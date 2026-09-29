import { describe, it, expect } from "vitest";
import {
  intakeTemporalSchema,
  symptomTemporalSchema,
  activityTemporalSchema,
} from "./observation-temporal";

const EXACT_OCCURRENCE = {
  kind: "EXACT",
  instantUtc: "2026-09-30T08:00:00Z",
  timeZoneId: "Asia/Singapore",
  utcOffsetMinutes: 480,
};

const LATER_EXACT_OCCURRENCE = {
  kind: "EXACT",
  instantUtc: "2026-09-30T10:00:00Z",
  timeZoneId: "Asia/Singapore",
  utcOffsetMinutes: 480,
};

const UNKNOWN_OCCURRENCE = { kind: "UNKNOWN" };

// Known end whose point is strictly after start.
const KNOWN_END = {
  kind: "KNOWN",
  point: LATER_EXACT_OCCURRENCE,
};

const OPEN_END = { kind: "OPEN" };

const UNKNOWN_END = { kind: "UNKNOWN" };

// --- Intake temporal ---

describe("intakeTemporalSchema", () => {
  it("accepts POINT with EXACT occurrence", () => {
    const result = intakeTemporalSchema.parse({
      kind: "POINT",
      occurrence: EXACT_OCCURRENCE,
    });
    expect(result.kind).toBe("POINT");
  });

  it("accepts POINT with APPROXIMATE occurrence", () => {
    const result = intakeTemporalSchema.parse({
      kind: "POINT",
      occurrence: {
        kind: "APPROXIMATE",
        approximateInstantUtc: "2026-09-30T08:00:00Z",
        uncertaintyMinutes: 15,
        timeZoneId: "Asia/Singapore",
        utcOffsetMinutes: 480,
      },
    });
    expect(result.kind).toBe("POINT");
  });

  it("accepts POINT with DATE_ONLY occurrence", () => {
    const result = intakeTemporalSchema.parse({
      kind: "POINT",
      occurrence: {
        kind: "DATE_ONLY",
        localDate: "2026-09-30",
        timeZoneId: "Asia/Singapore",
      },
    });
    expect(result.kind).toBe("POINT");
  });

  it("accepts POINT with UNKNOWN occurrence", () => {
    const result = intakeTemporalSchema.parse({
      kind: "POINT",
      occurrence: UNKNOWN_OCCURRENCE,
    });
    expect(result.kind).toBe("POINT");
  });

  it("rejects INTERVAL", () => {
    expect(() =>
      intakeTemporalSchema.parse({
        kind: "INTERVAL",
        start: EXACT_OCCURRENCE,
        end: OPEN_END,
      }),
    ).toThrow();
  });

  it("rejects ATEMPORAL", () => {
    expect(() => intakeTemporalSchema.parse({ kind: "ATEMPORAL" })).toThrow();
  });

  it("rejects missing occurrence", () => {
    expect(() => intakeTemporalSchema.parse({ kind: "POINT" })).toThrow();
  });

  it("rejects an entry-time substitution field", () => {
    expect(() =>
      intakeTemporalSchema.parse({
        kind: "POINT",
        occurrence: EXACT_OCCURRENCE,
        entryTime: "2026-09-30T10:00:00Z",
      }),
    ).toThrow();
  });

  it("rejects unknown keys", () => {
    expect(() =>
      intakeTemporalSchema.parse({
        kind: "POINT",
        occurrence: EXACT_OCCURRENCE,
        extra: true,
      }),
    ).toThrow();
  });
});

// --- Symptom temporal ---

describe("symptomTemporalSchema", () => {
  it("accepts POINT with EXACT", () => {
    const result = symptomTemporalSchema.parse({
      kind: "POINT",
      occurrence: EXACT_OCCURRENCE,
    });
    expect(result.kind).toBe("POINT");
  });

  it("accepts POINT with UNKNOWN occurrence", () => {
    const result = symptomTemporalSchema.parse({
      kind: "POINT",
      occurrence: UNKNOWN_OCCURRENCE,
    });
    expect(result.kind).toBe("POINT");
  });

  it("accepts INTERVAL with KNOWN end after start", () => {
    const result = symptomTemporalSchema.parse({
      kind: "INTERVAL",
      start: EXACT_OCCURRENCE,
      end: KNOWN_END,
    });
    expect(result.kind).toBe("INTERVAL");
  });

  it("accepts INTERVAL with OPEN end", () => {
    const result = symptomTemporalSchema.parse({
      kind: "INTERVAL",
      start: EXACT_OCCURRENCE,
      end: OPEN_END,
    });
    expect(result.kind).toBe("INTERVAL");
  });

  it("accepts INTERVAL with UNKNOWN end", () => {
    const result = symptomTemporalSchema.parse({
      kind: "INTERVAL",
      start: EXACT_OCCURRENCE,
      end: UNKNOWN_END,
    });
    expect(result.kind).toBe("INTERVAL");
  });

  it("rejects INTERVAL with KNOWN end equal to start", () => {
    expect(() =>
      symptomTemporalSchema.parse({
        kind: "INTERVAL",
        start: EXACT_OCCURRENCE,
        end: { kind: "KNOWN", point: EXACT_OCCURRENCE },
      }),
    ).toThrow();
  });

  it("rejects INTERVAL with KNOWN end before start", () => {
    expect(() =>
      symptomTemporalSchema.parse({
        kind: "INTERVAL",
        start: LATER_EXACT_OCCURRENCE,
        end: { kind: "KNOWN", point: EXACT_OCCURRENCE },
      }),
    ).toThrow();
  });

  it("rejects ATEMPORAL", () => {
    expect(() => symptomTemporalSchema.parse({ kind: "ATEMPORAL" })).toThrow();
  });

  it("rejects unknown keys", () => {
    expect(() =>
      symptomTemporalSchema.parse({
        kind: "POINT",
        occurrence: EXACT_OCCURRENCE,
        extra: true,
      }),
    ).toThrow();
  });
});

// --- Activity temporal ---

describe("activityTemporalSchema", () => {
  it("accepts POINT with EXACT", () => {
    const result = activityTemporalSchema.parse({
      kind: "POINT",
      occurrence: EXACT_OCCURRENCE,
    });
    expect(result.kind).toBe("POINT");
  });

  it("accepts POINT with UNKNOWN occurrence", () => {
    const result = activityTemporalSchema.parse({
      kind: "POINT",
      occurrence: UNKNOWN_OCCURRENCE,
    });
    expect(result.kind).toBe("POINT");
  });

  it("accepts INTERVAL with KNOWN end after start", () => {
    const result = activityTemporalSchema.parse({
      kind: "INTERVAL",
      start: EXACT_OCCURRENCE,
      end: KNOWN_END,
    });
    expect(result.kind).toBe("INTERVAL");
  });

  it("accepts INTERVAL with OPEN end", () => {
    const result = activityTemporalSchema.parse({
      kind: "INTERVAL",
      start: EXACT_OCCURRENCE,
      end: OPEN_END,
    });
    expect(result.kind).toBe("INTERVAL");
  });

  it("accepts INTERVAL with UNKNOWN end", () => {
    const result = activityTemporalSchema.parse({
      kind: "INTERVAL",
      start: EXACT_OCCURRENCE,
      end: UNKNOWN_END,
    });
    expect(result.kind).toBe("INTERVAL");
  });

  it("rejects INTERVAL with KNOWN end equal to start", () => {
    expect(() =>
      activityTemporalSchema.parse({
        kind: "INTERVAL",
        start: EXACT_OCCURRENCE,
        end: { kind: "KNOWN", point: EXACT_OCCURRENCE },
      }),
    ).toThrow();
  });

  it("rejects INTERVAL with KNOWN end before start", () => {
    expect(() =>
      activityTemporalSchema.parse({
        kind: "INTERVAL",
        start: LATER_EXACT_OCCURRENCE,
        end: { kind: "KNOWN", point: EXACT_OCCURRENCE },
      }),
    ).toThrow();
  });

  it("rejects ATEMPORAL", () => {
    expect(() => activityTemporalSchema.parse({ kind: "ATEMPORAL" })).toThrow();
  });

  it("rejects unknown keys", () => {
    expect(() =>
      activityTemporalSchema.parse({
        kind: "POINT",
        occurrence: EXACT_OCCURRENCE,
        extra: true,
      }),
    ).toThrow();
  });
});