import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import Dexie from "dexie";
import fakeIndexedDB, { IDBKeyRange as FDBKeyRange } from "fake-indexeddb";
import { instantSchema } from "@/domain/shared/time";
import { createJagaOnDatabase, type JagaOnDatabase } from "./database";
import type { AppPreferenceRow } from "./app-preference-row";
import { createBootstrapLocaleRepository } from "./bootstrap-locale-repository";
import { createKeepWordingPreferenceRepository } from "./keep-wording-preference-repository";

/**
 * Packet 11C Addendum C, Task C2 (hybrid spec D11): the patient's "Keep wording on this device" setting, stored with the language
 * setting in `appPreferences`. Default (no row) off; a row that cannot be read keeps wording on the device (fail closed: nothing sent).
 */
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
  const database = createJagaOnDatabase(`keep-wording-${crypto.randomUUID()}`);
  databases.push(database);
  await database.open();
  return database;
}
const at = instantSchema.parse("2026-10-08T01:00:00.000Z");
const later = instantSchema.parse("2026-10-08T02:00:00.000Z");

describe("keep-wording preference repository (Packet 11C C2)", () => {
  it("is off when no row exists (every existing dataset)", async () => {
    const database = await openDatabase();
    await expect(createKeepWordingPreferenceRepository(database).read()).resolves.toBe(false);
    expect(await database.table("appPreferences").toArray()).toEqual([]);
  });

  it("persists on and off as one exact versioned row and reads it back", async () => {
    const database = await openDatabase();
    const repository = createKeepWordingPreferenceRepository(database);
    await repository.persist(true, at);
    await expect(repository.read()).resolves.toBe(true);
    expect(await database.table<AppPreferenceRow>("appPreferences").toArray()).toEqual([
      { key: "keepWordingOnDevice", preferenceSchemaVersion: "app-preference.keep-wording.11c.1", value: true, updatedAt: at },
    ]);
    await repository.persist(false, later);
    await expect(repository.read()).resolves.toBe(false);
    expect(await database.table<AppPreferenceRow>("appPreferences").toArray()).toEqual([
      { key: "keepWordingOnDevice", preferenceSchemaVersion: "app-preference.keep-wording.11c.1", value: false, updatedAt: later },
    ]);
  });

  it("leaves the language row untouched, and the language repository leaves this row untouched", async () => {
    const database = await openDatabase();
    const repository = createKeepWordingPreferenceRepository(database);
    await createBootstrapLocaleRepository(database).resolve("zh-SG", at);
    await repository.persist(true, later);
    await expect(createBootstrapLocaleRepository(database).resolve(null, later)).resolves.toBe("zh-SG");
    await expect(repository.read()).resolves.toBe(true);
    expect((await database.table<AppPreferenceRow>("appPreferences").toArray()).map((row) => row.key).sort()).toEqual(["keepWordingOnDevice", "language"]);
  });

  it("fails closed: a stored row that does not validate reads as on and is never rewritten by a read", async () => {
    const database = await openDatabase();
    const malformed = { key: "keepWordingOnDevice", preferenceSchemaVersion: "app-preference.keep-wording.11c.1", value: "yes", updatedAt: at };
    await database.table("appPreferences").put(malformed as never);
    await expect(createKeepWordingPreferenceRepository(database).read()).resolves.toBe(true);
    expect(await database.table("appPreferences").get("keepWordingOnDevice")).toEqual(malformed);
  });

  it("rejects a non-boolean value before writing anything", async () => {
    const database = await openDatabase();
    await expect(createKeepWordingPreferenceRepository(database).persist("true" as never, at)).rejects.toThrow();
    expect(await database.table("appPreferences").toArray()).toEqual([]);
  });
});
