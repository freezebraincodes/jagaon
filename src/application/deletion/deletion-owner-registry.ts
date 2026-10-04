import type { CommandId, CorrelationId, DomainEventId } from "@/application/contracts/command-event-identifiers";
import type { AuditEventId, AuthoritativeOwner, Instant, RecordHead, RecordType, TransactionId } from "@/domain/shared";
import type { TypedRevisionRef } from "@/domain/shared/typed-revision-ref";
import type { Sha256Digest } from "@/application/contracts/canonical-json";
import { HACKATHON_STORAGE_PROFILE } from "@/storage/storage-profile-manifest";
import { PERMANENT_DELETION_AUDIT_REASON } from "./deletion-rows";

/**
 * Closed Packet 10A deletion-owner registry (freeze Section 8). Each enabled
 * owner supplies its own withdrawal rows and companion rule; the coordinator
 * never rewrites another owner's content. A dependent type with no adapter
 * rejects the plan. Packet 5A Safety has no adapter in this profile.
 */

export type StoredRevisionRow = { recordId: string; recordType: string; revisionId: string; revision?: { payload?: unknown } };

export type DeletionRowContext = {
  transactionId: TransactionId;
  commandId: CommandId;
  correlationId: CorrelationId;
  deletedAt: Instant;
  auditEventId: AuditEventId;
  eventId: DomainEventId;
  planHash: Sha256Digest;
  affectedDependencies: TypedRevisionRef<RecordType>[];
};

export type DeletionOwnerAdapter = {
  owner: AuthoritativeOwner;
  recordTypes: readonly RecordType[];
  initiator: "PATIENT" | "JAGAON_SYSTEM";
  /** Records inseparable from `recordId` under this owner's locked rule. */
  companions(recordId: string, recordType: RecordType, revisions: readonly StoredRevisionRow[]): string[];
  rows(head: RecordHead, context: DeletionRowContext): { audit: Record<string, unknown>; event: Record<string, unknown> };
};

type PayloadPath = readonly string[];

function refAt(row: StoredRevisionRow, path: PayloadPath): string | undefined {
  let value: unknown = row.revision?.payload;
  for (const key of path) value = (value as Record<string, unknown> | undefined)?.[key];
  const recordId = (value as { recordId?: unknown } | undefined)?.recordId;
  return typeof recordId === "string" ? recordId : undefined;
}

/** Records of `recordType` with any revision whose payload ref at `path` names `recordId`. */
function referencing(revisions: readonly StoredRevisionRow[], recordType: RecordType, path: PayloadPath, recordId: string): string[] {
  return [...new Set(revisions.filter((row) => row.recordType === recordType && refAt(row, path) === recordId).map((row) => row.recordId))];
}

/** Records named at `path` by any revision of `recordId`. */
function referencedBy(revisions: readonly StoredRevisionRow[], recordId: string, path: PayloadPath): string[] {
  return [...new Set(revisions.filter((row) => row.recordId === recordId).map((row) => refAt(row, path)).filter((value): value is string => value !== undefined))];
}

function systemRows(head: RecordHead, context: DeletionRowContext, reasonCode: string, payload: Record<string, unknown>) {
  return {
    audit: {
      auditEventId: context.auditEventId,
      transactionId: context.transactionId,
      recordId: head.recordId,
      recordType: head.recordType,
      previousRevisionId: head.headRevisionId,
      resultingRevisionId: null,
      action: "DELETE",
      initiator: "JAGAON_SYSTEM",
      assistance: "NONE",
      occurredAt: context.deletedAt,
      reasonCode,
    },
    event: {
      eventId: context.eventId,
      eventName: "PATIENT_RECORD_DELETED",
      transactionId: context.transactionId,
      commandId: context.commandId,
      correlationId: context.correlationId,
      change: { kind: "RECORD_DELETED", recordType: head.recordType, recordId: head.recordId, previousRevisionId: head.headRevisionId, resultingRevisionId: null },
      payload,
    },
  };
}

const TARGET_OWNER: DeletionOwnerAdapter = {
  owner: "HEALTH_RECORDS",
  recordTypes: HACKATHON_STORAGE_PROFILE.permanentDeletionTargets,
  initiator: "PATIENT",
  companions: () => [],
  rows(head, context) {
    return {
      audit: {
        auditEventId: context.auditEventId,
        transactionId: context.transactionId,
        recordId: head.recordId,
        recordType: head.recordType,
        previousRevisionId: head.headRevisionId,
        resultingRevisionId: null,
        action: "DELETE",
        initiator: "PATIENT",
        assistance: "NONE",
        occurredAt: context.deletedAt,
        reasonCode: PERMANENT_DELETION_AUDIT_REASON,
      },
      event: {
        eventId: context.eventId,
        eventName: "PATIENT_RECORD_DELETED",
        transactionId: context.transactionId,
        commandId: context.commandId,
        correlationId: context.correlationId,
        change: { kind: "RECORD_DELETED", recordType: head.recordType, recordId: head.recordId, previousRevisionId: head.headRevisionId, resultingRevisionId: null },
        // event-contracts-spec 8.4: no deleted value, only the reviewed plan and opaque refs.
        payload: {
          deletedRecordType: head.recordType,
          deletionReasonCode: "PATIENT_REQUESTED",
          reviewedDeletionPlanHash: context.planHash,
          affectedDependencies: context.affectedDependencies,
        },
      },
    };
  },
};

/** Pattern evidence snapshots and the observations that present them are one inseparable chain. */
const PATTERN_OWNER: DeletionOwnerAdapter = {
  owner: "PATTERN_ENGINE",
  recordTypes: ["PATTERN_EVIDENCE_SNAPSHOT", "PATTERN_OBSERVATION"],
  initiator: "JAGAON_SYSTEM",
  companions(recordId, recordType, revisions) {
    return recordType === "PATTERN_EVIDENCE_SNAPSHOT"
      ? referencing(revisions, "PATTERN_OBSERVATION", ["evidenceSnapshot"], recordId)
      : referencedBy(revisions, recordId, ["evidenceSnapshot"]);
  },
  rows: (head, context) => systemRows(head, context, "PATTERN_DERIVED_CONTENT_DELETED", { evaluationId: null, reasonCode: "PATTERN_DERIVED_CONTENT_DELETED" }),
};

const LEARNING_OWNER: DeletionOwnerAdapter = {
  owner: "LEARNING_ENGINE",
  recordTypes: ["LEARNED_KNOWLEDGE"],
  initiator: "JAGAON_SYSTEM",
  companions: () => [],
  rows: (head, context) => systemRows(head, context, "LEARNED_DERIVED_CONTENT_DELETED", { evaluationId: null, reasonCode: "LEARNED_DERIVED_CONTENT_DELETED" }),
};

/** An answer is never kept without the exact question it answered. */
const INQUIRY_OWNER: DeletionOwnerAdapter = {
  owner: "INQUIRY",
  recordTypes: ["INQUIRY", "INQUIRY_RESPONSE"],
  initiator: "JAGAON_SYSTEM",
  companions(recordId, recordType, revisions) {
    if (recordType !== "INQUIRY") return [];
    return [
      ...referencing(revisions, "INQUIRY_RESPONSE", ["inquiryPresentation", "inquiry"], recordId),
      ...referencedBy(revisions, recordId, ["lifecycle", "response"]),
    ];
  },
  rows: (head, context) => systemRows(head, context, "SOURCE_DELETED", { reasonCode: "SOURCE_DELETED" }),
};

/** A care-summary snapshot that copied deleted content is removed with its export attempts. */
const CARE_PREPARATION_OWNER: DeletionOwnerAdapter = {
  owner: "CARE_PREPARATION",
  recordTypes: ["CARE_SUMMARY_SNAPSHOT", "CARE_SUMMARY_EXPORT"],
  initiator: "JAGAON_SYSTEM",
  companions(recordId, recordType, revisions) {
    return recordType === "CARE_SUMMARY_SNAPSHOT" ? referencing(revisions, "CARE_SUMMARY_EXPORT", ["snapshot"], recordId) : [];
  },
  rows: (head, context) => systemRows(head, context, "SUMMARY_SOURCE_DELETED", { reasonCode: "DELETED" }),
};

/**
 * Care Plan owns reminder-target edges from prescriptions. No enabled
 * deletion target reaches them; a reminder dependent is therefore refused.
 */
const CARE_PLAN_OWNER: DeletionOwnerAdapter = {
  owner: "CARE_PLAN",
  recordTypes: [],
  initiator: "JAGAON_SYSTEM",
  companions: () => [],
  rows() {
    throw new Error("CARE_PLAN_DELETION_NOT_ENABLED");
  },
};

const ADAPTERS: Readonly<Record<string, DeletionOwnerAdapter>> = Object.freeze({
  HEALTH_RECORDS: TARGET_OWNER,
  PATTERN_ENGINE: PATTERN_OWNER,
  LEARNING_ENGINE: LEARNING_OWNER,
  INQUIRY: INQUIRY_OWNER,
  CARE_PLAN: CARE_PLAN_OWNER,
  CARE_PREPARATION: CARE_PREPARATION_OWNER,
});

/** Adapters in the frozen enabled-owner deletion order. */
export const DELETION_OWNER_ADAPTERS: readonly DeletionOwnerAdapter[] = Object.freeze(
  HACKATHON_STORAGE_PROFILE.deletionOwnerOrder.map((owner) => {
    const adapter = ADAPTERS[owner];
    if (!adapter) throw new Error("DELETION_OWNER_MISSING");
    return adapter;
  }),
);

export function dependentAdapterFor(recordType: string): DeletionOwnerAdapter | null {
  return DELETION_OWNER_ADAPTERS.slice(1).find((adapter) => (adapter.recordTypes as readonly string[]).includes(recordType)) ?? null;
}

export const TARGET_DELETION_OWNER = TARGET_OWNER;
