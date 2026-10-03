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
import { canonicalDecimal, compareRational, decimal, instantMs, localDateOf } from "@/application/intelligence/metrics";
import { evaluateComparableSlotTrend } from "@/patterns/comparable-slot-trend-evaluator";
import type { ResolvedGlucoseReading } from "@/patterns/pattern-evaluator-contracts";
import {
  HISTORY_LABELLED_SLOTS,
  recordedHistoryViewSchema,
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
  return { date: shifted.toISOString().slice(0, 10) as LocalDate, position: shifted.getUTCHours() < 12 ? "MORNING" : "EVENING" };
}

function positionStart(date: string, position: HistoryDisplayPosition): number {
  return Date.parse(`${date}T${position === "MORNING" ? "00" : "12"}:00:00Z`) - HOME_OFFSET_MINUTES * 60_000;
}

function canonicalValue(payload: GlucoseReadingPayload): string | null {
  const measurement = payload.measurement;
  if (measurement.normalization?.canonicalUnit === "MMOL_L") return canonicalDecimal(decimal(measurement.normalization.canonicalValue));
  return measurement.enteredUnit === "MMOL_L" ? canonicalDecimal(decimal(measurement.enteredValue)) : null;
}

function readingPoint(reading: ResolvedGlucoseReading): { instant: string; offset: number } | null {
  return occurrencePoint(reading.temporal as never);
}

function windowDates(window: { start: string; end: string }): DateRange {
  return {
    startDate: localDateOf(window.start, HOME_OFFSET_MINUTES) as LocalDate,
    endDate: localDateOf(new Date(instantMs(window.end) - 1).toISOString(), HOME_OFFSET_MINUTES) as LocalDate,
  };
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
        for (const position of ["MORNING", "EVENING"] as const) {
          if (positionStart(date, position) > instantMs(now)) continue;
          included += 1;
          const here = readings.filter((entry) => entry.display.date === date && entry.display.position === position);
          const valued = here.filter((entry) => canonicalValue(entry.reading.payload) !== null);
          if (here.length > 0 && valued.length > 0) {
            recorded += 1;
            chart.push({
              date,
              position,
              state: "RECORDED",
              valueMmolL: canonicalValue(valued.at(-1)!.reading.payload) as never,
              readingCount: here.length,
            });
          } else {
            chart.push({ date, position, state: "NOT_RECORDED" });
          }
        }
        if (included > 0) stamps.push({ date, recordedPositions: recorded, complete: included === 2 && recorded === 2 });
      }

      const values = readings.map((entry) => canonicalValue(entry.reading.payload)).filter((value): value is string => value !== null);
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
      const notRecordedPositions = chart
        .filter((position) => position.state === "NOT_RECORDED")
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

  return Object.freeze({ load });
}
