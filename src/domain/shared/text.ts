import { z } from "zod";

// Counts Unicode code points in a string, not UTF-16 code units.
// Supplementary-plane characters (e.g. emoji U+1F600) are one code point
// even though they occupy two UTF-16 code units.
export function countCodePoints(value: string): number {
  // Array.from iterates by code point, not by code unit.
  return Array.from(value).length;
}

// Creates a strict text schema that enforces:
// - a code-point length between min and max (inclusive);
// - no leading or trailing whitespace (rejected, not trimmed).
export function createBoundedTextSchema(
  min: number,
  max: number,
): z.ZodEffects<z.ZodEffects<z.ZodEffects<z.ZodString, string, string>, string, string>, string, string> {
  return z
    .string()
    .min(1, "Must not be empty")
    .refine((val) => countCodePoints(val) >= min, `Must be at least ${min} code point(s)`)
    .refine((val) => countCodePoints(val) <= max, `Must be at most ${max} code points`)
    .refine(
      (val) => val === val.trim(),
      "Must not have leading or trailing whitespace",
    );
}