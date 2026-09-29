import { describe, it, expect } from "vitest";
import {
  ketoneReadingPayloadSchema,
  urineKetoneResultSchema,
  bloodKetoneMeasurementMethodSchema,
  urineKetoneMeasurementMethodSchema,
  KETONE_READING_DELETION_POLICY,
  KETONE_READING_REVISION_ACTIONS,
  type KetoneReadingPayload,
} from "./ketone-reading";

const UUID = "a47ac10b-58cc-4372-a567-0e02b2c3d479";

function mkBloodMeasurement() {
  return {
    enteredValue: "1.2",
    enteredUnit: "MMOL_L",
    normalization: {
      canonicalValue: "1.2",
      canonicalUnit: "MMOL_L",
      normalizerVersion: "1.0.0",
    },
  };
}

describe("KETONE_READING_DELETION_POLICY", () => {
  it("is PATIENT_DELETABLE", () => {
    expect(KETONE_READING_DELETION_POLICY).toBe("PATIENT_DELETABLE");
  });
});

describe("KETONE_READING_REVISION_ACTIONS", () => {
  it("contains exactly CREATE, CORRECT, CONFIRM, SYSTEM_DERIVE", () => {
    expect(KETONE_READING_REVISION_ACTIONS).toEqual([
      "CREATE",
      "CORRECT",
      "CONFIRM",
      "SYSTEM_DERIVE",
    ]);
  });
});

describe("bloodKetoneMeasurementMethodSchema", () => {
  const methods = ["BLOOD_KETONE_METER", "LAB", "OTHER", "UNKNOWN"];
  for (const method of methods) {
    it(`accepts ${method}`, () => {
      expect(bloodKetoneMeasurementMethodSchema.parse(method)).toBe(method);
    });
  }

  it("rejects a urine method", () => {
    expect(() =>
      bloodKetoneMeasurementMethodSchema.parse("URINE_TEST_STRIP"),
    ).toThrow();
  });
});

describe("urineKetoneMeasurementMethodSchema", () => {
  const methods = ["URINE_TEST_STRIP", "LAB", "OTHER", "UNKNOWN"];
  for (const method of methods) {
    it(`accepts ${method}`, () => {
      expect(urineKetoneMeasurementMethodSchema.parse(method)).toBe(method);
    });
  }

  it("rejects a blood method", () => {
    expect(() =>
      urineKetoneMeasurementMethodSchema.parse("BLOOD_KETONE_METER"),
    ).toThrow();
  });
});

describe("ketoneReadingPayloadSchema — BLOOD_QUANTITATIVE", () => {
  it("accepts a valid blood quantitative reading", () => {
    const result = ketoneReadingPayloadSchema.parse({
      kind: "BLOOD_QUANTITATIVE",
      measurement: mkBloodMeasurement(),
      measurementMethod: "BLOOD_KETONE_METER",
    });
    expect(result.kind).toBe("BLOOD_QUANTITATIVE");
  });

  it("preserves entered unit as MMOL_L", () => {
    const result = ketoneReadingPayloadSchema.parse({
      kind: "BLOOD_QUANTITATIVE",
      measurement: mkBloodMeasurement(),
      measurementMethod: "BLOOD_KETONE_METER",
    });
    if (result.kind === "BLOOD_QUANTITATIVE") {
      expect(result.measurement.enteredUnit).toBe("MMOL_L");
    }
  });

  it("accepts null normalisation in blood measurement", () => {
    const result = ketoneReadingPayloadSchema.parse({
      kind: "BLOOD_QUANTITATIVE",
      measurement: { ...mkBloodMeasurement(), normalization: null },
      measurementMethod: "BLOOD_KETONE_METER",
    });
    if (result.kind === "BLOOD_QUANTITATIVE") {
      expect(result.measurement.normalization).toBeNull();
    }
  });

  it("accepts an optional recheckFor referencing SAFETY_EVENT", () => {
    const result = ketoneReadingPayloadSchema.parse({
      kind: "BLOOD_QUANTITATIVE",
      measurement: mkBloodMeasurement(),
      measurementMethod: "BLOOD_KETONE_METER",
      recheckFor: {
        recordType: "SAFETY_EVENT",
        recordId: UUID,
        revisionId: UUID,
      },
    });
    expect(result.recheckFor!.recordType).toBe("SAFETY_EVENT");
  });

  it("rejects recheckFor with a non-SAFETY_EVENT type", () => {
    expect(() =>
      ketoneReadingPayloadSchema.parse({
        kind: "BLOOD_QUANTITATIVE",
        measurement: mkBloodMeasurement(),
        measurementMethod: "BLOOD_KETONE_METER",
        recheckFor: {
          recordType: "GLUCOSE_READING",
          recordId: UUID,
          revisionId: UUID,
        },
      }),
    ).toThrow();
  });

  it("accepts an optional patientNote", () => {
    const result = ketoneReadingPayloadSchema.parse({
      kind: "BLOOD_QUANTITATIVE",
      measurement: mkBloodMeasurement(),
      measurementMethod: "BLOOD_KETONE_METER",
      patientNote: { text: "Feet unwell", language: "en-SG" },
    });
    expect(result.patientNote!.text).toBe("Feet unwell");
  });

  it("rejects unknown keys on BLOOD_QUANTITATIVE", () => {
    expect(() =>
      ketoneReadingPayloadSchema.parse({
        kind: "BLOOD_QUANTITATIVE",
        measurement: mkBloodMeasurement(),
        measurementMethod: "BLOOD_KETONE_METER",
        extra: true,
      }),
    ).toThrow();
  });
});

describe("ketoneReadingPayloadSchema — URINE_QUALITATIVE", () => {
  it("accepts a SUPPORTED_SCALE urine result", () => {
    const result = ketoneReadingPayloadSchema.parse({
      kind: "URINE_QUALITATIVE",
      result: {
        mapping: "SUPPORTED_SCALE",
        scaleId: "keto-strips-v2",
        scaleVersion: "2.0",
        resultCode: "MODERATE",
        enteredLabel: "++",
      },
      measurementMethod: "URINE_TEST_STRIP",
    });
    expect(result.kind).toBe("URINE_QUALITATIVE");
  });

  it("accepts an UNMAPPED urine result", () => {
    const result = ketoneReadingPayloadSchema.parse({
      kind: "URINE_QUALITATIVE",
      result: {
        mapping: "UNMAPPED",
        enteredLabel: "trace-ish",
      },
      measurementMethod: "URINE_TEST_STRIP",
    });
    if (result.kind === "URINE_QUALITATIVE") {
      expect(result.result.mapping).toBe("UNMAPPED");
    }
  });

  it("rejects SUPPORTED_SCALE with empty scaleId", () => {
    expect(() =>
      ketoneReadingPayloadSchema.parse({
        kind: "URINE_QUALITATIVE",
        result: {
          mapping: "SUPPORTED_SCALE",
          scaleId: "",
          scaleVersion: "2.0",
          resultCode: "MODERATE",
          enteredLabel: "++",
          },
          measurementMethod: "URINE_TEST_STRIP",
        }),
    ).toThrow();
  });

  it("rejects SUPPORTED_SCALE with empty scaleVersion", () => {
    expect(() =>
        ketoneReadingPayloadSchema.parse({
          kind: "URINE_QUALITATIVE",
          result: {
            mapping: "SUPPORTED_SCALE",
            scaleId: "keto-strips-v2",
            scaleVersion: "",
                resultCode: "MODERATE",
            enteredLabel: "++",
          },
          measurementMethod: "URINE_TEST_STRIP",
        }),
    ).toThrow();
  });

  it("rejects SUPPORTED_SCALE with empty resultCode", () => {
      expect(() =>
        ketoneReadingPayloadSchema.parse({
          kind: "URINE_QUALITATIVE",
          result: {
            mapping: "SUPPORTED_SCALE",
            scaleId: "keto-strips-v2",
            scaleVersion: "2.0",
            resultCode: "",
            enteredLabel: "++",
          },
          measurementMethod: "URINE_TEST_STRIP",
        }),
    ).toThrow();
  });

  it("rejects SUPPORTED_SCALE with empty enteredLabel", () => {
    expect(() =>
      ketoneReadingPayloadSchema.parse({
        kind: "URINE_QUALITATIVE",
        result: {
          mapping: "SUPPORTED_SCALE",
          scaleId: "keto-strips-v2",
          scaleVersion: "2.0",
          resultCode: "MODERATE",
          enteredLabel: "",
        },
        measurementMethod: "URINE_TEST_STRIP",
      }),
    ).toThrow();
  });

  it("rejects UNMAPPED with empty enteredLabel", () => {
    expect(() =>
      ketoneReadingPayloadSchema.parse({
        kind: "URINE_QUALITATIVE",
        result: {
          mapping: "UNMAPPED",
          enteredLabel: "",
        },
          measurementMethod: "URINE_TEST_STRIP",
      }),
    ).toThrow();
  });

  it("rejects an unmapped result with threshold/classification fields", () => {
    expect(() =>
      ketoneReadingPayloadSchema.parse({
          kind: "URINE_QUALITATIVE",
        result: {
          mapping: "UNMAPPED",
          enteredLabel: "weird",
          threshold: "HIGH",
          classification: "KETOSIS",
        },
        measurementMethod: "URINE_TEST_STRIP",
      }),
    ).toThrow();
  });

  it("accepts an optional recheckFor on URINE_QUALITATIVE", () => {
    const result = ketoneReadingPayloadSchema.parse({
      kind: "URINE_QUALITATIVE",
      result: {
        mapping: "UNMAPPED",
        enteredLabel: "trace-ish",
      },
      measurementMethod: "URINE_TEST_STRIP",
      recheckFor: {
        recordType: "SAFETY_EVENT",
        recordId: UUID,
        revisionId: UUID,
      },
    });
    expect(result.kind).toBe("URINE_QUALITATIVE");
  });

  it("accepts an optional patientNote on URINE_QUALITATIVE", () => {
    const result = ketoneReadingPayloadSchema.parse({
      kind: "URINE_QUALITATIVE",
      result: {
        mapping: "UNMAPPED",
        enteredLabel: "trace-ish",
      },
      measurementMethod: "URINE_TEST_STRIP",
      patientNote: { text: "Odd result", language: "en-SG" },
    });
    expect(result.patientNote!.text).toBe("Odd result");
  });

  it("rejects a urine method on blood quantitative", () => {
    expect(() =>
      ketoneReadingPayloadSchema.parse({
        kind: "BLOOD_QUANTITATIVE",
        measurement: mkBloodMeasurement(),
        measurementMethod: "URINE_TEST_STRIP",
      }),
    ).toThrow();
  });

  it("rejects a blood method on urine qualitative", () => {
      expect(() =>
        ketoneReadingPayloadSchema.parse({
          kind: "URINE_QUALITATIVE",
          result: {
            mapping: "UNMAPPED",
            enteredLabel: "trace-ish",
          },
        measurementMethod: "BLOOD_KETONE_METER",
        }),
    ).toThrow();
  });

  it("rejects unknown keys on URINE_QUALITATIVE", () => {
    expect(() =>
      ketoneReadingPayloadSchema.parse({
        kind: "URINE_QUALITATIVE",
        result: {
          mapping: "UNMAPPED",
          enteredLabel: "trace-ish",
        },
        measurementMethod: "URINE_TEST_STRIP",
        extra: true,
      }),
    ).toThrow();
  });

  it("rejects a missing result on URINE_QUALITATIVE", () => {
    expect(() =>
      ketoneReadingPayloadSchema.parse({
        kind: "URINE_QUALITATIVE",
        measurementMethod: "URINE_TEST_STRIP",
      }),
    ).toThrow();
  });
});

describe("urineKetoneResultSchema (direct)", () => {
  it("accepts a SUPPORTED_SCALE result directly", () => {
    const result = urineKetoneResultSchema.parse({
      mapping: "SUPPORTED_SCALE",
      scaleId: "keto-strips-v2",
      scaleVersion: "2.0",
      resultCode: "MODERATE",
      enteredLabel: "++",
    });
    expect(result.mapping).toBe("SUPPORTED_SCALE");
  });

  it("accepts an UNMAPPED result directly", () => {
    const result = urineKetoneResultSchema.parse({
      mapping: "UNMAPPED",
      enteredLabel: "trace-ish",
    });
    expect(result.mapping).toBe("UNMAPPED");
  });

  it("rejects an unknown mapping discriminator", () => {
    expect(() =>
      urineKetoneResultSchema.parse({
        mapping: "INFERRED",
        enteredLabel: "x",
      }),
    ).toThrow();
  });

  it("rejects unknown keys on SUPPORTED_SCALE", () => {
    expect(() =>
      urineKetoneResultSchema.parse({
        mapping: "SUPPORTED_SCALE",
        scaleId: "s1",
        scaleVersion: "1",
        resultCode: "C1",
        enteredLabel: "l1",
        extra: true,
      }),
    ).toThrow();
  });
});