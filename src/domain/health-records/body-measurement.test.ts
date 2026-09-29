import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  bodyMeasurementPayloadSchema,
  bodyMeasurementTemporalSchema,
  BODY_MEASUREMENT_DELETION_POLICY,
  type BodyMeasurementPayload,
  type BodyMeasurementTemporal,
} from "./body-measurement";

describe("BODY_MEASUREMENT_DELETION_POLICY", () => {
  it("is exactly PATIENT_DELETABLE", () => {
    expect(BODY_MEASUREMENT_DELETION_POLICY).toBe("PATIENT_DELETABLE");
  });
});

describe("bodyMeasurementPayloadSchema — WEIGHT", () => {
  it("accepts a valid KG weight", () => {
    const result = bodyMeasurementPayloadSchema.parse({
      kind: "WEIGHT",
      measurement: {
        enteredValue: "70.5",
        enteredUnit: "KG",
        normalization: {
          canonicalValue: "70.5",
          canonicalUnit: "KG",
          normalizerVersion: "1.0.0",
        },
      },
    });
    expect(result.kind).toBe("WEIGHT");
    expect(result.measurement.enteredUnit).toBe("KG");
  });

  it("accepts a valid LB weight with null normalisation", () => {
    const result = bodyMeasurementPayloadSchema.parse({
      kind: "WEIGHT",
      measurement: {
        enteredValue: "154.3",
        enteredUnit: "LB",
        normalization: null,
      },
    });
    expect(result.measurement.normalization).toBeNull();
  });
});

describe("bodyMeasurementPayloadSchema — HEIGHT", () => {
  it("accepts a valid CM height", () => {
    const result = bodyMeasurementPayloadSchema.parse({
      kind: "HEIGHT",
      measurement: {
        enteredValue: "170.0",
        enteredUnit: "CM",
        normalization: {
          canonicalValue: "170.0",
          canonicalUnit: "CM",
          normalizerVersion: "1.0.0",
        },
      },
    });
    expect(result.kind).toBe("HEIGHT");
  });

  it("accepts a valid IN height with null normalisation", () => {
    const result = bodyMeasurementPayloadSchema.parse({
      kind: "HEIGHT",
      measurement: {
        enteredValue: "67",
        enteredUnit: "IN",
        normalization: null,
      },
    });
    expect(result.measurement.enteredUnit).toBe("IN");
  });
});

describe("bodyMeasurementPayloadSchema — cross-kind validation", () => {
  it("rejects a KG unit on a HEIGHT measurement", () => {
    expect(() =>
      bodyMeasurementPayloadSchema.parse({
        kind: "HEIGHT",
        measurement: {
          enteredValue: "70.5",
          enteredUnit: "KG",
          normalization: null,
        },
      }),
    ).toThrow();
  });

  it("rejects a CM unit on a WEIGHT measurement", () => {
    expect(() =>
      bodyMeasurementPayloadSchema.parse({
        kind: "WEIGHT",
        measurement: {
          enteredValue: "170",
          enteredUnit: "CM",
          normalization: null,
        },
      }),
    ).toThrow();
  });

  it("rejects unknown keys", () => {
    expect(() =>
      bodyMeasurementPayloadSchema.parse({
        kind: "WEIGHT",
        measurement: {
          enteredValue: "70.5",
          enteredUnit: "KG",
          normalization: null,
        },
        extra: true,
      }),
    ).toThrow();
  });

  it("rejects an invalid kind", () => {
    expect(() =>
      bodyMeasurementPayloadSchema.parse({
        kind: "BMI",
        measurement: {
          enteredValue: "25",
          enteredUnit: "KG",
          normalization: null,
        },
      }),
    ).toThrow();
  });
});

describe("bodyMeasurementTemporalSchema", () => {
  it("accepts POINT with EXACT", () => {
    const result = bodyMeasurementTemporalSchema.parse({
      kind: "POINT",
      occurrence: {
        kind: "EXACT",
        instantUtc: "2026-09-27T10:00:00Z",
        timeZoneId: "Asia/Singapore",
        utcOffsetMinutes: 480,
      },
    });
    expect(result.kind).toBe("POINT");
    expect(result.occurrence.kind).toBe("EXACT");
  });

  it("accepts POINT with APPROXIMATE", () => {
    const result = bodyMeasurementTemporalSchema.parse({
      kind: "POINT",
      occurrence: {
        kind: "APPROXIMATE",
        approximateInstantUtc: "2026-09-27T10:00:00Z",
        uncertaintyMinutes: 15,
        timeZoneId: "Asia/Singapore",
        utcOffsetMinutes: 480,
      },
    });
    expect(result.occurrence.kind).toBe("APPROXIMATE");
  });

  it("accepts POINT with DATE_ONLY", () => {
    const result = bodyMeasurementTemporalSchema.parse({
      kind: "POINT",
      occurrence: {
        kind: "DATE_ONLY",
        localDate: "2026-09-27",
        timeZoneId: "Asia/Singapore",
      },
    });
    expect(result.occurrence.kind).toBe("DATE_ONLY");
  });

  it("rejects POINT with UNKNOWN", () => {
    expect(() =>
      bodyMeasurementTemporalSchema.parse({
        kind: "POINT",
        occurrence: { kind: "UNKNOWN" },
      }),
    ).toThrow();
  });

  it("rejects INTERVAL", () => {
    expect(() =>
      bodyMeasurementTemporalSchema.parse({
        kind: "INTERVAL",
        start: {
          kind: "EXACT",
          instantUtc: "2026-09-27T10:00:00Z",
          timeZoneId: "Asia/Singapore",
          utcOffsetMinutes: 480,
        },
        end: { kind: "OPEN" },
      }),
    ).toThrow();
  });

  it("rejects ATEMPORAL", () => {
    expect(() =>
      bodyMeasurementTemporalSchema.parse({ kind: "ATEMPORAL" }),
    ).toThrow();
  });

  it("rejects missing occurrence time", () => {
    expect(() =>
      bodyMeasurementTemporalSchema.parse({ kind: "POINT" }),
    ).toThrow();
  });

  it("rejects entry-time substitution fields", () => {
    expect(() =>
      bodyMeasurementTemporalSchema.parse({
        kind: "POINT",
        occurrence: {
          kind: "EXACT",
          instantUtc: "2026-09-27T10:00:00Z",
          timeZoneId: "Asia/Singapore",
          utcOffsetMinutes: 480,
        },
        entryTime: "2026-09-27T12:00:00Z",
      }),
    ).toThrow();
  });

  it("rejects unknown keys", () => {
    expect(() =>
      bodyMeasurementTemporalSchema.parse({
        kind: "POINT",
        occurrence: {
          kind: "EXACT",
          instantUtc: "2026-09-27T10:00:00Z",
          timeZoneId: "Asia/Singapore",
          utcOffsetMinutes: 480,
        },
        extra: true,
      }),
    ).toThrow();
  });

  it("preserves a historical date and rejects an added current field", () => {
    const result = bodyMeasurementTemporalSchema.parse({
      kind: "POINT",
      occurrence: {
        kind: "DATE_ONLY",
        localDate: "2001-05-15",
        timeZoneId: "Asia/Singapore",
      },
    });
    expect(result.occurrence.kind).toBe("DATE_ONLY");
    expect((result.occurrence as { localDate: string }).localDate).toBe("2001-05-15");
    expect(() =>
      bodyMeasurementTemporalSchema.parse({
        kind: "POINT",
        occurrence: {
          kind: "DATE_ONLY",
          localDate: "2001-05-15",
          timeZoneId: "Asia/Singapore",
        },
        current: true,
      }),
    ).toThrow();
  });
});