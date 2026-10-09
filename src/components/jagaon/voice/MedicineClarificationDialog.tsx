"use client";

import { useId, useState } from "react";
import type { VoiceMedicationRef } from "@/domain/voice/voice-contracts";
import { ModalDialog } from "../primitives/ModalDialog";
import type { VoiceScreenCopy } from "./voice-screen-copy";

export type VoiceMedicineOption = Readonly<{ medication: VoiceMedicationRef; name: string }>;

/**
 * Packet 13 (P13S): the targeted question for an unresolved spoken medicine description ("dark pen"). The person picks one of their
 * existing canonical medicines or leaves it out (the safe action, also Escape). "Remember" is a SEPARATE, unticked-by-default choice:
 * it saves only the phrase → medicine mapping and never records that anything was taken; the fact card still needs its own Save.
 * Nothing is guessed from a colour or a description.
 */
export function MedicineClarificationDialog({
  phrase,
  options,
  copy,
  onChoose,
  onLeaveOut,
  title,
  rememberable = true,
}: {
  /** Terminology review: the Change action reuses this picker with its own title and without the separate "remember" choice. */
  title?: string;
  /** False hides the "remember" choice (a Change, or a phrase that may not be remembered: a number, amount, unit or time word). */
  rememberable?: boolean;
  phrase: string;
  options: readonly VoiceMedicineOption[];
  copy: VoiceScreenCopy;
  onChoose: (choice: VoiceMedicineOption, remember: boolean) => void;
  onLeaveOut: () => void;
}) {
  const groupId = useId();
  const [selected, setSelected] = useState<number | null>(null);
  const [remember, setRemember] = useState(false);
  const choice = selected === null ? null : options[selected] ?? null;
  return (
    <ModalDialog
      className="voice-clarification-dialog"
      title={title ?? copy.card.medicineUnresolved(phrase)}
      onClose={onLeaveOut}
      initialFocusSelector="[data-voice-clarification-safe]"
      actions={
        <>
          <button type="button" className="btn btn-primary btn-wide" disabled={choice === null} onClick={() => choice && onChoose(choice, remember)}>
            {copy.card.chooseMedicine}
          </button>
          <button type="button" className="btn btn-outline btn-wide" data-voice-clarification-safe="" onClick={onLeaveOut}>
            {copy.card.leaveUnresolved}
          </button>
        </>
      }
    >
      {options.length === 0 ? (
        <p>{copy.card.noMedicines}</p>
      ) : (
        <fieldset className="voice-clarification-options">
          <legend className="sr-only">{copy.card.chooseMedicine}</legend>
          {options.map((option, index) => (
            <label key={option.medication.recordId} className="choice-row">
              <input type="radio" name={groupId} checked={selected === index} onChange={() => setSelected(index)} />
              <span>{option.name}</span>
            </label>
          ))}
        </fieldset>
      )}
      {choice && rememberable ? (
        <div className="voice-remember">
          <label className="choice-row">
            <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
            <span>{copy.card.rememberLabel(phrase, choice.name)}</span>
          </label>
          <p className="field-hint">{copy.card.rememberHint}</p>
        </div>
      ) : null}
    </ModalDialog>
  );
}
