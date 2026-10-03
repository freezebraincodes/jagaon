"use client";

import { useState } from "react";
import type { AppMessages } from "@/i18n/types";
import { ModalDialog } from "../primitives/ModalDialog";
import { TextareaField } from "../primitives/Field";

/** Matches the care-question text bound (PATIENT_AUTHORED_TEXT_LIMIT). */
const QUESTION_MAX = 1000;

type Props = {
  messages: AppMessages;
  initialText: string;
  editing: boolean;
  busy: boolean;
  failed: boolean;
  onSave: (text: string) => void;
  onClose: () => void;
};

/** User-authored care question (Section 5.6): saved locally, never answered, sent or summarised. */
export function CareQuestionDialog({ messages, initialText, editing, busy, failed, onSave, onClose }: Props) {
  const copy = messages.schedule;
  const [text, setText] = useState(initialText);
  const [error, setError] = useState<string | undefined>();

  function submit() {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      setError(copy.questionRequired);
      return;
    }
    setError(undefined);
    onSave(trimmed);
  }

  return (
    <ModalDialog
      title={editing ? copy.questionEdit : copy.addProfessionalQuestion}
      description={<p>{copy.questionHelp}</p>}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn btn-primary btn-wide" onClick={submit} disabled={busy} aria-busy={busy || undefined}>
            {busy ? messages.shared.saving : copy.questionSave}
          </button>
          <button type="button" className="btn btn-outline btn-wide" onClick={onClose} disabled={busy}>
            {copy.cancelRecord}
          </button>
        </>
      }
    >
      {failed ? (
        <p className="field-error" role="alert">
          {copy.saveFailedBody}
        </p>
      ) : null}
      <TextareaField label={copy.questionTitle} value={text} maxLength={QUESTION_MAX} onChange={(event) => setText(event.target.value)} error={error} rows={4} />
    </ModalDialog>
  );
}
