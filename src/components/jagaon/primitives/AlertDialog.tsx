"use client";

import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";

type AlertDialogProps = {
  title: string;
  icon?: ReactNode;
  children: ReactNode;
  /** Safe action: focused on open, also triggered by Escape. */
  cancelLabel: string;
  cancelIcon?: ReactNode;
  onCancel: () => void;
  /** Destructive action, styled as an outline danger button. */
  confirmLabel: string;
  confirmIcon?: ReactNode;
  onConfirm: () => void;
  /** Element that receives focus again when the dialog closes. */
  returnFocusRef?: RefObject<HTMLElement | null>;
  /** Packet 10: the destructive action stays unavailable until its own preconditions hold. */
  confirmDisabled?: boolean;
  confirmBusy?: boolean;
  /** Packet 10: once an irreversible request is running, neither Escape nor the safe action can dismiss it. */
  cancelDisabled?: boolean;
};

/**
 * Modal alert dialog: focus opens on the safe action, Tab stays inside the
 * dialog, Escape cancels, and focus returns to the originating control.
 */
export function AlertDialog({
  title,
  icon,
  children,
  cancelLabel,
  cancelIcon,
  onCancel,
  confirmLabel,
  confirmIcon,
  onConfirm,
  returnFocusRef,
  confirmDisabled = false,
  confirmBusy = false,
  cancelDisabled = false,
}: AlertDialogProps) {
  const id = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const safeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    safeRef.current?.focus();
    const returnTarget = returnFocusRef?.current ?? null;
    return () => {
      returnTarget?.focus();
    };
  }, [returnFocusRef]);

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      if (!cancelDisabled) onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [
      ...(dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex='-1'])") ?? []),
    ];
    if (focusable.length === 0) return;
    // Every Tab is handled here so focus cycles inside the dialog even where the
    // browser's own Tab order skips buttons (WebKit's default keyboard setting).
    event.preventDefault();
    const index = focusable.indexOf(document.activeElement as HTMLElement);
    const next = event.shiftKey ? (index <= 0 ? focusable.length - 1 : index - 1) : index === -1 || index === focusable.length - 1 ? 0 : index + 1;
    focusable[next]!.focus();
  }

  return (
    <div className="dialog-backdrop">
      <div
        ref={dialogRef}
        className="alert-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-body`}
        aria-busy={cancelDisabled || confirmBusy || undefined}
        onKeyDown={onKeyDown}
      >
        <h2 className="alert-dialog-title" id={`${id}-title`}>
          {icon}
          {title}
        </h2>
        <div className="alert-dialog-body" id={`${id}-body`}>
          {children}
        </div>
        <div className="button-stack">
          <button ref={safeRef} type="button" className="btn btn-dark btn-wide" onClick={onCancel} disabled={cancelDisabled}>
            {cancelIcon}
            {cancelLabel}
          </button>
          <button
            type="button"
            className="btn btn-danger-outline btn-wide"
            onClick={onConfirm}
            disabled={confirmDisabled || confirmBusy}
            aria-busy={confirmBusy || undefined}
          >
            {confirmIcon}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
