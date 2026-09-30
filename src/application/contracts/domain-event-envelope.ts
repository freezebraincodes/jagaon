import { z } from "zod";
import {
  recordTypeSchema,
  type RecordType,
  recordIdSchema,
  type RecordId,
  revisionIdSchema,
  type RevisionId,
  transactionIdSchema,
  type TransactionId,
  authoritativeOwnerSchema,
  type AuthoritativeOwner,
  changeInitiatorSchema,
  type ChangeInitiator,
  assistanceSchema,
  type Assistance,
} from "@/domain/shared";
import { type Instant, instantSchema } from "@/domain/shared/time";
import {
  revisionActionSchema,
  type RevisionAction,
} from "@/domain/shared/revision";
import {
  type DomainEventName,
} from "./command-event-names";
import {
  type DomainEventId,
  type EventSequence,
  type CommandId,
  type CorrelationId,
  domainEventIdSchema,
  eventSequenceSchema,
  commandIdSchema,
  correlationIdSchema,
} from "./command-event-identifiers";

// ---------------------------------------------------------------------------
// Numeric helpers
// ---------------------------------------------------------------------------

const positiveSafeInt = z.number().int().positive().safe();
const nonNegativeSafeInt = z.number().int().nonnegative().safe();

// ---------------------------------------------------------------------------
// EventRecordChange — strict discriminated union (Section 3.2)
// ---------------------------------------------------------------------------

export type EventRecordChange =
  | {
      kind: "REVISION_CREATED";
      recordType: RecordType;
      recordId: RecordId;
      action: RevisionAction;
      previousRevisionId: RevisionId | null;
      resultingRevisionId: RevisionId;
      resultingRevisionNumber: number;
    }
  | {
      kind: "RECORD_DELETED";
      recordType: RecordType;
      recordId: RecordId;
      previousRevisionId: RevisionId;
      resultingRevisionId: null;
    };

export const eventRecordChangeSchema = z.discriminatedUnion("kind", [
  // --- REVISION_CREATED ---
  z
    .object({
      kind: z.literal("REVISION_CREATED"),
      recordType: recordTypeSchema,
      recordId: recordIdSchema,
      action: revisionActionSchema,
      previousRevisionId: revisionIdSchema.nullable(),
      resultingRevisionId: revisionIdSchema,
      resultingRevisionNumber: positiveSafeInt,
    })
    .strict(),

  // --- RECORD_DELETED ---
  z
    .object({
      kind: z.literal("RECORD_DELETED"),
      recordType: recordTypeSchema,
      recordId: recordIdSchema,
      previousRevisionId: revisionIdSchema,
      resultingRevisionId: z.null(),
    })
    .strict(),
]);

// ---------------------------------------------------------------------------
// DomainEventEnvelope (Section 3.2)
// ---------------------------------------------------------------------------

export type DomainEventEnvelope<
  TName extends DomainEventName,
  TPayload,
> = {
  envelopeSchemaVersion: number;
  eventId: DomainEventId;
  eventName: TName;
  eventVersion: number;
  localSequence: EventSequence;
  transactionIndex: number;
  transactionId: TransactionId;
  commandId: CommandId;
  correlationId: CorrelationId;
  producedBy: AuthoritativeOwner;
  initiator: ChangeInitiator;
  assistance: Assistance;
  committedAt: Instant;
  change: EventRecordChange;
  payload: TPayload;
};

/**
 * Factory that builds a strict Zod schema for a typed domain-event envelope.
 *
 * @param nameSchema  A schema for one approved `DomainEventName` or an approved
 *                    subset. This constrains the accepted event names and
 *                    narrows the inferred `eventName` output type.
 * @param payloadSchema The authoritative event-specific payload schema.
 *                       It is never weakened to `unknown`, `any`, or a
 *                       passthrough object.
 *
 * The returned schema infers to `DomainEventEnvelope<TName, TPayload>` where
 * `TName` is the output type of `nameSchema` and `TPayload` is the output
 * type of `payloadSchema`.
 */
export function createDomainEventEnvelopeSchema<
  TName extends DomainEventName,
  TPayload,
>(
  nameSchema: z.ZodType<TName>,
  payloadSchema: z.ZodType<TPayload>,
): z.ZodType<DomainEventEnvelope<TName, TPayload>, z.ZodTypeDef, unknown> {
  // The `as` cast is required because Zod's `addQuestionMarks` utility
  // cannot determine whether a generic `ZodType<T>` field is required or
  // optional, so it conservatively adds `| undefined`. At runtime the
  // schema is a strict object that parses all fields as required; the
  // cast restores the precise `DomainEventEnvelope<TName, TPayload>` output
  // type.
  return z
    .object({
      envelopeSchemaVersion: positiveSafeInt,
      eventId: domainEventIdSchema,
      eventName: nameSchema,
      eventVersion: positiveSafeInt,
      localSequence: eventSequenceSchema,
      transactionIndex: nonNegativeSafeInt,
      transactionId: transactionIdSchema,
      commandId: commandIdSchema,
      correlationId: correlationIdSchema,
      producedBy: authoritativeOwnerSchema,
      initiator: changeInitiatorSchema,
      assistance: assistanceSchema,
      committedAt: instantSchema,
      change: eventRecordChangeSchema,
      payload: payloadSchema,
    })
    .strict() as z.ZodType<
      DomainEventEnvelope<TName, TPayload>,
      z.ZodTypeDef,
      unknown
    >;
}
