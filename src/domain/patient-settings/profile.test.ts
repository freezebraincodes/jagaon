import { describe, it, expect } from "vitest";
import {
  patientProfilePayloadSchema,
  type PatientProfilePayload,
} from "./profile";

describe("patientProfilePayloadSchema", () => {
  it("accepts a minimal profile with only ageEligibility", () => {
    const result = patientProfilePayloadSchema.parse({
      ageEligibility: "ADULT_18_PLUS",
    });
    expect(result.ageEligibility).toBe("ADULT_18_PLUS");
    expect(result.preferredName).toBeUndefined();
  });

  it("accepts UNKNOWN ageEligibility", () => {
    const result = patientProfilePayloadSchema.parse({
      ageEligibility: "UNKNOWN",
    });
    expect(result.ageEligibility).toBe("UNKNOWN");
  });

  it("accepts a profile with a valid preferredName", () => {
    const result = patientProfilePayloadSchema.parse({
      preferredName: "Alice",
      ageEligibility: "ADULT_18_PLUS",
    });
    expect(result.preferredName).toBe("Alice");
  });

  it("accepts Chinese preferredName", () => {
    const result = patientProfilePayloadSchema.parse({
      preferredName: "李明",
      ageEligibility: "ADULT_18_PLUS",
    });
    expect(result.preferredName).toBe("李明");
  });

  it("accepts a 100-code-point preferredName", () => {
    const name = "a".repeat(100);
    const result = patientProfilePayloadSchema.parse({
      preferredName: name,
      ageEligibility: "ADULT_18_PLUS",
    });
    expect(result.preferredName).toBe(name);
  });

  it("rejects a preferredName exceeding 100 code points", () => {
    expect(() =>
      patientProfilePayloadSchema.parse({
        preferredName: "a".repeat(101),
        ageEligibility: "ADULT_18_PLUS",
      }),
    ).toThrow();
  });

  it("rejects an empty preferredName", () => {
    expect(() =>
      patientProfilePayloadSchema.parse({
        preferredName: "",
        ageEligibility: "ADULT_18_PLUS",
      }),
    ).toThrow();
  });

  it("rejects preferredName with leading whitespace", () => {
    expect(() =>
      patientProfilePayloadSchema.parse({
        preferredName: " Alice",
        ageEligibility: "ADULT_18_PLUS",
      }),
    ).toThrow();
  });

  it("rejects preferredName with trailing whitespace", () => {
    expect(() =>
      patientProfilePayloadSchema.parse({
        preferredName: "Alice ",
        ageEligibility: "ADULT_18_PLUS",
      }),
    ).toThrow();
  });

  it("rejects a whitespace-only preferredName", () => {
    expect(() =>
      patientProfilePayloadSchema.parse({
        preferredName: "   ",
        ageEligibility: "ADULT_18_PLUS",
      }),
    ).toThrow();
  });

  it("rejects a missing ageEligibility", () => {
    expect(() =>
      patientProfilePayloadSchema.parse({
        preferredName: "Alice",
      }),
    ).toThrow();
  });

  it("rejects an invalid ageEligibility", () => {
    expect(() =>
      patientProfilePayloadSchema.parse({
        ageEligibility: "MINOR",
      }),
    ).toThrow();
  });

  it("rejects unknown keys", () => {
    expect(() =>
      patientProfilePayloadSchema.parse({
        ageEligibility: "ADULT_18_PLUS",
        extra: true,
      }),
    ).toThrow();
  });

  it("counts code points not UTF-16 code units for preferredName", () => {
    // 50 emoji = 50 code points but 100 UTF-16 code units — within 100 limit
    const emoji50 = "😀".repeat(50);
    const result = patientProfilePayloadSchema.parse({
      preferredName: emoji50,
      ageEligibility: "ADULT_18_PLUS",
    });
    expect(result.preferredName).toBe(emoji50);
    // 101 emoji = 101 code points — exceeds 100
    const emoji101 = "😀".repeat(101);
    expect(() =>
      patientProfilePayloadSchema.parse({
        preferredName: emoji101,
        ageEligibility: "ADULT_18_PLUS",
      }),
    ).toThrow();
  });
});