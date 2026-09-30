import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import Dexie from "dexie";
import fakeIndexedDB, { IDBKeyRange as FDBKeyRange } from "fake-indexeddb";
import type { ImplementedReleaseProfile } from "@/config/release-profile";
import { instantSchema } from "@/domain/shared/time";
import { createJagaOnDatabase, type JagaOnDatabase } from "./database";
import {
  DEMO_STORAGE_RESET_CONFIRMATION,
  resetSyntheticDemoStorage,
} from "./demo-storage-reset";
import {
  JAGAON_TABLE_NAMES,
  type JagaOnTableName,
} from "./table-catalogue";

const originalIndexedDB = Dexie.dependencies.indexedDB;
const originalIDBKeyRange = Dexie.dependencies.IDBKeyRange;

beforeAll(() => {
  Dexie.dependencies.indexedDB = fakeIndexedDB;
  Dexie.dependencies.IDBKeyRange = FDBKeyRange;
});

afterAll(() => {
  Dexie.dependencies.indexedDB = originalIndexedDB;
  Dexie.dependencies.IDBKeyRange = originalIDBKeyRange;
});

const databases: JagaOnDatabase[] = [];

afterEach(async () => {
  const names = [...new Set(databases.map((database) => database.name))];
  for (const database of databases) database.close();
  databases.length = 0;
  for (const name of names) await Dexie.delete(name);
});

async function openDatabase() {
  const database = createJagaOnDatabase(`reset-${crypto.randomUUID()}`);
  databases.push(database);
  await database.open();
  return database;
}

function seedRow(table: JagaOnTableName): Record<string, unknown> {
  switch (table) {
    case "appPreferences":
      return { key: "seed" };
    case "recordRevisions":
      return { revisionId: "seed-revision" };
    case "recordHeads":
    case "deletionTombstones":
      return { recordId: `seed-${table}` };
    case "auditEvents":
      return { auditEventId: "seed-audit" };
    case "domainEvents":
      return { eventId: "seed-event", localSequence: 99 };
    case "commandReceipts":
      return { commandId: "seed-command" };
    case "eventWorkItems":
      return { workItemId: "seed-work" };
    case "eventConsumerReceipts":
      return {
        eventId: "seed-event",
        consumer: "seed-consumer",
        handlerVersion: "seed-handler",
      };
    case "reverseDependencies":
      return {
        sourceRevisionId: "seed-source",
        dependentRevisionId: "seed-dependent",
        dependencyRole: "seed-role",
      };
    case "engineEvaluationAudits":
      return { evaluationId: "seed-evaluation" };
    case "aiInvocationAudits":
      return { requestId: "seed-request" };
    case "runtimeManifests":
      return { manifestId: "seed-manifest", manifestVersion: "1" };
    case "governedAssets":
      return { assetKey: "seed-asset", assetVersion: "1" };
    case "runtimeActivationAudits":
      return { activationAuditId: "seed-activation" };
    case "storageMetadata":
      return { key: "seed-metadata" };
  }
}

async function seedAllTables(database: JagaOnDatabase) {
  for (const table of JAGAON_TABLE_NAMES) {
    await database.table<Record<string, unknown>>(table).add(seedRow(table));
  }
}

const resetAt = instantSchema.parse("2026-09-30T12:00:00Z");

function reset(database: JagaOnDatabase) {
  return resetSyntheticDemoStorage(database, {
    releaseProfile: "HACKATHON_DEMO",
    confirmation: DEMO_STORAGE_RESET_CONFIRMATION,
    resetAt,
  });
}

describe("synthetic demo storage reset", () => {
  it("rejects a non-demo release profile before changing storage", async () => {
    const database = await openDatabase();
    await seedAllTables(database);

    await expect(
      resetSyntheticDemoStorage(database, {
        releaseProfile: "PATIENT_RELEASE" as ImplementedReleaseProfile,
        confirmation: DEMO_STORAGE_RESET_CONFIRMATION,
        resetAt,
      }),
    ).rejects.toThrow();

    for (const table of JAGAON_TABLE_NAMES) {
      await expect(database.table(table).count()).resolves.toBe(1);
    }
  });

  it("rejects the wrong confirmation literal before changing storage", async () => {
    const database = await openDatabase();
    await seedAllTables(database);

    await expect(
      resetSyntheticDemoStorage(database, {
        releaseProfile: "HACKATHON_DEMO",
        confirmation: "RESET" as typeof DEMO_STORAGE_RESET_CONFIRMATION,
        resetAt,
      }),
    ).rejects.toThrow();

    for (const table of JAGAON_TABLE_NAMES) {
      await expect(database.table(table).count()).resolves.toBe(1);
    }
  });

  it("clears exactly all 16 approved tables and initializes one sequence row", async () => {
    const database = await openDatabase();
    await seedAllTables(database);

    await reset(database);

    expect(database.tables.map((table) => table.name)).toEqual([
      ...JAGAON_TABLE_NAMES,
    ]);
    for (const table of JAGAON_TABLE_NAMES) {
      await expect(database.table(table).count()).resolves.toBe(
        table === "storageMetadata" ? 1 : 0,
      );
    }
    await expect(
      database.table("storageMetadata").toArray(),
    ).resolves.toEqual([
      {
        key: "EVENT_SEQUENCE_HIGH_WATER_MARK",
        lastAllocatedSequence: 0,
        updatedAt: resetAt,
      },
    ]);
  });

  it("rolls every clear back when sequence initialization fails", async () => {
    const database = await openDatabase();
    await seedAllTables(database);
    database.table("storageMetadata").hook("creating", (_key, row) => {
      if (
        typeof row === "object" &&
        row !== null &&
        "key" in row &&
        row.key === "EVENT_SEQUENCE_HIGH_WATER_MARK"
      ) {
        throw new Error("injected reset failure");
      }
    });

    await expect(reset(database)).rejects.toThrow();

    for (const table of JAGAON_TABLE_NAMES) {
      await expect(database.table(table).count()).resolves.toBe(1);
    }
  });
});
