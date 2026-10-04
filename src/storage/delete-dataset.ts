import type { Instant } from "@/domain/shared/time";
import { normaliseStorageFailure, storageFailure, type StorageOperationFailure } from "./storage-failure";

/**
 * Whole-dataset deletion (storage-backup-spec 6.8; SDEL-012; Packet 10 freeze
 * Section 9). A separate explicit confirmation with the exact locked token
 * `DELETE` is required. Another open JagaOn tab blocks the operation before
 * any deletion request is issued; success is reported only after the browser
 * deleted the database and its absence is verified. Exported backups,
 * screenshots and shared information are never claimed to be recalled.
 */

export const DELETE_ALL_CONFIRMATION_TOKEN = "DELETE" as const;
export const DELETE_ALL_PLAN_TTL_MS = 10 * 60 * 1000;

/** Cross-tab presence and exclusivity (Web Locks, with a BroadcastChannel fallback in the browser). */
export type DatasetConnectionCoordinator = {
  /**
   * Acquires exclusive use of the dataset when no other tab holds it, and
   * returns a release function; returns `null` when another tab is open.
   */
  acquireExclusive(): Promise<(() => void) | null>;
  /** Tells other tabs the dataset was deleted so they stop and never recreate it. */
  announceDeleted(): void;
};

export type DatabaseDeletionPort = {
  /** Resolves after deletion; `onBlocked` fires if an unknown connection delays it. */
  deleteDatabase(name: string, onBlocked: () => void): Promise<void>;
  exists(name: string): Promise<boolean>;
};

export type DeleteAllPlan = Readonly<{ createdAt: Instant; expiresAt: Instant }>;

export type DeleteAllResult =
  /** The database is gone; `localStateCleared` is false when auxiliary local keys could not be removed. */
  | { kind: "DELETED"; localStateCleared: boolean }
  | { kind: "BLOCKED"; failure: StorageOperationFailure }
  | { kind: "CONFIRMATION_REQUIRED" }
  | { kind: "FAILED"; failure: StorageOperationFailure };

export type DeleteAllEvents = {
  /** The irreversible IndexedDB delete request is about to be issued; cancellation is no longer possible. */
  onRequestIssued?(): void;
  /** An unknown connection delays the queued request; it completes when that connection closes. */
  onBlocked?(): void;
};

export type DeleteDatasetService = {
  prepare(): DeleteAllPlan;
  confirm(plan: DeleteAllPlan, typedToken: string, events?: DeleteAllEvents): Promise<DeleteAllResult>;
};

export function createDeleteDatasetService(dependencies: {
  databaseName: string;
  now(): Instant;
  coordinator: DatasetConnectionCoordinator;
  deletion: DatabaseDeletionPort;
  /** Closes this tab's own runtime connection before deletion. */
  closeOwnConnections(): void | Promise<void>;
  /** Removes JagaOn's local (non-IndexedDB) technical and presentation state. */
  clearLocalState(): void;
}): DeleteDatasetService {
  return Object.freeze({
    prepare(): DeleteAllPlan {
      const createdAt = dependencies.now();
      return Object.freeze({ createdAt, expiresAt: new Date(Date.parse(createdAt) + DELETE_ALL_PLAN_TTL_MS).toISOString() as Instant });
    },

    async confirm(plan, typedToken, events: DeleteAllEvents = {}) {
      const now = dependencies.now();
      if (typedToken !== DELETE_ALL_CONFIRMATION_TOKEN || Date.parse(now) > Date.parse(plan.expiresAt)) return { kind: "CONFIRMATION_REQUIRED" };
      let release: (() => void) | null = null;
      try {
        release = await dependencies.coordinator.acquireExclusive();
        if (release === null) {
          // Nothing was requested from IndexedDB; the dataset is untouched.
          return { kind: "BLOCKED", failure: storageFailure("DELETE_DATASET", "DATASET_DELETE_BLOCKED", now) };
        }
        // Every cross-tab preflight is complete; only now is the irreversible request issued.
        await dependencies.closeOwnConnections();
        events.onRequestIssued?.();
        await dependencies.deletion.deleteDatabase(dependencies.databaseName, () => events.onBlocked?.());
        if (await dependencies.deletion.exists(dependencies.databaseName)) {
          // Another tab recreated the database after it was deleted: never claim success,
          // and never claim that nothing changed.
          return { kind: "FAILED", failure: storageFailure("DELETE_DATASET", "DATASET_DELETE_BLOCKED", now) };
        }
        dependencies.coordinator.announceDeleted();
        // Auxiliary local keys are cleared only after the database is gone.
        let localStateCleared = true;
        try {
          dependencies.clearLocalState();
        } catch {
          localStateCleared = false;
        }
        return { kind: "DELETED", localStateCleared };
      } catch (error) {
        return { kind: "FAILED", failure: normaliseStorageFailure("DELETE_DATASET", error, now) };
      } finally {
        release?.();
      }
    },
  });
}
