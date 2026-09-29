import { describe, it, expect } from "vitest";
import {
  readingTemporalSchema,
  type ReadingTemporal,
} from "./reading-temporal";

describe("readingTemporalSchema", () => {
  it("accepts POINT with EXACT", () => {
    const result = readingTemporalSchema.parse({
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
    const result = readingTemporalSchema.parse({
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
    const result = readingTemporalSchema.parse({
      kind: "POINT",
      occurrence: {
        kind: "DATE_ONLY",
        localDate: "2026-09-27",
        timeZoneId: "Asia/Singapore",
      },
    });
    expect(result.occurrence.kind).toBe("DATE_ONLY");
  });

  it("accepts POINT with UNKNOWN", () => {
    const result = readingTemporalSchema.parse({
      kind: "POINT",
      occurrence: { kind: "UNKNOWN" },
    });
    expect(result.occurrence.kind).toBe("UNKNOWN");
  });

  it("rejects INTERVAL", () => {
    expect(() =>
      readingTemporalSchema.parse({
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
    expect(() => readingTemporalSchema.parse({ kind: "ATEMPORAL" })).toThrow();
  });

  it("rejects missing occurrence", () => {
    expect(() => readingTemporalSchema.parse({ kind: "POINT" })).toThrow();
  });

  it("rejects entry-time substitution fields", () => {
    expect(() =>
      readingTemporalSchema.parse({
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

  it("rejects import-time substitution fields", () => {
    expect(() =>
      readingTemporalSchema.parse({
        kind: "POINT",
        occurrence: {
          kind: "EXACT",
          instantUtc: "2026-09-27T10:00:00Z",
          timeZoneId: "Asia/Singapore",
          utcOffsetMinutes: 480,
        },
        importTime: "2026-09-27T12:00:00Z",
      }),
    ).toThrow();
  });

  it("rejects revision-time substitution fields", () => {
    expect(() =>
      readingTemporalSchema.parse({
        kind: "POINT",
        occurrence: {
          kind: "EXACT",
          instantUtc: "2026-09-27T10:00:00Z",
          timeZoneId: "Asia/Singapore",
          utcOffsetMinutes: 480,
        },
        revisionTime: "2026-09-27T12:00:00Z",
      }),
    ).toThrow();
  });

  it("rejects current-time substitution fields", () => {
    expect(() =>
      readingTemporalSchema.parse({
        kind: "POINT",
        occurrence: {
          kind: "EXACT",
          instantUtc: "2026-09-27T10:00:00Z",
          timeZoneId: "Asia/Singapore",
          utcOffsetMinutes: 480,
        },
        currentTime: "2026-09-27T12:00:00Z",
      }),
    ).toThrow();
  });

  it("rejects migration-time substitution fields", () => {
    expect(() =>
      readingTemporalSchema.parse({
        kind: "POINT",
        occurrence: {
          kind: "EXACT",
          instantUtc: "2026-09-27T10:00:00Z",
          timeZoneId: "Asia/Singapore",
          utcOffsetMinutes: 480,
        },
        migrationTime: "2026-09-27T12:00:00Z",
      }),
    ).toThrow();
  });

  it("rejects restoration-time substitution fields", () => {
    expect(() =>
      readingTemporalSchema.parse({
        kind: "POINT",
        occurrence: {
          kind: "EXACT",
          instantUtc: "2026-09-27T10:00:00Z",
          timeZoneId: "Asia/Singapore",
          utcOffsetMinutes: 480,
        },
        restorationTime: "2026-09-27T12:00:00:00Z",
      }),
    ).toThrow();
  });

  it("rejects unknown keys", () => {
    expect(() =>
      readingTemporalSchema.parse({
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
});