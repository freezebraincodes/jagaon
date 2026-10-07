import { aiTaskRequestSchema, SHELL_TASKS, type AiReasonCode, type AiTaskRequest, type AtomTable, type ShellTask, type ShellTaskRequest, type SlotPlan } from "@/domain/ai";
import { AI_ACTIVATION_MANIFEST, resolveAiTaskActivation, type AiActivationManifest } from "./ai-activation-manifest";
import { createDeterministicFallback, type AiFallbackResult } from "./ai-fallbacks";
import { resolveAiHybridBundle, type AiHybridRuntimeBundle } from "./ai-hybrid-runtime-bundles";
import { renderExplainLimitations, type RenderedLimitation } from "./ai-meaning-registry";
import { PROVIDER_FAILURE_REASONS, type AiInvocationAuditPort, type AiShellProviderPort } from "./ai-provider-port";
import { addUsage, buildAuditRow, callOnce, NO_USAGE, type Attempts } from "./ai-task-service";
import { composeAiResult } from "./language/ai-composition";
import type { AiComposition } from "./language/assembler";
import { renderCareDraftNotices, type CareDraftNotice } from "./language/care-draft-notices";
import { composeDeterministic } from "./language/deterministic-composition";
import { projectShellTaskRequest } from "./language/shell-projector";
import { validateShellCandidate } from "./language/shell-validator";
import { planSlots } from "./language/slot-planner";

/**
 * Packet 11B.6 hybrid task service (spec Sections 4, 9). The application renders every fact; a remote model,
 * when activated, configured, online and not in private mode, writes only the language shells. Any failure
 * returns the deterministic composition of the same atoms silently, with exactly one audit row.
 * 11b.7: a remote-ineligible plan (fixed budgets exceeded, or a Symptoms or Patterns section) is composed
 * deterministically in mode INELIGIBLE, after the activation, private, offline and provider checks and
 * before projection, with no provider call.
 * Observation ownership (2026-10-07): the model writes the REMOTE fields only (EXPLAIN headline and evidence; every care field);
 * the application composes the EXPLAIN observation deterministically (variant selected from the requestId), then the shared
 * composeAiResult runs the existing assembler (S9) and the unchanged r7 verifier (S10) over the whole output. A composer, assembler
 * or verifier failure returns the deterministic composition (always the default variant 0).
 */
export type AiLanguageMode = "REMOTE_AI" | "PRIVATE" | "OFFLINE" | "NOT_ACTIVATED" | "NO_PROVIDER" | "INELIGIBLE";
export type AiHybridExecutionResult =
  | Readonly<{ kind: "COMPOSED"; source: "AI" | "DETERMINISTIC"; mode: AiLanguageMode; composition: AiComposition; reason: AiReasonCode | null; auditRef: string; limitations?: readonly RenderedLimitation[]; limitationCopyComplete?: boolean; notices?: readonly CareDraftNotice[] }>
  | Readonly<{ kind: "FALLBACK"; fallback: AiFallbackResult; auditRef: string }>
  | Readonly<{ kind: "REQUEST_REJECTED" }>;
export type AiHybridTaskServiceDependencies = Readonly<{
  releaseProfile: unknown;
  audit: AiInvocationAuditPort;
  now: () => string;
  monotonicMs: () => number;
  provider?: AiShellProviderPort;
  manifest?: AiActivationManifest;
  /** The patient's "keep wording on this device" preference; persisted setting and UI arrive with Packet 11C. */
  privateMode?: () => boolean;
  /** Connectivity probe evaluated before any call; absent means online. */
  online?: () => boolean;
}>;

type Outcome = { kind: "AI"; composition: AiComposition } | { kind: "DETERMINISTIC"; reason: AiReasonCode };

async function invokeShells(request: AiTaskRequest, plan: SlotPlan, atoms: AtomTable, bundle: AiHybridRuntimeBundle, provider: AiShellProviderPort, shellRequest: ShellTaskRequest, attempts: Attempts, signal: AbortSignal | undefined): Promise<Outcome> {
  const fallback = (reason: AiReasonCode): Outcome => ({ kind: "DETERMINISTIC", reason });
  const budget = bundle.executionBudget;
  const overall = new AbortController();
  const overallTimer = setTimeout(() => overall.abort(), budget.overallTimeoutMs);
  try {
    while (attempts.count < budget.maxAttempts) {
      attempts.count += 1;
      const call = await callOnce((input: ShellTaskRequest, s: AbortSignal) => provider.invoke(input, s), shellRequest, budget.perCallTimeoutMs, overall.signal, signal);
      if (call.kind === "CANCELLED") return fallback("REQUEST_CANCELLED");
      if (call.kind === "TIMEOUT") {
        attempts.timedOut = true;
        return fallback("PROVIDER_TIMEOUT");
      }
      const result = call.result;
      if (result.kind !== "COMPLETED") return fallback((PROVIDER_FAILURE_REASONS as readonly string[]).includes(result.reason) ? result.reason : "PROVIDER_FAILED");
      addUsage(attempts, result.usage);
      if (result.retention !== "CONFIRMED_NOT_STORED") return fallback("PROVIDER_FAILED");
      const shells = validateShellCandidate(plan, bundle, result.candidate);
      if (shells.kind === "REJECTED") {
        if (!shells.repairable || attempts.count >= budget.maxAttempts) return fallback(shells.reason);
        attempts.structuralRepairUsed = true;
        continue;
      }
      // Local composition, S9 and S10 (the unchanged r7 validator over the whole output); never injectable here.
      const composed = composeAiResult(request, plan, atoms, shells.shells, bundle);
      if (composed.kind === "REJECTED") return fallback(composed.reason);
      return { kind: "AI", composition: composed.composition };
    }
    return fallback("PROVIDER_FAILED");
  } finally {
    clearTimeout(overallTimer);
  }
}

export function createAiHybridTaskService(dependencies: AiHybridTaskServiceDependencies): Readonly<{ execute(request: AiTaskRequest, signal?: AbortSignal): Promise<AiHybridExecutionResult> }> {
  const manifest = dependencies.manifest ?? AI_ACTIVATION_MANIFEST;
  return Object.freeze({
    async execute(input: AiTaskRequest, signal?: AbortSignal): Promise<AiHybridExecutionResult> {
      const parsed = aiTaskRequestSchema.safeParse(input);
      if (!parsed.success) return { kind: "REQUEST_REJECTED" };
      const request = parsed.data as AiTaskRequest;
      if (!(SHELL_TASKS as readonly string[]).includes(request.taskType)) return { kind: "REQUEST_REJECTED" };
      const startedMs = dependencies.monotonicMs();
      const bundle = resolveAiHybridBundle(request.taskType as ShellTask, request.locale);
      const attempts: Attempts = { count: 0, structuralRepairUsed: false, timedOut: false, usage: NO_USAGE };
      const audit = (outcomeCode: "ACCEPTED" | AiReasonCode) =>
        dependencies.audit.append(buildAuditRow({ request, bundle, outcomeCode, attempts, startedMs, manifest, provider: dependencies.provider, now: dependencies.now, monotonicMs: dependencies.monotonicMs }));

      const planned = planSlots(request, bundle);
      if (planned.kind === "UNPLANNABLE") {
        await audit(planned.reason);
        return { kind: "FALLBACK", fallback: createDeterministicFallback(request, planned.reason), auditRef: request.requestId };
      }
      const deterministic = composeDeterministic(request, planned.plan, planned.atoms, bundle);
      const copy = request.taskType === "EXPLAIN_PATTERN" ? renderExplainLimitations(request.taskPayload.limitations, request.locale) : null;
      // P3 (ai-language-copy.11b.8): a care draft carries the fixed draft notices beside its composition, never inside it.
      const extras = copy ? { limitations: copy.limitations.map((limitation) => ({ ...limitation })), limitationCopyComplete: copy.complete } : { notices: renderCareDraftNotices(request) };
      const finish = async (mode: AiLanguageMode, outcome: Outcome): Promise<AiHybridExecutionResult> => {
        await audit(outcome.kind === "AI" ? "ACCEPTED" : outcome.reason);
        return outcome.kind === "AI"
          ? { kind: "COMPOSED", source: "AI", mode, composition: outcome.composition, reason: null, auditRef: request.requestId, ...extras }
          : { kind: "COMPOSED", source: "DETERMINISTIC", mode, composition: deterministic, reason: outcome.reason, auditRef: request.requestId, ...extras };
      };

      const activation = resolveAiTaskActivation(request.taskType, dependencies.releaseProfile, manifest);
      if (activation.state !== "SYNTHETIC_REMOTE_ENABLED") return finish("NOT_ACTIVATED", { kind: "DETERMINISTIC", reason: activation.reason });
      if (dependencies.privateMode?.() === true) return finish("PRIVATE", { kind: "DETERMINISTIC", reason: "PRIVACY_REJECTED" });
      if (dependencies.online !== undefined && !dependencies.online()) return finish("OFFLINE", { kind: "DETERMINISTIC", reason: "TRANSPORT_FAILED" });
      if (!dependencies.provider) return finish("NO_PROVIDER", { kind: "DETERMINISTIC", reason: "MISSING_CONFIGURATION" });
      if (planned.plan.remote.eligible !== true) return finish("INELIGIBLE", { kind: "DETERMINISTIC", reason: planned.plan.remote.reason });
      if (signal?.aborted) return finish("REMOTE_AI", { kind: "DETERMINISTIC", reason: "REQUEST_CANCELLED" });
      let shellRequest: ShellTaskRequest;
      try {
        shellRequest = projectShellTaskRequest(planned.plan);
      } catch {
        // An unapprovable value-blind request never reaches the provider; fail closed to the deterministic text.
        return finish("REMOTE_AI", { kind: "DETERMINISTIC", reason: "PAYLOAD_INVALID" });
      }
      return finish("REMOTE_AI", await invokeShells(request, planned.plan, planned.atoms, bundle, dependencies.provider, shellRequest, attempts, signal));
    },
  });
}
