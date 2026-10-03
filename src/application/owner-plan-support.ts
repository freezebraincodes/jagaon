import type { RecordHeadExpectation } from "@/application/contracts/command-envelope";
import type { EventRecordChange } from "@/application/contracts/domain-event-envelope";
import type { AuditEventId, DeletionTombstone, Instant, RecordHead, RecordId, RecordType, RevisionId, TransactionId } from "@/domain/shared";
import type { RevisionAction } from "@/domain/shared/revision";

/**
 * Shared authoritative-plan helpers for owner command stores (event-contracts
 * Sections 2.2 and 11.1). A revision's lineage is checked against its exact
 * expected head before the transaction re-checks that head atomically.
 */

export type OwnedRevisionEnvelope = {
  recordType: RecordType;
  recordId: RecordId;
  revisionId: RevisionId;
  revisionNumber: number;
  previousRevisionId: RevisionId | null;
  action: RevisionAction;
  transactionId: TransactionId;
};

export class OwnerPlanError extends Error {
  readonly name = "OwnerPlanError";
  constructor(readonly code: "INVALID_REVISION_LINEAGE" | "INVALID_DELETION_TARGET" | "INVALID_REVERSE_DEPENDENCY" | "INVALID_TRANSITION") {
    super(code);
  }
}

/** Lineage check plus the head expectation the transaction must re-check. */
export function expectationFor(revision: OwnedRevisionEnvelope, expectedHead: RecordHead | null, transactionId: TransactionId): RecordHeadExpectation {
  if (revision.transactionId !== transactionId) throw new OwnerPlanError("INVALID_REVISION_LINEAGE");
  if (expectedHead === null) {
    if (revision.revisionNumber !== 1 || revision.previousRevisionId !== null || revision.action !== "CREATE") {
      throw new OwnerPlanError("INVALID_REVISION_LINEAGE");
    }
    return { kind: "MUST_NOT_EXIST", recordType: revision.recordType, proposedRecordId: revision.recordId };
  }
  if (
    expectedHead.state !== "ACTIVE" ||
    expectedHead.recordId !== revision.recordId ||
    expectedHead.recordType !== revision.recordType ||
    revision.previousRevisionId !== expectedHead.headRevisionId ||
    revision.revisionNumber !== expectedHead.headRevisionNumber + 1 ||
    revision.action === "CREATE"
  ) {
    throw new OwnerPlanError("INVALID_REVISION_LINEAGE");
  }
  return {
    kind: "MUST_MATCH",
    recordType: revision.recordType,
    recordId: revision.recordId,
    expectedRevisionId: expectedHead.headRevisionId,
    expectedRevisionNumber: expectedHead.headRevisionNumber,
  };
}

export function activeHeadFor(revision: OwnedRevisionEnvelope, updatedAt: Instant): RecordHead {
  return {
    recordId: revision.recordId,
    recordType: revision.recordType,
    headRevisionId: revision.revisionId,
    headRevisionNumber: revision.revisionNumber,
    state: "ACTIVE",
    updatedAt,
  };
}

export function revisionCreatedChange(revision: OwnedRevisionEnvelope): EventRecordChange {
  return {
    kind: "REVISION_CREATED",
    recordType: revision.recordType,
    recordId: revision.recordId,
    action: revision.action,
    previousRevisionId: revision.previousRevisionId,
    resultingRevisionId: revision.revisionId,
    resultingRevisionNumber: revision.revisionNumber,
  } as EventRecordChange;
}

/** Tombstone, deleted head, head expectation and deletion change for one active record. */
export function deletionPieces(input: {
  head: RecordHead;
  ownedRecordTypes: readonly RecordType[];
  deletedAt: Instant;
  initiator: "PATIENT" | "JAGAON_SYSTEM";
  auditEventId: AuditEventId;
  transactionId: TransactionId;
}): { expectation: RecordHeadExpectation; tombstone: DeletionTombstone; head: RecordHead; change: EventRecordChange } {
  const { head } = input;
  if (head.state !== "ACTIVE" || !input.ownedRecordTypes.includes(head.recordType)) throw new OwnerPlanError("INVALID_DELETION_TARGET");
  return {
    expectation: {
      kind: "MUST_MATCH",
      recordType: head.recordType,
      recordId: head.recordId,
      expectedRevisionId: head.headRevisionId,
      expectedRevisionNumber: head.headRevisionNumber,
    },
    tombstone: {
      recordId: head.recordId,
      recordType: head.recordType,
      deletedAt: input.deletedAt,
      initiator: input.initiator,
      auditEventId: input.auditEventId,
      transactionId: input.transactionId,
    },
    head: { ...head, state: "DELETED", updatedAt: input.deletedAt },
    change: {
      kind: "RECORD_DELETED",
      recordType: head.recordType,
      recordId: head.recordId,
      previousRevisionId: head.headRevisionId,
      resultingRevisionId: null,
    } as EventRecordChange,
  };
}
