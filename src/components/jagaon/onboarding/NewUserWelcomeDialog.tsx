"use client";

import type { AppMessages } from "@/i18n/types";
import { ModalDialog } from "../primitives/ModalDialog";

type Props = {
  messages: AppMessages;
  /** The preferred name entered during setup, if any. */
  name: string | null;
  onClose: () => void;
};

/**
 * Owner decision 2026-10-16 (option A): after a new user finishes or skips "Start demo setup", one welcome on Today says the booklet is
 * new and empty, and how to explore sample records instead (Settings → Reset synthetic demo data → Use the prepared demo profile). It
 * only explains: nothing is added to her booklet from here. It is shown once per finished setup (never after the prepared profile).
 */
export function NewUserWelcomeDialog({ messages, name, onClose }: Props) {
  const t = messages.onboarding;
  return (
    <ModalDialog
      className="new-user-welcome-dialog"
      title={t.newUserWelcomeTitle(name)}
      description={<p>{t.newUserWelcomeBody}</p>}
      onClose={onClose}
      initialFocusSelector="[data-new-user-welcome-ok]"
      actions={
        <button type="button" className="btn btn-primary btn-wide" data-new-user-welcome-ok="" onClick={onClose}>
          {t.newUserWelcomeAction}
        </button>
      }
    >
      <p className="new-user-welcome-sample">{t.newUserWelcomeSample}</p>
    </ModalDialog>
  );
}
