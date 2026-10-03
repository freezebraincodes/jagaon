"use client";

import { useState } from "react";
import type { AppMessages, SupportedLocale } from "@/i18n/types";
import type { ScheduleReminderView } from "@/application/medication-schedule/medication-schedule-contracts";
import { formatScheduleTime } from "@/application/medication-schedule/schedule-format";
import { ModalDialog } from "../primitives/ModalDialog";
import { TimeWheel } from "../primitives/TimeWheel";
import { labelAndValue } from "../locale-format";

export type ReminderChange =
  | { kind: "PAUSE" }
  | { kind: "RESUME" }
  | { kind: "END" }
  | { kind: "CONFIRM_REVIEW" }
  | { kind: "CHANGE_TIME"; time: string };

/** Chooses a new time for a patient-configured reminder; saving still needs confirmation. */
export function ReminderTimeDialog({
  messages,
  reminder,
  onContinue,
  onClose,
}: {
  messages: AppMessages;
  reminder: ScheduleReminderView;
  onContinue: (time: string) => void;
  onClose: () => void;
}) {
  const copy = messages.schedule;
  const [time, setTime] = useState(reminder.times[0] ?? "09:00");
  return (
    <ModalDialog
      title={copy.changeReminderSettings}
      description={<p>{reminder.label}</p>}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn btn-primary btn-wide" onClick={() => onContinue(time)}>
            {copy.reminderConfirm}
          </button>
          <button type="button" className="btn btn-outline btn-wide" onClick={onClose}>
            {copy.reminderCancel}
          </button>
        </>
      }
    >
      <TimeWheel legend={copy.reminderTimeLabel} value={time} onChange={setTime} messages={messages.readingTime} />
    </ModalDialog>
  );
}

/** Explicit confirmation before any reminder change is saved (Section 5.5). */
export function ReminderConfirmDialog({
  messages,
  locale,
  reminder,
  change,
  busy,
  failed,
  onConfirm,
  onClose,
}: {
  messages: AppMessages;
  locale: SupportedLocale;
  reminder: ScheduleReminderView;
  change: ReminderChange;
  busy: boolean;
  failed: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const copy = messages.schedule;
  const nextTimes =
    change.kind === "CHANGE_TIME"
      ? [change.time]
      : change.kind === "CONFIRM_REVIEW" && reminder.currentPrescription && reminder.currentPrescription.times.length > 0
        ? reminder.currentPrescription.times
        : reminder.times;
  const nextState = change.kind === "PAUSE" || change.kind === "END" ? copy.reminderOff : copy.reminderOn;
  return (
    <ModalDialog
      title={copy.reminderConfirmTitle}
      description={<p>{copy.reminderConfirmBody}</p>}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn btn-primary btn-wide" onClick={onConfirm} disabled={busy} aria-busy={busy || undefined}>
            {busy ? messages.shared.saving : copy.reminderConfirm}
          </button>
          <button type="button" className="btn btn-outline btn-wide" onClick={onClose} disabled={busy}>
            {copy.reminderCancel}
          </button>
        </>
      }
    >
      {failed ? (
        <p className="field-error" role="alert">
          {copy.reminderFailed}
        </p>
      ) : null}
      <dl className="schedule-confirm-summary">
        <div>
          <dt>{copy.remindersHeading}</dt>
          <dd>{reminder.label}</dd>
        </div>
        <div>
          <dt>{copy.reminderTimeLabel}</dt>
          <dd>{nextTimes.map((time) => formatScheduleTime(locale, time)).join(" · ")}</dd>
        </div>
      </dl>
      <p>{labelAndValue(locale, copy.reminderToggleLabel(reminder.label), nextState)}</p>
      <p className="alert-dialog-note">{copy.inAppOnly}</p>
    </ModalDialog>
  );
}
