import type { CommandId } from "@/application/contracts/command-event-identifiers";
import type { SupportedLocale } from "@/domain/patient-settings/locale";
import type { Instant, RecordId, RevisionId } from "@/domain/shared";
import type { DoseUnit } from "@/domain/care-plan/dose";
import type { InquiryAnswerOptionKeyValue, SnoozeChoice } from "@/domain/inquiry/inquiry-registry";
import type { BarrierCount } from "./barrier-counts";
import type { PresentedBarrierQuestion } from "@/application/inquiry/inquiry-presentation-contracts";

/**
 * Narrow, validated Medication schedule port (Packet 8 design Sections 5 and 8).
 * The screen receives only these view models and calls only these commands;
 * it never imports storage, the Inquiry engine or a record writer.
 */

export type ScheduleRecordedState = "TAKEN" | "SKIPPED" | "NOT_SURE" | "DECLINED";

/** A recorded dose unit; `OTHER` keeps the patient's own unit text verbatim. */
export type ScheduleDoseUnit = DoseUnit | "OTHER";

export type ScheduleAmount =
  | { kind: "KNOWN"; value: string; unit: ScheduleDoseUnit; otherUnitText: string | null }
  | { kind: "NOT_RECORDED" }
  | { kind: "UNSURE" };

/** Unit a patient-entered amount may use, relayed from the recorded prescription only. */
export type ScheduleAmountUnit = { unit: ScheduleDoseUnit; otherUnitText: string | null };

export type ScheduleOccasionRef = {
  medication: { recordId: RecordId; revisionId: RevisionId };
  prescription: { recordId: RecordId; revisionId: RevisionId };
  scheduleKey: string;
  expectedAt: Instant;
};

export type ScheduleBarrierView =
  | { kind: "NONE" }
  | { kind: "OFFER_AVAILABLE" }
  | {
      kind: "ANSWERED";
      responseRecordId: RecordId;
      answer: { kind: "OPTION"; optionKey: InquiryAnswerOptionKeyValue } | { kind: "SOMETHING_ELSE"; text: string } | { kind: "NOT_SURE" } | { kind: "PREFER_NOT_TO_SAY" };
    };

export type ScheduleOccasionView = {
  occasionId: string;
  section: "YESTERDAY" | "TODAY";
  localDate: string;
  scheduledTime: string;
  medicineName: string;
  scheduleSource: { kind: "SYNTHETIC_DEMO"; date: string };
  occasion: ScheduleOccasionRef;
  amountUnit: ScheduleAmountUnit | null;
  record: null | {
    recordId: RecordId;
    revisionId: RevisionId;
    revisionNumber: number;
    state: ScheduleRecordedState;
    amount: ScheduleAmount | null;
    recordedAt: Instant;
  };
  barrier: ScheduleBarrierView;
};

export type ScheduleReminderView = {
  recordId: RecordId;
  revisionId: RevisionId;
  revisionNumber: number;
  label: string;
  state: "ACTIVE" | "PAUSED" | "REVIEW_REQUIRED" | "ENDED";
  daysOfWeek: string[];
  times: string[];
  subject: "MEDICATION" | "MEASUREMENT" | "CUSTOM";
  /** For a medication reminder in review: the current recorded schedule it may be confirmed against. */
  currentPrescription: { recordId: RecordId; revisionId: RevisionId; times: string[] } | null;
};

export type ScheduleCareQuestionView = { recordId: RecordId; revisionId: RevisionId; revisionNumber: number; text: string; language: "en-SG" | "zh-SG" | "und" };

export type MedicationScheduleView =
  | { status: "UNAVAILABLE" }
  | {
      status: "READY";
      today: string;
      yesterday: string;
      occasions: ScheduleOccasionView[];
      /** Recorded medicines whose directions cannot safely produce a fixed time. */
      withoutFixedTime: { medicineName: string }[];
      window: { startDate: string; endDate: string };
      counts: BarrierCount[];
      excludedCorrected: number;
      unrecordedCount: number;
      reminders: ScheduleReminderView[];
      careQuestions: ScheduleCareQuestionView[];
    };

export type SaveRecordResult =
  | { kind: "SAVED"; medicationEventRecordId: RecordId; offer: PresentedBarrierQuestion | null }
  | { kind: "FAILED"; code: "VALIDATION_FAILED" | "STORAGE_UNAVAILABLE" | "HEAD_CONFLICT" };

export type ScheduleActionResult = { kind: "SAVED" } | { kind: "FAILED"; code: string };

export type RecordOccasionInput = {
  occasion: ScheduleOccasionRef;
  state: ScheduleRecordedState;
  /** Required for TAKEN only; exactly what the patient chose or entered. */
  amount: ScheduleAmount | null;
  locale: SupportedLocale;
  commandId: CommandId;
};

export type CorrectOccasionInput = RecordOccasionInput & {
  recordId: RecordId;
  expectedRevisionId: RevisionId;
  expectedRevisionNumber: number;
};

export type MedicationSchedulePort = {
  load(request: { locale: SupportedLocale; medicationRecordIds: readonly string[] }): Promise<MedicationScheduleView>;
  recordOccasion(input: RecordOccasionInput): Promise<SaveRecordResult>;
  correctOccasion(input: CorrectOccasionInput): Promise<SaveRecordResult>;
  openBarrierQuestion(medicationEventRecordId: RecordId, locale: SupportedLocale): Promise<PresentedBarrierQuestion | null>;
  answerBarrier(input: {
    question: PresentedBarrierQuestion;
    answer: { kind: "OPTION"; optionKey: InquiryAnswerOptionKeyValue } | { kind: "SOMETHING_ELSE"; text: string; language: "en-SG" | "zh-SG" | "und" } | { kind: "NOT_SURE" } | { kind: "PREFER_NOT_TO_SAY" };
    commandId: CommandId;
  }): Promise<ScheduleActionResult>;
  snoozeBarrier(question: PresentedBarrierQuestion, choice: SnoozeChoice): Promise<ScheduleActionResult>;
  dismissBarrier(question: PresentedBarrierQuestion): Promise<ScheduleActionResult>;
  correctBarrier(input: { responseRecordId: RecordId; answer: Parameters<MedicationSchedulePort["answerBarrier"]>[0]["answer"]; commandId: CommandId }): Promise<ScheduleActionResult>;
  removeBarrier(responseRecordId: RecordId): Promise<ScheduleActionResult>;
  saveReminder(input: {
    reminder: ScheduleReminderView;
    change: { kind: "PAUSE" } | { kind: "RESUME" } | { kind: "END" } | { kind: "CONFIRM_REVIEW" } | { kind: "CHANGE_TIME"; time: string };
    commandId: CommandId;
  }): Promise<ScheduleActionResult>;
  saveCareQuestion(input: { text: string; language: "en-SG" | "zh-SG" | "und"; commandId: CommandId }): Promise<ScheduleActionResult>;
  editCareQuestion(input: { question: ScheduleCareQuestionView; text: string; language: "en-SG" | "zh-SG" | "und"; commandId: CommandId }): Promise<ScheduleActionResult>;
  dismissCareQuestion(input: { question: ScheduleCareQuestionView; commandId: CommandId }): Promise<ScheduleActionResult>;
};

export type { PresentedBarrierQuestion, BarrierCount, SnoozeChoice };
