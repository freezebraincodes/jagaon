import { describe, expect, it } from "vitest";

import { decimalStringSchema } from "@/domain/health-records/measurement";
import { compareDecimalStrings } from "./decimal-comparison";

function decimal(value: string) {
  return decimalStringSchema.parse(value);
}

describe("compareDecimalStrings", () => {
  it.each([
    ["3", "4", -1],
    ["4", "4", 0],
    ["4.0", "4", 0],
    ["04.000", "4", 0],
    ["3.999999999999999999", "4", -1],
    ["4.000000000000000001", "4", 1],
    ["10", "9.999", 1],
    ["0.001", "0.01", -1],
    ["-1", "0", -1],
    ["-2", "-10", 1],
    ["-0.00", "0", 0],
    ["100000000000000000000", "99999999999999999999", 1],
  ] as const)("compares %s with %s", (left, right, expected) => {
    expect(compareDecimalStrings(decimal(left), decimal(right))).toBe(expected);
    expect(compareDecimalStrings(decimal(right), decimal(left))).toBe(
      expected === 0 ? 0 : -expected,
    );
  });

  it("rejects runtime strings outside DecimalString", () => {
    expect(() =>
      compareDecimalStrings("4e0" as ReturnType<typeof decimal>, decimal("4")),
    ).toThrow();
    expect(() =>
      compareDecimalStrings(decimal("4"), " 4" as ReturnType<typeof decimal>),
    ).toThrow();
  });
});
