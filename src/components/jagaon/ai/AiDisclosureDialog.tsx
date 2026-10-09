"use client";

import type { AppMessages } from "@/i18n/types";
import { ModalDialog } from "../primitives/ModalDialog";

/** Which flow's approved primary action the disclosure offers. */
export type AiDisclosureFlow = "PATTERN" | "CARE_SUMMARY";

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
};

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
 */
export function AiDisclosureDialog({ messages, flow, onConfirm, onCancel }: Props) {
  const t = messages.ai;
  const confirm = flow === "PATTERN" ? t.pattern.confirm : t.careSummary.confirm;
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
          <button type="button" className="btn btn-primary btn-wide" onClick={onConfirm}>
            {confirm}
          </button>
          <button type="button" className="btn btn-outline btn-wide" data-ai-disclosure-safe="" onClick={onCancel}>
            {t.cancel}
          </button>
        </>
      }
    >
      {null}
    </ModalDialog>
  );
}
