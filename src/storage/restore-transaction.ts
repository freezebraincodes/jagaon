import type { Instant } from "@/domain/shared/time";
import { createKeepWordingPreferenceRow, KEEP_WORDING_PREFERENCE_KEY } from "./app-preference-row";
import type { ClosedRowCodecRegistry } from "./closed-row-codecs";
import type { JagaOnDatabase } from "./database";
import { StorageOperationError } from "./storage-failure";
import { currentLocalStateCleanupPending, databaseIdentityRow, restoreStateRowSchema, type RestoreMode } from "./storage-metadata";
import { JAGAON_TABLE_NAMES, type JagaOnTableName } from "./table-catalogue";

/**
 * Atomic dataset replacement (storage-backup-spec 8.6; RST-012–RST-015). One
 * read-write transaction over all 16 tables revalidates the exact current
 * fingerprint, clears the replaced dataset, inserts the validated target
 * rows, adopts the backup identity, continues the event sequence and writes
 * `RESTORE_STATE: RECONCILING` last. Either all of it commits or the previous
 * dataset is untouched. Preferences stay absent until reconciliation, except
 * (Packet 11C Addendum C, C2) the "Keep wording on this device" setting,
 * written here as the reviewed backup value OR the device's current value
 * (fix round 1, I-2: a restore never turns it off).
 *
 * Corrective Pass D: LOCAL_STATE_CLEANUP_PENDING is local operational
 * metadata, never part of a backup target. The exact current marker, bound to
 * the plan through the dataset fingerprint (which covers `storageMetadata`),
 * is carried through the replacement unchanged; none is ever created.
 */

export type RestoreCommitInput = {
  operationId: string;
  planHash: string;
  containerId: string;
  mode: RestoreMode;
  sourceBackupSchemaVersion: number;
  datasetIdentity: string;
  lastCompletedMigrationId?: string;
  expectedFingerprint: string;
  fingerprint(tables: Record<JagaOnTableName, unknown[]>): string;
  /** Re-validates the exact private commit target inside the write boundary. */
  validateTarget(): boolean;
  targetTables: Partial<Record<JagaOnTableName, readonly unknown[]>>;
  /**
   * Packet 11C Addendum C (C2): the backup's "Keep wording on this device" setting. Fix round 1 (I-2, coordinator ruling): the value
   * written is backup || the device's current value (read inside the transaction before clearing; unreadable counts as on), so a restore
   * never turns it off; on writes the one versioned row, off leaves none.
   */
  keepWordingOnDevice?: boolean;
  eventSequenceHighWaterMark: number;
  startedAt: Instant;
  committedAt: Instant;
};

export class RestoreStaleError extends Error {
  readonly name = "RestoreStaleError";
  constructor() {
    super("Restore plan is stale");
  }
}

export async function commitRestore(database: JagaOnDatabase, input: RestoreCommitInput, registry: ClosedRowCodecRegistry): Promise<void> {
  const tables = JAGAON_TABLE_NAMES.map((name) => database.table(name));
  // Validate every target row for write before the transaction opens; the
  // validated objects themselves are written, so nothing else can be inserted.
  const rows = Object.fromEntries(
    JAGAON_TABLE_NAMES.filter((name) => name !== "storageMetadata" && name !== "appPreferences").map((name) => [
      name,
      (input.targetTables[name] ?? []).map((row) => {
        registry[name].validateForWrite(row);
        return row;
      }),
    ]),
  ) as Record<JagaOnTableName, unknown[]>;
  const metadata = [
    registry.storageMetadata.validateForWrite(
      databaseIdentityRow({ datasetIdentity: input.datasetIdentity, createdAt: input.committedAt, lastCompletedMigrationId: input.lastCompletedMigrationId }),
    ),
    registry.storageMetadata.validateForWrite({ key: "EVENT_SEQUENCE_HIGH_WATER_MARK", lastAllocatedSequence: input.eventSequenceHighWaterMark, updatedAt: input.committedAt }),
  ];
  // Packet 11C Addendum C (C2): the patient's setting; the language projection stays absent until reconciliation. Validated before the
  // transaction; whether it is written is decided inside it (fix round 1, I-2: backup || device).
  const keepWordingRow = registry.appPreferences.validateForWrite(createKeepWordingPreferenceRow(true, input.committedAt));
  const restoreState = restoreStateRowSchema.parse({
    key: "RESTORE_STATE",
    phase: "RECONCILING",
    operationId: input.operationId,
    containerId: input.containerId,
    restoreMode: input.mode,
    planHash: input.planHash,
    sourceBackupSchemaVersion: Math.max(1, input.sourceBackupSchemaVersion),
    targetLogicalStorageSchemaVersion: 1,
    startedAt: input.startedAt,
    committedAt: input.committedAt,
    lastCompletedStep: "COMMITTED",
  });

  await database.transaction("rw", tables, async () => {
    // 1. Revalidate the exact current dataset inside the write boundary.
    const current = Object.fromEntries(await Promise.all(JAGAON_TABLE_NAMES.map(async (name) => [name, await database.table(name).toArray()] as const))) as Record<JagaOnTableName, unknown[]>;
    if (input.fingerprint(current) !== input.expectedFingerprint) throw new RestoreStaleError();
    if (!input.validateTarget()) throw new RestoreStaleError();
    const activeRestore = (current.storageMetadata as Array<{ key: string; phase?: string }>).find((row) => row.key === "RESTORE_STATE");
    if (activeRestore && ["COMMITTING", "RECONCILING"].includes(activeRestore.phase ?? "")) throw new StorageOperationError("RESTORE_COMMIT_FAILED");
    // Read through the strict codec before anything is cleared; a malformed marker aborts the restore.
    let cleanupPending: ReturnType<typeof currentLocalStateCleanupPending>;
    try {
      cleanupPending = currentLocalStateCleanupPending(current.storageMetadata);
    } catch {
      throw new StorageOperationError("STORAGE_INTEGRITY_FAILED", { tableName: "storageMetadata" });
    }
    // C2 fix round 1 (I-2, coordinator ruling): a restore never turns "Keep wording on this device" off. The device's current value is
    // read before anything is cleared (no row: off; a row that does not validate: on) and combined with the backup's: backup || device.
    const deviceRow = (current.appPreferences as Array<{ key?: unknown }>).find((row) => row.key === KEEP_WORDING_PREFERENCE_KEY);
    let deviceKeepsWording = false;
    if (deviceRow !== undefined) {
      try {
        deviceKeepsWording = (registry.appPreferences.validateAfterRead(deviceRow) as { value: unknown }).value === true;
      } catch {
        deviceKeepsWording = true;
      }
    }
    const keepWording = input.keepWordingOnDevice === true || deviceKeepsWording;

    // 2. Clear every row of the replaced dataset, including projections and preferences.
    for (const name of JAGAON_TABLE_NAMES) await database.table(name).clear();
    // 3–4. Insert the validated target rows (heads were verified against revision chains).
    for (const name of JAGAON_TABLE_NAMES) {
      const tableRows = rows[name];
      if (tableRows && tableRows.length > 0) await database.table(name).bulkAdd(tableRows as never[]);
    }
    // Packet 11C Addendum C (C2): the "Keep wording on this device" row only when on (backup || device); no row is off.
    if (keepWording) await database.table("appPreferences").put(keepWordingRow as never);
    // 5–6. Adopt the backup identity and continue the sequence.
    for (const row of metadata) await database.table("storageMetadata").put(row as never);
    // The local cleanup marker survives the replacement exactly as it was.
    if (cleanupPending) await database.table("storageMetadata").put(cleanupPending as never);
    // 9. RECONCILING is the last required restore-state effect.
    await database.table("storageMetadata").put(restoreState as never);
  });
}
