import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  dataValidityAssessmentOutcomeSchema,
  createDataValidityAssessmentSchema,
  type DataValidityAssessment,
} from "./data-validity-assessment";

describe("dataValidityAssessmentOutcomeSchema", () => {
  it("accepts ROUTABLE_CURRENT", () => {
    expect(dataValidityAssessmentOutcomeSchema.parse("ROUTABLE_CURRENT")).toBe("ROUTABLE_CURRENT");
  });

  it("accepts ROUTABLE_HISTORICAL", () => {
    expect(dataValidityAssessmentOutcomeSchema.parse("ROUTABLE_HISTORICAL")).toBe("ROUTABLE_HISTORICAL");
  });

  it("accepts CONFIRM_REQUIRED", () => {
    expect(dataValidityAssessmentOutcomeSchema.parse("CONFIRM_REQUIRED")).toBe("CONFIRM_REQUIRED");
  });

  it("accepts MEASUREMENT_UNCERTAINTY", () => {
    expect(dataValidityAssessmentOutcomeSchema.parse("MEASUREMENT_UNCERTAINTY")).toBe("MEASUREMENT_UNCERTAINTY");
  });

  it("accepts UNUSABLE", () => {
    expect(dataValidityAssessmentOutcomeSchema.parse("UNUSABLE")).toBe("UNUSABLE");
  });

  it("rejects an unknown outcome", () => {
    expect(() => dataValidityAssessmentOutcomeSchema.parse("VALID")).toThrow();
  });
});

describe("DataValidityAssessment type", () => {
  type TestReasonCode = "CALIBRATION_ERROR" | "OUT_OF_RANGE";

  it("compiles with a string reason code", () => {
    const assessment: DataValidityAssessment<TestReasonCode> = {
      sourceRevisionId: "a47ac10b-58cc-4372-a567-0e02b2c3d479" as never,
      evaluatedAt: "2026-09-27T10:00:00Z" as never,
      ruleVersion: "1.0.0",
      outcome: "ROUTABLE_CURRENT",
      reasonCodes: [],
    };
    expect(assessment.outcome).toBe("ROUTABLE_CURRENT");
  });

  it("accepts an empty reasonCodes array", () => {
    const assessment: DataValidityAssessment<TestReasonCode> = {
      sourceRevisionId: "a47ac10b-58cc-4372-a567-0e02b2c3d479" as never,
      evaluatedAt: "2026-09-27T10:00:00Z" as never,
      ruleVersion: "1.0.0",
      outcome: "UNUSABLE",
      reasonCodes: [],
    };
    expect(assessment.reasonCodes).toHaveLength(0);
  });

  it("rejects a non-string reason code at compile time", () => {
    // @ts-expect-error: TReasonCode extends string, so a number is not allowed.
    type Bad = DataValidityAssessment<42>;
  });
});

describe("createDataValidityAssessmentSchema (runtime)", () => {
  const reasonSchema = z.enum(["CALIBRATION_ERROR", "OUT_OF_RANGE"]);
  const schema = createDataValidityAssessmentSchema(reasonSchema);

  const validBase = {
    sourceRevisionId: "a47ac10b-58cc-4372-a567-0e02b2c3d479",
    evaluatedAt: "2026-09-27T10:00:00Z",
    ruleVersion: "1.0.0",
    outcome: "ROUTABLE_CURRENT",
    reasonCodes: ["CALIBRATION_ERROR", "OUT_OF_RANGE"],
  };

  it("accepts a complete valid assessment", () => {
    const result = schema.parse(validBase);
    expect(result.outcome).toBe("ROUTABLE_CURRENT");
  });

  it("preserves every supplied reason code", () => {
    const result = schema.parse(validBase);
    expect(result.reasonCodes).toEqual(["CALIBRATION_ERROR", "OUT_OF_RANGE"]);
  });

  it("rejects a reason code outside the supplied reason-code schema", () => {
    expect(() =>
      schema.parse({ ...validBase, reasonCodes: ["UNKNOWN_CODE"] }),
    ).toThrow();
  });

  it("rejects a malformed sourceRevisionId", () => {
    expect(() =>
      schema.parse({ ...validBase, sourceRevisionId: "not-a-uuid" }),
    ).toThrow();
  });

  it("rejects a malformed evaluatedAt", () => {
    expect(() =>
      schema.parse({ ...validBase, evaluatedAt: "2026-09-27 10:00" }),
    ).toThrow();
  });

  it("rejects an empty ruleVersion", () => {
    expect(() =>
      schema.parse({ ...validBase, ruleVersion: "" }),
    ).toThrow();
  });

  it("rejects an unknown outcome", () => {
    expect(() =>
      schema.parse({ ...validBase, outcome: "VALID" }),
    ).toThrow();
  });

  it("rejects unknown object keys", () => {
    expect(() =>
      schema.parse({ ...validBase, extra: true }),
    ).toThrow();
  });
});