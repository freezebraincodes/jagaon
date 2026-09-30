import { z } from "zod";
import { type Instant, instantSchema } from "@/domain/shared/time";
import {
  type DomainEventId,
  type CommandId,
  domainEventIdSchema,
  commandIdSchema,
} from "./command-event-identifiers";

// ---------------------------------------------------------------------------
// Brand helper
// ---------------------------------------------------------------------------

type Brand<T, B extends string> = T & { readonly __brand: B };

// ---------------------------------------------------------------------------
// WorkItemId — branded UUID-v4 (Section 4.1)
// ---------------------------------------------------------------------------

export type WorkItemId = Brand<string, "WorkItemId">;

const uuidV4Regex =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const workItemIdSchema = z
  .string()
  .regex(uuidV4Regex)
  .transform((val) => val as WorkItemId);

export function createWorkItemId(): WorkItemId {
  return crypto.randomUUID() as WorkItemId;
}

// ---------------------------------------------------------------------------
// ConsumerKey — closed catalogue (Section 4.1)
// ---------------------------------------------------------------------------

export const CONSUMER_KEYS = [
  "SAFETY_PRESENTATION_RECOVERY",
  "DEPENDENCY_INVALIDATION",
  "REMINDER_RECONCILIATION",
  "LEARNING_REEVALUATION",
  "PATTERN_REEVALUATION",
  "INQUIRY_ELIGIBILITY",
  "CARE_SUMMARY_INVALIDATION",
  "CURRENT_STATE_PROJECTION",
  "MAINTENANCE",
] as const;

export type ConsumerKey = (typeof CONSUMER_KEYS)[number];

export const consumerKeySchema = z.enum(CONSUMER_KEYS);

// ---------------------------------------------------------------------------
// WorkPriority — closed catalogue (Section 4.1)
// ---------------------------------------------------------------------------

export const WORK_PRIORITIES = [
  "SAFETY_RECOVERY",
  "DEPENDENCY_INVALIDATION",
  "PATIENT_VISIBLE_CURRENT_STATE",
  "ORDINARY_INTELLIGENCE",
  "MAINTENANCE",
] as const;

export type WorkPriority = (typeof WORK_PRIORITIES)[number];

export const workPrioritySchema = z.enum(WORK_PRIORITIES);

// ---------------------------------------------------------------------------
// WorkErrorCode — closed catalogue (Section 13.2)
// ---------------------------------------------------------------------------

export const WORK_ERROR_CODES = [
  "SOURCE_NO_LONGER_CURRENT",
  "SOURCE_REVISION_UNAVAILABLE",
  "UNSUPPORTED_EVENT_VERSION",
  "HANDLER_CONFIGURATION_INVALID",
  "TRANSIENT_STORAGE_ERROR",
  "RUNTIME_INTERRUPTED",
  "EFFECT_COMMAND_REJECTED",
  "CYCLE_GUARD_TRIGGERED",
  "INTEGRITY_CHECK_FAILED",
] as const;

export type WorkErrorCode = (typeof WORK_ERROR_CODES)[number];

export const workErrorCodeSchema = z.enum(WORK_ERROR_CODES);

// ---------------------------------------------------------------------------
// WorkObsoleteReasonCode — closed catalogue (Section 4.1)
// ---------------------------------------------------------------------------

export const WORK_OBSOLETE_REASON_CODES = [
  "SOURCE_DELETED",
  "SOURCE_SUPERSEDED",
  "SOURCE_NO_LONGER_ELIGIBLE",
] as const;

export type WorkObsoleteReasonCode =
  (typeof WORK_OBSOLETE_REASON_CODES)[number];

export const workObsoleteReasonCodeSchema = z.enum(WORK_OBSOLETE_REASON_CODES);

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const nonEmptyString = z.string().min(1);
const nonNegativeSafeInt = z.number().int().nonnegative().safe();

// ---------------------------------------------------------------------------
// EventWorkState — strict discriminated union (Section 4.1)
// ---------------------------------------------------------------------------

export type EventWorkState =
  | { state: "PENDING" }
  | {
      state: "CLAIMED";
      leaseToken: string;
      claimedByInstance: string;
      leaseExpiresAt: Instant;
    }
  | {
      state: "RETRY_WAIT";
      availableAt: Instant;
      errorCode: WorkErrorCode;
    }
  | { state: "COMPLETED"; completedAt: Instant }
  | {
      state: "TERMINAL_FAILURE";
      failedAt: Instant;
      errorCode: WorkErrorCode;
    }
  | {
      state: "CANCELLED_OBSOLETE";
      cancelledAt: Instant;
      reasonCode: WorkObsoleteReasonCode;
    };

export const eventWorkStateSchema = z.discriminatedUnion("state", [
  // --- PENDING ---
  z
    .object({
      state: z.literal("PENDING"),
    })
    .strict(),

  // --- CLAIMED ---
  z
    .object({
      state: z.literal("CLAIMED"),
      leaseToken: nonEmptyString,
      claimedByInstance: nonEmptyString,
      leaseExpiresAt: instantSchema,
    })
    .strict(),

  // --- RETRY_WAIT ---
  z
    .object({
      state: z.literal("RETRY_WAIT"),
      availableAt: instantSchema,
      errorCode: workErrorCodeSchema,
    })
    .strict(),

  // --- COMPLETED ---
  z
    .object({
      state: z.literal("COMPLETED"),
      completedAt: instantSchema,
    })
    .strict(),

  // --- TERMINAL_FAILURE ---
  z
    .object({
      state: z.literal("TERMINAL_FAILURE"),
      failedAt: instantSchema,
      errorCode: workErrorCodeSchema,
    })
    .strict(),

  // --- CANCELLED_OBSOLETE ---
  z
    .object({
      state: z.literal("CANCELLED_OBSOLETE"),
      cancelledAt: instantSchema,
      reasonCode: workObsoleteReasonCodeSchema,
    })
    .strict(),
]);

// ---------------------------------------------------------------------------
// PlannedCommand — strict entry (Section 4.1)
// ---------------------------------------------------------------------------

const plannedCommandSchema = z
  .object({
    effectKey: nonEmptyString,
    commandId: commandIdSchema,
  })
  .strict();

// ---------------------------------------------------------------------------
// EventWorkItem — strict object (Section 4.1)
// ---------------------------------------------------------------------------

export type EventWorkItem = {
  workItemId: WorkItemId;
  eventId: DomainEventId;
  consumer: ConsumerKey;
  handlerVersion: string;
  priority: WorkPriority;
  createdAt: Instant;
  attemptCount: number;
  state: EventWorkState;
  plannedCommands: {
    effectKey: string;
    commandId: CommandId;
  }[];
};

export const eventWorkItemSchema = z
  .object({
    workItemId: workItemIdSchema,
    eventId: domainEventIdSchema,
    consumer: consumerKeySchema,
    handlerVersion: nonEmptyString,
    priority: workPrioritySchema,
    createdAt: instantSchema,
    attemptCount: nonNegativeSafeInt,
    state: eventWorkStateSchema,
    plannedCommands: z.array(plannedCommandSchema),
  })
  .strict()
  .superRefine((val, ctx) => {
    // Duplicate effectKey check
    const effectKeys = val.plannedCommands.map((c) => c.effectKey);
    const seenEffect = new Set<string>();
    for (let i = 0; i < effectKeys.length; i++) {
      if (seenEffect.has(effectKeys[i])) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "DUPLICATE_EFFECT_KEY",
          path: ["plannedCommands", i, "effectKey"],
        });
        return;
      }
      seenEffect.add(effectKeys[i]);
    }

    // Duplicate commandId check
    const commandIds = val.plannedCommands.map((c) => c.commandId);
    const seenCommand = new Set<string>();
    for (let i = 0; i < commandIds.length; i++) {
      const id = commandIds[i] as string;
      if (seenCommand.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "DUPLICATE_COMMAND_ID",
          path: ["plannedCommands", i, "commandId"],
        });
        return;
      }
      seenCommand.add(id);
    }
  });
