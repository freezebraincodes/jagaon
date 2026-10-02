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

export type DemoPatientProfile = {
  /** Display name shown in the greeting. */
  displayName: string;
  /** Locale-specific display name. */
  displayNameZh: string;
  /** All recorded prescriptions (verbatim, not translated). */
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

export type DemoPrescriptionProvenance =
  | { kind: "ENTERED_BY_USER"; detail: string }
  | { kind: "TRANSCRIBED_FROM_DOCUMENT"; detail: string };

export type DemoRecordedPrescription = {
  /** Source-bound medication ID. */
  medicationId: string;
  /** Stable synthetic revision reference used by the journal command. */
  medicationRecordId: RecordId;
  medicationRevisionId: RevisionId;
  /** Medicine name as recorded (brand name in this scenario). */
  displayName: string;
  /** Recorded generic name, shown as data. */
  genericName: string;
  /** Recorded form, as entered. */
  form: string;
  /** Recorded amount and unit, as entered. */
  amountText: string;
  /** Recorded timing or schedule, as entered. */
  timingText: string;
  /** Recorded effective date (YYYY-MM-DD). */
  effectiveDate: string;
  provenance: DemoPrescriptionProvenance;
  /**
   * Patient-entered or recorded direction text, shown verbatim.
   * Not automatically translated.
   */
  recordedDirection: string;
  /** Explicit display-only schedule supplied by the synthetic fixture. */
  scheduledTime: string;
  /** Whether reviewed general info is available for this medicine. */
  hasReviewedInfo: boolean;
};

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

const DEMO_PROFILE: DemoPatientProfile = Object.freeze({
  displayName: "Alex",
  displayNameZh: "陈先生",
  recordedPrescriptions: Object.freeze([
    Object.freeze({
      medicationId: "insulin-glargine",
      medicationRecordId: "00000000-0000-4000-8000-000000000101" as RecordId,
      medicationRevisionId: "00000000-0000-4000-8000-000000000102" as RevisionId,
      displayName: "Lantus",
      genericName: "insulin glargine",
      form: "Pre-filled pen, 100 units/mL",
      amountText: "12 units",
      timingText: "Daily · 9:00 pm",
      effectiveDate: "2026-08-12",
      provenance: Object.freeze({
        kind: "ENTERED_BY_USER" as const,
        detail: "Entered by you — checked 12 Sep 2026",
      }),
      recordedDirection: "Inject 12 units under the skin once daily at 9:00 pm.",
      scheduledTime: "9:00 pm",
      hasReviewedInfo: true,
    }),
    Object.freeze({
      medicationId: "insulin-aspart",
      medicationRecordId: "00000000-0000-4000-8000-000000000103" as RecordId,
      medicationRevisionId: "00000000-0000-4000-8000-000000000104" as RevisionId,
      displayName: "NovoRapid",
      genericName: "insulin aspart",
      form: "Pre-filled pen, 100 units/mL",
      amountText: "6 units",
      timingText: "With meals",
      effectiveDate: "2026-08-12",
      provenance: Object.freeze({
        kind: "TRANSCRIBED_FROM_DOCUMENT" as const,
        detail: "Jelutong Polyclinic (demo) prescription, 12 Aug 2026",
      }),
      recordedDirection: "Inject 6 units under the skin with meals.",
      scheduledTime: "6:30 pm",
      hasReviewedInfo: true,
    }),
  ]),
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
  defaultLocale: "en-SG",
});

// ---------------------------------------------------------------------------
// Fixture factory
// ---------------------------------------------------------------------------

export function createDemoScenarioFixture(): DemoPatientProfile {
  return DEMO_PROFILE;
}

// Export for tests
export const DEMO_DISPLAY_NAME = "Alex";
export const DEMO_DISPLAY_NAME_ZH = "陈先生";
