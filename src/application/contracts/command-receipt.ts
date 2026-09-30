import { z } from "zod";
import {
  recordTypeSchema,
  type RecordType,
  recordIdSchema,
  type RecordId,
  revisionIdSchema,
  type RevisionId,
  recordHeadSchema,
  type RecordHead,
  transactionIdSchema,
  type TransactionId,
  auditEventIdSchema,
  type AuditEventId,
} from "@/domain/shared";
import {
  domainEventIdSchema,
  type DomainEventId,
  commandIdSchema,
  type CommandId,
} from "./command-event-identifiers";
import { type Instant, instantSchema } from "@/domain/shared/time";
import {
  type TypedRevisionRef,
} from "@/domain/shared/typed-revision-ref";
import { type Sha256Digest, sha256DigestSchema } from "./canonical-json";

// ---------------------------------------------------------------------------
// CommandErrorCode — closed catalogue (Section 13.2)
// ---------------------------------------------------------------------------

export const COMMAND_ERROR_CODES = [
  "INVALID_COMMAND",
  "UNSUPPORTED_COMMAND_VERSION",
  "COMMAND_NOT_ALLOWED",
  "RECORD_NOT_FOUND",
  "HEAD_CONFLICT",
  "COMMAND_REPLAY_MISMATCH",
  "VALIDATION_FAILED",
  "INVALID_STATE_TRANSITION",
  "DEPENDENCY_CHANGED",
  "STALE_PATIENT_CONFIRMATION",
  "GOVERNED_ASSET_UNAVAILABLE",
  "STORAGE_COMMIT_FAILED",
  "INTEGRITY_CHECK_FAILED",
] as const;

export type CommandErrorCode = (typeof COMMAND_ERROR_CODES)[number];

export const commandErrorCodeSchema = z.enum(COMMAND_ERROR_CODES);

// ---------------------------------------------------------------------------
// Shared building blocks for receipt objects
// ---------------------------------------------------------------------------

// A RecordType-wide typed revision ref. Defined directly because the shared
// createTypedRevisionRefSchema factory expects a single literal schema, while
// receipts accept any approved RecordType.
const anyTypedRevisionRefSchema = z
  .object({
    recordType: recordTypeSchema,
    recordId: recordIdSchema,
    revisionId: revisionIdSchema,
  })
  .strict();

// Strict deleted-record reference (Section 2.4 COMMITTED variant).
const deletedRecordSchema = z
  .object({
    recordType: recordTypeSchema,
    recordId: recordIdSchema,
  })
  .strict();

// ---------------------------------------------------------------------------
// CommandReceipt — three strict variants (Section 2.4)
// ---------------------------------------------------------------------------

export type CommandReceipt =
  | {
      outcome: "COMMITTED";
      commandId: CommandId;
      commandHash: Sha256Digest;
      completedAt: Instant;
      transactionId: TransactionId;
      resultingRevisions: TypedRevisionRef<RecordType>[];
      deletedRecords: {
        recordType: RecordType;
        recordId: RecordId;
      }[];
      auditEventIds: AuditEventId[];
      domainEventIds: DomainEventId[];
    }
  | {
      outcome: "NO_CHANGE";
      commandId: CommandId;
      commandHash: Sha256Digest;
      completedAt: Instant;
      existingRevisions: TypedRevisionRef<RecordType>[];
    }
  | {
      outcome: "REJECTED";
      commandId: CommandId;
      commandHash: Sha256Digest;
      completedAt: Instant;
      errorCode: CommandErrorCode;
      currentHeads: RecordHead[];
    };

export const commandReceiptSchema = z.discriminatedUnion("outcome", [
  // --- COMMITTED ---
  z
    .object({
      outcome: z.literal("COMMITTED"),
      commandId: commandIdSchema,
      commandHash: sha256DigestSchema,
      completedAt: instantSchema,
      transactionId: transactionIdSchema,
      resultingRevisions: z.array(anyTypedRevisionRefSchema),
      deletedRecords: z.array(deletedRecordSchema),
      auditEventIds: z.array(auditEventIdSchema),
      domainEventIds: z.array(domainEventIdSchema),
    })
    .strict(),

  // --- NO_CHANGE ---
  z
    .object({
      outcome: z.literal("NO_CHANGE"),
      commandId: commandIdSchema,
      commandHash: sha256DigestSchema,
      completedAt: instantSchema,
      existingRevisions: z.array(anyTypedRevisionRefSchema),
    })
    .strict(),

  // --- REJECTED ---
  z
    .object({
      outcome: z.literal("REJECTED"),
      commandId: commandIdSchema,
      commandHash: sha256DigestSchema,
      completedAt: instantSchema,
      errorCode: commandErrorCodeSchema,
      currentHeads: z.array(recordHeadSchema),
    })
    .strict(),
]);
