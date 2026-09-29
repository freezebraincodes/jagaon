import { describe, it, expect } from "vitest";
import {
  patientPreferencePayloadSchema,
  DEFAULT_GLUCOSE_DISPLAY_UNIT,
  type PatientPreferencePayload,
} from "./preferences";

describe("DEFAULT_GLUCOSE_DISPLAY_UNIT", () => {
  it("is exactly MMOL_L", () => {
    expect(DEFAULT_GLUCOSE_DISPLAY_UNIT).toBe("MMOL_L");
  });
});

describe("patientPreferencePayloadSchema — LANGUAGE", () => {
  it("accepts en-SG", () => {
    const result = patientPreferencePayloadSchema.parse({
      kind: "LANGUAGE",
      locale: "en-SG",
    });
    expect(result).toEqual({ kind: "LANGUAGE", locale: "en-SG" });
  });

  it("accepts zh-SG", () => {
    const result = patientPreferencePayloadSchema.parse({
      kind: "LANGUAGE",
      locale: "zh-SG",
    });
    expect(result).toEqual({ kind: "LANGUAGE", locale: "zh-SG" });
  });

  it("rejects an invalid locale", () => {
    expect(() =>
      patientPreferencePayloadSchema.parse({
        kind: "LANGUAGE",
        locale: "en-US",
      }),
    ).toThrow();
  });
});

describe("patientPreferencePayloadSchema — GLUCOSE_DISPLAY_UNIT", () => {
  it("accepts MMOL_L", () => {
    expect(
      patientPreferencePayloadSchema.parse({
        kind: "GLUCOSE_DISPLAY_UNIT",
        unit: "MMOL_L",
      }),
    ).toEqual({ kind: "GLUCOSE_DISPLAY_UNIT", unit: "MMOL_L" });
  });

  it("accepts MG_DL", () => {
    expect(
      patientPreferencePayloadSchema.parse({
        kind: "GLUCOSE_DISPLAY_UNIT",
        unit: "MG_DL",
      }),
    ).toEqual({ kind: "GLUCOSE_DISPLAY_UNIT", unit: "MG_DL" });
  });

  it("rejects an invalid unit", () => {
    expect(() =>
      patientPreferencePayloadSchema.parse({
        kind: "GLUCOSE_DISPLAY_UNIT",
        unit: "G_L",
      }),
    ).toThrow();
  });
});

describe("patientPreferencePayloadSchema — ACCESSIBILITY", () => {
  it("accepts all textScale, contrast, and reducedMotion values", () => {
    const result = patientPreferencePayloadSchema.parse({
      kind: "ACCESSIBILITY",
      textScale: "LARGE",
      contrast: "HIGH",
      reducedMotion: true,
    });
    expect(result).toEqual({
      kind: "ACCESSIBILITY",
      textScale: "LARGE",
      contrast: "HIGH",
      reducedMotion: true,
    });
  });

  it("accepts STANDARD textScale with STANDARD contrast and false reducedMotion", () => {
    const result = patientPreferencePayloadSchema.parse({
      kind: "ACCESSIBILITY",
      textScale: "STANDARD",
      contrast: "STANDARD",
      reducedMotion: false,
    });
    if (result.kind === "ACCESSIBILITY") {
      expect(result.reducedMotion).toBe(false);
    }
  });

  it("rejects an invalid textScale", () => {
    expect(() =>
      patientPreferencePayloadSchema.parse({
        kind: "ACCESSIBILITY",
        textScale: "TINY",
        contrast: "STANDARD",
        reducedMotion: false,
      }),
    ).toThrow();
  });

  it("rejects an invalid contrast", () => {
    expect(() =>
      patientPreferencePayloadSchema.parse({
        kind: "ACCESSIBILITY",
        textScale: "STANDARD",
        contrast: "LOW",
        reducedMotion: false,
      }),
    ).toThrow();
  });

  it("rejects a missing reducedMotion", () => {
    expect(() =>
      patientPreferencePayloadSchema.parse({
        kind: "ACCESSIBILITY",
        textScale: "STANDARD",
        contrast: "STANDARD",
      }),
    ).toThrow();
  });
});

describe("patientPreferencePayloadSchema — HOME_TIME_ZONE", () => {
  it("accepts a valid IANA timezone identifier", () => {
    const result = patientPreferencePayloadSchema.parse({
      kind: "HOME_TIME_ZONE",
      timeZoneId: "Asia/Singapore",
    });
    expect(result).toEqual({ kind: "HOME_TIME_ZONE", timeZoneId: "Asia/Singapore" });
  });

  it("accepts another valid IANA timezone identifier", () => {
    const result = patientPreferencePayloadSchema.parse({
      kind: "HOME_TIME_ZONE",
      timeZoneId: "Europe/London",
    });
    expect(result).toEqual({ kind: "HOME_TIME_ZONE", timeZoneId: "Europe/London" });
  });

  it("rejects an invalid timezone identifier", () => {
    expect(() =>
      patientPreferencePayloadSchema.parse({
        kind: "HOME_TIME_ZONE",
        timeZoneId: "Fake/Zone",
      }),
    ).toThrow();
  });
});

describe("patientPreferencePayloadSchema — COMMUNICATION", () => {
  it("accepts STANDARD without quiet hours", () => {
    const result = patientPreferencePayloadSchema.parse({
      kind: "COMMUNICATION",
      ordinaryPromptLevel: "STANDARD",
    });
    expect(result).toEqual({ kind: "COMMUNICATION", ordinaryPromptLevel: "STANDARD" });
  });

  it("accepts REDUCED with quiet hours", () => {
    const result = patientPreferencePayloadSchema.parse({
      kind: "COMMUNICATION",
      ordinaryPromptLevel: "REDUCED",
      quietHours: { startLocalTime: "22:00", endLocalTime: "07:00" },
    });
    expect(result).toEqual({
      kind: "COMMUNICATION",
      ordinaryPromptLevel: "REDUCED",
      quietHours: { startLocalTime: "22:00", endLocalTime: "07:00" },
    });
  });

  it("accepts PAUSED", () => {
    const result = patientPreferencePayloadSchema.parse({
      kind: "COMMUNICATION",
      ordinaryPromptLevel: "PAUSED",
    });
    if (result.kind === "COMMUNICATION") {
      expect(result.ordinaryPromptLevel).toBe("PAUSED");
    }
  });

  it("rejects equal quiet-hour start and end", () => {
    expect(() =>
      patientPreferencePayloadSchema.parse({
        kind: "COMMUNICATION",
        ordinaryPromptLevel: "REDUCED",
        quietHours: { startLocalTime: "22:00", endLocalTime: "22:00" },
      }),
    ).toThrow();
  });

  it("accepts a quiet-hour window that crosses midnight", () => {
    expect(() =>
      patientPreferencePayloadSchema.parse({
        kind: "COMMUNICATION",
        ordinaryPromptLevel: "REDUCED",
        quietHours: { startLocalTime: "23:00", endLocalTime: "06:00" },
      }),
    ).not.toThrow();
  });

  it("rejects an invalid HH:mm format", () => {
    expect(() =>
      patientPreferencePayloadSchema.parse({
        kind: "COMMUNICATION",
        ordinaryPromptLevel: "REDUCED",
        quietHours: { startLocalTime: "25:00", endLocalTime: "07:00" },
      }),
    ).toThrow();
  });

  it("rejects a missing ordinaryPromptLevel", () => {
    expect(() =>
      patientPreferencePayloadSchema.parse({
        kind: "COMMUNICATION",
      }),
    ).toThrow();
  });

  it("rejects unknown keys", () => {
    expect(() =>
      patientPreferencePayloadSchema.parse({
        kind: "COMMUNICATION",
        ordinaryPromptLevel: "STANDARD",
        extra: true,
      }),
    ).toThrow();
  });

  it("rejects a suppressEmergency field on COMMUNICATION", () => {
    expect(() =>
      patientPreferencePayloadSchema.parse({
        kind: "COMMUNICATION",
        ordinaryPromptLevel: "STANDARD",
        suppressEmergency: true,
      }),
    ).toThrow();
  });

  it("rejects a suppressSafety field on COMMUNICATION", () => {
    expect(() =>
      patientPreferencePayloadSchema.parse({
        kind: "COMMUNICATION",
        ordinaryPromptLevel: "STANDARD",
        suppressSafety: true,
      }),
    ).toThrow();
  });
});