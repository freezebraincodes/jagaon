import { afterEach, describe, expect, it, vi } from "vitest";
import Dexie from "dexie";
import { createBrowserJournalRuntime } from "@/application/journal/browser-journal-runtime";
import { createDeletionFixture } from "@/application/deletion/packet10-deletion-fixture";
import { createPopulatedDataset, installFakeIndexedDb, openRaw, PACKET10_NOW, readAllTables } from "@/application/storage/packet10-test-support";
import { createBackupExportService } from "@/backup/backup-export-service";
import { createBackupSnapshotRepository } from "@/backup/backup-snapshot-repository";
import { capturingFilePort } from "@/backup/backup-test-support";
import { createWebCryptoPort } from "@/backup/web-crypto-port";
import { isJournalSourceEventName } from "@/application/journal/journal-stored-rows";
import type { JagaOnDatabase } from "@/storage/database";
import { createRestoreService } from "./restore-service";

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
