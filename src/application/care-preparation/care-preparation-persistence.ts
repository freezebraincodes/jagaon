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
import { careSummarySnapshotRevisionSchema, type CareSummarySnapshotRevision } from "@/domain/care-preparation/care-summary-snapshot";
import { careSummaryExportRevisionSchema, type CareSummaryExportRevision } from "@/domain/care-preparation/care-summary-export";
import { careSummaryAiMarkingIssues } from "./care-summary-ai-marking";
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
import { createStoredRecordRevisionCodec, type StoredRecordRevision } from "@/storage/stored-record-revision";
import type { StoredReverseDependency } from "@/storage/reverse-dependency-row";
import { OwnerPlanError, activeHeadFor, deletionPieces, expectationFor, revisionCreatedChange } from "@/application/owner-plan-support";

/**
 * Packet 9C Care Preparation persistence (domain Section 11; event-contracts
 * Sections 7.4, 9.4 and 11.1). Snapshot and export writes are authoritative
 * transactions with expected heads, idempotent receipts, closed audit and
 * event rows, and exact `CARE_SUMMARY_SOURCE` reverse dependencies. Events
 * carry only closed reason codes, never summary text or values.
 */

export const CARE_PREPARATION_RECORD_TYPES = Object.freeze(["CARE_SUMMARY_SNAPSHOT", "CARE_SUMMARY_EXPORT"] as const);
export type CarePreparationRecordType = (typeof CARE_PREPARATION_RECORD_TYPES)[number];

export type CarePreparationRevision = CareSummarySnapshotRevision | CareSummaryExportRevision;
export type StoredCarePreparationRevision = StoredRecordRevision<CarePreparationRevision>;

export const CARE_SUMMARY_SOURCE_EVALUATOR = Object.freeze({ key: "care-preparation.summary-source", version: "9c.1", role: "CARE_SUMMARY_SOURCE" } as const);

/**
 * Packet 11C Addendum C, Task C4: the stored snapshot revision is the domain revision plus the exact AI-marking rule (the approved rows,
 * which the application owns): an 11c.2 AI-assisted snapshot without exactly its marking, or any other snapshot with one, is never
 * written, read, backed up or restored. Older (9c.1, 11c.1) snapshots carry none and pass unchanged.
 */
const storedCareSummarySnapshotRevisionSchema = careSummarySnapshotRevisionSchema.superRefine((revision, ctx) => {
  for (const message of careSummaryAiMarkingIssues(revision.payload)) ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: ["payload", "sections"] });
}) as unknown as z.ZodType<CareSummarySnapshotRevision, z.ZodTypeDef, unknown>;

export const careSummarySnapshotRevisionCodec = createStoredRecordRevisionCodec<"CARE_SUMMARY_SNAPSHOT", CareSummarySnapshotRevision>({
  recordTypeSchema: z.literal("CARE_SUMMARY_SNAPSHOT"),
  revisionSchema: storedCareSummarySnapshotRevisionSchema,
  deriveTemporalIndexFields: () => ({ temporalKind: "ATEMPORAL" }),
});

export const careSummaryExportRevisionCodec = createStoredRecordRevisionCodec<"CARE_SUMMARY_EXPORT", CareSummaryExportRevision>({
  recordTypeSchema: z.literal("CARE_SUMMARY_EXPORT"),
  revisionSchema: careSummaryExportRevisionSchema,
  deriveTemporalIndexFields: () => ({ temporalKind: "ATEMPORAL" }),
});

function codecFor(recordType: unknown): StorageRowCodec<StoredCarePreparationRevision> | null {
  if (recordType === "CARE_SUMMARY_SNAPSHOT") return careSummarySnapshotRevisionCodec as unknown as StorageRowCodec<StoredCarePreparationRevision>;
  if (recordType === "CARE_SUMMARY_EXPORT") return careSummaryExportRevisionCodec as unknown as StorageRowCodec<StoredCarePreparationRevision>;
  return null;
}

export const carePreparationRevisionRowCodec: StorageRowCodec<StoredCarePreparationRevision> = Object.freeze({
  validateForWrite(value: unknown): StoredCarePreparationRevision {
    const codec = codecFor((value as { recordType?: unknown } | null)?.recordType);
    if (!codec) throw new StorageRowValidationError("STORAGE_VALIDATION_FAILED", "recordRevisions", "WRITE");
    return codec.validateForWrite(value);
  },
  validateAfterRead(value: unknown): StoredCarePreparationRevision {
    const codec = codecFor((value as { recordType?: unknown } | null)?.recordType);
    if (!codec) throw new StorageRowValidationError("STORAGE_INTEGRITY_FAILED", "recordRevisions", "READ");
    return codec.validateAfterRead(value);
  },
});

function storeRevision(revision: CarePreparationRevision): StoredCarePreparationRevision {
  return revision.recordType === "CARE_SUMMARY_SNAPSHOT"
    ? (careSummarySnapshotRevisionCodec.create(revision) as StoredCarePreparationRevision)
    : (careSummaryExportRevisionCodec.create(revision) as StoredCarePreparationRevision);
}

// --- Closed audit and event rows ------------------------------------------------------

export const CARE_PREPARATION_AUDIT_REASONS = Object.freeze([
  "SUMMARY_PREPARED",
  "SUMMARY_PREVIEWED",
  "SUMMARY_APPROVED",
  "SUMMARY_INVALIDATED",
  "SUMMARY_SUPERSEDED",
  "SUMMARY_SOURCE_DELETED",
  "EXPORT_REQUESTED",
  "EXPORT_OUTCOME_RECORDED",
] as const);
export type CarePreparationAuditReason = (typeof CARE_PREPARATION_AUDIT_REASONS)[number];

export type CarePreparationAuditRow = {
  auditEventId: AuditEventId;
  transactionId: TransactionId;
  recordId: RecordId;
  recordType: CarePreparationRecordType;
  previousRevisionId: RevisionId | null;
  resultingRevisionId: RevisionId | null;
  action: "CREATE" | "UPDATE" | "SYSTEM_DERIVE" | "DELETE";
  /** Preview, approval and export keep the patient as initiator (domain 11.10). */
  initiator: "PATIENT" | "JAGAON_SYSTEM";
  /** Packet 11C B1b: AI_ASSISTED only on the creation of an AI-assisted snapshot (its revision provenance says the same). */
  assistance: "NONE" | "AI_ASSISTED";
  occurredAt: Instant;
  reasonCode: CarePreparationAuditReason;
};

const auditRowSchema = z
  .strictObject({
    auditEventId: auditEventIdSchema,
    transactionId: transactionIdSchema,
    recordId: recordIdSchema,
    recordType: z.enum(CARE_PREPARATION_RECORD_TYPES),
    previousRevisionId: revisionIdSchema.nullable(),
    resultingRevisionId: revisionIdSchema.nullable(),
    action: z.enum(["CREATE", "UPDATE", "SYSTEM_DERIVE", "DELETE"]),
    initiator: z.enum(["PATIENT", "JAGAON_SYSTEM"]),
    assistance: z.enum(["NONE", "AI_ASSISTED"]),
    occurredAt: instantSchema,
    reasonCode: z.enum(CARE_PREPARATION_AUDIT_REASONS),
  })
  .refine((row) => (row.action === "DELETE") === (row.resultingRevisionId === null), "DELETE_HAS_NO_RESULTING_REVISION")
  // Packet 11C B1b: AI assistance is audited only where the domain records it, on the creation of an AI-assisted snapshot.
  .refine((row) => row.assistance === "NONE" || (row.recordType === "CARE_SUMMARY_SNAPSHOT" && row.action === "CREATE" && row.reasonCode === "SUMMARY_PREPARED"), "AI_ASSISTANCE_NOT_PERMITTED")
  .refine((row) => !row.reasonCode.startsWith("EXPORT_") || (row.recordType === "CARE_SUMMARY_EXPORT" && row.initiator === "PATIENT"), "EXPORT_REQUIRES_PATIENT")
  .transform((row): CarePreparationAuditRow => row as CarePreparationAuditRow);

/** Event name → record type it announces (null: deletion). */
export const CARE_PREPARATION_EVENT_TARGETS: Readonly<Record<string, CarePreparationRecordType | null>> = Object.freeze({
  CARE_SUMMARY_SNAPSHOT_PREPARED: "CARE_SUMMARY_SNAPSHOT",
  CARE_SUMMARY_SNAPSHOT_PREVIEWED: "CARE_SUMMARY_SNAPSHOT",
  CARE_SUMMARY_SNAPSHOT_APPROVED: "CARE_SUMMARY_SNAPSHOT",
  CARE_SUMMARY_SNAPSHOT_INVALIDATED: "CARE_SUMMARY_SNAPSHOT",
  CARE_SUMMARY_SNAPSHOT_SUPERSEDED: "CARE_SUMMARY_SNAPSHOT",
  CARE_SUMMARY_EXPORT_REQUESTED: "CARE_SUMMARY_EXPORT",
  CARE_SUMMARY_EXPORT_OUTCOME_RECORDED: "CARE_SUMMARY_EXPORT",
  PATIENT_RECORD_DELETED: null,
});

const EVENT_NAMES = Object.freeze(Object.keys(CARE_PREPARATION_EVENT_TARGETS) as [string, ...string[]]);

/** Closed event reasons; an outcome event names only the outcome code (event-contracts 9.4). */
export const CARE_PREPARATION_EVENT_REASONS = Object.freeze([
  "PREPARED",
  "PREVIEWED",
  "APPROVED",
  "INVALIDATED",
  "SUPERSEDED",
  "REQUESTED",
  "EXPORTED",
  "CANCELLED",
  "FAILED",
  "OUTCOME_UNKNOWN",
  "DELETED",
] as const);
export type CarePreparationEventReason = (typeof CARE_PREPARATION_EVENT_REASONS)[number];

export type CarePreparationEventRow = {
  eventId: DomainEventId;
  eventName: string;
  localSequence: EventSequence;
  transactionIndex: number;
  transactionId: TransactionId;
  commandId: CommandId;
  correlationId: CorrelationId;
  committedAt: Instant;
  change: EventRecordChange;
  payload: { reasonCode: CarePreparationEventReason };
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
    payload: z.strictObject({ reasonCode: z.enum(CARE_PREPARATION_EVENT_REASONS) }),
  })
  .refine((row) => (CARE_PREPARATION_RECORD_TYPES as readonly string[]).includes(row.change.recordType), "EVENT_TARGET_NOT_OWNED")
  .refine((row) => {
    const target = CARE_PREPARATION_EVENT_TARGETS[row.eventName];
    return target === null ? row.change.kind === "RECORD_DELETED" : row.change.kind === "REVISION_CREATED" && target === row.change.recordType;
  }, "EVENT_NAME_DISAGREES_WITH_CHANGE")
  .transform((row): CarePreparationEventRow => row as unknown as CarePreparationEventRow);

const auditCodec = createStorageRowCodec<CarePreparationAuditRow>("auditEvents", auditRowSchema);
const strictEventCodec = createStorageRowCodec<CarePreparationEventRow>("domainEvents", eventRowSchema);
const eventCodec: StorageRowCodec<CarePreparationEventRow> = Object.freeze({
  validateForWrite: (value: unknown) => strictEventCodec.validateForWrite(value),
  validateAfterRead: (value: unknown) => committedDomainEventRowCodec.validateAfterRead(value) as unknown as CarePreparationEventRow,
});

const rejectingEvaluationAuditCodec: StorageRowCodec<never> = Object.freeze({
  validateForWrite(): never {
    throw new StorageRowValidationError("STORAGE_VALIDATION_FAILED", "engineEvaluationAudits", "WRITE");
  },
  validateAfterRead(): never {
    throw new StorageRowValidationError("STORAGE_INTEGRITY_FAILED", "engineEvaluationAudits", "READ");
  },
}) as StorageRowCodec<never>;

export type CarePreparationCommandStore = AuthoritativeCommandStore<StoredCarePreparationRevision, CarePreparationAuditRow, CarePreparationEventRow, StoredReverseDependency, never>;
export type CarePreparationCommandPlan = AuthoritativeCommandPlan<StoredCarePreparationRevision, CarePreparationAuditRow, CarePreparationEventRow, StoredReverseDependency, never>;

export function createCarePreparationCommandStore(database: JagaOnDatabase): CarePreparationCommandStore {
  return createAuthoritativeCommandStore(database, {
    revisionCodec: carePreparationRevisionRowCodec,
    auditCodec,
    eventCodec,
    reverseDependencyCodec: implementedStorageRowCodecs.reverseDependencies,
    evaluationAuditCodec: rejectingEvaluationAuditCodec,
  });
}

export type CarePreparationChange =
  | {
      kind: "REVISION";
      revision: CarePreparationRevision;
      expectedHead: RecordHead | null;
      eventId: DomainEventId;
      eventName: keyof typeof CARE_PREPARATION_EVENT_TARGETS;
      eventReason: CarePreparationEventReason;
      auditReason: CarePreparationAuditReason;
      initiator: "PATIENT" | "JAGAON_SYSTEM";
    }
  | { kind: "DELETE"; head: RecordHead; deletedAt: Instant; auditEventId: AuditEventId; eventId: DomainEventId; initiator: "PATIENT" | "JAGAON_SYSTEM" };

export function buildCarePreparationCommitPlan(input: {
  commandId: CommandId;
  commandHash: Sha256Digest;
  correlationId: CorrelationId;
  transactionId: TransactionId;
  completedAt: Instant;
  changes: CarePreparationChange[];
  /** Exact source revision IDs of a newly prepared snapshot (one edge each). */
  summarySources?: { snapshot: { recordId: RecordId; revisionId: RevisionId }; sourceRevisionIds: RevisionId[] };
  /**
   * Packet 11C B1b: the exact current heads of the sources the new snapshot is built from, re-checked inside the transaction, so a source
   * corrected, superseded or deleted after the pre-checks rejects the whole command (HEAD_CONFLICT) and nothing is written.
   */
  sourceHeads?: RecordHead[];
}): CarePreparationCommandPlan {
  const { commandId, commandHash, correlationId, transactionId, completedAt } = input;
  const expectations: RecordHeadExpectation[] = (input.sourceHeads ?? []).map((head) => {
    if (head.state !== "ACTIVE" || (CARE_PREPARATION_RECORD_TYPES as readonly string[]).includes(head.recordType)) throw new OwnerPlanError("INVALID_TRANSITION");
    return { kind: "MUST_MATCH", recordType: head.recordType, recordId: head.recordId, expectedRevisionId: head.headRevisionId, expectedRevisionNumber: head.headRevisionNumber };
  });
  const revisions: StoredCarePreparationRevision[] = [];
  const heads: RecordHead[] = [];
  const tombstones: DeletionTombstone[] = [];
  const audits: CarePreparationAuditRow[] = [];
  const events: PreparedDomainEvent<CarePreparationEventRow>[] = [];

  for (const change of input.changes) {
    if (change.kind === "REVISION") {
      const revision = change.revision;
      if (revision.action !== "CREATE" && revision.action !== "UPDATE" && revision.action !== "SYSTEM_DERIVE") throw new OwnerPlanError("INVALID_REVISION_LINEAGE");
      if (CARE_PREPARATION_EVENT_TARGETS[change.eventName] !== revision.recordType) throw new OwnerPlanError("INVALID_TRANSITION");
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
        initiator: change.initiator,
        // The revision's own provenance (validated by the domain schema) is the only source of the audited assistance.
        assistance: revision.provenance.assistance,
        occurredAt: completedAt,
        reasonCode: change.auditReason,
      });
      events.push({ eventId: change.eventId, eventName: change.eventName, transactionId, commandId, correlationId, change: revisionCreatedChange(revision), payload: { reasonCode: change.eventReason } });
    } else {
      const pieces = deletionPieces({
        head: change.head,
        ownedRecordTypes: CARE_PREPARATION_RECORD_TYPES,
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
        recordId: change.head.recordId,
        recordType: change.head.recordType as CarePreparationRecordType,
        previousRevisionId: change.head.headRevisionId,
        resultingRevisionId: null,
        action: "DELETE",
        initiator: change.initiator,
        assistance: "NONE",
        occurredAt: change.deletedAt,
        reasonCode: "SUMMARY_SOURCE_DELETED",
      });
      events.push({ eventId: change.eventId, eventName: "PATIENT_RECORD_DELETED", transactionId, commandId, correlationId, change: pieces.change, payload: { reasonCode: "DELETED" } });
    }
  }

  const reverseDependencies: StoredReverseDependency[] = (input.summarySources?.sourceRevisionIds ?? []).map((sourceRevisionId) => ({
    sourceRevisionId,
    dependentRecordType: "CARE_SUMMARY_SNAPSHOT",
    dependentRecordId: input.summarySources!.snapshot.recordId,
    dependentRevisionId: input.summarySources!.snapshot.revisionId,
    dependencyRole: CARE_SUMMARY_SOURCE_EVALUATOR.role,
    owner: "CARE_PREPARATION",
    evaluatorKey: CARE_SUMMARY_SOURCE_EVALUATOR.key,
    evaluatorVersion: CARE_SUMMARY_SOURCE_EVALUATOR.version,
    createdAt: completedAt,
  }));
  if (new Set(reverseDependencies.map((edge) => edge.sourceRevisionId)).size !== reverseDependencies.length) throw new OwnerPlanError("INVALID_REVERSE_DEPENDENCY");

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
    // Summary and export events are projection-only (event-contracts 10.2).
    eventWorkItems: [],
    reverseDependencies,
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
export const CARE_PREPARATION_STORED_ROW_CODECS = Object.freeze({
  revision: carePreparationRevisionRowCodec,
  audit: auditCodec,
  event: strictEventCodec,
});
