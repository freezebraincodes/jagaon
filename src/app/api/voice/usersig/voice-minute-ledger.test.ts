// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InMemoryDailyMinuteLedger, voiceSessionMinutes } from "./voice-minute-ledger";

const day1 = new Date("2026-10-09T10:00:00.000Z");
const day1Late = new Date("2026-10-09T23:59:59.000Z");
const day2 = new Date("2026-10-10T00:00:01.000Z");

describe("voice daily minute ledger (best-effort, per instance)", () => {
  it("reserves the full session allowance per issuance", () => {
    expect(voiceSessionMinutes(90)).toBe(2);
    expect(voiceSessionMinutes(60)).toBe(1);
    expect(voiceSessionMinutes(10)).toBe(1);
    expect(voiceSessionMinutes(900)).toBe(15);
  });

  it("refuses when the day's limit would be exceeded and holds reservations (never auto-released)", async () => {
    const ledger = new InMemoryDailyMinuteLedger({ dailyMinutesLimit: 5 });
    expect((await ledger.reserve(2, day1)).kind).toBe("RESERVED");
    expect((await ledger.reserve(2, day1)).kind).toBe("RESERVED");
    expect(await ledger.reserve(2, day1Late)).toEqual({ kind: "REFUSED", reason: "MINUTES_EXHAUSTED" });
    expect((await ledger.reserve(1, day1Late)).kind).toBe("RESERVED");
    expect(ledger.snapshot(day1)).toEqual({ day: "2026-10-09", usedMinutes: 5, dailyMinutesLimit: 5 });
  });

  it("releases only on request (signing failed), once", async () => {
    const ledger = new InMemoryDailyMinuteLedger({ dailyMinutesLimit: 4 });
    const first = await ledger.reserve(4, day1);
    if (first.kind !== "RESERVED") throw new Error("expected a reservation");
    expect((await ledger.reserve(1, day1)).kind).toBe("REFUSED");
    await ledger.release(first.token);
    await ledger.release(first.token);
    expect(ledger.snapshot(day1).usedMinutes).toBe(0);
    expect((await ledger.reserve(4, day1)).kind).toBe("RESERVED");
  });

  it("starts a later UTC day at zero and never reopens an earlier day", async () => {
    const ledger = new InMemoryDailyMinuteLedger({ dailyMinutesLimit: 2 });
    const held = await ledger.reserve(2, day1);
    expect(await ledger.reserve(1, day1)).toEqual({ kind: "REFUSED", reason: "MINUTES_EXHAUSTED" });
    expect((await ledger.reserve(2, day2)).kind).toBe("RESERVED");
    // A clock that goes back counts against the latest day.
    expect(await ledger.reserve(1, day1)).toEqual({ kind: "REFUSED", reason: "MINUTES_EXHAUSTED" });
    // Releasing a previous day's reservation does not free today's minutes.
    if (held.kind === "RESERVED") await ledger.release(held.token);
    expect(ledger.snapshot(day2).usedMinutes).toBe(2);
  });

  it("fails closed on an invalid clock or amount and refuses a bad limit", async () => {
    const ledger = new InMemoryDailyMinuteLedger({ dailyMinutesLimit: 2 });
    expect(await ledger.reserve(1, new Date(Number.NaN))).toEqual({ kind: "REFUSED", reason: "LEDGER_UNAVAILABLE" });
    expect(await ledger.reserve(0, day1)).toEqual({ kind: "REFUSED", reason: "LEDGER_UNAVAILABLE" });
    expect(await ledger.reserve(1.5, day1)).toEqual({ kind: "REFUSED", reason: "LEDGER_UNAVAILABLE" });
    for (const dailyMinutesLimit of [0, -1, 1.5, Number.NaN]) expect(() => new InMemoryDailyMinuteLedger({ dailyMinutesLimit })).toThrow("VOICE_MINUTE_LEDGER_MISCONFIGURED");
  });

  it("states in its header that it is best-effort, per instance and not a spending cap", () => {
    const source = readFileSync(join(process.cwd(), "src/app/api/voice/usersig/voice-minute-ledger.ts"), "utf8");
    expect(source).toMatch(/BEST-EFFORT, PER INSTANCE, NOT A SPENDING CAP/);
    expect(source).toMatch(/resets to zero on every cold start/);
    expect(source).toMatch(/neither is UserSig expiry/);
  });
});
