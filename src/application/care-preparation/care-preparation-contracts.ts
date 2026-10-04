import type { CommandId } from "@/application/contracts/command-event-identifiers";
import type { Instant, RecordId, RecordType, RevisionId } from "@/domain/shared";
import type { TypedRevisionRef } from "@/domain/shared/typed-revision-ref";
import type { SupportedLocale } from "@/domain/patient-settings/locale";
import type { CareSummaryInvalidationReason, CareSummarySnapshotPayload, CareSummarySnapshotStatus } from "@/domain/care-preparation/care-summary-snapshot";
import type { CareSummaryExportOutcome } from "@/domain/care-preparation/care-summary-export";

/**
 * Packet 9C Care Preparation ports (event-contracts 7.4). Commands prepare,
 * preview, approve, invalidate and supersede snapshots and record one
 * print attempt per export record. No command sends anything, and none can
 * record delivery, receipt or clinician review.
 */

export type ExpectedHead = { recordId: RecordId; expectedRevisionId: RevisionId; expectedRevisionNumber: number };

export type CareSummaryGroupKey = "GLUCOSE" | "INSULIN" | "MEALS" | "WALKS";

/** The patient's explicit Screen 10 choice: exact current revisions only. */
export type CareSummarySelectionInput = {
  locale: SupportedLocale;
  period: { startAt: Instant; endAtExclusive: Instant; startDate: string; endDate: string };
  appointment: TypedRevisionRef<"APPOINTMENT"> | null;
  groups: Array<{ key: CareSummaryGroupKey; sources: TypedRevisionRef<RecordType>[] }>;
  questions: TypedRevisionRef<"CARE_QUESTION">[];
  /** Candidates shown on Screen 10 that the patient did not tick (kept local, never exported). */
  notSelected: TypedRevisionRef<RecordType>[];
  /** An earlier snapshot this one replaces; an actionable one becomes SUPERSEDED. */
  replaces?: ExpectedHead;
};

export type CarePreparationRejection =
  | "HEAD_CONFLICT"
  | "SUMMARY_SELECTION_EMPTY"
  | "SUMMARY_SELECTION_TOO_LARGE"
  | "SUMMARY_SOURCE_INELIGIBLE"
  | "SUMMARY_NOT_APPROVED"
  | "SUMMARY_INVALIDATED_FOR_EXPORT"
  | "SUMMARY_CONTENT_HASH_MISMATCH"
  | "EXPORT_OUTCOME_INVALID";

export type CarePreparationCommitResult =
  | { kind: "COMMITTED"; recordId: RecordId; revisionId: RevisionId; revisionNumber: number }
  | { kind: "REJECTED"; code: CarePreparationRejection }
  | { kind: "FAILED"; code: "VALIDATION_FAILED" | "NOT_FOUND" | "STORAGE_UNAVAILABLE" | "COMMIT_FAILED" };

/** What the browser print interaction actually proved. */
export type PrintObservation = "DIALOG_OPENED" | "UNAVAILABLE" | "OUTCOME_UNKNOWN";

export type CarePreparationCommandPort = {
  prepare(input: CareSummarySelectionInput & { commandId?: CommandId }): Promise<CarePreparationCommitResult>;
  markPreviewed(input: ExpectedHead & { contentHash: string; commandId?: CommandId }): Promise<CarePreparationCommitResult>;
  approve(input: ExpectedHead & { contentHash: string; commandId?: CommandId }): Promise<CarePreparationCommitResult>;
  invalidate(input: ExpectedHead & { reason: CareSummaryInvalidationReason; commandId?: CommandId }): Promise<CarePreparationCommitResult>;
  supersede(input: ExpectedHead & { replacement: TypedRevisionRef<"CARE_SUMMARY_SNAPSHOT">; commandId?: CommandId }): Promise<CarePreparationCommitResult>;
  /** Preflight (approval, validity, hash, current sources) then one REQUESTED export record. */
  requestPrintExport(input: ExpectedHead & { approvedContentHash: string; replacesExports?: TypedRevisionRef<"CARE_SUMMARY_EXPORT">[]; commandId?: CommandId }): Promise<CarePreparationCommitResult>;
  /** Exactly one terminal outcome for one requested attempt. */
  completePrintExport(input: ExpectedHead & { observation: PrintObservation; artifact: { hash: string; byteLength: number } | null; commandId?: CommandId }): Promise<CarePreparationCommitResult>;
  /** An attempt interrupted after its request becomes OUTCOME_UNKNOWN; it is never replayed. */
  recoverInterruptedExports(): Promise<number>;
};

export type CareSummaryExportView = { recordId: RecordId; revisionNumber: number; requestedAt: Instant; outcome: CareSummaryExportOutcome };

export type CareSummaryView =
  | { status: "UNAVAILABLE" }
  | { status: "NOT_FOUND" }
  | {
      status: "READY";
      recordId: RecordId;
      revisionId: RevisionId;
      revisionNumber: number;
      snapshotStatus: CareSummarySnapshotStatus;
      payload: CareSummarySnapshotPayload;
      /** False when any included source is no longer its exact current revision. */
      sourcesCurrent: boolean;
      exports: CareSummaryExportView[];
    };

export type CarePreparationQueryPort = {
  loadSummary(recordId: RecordId): Promise<CareSummaryView>;
};
