import { afterEach, beforeAll, describe, expect, it } from "vitest";
import Dexie from "dexie";
import fakeIndexedDB from "fake-indexeddb";
import { createPopulatedDataset, openRaw, PACKET10_NOW, readAllTables, installFakeIndexedDb } from "@/application/storage/packet10-test-support";
import { HACKATHON_CLOSED_ROW_CODECS } from "@/application/storage/profile-row-codecs";
import { createJagaOnDatabase } from "../database";
import { JAGAON_STORES_V1, JAGAON_TABLE_NAMES, type JagaOnTableName } from "../table-catalogue";
import type { RegisteredStorageMigration } from "./migration-contracts";
import { createMigrationCoordinator, type DatasetOpenPorts } from "./migration-coordinator";
import { LEGACY_DATASET_IDENTITY_MIGRATION_ID, resolveMigrationChain, STORAGE_MIGRATION_REGISTRY, verifyMigrationRegistry } from "./migration-registry";

installFakeIndexedDb();
const INTEGRATION_TIMEOUT_MS = 60_000;
const DATASET = "6f1c2b9e-3d4a-4b5c-8d6e-7f8091a2b3c4";
const names: string[] = [];
afterEach(async () => {
  for (const name of names.splice(0)) await Dexie.delete(name);
});

let packet9Rows: Record<JagaOnTableName, unknown[]>;

beforeAll(async () => {
  // A real Packet 9 dataset: written by every enabled owner, without the
  // Packet 10 identity/migration metadata a legacy database never had.
  const { name, runtime } = await createPopulatedDataset();
  runtime.close();
  const database = await openRaw(name);
  const rows = await readAllTables(database);
  database.close();
  await Dexie.delete(name);
  rows.storageMetadata = rows.storageMetadata.filter((row) => (row as { key: string }).key === "EVENT_SEQUENCE_HIGH_WATER_MARK");
  packet9Rows = rows;
}, INTEGRATION_TIMEOUT_MS);

async function createLegacyDatabase(mutate?: (rows: Record<JagaOnTableName, unknown[]>) => void): Promise<string> {
  const name = `packet10-legacy-${crypto.randomUUID()}`;
  names.push(name);
  const rows = structuredClone(packet9Rows);
  mutate?.(rows);
  const legacy = new Dexie(name, { autoOpen: false });
  legacy.version(1).stores(JAGAON_STORES_V1);
  await legacy.open();
  for (const table of JAGAON_TABLE_NAMES) if (rows[table].length > 0) await legacy.table(table).bulkAdd(rows[table]);
  legacy.close();
  return name;
}

async function physicalVersion(name: string): Promise<number> {
  const probe = new Dexie(name, { autoOpen: false });
  await probe.open();
  const version = probe.verno;
  probe.close();
  return version;
}

async function dynamicRows(name: string): Promise<Record<string, unknown[]>> {
  const probe = new Dexie(name, { autoOpen: false });
  await probe.open();
  const entries = await Promise.all(probe.tables.map(async (table) => [table.name, await table.toArray()] as const));
  probe.close();
  return Object.fromEntries(entries);
}

function ports(overrides: Partial<DatasetOpenPorts> = {}): DatasetOpenPorts {
  return { now: () => PACKET10_NOW, newDatasetIdentity: () => DATASET, closedRowCodecs: HACKATHON_CLOSED_ROW_CODECS, blockedTimeoutMs: 50, ...overrides };
}

function withEntry(entry: RegisteredStorageMigration, change: Partial<RegisteredStorageMigration["definition"]>, sha = entry.definitionSha256): RegisteredStorageMigration {
  return { ...entry, definition: { ...entry.definition, ...change }, definitionSha256: sha };
}

describe("Packet 10A forward-only migration (MIG-001–MIG-012)", () => {
  const [legacy] = STORAGE_MIGRATION_REGISTRY;

  it("MIG-001 resolves one unique contiguous chain and migrates a Packet 9 database", async () => {
    expect(resolveMigrationChain(STORAGE_MIGRATION_REGISTRY, { dexie: 1, logical: 0 }).map((entry) => entry.definition.migrationId)).toEqual([
      LEGACY_DATASET_IDENTITY_MIGRATION_ID,
    ]);
    expect(resolveMigrationChain(STORAGE_MIGRATION_REGISTRY, { dexie: 2, logical: 1 })).toEqual([]);
    const name = await createLegacyDatabase();
    const phases: string[] = [];
    const result = await createMigrationCoordinator(name, ports({ onPhase: (phase) => phases.push(phase) })).run();
    expect(result.kind).toBe("OPENED");
    if (result.kind !== "OPENED") return;
    expect(result.lifecycle).toBe("MIGRATED");
    expect(result.appliedMigrationIds).toEqual([LEGACY_DATASET_IDENTITY_MIGRATION_ID]);
    expect(result.identity).toEqual({
      key: "DATABASE_IDENTITY",
      datasetIdentity: DATASET,
      logicalStorageSchemaVersion: 1,
      createdAt: PACKET10_NOW,
      lastCompletedMigrationId: LEGACY_DATASET_IDENTITY_MIGRATION_ID,
      updatedAt: PACKET10_NOW,
    });
    expect(phases).toEqual(["PREPARING", "RUNNING", "VERIFYING", "COMPLETED"]);
    expect(result.database.verno).toBe(2);
    expect(await result.database.table("storageMetadata").get("MIGRATION_STATE")).toMatchObject({
      phase: "COMPLETED",
      migrationId: LEGACY_DATASET_IDENTITY_MIGRATION_ID,
      fromDexieVersion: 1,
      toDexieVersion: 2,
      fromLogicalSchemaVersion: 0,
      toLogicalSchemaVersion: 1,
      lastCompletedStep: "VERIFY",
    });
    result.database.close();
  }, INTEGRATION_TIMEOUT_MS);

  it("MIG-002 fails closed on missing, duplicated, out-of-order or checksum-mismatched definitions", async () => {
    await expect(verifyMigrationRegistry(STORAGE_MIGRATION_REGISTRY)).resolves.toBeUndefined();
    await expect(verifyMigrationRegistry([legacy!, legacy!])).rejects.toMatchObject({ code: "MIGRATION_CHAIN_UNAVAILABLE" });
    await expect(verifyMigrationRegistry([withEntry(legacy!, { implementationVersion: "10a.2" })])).rejects.toMatchObject({ code: "MIGRATION_CHAIN_UNAVAILABLE" });
    await expect(verifyMigrationRegistry([withEntry(legacy!, { expectedPreviousMigrationId: "jagaon.storage.0000-none" })])).rejects.toMatchObject({ code: "MIGRATION_CHAIN_UNAVAILABLE" });
    expect(() => resolveMigrationChain([], { dexie: 1, logical: 0 })).toThrow(expect.objectContaining({ code: "MIGRATION_CHAIN_UNAVAILABLE" }));

    const name = await createLegacyDatabase();
    const before = await dynamicRows(name);
    for (const registry of [[], [legacy!, legacy!], [withEntry(legacy!, { affectedTables: ["recordRevisions"] })]]) {
      const result = await createMigrationCoordinator(name, ports({ registry })).run();
      expect(result).toMatchObject({ kind: "FAILED", failure: { errorCode: "MIGRATION_CHAIN_UNAVAILABLE", retryClass: "APPLICATION_UPDATE_REQUIRED" } });
    }
    expect(await physicalVersion(name)).toBe(1);
    expect(await dynamicRows(name)).toEqual(before);
  }, INTEGRATION_TIMEOUT_MS);

  it("MIG-003 leaves a newer physical or logical database untouched", async () => {
    const newer = `packet10-newer-${crypto.randomUUID()}`;
    names.push(newer);
    const future = new Dexie(newer, { autoOpen: false });
    future.version(3).stores({ ...JAGAON_STORES_V1, futureTable: "id" });
    await future.open();
    await future.table("futureTable").add({ id: "kept" });
    future.close();
    const result = await createMigrationCoordinator(newer, ports()).run();
    expect(result).toMatchObject({ kind: "FAILED", failure: { errorCode: "DATABASE_VERSION_UNSUPPORTED", storedVersion: 3, supportedVersion: 2, userMessageKey: "packet10.integrity.newerDatabase" } });
    expect(await physicalVersion(newer)).toBe(3);
    expect((await dynamicRows(newer)).futureTable).toEqual([{ id: "kept" }]);

    const logical = `packet10-newer-logical-${crypto.randomUUID()}`;
    names.push(logical);
    const database = createJagaOnDatabase(logical);
    await database.open();
    await database.table("storageMetadata").put({ key: "DATABASE_IDENTITY", datasetIdentity: DATASET, logicalStorageSchemaVersion: 2, createdAt: PACKET10_NOW, updatedAt: PACKET10_NOW });
    database.close();
    const logicalResult = await createMigrationCoordinator(logical, ports()).run();
    expect(logicalResult).toMatchObject({ kind: "FAILED", failure: { errorCode: "DATABASE_VERSION_UNSUPPORTED", storedVersion: 2, supportedVersion: 1 } });
  });

  it("MIG-004 a tab that keeps its connection blocks the version change without deletion or partial upgrade", async () => {
    const name = await createLegacyDatabase();
    const blocker = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = fakeIndexedDB.open(name, 10);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    blocker.onversionchange = () => undefined; // never closes
    const result = await createMigrationCoordinator(name, ports()).run();
    expect(result).toMatchObject({ kind: "FAILED", failure: { errorCode: "MIGRATION_BLOCKED_BY_OTHER_TAB", retryClass: "PATIENT_ACTION_REQUIRED", userMessageKey: "packet10.integrity.migrationBlocked" } });
    expect(blocker.version).toBe(10);
    const count = await new Promise<number>((resolve) => {
      const request = blocker.transaction("recordRevisions").objectStore("recordRevisions").count();
      request.onsuccess = () => resolve(request.result);
    });
    expect(count).toBe(packet9Rows.recordRevisions.length);
    blocker.close();
  });

  it.each(["BEFORE_TRANSFORM", "AFTER_IDENTITY", "AFTER_STATE", "DURING_VERIFY"] as const)(
    "MIG-005 a fault %s leaves the last committed database version intact",
    async (fault) => {
      const name = await createLegacyDatabase();
      const before = await dynamicRows(name);
      const result = await createMigrationCoordinator(name, ports({ fault })).run();
      expect(result).toMatchObject({ kind: "FAILED", failure: { errorCode: "MIGRATION_VALIDATION_FAILED", operation: "MIGRATE" } });
      expect(await physicalVersion(name)).toBe(1);
      expect(await dynamicRows(name)).toEqual(before);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it("MIG-006/007/008 preserves every row exactly, invents nothing and replays nothing", async () => {
    const name = await createLegacyDatabase();
    const before = await dynamicRows(name);
    const result = await createMigrationCoordinator(name, ports()).run();
    if (result.kind !== "OPENED") throw new Error("migration failed");
    const after = await readAllTables(result.database);
    result.database.close();
    for (const table of JAGAON_TABLE_NAMES.filter((entry) => entry !== "storageMetadata")) expect(after[table], table).toEqual(before[table]);
    const added = after.storageMetadata.filter((row) => !before.storageMetadata!.some((old) => (old as { key: string }).key === (row as { key: string }).key));
    expect(added.map((row) => (row as { key: string }).key).sort()).toEqual(["DATABASE_IDENTITY", "MIGRATION_STATE"]);
    expect(Object.keys(added.find((row) => (row as { key: string }).key === "DATABASE_IDENTITY")!).sort()).toEqual([
      "createdAt",
      "datasetIdentity",
      "key",
      "lastCompletedMigrationId",
      "logicalStorageSchemaVersion",
      "updatedAt",
    ]);
    expect(after.storageMetadata.find((row) => (row as { key: string }).key === "EVENT_SEQUENCE_HIGH_WATER_MARK")).toEqual(
      before.storageMetadata!.find((row) => (row as { key: string }).key === "EVENT_SEQUENCE_HIGH_WATER_MARK"),
    );
    expect(after.domainEvents).toHaveLength(packet9Rows.domainEvents.length);
    expect(after.eventWorkItems).toHaveLength(packet9Rows.eventWorkItems.length);
    expect(after.commandReceipts).toHaveLength(packet9Rows.commandReceipts.length);
  }, INTEGRATION_TIMEOUT_MS);

  it("MIG-009 requires no implicit recomputation", async () => {
    expect(STORAGE_MIGRATION_REGISTRY.every((entry) => !entry.definition.requiresExplicitRecomputation && !entry.definition.changesPatientContent)).toBe(true);
    const result = await createMigrationCoordinator(await createLegacyDatabase(), ports()).run();
    if (result.kind !== "OPENED") throw new Error("migration failed");
    expect(result.recomputationRequired).toEqual([]);
    result.database.close();
  }, INTEGRATION_TIMEOUT_MS);

  it("MIG-010/011 an invalid stored row aborts before the version change and is never dropped", async () => {
    const name = await createLegacyDatabase((rows) => {
      rows.recordRevisions[0] = { ...(rows.recordRevisions[0] as object), quarantineNote: "x" };
    });
    const result = await createMigrationCoordinator(name, ports()).run();
    expect(result).toMatchObject({ kind: "FAILED", failure: { errorCode: "MIGRATION_VALIDATION_FAILED", tableName: "recordRevisions", retryClass: "DO_NOT_RETRY" } });
    expect(await physicalVersion(name)).toBe(1);
    const rows = await dynamicRows(name);
    expect(rows.recordRevisions).toHaveLength(packet9Rows.recordRevisions.length);
    expect(rows.recordRevisions!.some((row) => "quarantineNote" in (row as object))).toBe(true);
    expect(rows.storageMetadata!.some((row) => (row as { key: string }).key === "DATABASE_IDENTITY")).toBe(false);
  });

  it("MIG-012 never registers downgrades or reruns committed history", async () => {
    await expect(verifyMigrationRegistry([withEntry(legacy!, { fromDexieVersion: 2, toDexieVersion: 1 })])).rejects.toMatchObject({ code: "MIGRATION_CHAIN_UNAVAILABLE" });
    const name = await createLegacyDatabase();
    const first = await createMigrationCoordinator(name, ports()).run();
    if (first.kind !== "OPENED") throw new Error("migration failed");
    const state = await first.database.table("storageMetadata").get("MIGRATION_STATE");
    first.database.close();
    const second = await createMigrationCoordinator(name, ports({ newDatasetIdentity: () => "11111111-1111-4111-8111-111111111111" })).run();
    if (second.kind !== "OPENED") throw new Error("reopen failed");
    expect(second.lifecycle).toBe("EXISTING");
    expect(second.appliedMigrationIds).toEqual([]);
    expect(second.identity.datasetIdentity).toBe(DATASET);
    expect(await second.database.table("storageMetadata").get("MIGRATION_STATE")).toEqual(state);
    second.database.close();
  }, INTEGRATION_TIMEOUT_MS);

  it("creates a new dataset directly at Dexie 2 / logical 1 and rejects an identity-less current database", async () => {
    const created = `packet10-created-${crypto.randomUUID()}`;
    names.push(created);
    const result = await createMigrationCoordinator(created, ports()).run();
    if (result.kind !== "OPENED") throw new Error("create failed");
    expect(result.lifecycle).toBe("CREATED");
    expect(result.identity).toEqual({ key: "DATABASE_IDENTITY", datasetIdentity: DATASET, logicalStorageSchemaVersion: 1, createdAt: PACKET10_NOW, updatedAt: PACKET10_NOW });
    expect(await result.database.table("storageMetadata").get("MIGRATION_STATE")).toBeUndefined();
    result.database.close();

    const bare = `packet10-bare-${crypto.randomUUID()}`;
    names.push(bare);
    const database = createJagaOnDatabase(bare);
    await database.open();
    database.close();
    expect(await createMigrationCoordinator(bare, ports()).run()).toMatchObject({ kind: "FAILED", failure: { errorCode: "STORAGE_INTEGRITY_FAILED" } });
  });

  it("an ordinary open never upgrades a legacy database implicitly", async () => {
    const name = await createLegacyDatabase();
    await expect(createJagaOnDatabase(name).open()).rejects.toBeTruthy();
    expect(await physicalVersion(name)).toBe(1);
  });
});
