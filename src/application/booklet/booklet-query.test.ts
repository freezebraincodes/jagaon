import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import Dexie from "dexie";
import fakeIndexedDB, { IDBKeyRange as FDBKeyRange } from "fake-indexeddb";
import type { Instant } from "@/domain/shared/time";
import { databases, local, reading, setup } from "@/application/history/history-test-support";
import { createBookletQuery, type BookletView } from "./booklet-query";

/** Owner decision 2026-10-16: the Booklet tab is a read-only table laid out like a paper glucose diary. */
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

const NOW = "2026-10-04T02:00:00.000Z" as Instant; // Sunday 4 Oct 2026, 10:00 in Singapore
const at = (date: string, time: string) => local(date, time).occurrence.instantUtc;

function ready(view: BookletView) {
  if (view.status !== "READY") throw new Error("not ready");
  return view;
}

describe("Booklet query", () => {
  it("lists every day of the period newest first and puts each reading in its own meal-time column", async () => {
    const { database, journal } = await setup();
    await reading(journal, "2026-09-29", "07:10", "6.2", "BEFORE_BREAKFAST");
    await reading(journal, "2026-09-29", "06:40", "6.0", "FASTING");
    await reading(journal, "2026-09-29", "09:30", "8.4", "AFTER_BREAKFAST");
    await reading(journal, "2026-09-29", "18:40", "7.3", "BEFORE_DINNER");
    await reading(journal, "2026-09-29", "22:15", "7.0", "BEDTIME");
    // Outside this week: not shown.
    await reading(journal, "2026-09-27", "07:10", "6.9", "BEFORE_BREAKFAST");
    const view = ready(await createBookletQuery(database, { now: () => NOW }).load({ period: "THIS_WEEK" }));

    expect(view.range).toEqual({ startDate: "2026-09-28", endDate: "2026-10-04" });
    expect(view.today).toBe("2026-10-04");
    expect(view.days.map((day) => day.date)).toEqual(["2026-10-04", "2026-10-03", "2026-10-02", "2026-10-01", "2026-09-30", "2026-09-29", "2026-09-28"]);
    const tuesday = view.days.find((day) => day.date === "2026-09-29")!;
    // A fasting reading is written before breakfast, in time order with the before-breakfast one.
    expect(tuesday.readings.BREAKFAST_BEFORE).toEqual([
      { value: "6.0", unit: "mmol/L", at: at("2026-09-29", "06:40") },
      { value: "6.2", unit: "mmol/L", at: at("2026-09-29", "07:10") },
    ]);
    expect(tuesday.readings.BREAKFAST_AFTER.map((r) => r.value)).toEqual(["8.4"]);
    expect(tuesday.readings.LUNCH_BEFORE).toEqual([]);
    expect(tuesday.readings.DINNER_BEFORE.map((r) => r.value)).toEqual(["7.3"]);
    expect(tuesday.readings.BEDTIME.map((r) => r.value)).toEqual(["7.0"]);
    expect(tuesday.notes).toEqual([]);
    expect(view.days.flatMap((day) => Object.values(day.readings).flat()).map((r) => r.value)).not.toContain("6.9");
  });

  it("puts meals, activity and a reading without a meal time in that day's notes, in time order", async () => {
    const { database, journal } = await setup();
    const recordedAt = "2026-10-04T01:00:00.000Z" as Instant;
    await journal.recordMeal({
      payload: { intakeKind: "MEAL", intakeSlot: { kind: "STANDARD_MEAL", code: "BREAKFAST" }, occasion: "ROUTINE", foodIncluded: "YES", drinkIncluded: "UNKNOWN", items: [{ kind: "FOOD", label: "Kaya toast" }] },
      temporal: local("2026-10-01", "07:30"),
      recordedAt,
    } as never);
    await journal.recordActivity({ payload: { activityCategory: "WALKING", patientLabel: "Morning walk", reportedDurationMinutes: 20 }, temporal: local("2026-10-01", "06:45"), recordedAt } as never);
    await journal.recordGlucose({
      payload: { measurement: { enteredValue: "6.8" as never, enteredUnit: "MMOL_L", normalization: null }, measurementMethod: "FINGERSTICK_METER", context: { kind: "UNSPECIFIED" } },
      temporal: local("2026-10-01", "15:20"),
      recordedAt,
    } as never);
    const view = ready(await createBookletQuery(database, { now: () => NOW }).load({ period: "THIS_WEEK" }));
    const thursday = view.days.find((day) => day.date === "2026-10-01")!;
    expect(thursday.notes).toEqual([
      { kind: "ACTIVITY", at: at("2026-10-01", "06:45"), label: "Morning walk", minutes: 20 },
      { kind: "MEAL", at: at("2026-10-01", "07:30"), label: "Kaya toast" },
      { kind: "READING", at: at("2026-10-01", "15:20"), value: "6.8", unit: "mmol/L" },
    ]);
    expect(Object.values(thursday.readings).flat()).toEqual([]);
  });

  it("reports unavailable instead of a partial table when a stored record cannot be read", async () => {
    const { database, journal } = await setup();
    const result = await reading(journal, "2026-09-29", "07:10", "6.2");
    await database.table("recordRevisions").update(result.revisionId, { payload: null });
    expect(await createBookletQuery(database, { now: () => NOW }).load({ period: "THIS_WEEK" })).toEqual({ status: "UNAVAILABLE" });
  });
});
