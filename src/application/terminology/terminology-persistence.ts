import { z } from "zod";
import {
  commandIdSchema,
  correlationIdSchema,
  domainEventIdSchema,
  type CommandId,
  type CorrelationId,
  type DomainEventId,
  type EventSequence,
} from "@/application/contracts/command-event-identifiers";
import { eventRecordChangeSchema, type EventRecordChange } from "@/application/contracts/domain-event-envelope";
import type { RecordHeadExpectation } from "@/application/contracts/command-envelope";
import type { Sha256Digest } from "@/application/contracts/canonical-json";
import { auditEventIdSchema, instantSchema, recordIdSchema, revisionIdSchema, transactionIdSchema, type AuditEventId, type Instant, type RecordHead, type RecordId, type RevisionId, type TransactionId } from "@/domain/shared";
import { PATIENT_TERMINOLOGY_RECORD_TYPE, patientTerminologyRevisionSchema, type PatientTerminologyRevision } from "@/domain/terminology/patient-terminology";
import { createAuthoritativeCommandStore, type AuthoritativeCommandPlan, type AuthoritativeCommandStore, type PreparedDomainEvent } from "@/storage/authoritative-command-transaction";
import type { JagaOnDatabase } from "@/storage/database";
import { implementedStorageRowCodecs } from "@/storage/implemented-row-codecs";
import { createStorageRowCodec, StorageRowValidationError, type StorageRowCodec } from "@/storage/storage-row-codec";
import { committedDomainEventRowCodec } from "@/storage/committed-domain-event-row";
import { createStoredRecordRevisionCodec, type StoredRecordRevision } from "@/storage/stored-record-revision";
import type { StoredReverseDependency } from "@/storage/reverse-dependency-row";
import { OwnerPlanError, activeHeadFor, expectationFor, revisionCreatedChange } from "@/application/owner-plan-support";

/**
 * Packet 13 (P13S step 3): the PATIENT_TERMINOLOGY owner's authoritative persistence. Its three closed row codecs (revision, audit,
 * event) join the profile registry (`profile-row-codecs.ts`, queued Q13-8), so backup export, restore validation and integrity checks
 * validate these rows exactly like every other owner's. Remember = CREATE, change = CORRECT, both in one authoritative transaction
 * with an audit row and a domain event whose payload is a closed reason only (never the phrase). Forget is the existing patient
 * permanent deletion (PATIENT_RECORD_DELETED rows are the deletion owner's).
 */
export type StoredPatientTerminologyRevision = StoredRecordRevision<PatientTerminologyRevision>;

export const patientTerminologyRevisionCodec = createStoredRecordRevisionCodec<typeof PATIENT_TERMINOLOGY_RECORD_TYPE, PatientTerminologyRevision>({
  recordTypeSchema: z.literal(PATIENT_TERMINOLOGY_RECORD_TYPE),
  revisionSchema: patientTerminologyRevisionSchema as unknown as z.ZodType<PatientTerminologyRevision, z.ZodTypeDef, unknown>,
  deriveTemporalIndexFields: () => ({ temporalKind: "ATEMPORAL" as const }),
});

export const TERMINOLOGY_AUDIT_REASONS = Object.freeze(["PATIENT_REMEMBERED_TERM", "PATIENT_CHANGED_TERM"] as const);
export type TerminologyAuditReason = (typeof TERMINOLOGY_AUDIT_REASONS)[number];
export const TERMINOLOGY_EVENT_NAMES = Object.freeze(["PATIENT_TERM_REMEMBERED", "PATIENT_TERM_CHANGED"] as const);
export type TerminologyEventName = (typeof TERMINOLOGY_EVENT_NAMES)[number];

export type TerminologyAuditRow = {
  auditEventId: AuditEventId;
  transactionId: TransactionId;
  recordId: RecordId;
  recordType: typeof PATIENT_TERMINOLOGY_RECORD_TYPE;
  previousRevisionId: RevisionId | null;
  resultingRevisionId: RevisionId;
  action: "CREATE" | "CORRECT";
  initiator: "PATIENT";
  assistance: "NONE";
  occurredAt: Instant;
  reasonCode: TerminologyAuditReason;
};

const terminologyAuditRowSchema = z
  .strictObject({
    auditEventId: auditEventIdSchema,
    transactionId: transactionIdSchema,
    recordId: recordIdSchema,
    recordType: z.literal(PATIENT_TERMINOLOGY_RECORD_TYPE),
    previousRevisionId: revisionIdSchema.nullable(),
    resultingRevisionId: revisionIdSchema,
    action: z.enum(["CREATE", "CORRECT"]),
    initiator: z.literal("PATIENT"),
    assistance: z.literal("NONE"),
    occurredAt: instantSchema,
    reasonCode: z.enum(TERMINOLOGY_AUDIT_REASONS),
  })
  .refine((row) => (row.action === "CREATE") === (row.previousRevisionId === null) && (row.action === "CREATE") === (row.reasonCode === "PATIENT_REMEMBERED_TERM"), "AUDIT_ACTION_DISAGREES")
  .transform((row): TerminologyAuditRow => row as TerminologyAuditRow);

export type TerminologyEventRow = {
  eventId: DomainEventId;
  eventName: TerminologyEventName;
  localSequence: EventSequence;
  transactionIndex: number;
  transactionId: TransactionId;
  commandId: CommandId;
  correlationId: CorrelationId;
  committedAt: Instant;
  change: EventRecordChange;
  payload: { reasonCode: TerminologyAuditReason };
};

const terminologyEventRowSchema = z
  .strictObject({
    eventId: domainEventIdSchema,
    eventName: z.enum(TERMINOLOGY_EVENT_NAMES),
    localSequence: z.number().int().positive().safe(),
    transactionIndex: z.number().int().nonnegative().safe(),
    transactionId: transactionIdSchema,
    commandId: commandIdSchema,
    correlationId: correlationIdSchema,
    committedAt: instantSchema,
    change: eventRecordChangeSchema,
    // A closed reason only: never the phrase or the medicine.
    payload: z.strictObject({ reasonCode: z.enum(TERMINOLOGY_AUDIT_REASONS) }),
  })
  .refine((row) => row.change.kind === "REVISION_CREATED" && row.change.recordType === PATIENT_TERMINOLOGY_RECORD_TYPE, "EVENT_TARGET_NOT_TERMINOLOGY")
  .refine((row) => (row.eventName === "PATIENT_TERM_REMEMBERED") === (row.payload.reasonCode === "PATIENT_REMEMBERED_TERM"), "EVENT_NAME_DISAGREES_WITH_REASON")
  .transform((row): TerminologyEventRow => row as unknown as TerminologyEventRow);

const revisionRowCodec = patientTerminologyRevisionCodec as unknown as StorageRowCodec<StoredPatientTerminologyRevision>;
const auditCodec = createStorageRowCodec<TerminologyAuditRow>("auditEvents", terminologyAuditRowSchema);
const strictEventCodec = createStorageRowCodec<TerminologyEventRow>("domainEvents", terminologyEventRowSchema);
const eventCodec: StorageRowCodec<TerminologyEventRow> = Object.freeze({
  validateForWrite: (value: unknown) => strictEventCodec.validateForWrite(value),
  validateAfterRead: (value: unknown) => committedDomainEventRowCodec.validateAfterRead(value) as unknown as TerminologyEventRow,
});
const rejectingEvaluationAuditCodec: StorageRowCodec<never> = Object.freeze({
  validateForWrite(): never {
    throw new StorageRowValidationError("STORAGE_VALIDATION_FAILED", "engineEvaluationAudits", "WRITE");
  },
  validateAfterRead(): never {
    throw new StorageRowValidationError("STORAGE_INTEGRITY_FAILED", "engineEvaluationAudits", "READ");
  },
}) as StorageRowCodec<never>;

export type TerminologyCommandStore = AuthoritativeCommandStore<StoredPatientTerminologyRevision, TerminologyAuditRow, TerminologyEventRow, StoredReverseDependency, never>;
export type TerminologyCommandPlan = AuthoritativeCommandPlan<StoredPatientTerminologyRevision, TerminologyAuditRow, TerminologyEventRow, StoredReverseDependency, never>;

export function createTerminologyCommandStore(database: JagaOnDatabase): TerminologyCommandStore {
  return createAuthoritativeCommandStore(database, {
    revisionCodec: revisionRowCodec,
    auditCodec,
    eventCodec,
    reverseDependencyCodec: implementedStorageRowCodecs.reverseDependencies,
    evaluationAuditCodec: rejectingEvaluationAuditCodec,
  });
}

export function buildTerminologyCommitPlan(input: {
  commandId: CommandId;
  commandHash: Sha256Digest;
  correlationId: CorrelationId;
  transactionId: TransactionId;
  completedAt: Instant;
  revision: PatientTerminologyRevision;
  expectedHead: RecordHead | null;
  eventId: DomainEventId;
}): TerminologyCommandPlan {
  const { revision, transactionId, completedAt } = input;
  if (revision.transactionId !== transactionId) throw new OwnerPlanError("INVALID_TRANSITION");
  const remembered = revision.action === "CREATE";
  const reasonCode: TerminologyAuditReason = remembered ? "PATIENT_REMEMBERED_TERM" : "PATIENT_CHANGED_TERM";
  const stored = patientTerminologyRevisionCodec.create(revision) as StoredPatientTerminologyRevision;
  const event: PreparedDomainEvent<TerminologyEventRow> = {
    eventId: input.eventId,
    eventName: remembered ? "PATIENT_TERM_REMEMBERED" : "PATIENT_TERM_CHANGED",
    transactionId,
    commandId: input.commandId,
    correlationId: input.correlationId,
    change: revisionCreatedChange(revision),
    payload: { reasonCode },
  };
  const expectation: RecordHeadExpectation = expectationFor(revision, input.expectedHead, transactionId);
  return {
    kind: "COMMIT",
    commandId: input.commandId,
    commandHash: input.commandHash,
    completedAt,
    transactionId,
    headExpectations: [expectation],
    recordRevisions: [stored],
    recordHeads: [activeHeadFor(revision, completedAt)],
    deletionTombstones: [],
    auditEvents: [
      {
        auditEventId: revision.auditEventId,
        transactionId,
        recordId: revision.recordId,
        recordType: PATIENT_TERMINOLOGY_RECORD_TYPE,
        previousRevisionId: revision.previousRevisionId,
        resultingRevisionId: revision.revisionId,
        action: remembered ? "CREATE" : "CORRECT",
        initiator: "PATIENT",
        assistance: "NONE",
        occurredAt: completedAt,
        reasonCode,
      },
    ],
    domainEvents: [event],
    // No asynchronous consumer: a remembered term changes nothing else.
    eventWorkItems: [],
    reverseDependencies: [],
    evaluationAudits: [],
    appPreference: null,
    safety: { kind: "NOT_REQUIRED" },
  };
}

/** This owner's exact write-side row codecs, composed into the closed profile registry (queued Q13-8). */
export const TERMINOLOGY_STORED_ROW_CODECS = Object.freeze({
  revision: revisionRowCodec,
  audit: auditCodec,
  event: strictEventCodec,
});
