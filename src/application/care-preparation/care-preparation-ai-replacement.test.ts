import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Dexie from "dexie";
import fakeIndexedDB, { IDBKeyRange as FDBKeyRange } from "fake-indexeddb";
import type { Instant, RecordHead, RecordId } from "@/domain/shared";
import type { CareSummarySnapshotRevision } from "@/domain/care-preparation/care-summary-snapshot";
import { createJagaOnDatabase, type JagaOnDatabase } from "@/storage/database";
import { createCarePlanCommandService } from "@/application/care-plan/care-plan-command-service";
import { createJournalCommandService } from "@/application/journal/journal-command-service";
import { createCareOrganisationService } from "@/application/care-organisation/care-organisation-service";
import { createCareOrganisationQuery } from "@/application/care-organisation/care-organisation-query";
import { seedSyntheticCareOrganisation } from "@/application/care-organisation/synthetic-care-organisation-seed";
import { createAiInvocationAuditRepository } from "@/application/ai/ai-audit-persistence";
import { AI_ACTIVATION_MANIFEST } from "@/application/ai/ai-activation-manifest";
import { createAiHybridTaskService } from "@/application/ai/ai-hybrid-task-service";
import { carePreparationRevisionRowCodec } from "./care-preparation-persistence";
import { createCarePreparationService, type CarePreparationDependencies } from "./care-preparation-service";
import { createCarePreparationQuery } from "./care-preparation-query";
import { projectValidatedAiCareSummary } from "./ai-care-summary-replacement";
import { buildCareSummaryAiRequest } from "./ai-care-summary-request";
import { shellCandidate } from "@/ai/evaluation/packet-11-hybrid-test-support";
import { acceptedAiCareComposition, completedShells, ENABLED_CARE_MANIFEST, fakeCareShellProvider, fakeModelCareShells, rewriteAsLegacy9c1Snapshot } from "./care-preparation-test-support";
import type { ExpectedHead } from "./care-preparation-contracts";
import { createCareSummaryAiComposer } from "./compose-care-summary-with-ai";
import type { SlotPlan } from "@/domain/ai";
import { AI_HYBRID_RUNTIME_BUNDLES } from "@/application/ai/ai-hybrid-runtime-bundles";
import { planSlots } from "@/application/ai/language/slot-planner";

/**
 * Packet 11C Addendum B, Task B1b (original Task 1 Steps 2 and 5): `replaceWithAiAssistedPreview` is one authoritative transaction. The
 * old current unapproved snapshot becomes SUPERSEDED and a new AI-assisted PREPARED snapshot (the existing preview flow records PREVIEWED
 * when the screen shows its exact hash) is created with its edges, audit and event rows, or nothing is written. Sources and head are
 * revalidated before and inside the transaction; approval and export stay separate commands. Fake provider only.
 */

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
  vi.restoreAllMocks();
  for (const database of open.splice(0)) {
    database.close();
    await Dexie.delete(database.name);
  }
});

const uuid = () => crypto.randomUUID() as never;
const NOW = "2026-10-04T02:00:00.000Z" as Instant;
const LATER = "2026-10-04T02:05:00.000Z" as Instant;
const ids = { commandId: uuid, correlationId: uuid, recordId: uuid, revisionId: uuid, auditEventId: uuid, transactionId: uuid, domainEventId: uuid, workItemId: uuid };
const exact = (instantUtc: string) => ({ kind: "EXACT" as const, instantUtc: instantUtc as Instant, timeZoneId: "Asia/Singapore" as never, utcOffsetMinutes: 480 });
const glucosePayload = { measurement: { enteredValue: "6.6" as never, enteredUnit: "MMOL_L" as const, normalization: null }, measurementMethod: "FINGERSTICK_METER" as const, context: { kind: "PATIENT_SELECTED_SLOT" as const, slot: "BEDTIME" as const } };
const TABLES = ["recordRevisions", "recordHeads", "auditEvents", "domainEvents", "reverseDependencies", "commandReceipts"] as const;

async function setup(options: { projector?: CarePreparationDependencies["projectAiCareSummary"] | null } = {}) {
  const database = createJagaOnDatabase(`packet11c-b1b-${crypto.randomUUID()}`);
  open.push(database);
  await database.open();
  let clock = NOW;
  const now = () => clock;
  const carePlan = createCarePlanCommandService(database, { now, ids });
  const journal = createJournalCommandService(database, { now, ids });
  const organisation = createCareOrganisationService(database, { now, ids, carePlan });
  const visit = createCareOrganisationQuery(database, { now });
  const projectAiCareSummary = options.projector === null ? undefined : (options.projector ?? projectValidatedAiCareSummary);
  const service = createCarePreparationService(database, { now, ids, ...(projectAiCareSummary ? { projectAiCareSummary } : {}) });
  const query = createCarePreparationQuery(database);
  const audits = createAiInvocationAuditRepository(database);
  await seedSyntheticCareOrganisation({ database, seedAt: NOW, ids });
  const glucose = await journal.recordGlucose({ payload: glucosePayload, temporal: { kind: "POINT", occurrence: exact("2026-10-03T13:00:00.000Z") }, recordedAt: NOW });
  if (glucose.kind !== "COMMITTED") throw new Error("glucose");
  const question = await organisation.createCareQuestion({ questionText: { text: "Can I keep the pen in my bag? (demo)", language: "en-SG" } });
  if (question.kind !== "COMMITTED") throw new Error("question");

  async function prepared() {
    const view = await visit.loadVisitPreparation();
    if (view.status !== "READY" || !view.appointment) throw new Error("visit");
    const result = await service.prepare({
      locale: "en-SG",
      period: view.period,
      appointment: { recordType: "APPOINTMENT", recordId: view.appointment.recordId, revisionId: view.appointment.revisionId },
      groups: [{ key: "GLUCOSE", sources: view.factGroups.find((group) => group.key === "GLUCOSE")!.sources }],
      questions: view.questions.map((entry) => ({ recordType: "CARE_QUESTION" as const, recordId: entry.recordId, revisionId: entry.revisionId })),
      notSelected: [],
    });
    if (result.kind !== "COMMITTED") throw new Error(JSON.stringify(result));
    const loaded = await query.loadSummary(result.recordId);
    if (loaded.status !== "READY") throw new Error("ready");
    return { head: { recordId: result.recordId, expectedRevisionId: result.revisionId, expectedRevisionNumber: result.revisionNumber } as ExpectedHead, payload: loaded.payload };
  }

  /** The deterministic snapshot, an accepted AI composition for it and its persisted ACCEPTED audit row. */
  async function aiReady() {
    const { head, payload } = await prepared();
    const ai = await acceptedAiCareComposition(payload, { candidate: shellCandidate, requestId: crypto.randomUUID(), audit: audits });
    clock = LATER;
    const input = { ...head, expectedContentHash: payload.rendering.contentHash, composition: ai.composition, aiInvocationAuditRef: ai.auditRef, validatedAt: LATER };
    return { head, payload, ai, input };
  }

  const counts = async () => Object.fromEntries(await Promise.all(TABLES.map(async (table) => [table, await database.table(table).count()] as const)));
  const revisionsOf = async (recordId: RecordId) => (await database.table("recordRevisions").where("recordId").equals(recordId).toArray()).map((row) => carePreparationRevisionRowCodec.validateAfterRead(row).revision).sort((a, b) => a.revisionNumber - b.revisionNumber);
  const headOf = async (recordId: RecordId) => (await database.table("recordHeads").get(recordId)) as RecordHead;
  const correctGlucose = () => journal.correctGlucoseTime({ recordId: glucose.recordId, expectedRevisionId: glucose.revisionId, expectedRevisionNumber: 1, payload: glucosePayload, temporal: { kind: "POINT", occurrence: exact("2026-10-03T12:00:00.000Z") }, recordedAt: NOW });
  return { database, service, query, audits, prepared, aiReady, counts, revisionsOf, headOf, correctGlucose, setClock: (value: string) => (clock = value as Instant) };
}

describe("replaceWithAiAssistedPreview (Packet 11C B1b)", () => {
  it("supersedes the current preview and creates the AI-assisted snapshot, its edges, audit and event rows in one transaction", async () => {
    const h = await setup();
    const { head, payload, input } = await h.aiReady();
    const before = await h.counts();
    const result = await h.service.replaceWithAiAssistedPreview({ ...input, commandId: uuid() });
    if (result.kind !== "COMMITTED") throw new Error(JSON.stringify(result));
    expect(result.revisionNumber).toBe(1);
    expect(result.recordId).not.toBe(head.recordId);

    // The new snapshot: PREPARED (the preview flow records PREVIEWED), AI-assisted, unapproved, replacing the exact old revision.
    const [created] = (await h.revisionsOf(result.recordId)) as CareSummarySnapshotRevision[];
    expect(created!.action).toBe("CREATE");
    expect(created!.provenance).toEqual({ sourceKind: "SYSTEM_DERIVATION", captureMethod: "RULE_ENGINE", initiator: "JAGAON_SYSTEM", assistance: "AI_ASSISTED" });
    const next = created!.payload;
    expect(next.status).toBe("PREPARED");
    expect(next.composition).toEqual({ method: "AI_ASSISTED", templateVersion: payload.composition.templateVersion, aiInvocationAuditRef: input.aiInvocationAuditRef, validatedAt: LATER });
    expect(next.replacesSnapshot).toEqual({ recordType: "CARE_SUMMARY_SNAPSHOT", recordId: head.recordId, revisionId: head.expectedRevisionId });
    expect(next.rendering.contentHash).not.toBe(payload.rendering.contentHash);
    expect(next.patientApproval).toEqual({ state: "NOT_APPROVED" });
    // Identical purpose, period, locale, selection, limitations, questions and notices.
    for (const key of ["purpose", "conditionScope", "selectedPeriod", "asOf", "locale", "selection", "limitations"] as const) expect(next[key]).toEqual(payload[key]);
    for (const sectionId of ["SUMMARY_SCOPE", "QUESTIONS_FOR_CARE_TEAM", "DATA_LIMITATIONS", "CARE_DRAFT_NOTICES"]) {
      expect(next.sections.find((section) => section.sectionId === sectionId)).toEqual(payload.sections.find((section) => section.sectionId === sectionId));
    }

    // The old snapshot: one lifecycle revision, SUPERSEDED, content unchanged, not AI-assisted.
    const old = (await h.revisionsOf(head.recordId)) as CareSummarySnapshotRevision[];
    expect(old.map((revision) => [revision.revisionNumber, revision.action, revision.payload.status, revision.provenance.assistance])).toEqual([[1, "CREATE", "PREPARED", "NONE"], [2, "UPDATE", "SUPERSEDED", "NONE"]]);
    expect(JSON.stringify(old[1]!.payload.sections)).toBe(JSON.stringify(payload.sections));

    // Exactly: 2 revisions, 1 new head (+1 moved), 2 audit rows, 2 events, one edge per source of the new snapshot, 1 receipt; same transaction.
    const after = await h.counts();
    expect(Object.fromEntries(Object.entries(after).map(([table, count]) => [table, count - before[table]!]))).toEqual({ recordRevisions: 2, recordHeads: 1, auditEvents: 2, domainEvents: 2, reverseDependencies: payload.selection.includedSourceRevisions.length, commandReceipts: 1 });
    const audits = await h.database.table("auditEvents").where("transactionId").equals(created!.transactionId).toArray();
    expect(audits.map((row) => [row.recordId, row.action, row.reasonCode, row.initiator, row.assistance]).sort()).toEqual(
      [[result.recordId, "CREATE", "SUMMARY_PREPARED", "PATIENT", "AI_ASSISTED"], [head.recordId, "UPDATE", "SUMMARY_SUPERSEDED", "PATIENT", "NONE"]].sort(),
    );
    const events = (await h.database.table("domainEvents").where("transactionId").equals(created!.transactionId).toArray()).sort((a, b) => a.transactionIndex - b.transactionIndex);
    expect(events.map((event) => [event.eventName, event.payload])).toEqual([["CARE_SUMMARY_SNAPSHOT_PREPARED", { reasonCode: "PREPARED" }], ["CARE_SUMMARY_SNAPSHOT_SUPERSEDED", { reasonCode: "SUPERSEDED" }]]);
    const edges = await h.database.table("reverseDependencies").where("dependentRecordId").equals(result.recordId).toArray();
    expect(edges.map((edge) => edge.sourceRevisionId).sort()).toEqual(payload.selection.includedSourceRevisions.map((source) => source.revisionId).sort());
    expect(edges.every((edge) => edge.dependentRevisionId === created!.revisionId && edge.dependencyRole === "CARE_SUMMARY_SOURCE")).toBe(true);
    // No approval, no export, no AI audit change (the hybrid service's one row stays as appended).
    expect(await h.database.table("recordHeads").where("recordType").equals("CARE_SUMMARY_EXPORT").count()).toBe(0);
    expect((await h.audits.list()).map((row) => [row.requestId, row.outcomeCode, row.downstream])).toEqual([[input.aiInvocationAuditRef, "ACCEPTED", null]]);
    const view = await h.query.loadSummary(result.recordId);
    expect(view).toMatchObject({ status: "READY", snapshotStatus: "PREPARED", sourcesCurrent: true });
  });

  it("keeps approval and export separate: the AI-assisted snapshot is previewed, approved and printed by its exact new hash", async () => {
    const h = await setup();
    const { input } = await h.aiReady();
    const result = await h.service.replaceWithAiAssistedPreview(input);
    if (result.kind !== "COMMITTED") throw new Error(JSON.stringify(result));
    const view = await h.query.loadSummary(result.recordId);
    if (view.status !== "READY") throw new Error("ready");
    const hash = view.payload.rendering.contentHash;
    const target = { recordId: result.recordId, expectedRevisionId: result.revisionId, expectedRevisionNumber: 1 };
    expect(await h.service.approve({ ...target, contentHash: hash })).toEqual({ kind: "REJECTED", code: "SUMMARY_NOT_APPROVED" });
    const previewed = await h.service.markPreviewed({ ...target, contentHash: hash });
    if (previewed.kind !== "COMMITTED") throw new Error(JSON.stringify(previewed));
    const approved = await h.service.approve({ recordId: result.recordId, expectedRevisionId: previewed.revisionId, expectedRevisionNumber: 2, contentHash: hash });
    if (approved.kind !== "COMMITTED") throw new Error(JSON.stringify(approved));
    const lifecycle = (await h.revisionsOf(result.recordId)) as CareSummarySnapshotRevision[];
    expect(lifecycle.map((revision) => [revision.payload.status, revision.provenance.assistance])).toEqual([["PREPARED", "AI_ASSISTED"], ["PREVIEWED", "NONE"], ["APPROVED", "NONE"]]);
    expect(lifecycle[2]!.payload.patientApproval).toEqual({ state: "APPROVED", approvedAt: LATER, approvedContentHash: hash });
    expect(new Set(lifecycle.map((revision) => JSON.stringify(revision.payload.sections))).size).toBe(1);
    const requested = await h.service.requestPrintExport({ recordId: result.recordId, expectedRevisionId: approved.revisionId, expectedRevisionNumber: 3, approvedContentHash: hash });
    expect(requested.kind).toBe("COMMITTED");
  });

  it("is idempotent: a replay of the same command returns its receipt; a second replacement of the old head never commits", async () => {
    const h = await setup();
    const { input } = await h.aiReady();
    const commandId = uuid();
    const first = await h.service.replaceWithAiAssistedPreview({ ...input, commandId });
    if (first.kind !== "COMMITTED") throw new Error(JSON.stringify(first));
    const before = await h.counts();
    expect(await h.service.replaceWithAiAssistedPreview({ ...input, commandId })).toEqual(first);
    expect(await h.counts()).toEqual(before);
    // The same command id for different content is never replayed as something else.
    expect(await h.service.replaceWithAiAssistedPreview({ ...input, commandId, expectedContentHash: "f".repeat(64) })).toEqual({ kind: "FAILED", code: "COMMIT_FAILED" });
    // A double activation (another command id) against the replaced head, or against the superseded snapshot's head.
    expect(await h.service.replaceWithAiAssistedPreview({ ...input, commandId: uuid() })).toEqual({ kind: "REJECTED", code: "HEAD_CONFLICT" });
    const superseded = await h.headOf(input.recordId);
    expect(await h.service.replaceWithAiAssistedPreview({ ...input, expectedRevisionId: superseded.headRevisionId as never, expectedRevisionNumber: superseded.headRevisionNumber })).toEqual({ kind: "REJECTED", code: "SUMMARY_INVALIDATED_FOR_EXPORT" });
    expect(await h.counts()).toEqual(before);
    const aiSnapshots = (await h.database.table("recordHeads").where("recordType").equals("CARE_SUMMARY_SNAPSHOT").toArray()) as RecordHead[];
    expect(aiSnapshots.filter((row) => row.recordId !== input.recordId)).toHaveLength(1);
  });

  it("rejects a stale source before the transaction and rolls back when a source changes during it, writing nothing", async () => {
    const h = await setup();
    const { input } = await h.aiReady();
    expect((await h.correctGlucose()).kind).toBe("COMMITTED");
    const before = await h.counts();
    expect(await h.service.replaceWithAiAssistedPreview(input)).toEqual({ kind: "REJECTED", code: "SUMMARY_INVALIDATED_FOR_EXPORT" });
    expect(await h.counts()).toEqual(before);

    // Race: the source is corrected after the pre-checks, while the replacement is being projected.
    let race: Awaited<ReturnType<typeof setup>> | null = null;
    const racing = await setup({
      projector: async (projection) => {
        expect((await race!.correctGlucose()).kind).toBe("COMMITTED");
        return projectValidatedAiCareSummary(projection);
      },
    });
    race = racing;
    const ready = await racing.aiReady();
    const counted = await racing.counts();
    expect(await racing.service.replaceWithAiAssistedPreview({ ...ready.input, commandId: uuid() })).toEqual({ kind: "REJECTED", code: "HEAD_CONFLICT" });
    const after = await racing.counts();
    // Only the correction (its own rows) and the rejection receipt: no snapshot revision, head, audit, event or edge of the replacement.
    const careRevisions = (await racing.database.table("recordRevisions").toArray()).filter((row) => row.recordType === "CARE_SUMMARY_SNAPSHOT");
    expect(careRevisions).toHaveLength(1);
    expect(after.commandReceipts - counted.commandReceipts).toBe(2);
    expect((await racing.headOf(ready.head.recordId)).headRevisionNumber).toBe(1);
  });

  it("rejects a head conflict, a hash mismatch and anything but the current unapproved deterministic preview, writing nothing", async () => {
    const h = await setup();
    const { input } = await h.aiReady();
    const before = await h.counts();
    expect(await h.service.replaceWithAiAssistedPreview({ ...input, expectedRevisionNumber: 2 })).toEqual({ kind: "REJECTED", code: "HEAD_CONFLICT" });
    expect(await h.service.replaceWithAiAssistedPreview({ ...input, expectedContentHash: "f".repeat(64) })).toEqual({ kind: "REJECTED", code: "SUMMARY_CONTENT_HASH_MISMATCH" });
    expect(await h.counts()).toEqual(before);

    // Approved: never replaced.
    const approvedCase = await setup();
    const ready = await approvedCase.aiReady();
    const previewed = await approvedCase.service.markPreviewed({ ...ready.head, contentHash: ready.payload.rendering.contentHash });
    if (previewed.kind !== "COMMITTED") throw new Error("previewed");
    const approved = await approvedCase.service.approve({ recordId: ready.head.recordId, expectedRevisionId: previewed.revisionId, expectedRevisionNumber: 2, contentHash: ready.payload.rendering.contentHash });
    if (approved.kind !== "COMMITTED") throw new Error("approved");
    expect(await approvedCase.service.replaceWithAiAssistedPreview({ ...ready.input, expectedRevisionId: approved.revisionId, expectedRevisionNumber: 3 })).toEqual({ kind: "REJECTED", code: "SUMMARY_ALREADY_APPROVED" });

    // Invalidated by the patient.
    const invalidatedCase = await setup();
    const invalidReady = await invalidatedCase.aiReady();
    const invalidated = await invalidatedCase.service.invalidate({ ...invalidReady.head, reason: "PATIENT_CHANGED_SELECTION" });
    if (invalidated.kind !== "COMMITTED") throw new Error("invalidated");
    expect(await invalidatedCase.service.replaceWithAiAssistedPreview({ ...invalidReady.input, expectedRevisionId: invalidated.revisionId, expectedRevisionNumber: 2 })).toEqual({ kind: "REJECTED", code: "SUMMARY_INVALIDATED_FOR_EXPORT" });

    // An outdated (9c.1) preview is never replaced; it must be prepared again (D3).
    const legacyCase = await setup();
    const legacyReady = await legacyCase.aiReady();
    const legacy = await rewriteAsLegacy9c1Snapshot(legacyCase.database, legacyReady.head.recordId);
    expect(await legacyCase.service.replaceWithAiAssistedPreview({ ...legacyReady.input, expectedContentHash: legacy.rendering.contentHash })).toEqual({ kind: "REJECTED", code: "SUMMARY_TEMPLATE_SUPERSEDED" });
  });

  it("requires the accepted AI audit of this task and locale and a composition that projects onto this snapshot", async () => {
    const h = await setup();
    const { input, payload } = await h.aiReady();
    const before = await h.counts();
    const refused = { kind: "REJECTED", code: "SUMMARY_AI_VALIDATION_MISSING" };
    // No audit row with that request id.
    expect(await h.service.replaceWithAiAssistedPreview({ ...input, aiInvocationAuditRef: crypto.randomUUID() })).toEqual(refused);
    // An audit row that is not ACCEPTED (a deterministic run of the shipped manifest).
    const built = buildCareSummaryAiRequest({ current: payload, requestId: crypto.randomUUID(), requestedAt: NOW });
    if (built.kind !== "READY") throw new Error(built.reason);
    const shipped = createAiHybridTaskService({ releaseProfile: "HACKATHON_DEMO", audit: h.audits, now: () => LATER, monotonicMs: () => 0, manifest: AI_ACTIVATION_MANIFEST });
    const deterministic = await shipped.execute(built.request);
    if (deterministic.kind !== "COMPOSED" || deterministic.source !== "DETERMINISTIC") throw new Error("deterministic");
    expect(await h.service.replaceWithAiAssistedPreview({ ...input, composition: deterministic.composition, aiInvocationAuditRef: deterministic.auditRef })).toEqual(refused);
    // A composition that does not project (another value in the text), or none at all.
    const fields = new Map(input.composition.fields);
    const [path, field] = [...fields.entries()].find(([, entry]) => entry.text.includes("6.6"))!;
    fields.set(path, { ...field, text: field.text.replace("6.6", "9.9") });
    expect(await h.service.replaceWithAiAssistedPreview({ ...input, composition: { ...input.composition, fields } })).toEqual(refused);
    expect(await h.service.replaceWithAiAssistedPreview({ ...input, composition: null })).toEqual(refused);
    // A validation time before the facts' asOf.
    expect(await h.service.replaceWithAiAssistedPreview({ ...input, validatedAt: "2026-10-04T01:00:00.000Z" as Instant })).toEqual(refused);
    expect(await h.counts()).toEqual(before);

    // Without a configured projection (the shipped runtime before B4b wires one), nothing can be replaced.
    const unwired = await setup({ projector: null });
    const unwiredReady = await unwired.aiReady();
    expect(await unwired.service.replaceWithAiAssistedPreview(unwiredReady.input)).toEqual(refused);
  });

  it("writes nothing when the transaction fails, and the same command commits once storage recovers", async () => {
    const h = await setup();
    const { input } = await h.aiReady();
    const before = await h.counts();
    const commandId = uuid();
    const transaction = h.database.transaction.bind(h.database);
    const spy = vi.spyOn(h.database, "transaction").mockImplementationOnce((() => Promise.reject(new Error("disk full"))) as never);
    expect(await h.service.replaceWithAiAssistedPreview({ ...input, commandId })).toEqual({ kind: "FAILED", code: "STORAGE_UNAVAILABLE" });
    expect(await h.counts()).toEqual(before);
    spy.mockImplementation(transaction as never);
    expect((await h.service.replaceWithAiAssistedPreview({ ...input, commandId })).kind).toBe("COMMITTED");
  });
});

/**
 * Packet 11C Addendum B, Task B1b, use case: `composeCareSummaryWithAi` builds the request from the current preview, calls only the
 * injected hybrid `execute`, and replaces the preview only from an AI result with an accepted composition. A deterministic result never
 * creates a snapshot. No UI or app wiring (B4b). Fake provider and an injected test manifest only.
 */
describe("composeCareSummaryWithAi (Packet 11C B1b)", () => {
  type H = Awaited<ReturnType<typeof setup>>;
  function composer(h: H, options: { manifest?: typeof AI_ACTIVATION_MANIFEST; provider?: ReturnType<typeof fakeCareShellProvider> } = {}) {
    const provider = options.provider ?? fakeCareShellProvider(() => ({ kind: "FAILED", reason: "PROVIDER_FAILED" }));
    const hybrid = createAiHybridTaskService({ releaseProfile: "HACKATHON_DEMO", audit: h.audits, now: () => LATER, monotonicMs: () => 0, manifest: options.manifest ?? ENABLED_CARE_MANIFEST, provider });
    const execute = vi.fn(hybrid.execute);
    const use = createCareSummaryAiComposer({ query: h.query, commands: h.service, execute, now: () => LATER, requestId: () => crypto.randomUUID(), commandId: uuid });
    return { use, execute, provider };
  }
  /** A provider that answers with fake model wording for the plan of the request it receives (re-planned from that request). */
  const answering = (h: H, before?: () => Promise<void>) => {
    let plan: SlotPlan | null = null;
    const provider = fakeCareShellProvider(async () => {
      if (before) await before();
      return completedShells(shellCandidate(plan!, fakeModelCareShells(plan!)));
    });
    return {
      provider,
      capture: async (head: ExpectedHead) => {
        const view = await h.query.loadSummary(head.recordId);
        if (view.status !== "READY") throw new Error("ready");
        const built = buildCareSummaryAiRequest({ current: view.payload, requestId: crypto.randomUUID(), requestedAt: NOW });
        if (built.kind !== "READY") throw new Error(built.reason);
        const planned = planSlots(built.request, AI_HYBRID_RUNTIME_BUNDLES.DRAFT_CARE_PREPARATION_SUMMARY);
        if (planned.kind !== "PLANNED") throw new Error(planned.reason);
        plan = planned.plan;
      },
    };
  };
  const snapshotHeads = async (h: H) => (await h.database.table("recordHeads").where("recordType").equals("CARE_SUMMARY_SNAPSHOT").toArray()) as RecordHead[];

  it("with the shipped manifest: keeps the deterministic preview, creates no snapshot, makes no provider call and writes one audit row", async () => {
    const h = await setup();
    const { head } = await h.prepared();
    const { use, provider } = composer(h, { manifest: AI_ACTIVATION_MANIFEST });
    const before = await h.counts();
    expect(await use.composeCareSummaryWithAi({ snapshotRef: head, locale: "en-SG" })).toEqual({ kind: "KEPT_DETERMINISTIC", reason: "TASK_DISABLED" });
    expect(provider.calls).toBe(0);
    expect(await h.counts()).toEqual(before);
    expect((await h.audits.list()).map((row) => [row.outcomeCode, row.attempts.count])).toEqual([["TASK_DISABLED", 0]]);
  });

  it("with an injected test manifest and a fake provider: replaces the preview from the accepted AI composition", async () => {
    const h = await setup();
    const { head } = await h.prepared();
    const fake = answering(h);
    await fake.capture(head);
    const { use, execute } = composer(h, { provider: fake.provider });
    const outcome = await use.composeCareSummaryWithAi({ snapshotRef: head, locale: "en-SG" });
    if (outcome.kind !== "REPLACED") throw new Error(JSON.stringify(outcome));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(fake.provider.calls).toBe(1);
    const view = await h.query.loadSummary(outcome.recordId);
    if (view.status !== "READY") throw new Error("ready");
    expect(view.snapshotStatus).toBe("PREPARED");
    expect(view.payload.composition).toMatchObject({ method: "AI_ASSISTED", aiInvocationAuditRef: (await h.audits.list())[0]!.requestId, validatedAt: LATER });
    expect((await h.headOf(head.recordId)).headRevisionNumber).toBe(2);
    expect((await h.audits.list()).map((row) => row.outcomeCode)).toEqual(["ACCEPTED"]);
  });

  it("a provider failure keeps the deterministic preview; nothing is replaced", async () => {
    const h = await setup();
    const { head } = await h.prepared();
    const { use } = composer(h);
    const before = await h.counts();
    expect(await use.composeCareSummaryWithAi({ snapshotRef: head, locale: "en-SG" })).toEqual({ kind: "KEPT_DETERMINISTIC", reason: "PROVIDER_FAILED" });
    expect(await h.counts()).toEqual(before);
  });

  it("is STALE when the preview or a source changed before or while the AI request ran, and writes no snapshot", async () => {
    const h = await setup();
    const { head } = await h.prepared();
    const { use, execute } = composer(h);
    // Before: the caller's head is not the current one.
    expect(await use.composeCareSummaryWithAi({ snapshotRef: { ...head, expectedRevisionNumber: 2 }, locale: "en-SG" })).toEqual({ kind: "STALE" });
    expect(execute).not.toHaveBeenCalled();
    // While: a source is corrected during the provider call.
    const racing = await setup();
    const ready = await racing.prepared();
    const fake = answering(racing, async () => {
      expect((await racing.correctGlucose()).kind).toBe("COMMITTED");
    });
    await fake.capture(ready.head);
    const raced = composer(racing, { provider: fake.provider });
    expect(await raced.use.composeCareSummaryWithAi({ snapshotRef: ready.head, locale: "en-SG" })).toEqual({ kind: "STALE" });
    expect(await snapshotHeads(racing)).toHaveLength(1);
    expect((await racing.headOf(ready.head.recordId)).headRevisionNumber).toBe(1);
  });

  it("is CANCELLED on an abort before or during the call, and never replaces after it", async () => {
    const h = await setup();
    const { head } = await h.prepared();
    const early = new AbortController();
    early.abort();
    const first = composer(h);
    expect(await first.use.composeCareSummaryWithAi({ snapshotRef: head, locale: "en-SG" }, early.signal)).toEqual({ kind: "CANCELLED" });
    expect(first.execute).not.toHaveBeenCalled();
    const during = new AbortController();
    const fake = answering(h, async () => {
      during.abort();
    });
    await fake.capture(head);
    const second = composer(h, { provider: fake.provider });
    expect(await second.use.composeCareSummaryWithAi({ snapshotRef: head, locale: "en-SG" }, during.signal)).toEqual({ kind: "CANCELLED" });
    expect(await snapshotHeads(h)).toHaveLength(1);
  });

  it("never calls execute for a snapshot it cannot send, in another locale, or that is not the current unapproved preview", async () => {
    const h = await setup();
    const { head } = await h.prepared();
    const { use, execute } = composer(h);
    expect(await use.composeCareSummaryWithAi({ snapshotRef: head, locale: "zh-SG" })).toEqual({ kind: "UNAVAILABLE" });
    await rewriteAsLegacy9c1Snapshot(h.database, head.recordId);
    expect(await use.composeCareSummaryWithAi({ snapshotRef: head, locale: "en-SG" })).toEqual({ kind: "NOT_ELIGIBLE", reason: "NOT_CURRENT_DETERMINISTIC" });
    expect(await use.composeCareSummaryWithAi({ snapshotRef: { ...head, recordId: crypto.randomUUID() as never }, locale: "en-SG" })).toEqual({ kind: "UNAVAILABLE" });
    expect(execute).not.toHaveBeenCalled();
  });
});
