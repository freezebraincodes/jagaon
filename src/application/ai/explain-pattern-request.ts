import type { Instant } from "@/domain/shared/time";
import type { AiLocale, AiRequestFact, AiTaskRequest } from "@/domain/ai/ai-task-contracts";
import { explainablePatternViewSchema, type ExplainablePatternView, type ExplainablePeriod } from "@/application/history/recorded-history-contracts";
import { AI_HYBRID_RUNTIME_BUNDLES } from "./ai-hybrid-runtime-bundles";

/**
 * Packet 11C Addendum A1/A3 source-backed request builder. It turns an `ExplainablePatternView` (a stored SUPPORTED
 * comparable-slot observation reconciled against the current journal) into the EXPLAIN_PATTERN `AiTaskRequest` with the
 * local `periodSummary` binding. Nothing is recalculated, relabelled, capped or truncated: counts, windows and the
 * role-labelled summary values (median, or interquartile range for VARIABILITY) are the view's own.
 *
 * Provenance: each period's interval fact names the observation; its count and summary facts, and the total count
 * fact, name the evidence snapshot alone. Per-reading references never enter a request fact (the snapshot enumerates
 * every assignment and the view lists every reading), so the 32-source cap can never truncate or reject a period of
 * any size. Provenance stays local: the projector strips `sources`, and the binding is never copied to the provider.
 *
 * Fail closed (Packet 11C final review): the input view is validated with the unchanged `explainablePatternViewSchema` first, so a
 * mislabelled summary kind or slot, reversed periods or a disagreeing total can never become a request (`SOURCE_BACKED_VIEW_INVALID`).
 */

type LocalSource = AiRequestFact["sources"][number];

export function buildSourceBackedExplainRequest(input: { view: ExplainablePatternView; locale: AiLocale; requestId: string; requestedAt: Instant }): AiTaskRequest {
  const parsed = explainablePatternViewSchema.safeParse(input.view);
  if (!parsed.success) throw new Error("SOURCE_BACKED_VIEW_INVALID");
  const view: ExplainablePatternView = parsed.data;
  const observation: LocalSource = { recordType: view.observationRef.recordType, recordId: view.observationRef.recordId, revisionId: view.observationRef.revisionId };
  const snapshot: LocalSource = { recordType: view.snapshotRef.recordType, recordId: view.snapshotRef.recordId, revisionId: view.snapshotRef.revisionId };

  const count = (ref: string, value: number): AiRequestFact => ({ ref, field: "EVIDENCE_COUNT", value: { kind: "COUNT", value }, sources: [{ ...snapshot }] });
  const period = (entry: ExplainablePeriod, first: number): AiRequestFact[] => [
    {
      ref: `fact-${first}`,
      field: "EFFECTIVE_INTERVAL",
      value: { kind: "DATE_RANGE", startDate: entry.window.startDate, endDate: entry.window.endDate },
      sources: [{ ...observation }],
    },
    count(`fact-${first + 1}`, entry.count),
    {
      ref: `fact-${first + 2}`,
      field: "MEASUREMENT_VALUE",
      value: { kind: "DECIMAL", value: entry.summary.valueMmolL, unit: "MMOL_L" },
      sources: [{ ...snapshot }],
    },
  ];

  const [earlier, recent] = view.periods;
  const facts = [...period(earlier, 1), ...period(recent, 4), count("fact-7", view.totalCount)];

  return {
    requestId: input.requestId,
    requestedAt: input.requestedAt,
    locale: input.locale,
    releaseProfile: "HACKATHON_DEMO",
    taskType: "EXPLAIN_PATTERN",
    runtimeBundleKey: AI_HYBRID_RUNTIME_BUNDLES.EXPLAIN_PATTERN.bundleKey,
    facts,
    taskPayload: {
      claim: { ref: "claim-1", family: "COMPARABLE_SLOT_TREND", factRefs: facts.map((fact) => fact.ref) },
      limitations: [{ ref: "limitation-1", code: "DOES_NOT_ESTABLISH_CAUSE" }],
      periodSummary: {
        slot: view.slot,
        summaryKind: earlier.summary.kind,
        periods: [
          { role: "EARLIER", intervalRef: "fact-1", countRef: "fact-2", summaryRef: "fact-3" },
          { role: "RECENT", intervalRef: "fact-4", countRef: "fact-5", summaryRef: "fact-6" },
        ],
        totalCountRef: "fact-7",
      },
    },
  };
}
