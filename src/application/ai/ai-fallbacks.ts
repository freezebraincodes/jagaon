import { z } from "zod";
import { AI_LOCALES, AI_REASON_CODES, AI_TASK_TYPES, aiReasonCodeSchema, type AiReasonCode, type AiTaskRequest } from "@/domain/ai";
import { renderExplainLimitations } from "./ai-meaning-registry";

/**
 * Packet 11A deterministic fallbacks (ai-system-spec Section 10). Every task
 * has a local, network-free, typed presentation that carries only request-
 * local references and closed codes; it never contains generated prose. The
 * reason codes are the non-patient-facing list of the Packet 11 bilingual
 * matrix Section 5 and are never rendered directly.
 */

export { AI_REASON_CODES, aiReasonCodeSchema, type AiReasonCode } from "@/domain/ai";

const localRefs = (prefix: string) => z.array(z.string().regex(new RegExp(`^${prefix}-[1-9]\\d{0,2}$`)));

export const aiFallbackPresentationSchema = z.discriminatedUnion("kind", [
  // The note stays saved with its provenance; nothing is extracted and manual entry is offered.
  z.strictObject({ kind: z.literal("ORIGINAL_NOTE_PRESERVED"), excerptRef: z.string(), noticeRequired: z.literal(true), manualEntryOffered: z.literal(true), extractedFacts: z.array(z.never()).length(0) }),
  // Template pattern card from the computed observation, evidence count and limitations. Option B
  // (ai-fallback.explain-pattern@11b.1): it carries the same registry-rendered limitation copy as an
  // accepted result; copy is never invented for a code without approved text (complete = false).
  z.strictObject({
    kind: z.literal("TEMPLATE_PATTERN_CARD"),
    claimRef: z.string(),
    evidenceFactRefs: localRefs("fact").min(1),
    evidenceCount: z.number().int().positive(),
    limitationRefs: localRefs("limitation").min(1),
    limitations: z.array(z.strictObject({ limitationRef: z.string(), code: z.string(), text: z.string().min(1) })),
    limitationCopyComplete: z.boolean(),
    noticeRequired: z.literal(false),
  }),
  z.strictObject({ kind: z.literal("APPROVED_INQUIRY_TEMPLATE"), questionIntentCode: z.string(), optionRefs: localRefs("option").min(1), noticeRequired: z.literal(false) }),
  z.strictObject({ kind: z.literal("SELECTED_RECORD_LIST"), recordRefs: localRefs("record").min(1), noticeRequired: z.literal(false) }),
  z.strictObject({ kind: z.literal("STRUCTURED_PREVIEW"), sections: z.array(z.strictObject({ sectionRef: z.string(), factRefs: localRefs("fact").min(1) })).min(1), noticeRequired: z.literal(false) }),
  z.strictObject({ kind: z.literal("REVIEWED_LOCALE_STRING"), intentCode: z.string(), noticeRequired: z.literal(false) }),
]);
export type AiFallbackPresentation = z.infer<typeof aiFallbackPresentationSchema>;

export const aiFallbackResultSchema = z.strictObject({
  kind: z.literal("DETERMINISTIC_FALLBACK"),
  taskType: z.enum(AI_TASK_TYPES),
  locale: z.enum(AI_LOCALES),
  reason: aiReasonCodeSchema,
  presentation: aiFallbackPresentationSchema,
});
export type AiFallbackResult = z.infer<typeof aiFallbackResultSchema>;

function presentationFor(request: AiTaskRequest): AiFallbackPresentation {
  switch (request.taskType) {
    case "EXTRACT_CANDIDATE_FACTS":
      return { kind: "ORIGINAL_NOTE_PRESERVED", excerptRef: request.taskPayload.excerptRef, noticeRequired: true, manualEntryOffered: true, extractedFacts: [] };
    case "EXPLAIN_PATTERN": {
      const copy = renderExplainLimitations(request.taskPayload.limitations, request.locale);
      return {
        kind: "TEMPLATE_PATTERN_CARD",
        claimRef: request.taskPayload.claim.ref,
        evidenceFactRefs: [...request.taskPayload.claim.factRefs],
        evidenceCount: request.taskPayload.claim.factRefs.length,
        limitationRefs: request.taskPayload.limitations.map((limitation) => limitation.ref),
        limitations: copy.limitations.map((limitation) => ({ ...limitation })),
        limitationCopyComplete: copy.complete,
        noticeRequired: false,
      };
    }
    case "DRAFT_NEUTRAL_INQUIRY":
      return { kind: "APPROVED_INQUIRY_TEMPLATE", questionIntentCode: request.taskPayload.questionIntentCode, optionRefs: request.taskPayload.options.map((option) => option.ref), noticeRequired: false };
    case "ANSWER_BOUNDED_RECORD_QUERY":
      return { kind: "SELECTED_RECORD_LIST", recordRefs: request.taskPayload.records.map((record) => record.ref), noticeRequired: false };
    case "DRAFT_CARE_PREPARATION_SUMMARY":
      return { kind: "STRUCTURED_PREVIEW", sections: request.taskPayload.sections.map((section) => ({ sectionRef: section.ref, factRefs: [...section.factRefs] })), noticeRequired: false };
    case "PHRASE_NON_CLINICAL_RESPONSE":
      return { kind: "REVIEWED_LOCALE_STRING", intentCode: request.taskPayload.intentCode, noticeRequired: false };
  }
}

export function createDeterministicFallback(request: AiTaskRequest, reason: AiReasonCode): AiFallbackResult {
  if (!(AI_REASON_CODES as readonly string[]).includes(reason)) throw new Error("UNKNOWN_AI_REASON");
  return aiFallbackResultSchema.parse({ kind: "DETERMINISTIC_FALLBACK", taskType: request.taskType, locale: request.locale, reason, presentation: presentationFor(request) });
}
