import { z } from "zod";

// Brand helpers
type Brand<T, B extends string> = T & { readonly __brand: B };

export type RecordId = Brand<string, "RecordId">;
export type RevisionId = Brand<string, "RevisionId">;
export type AuditEventId = Brand<string, "AuditEventId">;
export type TransactionId = Brand<string, "TransactionId">;

// UUID v4 validation regex
// Format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx where y is 8, 9, a, or b
const uuidV4Regex =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function brandedIdSchema<T extends string>(brand: T) {
  return z
    .string()
    .regex(uuidV4Regex)
    .transform((val) => val as Brand<string, T>);
}

export const recordIdSchema = brandedIdSchema("RecordId");
export const revisionIdSchema = brandedIdSchema("RevisionId");
export const auditEventIdSchema = brandedIdSchema("AuditEventId");
export const transactionIdSchema = brandedIdSchema("TransactionId");

function createBrandedId<T extends string>(
  brand: T,
): Brand<string, T> {
  return crypto.randomUUID() as Brand<string, T>;
}

export function createRecordId(): RecordId {
  return createBrandedId("RecordId");
}

export function createRevisionId(): RevisionId {
  return createBrandedId("RevisionId");
}

export function createAuditEventId(): AuditEventId {
  return createBrandedId("AuditEventId");
}

export function createTransactionId(): TransactionId {
  return createBrandedId("TransactionId");
}