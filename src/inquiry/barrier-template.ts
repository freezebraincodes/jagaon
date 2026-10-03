import type { InquiryAnswerOptionKeyValue, EnabledInquiryDefinition } from "@/domain/inquiry/inquiry-registry";
import type { InquiryPresentation } from "@/domain/inquiry/inquiry";

/**
 * Deterministic `medication-occasion-barrier.dialog` template, version 1.
 * Wording comes only from the reviewed en-SG/zh-SG copy-matrix assets; the
 * patient's medicine name is inserted verbatim and never translated.
 */

export type BarrierTemplateCopy = {
  barrierWhy: (status: string, medicine: string, date: string) => string;
  barrierQuestion: string;
  optionLabels: Readonly<Record<InquiryAnswerOptionKeyValue, string>>;
};

export function renderBarrierContent(
  definition: EnabledInquiryDefinition,
  copy: BarrierTemplateCopy,
  facts: { statusLabel: string; medicineName: string; dateText: string },
): InquiryPresentation["content"] {
  return {
    leadIn: copy.barrierWhy(facts.statusLabel, facts.medicineName, facts.dateText),
    question: copy.barrierQuestion,
    options: definition.answerContract.optionKeys.map((optionKey) => ({
      optionKey: optionKey as InquiryPresentation["content"]["options"][number]["optionKey"],
      label: copy.optionLabels[optionKey],
    })),
  };
}
