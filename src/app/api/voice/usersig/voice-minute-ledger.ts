/**
 * Packet 13 slice (P13S, S6a): the voice route's daily minute guard. Server-only.
 *
 * BEST-EFFORT, PER INSTANCE, NOT A SPENDING CAP:
 * - it lives in the memory of ONE server instance and resets to zero on every cold start, restart or redeploy;
 * - it does not coordinate instances: N instances may each issue up to the daily limit;
 * - it is NOT a global or guaranteed TRTC spending cap, and neither is UserSig expiry (a UserSig is a bearer token valid until it
 *   expires; Tencent-side behaviour at expiry mid-session is undocumented). Only Tencent-side limits, the operator and the owner's
 *   cost ceiling bound spend.
 *
 * The server never sees actual microphone use, so each issuance reserves the full session allowance (`ceil(maxSessionSeconds / 60)`
 * minutes) and holds it for the day. A reservation is released only when signing fails (nothing was issued). The day is the UTC
 * calendar day of the clock passed to `reserve`; a later day starts again at zero, and a clock that goes back never reopens an earlier
 * day.
 */
export type VoiceMinuteReserveResult = Readonly<{ kind: "RESERVED"; token: VoiceMinuteReservation }> | Readonly<{ kind: "REFUSED"; reason: "MINUTES_EXHAUSTED" | "LEDGER_UNAVAILABLE" }>;
declare const voiceMinuteReservation: unique symbol;
export type VoiceMinuteReservation = Readonly<{ [voiceMinuteReservation]: true }>;

export type VoiceMinuteLedger = Readonly<{
  reserve(minutes: number, now: Date): Promise<VoiceMinuteReserveResult>;
  release(token: VoiceMinuteReservation): Promise<void>;
}>;

export function voiceSessionMinutes(maxSessionSeconds: number): number {
  return Math.ceil(maxSessionSeconds / 60);
}

function utcDay(now: Date): string | null {
  const time = now instanceof Date ? now.getTime() : Number.NaN;
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : null;
}

export class InMemoryDailyMinuteLedger implements VoiceMinuteLedger {
  readonly #limit: number;
  readonly #open = new Map<VoiceMinuteReservation, Readonly<{ day: string; minutes: number }>>();
  #day: string | null = null;
  #used = 0;

  constructor(options: { dailyMinutesLimit: number }) {
    if (!Number.isSafeInteger(options?.dailyMinutesLimit) || options.dailyMinutesLimit <= 0) throw new Error("VOICE_MINUTE_LEDGER_MISCONFIGURED");
    this.#limit = options.dailyMinutesLimit;
  }

  async reserve(minutes: number, now: Date): Promise<VoiceMinuteReserveResult> {
    const day = utcDay(now);
    if (day === null || !Number.isSafeInteger(minutes) || minutes <= 0) return { kind: "REFUSED", reason: "LEDGER_UNAVAILABLE" };
    // One synchronous step: no other call interleaves between the check and the hold.
    if (this.#day === null || day > this.#day) {
      this.#day = day;
      this.#used = 0;
    }
    if (this.#used + minutes > this.#limit) return { kind: "REFUSED", reason: "MINUTES_EXHAUSTED" };
    this.#used += minutes;
    const token = Object.freeze({}) as VoiceMinuteReservation;
    this.#open.set(token, Object.freeze({ day: this.#day, minutes }));
    return { kind: "RESERVED", token };
  }

  /** Signing failed: give the minutes back (only within the same day; an unknown or settled token is ignored). */
  async release(token: VoiceMinuteReservation): Promise<void> {
    const held = this.#open.get(token);
    if (!held) return;
    this.#open.delete(token);
    if (held.day === this.#day) this.#used -= held.minutes;
  }

  /** Read-only view for tests and diagnostics (never part of a response). */
  snapshot(now: Date): Readonly<{ day: string | null; usedMinutes: number; dailyMinutesLimit: number }> {
    const day = utcDay(now);
    const later = day !== null && (this.#day === null || day > this.#day);
    return { day: later ? day : this.#day, usedMinutes: later ? 0 : this.#used, dailyMinutesLimit: this.#limit };
  }
}
