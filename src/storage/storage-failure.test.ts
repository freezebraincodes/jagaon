import { describe, expect, it } from "vitest";
import { CommandTransactionError } from "./authoritative-command-transaction";
import {
  normaliseStorageFailure,
  storageFailure,
  StorageOperationError,
  STORAGE_FAILURE_CODES,
  STORAGE_FAILURE_MESSAGE_KEYS,
  STORAGE_FAILURE_REGISTRY,
  STORAGE_OPERATIONS,
} from "./storage-failure";
import { StorageRowValidationError } from "./storage-row-codec";

const AT = "2026-10-04T02:00:00.000Z" as never;
const SECRET = "correct horse battery staple 6.2 mmol/L Nocturin";

describe("closed storage failure registry (spec 9.1–9.3)", () => {
  it("registers exactly the 31 locked codes with one category, class, retry and message key each", () => {
    expect(STORAGE_FAILURE_CODES).toHaveLength(31);
    expect(Object.keys(STORAGE_FAILURE_REGISTRY).sort()).toEqual([...STORAGE_FAILURE_CODES].sort());
    for (const code of STORAGE_FAILURE_CODES) {
      const entry = STORAGE_FAILURE_REGISTRY[code];
      expect(STORAGE_FAILURE_MESSAGE_KEYS).toContain(entry.userMessageKey);
      expect(entry.permittedDiagnostics).toContain("operationId");
    }
    expect(STORAGE_OPERATIONS).toHaveLength(11);
  });

  it("follows the retry and recovery matrix", () => {
    const retry = (code: (typeof STORAGE_FAILURE_CODES)[number]) => STORAGE_FAILURE_REGISTRY[code].retryClass;
    expect(retry("DELETION_CONFIRMATION_STALE")).toBe("RETRY_AFTER_REFRESH");
    expect(retry("RESTORE_CONFIRMATION_STALE")).toBe("RETRY_AFTER_REFRESH");
    expect(retry("DATASET_DELETE_BLOCKED")).toBe("PATIENT_ACTION_REQUIRED");
    expect(retry("MIGRATION_BLOCKED_BY_OTHER_TAB")).toBe("PATIENT_ACTION_REQUIRED");
    expect(retry("STORAGE_QUOTA_EXCEEDED")).toBe("PATIENT_ACTION_REQUIRED");
    expect(retry("DATABASE_VERSION_UNSUPPORTED")).toBe("APPLICATION_UPDATE_REQUIRED");
    expect(retry("BACKUP_VERSION_UNSUPPORTED")).toBe("APPLICATION_UPDATE_REQUIRED");
    expect(retry("BACKUP_AUTHENTICATION_FAILED")).toBe("PATIENT_ACTION_REQUIRED");
    expect(retry("STORAGE_INTEGRITY_FAILED")).toBe("DO_NOT_RETRY");
    expect(retry("STORAGE_CORRUPTION_DETECTED")).toBe("DO_NOT_RETRY");
    expect(retry("STORAGE_TRANSACTION_ABORTED")).toBe("BOUNDED_AUTOMATIC_RETRY");
    expect(STORAGE_FAILURE_REGISTRY.BACKUP_AUTHENTICATION_FAILED.userMessageKey).toBe("packet10.restore.authenticationFailed");
    expect(STORAGE_FAILURE_REGISTRY.RESTORE_RECONCILIATION_FAILED.userMessageKey).toBe("packet10.restore.recoveryRequired");
  });

  it("maps typed and browser errors by closed type or name only", () => {
    expect(normaliseStorageFailure("COMMAND_COMMIT", new StorageRowValidationError("STORAGE_VALIDATION_FAILED", "auditEvents", "WRITE"), AT)).toMatchObject({
      errorCode: "STORAGE_VALIDATION_FAILED",
      tableName: "auditEvents",
    });
    expect(normaliseStorageFailure("READ", new StorageRowValidationError("STORAGE_INTEGRITY_FAILED", "recordRevisions", "READ"), AT)).toMatchObject({
      errorCode: "STORAGE_INTEGRITY_FAILED",
      storageClass: "INTEGRITY",
      tableName: "recordRevisions",
    });
    expect(normaliseStorageFailure("DELETE_RECORD", new CommandTransactionError("DELETION_CLOSURE_CHANGED"), AT).errorCode).toBe("DELETION_CONFIRMATION_STALE");
    expect(normaliseStorageFailure("COMMAND_COMMIT", new CommandTransactionError("STORAGE_INTEGRITY_FAILED"), AT).errorCode).toBe("STORAGE_INTEGRITY_FAILED");
    expect(normaliseStorageFailure("COMMAND_COMMIT", new DOMException(SECRET, "QuotaExceededError"), AT).errorCode).toBe("STORAGE_QUOTA_EXCEEDED");
    expect(normaliseStorageFailure("OPEN", { name: "OpenFailedError", inner: { name: "VersionError" }, message: SECRET }, AT).errorCode).toBe("DATABASE_VERSION_UNSUPPORTED");
    expect(normaliseStorageFailure("OPEN", { name: "MissingAPIError" }, AT).errorCode).toBe("BROWSER_STORAGE_UNSUPPORTED");
    expect(normaliseStorageFailure("EXPORT_BACKUP", new Error(SECRET), AT).errorCode).toBe("BACKUP_ENCRYPTION_FAILED");
    expect(normaliseStorageFailure("RESTORE_RECONCILE", SECRET, AT).errorCode).toBe("RESTORE_RECONCILIATION_FAILED");
    expect(normaliseStorageFailure("MIGRATE", new StorageOperationError("MIGRATION_REPAIR_REQUIRED", { storedVersion: 1, supportedVersion: 2 }), AT)).toMatchObject({
      errorCode: "MIGRATION_REPAIR_REQUIRED",
      storedVersion: 1,
      supportedVersion: 2,
    });
  });

  it("strips raw exceptions and non-permitted diagnostics", () => {
    for (const operation of STORAGE_OPERATIONS) {
      const failure = normaliseStorageFailure(operation, Object.assign(new Error(SECRET), { name: SECRET, stack: SECRET }), AT, { operationId: SECRET });
      expect(JSON.stringify(failure)).not.toContain("6.2");
      expect(JSON.stringify(failure)).not.toContain("horse");
      expect(failure).not.toHaveProperty("operationId");
    }
    const failure = storageFailure("RESTORE_BACKUP", "BACKUP_AUTHENTICATION_FAILED", AT, {
      operationId: "0b1c2d3e-4f50-4617-8829-3a4b5c6d7e8f",
      tableName: "recordRevisions",
      storedVersion: 7,
      governedReasonCodes: ["REVISION_CHAIN", SECRET],
    });
    expect(failure).toEqual({
      operation: "RESTORE_BACKUP",
      errorCode: "BACKUP_AUTHENTICATION_FAILED",
      category: "INPUT",
      storageClass: "CRYPTOGRAPHY",
      retryClass: "PATIENT_ACTION_REQUIRED",
      occurredAt: AT,
      userMessageKey: "packet10.restore.authenticationFailed",
      operationId: "0b1c2d3e-4f50-4617-8829-3a4b5c6d7e8f",
      governedReasonCodes: ["REVISION_CHAIN"],
    });
  });
});
