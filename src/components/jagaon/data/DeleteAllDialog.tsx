"use client";

import { useId, useState, type RefObject } from "react";
import type { AppMessages } from "@/i18n/types";
import type { DeleteAllPlan } from "@/storage/delete-dataset";
import { AlertDialog } from "../primitives/AlertDialog";
import { Banner } from "../primitives/Card";
import { ShieldIcon, TabsIcon, TrashIcon } from "../primitives/Icons";
import type { DeleteAllPort } from "./data-ports";
import { failureMessage } from "./failure-copy";

/**
 * `REQUESTED` and `WAITING_FOR_TAB` follow the irreversible IndexedDB delete
 * request: the dialog then cannot be cancelled, resubmitted or dismissed.
 */
type Phase = { kind: "IDLE" } | { kind: "CHECKING" } | { kind: "REQUESTED" } | { kind: "WAITING_FOR_TAB" } | { kind: "BLOCKED" } | { kind: "FAILED"; message: string };

/**
 * Frame 11: whole-dataset deletion. Focus opens on "Keep my data"; the
 * destructive action stays disabled until the locked token `DELETE` is typed
 * exactly, and acts only on a fresh plan. Another open tab blocks it with
 * nothing deleted.
 */
export function DeleteAllDialog({
  messages,
  port,
  onClose,
  onDeleted,
  returnFocusRef,
}: {
  messages: AppMessages;
  port: DeleteAllPort;
  onClose: () => void;
  onDeleted: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const copy = messages.packet10.deletion;
  const inputId = useId();
  const [plan, setPlan] = useState<DeleteAllPlan>(() => port.prepare());
  const [typed, setTyped] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "IDLE" });
  const matches = typed === copy.deleteConfirmToken;
  const committed = phase.kind === "REQUESTED" || phase.kind === "WAITING_FOR_TAB";
  const busy = committed || phase.kind === "CHECKING";

  async function confirm() {
    if (!matches) return;
    setPhase({ kind: "CHECKING" });
    const result = await port.confirm(plan, typed, {
      onRequestIssued: () => setPhase({ kind: "REQUESTED" }),
      onBlocked: () => setPhase({ kind: "WAITING_FOR_TAB" }),
    });
    if (result.kind === "DELETED") {
      onDeleted();
      return;
    }
    if (result.kind === "BLOCKED") setPhase({ kind: "BLOCKED" });
    else if (result.kind === "FAILED") setPhase({ kind: "FAILED", message: failureMessage(messages, result.failure.userMessageKey) });
    else {
      // An expired plan is never reused: start a fresh confirmation.
      setPlan(port.prepare());
      setTyped("");
      setPhase({ kind: "IDLE" });
    }
  }

  return (
    <AlertDialog
      title={copy.deleteAllTitle}
      icon={<TrashIcon size={28} className="icon icon-danger" />}
      cancelLabel={copy.keepData}
      cancelIcon={<ShieldIcon size={22} />}
      onCancel={onClose}
      confirmLabel={copy.deleteAllAction}
      confirmIcon={<TrashIcon size={22} />}
      onConfirm={() => void confirm()}
      confirmDisabled={!matches || busy}
      confirmBusy={busy}
      cancelDisabled={busy}
      returnFocusRef={returnFocusRef}
    >
      <p>{copy.deleteAllBody}</p>
      <p className="alert-dialog-note">{copy.deleteAllCopies}</p>
      <div className="field">
        <label className="field-label" htmlFor={inputId}>
          {copy.typeToConfirm}
        </label>
        <input
          id={inputId}
          className="input"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          lang="en"
          disabled={busy}
        />
      </div>
      {phase.kind === "BLOCKED" ? (
        <Banner variant="error" role="alert" title={copy.deleteBlocked}>
          {copy.deleteBlockedUnchanged}
        </Banner>
      ) : null}
      {phase.kind === "WAITING_FOR_TAB" ? (
        <Banner variant="warning" role="alert">
          <span className="banner-inline-icon">
            <TabsIcon size={20} />
          </span>
          {copy.deleteBlocked}
        </Banner>
      ) : null}
      {phase.kind === "FAILED" ? (
        <Banner variant="error" role="alert">
          {phase.message}
        </Banner>
      ) : null}
    </AlertDialog>
  );
}
