import { afterEach, describe, expect, it, vi } from "vitest";
import Dexie from "dexie";
import { createAiInvocationAuditRepository } from "@/application/ai/ai-audit-persistence";
import { createDeletionFixture } from "@/application/deletion/packet10-deletion-fixture";
import { createBrowserJournalRuntime } from "@/application/journal/browser-journal-runtime";
import { createPopulatedDataset, installFakeIndexedDb, openRaw, PACKET10_NOW, readAllTables } from "@/application/storage/packet10-test-support";
import { createBackupExportService } from "@/backup/backup-export-service";
import { createBackupSnapshotRepository } from "@/backup/backup-snapshot-repository";
import { capturingFilePort } from "@/backup/backup-test-support";
import { createWebCryptoPort } from "@/backup/web-crypto-port";
import { aiInvocationAuditRowSchema, aiInvocationAuditSchemaVersionOf, type AiInvocationAuditRow } from "@/domain/ai";
import { currentAuditRowFixture, deterministicAuditRowFixture, explainAuditRowFixture } from "@/domain/ai/ai-test-fixtures";
import { validateAiAuditReferences } from "@/application/ai/ai-audit-lifecycle";
import type { JagaOnDatabase } from "@/storage/database";
import { createStorageMetadataRepository } from "@/storage/storage-metadata";
import { createRestoreReconciler } from "./restore-reconciler";
import { verifyRestoreTarget } from "./restore-planner";
import { createRestoreService } from "./restore-service";

/**
 * Packet 11A Task 5 (owner decision, blocker 1 option b): AI invocation audits
 * round-trip through backup and restore, and inspection, target verification
 * and reconciliation reject dangling, unknown, malformed or mismatched AI audit
 * references. A later deletion is never undone by restoring an older backup.
 */

installFakeIndexedDb();
const TIMEOUT = 240_000;
const PASS = "correct horse battery staple";
const LATER = "2026-10-04T03:00:00.000Z";
const AUDIT = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const MISSING_REVISION = { recordType: "GLUCOSE_READING", recordId: "0b7e1f7a-1c2d-4e3f-8a9b-0c1d2e3f4b01", revisionId: "0b7e1f7a-1c2d-4e3f-8a9b-0c1d2e3f4b02" };
const names: string[] = [];
afterEach(async () => {
  for (const name of names.splice(0)) await Dexie.delete(name);
});

type Revision = { recordId: string; recordType: string; revisionId: string };

async function exportFrom(database: JagaOnDatabase): Promise<Uint8Array> {
  const capture = capturingFilePort();
  const result = await createBackupExportService({ snapshot: createBackupSnapshotRepository(database), crypto: () => createWebCryptoPort(), file: capture.port, now: () => PACKET10_NOW, timeZone: "Asia/Singapore" }).export({ passphrase: PASS, confirmation: PASS });
  if (result.kind !== "DOWNLOAD_STARTED") throw new Error(result.kind);
  return capture.saved[0]!.bytes;
}

const restoreService = (name: string) =>
  createRestoreService({
    databaseName: name,
    now: () => LATER as never,
    crypto: () => createWebCryptoPort(),
    coordinator: { acquireExclusive: async () => () => undefined, announceDeleted: () => undefined },
    closeRuntime: vi.fn(),
  });

async function emptyDataset(): Promise<string> {
  const name = `packet11a-empty-${crypto.randomUUID()}`;
  names.push(name);
  (await createBrowserJournalRuntime(name, { now: () => PACKET10_NOW, seedSyntheticScenarioOnCreate: false })).close();
  return name;
}

/** A populated dataset with one transmitted audit naming a real revision and one deterministic audit. */
async function auditedDataset(extra?: (database: JagaOnDatabase, revisions: Revision[]) => Promise<unknown>) {
  const { name, runtime } = await createPopulatedDataset();
  names.push(name);
  runtime.close();
  const database = await openRaw(name);
  const revisions = (await database.table("recordRevisions").toArray()) as Revision[];
  const glucose = revisions.find((row) => row.recordType === "GLUCOSE_READING")!;
  const audits = createAiInvocationAuditRepository(database);
  await audits.append(aiInvocationAuditRowSchema.parse(explainAuditRowFixture(AUDIT, [glucose])));
  await audits.append(aiInvocationAuditRowSchema.parse(deterministicAuditRowFixture()));
  await extra?.(database, revisions);
  return { name, database };
}

async function restoreInto(target: string, file: Uint8Array) {
  const service = restoreService(target);
  const inspected = await service.inspect(file, PASS);
  if (inspected.kind !== "PLAN_READY") return inspected;
  return service.confirm(inspected.plan, { planHash: inspected.plan.planHash, confirmedAt: LATER as never });
}

describe("AI invocation audits through backup and restore", () => {
  /**
   * Packet 11C Addendum C, Task C5 (owner decision C5-a: a versioned audit with backup compatibility). A backup holding rows of both
   * audit schema versions (legacy ai-invocation-audit.11a.1 rows exactly as written before C5, and current 11c.2 rows with an audit-only
   * outcome and a usage basis) restores every row byte-identically, and each keeps its own version. No backup payload, Dexie or index
   * version changed.
   */
  it(
    "C5: a backup with legacy (11a.1) and current (11c.2) audit rows restores both versions exactly",
    async () => {
      const MOOT = "2b3c4d5e-6f70-4a8b-9c0d-1e2f3a4b5c6d";
      const BILLED = "3c4d5e6f-7081-4b9c-8d0e-2f3a4b5c6d7e";
      const source = await auditedDataset(async (database, revisions) => {
        const glucose = revisions.find((row) => row.recordType === "GLUCOSE_READING")!;
        const audits = createAiInvocationAuditRepository(database);
        await audits.append(aiInvocationAuditRowSchema.parse(currentAuditRowFixture({ ...deterministicAuditRowFixture(), requestId: MOOT, outcomeCode: "DISCLOSURE_CLOSED_MOOT" })));
        await audits.append(aiInvocationAuditRowSchema.parse(currentAuditRowFixture({ ...explainAuditRowFixture(BILLED, [glucose]), outcomeCode: "PROVIDER_TIMEOUT", attempts: { count: 1, structuralRepairUsed: false, timedOut: true } }, "UPPER_BOUND")));
      });
      const before = (await source.database.table("aiInvocationAudits").toArray()) as AiInvocationAuditRow[];
      expect(before.map((row) => [row.requestId, aiInvocationAuditSchemaVersionOf(row)]).sort()).toEqual(
        [
          [AUDIT, "ai-invocation-audit.11a.1"],
          [deterministicAuditRowFixture().requestId, "ai-invocation-audit.11a.1"],
          [MOOT, "ai-invocation-audit.11c.2"],
          [BILLED, "ai-invocation-audit.11c.2"],
        ].sort(),
      );
      // The legacy rows are exactly the pre-C5 fixtures: no version field, no usage basis.
      for (const row of before.filter((entry) => aiInvocationAuditSchemaVersionOf(entry) === "ai-invocation-audit.11a.1")) {
        expect(row).not.toHaveProperty("auditSchemaVersion");
        expect(row).not.toHaveProperty("usageBasis");
      }
      const file = await exportFrom(source.database);
      source.database.close();
      const target = await emptyDataset();
      expect(await restoreInto(target, file)).toEqual({ kind: "COMMITTED" });
      (await createBrowserJournalRuntime(target, { now: () => LATER as never })).close();
      const restored = await openRaw(target);
      const after = (await restored.table("aiInvocationAudits").toArray()) as AiInvocationAuditRow[];
      expect(after).toEqual(before);
      const canonical = (rows: AiInvocationAuditRow[]) => rows.map((row) => JSON.stringify(row, Object.keys(row).sort())).sort();
      expect(canonical(after)).toEqual(canonical(before));
      expect(after.find((row) => row.requestId === MOOT)).toMatchObject({ auditSchemaVersion: "ai-invocation-audit.11c.2", outcomeCode: "DISCLOSURE_CLOSED_MOOT", usageBasis: "NONE" });
      expect(after.find((row) => row.requestId === BILLED)).toMatchObject({ outcomeCode: "PROVIDER_TIMEOUT", usageBasis: "UPPER_BOUND" });
      restored.close();
    },
    TIMEOUT,
  );

  it("C5: a row shaped as legacy but carrying a new code, or a current row with an unknown version, is refused as MALFORMED", () => {
    const legacyWithNewCode = { ...deterministicAuditRowFixture(), outcomeCode: "DISCLOSURE_CLOSED_MOOT" };
    const unknownVersion = { ...currentAuditRowFixture(deterministicAuditRowFixture()), auditSchemaVersion: "ai-invocation-audit.11c.9" };
    for (const row of [legacyWithNewCode, unknownVersion]) expect(validateAiAuditReferences({ recordRevisions: [], aiInvocationAudits: [row] })).toEqual({ kind: "INVALID", reason: "MALFORMED" });
    expect(validateAiAuditReferences({ recordRevisions: [], aiInvocationAudits: [deterministicAuditRowFixture(), currentAuditRowFixture({ ...deterministicAuditRowFixture(), requestId: "2b3c4d5e-6f70-4a8b-9c0d-1e2f3a4b5c6d" })] })).toEqual({ kind: "VALID" });
  });

  it(
    "a valid AI audit round-trips losslessly into an empty database",
    async () => {
      const source = await auditedDataset();
      const before = (await source.database.table("aiInvocationAudits").toArray()) as AiInvocationAuditRow[];
      const file = await exportFrom(source.database);
      source.database.close();
      const target = await emptyDataset();
      expect(await restoreInto(target, file)).toEqual({ kind: "COMMITTED" });
      (await createBrowserJournalRuntime(target, { now: () => LATER as never })).close();
      const restored = await openRaw(target);
      expect(await restored.table("aiInvocationAudits").toArray()).toEqual(before);
      expect(before).toHaveLength(2);
      for (const table of ["runtimeManifests", "governedAssets", "runtimeActivationAudits"]) expect(await restored.table(table).count()).toBe(0);
      restored.close();
    },
    TIMEOUT,
  );

  it(
    "inspection rejects a backup whose AI audit names a revision the backup does not contain",
    async () => {
      const source = await auditedDataset((database) => database.table("aiInvocationAudits").add(explainAuditRowFixture("4d5e6f7a-8b9c-4d0e-9f1a-3b4c5d6e7f80", [MISSING_REVISION])));
      const file = await exportFrom(source.database);
      source.database.close();
      const target = await emptyDataset();
      expect(await restoreInto(target, file)).toMatchObject({ kind: "FAILED", failure: { errorCode: "BACKUP_PAYLOAD_INVALID" } });
      const untouched = await openRaw(target);
      expect(await untouched.table("aiInvocationAudits").count()).toBe(0);
      untouched.close();
    },
    TIMEOUT,
  );

  it(
    "target verification rejects dangling, unknown, malformed and mismatched AI audit references",
    async () => {
      const source = await auditedDataset();
      const tables = await readAllTables(source.database);
      source.database.close();
      const verify = (mutate: (copy: Record<string, unknown[]>) => void) => {
        const copy = structuredClone(tables) as Record<string, unknown[]>;
        mutate(copy);
        return verifyRestoreTarget({ tables: copy, eventSequenceHighWaterMark: 10_000 }, LATER as never);
      };
      expect(verify(() => undefined)).toEqual({ kind: "VERIFIED" });
      const audit = (copy: Record<string, unknown[]>) => (copy.aiInvocationAudits as AiInvocationAuditRow[]).find((row) => row.requestId === AUDIT)!;
      const failed = { kind: "FAILED", tableName: "aiInvocationAudits" };
      // Dangling: the named source revision does not exist.
      expect(verify((copy) => (audit(copy).sourceRevisions = [MISSING_REVISION as never]))).toEqual(failed);
      // Mismatched: the revision exists but belongs to a different record.
      expect(verify((copy) => (audit(copy).sourceRevisions[0]!.recordId = MISSING_REVISION.recordId as never))).toEqual(failed);
      // Unknown: a canonical payload names an audit that does not exist.
      expect(
        verify((copy) => {
          const row = (copy.recordRevisions as Array<{ recordType: string; revision: { payload: Record<string, unknown> } }>).find((entry) => entry.recordType === "CARE_SUMMARY_SNAPSHOT")!;
          row.revision.payload = { ...row.revision.payload, composition: { method: "AI_ASSISTED", templateVersion: "t", aiInvocationAuditRef: "5e6f7a8b-9c0d-4e1f-8a2b-4c5d6e7f8091", validatedAt: PACKET10_NOW } };
        }).kind,
      ).toBe("FAILED");
      // Malformed: a payload or credential field in an audit row.
      expect(verify((copy) => ((audit(copy) as unknown as Record<string, unknown>).rawResponse = "{}")).kind).toBe("FAILED");
    },
    TIMEOUT,
  );

  it(
    "reconciliation fails closed on a dangling AI audit after commit",
    async () => {
      const source = await auditedDataset();
      await source.database.table("aiInvocationAudits").add(explainAuditRowFixture("4d5e6f7a-8b9c-4d0e-9f1a-3b4c5d6e7f80", [MISSING_REVISION]));
      await createStorageMetadataRepository(source.database).writeRestoreState({
        key: "RESTORE_STATE",
        phase: "RECONCILING",
        operationId: "0b1c2d3e-4f50-4617-8829-3a4b5c6d7e8f",
        restoreMode: "RESTORE_INTO_EMPTY_DATABASE",
        planHash: "a".repeat(64),
        committedAt: PACKET10_NOW,
        lastCompletedStep: "COMMITTED",
      });
      const op = async () => undefined;
      const owners = { rebuildBootstrapLocale: op, inquiryMaintenance: op, patternLearningRefresh: op, reminderReconciliation: op, careSummaryInvalidation: op };
      expect((await createRestoreReconciler(source.database, { now: () => PACKET10_NOW, owners }).resume()).kind).toBe("FAILED");
      source.database.close();
    },
    TIMEOUT,
  );

  it(
    "restoring an older same-lineage backup never resurrects an audit removed by a later deletion",
    async () => {
      const h = await createDeletionFixture();
      names.push(h.name);
      const target = await h.targetWithDependent("GLUCOSE_READING", "PATTERN_EVIDENCE_SNAPSHOT");
      const targetRevision = ((await h.revisions()) as Revision[]).find((row) => row.recordId === target.recordId)!;
      const audits = createAiInvocationAuditRepository(h.database);
      await audits.append(aiInvocationAuditRowSchema.parse(explainAuditRowFixture(AUDIT, [targetRevision])));
      await audits.append(aiInvocationAuditRowSchema.parse(deterministicAuditRowFixture()));
      const file = await exportFrom(h.database);
      const prepared = await h.service.prepare(target);
      if (prepared.kind !== "PLAN_READY") throw new Error(prepared.kind);
      expect(prepared.plan.closure.aiInvocationRequestIds).toEqual([AUDIT]);
      expect((await h.service.confirm(prepared.plan, { planHash: prepared.plan.planHash, confirmedAt: PACKET10_NOW })).kind).toBe("DELETED");
      h.database.close();

      expect(await restoreInto(h.name, file)).toEqual({ kind: "COMMITTED" });
      (await createBrowserJournalRuntime(h.name, { now: () => LATER as never })).close();
      const restored = await openRaw(h.name);
      const after = await readAllTables(restored);
      restored.close();
      expect((after.aiInvocationAudits as AiInvocationAuditRow[]).map((row) => row.requestId)).toEqual([deterministicAuditRowFixture().requestId]);
      expect(JSON.stringify(after.aiInvocationAudits)).not.toContain(target.recordId);
      expect((after.recordHeads as Array<{ recordId: string; state: string }>).find((row) => row.recordId === target.recordId)?.state).toBe("DELETED");
    },
    TIMEOUT,
  );
});
