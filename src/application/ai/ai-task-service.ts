import { aiTaskRequestSchema, type AiReasonCode, type AiTaskOutput, type AiTaskRequest, type ProviderTaskRequest } from "@/domain/ai";
import { AI_DETERMINISTIC_ONLY_MANIFEST, resolveAiTaskActivation, type AiActivationManifest } from "./ai-activation-manifest";
import { addUsage, buildAuditRow, callOnce, NO_USAGE, type Attempts } from "./ai-call-support";
import { createDeterministicFallback, type AiFallbackResult } from "./ai-fallbacks";
import { renderExplainLimitations, type RenderedLimitation } from "./ai-meaning-registry";
import { validateAiTaskOutput } from "./ai-output-validator";
import { PROVIDER_FAILURE_REASONS, type AiInvocationAuditPort, type AiProviderPort } from "./ai-provider-port";
import { resolveAiTaskBundle, type AiTaskRuntimeBundle } from "./ai-runtime-bundles";
import { projectProviderTaskPayload } from "./detached-payload-projector";

/**
 * Packet 11A provider-neutral orchestration (ai-system-spec Sections 7–10, 12,
 * 14; Packet 11 design Sections 3–9). One execution resolves the exact bundle,
 * checks activation and profile, projects the detached payload, optionally
 * invokes the injected provider within the bundle's attempt and time ceilings,
 * validates the whole result, appends exactly one minimal audit row and returns
 * the accepted output or the task's deterministic fallback. Without an injected
 * manifest it uses the deterministic-only manifest (`AI_DETERMINISTIC_ONLY_MANIFEST`,
 * every task DETERMINISTIC_ONLY), so no provider is ever called. Packet 11C English
 * activation (owner decisions Q and A, I-8 review follow-up): this legacy service
 * sends record values, so it deliberately does NOT default to the shipped
 * `AI_ACTIVATION_MANIFEST` (which enables the value-blind hybrid shell path); only
 * an explicitly injected manifest (the offline evaluation harness, tests) enables a
 * task here.
 */

export type AiTaskExecutionResult =
  /**
   * For EXPLAIN_PATTERN (Option B) the application adds the registry-rendered limitation copy, identical
   * to the deterministic fallback's; the model never writes limitation text.
   */
  | Readonly<{ kind: "ACCEPTED"; output: AiTaskOutput; auditRef: string; limitations?: readonly RenderedLimitation[]; limitationCopyComplete?: boolean }>
  | Readonly<{ kind: "FALLBACK"; fallback: AiFallbackResult; auditRef: string }>
  /** Malformed input: nothing can be projected, audited or presented. */
  | Readonly<{ kind: "REQUEST_REJECTED" }>;

export type AiTaskService = Readonly<{
  execute(request: AiTaskRequest, signal?: AbortSignal): Promise<AiTaskExecutionResult>;
}>;

export type AiTaskServiceDependencies = Readonly<{
  releaseProfile: unknown;
  audit: AiInvocationAuditPort;
  now: () => string;
  monotonicMs: () => number;
  provider?: AiProviderPort;
  manifest?: AiActivationManifest;
}>;

export function createAiTaskService(dependencies: AiTaskServiceDependencies): AiTaskService {
  const manifest = dependencies.manifest ?? AI_DETERMINISTIC_ONLY_MANIFEST;

  async function invoke(request: AiTaskRequest, bundle: AiTaskRuntimeBundle, payload: ProviderTaskRequest, provider: AiProviderPort, attempts: Attempts, signal: AbortSignal | undefined): Promise<{ kind: "ACCEPTED"; output: AiTaskOutput } | { kind: "REJECTED"; reason: AiReasonCode }> {
    const budget = bundle.executionBudget;
    const overall = new AbortController();
    const overallTimer = setTimeout(() => overall.abort(), budget.overallTimeoutMs);
    try {
      while (attempts.count < budget.maxAttempts) {
        attempts.count += 1;
        const outcome = await callOnce((input: ProviderTaskRequest, s: AbortSignal) => provider.invoke(input, s), payload, budget.perCallTimeoutMs, overall.signal, signal);
        if (outcome.kind === "CANCELLED") return { kind: "REJECTED", reason: "REQUEST_CANCELLED" };
        if (outcome.kind === "TIMEOUT") {
          attempts.timedOut = true;
          return { kind: "REJECTED", reason: "PROVIDER_TIMEOUT" };
        }
        const result = outcome.result;
        if (result.kind !== "COMPLETED") {
          const reason = (PROVIDER_FAILURE_REASONS as readonly string[]).includes(result.reason) ? result.reason : "PROVIDER_FAILED";
          return { kind: "REJECTED", reason };
        }
        addUsage(attempts, result.usage);
        const validation = validateAiTaskOutput(request, bundle, result.candidate);
        if (validation.kind === "ACCEPTED") return validation;
        // Only a structural failure may use the one permitted repair attempt.
        if (!validation.repairable || attempts.count >= budget.maxAttempts) return { kind: "REJECTED", reason: validation.reason };
        attempts.structuralRepairUsed = true;
      }
      return { kind: "REJECTED", reason: "PROVIDER_FAILED" };
    } finally {
      clearTimeout(overallTimer);
    }
  }

  return Object.freeze({
    async execute(input: AiTaskRequest, signal?: AbortSignal): Promise<AiTaskExecutionResult> {
      const parsed = aiTaskRequestSchema.safeParse(input);
      if (!parsed.success) return { kind: "REQUEST_REJECTED" };
      const request = parsed.data as AiTaskRequest;
      const startedMs = dependencies.monotonicMs();
      const bundle = resolveAiTaskBundle(request.taskType, request.locale);
      const attempts: Attempts = { count: 0, structuralRepairUsed: false, timedOut: false, usage: NO_USAGE };

      const finish = async (outcome: { kind: "ACCEPTED"; output: AiTaskOutput } | { kind: "REJECTED"; reason: AiReasonCode }): Promise<AiTaskExecutionResult> => {
        await dependencies.audit.append(buildAuditRow({ request, bundle, outcomeCode: outcome.kind === "ACCEPTED" ? "ACCEPTED" : outcome.reason, attempts, startedMs, manifest, provider: dependencies.provider, now: dependencies.now, monotonicMs: dependencies.monotonicMs }));
        if (outcome.kind !== "ACCEPTED") return { kind: "FALLBACK", fallback: createDeterministicFallback(request, outcome.reason), auditRef: request.requestId };
        if (request.taskType !== "EXPLAIN_PATTERN") return { kind: "ACCEPTED", output: outcome.output, auditRef: request.requestId };
        const copy = renderExplainLimitations(request.taskPayload.limitations, request.locale);
        return { kind: "ACCEPTED", output: outcome.output, auditRef: request.requestId, limitations: copy.limitations.map((limitation) => ({ ...limitation })), limitationCopyComplete: copy.complete };
      };
      const fallback = (reason: AiReasonCode) => finish({ kind: "REJECTED", reason });

      // Packet 11C Task 6A: a source-backed EXPLAIN request (local `periodSummary` binding) never enters this fact-sending path,
      // whatever its bundle key or activation. The detached projector drops the binding but keeps every fact value and interval
      // date, so it would leave as an ordinary EXPLAIN payload carrying values; it goes only through the hybrid (value-blind) service.
      if (request.taskType === "EXPLAIN_PATTERN" && request.taskPayload.periodSummary !== undefined) return fallback("PAYLOAD_INVALID");
      if (request.runtimeBundleKey !== bundle.bundleKey) return fallback("PAYLOAD_INVALID");
      const activation = resolveAiTaskActivation(request.taskType, dependencies.releaseProfile, manifest);
      if (activation.state !== "SYNTHETIC_REMOTE_ENABLED") return fallback(activation.reason);
      const projection = projectProviderTaskPayload(request, bundle);
      if (projection.kind === "FALLBACK") return fallback(projection.reason);
      if (!dependencies.provider) return fallback("MISSING_CONFIGURATION");
      if (signal?.aborted) return fallback("REQUEST_CANCELLED");
      return finish(await invoke(request, bundle, projection.payload, dependencies.provider, attempts, signal));
    },
  });
}
