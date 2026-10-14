import { describe, it, expect } from "vitest";
import { createDemoScenarioFixture } from "./demo-scenario-fixture";
import { createPreparedOnboardingState } from "@/application/onboarding/prepared-onboarding-fixture";
import type { DemoOnboardingStateV1 } from "@/application/onboarding/demo-onboarding-contracts";

const NOW = "2026-10-02T08:00:00.000Z";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("demo-scenario-fixture", () => {
  const fixture = createDemoScenarioFixture();

  it("defaults to the prepared synthetic profile", () => {
    expect(fixture.displayName).toBe("Mdm Tan");
    expect(fixture.displayNameZh).toBe("Mdm Tan");
    expect(fixture.defaultLocale).toBe("en-SG");
    expect(fixture.recordedPrescriptions.map((p) => p.displayName)).toEqual([
      "Lantus",
      "Apidra",
    ]);
  });

  it("uses governed content keys only for the exact catalogue mappings", () => {
    const [lantus, apidra] = fixture.recordedPrescriptions;
    expect(lantus).toMatchObject({ medicationId: "insulin-glargine", genericName: "insulin glargine", hasReviewedInfo: true });
    expect(apidra).toMatchObject({ medicationId: "insulin-glulisine", genericName: "insulin glulisine", hasReviewedInfo: true });
  });

  it("projects a completed setup verbatim, leaving unknown facts null", () => {
    const state: DemoOnboardingStateV1 = {
      ...createPreparedOnboardingState("zh-SG", NOW),
      preferredName: "陈女士（示例）",
      medicines: [
        {
          id: "55555555-5555-4555-8555-555555555555",
          catalogueKey: null,
          enteredName: "Oxatril (demo)",
          displayName: "Oxatril (demo)",
          genericName: null,
          form: null,
          strength: null,
          amountAndUnit: null,
          scheduleOrTiming: null,
          effectiveDate: null,
          verbatimDirections: "Take as written on my label",
          source: "PATIENT_ENTERED",
          reviewedContentKey: null,
        },
      ],
    };
    const projected = createDemoScenarioFixture(state);
    expect(projected.displayName).toBe("陈女士（示例）");
    expect(projected.displayNameZh).toBe("陈女士（示例）");
    expect(projected.defaultLocale).toBe("zh-SG");
    const [oxatril] = projected.recordedPrescriptions;
    expect(oxatril).toMatchObject({
      displayName: "Oxatril (demo)",
      genericName: null,
      amountText: null,
      timingText: null,
      scheduledTime: null,
      recordedDirection: "Take as written on my label",
      source: "PATIENT_ENTERED",
      hasReviewedInfo: false,
    });
    // Never resolves to governed content for free text.
    expect(oxatril!.medicationId).not.toMatch(/^insulin-/);
    expect(oxatril!.medicationRecordId).toMatch(UUID_V4);
    expect(oxatril!.medicationRevisionId).toMatch(UUID_V4);
    expect(oxatril!.medicationRevisionId).not.toBe(oxatril!.medicationRecordId);
  });

  it("projects a skipped setup with no medicines and no greeting name", () => {
    const projected = createDemoScenarioFixture({
      schemaVersion: 1,
      status: "SKIPPED",
      lastCompletedStep: null,
      locale: "en-SG",
      preferredName: null,
      medicines: [],
      updatedAt: NOW,
    });
    expect(projected.recordedPrescriptions).toEqual([]);
    expect(projected.displayName).toBeNull();
  });

  it("keeps the unrelated synthetic meal, activity and care-date fixtures unchanged", () => {
    const skipped = createDemoScenarioFixture({ ...createPreparedOnboardingState("en-SG", NOW), status: "SKIPPED" });
    expect(skipped.usualFoods).toBe(fixture.usualFoods);
    expect(skipped.activity).toBe(fixture.activity);
    expect(skipped.careDates).toBe(fixture.careDates);
    expect(fixture.usualFoods.map((food) => food.label)).toContain("Kaya toast");
    for (const food of fixture.usualFoods) {
      expect(Object.keys(food).sort()).toEqual(["id", "kind", "label", "quantityText"]);
    }
    // Owner decision 2026-10-12: names carry no "(demo)" suffix.
    expect(fixture.activity).toEqual({ title: "Morning walk", place: "Jelutong Park", minutes: 28 });
  });

  it("does not translate recorded directions", () => {
    const zh = createDemoScenarioFixture(createPreparedOnboardingState("zh-SG", NOW));
    expect(zh.recordedPrescriptions[0]!.recordedDirection).toBe("Inject 12 units every night at 9 pm (demo label)");
  });
});
