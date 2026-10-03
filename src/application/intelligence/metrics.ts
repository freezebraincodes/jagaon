import { canonicalizeJson, type Sha256Digest } from "@/application/contracts/canonical-json";
import type { Instant } from "@/domain/shared/time";
import type { RecordType } from "@/domain/shared/record-catalogue";
import type { TypedRevisionRef } from "@/domain/shared/typed-revision-ref";

/**
 * Packet 7A deterministic metric utilities ("metric-utilities.v1").
 *
 * Deterministic-engine Sections 8.4 and 19.2: exact rational arithmetic,
 * ordered-middle medians, Tukey hinges, interval overlap, six-place half-up
 * ratio serialisation, stable ordering and canonical fingerprints. No
 * floating-point value takes part in any threshold decision.
 */

export const METRIC_RULE_VERSION = "metric-utilities.v1";

// --- Exact rationals ------------------------------------------------------------

export type Rational = { readonly numerator: bigint; readonly denominator: bigint };

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x === 0n ? 1n : x;
}

function rational(numerator: bigint, denominator: bigint): Rational {
  if (denominator === 0n) throw new RangeError("DIVISION_BY_ZERO");
  const sign = denominator < 0n ? -1n : 1n;
  const divisor = gcd(numerator, denominator);
  return { numerator: (sign * numerator) / divisor, denominator: (sign * denominator) / divisor };
}

/** Parse a plain decimal string exactly. */
export function decimal(value: string): Rational {
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) throw new RangeError("INVALID_DECIMAL");
  const fraction = match[3] ?? "";
  const digits = BigInt(`${match[2]}${fraction}`);
  return rational(match[1] ? -digits : digits, 10n ** BigInt(fraction.length));
}

export const ZERO: Rational = rational(0n, 1n);

export function rationalAdd(a: Rational, b: Rational): Rational {
  return rational(a.numerator * b.denominator + b.numerator * a.denominator, a.denominator * b.denominator);
}

export function rationalSubtract(a: Rational, b: Rational): Rational {
  return rational(a.numerator * b.denominator - b.numerator * a.denominator, a.denominator * b.denominator);
}

export function rationalDivide(a: Rational, b: Rational): Rational {
  if (b.numerator === 0n) throw new RangeError("DIVISION_BY_ZERO");
  return rational(a.numerator * b.denominator, a.denominator * b.numerator);
}

export function rationalAbs(a: Rational): Rational {
  return a.numerator < 0n ? rational(-a.numerator, a.denominator) : a;
}

export function compareRational(a: Rational, b: Rational): -1 | 0 | 1 {
  const left = a.numerator * b.denominator;
  const right = b.numerator * a.denominator;
  return left < right ? -1 : left > right ? 1 : 0;
}

export function rationalMax(a: Rational, b: Rational): Rational {
  return compareRational(a, b) >= 0 ? a : b;
}

export function rationalMin(a: Rational, b: Rational): Rational {
  return compareRational(a, b) <= 0 ? a : b;
}

export function rationalSign(a: Rational): -1 | 0 | 1 {
  return a.numerator < 0n ? -1 : a.numerator > 0n ? 1 : 0;
}

/** Exact canonical decimal text; throws when the value does not terminate. */
export function canonicalDecimal(value: Rational): string {
  let denominator = value.denominator;
  let twos = 0;
  let fives = 0;
  while (denominator % 2n === 0n) {
    denominator /= 2n;
    twos += 1;
  }
  while (denominator % 5n === 0n) {
    denominator /= 5n;
    fives += 1;
  }
  if (denominator !== 1n) throw new RangeError("NON_TERMINATING_DECIMAL");
  const scale = Math.max(twos, fives);
  const scaled = (value.numerator * 10n ** BigInt(scale)) / value.denominator;
  const negative = scaled < 0n;
  const digits = (negative ? -scaled : scaled).toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale).replace(/0+$/, "");
  const text = fraction.length > 0 ? `${whole}.${fraction}` : whole;
  return negative && text !== "0" ? `-${text}` : text;
}

/** Six fractional places, half-up rounding, trailing zeroes removed (non-negative). */
export function formatRatio6(value: Rational): string {
  if (value.numerator < 0n) throw new RangeError("NEGATIVE_RATIO");
  const scaled = (value.numerator * 2_000_000n + value.denominator) / (2n * value.denominator);
  const whole = scaled / 1_000_000n;
  const fraction = (scaled % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction.length > 0 ? `${whole}.${fraction}` : `${whole}`;
}

// --- Robust summaries -------------------------------------------------------------

function sorted(values: readonly Rational[]): Rational[] {
  return [...values].sort(compareRational);
}

/** Ordered middle value, or the exact mean of the two middle values. */
export function median(values: readonly Rational[]): Rational {
  if (values.length === 0) throw new RangeError("EMPTY_SAMPLE");
  const ordered = sorted(values);
  const middle = Math.floor(ordered.length / 2);
  if (ordered.length % 2 === 1) return ordered[middle]!;
  return rationalDivide(rationalAdd(ordered[middle - 1]!, ordered[middle]!), rational(2n, 1n));
}

/** Tukey hinges: an odd sample places its median in both halves; IQR = Q3 − Q1. */
export function tukeyHinges(values: readonly Rational[]): { q1: Rational; q3: Rational; iqr: Rational } {
  if (values.length === 0) throw new RangeError("EMPTY_SAMPLE");
  const ordered = sorted(values);
  const half = Math.ceil(ordered.length / 2);
  const q1 = median(ordered.slice(0, half));
  const q3 = median(ordered.slice(ordered.length - half));
  return { q1, q3, iqr: rationalSubtract(q3, q1) };
}

/**
 * Interval overlap = intersection length / union length, clamped to zero.
 * Two zero-width intervals overlap fully only when their point is equal.
 */
export function intervalOverlapRatio(a: readonly [Rational, Rational], b: readonly [Rational, Rational]): Rational {
  const intersection = rationalSubtract(rationalMin(a[1], b[1]), rationalMax(a[0], b[0]));
  const union = rationalSubtract(rationalMax(a[1], b[1]), rationalMin(a[0], b[0]));
  if (rationalSign(union) === 0) return compareRational(a[0], b[0]) === 0 ? rational(1n, 1n) : ZERO;
  if (rationalSign(intersection) <= 0) return ZERO;
  return rationalDivide(intersection, union);
}

// --- Time -----------------------------------------------------------------------------

const DAY_MS = 86_400_000;

export function instantMs(instant: string): number {
  return Date.parse(instant);
}

export function toInstant(ms: number): Instant {
  return new Date(ms).toISOString() as Instant;
}

export function addDays(instant: string, days: number): Instant {
  return toInstant(instantMs(instant) + days * DAY_MS);
}

/** Local calendar date using the event's recorded offset, never ingestion time. */
export function localDateOf(instant: string, utcOffsetMinutes: number): string {
  return new Date(instantMs(instant) + utcOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

export function distinctLocalDates(points: readonly { instant: string; utcOffsetMinutes: number }[]): number {
  return new Set(points.map((point) => localDateOf(point.instant, point.utcOffsetMinutes))).size;
}

/** Fixed seven-day block counted back from a half-open window end (0 = latest). */
export function weekBlockIndex(instant: string, windowEnd: string): number {
  return Math.floor((instantMs(windowEnd) - instantMs(instant) - 1) / (7 * DAY_MS));
}

export function daysBetween(earlier: string, later: string): number {
  return (instantMs(later) - instantMs(earlier)) / DAY_MS;
}

// --- Canonical ordering --------------------------------------------------------------

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function sortRevisionRefs<T extends TypedRevisionRef<RecordType>>(refs: readonly T[]): T[] {
  return [...refs].sort(
    (a, b) =>
      compareText(a.recordType, b.recordType) || compareText(a.recordId, b.recordId) || compareText(a.revisionId, b.revisionId),
  );
}

export function sortByInstantThenRevision<T extends { instant: string; revisionId: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => instantMs(a.instant) - instantMs(b.instant) || compareText(a.revisionId, b.revisionId));
}

// --- Synchronous SHA-256 (FIPS 180-4) and canonical fingerprints -------------------

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

/** Synchronous SHA-256 of the UTF-8 encoding of `text`, as lowercase hex. */
export function sha256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const bitLength = bytes.length * 8;
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 2 ** 32));
  view.setUint32(padded.length - 4, bitLength >>> 0);

  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash as unknown as number[];
    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e!, 6) ^ rotr(e!, 11) ^ rotr(e!, 25);
      const ch = (e! & f!) ^ (~e! & g!);
      const t1 = (h! + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = rotr(a!, 2) ^ rotr(a!, 13) ^ rotr(a!, 22);
      const maj = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const t2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d! + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    hash[0] = (hash[0]! + a!) >>> 0;
    hash[1] = (hash[1]! + b!) >>> 0;
    hash[2] = (hash[2]! + c!) >>> 0;
    hash[3] = (hash[3]! + d!) >>> 0;
    hash[4] = (hash[4]! + e!) >>> 0;
    hash[5] = (hash[5]! + f!) >>> 0;
    hash[6] = (hash[6]! + g!) >>> 0;
    hash[7] = (hash[7]! + h!) >>> 0;
  }
  return [...hash].map((word) => word.toString(16).padStart(8, "0")).join("");
}

/** SHA-256 of the canonical JSON form (identical to `hashCanonicalJson`). */
export function fingerprint(value: unknown): Sha256Digest {
  return sha256Hex(canonicalizeJson(value)) as Sha256Digest;
}
