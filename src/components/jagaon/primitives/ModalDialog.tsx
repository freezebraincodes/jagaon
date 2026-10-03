"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

type ModalDialogProps = {
  title: string;
  /** Short context shown under the title and used as the accessible description. */
  description?: ReactNode;
  children: ReactNode;
  /** Labelled safe action: closes the dialog without changing anything. Also bound to Escape. */
  onClose: () => void;
  /** Actions row; the caller supplies the save and safe-close buttons. */
  actions: ReactNode;
  /** Optional element to receive focus first; defaults to the first focusable control. */
  initialFocusSelector?: string;
};

const FOCUSABLE = "button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])";

/**
 * Modal sheet dialog (Packet 8 design Section 9): focus moves into the dialog,
 * Tab and Shift+Tab stay inside it, Escape takes the labelled safe action, and
 * focus returns to the control that opened it. If that control is gone, focus
 * moves to the screen heading instead of being lost.
 */
export function ModalDialog({ title, description, children, onClose, actions, initialFocusSelector }: ModalDialogProps) {
  const id = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const first =
      (initialFocusSelector ? dialog?.querySelector<HTMLElement>(initialFocusSelector) : null) ??
      dialog?.querySelector<HTMLElement>(FOCUSABLE) ??
      dialog;
    first?.focus();
    return () => {
      if (opener && opener.isConnected) {
        opener.focus();
        return;
      }
      const heading = document.querySelector<HTMLElement>("main h1");
      if (heading) {
        heading.setAttribute("tabindex", "-1");
        heading.focus();
      }
    };
    // Focus moves once, when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
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
        className="alert-dialog modal-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={description ? `${id}-description` : undefined}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <h2 className="alert-dialog-title" id={`${id}-title`}>
          {title}
        </h2>
        {description ? (
          <div className="modal-dialog-description" id={`${id}-description`}>
            {description}
          </div>
        ) : null}
        <div className="alert-dialog-body">{children}</div>
        <div className="button-stack">{actions}</div>
      </div>
    </div>
  );
}
