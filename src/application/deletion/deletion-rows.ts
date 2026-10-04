import { z } from "zod";
import { sha256DigestSchema } from "@/application/contracts/canonical-json";
import { commandIdSchema, correlationIdSchema, domainEventIdSchema } from "@/application/contracts/command-event-identifiers";
import { anyTypedRevisionRefSchema } from "@/domain/learning";
import { auditEventIdSchema, instantSchema, recordIdSchema, revisionIdSchema, transactionIdSchema } from "@/domain/shared";
import { createStorageRowCodec } from "@/storage/storage-row-codec";
import { HACKATHON_STORAGE_PROFILE } from "@/storage/storage-profile-manifest";

/**
 * Packet 10A permanent-deletion audit and event rows for the patient-selected
 * target (storage-backup-spec 6.5–6.6; event-contracts-spec 8.4). They keep
 * only identity, the closed reason, the reviewed plan hash and opaque
 * dependency references: never a deleted value, note or rendered text.
 */

const targetTypeSchema = z.enum(HACKATHON_STORAGE_PROFILE.permanentDeletionTargets as [string, ...string[]]);

export const PERMANENT_DELETION_AUDIT_REASON = "PATIENT_PERMANENT_DELETION" as const;

export const permanentDeletionAuditRowSchema = z.strictObject({
  auditEventId: auditEventIdSchema,
  transactionId: transactionIdSchema,
  recordId: recordIdSchema,
  recordType: targetTypeSchema,
  previousRevisionId: revisionIdSchema,
  resultingRevisionId: z.null(),
  action: z.literal("DELETE"),
  initiator: z.literal("PATIENT"),
  assistance: z.literal("NONE"),
  occurredAt: instantSchema,
  reasonCode: z.literal(PERMANENT_DELETION_AUDIT_REASON),
});
export type PermanentDeletionAuditRow = z.infer<typeof permanentDeletionAuditRowSchema>;

export const permanentDeletionEventPayloadSchema = z.strictObject({
  deletedRecordType: targetTypeSchema,
  deletionReasonCode: z.literal("PATIENT_REQUESTED"),
  reviewedDeletionPlanHash: sha256DigestSchema,
  affectedDependencies: z.array(anyTypedRevisionRefSchema).max(10_000),
});

export const permanentDeletionEventRowSchema = z
  .strictObject({
    eventId: domainEventIdSchema,
    eventName: z.literal("PATIENT_RECORD_DELETED"),
    localSequence: z.number().int().positive().safe(),
    transactionIndex: z.number().int().nonnegative().safe(),
    transactionId: transactionIdSchema,
    commandId: commandIdSchema,
    correlationId: correlationIdSchema,
    committedAt: instantSchema,
    change: z.strictObject({
      kind: z.literal("RECORD_DELETED"),
      recordType: targetTypeSchema,
      recordId: recordIdSchema,
      previousRevisionId: revisionIdSchema,
      resultingRevisionId: z.null(),
    }),
    payload: permanentDeletionEventPayloadSchema,
  })
  .refine((row) => row.payload.deletedRecordType === row.change.recordType, "PAYLOAD_DISAGREES_WITH_CHANGE");
export type PermanentDeletionEventRow = z.infer<typeof permanentDeletionEventRowSchema>;

export const PERMANENT_DELETION_STORED_ROW_CODECS = Object.freeze({
  audit: createStorageRowCodec("auditEvents", permanentDeletionAuditRowSchema),
  event: createStorageRowCodec("domainEvents", permanentDeletionEventRowSchema),
});
