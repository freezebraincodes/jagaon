"use client";

import { useId, useMemo } from "react";
import { createMedicationInformationAdapter } from "@/application/governed/medication-information-adapter";
import { reviewedMedicineKeyFor } from "@/application/medicine-info/medicine-info-reviewed";
import type { VoiceMedicineInfoRequestCandidate } from "@/domain/voice/voice-contracts";
import type { AppMessages, SupportedLocale } from "@/i18n/types";
import { PreviewTag } from "../hsa/hsa-bounded-mode";
import { labelAndValue } from "../locale-format";
import { MedicineGeneralInfoPreview } from "../medicine-info/MedicineGeneralInfoPreview";
import { BookIcon, ExternalIcon } from "../primitives/Icons";
import type { VoiceScreenCopy } from "./voice-screen-copy";

type Props = Readonly<{
  candidate: VoiceMedicineInfoRequestCandidate;
  messages: AppMessages;
  locale: SupportedLocale;
  copy: VoiceScreenCopy;
  /** Opens My medicines (absent: no link). */
  onOpenMyMedicines?: () => void;
  onInteract?: () => void;
}>;

/**
 * HSA preview (owner decision 2026-10-14, "Tell me about my medicine"): the medicine information card in the Tell JagaOn review area,
 * shown only while HSA-bounded mode is off (the screen decides). A medicine with reviewed HealthHub information shows that reviewed
 * information, unchanged; any other medicine offers the same "Get general information with AI" flow as My medicines. It is never a
 * fact: there is no Save, and nothing is recorded. "Open in My medicines" leads to her list.
 */
export function VoiceMedicineInfoCard({ candidate, messages, locale, copy, onOpenMyMedicines, onInteract }: Props) {
  const id = useId();
  const adapter = useMemo(() => createMedicationInformationAdapter(), []);
  const key = reviewedMedicineKeyFor(candidate.name);
  const reviewed = key ? adapter.getGeneralInfo(key, messages, locale) : null;
  const msg = messages.medication;

  return (
    <article className="card voice-fact-card voice-medicine-info-card" aria-labelledby={`${id}-heading`} onClickCapture={onInteract}>
      <p className="medicine-ai-eyebrow">
        <PreviewTag messages={messages} />
      </p>
      <h3 id={`${id}-heading`} className="voice-fact-heading">
        {`${copy.medicineInfo.heading}: ${candidate.name}`}
      </h3>
      {reviewed?.available ? (
        <section className="voice-medicine-info-reviewed" aria-labelledby={`${id}-reviewed`}>
          <p id={`${id}-reviewed`} className="tag tag--reviewed">
            <BookIcon size={16} />
            {msg.reviewedTag}
          </p>
          <p className="medication-text">
            <strong>{msg.aboutThisMedicine}</strong> · {msg.notPersonalised}
          </p>
          <p className="medication-text">{reviewed.purpose}</p>
          <p className="medication-text">{reviewed.use}</p>
          <p className="source-attr">
            <a href={reviewed.sourceUrl} target="_blank" rel="noreferrer noopener">
              {labelAndValue(locale, messages.shared.source, reviewed.sourceName)}
              <ExternalIcon size={14} />
            </a>
            {" · "}
            {reviewed.reviewedOnLabel}
          </p>
        </section>
      ) : (
        <MedicineGeneralInfoPreview messages={messages} locale={locale} name={candidate.name} headingLevel={4} />
      )}
      {onOpenMyMedicines ? (
        <button type="button" className="btn btn-ghost btn-wide voice-medicine-info-open" onClick={onOpenMyMedicines}>
          {copy.medicineInfo.openInMyMedicines}
        </button>
      ) : null}
    </article>
  );
}
