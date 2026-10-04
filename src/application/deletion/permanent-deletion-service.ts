import { hashCanonicalJson } from "@/application/contracts/canonical-json";
import type { CommandId, CorrelationId, DomainEventId } from "@/application/contracts/command-event-identifiers";
import type { WorkItemId } from "@/application/contracts/event-work";
import { intelligenceWorkItemsFor } from "@/application/intelligence/intelligence-subscriptions";
import { JOURNAL_DELETED_EVENT_PAYLOAD } from "@/application/journal/journal-stored-rows";
import { packet8WorkItemsFor } from "@/application/packet8-subscriptions";
import { packet9WorkItemsFor } from "@/application/packet9-subscriptions";
import { HACKATHON_CLOSED_ROW_CODECS } from "@/application/storage/profile-row-codecs";
import type { AuditEventId, DeletionTombstone, Instant, RecordHead, RecordType, TransactionId } from "@/domain/shared";
import type { TypedRevisionRef } from "@/domain/shared/typed-revision-ref";
import { CommandTransactionError, createAuthoritativeCommandStore, type AuthoritativeCommitPlan } from "@/storage/authoritative-command-transaction";
import type { JagaOnDatabase } from "@/storage/database";
import { implementedStorageRowCodecs } from "@/storage/implemented-row-codecs";
import type { PermanentDeletionSnapshot } from "@/storage/permanent-deletion-transaction";
import { normaliseStorageFailure, storageFailure } from "@/storage/storage-failure";
import type { StorageRowCodec } from "@/storage/storage-row-codec";
import type { ConfirmDeletionResult, DeletionConfirmation, DeletionPlan, DeletionTarget, PrepareDeletionResult } from "./deletion-contracts";
import { DELETION_OWNER_ADAPTERS, TARGET_DELETION_OWNER, type DeletionOwnerAdapter } from "./deletion-owner-registry";
import { canonicalizeJson } from "@/application/contracts/canonical-json";
import type { DeletionClosure } from "./deletion-contracts";
import {
  buildDeletionPlan,
  closureFingerprint,
  computeDeletionClosure,
  deletionPlanHash,
  deletionPlanMaterial,
  DeletionPlanRefusedError,
  neutralisedReceiptsFor,
} from "./deletion-planner";

/**
 * Packet 10A permanent-deletion service (storage-backup-spec 6.4–6.6).
 *
 * `prepare` reads one consistent snapshot and returns a closed, hash-bound,
 * expiring plan. `confirm` commits exactly that plan in one authoritative
 * transaction (steps 1–9), or nothing: a changed head, dependency, receipt,
 * audit or expired plan is stale. Safety re-evaluation (step 2) is not
 * enabled in the `HACKATHON_DEMO` profile; no Safety module is imported.
 */

export type PermanentDeletionIds = {
  commandId(): CommandId;
  correlationId(): CorrelationId;
  transactionId(): TransactionId;
  auditEventId(): AuditEventId;
  domainEventId(): DomainEventId;
  workItemId(): WorkItemId;
};

export type PermanentDeletionService = {
  prepare(target: DeletionTarget): Promise<PrepareDeletionResult>;
  confirm(plan: DeletionPlan, confirmation: DeletionConfirmation): Promise<ConfirmDeletionResult>;
};

const SNAPSHOT_TABLES = ["recordHeads", "recordRevisions", "reverseDependencies", "engineEvaluationAudits", "commandReceipts", "domainEvents"] as const;

async function readSnapshot(database: JagaOnDatabase): Promise<PermanentDeletionSnapshot> {
  return database.transaction("r", SNAPSHOT_TABLES.map((name) => database.table(name)), async () => ({
    recordHeads: await database.table("recordHeads").toArray(),
    recordRevisions: await database.table("recordRevisions").toArray(),
    reverseDependencies: await database.table("reverseDependencies").toArray(),
    engineEvaluationAudits: await database.table("engineEvaluationAudits").toArray(),
    commandReceipts: await database.table("commandReceipts").toArray(),
    domainEvents: await database.table("domainEvents").toArray(),
  }));
}

function adapterFor(owner: string): DeletionOwnerAdapter {
  const adapter = DELETION_OWNER_ADAPTERS.find((entry) => entry.owner === owner);
  if (!adapter) throw new DeletionPlanRefusedError("UNSUPPORTED_DEPENDENT");
  return adapter;
}

export function createPermanentDeletionService(database: JagaOnDatabase, dependencies: { now(): Instant; ids: PermanentDeletionIds }): PermanentDeletionService {
  const store = createAuthoritativeCommandStore(database, {
    revisionCodec: HACKATHON_CLOSED_ROW_CODECS.recordRevisions as StorageRowCodec<never>,
    auditCodec: HACKATHON_CLOSED_ROW_CODECS.auditEvents as StorageRowCodec<never>,
    eventCodec: HACKATHON_CLOSED_ROW_CODECS.domainEvents as StorageRowCodec<never>,
    reverseDependencyCodec: implementedStorageRowCodecs.reverseDependencies,
    evaluationAuditCodec: implementedStorageRowCodecs.engineEvaluationAudits,
  });

  async function prepare(target: DeletionTarget): Promise<PrepareDeletionResult> {
    const now = dependencies.now();
    try {
      return { kind: "PLAN_READY", plan: await buildDeletionPlan(await readSnapshot(database), target, now) };
    } catch (error) {
      if (error instanceof DeletionPlanRefusedError) return { kind: "REFUSED", reason: error.reason };
      return { kind: "FAILED", failure: normaliseStorageFailure("DELETE_RECORD", error, now) };
    }
  }

  async function confirm(reviewed: DeletionPlan, confirmation: DeletionConfirmation): Promise<ConfirmDeletionResult> {
    const now = dependencies.now();
    const stale = (): ConfirmDeletionResult => ({ kind: "STALE", failure: storageFailure("DELETE_RECORD", "DELETION_CONFIRMATION_STALE", now) });
    try {
      // Work only on a private copy: nothing the caller holds can change what is committed.
      const plan = structuredClone(reviewed) as DeletionPlan;
      const expectedHash = await deletionPlanHash(deletionPlanMaterial(plan));
      if (expectedHash !== plan.planHash || confirmation.planHash !== plan.planHash) return stale();
      if (Date.parse(now) > Date.parse(plan.expiresAt) || Date.parse(confirmation.confirmedAt) > Date.parse(plan.expiresAt)) return stale();

      // Re-derive the exact closure from current state; every effect comes from it, not from the plan arrays.
      let closure: DeletionClosure;
      try {
        closure = computeDeletionClosure(await readSnapshot(database), plan.target);
      } catch (error) {
        if (error instanceof DeletionPlanRefusedError) return stale();
        throw error;
      }
      const fingerprint = closureFingerprint(closure);
      if (fingerprint !== plan.closureFingerprint || canonicalizeJson(closure) !== canonicalizeJson(plan.closure)) return stale();
      const neutralisedReceipts = await neutralisedReceiptsFor(closure);
      if (canonicalizeJson(neutralisedReceipts) !== canonicalizeJson(plan.neutralisedReceipts)) return stale();

      const transactionId = dependencies.ids.transactionId();
      const commandId = dependencies.ids.commandId();
      const correlationId = dependencies.ids.correlationId();
      const affectedDependencies: TypedRevisionRef<RecordType>[] = closure.dependents.map((dependent) => ({
        recordType: dependent.head.recordType,
        recordId: dependent.head.recordId,
        revisionId: dependent.head.headRevisionId,
      }));
      const deleted = [{ owner: TARGET_DELETION_OWNER.owner, head: closure.targetHead }, ...closure.dependents];

      const tombstones: DeletionTombstone[] = [];
      const heads: RecordHead[] = [];
      const audits: unknown[] = [];
      const events: Array<Record<string, unknown>> = [];
      for (const { owner, head } of deleted) {
        const adapter = owner === TARGET_DELETION_OWNER.owner && head.recordId === closure.targetHead.recordId ? TARGET_DELETION_OWNER : adapterFor(owner);
        const auditEventId = dependencies.ids.auditEventId();
        const rows = adapter.rows(head, {
          transactionId,
          commandId,
          correlationId,
          deletedAt: now,
          auditEventId,
          eventId: dependencies.ids.domainEventId(),
          planHash: plan.planHash,
          affectedDependencies,
        });
        tombstones.push({ recordId: head.recordId, recordType: head.recordType, deletedAt: now, initiator: adapter.initiator, auditEventId, transactionId });
        heads.push({ ...head, state: "DELETED", updatedAt: now });
        audits.push(rows.audit);
        events.push(rows.event);
      }
      const work = events.flatMap((event) => {
        const source = {
          eventId: event.eventId as DomainEventId,
          eventName: event.eventName as string,
          recordType: (event.change as { recordType: RecordType }).recordType,
          createdAt: now,
          workItemId: dependencies.ids.workItemId,
        };
        return [...intelligenceWorkItemsFor(source), ...packet8WorkItemsFor(source), ...packet9WorkItemsFor(source)];
      });

      const commitPlan: AuthoritativeCommitPlan<never, never, never, never, never> = {
        kind: "COMMIT",
        commandId,
        commandHash: await hashCanonicalJson({ commandName: "PERMANENTLY_DELETE_PATIENT_RECORD", planHash: plan.planHash }),
        completedAt: now,
        transactionId,
        headExpectations: deleted.map(({ head }) => ({
          kind: "MUST_MATCH" as const,
          recordType: head.recordType,
          recordId: head.recordId,
          expectedRevisionId: head.headRevisionId,
          expectedRevisionNumber: head.headRevisionNumber,
        })),
        recordRevisions: [],
        recordHeads: heads,
        deletionTombstones: tombstones,
        auditEvents: audits as never[],
        domainEvents: events as never[],
        eventWorkItems: work,
        reverseDependencies: [],
        evaluationAudits: [],
        appPreference: null,
        safety: { kind: "NOT_REQUIRED" },
        permanentDeletion: {
          purgedRecordIds: closure.purgedRecordIds,
          removedEvaluationIds: closure.evaluationIds,
          redactedEvents: closure.redactedEventIds.map((eventId) => ({ eventId, payload: { ...JOURNAL_DELETED_EVENT_PAYLOAD } })),
          neutralisedReceipts,
          // Revalidated inside the authoritative write transaction (spec 6.5 step 1).
          closureUnchanged(snapshot) {
            try {
              return closureFingerprint(computeDeletionClosure(snapshot, plan.target)) === fingerprint;
            } catch {
              return false;
            }
          },
        },
      };
      const receipt = await store.execute(commitPlan);
      if (receipt.outcome === "COMMITTED") return { kind: "DELETED", removedRecordCount: deleted.length };
      return stale();
    } catch (error) {
      if (error instanceof CommandTransactionError && error.code === "DELETION_CLOSURE_CHANGED") return stale();
      if (error instanceof DeletionPlanRefusedError) return stale();
      return { kind: "FAILED", failure: normaliseStorageFailure("DELETE_RECORD", error, now) };
    }
  }

  return Object.freeze({ prepare, confirm });
}
