import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import Dexie from "dexie";
import fakeIndexedDB, { IDBKeyRange as FDBKeyRange } from "fake-indexeddb";
import type { Instant, RecordHead, RecordId } from "@/domain/shared";
import { createJagaOnDatabase, type JagaOnDatabase } from "@/storage/database";
import { createCarePlanCommandService } from "@/application/care-plan/care-plan-command-service";
import { createJournalCommandService } from "@/application/journal/journal-command-service";
import { createCareOrganisationService } from "@/application/care-organisation/care-organisation-service";
import { createCareOrganisationQuery } from "@/application/care-organisation/care-organisation-query";
import { seedSyntheticCareOrganisation } from "@/application/care-organisation/synthetic-care-organisation-seed";
import { carePreparationRevisionRowCodec } from "./care-preparation-persistence";
import { createCarePreparationService } from "./care-preparation-service";
import { createCarePreparationQuery } from "./care-preparation-query";
import { createCareSummaryInvalidation } from "./care-summary-invalidation";
import { printableCareSummary } from "./care-summary-artifact";
import type { CareSummarySelectionInput } from "./care-preparation-contracts";
import { rewriteAsLegacy9c1Snapshot } from "./care-preparation-test-support";
import { AI_LANGUAGE_COPY } from "@/application/ai/language/ai-language-copy";

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
const open: JagaOnDatabase[] = [];
afterEach(async () => {
  for (const database of open.splice(0)) {
    database.close();
    await Dexie.delete(database.name);
  }
});

const uuid = () => crypto.randomUUID() as never;
// Sunday 4 Oct 2026, 10:00 in Singapore.
const NOW = "2026-10-04T02:00:00.000Z" as Instant;
const ids = { commandId: uuid, correlationId: uuid, recordId: uuid, revisionId: uuid, auditEventId: uuid, transactionId: uuid, domainEventId: uuid, workItemId: uuid };
const exact = (instantUtc: string) => ({ kind: "EXACT" as const, instantUtc: instantUtc as Instant, timeZoneId: "Asia/Singapore" as never, utcOffsetMinutes: 480 });
const glucosePayload = { measurement: { enteredValue: "6.6" as never, enteredUnit: "MMOL_L" as const, normalization: null }, measurementMethod: "FINGERSTICK_METER" as const, context: { kind: "PATIENT_SELECTED_SLOT" as const, slot: "BEDTIME" as const } };

async function setup() {
  const database = createJagaOnDatabase(`packet9c-service-${crypto.randomUUID()}`);
  open.push(database);
  await database.open();
  let clock = NOW;
  const now = () => clock;
  const carePlan = createCarePlanCommandService(database, { now, ids });
  const journal = createJournalCommandService(database, { now, ids });
  const organisation = createCareOrganisationService(database, { now, ids, carePlan });
  const visit = createCareOrganisationQuery(database, { now });
  const service = createCarePreparationService(database, { now, ids });
  const query = createCarePreparationQuery(database);
  const invalidation = createCareSummaryInvalidation(database, { now, newCommandId: uuid, leaseToken: () => crypto.randomUUID(), instanceId: "test", service });
  await seedSyntheticCareOrganisation({ database, seedAt: NOW, ids, demoQuestion: false });
  const glucose = await journal.recordGlucose({ payload: glucosePayload, temporal: { kind: "POINT", occurrence: exact("2026-10-03T13:00:00.000Z") }, recordedAt: NOW });
  if (glucose.kind !== "COMMITTED") throw new Error("glucose");
  const question = await organisation.createCareQuestion({ questionText: { text: "可以把笔放在包里吗？", language: "zh-SG" } });
  if (question.kind !== "COMMITTED") throw new Error("question");

  async function selection(overrides: Partial<CareSummarySelectionInput> = {}): Promise<CareSummarySelectionInput> {
    const view = await visit.loadVisitPreparation();
    if (view.status !== "READY" || !view.appointment) throw new Error("visit");
    const appointment = view.appointment;
    return {
      locale: "en-SG",
      period: view.period,
      appointment: { recordType: "APPOINTMENT", recordId: appointment.recordId, revisionId: appointment.revisionId },
      groups: [{ key: "GLUCOSE", sources: view.factGroups.find((group) => group.key === "GLUCOSE")!.sources }],
      questions: view.questions.map((entry) => ({ recordType: "CARE_QUESTION" as const, recordId: entry.recordId, revisionId: entry.revisionId })),
      notSelected: [],
      ...overrides,
    };
  }

  const rows = async (recordType: string) => ((await database.table("recordHeads").where("recordType").equals(recordType).toArray()) as RecordHead[]);
  const revisionsOf = async (recordId: RecordId) => (await database.table("recordRevisions").where("recordId").equals(recordId).toArray()).map((row) => carePreparationRevisionRowCodec.validateAfterRead(row).revision);
  return { database, journal, organisation, service, query, invalidation, glucose, question, selection, rows, revisionsOf, setClock: (value: string) => (clock = value as Instant) };
}

type Harness = Awaited<ReturnType<typeof setup>>;
const expected = (result: { recordId: RecordId; revisionId: never | string; revisionNumber: number }) => ({ recordId: result.recordId, expectedRevisionId: result.revisionId as never, expectedRevisionNumber: result.revisionNumber });

async function preparedAndApproved(h: Harness) {
  const prepared = await h.service.prepare(await h.selection());
  if (prepared.kind !== "COMMITTED") throw new Error(JSON.stringify(prepared));
  const loaded = await h.query.loadSummary(prepared.recordId);
  if (loaded.status !== "READY") throw new Error("ready");
  const hash = loaded.payload.rendering.contentHash;
  const previewed = await h.service.markPreviewed({ ...expected(prepared), contentHash: hash });
  if (previewed.kind !== "COMMITTED") throw new Error(JSON.stringify(previewed));
  const approved = await h.service.approve({ ...expected(previewed), contentHash: hash });
  if (approved.kind !== "COMMITTED") throw new Error(JSON.stringify(approved));
  return { prepared, approved, hash };
}

describe("care-summary preparation lifecycle", () => {
  it("prepares an exact source-closed snapshot, previews and approves the same hash, and links exact sources", async () => {
    const h = await setup();
    const prepared = await h.service.prepare(await h.selection());
    if (prepared.kind !== "COMMITTED") throw new Error(JSON.stringify(prepared));
    const view = await h.query.loadSummary(prepared.recordId);
    if (view.status !== "READY") throw new Error("ready");
    expect(view.snapshotStatus).toBe("PREPARED");
    expect(view.sourcesCurrent).toBe(true);
    expect(view.payload.selection.includedSourceRevisions.map((source) => source.recordType)).toEqual(["APPOINTMENT", "GLUCOSE_READING", "CARE_QUESTION"]);
    const edges = await h.database.table("reverseDependencies").where("dependentRecordId").equals(prepared.recordId).toArray();
    expect(edges.map((edge) => [edge.owner, edge.evaluatorKey, edge.dependencyRole]).sort()).toEqual(Array(3).fill(["CARE_PREPARATION", "care-preparation.summary-source", "CARE_SUMMARY_SOURCE"]));

    const { approved, hash } = await preparedAndApproved(h);
    const after = await h.query.loadSummary(approved.recordId);
    if (after.status !== "READY") throw new Error("ready");
    expect(after.snapshotStatus).toBe("APPROVED");
    expect(after.payload.patientApproval).toEqual({ state: "APPROVED", approvedAt: NOW, approvedContentHash: hash });
    // Content never changed across the lifecycle.
    const history = await h.revisionsOf(approved.recordId);
    const contents = history.map((revision) => (revision.recordType === "CARE_SUMMARY_SNAPSHOT" ? JSON.stringify(revision.payload.sections) : ""));
    expect(new Set(contents).size).toBe(1);
    // Events carry only closed reason codes, never summary content.
    const events = await h.database.table("domainEvents").toArray();
    const summaryEvents = events.filter((event) => String(event.eventName).startsWith("CARE_SUMMARY_"));
    expect(summaryEvents.map((event) => event.eventName)).toEqual(expect.arrayContaining(["CARE_SUMMARY_SNAPSHOT_PREPARED", "CARE_SUMMARY_SNAPSHOT_PREVIEWED", "CARE_SUMMARY_SNAPSHOT_APPROVED"]));
    for (const event of summaryEvents) expect(Object.keys(event.payload)).toEqual(["reasonCode"]);
    expect(JSON.stringify(summaryEvents)).not.toContain("可以把笔");
  });

  it("rejects a hash mismatch, approval before preview and export before approval without writing", async () => {
    const h = await setup();
    const prepared = await h.service.prepare(await h.selection());
    if (prepared.kind !== "COMMITTED") throw new Error("prepared");
    expect(await h.service.markPreviewed({ ...expected(prepared), contentHash: "f".repeat(64) })).toEqual({ kind: "REJECTED", code: "SUMMARY_CONTENT_HASH_MISMATCH" });
    const view = await h.query.loadSummary(prepared.recordId);
    if (view.status !== "READY") throw new Error("ready");
    expect(await h.service.approve({ ...expected(prepared), contentHash: view.payload.rendering.contentHash })).toEqual({ kind: "REJECTED", code: "SUMMARY_NOT_APPROVED" });
    expect(await h.service.requestPrintExport({ ...expected(prepared), approvedContentHash: view.payload.rendering.contentHash })).toEqual({ kind: "REJECTED", code: "SUMMARY_NOT_APPROVED" });
    expect(await h.rows("CARE_SUMMARY_EXPORT")).toEqual([]);
    expect((await h.rows("CARE_SUMMARY_SNAPSHOT"))[0]!.headRevisionNumber).toBe(1);
  });

  it("replays an identical prepare command idempotently and rejects a stale expected head", async () => {
    const h = await setup();
    const input = { ...(await h.selection()), commandId: crypto.randomUUID() as never };
    const first = await h.service.prepare(input);
    expect(first.kind).toBe("COMMITTED");
    // A replay of the same command hits the committed receipt; nothing new is created.
    await h.service.prepare(input);
    expect(await h.rows("CARE_SUMMARY_SNAPSHOT")).toHaveLength(1);
    if (first.kind !== "COMMITTED") throw new Error("first");
    const view = await h.query.loadSummary(first.recordId);
    if (view.status !== "READY") throw new Error("ready");
    await h.service.markPreviewed({ ...expected(first), contentHash: view.payload.rendering.contentHash });
    expect(await h.service.markPreviewed({ ...expected(first), contentHash: view.payload.rendering.contentHash })).toEqual({ kind: "REJECTED", code: "HEAD_CONFLICT" });
  });

  it("rejects ineligible, empty, oversized or out-of-period selections", async () => {
    const h = await setup();
    const base = await h.selection();
    expect(await h.service.prepare({ ...base, appointment: null, groups: [], questions: [] })).toEqual({ kind: "REJECTED", code: "SUMMARY_SELECTION_EMPTY" });
    const tooMany = Array.from({ length: 32 }, () => base.questions[0]!);
    expect(await h.service.prepare({ ...base, questions: tooMany })).toEqual({ kind: "REJECTED", code: "SUMMARY_SELECTION_TOO_LARGE" });
    // A revision that is not the current head is never included.
    const stale = { ...base.groups[0]!.sources[0]!, revisionId: crypto.randomUUID() as never };
    expect(await h.service.prepare({ ...base, groups: [{ key: "GLUCOSE", sources: [stale] }] })).toEqual({ kind: "REJECTED", code: "SUMMARY_SOURCE_INELIGIBLE" });
    // A record of the wrong type for its group is never included.
    expect(await h.service.prepare({ ...base, groups: [{ key: "WALKS", sources: base.groups[0]!.sources }] })).toEqual({ kind: "REJECTED", code: "SUMMARY_SOURCE_INELIGIBLE" });
    // A dismissed question is never included.
    const questionHead = base.questions[0]!;
    await h.organisation.reviseCareQuestion({ recordId: questionHead.recordId, expectedRevisionId: questionHead.revisionId, expectedRevisionNumber: 1, questionText: { text: "可以把笔放在包里吗？", language: "zh-SG" }, state: "DISMISSED" });
    const heads = (await h.database.table("recordHeads").get(questionHead.recordId)) as RecordHead;
    expect(await h.service.prepare({ ...base, questions: [{ ...questionHead, revisionId: heads.headRevisionId }] })).toEqual({ kind: "REJECTED", code: "SUMMARY_SOURCE_INELIGIBLE" });
    const outside = await h.journal.recordGlucose({ payload: glucosePayload, temporal: { kind: "POINT", occurrence: exact("2026-07-01T13:00:00.000Z") }, recordedAt: NOW });
    if (outside.kind !== "COMMITTED") throw new Error("outside");
    expect(await h.service.prepare({ ...base, groups: [{ key: "GLUCOSE", sources: [{ recordType: "GLUCOSE_READING", recordId: outside.recordId, revisionId: outside.revisionId }] }] })).toEqual({ kind: "REJECTED", code: "SUMMARY_SOURCE_INELIGIBLE" });
    expect(await h.rows("CARE_SUMMARY_SNAPSHOT")).toEqual([]);
  });

  it("replaces an actionable snapshot by superseding it, never by editing it", async () => {
    const h = await setup();
    const { approved } = await preparedAndApproved(h);
    const replacement = await h.service.prepare({ ...(await h.selection()), locale: "zh-SG", replaces: expected(approved) });
    if (replacement.kind !== "COMMITTED") throw new Error(JSON.stringify(replacement));
    const old = await h.query.loadSummary(approved.recordId);
    const fresh = await h.query.loadSummary(replacement.recordId);
    if (old.status !== "READY" || fresh.status !== "READY") throw new Error("ready");
    expect(old.snapshotStatus).toBe("SUPERSEDED");
    expect(fresh.payload.replacesSnapshot).toEqual({ recordType: "CARE_SUMMARY_SNAPSHOT", recordId: approved.recordId, revisionId: approved.revisionId });
    expect(fresh.payload.rendering.contentHash).not.toBe(old.payload.rendering.contentHash);
    expect(await h.service.requestPrintExport({ ...expected({ ...approved, revisionId: old.revisionId, revisionNumber: old.revisionNumber }), approvedContentHash: old.payload.rendering.contentHash })).toEqual({ kind: "REJECTED", code: "SUMMARY_INVALIDATED_FOR_EXPORT" });
  });
});

describe("correction invalidation", () => {
  it("blocks approval and export after a selected source is corrected, then invalidates the exact dependent snapshot", async () => {
    const h = await setup();
    const prepared = await h.service.prepare(await h.selection());
    if (prepared.kind !== "COMMITTED") throw new Error("prepared");
    const view = await h.query.loadSummary(prepared.recordId);
    if (view.status !== "READY") throw new Error("ready");
    const hash = view.payload.rendering.contentHash;
    const previewed = await h.service.markPreviewed({ ...expected(prepared), contentHash: hash });
    if (previewed.kind !== "COMMITTED") throw new Error("previewed");
    // An unrelated snapshot built without glucose must stay untouched.
    const unrelated = await h.service.prepare({ ...(await h.selection()), groups: [] });
    if (unrelated.kind !== "COMMITTED") throw new Error("unrelated");

    // Race: the glucose time is corrected after preview and before approval.
    const corrected = await h.journal.correctGlucoseTime({ recordId: h.glucose.recordId, expectedRevisionId: h.glucose.revisionId, expectedRevisionNumber: 1, payload: glucosePayload, temporal: { kind: "POINT", occurrence: exact("2026-10-03T12:00:00.000Z") }, recordedAt: NOW });
    expect(corrected.kind).toBe("COMMITTED");
    expect((await h.query.loadSummary(prepared.recordId)).status === "READY" && ((await h.query.loadSummary(prepared.recordId)) as { sourcesCurrent: boolean }).sourcesCurrent).toBe(false);
    expect(await h.service.approve({ ...expected(previewed), contentHash: hash })).toEqual({ kind: "REJECTED", code: "SUMMARY_INVALIDATED_FOR_EXPORT" });

    const report = await h.invalidation.processPending();
    expect(report.failed).toBe(false);
    const invalidated = await h.query.loadSummary(prepared.recordId);
    if (invalidated.status !== "READY") throw new Error("ready");
    expect(invalidated.snapshotStatus).toBe("INVALIDATED");
    expect(invalidated.payload.invalidation).toEqual({ invalidatedAt: NOW, reason: "SOURCE_CORRECTED" });
    const history = await h.revisionsOf(prepared.recordId);
    expect(history.map((revision) => revision.action).sort()).toEqual(["CREATE", "SYSTEM_DERIVE", "UPDATE"]);
    const other = await h.query.loadSummary(unrelated.recordId);
    expect(other.status === "READY" && other.snapshotStatus).toBe("PREPARED");
  });

});

describe("one-attempt print export", () => {
  it("records one REQUESTED attempt before the side effect and exactly one terminal outcome after it", async () => {
    const h = await setup();
    const { approved, hash } = await preparedAndApproved(h);
    const view = await h.query.loadSummary(approved.recordId);
    if (view.status !== "READY") throw new Error("ready");
    const artifact = printableCareSummary(view.payload);
    const requested = await h.service.requestPrintExport({ ...expected(approved), approvedContentHash: hash });
    if (requested.kind !== "COMMITTED") throw new Error(JSON.stringify(requested));
    const pending = await h.query.loadSummary(approved.recordId);
    expect(pending.status === "READY" && pending.exports.map((entry) => entry.outcome.state)).toEqual(["REQUESTED"]);

    const done = await h.service.completePrintExport({ ...expected(requested), observation: "DIALOG_OPENED", artifact: { hash: artifact.hash, byteLength: artifact.byteLength } });
    expect(done.kind).toBe("COMMITTED");
    // A second terminal outcome for the same attempt is impossible.
    if (done.kind !== "COMMITTED") throw new Error("done");
    expect(await h.service.completePrintExport({ ...expected(done), observation: "UNAVAILABLE", artifact: null })).toEqual({ kind: "REJECTED", code: "EXPORT_OUTCOME_INVALID" });

    // A retry, a little later, is a separate record with its own outcome.
    const LATER = "2026-10-04T02:05:00.000Z";
    h.setClock(LATER);
    const retry = await h.service.requestPrintExport({ ...expected(approved), approvedContentHash: hash, replacesExports: [{ recordType: "CARE_SUMMARY_EXPORT", recordId: requested.recordId, revisionId: done.revisionId }] });
    if (retry.kind !== "COMMITTED") throw new Error("retry");
    expect(retry.recordId).not.toBe(requested.recordId);
    await h.service.completePrintExport({ ...expected(retry), observation: "UNAVAILABLE", artifact: null });
    const final = await h.query.loadSummary(approved.recordId);
    if (final.status !== "READY") throw new Error("ready");
    expect(final.exports.map((entry) => entry.outcome)).toEqual([
      { state: "EXPORTED", completedAt: NOW, artifactHash: artifact.hash, byteLength: artifact.byteLength, evidence: "PRINT_DIALOG_OPENED" },
      { state: "FAILED", failedAt: LATER, reason: "PRINT_UNAVAILABLE" },
    ]);
    // External confirmation stays NONE on every record.
    for (const row of await h.database.table("recordRevisions").toArray()) {
      if (row.recordType === "CARE_SUMMARY_EXPORT") expect(row.revision.payload.externalConfirmation).toEqual({ state: "NONE" });
    }
  });

  it("records an interrupted attempt as OUTCOME_UNKNOWN and never replays it", async () => {
    const h = await setup();
    const { approved, hash } = await preparedAndApproved(h);
    await h.service.requestPrintExport({ ...expected(approved), approvedContentHash: hash });
    expect(await h.service.recoverInterruptedExports()).toBe(1);
    expect(await h.service.recoverInterruptedExports()).toBe(0);
    const view = await h.query.loadSummary(approved.recordId);
    if (view.status !== "READY") throw new Error("ready");
    expect(view.exports.map((entry) => entry.outcome)).toEqual([{ state: "OUTCOME_UNKNOWN", lastObservedAt: NOW, stage: "PRINT" }]);
    expect(await h.rows("CARE_SUMMARY_EXPORT")).toHaveLength(1);
  });

  it("requires an artifact to record an opened print dialog", async () => {
    const h = await setup();
    const { approved, hash } = await preparedAndApproved(h);
    const requested = await h.service.requestPrintExport({ ...expected(approved), approvedContentHash: hash });
    if (requested.kind !== "COMMITTED") throw new Error("requested");
    expect(await h.service.completePrintExport({ ...expected(requested), observation: "DIALOG_OPENED", artifact: null })).toEqual({ kind: "REJECTED", code: "EXPORT_OUTCOME_INVALID" });
  });
});

/**
 * Packet 11C Addendum B, Task B1a (decision 5, D3): approval binds the exact 11c.1 artifact including its notices; an unapproved
 * snapshot made with an older template or renderer must be re-prepared before approval; an approved snapshot is never touched.
 */
describe("Packet 11C B1a: notices in the approved artifact and re-prepare before approval (D3)", () => {
  const storedRows = async (h: Harness, recordId: RecordId) => JSON.stringify(await h.database.table("recordRevisions").where("recordId").equals(recordId).sortBy("revisionNumber"));

  it("approves the exact 11c.1 artifact that contains the notices, and prints them", async () => {
    const h = await setup();
    const { approved, hash } = await preparedAndApproved(h);
    const view = await h.query.loadSummary(approved.recordId);
    if (view.status !== "READY") throw new Error("ready");
    expect(view.payload.sections.at(-1)!.blocks.map((block) => block.kind === "CARE_DRAFT_NOTICE" && block.noticeKind)).toEqual(["QUESTIONS_IN_OWN_WORDS", "DRAFT_NOT_SENT_OR_REVIEWED"]);
    expect(view.payload.patientApproval).toEqual({ state: "APPROVED", approvedAt: NOW, approvedContentHash: hash });
    const text = printableCareSummary(view.payload).text;
    expect(text.endsWith(`## Notes about this draft\n${AI_LANGUAGE_COPY.careDraftNotices.questions["en-SG"]}\n${AI_LANGUAGE_COPY.careDraftNotices.draft["en-SG"]}`)).toBe(true);
    expect((await h.service.requestPrintExport({ ...expected(approved), approvedContentHash: hash })).kind).toBe("COMMITTED");
  });

  it("refuses to record the preview of an unapproved 9c.1 snapshot and writes nothing", async () => {
    const h = await setup();
    const prepared = await h.service.prepare(await h.selection());
    if (prepared.kind !== "COMMITTED") throw new Error("prepared");
    const legacy = await rewriteAsLegacy9c1Snapshot(h.database, prepared.recordId);
    const before = await storedRows(h, prepared.recordId);
    expect(await h.service.markPreviewed({ ...expected(prepared), contentHash: legacy.rendering.contentHash })).toEqual({ kind: "REJECTED", code: "SUMMARY_TEMPLATE_SUPERSEDED" });
    expect(await storedRows(h, prepared.recordId)).toBe(before);
    expect((await h.rows("CARE_SUMMARY_SNAPSHOT"))[0]!.headRevisionNumber).toBe(1);
    // A hash mismatch is still reported first, as before.
    expect(await h.service.markPreviewed({ ...expected(prepared), contentHash: "f".repeat(64) })).toEqual({ kind: "REJECTED", code: "SUMMARY_CONTENT_HASH_MISMATCH" });
  });

  it("refuses to approve a previewed 9c.1 snapshot with SUMMARY_TEMPLATE_SUPERSEDED, leaving it byte-identical", async () => {
    const h = await setup();
    const prepared = await h.service.prepare(await h.selection());
    if (prepared.kind !== "COMMITTED") throw new Error("prepared");
    const current = await h.query.loadSummary(prepared.recordId);
    if (current.status !== "READY") throw new Error("ready");
    const previewed = await h.service.markPreviewed({ ...expected(prepared), contentHash: current.payload.rendering.contentHash });
    if (previewed.kind !== "COMMITTED") throw new Error("previewed");
    const legacy = await rewriteAsLegacy9c1Snapshot(h.database, prepared.recordId);
    expect(legacy.status).toBe("PREVIEWED");
    const before = await storedRows(h, prepared.recordId);
    expect(await h.service.approve({ ...expected(previewed), contentHash: legacy.rendering.contentHash })).toEqual({ kind: "REJECTED", code: "SUMMARY_TEMPLATE_SUPERSEDED" });
    expect(await storedRows(h, prepared.recordId)).toBe(before);
    expect(await h.rows("CARE_SUMMARY_EXPORT")).toEqual([]);
    // Every earlier refusal keeps its own code and order.
    expect(await h.service.approve({ ...expected(previewed), contentHash: "f".repeat(64) })).toEqual({ kind: "REJECTED", code: "SUMMARY_CONTENT_HASH_MISMATCH" });
    expect(await h.service.requestPrintExport({ ...expected(previewed), approvedContentHash: legacy.rendering.contentHash })).toEqual({ kind: "REJECTED", code: "SUMMARY_NOT_APPROVED" });
  });

  it("re-preparing replaces the old preview with an 11c.1 snapshot with notices, which can then be approved", async () => {
    const h = await setup();
    const prepared = await h.service.prepare(await h.selection());
    if (prepared.kind !== "COMMITTED") throw new Error("prepared");
    await rewriteAsLegacy9c1Snapshot(h.database, prepared.recordId);
    const replacement = await h.service.prepare({ ...(await h.selection()), replaces: expected(prepared) });
    if (replacement.kind !== "COMMITTED") throw new Error(JSON.stringify(replacement));
    const old = await h.query.loadSummary(prepared.recordId);
    const fresh = await h.query.loadSummary(replacement.recordId);
    if (old.status !== "READY" || fresh.status !== "READY") throw new Error("ready");
    expect(old.snapshotStatus).toBe("SUPERSEDED");
    expect(old.payload.rendering.rendererVersion).toBe("care-summary-renderer.9c.1");
    expect(fresh.payload.rendering.rendererVersion).toBe("care-summary-renderer.11c.1");
    expect(fresh.payload.sections.at(-1)!.sectionId).toBe("CARE_DRAFT_NOTICES");
    const hash = fresh.payload.rendering.contentHash;
    const previewed = await h.service.markPreviewed({ ...expected(replacement), contentHash: hash });
    if (previewed.kind !== "COMMITTED") throw new Error(JSON.stringify(previewed));
    expect((await h.service.approve({ ...expected(previewed), contentHash: hash })).kind).toBe("COMMITTED");
  });

  it("never touches an approved 9c.1 snapshot: it stays approved, byte-identical and printable without notices", async () => {
    const h = await setup();
    const { approved } = await preparedAndApproved(h);
    const legacy = await rewriteAsLegacy9c1Snapshot(h.database, approved.recordId);
    expect(legacy.status).toBe("APPROVED");
    const before = await storedRows(h, approved.recordId);
    const artifact = printableCareSummary(legacy);
    expect(artifact.text).not.toContain(AI_LANGUAGE_COPY.careDraftNotices.draft["en-SG"]);
    expect(artifact.text.endsWith("## About this summary\nThis summary contains only the records and questions you selected.\nPatient-reported information; not externally verified.\nMissing or unrecorded information may not appear here.")).toBe(true);
    // Approval semantics are unchanged for it; previewing again records nothing.
    expect(await h.service.approve({ ...expected(approved), contentHash: legacy.rendering.contentHash })).toEqual({ kind: "REJECTED", code: "SUMMARY_NOT_APPROVED" });
    expect(await h.service.markPreviewed({ ...expected(approved), contentHash: legacy.rendering.contentHash })).toEqual({ kind: "COMMITTED", recordId: approved.recordId, revisionId: approved.revisionId, revisionNumber: approved.revisionNumber });
    const requested = await h.service.requestPrintExport({ ...expected(approved), approvedContentHash: legacy.rendering.contentHash });
    if (requested.kind !== "COMMITTED") throw new Error(JSON.stringify(requested));
    expect((await h.service.completePrintExport({ ...expected(requested), observation: "DIALOG_OPENED", artifact: { hash: artifact.hash, byteLength: artifact.byteLength } })).kind).toBe("COMMITTED");
    expect(await storedRows(h, approved.recordId)).toBe(before);
  });
});
