import { StorageOperationError } from "@/storage/storage-failure";
import { BACKUP_SCHEMA_VERSION } from "./backup-payload-v1";

/**
 * Closed, pure, in-memory backup-payload migration registry (storage-backup-
 * spec 8.4; RST-008, RST-009). Version 1 is the first payload schema, so the
 * compiled registry is empty. A migration may only transform the decrypted
 * payload in memory before the live database changes; its output passes the
 * same complete current validation. Newer or unknown versions fail closed.
 */

export type BackupPayloadMigration = {
  migrationId: string;
  fromBackupSchemaVersion: number;
  toBackupSchemaVersion: number;
  /** Pure and deterministic: no clock, randomness, network or storage. */
  migrate(payload: Readonly<Record<string, unknown>>): Record<string, unknown>;
};

export const BACKUP_PAYLOAD_MIGRATIONS: readonly BackupPayloadMigration[] = Object.freeze([]);

export function migrateBackupPayload(
  payload: Record<string, unknown>,
  registry: readonly BackupPayloadMigration[] = BACKUP_PAYLOAD_MIGRATIONS,
  target: number = BACKUP_SCHEMA_VERSION,
): { payload: Record<string, unknown>; appliedMigrationIds: string[] } {
  let version = payload.backupSchemaVersion;
  if (typeof version !== "number" || !Number.isSafeInteger(version)) throw new StorageOperationError("BACKUP_PAYLOAD_INVALID");
  if (version > target) throw new StorageOperationError("BACKUP_VERSION_UNSUPPORTED", { storedVersion: version, supportedVersion: target });
  let current = payload;
  const applied: string[] = [];
  while (version < target) {
    const steps = registry.filter((entry) => entry.fromBackupSchemaVersion === version);
    if (steps.length !== 1 || steps[0]!.toBackupSchemaVersion !== version + 1) {
      throw new StorageOperationError("BACKUP_VERSION_UNSUPPORTED", { storedVersion: version, supportedVersion: target });
    }
    current = steps[0]!.migrate(Object.freeze({ ...current }));
    if (current.backupSchemaVersion !== version + 1) throw new StorageOperationError("BACKUP_PAYLOAD_INVALID");
    applied.push(steps[0]!.migrationId);
    version += 1;
  }
  return { payload: current, appliedMigrationIds: applied };
}
