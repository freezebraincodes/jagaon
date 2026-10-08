import type { AiLocale, AiTaskRequest } from "@/domain/ai";
import { AI_LANGUAGE_COPY, type LanguageCopy } from "./ai-language-copy";

/**
 * P3 presentation correction (ai-language-copy.11b.8, owner instruction 2026-10-08, offline): the fixed bilingual notices shown with a
 * care preparation draft, apart from its patient facts and from the approved limitation copy. A draft with a questions section first
 * says the questions are the person's own words and are not carried out; every draft says the app does not send it to the care team or
 * confirm clinician review. Application wording only: no action, sending or review capability exists or is implied.
 */
export type CareDraftNoticeKind = "QUESTIONS_IN_OWN_WORDS" | "DRAFT_NOT_SENT_OR_REVIEWED";
export type CareDraftNotice = Readonly<{ kind: CareDraftNoticeKind; text: string }>;

export function renderCareDraftNotices(request: AiTaskRequest, copy: LanguageCopy = AI_LANGUAGE_COPY): readonly CareDraftNotice[] {
  if (request.taskType !== "DRAFT_CARE_PREPARATION_SUMMARY") return [];
  return careDraftNoticesFor(request.locale, request.taskPayload.sections.some((section) => section.sectionId === "QUESTIONS_FOR_CARE_TEAM"), copy);
}

/**
 * The one selection rule (Packet 11C B1a): the questions notice only with a questions section, then the draft notice always, in the
 * locale, verbatim from the approved copy. The care-summary renderer stores exactly these as the snapshot's CARE_DRAFT_NOTICE blocks.
 */
export function careDraftNoticesFor(locale: AiLocale, hasQuestionsSection: boolean, copy: LanguageCopy = AI_LANGUAGE_COPY): readonly CareDraftNotice[] {
  const notices: CareDraftNotice[] = [];
  if (hasQuestionsSection) notices.push({ kind: "QUESTIONS_IN_OWN_WORDS", text: copy.careDraftNotices.questions[locale] });
  notices.push({ kind: "DRAFT_NOT_SENT_OR_REVIEWED", text: copy.careDraftNotices.draft[locale] });
  return Object.freeze(notices.map((notice) => Object.freeze(notice)));
}
