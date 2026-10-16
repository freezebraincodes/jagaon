import { describe, expect, it } from "vitest";
import {
  DEMO_ONBOARDING_ROUTES,
  DEMO_ONBOARDING_STEPS,
  nextDemoOnboardingStep,
  parseDemoOnboardingState,
  stepNumber,
  type DemoOnboardingMedicine,
  type DemoOnboardingStateV1,
} from "./demo-onboarding-contracts";

const medicine: DemoOnboardingMedicine = {
  id: "11111111-1111-4111-8111-111111111111",
  catalogueKey: "lantus-demo",
  enteredName: "Lantus",
  displayName: "Lantus",
  genericName: "insulin glargine",
  form: "Pre-filled pen",
  strength: null,
  amountAndUnit: "12 units",
  scheduleOrTiming: "Daily · 9:00 pm",
  effectiveDate: null,
  verbatimDirections: "Inject 12 units every night at 9 pm (demo label)",
  source: "PRESCRIPTION_LABEL",
  reviewedContentKey: "insulin-glargine",
};

const valid: DemoOnboardingStateV1 = {
  schemaVersion: 1,
  status: "IN_PROGRESS",
  lastCompletedStep: "DIRECTIONS",
  locale: "en-SG",
  preferredName: "Mdm Tan",
  medicines: [medicine],
  updatedAt: "2026-10-02T08:00:00.000Z",
};

function rejects(raw: unknown) {
  expect(parseDemoOnboardingState(raw)).toEqual({ ok: false });
}

describe("demo onboarding contracts", () => {
  it("exposes the closed route and step sets", () => {
    expect(DEMO_ONBOARDING_ROUTES).toEqual([
      "WELCOME",
      "PROFILE",
      "MEDICINES",
      "ADD_MEDICINE",
      "DIRECTIONS",
      "REVIEW",
      "COMPLETE",
      "RESUME",
      "SKIPPED",
      "STORAGE_FAILURE",
    ]);
    expect(DEMO_ONBOARDING_STEPS).toEqual(["PROFILE", "MEDICINES", "ADD_MEDICINE", "DIRECTIONS", "REVIEW"]);
    expect(Object.isFrozen(DEMO_ONBOARDING_ROUTES)).toBe(true);
    expect(Object.isFrozen(DEMO_ONBOARDING_STEPS)).toBe(true);
    expect(DEMO_ONBOARDING_STEPS.map(stepNumber)).toEqual([1, 2, 3, 4, 5]);
  });

  it("computes the next step from the last persisted step", () => {
    expect(nextDemoOnboardingStep(null)).toBe("PROFILE");
    expect(nextDemoOnboardingStep("PROFILE")).toBe("MEDICINES");
    expect(nextDemoOnboardingStep("MEDICINES")).toBe("ADD_MEDICINE");
    expect(nextDemoOnboardingStep("ADD_MEDICINE")).toBe("DIRECTIONS");
    expect(nextDemoOnboardingStep("DIRECTIONS")).toBe("REVIEW");
    expect(nextDemoOnboardingStep("REVIEW")).toBe("REVIEW");
  });

  it("parses a valid state and keeps entered text verbatim", () => {
    const parsed = parseDemoOnboardingState(structuredClone(valid));
    expect(parsed).toEqual({ ok: true, state: valid });
  });

  it("accepts skipped, completed and nameless states with unknown optional fields", () => {
    expect(parseDemoOnboardingState({ ...valid, status: "SKIPPED", medicines: [] }).ok).toBe(true);
    expect(parseDemoOnboardingState({ ...valid, status: "COMPLETED", preferredName: null }).ok).toBe(true);
    expect(
      parseDemoOnboardingState({
        ...valid,
        medicines: [
          {
            ...medicine,
            id: "22222222-2222-4222-8222-222222222222",
            catalogueKey: null,
            enteredName: "Oxatril (demo)",
            displayName: "Oxatril (demo)",
            genericName: null,
            form: null,
            amountAndUnit: null,
            scheduleOrTiming: null,
            verbatimDirections: null,
            source: "UNKNOWN",
            reviewedContentKey: null,
          },
        ],
      }).ok,
    ).toBe(true);
  });

  it("rejects unknown versions, unknown keys and invalid enumerations", () => {
    rejects(null);
    rejects("not an object");
    rejects({ ...valid, schemaVersion: 2 });
    rejects({ ...valid, extra: true });
    rejects({ ...valid, locale: "fr-FR" });
    rejects({ ...valid, status: "DONE" });
    rejects({ ...valid, lastCompletedStep: "WELCOME" });
    rejects({ ...valid, medicines: [{ ...medicine, extra: 1 }] });
    rejects({ ...valid, medicines: [{ ...medicine, source: "DOCTOR" }] });
  });

  it("rejects invalid timestamps, blank names and duplicate medicine IDs", () => {
    rejects({ ...valid, updatedAt: "yesterday" });
    rejects({ ...valid, updatedAt: "2026-13-40T99:00:00.000Z" });
    rejects({ ...valid, preferredName: "   " });
    rejects({ ...valid, medicines: [{ ...medicine, enteredName: " " }] });
    rejects({ ...valid, medicines: [{ ...medicine, displayName: "" }] });
    rejects({ ...valid, medicines: [{ ...medicine, id: "not-a-uuid" }] });
    rejects({ ...valid, medicines: [medicine, { ...medicine }] });
  });

  it("rejects unsupported catalogue keys and reviewed content that does not match the catalogue", () => {
    rejects({ ...valid, medicines: [{ ...medicine, catalogueKey: "demo-glargine" }] });
    rejects({ ...valid, medicines: [{ ...medicine, reviewedContentKey: "insulin-glulisine" }] });
    rejects({ ...valid, medicines: [{ ...medicine, genericName: "demo-glargine" }] });
    rejects({
      ...valid,
      medicines: [{ ...medicine, catalogueKey: null, reviewedContentKey: "insulin-glargine" }],
    });
    rejects({
      ...valid,
      medicines: [{ ...medicine, catalogueKey: "glucotab-demo", genericName: null, reviewedContentKey: "insulin-glargine" }],
    });
  });

  it("binds every catalogue identity field to the exact frozen entry", () => {
    rejects({ ...valid, medicines: [{ ...medicine, enteredName: "Aspirin" }] });
    rejects({ ...valid, medicines: [{ ...medicine, displayName: "Aspirin" }] });
  });

  it("keeps free-text medicines free of catalogue-derived identity", () => {
    const freeText = {
      ...medicine,
      catalogueKey: null,
      enteredName: "Oxatril (demo)",
      displayName: "Oxatril (demo)",
      genericName: null,
      reviewedContentKey: null,
    };
    expect(parseDemoOnboardingState({ ...valid, medicines: [freeText] }).ok).toBe(true);
    rejects({ ...valid, medicines: [{ ...freeText, genericName: "insulin glargine" }] });
    rejects({ ...valid, medicines: [{ ...freeText, reviewedContentKey: "insulin-glargine" }] });
  });

  it("rejects over-long text instead of truncating it", () => {
    rejects({ ...valid, preferredName: "x".repeat(81) });
    rejects({ ...valid, medicines: [{ ...medicine, verbatimDirections: "x".repeat(1001) }] });
  });
});
