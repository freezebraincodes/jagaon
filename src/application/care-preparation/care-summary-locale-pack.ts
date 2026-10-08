import type { SupportedLocale } from "@/domain/patient-settings/locale";
import type { CareSummaryPayloadSectionId, CareSummaryLimitationCode, CareSummarySnapshotPayload } from "@/domain/care-preparation/care-summary-snapshot";
import type { TimePoint } from "@/domain/shared/temporal";
import { getMessages } from "@/i18n/get-messages";

/**
 * The reviewed locale assets a care summary is rendered from (domain 11.7).
 * Every fixed label, heading and limitation resolves through this pack; the
 * care-draft notice text (Packet 11C B1a) comes from its one approved source,
 * AI_LANGUAGE_COPY.careDraftNotices, via the renderer. Nothing is translated
 * from English.
 *
 * Versions (Packet 11C Addendum B, Task B1a; 9c.1 → 11c.1, offline, human acceptance pending):
 * - care-summary-template.11c.1 / care-summary-renderer.11c.1: new snapshots store the applicable care-draft notices as
 *   CARE_DRAFT_NOTICE blocks in a last CARE_DRAFT_NOTICES section (inside the hashed export projection).
 * - care-summary-locale.11c.1: adds the notice section heading asset (careSummary.draftNotices.label) and carries the D4 zh
 *   `selectedOnly` wording (你 → 您). Every 9c.1 heading, title and asset string is unchanged, so a 9c.1 snapshot (which stores its
 *   own block text) prints byte-identically (care-summary-legacy-artifact.test.ts).
 */

export const CARE_SUMMARY_LOCALE_PACK_VERSION = "care-summary-locale.11c.1";
export const CARE_SUMMARY_RENDERER_VERSION = "care-summary-renderer.11c.1";
export const CARE_SUMMARY_TEMPLATE_VERSION = "care-summary-template.11c.1";

/**
 * D3: an unapproved snapshot can be approved only when it was made with the current template and renderer. An older one is shown
 * as stored but must be prepared again; an approved one is never touched and stays printable.
 */
export function isCurrentCareSummaryTemplate(payload: Pick<CareSummarySnapshotPayload, "composition" | "rendering">): boolean {
  return payload.composition.templateVersion === CARE_SUMMARY_TEMPLATE_VERSION && payload.rendering.rendererVersion === CARE_SUMMARY_RENDERER_VERSION;
}

const SECTION_ASSET: Readonly<Record<CareSummaryPayloadSectionId, string>> = Object.freeze({
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
  CARE_DRAFT_NOTICES: "care-summary.section.draft-notices",
});

const LIMITATION_ASSET: Partial<Readonly<Record<CareSummaryLimitationCode, string>>> = Object.freeze({
  SELECTED_RECORDS_ONLY: "care-summary.limitation.selected-only",
  PATIENT_REPORTED_NOT_EXTERNALLY_VERIFIED: "care-summary.limitation.patient-reported",
  MISSING_OR_UNRECORDED_DATA: "care-summary.limitation.missing",
});

export const sectionAssetId = (section: CareSummaryPayloadSectionId) => SECTION_ASSET[section];

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
    "care-summary.section.draft-notices": summary.draftNotices.label,
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
