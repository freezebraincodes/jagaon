/**
 * Demo scenario fixture.
 *
 * Provides the synthetic patient profile, recorded prescription facts, the
 * person's usual foods, and the user-entered care dates for the hackathon
 * demo. Every value is synthetic. Names, foods and recorded text are data:
 * they are shown as entered and never translated or interpreted.
 */

import type { SupportedLocale } from "@/domain/patient-settings/locale";
import type { RecordId, RevisionId } from "@/domain/shared/identifiers";
import type {
  DemoMedicineSource,
  DemoOnboardingMedicine,
  DemoOnboardingStateV1,
} from "@/application/onboarding/demo-onboarding-contracts";
import { findDemoCatalogueEntry, type DemoMedicineForm } from "@/application/onboarding/demo-medicine-catalogue";
import { createPreparedOnboardingState } from "@/application/onboarding/prepared-onboarding-fixture";

export type DemoPatientProfile = {
  /** Greeting name exactly as entered during setup; null when not provided. */
  displayName: string | null;
  /** The same verbatim name; names are never translated. */
  displayNameZh: string | null;
  /** Medicines recorded during setup (verbatim, not translated). */
  recordedPrescriptions: readonly DemoRecordedPrescription[];
  /** Foods the person chose as their usuals; tapping one only fills text. */
  usualFoods: readonly DemoUsualFood[];
  /** A synthetic, user-entered activity shown on Today. */
  activity: DemoActivity;
  /** Care-planning dates the person typed in; never computed by JagaOn. */
  careDates: readonly DemoCareDate[];
  /** Default locale for this demo. */
  defaultLocale: SupportedLocale;
};

/**
 * View projection of one setup medicine. Unknown facts stay null and are
 * shown as unknown; nothing is filled from another medicine.
 */
export type DemoRecordedPrescription = {
  /** Governed content key for reviewed information, or an unmapped id. */
  medicationId: string;
  /** Stable synthetic revision reference used by the journal command. */
  medicationRecordId: RecordId;
  medicationRevisionId: RevisionId;
  /** Medicine name as recorded. */
  displayName: string;
  /** Visible generic identity, only for governed catalogue entries. */
  genericName: string | null;
  /** Catalogue form, used only to offer pens on the insulin screen. */
  catalogueForm: DemoMedicineForm | null;
  form: string | null;
  strength: string | null;
  amountText: string | null;
  timingText: string | null;
  effectiveDate: string | null;
  source: DemoMedicineSource;
  /** Recorded direction text, shown verbatim. Not automatically translated. */
  recordedDirection: string | null;
  /** The recorded schedule or timing, shown as entered. */
  scheduledTime: string | null;
  /** Whether reviewed general info is available for this medicine. */
  hasReviewedInfo: boolean;
};

/**
 * Only the two closed catalogue mappings with governed insulin content may
 * enter the insulin-recording flow. A free-text medicine is never inferred
 * to be insulin from its name, form or recorded directions.
 */
export function isDemoInsulinPrescription(
  prescription: DemoRecordedPrescription,
): boolean {
  return prescription.catalogueForm === "PRE_FILLED_PEN" &&
    (prescription.medicationId === "insulin-glargine" ||
      prescription.medicationId === "insulin-aspart");
}

export type DemoUsualFood = {
  id: string;
  /** Whether the person files this usual as food or a drink (no nutrition data). */
  kind: "FOOD" | "DRINK";
  label: string;
  quantityText: string;
};

export type DemoActivity = {
  title: string;
  place: string;
  minutes: number;
};

export type DemoCareDate = {
  id: string;
  kind: "VISIT" | "SCREENING";
  label: string;
  /** Exactly what the person typed; JagaOn does not compute due dates. */
  enteredDateText: string;
};

// ---------------------------------------------------------------------------
// Synthetic fixture data
// ---------------------------------------------------------------------------

/** Synthetic fixtures that onboarding never changes. */
const UNCHANGED_FIXTURES = Object.freeze({
  usualFoods: Object.freeze([
    Object.freeze({ id: "usual-kaya-toast", kind: "FOOD" as const, label: "Kaya toast", quantityText: "2 slices" }),
    Object.freeze({ id: "usual-kopi-c-kosong", kind: "DRINK" as const, label: "Kopi C kosong", quantityText: "1 cup" }),
    Object.freeze({ id: "usual-soft-boiled-eggs", kind: "FOOD" as const, label: "Soft-boiled eggs", quantityText: "2 eggs" }),
    Object.freeze({ id: "usual-chee-cheong-fun", kind: "FOOD" as const, label: "Chee cheong fun", quantityText: "1 plate" }),
    Object.freeze({ id: "usual-sliced-fish-soup", kind: "FOOD" as const, label: "Sliced fish soup", quantityText: "1 bowl" }),
    Object.freeze({ id: "usual-teh-o", kind: "DRINK" as const, label: "Teh O", quantityText: "1 cup" }),
    Object.freeze({ id: "usual-chicken-rice", kind: "FOOD" as const, label: "Chicken rice", quantityText: "1 plate" }),
  ]),
  activity: Object.freeze({
    title: "Morning walk",
    place: "Jelutong Park (demo)",
    minutes: 28,
  }),
  careDates: Object.freeze([
    Object.freeze({
      id: "care-visit-dr-lim",
      kind: "VISIT" as const,
      label: "Visit, Dr Lim",
      enteredDateText: "14 Oct · 9:40 am",
    }),
    Object.freeze({
      id: "care-eye-screening",
      kind: "SCREENING" as const,
      label: "Eye screening",
      enteredDateText: "Nov 2026",
    }),
  ]),
});

// ---------------------------------------------------------------------------
// Projection from the validated onboarding state
// ---------------------------------------------------------------------------

/**
 * A second stable UUID for the synthetic revision reference: each hex digit
 * of the last block is complemented, keeping the v4 version/variant digits.
 */
export function demoRevisionId(id: string): RevisionId {
  const head = id.slice(0, 24);
  const tail = [...id.slice(24)].map((digit) => (15 - parseInt(digit, 16)).toString(16)).join("");
  return `${head}${tail}` as RevisionId;
}

function projectMedicine(medicine: DemoOnboardingMedicine): DemoRecordedPrescription {
  return Object.freeze({
    medicationId: medicine.reviewedContentKey ?? `demo-medicine:${medicine.id}`,
    medicationRecordId: medicine.id as RecordId,
    medicationRevisionId: demoRevisionId(medicine.id),
    displayName: medicine.displayName,
    genericName: medicine.genericName,
    catalogueForm: findDemoCatalogueEntry(medicine.catalogueKey)?.form ?? null,
    form: medicine.form,
    strength: medicine.strength,
    amountText: medicine.amountAndUnit,
    timingText: medicine.scheduleOrTiming,
    effectiveDate: medicine.effectiveDate,
    source: medicine.source,
    recordedDirection: medicine.verbatimDirections,
    scheduledTime: medicine.scheduleOrTiming,
    hasReviewedInfo: medicine.reviewedContentKey !== null,
  });
}

const PREPARED_TIMESTAMP = "2026-10-02T00:00:00.000Z";

/**
 * Projects validated setup state into the view fixture without creating
 * any authoritative record. A skipped setup has no medicines. With no
 * state, the prepared synthetic profile is used.
 */
export function createDemoScenarioFixture(state?: DemoOnboardingStateV1 | null): DemoPatientProfile {
  const source = state ?? createPreparedOnboardingState("en-SG", PREPARED_TIMESTAMP);
  return Object.freeze({
    ...UNCHANGED_FIXTURES,
    displayName: source.preferredName,
    displayNameZh: source.preferredName,
    recordedPrescriptions: Object.freeze(
      source.status === "SKIPPED" ? [] : source.medicines.map(projectMedicine),
    ),
    defaultLocale: source.locale,
  });
}
