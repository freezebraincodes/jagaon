import type { Instant } from "@/domain/shared/time";
import type { AiLocale, AiTaskRequest } from "@/domain/ai";
import type { ExplainablePatternResult, ExplainablePatternView, RecordedHistoryQueryPort } from "@/application/history/recorded-history-contracts";
import type { AiHybridExecutionResult, createAiHybridTaskService } from "./ai-hybrid-task-service";
import { buildSourceBackedExplainRequest } from "./explain-pattern-request";
import type { AiComposition } from "./language/assembler";
import { renderSummaryRoleNotice } from "./language/atom-renderer";

/**
 * Packet 11C Task 6: the pattern-explanation use case (Addendum A1/A3). It loads the source projection of one READY comparison,
 * builds the source-backed EXPLAIN_PATTERN request from it and hands that request ONLY to the injected hybrid `execute`
 * (value-blind shells; the legacy fact-sending service refuses a request carrying `periodSummary`, Task 6A). While the shipped
 * manifest keeps EXPLAIN_PATTERN NOT_ACTIVATED, the hybrid service composes deterministically and nothing leaves the device.
 *
 * Protection:
 * - An ineligible fact returns the view's own reason and `execute` is never called.
 * - Stale result: after `execute` resolves the view is loaded again, and the result is kept only if the observation ref, the
 *   evidence snapshot ref and every supporting reading ref (per period, in order) are identical to the view the request was built
 *   from. A correction re-evaluated in the meantime, or a view that is no longer explainable, is `STALE_RESULT` and no composition
 *   is returned.
 * - Abort: an abort before, during or right after `execute` is `CANCELLED`; the caller's signal is passed to `execute`, and the
 *   use case does not wait for a pending `execute` once aborted.
 * - Anything else that is not an EXPLAIN composition for this request and locale fails closed (`UNAVAILABLE`).
 *
 * The limitations are the ones the hybrid service rendered with the existing limitation renderer (`renderExplainLimitations`, the
 * approved copy, identical on the AI and deterministic paths); incomplete limitation copy fails closed. The summary-role notice is
 * the application copy (ai-language-copy.11b.10). Neither is model output. (This module does not read the approved-meaning
 * registry itself: the registry's importers stay pinned by the import-boundary test.)
 */

export type AiHybridTaskService = ReturnType<typeof createAiHybridTaskService>;

type Composed = Extract<AiHybridExecutionResult, { kind: "COMPOSED" }>;
/** A limitation as the existing renderer produced it (`RenderedLimitation`), carried by the hybrid result. */
export type PatternLimitation = NonNullable<Composed["limitations"]>[number];

type ViewReason = Extract<ExplainablePatternResult, { kind: "INELIGIBLE" }>["reason"];
export type PatternExplanationUnavailableReason = ViewReason | "STALE_RESULT" | "CANCELLED";

export type PatternExplanation =
  | { kind: "EXPLAINED"; source: "AI" | "DETERMINISTIC"; view: ExplainablePatternView; composition: AiComposition; limitations: readonly PatternLimitation[]; summaryRoleNotice: string }
  | { kind: "UNAVAILABLE"; reason: PatternExplanationUnavailableReason };

export type PatternExplainerDependencies = {
  history: RecordedHistoryQueryPort;
  execute: AiHybridTaskService["execute"];
  now: () => Instant;
  requestId: () => string;
};

const ABORTED = Symbol("ABORTED");

const unavailable = (reason: PatternExplanationUnavailableReason): PatternExplanation => ({ kind: "UNAVAILABLE", reason });

/** Settles with the promise, or with ABORTED as soon as the signal aborts (the promise keeps a handler, so it never goes unhandled). */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T | typeof ABORTED> {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.resolve(ABORTED);
  }
  return new Promise((resolve, reject) => {
    // Released on whichever comes first (Packet 11C B2b): the abort, or execute settling while the signal never fired.
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

const refKey = (ref: { recordType: string; recordId: string; revisionId: string }) => `${ref.recordType}:${ref.recordId}:${ref.revisionId}`;

/** The view's source identity: the observation, the evidence snapshot and every supporting reading, per period and in order. */
function sourceIdentity(view: ExplainablePatternView): string[] {
  return [refKey(view.observationRef), refKey(view.snapshotRef), ...view.periods.map((period) => `${period.role}[${period.readings.map((reading) => refKey(reading.ref)).join(",")}]`)];
}

/**
 * Packet 11C B2b (carried Checkpoint 2 minor): the rendered limitations must be exactly the request's limitations, one per request
 * limitation in the request's order, with the same ref and code and a non-empty approved text. Returns frozen copies, or null.
 */
function limitationsFor(request: AiTaskRequest, rendered: readonly PatternLimitation[]): readonly PatternLimitation[] | null {
  if (request.taskType !== "EXPLAIN_PATTERN") return null;
  const expected = request.taskPayload.limitations;
  if (rendered.length !== expected.length) return null;
  const copies: PatternLimitation[] = [];
  for (const [index, limitation] of rendered.entries()) {
    const wanted = expected[index]!;
    if (limitation?.limitationRef !== wanted.ref || limitation.code !== wanted.code || typeof limitation.text !== "string" || limitation.text.length === 0) return null;
    copies.push(Object.freeze({ limitationRef: limitation.limitationRef, code: limitation.code, text: limitation.text }));
  }
  return Object.freeze(copies);
}

function sameSource(built: ExplainablePatternView, reloaded: ExplainablePatternResult): boolean {
  if (reloaded.kind !== "EXPLAINABLE" || reloaded.view.factId !== built.factId) return false;
  const before = sourceIdentity(built);
  const after = sourceIdentity(reloaded.view);
  return before.length === after.length && before.every((key, index) => key === after[index]);
}

export function createPatternExplainer(deps: PatternExplainerDependencies): { explain(input: { factId: string; locale: AiLocale }, signal?: AbortSignal): Promise<PatternExplanation> } {
  return Object.freeze({
    async explain(input: { factId: string; locale: AiLocale }, signal?: AbortSignal): Promise<PatternExplanation> {
      if (signal?.aborted) return unavailable("CANCELLED");
      try {
        const loaded = await deps.history.loadExplainablePattern({ factId: input.factId });
        if (signal?.aborted) return unavailable("CANCELLED");
        if (loaded.kind !== "EXPLAINABLE") return unavailable(loaded.reason);
        const view = loaded.view;

        const request: AiTaskRequest = buildSourceBackedExplainRequest({ view, locale: input.locale, requestId: deps.requestId(), requestedAt: deps.now() });
        const result: AiHybridExecutionResult | typeof ABORTED = await untilAborted(deps.execute(request, signal), signal);
        if (result === ABORTED || signal?.aborted) return unavailable("CANCELLED");

        // Stale protection: keep the result only if its sources are exactly the ones still recorded now.
        const reloaded = await deps.history.loadExplainablePattern({ factId: input.factId });
        if (signal?.aborted) return unavailable("CANCELLED");
        if (!sameSource(view, reloaded)) return unavailable("STALE_RESULT");

        if (result.kind !== "COMPOSED" || result.auditRef !== request.requestId) return unavailable("UNAVAILABLE");
        const composition = result.composition;
        if (composition.taskType !== "EXPLAIN_PATTERN" || composition.locale !== input.locale) return unavailable("UNAVAILABLE");
        if (result.limitationCopyComplete !== true || !result.limitations || result.limitations.length === 0) return unavailable("UNAVAILABLE");
        const limitations = limitationsFor(request, result.limitations);
        if (!limitations) return unavailable("UNAVAILABLE");

        return {
          kind: "EXPLAINED",
          source: result.source,
          view,
          composition,
          limitations,
          summaryRoleNotice: renderSummaryRoleNotice(input.locale),
        };
      } catch {
        // A storage failure, an invalid view or a failed execute never becomes an explanation.
        return signal?.aborted ? unavailable("CANCELLED") : unavailable("UNAVAILABLE");
      }
    },
  });
}
