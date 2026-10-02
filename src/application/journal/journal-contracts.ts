import type { Instant } from "@/domain/shared/time";
import type {
  RecordId,
  RevisionId,
} from "@/domain/shared/identifiers";
import type {
  CommandId,
  CorrelationId,
  DomainEventId,
} from "@/application/contracts/command-event-identifiers";
import type { AuditEventId } from "@/domain/shared/identifiers";
import type { TransactionId } from "@/domain/shared/identifiers";
import type { GlucoseReadingPayload } from "@/domain/health-records/glucose-reading";
import type { ReadingTemporal } from "@/domain/health-records/reading-temporal";
import type { MedicationEventPayload } from "@/domain/health-records/medication-event";
import type { MedicationEventTemporal } from "@/domain/health-records/medication-event";
import type { IntakeEventPayload } from "@/domain/health-records/intake-event";
import type { IntakeTemporal } from "@/domain/health-records/observation-temporal";
import type { JagaOnDatabase } from "@/storage/database";

// ---------------------------------------------------------------------------
// JournalCommitResult — bounded outcome of a journal mutation
// ---------------------------------------------------------------------------

export type JournalCommitResult =
  | {
      kind: "COMMITTED";
      recordId: RecordId;
      revisionId: RevisionId;
    }
  | {
      kind: "REJECTED";
      code: "HEAD_CONFLICT";
    }
  | {
      kind: "FAILED";
      code: "VALIDATION_FAILED" | "STORAGE_UNAVAILABLE" | "COMMIT_FAILED";
    };

// ---------------------------------------------------------------------------
// Input contracts for each journal mutation
// ---------------------------------------------------------------------------

export type RecordGlucoseInput = {
  payload: GlucoseReadingPayload;
  temporal: ReadingTemporal;
  recordedAt: Instant;
};

export type CorrectGlucoseTimeInput = {
  recordId: RecordId;
  expectedRevisionId: RevisionId;
  expectedRevisionNumber: number;
  payload: GlucoseReadingPayload;
  temporal: ReadingTemporal;
  recordedAt: Instant;
};

export type RecordInsulinInput = {
  payload: MedicationEventPayload;
  temporal: MedicationEventTemporal;
  recordedAt: Instant;
};

export type RecordMealInput = {
  payload: IntakeEventPayload;
  temporal: IntakeTemporal;
  recordedAt: Instant;
};

// ---------------------------------------------------------------------------
// JournalCommandDependencies — injectable clock and ID factories
// ---------------------------------------------------------------------------

export type JournalCommandDependencies = {
  now(): Instant;
  ids: {
    commandId(): CommandId;
    correlationId(): CorrelationId;
    recordId(): RecordId;
    revisionId(): RevisionId;
    auditEventId(): AuditEventId;
    transactionId(): TransactionId;
    domainEventId(): DomainEventId;
  };
};

// ---------------------------------------------------------------------------
// JournalCommandService — authoritative mutations
// ---------------------------------------------------------------------------

export type JournalCommandService = {
  recordGlucose(input: RecordGlucoseInput): Promise<JournalCommitResult>;
  correctGlucoseTime(
    input: CorrectGlucoseTimeInput,
  ): Promise<JournalCommitResult>;
  recordInsulin(input: RecordInsulinInput): Promise<JournalCommitResult>;
  recordMeal(input: RecordMealInput): Promise<JournalCommitResult>;
};

export type { JagaOnDatabase };

// ---------------------------------------------------------------------------
// JournalQueryPort — validated Today/detail reads
// ---------------------------------------------------------------------------

export type JournalEntryKind =
  | "GLUCOSE_READING"
  | "MEDICATION_EVENT"
  | "INTAKE_EVENT";

export type TodayJournalEntry = {
  recordId: RecordId;
  revisionId: RevisionId;
  recordType: JournalEntryKind;
  revisionNumber: number;
  recordedAt: Instant;
  occurrenceSortInstant: Instant | null;
  summary: string;
  displayValue?: string;
  displayUnit?: string;
  displayContext?: string;
};

export type TodayJournalViewModel = {
  entries: TodayJournalEntry[];
  unavailable: boolean;
};

export type GlucoseRecordViewModel = {
  recordId: RecordId;
  revisionId: RevisionId;
  revisionNumber: number;
  recordedAt: Instant;
  payload: GlucoseReadingPayload;
  temporal: ReadingTemporal;
};

export type JournalQueryPort = {
  loadToday(): Promise<TodayJournalViewModel>;
  loadGlucose(recordId: RecordId): Promise<GlucoseRecordViewModel | null>;
};

// ---------------------------------------------------------------------------
// JournalQueryError — bounded read failure
// ---------------------------------------------------------------------------

export type JournalQueryErrorCode = "STORAGE_UNAVAILABLE";

export class JournalQueryError extends Error {
  readonly name = "JournalQueryError";

  constructor(readonly code: JournalQueryErrorCode) {
    super("Journal storage is unavailable");
  }
}
