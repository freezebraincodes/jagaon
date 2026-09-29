import { describe, it, expect } from "vitest";
import {
  conditionPayloadSchema,
  CONDITION_KNOWLEDGE_CLASS,
  conditionKnowledgeClassSchema,
  type ConditionPayload,
} from "./condition";

describe("CONDITION_KNOWLEDGE_CLASS", () => {
  it("is exactly PATIENT_STATED", () => {
    expect(CONDITION_KNOWLEDGE_CLASS).toBe("PATIENT_STATED");
  });
});

describe("conditionKnowledgeClassSchema", () => {
  it("accepts PATIENT_STATED", () => {
    expect(conditionKnowledgeClassSchema.parse("PATIENT_STATED")).toBe("PATIENT_STATED");
  });

  it("rejects PRESCRIBED", () => {
    expect(() => conditionKnowledgeClassSchema.parse("PRESCRIBED")).toThrow();
  });

  it("rejects OBSERVED", () => {
    expect(() => conditionKnowledgeClassSchema.parse("OBSERVED")).toThrow();
  });

  it("rejects INFERRED", () => {
    expect(() => conditionKnowledgeClassSchema.parse("INFERRED")).toThrow();
  });

  it("rejects a clinician-entered alternative", () => {
    expect(() => conditionKnowledgeClassSchema.parse("CLINICIAN_ENTERED")).toThrow();
  });

  it("rejects a clinician-verified alternative", () => {
    expect(() => conditionKnowledgeClassSchema.parse("CLINICIAN_VERIFIED")).toThrow();
  });

  it("rejects a diagnosed-by-JagaOn alternative", () => {
    expect(() => conditionKnowledgeClassSchema.parse("DIAGNOSED_BY_JAGAON")).toThrow();
  });
});

describe("conditionPayloadSchema", () => {
  it("accepts an ACTIVE TYPE_1_DIABETES without diagnosis date", () => {
    const result = conditionPayloadSchema.parse({
      conditionCode: "TYPE_1_DIABETES",
      status: "ACTIVE",
    });
    expect(result.conditionCode).toBe("TYPE_1_DIABETES");
    expect(result.status).toBe("ACTIVE");
    expect(result.patientReportedDiagnosisDate).toBeUndefined();
  });

  it("accepts HISTORICAL", () => {
    const result = conditionPayloadSchema.parse({
      conditionCode: "TYPE_1_DIABETES",
      status: "HISTORICAL",
    });
    expect(result.status).toBe("HISTORICAL");
  });

  it("accepts UNSURE", () => {
    const result = conditionPayloadSchema.parse({
      conditionCode: "TYPE_1_DIABETES",
      status: "UNSURE",
    });
    expect(result.status).toBe("UNSURE");
  });

  it("accepts a patient-reported diagnosis date", () => {
    const result = conditionPayloadSchema.parse({
      conditionCode: "TYPE_1_DIABETES",
      status: "ACTIVE",
      patientReportedDiagnosisDate: {
        kind: "DATE_ONLY",
        localDate: "2020-01-15",
      },
    });
    expect(result.patientReportedDiagnosisDate).toEqual({
      kind: "DATE_ONLY",
      localDate: "2020-01-15",
    });
  });

  it("rejects an invalid conditionCode", () => {
    expect(() =>
      conditionPayloadSchema.parse({
        conditionCode: "TYPE_2_DIABETES",
        status: "ACTIVE",
      }),
    ).toThrow();
  });

  it("rejects an invalid status", () => {
    expect(() =>
      conditionPayloadSchema.parse({
        conditionCode: "TYPE_1_DIABETES",
        status: "RESOLVED",
      }),
    ).toThrow();
  });

  it("rejects a missing conditionCode", () => {
    expect(() =>
      conditionPayloadSchema.parse({
        status: "ACTIVE",
      }),
    ).toThrow();
  });

  it("rejects a missing status", () => {
    expect(() =>
      conditionPayloadSchema.parse({
        conditionCode: "TYPE_1_DIABETES",
      }),
    ).toThrow();
  });

  it("rejects unknown keys", () => {
    expect(() =>
      conditionPayloadSchema.parse({
        conditionCode: "TYPE_1_DIABETES",
        status: "ACTIVE",
        extra: true,
      }),
    ).toThrow();
  });

  it("rejects an invalid diagnosis date kind", () => {
    expect(() =>
      conditionPayloadSchema.parse({
        conditionCode: "TYPE_1_DIABETES",
        status: "ACTIVE",
        patientReportedDiagnosisDate: {
          kind: "EXACT",
          instantUtc: "2020-01-15T00:00:00Z",
        },
      }),
    ).toThrow();
  });
});