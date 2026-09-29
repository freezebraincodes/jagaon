import { z } from "zod";
import type { AuditEventId, TransactionId, RecordId } from "./identifiers";
import type { RecordType } from "./record-catalogue";
import type { RevisionId } from "./identifiers";
import type { ChangeInitiator, Assistance } from "./provenance";
import type { Instant } from "./time";

// Section 1.9: Audit action includes DELETE beyond RevisionAction
export const auditActionSchema = z.enum([
  "CREATE",
  "UPDATE",
  "CORRECT",
  "SUPERSEDE",
  "CONFIRM",
  "REJECT",
  "EXPIRE",
  "SYSTEM_DERIVE",
  "DELETE",
]);

export type AuditAction = z.infer<typeof auditActionSchema>;

// Section 1.9: DomainMutationAudit
// Generic over TReasonCode (constrained to string) and TNoteRef (defaults to
// never, meaning no note reference is available unless an entity contract
// supplies one).
export type DomainMutationAudit<
  TReasonCode extends string,
  TNoteRef = never,
> = {
  auditEventId: AuditEventId;
  transactionId: TransactionId;
  recordId: RecordId;
  recordType: RecordType;
  previousRevisionId: RevisionId | null;
  resultingRevisionId: RevisionId | null;
  action: AuditAction;
  initiator: ChangeInitiator;
  assistance: Assistance;
  occurredAt: Instant;
  reasonCode: TReasonCode;
  noteRef?: TNoteRef;
};