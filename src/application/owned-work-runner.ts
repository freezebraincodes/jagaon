import type { CommandId } from "@/application/contracts/command-event-identifiers";
import type { EventConsumerReceipt } from "@/application/contracts/event-consumer-receipt";
import type { ConsumerKey } from "@/application/contracts/event-work";
import type { Instant } from "@/domain/shared/time";
import type { JagaOnDatabase } from "@/storage/database";
import { createEventWorkRepository } from "@/storage/event-work-repository";
import type { StoredEventWorkItem } from "@/storage/stored-event-work-item";

/**
 * Runs one owner's queued work (event-contracts Sections 4 and 11.3).
 *
 * Only items of the named consumer and handler version are claimed. Planned
 * command IDs are persisted before any effect is submitted, so a crashed or
 * retried run reuses them and receipts make replays idempotent. Every handled
 * item is completed with a consumer receipt; a technical failure moves it to
 * bounded retry and commits nothing new.
 */

const LEASE_MS = 5 * 60_000;
const RETRY_MS = 60_000;
const MAX_ITEMS = 500;

export type OwnedEffect = {
  effectKey: string;
  /** Returns true when the effect committed (or replayed a committed receipt). */
  run(commandId: CommandId): Promise<boolean>;
};

export type OwnedWorkReport = { claimedWorkItems: number; committedCommands: number; failed: boolean };

export async function runOwnedWork(input: {
  database: JagaOnDatabase;
  now: () => Instant;
  newCommandId: () => CommandId;
  leaseToken: string;
  instanceId: string;
  consumer: ConsumerKey;
  handlerVersion: string;
  plan(item: StoredEventWorkItem): Promise<OwnedEffect[]>;
}): Promise<OwnedWorkReport> {
  const work = createEventWorkRepository(input.database);
  const report: OwnedWorkReport = { claimedWorkItems: 0, committedCommands: 0, failed: false };
  for (let index = 0; index < MAX_ITEMS; index += 1) {
    const now = input.now();
    const item = await work.claimNext({
      now,
      leaseExpiresAt: new Date(Date.parse(now) + LEASE_MS).toISOString() as Instant,
      leaseToken: input.leaseToken,
      claimedByInstance: input.instanceId,
      consumers: [input.consumer],
    });
    if (!item) break;
    report.claimedWorkItems += 1;
    if (item.handlerVersion !== input.handlerVersion) {
      await work.transition({
        workItemId: item.workItemId,
        leaseToken: input.leaseToken,
        now,
        state: { state: "TERMINAL_FAILURE", failedAt: now, errorCode: "HANDLER_CONFIGURATION_INVALID" },
      });
      continue;
    }
    try {
      const effects = await input.plan(item);
      const planned = new Map(item.plannedCommands.map((entry) => [entry.effectKey, entry.commandId as CommandId]));
      for (const effect of effects) if (!planned.has(effect.effectKey)) planned.set(effect.effectKey, input.newCommandId());
      if (effects.length > 0) {
        await work.persistPlannedCommands({
          workItemId: item.workItemId,
          leaseToken: input.leaseToken,
          now,
          plannedCommands: [...planned].map(([effectKey, commandId]) => ({ effectKey, commandId })),
        });
      }
      const committed: CommandId[] = [];
      for (const effect of effects) {
        const commandId = planned.get(effect.effectKey)!;
        if (await effect.run(commandId)) committed.push(commandId);
      }
      const completedAt = input.now();
      const receipt: EventConsumerReceipt = {
        eventId: item.eventId,
        consumer: item.consumer,
        handlerVersion: item.handlerVersion,
        completedAt,
        outcome:
          committed.length > 0
            ? { kind: "COMMANDS_COMMITTED", commandIds: [...new Set(committed)] as [CommandId, ...CommandId[]] }
            : { kind: "NO_ACTION_REQUIRED" },
      };
      await work.complete({ workItemId: item.workItemId, leaseToken: input.leaseToken, now: completedAt, receipt });
      report.committedCommands += committed.length;
    } catch {
      report.failed = true;
      try {
        await work.transition({
          workItemId: item.workItemId,
          leaseToken: input.leaseToken,
          now,
          state: { state: "RETRY_WAIT", availableAt: new Date(Date.parse(now) + RETRY_MS).toISOString() as Instant, errorCode: "TRANSIENT_STORAGE_ERROR" },
        });
      } catch {
        // The lease expires and a later run may reclaim the item.
      }
    }
  }
  return report;
}
