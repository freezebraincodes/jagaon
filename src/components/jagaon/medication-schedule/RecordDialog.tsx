"use client";

import { useState } from "react";
import type { AppMessages, SupportedLocale } from "@/i18n/types";
import type {
  ScheduleAmount,
  ScheduleOccasionView,
  ScheduleRecordedState,
} from "@/application/medication-schedule/medication-schedule-contracts";
import { formatScheduleDate, formatScheduleTime } from "@/application/medication-schedule/schedule-format";
import { ModalDialog } from "../primitives/ModalDialog";
import { ChoiceGroup } from "../primitives/ChoiceGroup";
import { InputField } from "../primitives/Field";
import { Notice } from "../primitives/ScreenHeader";
import { unitLabel } from "./schedule-labels";

type AmountMode = "KNOWN" | "UNSURE" | "NOT_RECORDED";

export type RecordSubmission = { state: ScheduleRecordedState; amount: ScheduleAmount | null };

type Props = {
  messages: AppMessages;
  locale: SupportedLocale;
  occasion: ScheduleOccasionView;
  correcting: boolean;
  /** True while the save is in flight. */
  busy: boolean;
  /** Set after a failed save; the entered state stays on screen. */
  failed: boolean;
  onSave: (submission: RecordSubmission) => void;
  onClose: () => void;
};

const AMOUNT_PATTERN = /^(?:0|[1-9]\d{0,3})(?:\.\d{1,2})?$/;

/**
 * Add record / Correct this record (Packet 8 Section 5.2). Only the patient's
 * explicit choice is saved: nothing is preselected, a taken amount is never
 * prefilled, calculated or compared, and a failed save keeps every entry.
 */
export function RecordDialog({ messages, locale, occasion, correcting, busy, failed, onSave, onClose }: Props) {
  const copy = messages.schedule;
  const [state, setState] = useState<ScheduleRecordedState | null>(null);
  const [amountMode, setAmountMode] = useState<AmountMode | null>(null);
  const [amountValue, setAmountValue] = useState("");
  const [errors, setErrors] = useState<{ state?: string; amount?: string }>({});
  const unit = occasion.amountUnit;
  const unitText = unit ? unitLabel(copy, unit) : "";

  function submit() {
    if (!state) {
      setErrors({ state: copy.stateRequired });
      return;
    }
    if (state !== "TAKEN") {
      setErrors({});
      onSave({ state, amount: null });
      return;
    }
    if (!amountMode) {
      setErrors({ amount: copy.amountRequired });
      return;
    }
    if (amountMode === "KNOWN") {
      const value = amountValue.trim();
      if (!unit || !AMOUNT_PATTERN.test(value) || Number(value) === 0) {
        setErrors({ amount: copy.amountRequired });
        return;
      }
      setErrors({});
      onSave({ state, amount: { kind: "KNOWN", value, unit: unit.unit, otherUnitText: unit.otherUnitText } });
      return;
    }
    setErrors({});
    onSave({ state, amount: { kind: amountMode } });
  }

  const amountOptions = [
    ...(unit ? [{ value: "KNOWN" as const, label: copy.amountKnown }] : []),
    { value: "UNSURE" as const, label: copy.amountUnknown },
    { value: "NOT_RECORDED" as const, label: copy.amountOmitted },
  ];

  return (
    <ModalDialog
      title={correcting ? copy.changeRecord : copy.recordTitle}
      description={
        <p>{copy.recordOccasion(occasion.medicineName, formatScheduleDate(locale, occasion.localDate), formatScheduleTime(locale, occasion.scheduledTime))}</p>
      }
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn btn-primary btn-wide" onClick={submit} disabled={busy} aria-busy={busy || undefined}>
            {busy ? messages.shared.saving : failed ? copy.trySavingAgain : copy.saveRecord}
          </button>
          <button type="button" className="btn btn-outline btn-wide" onClick={onClose} disabled={busy}>
            {copy.cancelRecord}
          </button>
        </>
      }
    >
      {failed ? (
        <div className="banner banner-error" role="alert">
          <div className="banner-content">
            <p className="banner-title">{copy.saveFailedTitle}</p>
            <p className="banner-body">{copy.saveFailedBody}</p>
          </div>
        </div>
      ) : null}
      <ChoiceGroup
        legend={copy.recordTitle}
        legendHidden
        variant="card"
        value={state}
        onChange={(next) => {
          setState(next);
          setErrors({});
        }}
        error={errors.state}
        options={[
          { value: "TAKEN", label: copy.optionTaken },
          { value: "SKIPPED", label: copy.optionSkipped },
          { value: "NOT_SURE", label: copy.optionNotSure },
          { value: "DECLINED", label: copy.optionDecline },
        ]}
      />
      {state === "TAKEN" ? (
        <div className="schedule-amount">
          <ChoiceGroup
            legend={copy.amountHeading}
            variant="card"
            value={amountMode}
            onChange={(next) => {
              setAmountMode(next);
              setErrors({});
            }}
            error={amountMode === "KNOWN" ? undefined : errors.amount}
            options={amountOptions}
          />
          {amountMode === "KNOWN" && unit ? (
            <InputField
              label={copy.amountInputLabel(unitText)}
              inputMode="decimal"
              autoComplete="off"
              value={amountValue}
              onChange={(event) => setAmountValue(event.target.value)}
              error={errors.amount}
              fieldClassName="schedule-amount-field"
            />
          ) : null}
          <Notice>
            <p>{copy.noDoseAdvice}</p>
          </Notice>
        </div>
      ) : null}
    </ModalDialog>
  );
}
