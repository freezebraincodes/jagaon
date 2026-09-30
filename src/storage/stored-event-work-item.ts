import { z } from "zod";
import {
  type EventWorkItem,
  eventWorkItemSchema,
  type WorkPriority,
  WORK_PRIORITIES,
} from "@/application/contracts/event-work";
import {
  type EventSequence,
  eventSequenceSchema,
  domainEventIdSchema,
  commandIdSchema,
} from "@/application/contracts/command-event-identifiers";
import { type Instant, instantSchema } from "@/domain/shared/time";

// ---------------------------------------------------------------------------
// WORK_PRIORITY_RANKS — immutable exhaustive mapping (Section 2.5)
// ---------------------------------------------------------------------------

/**
 * Fixed priority ranks for queue ordering.
 *
 * Spec: storage-backup-spec.md Section 2.5.
 *
 * | Priority                           | Rank |
 * |------------------------------------|-----:|
 * | SAFETY_RECOVERY                    |    0 |
 * | DEPENDENCY_INVALIDATION            |    1 |
 * | PATIENT_VISIBLE_CURRENT_STATE      |    2 |
 * | ORDINARY_INTELLIGENCE              |    3 |
 * | MAINTENANCE                        |    4 |
 */
export const WORK_PRIORITY_RANKS: Readonly<
  Record<WorkPriority, WorkPriorityRank>
> = Object.freeze({
  SAFETY_RECOVERY: 0,
  DEPENDENCY_INVALIDATION: 1,
  PATIENT_VISIBLE_CURRENT_STATE: 2,
  ORDINARY_INTELLIGENCE: 3,
  MAINTENANCE: 4,
});

export type WorkPriorityRank = 0 | 1 | 2 | 3 | 4;

// ---------------------------------------------------------------------------
// StoredEventWorkItem type (Section 2.5)
// ---------------------------------------------------------------------------

/**
 * Stored durable work row.
 *
 * Embeds the exact `EventWorkItem` fields plus only the scheduling derivatives
 * locked by Section 2.5: `stateCode`, `priorityRank`, `sourceEventSequence`,
 * and the optional `availableAt` / `leaseExpiresAt` fields authorised only for
 * specific states.
 */
export type StoredEventWorkItem = EventWorkItem & {
  stateCode: EventWorkItem["state"]["state"];
  priorityRank: WorkPriorityRank;
  sourceEventSequence: EventSequence;
  availableAt?: Instant;
  leaseExpiresAt?: Instant;
};

// ---------------------------------------------------------------------------
// StoredEventWorkItem schema
// ---------------------------------------------------------------------------

/**
 * Strict read schema for a stored durable work row.
 *
 * Reuses `eventWorkItemSchema` for all base invariants (including duplicate
 * effect-key/command-ID rejection and strict state discrimination) and then
 * validates every scheduling derivative against the base item.
 *
 * The schema is a fresh strict object that mirrors the complete stored shape
 * (base `EventWorkItem` fields plus scheduling derivatives). A `superRefine`
 * step first validates the base portion through `eventWorkItemSchema` so that
 * every base invariant — including unknown-key rejection within nested
 * objects — is enforced identically. It then checks every scheduling
 * derivative against the base item's state.
 *
 * Rejects:
 * - `stateCode` that differs from `state.state`;
 * - `priorityRank` that differs from `WORK_PRIORITY_RANKS[priority]`;
 * - `availableAt` present for any state other than `PENDING` or `RETRY_WAIT`;
 * - `availableAt` absent for `PENDING` or `RETRY_WAIT`;
 * - `availableAt` not equal to `createdAt` for `PENDING`;
 * - `availableAt` not equal to `state.availableAt` for `RETRY_WAIT`;
 * - `leaseExpiresAt` present for any state other than `CLAIMED`;
 * - `leaseExpiresAt` absent for `CLAIMED`;
 * - `leaseExpiresAt` not equal to `state.leaseExpiresAt` for `CLAIMED`;
 * - unknown top-level or nested fields (via strict schema);
 * - invalid `sourceEventSequence` (zero, negative, fractional, unsafe);
 * - any malformed base `EventWorkItem` field.
 */

// Reuse the exact base field validators by referencing the same schemas.
// We rebuild the object here because `eventWorkItemSchema` is a `ZodEffects`
// (it ends with `.superRefine`) and cannot be `.extend()`-ed. Instead, we
// define the stored shape and then pipe the base fields through
// `eventWorkItemSchema` inside `superRefine` to guarantee identical base
// invariant enforcement.

import {
  workItemIdSchema,
  consumerKeySchema,
  workPrioritySchema,
  workErrorCodeSchema,
  workObsoleteReasonCodeSchema,
} from "@/application/contracts/event-work";

const nonEmptyString = z.string().min(1);
const nonNegativeSafeInt = z.number().int().nonnegative().safe();

const plannedCommandStoredSchema = z
  .object({
    effectKey: nonEmptyString,
    commandId: commandIdSchema,
  })
  .strict();

const eventWorkStateStoredSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("PENDING") }).strict(),
  z
    .object({
      state: z.literal("CLAIMED"),
      leaseToken: nonEmptyString,
      claimedByInstance: nonEmptyString,
      leaseExpiresAt: instantSchema,
    })
    .strict(),
  z
    .object({
      state: z.literal("RETRY_WAIT"),
      availableAt: instantSchema,
      errorCode: workErrorCodeSchema,
    })
    .strict(),
  z
    .object({
      state: z.literal("COMPLETED"),
      completedAt: instantSchema,
    })
    .strict(),
  z
    .object({
      state: z.literal("TERMINAL_FAILURE"),
      failedAt: instantSchema,
      errorCode: workErrorCodeSchema,
    })
    .strict(),
  z
    .object({
      state: z.literal("CANCELLED_OBSOLETE"),
      cancelledAt: instantSchema,
      reasonCode: workObsoleteReasonCodeSchema,
    })
    .strict(),
]);

const stateCodeSchema = z.enum([
  "PENDING",
  "CLAIMED",
  "RETRY_WAIT",
  "COMPLETED",
  "TERMINAL_FAILURE",
  "CANCELLED_OBSOLETE",
]);

const priorityRankSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
]);

export const storedEventWorkItemSchema = z
  .object({
    workItemId: workItemIdSchema,
    eventId: domainEventIdSchema,
    consumer: consumerKeySchema,
    handlerVersion: nonEmptyString,
    priority: workPrioritySchema,
    createdAt: instantSchema,
    attemptCount: nonNegativeSafeInt,
    state: eventWorkStateStoredSchema,
    plannedCommands: z.array(plannedCommandStoredSchema),
    stateCode: stateCodeSchema,
    priorityRank: priorityRankSchema,
    sourceEventSequence: eventSequenceSchema,
    availableAt: instantSchema.optional(),
    leaseExpiresAt: instantSchema.optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    // --- Reuse eventWorkItemSchema for all base invariants ---
    // Extract the base fields and validate them through the original schema.
    // This guarantees duplicate effect-key/command-ID rejection and every
    // other base invariant are enforced identically.
    const baseResult = eventWorkItemSchema.safeParse({
      workItemId: val.workItemId,
      eventId: val.eventId,
      consumer: val.consumer,
      handlerVersion: val.handlerVersion,
      priority: val.priority,
      createdAt: val.createdAt,
      attemptCount: val.attemptCount,
      state: val.state,
      plannedCommands: val.plannedCommands,
    });
    if (!baseResult.success) {
      for (const issue of baseResult.error.issues) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: issue.message,
          path: issue.path,
        });
      }
      return;
    }

    // --- stateCode must equal state.state ---
    if (val.stateCode !== val.state.state) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "STATE_CODE_MISMATCH",
        path: ["stateCode"],
      });
    }

    // --- priorityRank must equal the fixed rank for the item's priority ---
    const expectedRank = WORK_PRIORITY_RANKS[val.priority as WorkPriority];
    if (val.priorityRank !== expectedRank) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "PRIORITY_RANK_MISMATCH",
        path: ["priorityRank"],
      });
    }

    // --- availableAt rules (Section 2.5) ---
    // availableAt equals createdAt for PENDING and the governed retry instant
    // for RETRY_WAIT; absent for all other states.
    if (val.state.state === "PENDING") {
      if (val.availableAt === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "AVAILABLE_AT_REQUIRED_FOR_PENDING",
          path: ["availableAt"],
        });
      } else if (val.availableAt !== val.createdAt) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "AVAILABLE_AT_MUST_EQUAL_CREATED_AT_FOR_PENDING",
          path: ["availableAt"],
        });
      }
    } else if (val.state.state === "RETRY_WAIT") {
      if (val.availableAt === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "AVAILABLE_AT_REQUIRED_FOR_RETRY_WAIT",
          path: ["availableAt"],
        });
      } else if (val.availableAt !== val.state.availableAt) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "AVAILABLE_AT_MUST_EQUAL_STATE_AVAILABLE_AT_FOR_RETRY_WAIT",
          path: ["availableAt"],
        });
      }
    } else {
      // availableAt must be absent for all other states
      if (val.availableAt !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "AVAILABLE_AT_MUST_BE_ABSENT_FOR_THIS_STATE",
          path: ["availableAt"],
        });
      }
    }

    // --- leaseExpiresAt rules (Section 2.5) ---
    // leaseExpiresAt exists only for CLAIMED.
    if (val.state.state === "CLAIMED") {
      if (val.leaseExpiresAt === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "LEASE_EXPIRES_AT_REQUIRED_FOR_CLAIMED",
          path: ["leaseExpiresAt"],
        });
      } else if (val.leaseExpiresAt !== val.state.leaseExpiresAt) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "LEASE_EXPIRES_AT_MISMATCH",
          path: ["leaseExpiresAt"],
        });
      }
    } else {
      // leaseExpiresAt must be absent for all other states
      if (val.leaseExpiresAt !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "LEASE_EXPIRES_AT_MUST_BE_ABSENT_FOR_THIS_STATE",
          path: ["leaseExpiresAt"],
        });
      }
    }
  });

// ---------------------------------------------------------------------------
// createStoredEventWorkItem — pure factory
// ---------------------------------------------------------------------------

/**
 * Derive a `StoredEventWorkItem` from a base `EventWorkItem` and its source
 * event sequence.
 *
 * The scheduling derivatives are computed purely from the base item's state:
 * - `stateCode` is `state.state`;
 * - `priorityRank` is the fixed rank for `priority`;
 * - `availableAt` is `createdAt` for `PENDING`, `state.availableAt` for
 *   `RETRY_WAIT`, and absent otherwise;
 * - `leaseExpiresAt` is `state.leaseExpiresAt` for `CLAIMED` and absent
 *   otherwise.
 *
 * No coercion, defaulting, or invention occurs. The returned object is
 * guaranteed to round-trip through `storedEventWorkItemSchema`.
 */
export function createStoredEventWorkItem(
  item: EventWorkItem,
  sourceEventSequence: EventSequence,
): StoredEventWorkItem {
  const stateCode = item.state.state;
  const priorityRank = WORK_PRIORITY_RANKS[item.priority as WorkPriority];

  const stored: StoredEventWorkItem = {
    ...item,
    stateCode,
    priorityRank,
    sourceEventSequence,
  };

  // Derive availableAt per Section 2.5 rules.
  if (item.state.state === "PENDING") {
    stored.availableAt = item.createdAt;
  } else if (item.state.state === "RETRY_WAIT") {
    stored.availableAt = item.state.availableAt;
  }

  // Derive leaseExpiresAt per Section 2.5 rules.
  if (item.state.state === "CLAIMED") {
    stored.leaseExpiresAt = item.state.leaseExpiresAt;
  }

  return stored;
}

// Compile-time proof: WORK_PRIORITY_RANKS covers every WorkPriority.
// This forces a type error if a new priority is added without a rank.
const _exhaustiveCheck: Record<WorkPriority, WorkPriorityRank> =
  WORK_PRIORITY_RANKS;
void _exhaustiveCheck;
void WORK_PRIORITIES;
