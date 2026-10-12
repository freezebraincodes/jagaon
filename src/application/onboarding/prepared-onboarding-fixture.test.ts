import { describe, expect, it } from "vitest";
import { createPreparedOnboardingState } from "./prepared-onboarding-fixture";
import { parseDemoOnboardingState } from "./demo-onboarding-contracts";
import { findDemoCatalogueEntry } from "./demo-medicine-catalogue";

describe("prepared onboarding fixture", () => {
  it("is one complete, valid, synthetic setup in the chosen locale", () => {
    const state = createPreparedOnboardingState("zh-SG", "2026-10-02T08:00:00.000Z");
    expect(parseDemoOnboardingState(state)).toEqual({ ok: true, state });
    expect(state.status).toBe("COMPLETED");
    expect(state.lastCompletedStep).toBe("REVIEW");
    expect(state.locale).toBe("zh-SG");
    // Owner decision 2026-10-12: names carry no "(demo)" suffix.
    expect(state.preferredName).toBe("Mdm Tan");
  });

  it("uses the same fictional catalogue and evidence mappings as the manual flow", () => {
    const state = createPreparedOnboardingState("en-SG", "2026-10-02T08:00:00.000Z");
    expect(state.medicines.map((m) => m.displayName)).toEqual(["Nocturin pen", "Veltora pen"]);
    for (const medicine of state.medicines) {
      const entry = findDemoCatalogueEntry(medicine.catalogueKey)!;
      expect(medicine.genericName).toBe(entry.genericName);
      expect(medicine.reviewedContentKey).toBe(entry.reviewedContentKey);
      // Owner decision 2026-10-12: names carry no "(demo)" suffix; the fictional
      // catalogue entry ("-demo" key) and "(demo label)" directions remain the proof.
      expect(medicine.displayName).toBe(entry.displayName);
      expect(medicine.catalogueKey).toMatch(/-demo$/);
      expect(medicine.verbatimDirections).toMatch(/\(demo label\)$/);
    }
  });

  it("is frozen and returns the same medicine identities each time", () => {
    const a = createPreparedOnboardingState("en-SG", "2026-10-02T08:00:00.000Z");
    const b = createPreparedOnboardingState("en-SG", "2026-10-03T08:00:00.000Z");
    expect(Object.isFrozen(a.medicines)).toBe(true);
    expect(a.medicines.map((m) => m.id)).toEqual(b.medicines.map((m) => m.id));
  });
});
