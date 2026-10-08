import type { LocalDate } from "@/domain/shared/time";
import type { ComparableSlotTrendEvidenceFacts } from "@/domain/patterns";
import { resolvePatternFamily } from "@/application/intelligence/activation-manifest";
import type { IntelligenceSnapshot } from "@/application/intelligence/intelligence-snapshot";
import { instantMs, sortByInstantThenRevision } from "@/application/intelligence/metrics";
import type { ResolvedGlucoseReading } from "@/patterns/pattern-evaluator-contracts";
import {
  EXPLAINABLE_PERIOD_ROLES,
  HISTORY_LABELLED_SLOTS,
  explainablePatternViewSchema,
  type ExplainablePatternResult,
  type ExplainablePeriod,
  type HistorySlot,
  type SupportingReading,
} from "./recorded-history-contracts";
import { windowDates } from "./recorded-history-query";

/**
 * Packet 11C Addendum A1 source projection (`ExplainablePatternView`).
 *
 * Projects one stored SUPPORTED comparable-slot observation and its evidence
 * snapshot, reconciled against the current journal revisions, into both
 * periods with exact counts, a role-labelled summary value and every
 * supporting reading. Every inconsistency fails closed with a reason; nothing
 * is recalculated, relabelled, capped or truncated.
 */

const FAMILY = "COMPARABLE_SLOT_TREND" as const;

type IneligibleReason = Extract<ExplainablePatternResult, { kind: "INELIGIBLE" }>["reason"];
type Segment = ComparableSlotTrendEvidenceFacts["reference"];
type Resolved = { source: ResolvedGlucoseReading; instant: string; offset: number; revisionId: string };

function ineligible(reason: IneligibleReason): ExplainablePatternResult {
  return { kind: "INELIGIBLE", reason };
}

function parseFactId(factId: string): { kind: "COMPARISON" | "NO_MATERIAL"; slot: HistorySlot } | null {
  const match = /^(COMPARISON|NO_MATERIAL):([A-Z_]+)$/.exec(factId);
  if (!match || !(HISTORY_LABELLED_SLOTS as readonly string[]).includes(match[2]!)) return null;
  return { kind: match[1] as "COMPARISON" | "NO_MATERIAL", slot: match[2] as HistorySlot };
}

/** The evaluator assigns only exact point readings; anything else no longer matches its evidence. */
function exactPoint(reading: ResolvedGlucoseReading): { instant: string; offset: number } | null {
  const temporal = reading.temporal;
  if (temporal.kind !== "POINT" || temporal.occurrence.kind !== "EXACT") return null;
  return { instant: temporal.occurrence.instantUtc, offset: temporal.occurrence.utcOffsetMinutes };
}

/** Local date and wall-clock time at the reading's own recorded offset. */
function supportingReading(entry: Resolved): SupportingReading {
  const shifted = new Date(instantMs(entry.instant) + entry.offset * 60_000).toISOString();
  const { measurement, measurementMethod } = entry.source.payload;
  return {
    ref: { recordType: "GLUCOSE_READING", recordId: entry.source.ref.recordId, revisionId: entry.source.ref.revisionId },
    localDate: shifted.slice(0, 10) as LocalDate,
    localTime: shifted.slice(11, 16),
    enteredValue: measurement.enteredValue,
    enteredUnit: measurement.enteredUnit,
    method: measurementMethod,
  };
}

/** Rule 3: every assignment resolves to the current revision, inside its window and slot. */
function resolveSegment(segment: Segment, slot: HistorySlot, byRecord: ReadonlyMap<string, ResolvedGlucoseReading>): Resolved[] | IneligibleReason {
  const resolved: Resolved[] = [];
  for (const assignment of segment.assignments) {
    const source = byRecord.get(assignment.reading.recordId);
    if (!source) return "MISSING_READING";
    if (source.ref.recordType !== "GLUCOSE_READING" || source.ref.revisionId !== assignment.reading.revisionId) return "STALE_SOURCE";
    const point = exactPoint(source);
    if (!point) return "STALE_SOURCE";
    const at = instantMs(point.instant);
    if (at < instantMs(segment.window.start) || at >= instantMs(segment.window.end)) return "STALE_SOURCE";
    const context = source.payload.context;
    if (context.kind !== "PATIENT_SELECTED_SLOT" || context.slot !== slot) return "STALE_SOURCE";
    resolved.push({ source, ...point, revisionId: source.ref.revisionId });
  }
  return resolved;
}

export function projectExplainablePattern(snapshot: IntelligenceSnapshot, factId: string): ExplainablePatternResult {
  const fact = parseFactId(factId);
  if (!fact) return ineligible("NOT_FOUND");
  if (resolvePatternFamily(FAMILY).kind !== "ENABLED") return ineligible("FAMILY_UNAVAILABLE");
  // A read-only "no material difference" statement has no stored snapshot to explain.
  if (fact.kind === "NO_MATERIAL") return ineligible("NO_MATERIAL");

  // Rule 1: the chain, found exactly as the Recorded-history query finds it.
  const chain = [...snapshot.patternChains.values()].find((candidate) => {
    const claim = candidate.previous.observation.payload.claim;
    return claim.family === FAMILY && claim.slot.kind === "PATIENT_SELECTED_SLOT" && claim.slot.slot === fact.slot;
  });
  if (!chain) return ineligible("NOT_FOUND");

  // Rule 2: only a SUPPORTED observation of this family, with a summary it can label.
  const observation = chain.previous.observation.payload;
  const facts = chain.previous.snapshot.payload.facts;
  if (
    observation.lifecycle.state !== "SUPPORTED" ||
    observation.claim.family !== FAMILY ||
    facts.family !== FAMILY ||
    facts.slot.kind !== "PATIENT_SELECTED_SLOT" ||
    facts.slot.slot !== fact.slot
  ) {
    return ineligible("NOT_SUPPORTED");
  }
  const change = observation.claim.observedChange;
  const directional = change.typicalValue === "HIGHER" || change.typicalValue === "LOWER";
  if (!directional && change.variability === "NO_MATERIAL_CHANGE") return ineligible("NOT_SUPPORTED");
  const kind = directional ? (change.typicalValue as "HIGHER" | "LOWER") : "VARIABILITY";
  const summaryOf = (segment: Segment): ExplainablePeriod["summary"] | null => {
    if (directional) return { kind: "MEDIAN", valueMmolL: segment.summary.median };
    // Variability is the interquartile range only; any other dispersion is refused, never relabelled.
    return segment.summary.dispersion.metric === "IQR" ? { kind: "IQR", valueMmolL: segment.summary.dispersion.valueMmolL } : null;
  };
  const summaries = [summaryOf(facts.reference), summaryOf(facts.recent)];
  if (summaries.some((summary) => summary === null)) return ineligible("UNSUPPORTED_SUMMARY");

  // Rule 3: an evidence snapshot the observation no longer heads, or any source that moved, is stale.
  if (chain.snapshotHeadRevision.revisionId !== chain.previous.snapshot.revisionId) return ineligible("STALE_SOURCE");
  const byRecord = new Map(snapshot.glucose.map((reading) => [reading.ref.recordId as string, reading]));
  const segments = [facts.reference, facts.recent] as const;
  const resolved: Resolved[][] = [];
  for (const segment of segments) {
    const outcome = resolveSegment(segment, fact.slot, byRecord);
    if (typeof outcome === "string") return ineligible(outcome);
    resolved.push(outcome);
  }

  // Rule 4: each period's list equals its count, and the total equals the evidence count.
  for (const [index, segment] of segments.entries()) {
    const count = segment.summary.distinctOccasionCount;
    if (segment.assignments.length !== count || resolved[index]!.length !== count) return ineligible("COUNT_MISMATCH");
  }
  const totalCount = facts.reference.summary.distinctOccasionCount + facts.recent.summary.distinctOccasionCount;
  const coverage = chain.previous.snapshot.payload.coverage;
  if (coverage.kind === "OBSERVATION_SPAN" && coverage.distinctOccasionCount !== totalCount) return ineligible("COUNT_MISMATCH");

  // Rule 5: all readings in a period share one method, the one the evidence assigned.
  for (const [index, segment] of segments.entries()) {
    const methods = new Set<string>([
      ...segment.assignments.map((assignment) => assignment.measurementMethod),
      ...resolved[index]!.map((entry) => entry.source.payload.measurementMethod),
    ]);
    if (methods.size !== 1) return ineligible("METHOD_MISMATCH");
  }

  // Rule 6: windows as local dates; every reading, sorted by instant, never truncated.
  const periods = segments.map((segment, index) => ({
    role: EXPLAINABLE_PERIOD_ROLES[index]!,
    window: windowDates(segment.window),
    count: segment.summary.distinctOccasionCount,
    summary: summaries[index]!,
    readings: sortByInstantThenRevision(resolved[index]!).map(supportingReading),
  }));
  const parsed = explainablePatternViewSchema.safeParse({
    factId: `COMPARISON:${fact.slot}`,
    slot: fact.slot,
    kind,
    periods,
    totalCount,
    observationRef: { recordType: "PATTERN_OBSERVATION", recordId: chain.previous.observation.recordId, revisionId: chain.previous.observation.revisionId },
    snapshotRef: { recordType: "PATTERN_EVIDENCE_SNAPSHOT", recordId: chain.previous.snapshot.recordId, revisionId: chain.previous.snapshot.revisionId },
  });
  return parsed.success ? { kind: "EXPLAINABLE", view: parsed.data } : ineligible("UNAVAILABLE");
}
