import Dexie, { type Table } from "dexie";
import { z } from "zod";
import {
  type EventConsumerReceipt,
  eventConsumerReceiptSchema,
} from "@/application/contracts/event-consumer-receipt";
import {
  type EventWorkState,
  type WorkItemId,
  type WorkErrorCode,
  type WorkObsoleteReasonCode,
  workItemIdSchema,
  workErrorCodeSchema,
  workObsoleteReasonCodeSchema,
} from "@/application/contracts/event-work";
import { commandIdSchema, type CommandId } from "@/application/contracts/command-event-identifiers";
import {
  compareInstants,
  instantAfter,
  instantSchema,
  type Instant,
} from "@/domain/shared/time";
import type { JagaOnDatabase } from "./database";
import { implementedStorageRowCodecs } from "./implemented-row-codecs";
import {
  createStoredEventWorkItem,
  type StoredEventWorkItem,
  type WorkPriorityRank,
} from "./stored-event-work-item";
import { StorageRowValidationError } from "./storage-row-codec";

export type WorkLeaseErrorCode =
  | "INVALID_LEASE_REQUEST"
  | "WORK_ITEM_NOT_FOUND"
  | "LEASE_NOT_OWNED"
  | "LEASE_EXPIRED"
  | "RECEIPT_MISMATCH"
  | "STORAGE_OPERATION_FAILED";

/** Bounded work-repository failure that never retains row or error payloads. */
export class WorkLeaseError extends Error {
  readonly name = "WorkLeaseError";

  constructor(readonly code: WorkLeaseErrorCode) {
    super(code);
  }
}

export type WorkClaimRequest = {
  now: Instant;
  leaseExpiresAt: Instant;
  leaseToken: string;
  claimedByInstance: string;
};

export type PlannedCommandInput = {
  effectKey: string;
  commandId: CommandId;
};

export type WorkTransitionState =
  | {
      state: "RETRY_WAIT";
      availableAt: Instant;
      errorCode: WorkErrorCode;
    }
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

export type EventWorkRepository = {
  claimNext(request: WorkClaimRequest): Promise<StoredEventWorkItem | null>;
  persistPlannedCommands(request: {
    workItemId: WorkItemId;
    leaseToken: string;
    now: Instant;
    plannedCommands: PlannedCommandInput[];
  }): Promise<StoredEventWorkItem>;
  complete(request: {
    workItemId: WorkItemId;
    leaseToken: string;
    now: Instant;
    receipt: EventConsumerReceipt;
  }): Promise<StoredEventWorkItem>;
  transition(request: {
    workItemId: WorkItemId;
    leaseToken: string;
    now: Instant;
    state: WorkTransitionState;
  }): Promise<StoredEventWorkItem>;
};

const nonEmptyString = z.string().min(1);

const claimRequestSchema = z
  .object({
    now: instantSchema,
    leaseExpiresAt: instantSchema,
    leaseToken: nonEmptyString,
    claimedByInstance: nonEmptyString,
  })
  .strict();

const plannedCommandInputSchema = z
  .object({ effectKey: nonEmptyString, commandId: commandIdSchema })
  .strict();

const transitionStateSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("RETRY_WAIT"),
      availableAt: instantSchema,
      errorCode: workErrorCodeSchema,
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

const ownedRequestSchema = z
  .object({
    workItemId: workItemIdSchema,
    leaseToken: nonEmptyString,
    now: instantSchema,
  })
  .strict();

const plannedCommandsRequestSchema = ownedRequestSchema
  .extend({ plannedCommands: z.array(plannedCommandInputSchema) })
  .strict();

const completionRequestSchema = ownedRequestSchema
  .extend({ receipt: eventConsumerReceiptSchema })
  .strict();

const transitionRequestSchema = ownedRequestSchema
  .extend({ state: transitionStateSchema })
  .strict();

type WorkTable = Table<StoredEventWorkItem, string>;
type ReceiptKey = [string, string, string];
type ReceiptTable = Table<EventConsumerReceipt, ReceiptKey>;

function workTable(database: JagaOnDatabase): WorkTable {
  return database.table<StoredEventWorkItem, string>("eventWorkItems");
}

function receiptTable(database: JagaOnDatabase): ReceiptTable {
  return database.table<EventConsumerReceipt, ReceiptKey>(
    "eventConsumerReceipts",
  );
}

function receiptKey(
  receipt: Pick<EventConsumerReceipt, "eventId" | "consumer" | "handlerVersion">,
): ReceiptKey {
  return [receipt.eventId, receipt.consumer, receipt.handlerVersion];
}

function sameReceipt(
  left: EventConsumerReceipt,
  right: EventConsumerReceipt,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateClaimRequest(value: WorkClaimRequest): WorkClaimRequest {
  const result = claimRequestSchema.safeParse(value);
  if (!result.success || !instantAfter(result.data.leaseExpiresAt, result.data.now)) {
    throw new WorkLeaseError("INVALID_LEASE_REQUEST");
  }
  return result.data;
}

function assertLeaseOwner(
  row: StoredEventWorkItem,
  leaseToken: string,
  now: Instant,
): asserts row is StoredEventWorkItem & {
  state: Extract<EventWorkState, { state: "CLAIMED" }>;
} {
  if (row.state.state !== "CLAIMED" || row.state.leaseToken !== leaseToken) {
    throw new WorkLeaseError("LEASE_NOT_OWNED");
  }
  if (!instantAfter(row.state.leaseExpiresAt, now)) {
    throw new WorkLeaseError("LEASE_EXPIRED");
  }
}

function rederive(
  row: StoredEventWorkItem,
  changes: Partial<Pick<StoredEventWorkItem, "attemptCount" | "state" | "plannedCommands">>,
): StoredEventWorkItem {
  return createStoredEventWorkItem(
    {
      workItemId: row.workItemId,
      eventId: row.eventId,
      consumer: row.consumer,
      handlerVersion: row.handlerVersion,
      priority: row.priority,
      createdAt: row.createdAt,
      attemptCount: changes.attemptCount ?? row.attemptCount,
      state: changes.state ?? row.state,
      plannedCommands: changes.plannedCommands ?? row.plannedCommands,
    },
    row.sourceEventSequence,
  );
}

function compareEligibleWork(
  left: StoredEventWorkItem,
  right: StoredEventWorkItem,
): number {
  if (left.priorityRank !== right.priorityRank) {
    return left.priorityRank - right.priorityRank;
  }
  const leftAt =
    left.state.state === "CLAIMED"
      ? left.state.leaseExpiresAt
      : left.availableAt!;
  const rightAt =
    right.state.state === "CLAIMED"
      ? right.state.leaseExpiresAt
      : right.availableAt!;
  const instantOrder = compareInstants(leftAt, rightAt);
  if (instantOrder !== 0) return instantOrder;
  if (left.sourceEventSequence !== right.sourceEventSequence) {
    return left.sourceEventSequence - right.sourceEventSequence;
  }
  return left.workItemId.localeCompare(right.workItemId);
}

async function readEligibleWork(
  table: WorkTable,
  now: Instant,
): Promise<StoredEventWorkItem[]> {
  const results: StoredEventWorkItem[] = [];
  const ranks: readonly WorkPriorityRank[] = [0, 1, 2, 3, 4];

  for (const rank of ranks) {
    for (const state of ["PENDING", "RETRY_WAIT"] as const) {
      const rows = await table
        .where("[stateCode+priorityRank+availableAt+sourceEventSequence]")
        .between(
          [state, rank, Dexie.minKey, Dexie.minKey],
          [state, rank, now, Dexie.maxKey],
          true,
          true,
        )
        .toArray();
      results.push(...rows);
    }
  }

  const expiredClaims = await table
    .where("[stateCode+leaseExpiresAt]")
    .between(["CLAIMED", Dexie.minKey], ["CLAIMED", now], true, true)
    .toArray();
  results.push(...expiredClaims);

  return results
    .map((row) => implementedStorageRowCodecs.eventWorkItems.validateAfterRead(row))
    .sort(compareEligibleWork);
}

function completedRow(
  row: StoredEventWorkItem,
  completedAt: Instant,
): StoredEventWorkItem {
  return implementedStorageRowCodecs.eventWorkItems.validateForWrite(
    rederive(row, { state: { state: "COMPLETED", completedAt } }),
  );
}

function boundedStorageFailure(error: unknown): never {
  if (error instanceof WorkLeaseError) throw error;
  if (error instanceof StorageRowValidationError) throw error;
  throw new WorkLeaseError("STORAGE_OPERATION_FAILED");
}

export function createEventWorkRepository(
  database: JagaOnDatabase,
): EventWorkRepository {
  const work = workTable(database);
  const receipts = receiptTable(database);

  return Object.freeze({
    async claimNext(input: WorkClaimRequest) {
      const request = validateClaimRequest(input);
      try {
        return await database.transaction("rw", work, receipts, async () => {
          const candidates = await readEligibleWork(work, request.now);
          for (const candidate of candidates) {
            const existingReceipt = await receipts.get(receiptKey(candidate));
            if (existingReceipt !== undefined) {
              const receipt =
                implementedStorageRowCodecs.eventConsumerReceipts.validateAfterRead(
                  existingReceipt,
                );
              const reconciled = completedRow(candidate, receipt.completedAt);
              await work.put(reconciled);
              continue;
            }

            const claimed = implementedStorageRowCodecs.eventWorkItems.validateForWrite(
              rederive(candidate, {
                attemptCount: candidate.attemptCount + 1,
                state: {
                  state: "CLAIMED",
                  leaseToken: request.leaseToken,
                  claimedByInstance: request.claimedByInstance,
                  leaseExpiresAt: request.leaseExpiresAt,
                },
              }),
            );
            await work.put(claimed);
            return claimed;
          }
          return null;
        });
      } catch (error) {
        return boundedStorageFailure(error);
      }
    },

    async persistPlannedCommands(input) {
      const parsed = plannedCommandsRequestSchema.safeParse(input);
      if (!parsed.success) throw new WorkLeaseError("INVALID_LEASE_REQUEST");
      const request = parsed.data;
      try {
        return await database.transaction("rw", work, async () => {
          const raw = await work.get(request.workItemId);
          if (raw === undefined) throw new WorkLeaseError("WORK_ITEM_NOT_FOUND");
          const row =
            implementedStorageRowCodecs.eventWorkItems.validateAfterRead(raw);
          assertLeaseOwner(row, request.leaseToken, request.now);
          const updated =
            implementedStorageRowCodecs.eventWorkItems.validateForWrite(
              rederive(row, { plannedCommands: request.plannedCommands }),
            );
          await work.put(updated);
          return updated;
        });
      } catch (error) {
        return boundedStorageFailure(error);
      }
    },

    async complete(input) {
      const parsed = completionRequestSchema.safeParse(input);
      if (!parsed.success) throw new WorkLeaseError("INVALID_LEASE_REQUEST");
      const request = parsed.data;
      const receipt = request.receipt;
      if (compareInstants(receipt.completedAt, request.now) !== 0) {
        throw new WorkLeaseError("RECEIPT_MISMATCH");
      }

      try {
        return await database.transaction("rw", work, receipts, async () => {
          const raw = await work.get(request.workItemId);
          if (raw === undefined) throw new WorkLeaseError("WORK_ITEM_NOT_FOUND");
          const row =
            implementedStorageRowCodecs.eventWorkItems.validateAfterRead(raw);
          if (
            row.eventId !== receipt.eventId ||
            row.consumer !== receipt.consumer ||
            row.handlerVersion !== receipt.handlerVersion
          ) {
            throw new WorkLeaseError("RECEIPT_MISMATCH");
          }

          const existingRaw = await receipts.get(receiptKey(receipt));
          if (existingRaw !== undefined) {
            const existing =
              implementedStorageRowCodecs.eventConsumerReceipts.validateAfterRead(
                existingRaw,
              );
            if (!sameReceipt(existing, receipt)) {
              throw new WorkLeaseError("RECEIPT_MISMATCH");
            }
            if (row.state.state !== "COMPLETED") {
              assertLeaseOwner(row, request.leaseToken, request.now);
            }
            const reconciled = completedRow(row, existing.completedAt);
            await work.put(reconciled);
            return reconciled;
          }

          assertLeaseOwner(row, request.leaseToken, request.now);
          const validatedReceipt =
            implementedStorageRowCodecs.eventConsumerReceipts.validateForWrite(
              receipt,
            );
          const completed = completedRow(row, receipt.completedAt);
          await receipts.add(validatedReceipt);
          await work.put(completed);
          return completed;
        });
      } catch (error) {
        return boundedStorageFailure(error);
      }
    },

    async transition(input) {
      const parsed = transitionRequestSchema.safeParse(input);
      if (!parsed.success) throw new WorkLeaseError("INVALID_LEASE_REQUEST");
      const request = parsed.data;
      try {
        return await database.transaction("rw", work, async () => {
          const raw = await work.get(request.workItemId);
          if (raw === undefined) throw new WorkLeaseError("WORK_ITEM_NOT_FOUND");
          const row =
            implementedStorageRowCodecs.eventWorkItems.validateAfterRead(raw);
          assertLeaseOwner(row, request.leaseToken, request.now);
          const updated =
            implementedStorageRowCodecs.eventWorkItems.validateForWrite(
              rederive(row, { state: request.state }),
            );
          await work.put(updated);
          return updated;
        });
      } catch (error) {
        return boundedStorageFailure(error);
      }
    },
  });
}
