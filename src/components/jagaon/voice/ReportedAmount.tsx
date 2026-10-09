"use client";

import type { VoiceCandidate } from "@/domain/voice/voice-contracts";
import type { VoiceScreenCopy } from "./voice-screen-copy";

/**
 * Packet 13 (P13S; owner decision #4; contract voice-contract.13s.3): the ONE place that shows a medicine amount the person reported
 * (`MEDICATION_OCCURRENCE.reportedAmount`), exactly as the extractor kept it from the spoken words, never as a recommendation. It always
 * says plainly whether the amount will be stored: `willBeSaved` is true only when this fact is saved as a TAKEN event through the review
 * (an edit carries no amount) and the save path stores that amount; otherwise (SKIPPED, not sure, planned, an edit) the card says it
 * will not be saved and the card's manual-entry button is the path to add it.
 */
export function reportedAmountText(candidate: VoiceCandidate): string | null {
  if (candidate.kind !== "MEDICATION_OCCURRENCE" || candidate.reportedAmount === null) return null;
  return `${candidate.reportedAmount.valueText} ${candidate.reportedAmount.unitText}`.trim();
}

export function ReportedAmount({ candidate, copy, willBeSaved }: { candidate: VoiceCandidate; copy: VoiceScreenCopy; willBeSaved: boolean }) {
  const text = reportedAmountText(candidate);
  if (text === null) return null;
  return (
    <div className="voice-reported-amount">
      <p>{copy.card.amountReported(text)}</p>
      <p className={willBeSaved ? "voice-reported-amount-saved" : "voice-reported-amount-not-saved"}>{willBeSaved ? copy.card.amountWillBeSaved : copy.card.amountNotSaved}</p>
    </div>
  );
}
