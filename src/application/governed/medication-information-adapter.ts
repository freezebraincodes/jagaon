/**
 * Medication information adapter.
 *
 * Provides reviewed general medication information for the medicines
 * available in this hackathon demo. All content is synthetic and governed
 * by the regulatory-compliance spec:
 *
 * - General information is kept separate from recorded directions.
 * - No dose recommendation, interpretation, or risk prediction.
 * - Missing medicines fall back to the approved "info unavailable" copy.
 */

import type { AppMessages } from "@/i18n/types";
import type { LocalDateText } from "@/i18n/types";

export type MedicationGeneralInfo = {
  /** Source-bound identifier for the medication in this demo. */
  medicationId: string;
  /** Display name shown above the reviewed general info. */
  displayName: string;
  /** Reviewed general-purpose paragraph (locale-specific). */
  purpose: string;
  /** Reviewed general-use paragraph (locale-specific). */
  use: string;
  /** Reviewed date label, e.g. "Reviewed 2026-10-02". */
  reviewedOnLabel: string;
  /** Public source the reviewed copy was checked against. */
  sourceName: string;
  /** Locale-specific official leaflet URL for the reviewed copy. */
  sourceUrl: string;
  /** Whether reviewed info is available for this medicine. */
  available: boolean;
};

export type MedicationInformationAdapter = {
  /**
   * Returns reviewed general information for the given medication ID.
   * If no reviewed info exists, returns an "unavailable" marker so the
   * UI can show the approved fallback copy.
   */
  getGeneralInfo(
    medicationId: string,
    messages: AppMessages,
    locale: "en-SG" | "zh-SG",
  ): MedicationGeneralInfo;
};

// --- Section: Reviewed medication IDs supported in this demo ---------------

const GLARGINE_ID = "insulin-glargine";
const GLULISINE_ID = "insulin-glulisine";

const SUPPORTED_MEDICATION_IDS: ReadonlySet<string> = new Set([
  GLARGINE_ID,
  GLULISINE_ID,
]);

// Review date and leaflet URLs from the approved Packet 6 copy matrix (section 7).
const REVIEWED_DATE: LocalDateText = "2026-10-02";
/** The insulin glulisine leaflet was checked on HealthHub on this date (owner decision 2026-10-14). */
const GLULISINE_REVIEWED_DATE: LocalDateText = "2026-10-14";

const SOURCE_NAME = "HealthHub";

const SOURCE_URLS: Readonly<Record<string, Readonly<Record<"en-SG" | "zh-SG", string>>>> =
  Object.freeze({
    [GLARGINE_ID]: Object.freeze({
      "en-SG":
        "https://www.healthhub.sg/medication-devices-and-treatment/medications/insulin-glargine",
      "zh-SG":
        "https://ch-api.healthhub.sg/api/public/content/786935d0c91f452abdbdbcc18040d18b?v=60f917d4",
    }),
    // Owner decision 2026-10-14: Apidra (insulin glulisine) replaces the earlier demo pen. HealthHub's insulin glulisine leaflet,
    // checked 2026-10-14. No Chinese leaflet link was checked, so zh-SG points to the same English page (English-only hackathon scope).
    [GLULISINE_ID]: Object.freeze({
      "en-SG":
        "https://www.healthhub.sg/medication-devices-and-treatment/medications/insulin-glulisine",
      "zh-SG":
        "https://www.healthhub.sg/medication-devices-and-treatment/medications/insulin-glulisine",
    }),
  });

// --- Section: Adapter factory ---------------------------------------------

export function createMedicationInformationAdapter(
  reviewedDate: LocalDateText = REVIEWED_DATE,
): MedicationInformationAdapter {
  return Object.freeze({
    getGeneralInfo(
      medicationId: string,
      messages: AppMessages,
      locale: "en-SG" | "zh-SG",
    ): MedicationGeneralInfo {
      const msg = messages.medication;
      const reviewedLabel = messages.shared.reviewedOn(reviewedDate);

      if (medicationId === GLARGINE_ID) {
        return {
          medicationId: GLARGINE_ID,
          // Medicine names are data and stay untranslated in every locale.
          displayName: "Insulin glargine",
          purpose: msg.glarginePurpose,
          use: msg.glargineUse,
          reviewedOnLabel: reviewedLabel,
          sourceName: SOURCE_NAME,
          sourceUrl: SOURCE_URLS[GLARGINE_ID]![locale],
          available: true,
        };
      }

      if (medicationId === GLULISINE_ID) {
        return {
          medicationId: GLULISINE_ID,
          displayName: "Insulin glulisine",
          purpose: msg.glulisinePurpose,
          use: msg.glulisineUse,
          reviewedOnLabel: messages.shared.reviewedOn(GLULISINE_REVIEWED_DATE),
          sourceName: SOURCE_NAME,
          sourceUrl: SOURCE_URLS[GLULISINE_ID]![locale],
          available: true,
        };
      }

      // Fallback for unsupported medications
      return {
        medicationId,
        displayName: medicationId,
        purpose: "",
        use: "",
        reviewedOnLabel: "",
        sourceName: "",
        sourceUrl: "",
        available: false,
      };
    },
  });
}

// --- Section: Test-exported constants --------------------------------------

export const DEMO_MEDICATION_IDS = Object.freeze({
  glargine: GLARGINE_ID,
  glulisine: GLULISINE_ID,
});

export const DEMO_MEDICATION_REVIEWED_DATE = REVIEWED_DATE;

export function isSupportedMedicationId(id: string): boolean {
  return SUPPORTED_MEDICATION_IDS.has(id);
}
