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
import { preventiveCareRecordRevisionSchema, type PreventiveCareRecordRevision } from "@/domain/health-records/preventive-care-record";
import { contextWindowRevisionSchema, type ContextWindowRevision } from "@/domain/health-records/context-window";
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
import type { TimePoint } from "@/domain/shared/temporal";
import { packet9WorkItemsFor } from "@/application/packet9-subscriptions";
import { OwnerPlanError, activeHeadFor, deletionPieces, expectationFor, revisionCreatedChange } from "@/application/owner-plan-support";

/**
 * Packet 9B Health Records persistence for patient-reported preventive-care
 * occurrences and context windows (event-contracts Sections 6.4, 8.3, 8.4 and
 * 11.1). Every write is one authoritative transaction with expected heads,
 * idempotent receipts, closed audit and event rows, and no copied content in
 * events.
 */

export const CARE_ORGANISATION_HEALTH_RECORD_TYPES = Object.freeze(["PREVENTIVE_CARE_RECORD", "CONTEXT_WINDOW"] as const);

export type CareOrganisationHealthRecordType = (typeof CARE_ORGANISATION_HEALTH_RECORD_TYPES)[number];

export type CareOrganisationRevision = PreventiveCareRecordRevision | ContextWindowRevision;

export type StoredCareOrganisationRevision = StoredRecordRevision<CareOrganisationRevision>;

function pointIndex(point: TimePoint, temporalKind: "POINT" | "INTERVAL"): StoredTemporalIndexFields {
  const sortKey = temporalKind === "POINT" ? "occurrenceSortInstant" : "effectiveStartSortInstant";
  if (point.kind === "EXACT") return { temporalKind, [sortKey]: point.instantUtc };
  if (point.kind === "APPROXIMATE") return { temporalKind, [sortKey]: point.approximateInstantUtc };
  if (point.kind === "DATE_ONLY") return { temporalKind, localDateSortKey: point.localDate };
  return { temporalKind };
}

export const preventiveCareRecordRevisionCodec = createStoredRecordRevisionCodec<"PREVENTIVE_CARE_RECORD", PreventiveCareRecordRevision>({
  recordTypeSchema: z.literal("PREVENTIVE_CARE_RECORD"),
  revisionSchema: preventiveCareRecordRevisionSchema,
  deriveTemporalIndexFields: (revision) => pointIndex(revision.temporal.occurrence, "POINT"),
});

export const contextWindowRevisionCodec = createStoredRecordRevisionCodec<"CONTEXT_WINDOW", ContextWindowRevision>({
  recordTypeSchema: z.literal("CONTEXT_WINDOW"),
  revisionSchema: contextWindowRevisionSchema,
  deriveTemporalIndexFields: (revision) => pointIndex(revision.temporal.start, "INTERVAL"),
});

function codecFor(recordType: unknown): StorageRowCodec<StoredCareOrganisationRevision> | null {
  if (recordType === "PREVENTIVE_CARE_RECORD") return preventiveCareRecordRevisionCodec as unknown as StorageRowCodec<StoredCareOrganisationRevision>;
  if (recordType === "CONTEXT_WINDOW") return contextWindowRevisionCodec as unknown as StorageRowCodec<StoredCareOrganisationRevision>;
  return null;
}

export const careOrganisationRevisionRowCodec: StorageRowCodec<StoredCareOrganisationRevision> = Object.freeze({
  validateForWrite(value: unknown): StoredCareOrganisationRevision {
    const codec = codecFor((value as { recordType?: unknown } | null)?.recordType);
    if (!codec) throw new StorageRowValidationError("STORAGE_VALIDATION_FAILED", "recordRevisions", "WRITE");
    return codec.validateForWrite(value);
  },
  validateAfterRead(value: unknown): StoredCareOrganisationRevision {
    const codec = codecFor((value as { recordType?: unknown } | null)?.recordType);
    if (!codec) throw new StorageRowValidationError("STORAGE_INTEGRITY_FAILED", "recordRevisions", "READ");
    return codec.validateAfterRead(value);
  },
});

function storeRevision(revision: CareOrganisationRevision): StoredCareOrganisationRevision {
  return revision.recordType === "PREVENTIVE_CARE_RECORD"
    ? (preventiveCareRecordRevisionCodec.create(revision) as StoredCareOrganisationRevision)
    : (contextWindowRevisionCodec.create(revision) as StoredCareOrganisationRevision);
}

// --- Closed audit and event rows ------------------------------------------------------

export const CARE_ORGANISATION_AUDIT_REASONS = Object.freeze(["SYNTHETIC_DEMO_SEEDED", "PATIENT_RECORDED", "PATIENT_CORRECTED", "PATIENT_CONFIRMED_CHANGE", "PATIENT_DELETED"] as const);

export type CareOrganisationAuditReason = (typeof CARE_ORGANISATION_AUDIT_REASONS)[number];

export type CareOrganisationAuditRow = {
  auditEventId: AuditEventId;
  transactionId: TransactionId;
  recordId: RecordId;
  recordType: CareOrganisationHealthRecordType;
  previousRevisionId: RevisionId | null;
  resultingRevisionId: RevisionId | null;
  action: "CREATE" | "CORRECT" | "SUPERSEDE" | "DELETE";
  initiator: "PATIENT";
  assistance: "NONE";
  occurredAt: Instant;
  reasonCode: CareOrganisationAuditReason;
};

const auditRowSchema = z
  .strictObject({
    auditEventId: auditEventIdSchema,
    transactionId: transactionIdSchema,
    recordId: recordIdSchema,
    recordType: z.enum(CARE_ORGANISATION_HEALTH_RECORD_TYPES),
    previousRevisionId: revisionIdSchema.nullable(),
    resultingRevisionId: revisionIdSchema.nullable(),
    action: z.enum(["CREATE", "CORRECT", "SUPERSEDE", "DELETE"]),
    initiator: z.literal("PATIENT"),
    assistance: z.literal("NONE"),
    occurredAt: instantSchema,
    reasonCode: z.enum(CARE_ORGANISATION_AUDIT_REASONS),
  })
  .refine((row) => (row.action === "DELETE") === (row.resultingRevisionId === null), "DELETE_HAS_NO_RESULTING_REVISION")
  .transform((row): CareOrganisationAuditRow => row as CareOrganisationAuditRow);

/** Event name → record type it may announce (null: deletion). */
export const CARE_ORGANISATION_EVENT_TARGETS: Readonly<Record<string, CareOrganisationHealthRecordType | null>> = Object.freeze({
  PREVENTIVE_CARE_OUTCOME_RECORDED: "PREVENTIVE_CARE_RECORD",
  PREVENTIVE_CARE_OUTCOME_CORRECTED: "PREVENTIVE_CARE_RECORD",
  CONTEXT_WINDOW_RECORDED: "CONTEXT_WINDOW",
  CONTEXT_WINDOW_REVISED: "CONTEXT_WINDOW",
  PATIENT_RECORD_DELETED: null,
});

const EVENT_NAMES = Object.freeze(Object.keys(CARE_ORGANISATION_EVENT_TARGETS) as [string, ...string[]]);

export const CARE_ORGANISATION_EVENT_REASONS = Object.freeze(["RECORDED", "RECORDED_ERROR_CORRECTED", "STATE_CHANGED", "DELETED"] as const);

export type CareOrganisationEventReason = (typeof CARE_ORGANISATION_EVENT_REASONS)[number];

export type CareOrganisationEventRow = {
  eventId: DomainEventId;
  eventName: string;
  localSequence: EventSequence;
  transactionIndex: number;
  transactionId: TransactionId;
  commandId: CommandId;
  correlationId: CorrelationId;
  committedAt: Instant;
  change: EventRecordChange;
  payload: { reasonCode: CareOrganisationEventReason };
};

const eventRowSchema = z
  .strictObject({
    eventId: domainEventIdSchema,
    eventName: z.enum(EVENT_NAMES),
    localSequence: z.number().int().positive().safe(),
    transactionIndex: z.number().int().nonnegative().safe(),
    transactionId: transactionIdSchema,
    commandId: commandIdSchema,
    correlationId: correlationIdSchema,
    committedAt: instantSchema,
    change: eventRecordChangeSchema,
    // Events carry only a closed reason: never notes, labels or dates.
    payload: z.strictObject({ reasonCode: z.enum(CARE_ORGANISATION_EVENT_REASONS) }),
  })
  .refine((row) => (CARE_ORGANISATION_HEALTH_RECORD_TYPES as readonly string[]).includes(row.change.recordType), "EVENT_TARGET_NOT_OWNED")
  .refine((row) => {
    const target = CARE_ORGANISATION_EVENT_TARGETS[row.eventName];
    return target === null ? row.change.kind === "RECORD_DELETED" : row.change.kind === "REVISION_CREATED" && target === row.change.recordType;
  }, "EVENT_NAME_DISAGREES_WITH_CHANGE")
  .transform((row): CareOrganisationEventRow => row as unknown as CareOrganisationEventRow);

const auditCodec = createStorageRowCodec<CareOrganisationAuditRow>("auditEvents", auditRowSchema);
const strictEventCodec = createStorageRowCodec<CareOrganisationEventRow>("domainEvents", eventRowSchema);
const eventCodec: StorageRowCodec<CareOrganisationEventRow> = Object.freeze({
  validateForWrite: (value: unknown) => strictEventCodec.validateForWrite(value),
  validateAfterRead: (value: unknown) => committedDomainEventRowCodec.validateAfterRead(value) as unknown as CareOrganisationEventRow,
});

const rejectingEvaluationAuditCodec: StorageRowCodec<never> = Object.freeze({
  validateForWrite(): never {
    throw new StorageRowValidationError("STORAGE_VALIDATION_FAILED", "engineEvaluationAudits", "WRITE");
  },
  validateAfterRead(): never {
    throw new StorageRowValidationError("STORAGE_INTEGRITY_FAILED", "engineEvaluationAudits", "READ");
  },
}) as StorageRowCodec<never>;

export type CareOrganisationCommandStore = AuthoritativeCommandStore<StoredCareOrganisationRevision, CareOrganisationAuditRow, CareOrganisationEventRow, StoredReverseDependency, never>;
export type CareOrganisationCommandPlan = AuthoritativeCommandPlan<StoredCareOrganisationRevision, CareOrganisationAuditRow, CareOrganisationEventRow, StoredReverseDependency, never>;

export function createCareOrganisationCommandStore(database: JagaOnDatabase): CareOrganisationCommandStore {
  return createAuthoritativeCommandStore(database, {
    revisionCodec: careOrganisationRevisionRowCodec,
    auditCodec,
    eventCodec,
    reverseDependencyCodec: implementedStorageRowCodecs.reverseDependencies,
    evaluationAuditCodec: rejectingEvaluationAuditCodec,
  });
}

export type CareOrganisationChange =
  | {
      kind: "REVISION";
      revision: CareOrganisationRevision;
      expectedHead: RecordHead | null;
      eventId: DomainEventId;
      eventName: string;
      eventReason: CareOrganisationEventReason;
      auditReason: CareOrganisationAuditReason;
    }
  | { kind: "DELETE"; head: RecordHead; deletedAt: Instant; auditEventId: AuditEventId; eventId: DomainEventId };

export function buildCareOrganisationCommitPlan(input: {
  commandId: CommandId;
  commandHash: Sha256Digest;
  correlationId: CorrelationId;
  transactionId: TransactionId;
  completedAt: Instant;
  changes: CareOrganisationChange[];
  workItemId: () => WorkItemId;
}): CareOrganisationCommandPlan {
  const { commandId, commandHash, correlationId, transactionId, completedAt } = input;
  const expectations: RecordHeadExpectation[] = [];
  const revisions: StoredCareOrganisationRevision[] = [];
  const heads: RecordHead[] = [];
  const tombstones: DeletionTombstone[] = [];
  const audits: CareOrganisationAuditRow[] = [];
  const events: PreparedDomainEvent<CareOrganisationEventRow>[] = [];
  const work: EventWorkItem[] = [];

  for (const change of input.changes) {
    if (change.kind === "REVISION") {
      const revision = change.revision;
      if (revision.action !== "CREATE" && revision.action !== "CORRECT" && revision.action !== "SUPERSEDE") throw new OwnerPlanError("INVALID_REVISION_LINEAGE");
      expectations.push(expectationFor(revision, change.expectedHead, transactionId));
      revisions.push(storeRevision(revision));
      heads.push(activeHeadFor(revision, completedAt));
      audits.push({
        auditEventId: revision.auditEventId,
        transactionId,
        recordId: revision.recordId,
        recordType: revision.recordType,
        previousRevisionId: revision.previousRevisionId,
        resultingRevisionId: revision.revisionId,
        action: revision.action,
        initiator: "PATIENT",
        assistance: "NONE",
        occurredAt: completedAt,
        reasonCode: change.auditReason,
      });
      const event = { eventId: change.eventId, eventName: change.eventName, transactionId, commandId, correlationId, change: revisionCreatedChange(revision), payload: { reasonCode: change.eventReason } };
      events.push(event);
      work.push(...packet9WorkItemsFor({ eventId: event.eventId, eventName: event.eventName, recordType: revision.recordType, createdAt: completedAt, workItemId: input.workItemId }));
    } else {
      const pieces = deletionPieces({
        head: change.head,
        ownedRecordTypes: CARE_ORGANISATION_HEALTH_RECORD_TYPES,
        deletedAt: change.deletedAt,
        initiator: "PATIENT",
        auditEventId: change.auditEventId,
        transactionId,
      });
      expectations.push(pieces.expectation);
      tombstones.push(pieces.tombstone);
      heads.push(pieces.head);
      audits.push({
        auditEventId: change.auditEventId,
        transactionId,
        recordId: change.head.recordId,
        recordType: change.head.recordType as CareOrganisationHealthRecordType,
        previousRevisionId: change.head.headRevisionId,
        resultingRevisionId: null,
        action: "DELETE",
        initiator: "PATIENT",
        assistance: "NONE",
        occurredAt: change.deletedAt,
        reasonCode: "PATIENT_DELETED",
      });
      const event = { eventId: change.eventId, eventName: "PATIENT_RECORD_DELETED", transactionId, commandId, correlationId, change: pieces.change, payload: { reasonCode: "DELETED" as const } };
      events.push(event);
      work.push(...packet9WorkItemsFor({ eventId: event.eventId, eventName: event.eventName, recordType: change.head.recordType, createdAt: change.deletedAt, workItemId: input.workItemId }));
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
    reverseDependencies: [],
    evaluationAudits: [],
    appPreference: null,
    safety: { kind: "NOT_REQUIRED" },
  };
}
