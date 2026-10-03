import type { SupportedLocale } from "@/domain/patient-settings/locale";
import type { RecordId, RevisionId } from "@/domain/shared";
import type { InquiryPresentationKey } from "@/domain/inquiry/inquiry";

/**
 * Pure view contract for one presented barrier question. The UI receives this
 * shape only; it never imports the Inquiry engine, service or storage.
 */
export type PresentedBarrierQuestion = {
  inquiryRecordId: RecordId;
  inquiryRevisionId: RevisionId;
  presentationKey: InquiryPresentationKey;
  locale: SupportedLocale;
  leadIn: string;
  question: string;
  options: { optionKey: string; label: string }[];
  medicationEventRecordId: RecordId;
};
