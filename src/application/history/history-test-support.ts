import { createJagaOnDatabase, type JagaOnDatabase } from "@/storage/database";
import { createJournalCommandService } from "@/application/journal/journal-command-service";
import type { JournalCommandService } from "@/application/journal/journal-contracts";
import { createIntelligenceCoordinator } from "@/application/intelligence/intelligence-coordinator";
import type { Instant } from "@/domain/shared/time";
import { createRecordedHistoryQuery } from "./recorded-history-query";

/**
 * Test support for the Recorded-history query (test-only; never imported by
 * runtime code). The caller installs fake-indexeddb as Dexie's dependency and
 * closes and deletes every database pushed to `databases` after each test.
 */

/** Databases opened by `setup()`; the calling test file closes and deletes them. */
export const databases: JagaOnDatabase[] = [];

// Sunday 4 Oct 2026, 10:00 in Singapore.
export const NOW = "2026-10-04T02:00:00.000Z" as Instant;
const uuid = () => crypto.randomUUID() as never;

export async function setup() {
  const database = createJagaOnDatabase(`history-${crypto.randomUUID()}`);
  databases.push(database);
  await database.open();
  const ids = { commandId: uuid, correlationId: uuid, recordId: uuid, revisionId: uuid, auditEventId: uuid, transactionId: uuid, domainEventId: uuid };
  const journal = createJournalCommandService(database, { now: () => "2026-10-04T01:00:00.000Z" as Instant, ids });
  const coordinator = createIntelligenceCoordinator(database, { now: () => NOW, ids: { ...ids, evaluationId: uuid, leaseToken: uuid }, instanceId: "t" });
  const history = createRecordedHistoryQuery(database, { now: () => NOW });
  return { database, journal, coordinator, history };
}

/** Local Singapore wall-clock time on a date. */
export function local(date: string, time: string) {
  const instant = new Date(`${date}T${time}:00+08:00`).toISOString() as Instant;
  return { kind: "POINT" as const, occurrence: { kind: "EXACT" as const, instantUtc: instant, timeZoneId: "Asia/Singapore", utcOffsetMinutes: 480 } };
}

/**
 * Packet 11C B4a: a wall-clock time recorded at another UTC offset (for example +05:30 in Asia/Kolkata). The instant is the one that
 * local time and offset name; nothing about it is inferred from Singapore time.
 */
export function atOffset(date: string, time: string, utcOffsetMinutes: number, timeZoneId: string) {
  const localMs = Date.parse(`${date}T${time}:00.000Z`);
  const instant = new Date(localMs - utcOffsetMinutes * 60_000).toISOString() as Instant;
  return { kind: "POINT" as const, occurrence: { kind: "EXACT" as const, instantUtc: instant, timeZoneId, utcOffsetMinutes } };
}

export async function reading(journal: JournalCommandService, date: string, time: string, value: string, slot = "BEFORE_BREAKFAST", temporal = local(date, time)) {
  const result = await journal.recordGlucose({
    payload: {
      measurement: { enteredValue: value as never, enteredUnit: "MMOL_L", normalization: null },
      measurementMethod: "FINGERSTICK_METER",
      context: { kind: "PATIENT_SELECTED_SLOT", slot: slot as never },
    },
    temporal,
    recordedAt: "2026-10-04T01:00:00.000Z" as Instant,
  });
  if (result.kind !== "COMMITTED") throw new Error("reading failed");
  return result;
}

export function dayBefore(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

// --- Real-evaluator comparison fixtures, shared by the view and request-builder tests ---
// Every lifecycle, count and median comes out of JournalCommandService -> processPending() -> the real evaluator.

export const TODAY = "2026-10-04";
export const FACT = "COMPARISON:BEFORE_BREAKFAST";
export const REFERENCE: Array<[number, string]> = [[16, "5.8"], [18, "6.0"], [20, "6.1"], [23, "5.9"], [25, "6.2"], [27, "6.0"], [30, "5.7"], [33, "6.3"]];
export const RECENT: Array<[number, string]> = [[1, "7.2"], [3, "7.4"], [5, "7.1"], [8, "7.6"], [10, "7.3"], [12, "7.5"]];

/** A HIGHER before-breakfast comparison: 8 earlier and 6 recent readings. */
export async function higherFixture() {
  const harness = await setup();
  const recorded = [];
  for (const [d, v] of [...REFERENCE, ...RECENT]) recorded.push(await reading(harness.journal, dayBefore(TODAY, d), "07:30", v));
  await harness.coordinator.processPending();
  return { ...harness, recorded };
}

/** Variability-only support needs a successive evaluation with a new recent reading (evaluator rule). */
const VARIABILITY_REFERENCE: Array<[number, string]> = [[16, "6.0"], [18, "6.1"], [20, "6.0"], [23, "6.2"], [25, "6.1"], [27, "6.0"], [30, "6.1"], [33, "6.2"]];
const VARIABILITY_RECENT: Array<[number, string]> = [[3, "5.0"], [5, "8.0"], [6, "5.5"], [8, "8.5"], [10, "5.2"], [12, "8.2"]];
const VARIABILITY_SUCCESSIVE: [number, string] = [1, "6.5"];

export async function variabilityFixture() {
  const harness = await setup();
  for (const [d, v] of [...VARIABILITY_REFERENCE, ...VARIABILITY_RECENT]) await reading(harness.journal, dayBefore(TODAY, d), "07:30", v);
  await harness.coordinator.processPending();
  const first = await harness.history.loadExplainablePattern({ factId: FACT });
  await reading(harness.journal, dayBefore(TODAY, VARIABILITY_SUCCESSIVE[0]), "07:30", VARIABILITY_SUCCESSIVE[1]);
  await harness.coordinator.processPending();
  return { ...harness, first };
}

/**
 * Packet 11C Task 6R boundary-day case. The evaluator's windows are instant-based: earlier `[T−42d, T−14d)`, recent `[T−14d, T)`, with
 * T = NOW (10:00 in Singapore). So the shared boundary is 10:00 on BOUNDARY_DATE, and that one local date belongs to both periods' date
 * ranges. One reading on that date before the cutoff (earlier) and one after it (recent), on top of the HIGHER readings.
 */
export const BOUNDARY_DATE = dayBefore(TODAY, 14);
/** A late before-breakfast reading at 10:30 is after the 10:00 cutoff; the evaluator alone decides its period (recent). */
export const BOUNDARY_DAY_READINGS = Object.freeze({ before: Object.freeze(["07:30", "6.0"] as const), after: Object.freeze(["10:30", "7.4"] as const) });

export async function boundaryDayFixture() {
  const harness = await setup();
  for (const [d, v] of [...REFERENCE, ...RECENT]) await reading(harness.journal, dayBefore(TODAY, d), "07:30", v);
  const before = await reading(harness.journal, BOUNDARY_DATE, ...BOUNDARY_DAY_READINGS.before);
  const after = await reading(harness.journal, BOUNDARY_DATE, ...BOUNDARY_DAY_READINGS.after);
  await harness.coordinator.processPending();
  return { ...harness, boundary: { before, after } };
}

/**
 * Packet 11C B4a (D7) foreign-offset case, on top of the HIGHER readings: three before-breakfast readings recorded at +05:30
 * (Asia/Kolkata). The evaluator alone places them, by instant:
 * - `beforeCutoff`: 07:15 +05:30 on BOUNDARY_DATE = 09:45 Singapore time, before the 10:00 cutoff (EARLIER);
 * - `afterCutoff`: 07:45 +05:30 on BOUNDARY_DATE = 10:15 Singapore time, after the cutoff (RECENT), although its own wall-clock time is
 *   earlier than 10:00;
 * - `outerEdge`: 22:00 +05:30 on the day before TODAY = 00:30 Singapore time on TODAY, the recent window's end date (RECENT, last).
 */
export const FOREIGN_OFFSET_MINUTES = 330;
export const FOREIGN_TIME_ZONE = "Asia/Kolkata";
export const FOREIGN_OFFSET_READINGS = Object.freeze({
  beforeCutoff: Object.freeze({ date: BOUNDARY_DATE, time: "07:15", value: "6.0", singapore: Object.freeze({ date: BOUNDARY_DATE, time: "09:45" }) }),
  afterCutoff: Object.freeze({ date: BOUNDARY_DATE, time: "07:45", value: "7.4", singapore: Object.freeze({ date: BOUNDARY_DATE, time: "10:15" }) }),
  outerEdge: Object.freeze({ date: dayBefore(TODAY, 1), time: "22:00", value: "7.3", singapore: Object.freeze({ date: TODAY, time: "00:30" }) }),
});

export async function foreignOffsetFixture() {
  const harness = await setup();
  for (const [d, v] of [...REFERENCE, ...RECENT]) await reading(harness.journal, dayBefore(TODAY, d), "07:30", v);
  const foreign: Record<keyof typeof FOREIGN_OFFSET_READINGS, Awaited<ReturnType<typeof reading>>> = {} as never;
  for (const [key, entry] of Object.entries(FOREIGN_OFFSET_READINGS) as Array<[keyof typeof FOREIGN_OFFSET_READINGS, (typeof FOREIGN_OFFSET_READINGS)[keyof typeof FOREIGN_OFFSET_READINGS]]>) {
    foreign[key] = await reading(harness.journal, entry.date, entry.time, entry.value, "BEFORE_BREAKFAST", atOffset(entry.date, entry.time, FOREIGN_OFFSET_MINUTES, FOREIGN_TIME_ZONE));
  }
  await harness.coordinator.processPending();
  return { ...harness, foreign };
}

/**
 * The evaluator counts one occasion per distinct instant in the slot, so three before-breakfast readings on each
 * of twelve reference days are 36 occasions (plus the 6 RECENT readings).
 */
export const LARGE_PERIOD_TIMES = ["07:00", "07:10", "07:20"] as const;

export async function largePeriodFixture() {
  const harness = await setup();
  const referenceDays = [15, 17, 19, 21, 23, 25, 27, 29, 31, 33, 35, 37];
  const referenceValues = ["5.8", "6.0", "6.1", "5.9", "6.2", "6.0"];
  let index = 0;
  for (const d of referenceDays) {
    for (const time of LARGE_PERIOD_TIMES) await reading(harness.journal, dayBefore(TODAY, d), time, referenceValues[index++ % referenceValues.length]!);
  }
  for (const [d, v] of RECENT) await reading(harness.journal, dayBefore(TODAY, d), "07:30", v);
  await harness.coordinator.processPending();
  return harness;
}
