import { describe, expect, it, vi } from "vitest";
import type { JournalCommandService } from "@/application/journal/journal-contracts";
import { planSyntheticHistory, seedSyntheticHistory } from "./synthetic-history-seed";

const SEED_AT = "2026-10-04T02:00:00.000Z"; // 10:00 Sunday in Singapore

describe("deterministic synthetic Recorded-history seed", () => {
  it("is a pure function of the seed instant", () => {
    expect(planSyntheticHistory(SEED_AT as never)).toEqual(planSyntheticHistory(SEED_AT as never));
  });

  it("never seeds a future occurrence and spans the 42-day comparison window", () => {
    const plan = planSyntheticHistory(SEED_AT as never);
    const instants = plan.map((entry) => Date.parse(entry.occurredAt));
    expect(Math.max(...instants)).toBeLessThan(Date.parse(SEED_AT));
    expect(Math.min(...instants)).toBeGreaterThanOrEqual(Date.parse(SEED_AT) - 42 * 86_400_000);
  });

  it("contains glucose, intake and activity records with deliberate gaps and one correction", () => {
    const plan = planSyntheticHistory(SEED_AT as never);
    const kinds = plan.reduce<Record<string, number>>((acc, entry) => ({ ...acc, [entry.kind]: (acc[entry.kind] ?? 0) + 1 }), {});
    expect(kinds.GLUCOSE).toBeGreaterThanOrEqual(60);
    expect(kinds.MEAL).toBeGreaterThanOrEqual(8);
    expect(kinds.ACTIVITY).toBeGreaterThanOrEqual(6);
    expect(plan.filter((entry) => entry.kind === "GLUCOSE" && entry.correctedTo)).toHaveLength(1);
    // Fewer readings than two per day: some positions are intentionally not recorded.
    expect(kinds.GLUCOSE).toBeLessThan(2 * 42);
    expect(new Set(plan.filter((e) => e.kind === "MEAL").map((e) => (e.kind === "MEAL" ? e.label : "")))).toEqual(
      new Set(["Kaya toast", "Chicken rice"]),
    );
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
