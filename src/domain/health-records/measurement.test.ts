import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  decimalStringSchema,
  createMeasurementValueSchema,
  type DecimalString,
  type MeasurementValue,
} from "./measurement";

describe("decimalStringSchema", () => {
  it("accepts a whole number", () => {
    expect(decimalStringSchema.parse("5")).toBe("5");
  });

  it("accepts a decimal number", () => {
    expect(decimalStringSchema.parse("5.5")).toBe("5.5");
  });

  it("accepts a number with leading zero", () => {
    expect(decimalStringSchema.parse("0.5")).toBe("0.5");
  });

  it("accepts a whole number with leading zeros (05)", () => {
    expect(decimalStringSchema.parse("05")).toBe("05");
  });

  it("accepts a decimal with leading zeros in integer part (005.50)", () => {
    expect(decimalStringSchema.parse("005.50")).toBe("005.50");
  });

  it("preserves trailing zeros in the fractional part", () => {
    expect(decimalStringSchema.parse("5.500")).toBe("5.500");
  });

  it("preserves both leading and trailing zeros (007.00)", () => {
    expect(decimalStringSchema.parse("007.00")).toBe("007.00");
  });

  it("preserves a negative number with leading zeros (-005)", () => {
    expect(decimalStringSchema.parse("-005")).toBe("-005");
  });

  it("accepts a number with trailing zeros in fraction", () => {
    expect(decimalStringSchema.parse("5.50")).toBe("5.50");
  });

  it("accepts a large number", () => {
    expect(decimalStringSchema.parse("180.7")).toBe("180.7");
  });

  it("rejects scientific notation", () => {
    expect(() => decimalStringSchema.parse("1e5")).toThrow();
  });

  it("rejects a negative sign only", () => {
    expect(() => decimalStringSchema.parse("-")).toThrow();
  });

  it("rejects a non-numeric string", () => {
    expect(() => decimalStringSchema.parse("abc")).toThrow();
  });

  it("rejects an empty string", () => {
    expect(() => decimalStringSchema.parse("")).toThrow();
  });

  it("rejects whitespace-only input", () => {
    expect(() => decimalStringSchema.parse("   ")).toThrow();
  });

  it("rejects input with internal whitespace", () => {
    expect(() => decimalStringSchema.parse("5 5")).toThrow();
  });

  it("rejects NaN", () => {
    expect(() => decimalStringSchema.parse("NaN")).toThrow();
  });

  it("rejects Infinity", () => {
    expect(() => decimalStringSchema.parse("Infinity")).toThrow();
  });

  it("rejects hexadecimal values", () => {
    expect(() => decimalStringSchema.parse("0x1F")).toThrow();
  });

  it("rejects numeric separators", () => {
    expect(() => decimalStringSchema.parse("1_000")).toThrow();
  });

  it("rejects numeric JavaScript input (number 5)", () => {
    expect(() => (decimalStringSchema as unknown as { parse: (v: unknown) => unknown }).parse(5)).toThrow();
  });

  it("rejects a non-numeric string", () => {
    expect(() => decimalStringSchema.parse("abc")).toThrow();
  });

  it("rejects leading + sign", () => {
    expect(() => decimalStringSchema.parse("+5")).toThrow();
  });

  it("accepts a value with many decimal places", () => {
    expect(decimalStringSchema.parse("5.123456789")).toBe("5.123456789");
  });
});

describe("createMeasurementValueSchema", () => {
  const weightSchema = createMeasurementValueSchema(
    z.enum(["KG", "LB"]),
    z.enum(["KG"]),
  );

  it("accepts a measurement with normalisation", () => {
    const result = weightSchema.parse({
      enteredValue: "70.5",
      enteredUnit: "KG",
      normalization: {
        canonicalValue: "70.5",
        canonicalUnit: "KG",
        normalizerVersion: "1.0.0",
      },
    });
    expect(result.enteredValue).toBe("70.5");
  });

  it("accepts a measurement with null normalisation", () => {
    const result = weightSchema.parse({
      enteredValue: "154.3",
      enteredUnit: "LB",
      normalization: null,
    });
    expect(result.normalization).toBeNull();
    expect(result.enteredUnit).toBe("LB");
  });

  it("preserves the original entered value and unit", () => {
    const result = weightSchema.parse({
      enteredValue: "70.5",
      enteredUnit: "KG",
      normalization: {
        canonicalValue: "70.5",
        canonicalUnit: "KG",
        normalizerVersion: "1.0.0",
      },
    });
    expect(result.enteredValue).toBe("70.5");
    expect(result.enteredUnit).toBe("KG");
  });

  it("rejects an invalid entered unit", () => {
    expect(() =>
      weightSchema.parse({
        enteredValue: "70.5",
        enteredUnit: "G",
        normalization: null,
      }),
    ).toThrow();
  });

  it("rejects an invalid canonical unit", () => {
    expect(() =>
      weightSchema.parse({
        enteredValue: "70.5",
        enteredUnit: "KG",
        normalization: {
          canonicalValue: "70.5",
          canonicalUnit: "LB",
          normalizerVersion: "1.0.0",
        },
      }),
    ).toThrow();
  });

  it("rejects scientific notation in enteredValue", () => {
    expect(() =>
      weightSchema.parse({
        enteredValue: "1e5",
        enteredUnit: "KG",
        normalization: null,
        }),
    ).toThrow();
  });

  it("rejects scientific notation in canonicalValue", () => {
    expect(() =>
      weightSchema.parse({
        enteredValue: "70.5",
        enteredUnit: "KG",
        normalization: {
          canonicalValue: "1e2",
          canonicalUnit: "KG",
          normalizerVersion: "1.0.0",
        },
      }),
    ).toThrow();
  });

  it("rejects unknown keys", () => {
    expect(() =>
      weightSchema.parse({
        enteredValue: "70.5",
        enteredUnit: "KG",
        normalization: null,
        extra: true,
      }),
    ).toThrow();
  });

  it("rejects a missing normalization field", () => {
    expect(() =>
      weightSchema.parse({
        enteredValue: "70.5",
        enteredUnit: "KG",
      }),
    ).toThrow();
  });
});