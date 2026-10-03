import type { Instant } from "@/domain/shared/time";
import type { EnabledInquiryDefinition } from "@/domain/inquiry/inquiry-registry";
import type { InquiryPresentation } from "@/domain/inquiry/inquiry";
import {
  terminalStateForRawAnswer,
  validateRawAnswerAgainstPresentation,
  type InquiryRawAnswer,
  type InquiryResponseKind,
  type InquiryResponseInterpretation,
  type InquiryResponsePayload,
  type InquiryResponseProcessing,
  type InquirySemanticValueKey,
  type RawAnswerIssue,
} from "@/domain/inquiry/inquiry-response";
import { resolveInquirySafetyDisposition, type InquiryCapabilityManifest } from "./inquiry-capability-manifest";

/**
 * Pure response-candidate builder for the barrier definition (deterministic-
 * engine Section 15.1, Phase 1). It validates the raw answer against the exact
 * presentation, maps a reviewed option to its fixed semantic value, keeps
 * patient text unclassified, and records the capability-bound Safety
 * disposition. It never evaluates or routes Safety.
 */

export type BarrierResponseParts = Pick<
  InquiryResponsePayload,
  "responseKind" | "rawAnswer" | "interpretation" | "safetyDisposition" | "processing"
> & { terminalState: "ANSWERED" | "NOT_SURE" | "DECLINED" };

export function buildBarrierResponseParts(input: {
  definition: EnabledInquiryDefinition;
  manifest: InquiryCapabilityManifest;
  presentation: InquiryPresentation;
  rawAnswer: InquiryRawAnswer;
  determinedAt: Instant;
}): { ok: true; parts: BarrierResponseParts } | { ok: false; issue: RawAnswerIssue } {
  const { definition, manifest, presentation, rawAnswer, determinedAt } = input;
  const issue = validateRawAnswerAgainstPresentation(
    definition.answerContract as unknown as Parameters<typeof validateRawAnswerAgainstPresentation>[0],
    presentation,
    rawAnswer,
    definition.somethingElseMaximumCodePoints,
  );
  if (issue) return { ok: false, issue };

  let responseKind: InquiryResponseKind;
  let interpretation: InquiryResponseInterpretation;
  let processing: InquiryResponseProcessing;
  switch (rawAnswer.kind) {
    case "BOUNDED_CHOICE": {
      const meaning = definition.reviewedOptions.find((option) => option.optionKey === rawAnswer.optionKey)!;
      responseKind = "CONTEXT";
      interpretation = {
        kind: "DETERMINISTIC_MAPPING",
        mappingVersion: definition.ruleVersions.optionMapping,
        meaning: { kind: "REVIEWED_SEMANTIC_VALUE", semanticValueKey: meaning.semanticValueKey as unknown as InquirySemanticValueKey },
      };
      // The barrier answer has no authoritative destination record; it is
      // preserved for the factual-count projection only.
      processing = { state: "RECORDED" };
      break;
    }
    case "SOMETHING_ELSE":
      responseKind = "FREE_TEXT";
      interpretation = { kind: "DIRECT", meaning: { kind: "PATIENT_TEXT_RETAINED", rawAnswerKind: "SOMETHING_ELSE" } };
      processing = { state: "NO_DOMAIN_EFFECT", reason: "PATIENT_TEXT_RETAINED_ONLY" };
      break;
    case "NOT_SURE":
      responseKind = "NOT_SURE";
      interpretation = { kind: "NONE", reason: "NOT_SURE" };
      processing = { state: "NO_DOMAIN_EFFECT", reason: "NOT_SURE" };
      break;
    case "PREFER_NOT_TO_SAY":
      responseKind = "PREFER_NOT_TO_SAY";
      interpretation = { kind: "NONE", reason: "PREFER_NOT_TO_SAY" };
      processing = { state: "NO_DOMAIN_EFFECT", reason: "PREFER_NOT_TO_SAY" };
      break;
    default:
      return { ok: false, issue: "RAW_ANSWER_NOT_PERMITTED_BY_CONTRACT" };
  }
  return {
    ok: true,
    parts: {
      responseKind,
      rawAnswer,
      interpretation,
      safetyDisposition: resolveInquirySafetyDisposition(manifest, determinedAt),
      processing,
      terminalState: terminalStateForRawAnswer(rawAnswer),
    },
  };
}
