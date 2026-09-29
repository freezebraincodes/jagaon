import { z } from "zod";

// --- Section 3.6: DecimalString ---

// Brand helpers
type Brand<T, B extends string> = T & { readonly __brand: B };

export type DecimalString = Brand<string, "DecimalString">;

// Accepts a plain finite decimal form: optional sign, one or more digits in
// the integer part (leading zeros accepted and preserved), optional
// fractional part. Rejects scientific notation, non-numeric values, leading
// + sign, and empty strings. Does not coerce or canonicalise.
const decimalStringRegex = /^-?\d+(\.\d+)?$/;

export const decimalStringSchema = z
  .string()
  .regex(decimalStringRegex, "Must be a plain finite decimal string")
  .transform((val) => val as DecimalString);

// --- Section 3.6: MeasurementValue ---

export type MeasurementValue<
  TEnteredUnit extends string,
  TCanonicalUnit extends string,
> = {
  enteredValue: DecimalString;
  enteredUnit: TEnteredUnit;
  normalization:
    | {
        canonicalValue: DecimalString;
        canonicalUnit: TCanonicalUnit;
        normalizerVersion: string;
      }
    | null;
};

// Schema factory: accepts the entity's entered-unit and canonical-unit
// schemas so only compatible combinations compose.
export function createMeasurementValueSchema<
  TEnteredUnitSchema extends z.ZodType<string>,
  TCanonicalUnitSchema extends z.ZodType<string>,
>(
  enteredUnitS: TEnteredUnitSchema,
  canonicalUnitS: TCanonicalUnitSchema,
) {
  const normalizationSchema = z.union([
    z.strictObject({
      canonicalValue: decimalStringSchema,
      canonicalUnit: canonicalUnitS,
      normalizerVersion: z.string().min(1),
    }),
    z.null(),
  ]);

  return z.strictObject({
    enteredValue: decimalStringSchema,
    enteredUnit: enteredUnitS,
    normalization: normalizationSchema,
  });
}