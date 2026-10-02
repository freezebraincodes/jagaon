"use client";

import type { RefObject } from "react";
import type { AppMessages } from "@/i18n/types";
import { AlertDialog } from "../primitives/AlertDialog";
import { ResetIcon, ShieldIcon } from "../primitives/Icons";

/** Frame 30. Restarting removes only the saved demo setup on this device. */
export function RestartConfirmationDialog({
  messages,
  savedSummary,
  onKeep,
  onRestart,
  returnFocusRef,
}: {
  messages: AppMessages;
  savedSummary: string;
  onKeep: () => void;
  onRestart: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const msg = messages.onboarding;
  return (
    <AlertDialog
      title={msg.restartTitle}
      icon={<ResetIcon size={28} />}
      cancelLabel={msg.keepProgress}
      cancelIcon={<ShieldIcon size={22} />}
      onCancel={onKeep}
      confirmLabel={msg.confirmRestart}
      confirmIcon={<ResetIcon size={22} />}
      onConfirm={onRestart}
      returnFocusRef={returnFocusRef}
    >
      <p>{msg.restartBody(savedSummary)}</p>
      <p className="alert-dialog-note">{msg.restartNoReal}</p>
    </AlertDialog>
  );
}
