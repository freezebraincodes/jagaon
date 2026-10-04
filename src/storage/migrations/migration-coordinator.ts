import Dexie, { type Transaction } from "dexie";
import type { Instant } from "@/domain/shared/time";
import { validateClosedStoredRow, type ClosedRowCodecRegistry } from "../closed-row-codecs";
import { createJagaOnDatabase, type JagaOnDatabase } from "../database";
import { normaliseStorageFailure, storageFailure, StorageOperationError, type StorageOperationFailure } from "../storage-failure";
import {
  createStorageMetadataRepository,
  databaseIdentityRow,
  localStateCleanupPendingRow,
  LOGICAL_STORAGE_SCHEMA_VERSION,
  type DatabaseIdentityRow,
  type MigrationPhase,
  type RestoreStateRow,
} from "../storage-metadata";
import { StorageRowValidationError } from "../storage-row-codec";
import { JAGAON_DEXIE_VERSION, JAGAON_TABLE_NAMES } from "../table-catalogue";
import type { MigrationFaultPoint, RegisteredStorageMigration } from "./migration-contracts";
import { resolveMigrationChain, STORAGE_MIGRATION_REGISTRY, verifyMigrationRegistry } from "./migration-registry";

/**
 * Forward-only open and migration coordinator (storage-backup-spec 5.1–5.8,
 * 9.3–9.4; Packet 10 freeze Sections 5–7).
 *
 * 1. Preflight reads only the physical version (and, for a legacy database,
 *    validates every row read-only) without performing domain work.
 * 2. The exact contiguous chain is resolved from the closed registry.
 * 3. IndexedDB's exclusive version change is the only upgrade boundary; a
 *    tab that keeps its connection blocks it and nothing is upgraded.
 * 4. The new logical version becomes visible only after in-transaction
 *    verification; any failure aborts and keeps the last committed version.
 *
 * A newer physical or logical database is never opened for domain use and is
 * left untouched. Migration failures are reported, not persisted (freeze 7).
 */

export type DatasetLifecycle = "CREATED" | "MIGRATED" | "EXISTING";

export type DatasetOpenPorts = {
  now(): Instant;
  newDatasetIdentity(): string;
  closedRowCodecs: ClosedRowCodecRegistry;
  /** How long a blocking tab may hold the version change before we report it. */
  blockedTimeoutMs?: number;
  /** Test-only overrides. */
  registry?: readonly RegisteredStorageMigration[];
  fault?: MigrationFaultPoint;
  onPhase?(phase: MigrationPhase): void;
  /**
   * Corrective Pass C: when this open creates the dataset, write
   * LOCAL_STATE_CLEANUP_PENDING in the same transaction as the identity, so the
   * new dataset can never exist without it. Ignored for an existing dataset.
   */
  localStateCleanupPendingOnCreate?: Instant;
};

export type DatasetOpenResult =
  | {
      kind: "OPENED";
      database: JagaOnDatabase;
      identity: DatabaseIdentityRow;
      lifecycle: DatasetLifecycle;
      appliedMigrationIds: string[];
      /** Explicit recomputation commands required after open (none in the registry). */
      recomputationRequired: string[];
      restoreState: RestoreStateRow | null;
    }
  /** `attemptedCreate`: this open was creating the dataset, which therefore does not exist. */
  | { kind: "FAILED"; failure: StorageOperationFailure; attemptedCreate?: true };

export type MigrationPreflight =
  | { kind: "CREATE" }
  | { kind: "OPEN" }
  | { kind: "MIGRATE"; chain: RegisteredStorageMigration[] }
  | { kind: "UNSUPPORTED"; storedVersion: number };

const DEFAULT_BLOCKED_TIMEOUT_MS = 4_000;

/** Unwraps Dexie's open/upgrade wrappers to our own closed error, when present. */
function innermost(error: unknown): unknown {
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (current instanceof StorageOperationError || current instanceof StorageRowValidationError) return current;
    const inner = (current as { inner?: unknown } | null)?.inner;
    if (inner === undefined || inner === null) return current;
    current = inner;
  }
  return current;
}

async function physicalVersion(name: string): Promise<number | null> {
  if (!(await Dexie.exists(name))) return null;
  const probe = new Dexie(name, { autoOpen: false });
  try {
    await probe.open();
    return probe.verno;
  } finally {
    probe.close();
  }
}

async function validateLegacyRowsReadOnly(name: string, registry: ClosedRowCodecRegistry): Promise<void> {
  const probe = new Dexie(name, { autoOpen: false });
  try {
    await probe.open();
    const present = new Set(probe.tables.map((table) => table.name));
    for (const table of JAGAON_TABLE_NAMES) {
      if (!present.has(table)) throw new StorageOperationError("MIGRATION_VALIDATION_FAILED", { tableName: table });
      for (const row of await probe.table(table).toArray()) validateClosedStoredRow(registry, table, row);
    }
    if (probe.tables.length !== JAGAON_TABLE_NAMES.length) throw new StorageOperationError("MIGRATION_VALIDATION_FAILED");
  } catch (error) {
    if (error instanceof StorageRowValidationError) throw new StorageOperationError("MIGRATION_VALIDATION_FAILED", { tableName: error.table });
    throw error;
  } finally {
    probe.close();
  }
}

export async function verifyAllRowsInTransaction(transaction: Transaction, registry: ClosedRowCodecRegistry): Promise<void> {
  for (const table of JAGAON_TABLE_NAMES) {
    for (const row of await transaction.table(table).toArray()) {
      try {
        validateClosedStoredRow(registry, table, row);
      } catch {
        throw new StorageOperationError("MIGRATION_VALIDATION_FAILED", { tableName: table });
      }
    }
  }
}

export function createMigrationCoordinator(name: string, ports: DatasetOpenPorts) {
  const registry = ports.registry ?? STORAGE_MIGRATION_REGISTRY;

  async function preflight(): Promise<MigrationPreflight> {
    await verifyMigrationRegistry(registry);
    const version = await physicalVersion(name);
    if (version === null) return { kind: "CREATE" };
    if (!Number.isSafeInteger(version) || version < 1) throw new StorageOperationError("MIGRATION_CHAIN_UNAVAILABLE", { storedVersion: version });
    if (version > JAGAON_DEXIE_VERSION) return { kind: "UNSUPPORTED", storedVersion: version };
    if (version === JAGAON_DEXIE_VERSION) return { kind: "OPEN" };
    // A Dexie 1 database predates the identity: logical 0 is only the chain's source label.
    return { kind: "MIGRATE", chain: resolveMigrationChain(registry, { dexie: version, logical: 0 }) };
  }

  async function openWithBlockDetection(database: JagaOnDatabase): Promise<"OPENED" | "BLOCKED"> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const blocked = new Promise<"BLOCKED">((resolve) => {
      database.on("blocked", () => {
        timer ??= setTimeout(() => resolve("BLOCKED"), ports.blockedTimeoutMs ?? DEFAULT_BLOCKED_TIMEOUT_MS);
      });
    });
    try {
      const outcome = await Promise.race([database.open().then(() => "OPENED" as const), blocked]);
      if (outcome === "BLOCKED") database.close();
      return outcome;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function run(): Promise<DatasetOpenResult> {
    const at = ports.now();
    let plan: MigrationPreflight;
    try {
      ports.onPhase?.("PREPARING");
      plan = await preflight();
    } catch (error) {
      return { kind: "FAILED", failure: normaliseStorageFailure("MIGRATE", innermost(error), at) };
    }
    if (plan.kind === "UNSUPPORTED") {
      return { kind: "FAILED", failure: storageFailure("OPEN", "DATABASE_VERSION_UNSUPPORTED", at, { storedVersion: plan.storedVersion, supportedVersion: JAGAON_DEXIE_VERSION }) };
    }

    const datasetIdentity = plan.kind === "OPEN" ? null : ports.newDatasetIdentity();
    if (plan.kind === "MIGRATE") {
      try {
        await validateLegacyRowsReadOnly(name, ports.closedRowCodecs);
      } catch (error) {
        return { kind: "FAILED", failure: normaliseStorageFailure("MIGRATE", innermost(error), at) };
      }
    }

    // The marker is validated before creation, so populate only issues plain adds:
    // both rows commit with the creating version change or neither does.
    let cleanupMarker: ReturnType<typeof localStateCleanupPendingRow> | null = null;
    if (plan.kind === "CREATE" && ports.localStateCleanupPendingOnCreate !== undefined) {
      try {
        cleanupMarker = localStateCleanupPendingRow(ports.localStateCleanupPendingOnCreate);
      } catch (error) {
        return { kind: "FAILED", failure: normaliseStorageFailure("OPEN", innermost(error), at), attemptedCreate: true };
      }
    }

    const chain = plan.kind === "MIGRATE" ? plan.chain : [];
    const database = createJagaOnDatabase(name, {
      populate:
        plan.kind === "CREATE"
          ? async (transaction) => {
              await transaction.table("storageMetadata").add(databaseIdentityRow({ datasetIdentity: datasetIdentity!, createdAt: at }) as never);
              if (cleanupMarker) await transaction.table("storageMetadata").add(cleanupMarker as never);
            }
          : undefined,
      upgradeFromLegacy:
        plan.kind === "MIGRATE"
          ? async (transaction) => {
              ports.onPhase?.("RUNNING");
              for (const migration of chain) {
                await migration.transform({
                  transaction,
                  inputs: { datasetIdentity: datasetIdentity!, at },
                  fault: ports.fault,
                  verifyAllRows: async (tx) => {
                    ports.onPhase?.("VERIFYING");
                    await verifyAllRowsInTransaction(tx, ports.closedRowCodecs);
                  },
                });
              }
            }
          : undefined,
    });

    const operation = plan.kind === "MIGRATE" ? "MIGRATE" : "OPEN";
    try {
      const outcome = await openWithBlockDetection(database);
      if (outcome === "BLOCKED") {
        return { kind: "FAILED", failure: storageFailure(operation, plan.kind === "MIGRATE" ? "MIGRATION_BLOCKED_BY_OTHER_TAB" : "DATABASE_BLOCKED_BY_OTHER_TAB", at) };
      }
    } catch (error) {
      database.close();
      ports.onPhase?.("FAILED_BLOCKING");
      return { kind: "FAILED", failure: normaliseStorageFailure(operation, innermost(error), at), ...(plan.kind === "CREATE" ? { attemptedCreate: true as const } : {}) };
    }

    try {
      const metadata = createStorageMetadataRepository(database);
      const identity = await metadata.readIdentity();
      if (identity === null) throw new StorageOperationError("STORAGE_INTEGRITY_FAILED", { tableName: "storageMetadata" });
      if (identity.logicalStorageSchemaVersion > LOGICAL_STORAGE_SCHEMA_VERSION) {
        throw new StorageOperationError("DATABASE_VERSION_UNSUPPORTED", {
          storedVersion: identity.logicalStorageSchemaVersion,
          supportedVersion: LOGICAL_STORAGE_SCHEMA_VERSION,
        });
      }
      if (identity.logicalStorageSchemaVersion < LOGICAL_STORAGE_SCHEMA_VERSION) {
        throw new StorageOperationError("MIGRATION_CHAIN_UNAVAILABLE", { storedVersion: identity.logicalStorageSchemaVersion, supportedVersion: LOGICAL_STORAGE_SCHEMA_VERSION });
      }
      const restoreState = await metadata.readRestoreState();
      ports.onPhase?.(plan.kind === "MIGRATE" ? "COMPLETED" : "IDLE");
      return {
        kind: "OPENED",
        database,
        identity,
        lifecycle: plan.kind === "CREATE" ? "CREATED" : plan.kind === "MIGRATE" ? "MIGRATED" : "EXISTING",
        appliedMigrationIds: chain.map((migration) => migration.definition.migrationId),
        recomputationRequired: chain.filter((migration) => migration.definition.requiresExplicitRecomputation).map((migration) => migration.definition.migrationId),
        restoreState,
      };
    } catch (error) {
      database.close();
      return { kind: "FAILED", failure: normaliseStorageFailure("OPEN", innermost(error), at) };
    }
  }

  return Object.freeze({ preflight, run });
}
