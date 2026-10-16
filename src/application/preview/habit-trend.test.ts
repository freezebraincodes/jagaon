import { describe, expect, it } from "vitest";
import { computeHabitTrend, HABIT_TREND_RULE_VERSION, type HabitTrendActivity, type HabitTrendReading } from "./habit-trend";

// Wednesday 14 Oct 2026, 10:00 in Singapore.
const NOW = "2026-10-14T02:00:00.000Z";
const DAY = 86_400_000;

/** Local Singapore wall-clock time `daysAgo` days before NOW's local date. */
function at(daysAgo: number, time = "07:30"): string {
  return new Date(Date.parse(`2026-10-14T${time}:00+08:00`) - daysAgo * DAY).toISOString();
}

function readings(slot: string, entries: Array<[number, string]>, time = "07:30"): HabitTrendReading[] {
  return entries.map(([daysAgo, value]) => ({ slot, at: at(daysAgo, time), valueMmolL: value }));
}

function walks(daysAgo: number[], label = "Morning walk"): HabitTrendActivity[] {
  return daysAgo.map((d) => ({ label, at: at(d, "08:20") }));
}

// Before the walks (start 16 days ago, 08:20): 7 readings, median 7.6. After: 6 readings, median 6.2 (even count: (6.1 + 6.3) / 2).
const BEFORE: Array<[number, string]> = [[30, "7.9"], [27, "7.4"], [25, "7.6"], [22, "8.0"], [20, "7.2"], [18, "7.7"], [16, "7.5"]];
const AFTER: Array<[number, string]> = [[14, "6.6"], [12, "6.3"], [9, "6.1"], [7, "5.9"], [4, "6.0"], [1, "6.4"]];

describe(`${HABIT_TREND_RULE_VERSION} (HSA-bounded mode preview)`, () => {
  it("compares medians before and after the habit's first recorded occurrence and says 'lower'", () => {
    const trend = computeHabitTrend({ now: NOW, readings: readings("BEFORE_BREAKFAST", [...BEFORE, ...AFTER]), activities: walks([16, 13, 11]) });
    expect(trend).toEqual({
      ruleVersion: "habit-trend-preview.1",
      habitLabel: "Morning walk",
      slot: "BEFORE_BREAKFAST",
      direction: "LOWER",
      // (6.2 − 7.6) / 7.6 = −18.42% → 18.
      percentChange: 18,
      beforeMedian: "7.6",
      afterMedian: "6.2",
      beforeCount: 7,
      afterCount: 6,
      habitCount: 3,
      daysSince: 16,
      startedAt: at(16, "08:20"),
      startDate: "2026-09-28",
    });
  });

  it("says 'higher' for a rise", () => {
    const up = [...BEFORE.map(([d]) => [d, "6.0"] as [number, string]), ...AFTER.map(([d]) => [d, "7.0"] as [number, string])];
    const trend = computeHabitTrend({ now: NOW, readings: readings("BEFORE_BREAKFAST", up), activities: walks([16, 10]) });
    expect(trend).toMatchObject({ direction: "HIGHER", percentChange: 17, beforeMedian: "6.0", afterMedian: "7.0" });
  });

  it("returns null without activities, or without readings", () => {
    expect(computeHabitTrend({ now: NOW, readings: readings("BEFORE_BREAKFAST", [...BEFORE, ...AFTER]), activities: [] })).toBeNull();
    expect(computeHabitTrend({ now: NOW, readings: [], activities: walks([16, 13]) })).toBeNull();
  });

  it("needs at least 2 occurrences of the habit since it started", () => {
    const input = { now: NOW, readings: readings("BEFORE_BREAKFAST", [...BEFORE, ...AFTER]) };
    expect(computeHabitTrend({ ...input, activities: walks([16]) })).toBeNull();
    expect(computeHabitTrend({ ...input, activities: walks([16, 15]) })).not.toBeNull();
  });

  it("groups occurrences by normalised label (case, whitespace)", () => {
    const activities = [...walks([16]), ...walks([12], "  MORNING WALK ")];
    const trend = computeHabitTrend({ now: NOW, readings: readings("BEFORE_BREAKFAST", [...BEFORE, ...AFTER]), activities });
    expect(trend).toMatchObject({ habitLabel: "Morning walk", habitCount: 2 });
    // Different labels are different habits: one occurrence each.
    expect(computeHabitTrend({ now: NOW, readings: readings("BEFORE_BREAKFAST", [...BEFORE, ...AFTER]), activities: [...walks([16]), ...walks([12], "Evening walk")] })).toBeNull();
  });

  it("only treats a habit as new when its first occurrence is within the last 45 days", () => {
    const longBefore: Array<[number, string]> = [[70, "7.9"], [65, "7.4"], [60, "7.6"], [55, "8.0"], [50, "7.2"]];
    const after: Array<[number, string]> = [[43, "6.6"], [40, "6.3"], [35, "6.1"], [30, "5.9"], [20, "6.0"]];
    const input = { now: NOW, readings: readings("BEFORE_BREAKFAST", [...longBefore, ...after]) };
    expect(computeHabitTrend({ ...input, activities: walks([46, 40]) })).toBeNull();
    expect(computeHabitTrend({ ...input, activities: walks([45, 40]) })).toBeNull(); // 45 days ago at 08:20 is before now − 45d (10:00).
    expect(computeHabitTrend({ ...input, activities: walks([44, 40]) })).not.toBeNull();
  });

  it("uses only the 28 days before the start for the BEFORE side", () => {
    // Four readings inside the 28 days, two older ones outside it.
    const before: Array<[number, string]> = [[50, "7.9"], [46, "7.8"], [40, "7.6"], [30, "8.0"], [25, "7.2"], [20, "7.7"]];
    const input = { now: NOW, readings: readings("BEFORE_BREAKFAST", [...before, ...AFTER]), activities: walks([17, 12]) };
    expect(computeHabitTrend(input)).toBeNull();
    const withOneMore = { ...input, readings: [...input.readings, ...readings("BEFORE_BREAKFAST", [[44, "7.5"]])] };
    expect(computeHabitTrend(withOneMore)).toMatchObject({ beforeCount: 5 });
  });

  it("splits by instant: a reading on the start day before the first occurrence counts as BEFORE", () => {
    const trend = computeHabitTrend({ now: NOW, readings: readings("BEFORE_BREAKFAST", [...BEFORE, ...AFTER]), activities: walks([16, 13]) });
    // BEFORE includes 16 days ago at 07:30 (the walk was at 08:20).
    expect(trend?.beforeCount).toBe(7);
  });

  it("needs at least 5 readings on each side", () => {
    const fewAfter = AFTER.slice(0, 4);
    expect(computeHabitTrend({ now: NOW, readings: readings("BEFORE_BREAKFAST", [...BEFORE, ...fewAfter]), activities: walks([16, 13]) })).toBeNull();
    const fewBefore = BEFORE.slice(0, 4);
    expect(computeHabitTrend({ now: NOW, readings: readings("BEFORE_BREAKFAST", [...fewBefore, ...AFTER]), activities: walks([16, 13]) })).toBeNull();
  });

  it("shows a change of exactly 5% and hides one just under it", () => {
    const flat = (before: string, after: string) => [
      ...BEFORE.map(([d]) => [d, before] as [number, string]),
      ...AFTER.map(([d]) => [d, after] as [number, string]),
    ];
    expect(computeHabitTrend({ now: NOW, readings: readings("BEFORE_BREAKFAST", flat("8.0", "7.6")), activities: walks([16, 13]) })).toMatchObject({
      percentChange: 5,
      direction: "LOWER",
    });
    expect(computeHabitTrend({ now: NOW, readings: readings("BEFORE_BREAKFAST", flat("8.0", "7.61")), activities: walks([16, 13]) })).toBeNull();
  });

  it("rounds the percent half away from zero and medians half up to 1 dp", () => {
    // Before median 8.0; after median (7.0 + 7.05) / 2 = 7.025 → "7.0"; change −12.1875% → 12.
    const before = BEFORE.map(([d]) => [d, "8.0"] as [number, string]);
    const after: Array<[number, string]> = [[14, "7.0"], [12, "7.0"], [9, "7.0"], [7, "7.05"], [4, "7.05"], [1, "7.05"]];
    expect(computeHabitTrend({ now: NOW, readings: readings("BEFORE_BREAKFAST", [...before, ...after]), activities: walks([16, 13]) })).toMatchObject({
      afterMedian: "7.0",
      percentChange: 12,
    });
    // Before 8.0, after 7.0: exactly −12.5% → 13 (half away from zero).
    const half: Array<[number, string]> = [[14, "7.0"], [12, "7.0"], [9, "7.0"], [7, "7.0"], [4, "7.0"], [1, "7.0"]];
    expect(computeHabitTrend({ now: NOW, readings: readings("BEFORE_BREAKFAST", [...before, ...half]), activities: walks([16, 13]) })).toMatchObject({
      percentChange: 13,
    });
    // Before median (6.2 + 6.3) / 2 = 6.25 → "6.3" (half up).
    const beforeHalf: Array<[number, string]> = [[30, "6.2"], [27, "6.2"], [25, "6.2"], [22, "6.3"], [20, "6.3"], [18, "6.3"]];
    const afterLow = AFTER.map(([d]) => [d, "5.0"] as [number, string]);
    expect(computeHabitTrend({ now: NOW, readings: readings("BEFORE_BREAKFAST", [...beforeHalf, ...afterLow]), activities: walks([16, 13]) })).toMatchObject({
      beforeMedian: "6.3",
      afterMedian: "5.0",
      percentChange: 20,
    });
  });

  it("picks the habit and slot with the largest change, ties to before-breakfast, then the earlier start, then the label", () => {
    const breakfast = readings("BEFORE_BREAKFAST", [...BEFORE, ...AFTER]);
    // Before dinner: 8.0 → 6.0 (−25%), larger than before-breakfast (−18%).
    const dinner = readings(
      "BEFORE_DINNER",
      [...BEFORE.map(([d]) => [d, "8.0"] as [number, string]), ...AFTER.map(([d]) => [d, "6.0"] as [number, string])],
      "18:30",
    );
    expect(computeHabitTrend({ now: NOW, readings: [...breakfast, ...dinner], activities: walks([16, 13]) })).toMatchObject({
      slot: "BEFORE_DINNER",
      percentChange: 25,
    });

    // The same change in both slots: before-breakfast wins.
    const flat = (slot: string, time: string) =>
      readings(slot, [...BEFORE.map(([d]) => [d, "8.0"] as [number, string]), ...AFTER.map(([d]) => [d, "7.0"] as [number, string])], time);
    expect(
      computeHabitTrend({ now: NOW, readings: [...flat("BEFORE_DINNER", "18:30"), ...flat("BEFORE_BREAKFAST", "07:30")], activities: walks([16, 13]) }),
    ).toMatchObject({ slot: "BEFORE_BREAKFAST" });

    // Two habits starting the same day with the same windows and change: the label decides ("cycling" before "morning walk").
    const sameDay = [...walks([16, 13]), ...walks([16, 12], "Cycling")];
    expect(computeHabitTrend({ now: NOW, readings: flat("BEFORE_BREAKFAST", "07:30"), activities: sameDay })).toMatchObject({ habitLabel: "Cycling" });
  });

  it("ignores other slots and values that are not mmol/L numbers", () => {
    const lunch = readings("BEFORE_LUNCH", [...BEFORE, ...AFTER]);
    expect(computeHabitTrend({ now: NOW, readings: lunch, activities: walks([16, 13]) })).toBeNull();
    const broken = readings("BEFORE_BREAKFAST", [...BEFORE, ...AFTER.slice(0, 4), [1, "high"]]);
    expect(computeHabitTrend({ now: NOW, readings: broken, activities: walks([16, 13]) })).toBeNull();
  });
});
