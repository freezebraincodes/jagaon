import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import Dexie from "dexie";
import fakeIndexedDB, { IDBKeyRange as FDBKeyRange } from "fake-indexeddb";
import { NOW, closeCarePreparationHarnesses, createCarePreparationHarness, exact } from "./care-preparation-test-support";
import { loadCareSummaryDraft } from "./care-summary-candidates";

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

const glucose = (note?: string) => ({
  measurement: { enteredValue: "7.1" as never, enteredUnit: "MMOL_L" as const, normalization: null },
  measurementMethod: "FINGERSTICK_METER" as const,
  context: { kind: "PATIENT_SELECTED_SLOT" as const, slot: "BEDTIME" as const },
  ...(note ? { patientNote: { text: note, language: "en-SG" as const } } : {}),
});

describe("care-summary candidates", () => {
  it("reads only explicitly selected facts in stable time order and never reads private notes", async () => {
    const h = await createCarePreparationHarness();
    await h.journal.recordGlucose({ payload: glucose("Private words about my evening"), temporal: { kind: "POINT", occurrence: exact("2026-10-03T13:00:00.000Z") }, recordedAt: NOW });
    await h.journal.recordGlucose({ payload: glucose(), temporal: { kind: "POINT", occurrence: exact("2026-10-01T13:00:00.000Z") }, recordedAt: NOW });
    const selection = await h.selection();
    const loaded = await loadCareSummaryDraft(h.database, selection, NOW);
    if (loaded.kind !== "OK") throw new Error(loaded.kind);
    expect(loaded.selections).toBe(2);
    const facts = loaded.draft.groups[0]!.facts;
    expect(facts.map((fact) => fact.kind)).toEqual(["GLUCOSE", "GLUCOSE"]);
    expect(JSON.stringify(loaded.draft)).not.toContain("Private words");

    const prepared = await h.service.prepare(selection);
    if (prepared.kind !== "COMMITTED") throw new Error("prepared");
    const view = await h.query.loadSummary(prepared.recordId);
    if (view.status !== "READY") throw new Error("ready");
    const glucoseText = view.payload.sections.find((section) => section.sectionId === "MEASUREMENTS")!.blocks[0]!;
    expect(glucoseText.kind === "RECORDED_FACT" && glucoseText.renderedText.split("\n").slice(1)).toEqual(["1 Oct 2026, 9:00 pm · 7.1 mmol/L", "3 Oct 2026, 9:00 pm · 7.1 mmol/L"]);
    expect(JSON.stringify(view.payload)).not.toContain("Private words");
  });

  it("keeps unticked candidates as local NOT_SELECTED exclusions that the summary never shows", async () => {
    const h = await createCarePreparationHarness();
    const reading = await h.journal.recordGlucose({ payload: glucose(), temporal: { kind: "POINT", occurrence: exact("2026-10-03T13:00:00.000Z") }, recordedAt: NOW });
    if (reading.kind !== "COMMITTED") throw new Error("reading");
    const ref = { recordType: "GLUCOSE_READING" as const, recordId: reading.recordId, revisionId: reading.revisionId };
    const prepared = await h.service.prepare(await h.selection({ groups: [], notSelected: [ref] }));
    if (prepared.kind !== "COMMITTED") throw new Error(JSON.stringify(prepared));
    const view = await h.query.loadSummary(prepared.recordId);
    if (view.status !== "READY") throw new Error("ready");
    expect(view.payload.selection.excludedCandidates).toEqual([{ source: ref, reason: "NOT_SELECTED" }]);
    expect(JSON.stringify(view.payload.sections)).not.toContain(reading.recordId);
    expect(view.payload.sections.map((section) => section.sectionId)).toEqual(["SUMMARY_SCOPE", "CARE_ORGANISATION", "DATA_LIMITATIONS"]);
  });
});
