import type { JagaOnDatabase } from "@/storage/database";
import type { Instant, LocalDate } from "@/domain/shared/time";
import type { GlucoseReadingPayload } from "@/domain/health-records/glucose-reading";
import type { PatternFamily } from "@/domain/patterns";
import {
  enabledPatternFamilies,
  resolvePatternFamily,
} from "@/application/intelligence/activation-manifest";
import { resolveActivityIdentity, resolveIntakeIdentities } from "@/application/intelligence/familiar-identity";
import { occurrencePoint } from "@/application/intelligence/familiar-occurrences";
import {
  IntelligenceIntegrityError,
  loadIntelligenceSnapshot,
  type IntelligenceSnapshot,
} from "@/application/intelligence/intelligence-snapshot";
import { compareRational, decimal, instantMs, localDateOf } from "@/application/intelligence/metrics";
import { evaluateComparableSlotTrend } from "@/patterns/comparable-slot-trend-evaluator";
import type { ResolvedGlucoseReading } from "@/patterns/pattern-evaluator-contracts";
import { projectExplainablePattern } from "./explainable-pattern-view";
import {
  HISTORY_DISPLAY_POSITIONS,
  HISTORY_LABELLED_SLOTS,
  recordedHistoryViewSchema,
  type ExplainablePatternRequest,
  type ExplainablePatternResult,
  type HistoryChartPosition,
  type HistoryComparison,
  type HistoryDisplayPosition,
  type HistoryPeriod,
  type HistoryProjection,
  type HistorySlot,
  type RecordedHistoryQueryPort,
  type RecordedHistoryView,
} from "./recorded-history-contracts";

/**
 * Packet 7A Recorded-history query (design Section 5.3 and 7).
 *
 * Factual projections are calculated directly from the latest validated
 * journal revisions and create no Pattern record. Comparisons come only from
 * validated SUPPORTED comparable-slot observations, or from the same governed
 * rule stating that comparable records did not meet the numerical threshold.
 * Repeated labels come from SUPPORTED familiar-item observations, counted in
 * the selected period. "Not recorded" describes the journal only.
 */

/** Singapore has a fixed +08:00 offset; the demo's home timezone. */
const HOME_OFFSET_MINUTES = 480;
/** Owner decision 2026-10-16: readings at this many of the three times of day complete a day's booklet stamp. */
const MIN_POSITIONS_FOR_COMPLETE_DAY = 2;
const DAY_MS = 86_400_000;

type Dependencies = { now(): Instant };

type DateRange = { startDate: LocalDate; endDate: LocalDate };

function addLocalDays(date: string, days: number): LocalDate {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10) as LocalDate;
}

export function historyRange(period: HistoryPeriod, now: Instant): DateRange {
  const today = localDateOf(now, HOME_OFFSET_MINUTES) as LocalDate;
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  const monday = addLocalDays(today, -((weekday + 6) % 7));
  if (period === "THIS_WEEK") return { startDate: monday, endDate: today };
  if (period === "LAST_WEEK") return { startDate: addLocalDays(monday, -7), endDate: addLocalDays(monday, -1) };
  return { startDate: addLocalDays(today, -29), endDate: today };
}

/** MORNING is local 00:00–11:59 and EVENING 12:00–23:59 of the recorded day. */
function displayPosition(instant: string, offset: number): { date: LocalDate; position: HistoryDisplayPosition } {
  const shifted = new Date(instantMs(instant) + offset * 60_000);
  // Owner decision 2026-10-16: the same three times of day as Today's booklet.
  const hour = shifted.getUTCHours();
  return { date: shifted.toISOString().slice(0, 10) as LocalDate, position: hour < 12 ? "MORNING" : hour < 18 ? "AFTERNOON" : "EVENING" };
}

function positionStart(date: string, position: HistoryDisplayPosition): number {
  return Date.parse(`${date}T${position === "MORNING" ? "00" : position === "AFTERNOON" ? "12" : "18"}:00:00Z`) - HOME_OFFSET_MINUTES * 60_000;
}

/**
 * CR-11 (owner decision R-4, 2026-10-11): the reading's mmol/L value exactly as STORED, never canonicalised, so the History list and
 * explanation facts keep the precision the person entered ("6.80" stays "6.80", "60.0" stays "60.0", "0.0" stays "0.0"; nothing is
 * rounded or rewritten). Ordering and the chart stay numeric (6.80 = 6.8) through `decimal`.
 */
function storedMmolValue(payload: GlucoseReadingPayload): string | null {
  const measurement = payload.measurement;
  if (measurement.normalization?.canonicalUnit === "MMOL_L") return measurement.normalization.canonicalValue;
  return measurement.enteredUnit === "MMOL_L" ? measurement.enteredValue : null;
}

function readingPoint(reading: ResolvedGlucoseReading): { instant: string; offset: number } | null {
  return occurrencePoint(reading.temporal as never);
}

/** A half-open instant window `[start, end)` as inclusive home-timezone local dates. */
export function windowDates(window: { start: string; end: string }): DateRange {
  return {
    startDate: localDateOf(window.start, HOME_OFFSET_MINUTES) as LocalDate,
    endDate: localDateOf(new Date(instantMs(window.end) - 1).toISOString(), HOME_OFFSET_MINUTES) as LocalDate,
  };
}

/**
 * Packet 11C Task 6R: one window endpoint exactly as stored (canonical ISO form of the same instant) with its home-timezone local date
 * and wall-clock time (HH:MM, seconds truncated, as supporting readings show theirs). Unlike `windowDates`, an end is not moved back
 * 1 ms: this is the instant itself, so a half-open window's end reads as the excluded cutoff.
 */
export function homeLocalPoint(instant: string): { instant: Instant; localDate: LocalDate; localTime: string } {
  const at = instantMs(instant);
  const shifted = new Date(at + HOME_OFFSET_MINUTES * 60_000).toISOString();
  return { instant: new Date(at).toISOString() as Instant, localDate: shifted.slice(0, 10) as LocalDate, localTime: shifted.slice(11, 16) };
}

function comparisons(snapshot: IntelligenceSnapshot, now: Instant): HistoryComparison[] {
  const facts: HistoryComparison[] = [];
  for (const slot of HISTORY_LABELLED_SLOTS) {
    const chain = [...snapshot.patternChains.values()].find((candidate) => {
      const claim = candidate.previous.observation.payload.claim;
      return claim.family === "COMPARABLE_SLOT_TREND" && claim.slot.kind === "PATIENT_SELECTED_SLOT" && claim.slot.slot === slot;
    });
    const observation = chain?.previous.observation.payload;
    const snapshotFacts = chain?.previous.snapshot.payload.facts;
    if (
      chain &&
      observation?.lifecycle.state === "SUPPORTED" &&
      observation.claim.family === "COMPARABLE_SLOT_TREND" &&
      snapshotFacts?.family === "COMPARABLE_SLOT_TREND"
    ) {
      const typical = observation.claim.observedChange.typicalValue;
      const directional = typical === "HIGHER" || typical === "LOWER";
      facts.push({
        factId: `COMPARISON:${slot}`,
        slot,
        kind: directional ? typical : "VARIABILITY",
        recent: directional ? snapshotFacts.recent.summary.median : snapshotFacts.recent.summary.dispersion.valueMmolL,
        reference: directional ? snapshotFacts.reference.summary.median : snapshotFacts.reference.summary.dispersion.valueMmolL,
        recentWindow: windowDates(snapshotFacts.recent.window),
        referenceWindow: windowDates(snapshotFacts.reference.window),
        correctionUpdated: chain.previous.snapshot.payload.consideredButExcluded.some((entry) => entry.reason === "CORRECTED_AWAY"),
      });
      continue;
    }
    // The same governed rule, read-only: comparable records without a material difference.
    const evaluation = evaluateComparableSlotTrend({
      evaluatedAt: now,
      inputSequenceCutoff: snapshot.inputSequenceCutoff,
      slot: { kind: "PATIENT_SELECTED_SLOT", slot },
      readings: snapshot.glucose,
      superseded: snapshot.glucoseSuperseded,
      previous: null,
    });
    if (evaluation.result.kind === "NO_MATERIAL_DIFFERENCE" && evaluation.result.coverage === "SUPPORTED") {
      const recentStart = new Date(instantMs(now) - 14 * DAY_MS).toISOString();
      const referenceStart = new Date(instantMs(now) - 42 * DAY_MS).toISOString();
      const slotReadings = snapshot.glucose.filter(
        (reading) => reading.payload.context.kind === "PATIENT_SELECTED_SLOT" && reading.payload.context.slot === slot,
      );
      facts.push({
        factId: `NO_MATERIAL:${slot}`,
        slot,
        kind: "NO_MATERIAL",
        recent: null,
        reference: null,
        recentWindow: windowDates({ start: recentStart, end: now }),
        referenceWindow: windowDates({ start: referenceStart, end: recentStart }),
        correctionUpdated: slotReadings.some((reading) => reading.revisionNumber > 1),
      });
    }
  }
  return facts;
}

function repeated(snapshot: IntelligenceSnapshot, range: DateRange): HistoryProjection["repeated"] {
  const inRange = (point: { instant: string; offset: number } | null) => {
    if (!point) return null;
    const date = localDateOf(point.instant, point.offset);
    return date >= range.startDate && date <= range.endDate ? { ...point, date } : null;
  };
  const results: HistoryProjection["repeated"] = [];
  for (const chain of snapshot.patternChains.values()) {
    const observation = chain.previous.observation.payload;
    if (observation.claim.family !== "FAMILIAR_OR_FREQUENT_ITEM" || observation.lifecycle.state !== "SUPPORTED") continue;
    const item = observation.claim.item;
    const occasions = new Map<number, string>();
    if (item.kind === "INTAKE_ITEM") {
      for (const event of snapshot.intakeEvents) {
        if (!resolveIntakeIdentities(event.payload.items).some((identity) => identity.familiarItemKey === item.familiarItemKey)) continue;
        const point = inRange(occurrencePoint(event.temporal));
        if (point) occasions.set(instantMs(point.instant), point.date);
      }
    } else {
      for (const event of snapshot.activityEvents) {
        if (resolveActivityIdentity(event.payload).familiarItemKey !== item.familiarItemKey) continue;
        const point = inRange(occurrencePoint(event.temporal));
        if (point) occasions.set(instantMs(point.instant), point.date);
      }
    }
    if (occasions.size < 2) continue;
    results.push({
      factId: `REPEATED:${item.familiarItemKey}`,
      kind: item.kind === "INTAKE_ITEM" ? "ITEM" : "CONTEXT",
      label: item.label.text,
      count: occasions.size,
      days: new Set(occasions.values()).size,
    });
  }
  return results.sort((a, b) => (a.kind === b.kind ? (a.label < b.label ? -1 : a.label > b.label ? 1 : 0) : a.kind === "ITEM" ? -1 : 1));
}

export function createRecordedHistoryQuery(database: JagaOnDatabase, dependencies: Dependencies): RecordedHistoryQueryPort {
  async function load(request: { period: HistoryPeriod; families?: readonly PatternFamily[] }): Promise<RecordedHistoryView> {
    const now = dependencies.now();
    const unavailableFamilies = (request.families ?? enabledPatternFamilies()).filter(
      (family) => resolvePatternFamily(family).kind !== "ENABLED",
    );
    const range = historyRange(request.period, now);
    let snapshot: IntelligenceSnapshot;
    try {
      snapshot = await loadIntelligenceSnapshot(database, now);
    } catch (error) {
      return { status: "UNAVAILABLE", code: error instanceof IntelligenceIntegrityError ? "INTEGRITY_FAILURE" : "STORAGE_UNAVAILABLE" };
    }

    try {
      const readings = snapshot.glucose
        .map((reading) => ({ reading, point: readingPoint(reading) }))
        .filter((entry): entry is { reading: ResolvedGlucoseReading; point: { instant: string; offset: number } } => entry.point !== null)
        .map((entry) => ({ ...entry, display: displayPosition(entry.point.instant, entry.point.offset) }))
        .filter((entry) => entry.display.date >= range.startDate && entry.display.date <= range.endDate)
        .sort((a, b) => instantMs(a.point.instant) - instantMs(b.point.instant));

      if (readings.length === 0) {
        return recordedHistoryViewSchema.parse({ status: "EMPTY", period: request.period, range, unavailableFamilies });
      }

      // Display positions up to now; later positions have not occurred yet.
      const chart: HistoryChartPosition[] = [];
      const stamps: HistoryProjection["stamps"] = [];
      for (let date = range.startDate; date <= range.endDate; date = addLocalDays(date, 1)) {
        let included = 0;
        let recorded = 0;
        for (const position of HISTORY_DISPLAY_POSITIONS) {
          if (positionStart(date, position) > instantMs(now)) continue;
          included += 1;
          const here = readings.filter((entry) => entry.display.date === date && entry.display.position === position);
          const valued = here.filter((entry) => storedMmolValue(entry.reading.payload) !== null);
          if (here.length > 0 && valued.length > 0) {
            recorded += 1;
            chart.push({
              date,
              position,
              state: "RECORDED",
              valueMmolL: storedMmolValue(valued.at(-1)!.reading.payload) as never,
              readingCount: here.length,
              readings: valued.map((entry) => ({ valueMmolL: storedMmolValue(entry.reading.payload) as never, at: entry.point.instant as never })),
            });
          } else {
            chart.push({ date, position, state: "NOT_RECORDED" });
          }
        }
        // Owner decision 2026-10-16: readings at two or more times of day complete the day (two readings a day is fine).
        if (included > 0) stamps.push({ date, recordedPositions: recorded, complete: recorded >= MIN_POSITIONS_FOR_COMPLETE_DAY });
      }

      const values = readings.map((entry) => storedMmolValue(entry.reading.payload)).filter((value): value is string => value !== null);
      const sortedValues = [...values].sort((a, b) => compareRational(decimal(a), decimal(b)));
      const slotCounts = HISTORY_LABELLED_SLOTS.map((slot) => ({
        slot,
        count: readings.filter(
          (entry) => entry.reading.payload.context.kind === "PATIENT_SELECTED_SLOT" && entry.reading.payload.context.slot === slot,
        ).length,
      })).filter((entry) => entry.count > 0) as { slot: HistorySlot; count: number }[];

      const eventsInRange = [...snapshot.intakeEvents, ...snapshot.activityEvents].filter((event) => {
        const point = occurrencePoint(event.temporal);
        if (!point) return false;
        const date = localDateOf(point.instant, point.offset);
        return date >= range.startDate && date <= range.endDate;
      });
      const correctedRecordCount =
        readings.filter((entry) => entry.reading.revisionNumber > 1).length +
        eventsInRange.filter((event) => event.revisionNumber > 1).length;

      const comparisonFacts = comparisons(snapshot, now);
      const repeatedFacts = repeated(snapshot, range);
      // A complete day's empty time of day is not listed as missing (owner decision 2026-10-16: two readings a day is fine); the chart
      // still draws it as an empty outline, never as zero.
      const completeDays = new Set(stamps.filter((stamp) => stamp.complete).map((stamp) => stamp.date));
      const notRecordedPositions = chart
        .filter((position) => position.state === "NOT_RECORDED" && !completeDays.has(position.date))
        .map((position) => ({ date: position.date, position: position.position }));
      const valueRange = sortedValues.length > 0 ? { minimum: sortedValues[0]!, maximum: sortedValues.at(-1)! } : null;

      const projection: HistoryProjection = {
        period: request.period,
        range,
        unit: "MMOL_L",
        readingCount: readings.length,
        valueRange: valueRange as never,
        slotCounts,
        chart,
        notRecordedPositions,
        stamps,
        source: "PATIENT_ENTERED",
        correctedRecordCount,
        repeated: repeatedFacts,
        selectableFactIds: [
          "READING_COUNT",
          ...(valueRange ? ["VALUE_RANGE"] : []),
          ...slotCounts.map((entry) => `SLOT_COUNT:${entry.slot}`),
          ...comparisonFacts.map((fact) => fact.factId),
          ...repeatedFacts.map((fact) => fact.factId),
          ...(notRecordedPositions.length > 0 ? ["NOT_RECORDED_POSITIONS"] : []),
          "SOURCE",
          ...(correctedRecordCount > 0 ? ["CORRECTIONS"] : []),
        ],
      };
      return recordedHistoryViewSchema.parse(
        comparisonFacts.length > 0
          ? { status: "READY", projection, comparisons: comparisonFacts, unavailableFamilies }
          : { status: "INSUFFICIENT_EVIDENCE", projection, comparisons: [], unavailableFamilies },
      );
    } catch {
      return { status: "UNAVAILABLE", code: "INTEGRITY_FAILURE" };
    }
  }

  /** Packet 11C A1: any integrity or storage failure leaves the factual card only. */
  async function loadExplainablePattern(request: ExplainablePatternRequest): Promise<ExplainablePatternResult> {
    try {
      const snapshot = await loadIntelligenceSnapshot(database, dependencies.now());
      return projectExplainablePattern(snapshot, request.factId);
    } catch {
      return { kind: "INELIGIBLE", reason: "UNAVAILABLE" };
    }
  }

  return Object.freeze({ load, loadExplainablePattern });
}
