"use client";

import { useState } from "react";
import type { AppMessages } from "@/i18n/types";
import type { TimePoint } from "@/domain/shared/temporal";
import { instantSchema, localDateSchema } from "@/domain/shared/time";
import type { AppointmentPayload } from "@/domain/care-plan/appointment";
import type { AppointmentView } from "@/application/care-organisation/care-organisation-contracts";
import type { AppointmentRevisionReason } from "@/application/care-organisation/care-organisation-contracts";
import { ModalDialog } from "../primitives/ModalDialog";
import { InputField } from "../primitives/Field";
import { ChoiceGroup } from "../primitives/ChoiceGroup";
import { localDateOfPoint } from "./care-format";

const HOME_TIME_ZONE = "Asia/Singapore";
const HOME_OFFSET_MINUTES = 480;

export type AppointmentEditorResult =
  | { kind: "CREATE"; payload: AppointmentPayload; scheduledAt: TimePoint }
  | { kind: "REVISE"; payload: AppointmentPayload; scheduledAt: TimePoint; reason: AppointmentRevisionReason };

type ChangeKind = "CORRECT" | "RESCHEDULED" | "CANCELLED";

/** "HH:MM" of an exact point in Singapore time, or "" when no clock time was entered. */
function clockOf(point: TimePoint): string {
  if (point.kind !== "EXACT") return "";
  const local = new Date(Date.parse(point.instantUtc) + HOME_OFFSET_MINUTES * 60_000);
  return local.toISOString().slice(11, 16);
}

/** The appointment time exactly as entered: a clock time makes an exact point, otherwise the date alone. */
function timePointOf(date: string, time: string): TimePoint | null {
  const localDate = localDateSchema.safeParse(date);
  if (!localDate.success) return null;
  if (!time) return { kind: "DATE_ONLY", localDate: localDate.data, timeZoneId: HOME_TIME_ZONE };
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) return null;
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const utc = Date.UTC(year, month - 1, day, Number(match[1]), Number(match[2])) - HOME_OFFSET_MINUTES * 60_000;
  const instant = instantSchema.safeParse(new Date(utc).toISOString());
  if (!instant.success) return null;
  return { kind: "EXACT", instantUtc: instant.data, timeZoneId: HOME_TIME_ZONE, utcOffsetMinutes: HOME_OFFSET_MINUTES };
}

const samePoint = (a: TimePoint, b: TimePoint) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Add the patient's appointment, or change it with an explicit reason.
 * Nothing here contacts the clinic or verifies the details.
 */
export function AppointmentEditor({
  messages,
  appointment,
  busy,
  failed,
  onSave,
  onClose,
}: {
  messages: AppMessages;
  appointment: AppointmentView | null;
  busy: boolean;
  failed: boolean;
  onSave: (result: AppointmentEditorResult) => void;
  onClose: () => void;
}) {
  const copy = messages.carePreparation;
  const [label, setLabel] = useState(appointment?.payload.appointmentLabel ?? "");
  const [date, setDate] = useState(appointment ? (localDateOfPoint(appointment.scheduledAt) ?? "") : "");
  const [time, setTime] = useState(appointment ? clockOf(appointment.scheduledAt) : "");
  const [change, setChange] = useState<ChangeKind | null>(null);
  const [errors, setErrors] = useState<{ label?: string; date?: string; change?: string }>({});

  function submit() {
    if (appointment && change === "CANCELLED") {
      // Cancelling keeps the recorded time; only the status changes.
      setErrors({});
      onSave({ kind: "REVISE", payload: { ...appointment.payload, status: "CANCELLED" }, scheduledAt: appointment.scheduledAt, reason: "CANCELLED" });
      return;
    }
    const trimmed = label.trim();
    const scheduledAt = timePointOf(date, time);
    const next = {
      label: trimmed ? undefined : messages.shared.requiredField,
      date: scheduledAt ? undefined : messages.shared.requiredField,
      change: appointment && !change ? messages.shared.requiredField : undefined,
    };
    if (appointment && change === "RESCHEDULED" && scheduledAt && samePoint(scheduledAt, appointment.scheduledAt)) next.date = messages.shared.invalidValue;
    setErrors(next);
    if (next.label || next.date || next.change || !scheduledAt) return;
    if (!appointment) {
      onSave({ kind: "CREATE", payload: { appointmentLabel: trimmed, service: { kind: "UNKNOWN" }, mode: "UNKNOWN", status: "SCHEDULED" }, scheduledAt });
      return;
    }
    // A renamed appointment drops the older contact and place labels instead of keeping stale ones.
    const { careContactLabel: _contact, locationLabel: _place, ...rest } = appointment.payload;
    const payload: AppointmentPayload = trimmed === appointment.payload.appointmentLabel ? appointment.payload : { ...rest, appointmentLabel: trimmed };
    if (change === "RESCHEDULED") {
      onSave({ kind: "REVISE", payload, scheduledAt, reason: "RESCHEDULED" });
      return;
    }
    onSave({ kind: "REVISE", payload, scheduledAt, reason: "RECORDED_ERROR_CORRECTED" });
  }

  const cancelling = appointment !== null && change === "CANCELLED";
  return (
    <ModalDialog
      title={appointment ? copy.changeAppointment : copy.addAppointment}
      description={appointment ? <p>{appointment.payload.appointmentLabel}</p> : undefined}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn btn-primary btn-wide" onClick={submit} disabled={busy} aria-busy={busy || undefined}>
            {busy ? messages.shared.saving : messages.shared.save}
          </button>
          <button type="button" className="btn btn-outline btn-wide" onClick={onClose} disabled={busy}>
            {messages.shared.cancel}
          </button>
        </>
      }
    >
      {failed ? (
        <p className="field-error" role="alert">
          {copy.saveFailed}
        </p>
      ) : null}
      {appointment ? (
        <ChoiceGroup<ChangeKind>
          legend={copy.changeKindLabel}
          variant="card"
          value={change}
          onChange={setChange}
          error={errors.change}
          options={[
            { value: "CORRECT", label: copy.changeCorrect },
            { value: "RESCHEDULED", label: copy.changeRescheduled },
            { value: "CANCELLED", label: copy.changeCancelled },
          ]}
        />
      ) : null}
      {cancelling ? null : (
        <>
          <InputField label={copy.appointmentWhoLabel} value={label} maxLength={120} required onChange={(event) => setLabel(event.target.value)} error={errors.label} />
          <InputField label={copy.appointmentDateLabel} type="date" value={date} required onChange={(event) => setDate(event.target.value)} error={errors.date} />
          <InputField label={copy.appointmentTimeLabel} type="time" value={time} onChange={(event) => setTime(event.target.value)} />
        </>
      )}
    </ModalDialog>
  );
}
