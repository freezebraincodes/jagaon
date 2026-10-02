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
      onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [
      ...(dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), [href], input, [tabindex]:not([tabindex='-1'])") ?? []),
    ];
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
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
          <button ref={safeRef} type="button" className="btn btn-dark btn-wide" onClick={onCancel}>
            {cancelIcon}
            {cancelLabel}
          </button>
          <button type="button" className="btn btn-danger-outline btn-wide" onClick={onConfirm}>
            {confirmIcon}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
