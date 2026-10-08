import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import Dexie from "dexie";
import fakeIndexedDB, { IDBKeyRange as FDBKeyRange } from "fake-indexeddb";
import type { Instant } from "@/domain/shared/time";
import { patternEvidenceSnapshotPayloadSchema } from "@/domain/patterns";
import { loadIntelligenceSnapshot, type IntelligenceSnapshot } from "@/application/intelligence/intelligence-snapshot";
import { explainablePatternResultSchema, explainablePatternViewSchema, type ExplainablePatternResult, type ExplainablePatternView } from "./recorded-history-contracts";
import { projectExplainablePattern } from "./explainable-pattern-view";
import {
  BOUNDARY_DATE,
  BOUNDARY_DAY_READINGS,
  boundaryDayFixture,
  databases,
  atOffset,
  dayBefore,
  FACT,
  FOREIGN_OFFSET_MINUTES,
  FOREIGN_OFFSET_READINGS,
  FOREIGN_TIME_ZONE,
  foreignOffsetFixture,
  higherFixture,
  largePeriodFixture,
  LARGE_PERIOD_TIMES,
  local,
  NOW,
  reading,
  RECENT,
  REFERENCE,
  setup,
  TODAY,
  variabilityFixture,
} from "./history-test-support";

const originalIndexedDB = Dexie.dependencies.indexedDB;
const originalIDBKeyRange = Dexie.dependencies.IDBKeyRange;
beforeAll(() => {
  Dexie.dependencies.indexedDB = fakeIndexedDB;
  Dexie.dependencies.IDBKeyRange = FDBKeyRange;
});
afterAll(() => {
  Dexie.dependencies.indexedDB = originalIndexedDB;
  Dexie.dependencies.IDBKeyRange = originalIDBKeyRange;
});
afterEach(async () => {
  for (const database of databases) database.close();
  for (const database of databases.splice(0)) await Dexie.delete(database.name);
});

function explainable(result: ExplainablePatternResult): ExplainablePatternView {
  if (result.kind !== "EXPLAINABLE") throw new Error(`unexpected ${JSON.stringify(result)}`);
  expect(explainablePatternResultSchema.safeParse(result).success).toBe(true);
  return result.view;
}

function comparisonChain(snapshot: IntelligenceSnapshot) {
  const chain = [...snapshot.patternChains.values()].find((candidate) => candidate.previous.observation.payload.claim.family === "COMPARABLE_SLOT_TREND");
  if (!chain) throw new Error("no comparison chain");
  const facts = chain.previous.snapshot.payload.facts;
  if (facts.family !== "COMPARABLE_SLOT_TREND") throw new Error("wrong family");
  return { chain, facts };
}

/** A deep clone of a snapshot loaded from the real database; mutations bypass every schema. */
async function loadedClone(database: Parameters<typeof loadIntelligenceSnapshot>[0]): Promise<IntelligenceSnapshot> {
  return structuredClone(await loadIntelligenceSnapshot(database, NOW));
}

describe("ExplainablePatternView (Packet 11C Addendum A1)", () => {
  it("projects a SUPPORTED comparison produced by the real evaluator, with every supporting reading by period", async () => {
    const { journal, coordinator, history } = await setup();
    for (const [d, v] of [...REFERENCE, ...RECENT]) await reading(journal, dayBefore(TODAY, d), "07:30", v);
    await coordinator.processPending();
    const result = await history.loadExplainablePattern({ factId: FACT });
    expect(result.kind).toBe("EXPLAINABLE");
    const view = explainable(result);
    expect(view.factId).toBe(FACT);
    expect(view.slot).toBe("BEFORE_BREAKFAST");
    expect(view.kind).toBe("HIGHER");
    expect(view.periods.map((p) => [p.role, p.count, p.summary, p.readings.length])).toEqual([
      ["EARLIER", 8, { kind: "MEDIAN", valueMmolL: "6" }, 8],
      ["RECENT", 6, { kind: "MEDIAN", valueMmolL: "7.35" }, 6],
    ]);
    expect(view.totalCount).toBe(14);
    // Every reading is a current revision inside its window, sorted by time.
    expect(view.periods[0].readings.map((r) => r.enteredValue)).toEqual(["6.3", "5.7", "6.0", "6.2", "5.9", "6.1", "6.0", "5.8"]);
    expect(view.periods[1].readings.map((r) => r.enteredValue)).toEqual(["7.5", "7.3", "7.6", "7.1", "7.4", "7.2"]);
    expect(view.periods[0].readings[0]).toMatchObject({
      localDate: dayBefore(TODAY, 33),
      localTime: "07:30",
      enteredUnit: "MMOL_L",
      method: "FINGERSTICK_METER",
      ref: { recordType: "GLUCOSE_READING" },
    });
    for (const period of view.periods) {
      for (const supporting of period.readings) {
        expect(supporting.localDate >= period.window.startDate && supporting.localDate <= period.window.endDate).toBe(true);
      }
    }
    expect(view.observationRef.recordType).toBe("PATTERN_OBSERVATION");
    expect(view.snapshotRef.recordType).toBe("PATTERN_EVIDENCE_SNAPSHOT");
    // The view agrees with the existing READY history comparison (same medians and windows).
    const ready = await history.load({ period: "THIRTY_DAYS" });
    expect(ready.status === "READY" && ready.comparisons[0]).toMatchObject({
      recent: "7.35",
      reference: "6",
      recentWindow: view.periods[1].window,
      referenceWindow: view.periods[0].window,
    });
  });

  it("lists each reading's revision exactly as the evidence snapshot assigns it, with the snapshot and observation refs", async () => {
    const { database, history } = await higherFixture();
    const view = explainable(await history.loadExplainablePattern({ factId: FACT }));
    const { chain, facts } = comparisonChain(await loadIntelligenceSnapshot(database, NOW));
    expect(view.periods[0].readings.map((r) => r.ref)).toEqual(facts.reference.assignments.map((a) => a.reading));
    expect(view.periods[1].readings.map((r) => r.ref)).toEqual(facts.recent.assignments.map((a) => a.reading));
    expect(view.observationRef).toEqual({
      recordType: "PATTERN_OBSERVATION",
      recordId: chain.previous.observation.recordId,
      revisionId: chain.previous.observation.revisionId,
    });
    expect(view.snapshotRef).toEqual(chain.previous.observation.payload.evidenceSnapshot);
  });

  it("fails closed with STALE_SOURCE after a correction until the evaluator re-runs, then lists the corrected value", async () => {
    const { journal, coordinator, history, recorded } = await higherFixture();
    const target = recorded.at(-1)!;
    const corrected = await journal.correctGlucoseTime({
      recordId: target.recordId,
      expectedRevisionId: target.revisionId,
      expectedRevisionNumber: 1,
      payload: {
        measurement: { enteredValue: "7.8" as never, enteredUnit: "MMOL_L", normalization: null },
        measurementMethod: "FINGERSTICK_METER",
        context: { kind: "PATIENT_SELECTED_SLOT", slot: "BEFORE_BREAKFAST" },
      },
      temporal: local(dayBefore(TODAY, 12), "07:45"),
      recordedAt: "2026-10-04T01:00:00.000Z" as Instant,
    });
    expect(corrected.kind).toBe("COMMITTED");
    expect(await history.loadExplainablePattern({ factId: FACT })).toEqual({ kind: "INELIGIBLE", reason: "STALE_SOURCE" });

    await coordinator.processPending();
    const view = explainable(await history.loadExplainablePattern({ factId: FACT }));
    const listed = view.periods[1].readings.find((r) => r.ref.recordId === target.recordId);
    expect(listed).toMatchObject({ enteredValue: "7.8", localTime: "07:45", localDate: dayBefore(TODAY, 12) });
    expect(listed?.ref.revisionId).not.toBe(target.revisionId);
    expect(view.periods[1].readings.map((r) => r.enteredValue)).not.toContain("7.5");
  });

  it("never explains a read-only NO_MATERIAL comparison", async () => {
    const { journal, coordinator, history } = await setup();
    const days = [16, 18, 20, 23, 25, 27, 30, 33, 1, 3, 5, 8, 10, 12];
    for (const [i, d] of days.entries()) {
      await reading(journal, dayBefore(TODAY, d), "18:30", i % 2 === 0 ? "7.0" : "7.2", "BEFORE_DINNER");
    }
    await coordinator.processPending();
    const ready = await history.load({ period: "THIS_WEEK" });
    expect(ready.status === "READY" && ready.comparisons.map((c) => c.factId)).toEqual(["NO_MATERIAL:BEFORE_DINNER"]);
    expect(await history.loadExplainablePattern({ factId: "NO_MATERIAL:BEFORE_DINNER" })).toEqual({ kind: "INELIGIBLE", reason: "NO_MATERIAL" });
    expect(await history.loadExplainablePattern({ factId: "COMPARISON:BEFORE_DINNER" })).toEqual({ kind: "INELIGIBLE", reason: "NOT_FOUND" });
  });

  it("never explains an observation the evaluator has not SUPPORTED", async () => {
    const { journal, coordinator, history } = await setup();
    for (const [d, v] of [...REFERENCE.slice(0, 4), ...RECENT.slice(0, 3)]) await reading(journal, dayBefore(TODAY, d), "07:30", v);
    await coordinator.processPending();
    const view = await history.load({ period: "THIRTY_DAYS" });
    expect(view.status).toBe("INSUFFICIENT_EVIDENCE");
    const result = await history.loadExplainablePattern({ factId: FACT });
    expect(result).toEqual({ kind: "INELIGIBLE", reason: "NOT_SUPPORTED" });
  });

  it("returns NOT_FOUND for an unknown or empty fact and UNAVAILABLE when stored history fails integrity", async () => {
    const { database, journal, history } = await setup();
    expect(await history.loadExplainablePattern({ factId: FACT })).toEqual({ kind: "INELIGIBLE", reason: "NOT_FOUND" });
    expect(await history.loadExplainablePattern({ factId: "COMPARISON:LUNCHTIME" })).toEqual({ kind: "INELIGIBLE", reason: "NOT_FOUND" });
    expect(await history.loadExplainablePattern({ factId: "REPEATED:kaya" })).toEqual({ kind: "INELIGIBLE", reason: "NOT_FOUND" });
    const result = await reading(journal, "2026-09-29", "07:30", "6.0");
    await database.table("recordRevisions").update(result.revisionId, { "revision.payload.measurement.enteredValue": "not-a-number" });
    expect(await history.loadExplainablePattern({ factId: FACT })).toEqual({ kind: "INELIGIBLE", reason: "UNAVAILABLE" });
  });

  it("projects a VARIABILITY comparison with both interquartile ranges taken from the evaluator's IQR dispersion", async () => {
    const { database, history, first } = await variabilityFixture();
    // The first evaluation awaits a successive one, so it is not explainable yet.
    expect(first).toEqual({ kind: "INELIGIBLE", reason: "NOT_SUPPORTED" });
    const view = explainable(await history.loadExplainablePattern({ factId: FACT }));
    expect(view.kind).toBe("VARIABILITY");
    const { facts } = comparisonChain(await loadIntelligenceSnapshot(database, NOW));
    expect([facts.reference.summary.dispersion.metric, facts.recent.summary.dispersion.metric]).toEqual(["IQR", "IQR"]);
    expect(view.periods.map((p) => p.summary)).toEqual([
      { kind: "IQR", valueMmolL: facts.reference.summary.dispersion.valueMmolL },
      { kind: "IQR", valueMmolL: facts.recent.summary.dispersion.valueMmolL },
    ]);
    // Tukey-hinge IQRs as the evaluator computed them: 6.15 − 6.0 and 8.1 − 5.35.
    expect(view.periods.map((p) => p.summary.valueMmolL)).toEqual(["0.15", "2.75"]);
    expect(view.periods.map((p) => [p.count, p.readings.length])).toEqual([[8, 8], [7, 7]]);
    const ready = await history.load({ period: "THIRTY_DAYS" });
    expect(ready.status === "READY" && ready.comparisons[0]).toMatchObject({
      kind: "VARIABILITY",
      reference: view.periods[0].summary.valueMmolL,
      recent: view.periods[1].summary.valueMmolL,
    });
  });

  it("keeps every reading of a period with more than 32 evaluator-assigned occasions, without truncation", async () => {
    const { history, database } = await largePeriodFixture();
    const times = LARGE_PERIOD_TIMES;

    const view = explainable(await history.loadExplainablePattern({ factId: FACT }));
    const { facts } = comparisonChain(await loadIntelligenceSnapshot(database, NOW));
    expect(facts.reference.summary.distinctOccasionCount).toBe(36);
    expect(facts.reference.summary.distinctDayCount).toBe(12);
    expect(view.periods.map((p) => [p.role, p.count, p.readings.length])).toEqual([
      ["EARLIER", 36, 36],
      ["RECENT", 6, 6],
    ]);
    expect(view.kind).toBe("HIGHER");
    expect(view.totalCount).toBe(42);
    expect(new Set(view.periods[0].readings.map((r) => r.ref.revisionId)).size).toBe(36);
    expect(view.periods[0].readings.slice(0, 3).map((r) => [r.localDate, r.localTime])).toEqual(times.map((time) => [dayBefore(TODAY, 37), time]));
  });
});

describe("Packet 11C Task 6R: the shared period boundary and included-reading counts (real evaluator)", () => {
  // NOW is 10:00 on 4 Oct 2026 in Singapore: earlier [T−42d, T−14d), recent [T−14d, T), shared boundary T−14d.
  const T_MINUS_42 = { instant: "2026-08-23T02:00:00.000Z", localDate: "2026-08-23", localTime: "10:00" };
  const BOUNDARY = { instant: "2026-09-20T02:00:00.000Z", localDate: "2026-09-20", localTime: "10:00" };
  const T = { instant: NOW, localDate: TODAY, localTime: "10:00" };

  it("carries each period's source instants with their home-offset local date and time, and the shared boundary; window dates unchanged", async () => {
    const { database, history } = await higherFixture();
    const view = explainable(await history.loadExplainablePattern({ factId: FACT }));
    const { facts } = comparisonChain(await loadIntelligenceSnapshot(database, NOW));
    expect(view.periods.map((p) => p.bounds)).toEqual([
      { start: T_MINUS_42, end: BOUNDARY },
      { start: BOUNDARY, end: T },
    ]);
    // Source-derived: the evaluator's own window instants, not recomputed.
    expect([facts.reference.window.start, facts.reference.window.end, facts.recent.window.start, facts.recent.window.end].map((at) => new Date(at).toISOString())).toEqual([
      T_MINUS_42.instant,
      BOUNDARY.instant,
      BOUNDARY.instant,
      T.instant,
    ]);
    expect(view.sharedBoundary).toEqual(BOUNDARY);
    // Period semantics and the 7A date ranges are unchanged: the boundary date is the last date of one and the first of the other.
    expect(view.periods.map((p) => p.window)).toEqual([
      { startDate: "2026-08-23", endDate: "2026-09-20" },
      { startDate: "2026-09-20", endDate: TODAY },
    ]);
  });

  it("boundary day: a reading before the 10:00 cutoff on the boundary date is EARLIER, one after it is RECENT; counts reconcile", async () => {
    const { database, history, boundary } = await boundaryDayFixture();
    expect(BOUNDARY_DATE).toBe(BOUNDARY.localDate);
    const view = explainable(await history.loadExplainablePattern({ factId: FACT }));
    expect(view.kind).toBe("HIGHER");
    expect(view.sharedBoundary).toEqual(BOUNDARY);
    const [earlier, recent] = view.periods;
    const before = earlier.readings.filter((r) => r.ref.recordId === boundary.before.recordId);
    const after = recent.readings.filter((r) => r.ref.recordId === boundary.after.recordId);
    expect(before).toEqual([expect.objectContaining({ localDate: BOUNDARY_DATE, localTime: BOUNDARY_DAY_READINGS.before[0], enteredValue: BOUNDARY_DAY_READINGS.before[1] })]);
    expect(after).toEqual([expect.objectContaining({ localDate: BOUNDARY_DATE, localTime: BOUNDARY_DAY_READINGS.after[0], enteredValue: BOUNDARY_DAY_READINGS.after[1] })]);
    expect(recent.readings.map((r) => r.ref.recordId)).not.toContain(boundary.before.recordId);
    expect(earlier.readings.map((r) => r.ref.recordId)).not.toContain(boundary.after.recordId);
    // The before-cutoff reading is the last earlier reading, the after-cutoff one the first recent reading.
    expect(earlier.readings.at(-1)!.ref.recordId).toBe(boundary.before.recordId);
    expect(recent.readings[0]!.ref.recordId).toBe(boundary.after.recordId);
    // The evaluator agrees: each reading is assigned to exactly that period.
    const { facts } = comparisonChain(await loadIntelligenceSnapshot(database, NOW));
    expect(facts.reference.assignments.map((a) => a.reading.recordId)).toContain(boundary.before.recordId);
    expect(facts.recent.assignments.map((a) => a.reading.recordId)).toContain(boundary.after.recordId);
    // Counts: 8 + 1 earlier, 6 + 1 recent; each count is its list's length and the total is their sum.
    expect(view.periods.map((p) => [p.role, p.count, p.readings.length])).toEqual([["EARLIER", 9, 9], ["RECENT", 7, 7]]);
    expect(view.totalCount).toBe(16);
    expect(view.totalCount).toBe(earlier.readings.length + recent.readings.length);
    // Both date ranges still show the boundary date (unchanged period semantics).
    expect(earlier.window.endDate).toBe(BOUNDARY_DATE);
    expect(recent.window.startDate).toBe(BOUNDARY_DATE);
    expect(earlier.bounds.end).toEqual(BOUNDARY);
    expect(recent.bounds.start).toEqual(BOUNDARY);
  });

  it("counts distinct included readings: a same-instant duplicate the evaluator excludes is neither counted nor listed", async () => {
    const { database, journal, coordinator, history } = await setup();
    const recorded = new Map<number, string>();
    for (const [d, v] of [...REFERENCE, ...RECENT]) recorded.set(d, (await reading(journal, dayBefore(TODAY, d), "07:30", v)).recordId);
    // A second reading at exactly the same instant as the earlier reading 18 days ago (same value, so the summary is deterministic).
    const twinDate = dayBefore(TODAY, 18);
    expect(REFERENCE.find(([d]) => d === 18)).toEqual([18, "6.0"]);
    const original = recorded.get(18)!;
    const twin = await reading(journal, twinDate, "07:30", "6.0");
    await coordinator.processPending();
    const view = explainable(await history.loadExplainablePattern({ factId: FACT }));
    const { chain, facts } = comparisonChain(await loadIntelligenceSnapshot(database, NOW));
    const excluded = chain.previous.snapshot.payload.consideredButExcluded.filter((entry) => entry.reason === "DUPLICATE_LOGICAL_OCCASION");
    expect(excluded).toHaveLength(1);
    const excludedId = excluded[0]!.revision.recordId;
    const [earlier, recent] = view.periods;
    const atTwin = earlier.readings.filter((r) => r.localDate === twinDate && r.localTime === "07:30");
    // Exactly one of the two same-instant readings is included and listed, exactly once; the excluded one is nowhere in the view.
    expect(atTwin).toHaveLength(1);
    expect([original, twin.recordId].sort()).toEqual([excludedId, atTwin[0]!.ref.recordId].sort());
    expect(view.periods.flatMap((p) => p.readings.map((r) => r.ref.recordId))).not.toContain(excludedId);
    const keys = view.periods.flatMap((p) => p.readings.map((r) => `${r.ref.recordId}:${r.ref.revisionId}`));
    expect(new Set(keys).size).toBe(keys.length);
    // The count is the evaluator's included readings (8, not the 9 recorded), equal to the listed readings; total = sum.
    expect(earlier.count).toBe(8);
    expect(earlier.count).toBe(facts.reference.assignments.length);
    expect(earlier.count).toBe(earlier.readings.length);
    expect(recent.count).toBe(recent.readings.length);
    expect(view.totalCount).toBe(earlier.count + recent.count);
  });
});

describe("Packet 11C B4a (D7): each supporting reading carries its source instant and recorded UTC offset (real evaluator)", () => {
  it("a Singapore reading carries its own instant and +08:00 (480), exactly as the journal recorded it", async () => {
    const { history, recorded } = await higherFixture();
    const view = explainable(await history.loadExplainablePattern({ factId: FACT }));
    const first = view.periods[0].readings[0]!;
    expect(first).toEqual({
      ref: { recordType: "GLUCOSE_READING", recordId: first.ref.recordId, revisionId: first.ref.revisionId },
      localDate: dayBefore(TODAY, 33),
      localTime: "07:30",
      instantUtc: local(dayBefore(TODAY, 33), "07:30").occurrence.instantUtc,
      utcOffsetMinutes: 480,
      enteredValue: "6.3",
      enteredUnit: "MMOL_L",
      method: "FINGERSTICK_METER",
    });
    expect(recorded.map((entry) => entry.recordId)).toContain(first.ref.recordId);
  });

  it("+05:30 readings on each side of the cutoff and at the outer window edge: the evaluator places them by instant; the view keeps their actual offset", async () => {
    const { database, history, foreign } = await foreignOffsetFixture();
    const view = explainable(await history.loadExplainablePattern({ factId: FACT }));
    const [earlier, recent] = view.periods;
    const find = (key: keyof typeof FOREIGN_OFFSET_READINGS) => view.periods.flatMap((p) => p.readings.map((r) => ({ role: p.role, r }))).find(({ r }) => r.ref.recordId === foreign[key].recordId)!;
    for (const key of Object.keys(FOREIGN_OFFSET_READINGS) as Array<keyof typeof FOREIGN_OFFSET_READINGS>) {
      const entry = FOREIGN_OFFSET_READINGS[key];
      const { r } = find(key);
      // The recorded local date and time at its own offset, and the source instant (never re-derived from Singapore time).
      expect(r).toMatchObject({ localDate: entry.date, localTime: entry.time, utcOffsetMinutes: FOREIGN_OFFSET_MINUTES, instantUtc: atOffset(entry.date, entry.time, FOREIGN_OFFSET_MINUTES, FOREIGN_TIME_ZONE).occurrence.instantUtc });
      expect(new Date(Date.parse(r.instantUtc) + 480 * 60_000).toISOString().slice(0, 16)).toBe(`${entry.singapore.date}T${entry.singapore.time}`);
    }
    // 07:15 +05:30 (09:45 Singapore time) is before the 10:00 cutoff; 07:45 +05:30 (10:15 Singapore time) is at or after it.
    expect(find("beforeCutoff").role).toBe("EARLIER");
    expect(find("afterCutoff").role).toBe("RECENT");
    expect(earlier.readings.at(-1)!.ref.recordId).toBe(foreign.beforeCutoff.recordId);
    expect(recent.readings[0]!.ref.recordId).toBe(foreign.afterCutoff.recordId);
    // 22:00 +05:30 on 3 Oct is 00:30 Singapore time on 4 Oct, the recent window's end date: the last recent reading.
    expect(find("outerEdge").role).toBe("RECENT");
    expect(recent.readings.at(-1)!.ref.recordId).toBe(foreign.outerEdge.recordId);
    expect(find("outerEdge").r.localDate).toBe(dayBefore(TODAY, 1));
    // The evaluator agrees (placement comes from its assignments only), and the counts are the included readings.
    const { facts } = comparisonChain(await loadIntelligenceSnapshot(database, NOW));
    expect(facts.reference.assignments.map((a) => a.reading.recordId)).toContain(foreign.beforeCutoff.recordId);
    expect(facts.recent.assignments.map((a) => a.reading.recordId)).toEqual(expect.arrayContaining([foreign.afterCutoff.recordId, foreign.outerEdge.recordId]));
    expect(view.periods.map((p) => [p.role, p.count, p.readings.length])).toEqual([["EARLIER", 9, 9], ["RECENT", 8, 8]]);
    expect(view.totalCount).toBe(17);
  });

  it("the view schema refuses a reading whose recorded local date and time disagree with its instant and offset", async () => {
    const { history } = await foreignOffsetFixture();
    const view = explainable(await history.loadExplainablePattern({ factId: FACT }));
    expect(explainablePatternViewSchema.safeParse(view).success).toBe(true);
    for (const change of [{ utcOffsetMinutes: 480 }, { localTime: "07:46" }, { instantUtc: "2026-09-20T02:16:00.000Z" }, { utcOffsetMinutes: 330.5 }]) {
      const broken = structuredClone(view);
      Object.assign(broken.periods[1].readings[0]!, change);
      expect(explainablePatternViewSchema.safeParse(broken).success, JSON.stringify(change)).toBe(false);
    }
  });
});

describe("projectExplainablePattern fail-closed reconciliation (pure, on clones of a real snapshot)", () => {
  it("fails closed with UNAVAILABLE when the periods do not share one boundary (a gap or an overlap); a boundary is never invented", async () => {
    const { database } = await higherFixture();
    const base = await loadIntelligenceSnapshot(database, NOW);
    expect(projectExplainablePattern(base, FACT).kind).toBe("EXPLAINABLE");
    const shifted = (minutes: number) => {
      const snapshot = structuredClone(base);
      const recent = comparisonChain(snapshot).facts.recent;
      recent.window.start = new Date(Date.parse(recent.window.start) + minutes * 60_000).toISOString() as never;
      return projectExplainablePattern(snapshot, FACT);
    };
    expect(shifted(60)).toEqual({ kind: "INELIGIBLE", reason: "UNAVAILABLE" });
    expect(shifted(-60)).toEqual({ kind: "INELIGIBLE", reason: "UNAVAILABLE" });
  });

  it("the view schema refuses a shared boundary that disagrees with either period's endpoint", async () => {
    const { history } = await higherFixture();
    const view = explainable(await history.loadExplainablePattern({ factId: FACT }));
    expect(explainablePatternViewSchema.safeParse(view).success).toBe(true);
    const moved = structuredClone(view);
    moved.sharedBoundary = { ...moved.sharedBoundary, localTime: "11:00" };
    expect(explainablePatternViewSchema.safeParse(moved).success).toBe(false);
    const gap = structuredClone(view);
    gap.periods[1].bounds.start = { instant: "2026-09-20T03:00:00.000Z" as never, localDate: "2026-09-20" as never, localTime: "11:00" };
    expect(explainablePatternViewSchema.safeParse(gap).success).toBe(false);
    const inverted = structuredClone(view);
    inverted.periods[0].bounds.start = inverted.periods[0].bounds.end;
    expect(explainablePatternViewSchema.safeParse(inverted).success).toBe(false);
  });

  it("returns MISSING_READING when a supporting reading is absent from the resolved journal", async () => {
    const { database } = await higherFixture();
    const snapshot = await loadedClone(database);
    expect(projectExplainablePattern(snapshot, FACT).kind).toBe("EXPLAINABLE");
    const { facts } = comparisonChain(snapshot);
    const removed = facts.recent.assignments[2]!.reading.recordId;
    snapshot.glucose = snapshot.glucose.filter((entry) => entry.ref.recordId !== removed);
    expect(projectExplainablePattern(snapshot, FACT)).toEqual({ kind: "INELIGIBLE", reason: "MISSING_READING" });
  });

  it("returns COUNT_MISMATCH for an altered occasion count that its own schema rejects at read time", async () => {
    const { database, history } = await higherFixture();
    const snapshot = await loadedClone(database);
    const { chain, facts } = comparisonChain(snapshot);
    facts.reference.summary.distinctOccasionCount += 1;
    expect(patternEvidenceSnapshotPayloadSchema.safeParse(chain.previous.snapshot.payload).success).toBe(false);
    expect(projectExplainablePattern(snapshot, FACT)).toEqual({ kind: "INELIGIBLE", reason: "COUNT_MISMATCH" });

    // Stored, the same alteration fails integrity at read time.
    const snapshotRevisionId = chain.previous.snapshot.revisionId;
    await database.table("recordRevisions").update(snapshotRevisionId, {
      "revision.payload.facts.reference.summary.distinctOccasionCount": facts.reference.summary.distinctOccasionCount,
    });
    const stored = await database.table("recordRevisions").get(snapshotRevisionId);
    expect(stored.revision.payload.facts.reference.summary.distinctOccasionCount).toBe(9);
    expect(await history.loadExplainablePattern({ factId: FACT })).toEqual({ kind: "INELIGIBLE", reason: "UNAVAILABLE" });
  });

  it("returns COUNT_MISMATCH when the total disagrees with the snapshot's evidence count", async () => {
    const { database } = await higherFixture();
    const snapshot = await loadedClone(database);
    const { chain } = comparisonChain(snapshot);
    const coverage = chain.previous.snapshot.payload.coverage;
    if (coverage.kind !== "OBSERVATION_SPAN") throw new Error("unexpected coverage");
    coverage.distinctOccasionCount -= 1;
    expect(projectExplainablePattern(snapshot, FACT)).toEqual({ kind: "INELIGIBLE", reason: "COUNT_MISMATCH" });
  });

  it("returns STALE_SOURCE for a superseded revision, a reading outside its window or slot, or a moved snapshot head", async () => {
    const { database } = await higherFixture();
    const base = await loadIntelligenceSnapshot(database, NOW);
    const target = comparisonChain(base).facts.recent.assignments[0]!.reading;
    const mutate = (change: (entry: IntelligenceSnapshot["glucose"][number]) => void) => {
      const snapshot = structuredClone(base);
      change(snapshot.glucose.find((entry) => entry.ref.recordId === target.recordId)!);
      return projectExplainablePattern(snapshot, FACT);
    };
    expect(mutate((entry) => (entry.ref.revisionId = crypto.randomUUID() as never))).toEqual({ kind: "INELIGIBLE", reason: "STALE_SOURCE" });
    expect(mutate((entry) => (entry.payload.context = { kind: "PATIENT_SELECTED_SLOT", slot: "BEDTIME" as never }))).toEqual({
      kind: "INELIGIBLE",
      reason: "STALE_SOURCE",
    });
    expect(
      mutate((entry) => {
        if (entry.temporal.kind === "POINT" && entry.temporal.occurrence.kind === "EXACT") {
          entry.temporal.occurrence.instantUtc = local(dayBefore(TODAY, 20), "07:30").occurrence.instantUtc as never;
        }
      }),
    ).toEqual({ kind: "INELIGIBLE", reason: "STALE_SOURCE" });

    const moved = structuredClone(base);
    const { chain } = comparisonChain(moved);
    chain.snapshotHeadRevision = { ...chain.snapshotHeadRevision, revisionId: crypto.randomUUID() as never };
    expect(projectExplainablePattern(moved, FACT)).toEqual({ kind: "INELIGIBLE", reason: "STALE_SOURCE" });
  });

  it("returns METHOD_MISMATCH when readings in a period do not share one method", async () => {
    const { database } = await higherFixture();
    const snapshot = await loadedClone(database);
    const target = comparisonChain(snapshot).facts.reference.assignments[3]!.reading;
    snapshot.glucose.find((entry) => entry.ref.recordId === target.recordId)!.payload.measurementMethod = "CGM" as never;
    expect(projectExplainablePattern(snapshot, FACT)).toEqual({ kind: "INELIGIBLE", reason: "METHOD_MISMATCH" });
  });

  it("refuses a non-IQR dispersion as UNSUPPORTED_SUMMARY and never relabels it", async () => {
    const { database } = await variabilityFixture();
    const base = await loadIntelligenceSnapshot(database, NOW);
    expect(projectExplainablePattern(base, FACT).kind).toBe("EXPLAINABLE");
    const both = structuredClone(base);
    const bothFacts = comparisonChain(both).facts;
    bothFacts.reference.summary.dispersion.metric = "MAD";
    bothFacts.recent.summary.dispersion.metric = "MAD";
    expect(projectExplainablePattern(both, FACT)).toEqual({ kind: "INELIGIBLE", reason: "UNSUPPORTED_SUMMARY" });
    const one = structuredClone(base);
    comparisonChain(one).facts.recent.summary.dispersion.metric = "MAD";
    expect(projectExplainablePattern(one, FACT)).toEqual({ kind: "INELIGIBLE", reason: "UNSUPPORTED_SUMMARY" });
  });

  it("returns NOT_SUPPORTED for a non-SUPPORTED lifecycle on an otherwise valid chain", async () => {
    const { database } = await higherFixture();
    const snapshot = await loadedClone(database);
    comparisonChain(snapshot).chain.previous.observation.payload.lifecycle = { state: "WATCHING" } as never;
    expect(projectExplainablePattern(snapshot, FACT)).toEqual({ kind: "INELIGIBLE", reason: "NOT_SUPPORTED" });
  });
});
