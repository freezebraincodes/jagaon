import { describe, it, expect } from "vitest";
import {
  prescriptionVersionPayloadSchema,
  prescriptionEffectivePeriodSchema,
  prescriptionDoseInstructionSchema,
  PRESCRIPTION_VERSION_REVISION_ACTIONS,
  PRESCRIPTION_VERSION_DELETION_POLICY,
} from "./prescription-version";
import { DeletionPolicy } from "../shared/record-catalogue";

const UUID = "a47ac10b-58cc-4372-a567-0e02b2c3d479";

const MEDICATION_REF = {
  recordType: "MEDICATION" as const,
  recordId: UUID,
  revisionId: UUID,
};

const EXACT_START = {
  kind: "EXACT" as const,
  instantUtc: "2026-01-01T00:00:00Z",
  timeZoneId: "Asia/Singapore",
  utcOffsetMinutes: 480,
};

const EXACT_LATER_END = {
  kind: "KNOWN" as const,
  point: {
    kind: "EXACT" as const,
    instantUtc: "2026-06-01T00:00:00Z",
    timeZoneId: "Asia/Singapore",
    utcOffsetMinutes: 480,
  },
};

function mkBase() {
  return {
    medication: MEDICATION_REF,
    sourceInstructionText: {
      text: "Take 10 units before breakfast",
      language: "en-SG" as const,
    },
    doseInstruction: {
      kind: "FIXED" as const,
      amount: { value: "10", unit: "UNIT" },
    },
    schedule: {
      kind: "FIXED_LOCAL_TIMES" as const,
      entries: [{ scheduleKey: "morning", time: "08:00" }],
    },
    effectivePeriod: {
      start: EXACT_START,
      end: EXACT_LATER_END,
    },
  };
}

describe("prescriptionDoseInstructionSchema", () => {
  it("accepts FIXED amount", () => {
    const result = prescriptionDoseInstructionSchema.parse({
      kind: "FIXED",
      amount: { value: "10", unit: "UNIT" },
    });
    expect(result.kind).toBe("FIXED");
  });

  it("accepts VARIABLE_PER_REPORTED_PLAN with multiple amounts", () => {
    const result = prescriptionDoseInstructionSchema.parse({
      kind: "VARIABLE_PER_REPORTED_PLAN",
      reportedAmounts: [
        { value: "8", unit: "UNIT" },
        { value: "12", unit: "UNIT" },
      ],
      decisionInstructionText: {
        text: "12 if pre-meal glucose above 10",
        language: "en-SG",
      },
    });
    expect(result.kind).toBe("VARIABLE_PER_REPORTED_PLAN");
  });

  it("rejects an empty reportedAmounts array", () => {
    expect(() =>
      prescriptionDoseInstructionSchema.parse({
        kind: "VARIABLE_PER_REPORTED_PLAN",
        reportedAmounts: [],
        decisionInstructionText: {
          text: "x",
          language: "en-SG",
        },
      }),
    ).toThrow();
  });

  it("keeps FIXED, VARIABLE, and UNSTRUCTURED distinct", () => {
    const fixed = prescriptionDoseInstructionSchema.parse({
      kind: "FIXED",
      amount: { value: "1", unit: "MG" },
    });
    const variable = prescriptionDoseInstructionSchema.parse({
      kind: "VARIABLE_PER_REPORTED_PLAN",
      reportedAmounts: [{ value: "1", unit: "MG" }],
      decisionInstructionText: { text: "x", language: "en-SG" },
    });
    const unstructured = prescriptionDoseInstructionSchema.parse({
      kind: "UNSTRUCTURED",
    });
    expect(new Set([fixed.kind, variable.kind, unstructured.kind]).size).toBe(
      3,
    );
  });
});

describe("prescriptionEffectivePeriodSchema", () => {
  it("accepts a known end after start", () => {
    const result = prescriptionEffectivePeriodSchema.parse({
      start: EXACT_START,
      end: EXACT_LATER_END,
    });
    expect(result.end.kind).toBe("KNOWN");
  });

  it("accepts an OPEN end", () => {
    const result = prescriptionEffectivePeriodSchema.parse({
      start: EXACT_START,
      end: { kind: "OPEN" },
    });
    expect(result.end.kind).toBe("OPEN");
  });

  it("accepts an UNKNOWN end", () => {
    const result = prescriptionEffectivePeriodSchema.parse({
      start: EXACT_START,
      end: { kind: "UNKNOWN" },
    });
    expect(result.end.kind).toBe("UNKNOWN");
  });

  it("rejects a known end equal to start", () => {
    expect(() =>
      prescriptionEffectivePeriodSchema.parse({
        start: EXACT_START,
        end: { kind: "KNOWN", point: EXACT_START },
      }),
    ).toThrow();
  });

  it("rejects a known end before start", () => {
    expect(() =>
      prescriptionEffectivePeriodSchema.parse({
        start: EXACT_LATER_END,
        end: { kind: "KNOWN", point: EXACT_START },
      }),
    ).toThrow();
  });
});

describe("prescriptionVersionPayloadSchema", () => {
  it("accepts a valid prescription version", () => {
    const result = prescriptionVersionPayloadSchema.parse(mkBase());
    expect(result.medication.recordType).toBe("MEDICATION");
  });

  it("preserves source instruction text unchanged", () => {
    const result = prescriptionVersionPayloadSchema.parse(mkBase());
    expect(result.sourceInstructionText.text).toBe(
      "Take 10 units before breakfast",
    );
  });

  it("accepts an UNKNOWN start without substitution", () => {
    const result = prescriptionVersionPayloadSchema.parse({
      ...mkBase(),
      effectivePeriod: {
        start: { kind: "UNKNOWN" },
        end: { kind: "UNKNOWN" },
      },
    });
    expect(result.effectivePeriod.start.kind).toBe("UNKNOWN");
  });

  it("accepts a supersedes reference", () => {
    const result = prescriptionVersionPayloadSchema.parse({
      ...mkBase(),
      supersedes: {
        recordType: "PRESCRIPTION_VERSION",
        recordId: UUID,
        revisionId: UUID,
      },
    });
    expect(result.supersedes!.recordType).toBe("PRESCRIPTION_VERSION");
  });

  it("preserves variable plan reportedAmounts without choosing one", () => {
    const result = prescriptionVersionPayloadSchema.parse({
      ...mkBase(),
      doseInstruction: {
        kind: "VARIABLE_PER_REPORTED_PLAN",
        reportedAmounts: [
          { value: "8", unit: "UNIT" },
          { value: "12", unit: "UNIT" },
        ],
        decisionInstructionText: {
          text: "12 if pre-meal glucose above 10",
          language: "en-SG",
        },
      },
    });
    expect(result.doseInstruction.kind).toBe("VARIABLE_PER_REPORTED_PLAN");
    if (result.doseInstruction.kind === "VARIABLE_PER_REPORTED_PLAN") {
      expect(result.doseInstruction.reportedAmounts).toHaveLength(2);
    }
  });

  it("rejects unknown keys", () => {
    expect(() =>
      prescriptionVersionPayloadSchema.parse({ ...mkBase(), extra: true }),
    ).toThrow();
  });

  it("rejects a wrong recordType on medication ref", () => {
    expect(() =>
      prescriptionVersionPayloadSchema.parse({
        ...mkBase(),
        medication: {
          recordType: "GLUCOSE_READING",
          recordId: UUID,
          revisionId: UUID,
        },
      }),
    ).toThrow();
  });
});

describe("PRESCRIPTION_VERSION shared boundaries", () => {
  it("is PATIENT_DELETABLE", () => {
    expect(PRESCRIPTION_VERSION_DELETION_POLICY).toBe(
      DeletionPolicy.PATIENT_DELETABLE,
    );
  });

  it("has exactly CREATE, CORRECT, CONFIRM", () => {
    expect(PRESCRIPTION_VERSION_REVISION_ACTIONS).toEqual([
      "CREATE",
      "CORRECT",
      "CONFIRM",
    ]);
  });

  it("does not include SYSTEM_DERIVE", () => {
    expect(PRESCRIPTION_VERSION_REVISION_ACTIONS).not.toContain(
      "SYSTEM_DERIVE",
    );
  });
});