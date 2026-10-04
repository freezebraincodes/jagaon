"use client";

import { useEffect, useState, type RefObject } from "react";
import type { DeletionPlan, DeletionTarget, PrepareDeletionResult } from "@/application/deletion/deletion-contracts";
import type { AppMessages, SupportedLocale } from "@/i18n/types";
import { AlertDialog } from "../primitives/AlertDialog";
import { Banner } from "../primitives/Card";
import { ShieldIcon, TrashIcon } from "../primitives/Icons";
import type { RecordDeletionPort } from "./data-ports";
import { failureMessage, formatCount } from "./failure-copy";

type State =
  | { kind: "PREPARING" }
  | { kind: "READY"; plan: DeletionPlan; changed: boolean }
  | { kind: "DELETING"; plan: DeletionPlan }
  | { kind: "UNAVAILABLE"; message: string };

/**
 * Frame 10: permanent-record deletion as an accessible alertdialog over the
 * originating view (frozen resolution 6). The items come only from the
 * owner deletion-plan result (resolution 7); a changed plan is recalculated
 * and must be confirmed again (resolution 5).
 */
export function RecordDeletionDialog({
  messages,
  locale,
  port,
  target,
  recordLabel,
  recordWhen,
  now,
  onClose,
  onDeleted,
  returnFocusRef,
}: {
  messages: AppMessages;
  locale: SupportedLocale;
  port: RecordDeletionPort;
  target: DeletionTarget;
  /** Owner-supplied label and locale-formatted time (PARAMETER_ONLY rows). */
  recordLabel: string;
  recordWhen: string;
  now: () => string;
  onClose: () => void;
  onDeleted: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const copy = messages.packet10.deletion;
  const [state, setState] = useState<State>({ kind: "PREPARING" });

  function stateFor(result: PrepareDeletionResult, changed: boolean): State {
    if (result.kind === "PLAN_READY") return { kind: "READY", plan: result.plan, changed };
    return { kind: "UNAVAILABLE", message: result.kind === "FAILED" ? failureMessage(messages, result.failure.userMessageKey) : messages.packet10.shared.recordsUnchanged };
  }

  async function prepare(changed: boolean) {
    setState(stateFor(await port.prepare(target), changed));
  }

  useEffect(() => {
    let active = true;
    void port.prepare(target).then((result) => {
      if (active) setState(stateFor(result, false));
    });
    return () => {
      active = false;
    };
    // The target is fixed for the dialog's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function confirm() {
    if (state.kind !== "READY") return;
    const plan = state.plan;
    setState({ kind: "DELETING", plan });
    const result = await port.confirm(plan, { planHash: plan.planHash, confirmedAt: now() as never });
    if (result.kind === "DELETED") onDeleted();
    else if (result.kind === "STALE") await prepare(true);
    else setState({ kind: "UNAVAILABLE", message: failureMessage(messages, result.failure.userMessageKey) });
  }

  const plan = state.kind === "READY" || state.kind === "DELETING" ? state.plan : null;
  return (
    <AlertDialog
      title={copy.deleteRecordTitle}
      icon={<TrashIcon size={28} className="icon icon-danger" />}
      cancelLabel={copy.keepRecord}
      cancelIcon={<ShieldIcon size={22} />}
      onCancel={onClose}
      confirmLabel={copy.deleteRecordAction}
      confirmIcon={<TrashIcon size={22} />}
      onConfirm={() => void confirm()}
      confirmDisabled={plan === null}
      confirmBusy={state.kind === "DELETING" || state.kind === "PREPARING"}
      returnFocusRef={returnFocusRef}
    >
      <p>{copy.deleteRecordBody}</p>
      <dl className="data-plan">
        <div className="data-plan-row">
          <dt>{copy.recordK}</dt>
          <dd>
            <span className="data-plan-strong">{recordLabel}</span>
            <span className="data-plan-meta">{recordWhen}</span>
          </dd>
        </div>
        {plan ? (
          <div className="data-plan-row">
            <dt>{copy.planK}</dt>
            <dd>
              <ul className="data-plan-list">
                <li>{copy.deletePlanItems.self}</li>
                <li>{plan.effects.dependentCount > 0 ? copy.deletePlanItems.dependent(formatCount(locale, plan.effects.dependentCount)) : copy.deletePlanItems.none}</li>
              </ul>
            </dd>
          </div>
        ) : null}
      </dl>
      <p className="alert-dialog-note">{copy.externalCopiesRemain}</p>
      <p className="alert-dialog-note">{messages.packet10.restore.planExpires}</p>
      {state.kind === "READY" && state.changed ? (
        <Banner variant="warning" role="alert">
          {copy.deletionChanged}
        </Banner>
      ) : null}
      {state.kind === "PREPARING" ? <p role="status">{messages.shared.loading}</p> : null}
      {state.kind === "UNAVAILABLE" ? (
        <Banner variant="error" role="alert">
          {state.message}
        </Banner>
      ) : null}
    </AlertDialog>
  );
}
