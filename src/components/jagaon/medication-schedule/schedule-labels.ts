import type { ScheduleMessages } from "@/i18n/types";
import type {
  ScheduleAmount,
  ScheduleAmountUnit,
  ScheduleBarrierView,
  ScheduleRecordedState,
} from "@/application/medication-schedule/medication-schedule-contracts";
import type { InquiryAnswerOptionKeyValue } from "@/domain/inquiry/inquiry-registry";

/** Governed labels for recorded values; patient-entered unit text stays verbatim. */

export function unitLabel(copy: ScheduleMessages, unit: ScheduleAmountUnit | { unit: ScheduleAmountUnit["unit"]; otherUnitText: string | null }): string {
  return unit.unit === "OTHER" ? (unit.otherUnitText ?? "") : copy.unitLabels[unit.unit];
}

export function recordedStateLabel(copy: ScheduleMessages, state: ScheduleRecordedState | null): string {
  switch (state) {
    case "TAKEN":
      return copy.recordedTaken;
    case "SKIPPED":
      return copy.recordedSkipped;
    case "NOT_SURE":
      return copy.recordedNotSure;
    case "DECLINED":
      return copy.recordedDeclined;
    default:
      return copy.notRecorded;
  }
}

export function amountLabel(copy: ScheduleMessages, amount: ScheduleAmount): string {
  if (amount.kind === "KNOWN") return copy.amountRecorded(amount.value, unitLabel(copy, amount));
  return amount.kind === "UNSURE" ? copy.amountUnknown : copy.amountNotRecorded;
}

export function optionLabel(copy: ScheduleMessages, optionKey: InquiryAnswerOptionKeyValue): string {
  switch (optionKey) {
    case "FORGOT":
      return copy.barrierForgot;
    case "ROUTINE_CHANGED":
      return copy.barrierRoutineChanged;
    case "AWAY_FROM_HOME":
      return copy.barrierAway;
    case "ACCESS_DIFFICULTY":
      return copy.barrierAccess;
    case "SIDE_EFFECT_CONCERN":
      return copy.barrierSideEffectConcern;
  }
}

export function answerLabel(copy: ScheduleMessages, answer: Extract<ScheduleBarrierView, { kind: "ANSWERED" }>["answer"]): string {
  switch (answer.kind) {
    case "OPTION":
      return optionLabel(copy, answer.optionKey);
    case "SOMETHING_ELSE":
      return `${copy.barrierSomethingElse} · ${answer.text}`;
    case "NOT_SURE":
      return copy.barrierNotSure;
    case "PREFER_NOT_TO_SAY":
      return copy.barrierPreferNot;
  }
}
