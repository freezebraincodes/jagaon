import {
  furthestStep,
  type DemoOnboardingMedicine,
  type DemoOnboardingStateV1,
  type DemoOnboardingStep,
} from "./demo-onboarding-contracts";
import { findDemoCatalogueEntry, type DemoCatalogueKey } from "./demo-medicine-catalogue";

/**
 * Pure edits of the onboarding presentation state. Every function returns a
 * new state; the caller persists it and only then moves on.
 */

export type MedicineChoice =
  | { kind: "CATALOGUE"; key: DemoCatalogueKey }
  | { kind: "FREE_TEXT"; name: string };

export type RecordedFacts = Pick<
  DemoOnboardingMedicine,
  "form" | "strength" | "amountAndUnit" | "scheduleOrTiming" | "effectiveDate" | "verbatimDirections" | "source"
>;

export function emptyOnboardingState(
  locale: DemoOnboardingStateV1["locale"],
  updatedAt: string,
): DemoOnboardingStateV1 {
  return {
    schemaVersion: 1,
    status: "IN_PROGRESS",
    lastCompletedStep: null,
    locale,
    preferredName: null,
    medicines: [],
    updatedAt,
  };
}

/** Outer whitespace is trimmed; a blank name means "not provided". */
export function normalisePreferredName(name: string): string | null {
  const trimmed = name.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * A catalogue choice carries only the catalogue's own identity and governed
 * mapping; a free-text name carries nothing else. No prescription fact is
 * pre-filled in either case.
 */
export function medicineFromChoice(choice: MedicineChoice, id: string): DemoOnboardingMedicine {
  const entry = choice.kind === "CATALOGUE" ? findDemoCatalogueEntry(choice.key) : null;
  const name = entry ? entry.displayName : (choice as { name: string }).name.trim();
  return {
    id,
    catalogueKey: entry?.key ?? null,
    enteredName: name,
    displayName: name,
    genericName: entry?.genericName ?? null,
    form: null,
    strength: null,
    amountAndUnit: null,
    scheduleOrTiming: null,
    effectiveDate: null,
    verbatimDirections: null,
    source: "UNKNOWN",
    reviewedContentKey: entry?.reviewedContentKey ?? null,
  };
}

export function withStep(state: DemoOnboardingStateV1, step: DemoOnboardingStep): DemoOnboardingStateV1 {
  return { ...state, lastCompletedStep: furthestStep(state.lastCompletedStep, step) };
}

export function addMedicine(state: DemoOnboardingStateV1, medicine: DemoOnboardingMedicine): DemoOnboardingStateV1 {
  return { ...state, medicines: [...state.medicines, medicine] };
}

export function updateMedicineFacts(
  state: DemoOnboardingStateV1,
  id: string,
  facts: RecordedFacts,
): DemoOnboardingStateV1 {
  return {
    ...state,
    medicines: state.medicines.map((medicine) => (medicine.id === id ? { ...medicine, ...facts } : medicine)),
  };
}

export function removeMedicine(state: DemoOnboardingStateV1, id: string): DemoOnboardingStateV1 {
  return { ...state, medicines: state.medicines.filter((medicine) => medicine.id !== id) };
}
