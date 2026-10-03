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
import {
  inquiryRevisionSchema,
  inquiryResponseRevisionSchema,
  validateInquiryTransition,
  type InquiryLifecycleState,
  type InquiryResponseRevision,
  type InquiryRevision,
} from "@/domain/inquiry";
import { INQUIRY_CAPABILITY_MANIFEST } from "@/inquiry/inquiry-capability-manifest";
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
import {
  OwnerPlanError,
  activeHeadFor,
  deletionPieces,
  expectationFor,
  revisionCreatedChange,
} from "@/application/owner-plan-support";

/**
 * Packet 8 Inquiry authoritative persistence (event-contracts Sections 7.2,
 * 9.2 and 11.1; domain Section 9.14).
 *
 * An answer commits the immutable response revision and the corresponding
 * terminal Inquiry revision in one transaction. The response codec accepts
 * only the ordinary-journal `NOT_APPLICABLE` Safety disposition bound to the
 * active Inquiry capability manifest; no plan here can carry a Safety record,
 * Safety participation or a policy-pack reference.
 */

export const INQUIRY_RECORD_TYPES = Object.freeze(["INQUIRY", "INQUIRY_RESPONSE"] as const);

export type InquiryOwnedRevision = InquiryRevision | InquiryResponseRevision;
export type StoredInquiryOwnedRevision = StoredRecordRevision<InquiryOwnedRevision>;

const atemporalIndex = () => ({ temporalKind: "ATEMPORAL" as const });

export const inquiryRevisionCodec = createStoredRecordRevisionCodec<"INQUIRY", InquiryRevision>({
  recordTypeSchema: z.literal("INQUIRY"),
  revisionSchema: inquiryRevisionSchema,
  deriveTemporalIndexFields: atemporalIndex,
});

/** The ordinary-journal capability guard: Safety is structurally absent. */
const ordinaryResponseRevisionSchema = (inquiryResponseRevisionSchema as unknown as z.ZodType<InquiryResponseRevision, z.ZodTypeDef, unknown>).refine(
  (revision) =>
    revision.payload.safetyDisposition.applicability === "NOT_APPLICABLE" &&
    revision.payload.safetyDisposition.capabilityManifestVersion === INQUIRY_CAPABILITY_MANIFEST.manifestVersion,
  "SAFETY_DISPOSITION_DISAGREES_WITH_CAPABILITY_MANIFEST",
);

export const inquiryResponseRevisionCodec = createStoredRecordRevisionCodec<"INQUIRY_RESPONSE", InquiryResponseRevision>({
  recordTypeSchema: z.literal("INQUIRY_RESPONSE"),
  revisionSchema: ordinaryResponseRevisionSchema,
  deriveTemporalIndexFields: atemporalIndex,
});

function codecFor(recordType: unknown): StorageRowCodec<StoredInquiryOwnedRevision> | null {
  if (recordType === "INQUIRY") return inquiryRevisionCodec as unknown as StorageRowCodec<StoredInquiryOwnedRevision>;
  if (recordType === "INQUIRY_RESPONSE") return inquiryResponseRevisionCodec as unknown as StorageRowCodec<StoredInquiryOwnedRevision>;
  return null;
}

export const inquiryOwnedRevisionRowCodec: StorageRowCodec<StoredInquiryOwnedRevision> = Object.freeze({
  validateForWrite(value: unknown): StoredInquiryOwnedRevision {
    const codec = codecFor((value as { recordType?: unknown } | null)?.recordType);
    if (!codec) throw new StorageRowValidationError("STORAGE_VALIDATION_FAILED", "recordRevisions", "WRITE");
    return codec.validateForWrite(value);
  },
  validateAfterRead(value: unknown): StoredInquiryOwnedRevision {
    const codec = codecFor((value as { recordType?: unknown } | null)?.recordType);
    if (!codec) throw new StorageRowValidationError("STORAGE_INTEGRITY_FAILED", "recordRevisions", "READ");
    return codec.validateAfterRead(value);
  },
});

export function storeInquiryOwnedRevision(revision: InquiryOwnedRevision): StoredInquiryOwnedRevision {
  return revision.recordType === "INQUIRY"
    ? (inquiryRevisionCodec.create(revision) as StoredInquiryOwnedRevision)
    : (inquiryResponseRevisionCodec.create(revision) as StoredInquiryOwnedRevision);
}

// --- Closed audit and event rows ---------------------------------------------------------

export const INQUIRY_AUDIT_REASONS = Object.freeze([
  "CANDIDATE_CREATED",
  "ELIGIBILITY_ASSESSED",
  "QUEUED",
  "PRESENTED",
  "PATIENT_SNOOZED",
  "PATIENT_DISMISSED",
  "PATIENT_ANSWERED",
  "PATIENT_CORRECTED_ANSWER",
  "EXPIRED",
  "WITHDRAWN",
  "PATIENT_DELETED",
  "SOURCE_DELETED",
] as const);

export type InquiryAuditReason = (typeof INQUIRY_AUDIT_REASONS)[number];

export type InquiryAuditRow = {
  auditEventId: AuditEventId;
  transactionId: TransactionId;
  recordId: RecordId;
  recordType: (typeof INQUIRY_RECORD_TYPES)[number];
  previousRevisionId: RevisionId | null;
  resultingRevisionId: RevisionId | null;
  action: "CREATE" | "UPDATE" | "CORRECT" | "SYSTEM_DERIVE" | "EXPIRE" | "DELETE";
  initiator: "PATIENT" | "JAGAON_SYSTEM";
  assistance: "NONE";
  occurredAt: Instant;
  reasonCode: InquiryAuditReason;
};

const inquiryAuditRowSchema = z
  .strictObject({
    auditEventId: auditEventIdSchema,
    transactionId: transactionIdSchema,
    recordId: recordIdSchema,
    recordType: z.enum(INQUIRY_RECORD_TYPES),
    previousRevisionId: revisionIdSchema.nullable(),
    resultingRevisionId: revisionIdSchema.nullable(),
    action: z.enum(["CREATE", "UPDATE", "CORRECT", "SYSTEM_DERIVE", "EXPIRE", "DELETE"]),
    initiator: z.enum(["PATIENT", "JAGAON_SYSTEM"]),
    assistance: z.literal("NONE"),
    occurredAt: instantSchema,
    reasonCode: z.enum(INQUIRY_AUDIT_REASONS),
  })
  .refine((row) => (row.action === "DELETE") === (row.resultingRevisionId === null), "DELETE_HAS_NO_RESULTING_REVISION")
  .transform((row): InquiryAuditRow => row as InquiryAuditRow);

const LIFECYCLE_STATES = [
  "CANDIDATE",
  "ELIGIBLE",
  "QUEUED",
  "PRESENTED",
  "ANSWERED",
  "NOT_SURE",
  "DECLINED",
  "SNOOZED",
  "DISMISSED",
  "EXPIRED",
  "SUPERSEDED",
  "WITHDRAWN",
] as const satisfies readonly InquiryLifecycleState[];

export const INQUIRY_EVENT_NAMES = Object.freeze([
  "INQUIRY_CREATED",
  "INQUIRY_TRANSITIONED",
  "INQUIRY_RESPONSE_RECORDED",
  "INQUIRY_RESPONSE_CORRECTED",
  "PATIENT_RECORD_DELETED",
] as const);

export type InquiryEventPayload =
  | { reasonCode: InquiryAuditReason }
  | { reasonCode: InquiryAuditReason; fromState: InquiryLifecycleState; toState: InquiryLifecycleState };

export type InquiryEventRow = {
  eventId: DomainEventId;
  eventName: (typeof INQUIRY_EVENT_NAMES)[number];
  localSequence: EventSequence;
  transactionIndex: number;
  transactionId: TransactionId;
  commandId: CommandId;
  correlationId: CorrelationId;
  committedAt: Instant;
  change: EventRecordChange;
  payload: InquiryEventPayload;
};

const inquiryEventRowSchema = z
  .strictObject({
    eventId: domainEventIdSchema,
    eventName: z.enum(INQUIRY_EVENT_NAMES),
    localSequence: z.number().int().positive().safe(),
    transactionIndex: z.number().int().nonnegative().safe(),
    transactionId: transactionIdSchema,
    commandId: commandIdSchema,
    correlationId: correlationIdSchema,
    committedAt: instantSchema,
    change: eventRecordChangeSchema,
    // Closed reason and lifecycle only: never question text or the raw answer.
    payload: z.union([
      z.strictObject({ reasonCode: z.enum(INQUIRY_AUDIT_REASONS), fromState: z.enum(LIFECYCLE_STATES), toState: z.enum(LIFECYCLE_STATES) }),
      z.strictObject({ reasonCode: z.enum(INQUIRY_AUDIT_REASONS) }),
    ]),
  })
  .refine((row) => (INQUIRY_RECORD_TYPES as readonly string[]).includes(row.change.recordType), "EVENT_TARGET_NOT_INQUIRY")
  .refine((row) => {
    if (row.eventName === "PATIENT_RECORD_DELETED") return row.change.kind === "RECORD_DELETED";
    if (row.change.kind !== "REVISION_CREATED") return false;
    const onInquiry = row.change.recordType === "INQUIRY";
    if (row.eventName === "INQUIRY_TRANSITIONED") return onInquiry && "fromState" in row.payload;
    if (row.eventName === "INQUIRY_CREATED") return onInquiry;
    return !onInquiry;
  }, "EVENT_NAME_DISAGREES_WITH_CHANGE")
  .transform((row): InquiryEventRow => row as unknown as InquiryEventRow);

const auditCodec = createStorageRowCodec<InquiryAuditRow>("auditEvents", inquiryAuditRowSchema);
const strictEventCodec = createStorageRowCodec<InquiryEventRow>("domainEvents", inquiryEventRowSchema);
const eventCodec: StorageRowCodec<InquiryEventRow> = Object.freeze({
  validateForWrite: (value: unknown) => strictEventCodec.validateForWrite(value),
  validateAfterRead: (value: unknown) => committedDomainEventRowCodec.validateAfterRead(value) as unknown as InquiryEventRow,
});

const rejectingEvaluationAuditCodec: StorageRowCodec<never> = Object.freeze({
  validateForWrite(): never {
    throw new StorageRowValidationError("STORAGE_VALIDATION_FAILED", "engineEvaluationAudits", "WRITE");
  },
  validateAfterRead(): never {
    throw new StorageRowValidationError("STORAGE_INTEGRITY_FAILED", "engineEvaluationAudits", "READ");
  },
}) as StorageRowCodec<never>;

export type InquiryCommandStore = AuthoritativeCommandStore<StoredInquiryOwnedRevision, InquiryAuditRow, InquiryEventRow, StoredReverseDependency, never>;
export type InquiryCommandPlan = AuthoritativeCommandPlan<StoredInquiryOwnedRevision, InquiryAuditRow, InquiryEventRow, StoredReverseDependency, never>;

export function createInquiryCommandStore(database: JagaOnDatabase): InquiryCommandStore {
  return createAuthoritativeCommandStore(database, {
    revisionCodec: inquiryOwnedRevisionRowCodec,
    auditCodec,
    eventCodec,
    reverseDependencyCodec: implementedStorageRowCodecs.reverseDependencies,
    evaluationAuditCodec: rejectingEvaluationAuditCodec,
  });
}

// --- Plan builder ---------------------------------------------------------------------------

export type InquiryChange =
  | {
      kind: "REVISION";
      revision: InquiryOwnedRevision;
      expectedHead: RecordHead | null;
      /** The previous Inquiry revision and every presentation key used in the chain. */
      transitionFrom?: { previous: InquiryRevision; usedPresentationKeys: ReadonlySet<string> };
      eventId: DomainEventId;
      eventName: Exclude<(typeof INQUIRY_EVENT_NAMES)[number], "PATIENT_RECORD_DELETED">;
      auditReason: InquiryAuditReason;
    }
  | {
      kind: "DELETE";
      head: RecordHead;
      deletedAt: Instant;
      initiator: "PATIENT" | "JAGAON_SYSTEM";
      auditEventId: AuditEventId;
      eventId: DomainEventId;
      auditReason: Extract<InquiryAuditReason, "PATIENT_DELETED" | "SOURCE_DELETED">;
    };

function auditAction(revision: InquiryOwnedRevision): InquiryAuditRow["action"] {
  return revision.action as InquiryAuditRow["action"];
}

export function buildInquiryCommitPlan(input: {
  commandId: CommandId;
  commandHash: Sha256Digest;
  correlationId: CorrelationId;
  transactionId: TransactionId;
  completedAt: Instant;
  changes: InquiryChange[];
  reverseDependencies: StoredReverseDependency[];
}): InquiryCommandPlan {
  const { commandId, commandHash, correlationId, transactionId, completedAt } = input;
  const expectations: RecordHeadExpectation[] = [];
  const revisions: StoredInquiryOwnedRevision[] = [];
  const heads: RecordHead[] = [];
  const tombstones: DeletionTombstone[] = [];
  const audits: InquiryAuditRow[] = [];
  const events: PreparedDomainEvent<InquiryEventRow>[] = [];
  const base = { transactionId, commandId, correlationId };

  for (const change of input.changes) {
    if (change.kind === "REVISION") {
      const revision = change.revision;
      expectations.push(expectationFor(revision, change.expectedHead, transactionId));
      let payload: InquiryEventPayload = { reasonCode: change.auditReason };
      if (revision.recordType === "INQUIRY" && change.transitionFrom) {
        const issue = validateInquiryTransition(change.transitionFrom.previous, revision, change.transitionFrom.usedPresentationKeys);
        if (issue) throw new OwnerPlanError("INVALID_TRANSITION");
        payload = {
          reasonCode: change.auditReason,
          fromState: change.transitionFrom.previous.payload.lifecycle.state,
          toState: revision.payload.lifecycle.state,
        };
      } else if (revision.recordType === "INQUIRY" && revision.action !== "CREATE") {
        throw new OwnerPlanError("INVALID_TRANSITION");
      }
      revisions.push(storeInquiryOwnedRevision(revision));
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
      events.push({ ...base, eventId: change.eventId, eventName: change.eventName, change: revisionCreatedChange(revision), payload });
    } else {
      const pieces = deletionPieces({
        head: change.head,
        ownedRecordTypes: INQUIRY_RECORD_TYPES,
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
        recordType: change.head.recordType as InquiryAuditRow["recordType"],
        previousRevisionId: change.head.headRevisionId,
        resultingRevisionId: null,
        action: "DELETE",
        initiator: change.initiator,
        assistance: "NONE",
        occurredAt: change.deletedAt,
        reasonCode: change.auditReason,
      });
      events.push({ ...base, eventId: change.eventId, eventName: "PATIENT_RECORD_DELETED", change: pieces.change, payload: { reasonCode: change.auditReason } });
    }
  }

  for (const edge of input.reverseDependencies) {
    const dependent = revisions.find((row) => row.revisionId === edge.dependentRevisionId);
    if (!dependent || dependent.recordId !== edge.dependentRecordId || dependent.recordType !== edge.dependentRecordType || edge.owner !== "INQUIRY") {
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
    // Inquiry and response events intentionally have no asynchronous consumer.
    eventWorkItems: [],
    reverseDependencies: input.reverseDependencies,
    evaluationAudits: [],
    appPreference: null,
    safety: { kind: "NOT_REQUIRED" },
  };
}
