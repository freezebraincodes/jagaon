"use client";

import type { AppMessages } from "@/i18n/types";
import { ModalDialog } from "../primitives/ModalDialog";
import type { AiDisclosureFlow } from "./AiDisclosureDialog";

type Props = {
  messages: AppMessages;
  /** Which flow's standard wording the text names: the care summary ("Your summary") or the history explanation ("The explanation"). */
  flow: AiDisclosureFlow;
  /** OK (also Escape): closes the dialog; the standard wording the screen already holds stays shown. */
  onClose: () => void;
};

/**
 * Owner decision 2026-10-12 (AI credit dialog): shown by a screen when its explicit AI wording request was refused because the demo's AI
 * credit is used up: the daily spend limit (the route's SPEND_CEILING_REACHED) or the DeepSeek account balance (OPERATIONAL_SPEND_LOCKED,
 * from the provider's HTTP 402). The caller decides that from the browser wiring's `remoteUse: "CREDIT_LIMIT_REACHED"` marker; this
 * component reads, stores and sends nothing and imports no AI module.
 *
 * The copy is `messages.aiCreditLimit` (en-SG: the owner's wording; zh-SG: drafts, Chinese acceptance deferred). It is the shared modal
 * primitive: named by its title, described by the text, initial focus on OK (the only action), Tab kept inside, Escape takes the same
 * action, and focus returns to the control that was focused when it opened.
 */
export function AiCreditLimitDialog({ messages, flow, onClose }: Props) {
  const t = messages.aiCreditLimit;
  return (
    <ModalDialog
      className="ai-credit-limit-dialog"
      title={t.title}
      description={<p>{flow === "PATTERN" ? t.historyBody : t.careSummaryBody}</p>}
      onClose={onClose}
      initialFocusSelector="[data-ai-credit-limit-ok]"
      actions={
        <button type="button" className="btn btn-primary btn-wide" data-ai-credit-limit-ok="" onClick={onClose}>
          {t.ok}
        </button>
      }
    >
      {null}
    </ModalDialog>
  );
}
