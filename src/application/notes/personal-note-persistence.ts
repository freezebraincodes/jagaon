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
import type { Sha256Digest } from "@/application/contracts/canonical-json";
import { auditEventIdSchema, instantSchema, recordIdSchema, revisionIdSchema, transactionIdSchema, type AuditEventId, type Instant, type RecordId, type RevisionId, type TransactionId } from "@/domain/shared";
import { PERSONAL_NOTE_RECORD_TYPE, personalNoteRevisionSchema, type PersonalNoteRevision } from "@/domain/notes/personal-note";
import { createAuthoritativeCommandStore, type AuthoritativeCommandPlan, type AuthoritativeCommandStore, type PreparedDomainEvent } from "@/storage/authoritative-command-transaction";
import type { JagaOnDatabase } from "@/storage/database";
import { implementedStorageRowCodecs } from "@/storage/implemented-row-codecs";
import { createStorageRowCodec, StorageRowValidationError, type StorageRowCodec } from "@/storage/storage-row-codec";
import { committedDomainEventRowCodec } from "@/storage/committed-domain-event-row";
import { createStoredRecordRevisionCodec, type StoredRecordRevision } from "@/storage/stored-record-revision";
import type { StoredReverseDependency } from "@/storage/reverse-dependency-row";
import { OwnerPlanError, activeHeadFor, expectationFor, revisionCreatedChange } from "@/application/owner-plan-support";

/**
 * Owner decision 2026-10-14 (My notes): the PERSONAL_NOTE owner's authoritative persistence. Its three closed row codecs (revision,
 * audit, event) join the profile registry (`profile-row-codecs.ts`), so backup export, restore validation and integrity checks validate
 * these rows exactly like every other owner's. Saving a note is one CREATE in one authoritative transaction with an audit row and a
 * domain event whose payload is a closed reason only (never the note). Deleting a note is the existing patient permanent deletion
 * (PATIENT_RECORD_DELETED rows are the deletion owner's).
 */
export type StoredPersonalNoteRevision = StoredRecordRevision<PersonalNoteRevision>;

export const personalNoteRevisionCodec = createStoredRecordRevisionCodec<typeof PERSONAL_NOTE_RECORD_TYPE, PersonalNoteRevision>({
  recordTypeSchema: z.literal(PERSONAL_NOTE_RECORD_TYPE),
  revisionSchema: personalNoteRevisionSchema as unknown as z.ZodType<PersonalNoteRevision, z.ZodTypeDef, unknown>,
  deriveTemporalIndexFields: () => ({ temporalKind: "ATEMPORAL" as const }),
});

export const PERSONAL_NOTE_AUDIT_REASON = "PATIENT_SAVED_NOTE" as const;
export const PERSONAL_NOTE_EVENT_NAME = "PERSONAL_NOTE_RECORDED" as const;

export type PersonalNoteAuditRow = {
  auditEventId: AuditEventId;
  transactionId: TransactionId;
  recordId: RecordId;
  recordType: typeof PERSONAL_NOTE_RECORD_TYPE;
  previousRevisionId: null;
  resultingRevisionId: RevisionId;
  action: "CREATE";
  initiator: "PATIENT";
  assistance: "NONE" | "AI_ASSISTED";
  occurredAt: Instant;
  reasonCode: typeof PERSONAL_NOTE_AUDIT_REASON;
};

const personalNoteAuditRowSchema = z
  .strictObject({
    auditEventId: auditEventIdSchema,
    transactionId: transactionIdSchema,
    recordId: recordIdSchema,
    recordType: z.literal(PERSONAL_NOTE_RECORD_TYPE),
    previousRevisionId: z.null(),
    resultingRevisionId: revisionIdSchema,
    action: z.literal("CREATE"),
    initiator: z.literal("PATIENT"),
    assistance: z.enum(["NONE", "AI_ASSISTED"]),
    occurredAt: instantSchema,
    reasonCode: z.literal(PERSONAL_NOTE_AUDIT_REASON),
  })
  .transform((row): PersonalNoteAuditRow => row as PersonalNoteAuditRow);

export type PersonalNoteEventRow = {
  eventId: DomainEventId;
  eventName: typeof PERSONAL_NOTE_EVENT_NAME;
  localSequence: EventSequence;
  transactionIndex: number;
  transactionId: TransactionId;
  commandId: CommandId;
  correlationId: CorrelationId;
  committedAt: Instant;
  change: EventRecordChange;
  payload: { reasonCode: typeof PERSONAL_NOTE_AUDIT_REASON };
};

const personalNoteEventRowSchema = z
  .strictObject({
    eventId: domainEventIdSchema,
    eventName: z.literal(PERSONAL_NOTE_EVENT_NAME),
    localSequence: z.number().int().positive().safe(),
    transactionIndex: z.number().int().nonnegative().safe(),
    transactionId: transactionIdSchema,
    commandId: commandIdSchema,
    correlationId: correlationIdSchema,
    committedAt: instantSchema,
    change: eventRecordChangeSchema,
    // A closed reason only: never the note, its cues or its themes.
    payload: z.strictObject({ reasonCode: z.literal(PERSONAL_NOTE_AUDIT_REASON) }),
  })
  .refine((row) => row.change.kind === "REVISION_CREATED" && row.change.recordType === PERSONAL_NOTE_RECORD_TYPE, "EVENT_TARGET_NOT_PERSONAL_NOTE")
  .transform((row): PersonalNoteEventRow => row as unknown as PersonalNoteEventRow);

const revisionRowCodec = personalNoteRevisionCodec as unknown as StorageRowCodec<StoredPersonalNoteRevision>;
const auditCodec = createStorageRowCodec<PersonalNoteAuditRow>("auditEvents", personalNoteAuditRowSchema);
const strictEventCodec = createStorageRowCodec<PersonalNoteEventRow>("domainEvents", personalNoteEventRowSchema);
const eventCodec: StorageRowCodec<PersonalNoteEventRow> = Object.freeze({
  validateForWrite: (value: unknown) => strictEventCodec.validateForWrite(value),
  validateAfterRead: (value: unknown) => committedDomainEventRowCodec.validateAfterRead(value) as unknown as PersonalNoteEventRow,
});
const rejectingEvaluationAuditCodec: StorageRowCodec<never> = Object.freeze({
  validateForWrite(): never {
    throw new StorageRowValidationError("STORAGE_VALIDATION_FAILED", "engineEvaluationAudits", "WRITE");
  },
  validateAfterRead(): never {
    throw new StorageRowValidationError("STORAGE_INTEGRITY_FAILED", "engineEvaluationAudits", "READ");
  },
}) as StorageRowCodec<never>;

export type PersonalNoteCommandStore = AuthoritativeCommandStore<StoredPersonalNoteRevision, PersonalNoteAuditRow, PersonalNoteEventRow, StoredReverseDependency, never>;
export type PersonalNoteCommandPlan = AuthoritativeCommandPlan<StoredPersonalNoteRevision, PersonalNoteAuditRow, PersonalNoteEventRow, StoredReverseDependency, never>;

export function createPersonalNoteCommandStore(database: JagaOnDatabase): PersonalNoteCommandStore {
  return createAuthoritativeCommandStore(database, {
    revisionCodec: revisionRowCodec,
    auditCodec,
    eventCodec,
    reverseDependencyCodec: implementedStorageRowCodecs.reverseDependencies,
    evaluationAuditCodec: rejectingEvaluationAuditCodec,
  });
}

export function buildPersonalNoteCommitPlan(input: {
  commandId: CommandId;
  commandHash: Sha256Digest;
  correlationId: CorrelationId;
  transactionId: TransactionId;
  completedAt: Instant;
  revision: PersonalNoteRevision;
  eventId: DomainEventId;
}): PersonalNoteCommandPlan {
  const { revision, transactionId, completedAt } = input;
  if (revision.transactionId !== transactionId || revision.action !== "CREATE") throw new OwnerPlanError("INVALID_TRANSITION");
  const stored = personalNoteRevisionCodec.create(revision) as StoredPersonalNoteRevision;
  const event: PreparedDomainEvent<PersonalNoteEventRow> = {
    eventId: input.eventId,
    eventName: PERSONAL_NOTE_EVENT_NAME,
    transactionId,
    commandId: input.commandId,
    correlationId: input.correlationId,
    change: revisionCreatedChange(revision),
    payload: { reasonCode: PERSONAL_NOTE_AUDIT_REASON },
  };
  return {
    kind: "COMMIT",
    commandId: input.commandId,
    commandHash: input.commandHash,
    completedAt,
    transactionId,
    headExpectations: [expectationFor(revision, null, transactionId)],
    recordRevisions: [stored],
    recordHeads: [activeHeadFor(revision, completedAt)],
    deletionTombstones: [],
    auditEvents: [
      {
        auditEventId: revision.auditEventId,
        transactionId,
        recordId: revision.recordId,
        recordType: PERSONAL_NOTE_RECORD_TYPE,
        previousRevisionId: null,
        resultingRevisionId: revision.revisionId,
        action: "CREATE",
        initiator: "PATIENT",
        assistance: revision.provenance.assistance,
        occurredAt: completedAt,
        reasonCode: PERSONAL_NOTE_AUDIT_REASON,
      },
    ],
    domainEvents: [event],
    // No asynchronous consumer: a saved note changes nothing else.
    eventWorkItems: [],
    // The optional care-question reference is a pinned revision ref inside the payload, not a dependency edge: deleting a note never
    // reaches a care question, and no enabled deletion reaches a care question.
    reverseDependencies: [],
    evaluationAudits: [],
    appPreference: null,
    safety: { kind: "NOT_REQUIRED" },
  };
}

/** This owner's exact write-side row codecs, composed into the closed profile registry. */
export const PERSONAL_NOTE_STORED_ROW_CODECS = Object.freeze({
  revision: revisionRowCodec,
  audit: auditCodec,
  event: strictEventCodec,
});
