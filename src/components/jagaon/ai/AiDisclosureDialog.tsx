"use client";

import { useId, useState } from "react";
import type { AppMessages } from "@/i18n/types";
import { ModalDialog } from "../primitives/ModalDialog";

/** Which flow's approved primary action the disclosure offers. */
export type AiDisclosureFlow = "PATTERN" | "CARE_SUMMARY";

/**
 * Packet 11C Addendum C, Task C6: the app session's demo passcode entry (structurally the browser wiring's in-memory entry). `needed()`:
 * no passcode is held; `provide(passcode)`: hold it in memory for the session (false when it cannot be sent).
 */
export type AiDisclosurePasscodeEntry = Readonly<{ needed(): boolean; provide(passcode: string): boolean }>;

type Props = {
  messages: AppMessages;
  flow: AiDisclosureFlow;
  /**
   * The patient accepts remote use for the one request this dialog was shown for (Packet 11C Addendum C, C3: acceptance is per explicit
   * request); the caller makes that request with the acceptance and remembers nothing.
   */
  onConfirm: () => void;
  /** The safe action (also Escape): nothing is sent; the caller continues without AI. */
  onCancel: () => void;
  /**
   * Packet 11C Addendum C, Task C6: the demo passcode entry. While it is `needed()` (asked once, when the dialog opens), the dialog shows
   * a password field, and the primary action hands the entered value to `provide` before `onConfirm`. Owner UI decision U03
   * (2026-10-09): the primary action stays disabled until the field holds non-whitespace input; Cancel stays available. Absent, null,
   * not needed or unreadable: no field (the route still checks).
   */
  passcode?: AiDisclosurePasscodeEntry | null;
};

function passcodeNeeded(entry: AiDisclosurePasscodeEntry | null | undefined): boolean {
  try {
    return entry?.needed() === true;
  } catch {
    return false;
  }
}

/**
 * Packet 11C Addendum B, Task B3 (original Task 4): the shared AI disclosure, shown by a screen BEFORE it makes any request that could
 * use the remote route, and never while the task is NOT_ACTIVATED (the caller decides that). The copy is the Packet 11 catalogue
 * (`messages.ai`): the approved title, limit, Cancel and the flow's approved primary action, and the corrected value-blind body
 * (ai-disclosure.11c.1). It makes no consent or confidentiality claim.
 *
 * It is the shared modal primitive: named by its heading, described by the body and the limit, initial focus on the safe action
 * (Cancel), Tab and Shift+Tab kept inside, Escape takes the safe action, and focus returns to the control that opened it when it
 * closes (including when the caller closes it because the request became moot). This component is AI-free: it imports no AI module,
 * reads nothing and sends nothing. Presentation: human acceptance pending.
 *
 * Packet 11C Addendum C, Task C6: the optional demo passcode field (`messages.aiAccess`, new wording; field and placement human acceptance
 * pending). The typed value lives only in this dialog's state until it closes; it is handed to the session's in-memory entry on the
 * primary action only (never on Cancel or Escape) and is never stored, shown elsewhere or sent by this component.
 */
export function AiDisclosureDialog({ messages, flow, onConfirm, onCancel, passcode = null }: Props) {
  const t = messages.ai;
  const confirm = flow === "PATTERN" ? t.pattern.confirm : t.careSummary.confirm;
  const fieldId = useId();
  const [askPasscode] = useState(() => passcodeNeeded(passcode));
  const [entered, setEntered] = useState("");
  // Owner UI decision U03 (2026-10-09): while the field is required, the primary action waits for non-whitespace input. Cancel stays
  // available and the route still checks every passcode (a value it cannot accept is refused ACCESS_DENIED; fail closed).
  const awaitingPasscode = askPasscode && entered.trim().length === 0;
  const accept = () => {
    if (awaitingPasscode) return;
    if (askPasscode && entered.length > 0) {
      try {
        passcode?.provide(entered);
      } catch {
        // Not held: the route refuses the request without a passcode (fail closed).
      }
    }
    onConfirm();
  };
  return (
    <ModalDialog
      className="ai-disclosure-dialog"
      title={t.remoteTitle}
      description={
        <>
          <p className="ai-disclosure-body">{t.remoteBody}</p>
          <p className="ai-disclosure-limit">{t.remoteLimit}</p>
        </>
      }
      onClose={onCancel}
      initialFocusSelector="[data-ai-disclosure-safe]"
      actions={
        <>
          <button type="button" className="btn btn-primary btn-wide" disabled={awaitingPasscode} onClick={accept}>
            {confirm}
          </button>
          <button type="button" className="btn btn-outline btn-wide" data-ai-disclosure-safe="" onClick={onCancel}>
            {t.cancel}
          </button>
        </>
      }
    >
      {askPasscode ? (
        <div className="field ai-disclosure-passcode">
          <label className="field-label" htmlFor={fieldId}>
            {messages.aiAccess.passcodeLabel}
          </label>
          <input id={fieldId} className="input" type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} value={entered} onChange={(event) => setEntered(event.target.value)} />
        </div>
      ) : null}
    </ModalDialog>
  );
}
