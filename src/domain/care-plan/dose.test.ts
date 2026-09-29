import { describe, it, expect } from "vitest";
import {
  doseAmountSchema,
  prescriptionInstructionTextSchema,
} from "./dose";

describe("doseAmountSchema", () => {
  it("accepts a standard unit with a decimal string", () => {
    const result = doseAmountSchema.parse({
      value: "10",
      unit: "UNIT",
    });
    expect(result.unit).toBe("UNIT");
  });

  it("preserves exact decimal string without conversion", () => {
    const result = doseAmountSchema.parse({
      value: "0.05",
      unit: "ML",
    });
    expect(result.value).toBe("0.05");
  });

  it("preserves leading zeros in decimal string", () => {
    const result = doseAmountSchema.parse({
      value: "007",
      unit: "MG",
    });
    expect(result.value).toBe("007");
  });

  it("accepts OTHER unit with otherUnitText", () => {
    const result = doseAmountSchema.parse({
      value: "2",
      unit: "OTHER",
      otherUnitText: "puffs of my inhaler",
    });
    expect(result.unit).toBe("OTHER");
    if (result.unit === "OTHER") {
      expect(result.otherUnitText).toBe("puffs of my inhaler");
    }
  });

  it("keeps standard and OTHER units distinct", () => {
    const std = doseAmountSchema.parse({ value: "1", unit: "MG" });
    const other = doseAmountSchema.parse({
      value: "1",
      unit: "OTHER",
      otherUnitText: "scoop",
    });
    expect(std.unit).not.toBe(other.unit);
  });

  it("rejects scientific notation in value", () => {
    expect(() =>
      doseAmountSchema.parse({ value: "1e3", unit: "MG" }),
    ).toThrow();
  });

  it("rejects unknown keys on standard amount", () => {
    expect(() =>
      doseAmountSchema.parse({ value: "1", unit: "MG", extra: true }),
    ).toThrow();
  });

  it("rejects unknown keys on OTHER amount", () => {
    expect(() =>
      doseAmountSchema.parse({
        value: "1",
        unit: "OTHER",
        otherUnitText: "thing",
        extra: true,
      }),
    ).toThrow();
  });
});

describe("prescriptionInstructionTextSchema", () => {
  it("accepts en-SG text", () => {
    const result = prescriptionInstructionTextSchema.parse({
      text: "Take 10 units before breakfast",
      language: "en-SG",
    });
    expect(result.text).toBe("Take 10 units before breakfast");
  });

  it("accepts zh-SG text", () => {
    const result = prescriptionInstructionTextSchema.parse({
      text: "早餐前注射10单位",
      language: "zh-SG",
    });
    expect(result.language).toBe("zh-SG");
  });

  it("rejects unknown language", () => {
    expect(() =>
      prescriptionInstructionTextSchema.parse({
        text: "x",
        language: "en-US",
      }),
    ).toThrow();
  });

  it("rejects unknown keys", () => {
    expect(() =>
      prescriptionInstructionTextSchema.parse({
        text: "x",
        language: "en-SG",
        extra: true,
      }),
    ).toThrow();
  });
});