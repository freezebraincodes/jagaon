import type { Sha256Digest } from "@/application/contracts/canonical-json";
import type { AuthoritativeOwner, Instant, RecordHead, RecordId, RecordType } from "@/domain/shared";
import type { StorageOperationFailure } from "@/storage/storage-failure";

/**
 * Packet 10A permanent-deletion contracts (storage-backup-spec 6.4–6.6;
 * Packet 10 freeze Section 8). A plan is closed, canonical, hash-bound and
 * expires after ten minutes (frozen audit resolution 5).
 */

export const DELETION_PLAN_TTL_MS = 10 * 60 * 1000;

export type DeletionTarget = { recordType: RecordType; recordId: RecordId };

export type DeletionDependent = { owner: AuthoritativeOwner; head: RecordHead };

/** Complete canonical identity of one reverse-dependency edge the deletion removes. */
export type DeletionEdge = {
  sourceRevisionId: string;
  dependentRecordId: string;
  dependentRevisionId: string;
  dependencyRole: string;
  owner: string;
  evaluatorKey: string;
  evaluatorVersion: string;
};

/** Owner consequence for each dependent (storage-backup-spec 6.4–6.5). */
export type DeletionConsequence = {
  owner: AuthoritativeOwner;
  recordType: RecordType;
  recordId: RecordId;
  outcome: "PERMANENTLY_WITHDRAWN";
  basis: "EXACT_DEPENDENCY" | "OWNER_COMPANION";
};

export type DeletionClosure = {
  targetHead: RecordHead;
  /** Dependents in the frozen owner order, then record identity. */
  dependents: DeletionDependent[];
  edges: DeletionEdge[];
  consequences: DeletionConsequence[];
  purgedRecordIds: RecordId[];
  evaluationIds: string[];
  receiptCommandIds: string[];
  redactedEventIds: string[];
};

/** Patient-meaningful effects only: no identifiers, hashes or values. */
export type DeletionPlanEffects = {
  targetRecordType: RecordType;
  dependentCount: number;
  externalCopiesNotRecalled: true;
};

export type DeletionPlan = Readonly<{
  planHash: Sha256Digest;
  createdAt: Instant;
  expiresAt: Instant;
  target: DeletionTarget;
  closure: DeletionClosure;
  closureFingerprint: string;
  neutralisedReceipts: ReadonlyArray<{ commandId: string; commandHash: Sha256Digest }>;
  effects: DeletionPlanEffects;
}>;

export type DeletionConfirmation = Readonly<{ planHash: Sha256Digest; confirmedAt: Instant }>;

export const DELETION_PLAN_REFUSALS = Object.freeze([
  "TARGET_NOT_FOUND",
  "TARGET_NOT_ACTIVE",
  "TARGET_NOT_PATIENT_DELETABLE",
  "UNSUPPORTED_DEPENDENT",
  "DEPENDENT_NOT_ACTIVE",
] as const);
export type DeletionPlanRefusal = (typeof DELETION_PLAN_REFUSALS)[number];

export type PrepareDeletionResult =
  | { kind: "PLAN_READY"; plan: DeletionPlan }
  | { kind: "REFUSED"; reason: DeletionPlanRefusal }
  | { kind: "FAILED"; failure: StorageOperationFailure };

export type ConfirmDeletionResult =
  | { kind: "DELETED"; removedRecordCount: number }
  | { kind: "STALE"; failure: StorageOperationFailure }
  | { kind: "FAILED"; failure: StorageOperationFailure };
