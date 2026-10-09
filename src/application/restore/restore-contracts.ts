import type { Sha256Digest } from "@/application/contracts/canonical-json";
import type { BackupPatientSettings, BackupTableSetV1 } from "@/backup/backup-payload-v1";
import type { Instant } from "@/domain/shared/time";
import type { StorageOperationFailure } from "@/storage/storage-failure";
import type { RestoreMode } from "@/storage/storage-metadata";

/**
 * Packet 10C restore contracts (storage-backup-spec 8.1, 8.5). Only two modes
 * exist; a different-lineage non-empty database is never merged or
 * overwritten. Plans are closed, hash-bound and expire after ten minutes.
 */

export const RESTORE_PLAN_TTL_MS = 10 * 60 * 1000;

export type RestorePlanCounts = {
  glucoseReadings: number;
  medicineEntries: number;
  mealEntries: number;
  healthChecksAppointments: number;
};

/** Patient-meaningful effects only: no IDs, hashes or cryptographic parameters. */
export type RestorePlanEffects = {
  exportedAt: Instant;
  counts: RestorePlanCounts;
  /** Same-lineage only: current records absent from the backup that will be discarded. */
  newerRecordsDiscarded: number;
  /** Same-lineage only: current permanent deletions preserved over older backup content. */
  protectedDeletions: number;
  /** The hackathon profile has no runtime pointer to replace. */
  runtimePointersReplaced: 0;
  externalCopiesUnchanged: true;
};

export type RestoreTarget = {
  tables: BackupTableSetV1;
  eventSequenceHighWaterMark: number;
  lastCompletedMigrationId?: string;
  /**
   * Packet 11C Addendum C (C2): the backup's patient settings (bound into `targetDigest`; an old version 1 backup: off). Fix round 1
   * (I-2): the commit writes backup || the device's current value, so a restore never turns "Keep wording on this device" off.
   */
  patientSettings: BackupPatientSettings;
};

export type RestorePlan = Readonly<{
  operationId: string;
  planHash: Sha256Digest;
  createdAt: Instant;
  expiresAt: Instant;
  mode: RestoreMode;
  containerId: string;
  datasetIdentity: string;
  sourceBackupSchemaVersion: number;
  /** Exact current-dataset material re-checked inside the write transaction. */
  currentFingerprint: string;
  payloadFingerprint: string;
  /** SHA-256 of the canonical post-overlay target dataset; bound into `planHash`. */
  targetDigest: string;
  effects: RestorePlanEffects;
  target: RestoreTarget;
}>;

export type RestoreConfirmation = Readonly<{ planHash: Sha256Digest; confirmedAt: Instant }>;

export type InspectRestoreResult = { kind: "PLAN_READY"; plan: RestorePlan } | { kind: "FAILED"; failure: StorageOperationFailure };

export type ConfirmRestoreResult =
  | { kind: "COMMITTED" }
  | { kind: "STALE"; failure: StorageOperationFailure }
  | { kind: "BLOCKED"; failure: StorageOperationFailure }
  | { kind: "FAILED"; failure: StorageOperationFailure };
