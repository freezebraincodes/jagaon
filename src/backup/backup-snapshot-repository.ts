import { isJournalSourceEventName, JOURNAL_DELETED_EVENT_PAYLOAD } from "@/application/journal/journal-stored-rows";
import { readDatasetTables } from "@/application/storage/integrity-gate";
import { HACKATHON_CLOSED_ROW_CODECS } from "@/application/storage/profile-row-codecs";
import { verifyDataset } from "@/storage/dataset-verifier";
import type { JagaOnDatabase } from "@/storage/database";
import { StorageOperationError } from "@/storage/storage-failure";
import type { DatabaseIdentityRow } from "@/storage/storage-metadata";
import { BackupCanonicalisationError, canonicaliseBackupTable } from "./backup-canonicalisation";
import { BACKUP_TABLE_NAMES_V1, type BackupTableSetV1 } from "./backup-payload-v1";

/**
 * One consistent, fully validated read-only snapshot for export (storage-
 * backup-spec 7.5; BAK-001–BAK-003, BAK-014). All 16 tables are read in one
 * IndexedDB read transaction, so a concurrent commit is wholly before or
 * after it. Every row passes its closed codec and the dataset closure is
 * verified before anything is serialised. Export performs no write.
 */

export type ValidatedBackupSnapshot = {
  identity: DatabaseIdentityRow;
  eventSequenceHighWaterMark: number;
  tables: BackupTableSetV1;
};

export type BackupSnapshotRepository = { readValidatedSnapshot(): Promise<ValidatedBackupSnapshot> };

function isRedacted(payload: unknown): boolean {
  return typeof payload === "object" && payload !== null && Object.keys(payload).length === 1 && (payload as { reasonCode?: unknown }).reasonCode === JOURNAL_DELETED_EVENT_PAYLOAD.reasonCode;
}

export function createBackupSnapshotRepository(database: JagaOnDatabase): BackupSnapshotRepository {
  return Object.freeze({
    async readValidatedSnapshot(): Promise<ValidatedBackupSnapshot> {
      const all = await readDatasetTables(database);
      const verification = verifyDataset(all, HACKATHON_CLOSED_ROW_CODECS);
      if (verification.kind === "FAILED") throw new StorageOperationError("BACKUP_VALIDATION_FAILED", { tableName: verification.tableName });

      // Deleted content can never re-enter a backup (spec 6.7; BAK-014).
      const tombstoned = new Set((all.deletionTombstones as Array<{ recordId: string }>).map((row) => row.recordId));
      for (const event of all.domainEvents as Array<{ eventName: string; change: { recordId: string }; payload: unknown }>) {
        if (tombstoned.has(event.change.recordId) && isJournalSourceEventName(event.eventName) && !isRedacted(event.payload)) {
          throw new StorageOperationError("BACKUP_VALIDATION_FAILED", { tableName: "domainEvents" });
        }
      }

      const metadata = all.storageMetadata as Array<{ key: string }>;
      const identity = metadata.find((row) => row.key === "DATABASE_IDENTITY") as DatabaseIdentityRow | undefined;
      if (!identity) throw new StorageOperationError("BACKUP_VALIDATION_FAILED", { tableName: "storageMetadata" });
      const restore = metadata.find((row) => row.key === "RESTORE_STATE") as { phase: string } | undefined;
      if (restore && ["COMMITTING", "RECONCILING", "FAILED_BLOCKING"].includes(restore.phase)) {
        throw new StorageOperationError("BACKUP_VALIDATION_FAILED", { tableName: "storageMetadata" });
      }

      try {
        const tables = Object.fromEntries(BACKUP_TABLE_NAMES_V1.map((name) => [name, canonicaliseBackupTable(name, all[name])])) as BackupTableSetV1;
        return { identity, eventSequenceHighWaterMark: verification.eventSequenceHighWaterMark, tables };
      } catch (error) {
        if (error instanceof BackupCanonicalisationError) throw new StorageOperationError("BACKUP_VALIDATION_FAILED", error.tableName ? { tableName: error.tableName } : {});
        throw error;
      }
    },
  });
}
