// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InMemoryDailySpendLedger, type SpendLedger, type SpendReservationToken } from "./ai-spend-ledger";

/**
 * Packet 11C Addendum C, Task C6: the SpendLedger port and its only shipped implementation, the per-instance in-memory daily guard. The
 * limits here are TEST values only; no budget is a code default (the owner's daily limit is a deployment value).
 */

const DAY = new Date("2026-10-08T10:00:00.000Z");
const NEXT_DAY = new Date("2026-10-09T00:00:00.000Z");
const LIMIT = 10_000;

async function reserved(ledger: SpendLedger, amount: number, now = DAY): Promise<SpendReservationToken> {
  const result = await ledger.reserve(amount, now);
  if (result.kind !== "RESERVED") throw new Error(`expected a reservation, got ${result.reason}`);
  return result.token;
}

describe("InMemoryDailySpendLedger (best-effort per-instance guard, not a global cap)", () => {
  it("reserves while committed + held + the new upper bound stays within the daily limit, and refuses beyond it", async () => {
    const ledger = new InMemoryDailySpendLedger({ dailyLimitMicroUsd: LIMIT });
    await reserved(ledger, 6_000);
    await reserved(ledger, 4_000);
    expect(await ledger.reserve(1, DAY)).toEqual({ kind: "REFUSED", reason: "SPEND_CEILING_REACHED" });
    expect(ledger.snapshot(DAY)).toEqual({ day: "2026-10-08", committedMicroUsd: 0, heldMicroUsd: 10_000, dailyLimitMicroUsd: LIMIT });
  });

  it("a single upper bound above the limit is refused; an invalid amount or clock is refused as unavailable (fail closed)", async () => {
    const ledger = new InMemoryDailySpendLedger({ dailyLimitMicroUsd: LIMIT });
    expect(await ledger.reserve(LIMIT + 1, DAY)).toEqual({ kind: "REFUSED", reason: "SPEND_CEILING_REACHED" });
    for (const amount of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(await ledger.reserve(amount, DAY), String(amount)).toEqual({ kind: "REFUSED", reason: "SPEND_LEDGER_UNAVAILABLE" });
    }
    expect(await ledger.reserve(1, new Date(Number.NaN))).toEqual({ kind: "REFUSED", reason: "SPEND_LEDGER_UNAVAILABLE" });
    expect(ledger.snapshot(DAY).heldMicroUsd).toBe(0);
  });

  it("refuses to construct without a valid positive whole micro-USD limit (no default budget)", () => {
    for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, undefined, null, "1000"]) {
      expect(() => new InMemoryDailySpendLedger({ dailyLimitMicroUsd: limit as never }), String(limit)).toThrow("SPEND_LEDGER_MISCONFIGURED");
    }
  });

  it("commit REPORTED: the reported amount is committed and only the unused remainder of the reservation is released", async () => {
    const ledger = new InMemoryDailySpendLedger({ dailyLimitMicroUsd: LIMIT });
    const token = await reserved(ledger, 6_000);
    await ledger.commit(token, 1_500, "REPORTED");
    expect(ledger.snapshot(DAY)).toMatchObject({ committedMicroUsd: 1_500, heldMicroUsd: 0 });
    // The released remainder is available again: 1_500 + 8_500 = the limit.
    await reserved(ledger, 8_500);
    expect(await ledger.reserve(1, DAY)).toEqual({ kind: "REFUSED", reason: "SPEND_CEILING_REACHED" });
  });

  it("commit UPPER_BOUND (transmitted, usage missing): the full reservation is committed, never zero and never less", async () => {
    const ledger = new InMemoryDailySpendLedger({ dailyLimitMicroUsd: LIMIT });
    for (const billed of [0, 10, Number.NaN, -5]) {
      const token = await reserved(ledger, 1_000);
      await ledger.commit(token, billed, "UPPER_BOUND");
    }
    expect(ledger.snapshot(DAY)).toMatchObject({ committedMicroUsd: 4_000, heldMicroUsd: 0 });
    // An unreadable REPORTED amount is counted at the full reservation too (conservative).
    const token = await reserved(ledger, 1_000);
    await ledger.commit(token, Number.NaN, "REPORTED");
    expect(ledger.snapshot(DAY)).toMatchObject({ committedMicroUsd: 5_000, heldMicroUsd: 0 });
  });

  it("a reported amount above the reservation is committed as reported (truthful, never capped down)", async () => {
    const ledger = new InMemoryDailySpendLedger({ dailyLimitMicroUsd: LIMIT });
    const token = await reserved(ledger, 1_000);
    await ledger.commit(token, 1_200, "REPORTED");
    expect(ledger.snapshot(DAY)).toMatchObject({ committedMicroUsd: 1_200, heldMicroUsd: 0 });
  });

  it("release (never transmitted) frees the whole reservation; settling is once only and an unknown token is ignored", async () => {
    const ledger = new InMemoryDailySpendLedger({ dailyLimitMicroUsd: LIMIT });
    const token = await reserved(ledger, 7_000);
    await ledger.release(token);
    await ledger.release(token);
    await ledger.commit(token, 7_000, "REPORTED");
    expect(ledger.snapshot(DAY)).toMatchObject({ committedMicroUsd: 0, heldMicroUsd: 0 });
    const other = new InMemoryDailySpendLedger({ dailyLimitMicroUsd: LIMIT });
    const foreign = await reserved(other, 1_000);
    await ledger.commit(foreign, 1_000, "REPORTED");
    expect(ledger.snapshot(DAY)).toMatchObject({ committedMicroUsd: 0, heldMicroUsd: 0 });
  });

  it("concurrent reservations within one instance never overshoot the limit (atomic check-and-hold per call)", async () => {
    const ledger = new InMemoryDailySpendLedger({ dailyLimitMicroUsd: LIMIT });
    const results = await Promise.all(Array.from({ length: 50 }, () => ledger.reserve(900, DAY)));
    expect(results.filter((result) => result.kind === "RESERVED")).toHaveLength(11);
    expect(results.filter((result) => result.kind === "REFUSED" && result.reason === "SPEND_CEILING_REACHED")).toHaveLength(39);
    expect(ledger.snapshot(DAY).heldMicroUsd).toBeLessThanOrEqual(LIMIT);
  });

  it("the day is the UTC calendar day of the clock given to reserve: committed spend restarts with the first reservation of a later day; held reservations carry over", async () => {
    const ledger = new InMemoryDailySpendLedger({ dailyLimitMicroUsd: LIMIT });
    const settled = await reserved(ledger, 8_000, new Date("2026-10-08T23:59:59.999Z"));
    await ledger.commit(settled, 8_000, "REPORTED");
    const inFlight = await reserved(ledger, 2_000, new Date("2026-10-08T23:59:59.999Z"));
    // Singapore 08:00 on 9 October is still 8 October in UTC: no reset yet.
    expect(await ledger.reserve(1, new Date("2026-10-08T23:59:59.999Z"))).toEqual({ kind: "REFUSED", reason: "SPEND_CEILING_REACHED" });
    // A new UTC day: committed resets, the in-flight reservation is still held (conservative).
    await reserved(ledger, 8_000, NEXT_DAY);
    expect(ledger.snapshot(NEXT_DAY)).toEqual({ day: "2026-10-09", committedMicroUsd: 0, heldMicroUsd: 10_000, dailyLimitMicroUsd: LIMIT });
    // A settlement counts against the latest day the ledger has seen (here the new day, already reached by a reservation; commit itself
    // never advances the day).
    await ledger.commit(inFlight, 2_000, "REPORTED");
    expect(ledger.snapshot(NEXT_DAY)).toMatchObject({ committedMicroUsd: 2_000, heldMicroUsd: 8_000 });
    // A clock that goes back never reopens an earlier day's budget.
    expect(await ledger.reserve(1, DAY)).toEqual({ kind: "REFUSED", reason: "SPEND_CEILING_REACHED" });
    expect(ledger.snapshot(DAY).day).toBe("2026-10-09");
  });

  it("documents its limits in code: per instance, reset on cold start, no coordination across instances, not a global cap", () => {
    const source = readFileSync(join(process.cwd(), "src/app/api/ai/shell/ai-spend-ledger.ts"), "utf8");
    expect(source).toContain("best-effort per-instance guard, not a global cap");
    expect(source).toMatch(/cold start/);
    expect(source).toMatch(/does NOT coordinate/);
    // No storage, database or external service.
    expect(source).not.toMatch(/from\s+["'](?!\.)[^"']*["']/);
  });
});
