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

  it("spans 42 days with deliberate gaps, one correction, an improvement before breakfast and few readings in the last 14 days", () => {
    const rows = PREPARED_DEMO_HISTORY_ROWS;
    const glucose = rows.filter((row): row is Extract<typeof row, { kind: "GLUCOSE" }> => row.kind === "GLUCOSE");
    const kinds = rows.reduce<Record<string, number>>((acc, row) => ({ ...acc, [row.kind]: (acc[row.kind] ?? 0) + 1 }), {});
    expect(kinds).toEqual({ GLUCOSE: 49, MEAL: 15, ACTIVITY: 9 });
    expect(Math.min(...rows.map((row) => row.daysAgo))).toBe(1);
    expect(Math.max(...rows.map((row) => row.daysAgo))).toBe(42);
    const breakfast = glucose.filter((row) => row.slot === "BEFORE_BREAKFAST");
    const dinner = glucose.filter((row) => row.slot === "BEFORE_DINNER");
    // Fewer readings than one per day in each slot: some days are intentionally not recorded.
    expect([breakfast.length, dinner.length]).toEqual([34, 15]);
    expect(glucose.filter((row) => row.correctedTime)).toEqual([expect.objectContaining({ daysAgo: 2, time: "07:37", correctedTime: "07:07", slot: "BEFORE_BREAKFAST" })]);
    const value = (row: { value: string }) => Number(row.value);
    // Earlier weeks about 7.0–8.2 mmol/L before breakfast; the last two weeks about 5.6–6.6; before dinner moderate throughout.
    expect(breakfast.filter((row) => row.daysAgo > 14).every((row) => value(row) >= 7.0 && value(row) <= 8.2)).toBe(true);
    expect(breakfast.filter((row) => row.daysAgo <= 14).every((row) => value(row) >= 5.6 && value(row) <= 6.6)).toBe(true);
    expect(dinner.every((row) => value(row) >= 7.0 && value(row) <= 8.6)).toBe(true);
    // Plausible synthetic values only: one decimal place, never a confirmation-range value.
    expect(glucose.every((row) => /^\d\.\d$/.test(row.value) && value(row) > 0 && value(row) <= 50)).toBe(true);
    // The visit summary's 14 days (today and the 13 days before) stay well under the care-summary request's 32-fact limit and within its
    // English remote wording budget (with the appointment and one question: 14 facts).
    expect(glucose.filter((row) => row.daysAgo <= 13)).toHaveLength(11);
    expect(glucose.filter((row) => row.daysAgo <= 14)).toHaveLength(13);
    // Fewer before-dinner readings in the last two weeks: too few for a before-dinner comparison, so History shows one comparison.
    expect(dinner.filter((row) => row.daysAgo <= 14)).toHaveLength(3);
    expect(new Set(rows.filter((row) => row.kind === "MEAL").map((row) => (row.kind === "MEAL" ? row.label : "")))).toEqual(new Set(["Kaya toast", "Chicken rice"]));
    expect(new Set(rows.filter((row) => row.kind === "ACTIVITY").map((row) => (row.kind === "ACTIVITY" ? row.label : "")))).toEqual(new Set(["Morning walk"]));
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
