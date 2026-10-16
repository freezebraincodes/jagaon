import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { JournalCommandService } from "@/application/journal/journal-contracts";
import { PREPARED_DEMO_HISTORY_ROWS } from "./prepared-demo-history-data";
import { planSyntheticHistory, seedSyntheticHistory } from "./synthetic-history-seed";

const SEED_AT = "2026-10-04T02:00:00.000Z"; // 10:00 Sunday in Singapore
const localDateBefore = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

describe("deterministic synthetic Recorded-history seed", () => {
  it("is a pure function of the seed instant", () => {
    expect(planSyntheticHistory(SEED_AT as never)).toEqual(planSyntheticHistory(SEED_AT as never));
  });

  it("comes from the static data set: every row once, placed on its local Singapore day and time", () => {
    const plan = planSyntheticHistory(SEED_AT as never);
    expect(plan).toHaveLength(PREPARED_DEMO_HISTORY_ROWS.length);
    const local = (instant: string) => new Date(Date.parse(instant) + 8 * 3_600_000).toISOString();
    const placed = plan.map((entry) => local(entry.occurredAt).slice(0, 16)).sort();
    const expected = PREPARED_DEMO_HISTORY_ROWS.map((row) => `${localDateBefore("2026-10-04", row.daysAgo)}T${row.time}`).sort();
    expect(placed).toEqual(expected);
  });

  it.each([
    ["Mon 12 Oct 08:40 SGT", "2026-10-12T00:40:00.000Z", "2026-10-11"],
    ["Tue 13 Oct 14:00 SGT", "2026-10-13T06:00:00.000Z", "2026-10-12"],
    ["just after local midnight", "2026-10-12T16:00:30.000Z", "2026-10-12"],
    ["just before local midnight", "2026-10-12T15:59:30.000Z", "2026-10-11"],
  ])("ends yesterday (%s): nothing dated on the seed's local day or later", (_label, seedAt, yesterday) => {
    const plan = planSyntheticHistory(seedAt as never);
    const today = new Date(Date.parse(seedAt) + 8 * 3_600_000).toISOString().slice(0, 10);
    const dates = plan.flatMap((entry) => [entry.occurredAt, ...(entry.kind === "GLUCOSE" && entry.correctedTo ? [entry.correctedTo] : [])]).map((instant) => new Date(Date.parse(instant) + 8 * 3_600_000).toISOString().slice(0, 10));
    expect(dates.every((date) => date < today)).toBe(true);
    expect(dates.reduce((latest, date) => (date > latest ? date : latest))).toBe(yesterday);
    expect(Math.max(...plan.map((entry) => Date.parse(entry.occurredAt)))).toBeLessThan(Date.parse(seedAt));
  });

  it("is a static data set: no random source, fixed values and varied fixed times", () => {
    const source = readFileSync(join(process.cwd(), "src/application/history/prepared-demo-history-data.ts"), "utf8") + readFileSync(join(process.cwd(), "src/application/history/synthetic-history-seed.ts"), "utf8");
    expect(source).not.toMatch(/Math\.random|crypto\.|Date\.now|new Date\(\)/);
    const breakfastTimes = new Set(PREPARED_DEMO_HISTORY_ROWS.filter((row) => row.kind === "GLUCOSE" && row.slot === "BEFORE_BREAKFAST").map((row) => row.time));
    expect(breakfastTimes.size).toBeGreaterThan(20);
    expect([...breakfastTimes].every((time) => time >= "06:58" && time <= "07:52")).toBe(true);
    const dinnerTimes = PREPARED_DEMO_HISTORY_ROWS.filter((row) => row.kind === "GLUCOSE" && row.slot === "BEFORE_DINNER").map((row) => row.time);
    expect(dinnerTimes.every((time) => time >= "18:05" && time <= "19:20")).toBe(true);
  });

  it("is a full booklet: three readings a day for 42 days, daily meals with five gaps in the month, walks 3 to 5 times a week (owner request 2026-10-16)", () => {
    const rows = PREPARED_DEMO_HISTORY_ROWS;
    const glucose = rows.filter((row): row is Extract<typeof row, { kind: "GLUCOSE" }> => row.kind === "GLUCOSE");
    const meals = rows.filter((row): row is Extract<typeof row, { kind: "MEAL" }> => row.kind === "MEAL");
    const walks = rows.filter((row): row is Extract<typeof row, { kind: "ACTIVITY" }> => row.kind === "ACTIVITY");
    expect(Math.min(...rows.map((row) => row.daysAgo))).toBe(1);
    expect(Math.max(...rows.map((row) => row.daysAgo))).toBe(42);
    // Three readings every day: before breakfast, before dinner and one after-meal check.
    for (let day = 1; day <= 42; day += 1) {
      const slots = glucose.filter((row) => row.daysAgo === day).map((row) => row.slot);
      expect(slots).toHaveLength(3);
      expect(slots).toEqual(expect.arrayContaining(["BEFORE_BREAKFAST", "BEFORE_DINNER"]));
      expect(slots.filter((slot) => slot.startsWith("AFTER_"))).toHaveLength(1);
    }
    // Breakfast, lunch and dinner every day, except five missed meals in the last 30 days.
    expect(meals.filter((row) => row.daysAgo <= 30)).toHaveLength(30 * 3 - 5);
    expect(meals.filter((row) => row.daysAgo > 30)).toHaveLength(12 * 3);
    // Exercise three to five times a week: tai chi three times a week until about two and a half weeks ago, then morning walks five
    // times a week starting 16 days ago (so the preview's "What changed alongside" card has four weeks of readings before them).
    const label = (name: string) => walks.filter((row) => row.label === name);
    expect(label("Tai chi").every((row) => row.daysAgo >= 17 && row.category === "FLEXIBILITY_OR_MOBILITY")).toBe(true);
    expect(label("Tai chi")).toHaveLength(11);
    expect(Math.max(...label("Morning walk").map((row) => row.daysAgo))).toBe(16);
    expect(label("Morning walk")).toHaveLength(11);
    for (let week = 0; week < 6; week += 1) {
      const count = walks.filter((row) => row.daysAgo > week * 7 && row.daysAgo <= (week + 1) * 7).length;
      expect(count, `week ${week + 1} back`).toBeGreaterThanOrEqual(3);
      expect(count, `week ${week + 1} back`).toBeLessThanOrEqual(5);
    }
    expect(glucose.filter((row) => row.correctedTime)).toEqual([expect.objectContaining({ daysAgo: 2, time: "07:37", correctedTime: "07:07", slot: "BEFORE_BREAKFAST" })]);
    const value = (row: { value: string }) => Number(row.value);
    const median = (values: number[]) => {
      const sorted = [...values].sort((a, b) => a - b);
      const middle = sorted.length / 2;
      return Number.isInteger(middle) ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[Math.floor(middle)]!;
    };
    const breakfast = glucose.filter((row) => row.slot === "BEFORE_BREAKFAST");
    const dinner = glucose.filter((row) => row.slot === "BEFORE_DINNER");
    // The comparisons keep their story: before breakfast lower, before dinner higher in the last two weeks.
    expect(breakfast.filter((row) => row.daysAgo > 14).every((row) => value(row) >= 7.0 && value(row) <= 8.2)).toBe(true);
    expect(breakfast.filter((row) => row.daysAgo <= 14).every((row) => value(row) >= 5.6 && value(row) <= 6.6)).toBe(true);
    expect(dinner.filter((row) => row.daysAgo > 14).every((row) => value(row) >= 7.0 && value(row) <= 8.6)).toBe(true);
    expect(dinner.filter((row) => row.daysAgo <= 14).every((row) => value(row) >= 8.8 && value(row) <= 9.4)).toBe(true);
    expect(median(breakfast.filter((row) => row.daysAgo > 14).map(value))).toBe(7.5);
    expect(median(breakfast.filter((row) => row.daysAgo <= 13).map(value))).toBe(6.1);
    expect(median(dinner.filter((row) => row.daysAgo > 14).map(value))).toBe(7.8);
    expect(median(dinner.filter((row) => row.daysAgo <= 13).map(value))).toBe(9.1);
    // Plausible synthetic values only: one decimal place, never a confirmation-range value.
    expect(glucose.every((row) => /^\d+\.\d$/.test(row.value) && value(row) > 0 && value(row) <= 50)).toBe(true);
    // The 5-day visit summary (today and the 4 days before) holds 12 readings: with the appointment and one question, 15 facts,
    // inside the care-summary request's 32-fact limit and its English remote wording budget.
    expect(glucose.filter((row) => row.daysAgo <= 4)).toHaveLength(12);
    // Each day reads in time order: the before-breakfast reading comes before breakfast, before dinner before dinner.
    for (let day = 1; day <= 42; day += 1) {
      const times = rows.filter((row) => row.daysAgo === day).map((row) => row.time);
      expect(times).toEqual([...times].sort());
    }
  });

  it("refuses a row dated today or with an unreadable time instead of seeding it", () => {
    const row = PREPARED_DEMO_HISTORY_ROWS[0]!;
    expect(() => planSyntheticHistory(SEED_AT as never, [{ ...row, daysAgo: 0 }])).toThrow("SYNTHETIC_SCENARIO_DATA_INVALID");
    expect(() => planSyntheticHistory(SEED_AT as never, [{ ...row, time: "24:10" }])).toThrow("SYNTHETIC_SCENARIO_DATA_INVALID");
  });

  it("writes only through journal commands and applies the correction as a revision", async () => {
    const committed = { kind: "COMMITTED" as const, recordId: crypto.randomUUID() as never, revisionId: crypto.randomUUID() as never };
    const commands = {
      recordGlucose: vi.fn().mockResolvedValue(committed),
      correctGlucoseTime: vi.fn().mockResolvedValue(committed),
      recordInsulin: vi.fn(),
      recordMeal: vi.fn().mockResolvedValue(committed),
      recordActivity: vi.fn().mockResolvedValue(committed),
    } satisfies JournalCommandService;
    const report = await seedSyntheticHistory(commands, SEED_AT as never);
    const plan = planSyntheticHistory(SEED_AT as never);
    expect(commands.recordGlucose).toHaveBeenCalledTimes(plan.filter((e) => e.kind === "GLUCOSE").length);
    expect(commands.correctGlucoseTime).toHaveBeenCalledTimes(1);
    expect(commands.correctGlucoseTime.mock.calls[0]![0]).toMatchObject({ recordId: committed.recordId, expectedRevisionNumber: 1 });
    expect(commands.recordInsulin).not.toHaveBeenCalled();
    expect(report).toEqual({ committed: plan.length + 1 });
  });

  it("stops and reports failure instead of continuing on a rejected write", async () => {
    const commands = {
      recordGlucose: vi.fn().mockResolvedValue({ kind: "FAILED", code: "STORAGE_UNAVAILABLE" }),
      correctGlucoseTime: vi.fn(),
      recordInsulin: vi.fn(),
      recordMeal: vi.fn(),
      recordActivity: vi.fn(),
    } satisfies JournalCommandService;
    await expect(seedSyntheticHistory(commands, SEED_AT as never)).rejects.toThrow("SYNTHETIC_SCENARIO_BOOTSTRAP_FAILED");
    expect(commands.recordGlucose).toHaveBeenCalledTimes(1);
  });
});
