import { aiTaskRequestSchema, type AiInvocationAuditRow, type AiReasonCode, type AiTaskOutput, type AiTaskRequest, type ProviderTaskRequest } from "@/domain/ai";
import { AI_ACTIVATION_MANIFEST, resolveAiTaskActivation, type AiActivationManifest } from "./ai-activation-manifest";
import { createDeterministicFallback, type AiFallbackResult } from "./ai-fallbacks";
import { renderExplainLimitations, type RenderedLimitation } from "./ai-meaning-registry";
import { validateAiTaskOutput } from "./ai-output-validator";
import { PROVIDER_FAILURE_REASONS, type AiInvocationAuditPort, type AiProviderPort, type ProviderInvocationResult, type ProviderUsage } from "./ai-provider-port";
import { resolveAiTaskBundle, type AiTaskRuntimeBundle } from "./ai-runtime-bundles";
import { projectProviderTaskPayload } from "./detached-payload-projector";

/**
 * Packet 11A provider-neutral orchestration (ai-system-spec Sections 7–10, 12,
 * 14; Packet 11 design Sections 3–9). One execution resolves the exact bundle,
 * checks activation and profile, projects the detached payload, optionally
 * invokes the injected provider within the bundle's attempt and time ceilings,
 * validates the whole result, appends exactly one minimal audit row and returns
 * the accepted output or the task's deterministic fallback. With the shipped
 * 11A manifest every task is deterministic-only, so no provider is ever called.
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

export type Attempts = { count: number; structuralRepairUsed: boolean; timedOut: boolean; usage: ProviderUsage };
export type CallOutcome = { kind: "RESULT"; result: ProviderInvocationResult } | { kind: "TIMEOUT" } | { kind: "CANCELLED" };

export const NO_USAGE: ProviderUsage = Object.freeze({ inputTokens: null, outputTokens: null, costMicroUsd: null });
const bounded = (value: unknown, max: number): number | null => (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max ? value : null);
const sum = (a: number | null, b: number | null, max: number) => (a === null && b === null ? null : Math.min((a ?? 0) + (b ?? 0), max));

/** One bounded provider call. A provider that ignores the abort signal is still cut off. */
export function callOnce<TInput>(invoke: (input: TInput, signal: AbortSignal) => Promise<ProviderInvocationResult>, payload: TInput, perCallMs: number, overall: AbortSignal, user: AbortSignal | undefined): Promise<CallOutcome> {
  const controller = new AbortController();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: CallOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      overall.removeEventListener("abort", onTimeout);
      user?.removeEventListener("abort", onCancel);
      controller.abort();
      resolve(outcome);
    };
    const onTimeout = () => finish({ kind: "TIMEOUT" });
    const onCancel = () => finish({ kind: "CANCELLED" });
    const timer = setTimeout(onTimeout, perCallMs);
    overall.addEventListener("abort", onTimeout);
    user?.addEventListener("abort", onCancel);
    if (overall.aborted) return onTimeout();
    if (user?.aborted) return onCancel();
    // A synchronous throw is a transport failure too, never an escaped exception.
    Promise.resolve()
      .then(() => invoke(payload, controller.signal))
      .then(
      (result) => finish({ kind: "RESULT", result }),
      () => finish({ kind: "RESULT", result: { kind: "FAILED", reason: "TRANSPORT_FAILED" } }),
    );
  });
}

/** Folds one completed attempt's bounded usage into the running totals. */
export function addUsage(attempts: Attempts, usage: ProviderUsage | undefined): void {
  attempts.usage = {
    inputTokens: sum(attempts.usage.inputTokens, bounded(usage?.inputTokens, 100_000), 100_000),
    outputTokens: sum(attempts.usage.outputTokens, bounded(usage?.outputTokens, 100_000), 100_000),
    costMicroUsd: sum(attempts.usage.costMicroUsd, bounded(usage?.costMicroUsd, 10_000_000), 10_000_000),
  };
}

export function buildAuditRow(input: { request: AiTaskRequest; bundle: AiTaskRuntimeBundle; outcomeCode: AiInvocationAuditRow["outcomeCode"]; attempts: Attempts; startedMs: number; manifest: AiActivationManifest; provider: { providerModel: { providerKey: string; modelSnapshot: string } } | undefined; now: () => string; monotonicMs: () => number }): AiInvocationAuditRow {
  const { request, bundle, outcomeCode, attempts, startedMs, manifest } = input;
  const transmitted = attempts.count > 0;
  const sources = new Map<string, AiInvocationAuditRow["sourceRevisions"][number]>();
  if (transmitted) for (const fact of request.facts) for (const source of fact.sources) sources.set(source.revisionId, source);
  return {
    requestId: request.requestId,
    taskType: request.taskType,
    locale: request.locale,
    requestedAt: request.requestedAt,
    completedAt: input.now(),
    outcomeCode,
    routeProfileKey: bundle.routeProfile,
    runtimeBundleKey: bundle.bundleKey,
    activationManifestVersion: manifest.manifestVersion,
    components: {
      capabilityProfile: bundle.capabilityProfile,
      promptTemplate: bundle.promptTemplate,
      inputSchema: bundle.inputSchema,
      outputSchema: bundle.outputSchema,
      validatorProfile: bundle.validatorProfile,
      localePack: bundle.localePack[request.locale],
      fallbackProfile: bundle.fallbackProfile,
      fixtureSet: bundle.fixtureSet,
    },
    logicalTier: bundle.logicalTier,
    providerModel: transmitted && input.provider ? { ...input.provider.providerModel } : null,
    attempts: { count: attempts.count, structuralRepairUsed: attempts.structuralRepairUsed, timedOut: attempts.timedOut },
    measurements: {
      ...(transmitted ? attempts.usage : NO_USAGE),
      latencyMs: Math.min(Math.max(0, Math.round(input.monotonicMs() - startedMs)), 600_000),
    },
    sourceRevisions: [...sources.values()],
    downstream: null,
  } as AiInvocationAuditRow;
}

export function createAiTaskService(dependencies: AiTaskServiceDependencies): AiTaskService {
  const manifest = dependencies.manifest ?? AI_ACTIVATION_MANIFEST;

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
