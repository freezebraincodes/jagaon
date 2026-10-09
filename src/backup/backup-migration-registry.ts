import { StorageOperationError } from "@/storage/storage-failure";
import { BACKUP_SCHEMA_VERSION, BACKUP_SCHEMA_VERSION_V1 } from "./backup-payload-v1";

/**
 * Closed, pure, in-memory backup-payload migration registry (storage-backup-
 * spec 8.4; RST-008, RST-009). A migration may only transform the decrypted
 * payload in memory before the live database changes; its output passes the
 * same complete current validation. Newer or unknown versions fail closed.
 *
 * Packet 11C Addendum C, Task C2: version 2 adds the closed `patientSettings`
 * (the "Keep wording on this device" setting), so the compiled registry has
 * exactly one step, 1 → 2. A version 1 payload never carried the setting: the
 * step adds it as off (hybrid spec D11 default), and refuses a version 1
 * payload that claims to carry one rather than overwrite it silently.
 */

export type BackupPayloadMigration = {
  migrationId: string;
  fromBackupSchemaVersion: number;
  toBackupSchemaVersion: number;
  /** Pure and deterministic: no clock, randomness, network or storage. */
  migrate(payload: Readonly<Record<string, unknown>>): Record<string, unknown>;
};

/** Packet 11C Addendum C (C2): version 1 → 2, the patient settings with "Keep wording on this device" off. */
const V1_TO_V2_PATIENT_SETTINGS: BackupPayloadMigration = Object.freeze({
  migrationId: "jagaon.backup.0001-patient-settings",
  fromBackupSchemaVersion: BACKUP_SCHEMA_VERSION_V1,
  toBackupSchemaVersion: BACKUP_SCHEMA_VERSION,
  migrate(payload: Readonly<Record<string, unknown>>): Record<string, unknown> {
    if (Object.prototype.hasOwnProperty.call(payload, "patientSettings")) throw new StorageOperationError("BACKUP_PAYLOAD_INVALID");
    return { ...payload, backupSchemaVersion: BACKUP_SCHEMA_VERSION, patientSettings: { keepWordingOnDevice: false } };
  },
});

export const BACKUP_PAYLOAD_MIGRATIONS: readonly BackupPayloadMigration[] = Object.freeze([V1_TO_V2_PATIENT_SETTINGS]);

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
