import type { Instant } from "@/domain/shared/time";
import { CommandTransactionError } from "./authoritative-command-transaction";
import { StorageRowValidationError } from "./storage-row-codec";
import { JAGAON_TABLE_NAMES, type JagaOnTableName } from "./table-catalogue";

/**
 * Closed storage failure model (storage-backup-spec Sections 9.1–9.3).
 *
 * A storage operation returns one closed failure. The failure carries no
 * record payload, entered value, passphrase, cryptographic material, filename,
 * provider payload or raw exception text; `normaliseStorageFailure` discards
 * whatever it was given after reading only its closed type or name.
 */

export const STORAGE_OPERATIONS = Object.freeze([
  "OPEN",
  "READ",
  "COMMAND_COMMIT",
  "WORK_CLAIM",
  "WORK_COMPLETE",
  "MIGRATE",
  "DELETE_RECORD",
  "DELETE_DATASET",
  "EXPORT_BACKUP",
  "RESTORE_BACKUP",
  "RESTORE_RECONCILE",
] as const);
export type StorageOperation = (typeof STORAGE_OPERATIONS)[number];

export const STORAGE_FAILURE_CLASSES = Object.freeze([
  "CAPABILITY",
  "VALIDATION",
  "CONCURRENCY",
  "QUOTA",
  "TRANSACTION",
  "MIGRATION",
  "CRYPTOGRAPHY",
  "BACKUP_FORMAT",
  "COMPATIBILITY",
  "INTEGRITY",
  "CORRUPTION",
] as const);
export type StorageFailureClass = (typeof STORAGE_FAILURE_CLASSES)[number];

/** Shared event-contract types (event-contracts-spec Section 13.1). */
export type FailureCategory =
  | "INPUT"
  | "AUTHORISATION"
  | "CONCURRENCY"
  | "DEPENDENCY"
  | "GOVERNED_CONFIGURATION"
  | "STORAGE"
  | "INTEGRITY"
  | "RUNTIME";

export type RetryClass =
  | "DO_NOT_RETRY"
  | "RETRY_AFTER_REFRESH"
  | "BOUNDED_AUTOMATIC_RETRY"
  | "PATIENT_ACTION_REQUIRED"
  | "APPLICATION_UPDATE_REQUIRED";

export const STORAGE_FAILURE_CODES = Object.freeze([
  "BROWSER_STORAGE_UNSUPPORTED",
  "DATABASE_OPEN_FAILED",
  "DATABASE_VERSION_UNSUPPORTED",
  "DATABASE_BLOCKED_BY_OTHER_TAB",
  "STORAGE_VALIDATION_FAILED",
  "STORAGE_TRANSACTION_ABORTED",
  "STORAGE_QUOTA_EXCEEDED",
  "STORAGE_INTEGRITY_FAILED",
  "STORAGE_CORRUPTION_DETECTED",
  "MIGRATION_CHAIN_UNAVAILABLE",
  "MIGRATION_BLOCKED_BY_OTHER_TAB",
  "MIGRATION_VALIDATION_FAILED",
  "MIGRATION_REPAIR_REQUIRED",
  "DELETION_CONFIRMATION_STALE",
  "DELETION_COMMIT_FAILED",
  "DATASET_DELETE_BLOCKED",
  "SECURE_CONTEXT_REQUIRED",
  "BACKUP_CRYPTO_UNAVAILABLE",
  "BACKUP_VALIDATION_FAILED",
  "BACKUP_TOO_LARGE_FOR_FORMAT_V1",
  "BACKUP_ENCRYPTION_FAILED",
  "BACKUP_FILE_UNSUPPORTED",
  "BACKUP_VERSION_UNSUPPORTED",
  "BACKUP_KDF_UNSUPPORTED",
  "BACKUP_AUTHENTICATION_FAILED",
  "BACKUP_PAYLOAD_INVALID",
  "BACKUP_LINEAGE_MISMATCH",
  "RESTORE_CONFIRMATION_STALE",
  "RESTORE_RUNTIME_UNAVAILABLE",
  "RESTORE_COMMIT_FAILED",
  "RESTORE_RECONCILIATION_FAILED",
] as const);
export type StorageFailureCode = (typeof STORAGE_FAILURE_CODES)[number];

/**
 * Closed Packet 10 message keys. Each resolves to one approved row of
 * `10-bilingual-copy-matrix.md` (or the Packet 6 shared storage rows) in both
 * locales; UI code never concatenates exception text.
 */
export const STORAGE_FAILURE_MESSAGE_KEYS = Object.freeze([
  "shared.storageUnavailable",
  "shared.notSaved",
  "packet10.shared.recordsUnchanged",
  "packet10.integrity.integrityBody",
  "packet10.integrity.migrationBlocked",
  "packet10.integrity.newerDatabase",
  "packet10.deletion.deletionChanged",
  "packet10.deletion.deleteBlocked",
  "packet10.backup.backupFailed",
  "packet10.backup.backupTooLarge",
  "packet10.restore.authenticationFailed",
  "packet10.restore.unsupportedVersion",
  "packet10.restore.differentDataset",
  "packet10.restore.restoreFailed",
  "packet10.restore.recoveryRequired",
] as const);
export type StorageFailureMessageKey = (typeof STORAGE_FAILURE_MESSAGE_KEYS)[number];

/** Optional diagnostic fields; every failure also has the fixed core fields. */
export type StorageDiagnosticField = "operationId" | "tableName" | "storedVersion" | "supportedVersion";

export type StorageFailureRegistration = {
  category: FailureCategory;
  storageClass: StorageFailureClass;
  retryClass: RetryClass;
  userMessageKey: StorageFailureMessageKey;
  permittedDiagnostics: readonly StorageDiagnosticField[];
};

const OP: readonly StorageDiagnosticField[] = ["operationId"];
const TABLE: readonly StorageDiagnosticField[] = ["operationId", "tableName"];
const VERSION: readonly StorageDiagnosticField[] = ["operationId", "storedVersion", "supportedVersion"];

function entry(
  category: FailureCategory,
  storageClass: StorageFailureClass,
  retryClass: RetryClass,
  userMessageKey: StorageFailureMessageKey,
  permittedDiagnostics: readonly StorageDiagnosticField[] = OP,
): StorageFailureRegistration {
  return Object.freeze({ category, storageClass, retryClass, userMessageKey, permittedDiagnostics: Object.freeze([...permittedDiagnostics]) });
}

export const STORAGE_FAILURE_REGISTRY: Readonly<Record<StorageFailureCode, StorageFailureRegistration>> = Object.freeze({
  BROWSER_STORAGE_UNSUPPORTED: entry("DEPENDENCY", "CAPABILITY", "DO_NOT_RETRY", "shared.storageUnavailable"),
  DATABASE_OPEN_FAILED: entry("STORAGE", "TRANSACTION", "PATIENT_ACTION_REQUIRED", "shared.storageUnavailable"),
  DATABASE_VERSION_UNSUPPORTED: entry("RUNTIME", "COMPATIBILITY", "APPLICATION_UPDATE_REQUIRED", "packet10.integrity.newerDatabase", VERSION),
  DATABASE_BLOCKED_BY_OTHER_TAB: entry("CONCURRENCY", "CONCURRENCY", "PATIENT_ACTION_REQUIRED", "packet10.integrity.migrationBlocked"),
  STORAGE_VALIDATION_FAILED: entry("STORAGE", "VALIDATION", "DO_NOT_RETRY", "shared.notSaved", TABLE),
  STORAGE_TRANSACTION_ABORTED: entry("STORAGE", "TRANSACTION", "BOUNDED_AUTOMATIC_RETRY", "shared.notSaved", TABLE),
  STORAGE_QUOTA_EXCEEDED: entry("STORAGE", "QUOTA", "PATIENT_ACTION_REQUIRED", "shared.notSaved"),
  STORAGE_INTEGRITY_FAILED: entry("INTEGRITY", "INTEGRITY", "DO_NOT_RETRY", "packet10.integrity.integrityBody", TABLE),
  STORAGE_CORRUPTION_DETECTED: entry("INTEGRITY", "CORRUPTION", "DO_NOT_RETRY", "packet10.integrity.integrityBody", TABLE),
  MIGRATION_CHAIN_UNAVAILABLE: entry("RUNTIME", "MIGRATION", "APPLICATION_UPDATE_REQUIRED", "packet10.integrity.newerDatabase", VERSION),
  MIGRATION_BLOCKED_BY_OTHER_TAB: entry("CONCURRENCY", "CONCURRENCY", "PATIENT_ACTION_REQUIRED", "packet10.integrity.migrationBlocked", VERSION),
  MIGRATION_VALIDATION_FAILED: entry("INTEGRITY", "MIGRATION", "DO_NOT_RETRY", "packet10.integrity.integrityBody", ["operationId", "tableName", "storedVersion", "supportedVersion"]),
  MIGRATION_REPAIR_REQUIRED: entry("INTEGRITY", "MIGRATION", "APPLICATION_UPDATE_REQUIRED", "packet10.integrity.integrityBody", VERSION),
  DELETION_CONFIRMATION_STALE: entry("CONCURRENCY", "CONCURRENCY", "RETRY_AFTER_REFRESH", "packet10.deletion.deletionChanged"),
  DELETION_COMMIT_FAILED: entry("STORAGE", "TRANSACTION", "PATIENT_ACTION_REQUIRED", "packet10.shared.recordsUnchanged", TABLE),
  DATASET_DELETE_BLOCKED: entry("CONCURRENCY", "CONCURRENCY", "PATIENT_ACTION_REQUIRED", "packet10.deletion.deleteBlocked"),
  SECURE_CONTEXT_REQUIRED: entry("DEPENDENCY", "CAPABILITY", "DO_NOT_RETRY", "packet10.backup.backupFailed"),
  BACKUP_CRYPTO_UNAVAILABLE: entry("DEPENDENCY", "CAPABILITY", "DO_NOT_RETRY", "packet10.backup.backupFailed"),
  BACKUP_VALIDATION_FAILED: entry("INTEGRITY", "VALIDATION", "DO_NOT_RETRY", "packet10.backup.backupFailed", TABLE),
  BACKUP_TOO_LARGE_FOR_FORMAT_V1: entry("STORAGE", "BACKUP_FORMAT", "DO_NOT_RETRY", "packet10.backup.backupTooLarge"),
  BACKUP_ENCRYPTION_FAILED: entry("RUNTIME", "CRYPTOGRAPHY", "PATIENT_ACTION_REQUIRED", "packet10.backup.backupFailed"),
  BACKUP_FILE_UNSUPPORTED: entry("INPUT", "BACKUP_FORMAT", "PATIENT_ACTION_REQUIRED", "packet10.restore.restoreFailed"),
  BACKUP_VERSION_UNSUPPORTED: entry("INPUT", "COMPATIBILITY", "APPLICATION_UPDATE_REQUIRED", "packet10.restore.unsupportedVersion", VERSION),
  BACKUP_KDF_UNSUPPORTED: entry("INPUT", "BACKUP_FORMAT", "DO_NOT_RETRY", "packet10.restore.unsupportedVersion"),
  BACKUP_AUTHENTICATION_FAILED: entry("INPUT", "CRYPTOGRAPHY", "PATIENT_ACTION_REQUIRED", "packet10.restore.authenticationFailed"),
  BACKUP_PAYLOAD_INVALID: entry("INTEGRITY", "VALIDATION", "DO_NOT_RETRY", "packet10.restore.restoreFailed", TABLE),
  BACKUP_LINEAGE_MISMATCH: entry("INPUT", "COMPATIBILITY", "PATIENT_ACTION_REQUIRED", "packet10.restore.differentDataset"),
  RESTORE_CONFIRMATION_STALE: entry("CONCURRENCY", "CONCURRENCY", "RETRY_AFTER_REFRESH", "packet10.restore.restoreFailed"),
  RESTORE_RUNTIME_UNAVAILABLE: entry("GOVERNED_CONFIGURATION", "COMPATIBILITY", "APPLICATION_UPDATE_REQUIRED", "packet10.restore.restoreFailed"),
  RESTORE_COMMIT_FAILED: entry("STORAGE", "TRANSACTION", "PATIENT_ACTION_REQUIRED", "packet10.restore.restoreFailed", TABLE),
  RESTORE_RECONCILIATION_FAILED: entry("INTEGRITY", "INTEGRITY", "PATIENT_ACTION_REQUIRED", "packet10.restore.recoveryRequired"),
});

export type StorageOperationFailure = {
  operation: StorageOperation;
  errorCode: StorageFailureCode;
  category: FailureCategory;
  storageClass: StorageFailureClass;
  retryClass: RetryClass;
  occurredAt: Instant;
  userMessageKey: StorageFailureMessageKey;
  operationId?: string;
  tableName?: JagaOnTableName;
  storedVersion?: number;
  supportedVersion?: number;
  governedReasonCodes: string[];
};

/** A typed failure raised inside Packet 10 storage code; carries a closed code only. */
export class StorageOperationError extends Error {
  readonly name = "StorageOperationError";
  constructor(
    readonly code: StorageFailureCode,
    readonly context: { tableName?: JagaOnTableName; storedVersion?: number; supportedVersion?: number } = {},
  ) {
    super(code);
  }
}

const GOVERNED_REASON_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Builds one closed failure; disallowed diagnostic fields are dropped. */
export function storageFailure(
  operation: StorageOperation,
  errorCode: StorageFailureCode,
  occurredAt: Instant,
  diagnostics: { operationId?: string; tableName?: JagaOnTableName; storedVersion?: number; supportedVersion?: number; governedReasonCodes?: readonly string[] } = {},
): StorageOperationFailure {
  const registration = STORAGE_FAILURE_REGISTRY[errorCode];
  const failure: StorageOperationFailure = {
    operation,
    errorCode,
    category: registration.category,
    storageClass: registration.storageClass,
    retryClass: registration.retryClass,
    occurredAt,
    userMessageKey: registration.userMessageKey,
    governedReasonCodes: [...(diagnostics.governedReasonCodes ?? [])].filter((code) => GOVERNED_REASON_CODE.test(code)),
  };
  const permitted = new Set(registration.permittedDiagnostics);
  if (permitted.has("operationId") && typeof diagnostics.operationId === "string" && /^[0-9a-f-]{36}$/.test(diagnostics.operationId)) {
    failure.operationId = diagnostics.operationId;
  }
  if (permitted.has("tableName") && diagnostics.tableName && (JAGAON_TABLE_NAMES as readonly string[]).includes(diagnostics.tableName)) {
    failure.tableName = diagnostics.tableName;
  }
  if (permitted.has("storedVersion") && Number.isSafeInteger(diagnostics.storedVersion)) failure.storedVersion = diagnostics.storedVersion;
  if (permitted.has("supportedVersion") && Number.isSafeInteger(diagnostics.supportedVersion)) failure.supportedVersion = diagnostics.supportedVersion;
  return Object.freeze(failure) as StorageOperationFailure;
}

const FALLBACK_BY_OPERATION: Readonly<Record<StorageOperation, StorageFailureCode>> = Object.freeze({
  OPEN: "DATABASE_OPEN_FAILED",
  READ: "STORAGE_TRANSACTION_ABORTED",
  COMMAND_COMMIT: "STORAGE_TRANSACTION_ABORTED",
  WORK_CLAIM: "STORAGE_TRANSACTION_ABORTED",
  WORK_COMPLETE: "STORAGE_TRANSACTION_ABORTED",
  MIGRATE: "MIGRATION_VALIDATION_FAILED",
  DELETE_RECORD: "DELETION_COMMIT_FAILED",
  DELETE_DATASET: "DELETION_COMMIT_FAILED",
  EXPORT_BACKUP: "BACKUP_ENCRYPTION_FAILED",
  RESTORE_BACKUP: "RESTORE_COMMIT_FAILED",
  RESTORE_RECONCILE: "RESTORE_RECONCILIATION_FAILED",
});

/** Browser/Dexie error *names* only; their messages are never read. */
const CODE_BY_ERROR_NAME: Readonly<Record<string, StorageFailureCode>> = Object.freeze({
  QuotaExceededError: "STORAGE_QUOTA_EXCEEDED",
  VersionError: "DATABASE_VERSION_UNSUPPORTED",
  MissingAPIError: "BROWSER_STORAGE_UNSUPPORTED",
  InvalidStateError: "BROWSER_STORAGE_UNSUPPORTED",
  SecurityError: "BROWSER_STORAGE_UNSUPPORTED",
  AbortError: "STORAGE_TRANSACTION_ABORTED",
  TransactionInactiveError: "STORAGE_TRANSACTION_ABORTED",
  PrematureCommitError: "STORAGE_TRANSACTION_ABORTED",
  DatabaseClosedError: "DATABASE_OPEN_FAILED",
  OpenFailedError: "DATABASE_OPEN_FAILED",
  ConstraintError: "STORAGE_INTEGRITY_FAILED",
  DataError: "STORAGE_INTEGRITY_FAILED",
});

function errorName(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const name = (error as { name?: unknown }).name;
  if (typeof name !== "string") return null;
  const inner = (error as { inner?: { name?: unknown } }).inner;
  if (name === "OpenFailedError" && typeof inner?.name === "string" && inner.name in CODE_BY_ERROR_NAME) return inner.name;
  return name;
}

/**
 * Maps anything thrown by a storage operation to one closed failure. Only the
 * error's closed type, code or name is read; the value itself is discarded.
 */
export function normaliseStorageFailure(
  operation: StorageOperation,
  error: unknown,
  occurredAt: Instant,
  diagnostics: { operationId?: string } = {},
): StorageOperationFailure {
  if (error instanceof StorageOperationError) {
    return storageFailure(operation, error.code, occurredAt, { ...diagnostics, ...error.context });
  }
  if (error instanceof StorageRowValidationError) {
    return storageFailure(operation, error.boundary === "WRITE" ? "STORAGE_VALIDATION_FAILED" : "STORAGE_INTEGRITY_FAILED", occurredAt, {
      ...diagnostics,
      tableName: error.table,
    });
  }
  if (error instanceof CommandTransactionError) {
    const code: StorageFailureCode =
      error.code === "STORAGE_INTEGRITY_FAILED"
        ? "STORAGE_INTEGRITY_FAILED"
        : error.code === "DELETION_CLOSURE_CHANGED"
          ? "DELETION_CONFIRMATION_STALE"
          : FALLBACK_BY_OPERATION[operation];
    return storageFailure(operation, code, occurredAt, diagnostics);
  }
  const name = errorName(error);
  const mapped = name ? CODE_BY_ERROR_NAME[name] : undefined;
  return storageFailure(operation, mapped ?? FALLBACK_BY_OPERATION[operation], occurredAt, diagnostics);
}
