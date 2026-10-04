import type { Instant } from "@/domain/shared/time";
import { CommandTransactionError } from "@/storage/authoritative-command-transaction";
import { verifyDataset } from "@/storage/dataset-verifier";
import type { JagaOnDatabase } from "@/storage/database";
import { createMigrationCoordinator, type DatasetLifecycle } from "@/storage/migrations/migration-coordinator";
import { storageFailure, StorageOperationError, STORAGE_FAILURE_REGISTRY, type StorageOperationFailure } from "@/storage/storage-failure";
import type { DatabaseIdentityRow, RestoreStateRow } from "@/storage/storage-metadata";
import { StorageRowValidationError } from "@/storage/storage-row-codec";
import { JAGAON_TABLE_NAMES, type JagaOnTableName } from "@/storage/table-catalogue";
import { HACKATHON_CLOSED_ROW_CODECS } from "./profile-row-codecs";

/**
 * Packet 10A integrity gate (storage-backup-spec 5.4–5.8 and 9.4).
 *
 * The dataset opens only through the migration coordinator and the closed
 * verification set. A failure yields a closed lock state; the runtime then
 * exposes no authoritative write, engine, notification, ordinary work or AI
 * path. Later integrity failures during use lock the same gate. The lock is
 * held in memory and recomputed on every launch (freeze Section 7).
 */

export const STORAGE_LOCK_KINDS = Object.freeze(["INTEGRITY_LOCKED", "MIGRATION_BLOCKED", "NEWER_DATABASE", "STORAGE_UNAVAILABLE", "RECOVERY_REQUIRED"] as const);
export type StorageLockKind = (typeof STORAGE_LOCK_KINDS)[number];
export type StorageLockState = Readonly<{ kind: StorageLockKind; failure: StorageOperationFailure }>;

export function lockKindFor(failure: StorageOperationFailure): StorageLockKind {
  switch (failure.errorCode) {
    case "DATABASE_VERSION_UNSUPPORTED":
    case "MIGRATION_CHAIN_UNAVAILABLE":
      return "NEWER_DATABASE";
    case "DATABASE_BLOCKED_BY_OTHER_TAB":
    case "MIGRATION_BLOCKED_BY_OTHER_TAB":
      return "MIGRATION_BLOCKED";
    case "BROWSER_STORAGE_UNSUPPORTED":
    case "DATABASE_OPEN_FAILED":
    case "STORAGE_QUOTA_EXCEEDED":
      return "STORAGE_UNAVAILABLE";
    case "RESTORE_RECONCILIATION_FAILED":
      return "RECOVERY_REQUIRED";
    default:
      return "INTEGRITY_LOCKED";
  }
}

export function lockStateFor(failure: StorageOperationFailure): StorageLockState {
  return Object.freeze({ kind: lockKindFor(failure), failure });
}

export type VerifiedDatasetOpen =
  | { kind: "READY"; database: JagaOnDatabase; identity: DatabaseIdentityRow; lifecycle: DatasetLifecycle; restoreState: RestoreStateRow | null }
  | { kind: "LOCKED"; lock: StorageLockState; attemptedCreate?: true };

export async function readDatasetTables(database: JagaOnDatabase): Promise<Record<JagaOnTableName, unknown[]>> {
  return database.transaction("r", JAGAON_TABLE_NAMES.map((table) => database.table(table)), async () => {
    const entries: Array<[JagaOnTableName, unknown[]]> = [];
    for (const table of JAGAON_TABLE_NAMES) entries.push([table, await database.table(table).toArray()]);
    return Object.fromEntries(entries) as Record<JagaOnTableName, unknown[]>;
  });
}

/** Opens, migrates if required, and verifies the complete closed dataset. */
export async function openVerifiedDataset(
  name: string,
  ports: { now(): Instant; newDatasetIdentity(): string; blockedTimeoutMs?: number; localStateCleanupPendingOnCreate?: Instant },
): Promise<VerifiedDatasetOpen> {
  const opened = await createMigrationCoordinator(name, { ...ports, closedRowCodecs: HACKATHON_CLOSED_ROW_CODECS }).run();
  if (opened.kind === "FAILED") return { kind: "LOCKED", lock: lockStateFor(opened.failure), ...(opened.attemptedCreate ? { attemptedCreate: true as const } : {}) };
  try {
    const verification = verifyDataset(await readDatasetTables(opened.database), HACKATHON_CLOSED_ROW_CODECS);
    if (verification.kind === "FAILED") {
      opened.database.close();
      return {
        kind: "LOCKED",
        lock: lockStateFor(storageFailure("OPEN", "STORAGE_INTEGRITY_FAILED", ports.now(), { tableName: verification.tableName, governedReasonCodes: [verification.invariant] })),
      };
    }
  } catch {
    opened.database.close();
    return { kind: "LOCKED", lock: lockStateFor(storageFailure("OPEN", "STORAGE_INTEGRITY_FAILED", ports.now())) };
  }
  return { kind: "READY", database: opened.database, identity: opened.identity, lifecycle: opened.lifecycle, restoreState: opened.restoreState };
}

/** Thrown by a guarded port once the gate is locked; carries only the closed lock. */
export class IntegrityLockedError extends Error {
  readonly name = "IntegrityLockedError";
  constructor(readonly lock: StorageLockState) {
    super(lock.kind);
  }
}

function integrityFailureOf(error: unknown, now: Instant): StorageOperationFailure | null {
  if (error instanceof StorageRowValidationError && error.boundary === "READ") {
    return storageFailure("READ", "STORAGE_INTEGRITY_FAILED", now, { tableName: error.table });
  }
  if (error instanceof CommandTransactionError && error.code === "STORAGE_INTEGRITY_FAILED") return storageFailure("COMMAND_COMMIT", "STORAGE_INTEGRITY_FAILED", now);
  if (error instanceof StorageOperationError && ["INTEGRITY", "CORRUPTION"].includes(STORAGE_FAILURE_REGISTRY[error.code].storageClass)) {
    return storageFailure("READ", error.code, now, error.context);
  }
  return null;
}

export type IntegrityGate = {
  current(): StorageLockState | null;
  lock(lock: StorageLockState): void;
  subscribe(listener: (lock: StorageLockState) => void): () => void;
  /** Rejects when locked; locks on an integrity failure raised by `operation`. */
  run<T>(operation: () => Promise<T>): Promise<T>;
  /** Wraps every function of a port object (recursively) with `run`. */
  guard<T extends object>(port: T): T;
};

export function createIntegrityGate(now: () => Instant): IntegrityGate {
  let state: StorageLockState | null = null;
  const listeners = new Set<(lock: StorageLockState) => void>();

  function lock(next: StorageLockState) {
    if (state) return;
    state = next;
    for (const listener of listeners) listener(next);
  }

  async function run<T>(operation: () => Promise<T>): Promise<T> {
    if (state) throw new IntegrityLockedError(state);
    try {
      return await operation();
    } catch (error) {
      const failure = integrityFailureOf(error, now());
      if (failure) {
        lock(lockStateFor(failure));
        throw new IntegrityLockedError(state!);
      }
      throw error;
    }
  }

  function guard<T extends object>(port: T): T {
    const wrapped: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(port)) {
      if (typeof value === "function") wrapped[key] = (...args: unknown[]) => run(() => Promise.resolve((value as (...a: unknown[]) => unknown).apply(port, args)));
      else if (value && typeof value === "object" && !Array.isArray(value)) wrapped[key] = guard(value as object);
      else wrapped[key] = value;
    }
    return Object.freeze(wrapped) as T;
  }

  return Object.freeze({
    current: () => state,
    lock,
    subscribe(listener: (lock: StorageLockState) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    run,
    guard,
  });
}
