"use client";

import { useState } from "react";
import type { AppMessages, SupportedLocale } from "@/i18n/types";
import type { MedicationSchedulePort } from "@/application/medication-schedule/medication-schedule-contracts";
import type { InquiryAnswerOptionKeyValue } from "@/domain/inquiry/inquiry-registry";
import { ModalDialog } from "../primitives/ModalDialog";
import { ChoiceGroup } from "../primitives/ChoiceGroup";
import { TextareaField } from "../primitives/Field";

export type BarrierAnswer = Parameters<MedicationSchedulePort["answerBarrier"]>[0]["answer"];

type Choice = InquiryAnswerOptionKeyValue | "SOMETHING_ELSE" | "NOT_SURE" | "PREFER_NOT_TO_SAY";

/** Matches the definition's Something-else limit (MEDICATION_OCCASION_BARRIER_V1). */
const SOMETHING_ELSE_MAX = 280;

type Props = {
  messages: AppMessages;
  locale: SupportedLocale;
  /** Why this is asked, naming the exact recorded occasion. */
  leadIn: string;
  question: string;
  options: readonly { optionKey: string; label: string }[];
  /** OFFER: a presented question (snooze and skip available). CORRECT: changing a saved answer. */
  mode: "OFFER" | "CORRECT";
  busy: boolean;
  failed: boolean;
  onSave: (answer: BarrierAnswer) => void;
  onSnooze?: () => void;
  onSkip?: () => void;
  onClose: () => void;
};

/**
 * Optional barrier question (Packet 8 Section 5.3): neutral, dismissible and
 * about one recorded occasion. Escape closes without recording anything.
 */
export function BarrierDialog({ messages, locale, leadIn, question, options, mode, busy, failed, onSave, onSnooze, onSkip, onClose }: Props) {
  const copy = messages.schedule;
  const [choice, setChoice] = useState<Choice | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | undefined>();

  function submit() {
    if (!choice) {
      setError(copy.stateRequired);
      return;
    }
    if (choice === "SOMETHING_ELSE") {
      const trimmed = text.trim();
      if (trimmed.length === 0) {
        setError(copy.somethingElseRequired);
        return;
      }
      setError(undefined);
      onSave({ kind: "SOMETHING_ELSE", text: trimmed, language: locale });
      return;
    }
    setError(undefined);
    if (choice === "NOT_SURE" || choice === "PREFER_NOT_TO_SAY") onSave({ kind: choice });
    else onSave({ kind: "OPTION", optionKey: choice });
  }

  return (
    <ModalDialog
      title={copy.barrierOfferTitle}
      description={<p>{leadIn}</p>}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn btn-primary btn-wide" onClick={submit} disabled={busy} aria-busy={busy || undefined}>
            {busy ? messages.shared.saving : copy.barrierSave}
          </button>
          {mode === "OFFER" ? (
            <>
              <button type="button" className="btn btn-outline btn-wide" onClick={onSnooze} disabled={busy}>
                {copy.barrierLater}
              </button>
              <button type="button" className="btn btn-ghost btn-wide" onClick={onSkip} disabled={busy}>
                {copy.barrierSkip}
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-outline btn-wide" onClick={onClose} disabled={busy}>
              {copy.cancelRecord}
            </button>
          )}
        </>
      }
    >
      {failed ? (
        <p className="field-error" role="alert">
          {copy.barrierSaveFailed}
        </p>
      ) : null}
      <ChoiceGroup<Choice>
        legend={question}
        variant="card"
        value={choice}
        onChange={(next) => {
          setChoice(next);
          setError(undefined);
        }}
        error={choice === "SOMETHING_ELSE" ? undefined : error}
        options={[
          ...options.map((option) => ({ value: option.optionKey as Choice, label: option.label })),
          { value: "SOMETHING_ELSE" as const, label: copy.barrierSomethingElse },
          { value: "NOT_SURE" as const, label: copy.barrierNotSure },
          { value: "PREFER_NOT_TO_SAY" as const, label: copy.barrierPreferNot },
        ]}
      />
      {choice === "SOMETHING_ELSE" ? (
        <TextareaField
          label={copy.somethingElseLabel}
          value={text}
          maxLength={SOMETHING_ELSE_MAX}
          onChange={(event) => setText(event.target.value)}
          error={error}
          lang={locale}
        />
      ) : null}
    </ModalDialog>
  );
}
