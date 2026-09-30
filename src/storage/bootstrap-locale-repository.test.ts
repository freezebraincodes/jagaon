import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import Dexie from "dexie";
import fakeIndexedDB, { IDBKeyRange as FDBKeyRange } from "fake-indexeddb";
import type { SupportedLocale } from "@/domain/patient-settings/locale";
import { instantSchema } from "@/domain/shared/time";
import { createJagaOnDatabase, type JagaOnDatabase } from "./database";
import type { AppPreferenceRow } from "./app-preference-row";
import { createBootstrapLocaleRepository } from "./bootstrap-locale-repository";

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
  for (const database of databases) database.close();
  const names = [...new Set(databases.map((database) => database.name))];
  databases.length = 0;
  for (const name of names) await Dexie.delete(name);
});

async function openDatabase() {
  const database = createJagaOnDatabase(`locale-${crypto.randomUUID()}`);
  databases.push(database);
  await database.open();
  return database;
}

const updatedAt = instantSchema.parse("2026-09-30T12:00:00Z");

describe("bootstrap locale reconciliation", () => {
  it("uses canonical locale and repairs a stale projection", async () => {
    const database = await openDatabase();
    await database.table<AppPreferenceRow>("appPreferences").put({
      key: "language",
      value: "en-SG",
      updatedAt: instantSchema.parse("2026-09-29T12:00:00Z"),
    });
    const repository = createBootstrapLocaleRepository(database);

    await expect(repository.resolve("zh-SG", updatedAt)).resolves.toBe(
      "zh-SG",
    );
    await expect(
      database.table<AppPreferenceRow>("appPreferences").get("language"),
    ).resolves.toEqual({ key: "language", value: "zh-SG", updatedAt });
  });

  it("preserves a valid pre-onboarding projection when canonical locale is absent", async () => {
    const database = await openDatabase();
    const row: AppPreferenceRow = {
      key: "language",
      value: "zh-SG",
      updatedAt,
    };
    await database.table<AppPreferenceRow>("appPreferences").put(row);
    const repository = createBootstrapLocaleRepository(database);

    await expect(repository.resolve(null, updatedAt)).resolves.toBe("zh-SG");
    await expect(
      database.table<AppPreferenceRow>("appPreferences").get("language"),
    ).resolves.toEqual(row);
  });

  it("returns en-SG for a missing projection without persisting health truth", async () => {
    const database = await openDatabase();
    const repository = createBootstrapLocaleRepository(database);

    await expect(repository.resolve(null, updatedAt)).resolves.toBe("en-SG");
    await expect(database.table("appPreferences").count()).resolves.toBe(0);
  });

  it("deletes a malformed rebuildable row and returns only the neutral fallback", async () => {
    const database = await openDatabase();
    await database.table<unknown>("appPreferences").put({
      key: "language",
      value: "fr-FR",
      updatedAt,
    });
    const repository = createBootstrapLocaleRepository(database);

    await expect(repository.resolve(null, updatedAt)).resolves.toBe("en-SG");
    await expect(database.table("appPreferences").count()).resolves.toBe(0);
  });

  it("rejects an unsupported canonical locale at runtime", async () => {
    const database = await openDatabase();
    const repository = createBootstrapLocaleRepository(database);

    await expect(
      repository.resolve("fr-FR" as SupportedLocale, updatedAt),
    ).rejects.toThrow();
  });
});
