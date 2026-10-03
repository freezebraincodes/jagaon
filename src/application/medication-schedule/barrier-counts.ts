import type { InquiryAnswerOptionKeyValue } from "@/domain/inquiry/inquiry-registry";

/**
 * Pure factual barrier counts (Packet 8 design Section 5.4; LRJ-003, LRJ-005).
 *
 * A count includes only a current accepted response that explicitly selected
 * a reviewed option for one exact occasion the patient recorded as skipped or
 * not sure, where that medication record is still the current recorded
 * representation. Each option counts distinct occasions only. Something else,
 * free text, Not sure, Prefer not to say, dismissal, snooze, reminder
 * interaction and missing records are never counted.
 */

export type CountableResponseInput = {
  responseRecordId: string;
  /** Raw answer kind of the current response revision. */
  rawAnswerKind: string;
  optionKey: InquiryAnswerOptionKeyValue | null;
  /** The inquiry's current terminal state references this exact response revision. */
  inquiryAnswersCurrentRevision: boolean;
  /** The exact medication-event revision the question was about. */
  basisRevisionId: string;
  basisRecordId: string;
  occasion: { identity: string; localDate: string; scheduledTime: string; medicineName: string };
};

export type MedicationEventHeadInput = { recordId: string; headRevisionId: string; state: string; active: boolean };

export type BarrierCount = {
  optionKey: InquiryAnswerOptionKeyValue;
  occasionCount: number;
  evidence: { localDate: string; scheduledTime: string; medicineName: string }[];
};

export type BarrierCountProjection = {
  counts: BarrierCount[];
  /** Reviewed-option answers excluded because their record was corrected or removed. */
  excludedCorrected: number;
};

const COUNTABLE_RECORDED_STATES = new Set(["MISSED", "UNSURE"]);

export function projectBarrierCounts(input: {
  responses: readonly CountableResponseInput[];
  eventHeads: readonly MedicationEventHeadInput[];
  window: { startDate: string; endDate: string };
  optionOrder: readonly InquiryAnswerOptionKeyValue[];
}): BarrierCountProjection {
  const heads = new Map(input.eventHeads.map((head) => [head.recordId, head]));
  const byOption = new Map<InquiryAnswerOptionKeyValue, Map<string, CountableResponseInput["occasion"]>>();
  let excludedCorrected = 0;
  for (const response of input.responses) {
    if (response.rawAnswerKind !== "BOUNDED_CHOICE" || response.optionKey === null || !response.inquiryAnswersCurrentRevision) continue;
    if (response.occasion.localDate < input.window.startDate || response.occasion.localDate > input.window.endDate) continue;
    const head = heads.get(response.basisRecordId);
    const current = head?.active === true && head.headRevisionId === response.basisRevisionId && COUNTABLE_RECORDED_STATES.has(head.state);
    if (!current) {
      excludedCorrected += 1;
      continue;
    }
    const occasions = byOption.get(response.optionKey) ?? new Map();
    // Several answers about one occasion never count more than once.
    occasions.set(response.occasion.identity, response.occasion);
    byOption.set(response.optionKey, occasions);
  }
  const counts = input.optionOrder.flatMap((optionKey) => {
    const occasions = byOption.get(optionKey);
    if (!occasions || occasions.size === 0) return [];
    const evidence = [...occasions.values()]
      .sort((a, b) => (a.localDate === b.localDate ? (a.scheduledTime < b.scheduledTime ? -1 : 1) : a.localDate < b.localDate ? -1 : 1))
      .map(({ localDate, scheduledTime, medicineName }) => ({ localDate, scheduledTime, medicineName }));
    return [{ optionKey, occasionCount: occasions.size, evidence }];
  });
  return { counts, excludedCorrected };
}
