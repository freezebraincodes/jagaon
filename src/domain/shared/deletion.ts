import { z } from "zod";
import type { RecordId, AuditEventId, TransactionId } from "./identifiers";
import { recordIdSchema, auditEventIdSchema, transactionIdSchema } from "./identifiers";
import type { Instant } from "./time";
import { instantSchema } from "./time";
import type { RecordType } from "./record-catalogue";
import { recordTypeSchema } from "./record-catalogue";
import type { ChangeInitiator } from "./provenance";
import { changeInitiatorSchema } from "./provenance";

// --- Section 1.10: DeletionTombstone ---
// Minimal tombstone retained after a confirmed permanent deletion of a
// PATIENT_DELETABLE health record. Contains only record identity, type,
// deletion time, initiator, and audit/transaction references. Must never
// carry the deleted health payload, free text, clinical values, or a
// reversible copy.

export type DeletionTombstone = {
  recordId: RecordId;
  recordType: RecordType;
  deletedAt: Instant;
  initiator: ChangeInitiator;
  auditEventId: AuditEventId;
  transactionId: TransactionId;
};

export const deletionTombstoneSchema = z.strictObject({
  recordId: recordIdSchema,
  recordType: recordTypeSchema,
  deletedAt: instantSchema,
  initiator: changeInitiatorSchema,
  auditEventId: auditEventIdSchema,
  transactionId: transactionIdSchema,
});