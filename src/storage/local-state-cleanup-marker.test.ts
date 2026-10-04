import { afterEach, describe, expect, it } from "vitest";
import Dexie from "dexie";
import { installFakeIndexedDb } from "@/application/storage/packet10-test-support";
import { HACKATHON_CLOSED_ROW_CODECS } from "@/application/storage/profile-row-codecs";
import { createJagaOnDatabase } from "./database";
import { verifyDataset } from "./dataset-verifier";
import { createStorageMetadataRepository, databaseIdentityRow, localStateCleanupPendingRow, localStateCleanupPendingRowSchema, storageMetadataRowCodec } from "./storage-metadata";
import { StorageRowValidationError } from "./storage-row-codec";
import { JAGAON_TABLE_NAMES } from "./table-catalogue";

/**
 * Packet 10 Corrective Pass C: the approved closed operational marker for
 * incomplete post-delete local-state cleanup. It carries only its key and the
 * instant the cleanup was requested.
 */

installFakeIndexedDb();
const names: string[] = [];
afterEach(async () => {
  for (const name of names.splice(0)) await Dexie.delete(name);
});

const AT = "2026-10-04T02:00:00.000Z";
const MARKER = { key: "LOCAL_STATE_CLEANUP_PENDING", requestedAt: AT };

describe("LOCAL_STATE_CLEANUP_PENDING closed schema", () => {
  it("accepts exactly the key and the requested instant", () => {
    expect(localStateCleanupPendingRowSchema.parse(MARKER)).toEqual(MARKER);
    expect(localStateCleanupPendingRow(AT as never)).toEqual(MARKER);
    expect(storageMetadataRowCodec.validateForWrite(MARKER)).toEqual(MARKER);
  });

  it("rejects raw errors, browser, setup or patient data and malformed instants", () => {
    for (const extra of [{ error: "QuotaExceededError" }, { keys: ["jagaon:onboarding:v1"] }, { setup: { status: "COMPLETED" } }, { patientName: "Demo" }, { requestedAt: undefined }]) {
      expect(localStateCleanupPendingRowSchema.safeParse({ ...MARKER, ...extra }).success).toBe(false);
      expect(() => storageMetadataRowCodec.validateForWrite({ ...MARKER, ...extra })).toThrow(StorageRowValidationError);
    }
    expect(localStateCleanupPendingRowSchema.safeParse({ ...MARKER, requestedAt: "yesterday" }).success).toBe(false);
    expect(localStateCleanupPendingRowSchema.safeParse({ key: "LOCAL_STATE_CLEANUP_PENDING" }).success).toBe(false);
  });
});

describe("local-state cleanup marker repository", () => {
  async function database() {
    const name = `marker-${crypto.randomUUID()}`;
    names.push(name);
    const db = createJagaOnDatabase(name, {
      populate: async (transaction) => {
        await transaction.table("storageMetadata").add(databaseIdentityRow({ datasetIdentity: "6f1c2b9e-3d4a-4b5c-8d6e-7f8091a2b3c4", createdAt: AT as never }) as never);
      },
    });
    await db.open();
    return db;
  }

  it("reads, writes and clears only the validated closed row", async () => {
    const db = await database();
    const metadata = createStorageMetadataRepository(db);
    expect(await metadata.readLocalStateCleanupPending()).toBeNull();
    expect(await metadata.writeLocalStateCleanupPending(localStateCleanupPendingRow(AT as never))).toEqual(MARKER);
    expect(await db.table("storageMetadata").get("LOCAL_STATE_CLEANUP_PENDING")).toEqual(MARKER);
    expect(await metadata.readLocalStateCleanupPending()).toEqual(MARKER);
    await expect(metadata.writeLocalStateCleanupPending({ ...MARKER, error: "x" } as never)).rejects.toBeInstanceOf(StorageRowValidationError);
    await metadata.clearLocalStateCleanupPending();
    expect(await metadata.readLocalStateCleanupPending()).toBeNull();
    // Clearing an absent marker is a no-op.
    await metadata.clearLocalStateCleanupPending();
    db.close();
  });

  it("fails closed on a malformed stored marker and never removes it silently", async () => {
    const db = await database();
    await db.table("storageMetadata").put({ ...MARKER, error: "raw" } as never);
    const metadata = createStorageMetadataRepository(db);
    await expect(metadata.readLocalStateCleanupPending()).rejects.toBeInstanceOf(StorageRowValidationError);
    await expect(metadata.clearLocalStateCleanupPending()).rejects.toBeInstanceOf(StorageRowValidationError);
    expect(await db.table("storageMetadata").get("LOCAL_STATE_CLEANUP_PENDING")).toEqual({ ...MARKER, error: "raw" });
    db.close();
  });

  it("does not weaken launch verification: a valid marker verifies, a malformed one locks", () => {
    const tables = Object.fromEntries(JAGAON_TABLE_NAMES.map((name) => [name, [] as unknown[]])) as Record<string, unknown[]>;
    tables.storageMetadata = [databaseIdentityRow({ datasetIdentity: "6f1c2b9e-3d4a-4b5c-8d6e-7f8091a2b3c4", createdAt: AT as never }), MARKER];
    expect(verifyDataset(tables as never, HACKATHON_CLOSED_ROW_CODECS).kind).toBe("VERIFIED");
    tables.storageMetadata = [tables.storageMetadata[0], { ...MARKER, error: "raw" }];
    expect(verifyDataset(tables as never, HACKATHON_CLOSED_ROW_CODECS)).toEqual({ kind: "FAILED", invariant: "ROW_SCHEMA", tableName: "storageMetadata" });
  });
});
