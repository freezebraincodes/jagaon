import type { CommandId } from "@/application/contracts/command-event-identifiers";
import type { EventRecordChange } from "@/application/contracts/domain-event-envelope";
import type { Instant, RecordId, RevisionId } from "@/domain/shared";
import type { CareSummaryInvalidationReason } from "@/domain/care-preparation/care-summary-snapshot";
import type { JagaOnDatabase } from "@/storage/database";
import { committedDomainEventRowCodec } from "@/storage/committed-domain-event-row";
import { runOwnedWork, type OwnedEffect, type OwnedWorkReport } from "@/application/owned-work-runner";
import { CARE_SUMMARY_INVALIDATION_HANDLER_VERSION, CARE_SUMMARY_SOURCE_RECORD_TYPES } from "@/application/packet9-subscriptions";
import { CARE_SUMMARY_SOURCE_EVALUATOR } from "./care-preparation-persistence";
import type { CarePreparationService } from "./care-preparation-service";

/**
 * Care-summary invalidation (domain 11.11–11.12; event-contracts 10.3).
 *
 * A corrected or revised source invalidates only the snapshots whose exact
 * reverse-dependency edges name that source revision; the snapshot is never
 * edited in place. Permanent source deletion is not handled in Packet 9:
 * Packet 10A owns the confirmed deletion plan and its dependency closure.
 * Until then export preflight refuses any snapshot whose source is missing,
 * tombstoned or changed. Exports are never rewritten.
 */

/** The snapshot effects one source change requires. */
export async function careSummaryEffectsFor(
  database: JagaOnDatabase,
  service: Pick<CarePreparationService, "systemInvalidate">,
  change: EventRecordChange,
): Promise<OwnedEffect[]> {
  if (!(CARE_SUMMARY_SOURCE_RECORD_TYPES as readonly string[]).includes(change.recordType)) return [];

  // Permanent deletion belongs to Packet 10A's confirmed deletion transaction;
  // no asynchronous purge is performed here.
  if (change.kind === "RECORD_DELETED") return [];

  if (change.previousRevisionId === null) return [];
  const reason: CareSummaryInvalidationReason = change.action === "CORRECT" ? "SOURCE_CORRECTED" : "SOURCE_SUPERSEDED";
  const edges = (await database.table("reverseDependencies").where("sourceRevisionId").equals(change.previousRevisionId as RevisionId).toArray()) as Array<{
    dependentRecordId: RecordId;
    owner: string;
    evaluatorKey: string;
  }>;
  const snapshots = [...new Set(edges.filter((edge) => edge.owner === "CARE_PREPARATION" && edge.evaluatorKey === CARE_SUMMARY_SOURCE_EVALUATOR.key).map((edge) => edge.dependentRecordId))].sort();
  return snapshots.map((recordId) => ({
    effectKey: `invalidate:${recordId}`,
    async run(commandId: CommandId) {
      const result = await service.systemInvalidate({ recordId, reason, commandId });
      if (result !== "NO_CHANGE" && result.kind === "FAILED") throw new Error(result.code);
      return result !== "NO_CHANGE" && result.kind === "COMMITTED";
    },
  }));
}

export function createCareSummaryInvalidation(
  database: JagaOnDatabase,
  dependencies: { now: () => Instant; newCommandId: () => CommandId; leaseToken: () => string; instanceId: string; service: CarePreparationService },
) {
  return Object.freeze({
    async processPending(): Promise<OwnedWorkReport> {
      return runOwnedWork({
        database,
        now: dependencies.now,
        newCommandId: dependencies.newCommandId,
        leaseToken: dependencies.leaseToken(),
        instanceId: dependencies.instanceId,
        consumer: "CARE_SUMMARY_INVALIDATION",
        handlerVersion: CARE_SUMMARY_INVALIDATION_HANDLER_VERSION,
        async plan(item) {
          const event = committedDomainEventRowCodec.validateAfterRead(await database.table("domainEvents").get(item.eventId));
          return careSummaryEffectsFor(database, dependencies.service, event.change);
        },
      });
    },
  });
}
