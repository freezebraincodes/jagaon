import type { AiInvocationAuditRow, AiTaskRequest } from "@/domain/ai";
import type { AiActivationManifest } from "./ai-activation-manifest";
import type { ProviderInvocationResult, ProviderUsage } from "./ai-provider-port";
import type { AiTaskRuntimeBundle } from "./ai-runtime-bundles";

/**
 * Provider-call helpers shared by the legacy task service and the hybrid task service (Packet 11C Addendum B, Task B2a). Moved
 * unchanged out of ai-task-service.ts so that the hybrid service, which may enter the browser graph (D1), never imports the legacy
 * fact-sending service. No behaviour change: the bounded call, the usage folding and the audit row are byte-identical.
 */

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
