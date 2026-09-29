import { describe, it, expect } from "vitest";
import { coreLoggingObservations } from "./core-logging-observations";

describe("coreLoggingObservations fixtures", () => {
  it("exports a readonly object", () => {
    expect(Object.isFrozen(coreLoggingObservations)).toBe(true);
  });

  it("ad-hoc snack has no reason and no slot", () => {
    const snack = coreLoggingObservations.adHocSnack;
    expect(snack.intakeKind).toBe("SNACK");
    expect(snack.reason).toBeUndefined();
    expect(snack.intakeSlot).toBeUndefined();
    expect(snack.occasion).toBe("AD_HOC");
  });

  it("tea with unknown food preserves UNKNOWN", () => {
    expect(coreLoggingObservations.teaWithUnknownFood.foodIncluded).toBe("UNKNOWN");
    expect(coreLoggingObservations.teaWithUnknownFood.drinkIncluded).toBe("YES");
  });

  it("tea without food preserves NO", () => {
    expect(coreLoggingObservations.teaWithoutFood.foodIncluded).toBe("NO");
  });

  it("tea with food preserves YES", () => {
    expect(coreLoggingObservations.teaWithFood.foodIncluded).toBe("YES");
  });

  it("keeps the three tea food states distinct", () => {
    const states = new Set([
      coreLoggingObservations.teaWithUnknownFood.foodIncluded,
      coreLoggingObservations.teaWithoutFood.foodIncluded,
      coreLoggingObservations.teaWithFood.foodIncluded,
    ]);
    expect(states.size).toBe(3);
  });

  it("present emergency symptom report has no optional fields", () => {
    const report = coreLoggingObservations.presentEmergencySymptom;
    expect(report.reportKind).toBe("PRESENT");
  });

  it("chair yoga retains its label with FLEXIBILITY_OR_MOBILITY", () => {
    const activity = coreLoggingObservations.chairYoga;
    expect(activity.patientLabel).toBe("Chair yoga");
    expect(activity.activityCategory).toBe("FLEXIBILITY_OR_MOBILITY");
  });
});