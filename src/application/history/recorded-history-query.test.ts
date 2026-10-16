import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import Dexie from "dexie";
import fakeIndexedDB, { IDBKeyRange as FDBKeyRange } from "fake-indexeddb";
import type { Instant } from "@/domain/shared/time";
import { recordedHistoryViewSchema, type RecordedHistoryView } from "./recorded-history-contracts";
import { databases, dayBefore, local, reading, setup } from "./history-test-support";

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

function ready(view: RecordedHistoryView) {
  if (view.status !== "READY" && view.status !== "INSUFFICIENT_EVIDENCE") throw new Error(`unexpected ${view.status}`);
  return view;
}

describe("Recorded-history query port", () => {
  it("keeps every reading in a display position, in time order, not only the latest (owner decision 2026-10-12)", async () => {
    const { journal, history } = await setup();
    await reading(journal, "2026-09-29", "07:10", "6.2");
    await reading(journal, "2026-09-29", "13:05", "9.1", "BEFORE_LUNCH");
    await reading(journal, "2026-09-29", "18:40", "7.3", "BEFORE_DINNER");
    const projection = ready(await history.load({ period: "THIS_WEEK" })).projection;
    expect(projection.readingCount).toBe(3);
    // Owner decision 2026-10-16: three times of day. The 13:05 reading is the afternoon's own; the 18:40 reading the evening's.
    expect(projection.chart.find((p) => p.date === "2026-09-29" && p.position === "AFTERNOON")).toEqual({
      date: "2026-09-29",
      position: "AFTERNOON",
      state: "RECORDED",
      valueMmolL: "9.1",
      readingCount: 1,
      readings: [{ valueMmolL: "9.1", at: local("2026-09-29", "13:05").occurrence.instantUtc }],
    });
    expect(projection.chart.find((p) => p.date === "2026-09-29" && p.position === "EVENING")).toMatchObject({ readings: [{ valueMmolL: "7.3" }] });
    // Two readings in one time of day are both kept, in time order.
    await reading(journal, "2026-09-29", "19:30", "7.0", "BEDTIME");
    const again = ready(await history.load({ period: "THIS_WEEK" })).projection;
    expect(again.chart.find((p) => p.date === "2026-09-29" && p.position === "EVENING")).toMatchObject({
      valueMmolL: "7.0",
      readingCount: 2,
      readings: [
        { valueMmolL: "7.3", at: local("2026-09-29", "18:40").occurrence.instantUtc },
        { valueMmolL: "7.0", at: local("2026-09-29", "19:30").occurrence.instantUtc },
      ],
    });
    expect(projection.chart.find((p) => p.date === "2026-09-29" && p.position === "MORNING")).toMatchObject({ readings: [{ valueMmolL: "6.2" }] });
  });

  it("projects this week's counts, range, slot counts, positions and stamps from latest revisions", async () => {
    const { journal, history } = await setup();
    await reading(journal, "2026-09-28", "07:30", "6.1");
    await reading(journal, "2026-09-28", "18:30", "7.9", "BEFORE_DINNER");
    await reading(journal, "2026-09-29", "07:40", "6.4");
    await reading(journal, "2026-09-30", "07:20", "5.9");
    await reading(journal, "2026-10-01", "12:30", "8.4", "BEFORE_LUNCH");

    const view = ready(await history.load({ period: "THIS_WEEK" }));
    expect(recordedHistoryViewSchema.safeParse(view).success).toBe(true);
    const projection = view.projection;
    expect(projection.range).toEqual({ startDate: "2026-09-28", endDate: "2026-10-04" });
    expect(projection.readingCount).toBe(5);
    expect(projection.valueRange).toEqual({ minimum: "5.9", maximum: "8.4" });
    expect(projection.slotCounts).toEqual([
      { slot: "BEFORE_BREAKFAST", count: 3 },
      { slot: "BEFORE_LUNCH", count: 1 },
      { slot: "BEFORE_DINNER", count: 1 },
    ]);
    // Six full days of three times of day, plus Sunday morning; Sunday afternoon has not begun.
    expect(projection.chart).toHaveLength(19);
    expect(projection.chart[0]).toEqual({
      date: "2026-09-28",
      position: "MORNING",
      state: "RECORDED",
      valueMmolL: "6.1",
      readingCount: 1,
      readings: [{ valueMmolL: "6.1", at: local("2026-09-28", "07:30").occurrence.instantUtc }],
    });
    expect(projection.chart[1]).toEqual({ date: "2026-09-28", position: "AFTERNOON", state: "NOT_RECORDED" });
    expect(projection.chart.find((p) => p.date === "2026-10-01" && p.position === "AFTERNOON")).toMatchObject({ state: "RECORDED", valueMmolL: "8.4" });
    // A day with readings at two or more times of day is complete: its empty afternoon is drawn but not listed as missing
    // (owner decision 2026-10-16). Listed: 29 Sep and 30 Sep afternoon and evening, 1 Oct morning and evening, all of 2 and 3 Oct,
    // and 4 Oct morning.
    expect(projection.notRecordedPositions).toHaveLength(13);
    expect(projection.notRecordedPositions.some((p) => p.date === "2026-09-28")).toBe(false);
    expect(projection.notRecordedPositions.some((p) => "valueMmolL" in p)).toBe(false);
    expect(projection.stamps.slice(0, 2)).toEqual([
      { date: "2026-09-28", recordedPositions: 2, complete: true },
      { date: "2026-09-29", recordedPositions: 1, complete: false },
    ]);
    expect(projection.source).toBe("PATIENT_ENTERED");
    expect(projection.correctedRecordCount).toBe(0);
    expect(projection.selectableFactIds).toEqual([
      "READING_COUNT",
      "VALUE_RANGE",
      "SLOT_COUNT:BEFORE_BREAKFAST",
      "SLOT_COUNT:BEFORE_LUNCH",
      "SLOT_COUNT:BEFORE_DINNER",
      "NOT_RECORDED_POSITIONS",
      "SOURCE",
    ]);
    expect(view.status).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("returns EMPTY for a period without readings and supports every period", async () => {
    const { journal, history } = await setup();
    await reading(journal, "2026-09-30", "07:20", "5.9");
    expect(await history.load({ period: "LAST_WEEK" })).toEqual({
      status: "EMPTY",
      period: "LAST_WEEK",
      range: { startDate: "2026-09-21", endDate: "2026-09-27" },
      unavailableFamilies: [],
    });
    const thirty = ready(await history.load({ period: "THIRTY_DAYS" }));
    expect(thirty.projection.range).toEqual({ startDate: "2026-09-05", endDate: "2026-10-04" });
    expect(thirty.projection.chart).toHaveLength(88);
  });

  it("reports a supported comparison with its evidence windows and correction provenance", async () => {
    const { journal, coordinator, history } = await setup();
    const reference: Array<[number, string]> = [[16, "5.8"], [18, "6.0"], [20, "6.1"], [23, "5.9"], [25, "6.2"], [27, "6.0"], [30, "5.7"], [33, "6.3"]];
    const recent: Array<[number, string]> = [[1, "7.2"], [3, "7.4"], [5, "7.1"], [8, "7.6"], [10, "7.3"], [12, "7.5"]];
    const recorded = [];
    for (const [days, value] of [...reference, ...recent]) recorded.push(await reading(journal, dayBefore("2026-10-04", days), "07:30", value));
    await coordinator.processPending();

    const view = ready(await history.load({ period: "THIS_WEEK" }));
    expect(view.status).toBe("READY");
    expect(view.comparisons).toEqual([
      expect.objectContaining({
        factId: "COMPARISON:BEFORE_BREAKFAST",
        slot: "BEFORE_BREAKFAST",
        kind: "HIGHER",
        recent: "7.35",
        reference: "6",
        recentWindow: { startDate: "2026-09-20", endDate: "2026-10-04" },
        referenceWindow: { startDate: "2026-08-23", endDate: "2026-09-20" },
        correctionUpdated: false,
      }),
    ]);

    const target = recorded.at(-1)!;
    await journal.correctGlucoseTime({
      recordId: target.recordId,
      expectedRevisionId: target.revisionId,
      expectedRevisionNumber: 1,
      payload: {
        measurement: { enteredValue: "7.8" as never, enteredUnit: "MMOL_L", normalization: null },
        measurementMethod: "FINGERSTICK_METER",
        context: { kind: "PATIENT_SELECTED_SLOT", slot: "BEFORE_BREAKFAST" },
      },
      temporal: local(dayBefore("2026-10-04", 12), "07:45"),
      recordedAt: "2026-10-04T01:00:00.000Z" as Instant,
    });
    await coordinator.processPending();
    const updated = ready(await history.load({ period: "THIRTY_DAYS" }));
    expect(updated.comparisons[0]).toMatchObject({ correctionUpdated: true });
    expect(updated.projection.correctedRecordCount).toBe(1);
  });

  it("states that comparable records did not meet the governed threshold without inventing a claim", async () => {
    const { journal, coordinator, history } = await setup();
    const days = [16, 18, 20, 23, 25, 27, 30, 33, 1, 3, 5, 8, 10, 12];
    for (const [i, d] of days.entries()) {
      await reading(journal, dayBefore("2026-10-04", d), "18:30", i % 2 === 0 ? "7.0" : "7.2", "BEFORE_DINNER");
    }
    await coordinator.processPending();
    const view = ready(await history.load({ period: "THIS_WEEK" }));
    expect(view.status).toBe("READY");
    expect(view.comparisons).toEqual([
      expect.objectContaining({ factId: "NO_MATERIAL:BEFORE_DINNER", slot: "BEFORE_DINNER", kind: "NO_MATERIAL" }),
    ]);
  });

  it("lists supported repeated items with period counts and verbatim labels", async () => {
    const { journal, coordinator, history } = await setup();
    await reading(journal, "2026-09-29", "07:30", "6.0");
    for (const date of ["2026-09-28", "2026-09-29", "2026-10-01", "2026-10-02"]) {
      await journal.recordMeal({
        payload: { intakeKind: "MEAL", intakeSlot: { kind: "STANDARD_MEAL", code: "BREAKFAST" }, occasion: "ROUTINE", foodIncluded: "YES", drinkIncluded: "UNKNOWN", items: [{ kind: "FOOD", label: "Kaya toast" }] },
        temporal: local(date, "08:00"),
        recordedAt: "2026-10-04T01:00:00.000Z" as Instant,
      });
      await journal.recordActivity({
        payload: { activityCategory: "WALKING", patientLabel: "Morning walk" },
        temporal: local(date, "09:00") as never,
        recordedAt: "2026-10-04T01:00:00.000Z" as Instant,
      });
    }
    await coordinator.processPending();
    const view = ready(await history.load({ period: "THIS_WEEK" }));
    expect(view.projection.repeated).toEqual([
      expect.objectContaining({ kind: "ITEM", label: "Kaya toast", count: 4, days: 4 }),
      expect.objectContaining({ kind: "CONTEXT", label: "Morning walk", count: 4, days: 4 }),
    ]);
    expect(view.projection.selectableFactIds.filter((id) => id.startsWith("REPEATED:"))).toHaveLength(2);
  });

  it("names requested disabled families as unavailable without any effect", async () => {
    const { database, journal, history } = await setup();
    await reading(journal, "2026-09-29", "07:30", "6.0");
    const before = await database.table("recordRevisions").count();
    const view = await history.load({ period: "THIS_WEEK", families: ["COMPARABLE_SLOT_TREND", "ROUTINE_SHIFT", "CROSS_VARIABLE_ASSOCIATION"] });
    expect(view.status === "UNAVAILABLE" ? [] : view.unavailableFamilies).toEqual(["ROUTINE_SHIFT", "CROSS_VARIABLE_ASSOCIATION"]);
    expect(await database.table("recordRevisions").count()).toBe(before);
    expect(await database.table("domainEvents").count()).toBe(1);
  });

  it("returns a bounded unavailable state when stored history fails integrity", async () => {
    const { database, journal, history } = await setup();
    const result = await reading(journal, "2026-09-29", "07:30", "6.0");
    await database.table("recordRevisions").update(result.revisionId, { "revision.payload.measurement.enteredValue": "not-a-number" });
    expect(await history.load({ period: "THIS_WEEK" })).toEqual({ status: "UNAVAILABLE", code: "INTEGRITY_FAILURE" });
  });
});
