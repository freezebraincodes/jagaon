import type { CommandId } from "@/application/contracts/command-event-identifiers";
import type { Instant } from "@/domain/shared";
import type { AiLocale, AiReasonCode } from "@/domain/ai";
import type { AiHybridExecutionResult, AiUnsentRequestOutcome, createAiHybridTaskService } from "@/application/ai/ai-hybrid-task-service";
import { buildCareSummaryAiRequest, type CareSummaryAiRequestRefusal } from "./ai-care-summary-request";
import type { CarePreparationCommandPort, CarePreparationQueryPort, ExpectedHead } from "./care-preparation-contracts";

/**
 * Packet 11C Addendum B, Task B1b: the care-summary AI-wording use case (original Task 1 via the hybrid path). On an explicit request it
 * loads the current preview, builds the source-closed `DRAFT_CARE_PREPARATION_SUMMARY` request from it (`buildCareSummaryAiRequest`) and
 * hands that request ONLY to the injected hybrid `execute` (value-blind shells; the shipped manifest keeps the task NOT_ACTIVATED, so the
 * hybrid service composes deterministically and nothing leaves the device). ONLY an `AI` result with an accepted composition for this
 * request and locale leads to `replaceWithAiAssistedPreview`, which re-validates head, hash, template, sources, audit and composition in
 * one transaction. Closed outcomes:
 * - REPLACED: the new AI-assisted preview (PREPARED; approval stays a separate patient action);
 * - KEPT_DETERMINISTIC: a deterministic result (not activated, private, offline, ineligible plan, any provider or validator failure):
 *   no snapshot is created;
 * - NOT_ELIGIBLE: the preview cannot be sent (`execute` is never called);
 * - STALE: the preview or a source changed before or during the request (nothing is written);
 * - CANCELLED: aborted before the replacement was requested (the use case does not wait for a pending `execute` once aborted);
 * - UNAVAILABLE: anything else, fail closed.
 * Audit (Packet 11C Addendum C, C5): every call is one explicit request with its own id and instant, and writes exactly one audit row:
 * the hybrid service's once the request reaches `execute`; otherwise a zero-attempt row through `recordUnsent` (NOT_ELIGIBLE,
 * SOURCE_CHANGED, SOURCE_UNAVAILABLE, REQUEST_CANCELLED before sending, PAYLOAD_INVALID for a request `execute` rejects).
 * No UI here. Packet 11C B4b: the browser wiring (`createBrowserAiAssistance`) builds it over the app's one hybrid service.
 */

export type AiHybridTaskService = ReturnType<typeof createAiHybridTaskService>;

export type CareSummaryAiOutcome =
  | Readonly<{ kind: "REPLACED"; recordId: ExpectedHead["recordId"]; revisionId: ExpectedHead["expectedRevisionId"]; revisionNumber: number }>
  | Readonly<{ kind: "KEPT_DETERMINISTIC"; reason: AiReasonCode }>
  | Readonly<{ kind: "NOT_ELIGIBLE"; reason: CareSummaryAiRequestRefusal }>
  | Readonly<{ kind: "STALE" }>
  | Readonly<{ kind: "CANCELLED" }>
  | Readonly<{ kind: "UNAVAILABLE" }>;

/**
 * `recordUnsent` (Packet 11C Addendum C, C5): the hybrid service's zero-attempt audit row, for an explicit request that never reaches
 * `execute` (or that `execute` rejects without a row). Every `composeCareSummaryWithAi` call writes exactly one audit row.
 */
export type CareSummaryAiComposerDependencies = {
  query: CarePreparationQueryPort;
  commands: Pick<CarePreparationCommandPort, "replaceWithAiAssistedPreview">;
  execute: AiHybridTaskService["execute"];
  recordUnsent: AiHybridTaskService["recordUnsent"];
  now: () => Instant;
  requestId: () => string;
  commandId?: () => CommandId;
};

const ABORTED = Symbol("ABORTED");
const STALE_CODES: ReadonlySet<string> = new Set(["HEAD_CONFLICT", "SUMMARY_INVALIDATED_FOR_EXPORT", "SUMMARY_CONTENT_HASH_MISMATCH"]);

/** Settles with the promise, or with ABORTED as soon as the signal aborts (the promise keeps a handler, so it never goes unhandled). */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T | typeof ABORTED> {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.resolve(ABORTED);
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      resolve(ABORTED);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function createCareSummaryAiComposer(deps: CareSummaryAiComposerDependencies): Readonly<{ composeCareSummaryWithAi(input: { snapshotRef: ExpectedHead; locale: AiLocale }, signal?: AbortSignal): Promise<CareSummaryAiOutcome> }> {
  return Object.freeze({
    async composeCareSummaryWithAi(input: { snapshotRef: ExpectedHead; locale: AiLocale }, signal?: AbortSignal): Promise<CareSummaryAiOutcome> {
      const cancelled: CareSummaryAiOutcome = { kind: "CANCELLED" };
      // Packet 11C Addendum C (C5): this explicit request's identity, fixed at the patient's action; its one audit row names it.
      const requestId = deps.requestId();
      const requestedAt = deps.now();
      let handedToService = false;
      /** The zero-attempt row of this request (best effort: a failed audit write never changes the outcome and never throws). */
      const record = (outcome: AiUnsentRequestOutcome) => Promise.resolve().then(() => deps.recordUnsent({ requestId, taskType: "DRAFT_CARE_PREPARATION_SUMMARY", locale: input.locale, requestedAt, outcome })).catch(() => false);
      const unsent = async (outcome: AiUnsentRequestOutcome, result: CareSummaryAiOutcome): Promise<CareSummaryAiOutcome> => {
        await record(outcome);
        return result;
      };
      if (signal?.aborted) return unsent("REQUEST_CANCELLED", cancelled);
      try {
        const { snapshotRef } = input;
        const view = await deps.query.loadSummary(snapshotRef.recordId);
        if (signal?.aborted) return unsent("REQUEST_CANCELLED", cancelled);
        if (view.status !== "READY") return unsent("SOURCE_UNAVAILABLE", { kind: "UNAVAILABLE" });
        // A request in another locale than the preview's cannot be formed for that preview.
        if (view.payload.locale !== input.locale) return unsent("NOT_ELIGIBLE", { kind: "UNAVAILABLE" });
        if (view.revisionId !== snapshotRef.expectedRevisionId || view.revisionNumber !== snapshotRef.expectedRevisionNumber || !view.sourcesCurrent) return unsent("SOURCE_CHANGED", { kind: "STALE" });

        const built = buildCareSummaryAiRequest({ current: view.payload, requestId, requestedAt });
        if (built.kind !== "READY") return unsent("NOT_ELIGIBLE", { kind: "NOT_ELIGIBLE", reason: built.reason });

        handedToService = true;
        // The service writes this request's row, except for a request it rejects outright: that one is recorded here, also when the
        // patient has meanwhile cancelled (the use case does not wait for it).
        const executed = deps.execute(built.request, signal).then(async (result) => {
          if (result.kind === "REQUEST_REJECTED") await record("PAYLOAD_INVALID");
          return result;
        });
        const result: AiHybridExecutionResult | typeof ABORTED = await untilAborted(executed, signal);
        if (result === ABORTED || signal?.aborted) return cancelled;
        if (result.kind === "FALLBACK") return { kind: "KEPT_DETERMINISTIC", reason: result.fallback.reason };
        if (result.kind !== "COMPOSED" || result.auditRef !== requestId) return { kind: "UNAVAILABLE" };
        // A deterministic result never creates a snapshot: replacement happens only from validated AI output.
        if (result.source !== "AI") return { kind: "KEPT_DETERMINISTIC", reason: result.reason ?? "PROVIDER_FAILED" };
        if (result.composition.taskType !== "DRAFT_CARE_PREPARATION_SUMMARY" || result.composition.locale !== input.locale) return { kind: "UNAVAILABLE" };

        const replaced = await deps.commands.replaceWithAiAssistedPreview({
          ...snapshotRef,
          expectedContentHash: view.payload.rendering.contentHash,
          composition: result.composition,
          aiInvocationAuditRef: result.auditRef,
          validatedAt: deps.now(),
          ...(deps.commandId ? { commandId: deps.commandId() } : {}),
        });
        if (replaced.kind === "COMMITTED") return { kind: "REPLACED", recordId: replaced.recordId, revisionId: replaced.revisionId, revisionNumber: replaced.revisionNumber };
        if (replaced.kind === "REJECTED" && STALE_CODES.has(replaced.code)) return { kind: "STALE" };
        return { kind: "UNAVAILABLE" };
      } catch {
        // A storage failure, an invalid snapshot or a failed execute never becomes a replacement. Before the request reached the service,
        // its one row is recorded here (C5); after, the service owns it.
        const result: CareSummaryAiOutcome = signal?.aborted ? cancelled : { kind: "UNAVAILABLE" };
        if (handedToService) return result;
        return unsent(signal?.aborted ? "REQUEST_CANCELLED" : "SOURCE_UNAVAILABLE", result);
      }
    },
  });
}
