import { z } from "zod";
import type { RecordId, RevisionId, AuditEventId, TransactionId } from "./identifiers";
import { recordIdSchema, revisionIdSchema, auditEventIdSchema, transactionIdSchema } from "./identifiers";
import type { Instant } from "./time";
import { instantSchema, instantBefore } from "./time";
import type { RecordType } from "./record-catalogue";
import { recordTypeSchema } from "./record-catalogue";
import type { DomainValidationCode } from "./validation";

// --- Section 1.4: RevisionAction ---

export const REVISION_ACTIONS = [
  "CREATE", "UPDATE", "CORRECT", "SUPERSEDE",
  "CONFIRM", "REJECT", "EXPIRE", "SYSTEM_DERIVE",
] as const;

export type RevisionAction = (typeof REVISION_ACTIONS)[number];

export const revisionActionSchema = z.enum(REVISION_ACTIONS);

// --- Section 1.4: RecordRevision ---
// Generic over TType, TPayload, TTemporal, TProvenance so entity modules
// compose their own typed schemas.

export type RecordRevision<
  TType extends string,
  TPayload,
  TTemporal,
  TProvenance,
> = {
  schemaVersion: number;
  recordType: TType;
  recordId: RecordId;
  revisionId: RevisionId;
  revisionNumber: number;
  previousRevisionId: RevisionId | null;
  action: RevisionAction;
  recordedAt: Instant;
  revisionCreatedAt: Instant;
  temporal: TTemporal;
  provenance: TProvenance;
  auditEventId: AuditEventId;
  transactionId: TransactionId;
  payload: TPayload;
};

// Schema factory: accepts the entity's record-type, payload, temporal, and
// provenance schemas rather than accepting `unknown` payloads. The
// record-type schema is constrained to produce a string so that only valid
// record-type enums compose; payload, temporal, and provenance accept any
// ZodTypeAny.
export function createRecordRevisionSchema<
  TTypeSchema extends z.ZodType<string>,
  TPayloadSchema extends z.ZodTypeAny,
  TTemporalSchema extends z.ZodTypeAny,
  TProvenanceSchema extends z.ZodTypeAny,
>(
  recordTypeS: TTypeSchema,
  payloadS: TPayloadSchema,
  temporalS: TTemporalSchema,
  provenanceS: TProvenanceSchema,
) {
  return z.strictObject({
    schemaVersion: z.number().int().positive(),
    recordType: recordTypeS,
    recordId: recordIdSchema,
    revisionId: revisionIdSchema,
    revisionNumber: z.number().int().positive(),
    previousRevisionId: revisionIdSchema.nullable(),
    action: revisionActionSchema,
    recordedAt: instantSchema,
    revisionCreatedAt: instantSchema,
    temporal: temporalS,
    provenance: provenanceS,
    auditEventId: auditEventIdSchema,
    transactionId: transactionIdSchema,
    payload: payloadS,
  });
}

// --- Section 1.5: RecordHead ---

export type RecordHead = {
  recordId: RecordId;
  recordType: RecordType;
  headRevisionId: RevisionId;
  headRevisionNumber: number;
  state: "ACTIVE" | "DELETED";
  updatedAt: Instant;
};

export const recordHeadSchema = z.strictObject({
  recordId: recordIdSchema,
  recordType: recordTypeSchema,
  headRevisionId: revisionIdSchema,
  headRevisionNumber: z.number().int().positive(),
  state: z.enum(["ACTIVE", "DELETED"]),
  updatedAt: instantSchema,
});

// --- Validation result types ---

export type ValidationResult =
  | { ok: true }
  | { ok: false; code: DomainValidationCode; message: string };

// --- Section 1.4: Lineage validation ---

export function validateRevisionLineage<
  TType extends string,
  TP,
  TT,
  TV,
>(
  previous: RecordRevision<TType, TP, TT, TV> | null,
  next: RecordRevision<TType, TP, TT, TV>,
): ValidationResult {
  // First revision invariants
  if (previous === null) {
    if (next.revisionNumber !== 1) {
      return { ok: false, code: "INVALID_REVISION_LINEAGE", message: "First revision must be numbered 1" };
    }
    if (next.action !== "CREATE") {
      return { ok: false, code: "INVALID_REVISION_LINEAGE", message: "First revision must use action CREATE" };
    }
    if (next.previousRevisionId !== null) {
      return { ok: false, code: "INVALID_REVISION_LINEAGE", message: "First revision must have null previousRevisionId" };
    }
    if (instantBefore(next.revisionCreatedAt, next.recordedAt)) {
      return { ok: false, code: "INVALID_REVISION_LINEAGE", message: "revisionCreatedAt must not precede recordedAt" };
    }
    return { ok: true };
  }

  // Successor invariants
  if (next.action === "CREATE") {
    return { ok: false, code: "INVALID_REVISION_LINEAGE", message: "CREATE cannot be reused on a successor" };
  }
  if (next.revisionNumber !== previous.revisionNumber + 1) {
    return { ok: false, code: "INVALID_REVISION_LINEAGE", message: "Revision number must increase by exactly one" };
  }
  if (next.previousRevisionId !== previous.revisionId) {
    return { ok: false, code: "INVALID_REVISION_LINEAGE", message: "previousRevisionId must point to the immediately preceding revision" };
  }
  if (next.recordId !== previous.recordId) {
    return { ok: false, code: "INVALID_REVISION_LINEAGE", message: "recordId must not change across the chain" };
  }
  if (next.recordType !== previous.recordType) {
    return { ok: false, code: "INVALID_REVISION_LINEAGE", message: "recordType must not change across the chain" };
  }
  if (next.recordedAt !== previous.recordedAt) {
    return { ok: false, code: "INVALID_REVISION_LINEAGE", message: "recordedAt must remain unchanged across the chain" };
  }
  if (instantBefore(next.revisionCreatedAt, next.recordedAt)) {
    return { ok: false, code: "INVALID_REVISION_LINEAGE", message: "revisionCreatedAt must not precede recordedAt" };
  }
  return { ok: true };
}

// --- Section 1.5: Expected head validation ---

export function validateExpectedHead(
  head: RecordHead,
  expectedRevisionId: RevisionId,
  expectedRevisionNumber: number,
): ValidationResult {
  if (
    head.headRevisionId !== expectedRevisionId ||
    head.headRevisionNumber !== expectedRevisionNumber
  ) {
    return { ok: false, code: "REVISION_CONFLICT", message: "Expected head does not match stored head" };
  }
  return { ok: true };
}

// --- Deletion / actionability ---

export function assertActionableHead(head: RecordHead): ValidationResult {
  if (head.state === "DELETED") {
    return { ok: false, code: "DELETED_RECORD_NOT_ACTIONABLE", message: "Record is deleted and not actionable" };
  }
  return { ok: true };
}