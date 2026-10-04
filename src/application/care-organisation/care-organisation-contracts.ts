import type { CommandId } from "@/application/contracts/command-event-identifiers";
import type { Instant, RecordId, RevisionId } from "@/domain/shared";
import type { IntervalEnd, TimePoint } from "@/domain/shared/temporal";
import type { TypedRevisionRef } from "@/domain/shared/typed-revision-ref";
import type { PreventiveCareItemPayload } from "@/domain/care-plan/preventive-care";
import type { AppointmentPayload } from "@/domain/care-plan/appointment";
import type { CareQuestionPayload } from "@/domain/care-plan/care-question";
import type { PreventiveCareRecordPayload } from "@/domain/health-records/preventive-care-record";
import type { ContextWindowPayload } from "@/domain/health-records/context-window";
import type { PatientAuthoredNote } from "@/domain/health-records/patient-authored-note";

/**
 * Packet 9B care-organisation command port. Every method writes one
 * authoritative transaction; none calculates eligibility, due dates,
 * attendance or completion, and none sends anything anywhere.
 */

export type ExpectedHead = { recordId: RecordId; expectedRevisionId: RevisionId; expectedRevisionNumber: number };

export type CareOrganisationCommitResult =
  | { kind: "COMMITTED"; recordId: RecordId; revisionId: RevisionId }
  | { kind: "REJECTED"; code: "HEAD_CONFLICT" }
  | { kind: "FAILED"; code: "VALIDATION_FAILED" | "CONFIRMATION_REQUIRED" | "NOT_FOUND" | "STORAGE_UNAVAILABLE" | "COMMIT_FAILED" };

export type AppointmentRevisionReason = "RECORDED_ERROR_CORRECTED" | "RESCHEDULED" | "CANCELLED" | "OUTCOME_REPORTED" | "ORGANISATIONAL_DETAILS_CHANGED";

export type CareOrganisationCommandPort = {
  createPreventiveItem(input: { payload: PreventiveCareItemPayload; commandId?: CommandId }): Promise<CareOrganisationCommitResult>;
  revisePreventiveItem(input: ExpectedHead & { payload: PreventiveCareItemPayload; intent: "CORRECT" | "SUPERSEDE"; commandId?: CommandId }): Promise<CareOrganisationCommitResult>;
  recordPreventiveOutcome(input: { payload: PreventiveCareRecordPayload; occurrence: TimePoint; commandId?: CommandId }): Promise<CareOrganisationCommitResult>;
  correctPreventiveOutcome(input: ExpectedHead & { payload: PreventiveCareRecordPayload; occurrence: TimePoint; commandId?: CommandId }): Promise<CareOrganisationCommitResult>;
  /** "Undo recorded": the patient removes a mistaken report; content is purged, the item stays. */
  undoPreventiveOutcome(input: ExpectedHead & { commandId?: CommandId }): Promise<CareOrganisationCommitResult>;
  scheduleAppointment(input: { payload: AppointmentPayload; scheduledAt: TimePoint; commandId?: CommandId }): Promise<CareOrganisationCommitResult>;
  reviseAppointment(input: ExpectedHead & { payload: AppointmentPayload; scheduledAt: TimePoint; reason: AppointmentRevisionReason; commandId?: CommandId }): Promise<CareOrganisationCommitResult>;
  recordContextWindow(input: { payload: ContextWindowPayload; start: TimePoint; end: IntervalEnd; commandId?: CommandId }): Promise<CareOrganisationCommitResult>;
  reviseContextWindow(input: ExpectedHead & { payload: ContextWindowPayload; start: TimePoint; end: IntervalEnd; intent: "CORRECT" | "SUPERSEDE"; commandId?: CommandId }): Promise<CareOrganisationCommitResult>;
  createCareQuestion(input: { questionText: CareQuestionPayload["questionText"]; relatedAppointment?: TypedRevisionRef<"APPOINTMENT">; commandId?: CommandId }): Promise<CareOrganisationCommitResult>;
  reviseCareQuestion(input: ExpectedHead & { questionText: CareQuestionPayload["questionText"]; state: "READY_TO_ASK" | "DISMISSED"; commandId?: CommandId }): Promise<CareOrganisationCommitResult>;
};

/**
 * Packet 9B read projections for Screens 09 and 10. They relay recorded
 * values only: a status is "scheduled" because the patient entered a date,
 * "recorded" because the patient reported an occurrence, and "no date"
 * otherwise. Nothing computes eligibility, due, overdue, attendance or
 * completion, and a missing record stays missing.
 */
export type PreventiveCareStatus = "SCHEDULED" | "RECORDED" | "NO_DATE";

export type PreventiveHistoryEntry = {
  kind: "ITEM" | "RECORD";
  action: string;
  revisionCreatedAt: Instant;
  dateEntered: { kind: "TARGET"; localDate: string } | { kind: "OCCURRENCE"; occurrence: TimePoint } | null;
  note: PatientAuthoredNote | null;
};

export type PreventiveCareItemView = {
  recordId: RecordId;
  revisionId: RevisionId;
  revisionNumber: number;
  payload: PreventiveCareItemPayload;
  status: PreventiveCareStatus;
  /** The date the patient entered: a target date, or the reported occurrence when recorded. */
  dateEntered: { kind: "TARGET"; localDate: string } | { kind: "OCCURRENCE"; occurrence: TimePoint } | null;
  currentRecord: { recordId: RecordId; revisionId: RevisionId; revisionNumber: number; occurrence: TimePoint } | null;
  history: PreventiveHistoryEntry[];
};

export type PreventiveCareView = { status: "UNAVAILABLE" } | { status: "READY"; items: PreventiveCareItemView[] };

export type AppointmentView = {
  recordId: RecordId;
  revisionId: RevisionId;
  revisionNumber: number;
  payload: AppointmentPayload;
  scheduledAt: TimePoint;
};

export type CareQuestionView = { recordId: RecordId; revisionId: RevisionId; revisionNumber: number; text: string; language: "en-SG" | "zh-SG" | "und"; relatedAppointment: RecordId | null };

export const FACT_GROUP_KEYS = Object.freeze(["GLUCOSE", "INSULIN", "MEALS", "WALKS"] as const);
export type FactGroupKey = (typeof FACT_GROUP_KEYS)[number];


export type FactGroupView = {
  key: FactGroupKey;
  /** Exact current source revisions whose known occurrence falls inside the period. */
  sources: TypedRevisionRef<"GLUCOSE_READING" | "MEDICATION_EVENT" | "INTAKE_EVENT" | "ACTIVITY_EVENT">[];
};

export type VisitPreparationView =
  | { status: "UNAVAILABLE" }
  | {
      status: "READY";
      appointment: AppointmentView | null;
      questions: CareQuestionView[];
      period: { startAt: Instant; endAtExclusive: Instant; startDate: string; endDate: string };
      factGroups: FactGroupView[];
    };

export type CareOrganisationQueryPort = {
  loadPreventiveCare(): Promise<PreventiveCareView>;
  loadVisitPreparation(): Promise<VisitPreparationView>;
};

