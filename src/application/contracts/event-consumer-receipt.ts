import { z } from "zod";
import { type Instant, instantSchema } from "@/domain/shared/time";
import {
  type DomainEventId,
  domainEventIdSchema,
  type CommandId,
  commandIdSchema,
} from "./command-event-identifiers";
import {
  type ConsumerKey,
  consumerKeySchema,
  type WorkObsoleteReasonCode,
  workObsoleteReasonCodeSchema,
} from "./event-work";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const nonEmptyString = z.string().min(1);

// ---------------------------------------------------------------------------
// EventConsumerReceipt — strict object (Section 4.2)
// ---------------------------------------------------------------------------

export type EventConsumerReceipt = {
  eventId: DomainEventId;
  consumer: ConsumerKey;
  handlerVersion: string;
  completedAt: Instant;
  outcome:
    | { kind: "NO_ACTION_REQUIRED" }
    | {
        kind: "COMMANDS_COMMITTED";
        commandIds: [CommandId, ...CommandId[]];
      }
    | {
        kind: "SOURCE_NO_LONGER_ELIGIBLE";
        reasonCode: WorkObsoleteReasonCode;
      };
};

export const eventConsumerReceiptSchema = z
  .object({
    eventId: domainEventIdSchema,
    consumer: consumerKeySchema,
    handlerVersion: nonEmptyString,
    completedAt: instantSchema,
    outcome: z.discriminatedUnion("kind", [
      // --- NO_ACTION_REQUIRED ---
      z
        .object({
          kind: z.literal("NO_ACTION_REQUIRED"),
        })
        .strict(),

      // --- COMMANDS_COMMITTED ---
      z
        .object({
          kind: z.literal("COMMANDS_COMMITTED"),
          commandIds: z
            .tuple([commandIdSchema])
            .rest(commandIdSchema)
            .superRefine((ids, ctx) => {
              const seen = new Set<string>();
              for (let i = 0; i < ids.length; i++) {
                const id = ids[i] as string;
                if (seen.has(id)) {
                  ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: "DUPLICATE_COMMAND_ID",
                    path: [i],
                  });
                  return;
                }
                seen.add(id);
              }
            }),
        })
        .strict(),

      // --- SOURCE_NO_LONGER_ELIGIBLE ---
      z
        .object({
          kind: z.literal("SOURCE_NO_LONGER_ELIGIBLE"),
          reasonCode: workObsoleteReasonCodeSchema,
        })
        .strict(),
    ]),
  })
  .strict();
