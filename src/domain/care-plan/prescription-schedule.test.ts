import { describe, it, expect } from "vitest";
import {
  localClockTimeSchema,
  prescriptionTimingAllowanceSchema,
  prescriptionScheduleSchema,
} from "./prescription-schedule";

describe("localClockTimeSchema", () => {
  it("accepts 00:00", () => {
    expect(localClockTimeSchema.parse("00:00")).toBe("00:00");
  });

  it("accepts 23:59", () => {
    expect(localClockTimeSchema.parse("23:59")).toBe("23:59");
  });

  it("accepts 08:30", () => {
    expect(localClockTimeSchema.parse("08:30")).toBe("08:30");
  });

  it("rejects 24:00", () => {
    expect(() => localClockTimeSchema.parse("24:00")).toThrow();
  });

  it("rejects 12:60", () => {
    expect(() => localClockTimeSchema.parse("12:60")).toThrow();
  });

  it("rejects non-zero-padded", () => {
    expect(() => localClockTimeSchema.parse("8:30")).toThrow();
  });

  it("rejects plain text", () => {
    expect(() => localClockTimeSchema.parse("noon")).toThrow();
  });
});

describe("prescriptionTimingAllowanceSchema", () => {
  it("accepts a valid ordering", () => {
    const result = prescriptionTimingAllowanceSchema.parse({
      minimumMinutesFromTarget: -10,
      maximumMinutesFromTarget: 15,
    });
    expect(result.minimumMinutesFromTarget).toBe(-10);
  });

  it("accepts minimum equal to maximum", () => {
    expect(() =>
      prescriptionTimingAllowanceSchema.parse({
        minimumMinutesFromTarget: 0,
        maximumMinutesFromTarget: 0,
      }),
    ).not.toThrow();
  });

  it("rejects minimum greater than maximum", () => {
    expect(() =>
      prescriptionTimingAllowanceSchema.parse({
        minimumMinutesFromTarget: 10,
        maximumMinutesFromTarget: 5,
      }),
    ).toThrow();
  });

  it("rejects non-integer values", () => {
    expect(() =>
      prescriptionTimingAllowanceSchema.parse({
        minimumMinutesFromTarget: 5.5,
        maximumMinutesFromTarget: 10,
      }),
    ).toThrow();
  });

  it("accepts MIN_SAFE_INTEGER and MAX_SAFE_INTEGER", () => {
    const result = prescriptionTimingAllowanceSchema.parse({
      minimumMinutesFromTarget: Number.MIN_SAFE_INTEGER,
      maximumMinutesFromTarget: Number.MAX_SAFE_INTEGER,
    });
    expect(result.minimumMinutesFromTarget).toBe(Number.MIN_SAFE_INTEGER);
    expect(result.maximumMinutesFromTarget).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("rejects allowance minimum below MIN_SAFE_INTEGER", () => {
    expect(() =>
      prescriptionTimingAllowanceSchema.parse({
        minimumMinutesFromTarget: Number.MIN_SAFE_INTEGER - 1,
        maximumMinutesFromTarget: 0,
      }),
    ).toThrow();
  });

  it("rejects allowance maximum above MAX_SAFE_INTEGER", () => {
    expect(() =>
      prescriptionTimingAllowanceSchema.parse({
        minimumMinutesFromTarget: 0,
        maximumMinutesFromTarget: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toThrow();
  });
});

describe("prescriptionScheduleSchema — FIXED_LOCAL_TIMES", () => {
  it("accepts a single entry", () => {
    const result = prescriptionScheduleSchema.parse({
      kind: "FIXED_LOCAL_TIMES",
      entries: [{ scheduleKey: "morning", time: "08:00" }],
    });
    expect(result.kind).toBe("FIXED_LOCAL_TIMES");
  });

  it("accepts multiple entries with unique scheduleKeys", () => {
    const result = prescriptionScheduleSchema.parse({
      kind: "FIXED_LOCAL_TIMES",
      entries: [
        { scheduleKey: "morning", time: "08:00" },
        { scheduleKey: "evening", time: "20:00" },
      ],
    });
    expect(result.kind).toBe("FIXED_LOCAL_TIMES");
  });

  it("rejects duplicate scheduleKeys", () => {
    expect(() =>
      prescriptionScheduleSchema.parse({
        kind: "FIXED_LOCAL_TIMES",
        entries: [
          { scheduleKey: "morning", time: "08:00" },
          { scheduleKey: "morning", time: "20:00" },
        ],
      }),
    ).toThrow();
  });

  it("rejects an empty entries array", () => {
    expect(() =>
      prescriptionScheduleSchema.parse({
        kind: "FIXED_LOCAL_TIMES",
        entries: [],
      }),
    ).toThrow();
  });

  it("accepts an explicit timing allowance on a fixed local time", () => {
    const result = prescriptionScheduleSchema.parse({
      kind: "FIXED_LOCAL_TIMES",
      entries: [
        {
          scheduleKey: "morning",
          time: "08:00",
          explicitTimingAllowance: {
            minimumMinutesFromTarget: -5,
            maximumMinutesFromTarget: 10,
          },
        },
      ],
    });
    expect(result.kind).toBe("FIXED_LOCAL_TIMES");
  });
});

describe("prescriptionScheduleSchema — EVENT_RELATIVE", () => {
  it("accepts a TARGET_MINUTES timing with allowance", () => {
    const result = prescriptionScheduleSchema.parse({
      kind: "EVENT_RELATIVE",
      timings: [
        {
          scheduleKey: "before-breakfast",
          relation: "BEFORE",
          anchor: "BREAKFAST",
          interval: { kind: "TARGET_MINUTES", minutes: 30 },
          explicitTimingAllowance: {
            minimumMinutesFromTarget: -5,
            maximumMinutesFromTarget: 5,
          },
        },
      ],
    });
    expect(result.kind).toBe("EVENT_RELATIVE");
  });

  it("accepts UNSPECIFIED without allowance", () => {
    const result = prescriptionScheduleSchema.parse({
      kind: "EVENT_RELATIVE",
      timings: [
        {
          scheduleKey: "with-meal",
          relation: "WITH",
          anchor: "MEAL",
          interval: { kind: "UNSPECIFIED" },
        },
      ],
    });
    expect(result.kind).toBe("EVENT_RELATIVE");
  });

  it("rejects allowance on UNSPECIFIED", () => {
    expect(() =>
      prescriptionScheduleSchema.parse({
        kind: "EVENT_RELATIVE",
        timings: [
          {
            scheduleKey: "with-meal",
            relation: "WITH",
            anchor: "MEAL",
            interval: { kind: "UNSPECIFIED" },
            explicitTimingAllowance: {
              minimumMinutesFromTarget: 0,
              maximumMinutesFromTarget: 5,
            },
          },
        ],
      }),
    ).toThrow();
  });

  it("accepts WINDOW_MINUTES without allowance", () => {
    const result = prescriptionScheduleSchema.parse({
      kind: "EVENT_RELATIVE",
      timings: [
        {
          scheduleKey: "window",
          relation: "AFTER",
          anchor: "DINNER",
          interval: {
            kind: "WINDOW_MINUTES",
            minimumMinutes: 10,
            maximumMinutes: 30,
          },
        },
      ],
    });
    expect(result.kind).toBe("EVENT_RELATIVE");
  });

  it("rejects allowance on WINDOW_MINUTES", () => {
    expect(() =>
      prescriptionScheduleSchema.parse({
        kind: "EVENT_RELATIVE",
        timings: [
          {
            scheduleKey: "window",
            relation: "AFTER",
            anchor: "DINNER",
            interval: {
              kind: "WINDOW_MINUTES",
              minimumMinutes: 10,
              maximumMinutes: 30,
            },
            explicitTimingAllowance: {
              minimumMinutesFromTarget: 0,
              maximumMinutesFromTarget: 5,
            },
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects negative TARGET_MINUTES", () => {
    expect(() =>
      prescriptionScheduleSchema.parse({
        kind: "EVENT_RELATIVE",
        timings: [
          {
            scheduleKey: "neg",
            relation: "BEFORE",
            anchor: "BEDTIME",
            interval: { kind: "TARGET_MINUTES", minutes: -10 },
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects reversed WINDOW_MINUTES", () => {
    expect(() =>
      prescriptionScheduleSchema.parse({
        kind: "EVENT_RELATIVE",
        timings: [
          {
            scheduleKey: "rev",
            relation: "BEFORE",
            anchor: "LUNCH",
            interval: {
              kind: "WINDOW_MINUTES",
              minimumMinutes: 30,
              maximumMinutes: 10,
            },
          },
        ],
      }),
    ).toThrow();
  });

  it("accepts TARGET_MINUTES at MAX_SAFE_INTEGER", () => {
    const result = prescriptionScheduleSchema.parse({
      kind: "EVENT_RELATIVE",
      timings: [
        {
          scheduleKey: "max",
          relation: "AFTER",
          anchor: "DINNER",
          interval: {
            kind: "TARGET_MINUTES",
            minutes: Number.MAX_SAFE_INTEGER,
          },
        },
      ],
    });
    expect(result.kind).toBe("EVENT_RELATIVE");
  });

  it("rejects TARGET_MINUTES above MAX_SAFE_INTEGER", () => {
    expect(() =>
      prescriptionScheduleSchema.parse({
        kind: "EVENT_RELATIVE",
        timings: [
          {
            scheduleKey: "over",
            relation: "AFTER",
            anchor: "DINNER",
            interval: {
              kind: "TARGET_MINUTES",
              minutes: Number.MAX_SAFE_INTEGER + 1,
            },
          },
        ],
      }),
    ).toThrow();
  });

  it("accepts WINDOW_MINUTES at safe boundaries", () => {
    const result = prescriptionScheduleSchema.parse({
      kind: "EVENT_RELATIVE",
      timings: [
        {
          scheduleKey: "bounds",
          relation: "AFTER",
          anchor: "DINNER",
          interval: {
            kind: "WINDOW_MINUTES",
            minimumMinutes: 0,
            maximumMinutes: Number.MAX_SAFE_INTEGER,
          },
        },
      ],
    });
    expect(result.kind).toBe("EVENT_RELATIVE");
  });

  it("rejects WINDOW_MINUTES minimum above MAX_SAFE_INTEGER", () => {
    expect(() =>
      prescriptionScheduleSchema.parse({
        kind: "EVENT_RELATIVE",
        timings: [
          {
            scheduleKey: "over-min",
            relation: "AFTER",
            anchor: "DINNER",
            interval: {
              kind: "WINDOW_MINUTES",
              minimumMinutes: Number.MAX_SAFE_INTEGER + 1,
              maximumMinutes: Number.MAX_SAFE_INTEGER + 2,
            },
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects WINDOW_MINUTES maximum above MAX_SAFE_INTEGER", () => {
    expect(() =>
      prescriptionScheduleSchema.parse({
        kind: "EVENT_RELATIVE",
        timings: [
          {
            scheduleKey: "over-max",
            relation: "AFTER",
            anchor: "DINNER",
            interval: {
              kind: "WINDOW_MINUTES",
              minimumMinutes: 0,
              maximumMinutes: Number.MAX_SAFE_INTEGER + 1,
            },
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects duplicate scheduleKeys in EVENT_RELATIVE", () => {
    expect(() =>
      prescriptionScheduleSchema.parse({
        kind: "EVENT_RELATIVE",
        timings: [
          {
            scheduleKey: "dup",
            relation: "WITH",
            anchor: "MEAL",
            interval: { kind: "UNSPECIFIED" },
          },
          {
            scheduleKey: "dup",
            relation: "AFTER",
            anchor: "DINNER",
            interval: { kind: "UNSPECIFIED" },
          },
        ],
      }),
    ).toThrow();
  });
});

describe("prescriptionScheduleSchema — other kinds", () => {
  it("accepts FREQUENCY with positive integer occurrences", () => {
    const result = prescriptionScheduleSchema.parse({
      kind: "FREQUENCY",
      occurrences: 3,
      period: "DAY",
    });
    expect(result.kind).toBe("FREQUENCY");
  });

  it("rejects FREQUENCY with zero occurrences", () => {
    expect(() =>
      prescriptionScheduleSchema.parse({
        kind: "FREQUENCY",
        occurrences: 0,
        period: "DAY",
      }),
    ).toThrow();
  });

  it("rejects FREQUENCY with fractional occurrences", () => {
    expect(() =>
      prescriptionScheduleSchema.parse({
        kind: "FREQUENCY",
        occurrences: 2.5,
        period: "WEEK",
      }),
    ).toThrow();
  });

  it("rejects FREQUENCY with occurrences over MAX_SAFE_INTEGER", () => {
    expect(() =>
      prescriptionScheduleSchema.parse({
        kind: "FREQUENCY",
        occurrences: Number.MAX_SAFE_INTEGER + 1,
        period: "DAY",
      }),
    ).toThrow();
  });

  it("accepts AS_NEEDED", () => {
    expect(prescriptionScheduleSchema.parse({ kind: "AS_NEEDED" }).kind).toBe(
      "AS_NEEDED",
    );
  });

  it("accepts CONTINUOUS", () => {
    expect(
      prescriptionScheduleSchema.parse({ kind: "CONTINUOUS" }).kind,
    ).toBe("CONTINUOUS");
  });

  it("accepts UNSTRUCTURED", () => {
    expect(
      prescriptionScheduleSchema.parse({ kind: "UNSTRUCTURED" }).kind,
    ).toBe("UNSTRUCTURED");
  });
});

describe("prescriptionScheduleSchema — strict-object rejection", () => {
  it("rejects unknown keys on FIXED_LOCAL_TIMES", () => {
    expect(() =>
      prescriptionScheduleSchema.parse({
        kind: "FIXED_LOCAL_TIMES",
        entries: [{ scheduleKey: "m", time: "08:00" }],
        extra: true,
      }),
    ).toThrow();
  });

  it("rejects unknown schedule kind", () => {
    expect(() =>
      prescriptionScheduleSchema.parse({ kind: "PRN" }),
    ).toThrow();
  });
});