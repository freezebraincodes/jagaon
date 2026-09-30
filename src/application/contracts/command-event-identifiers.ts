import { z } from "zod";
import { type Instant, instantSchema } from "@/domain/shared/time";

// ---------------------------------------------------------------------------
// Branded identity types (Section 2.1 / Section 3.1)
// ---------------------------------------------------------------------------

type Brand<T, B extends string> = T & { readonly __brand: B };

export type CommandId = Brand<string, "CommandId">;
export type CorrelationId = Brand<string, "CorrelationId">;
export type DomainEventId = Brand<string, "DomainEventId">;

// UUID v4 validation regex — identical to the shared-domain pattern.
const uuidV4Regex =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function brandedUuidSchema<T extends string>(brand: T) {
  return z
    .string()
    .regex(uuidV4Regex)
    .transform((val) => val as Brand<string, T>);
}

// Runtime schemas. Each validates the shared UUID-v4 representation and
// returns the appropriate brand. Runtime validation cannot distinguish two
// otherwise identical branded UUID strings; the brands are distinct at
// compile time only.
export const commandIdSchema = brandedUuidSchema("CommandId");
export const correlationIdSchema = brandedUuidSchema("CorrelationId");
export const domainEventIdSchema = brandedUuidSchema("DomainEventId");

// Patient-local creator functions.
export function createCommandId(): CommandId {
  return crypto.randomUUID() as CommandId;
}

export function createCorrelationId(): CorrelationId {
  return crypto.randomUUID() as CorrelationId;
}

export function createDomainEventId(): DomainEventId {
  return crypto.randomUUID() as DomainEventId;
}

// ---------------------------------------------------------------------------
// EventSequence — branded positive safe integer (Section 3.1)
// ---------------------------------------------------------------------------

export type EventSequence = Brand<number, "EventSequence">;

export const eventSequenceSchema = z
  .number()
  .int()
  .positive()
  .safe()
  .transform((val) => val as EventSequence);

// ---------------------------------------------------------------------------
// CommandOrigin — closed catalogue (Section 2.1)
// ---------------------------------------------------------------------------

export const COMMAND_ORIGINS = [
  "PATIENT_UI",
  "INQUIRY_PROCESSING",
  "SAFETY_ROUTER",
  "LEARNING_ENGINE",
  "PATTERN_ENGINE",
  "CARE_PREPARATION",
  "SYSTEM_TIMER",
  "IMPORT_OR_RESTORE",
] as const;

export type CommandOrigin = (typeof COMMAND_ORIGINS)[number];

export const commandOriginSchema = z.enum(COMMAND_ORIGINS);

// ---------------------------------------------------------------------------
// CommandCause — strict discriminated union (Section 2.1)
// ---------------------------------------------------------------------------

export type CommandCause =
  | { kind: "DIRECT_PATIENT_ACTION" }
  | { kind: "DOMAIN_EVENT"; eventId: DomainEventId }
  | { kind: "SCHEDULED_RULE"; ruleKey: string; dueAt: Instant }
  | { kind: "RECOVERY"; previousCommandId: CommandId }
  | { kind: "IMPORT_OR_RESTORE"; batchId: string };

export const commandCauseSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("DIRECT_PATIENT_ACTION"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("DOMAIN_EVENT"),
      eventId: domainEventIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("SCHEDULED_RULE"),
      ruleKey: z.string(),
      dueAt: instantSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("RECOVERY"),
      previousCommandId: commandIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("IMPORT_OR_RESTORE"),
      batchId: z.string(),
    })
    .strict(),
]);
