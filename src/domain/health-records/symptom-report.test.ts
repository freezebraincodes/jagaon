import { describe, it, expect } from "vitest";
import {
  symptomReportPayloadSchema,
  symptomCodeSchema,
  SYMPTOM_REPORT_REVISION_ACTIONS,
} from "./symptom-report";

const UUID = "a47ac10b-58cc-4372-a567-0e02b2c3d479";

describe("symptomCodeSchema", () => {
  it("accepts all reviewed codes", () => {
    const codes = [
      "COLD_OR_CHILLY",
      "SHAKY",
      "SWEATY",
      "DIZZY",
      "WEAK",
      "SUDDEN_HUNGER",
      "CONFUSION",
      "SEVERE_DROWSINESS",
      "LOSS_OF_CONSCIOUSNESS",
      "SEIZURE",
      "UNABLE_TO_SWALLOW_OR_SELF_TREAT",
      "BREATHING_DIFFICULTY",
      "NAUSEA",
      "VOMITING",
      "ABDOMINAL_PAIN",
      "FRUITY_SMELLING_BREATH",
      "GENERALLY_UNWELL",
      "OTHER",
    ];
    for (const code of codes) {
      expect(symptomCodeSchema.parse(code)).toBe(code);
    }
  });

  it("rejects an unknown code", () => {
    expect(() => symptomCodeSchema.parse("HYPO")).toThrow();
  });
});

describe("symptomReportPayloadSchema — PRESENT", () => {
  function mkPresent() {
    return {
      reportKind: "PRESENT",
      symptoms: [
        { code: "SHAKY", severity: "MODERATE" },
      ],
    };
  }

  it("accepts a present symptom report without optional fields", () => {
    const result = symptomReportPayloadSchema.parse(mkPresent());
    expect(result.reportKind).toBe("PRESENT");
  });

  it("accepts multiple symptoms", () => {
    const result = symptomReportPayloadSchema.parse({
      reportKind: "PRESENT",
      symptoms: [
        { code: "SHAKY", severity: "MODERATE" },
        { code: "SWEATY", severity: "MILD" },
      ],
    });
    expect(result.reportKind).toBe("PRESENT");
  });

  it("rejects an empty symptoms array", () => {
    expect(() =>
      symptomReportPayloadSchema.parse({
        reportKind: "PRESENT",
        symptoms: [],
      }),
    ).toThrow();
  });

  it("requires patientLabel when code is OTHER", () => {
    expect(() =>
      symptomReportPayloadSchema.parse({
        reportKind: "PRESENT",
        symptoms: [{ code: "OTHER", severity: "MODERATE" }],
      }),
    ).toThrow();
  });

  it("accepts patientLabel when code is OTHER", () => {
    const result = symptomReportPayloadSchema.parse({
      reportKind: "PRESENT",
      symptoms: [
        { code: "OTHER", severity: "MODERATE", patientLabel: "Jittery legs" },
      ],
    });
    expect(result.reportKind).toBe("PRESENT");
  });

  it("rejects a whitespace-only patientLabel when code is OTHER", () => {
    expect(() =>
      symptomReportPayloadSchema.parse({
        reportKind: "PRESENT",
        symptoms: [
          { code: "OTHER", severity: "MODERATE", patientLabel: "   " },
        ],
      }),
    ).toThrow();
  });

  it("accepts an emergency symptom without optional fields", () => {
    const result = symptomReportPayloadSchema.parse({
      reportKind: "PRESENT",
      symptoms: [
        { code: "SEIZURE", severity: "SEVERE" },
      ],
    });
    expect(result.reportKind).toBe("PRESENT");
  });

  it("accepts optional capabilities", () => {
    const result = symptomReportPayloadSchema.parse({
      reportKind: "PRESENT",
      symptoms: [{ code: "SHAKY", severity: "MODERATE" }],
      capabilities: {
        canCheckGlucoseNow: "YES",
        canSwallow: "YES",
        canActIndependently: "YES",
      },
    });
    expect(result.reportKind).toBe("PRESENT");
  });

  it("accepts optional relatedSafetyEvent", () => {
    const result = symptomReportPayloadSchema.parse({
      reportKind: "PRESENT",
      symptoms: [{ code: "SHAKY", severity: "MODERATE" }],
      relatedSafetyEvent: {
        recordType: "SAFETY_EVENT",
        recordId: UUID,
        revisionId: UUID,
      },
    });
    expect(result.reportKind).toBe("PRESENT");
  });

  it("rejects unknown keys on PRESENT payload", () => {
    expect(() =>
      symptomReportPayloadSchema.parse({ ...mkPresent(), extra: true }),
    ).toThrow();
  });

  it("rejects unknown keys on a symptom entry", () => {
    expect(() =>
      symptomReportPayloadSchema.parse({
        reportKind: "PRESENT",
        symptoms: [{ code: "SHAKY", severity: "MODERATE", extra: true }],
      }),
    ).toThrow();
  });

  it("rejects an invalid severity", () => {
    expect(() =>
      symptomReportPayloadSchema.parse({
        reportKind: "PRESENT",
        symptoms: [{ code: "SHAKY", severity: "EXTREME" }],
      }),
    ).toThrow();
  });
});

describe("symptomReportPayloadSchema — EXPLICIT_NONE", () => {
  it("accepts EXPLICIT_NONE without optional fields", () => {
    const result = symptomReportPayloadSchema.parse({
      reportKind: "EXPLICIT_NONE",
    });
    expect(result.reportKind).toBe("EXPLICIT_NONE");
  });

  it("accepts EXPLICIT_NONE with optional patientNote", () => {
    const result = symptomReportPayloadSchema.parse({
      reportKind: "EXPLICIT_NONE",
      patientNote: { text: "Feeling fine", language: "en-SG" },
    });
    expect(result.reportKind).toBe("EXPLICIT_NONE");
  });

  it("rejects unknown keys on EXPLICIT_NONE", () => {
    expect(() =>
      symptomReportPayloadSchema.parse({
        reportKind: "EXPLICIT_NONE",
        extra: true,
      }),
    ).toThrow();
  });

  it("keeps EXPLICIT_NONE distinct from no record", () => {
    // EXPLICIT_NONE is a valid reportKind; absence of any record is a different
    // state that cannot be represented by a payload. The test proves
    // EXPLICIT_NONE exists as an explicit kind, not as a missing or null value.
    const result = symptomReportPayloadSchema.parse({
      reportKind: "EXPLICIT_NONE",
    });
    expect(result.reportKind).toBe("EXPLICIT_NONE");
  });
});

describe("symptomReportPayloadSchema — UNSURE", () => {
  it("accepts UNSURE without optional fields", () => {
    const result = symptomReportPayloadSchema.parse({
      reportKind: "UNSURE",
    });
    expect(result.reportKind).toBe("UNSURE");
  });

  it("rejects unknown keys on UNSURE", () => {
    expect(() =>
      symptomReportPayloadSchema.parse({
        reportKind: "UNSURE",
        extra: true,
      }),
    ).toThrow();
  });
});

describe("SYMPTOM_REPORT_REVISION_ACTIONS", () => {
  it("has exactly CREATE, CORRECT, CONFIRM", () => {
    expect(SYMPTOM_REPORT_REVISION_ACTIONS).toEqual([
      "CREATE",
      "CORRECT",
      "CONFIRM",
    ]);
  });

  it("does not include SYSTEM_DERIVE", () => {
    expect(SYMPTOM_REPORT_REVISION_ACTIONS).not.toContain("SYSTEM_DERIVE");
  });
});