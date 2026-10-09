/**
 * Packet 11C Addendum C, Task C6: the route's spend ledger (owner approval of Addendum C; C6 amendment 2026-10-08). Server-only.
 *
 * `SpendLedger` is the port `/api/ai/shell` reserves against before it reads the provider credential:
 * - `reserve(upperBoundMicroUsd, now)`: holds the call's pre-send upper bound (`shellRouteCallUpperBound`) when the day's committed spend
 *   plus every held reservation plus this bound stays within the configured daily limit; otherwise refuses with a closed reason. The check
 *   and the hold are one atomic step per call within the implementation.
 * - `commit(token, billedMicroUsd, basis)`: the call was transmitted (potentially billed). REPORTED commits the provider-reported amount
 *   (as reported, also when above the reservation); UPPER_BOUND (transmitted, usage missing or unreadable) commits the full reservation,
 *   never zero and never less. An unreadable REPORTED amount is committed at the full reservation too. Only the unused remainder of the
 *   reservation is released.
 * - `release(token)`: the call was never transmitted; the whole reservation is released.
 * A token settles once; a second settlement or an unknown token is ignored. The route refuses (fail closed) when the ledger throws,
 * answers anything but a reservation, or is not configured.
 *
 * `InMemoryDailySpendLedger` is the only implementation shipped. It is a best-effort per-instance guard, not a global cap:
 * - it lives in the memory of ONE server instance (one Vercel serverless instance, or one `next start` process) and is lost, so reset
 *   to zero, on every cold start, restart or redeploy;
 * - it does NOT coordinate concurrent instances: N instances may each spend up to the daily limit;
 * - its day is the UTC calendar day of the clock passed to `reserve` (the only call that reads it and advances the day): committed spend
 *   starts again at zero on the first reservation of a later UTC day, held reservations carry over, and a clock that goes back never
 *   reopens an earlier day. `commit` does not advance the day: a settlement counts against the latest day the ledger has seen.
 * The aggregate monetary limit therefore rests on the provider account (a dedicated, prepaid demo balance) unless the owner provides
 * shared storage; see docs/status/packet-11c-integration.md, "Deployment configuration (not set)". No storage, database or external
 * service is used, and no budget is a code default: the daily limit comes only from the deployment configuration.
 */

export type SpendLedgerRefusalReason = "SPEND_CEILING_REACHED" | "SPEND_LEDGER_UNAVAILABLE";
declare const spendReservation: unique symbol;
/** An opaque reservation handle, meaningful only to the ledger that issued it. */
export type SpendReservationToken = Readonly<{ [spendReservation]: true }>;
export type SpendReserveResult = Readonly<{ kind: "RESERVED"; token: SpendReservationToken }> | Readonly<{ kind: "REFUSED"; reason: SpendLedgerRefusalReason }>;
export type SpendCommitBasis = "REPORTED" | "UPPER_BOUND";

export type SpendLedger = Readonly<{
  reserve(upperBoundMicroUsd: number, now: Date): Promise<SpendReserveResult>;
  commit(token: SpendReservationToken, billedMicroUsd: number, basis: SpendCommitBasis): Promise<void>;
  release(token: SpendReservationToken): Promise<void>;
}>;

const isAmount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const isBilled = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
/** The UTC calendar day (YYYY-MM-DD) of an instant, or null for an invalid clock. */
function utcDay(now: Date): string | null {
  const time = now instanceof Date ? now.getTime() : Number.NaN;
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : null;
}

export class InMemoryDailySpendLedger implements SpendLedger {
  readonly #limit: number;
  /** The open reservations of this instance and their held amounts. */
  readonly #open = new Map<SpendReservationToken, number>();
  #day: string | null = null;
  #committed = 0;
  #held = 0;

  constructor(options: { dailyLimitMicroUsd: number }) {
    if (!isAmount(options?.dailyLimitMicroUsd)) throw new Error("SPEND_LEDGER_MISCONFIGURED");
    this.#limit = options.dailyLimitMicroUsd;
  }

  /** Moves to a later UTC day (committed spend starts again at zero); an earlier day never reopens. */
  #advance(day: string): void {
    if (this.#day === null || day > this.#day) {
      this.#day = day;
      this.#committed = 0;
    }
  }

  async reserve(upperBoundMicroUsd: number, now: Date): Promise<SpendReserveResult> {
    const day = utcDay(now);
    if (day === null || !isAmount(upperBoundMicroUsd)) return { kind: "REFUSED", reason: "SPEND_LEDGER_UNAVAILABLE" };
    // One synchronous step: no other call can interleave between the check and the hold.
    this.#advance(day);
    if (this.#committed + this.#held + upperBoundMicroUsd > this.#limit) return { kind: "REFUSED", reason: "SPEND_CEILING_REACHED" };
    const token = Object.freeze({}) as SpendReservationToken;
    this.#open.set(token, upperBoundMicroUsd);
    this.#held += upperBoundMicroUsd;
    return { kind: "RESERVED", token };
  }

  async commit(token: SpendReservationToken, billedMicroUsd: number, basis: SpendCommitBasis): Promise<void> {
    const reserved = this.#settle(token);
    if (reserved === null) return;
    // Counted against the latest UTC day this ledger has seen (commit does not read a clock or advance the day). A call settled after
    // 00:00 UTC counts against the new day only once a later `reserve` has moved the ledger to it; until then it counts against the
    // earlier day, whose total is then dropped when the day advances.
    this.#committed += basis === "REPORTED" && isBilled(billedMicroUsd) ? billedMicroUsd : Math.max(reserved, isBilled(billedMicroUsd) ? billedMicroUsd : 0);
  }

  async release(token: SpendReservationToken): Promise<void> {
    this.#settle(token);
  }

  /** Ends a reservation once: its held amount is released; returns it, or null for an unknown or already settled token. */
  #settle(token: SpendReservationToken): number | null {
    const reserved = this.#open.get(token);
    if (reserved === undefined) return null;
    this.#open.delete(token);
    this.#held -= reserved;
    return reserved;
  }

  /** A read-only view for tests and diagnostics (never part of a response): the current day, committed and held amounts, the limit. */
  snapshot(now: Date): Readonly<{ day: string | null; committedMicroUsd: number; heldMicroUsd: number; dailyLimitMicroUsd: number }> {
    const day = utcDay(now);
    const later = day !== null && (this.#day === null || day > this.#day);
    return { day: later ? day : this.#day, committedMicroUsd: later ? 0 : this.#committed, heldMicroUsd: this.#held, dailyLimitMicroUsd: this.#limit };
  }
}
