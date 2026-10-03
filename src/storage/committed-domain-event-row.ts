import { z } from "zod";
import {
  commandIdSchema,
  correlationIdSchema,
  domainEventIdSchema,
} from "@/application/contracts/command-event-identifiers";
import { domainEventNameSchema } from "@/application/contracts/command-event-names";
import { eventRecordChangeSchema } from "@/application/contracts/domain-event-envelope";
import { instantSchema, transactionIdSchema } from "@/domain/shared";
import { StorageRowValidationError, type StorageRowCodec } from "./storage-row-codec";

/**
 * Read-side codec for the shared `domainEvents` table.
 *
 * Several authoritative owners append to one event log, and the transaction
 * store reads the latest committed event to allocate the next local sequence.
 * That read must accept any owner's committed envelope with a closed event
 * name and change, while every write still goes through the committing
 * owner's exact payload codec. The codec therefore refuses writes.
 */

export type CommittedDomainEventRow = z.infer<typeof committedDomainEventRowSchema>;

const committedDomainEventRowSchema = z
  .object({
    eventId: domainEventIdSchema,
    eventName: domainEventNameSchema,
    localSequence: z.number().int().positive().safe(),
    transactionIndex: z.number().int().nonnegative().safe(),
    transactionId: transactionIdSchema,
    commandId: commandIdSchema,
    correlationId: correlationIdSchema,
    committedAt: instantSchema,
    change: eventRecordChangeSchema,
    payload: z.unknown(),
  })
  .strict();

export const committedDomainEventRowCodec: StorageRowCodec<CommittedDomainEventRow> = Object.freeze({
  validateForWrite(): CommittedDomainEventRow {
    throw new StorageRowValidationError("STORAGE_VALIDATION_FAILED", "domainEvents", "WRITE");
  },
  validateAfterRead(value: unknown): CommittedDomainEventRow {
    const result = committedDomainEventRowSchema.safeParse(value);
    if (!result.success) throw new StorageRowValidationError("STORAGE_INTEGRITY_FAILED", "domainEvents", "READ");
    return result.data;
  },
});
