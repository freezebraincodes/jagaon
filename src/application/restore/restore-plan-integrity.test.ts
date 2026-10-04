import { afterEach, describe, expect, it, vi } from "vitest";
import Dexie from "dexie";
import { createBrowserJournalRuntime, JagaOnStorageLockedError } from "@/application/journal/browser-journal-runtime";
import { createDeletionFixture } from "@/application/deletion/packet10-deletion-fixture";
import { installFakeIndexedDb, openRaw, PACKET10_NOW, readAllTables } from "@/application/storage/packet10-test-support";
import { createBackupExportService } from "@/backup/backup-export-service";
import { createBackupSnapshotRepository } from "@/backup/backup-snapshot-repository";
import { capturingFilePort } from "@/backup/backup-test-support";
import { createWebCryptoPort } from "@/backup/web-crypto-port";
import { createStorageMetadataRepository } from "@/storage/storage-metadata";
import type { RestorePlan } from "./restore-contracts";
import { restorePlanHash, restorePlanMaterial, restoreTargetDigest } from "./restore-planner";
import { createRestoreReconciler } from "./restore-reconciler";
import { createRestoreService } from "./restore-service";

/** Corrective Pass A items 2 and 6. */

installFakeIndexedDb();
const TIMEOUT = 240_000;
const PASS = "correct horse battery staple";
const LATER = "2026-10-04T03:00:00.000Z";
const names: string[] = [];
afterEach(async () => {
  for (const name of names.splice(0)) await Dexie.delete(name);
});

async function sameLineage() {
  const h = await createDeletionFixture();
  names.push(h.name);
  const capture = capturingFilePort();
  await createBackupExportService({ snapshot: createBackupSnapshotRepository(h.database), crypto: () => createWebCryptoPort(), file: capture.port, now: () => PACKET10_NOW, timeZone: "Asia/Singapore" }).export({ passphrase: PASS, confirmation: PASS });
  h.database.close();
  const service = createRestoreService({
    databaseName: h.name,
    now: () => LATER as never,
    crypto: () => createWebCryptoPort(),
    coordinator: { acquireExclusive: async () => () => undefined, announceDeleted: () => undefined },
    closeRuntime: () => undefined,
  });
  const inspected = await service.inspect(capture.saved[0]!.bytes, PASS);
  if (inspected.kind !== "PLAN_READY") throw new Error(JSON.stringify(inspected));
  const snapshot = async () => {
    const database = await openRaw(h.name);
    const tables = await readAllTables(database);
    database.close();
    return tables;
  };
  return { name: h.name, service, plan: inspected.plan, snapshot };
}

const confirmation = (plan: RestorePlan) => ({ planHash: plan.planHash, confirmedAt: LATER as never });

function forge(plan: RestorePlan, change: (copy: any) => void): RestorePlan {
  const copy = structuredClone(plan) as any;
  change(copy);
  return copy;
}

describe("restore-plan immutability and confirmation binding (item 2)", () => {
  it(
    "returns a deeply frozen plan including every target row",
    async () => {
      const { plan } = await sameLineage();
      const anyPlan = plan as any;
      for (const value of [plan, plan.effects, plan.effects.counts, plan.target, plan.target.tables, plan.target.tables.recordHeads, plan.target.tables.recordHeads[0]]) expect(Object.isFrozen(value)).toBe(true);
      expect(plan.targetDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(() => (anyPlan.target.tables.recordHeads[0].state = "DELETED")).toThrow(TypeError);
      expect(() => anyPlan.target.tables.recordRevisions.pop()).toThrow(TypeError);
      expect(() => (anyPlan.effects.counts.glucoseReadings = 0)).toThrow(TypeError);
      expect(() => (anyPlan.target.tables = {})).toThrow(TypeError);
    },
    TIMEOUT,
  );

  it(
    "rejects forged target rows, row counts, effects or tables as stale before clearing anything",
    async () => {
      const { service, plan, snapshot } = await sameLineage();
      const before = await snapshot();
      const forgeries = [
        forge(plan, (copy) => (copy.target.tables.recordHeads[0].state = "DELETED")),
        forge(plan, (copy) => copy.target.tables.recordRevisions.pop()),
        forge(plan, (copy) => copy.target.tables.auditEvents.push({ ...copy.target.tables.auditEvents[0], auditEventId: "0b1c2d3e-4f50-4617-8829-3a4b5c6d7e8f" })),
        forge(plan, (copy) => (copy.effects.counts.glucoseReadings += 1)),
        forge(plan, (copy) => (copy.target.tables = { ...copy.target.tables, recordRevisions: [] })),
        forge(plan, (copy) => (copy.target.eventSequenceHighWaterMark += 10)),
        forge(plan, (copy) => (copy.mode = "RESTORE_INTO_EMPTY_DATABASE")),
      ];
      for (const forged of forgeries) {
        expect((await service.confirm(forged, confirmation(forged))).kind).toBe("STALE");
      }
      // Even with a correctly recomputed digest and hash, a plan this service did not issue is refused.
      const recomputed = forge(plan, (copy) => copy.target.tables.recordRevisions.pop()) as any;
      recomputed.targetDigest = await restoreTargetDigest(recomputed.target);
      recomputed.planHash = await restorePlanHash(restorePlanMaterial(recomputed));
      expect((await service.confirm(recomputed, confirmation(recomputed))).kind).toBe("STALE");
      expect(await snapshot()).toEqual(before);
    },
    TIMEOUT,
  );
});

describe("restore staleness covers every mutable canonical row (item 6)", () => {
  it(
    "a same-count content change after planning makes the plan stale",
    async () => {
      const { name, service, plan, snapshot } = await sameLineage();
      const database = await openRaw(name);
      const audit = (await database.table("auditEvents").toArray())[0] as Record<string, unknown>;
      await database.table("auditEvents").put({ ...audit, occurredAt: "2026-10-04T02:30:00.000Z" } as never);
      database.close();
      const before = await snapshot();
      expect((await service.confirm(plan, confirmation(plan))).kind).toBe("STALE");
      expect(await snapshot()).toEqual(before);
    },
    TIMEOUT,
  );

  it(
    "a dependency-edge change after planning makes the plan stale",
    async () => {
      const { name, service, plan, snapshot } = await sameLineage();
      const database = await openRaw(name);
      const edge = (await database.table("reverseDependencies").toArray())[0] as Record<string, unknown>;
      await database.table("reverseDependencies").delete([edge.sourceRevisionId, edge.dependentRevisionId, edge.dependencyRole] as never);
      database.close();
      const before = await snapshot();
      expect((await service.confirm(plan, confirmation(plan))).kind).toBe("STALE");
      expect(await snapshot()).toEqual(before);
    },
    TIMEOUT,
  );
});

describe("restore reconciliation blocking and exact dependencies (item 6)", () => {
  async function reconciling() {
    const h = await createDeletionFixture();
    names.push(h.name);
    await createStorageMetadataRepository(h.database).writeRestoreState({
      key: "RESTORE_STATE",
      phase: "RECONCILING",
      operationId: "0b1c2d3e-4f50-4617-8829-3a4b5c6d7e8f",
      restoreMode: "RESTORE_INTO_EMPTY_DATABASE",
      planHash: "a".repeat(64),
      committedAt: PACKET10_NOW,
      lastCompletedStep: "COMMITTED",
    });
    const owners = { rebuildBootstrapLocale: vi.fn(async () => undefined), inquiryMaintenance: vi.fn(async () => undefined), patternLearningRefresh: vi.fn(async () => undefined), reminderReconciliation: vi.fn(async () => undefined), careSummaryInvalidation: vi.fn(async () => undefined) };
    return { h, owners };
  }

  it(
    "verifies the exact canonical reverse-dependency set: a missing edge blocks reconciliation",
    async () => {
      const { h, owners } = await reconciling();
      const edge = (await h.database.table("reverseDependencies").toArray())[0] as Record<string, unknown>;
      await h.database.table("reverseDependencies").delete([edge.sourceRevisionId, edge.dependentRevisionId, edge.dependencyRole] as never);
      expect((await createRestoreReconciler(h.database, { now: () => PACKET10_NOW, owners }).resume()).kind).toBe("FAILED");
      expect(owners.rebuildBootstrapLocale).not.toHaveBeenCalled();
    },
    TIMEOUT,
  );

  it(
    "an extra edge whose dependent still has a head also blocks reconciliation",
    async () => {
      const { h, owners } = await reconciling();
      const edges = (await h.database.table("reverseDependencies").toArray()) as Array<Record<string, unknown>>;
      const revisions = (await h.database.table("recordRevisions").toArray()) as Array<{ revisionId: string; recordType: string }>;
      const source = revisions.find((row) => row.recordType === "GLUCOSE_READING" && !edges.some((edge) => edge.sourceRevisionId === row.revisionId && edge.dependentRevisionId === edges[0]!.dependentRevisionId))!;
      await h.database.table("reverseDependencies").add({ ...edges[0]!, sourceRevisionId: source.revisionId } as never);
      expect((await createRestoreReconciler(h.database, { now: () => PACKET10_NOW, owners }).resume()).kind).toBe("FAILED");
    },
    TIMEOUT,
  );

  it(
    "accepts the genuine stored edge set",
    async () => {
      const { h, owners } = await reconciling();
      expect(await createRestoreReconciler(h.database, { now: () => PACKET10_NOW, owners }).resume()).toEqual({ kind: "COMPLETED" });
    },
    TIMEOUT,
  );

  it(
    "FAILED_BLOCKING is never resumed automatically at startup; only an explicit recovery retries",
    async () => {
      const { h, owners } = await reconciling();
      await createRestoreReconciler(h.database, { now: () => PACKET10_NOW, owners: { ...owners, inquiryMaintenance: vi.fn(async () => { throw new Error("x"); }) } }).resume();
      const failed = await createStorageMetadataRepository(h.database).readRestoreState();
      expect(failed).toMatchObject({ phase: "FAILED_BLOCKING" });
      expect((await createRestoreReconciler(h.database, { now: () => PACKET10_NOW, owners }).resume()).kind).toBe("FAILED");
      expect(owners.patternLearningRefresh).not.toHaveBeenCalled();
      h.database.close();

      const error = await createBrowserJournalRuntime(h.name, { now: () => PACKET10_NOW }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(JagaOnStorageLockedError);
      expect((error as JagaOnStorageLockedError).lock.kind).toBe("RECOVERY_REQUIRED");
      const database = await openRaw(h.name);
      expect(await createStorageMetadataRepository(database).readRestoreState()).toEqual(failed);
      database.close();

      const recovered = await createBrowserJournalRuntime(h.name, { now: () => PACKET10_NOW, resumeFailedRestore: true });
      recovered.close();
      const after = await openRaw(h.name);
      expect(await createStorageMetadataRepository(after).readRestoreState()).toMatchObject({ phase: "COMPLETED" });
      after.close();
      await h.database.open();
    },
    TIMEOUT,
  );
});
