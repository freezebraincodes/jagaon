import { z } from "zod";

// Brand helpers
type Brand<T, B extends string> = T & { readonly __brand: B };

export type Instant = Brand<string, "Instant">;
export type LocalDate = Brand<string, "LocalDate">;

// RFC 3339 / ISO 8601 UTC instant with mandatory Z suffix
// Rejects local time, numeric offsets, and impossible calendar dates.
// Accepts fractional seconds.
const instantRegex =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export const instantSchema = z
  .string()
  .regex(instantRegex, "Must be a UTC ISO 8601 instant ending in Z")
  .refine((val) => {
    // Validate that the date/time is a real calendar moment.
    // JavaScript's Date rolls over impossible dates (e.g. Feb 30 → Mar 2),
    // so we must check the components ourselves.
    const m = val.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
    if (!m) return false;
    const [, y, mo, d, h, mi, s] = m.map(Number) as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    // Validate ranges
    if (mo < 1 || mo > 12) return false;
    if (d < 1 || d > 31) return false;
    if (h > 23) return false;
    if (mi > 59) return false;
    if (s > 59) return false;
    // Validate calendar date using UTC
    const dt = new Date(Date.UTC(y, mo - 1, d));
    return (
      dt.getUTCFullYear() === y &&
      dt.getUTCMonth() === mo - 1 &&
      dt.getUTCDate() === d
    );
  }, "Invalid calendar date/time")
  .transform((val) => val as Instant);

const localDateRegex = /^\d{4}-\d{2}-\d{2}$/;

export const localDateSchema = z
  .string()
  .regex(localDateRegex, "Must be YYYY-MM-DD")
  .refine((val) => {
    const [y, m, d] = val.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return (
      dt.getUTCFullYear() === y &&
      dt.getUTCMonth() === m - 1 &&
      dt.getUTCDate() === d
    );
  }, "Invalid calendar date")
  .transform((val) => val as LocalDate);

// Validates an IANA time zone ID without maintaining a hand-written catalogue.
// Uses Intl.DateTimeFormat as the authoritative runtime check so that valid
// identifiers and recognised aliases (e.g. "UTC") are not rejected merely
// because they are absent from Intl.supportedValuesOf("timeZone").
export function isValidIanaTimeZoneId(value: string): boolean {
  if (!value || typeof value !== "string") return false;
  try {
    // Intl.DateTimeFormat throws RangeError for an unknown timeZone, which is
    // the most reliable cross-runtime signal. This accepts valid IANA
    // identifiers and well-known aliases that supportedValuesOf may omit.
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

// Lossless comparison of two UTC instants preserving arbitrary fractional-
// second precision. Does not rely on millisecond conversion.
//
// Returns negative if a < b, positive if a > b, 0 if equal.
//
// The whole-second portion (YYYY-MM-DDTHH:MM:SS) is fixed-width and
// zero-padded, so lexicographic comparison is correct there. The fractional
// part is compared by right-padding both to equal length so that ".09" vs
// ".1" compares "090" vs "100" (correct: 0.09 < 0.1).
export function compareInstants(a: Instant, b: Instant): number {
  const wholeA = a.slice(0, 19); // YYYY-MM-DDTHH:MM:SS
  const wholeB = b.slice(0, 19);
  // Whole-second comparison: lexicographic is correct for fixed-width ISO.
  if (wholeA < wholeB) return -1;
  if (wholeA > wholeB) return 1;

  // Same whole second — compare fractional parts losslessly.
  const fracA = extractFraction(a);
  const fracB = extractFraction(b);
  // Pad to equal length so decimal comparison is correct.
  const maxLen = Math.max(fracA.length, fracB.length);
  const pa = fracA.padEnd(maxLen, "0");
  const pb = fracB.padEnd(maxLen, "0");
  if (pa < pb) return -1;
  if (pa > pb) return 1;
  return 0;
}

// Extract the fractional-second digits (without the leading dot) or "" if
// there is no fractional part.
function extractFraction(instant: string): string {
  const m = instant.match(/^.{19}\.(\d+)Z$/);
  return m ? m[1] : "";
}

// Convenience predicates built on compareInstants.
export function instantBefore(a: Instant, b: Instant): boolean {
  return compareInstants(a, b) < 0;
}

export function instantAfter(a: Instant, b: Instant): boolean {
  return compareInstants(a, b) > 0;
}

export function instantEqual(a: Instant, b: Instant): boolean {
  return compareInstants(a, b) === 0;
}