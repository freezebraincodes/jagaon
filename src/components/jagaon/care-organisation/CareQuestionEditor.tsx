"use client";

import { useState } from "react";
import type { AppMessages } from "@/i18n/types";
import { ModalDialog } from "../primitives/ModalDialog";
import { TextareaField } from "../primitives/Field";

/** Add or edit the patient's own question. The words are stored as typed; nothing answers them. */
export function CareQuestionEditor({
  messages,
  initialText,
  busy,
  failed,
  onSave,
  onClose,
}: {
  messages: AppMessages;
  initialText: string | null;
  busy: boolean;
  failed: boolean;
  onSave: (text: string) => void;
  onClose: () => void;
}) {
  const copy = messages.carePreparation;
  const [text, setText] = useState(initialText ?? "");
  const [error, setError] = useState<string | undefined>();
  function submit() {
    const value = text.trim();
    if (value.length === 0) {
      setError(messages.shared.requiredField);
      return;
    }
    setError(undefined);
    onSave(value);
  }
  return (
    <ModalDialog
      title={initialText === null ? copy.addOwnQuestion : copy.editQuestion}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn btn-primary btn-wide" onClick={submit} disabled={busy} aria-busy={busy || undefined}>
            {busy ? messages.shared.saving : messages.shared.save}
          </button>
          <button type="button" className="btn btn-outline btn-wide" onClick={onClose} disabled={busy}>
            {messages.shared.cancel}
          </button>
        </>
      }
    >
      {failed ? (
        <p className="field-error" role="alert">
          {copy.saveFailed}
        </p>
      ) : null}
      <TextareaField label={copy.questionLabel} hint={copy.questionHint} value={text} maxLength={500} rows={3} required onChange={(event) => setText(event.target.value)} error={error} />
    </ModalDialog>
  );
}
