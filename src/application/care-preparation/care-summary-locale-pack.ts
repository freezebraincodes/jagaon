import type { SupportedLocale } from "@/domain/patient-settings/locale";
import type { CareSummarySectionId, CareSummaryLimitationCode } from "@/domain/care-preparation/care-summary-snapshot";
import type { TimePoint } from "@/domain/shared/temporal";
import { getMessages } from "@/i18n/get-messages";

/**
 * The reviewed locale assets a care summary is rendered from (domain 11.7).
 * Every fixed label, heading and limitation resolves through this pack; no
 * other wording source exists, and nothing is translated from English.
 */

export const CARE_SUMMARY_LOCALE_PACK_VERSION = "care-summary-locale.9c.1";
export const CARE_SUMMARY_RENDERER_VERSION = "care-summary-renderer.9c.1";
export const CARE_SUMMARY_TEMPLATE_VERSION = "care-summary-template.9c.1";

const SECTION_ASSET: Readonly<Record<CareSummarySectionId, string>> = Object.freeze({
  SUMMARY_SCOPE: "care-summary.section.scope",
  CURRENT_CARE_PLAN: "care-summary.section.care-plan",
  CARE_ORGANISATION: "care-summary.section.organisation",
  MEASUREMENTS: "care-summary.section.measurements",
  MEDICATION_RECORDS: "care-summary.section.medication",
  SYMPTOMS_AND_CONTEXT: "care-summary.section.symptoms",
  INTAKE_AND_ACTIVITY: "care-summary.section.intake-activity",
  PATTERNS: "care-summary.section.patterns",
  SAFETY_HISTORY: "care-summary.section.safety",
  QUESTIONS_FOR_CARE_TEAM: "care-summary.section.questions",
  DATA_LIMITATIONS: "care-summary.section.limitations",
});

const LIMITATION_ASSET: Partial<Readonly<Record<CareSummaryLimitationCode, string>>> = Object.freeze({
  SELECTED_RECORDS_ONLY: "care-summary.limitation.selected-only",
  PATIENT_REPORTED_NOT_EXTERNALLY_VERIFIED: "care-summary.limitation.patient-reported",
  MISSING_OR_UNRECORDED_DATA: "care-summary.limitation.missing",
});

export const sectionAssetId = (section: CareSummarySectionId) => SECTION_ASSET[section];

export function limitationAssetId(code: CareSummaryLimitationCode): string {
  const asset = LIMITATION_ASSET[code];
  if (!asset) throw new Error("SUMMARY_REQUIRED_LIMITATION_MISSING");
  return asset;
}

export type CareSummaryLocalePack = ReturnType<typeof careSummaryLocalePack>;

const HOME_TIME_ZONE = "Asia/Singapore";

export function careSummaryLocalePack(locale: SupportedLocale) {
  const messages = getMessages(locale);
  const summary = messages.careSummary;
  const assets: Readonly<Record<string, string>> = Object.freeze({
    "care-summary.title": summary.title,
    "care-summary.scope": summary.scopeHeading,
    "care-summary.section.scope": summary.scopeHeading,
    "care-summary.section.care-plan": summary.carePlanHeading,
    "care-summary.section.organisation": summary.organisationHeading,
    "care-summary.section.measurements": summary.measurementsHeading,
    "care-summary.section.medication": summary.medicationHeading,
    "care-summary.section.intake-activity": summary.intakeActivityHeading,
    "care-summary.section.questions": summary.questionsHeading,
    "care-summary.section.limitations": summary.limitationsHeading,
    "care-summary.limitation.selected-only": summary.selectedOnly,
    "care-summary.limitation.patient-reported": summary.patientReported,
    "care-summary.limitation.missing": summary.missingLimitation,
  });

  const dateFormat = (timeZone: string) => new Intl.DateTimeFormat(locale, { timeZone, day: "numeric", month: "short", year: "numeric" });
  const timeFormat = (timeZone: string) => new Intl.DateTimeFormat(locale, { timeZone, hour: "numeric", minute: "2-digit" });
  const localDateText = (localDate: string) => {
    const [year, month, day] = localDate.split("-").map(Number) as [number, number, number];
    return dateFormat("UTC").format(new Date(Date.UTC(year, month - 1, day)));
  };

  /** Date and time exactly as recorded; an unknown time stays unknown. */
  function pointParts(point: TimePoint): { date: string | null; time: string | null } {
    if (point.kind === "UNKNOWN") return { date: null, time: null };
    if (point.kind === "DATE_ONLY") return { date: localDateText(point.localDate), time: null };
    const instant = new Date(point.kind === "EXACT" ? point.instantUtc : point.approximateInstantUtc);
    const zone = point.timeZoneId ?? HOME_TIME_ZONE;
    const time = timeFormat(zone).format(instant);
    return { date: dateFormat(zone).format(instant), time: point.kind === "APPROXIMATE" ? summary.approximately(time) : time };
  }

  function pointText(point: TimePoint): string {
    const parts = pointParts(point);
    if (parts.date === null) return summary.timeNotRecorded;
    // Locale punctuation: "3 Oct 2026, 9:00 pm" / "2026年10月3日 下午9:00".
    return parts.time === null ? `${parts.date} · ${summary.timeNotRecorded}` : `${parts.date}${locale === "zh-SG" ? " " : ", "}${parts.time}`;
  }

  return Object.freeze({
    locale,
    version: CARE_SUMMARY_LOCALE_PACK_VERSION,
    asset(assetId: string): string {
      const text = assets[assetId];
      if (text === undefined) throw new Error("SUMMARY_LOCALE_INVALID");
      return text;
    },
    pointParts,
    pointText,
    localDateText,
    summary,
    glucoseUnit: messages.glucose.unit,
    groupTitles: {
      GLUCOSE: messages.carePreparation.glucoseReadings,
      INSULIN: messages.carePreparation.insulinRecords,
      MEALS: messages.carePreparation.mealNotes,
      WALKS: messages.carePreparation.walks,
    },
    appointmentEnteredByYou: messages.carePreparation.appointmentEnteredByYou,
    appointmentUnverified: messages.carePreparation.appointmentUnverified,
    schedule: messages.schedule,
    minutes: messages.shared.minutes,
  });
}
