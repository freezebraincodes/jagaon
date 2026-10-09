import { afterEach, describe, expect, it } from "vitest";
import Dexie from "dexie";
import fakeIndexedDB from "fake-indexeddb";
import { createBrowserJournalRuntime } from "@/application/journal/browser-journal-runtime";
import { clearJagaOnLocalState, createMemoryOnboardingStorage, DEMO_ONBOARDING_STORAGE_KEY, JAGAON_LOCAL_STATE_KEYS } from "@/application/onboarding/demo-onboarding-repository";
import { createBrowserDatabaseDeletion } from "@/application/storage/browser-dataset-lifecycle";
import { createPopulatedDataset, openRaw, PACKET10_NOW, readAllTables, installFakeIndexedDb } from "@/application/storage/packet10-test-support";
import { createDeleteDatasetService, DELETE_ALL_CONFIRMATION_TOKEN, type DatasetConnectionCoordinator } from "./delete-dataset";
import { JAGAON_TABLE_NAMES } from "./table-catalogue";

installFakeIndexedDb();
const INTEGRATION_TIMEOUT_MS = 60_000;
const names: string[] = [];
afterEach(async () => {
  for (const name of names.splice(0)) await Dexie.delete(name);
});

function coordinator(othersOpen: boolean) {
  const calls = { acquired: 0, released: 0, announced: 0 };
  const port: DatasetConnectionCoordinator = {
    async acquireExclusive() {
      if (othersOpen) return null;
      calls.acquired += 1;
      return () => (calls.released += 1);
    },
    announceDeleted: () => (calls.announced += 1),
  };
  return { port, calls };
}

async function setup(othersOpen = false) {
  const { name, runtime } = await createPopulatedDataset();
  names.push(name);
  const storage = createMemoryOnboardingStorage();
  for (const key of JAGAON_LOCAL_STATE_KEYS) storage.setItem(key, "{}");
  storage.setItem("unrelated:key", "kept");
  const { port, calls } = coordinator(othersOpen);
  let clock = PACKET10_NOW as string;
  let closed = 0;
  const service = createDeleteDatasetService({
    databaseName: name,
    now: () => clock as never,
    coordinator: port,
    deletion: createBrowserDatabaseDeletion(),
    closeOwnConnections: () => {
      closed += 1;
      runtime.close();
    },
    clearLocalState: () => clearJagaOnLocalState(storage),
  });
  return { name, runtime, storage, service, calls, closed: () => closed, setClock: (value: string) => (clock = value) };
}

describe("whole-dataset deletion (SDEL-012)", () => {
  it("uses the exact locked DELETE token in every locale", () => {
    expect(DELETE_ALL_CONFIRMATION_TOKEN).toBe("DELETE");
  });

  it(
    "requires a fresh exact confirmation and changes nothing otherwise",
    async () => {
      const h = await setup();
      const plan = h.service.prepare();
      for (const token of ["delete", "DELETE ", "删除", ""]) expect(await h.service.confirm(plan, token)).toEqual({ kind: "CONFIRMATION_REQUIRED" });
      h.setClock("2026-10-04T02:10:00.001Z");
      expect(await h.service.confirm(plan, "DELETE")).toEqual({ kind: "CONFIRMATION_REQUIRED" });
      expect(await Dexie.exists(h.name)).toBe(true);
      expect(h.closed()).toBe(0);
      h.runtime.close();
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "is blocked by another open tab before anything is requested, and the dataset is untouched",
    async () => {
      const h = await setup(true);
      h.runtime.close();
      const database = await openRaw(h.name);
      const before = await readAllTables(database);
      database.close();
      const result = await h.service.confirm(h.service.prepare(), "DELETE");
      expect(result).toMatchObject({ kind: "BLOCKED", failure: { errorCode: "DATASET_DELETE_BLOCKED", userMessageKey: "packet10.deletion.deleteBlocked", retryClass: "PATIENT_ACTION_REQUIRED" } });
      const after = await openRaw(h.name);
      expect(await readAllTables(after)).toEqual(before);
      after.close();
      expect(h.storage.getItem(DEMO_ONBOARDING_STORAGE_KEY)).toBe("{}");
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "removes every table, metadata row and local key, then a later launch creates a new empty identity",
    async () => {
      const h = await setup();
      const oldIdentity = await openRaw(h.name).then(async (database) => {
        const row = await database.table("storageMetadata").get("DATABASE_IDENTITY");
        database.close();
        return (row as { datasetIdentity: string }).datasetIdentity;
      });
      expect(await h.service.confirm(h.service.prepare(), "DELETE")).toEqual({ kind: "DELETED", localStateCleared: true });
      expect(await Dexie.exists(h.name)).toBe(false);
      expect(h.calls).toEqual({ acquired: 1, released: 1, announced: 1 });
      for (const key of JAGAON_LOCAL_STATE_KEYS) expect(h.storage.getItem(key)).toBeNull();
      expect(h.storage.getItem("unrelated:key")).toBe("kept");

      const restarted = await createBrowserJournalRuntime(h.name, { now: () => PACKET10_NOW, seedSyntheticScenarioOnCreate: false });
      restarted.close();
      const database = await openRaw(h.name);
      const tables = await readAllTables(database);
      database.close();
      for (const table of JAGAON_TABLE_NAMES.filter((entry) => entry !== "storageMetadata")) expect(tables[table], table).toEqual([]);
      const identity = tables.storageMetadata.find((row) => (row as { key: string }).key === "DATABASE_IDENTITY") as { datasetIdentity: string };
      expect(identity.datasetIdentity).not.toBe(oldIdentity);
      // A plain reload of the new empty dataset never seeds the synthetic scenario.
      const reloaded = await createBrowserJournalRuntime(h.name, { now: () => PACKET10_NOW });
      expect((await reloaded.query.loadToday()).entries).toEqual([]);
      reloaded.close();
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "Packet 11C C2: deleting all data also removes the 'Keep wording on this device' setting; the new dataset reads it as off",
    async () => {
      const h = await setup();
      await h.runtime.keepWordingOnDevice.persist(true);
      expect(await h.runtime.keepWordingOnDevice.read()).toBe(true);
      expect(await h.service.confirm(h.service.prepare(), "DELETE")).toEqual({ kind: "DELETED", localStateCleared: true });
      expect(await Dexie.exists(h.name)).toBe(false);
      const restarted = await createBrowserJournalRuntime(h.name, { now: () => PACKET10_NOW, seedSyntheticScenarioOnCreate: false });
      expect(await restarted.keepWordingOnDevice.read()).toBe(false);
      restarted.close();
      const database = await openRaw(h.name);
      expect(await database.table("appPreferences").toArray()).toEqual([]);
      database.close();
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it("waits for an unknown connection rather than claiming success, and reports it as blocked meanwhile", async () => {
    const name = `packet10-delete-blocked-${crypto.randomUUID()}`;
    names.push(name);
    const blocker = await new Promise<IDBDatabase>((resolve) => {
      const request = fakeIndexedDB.open(name, 1);
      request.onsuccess = () => resolve(request.result);
    });
    blocker.onversionchange = () => undefined;
    let blocked = 0;
    const deletion = createBrowserDatabaseDeletion().deleteDatabase(name, () => (blocked += 1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(blocked).toBe(1);
    blocker.close();
    await deletion;
    expect(await Dexie.exists(name)).toBe(false);
  });

  it("never clears local state before the database deletion succeeds (item 5)", async () => {
    const order: string[] = [];
    const service = createDeleteDatasetService({
      databaseName: "packet10-order",
      now: () => PACKET10_NOW,
      coordinator: { acquireExclusive: async () => () => undefined, announceDeleted: () => undefined },
      deletion: {
        deleteDatabase: async () => {
          order.push("delete");
          throw Object.assign(new Error("x"), { name: "UnknownError" });
        },
        exists: async () => true,
      },
      closeOwnConnections: () => void order.push("close"),
      clearLocalState: () => void order.push("clear-local"),
    });
    expect(await service.confirm(service.prepare(), "DELETE")).toMatchObject({ kind: "FAILED" });
    expect(order).toEqual(["close", "delete"]);
  });

  it("reports a truthful completed deletion when only auxiliary local state could not be cleared", async () => {
    const events: string[] = [];
    const service = createDeleteDatasetService({
      databaseName: "packet10-aux",
      now: () => PACKET10_NOW,
      coordinator: { acquireExclusive: async () => () => undefined, announceDeleted: () => undefined },
      deletion: { deleteDatabase: async () => void events.push("delete"), exists: async () => false },
      closeOwnConnections: () => undefined,
      clearLocalState: () => {
        events.push("clear-local");
        throw new Error("storage unavailable");
      },
    });
    const result = await service.confirm(service.prepare(), "DELETE", { onRequestIssued: () => events.push("issued") });
    expect(result).toEqual({ kind: "DELETED", localStateCleared: false });
    expect(events).toEqual(["issued", "delete", "clear-local"]);
  });
});
