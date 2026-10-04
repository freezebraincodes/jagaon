import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import Dexie from "dexie";
import fakeIndexedDB, { IDBKeyRange as FDBKeyRange } from "fake-indexeddb";
import { closeCarePreparationHarnesses, createCarePreparationHarness } from "./care-preparation-test-support";

const originalIndexedDB = Dexie.dependencies.indexedDB;
const originalKeyRange = Dexie.dependencies.IDBKeyRange;
beforeAll(() => {
  Dexie.dependencies.indexedDB = fakeIndexedDB;
  Dexie.dependencies.IDBKeyRange = FDBKeyRange;
});
afterAll(() => {
  Dexie.dependencies.indexedDB = originalIndexedDB;
  Dexie.dependencies.IDBKeyRange = originalKeyRange;
});
afterEach(() => closeCarePreparationHarnesses());

describe("care-preparation query", () => {
  it("reports not-found for an unknown snapshot and unavailable when storage cannot be read", async () => {
    const h = await createCarePreparationHarness();
    expect(await h.query.loadSummary(crypto.randomUUID() as never)).toEqual({ status: "NOT_FOUND" });
    const prepared = await h.service.prepare(await h.selection());
    if (prepared.kind !== "COMMITTED") throw new Error("prepared");
    h.database.close();
    expect(await h.query.loadSummary(prepared.recordId)).toEqual({ status: "UNAVAILABLE" });
  });

  it("relays the stored snapshot exactly, with no export attempts before the patient prints", async () => {
    const h = await createCarePreparationHarness();
    const prepared = await h.service.prepare(await h.selection());
    if (prepared.kind !== "COMMITTED") throw new Error("prepared");
    const view = await h.query.loadSummary(prepared.recordId);
    if (view.status !== "READY") throw new Error("ready");
    expect([view.snapshotStatus, view.sourcesCurrent, view.exports]).toEqual(["PREPARED", true, []]);
    expect(view.payload.patientApproval).toEqual({ state: "NOT_APPROVED" });
  });
});
