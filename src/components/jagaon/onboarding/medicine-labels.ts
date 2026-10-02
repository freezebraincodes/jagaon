import type { AppMessages } from "@/i18n/types";
import type { DemoMedicineSource, DemoOnboardingMedicine } from "@/application/onboarding/demo-onboarding-contracts";
import { findDemoCatalogueEntry, type DemoMedicineForm } from "@/application/onboarding/demo-medicine-catalogue";

export function sourceLabel(messages: AppMessages, source: DemoMedicineSource): string {
  const msg = messages.onboarding;
  switch (source) {
    case "PRESCRIPTION_LABEL":
      return msg.sourcePrescriptionLabel;
    case "CARE_TEAM_DIRECTIONS":
      return msg.sourceCareTeam;
    case "PATIENT_ENTERED":
      return msg.sourcePatient;
    case "UNKNOWN":
      return msg.sourceUnknown;
  }
}

export function catalogueFormLabel(messages: AppMessages, form: DemoMedicineForm): string {
  return form === "PRE_FILLED_PEN" ? messages.onboarding.formPen : messages.onboarding.formTablet;
}

/**
 * Card subtitle: the visible generic identity (only for governed catalogue
 * entries) and the recorded or catalogue form. Never the mockup-only labels.
 */
export function medicineSubtitle(messages: AppMessages, medicine: DemoOnboardingMedicine): string {
  const entry = findDemoCatalogueEntry(medicine.catalogueKey);
  const form = medicine.form ?? (entry ? catalogueFormLabel(messages, entry.form) : null);
  return [medicine.genericName, form].filter(Boolean).join(" · ");
}
