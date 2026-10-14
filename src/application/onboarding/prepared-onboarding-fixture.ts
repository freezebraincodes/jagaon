import type { DemoOnboardingMedicine, DemoOnboardingStateV1 } from "./demo-onboarding-contracts";
import { findDemoCatalogueEntry, type DemoCatalogueKey } from "./demo-medicine-catalogue";

/**
 * The one prepared synthetic setup offered on Welcome. It uses the same
 * fictional catalogue and governed mappings as the manual flow, and every
 * value is invented for the demo.
 */

function fromCatalogue(
  key: DemoCatalogueKey,
  facts: Omit<
    DemoOnboardingMedicine,
    "catalogueKey" | "enteredName" | "displayName" | "genericName" | "reviewedContentKey"
  >,
): DemoOnboardingMedicine {
  const entry = findDemoCatalogueEntry(key)!;
  return Object.freeze({
    ...facts,
    catalogueKey: entry.key,
    enteredName: entry.displayName,
    displayName: entry.displayName,
    genericName: entry.genericName,
    reviewedContentKey: entry.reviewedContentKey,
  });
}

const PREPARED_MEDICINES: readonly DemoOnboardingMedicine[] = Object.freeze([
  fromCatalogue("lantus-demo", {
    id: "00000000-0000-4000-8000-000000000101",
    form: "Pre-filled pen",
    strength: "100 units/mL",
    amountAndUnit: "12 units",
    scheduleOrTiming: "Daily · 9:00 pm",
    effectiveDate: "12 Aug 2026",
    verbatimDirections: "Inject 12 units every night at 9 pm (demo label)",
    source: "PRESCRIPTION_LABEL",
  }),
  fromCatalogue("apidra-demo", {
    id: "00000000-0000-4000-8000-000000000103",
    form: "Pre-filled pen",
    strength: "100 units/mL",
    amountAndUnit: "6 units",
    scheduleOrTiming: "With meals",
    effectiveDate: "12 Aug 2026",
    verbatimDirections: "Inject 6 units with meals (demo label)",
    source: "CARE_TEAM_DIRECTIONS",
  }),
]);

export const PREPARED_PREFERRED_NAME = "Mdm Tan";

export function createPreparedOnboardingState(
  locale: DemoOnboardingStateV1["locale"],
  updatedAt: string,
): DemoOnboardingStateV1 {
  return Object.freeze({
    schemaVersion: 1,
    status: "COMPLETED",
    lastCompletedStep: "REVIEW",
    locale,
    preferredName: PREPARED_PREFERRED_NAME,
    medicines: PREPARED_MEDICINES as DemoOnboardingMedicine[],
    updatedAt,
  });
}
