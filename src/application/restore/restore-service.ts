import { createBackupRestoreValidator } from "@/backup/backup-restore-validator";
import type { BackupCryptoPort } from "@/backup/web-crypto-port";
import { HACKATHON_CLOSED_ROW_CODECS } from "@/application/storage/profile-row-codecs";
import { readDatasetTables } from "@/application/storage/integrity-gate";
import type { Instant } from "@/domain/shared/time";
import type { DatasetConnectionCoordinator } from "@/storage/delete-dataset";
import { createMigrationCoordinator } from "@/storage/migrations/migration-coordinator";
import { commitRestore, RestoreStaleError } from "@/storage/restore-transaction";
import { normaliseStorageFailure, storageFailure } from "@/storage/storage-failure";
import type { ConfirmRestoreResult, InspectRestoreResult, RestoreConfirmation, RestorePlan } from "./restore-contracts";
import { canonicalizeJson } from "@/application/contracts/canonical-json";
import { buildRestorePlan, currentDatasetFingerprint, restorePlanHash, restorePlanMaterial, restoreTargetDigest, verifyRestoreTarget } from "./restore-planner";

/**
 * Packet 10C restore service (storage-backup-spec 8.1–8.6). `inspect`
 * validates the untrusted file completely and returns an expiring plan with
 * no database change. `confirm` takes exclusive use of the dataset, closes
 * this tab's runtime and commits exactly that plan atomically; the next
 * runtime launch resumes durable reconciliation before normal use.
 */

export type RestoreService = {
  inspect(file: Uint8Array, passphrase: string): Promise<InspectRestoreResult>;
  confirm(plan: RestorePlan, confirmation: RestoreConfirmation): Promise<ConfirmRestoreResult>;
};

export function createRestoreService(dependencies: {
  databaseName: string;
  now(): Instant;
  crypto: () => BackupCryptoPort;
  coordinator: DatasetConnectionCoordinator;
  closeRuntime(): void;
  newOperationId?: () => string;
  newDatasetIdentity?: () => string;
}): RestoreService {
  const validator = createBackupRestoreValidator({ crypto: dependencies.crypto });
  /** Plans this service issued (operation → hash); a recomputed forgery is never accepted. */
  const issued = new Map<string, string>();
  const open = () =>
    createMigrationCoordinator(dependencies.databaseName, {
      now: dependencies.now,
      newDatasetIdentity: dependencies.newDatasetIdentity ?? (() => crypto.randomUUID()),
      closedRowCodecs: HACKATHON_CLOSED_ROW_CODECS,
    }).run();

  return Object.freeze({
    async inspect(file: Uint8Array, passphrase: string): Promise<InspectRestoreResult> {
      const now = dependencies.now();
      try {
        const candidate = await validator.validate(file, passphrase);
        const opened = await open();
        if (opened.kind === "FAILED") return { kind: "FAILED", failure: opened.failure };
        try {
          const current = await readDatasetTables(opened.database);
          const plan = await buildRestorePlan({ candidate, current, now, operationId: (dependencies.newOperationId ?? (() => crypto.randomUUID()))() });
          issued.set(plan.operationId, plan.planHash);
          return { kind: "PLAN_READY", plan };
        } finally {
          opened.database.close();
        }
      } catch (error) {
        return { kind: "FAILED", failure: normaliseStorageFailure("RESTORE_BACKUP", error, now) };
      }
    },

    async confirm(reviewed: RestorePlan, confirmation: RestoreConfirmation): Promise<ConfirmRestoreResult> {
      const now = dependencies.now();
      const stale = (): ConfirmRestoreResult => ({ kind: "STALE", failure: storageFailure("RESTORE_BACKUP", "RESTORE_CONFIRMATION_STALE", now) });
      // A private copy, checked against the issued hash and recomputed digest and
      // hash, before any lock is taken or any row is touched.
      let plan: RestorePlan;
      let expectedTargetCanonical: string;
      try {
        plan = structuredClone(reviewed) as RestorePlan;
        if (issued.get(plan.operationId) !== plan.planHash || confirmation.planHash !== plan.planHash) return stale();
        expectedTargetCanonical = canonicalizeJson(plan.target);
        if ((await restoreTargetDigest(plan.target)) !== plan.targetDigest) return stale();
        if ((await restorePlanHash(restorePlanMaterial(plan))) !== plan.planHash) return stale();
      } catch {
        return stale();
      }
      if (Date.parse(now) > Date.parse(plan.expiresAt)) return stale();
      const target = plan.target;
      // One target check, run on the private plan before any lock, runtime closure
      // or write, and again inside the replacement transaction before any clear.
      const validateTarget = () => canonicalizeJson(target) === expectedTargetCanonical && verifyRestoreTarget(target, now).kind === "VERIFIED";
      if (!validateTarget()) return stale();
      const release = await dependencies.coordinator.acquireExclusive();
      if (release === null) return { kind: "BLOCKED", failure: storageFailure("RESTORE_BACKUP", "DATABASE_BLOCKED_BY_OTHER_TAB", now) };
      try {
        dependencies.closeRuntime();
        const opened = await open();
        if (opened.kind === "FAILED") return { kind: "FAILED", failure: opened.failure };
        try {
          await commitRestore(
            opened.database,
            {
              operationId: plan.operationId,
              planHash: plan.planHash,
              containerId: plan.containerId,
              mode: plan.mode,
              sourceBackupSchemaVersion: plan.sourceBackupSchemaVersion,
              datasetIdentity: plan.datasetIdentity,
              lastCompletedMigrationId: plan.target.lastCompletedMigrationId,
              expectedFingerprint: plan.currentFingerprint,
              fingerprint: (tables) => currentDatasetFingerprint(tables),
              validateTarget,
              targetTables: target.tables,
              // Packet 11C Addendum C (C2): the reviewed backup value (absent in an old backup: off); the commit writes it OR the device's
              // current value, atomically with the dataset (fix round 1, I-2: a restore never turns the setting off).
              keepWordingOnDevice: target.patientSettings.keepWordingOnDevice === true,
              eventSequenceHighWaterMark: target.eventSequenceHighWaterMark,
              startedAt: plan.createdAt,
              committedAt: now,
            },
            HACKATHON_CLOSED_ROW_CODECS,
          );
          issued.delete(plan.operationId);
          return { kind: "COMMITTED" };
        } finally {
          opened.database.close();
        }
      } catch (error) {
        if (error instanceof RestoreStaleError) return stale();
        return { kind: "FAILED", failure: normaliseStorageFailure("RESTORE_BACKUP", error, now) };
      } finally {
        release();
      }
    },
  });
}
