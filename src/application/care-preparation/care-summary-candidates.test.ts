import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import Dexie from "dexie";
import fakeIndexedDB, { IDBKeyRange as FDBKeyRange } from "fake-indexeddb";
import { NOW, closeCarePreparationHarnesses, createCarePreparationHarness, exact } from "./care-preparation-test-support";
import { loadCareSummaryDraft } from "./care-summary-candidates";
import { printableCareSummary } from "./care-summary-artifact";
import { carePlanRevisionRowCodec } from "@/application/care-plan/care-plan-persistence";
import { CARE_QUESTION_BASIS_POLICY } from "@/domain/care-plan/care-question";

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

/**
 * Packet 11C Task 8 (Addendum A3) regressions: only the person's own READY_TO_ASK questions can be selected or included.
 * No command creates a DRAFT or a JaGaOn-prepared question yet, so those stored revisions are written here as valid rows
 * (the codec still validates them); a DISMISSED question and a confirmed prepared question use the real revise command.
 */
describe("care-summary candidates: question states (A3)", () => {
  type Harness = Awaited<ReturnType<typeof createCarePreparationHarness>>;
  const questionRef = (created: { recordId: unknown; revisionId: unknown }) => ({ recordType: "CARE_QUESTION" as const, recordId: created.recordId as never, revisionId: created.revisionId as never });

  async function rewriteStoredPayload(h: Harness, revisionId: string, change: (payload: Record<string, unknown>) => Record<string, unknown>) {
    const row = (await h.database.table("recordRevisions").get(revisionId)) as { revision: { payload: Record<string, unknown> } };
    const next = { ...row, revision: { ...row.revision, payload: change(row.revision.payload) } };
    await h.database.table("recordRevisions").put(carePlanRevisionRowCodec.validateForWrite(next));
  }

  async function create(h: Harness, text: string) {
    const created = await h.organisation.createCareQuestion({ questionText: { text, language: "en-SG" } });
    if (created.kind !== "COMMITTED") throw new Error("question");
    return created;
  }

  async function prepared(h: Harness, text: string) {
    const created = await create(h, text);
    const selection = await h.selection();
    const appointment = selection.appointment!;
    await rewriteStoredPayload(h, created.revisionId, (payload) => ({
      ...payload,
      state: "DRAFT",
      origin: { kind: "JAGAON_PREPARED", purpose: "REVIEW_PREVENTIVE_CARE", basis: [appointment], basisPolicyVersion: CARE_QUESTION_BASIS_POLICY.version, preparationRuleVersion: "prep.1" },
    }));
    return created;
  }

  async function expectNeverSelectableOrIncluded(h: Harness, ref: ReturnType<typeof questionRef>, text: string) {
    const offered = await h.selection();
    // Never offered for selection.
    expect(offered.questions.map((entry) => entry.recordId)).not.toContain(ref.recordId);
    // Never included, even when a caller forces it into the selection.
    const forced = { ...offered, questions: [...offered.questions, ref] };
    expect((await loadCareSummaryDraft(h.database, forced, NOW)).kind).toBe("INELIGIBLE");
    const result = await h.service.prepare(forced);
    expect(result.kind).not.toBe("COMMITTED");
    const included = await h.service.prepare(offered);
    if (included.kind !== "COMMITTED") throw new Error(JSON.stringify(included));
    const view = await h.query.loadSummary(included.recordId);
    if (view.status !== "READY") throw new Error("ready");
    expect(JSON.stringify(view.payload)).not.toContain(text);
    expect(JSON.stringify(view.payload)).not.toContain(ref.recordId);
  }

  it("never selects or includes a DRAFT question", async () => {
    const h = await createCarePreparationHarness();
    await create(h, "Ready question kept");
    const draft = await create(h, "Draft question words");
    await rewriteStoredPayload(h, draft.revisionId, (payload) => ({ ...payload, state: "DRAFT" }));
    await expectNeverSelectableOrIncluded(h, questionRef(draft), "Draft question words");
  });

  it("never selects or includes a DISMISSED question", async () => {
    const h = await createCarePreparationHarness();
    await create(h, "Ready question kept");
    const created = await create(h, "Dismissed question words");
    const dismissed = await h.organisation.reviseCareQuestion({ recordId: created.recordId, expectedRevisionId: created.revisionId, expectedRevisionNumber: 1, questionText: { text: "Dismissed question words", language: "en-SG" }, state: "DISMISSED" });
    if (dismissed.kind !== "COMMITTED") throw new Error(JSON.stringify(dismissed));
    await expectNeverSelectableOrIncluded(h, questionRef(dismissed), "Dismissed question words");
  });

  it("never selects or includes a JAGAON_PREPARED question, as a draft or after the person confirmed it", async () => {
    const h = await createCarePreparationHarness();
    await create(h, "Ready question kept");
    const draft = await prepared(h, "Prepared question words");
    await expectNeverSelectableOrIncluded(h, questionRef(draft), "Prepared question words");
    // Confirming keeps the prepared origin (revise carries the previous payload); it is still not the person's own question.
    const confirmed = await h.organisation.reviseCareQuestion({ recordId: draft.recordId, expectedRevisionId: draft.revisionId, expectedRevisionNumber: 1, questionText: { text: "Prepared question words", language: "en-SG" }, state: "READY_TO_ASK" });
    if (confirmed.kind !== "COMMITTED") throw new Error(JSON.stringify(confirmed));
    await expectNeverSelectableOrIncluded(h, questionRef(confirmed), "Prepared question words");
  });

  it("quotes an included READY_TO_ASK question verbatim, in the draft, the snapshot and the printable lines", async () => {
    const h = await createCarePreparationHarness();
    const text = "can i bring my meter on plane?  need doctor letter?? (ask nurse ok)";
    const created = await create(h, text);
    const selection = await h.selection();
    expect(selection.questions).toEqual([questionRef(created)]);
    const loaded = await loadCareSummaryDraft(h.database, selection, NOW);
    if (loaded.kind !== "OK") throw new Error(loaded.kind);
    expect(loaded.draft.questions.map((question) => [question.text, question.language])).toEqual([[text, "en-SG"]]);
    const result = await h.service.prepare(selection);
    if (result.kind !== "COMMITTED") throw new Error(JSON.stringify(result));
    const view = await h.query.loadSummary(result.recordId);
    if (view.status !== "READY") throw new Error("ready");
    const questions = view.payload.sections.find((section) => section.sectionId === "QUESTIONS_FOR_CARE_TEAM")!.blocks;
    expect(questions.map((block) => block.kind === "PATIENT_QUESTION" && block.originalPatientText)).toEqual([{ text, language: "en-SG" }]);
    expect(printableCareSummary(view.payload).lines.filter((line) => line.kind === "QUESTION")).toEqual([{ kind: "QUESTION", text, language: "en-SG" }]);
  });
});
