import { describe, it, expect } from "vitest";
import {
  timePointSchema,
  intervalEndSchema,
  temporalMeaningSchema,
  type TimePoint,
  type IntervalEnd,
  type TemporalMeaning,
} from "./temporal";

const VALID_INSTANT = "2026-09-27T10:30:00Z" as TimePoint extends string
  ? string
  : never;

describe("timePointSchema", () => {
  describe("EXACT", () => {
    it("accepts a valid exact time point", () => {
      const tp = timePointSchema.parse({
        kind: "EXACT",
        instantUtc: "2026-09-27T10:30:00Z",
        timeZoneId: "Asia/Singapore",
        utcOffsetMinutes: 480,
      });
      expect(tp.kind).toBe("EXACT");
    });

    it("accepts null timeZoneId", () => {
      const tp = timePointSchema.parse({
        kind: "EXACT",
        instantUtc: "2026-09-27T10:30:00Z",
        timeZoneId: null,
        utcOffsetMinutes: 0,
      });
      expect(tp.kind).toBe("EXACT");
    });

    it("rejects unknown keys", () => {
      expect(() =>
        timePointSchema.parse({
          kind: "EXACT",
          instantUtc: "2026-09-27T10:30:00Z",
          timeZoneId: null,
          utcOffsetMinutes: 0,
          extra: true,
        }),
      ).toThrow();
    });

    it("accepts Asia/Singapore as timeZoneId", () => {
      const tp = timePointSchema.parse({
        kind: "EXACT",
        instantUtc: "2026-09-27T10:30:00Z",
        timeZoneId: "Asia/Singapore",
        utcOffsetMinutes: 480,
      });
      expect(tp.kind).toBe("EXACT");
    });

    it("accepts Europe/London as timeZoneId", () => {
      const tp = timePointSchema.parse({
        kind: "EXACT",
        instantUtc: "2026-09-27T10:30:00Z",
        timeZoneId: "Europe/London",
        utcOffsetMinutes: 60,
      });
      expect(tp.kind).toBe("EXACT");
    });

    it("rejects an invalid timeZoneId", () => {
      expect(() =>
        timePointSchema.parse({
          kind: "EXACT",
          instantUtc: "2026-09-27T10:30:00Z",
          timeZoneId: "Fake/Zone",
          utcOffsetMinutes: 0,
        }),
      ).toThrow();
    });

    it("accepts null timeZoneId", () => {
      const tp = timePointSchema.parse({
        kind: "EXACT",
        instantUtc: "2026-09-27T10:30:00Z",
        timeZoneId: null,
        utcOffsetMinutes: 0,
      });
      expect(tp.kind).toBe("EXACT");
    });

    it("rejects an invalid instant string", () => {
      expect(() =>
        timePointSchema.parse({
          kind: "EXACT",
          instantUtc: "not-an-instant",
          timeZoneId: null,
          utcOffsetMinutes: 0,
        }),
      ).toThrow();
    });
  });

  describe("APPROXIMATE", () => {
    it("accepts a valid approximate time point with positive uncertainty", () => {
      const tp = timePointSchema.parse({
        kind: "APPROXIMATE",
        approximateInstantUtc: "2026-09-27T10:30:00Z",
        uncertaintyMinutes: 15,
        timeZoneId: null,
        utcOffsetMinutes: 0,
      });
      expect(tp.kind).toBe("APPROXIMATE");
    });

    it("rejects zero uncertainty", () => {
      expect(() =>
        timePointSchema.parse({
          kind: "APPROXIMATE",
          approximateInstantUtc: "2026-09-27T10:30:00Z",
          uncertaintyMinutes: 0,
          timeZoneId: null,
          utcOffsetMinutes: 0,
        }),
      ).toThrow();
    });

    it("rejects negative uncertainty", () => {
      expect(() =>
        timePointSchema.parse({
          kind: "APPROXIMATE",
          approximateInstantUtc: "2026-09-27T10:30:00Z",
          uncertaintyMinutes: -5,
          timeZoneId: null,
          utcOffsetMinutes: 0,
        }),
      ).toThrow();
    });

    it("rejects fractional uncertainty", () => {
      expect(() =>
        timePointSchema.parse({
          kind: "APPROXIMATE",
          approximateInstantUtc: "2026-09-27T10:30:00Z",
          uncertaintyMinutes: 5.5,
          timeZoneId: null,
          utcOffsetMinutes: 0,
        }),
      ).toThrow();
    });
  });

  describe("DATE_ONLY", () => {
    it("accepts a valid date-only time point", () => {
      const tp = timePointSchema.parse({
        kind: "DATE_ONLY",
        localDate: "2026-09-27",
        timeZoneId: "Asia/Singapore",
      });
      expect(tp.kind).toBe("DATE_ONLY");
    });

    it("accepts null timeZoneId", () => {
      const tp = timePointSchema.parse({
        kind: "DATE_ONLY",
        localDate: "2026-09-27",
        timeZoneId: null,
      });
      expect(tp.kind).toBe("DATE_ONLY");
    });

    it("rejects an impossible date", () => {
      expect(() =>
        timePointSchema.parse({
          kind: "DATE_ONLY",
          localDate: "2026-02-30",
          timeZoneId: null,
        }),
      ).toThrow();
    });
  });

  describe("UNKNOWN", () => {
    it("accepts unknown time point", () => {
      const tp = timePointSchema.parse({ kind: "UNKNOWN" });
      expect(tp.kind).toBe("UNKNOWN");
    });

    it("rejects extra keys on unknown", () => {
      expect(() =>
        timePointSchema.parse({ kind: "UNKNOWN", extra: true }),
      ).toThrow();
    });
  });
});

describe("intervalEndSchema", () => {
  it("accepts KNOWN end with a valid time point", () => {
    const end = intervalEndSchema.parse({
      kind: "KNOWN",
      point: {
        kind: "EXACT",
        instantUtc: "2026-09-27T11:30:00Z",
        timeZoneId: null,
        utcOffsetMinutes: 0,
      },
    });
    expect(end.kind).toBe("KNOWN");
  });

  it("keeps OPEN distinct from ENDED_TIME_UNKNOWN", () => {
    const open = intervalEndSchema.parse({ kind: "OPEN" });
    const endedUnknown = intervalEndSchema.parse({
      kind: "ENDED_TIME_UNKNOWN",
    });
    expect(open.kind).toBe("OPEN");
    expect(endedUnknown.kind).toBe("ENDED_TIME_UNKNOWN");
    expect(open.kind).not.toBe(endedUnknown.kind);
  });

  it("keeps UNKNOWN ending distinct from OPEN and ENDED_TIME_UNKNOWN", () => {
    const unknown = intervalEndSchema.parse({ kind: "UNKNOWN" });
    expect(unknown.kind).toBe("UNKNOWN");
  });

  it("rejects an unknown end kind", () => {
    expect(() => intervalEndSchema.parse({ kind: "CLOSED" })).toThrow();
  });
});

describe("temporalMeaningSchema", () => {
  describe("POINT", () => {
    it("accepts a valid point meaning", () => {
      const tm = temporalMeaningSchema.parse({
        kind: "POINT",
        occurrence: {
          kind: "EXACT",
          instantUtc: "2026-09-27T10:30:00Z",
          timeZoneId: null,
          utcOffsetMinutes: 0,
        },
      });
      expect(tm.kind).toBe("POINT");
    });
  });

  describe("INTERVAL", () => {
    it("accepts a valid interval with known endpoints", () => {
      const tm = temporalMeaningSchema.parse({
        kind: "INTERVAL",
        start: {
          kind: "EXACT",
          instantUtc: "2026-09-27T10:00:00Z",
          timeZoneId: null,
          utcOffsetMinutes: 0,
        },
        end: {
          kind: "KNOWN",
          point: {
            kind: "EXACT",
            instantUtc: "2026-09-27T11:00:00Z",
            timeZoneId: null,
            utcOffsetMinutes: 0,
          },
        },
      });
      expect(tm.kind).toBe("INTERVAL");
    });

    it("accepts an interval with an OPEN end", () => {
      const tm = temporalMeaningSchema.parse({
        kind: "INTERVAL",
        start: {
          kind: "EXACT",
          instantUtc: "2026-09-27T10:00:00Z",
          timeZoneId: null,
          utcOffsetMinutes: 0,
        },
        end: { kind: "OPEN" },
      });
      expect(tm.kind).toBe("INTERVAL");
    });

    it("rejects a known end not later than the start (equal)", () => {
      const result = temporalMeaningSchema.safeParse({
        kind: "INTERVAL",
        start: {
          kind: "EXACT",
          instantUtc: "2026-09-27T10:00:00Z",
          timeZoneId: null,
          utcOffsetMinutes: 0,
        },
        end: {
          kind: "KNOWN",
          point: {
            kind: "EXACT",
            instantUtc: "2026-09-27T10:00:00Z",
            timeZoneId: null,
            utcOffsetMinutes: 0,
          },
        },
      });
      expect(result.success).toBe(false);
    });

    it("rejects a known end not later than the start (reversed)", () => {
      const result = temporalMeaningSchema.safeParse({
        kind: "INTERVAL",
        start: {
          kind: "EXACT",
          instantUtc: "2026-09-27T11:00:00Z",
          timeZoneId: null,
          utcOffsetMinutes: 0,
        },
        end: {
          kind: "KNOWN",
          point: {
            kind: "EXACT",
            instantUtc: "2026-09-27T10:00:00Z",
            timeZoneId: null,
            utcOffsetMinutes: 0,
          },
        },
      });
      expect(result.success).toBe(false);
    });
  });

  describe("ATEMPORAL", () => {
    it("accepts an atemporal meaning", () => {
      const tm = temporalMeaningSchema.parse({ kind: "ATEMPORAL" });
      expect(tm.kind).toBe("ATEMPORAL");
    });
  });
});