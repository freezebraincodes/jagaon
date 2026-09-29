import { describe, it, expect } from "vitest";
import {
  activityEventPayloadSchema,
  ACTIVITY_EVENT_REVISION_ACTIONS,
} from "./activity-event";

describe("activityEventPayloadSchema", () => {
  it("accepts chair yoga with FLEXIBILITY_OR_MOBILITY and patientLabel", () => {
    const result = activityEventPayloadSchema.parse({
      activityCategory: "FLEXIBILITY_OR_MOBILITY",
      patientLabel: "Chair yoga",
    });
    expect(result.activityCategory).toBe("FLEXIBILITY_OR_MOBILITY");
    expect(result.patientLabel).toBe("Chair yoga");
  });

  it("preserves patient label independently from broad category", () => {
    const result = activityEventPayloadSchema.parse({
      activityCategory: "FLEXIBILITY_OR_MOBILITY",
      patientLabel: "Tai chi",
    });
    expect(result.patientLabel).toBe("Tai chi");
    expect(result.activityCategory).toBe("FLEXIBILITY_OR_MOBILITY");
  });

  it("accepts a walk without duration or intensity (optionality)", () => {
    const result = activityEventPayloadSchema.parse({
      activityCategory: "WALKING",
      patientLabel: "Morning walk",
    });
    expect(result.patientReportedIntensity).toBeUndefined();
    expect(result.reportedDurationMinutes).toBeUndefined();
  });

  it("accepts an optional intensity", () => {
    const result = activityEventPayloadSchema.parse({
      activityCategory: "WALKING",
      patientLabel: "Morning walk",
      patientReportedIntensity: "MODERATE",
    });
    expect(result.patientReportedIntensity).toBe("MODERATE");
  });

  it("accepts a positive safe-integer duration", () => {
    const result = activityEventPayloadSchema.parse({
      activityCategory: "WALKING",
      patientLabel: "Morning walk",
      reportedDurationMinutes: 30,
    });
    expect(result.reportedDurationMinutes).toBe(30);
  });

  it("rejects a zero duration", () => {
    expect(() =>
      activityEventPayloadSchema.parse({
        activityCategory: "WALKING",
        patientLabel: "Walk",
        reportedDurationMinutes: 0,
      }),
    ).toThrow();
  });

  it("rejects a negative duration", () => {
    expect(() =>
      activityEventPayloadSchema.parse({
        activityCategory: "WALKING",
        patientLabel: "Walk",
        reportedDurationMinutes: -5,
      }),
    ).toThrow();
  });

  it("rejects a non-integer duration", () => {
    expect(() =>
      activityEventPayloadSchema.parse({
        activityCategory: "WALKING",
        patientLabel: "Walk",
        reportedDurationMinutes: 30.5,
      }),
    ).toThrow();
  });

  it("accepts exactly Number.MAX_SAFE_INTEGER duration", () => {
    const result = activityEventPayloadSchema.parse({
      activityCategory: "WALKING",
      patientLabel: "Walk",
      reportedDurationMinutes: Number.MAX_SAFE_INTEGER,
    });
    expect(result.reportedDurationMinutes).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("rejects a duration greater than Number.MAX_SAFE_INTEGER", () => {
    expect(() =>
      activityEventPayloadSchema.parse({
        activityCategory: "WALKING",
        patientLabel: "Walk",
        reportedDurationMinutes: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toThrow();
  });

  it("accepts an optional patientNote", () => {
    const result = activityEventPayloadSchema.parse({
      activityCategory: "STRENGTH",
      patientLabel: "Light dumbbells",
      patientNote: { text: "Felt good", language: "en-SG" },
    });
    expect(result.patientNote!.text).toBe("Felt good");
  });

  it("rejects unknown keys on the payload", () => {
    expect(() =>
      activityEventPayloadSchema.parse({
        activityCategory: "WALKING",
        patientLabel: "Walk",
        extra: true,
      }),
    ).toThrow();
  });

  it("rejects an invalid activity category", () => {
    expect(() =>
      activityEventPayloadSchema.parse({
        activityCategory: "RUNNING",
        patientLabel: "Jog",
      }),
    ).toThrow();
  });

  it("rejects an invalid intensity", () => {
    expect(() =>
      activityEventPayloadSchema.parse({
        activityCategory: "WALKING",
        patientLabel: "Walk",
        patientReportedIntensity: "EXTREME",
      }),
    ).toThrow();
  });

  it("rejects a missing patientLabel", () => {
    expect(() =>
      activityEventPayloadSchema.parse({
        activityCategory: "WALKING",
      }),
    ).toThrow();
  });

  it("rejects leading whitespace on patientLabel", () => {
    expect(() =>
      activityEventPayloadSchema.parse({
        activityCategory: "WALKING",
        patientLabel: "  Morning walk",
      }),
    ).toThrow();
  });

  it("rejects trailing whitespace on patientLabel", () => {
    expect(() =>
      activityEventPayloadSchema.parse({
        activityCategory: "WALKING",
        patientLabel: "Morning walk  ",
      }),
    ).toThrow();
  });

  it("rejects patientLabel over 1000 Unicode code points", () => {
    expect(() =>
      activityEventPayloadSchema.parse({
        activityCategory: "WALKING",
        patientLabel: "x".repeat(1001),
      }),
    ).toThrow();
  });

  it("accepts patientLabel of exactly 1000 Unicode code points", () => {
    const result = activityEventPayloadSchema.parse({
      activityCategory: "WALKING",
      patientLabel: "x".repeat(1000),
    });
    expect(result.patientLabel).toHaveLength(1000);
  });
});

describe("ACTIVITY_EVENT_REVISION_ACTIONS", () => {
  it("has exactly CREATE, CORRECT, CONFIRM", () => {
    expect(ACTIVITY_EVENT_REVISION_ACTIONS).toEqual([
      "CREATE",
      "CORRECT",
      "CONFIRM",
    ]);
  });

  it("does not include SYSTEM_DERIVE", () => {
    expect(ACTIVITY_EVENT_REVISION_ACTIONS).not.toContain("SYSTEM_DERIVE");
  });
});