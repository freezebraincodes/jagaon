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

describe("care-summary invalidation worker", () => {
  it("invalidates a snapshot when its selected question or appointment is revised, and does nothing twice", async () => {
    const h = await createCarePreparationHarness();
    const question = await h.organisation.createCareQuestion({ questionText: { text: "Bring my meter?", language: "en-SG" } });
    if (question.kind !== "COMMITTED") throw new Error("question");
    const prepared = await h.service.prepare(await h.selection());
    if (prepared.kind !== "COMMITTED") throw new Error(JSON.stringify(prepared));
    await h.organisation.reviseCareQuestion({ recordId: question.recordId, expectedRevisionId: question.revisionId, expectedRevisionNumber: 1, questionText: { text: "Bring my meter and pen?", language: "en-SG" }, state: "READY_TO_ASK" });
    const first = await h.invalidation.processPending();
    expect(first.committedCommands).toBe(1);
    const view = await h.query.loadSummary(prepared.recordId);
    expect(view.status === "READY" && [view.snapshotStatus, view.payload.invalidation?.reason]).toEqual(["INVALIDATED", "SOURCE_SUPERSEDED"]);
    expect((await h.invalidation.processPending()).committedCommands).toBe(0);
  });

  it("leaves snapshots that never used the changed revision untouched", async () => {
    const h = await createCarePreparationHarness();
    const question = await h.organisation.createCareQuestion({ questionText: { text: "Separate question", language: "en-SG" } });
    if (question.kind !== "COMMITTED") throw new Error("question");
    const appointmentOnly = await h.service.prepare(await h.selection({ questions: [] }));
    if (appointmentOnly.kind !== "COMMITTED") throw new Error("prepared");
    await h.organisation.reviseCareQuestion({ recordId: question.recordId, expectedRevisionId: question.revisionId, expectedRevisionNumber: 1, questionText: { text: "Separate question", language: "en-SG" }, state: "DISMISSED" });
    await h.invalidation.processPending();
    const view = await h.query.loadSummary(appointmentOnly.recordId);
    expect(view.status === "READY" && view.snapshotStatus).toBe("PREPARED");
  });
});
