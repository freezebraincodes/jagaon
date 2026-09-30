import { z } from "zod";
import {
  recordTypeSchema,
  type RecordType,
  recordIdSchema,
  type RecordId,
  revisionIdSchema,
  type RevisionId,
  changeInitiatorSchema,
  type ChangeInitiator,
  assistanceSchema,
  type Assistance,
} from "@/domain/shared";
import {
  type CommandName,
} from "./command-event-names";
import {
  type CommandId,
  commandIdSchema,
  type CorrelationId,
  correlationIdSchema,
  type CommandOrigin,
  commandOriginSchema,
  type CommandCause,
  commandCauseSchema,
} from "./command-event-identifiers";
import {
  type Instant,
  instantSchema,
} from "@/domain/shared/time";

// ---------------------------------------------------------------------------
// Positive safe-integer helper (matches the eventSequenceSchema pattern)
// ---------------------------------------------------------------------------

const positiveSafeInt = z.number().int().positive().safe();

// ---------------------------------------------------------------------------
// RecordHeadExpectation (Section 2.2)
// ---------------------------------------------------------------------------

export type RecordHeadExpectation =
  | {
      kind: "MUST_NOT_EXIST";
      recordType: RecordType;
      proposedRecordId: RecordId;
    }
  | {
      kind: "MUST_MATCH";
      recordType: RecordType;
      recordId: RecordId;
      expectedRevisionId: RevisionId;
      expectedRevisionNumber: number;
    };

export const recordHeadExpectationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("MUST_NOT_EXIST"),
      recordType: recordTypeSchema,
      proposedRecordId: recordIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("MUST_MATCH"),
      recordType: recordTypeSchema,
      recordId: recordIdSchema,
      expectedRevisionId: revisionIdSchema,
      expectedRevisionNumber: positiveSafeInt,
    })
    .strict(),
]);

// ---------------------------------------------------------------------------
// CommandEnvelope (Section 2.3)
// ---------------------------------------------------------------------------

export type CommandEnvelope<
  TName extends CommandName,
  TPayload,
> = {
  schemaVersion: number;
  commandId: CommandId;
  commandName: TName;
  issuedAt: Instant;
  initiator: ChangeInitiator;
  assistance: Assistance;
  origin: CommandOrigin;
  correlationId: CorrelationId;
  cause: CommandCause;
  headExpectations: RecordHeadExpectation[];
  payload: TPayload;
};

/**
 * Factory that builds a strict Zod schema for a typed command envelope.
 *
 * @param nameSchema  A schema for one approved `CommandName` or an approved
 *                    subset. This constrains the accepted command names and
 *                    narrows the inferred `commandName` output type.
 * @param payloadSchema The authoritative command-specific payload schema.
 *                      It is never weakened to `unknown`, `any`, or a
 *                      passthrough object.
 *
 * The returned schema infers to `CommandEnvelope<TName, TPayload>` where
 * `TName` is the output type of `nameSchema` and `TPayload` is the output
 * type of `payloadSchema`.
 */
export function createCommandEnvelopeSchema<
  TName extends CommandName,
  TPayload,
>(
  nameSchema: z.ZodType<TName>,
  payloadSchema: z.ZodType<TPayload>,
): z.ZodType<CommandEnvelope<TName, TPayload>, z.ZodTypeDef, unknown> {
  // The `as` cast is required because Zod's `addQuestionMarks` utility
  // cannot determine whether a generic `ZodType<T>` field is required or
  // optional, so it conservatively adds `| undefined`. At runtime the
  // schema is a strict object that parses all fields as required; the
  // cast restores the precise `CommandEnvelope<TName, TPayload>` output
  // type.
  return z
    .object({
      schemaVersion: positiveSafeInt,
      commandId: commandIdSchema,
      commandName: nameSchema,
      issuedAt: instantSchema,
      initiator: changeInitiatorSchema,
      assistance: assistanceSchema,
      origin: commandOriginSchema,
      correlationId: correlationIdSchema,
      cause: commandCauseSchema,
      headExpectations: z.array(recordHeadExpectationSchema),
      payload: payloadSchema,
    })
    .strict() as z.ZodType<
      CommandEnvelope<TName, TPayload>,
      z.ZodTypeDef,
      unknown
    >;
}
