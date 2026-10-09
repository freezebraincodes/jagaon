import { afterEach, describe, expect, it, vi } from "vitest";
import Dexie from "dexie";
import { createBrowserJournalRuntime } from "@/application/journal/browser-journal-runtime";
import { createDeletionFixture } from "@/application/deletion/packet10-deletion-fixture";
import { createPopulatedDataset, installFakeIndexedDb, openRaw, PACKET10_NOW, readAllTables } from "@/application/storage/packet10-test-support";
import { createBackupExportService } from "@/backup/backup-export-service";
import { createBackupSnapshotRepository } from "@/backup/backup-snapshot-repository";
import { capturingFilePort, decryptForTest, parseContainer, sealForTest } from "@/backup/backup-test-support";
import { canonicalizeJson } from "@/application/contracts/canonical-json";
import { createWebCryptoPort } from "@/backup/web-crypto-port";
import { isJournalSourceEventName } from "@/application/journal/journal-stored-rows";
import type { JagaOnDatabase } from "@/storage/database";
import { createRestoreService } from "./restore-service";
import { validateAiAuditReferences } from "@/application/ai/ai-audit-lifecycle";
import { createAiInvocationAuditRepository } from "@/application/ai/ai-audit-persistence";
import { projectValidatedAiCareSummary } from "@/application/care-preparation/ai-care-summary-replacement";
import { printableCareSummary } from "@/application/care-preparation/care-summary-artifact";
import { createCarePreparationQuery } from "@/application/care-preparation/care-preparation-query";
import { createCarePreparationService } from "@/application/care-preparation/care-preparation-service";
import { acceptedAiCareComposition, rewriteAsLegacy11c1AiAssistedSnapshot, rewriteAsLegacy9c1Snapshot } from "@/application/care-preparation/care-preparation-test-support";
import { shellCandidate } from "@/ai/evaluation/packet-11-hybrid-test-support";

installFakeIndexedDb();
const TIMEOUT = 240_000;
const PASS = "correct horse battery staple";
const LATER = "2026-10-04T03:00:00.000Z";
const names: string[] = [];
afterEach(async () => {
  for (const name of names.splice(0)) await Dexie.delete(name);
});

async function exportFrom(database: JagaOnDatabase): Promise<Uint8Array> {
  const capture = capturingFilePort();
  const result = await createBackupExportService({ snapshot: createBackupSnapshotRepository(database), crypto: () => createWebCryptoPort(), file: capture.port, now: () => PACKET10_NOW, timeZone: "Asia/Singapore" }).export({ passphrase: PASS, confirmation: PASS });
  if (result.kind !== "DOWNLOAD_STARTED") throw new Error(result.kind);
  return capture.saved[0]!.bytes;
}

function restoreService(name: string, options: { otherTabOpen?: boolean; now?: string } = {}) {
  const closeRuntime = vi.fn();
  const service = createRestoreService({
    databaseName: name,
    now: () => (options.now ?? LATER) as never,
    crypto: () => createWebCryptoPort(),
    coordinator: { acquireExclusive: async () => (options.otherTabOpen ? null : () => undefined), announceDeleted: () => undefined },
    closeRuntime,
  });
  return { service, closeRuntime };
}

async function emptyDataset(): Promise<string> {
  const name = `packet10-empty-${crypto.randomUUID()}`;
  names.push(name);
  (await createBrowserJournalRuntime(name, { now: () => PACKET10_NOW, seedSyntheticScenarioOnCreate: false })).close();
  return name;
}

async function sourceBackup() {
  const { name, runtime } = await createPopulatedDataset();
  names.push(name);
  runtime.close();
  const database = await openRaw(name);
  const file = await exportFrom(database);
  const tables = await readAllTables(database);
  database.close();
  return { name, file, tables };
}

const identityOf = (tables: Record<string, unknown[]>) => (tables.storageMetadata.find((row) => (row as { key: string }).key === "DATABASE_IDENTITY") as { datasetIdentity: string }).datasetIdentity;

/**
 * Packet 11C Addendum B, Task B1b: Packet 10 coverage of the old and the new care-summary composition. A dataset holding a 9c.1 approved
 * snapshot (stored exactly as the Packet 9C code path stored it) and an AI-assisted snapshot (created by `replaceWithAiAssistedPreview`
 * from a fake-provider composition, with its ACCEPTED AI audit row) passes backup validation and restore reconciliation unchanged: the
 * same rows, the 9c.1 artifact printing byte-identically, and the AI audit reference resolving. Offline; no provider, no network.
 */
describe("Packet 11C B1b: backup and restore of 9c.1 and AI-assisted care summaries", () => {
  it(
    "restores a 9c.1 approved snapshot and an AI-assisted snapshot with its accepted audit, byte-identical and still valid",
    async () => {
      const { name, runtime } = await createPopulatedDataset();
      names.push(name);
      // A second deterministic preview that the AI-assisted replacement will supersede: three readings (the full synthetic month has more
      // than the 32 facts one request may carry, so that snapshot is not eligible for AI wording).
      const visit = await runtime.careOrganisation.query.loadVisitPreparation();
      if (visit.status !== "READY" || !visit.appointment) throw new Error("visit");
      const glucose = visit.factGroups.find((group) => group.key === "GLUCOSE");
      if (!glucose || glucose.sources.length < 3) throw new Error("glucose");
      const eligibleSelection = {
        locale: "en-SG" as const,
        period: visit.period,
        appointment: { recordType: "APPOINTMENT" as const, recordId: visit.appointment.recordId, revisionId: visit.appointment.revisionId },
        groups: [{ key: "GLUCOSE" as const, sources: glucose.sources.slice(0, 3) }],
        questions: visit.questions.map((entry) => ({ recordType: "CARE_QUESTION" as const, recordId: entry.recordId, revisionId: entry.revisionId })),
        notSelected: [],
      };
      const second = await runtime.carePreparation.commands.prepare(eligibleSelection);
      if (second.kind !== "COMMITTED") throw new Error(JSON.stringify(second));
      // Packet 11C Addendum C, C4: a third preview, replaced by AI wording and then stored as the pre-C4 (11c.1) code stored it.
      const third = await runtime.carePreparation.commands.prepare(eligibleSelection);
      if (third.kind !== "COMMITTED") throw new Error(JSON.stringify(third));
      runtime.close();

      const database = await openRaw(name);
      const uuid = () => crypto.randomUUID() as never;
      const ids = { commandId: uuid, correlationId: uuid, recordId: uuid, revisionId: uuid, auditEventId: uuid, transactionId: uuid, domainEventId: uuid };
      const service = createCarePreparationService(database, { now: () => PACKET10_NOW, ids, projectAiCareSummary: projectValidatedAiCareSummary });
      const query = createCarePreparationQuery(database);
      const snapshotHeads = (await database.table("recordHeads").where("recordType").equals("CARE_SUMMARY_SNAPSHOT").toArray()) as Array<{ recordId: string; headRevisionId: string; headRevisionNumber: number }>;
      const first = snapshotHeads.find((head) => head.recordId !== second.recordId && head.recordId !== third.recordId)!;

      // The first snapshot: previewed, approved, then stored as the 9c.1 code path stored it.
      const loadedFirst = await query.loadSummary(first.recordId as never);
      if (loadedFirst.status !== "READY") throw new Error("first");
      const firstHash = loadedFirst.payload.rendering.contentHash;
      const previewed = await service.markPreviewed({ recordId: first.recordId as never, expectedRevisionId: first.headRevisionId as never, expectedRevisionNumber: 1, contentHash: firstHash });
      if (previewed.kind !== "COMMITTED") throw new Error("previewed");
      const approved = await service.approve({ recordId: first.recordId as never, expectedRevisionId: previewed.revisionId, expectedRevisionNumber: 2, contentHash: firstHash });
      if (approved.kind !== "COMMITTED") throw new Error("approved");
      const legacy = await rewriteAsLegacy9c1Snapshot(database, first.recordId as never);
      expect(legacy.composition).toEqual({ method: "DETERMINISTIC", templateVersion: "care-summary-template.9c.1" });
      const legacyPrint = printableCareSummary(legacy);

      // The second snapshot: replaced from an accepted fake-provider AI composition, its audit row stored by the hybrid service.
      const loadedSecond = await query.loadSummary(second.recordId);
      if (loadedSecond.status !== "READY") throw new Error("second");
      const ai = await acceptedAiCareComposition(loadedSecond.payload, { candidate: shellCandidate, requestId: crypto.randomUUID(), audit: createAiInvocationAuditRepository(database) });
      const replaced = await service.replaceWithAiAssistedPreview({ recordId: second.recordId, expectedRevisionId: second.revisionId, expectedRevisionNumber: 1, expectedContentHash: loadedSecond.payload.rendering.contentHash, composition: ai.composition, aiInvocationAuditRef: ai.auditRef, validatedAt: PACKET10_NOW });
      if (replaced.kind !== "COMMITTED") throw new Error(JSON.stringify(replaced));

      // Packet 11C Addendum C, C4: the third snapshot replaced the same way, then stored as the pre-C4 code stored it (11c.1, no marking).
      const loadedThird = await query.loadSummary(third.recordId);
      if (loadedThird.status !== "READY") throw new Error("third");
      const aiOld = await acceptedAiCareComposition(loadedThird.payload, { candidate: shellCandidate, requestId: crypto.randomUUID(), audit: createAiInvocationAuditRepository(database) });
      const replacedOld = await service.replaceWithAiAssistedPreview({ recordId: third.recordId, expectedRevisionId: third.revisionId, expectedRevisionNumber: 1, expectedContentHash: loadedThird.payload.rendering.contentHash, composition: aiOld.composition, aiInvocationAuditRef: aiOld.auditRef, validatedAt: PACKET10_NOW });
      if (replacedOld.kind !== "COMMITTED") throw new Error(JSON.stringify(replacedOld));
      const legacyAi = await rewriteAsLegacy11c1AiAssistedSnapshot(database, replacedOld.recordId);
      expect([legacyAi.composition.templateVersion, legacyAi.rendering.rendererVersion]).toEqual(["care-summary-template.11c.1", "care-summary-renderer.11c.1"]);

      const file = await exportFrom(database);
      const source = await readAllTables(database);
      database.close();
      expect(validateAiAuditReferences({ recordRevisions: source.recordRevisions, aiInvocationAudits: source.aiInvocationAudits })).toEqual({ kind: "VALID" });

      const target = await emptyDataset();
      const { service: restore } = restoreService(target);
      const inspected = await restore.inspect(file, PASS);
      if (inspected.kind !== "PLAN_READY") throw new Error(JSON.stringify(inspected));
      expect(await restore.confirm(inspected.plan, { planHash: inspected.plan.planHash, confirmedAt: LATER as never })).toEqual({ kind: "COMMITTED" });
      (await createBrowserJournalRuntime(target, { now: () => LATER as never })).close();
      const restoredDatabase = await openRaw(target);
      const restored = await readAllTables(restoredDatabase);
      const restoredQuery = createCarePreparationQuery(restoredDatabase);
      const legacyView = await restoredQuery.loadSummary(first.recordId as never);
      const aiView = await restoredQuery.loadSummary(replaced.recordId);
      const legacyAiView = await restoredQuery.loadSummary(replacedOld.recordId);
      restoredDatabase.close();

      // Same care-summary rows and the same AI audit rows (row key order is the codec's, so the comparison is deep equality).
      type Row = { recordType: string; recordId: string; revisionId: string };
      const careRows = (tables: Record<string, unknown[]>) => (tables.recordRevisions as Row[]).filter((row) => row.recordType === "CARE_SUMMARY_SNAPSHOT").sort((a, b) => a.revisionId.localeCompare(b.revisionId));
      expect(careRows(restored)).toEqual(careRows(source));
      expect(restored.aiInvocationAudits).toEqual(source.aiInvocationAudits);
      expect(validateAiAuditReferences({ recordRevisions: restored.recordRevisions, aiInvocationAudits: restored.aiInvocationAudits })).toEqual({ kind: "VALID" });
      // The 9c.1 approved artifact: still APPROVED and printing byte-identically.
      if (legacyView.status !== "READY") throw new Error("legacy view");
      expect(legacyView.snapshotStatus).toBe("APPROVED");
      expect(JSON.stringify(legacyView.payload)).toBe(JSON.stringify(legacy));
      expect(Buffer.from(printableCareSummary(legacyView.payload).text, "utf8").equals(Buffer.from(legacyPrint.text, "utf8"))).toBe(true);
      // The AI-assisted snapshot: still the current unapproved preview, naming its accepted audit.
      if (aiView.status !== "READY") throw new Error("ai view");
      expect(aiView.snapshotStatus).toBe("PREPARED");
      // Packet 11C Addendum C, C4 (deliberate): made under template 11c.2, with the AI marking section restored as stored (last).
      expect(aiView.payload.composition).toEqual({ method: "AI_ASSISTED", templateVersion: "care-summary-template.11c.2", aiInvocationAuditRef: ai.auditRef, validatedAt: PACKET10_NOW });
      expect(aiView.payload.sections.at(-1)!.sectionId).toBe("AI_MARKING");
      expect((restored.aiInvocationAudits as Array<{ requestId: string; outcomeCode: string }>).find((row) => row.requestId === ai.auditRef)?.outcomeCode).toBe("ACCEPTED");
      // C4: the old 11c.1 AI-assisted snapshot restores byte-identically, still without a marking (and is never approvable: D3).
      if (legacyAiView.status !== "READY") throw new Error("legacy ai view");
      expect(JSON.stringify(legacyAiView.payload)).toBe(JSON.stringify(legacyAi));
      expect(legacyAiView.payload.sections.some((section) => section.sectionId === "AI_MARKING")).toBe(false);
      // A backup whose AI-assisted snapshot names no stored audit is refused by the same Packet 10 rule.
      expect(validateAiAuditReferences({ recordRevisions: restored.recordRevisions, aiInvocationAudits: [] })).toEqual({ kind: "INVALID", reason: "DANGLING" });
    },
    TIMEOUT,
  );
});

describe("Packet 10C restore (RST-001–RST-006, RST-012, RST-015, RST-016, RST-021)", () => {
  it(
    "RST-001/016/021 restores into a bootstrap-only empty database, adopts its identity and reconciles without replay or network",
    async () => {
      const source = await sourceBackup();
      const target = await emptyDataset();
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const { service, closeRuntime } = restoreService(target);
      const inspected = await service.inspect(source.file, PASS);
      if (inspected.kind !== "PLAN_READY") throw new Error(JSON.stringify(inspected));
      const plan = inspected.plan;
      expect(plan.mode).toBe("RESTORE_INTO_EMPTY_DATABASE");
      expect(plan.effects).toMatchObject({ exportedAt: PACKET10_NOW, newerRecordsDiscarded: 0, protectedDeletions: 0, externalCopiesUnchanged: true });
      expect(plan.effects.counts.glucoseReadings).toBeGreaterThan(0);
      expect(JSON.stringify(plan.effects)).not.toContain(identityOf(source.tables));
      // Inspection changed nothing.
      const untouched = await openRaw(target);
      expect((await untouched.table("recordHeads").count())).toBe(0);
      untouched.close();

      expect(await service.confirm(plan, { planHash: plan.planHash, confirmedAt: LATER as never })).toEqual({ kind: "COMMITTED" });
      expect(closeRuntime).toHaveBeenCalledTimes(1);
      const committed = await openRaw(target);
      const afterCommit = await readAllTables(committed);
      committed.close();
      expect(afterCommit.storageMetadata.find((row) => (row as { key: string }).key === "RESTORE_STATE")).toMatchObject({ phase: "RECONCILING", lastCompletedStep: "COMMITTED", restoreMode: "RESTORE_INTO_EMPTY_DATABASE" });
      expect(afterCommit.appPreferences).toEqual([]);
      expect(identityOf(afterCommit)).toBe(identityOf(source.tables));
      // Packet 11C B1a: the care-summary snapshot (now 11c.1, with its CARE_DRAFT_NOTICE blocks) passes backup and restore row
      // validation and is restored with identical content (row key order is the codec's, so the comparison is deep equality).
      type SnapshotRow = { recordType: string; revisionId: string; revision: { payload: { rendering: { rendererVersion: string }; sections: Array<{ sectionId: string; blocks: Array<{ kind: string }> }> } } };
      const snapshotRows = (tables: Record<string, unknown[]>) => (tables.recordRevisions as SnapshotRow[]).filter((row) => row.recordType === "CARE_SUMMARY_SNAPSHOT").sort((a, b) => a.revisionId.localeCompare(b.revisionId));
      expect(snapshotRows(source.tables).length).toBeGreaterThan(0);
      expect(snapshotRows(afterCommit)).toEqual(snapshotRows(source.tables));
      for (const row of snapshotRows(afterCommit)) {
        expect(row.revision.payload.rendering.rendererVersion).toBe("care-summary-renderer.11c.1");
        expect(row.revision.payload.sections.at(-1)!.blocks.map((block) => block.kind)).toEqual(["CARE_DRAFT_NOTICE", "CARE_DRAFT_NOTICE"]);
      }

      const runtime = await createBrowserJournalRuntime(target, { now: () => LATER as never, bootstrapLocaleAfterRestore: "zh-SG" });
      expect(await runtime.resolveLocale()).toBe("zh-SG");
      runtime.close();
      const reconciled = await openRaw(target);
      const final = await readAllTables(reconciled);
      reconciled.close();
      expect(final.storageMetadata.find((row) => (row as { key: string }).key === "RESTORE_STATE")).toMatchObject({ phase: "COMPLETED", lastCompletedStep: "CARE_SUMMARY_INVALIDATION" });
      const sourceHeads = new Map((source.tables.recordHeads as Array<{ recordId: string; headRevisionId: string }>).map((head) => [head.recordId, head.headRevisionId]));
      for (const head of afterCommit.recordHeads as Array<{ recordId: string; headRevisionId: string }>) expect(sourceHeads.get(head.recordId)).toBe(head.headRevisionId);
      // No historical replay: no journal source event, deletion or event for an old revision was appended.
      const historical = new Set((afterCommit.domainEvents as Array<{ eventId: string }>).map((event) => event.eventId));
      const appended = (final.domainEvents as Array<{ eventId: string; eventName: string }>).filter((event) => !historical.has(event.eventId));
      expect(appended.filter((event) => isJournalSourceEventName(event.eventName) || event.eventName === "PATIENT_RECORD_DELETED")).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    },
    TIMEOUT,
  );

  it(
    "RST-003 refuses a different-lineage non-empty database without changing it",
    async () => {
      const source = await sourceBackup();
      const other = await createPopulatedDataset();
      names.push(other.name);
      other.runtime.close();
      const before = await openRaw(other.name).then(async (database) => {
        const tables = await readAllTables(database);
        database.close();
        return tables;
      });
      const result = await restoreService(other.name).service.inspect(source.file, PASS);
      expect(result).toMatchObject({ kind: "FAILED", failure: { errorCode: "BACKUP_LINEAGE_MISMATCH", userMessageKey: "packet10.restore.differentDataset" } });
      const after = await openRaw(other.name);
      expect(await readAllTables(after)).toEqual(before);
      after.close();
    },
    TIMEOUT,
  );

  it(
    "RST-002/004/015 replaces the same lineage, discards newer activity and keeps later deletions protected",
    async () => {
      const h = await createDeletionFixture();
      names.push(h.name);
      const file = await exportFrom(h.database);
      const backupTables = await h.tables();
      // After the backup: one permanent deletion of a record the backup still contains, and new activity.
      const target = await h.targetWithDependent("GLUCOSE_READING", "PATTERN_EVIDENCE_SNAPSHOT");
      const deletion = await h.service.prepare(target);
      if (deletion.kind !== "PLAN_READY") throw new Error(deletion.kind);
      expect((await h.service.confirm(deletion.plan, { planHash: deletion.plan.planHash, confirmedAt: PACKET10_NOW })).kind).toBe("DELETED");
      h.database.close();
      const runtime = await createBrowserJournalRuntime(h.name, { now: () => PACKET10_NOW });
      const added = await runtime.commands.recordGlucose({
        payload: { measurement: { enteredValue: "5.4" as never, enteredUnit: "MMOL_L", normalization: null }, measurementMethod: "FINGERSTICK_METER", context: { kind: "PATIENT_SELECTED_SLOT", slot: "BEDTIME" } },
        temporal: { kind: "POINT", occurrence: { kind: "EXACT", instantUtc: "2026-10-04T01:30:00.000Z" as never, timeZoneId: "Asia/Singapore" as never, utcOffsetMinutes: 480 } },
        recordedAt: PACKET10_NOW,
      });
      runtime.close();
      if (added.kind !== "COMMITTED") throw new Error("added");
      const current = await openRaw(h.name);
      const beforeRestore = await readAllTables(current);
      current.close();
      const currentHighWater = (beforeRestore.storageMetadata.find((row) => (row as { key: string }).key === "EVENT_SEQUENCE_HIGH_WATER_MARK") as { lastAllocatedSequence: number }).lastAllocatedSequence;

      const { service } = restoreService(h.name);
      const inspected = await service.inspect(file, PASS);
      if (inspected.kind !== "PLAN_READY") throw new Error(JSON.stringify(inspected));
      expect(inspected.plan.mode).toBe("REPLACE_SAME_LINEAGE_DATABASE");
      expect(inspected.plan.effects.newerRecordsDiscarded).toBe(1);
      expect(inspected.plan.effects.protectedDeletions).toBe(1 + deletion.plan.closure.dependents.length);
      expect(await service.confirm(inspected.plan, { planHash: inspected.plan.planHash, confirmedAt: LATER as never })).toEqual({ kind: "COMMITTED" });
      (await createBrowserJournalRuntime(h.name, { now: () => LATER as never })).close();

      const restored = await openRaw(h.name);
      const after = await readAllTables(restored);
      restored.close();
      // The later deletion survives: no revision, a DELETED head and the exact tombstone.
      for (const recordId of deletion.plan.closure.purgedRecordIds) {
        expect((after.recordRevisions as Array<{ recordId: string }>).some((row) => row.recordId === recordId)).toBe(false);
        expect((after.recordHeads as Array<{ recordId: string; state: string }>).find((row) => row.recordId === recordId)?.state).toBe("DELETED");
      }
      // Newer activity is discarded; older backup content otherwise returns.
      expect((after.recordHeads as Array<{ recordId: string }>).some((row) => row.recordId === added.recordId)).toBe(false);
      expect(after.recordRevisions.length).toBeLessThan(backupTables.recordRevisions.length);
      const restoredHighWater = (after.storageMetadata.find((row) => (row as { key: string }).key === "EVENT_SEQUENCE_HIGH_WATER_MARK") as { lastAllocatedSequence: number }).lastAllocatedSequence;
      expect(restoredHighWater).toBeGreaterThanOrEqual(currentHighWater);
      expect(Math.max(...(after.domainEvents as Array<{ localSequence: number }>).map((event) => event.localSequence))).toBeLessThanOrEqual(restoredHighWater);
    },
    TIMEOUT,
  );

  it(
    "RST-006 a change after planning makes confirmation stale and changes nothing",
    async () => {
      const source = await sourceBackup();
      const target = await emptyDataset();
      const { service } = restoreService(target);
      const inspected = await service.inspect(source.file, PASS);
      if (inspected.kind !== "PLAN_READY") throw new Error(inspected.kind);
      const runtime = await createBrowserJournalRuntime(target, { now: () => PACKET10_NOW });
      await runtime.commands.recordGlucose({
        payload: { measurement: { enteredValue: "6.0" as never, enteredUnit: "MMOL_L", normalization: null }, measurementMethod: "FINGERSTICK_METER", context: { kind: "PATIENT_SELECTED_SLOT", slot: "BEDTIME" } },
        temporal: { kind: "POINT", occurrence: { kind: "EXACT", instantUtc: "2026-10-04T01:30:00.000Z" as never, timeZoneId: "Asia/Singapore" as never, utcOffsetMinutes: 480 } },
        recordedAt: PACKET10_NOW,
      });
      runtime.close();
      const before = await openRaw(target).then(async (database) => {
        const tables = await readAllTables(database);
        database.close();
        return tables;
      });
      expect(await service.confirm(inspected.plan, { planHash: inspected.plan.planHash, confirmedAt: LATER as never })).toMatchObject({ kind: "STALE", failure: { errorCode: "RESTORE_CONFIRMATION_STALE" } });
      expect(await restoreService(target, { now: "2026-10-04T03:10:00.001Z" }).service.confirm(inspected.plan, { planHash: inspected.plan.planHash, confirmedAt: LATER as never })).toMatchObject({ kind: "STALE" });
      const after = await openRaw(target);
      expect(await readAllTables(after)).toEqual(before);
      after.close();
    },
    TIMEOUT,
  );

  it(
    "blocks the commit while another tab holds the dataset",
    async () => {
      const source = await sourceBackup();
      const target = await emptyDataset();
      const { service, closeRuntime } = restoreService(target, { otherTabOpen: true });
      const inspected = await service.inspect(source.file, PASS);
      if (inspected.kind !== "PLAN_READY") throw new Error(inspected.kind);
      expect(await service.confirm(inspected.plan, { planHash: inspected.plan.planHash, confirmedAt: LATER as never })).toMatchObject({ kind: "BLOCKED" });
      expect(closeRuntime).not.toHaveBeenCalled();
    },
    TIMEOUT,
  );

  it.each([["recordRevisions"], ["recordHeads"], ["domainEvents"], ["commandReceipts"], ["eventWorkItems"], ["storageMetadata"]] as const)(
    "RST-012 a fault while inserting %s leaves the complete old dataset",
    async (table) => {
      const source = await sourceBackup();
      const target = await emptyDataset();
      const { service } = restoreService(target);
      const inspected = await service.inspect(source.file, PASS);
      if (inspected.kind !== "PLAN_READY") throw new Error(inspected.kind);
      const database = await openRaw(target);
      const before = await readAllTables(database);
      database.close();
      const original = Dexie.prototype.table;
      const spy = vi.spyOn(Dexie.prototype, "table").mockImplementation(function (this: unknown, ...args: unknown[]) {
        const name = args[0] as string;
        const result = original.call(this as Dexie, name);
        if (name === table) {
          result.hook("creating", () => {
            throw new Error("injected");
          });
        }
        return result;
      });
      try {
        expect(await service.confirm(inspected.plan, { planHash: inspected.plan.planHash, confirmedAt: LATER as never })).toMatchObject({ kind: "FAILED", failure: { errorCode: "RESTORE_COMMIT_FAILED" } });
      } finally {
        spy.mockRestore();
      }
      const after = await openRaw(target);
      expect(await readAllTables(after)).toEqual(before);
      after.close();
    },
    TIMEOUT,
  );
});

/**
 * Packet 11C Addendum C, Task C2 (hybrid spec D11): the patient's "Keep wording on this device" setting travels in the backup (payload
 * version 2) and the restore replaces the device's value with the backup's, atomically with the dataset. An old (version 1) backup has
 * no such field and restores it as off. Offline; no provider, no network.
 */
describe("Packet 11C C2: the 'Keep wording on this device' setting through backup and restore", () => {
  const keepWordingRows = (tables: Record<string, unknown[]>) => tables.appPreferences.filter((row) => (row as { key: string }).key === "keepWordingOnDevice");

  it(
    "round-trips: on in the backup is on after restoring into an empty dataset (and the plan binds it)",
    async () => {
      const { name, runtime } = await createPopulatedDataset();
      names.push(name);
      await runtime.keepWordingOnDevice.persist(true);
      expect(await runtime.keepWordingOnDevice.read()).toBe(true);
      runtime.close();
      const database = await openRaw(name);
      const file = await exportFrom(database);
      database.close();
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      const target = await emptyDataset();
      const before = await createBrowserJournalRuntime(target, { now: () => PACKET10_NOW });
      // Fix round 1 (I-2): the device holds an explicit off; the backup's on wins (on || off).
      await before.keepWordingOnDevice.persist(false);
      expect(await before.keepWordingOnDevice.read()).toBe(false);
      before.close();
      const { service } = restoreService(target);
      const inspected = await service.inspect(file, PASS);
      if (inspected.kind !== "PLAN_READY") throw new Error(JSON.stringify(inspected));
      expect(inspected.plan.target.patientSettings).toEqual({ keepWordingOnDevice: true });
      // The setting is part of the reviewed, hash-bound target: a changed copy is stale and changes nothing.
      const tampered = structuredClone(inspected.plan) as typeof inspected.plan;
      (tampered.target as { patientSettings: { keepWordingOnDevice: boolean } }).patientSettings = { keepWordingOnDevice: false };
      expect(await service.confirm(tampered, { planHash: tampered.planHash, confirmedAt: LATER as never })).toMatchObject({ kind: "STALE" });

      expect(await service.confirm(inspected.plan, { planHash: inspected.plan.planHash, confirmedAt: LATER as never })).toEqual({ kind: "COMMITTED" });
      const committed = await openRaw(target);
      const afterCommit = await readAllTables(committed);
      committed.close();
      expect(keepWordingRows(afterCommit)).toEqual([{ key: "keepWordingOnDevice", preferenceSchemaVersion: "app-preference.keep-wording.11c.1", value: true, updatedAt: LATER }]);
      const restored = await createBrowserJournalRuntime(target, { now: () => LATER as never, bootstrapLocaleAfterRestore: "en-SG" });
      expect(await restored.keepWordingOnDevice.read()).toBe(true);
      restored.close();
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    },
    TIMEOUT,
  );

  // Fix round 1 (I-2, coordinator ruling, supersedes the brief's "old backup → off" on a device that is on): a restore never turns
  // private mode off. The commit writes backup || device (an unreadable device value counts as on); the plan target keeps the backup's.
  it(
    "an old version 1 backup (off) restored over a device that is on keeps it on",
    async () => {
      const { name, runtime } = await createPopulatedDataset();
      names.push(name);
      runtime.close();
      const database = await openRaw(name);
      const current = await exportFrom(database);
      database.close();
      // The same backup as the Packet 10 code path wrote it: payload version 1, no patient settings.
      const container = parseContainer(current);
      const payload = await decryptForTest(container, PASS);
      expect(payload.patientSettings).toEqual({ keepWordingOnDevice: false });
      payload.backupSchemaVersion = 1;
      delete payload.patientSettings;
      const old = await sealForTest(canonicalizeJson(payload), PASS, container.containerId);

      const reopened = await createBrowserJournalRuntime(name, { now: () => PACKET10_NOW });
      await reopened.keepWordingOnDevice.persist(true);
      expect(await reopened.keepWordingOnDevice.read()).toBe(true);
      reopened.close();
      const { service } = restoreService(name);
      const inspected = await service.inspect(old, PASS);
      if (inspected.kind !== "PLAN_READY") throw new Error(JSON.stringify(inspected));
      expect(inspected.plan.mode).toBe("REPLACE_SAME_LINEAGE_DATABASE");
      expect(inspected.plan.sourceBackupSchemaVersion).toBe(1);
      expect(inspected.plan.target.patientSettings).toEqual({ keepWordingOnDevice: false });
      expect(await service.confirm(inspected.plan, { planHash: inspected.plan.planHash, confirmedAt: LATER as never })).toEqual({ kind: "COMMITTED" });
      const committed = await openRaw(name);
      const afterCommit = await readAllTables(committed);
      committed.close();
      expect(keepWordingRows(afterCommit)).toEqual([{ key: "keepWordingOnDevice", preferenceSchemaVersion: "app-preference.keep-wording.11c.1", value: true, updatedAt: LATER }]);
      const restored = await createBrowserJournalRuntime(name, { now: () => LATER as never });
      expect(await restored.keepWordingOnDevice.read()).toBe(true);
      restored.close();
    },
    TIMEOUT,
  );

  it(
    "an old version 1 backup restored into an empty device gives off (the D11 default)",
    async () => {
      const { name, runtime } = await createPopulatedDataset();
      names.push(name);
      runtime.close();
      const database = await openRaw(name);
      const current = await exportFrom(database);
      database.close();
      const container = parseContainer(current);
      const payload = await decryptForTest(container, PASS);
      payload.backupSchemaVersion = 1;
      delete payload.patientSettings;
      const old = await sealForTest(canonicalizeJson(payload), PASS, container.containerId);

      const target = await emptyDataset();
      const { service } = restoreService(target);
      const inspected = await service.inspect(old, PASS);
      if (inspected.kind !== "PLAN_READY") throw new Error(JSON.stringify(inspected));
      expect(inspected.plan.mode).toBe("RESTORE_INTO_EMPTY_DATABASE");
      expect(inspected.plan.target.patientSettings).toEqual({ keepWordingOnDevice: false });
      expect(await service.confirm(inspected.plan, { planHash: inspected.plan.planHash, confirmedAt: LATER as never })).toEqual({ kind: "COMMITTED" });
      const committed = await openRaw(target);
      const afterCommit = await readAllTables(committed);
      committed.close();
      expect(afterCommit.appPreferences).toEqual([]);
      const restored = await createBrowserJournalRuntime(target, { now: () => LATER as never });
      expect(await restored.keepWordingOnDevice.read()).toBe(false);
      restored.close();
    },
    TIMEOUT,
  );
});
