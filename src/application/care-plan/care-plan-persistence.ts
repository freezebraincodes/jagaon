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
import type { EventWorkItem, WorkItemId } from "@/application/contracts/event-work";
import {
  auditEventIdSchema,
  instantSchema,
  recordIdSchema,
  revisionIdSchema,
  transactionIdSchema,
  type AuditEventId,
  type DeletionTombstone,
  type Instant,
  type RecordHead,
  type RecordId,
  type RevisionId,
  type TransactionId,
} from "@/domain/shared";
import type { Sha256Digest } from "@/application/contracts/canonical-json";
import {
  medicationRevisionSchema,
  prescriptionVersionRevisionSchema,
  type MedicationRevision,
  type PrescriptionVersionRevision,
} from "@/domain/care-plan/care-plan-revisions";
import { reminderRevisionSchema, type ReminderRevision } from "@/domain/care-plan/reminder";
import { careQuestionRevisionSchema, type CareQuestionRevision } from "@/domain/care-plan/care-question";
import { preventiveCareItemRevisionSchema, type PreventiveCareItemRevision } from "@/domain/care-plan/preventive-care";
import { appointmentRevisionSchema, type AppointmentRevision } from "@/domain/care-plan/appointment";
import {
  createAuthoritativeCommandStore,
  type AuthoritativeCommandPlan,
  type AuthoritativeCommandStore,
  type PreparedDomainEvent,
} from "@/storage/authoritative-command-transaction";
import type { JagaOnDatabase } from "@/storage/database";
import { implementedStorageRowCodecs } from "@/storage/implemented-row-codecs";
import { createStorageRowCodec, StorageRowValidationError, type StorageRowCodec } from "@/storage/storage-row-codec";
import { committedDomainEventRowCodec } from "@/storage/committed-domain-event-row";
import { createStoredRecordRevisionCodec, type StoredRecordRevision, type StoredTemporalIndexFields } from "@/storage/stored-record-revision";
import type { StoredReverseDependency } from "@/storage/reverse-dependency-row";
import { packet8WorkItemsFor } from "@/application/packet8-subscriptions";
import { packet9WorkItemsFor } from "@/application/packet9-subscriptions";
import {
  OwnerPlanError,
  activeHeadFor,
  deletionPieces,
  expectationFor,
  revisionCreatedChange,
} from "@/application/owner-plan-support";

/**
 * Packet 8 Care Plan authoritative persistence for medication identity,
 * prescription versions, reminders and care questions (event-contracts
 * Sections 6.3, 8.2 and 11.1). Every change commits through the existing
 * authoritative transaction with expected heads, idempotent receipts, closed
 * audit and event rows, exact reverse dependencies and subscription work.
 */

export const CARE_PLAN_RECORD_TYPES = Object.freeze([
  "MEDICATION",
  "PRESCRIPTION_VERSION",
  "REMINDER",
  "CARE_QUESTION",
  // Packet 9B
  "PREVENTIVE_CARE_ITEM",
  "APPOINTMENT",
] as const);

export type CarePlanRecordType = (typeof CARE_PLAN_RECORD_TYPES)[number];

export type CarePlanRevision =
  | MedicationRevision
  | PrescriptionVersionRevision
  | ReminderRevision
  | CareQuestionRevision
  | PreventiveCareItemRevision
  | AppointmentRevision;

export type StoredCarePlanRevision = StoredRecordRevision<CarePlanRevision>;

// --- Stored revision codecs ----------------------------------------------------------

const atemporalIndex = (): StoredTemporalIndexFields => ({ temporalKind: "ATEMPORAL" });

function prescriptionIndex(revision: PrescriptionVersionRevision): StoredTemporalIndexFields {
  const start = revision.temporal.start;
  if (start.kind === "EXACT") return { temporalKind: "INTERVAL", effectiveStartSortInstant: start.instantUtc };
  if (start.kind === "APPROXIMATE") return { temporalKind: "INTERVAL", effectiveStartSortInstant: start.approximateInstantUtc };
  if (start.kind === "DATE_ONLY") return { temporalKind: "INTERVAL", localDateSortKey: start.localDate };
  return { temporalKind: "INTERVAL" };
}

export const medicationRevisionCodec = createStoredRecordRevisionCodec<"MEDICATION", MedicationRevision>({
  recordTypeSchema: z.literal("MEDICATION"),
  revisionSchema: medicationRevisionSchema,
  deriveTemporalIndexFields: atemporalIndex,
});

export const prescriptionVersionRevisionCodec = createStoredRecordRevisionCodec<"PRESCRIPTION_VERSION", PrescriptionVersionRevision>({
  recordTypeSchema: z.literal("PRESCRIPTION_VERSION"),
  revisionSchema: prescriptionVersionRevisionSchema,
  deriveTemporalIndexFields: prescriptionIndex,
});

export const reminderRevisionCodec = createStoredRecordRevisionCodec<"REMINDER", ReminderRevision>({
  recordTypeSchema: z.literal("REMINDER"),
  revisionSchema: reminderRevisionSchema,
  deriveTemporalIndexFields: atemporalIndex,
});

function appointmentIndex(revision: AppointmentRevision): StoredTemporalIndexFields {
  const at = revision.temporal.occurrence;
  if (at.kind === "EXACT") return { temporalKind: "POINT", occurrenceSortInstant: at.instantUtc };
  if (at.kind === "APPROXIMATE") return { temporalKind: "POINT", occurrenceSortInstant: at.approximateInstantUtc };
  if (at.kind === "DATE_ONLY") return { temporalKind: "POINT", localDateSortKey: at.localDate };
  return { temporalKind: "POINT" };
}

export const preventiveCareItemRevisionCodec = createStoredRecordRevisionCodec<"PREVENTIVE_CARE_ITEM", PreventiveCareItemRevision>({
  recordTypeSchema: z.literal("PREVENTIVE_CARE_ITEM"),
  revisionSchema: preventiveCareItemRevisionSchema,
  deriveTemporalIndexFields: atemporalIndex,
});

export const appointmentRevisionCodec = createStoredRecordRevisionCodec<"APPOINTMENT", AppointmentRevision>({
  recordTypeSchema: z.literal("APPOINTMENT"),
  revisionSchema: appointmentRevisionSchema,
  deriveTemporalIndexFields: appointmentIndex,
});

export const careQuestionRevisionCodec = createStoredRecordRevisionCodec<"CARE_QUESTION", CareQuestionRevision>({
  recordTypeSchema: z.literal("CARE_QUESTION"),
  revisionSchema: careQuestionRevisionSchema,
  deriveTemporalIndexFields: atemporalIndex,
});

function codecFor(recordType: unknown): StorageRowCodec<StoredCarePlanRevision> | null {
  switch (recordType) {
    case "MEDICATION":
      return medicationRevisionCodec as unknown as StorageRowCodec<StoredCarePlanRevision>;
    case "PRESCRIPTION_VERSION":
      return prescriptionVersionRevisionCodec as unknown as StorageRowCodec<StoredCarePlanRevision>;
    case "REMINDER":
      return reminderRevisionCodec as unknown as StorageRowCodec<StoredCarePlanRevision>;
    case "CARE_QUESTION":
      return careQuestionRevisionCodec as unknown as StorageRowCodec<StoredCarePlanRevision>;
    case "PREVENTIVE_CARE_ITEM":
      return preventiveCareItemRevisionCodec as unknown as StorageRowCodec<StoredCarePlanRevision>;
    case "APPOINTMENT":
      return appointmentRevisionCodec as unknown as StorageRowCodec<StoredCarePlanRevision>;
    default:
      return null;
  }
}

export const carePlanRevisionRowCodec: StorageRowCodec<StoredCarePlanRevision> = Object.freeze({
  validateForWrite(value: unknown): StoredCarePlanRevision {
    const codec = codecFor((value as { recordType?: unknown } | null)?.recordType);
    if (!codec) throw new StorageRowValidationError("STORAGE_VALIDATION_FAILED", "recordRevisions", "WRITE");
    return codec.validateForWrite(value);
  },
  validateAfterRead(value: unknown): StoredCarePlanRevision {
    const codec = codecFor((value as { recordType?: unknown } | null)?.recordType);
    if (!codec) throw new StorageRowValidationError("STORAGE_INTEGRITY_FAILED", "recordRevisions", "READ");
    return codec.validateAfterRead(value);
  },
});

export function storeCarePlanRevision(revision: CarePlanRevision): StoredCarePlanRevision {
  switch (revision.recordType) {
    case "MEDICATION":
      return medicationRevisionCodec.create(revision) as StoredCarePlanRevision;
    case "PRESCRIPTION_VERSION":
      return prescriptionVersionRevisionCodec.create(revision) as StoredCarePlanRevision;
    case "REMINDER":
      return reminderRevisionCodec.create(revision) as StoredCarePlanRevision;
    case "CARE_QUESTION":
      return careQuestionRevisionCodec.create(revision) as StoredCarePlanRevision;
    case "PREVENTIVE_CARE_ITEM":
      return preventiveCareItemRevisionCodec.create(revision) as StoredCarePlanRevision;
    case "APPOINTMENT":
      return appointmentRevisionCodec.create(revision) as StoredCarePlanRevision;
  }
}

// --- Closed audit and event rows ------------------------------------------------------

export const CARE_PLAN_AUDIT_REASONS = Object.freeze([
  "SYNTHETIC_DEMO_SEEDED",
  "PATIENT_RECORDED",
  "PATIENT_CORRECTED",
  "PATIENT_CONFIRMED_CHANGE",
  "SOURCE_CHANGED_REVIEW_REQUIRED",
  "PATIENT_DELETED",
] as const);

export type CarePlanAuditReason = (typeof CARE_PLAN_AUDIT_REASONS)[number];

export type CarePlanAuditRow = {
  auditEventId: AuditEventId;
  transactionId: TransactionId;
  recordId: RecordId;
  recordType: CarePlanRecordType;
  previousRevisionId: RevisionId | null;
  resultingRevisionId: RevisionId | null;
  action: "CREATE" | "CORRECT" | "SUPERSEDE" | "SYSTEM_DERIVE" | "DELETE";
  initiator: "PATIENT" | "JAGAON_SYSTEM";
  assistance: "NONE";
  occurredAt: Instant;
  reasonCode: CarePlanAuditReason;
};

const carePlanAuditRowSchema = z
  .strictObject({
    auditEventId: auditEventIdSchema,
    transactionId: transactionIdSchema,
    recordId: recordIdSchema,
    recordType: z.enum(CARE_PLAN_RECORD_TYPES),
    previousRevisionId: revisionIdSchema.nullable(),
    resultingRevisionId: revisionIdSchema.nullable(),
    action: z.enum(["CREATE", "CORRECT", "SUPERSEDE", "SYSTEM_DERIVE", "DELETE"]),
    initiator: z.enum(["PATIENT", "JAGAON_SYSTEM"]),
    assistance: z.literal("NONE"),
    occurredAt: instantSchema,
    reasonCode: z.enum(CARE_PLAN_AUDIT_REASONS),
  })
  .refine((row) => (row.action === "DELETE") === (row.resultingRevisionId === null), "DELETE_HAS_NO_RESULTING_REVISION")
  .transform((row): CarePlanAuditRow => row as CarePlanAuditRow);

const EVENT_TARGET: Readonly<Record<string, CarePlanRecordType | null>> = Object.freeze({
  MEDICATION_REGISTERED: "MEDICATION",
  PRESCRIPTION_VERSION_RECORDED: "PRESCRIPTION_VERSION",
  PRESCRIPTION_VERSION_REVISED: "PRESCRIPTION_VERSION",
  REMINDER_CREATED: "REMINDER",
  REMINDER_REVISED: "REMINDER",
  CARE_QUESTION_CREATED: "CARE_QUESTION",
  CARE_QUESTION_REVISED: "CARE_QUESTION",
  PREVENTIVE_CARE_ITEM_CREATED: "PREVENTIVE_CARE_ITEM",
  PREVENTIVE_CARE_ITEM_REVISED: "PREVENTIVE_CARE_ITEM",
  APPOINTMENT_SCHEDULED: "APPOINTMENT",
  APPOINTMENT_REVISED: "APPOINTMENT",
  PATIENT_RECORD_DELETED: null,
});

export const CARE_PLAN_EVENT_NAMES = Object.freeze(Object.keys(EVENT_TARGET) as [string, ...string[]]);

/** Closed revision reasons; consumers never diff before-and-after payloads. */
export const CARE_PLAN_EVENT_REASONS = Object.freeze([
  "RECORDED",
  "RECORDED_ERROR_CORRECTED",
  "PAUSED",
  "RESUMED",
  "SCHEDULE_CHANGED",
  "ENDED",
  "SOURCE_CHANGED_REVIEW_REQUIRED",
  "REVIEW_CONFIRMED",
  "QUESTION_EDITED",
  "QUESTION_DISMISSED",
  "DELETED",
  // Packet 9B appointment and preventive-care reasons (event-contracts 8.2)
  "RESCHEDULED",
  "CANCELLED",
  "OUTCOME_REPORTED",
  "ORGANISATIONAL_DETAILS_CHANGED",
  "PLAN_CHANGED",
] as const);

export type CarePlanEventReason = (typeof CARE_PLAN_EVENT_REASONS)[number];

export type CarePlanEventRow = {
  eventId: DomainEventId;
  eventName: string;
  localSequence: EventSequence;
  transactionIndex: number;
  transactionId: TransactionId;
  commandId: CommandId;
  correlationId: CorrelationId;
  committedAt: Instant;
  change: EventRecordChange;
  payload: { reasonCode: CarePlanEventReason };
};

const carePlanEventRowSchema = z
  .strictObject({
    eventId: domainEventIdSchema,
    eventName: z.enum(CARE_PLAN_EVENT_NAMES),
    localSequence: z.number().int().positive().safe(),
    transactionIndex: z.number().int().nonnegative().safe(),
    transactionId: transactionIdSchema,
    commandId: commandIdSchema,
    correlationId: correlationIdSchema,
    committedAt: instantSchema,
    change: eventRecordChangeSchema,
    // Events never copy labels, question text, medicine names or schedules.
    payload: z.strictObject({ reasonCode: z.enum(CARE_PLAN_EVENT_REASONS) }),
  })
  .refine((row) => (CARE_PLAN_RECORD_TYPES as readonly string[]).includes(row.change.recordType), "EVENT_TARGET_NOT_CARE_PLAN")
  .refine((row) => {
    const target = EVENT_TARGET[row.eventName];
    return target === null ? row.change.kind === "RECORD_DELETED" : row.change.kind === "REVISION_CREATED" && target === row.change.recordType;
  }, "EVENT_NAME_DISAGREES_WITH_CHANGE")
  .transform((row): CarePlanEventRow => row as unknown as CarePlanEventRow);

const auditCodec = createStorageRowCodec<CarePlanAuditRow>("auditEvents", carePlanAuditRowSchema);
const strictEventCodec = createStorageRowCodec<CarePlanEventRow>("domainEvents", carePlanEventRowSchema);
const eventCodec: StorageRowCodec<CarePlanEventRow> = Object.freeze({
  validateForWrite: (value: unknown) => strictEventCodec.validateForWrite(value),
  // The shared event log also holds other owners' committed events.
  validateAfterRead: (value: unknown) => committedDomainEventRowCodec.validateAfterRead(value) as unknown as CarePlanEventRow,
});

/** Care Plan never writes engine evaluation audits. */
const rejectingEvaluationAuditCodec: StorageRowCodec<never> = Object.freeze({
  validateForWrite(): never {
    throw new StorageRowValidationError("STORAGE_VALIDATION_FAILED", "engineEvaluationAudits", "WRITE");
  },
  validateAfterRead(): never {
    throw new StorageRowValidationError("STORAGE_INTEGRITY_FAILED", "engineEvaluationAudits", "READ");
  },
}) as StorageRowCodec<never>;

export type CarePlanCommandStore = AuthoritativeCommandStore<StoredCarePlanRevision, CarePlanAuditRow, CarePlanEventRow, StoredReverseDependency, never>;
export type CarePlanCommandPlan = AuthoritativeCommandPlan<StoredCarePlanRevision, CarePlanAuditRow, CarePlanEventRow, StoredReverseDependency, never>;

export function createCarePlanCommandStore(database: JagaOnDatabase): CarePlanCommandStore {
  return createAuthoritativeCommandStore(database, {
    revisionCodec: carePlanRevisionRowCodec,
    auditCodec,
    eventCodec,
    reverseDependencyCodec: implementedStorageRowCodecs.reverseDependencies,
    evaluationAuditCodec: rejectingEvaluationAuditCodec,
  });
}

// --- Plan builder ------------------------------------------------------------------------

export type CarePlanChange =
  | {
      kind: "REVISION";
      revision: CarePlanRevision;
      /** null when the record must not yet exist. */
      expectedHead: RecordHead | null;
      eventId: DomainEventId;
      eventName: string;
      eventReason: CarePlanEventReason;
      auditReason: CarePlanAuditReason;
    }
  | {
      kind: "DELETE";
      head: RecordHead;
      deletedAt: Instant;
      initiator: "PATIENT" | "JAGAON_SYSTEM";
      auditEventId: AuditEventId;
      eventId: DomainEventId;
      auditReason: CarePlanAuditReason;
    };

export { OwnerPlanError as CarePlanPlanError } from "@/application/owner-plan-support";

function auditAction(revision: CarePlanRevision): CarePlanAuditRow["action"] {
  if (revision.action === "CREATE" || revision.action === "CORRECT" || revision.action === "SUPERSEDE" || revision.action === "SYSTEM_DERIVE") {
    return revision.action;
  }
  return "SUPERSEDE";
}

/**
 * Builds one atomic plan from typed revisions and deletions. Each revision is
 * validated by its exact codec, and its lineage is checked against the
 * expected head so a stale proposal cannot commit over newer data.
 */
export function buildCarePlanCommitPlan(input: {
  commandId: CommandId;
  commandHash: Sha256Digest;
  correlationId: CorrelationId;
  transactionId: TransactionId;
  completedAt: Instant;
  changes: CarePlanChange[];
  reverseDependencies: StoredReverseDependency[];
  workItemId: () => WorkItemId;
}): CarePlanCommandPlan {
  const { commandId, commandHash, correlationId, transactionId, completedAt } = input;
  const expectations: RecordHeadExpectation[] = [];
  const revisions: StoredCarePlanRevision[] = [];
  const heads: RecordHead[] = [];
  const tombstones: DeletionTombstone[] = [];
  const audits: CarePlanAuditRow[] = [];
  const events: PreparedDomainEvent<CarePlanEventRow>[] = [];
  const work: EventWorkItem[] = [];

  for (const change of input.changes) {
    if (change.kind === "REVISION") {
      const revision = change.revision;
      expectations.push(expectationFor(revision, change.expectedHead, transactionId));
      revisions.push(storeCarePlanRevision(revision));
      heads.push(activeHeadFor(revision, completedAt));
      audits.push({
        auditEventId: revision.auditEventId,
        transactionId,
        recordId: revision.recordId,
        recordType: revision.recordType,
        previousRevisionId: revision.previousRevisionId,
        resultingRevisionId: revision.revisionId,
        action: auditAction(revision),
        initiator: revision.provenance.initiator === "PATIENT" ? "PATIENT" : "JAGAON_SYSTEM",
        assistance: "NONE",
        occurredAt: completedAt,
        reasonCode: change.auditReason,
      });
      const event = {
        eventId: change.eventId,
        eventName: change.eventName,
        transactionId,
        commandId,
        correlationId,
        change: revisionCreatedChange(revision),
        payload: { reasonCode: change.eventReason },
      };
      events.push(event);
      work.push(...packet8WorkItemsFor({ eventId: event.eventId, eventName: event.eventName, recordType: revision.recordType, createdAt: completedAt, workItemId: input.workItemId }));
      work.push(...packet9WorkItemsFor({ eventId: event.eventId, eventName: event.eventName, recordType: revision.recordType, createdAt: completedAt, workItemId: input.workItemId }));
    } else {
      const head = change.head;
      const pieces = deletionPieces({
        head,
        ownedRecordTypes: CARE_PLAN_RECORD_TYPES,
        deletedAt: change.deletedAt,
        initiator: change.initiator,
        auditEventId: change.auditEventId,
        transactionId,
      });
      expectations.push(pieces.expectation);
      tombstones.push(pieces.tombstone);
      heads.push(pieces.head);
      audits.push({
        auditEventId: change.auditEventId,
        transactionId,
        recordId: head.recordId,
        recordType: head.recordType as CarePlanRecordType,
        previousRevisionId: head.headRevisionId,
        resultingRevisionId: null,
        action: "DELETE",
        initiator: change.initiator,
        assistance: "NONE",
        occurredAt: change.deletedAt,
        reasonCode: change.auditReason,
      });
      const event = {
        eventId: change.eventId,
        eventName: "PATIENT_RECORD_DELETED",
        transactionId,
        commandId,
        correlationId,
        change: pieces.change,
        payload: { reasonCode: "DELETED" as const },
      };
      events.push(event);
      work.push(...packet8WorkItemsFor({ eventId: event.eventId, eventName: event.eventName, recordType: head.recordType, createdAt: change.deletedAt, workItemId: input.workItemId }));
      work.push(...packet9WorkItemsFor({ eventId: event.eventId, eventName: event.eventName, recordType: head.recordType, createdAt: change.deletedAt, workItemId: input.workItemId }));
    }
  }

  for (const edge of input.reverseDependencies) {
    const dependent = revisions.find((row) => row.revisionId === edge.dependentRevisionId);
    if (!dependent || dependent.recordId !== edge.dependentRecordId || dependent.recordType !== edge.dependentRecordType || edge.owner !== "CARE_PLAN") {
      throw new OwnerPlanError("INVALID_REVERSE_DEPENDENCY");
    }
  }

  return {
    kind: "COMMIT",
    commandId,
    commandHash,
    completedAt,
    transactionId,
    headExpectations: expectations,
    recordRevisions: revisions,
    recordHeads: heads,
    deletionTombstones: tombstones,
    auditEvents: audits,
    domainEvents: events,
    eventWorkItems: work,
    reverseDependencies: input.reverseDependencies,
    evaluationAudits: [],
    appPreference: null,
    safety: { kind: "NOT_REQUIRED" },
  };
}

/**
 * Packet 10A: this owner's exact write-side row codecs, composed into the
 * closed profile registry that validates every stored row (backup, restore,
 * integrity verification). Reads through the registry never fall back to the
 * permissive shared event reader.
 */
export const CARE_PLAN_STORED_ROW_CODECS = Object.freeze({
  revision: carePlanRevisionRowCodec,
  audit: auditCodec,
  event: strictEventCodec,
});
