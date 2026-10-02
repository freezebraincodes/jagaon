import { describe, it, expect } from "vitest";
import {
  createDemoScenarioFixture,
  DEMO_DISPLAY_NAME,
  DEMO_DISPLAY_NAME_ZH,
} from "./demo-scenario-fixture";

describe("demo-scenario-fixture", () => {
  const fixture = createDemoScenarioFixture();

  it("provides a synthetic display name", () => {
    expect(fixture.displayName).toBe(DEMO_DISPLAY_NAME);
    expect(fixture.displayNameZh).toBe(DEMO_DISPLAY_NAME_ZH);
  });

  it("defaults to en-SG locale", () => {
    expect(fixture.defaultLocale).toBe("en-SG");
  });

  it("has exactly two recorded prescriptions (glargine + aspart)", () => {
    expect(fixture.recordedPrescriptions).toHaveLength(2);
    expect(
      fixture.recordedPrescriptions.some(
        (p) => p.medicationId === "insulin-glargine",
      ),
    ).toBe(true);
    expect(
      fixture.recordedPrescriptions.some(
        (p) => p.medicationId === "insulin-aspart",
      ),
    ).toBe(true);
  });

  it("recorded directions are verbatim patient-entered text", () => {
    const glargine = fixture.recordedPrescriptions.find(
      (p) => p.medicationId === "insulin-glargine",
    )!;
    expect(glargine.recordedDirection).toContain("12 units");
    expect(glargine.recordedDirection).not.toContain("Translate");
  });

  it("keeps usual foods, activity and care dates as synthetic data only", () => {
    expect(fixture.usualFoods.map((food) => food.label)).toContain("Kaya toast");
    for (const food of fixture.usualFoods) {
      // A usual only carries the text the person would type; no nutrition data.
      expect(Object.keys(food).sort()).toEqual(["id", "kind", "label", "quantityText"]);
    }
    expect(fixture.activity.place).toContain("(demo)");
    for (const date of fixture.careDates) {
      expect(Object.keys(date).sort()).toEqual(["enteredDateText", "id", "kind", "label"]);
    }
  });

  it("does not provide a zh-SG translation of recorded directions", () => {
    // Recorded text is not automatically translated
    const glargine = fixture.recordedPrescriptions.find(
      (p) => p.medicationId === "insulin-glargine",
    )!;
    // The direction should be English (not translated to Chinese)
    expect(glargine.recordedDirection).toMatch(/Inject.*units/);
  });
});
