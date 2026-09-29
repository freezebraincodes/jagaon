import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  glucoseReadingPayloadSchema,
  glucoseMeasurementContextSchema,
  glucoseMeasurementMethodSchema,
  DEFAULT_GLUCOSE_ENTRY_UNIT,
  GLUCOSE_READING_DELETION_POLICY,
  GLUCOSE_READING_REVISION_ACTIONS,
  type GlucoseReadingPayload,
} from "./glucose-reading";

const UUID = "a47ac10b-58cc-4372-a567-0e02b2c3d479";

function mkMeasurement(overrides?: Record<string, unknown>) {
  return {
    enteredValue: "7.2",
    enteredUnit: "MMOL_L",
    normalization: {
      canonicalValue: "7.2",
      canonicalUnit: "MMOL_L",
      normalizerVersion: "1.0.0",
    },
    ...overrides,
  };
}

describe("DEFAULT_GLUCOSE_ENTRY_UNIT", () => {
  it("is exactly MMOL_L", () => {
    expect(DEFAULT_GLUCOSE_ENTRY_UNIT).toBe("MMOL_L");
  });
});

describe("GLUCOSE_READING_DELETION_POLICY", () => {
  it("is PATIENT_DELETABLE", () => {
    expect(GLUCOSE_READING_DELETION_POLICY).toBe("PATIENT_DELETABLE");
  });
});

describe("GLUCOSE_READING_REVISION_ACTIONS", () => {
  it("contains exactly CREATE, CORRECT, CONFIRM, SYSTEM_DERIVE", () => {
    expect(GLUCOSE_READING_REVISION_ACTIONS).toEqual([
      "CREATE",
      "CORRECT",
      "CONFIRM",
      "SYSTEM_DERIVE",
    ]);
  });
});

describe("glucoseMeasurementMethodSchema", () => {
  const methods = [
    "FINGERSTICK_METER",
    "CGM",
    "FLASH_SENSOR",
    "LAB",
    "OTHER",
    "UNKNOWN",
  ];
  for (const method of methods) {
    it(`accepts ${method}`, () => {
      expect(glucoseMeasurementMethodSchema.parse(method)).toBe(method);
    });
  }

  it("rejects an unknown method", () => {
    expect(() => glucoseMeasurementMethodSchema.parse(" cgM")).toThrow();
  });

  it("rejects a method not in the enum", () => {
    expect(() => glucoseMeasurementMethodSchema.parse("DEXCOM")).toThrow();
  });
});

describe("glucoseMeasurementContextSchema", () => {
  it("accepts UNSPECIFIED", () => {
    const result = glucoseMeasurementContextSchema.parse({
      kind: "UNSPECIFIED",
    });
    expect(result.kind).toBe("UNSPECIFIED");
  });

  const slots = [
    "FASTING",
    "BEFORE_BREAKFAST",
    "AFTER_BREAKFAST",
    "BEFORE_LUNCH",
    "AFTER_LUNCH",
    "BEFORE_DINNER",
    "AFTER_DINNER",
    "BEDTIME",
    "OVERNIGHT",
    "OTHER",
  ];
  for (const slot of slots) {
    it(`accepts PATIENT_SELECTED_SLOT with ${slot}`, () => {
      const result = glucoseMeasurementContextSchema.parse({
        kind: "PATIENT_SELECTED_SLOT",
        slot,
      });
      expect(result.kind).toBe("PATIENT_SELECTED_SLOT");
    });
  }

  it("accepts PRESCRIBED_SLOT with non-empty slotKey and PRESCRIPTION_VERSION ref", () => {
    const result = glucoseMeasurementContextSchema.parse({
      kind: "PRESCRIBED_SLOT",
      slotKey: "morning-fasting",
      prescriptionVersion: {
        recordType: "PRESCRIPTION_VERSION",
        recordId: UUID,
        revisionId: UUID,
      },
    });
    expect(result.kind).toBe("PRESCRIBED_SLOT");
  });

  it("rejects PRESCRIBED_SLOT with empty slotKey", () => {
    expect(() =>
      glucoseMeasurementContextSchema.parse({
        kind: "PRESCRIBED_SLOT",
        slotKey: "",
        prescriptionVersion: {
          recordType: "PRESCRIPTION_VERSION",
          recordId: UUID,
          revisionId: UUID,
        },
      }),
    ).toThrow();
  });

  it("rejects PRESCRIBED_SLOT with wrong record type in prescriptionVersion", () => {
    expect(() =>
      glucoseMeasurementContextSchema.parse({
        kind: "PRESCRIBED_SLOT",
        slotKey: "morning",
        prescriptionVersion: {
          recordType: "SAFETY_EVENT",
          recordId: UUID,
          revisionId: UUID,
        },
      }),
    ).toThrow();
  });

  it("rejects PRESCRIBED_SLOT with bare recordId (no typed ref)", () => {
    expect(() =>
      glucoseMeasurementContextSchema.parse({
        kind: "PRESCRIBED_SLOT",
        slotKey: "morning",
        prescriptionVersion: UUID,
      }),
    ).toThrow();
  });

  it("accepts EVENT_RELATIVE with BEFORE and INTAKE_EVENT ref", () => {
    const result = glucoseMeasurementContextSchema.parse({
      kind: "EVENT_RELATIVE",
      relation: "BEFORE",
      relatedEvent: {
        recordType: "INTAKE_EVENT",
        recordId: UUID,
        revisionId: UUID,
      },
      assignment: "PATIENT_CONFIRMED",
    });
    expect(result.kind).toBe("EVENT_RELATIVE");
  });

  it("accepts EVENT_RELATIVE with AFTER and MEDICATION_EVENT ref", () => {
    const result = glucoseMeasurementContextSchema.parse({
      kind: "EVENT_RELATIVE",
      relation: "AFTER",
      relatedEvent: {
        recordType: "MEDICATION_EVENT",
        recordId: UUID,
        revisionId: UUID,
      },
      assignment: "PATIENT_CONFIRMED",
    });
    expect(result.kind).toBe("EVENT_RELATIVE");
  });

  it("rejects EVENT_RELATIVE with unsupported record type in relatedEvent", () => {
    expect(() =>
      glucoseMeasurementContextSchema.parse({
        kind: "EVENT_RELATIVE",
        relation: "AFTER",
        relatedEvent: {
          recordType: "GLUCOSE_READING",
          recordId: UUID,
          revisionId: UUID,
        },
        assignment: "PATIENT_CONFIRMED",
      }),
    ).toThrow();
  });

  it("rejects EVENT_RELATIVE with bare recordId (no typed ref)", () => {
    expect(() =>
      glucoseMeasurementContextSchema.parse({
        kind: "EVENT_RELATIVE",
        relation: "AFTER",
        relatedEvent: UUID,
        assignment: "PATIENT_CONFIRMED",
      }),
    ).toThrow();
  });

  it("rejects EVENT_RELATIVE with assignment other than PATIENT_CONFIRMED", () => {
    expect(() =>
      glucoseMeasurementContextSchema.parse({
        kind: "EVENT_RELATIVE",
        relation: "AFTER",
        relatedEvent: {
          recordType: "INTAKE_EVENT",
          recordId: UUID,
          revisionId: UUID,
        },
        assignment: "SYSTEM_INFERRED",
      }),
    ).toThrow();
  });

  it("rejects an inferred context kind", () => {
    expect(() =>
      glucoseMeasurementContextSchema.parse({
        kind: "INFERRED_SLOT",
      }),
    ).toThrow();
  });

  it("rejects unknown keys on UNSPECIFIED", () => {
    expect(() =>
      glucoseMeasurementContextSchema.parse({
        kind: "UNSPECIFIED",
        extra: true,
      }),
    ).toThrow();
  });
});

describe("glucoseReadingPayloadSchema", () => {
  it("accepts a minimal valid reading with UNSPECIFIED context", () => {
    const result = glucoseReadingPayloadSchema.parse({
      measurement: mkMeasurement(),
      measurementMethod: "FINGERSTICK_METER",
      context: { kind: "UNSPECIFIED" },
    });
    expect(result.measurementMethod).toBe("FINGERSTICK_METER");
  });

  it("preserves the entered unit when MG_DL", () => {
    const result = glucoseReadingPayloadSchema.parse({
      measurement: mkMeasurement({
        enteredValue: "130",
        enteredUnit: "MG_DL",
        normalization: {
          canonicalValue: "7.2",
          canonicalUnit: "MMOL_L",
          normalizerVersion: "1.0.0",
        },
      }),
      measurementMethod: "FINGERSTICK_METER",
      context: { kind: "UNSPECIFIED" },
    });
    expect(result.measurement.enteredUnit).toBe("MG_DL");
    expect(result.measurement.enteredValue).toBe("130");
  });

  it("accepts null normalisation", () => {
    const result = glucoseReadingPayloadSchema.parse({
      measurement: mkMeasurement({ normalization: null }),
      measurementMethod: "CGM",
      context: { kind: "UNSPECIFIED" },
    });
    expect(result.measurement.normalization).toBeNull();
  });

  it("accepts an optional recheckFor referencing SAFETY_EVENT", () => {
    const result = glucoseReadingPayloadSchema.parse({
      measurement: mkMeasurement(),
      measurementMethod: "FINGERSTICK_METER",
      context: { kind: "UNSPECIFIED" },
      recheckFor: {
        recordType: "SAFETY_EVENT",
        recordId: UUID,
        revisionId: UUID,
      },
    });
    expect(result.recheckFor!.recordType).toBe("SAFETY_EVENT");
  });

  it("rejects recheckFor referencing a non-SAFETY_EVENT record type", () => {
    expect(() =>
      glucoseReadingPayloadSchema.parse({
        measurement: mkMeasurement(),
        measurementMethod: "FINGERSTICK_METER",
        context: { kind: "UNSPECIFIED" },
        recheckFor: {
          recordType: "PRESCRIPTION_VERSION",
          recordId: UUID,
          revisionId: UUID,
        },
      }),
    ).toThrow();
  });

  it("accepts an optional patientNote", () => {
    const result = glucoseReadingPayloadSchema.parse({
      measurement: mkMeasurement(),
      measurementMethod: "FINGERSTICK_METER",
      context: { kind: "UNSPECIFIED" },
      patientNote: { text: "Feeling slightly low", language: "en-SG" },
    });
    expect(result.patientNote!.text).toBe("Feeling slightly low");
  });

  it("rejects a LOW field on the payload", () => {
    expect(() =>
      glucoseReadingPayloadSchema.parse({
        measurement: mkMeasurement(),
        measurementMethod: "FINGERSTICK_METER",
        context: { kind: "UNSPECIFIED" },
        LOW: true,
      }),
    ).toThrow();
  });

  it("rejects a HIGH field on the payload", () => {
    expect(() =>
      glucoseReadingPayloadSchema.parse({
        measurement: mkMeasurement(),
        measurementMethod: "FINGERSTICK_METER",
        context: { kind: "UNSPECIFIED" },
        HIGH: true,
      }),
    ).toThrow();
  });

  it("rejects a NORMAL field on the payload", () => {
    expect(() =>
      glucoseReadingPayloadSchema.parse({
        measurement: mkMeasurement(),
        measurementMethod: "FINGERSTICK_METER",
        context: { kind: "UNSPECIFIED" },
        NORMAL: true,
      }),
    ).toThrow();
  });

  it("rejects a targetStatus field on the payload", () => {
    expect(() =>
      glucoseReadingPayloadSchema.parse({
        measurement: mkMeasurement(),
        measurementMethod: "FINGERSTICK_METER",
        context: { kind: "UNSPECIFIED" },
        targetStatus: "IN_RANGE",
      }),
    ).toThrow();
  });

  it("rejects a safetyStatus field on the payload", () => {
    expect(() =>
      glucoseReadingPayloadSchema.parse({
        measurement: mkMeasurement(),
        measurementMethod: "FINGERSTICK_METER",
        context: { kind: "UNSPECIFIED" },
        safetyStatus: "SAFE",
      }),
    ).toThrow();
  });

  it("rejects a treatmentImplication field on the payload", () => {
    expect(() =>
      glucoseReadingPayloadSchema.parse({
        measurement: mkMeasurement(),
        measurementMethod: "FINGERSTICK_METER",
        context: { kind: "UNSPECIFIED" },
        treatmentImplication: "INSULIN",
      }),
    ).toThrow();
  });

  it("rejects an invalid measurementMethod", () => {
    expect(() =>
      glucoseReadingPayloadSchema.parse({
        measurement: mkMeasurement(),
        measurementMethod: "ORAL",
        context: { kind: "UNSPECIFIED" },
      }),
    ).toThrow();
  });

  it("rejects a missing measurement", () => {
    expect(() =>
      glucoseReadingPayloadSchema.parse({
        measurementMethod: "FINGERSTICK_METER",
        context: { kind: "UNSPECIFIED" },
      }),
    ).toThrow();
  });

  it("rejects a missing context", () => {
    expect(() =>
      glucoseReadingPayloadSchema.parse({
        measurement: mkMeasurement(),
        measurementMethod: "FINGERSTICK_METER",
      }),
    ).toThrow();
  });

  it("rejects unknown keys", () => {
    expect(() =>
      glucoseReadingPayloadSchema.parse({
        measurement: mkMeasurement(),
        measurementMethod: "FINGERSTICK_METER",
        context: { kind: "UNSPECIFIED" },
        extra: true,
      }),
    ).toThrow();
  });
});