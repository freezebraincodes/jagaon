import { readDatasetTables } from "@/application/storage/integrity-gate";
import { HACKATHON_CLOSED_ROW_CODECS } from "@/application/storage/profile-row-codecs";
import type { Instant } from "@/domain/shared/time";
import { verifyDataset } from "@/storage/dataset-verifier";
import type { JagaOnDatabase } from "@/storage/database";
import { implementedStorageRowCodecs } from "@/storage/implemented-row-codecs";
import { createStoredEventWorkItem, type StoredEventWorkItem } from "@/storage/stored-event-work-item";
import { storageFailure, StorageOperationError, type StorageOperationFailure } from "@/storage/storage-failure";
import { createStorageMetadataRepository, RESTORE_CHECKPOINTS, type RestoreCheckpoint, type RestoreStateRow } from "@/storage/storage-metadata";
import { validateReverseDependencies } from "./dependency-reconstruction";
import { reconciliationPlan, type ReconciliationOwnerKey } from "./restore-owner-registry";

/**
 * Durable post-restore reconciliation (storage-backup-spec 8.7–8.8; RST-013,
 * RST-014, RST-016–RST-019). Normal use stays locked until `COMPLETED`. Each
 * checkpoint is recorded in `RESTORE_STATE` as it completes, so a crash
 * resumes after the last verified checkpoint. Historical events are never
 * replayed: owners run their bounded current-state operations over pending
 * responsibility only. No network, AI or Safety module is involved.
 */

export type ReconciliationOwnerOperations = {
  rebuildBootstrapLocale(): Promise<void>;
  inquiryMaintenance(): Promise<void>;
  patternLearningRefresh(): Promise<void>;
  reminderReconciliation(): Promise<void>;
  careSummaryInvalidation(): Promise<void>;
};

export type ReconciliationResult = { kind: "COMPLETED" } | { kind: "FAILED"; failure: StorageOperationFailure };

async function recoverWorkLeases(database: JagaOnDatabase): Promise<void> {
  await database.transaction("rw", [database.table("eventWorkItems"), database.table("eventConsumerReceipts")], async () => {
    const receipts = (await database.table("eventConsumerReceipts").toArray()) as Array<{ eventId: string; consumer: string; handlerVersion: string; completedAt: Instant }>;
    const completedBy = new Map(receipts.map((row) => [`${row.eventId}|${row.consumer}|${row.handlerVersion}`, row.completedAt]));
    for (const raw of await database.table("eventWorkItems").toArray()) {
      const row = implementedStorageRowCodecs.eventWorkItems.validateAfterRead(raw) as StoredEventWorkItem;
      const completedAt = completedBy.get(`${row.eventId}|${row.consumer}|${row.handlerVersion}`);
      let state = row.state;
      // An existing consumer receipt proves the effect happened: never repeat it.
      if (completedAt && (state.state === "PENDING" || state.state === "CLAIMED" || state.state === "RETRY_WAIT")) state = { state: "COMPLETED", completedAt };
      // A restored claim belongs to another device: it is never resumed as claimed.
      else if (state.state === "CLAIMED") state = { state: "PENDING" };
      if (state === row.state) continue;
      const { stateCode: _code, priorityRank: _rank, sourceEventSequence, availableAt: _available, leaseExpiresAt: _lease, ...base } = row;
      void _code;
      void _rank;
      void _available;
      void _lease;
      await database.table("eventWorkItems").put(implementedStorageRowCodecs.eventWorkItems.validateForWrite(createStoredEventWorkItem({ ...base, state } as never, sourceEventSequence)) as never);
    }
  });
}

export function createRestoreReconciler(
  database: JagaOnDatabase,
  dependencies: {
    now(): Instant;
    owners: ReconciliationOwnerOperations;
    fault?: RestoreCheckpoint;
    /** Only an explicit patient recovery action may resume a `FAILED_BLOCKING` restore. */
    resumeFailedBlocking?: boolean;
  },
) {
  const metadata = createStorageMetadataRepository(database);

  async function runOwner(owner: ReconciliationOwnerKey): Promise<void> {
    switch (owner) {
      case "STORAGE_VERIFIER": {
        const verification = verifyDataset(await readDatasetTables(database), HACKATHON_CLOSED_ROW_CODECS, { requireMetadata: true, auditLinkage: true });
        if (verification.kind === "FAILED") throw new StorageOperationError("RESTORE_RECONCILIATION_FAILED", { tableName: verification.tableName });
        return;
      }
      case "DEPENDENCY_VERIFIER": {
        // Defence in depth: the stored edges must equal exactly, field for field, the set each owner derives from current canonical revisions.
        const tables = await readDatasetTables(database);
        if (validateReverseDependencies(tables.recordRevisions, tables.reverseDependencies).kind !== "VALID") {
          throw new StorageOperationError("RESTORE_RECONCILIATION_FAILED", { tableName: "reverseDependencies" });
        }
        return;
      }
      case "BOOTSTRAP_LOCALE":
        return dependencies.owners.rebuildBootstrapLocale();
      case "RUNTIME_POINTER_VERIFIER": {
        const rows = (await database.table("storageMetadata").toArray()) as Array<{ key: string }>;
        if (rows.some((row) => row.key.startsWith("ACTIVE_") || row.key.startsWith("AI_ROUTE_CIRCUIT"))) throw new StorageOperationError("RESTORE_RECONCILIATION_FAILED", { tableName: "storageMetadata" });
        return;
      }
      case "WORK_LEASE_RECOVERY":
        return recoverWorkLeases(database);
      case "INQUIRY":
        return dependencies.owners.inquiryMaintenance();
      case "PATTERN_LEARNING":
        return dependencies.owners.patternLearningRefresh();
      case "REMINDERS":
        return dependencies.owners.reminderReconciliation();
      case "CARE_SUMMARY":
        return dependencies.owners.careSummaryInvalidation();
    }
  }

  async function checkpoint(state: RestoreStateRow, patch: Partial<RestoreStateRow>): Promise<RestoreStateRow> {
    return metadata.writeRestoreState({ ...state, ...patch } as RestoreStateRow);
  }

  return Object.freeze({
    async resume(): Promise<ReconciliationResult> {
      let state = await metadata.readRestoreState();
      if (state?.phase === "FAILED_BLOCKING" && !dependencies.resumeFailedBlocking) {
        // Stays integrity-locked; nothing is written until the patient chooses recovery.
        return { kind: "FAILED", failure: storageFailure("RESTORE_RECONCILE", "RESTORE_RECONCILIATION_FAILED", dependencies.now()) };
      }
      if (!state || !["RECONCILING", "FAILED_BLOCKING"].includes(state.phase)) return { kind: "COMPLETED" };
      const { failureCode: _previous, ...withoutFailure } = state;
      void _previous;
      state = await checkpoint(withoutFailure as RestoreStateRow, { phase: "RECONCILING" });
      const steps = reconciliationPlan();
      const done = RESTORE_CHECKPOINTS.indexOf(state.lastCompletedStep ?? "COMMITTED");
      try {
        for (const step of steps) {
          if (RESTORE_CHECKPOINTS.indexOf(step.checkpoint) <= done) continue;
          if (dependencies.fault === step.checkpoint) throw new StorageOperationError("RESTORE_RECONCILIATION_FAILED");
          if (step.owner) await runOwner(step.owner);
          state = await checkpoint(state, { lastCompletedStep: step.checkpoint });
        }
        await checkpoint(state, { phase: "COMPLETED", completedAt: dependencies.now() });
        return { kind: "COMPLETED" };
      } catch {
        const failure = storageFailure("RESTORE_RECONCILE", "RESTORE_RECONCILIATION_FAILED", dependencies.now());
        await checkpoint(state, { phase: "FAILED_BLOCKING", failureCode: "RESTORE_RECONCILIATION_FAILED" }).catch(() => undefined);
        return { kind: "FAILED", failure };
      }
    },
  });
}
