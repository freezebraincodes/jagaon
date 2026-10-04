import type { CommandId } from "@/application/contracts/command-event-identifiers";
import type { Instant, RecordHead, RecordId, RevisionId } from "@/domain/shared";
import type { ReminderRevision } from "@/domain/care-plan/reminder";
import type { JagaOnDatabase } from "@/storage/database";
import { committedDomainEventRowCodec } from "@/storage/committed-domain-event-row";
import { REMINDER_RECONCILIATION_HANDLER_VERSION } from "@/application/packet8-subscriptions";
import { runOwnedWork, type OwnedEffect, type OwnedWorkReport } from "@/application/owned-work-runner";
import { carePlanRevisionRowCodec } from "./care-plan-persistence";
import type { CarePlanCommandService } from "./care-plan-command-service";

/**
 * Reminder reconciliation (domain Section 7.14; event-contracts Section 10).
 *
 * A corrected, superseded or deleted source revision (prescription,
 * appointment, preventive-care item or care question) invalidates only the
 * reminders whose current head references that exact revision. Each becomes
 * `REVIEW_REQUIRED` and stops producing future occurrences until the patient
 * confirms or replaces it. Nothing here rewrites a reminder's time, creates a
 * medication fact or reactivates a reminder.
 */

/** Record types whose revisions a reminder may reference. */
export const REMINDER_SOURCE_RECORD_TYPES = Object.freeze(["PRESCRIPTION_VERSION", "APPOINTMENT", "PREVENTIVE_CARE_ITEM", "CARE_QUESTION"] as const);

/** True when the reminder's subject target or schedule anchor is this exact revision. */
export function reminderReferences(revision: ReminderRevision, sourceRevisionId: RevisionId): boolean {
  const subject = revision.payload.subject;
  const targetsSource = "target" in subject && subject.target.revisionId === sourceRevisionId;
  const schedule = revision.payload.schedule;
  const anchoredToSource = schedule.kind === "RELATIVE_TO_APPOINTMENT" && schedule.appointment.revisionId === sourceRevisionId;
  return targetsSource || anchoredToSource;
}

export function createReminderReconciliation(
  database: JagaOnDatabase,
  dependencies: { now: () => Instant; newCommandId: () => CommandId; leaseToken: () => string; instanceId: string; carePlan: CarePlanCommandService },
) {
  async function reviewEffects(sourceRevisionId: RevisionId): Promise<OwnedEffect[]> {
    const edges = (await database.table("reverseDependencies").where("sourceRevisionId").equals(sourceRevisionId).toArray()) as Array<{
      dependentRecordId: RecordId;
      dependentRecordType: string;
      owner: string;
    }>;
    const reminderIds = [...new Set(edges.filter((edge) => edge.owner === "CARE_PLAN" && edge.dependentRecordType === "REMINDER").map((edge) => edge.dependentRecordId))].sort();
    const effects: OwnedEffect[] = [];
    for (const recordId of reminderIds) {
      const head = (await database.table("recordHeads").get(recordId)) as RecordHead | undefined;
      if (!head || head.state !== "ACTIVE") continue;
      const revision = carePlanRevisionRowCodec.validateAfterRead(await database.table("recordRevisions").get(head.headRevisionId)).revision as ReminderRevision;
      if (!reminderReferences(revision, sourceRevisionId)) continue;
      if (revision.payload.state !== "ACTIVE" && revision.payload.state !== "PAUSED") continue;
      effects.push({
        effectKey: `review:${recordId}`,
        async run(commandId) {
          const result = await dependencies.carePlan.requireReminderReview({
            recordId,
            expectedRevisionId: head.headRevisionId,
            expectedRevisionNumber: head.headRevisionNumber,
            commandId,
          });
          if (result.kind === "FAILED") throw new Error(result.code);
          return result.kind === "COMMITTED";
        },
      });
    }
    return effects;
  }

  return Object.freeze({
    async processPending(): Promise<OwnedWorkReport> {
      return runOwnedWork({
        database,
        now: dependencies.now,
        newCommandId: dependencies.newCommandId,
        leaseToken: dependencies.leaseToken(),
        instanceId: dependencies.instanceId,
        consumer: "REMINDER_RECONCILIATION",
        handlerVersion: REMINDER_RECONCILIATION_HANDLER_VERSION,
        async plan(item) {
          const event = committedDomainEventRowCodec.validateAfterRead(await database.table("domainEvents").get(item.eventId));
          const change = event.change;
          if (!(REMINDER_SOURCE_RECORD_TYPES as readonly string[]).includes(change.recordType) || change.previousRevisionId === null) return [];
          return reviewEffects(change.previousRevisionId as RevisionId);
        },
      });
    },
  });
}
