import { afterEach, describe, expect, it } from "vitest";
import Dexie from "dexie";
import { installFakeIndexedDb } from "@/application/storage/packet10-test-support";
import { createJagaOnDatabase } from "./database";
import {
  createStorageMetadataRepository,
  databaseIdentityRow,
  databaseIdentityRowSchema,
  LOGICAL_STORAGE_SCHEMA_VERSION,
  MIGRATION_PHASES,
  migrationStateRowSchema,
  RESTORE_CHECKPOINTS,
  RESTORE_PHASES,
  restoreStateRowSchema,
} from "./storage-metadata";
import { StorageRowValidationError } from "./storage-row-codec";

installFakeIndexedDb();
const names: string[] = [];
afterEach(async () => {
  for (const name of names.splice(0)) await Dexie.delete(name);
});

const AT = "2026-10-04T02:00:00.000Z";
const DATASET = "6f1c2b9e-3d4a-4b5c-8d6e-7f8091a2b3c4";
const OPERATION = "0b1c2d3e-4f50-4617-8829-3a4b5c6d7e8f";
const PLAN = "a".repeat(64);

describe("storage metadata schemas (spec 2.9, 5.1, 5.3, 8.2)", () => {
  it("builds an exact database identity at logical version 1", () => {
    expect(LOGICAL_STORAGE_SCHEMA_VERSION).toBe(1);
    expect(databaseIdentityRow({ datasetIdentity: DATASET, createdAt: AT as never })).toEqual({
      key: "DATABASE_IDENTITY",
      datasetIdentity: DATASET,
      logicalStorageSchemaVersion: 1,
      createdAt: AT,
      updatedAt: AT,
    });
  });

  it("rejects patient, cryptographic and free-text fields on every metadata row", () => {
    const identity = databaseIdentityRow({ datasetIdentity: DATASET, createdAt: AT as never });
    for (const field of ["patientName", "passphrase", "salt", "key", "fileName", "rawError", "payload"]) {
      expect(databaseIdentityRowSchema.safeParse({ ...identity, [field]: "x" }).success, field).toBe(false);
      expect(migrationStateRowSchema.safeParse({ key: "MIGRATION_STATE", phase: "IDLE", [field]: "x" }).success, field).toBe(false);
      expect(restoreStateRowSchema.safeParse({ key: "RESTORE_STATE", phase: "IDLE", [field]: "x" }).success, field).toBe(false);
    }
  });

  it("rejects malformed identities, undefined optional fields and unknown versions", () => {
    const identity = databaseIdentityRow({ datasetIdentity: DATASET, createdAt: AT as never });
    expect(databaseIdentityRowSchema.safeParse({ ...identity, datasetIdentity: "not-a-uuid" }).success).toBe(false);
    expect(databaseIdentityRowSchema.safeParse({ ...identity, logicalStorageSchemaVersion: 0 }).success).toBe(false);
    expect(databaseIdentityRowSchema.safeParse({ ...identity, lastCompletedMigrationId: undefined }).success).toBe(false);
    expect(databaseIdentityRowSchema.safeParse({ ...identity, lastCompletedMigrationId: "drop tables" }).success).toBe(false);
  });

  it("keeps the migration and restore phases closed", () => {
    expect(MIGRATION_PHASES).toEqual(["IDLE", "PREPARING", "RUNNING", "VERIFYING", "COMPLETED", "FAILED_RECOVERABLE", "FAILED_BLOCKING"]);
    expect(RESTORE_PHASES).toEqual([
      "IDLE",
      "HEADER_VALIDATED",
      "DECRYPTING",
      "PAYLOAD_VALIDATING",
      "PLAN_READY",
      "AWAITING_CONFIRMATION",
      "COMMITTING",
      "RECONCILING",
      "COMPLETED",
      "FAILED_RECOVERABLE",
      "FAILED_BLOCKING",
    ]);
    expect(migrationStateRowSchema.safeParse({ key: "MIGRATION_STATE", phase: "PAUSED" }).success).toBe(false);
    expect(migrationStateRowSchema.safeParse({ key: "MIGRATION_STATE", phase: "COMPLETED" }).success).toBe(false);
    expect(migrationStateRowSchema.safeParse({ key: "MIGRATION_STATE", phase: "FAILED_BLOCKING" }).success).toBe(false);
    expect(migrationStateRowSchema.safeParse({ key: "MIGRATION_STATE", phase: "FAILED_BLOCKING", failureCode: "NOT_A_CODE" }).success).toBe(false);
    expect(
      migrationStateRowSchema.safeParse({ key: "MIGRATION_STATE", phase: "COMPLETED", migrationId: "jagaon.storage.0001-legacy-dataset-identity", completedAt: AT }).success,
    ).toBe(true);
  });

  it("requires durable identity for committed restores and closed checkpoints", () => {
    expect(RESTORE_CHECKPOINTS[0]).toBe("COMMITTED");
    expect(restoreStateRowSchema.safeParse({ key: "RESTORE_STATE", phase: "RECONCILING" }).success).toBe(false);
    const reconciling = {
      key: "RESTORE_STATE",
      phase: "RECONCILING",
      operationId: OPERATION,
      restoreMode: "RESTORE_INTO_EMPTY_DATABASE",
      planHash: PLAN,
      committedAt: AT,
      lastCompletedStep: "VERIFY_STORAGE",
    };
    expect(restoreStateRowSchema.safeParse(reconciling).success).toBe(true);
    expect(restoreStateRowSchema.safeParse({ ...reconciling, lastCompletedStep: "SKIPPED_EVERYTHING" }).success).toBe(false);
    expect(restoreStateRowSchema.safeParse({ ...reconciling, restoreMode: "MERGE" }).success).toBe(false);
  });
});

describe("storage metadata repository", () => {
  it("writes only validated rows and fails closed on invalid stored metadata", async () => {
    const name = `packet10-metadata-${crypto.randomUUID()}`;
    names.push(name);
    const database = createJagaOnDatabase(name);
    await database.open();
    const repository = createStorageMetadataRepository(database);
    expect(await repository.readRestoreState()).toBeNull();
    await expect(repository.writeRestoreState({ key: "RESTORE_STATE", phase: "RECONCILING" } as never)).rejects.toBeInstanceOf(StorageRowValidationError);
    await repository.writeRestoreState({ key: "RESTORE_STATE", phase: "IDLE" });
    expect(await repository.readRestoreState()).toEqual({ key: "RESTORE_STATE", phase: "IDLE" });
    await database.table("storageMetadata").put({ key: "MIGRATION_STATE", phase: "COMPLETED", note: "free text" });
    await expect(repository.readMigrationState()).rejects.toMatchObject({ code: "STORAGE_INTEGRITY_FAILED", table: "storageMetadata" });
    database.close();
  });
});
