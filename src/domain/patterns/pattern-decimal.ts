// Exact decimal helpers used only for structural validation of stored
// pattern facts. They never round or convert a source value.

const DECIMAL = /^(-)?(\d+)(?:\.(\d+))?$/;

type ScaledDecimal = { value: bigint; scale: number };

function parse(value: string): ScaledDecimal | null {
  const match = DECIMAL.exec(value);
  if (!match) return null;
  const fraction = match[3] ?? "";
  const digits = BigInt(`${match[2]}${fraction}`);
  return { value: match[1] ? -digits : digits, scale: fraction.length };
}

function aligned(a: ScaledDecimal, b: ScaledDecimal): [bigint, bigint] {
  const scale = Math.max(a.scale, b.scale);
  return [a.value * 10n ** BigInt(scale - a.scale), b.value * 10n ** BigInt(scale - b.scale)];
}

/** Compare two decimal strings exactly: -1, 0 or 1; null when malformed. */
export function compareDecimalStrings(a: string, b: string): -1 | 0 | 1 | null {
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return null;
  const [x, y] = aligned(left, right);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function decimalSign(value: string): -1 | 0 | 1 | null {
  return compareDecimalStrings(value, "0");
}

/** Canonical form: no superfluous leading or trailing zeroes and no "-0". */
export function isCanonicalDecimal(value: string): boolean {
  if (!/^-?(0|[1-9]\d*)(\.\d*[1-9])?$/.test(value)) return false;
  return !/^-0(\.0*)?$/.test(value);
}

export function isCanonicalNonNegativeDecimal(value: string): boolean {
  return isCanonicalDecimal(value) && decimalSign(value) !== -1;
}

export function isCanonicalUnitRatio(value: string): boolean {
  return isCanonicalNonNegativeDecimal(value) && compareDecimalStrings(value, "1") !== 1;
}

/**
 * The governed serialisation of a ratio: six fractional places, half-up
 * rounding, trailing zeroes removed (deterministic-engine Section 8.4).
 */
export function formatRatioHalfUp(numerator: bigint, denominator: bigint): string {
  if (denominator <= 0n || numerator < 0n) throw new RangeError("INVALID_RATIO");
  const scaled = (numerator * 2_000_000n + denominator) / (2n * denominator);
  const whole = scaled / 1_000_000n;
  const fraction = (scaled % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction.length > 0 ? `${whole}.${fraction}` : `${whole}`;
}

/** Key-sorted JSON used to compare structured identities exactly. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}
