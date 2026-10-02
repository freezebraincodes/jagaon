import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import Dexie from "dexie";
import fakeIndexedDB, { IDBKeyRange as FDBKeyRange } from "fake-indexeddb";
import { createBrowserJournalRuntime } from "./browser-journal-runtime";

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

const runtimes: Awaited<ReturnType<typeof createBrowserJournalRuntime>>[] = [];

afterEach(async () => {
  const names = runtimes.map((runtime) => runtime.databaseName);
  for (const runtime of runtimes) runtime.close();
  runtimes.length = 0;
  for (const name of names) await Dexie.delete(name);
});

describe("browser journal runtime", () => {
  it("opens storage and bootstraps the synthetic scenario through journal commands", async () => {
    const runtime = await createBrowserJournalRuntime(
      `packet-6-runtime-${crypto.randomUUID()}`,
    );
    runtimes.push(runtime);

    const today = await runtime.query.loadToday();

    expect(today.unavailable).toBe(false);
    expect(today.entries).toHaveLength(1);
    expect(today.entries[0]?.recordType).toBe("GLUCOSE_READING");
    expect(today.entries[0]?.summary).toContain("6.2 mmol/L");
  });

  it("persists an explicit locale and restores a clean synthetic scenario after reset", async () => {
    const runtime = await createBrowserJournalRuntime(
      `packet-6-runtime-${crypto.randomUUID()}`,
    );
    runtimes.push(runtime);

    await runtime.persistLocale("zh-SG");
    expect(await runtime.resolveLocale()).toBe("zh-SG");

    await runtime.resetDemo();

    expect(await runtime.resolveLocale()).toBe("en-SG");
    expect((await runtime.query.loadToday()).entries).toHaveLength(1);
  });
});
