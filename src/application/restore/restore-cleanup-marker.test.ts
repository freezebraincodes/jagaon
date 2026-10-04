import { afterEach, describe, expect, it } from "vitest";
import Dexie from "dexie";
import { canonicalizeJson } from "@/application/contracts/canonical-json";
import { createBrowserJournalRuntime } from "@/application/journal/browser-journal-runtime";
import { createPopulatedDataset, installFakeIndexedDb, openRaw, PACKET10_NOW, readAllTables } from "@/application/storage/packet10-test-support";
import { createBackupExportService } from "@/backup/backup-export-service";
import { createBackupSnapshotRepository } from "@/backup/backup-snapshot-repository";
import { capturingFilePort, decryptForTest, parseContainer, sealForTest } from "@/backup/backup-test-support";
import { createWebCryptoPort } from "@/backup/web-crypto-port";
import { createStorageMetadataRepository, localStateCleanupPendingRow } from "@/storage/storage-metadata";
import { currentDatasetFingerprint } from "./restore-planner";
import { createRestoreService } from "./restore-service";

/**
 * Packet 10 Corrective Pass D: LOCAL_STATE_CLEANUP_PENDING is local
 * operational metadata. A restore preserves the exact current marker, never
 * creates or imports one, and a marker change after planning makes the plan
 * stale.
 */

installFakeIndexedDb();
const TIMEOUT = 240_000;
const PASS = "correct horse battery staple";
const LATER = "2026-10-04T03:00:00.000Z";
const REQUESTED = "2026-10-01T08:00:00.000Z";
const MARKER = { key: "LOCAL_STATE_CLEANUP_PENDING", requestedAt: REQUESTED };
const names: string[] = [];
afterEach(async () => {
  for (const name of names.splice(0)) await Dexie.delete(name);
});
const fresh = () => {
  const name = `restore-marker-${crypto.randomUUID()}`;
  names.push(name);
  return name;
};

async function backupOf(name: string): Promise<Uint8Array> {
  const database = await openRaw(name);
  const capture = capturingFilePort();
  await createBackupExportService({ snapshot: createBackupSnapshotRepository(database), crypto: () => createWebCryptoPort(), file: capture.port, now: () => PACKET10_NOW, timeZone: "Asia/Singapore" }).export({ passphrase: PASS, confirmation: PASS });
  database.close();
  return capture.saved[0]!.bytes;
}

async function populatedBackup(): Promise<Uint8Array> {
  const { name, runtime } = await createPopulatedDataset();
  names.push(name);
  runtime.close();
  return backupOf(name);
}

/** The empty replacement dataset a failed post-delete cleanup leaves behind, optionally with its marker. */
async function replacementDataset(withMarker: boolean): Promise<string> {
  const name = fresh();
  const runtime = await createBrowserJournalRuntime(name, {
    now: () => PACKET10_NOW,
    seedSyntheticScenarioOnCreate: false,
    ...(withMarker ? { localStateCleanup: { requestedAt: REQUESTED as never, when: "IF_CREATED" as const } } : {}),
  });
  runtime.close();
  return name;
}

function restoreService(name: string) {
  return createRestoreService({
    databaseName: name,
    now: () => LATER as never,
    crypto: () => createWebCryptoPort(),
    coordinator: { acquireExclusive: async () => () => undefined, announceDeleted: () => undefined },
    closeRuntime: () => undefined,
  });
}

async function plan(name: string, file: Uint8Array) {
  const service = restoreService(name);
  const inspected = await service.inspect(file, PASS);
  if (inspected.kind !== "PLAN_READY") throw new Error(inspected.kind);
  return { service, plan: inspected.plan, confirm: () => service.confirm(inspected.plan, { planHash: inspected.plan.planHash, confirmedAt: LATER as never }) };
}

async function marker(name: string) {
  const database = await openRaw(name);
  const row = await database.table("storageMetadata").get("LOCAL_STATE_CLEANUP_PENDING");
  database.close();
  return row ?? null;
}

async function snapshot(name: string) {
  const database = await openRaw(name);
  const all = await readAllTables(database);
  database.close();
  return { all, fingerprint: currentDatasetFingerprint(all) };
}

/** Opening the runtime resumes and completes post-commit reconciliation. */
async function reconcile(name: string) {
  const runtime = await createBrowserJournalRuntime(name, { now: () => LATER as never });
  const pending = await runtime.localStateCleanup.isPending();
  runtime.close();
  const database = await openRaw(name);
  const state = await createStorageMetadataRepository(database).readRestoreState();
  database.close();
  return { pending, state };
}

describe("restore preserves the local cleanup marker (Corrective Pass D)", () => {
  it(
    "A: a restore into the pending replacement dataset keeps the exact marker through commit and reconciliation",
    async () => {
      const file = await populatedBackup();
      const target = await replacementDataset(true);
      expect(await marker(target)).toEqual(MARKER);
      const restore = await plan(target, file);
      expect(restore.plan.mode).toBe("RESTORE_INTO_EMPTY_DATABASE");
      expect((await restore.confirm()).kind).toBe("COMMITTED");
      expect(await marker(target)).toEqual(MARKER);
      const reconciled = await reconcile(target);
      expect(reconciled.state).toMatchObject({ phase: "COMPLETED" });
      expect(reconciled.pending).toBe(true);
      expect(await marker(target)).toEqual(MARKER);
    },
    TIMEOUT,
  );

  it(
    "A: a same-lineage replacement keeps the exact marker too",
    async () => {
      const { name, runtime } = await createPopulatedDataset();
      names.push(name);
      runtime.close();
      const file = await backupOf(name);
      const database = await openRaw(name);
      await createStorageMetadataRepository(database).writeLocalStateCleanupPending(localStateCleanupPendingRow(REQUESTED as never));
      database.close();
      const restore = await plan(name, file);
      expect(restore.plan.mode).toBe("REPLACE_SAME_LINEAGE_DATABASE");
      expect((await restore.confirm()).kind).toBe("COMMITTED");
      expect(await marker(name)).toEqual(MARKER);
      expect((await reconcile(name)).pending).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "C: a restore without a current marker never creates one",
    async () => {
      const file = await populatedBackup();
      const target = await replacementDataset(false);
      expect((await (await plan(target, file)).confirm()).kind).toBe("COMMITTED");
      expect(await marker(target)).toBeNull();
      const reconciled = await reconcile(target);
      expect(reconciled.state).toMatchObject({ phase: "COMPLETED" });
      expect(reconciled.pending).toBe(false);
      expect(await marker(target)).toBeNull();
    },
    TIMEOUT,
  );

  it(
    "D: a marker cleared after planning makes the plan stale; the old marker is never reintroduced",
    async () => {
      const file = await populatedBackup();
      const target = await replacementDataset(true);
      const restore = await plan(target, file);
      const database = await openRaw(target);
      await createStorageMetadataRepository(database).clearLocalStateCleanupPending();
      database.close();
      const before = await snapshot(target);
      expect((await restore.confirm()).kind).toBe("STALE");
      expect(await marker(target)).toBeNull();
      expect(await snapshot(target)).toEqual(before);
    },
    TIMEOUT,
  );

  it(
    "D: a marker replaced after planning makes the plan stale and keeps the current marker",
    async () => {
      const file = await populatedBackup();
      const target = await replacementDataset(true);
      const restore = await plan(target, file);
      const database = await openRaw(target);
      await createStorageMetadataRepository(database).writeLocalStateCleanupPending(localStateCleanupPendingRow("2026-10-02T09:30:00.000Z" as never));
      database.close();
      expect((await restore.confirm()).kind).toBe("STALE");
      expect(await marker(target)).toEqual({ key: "LOCAL_STATE_CLEANUP_PENDING", requestedAt: "2026-10-02T09:30:00.000Z" });
    },
    TIMEOUT,
  );

  it(
    "E: a marker created after planning makes the plan stale and is never silently erased",
    async () => {
      const file = await populatedBackup();
      const target = await replacementDataset(false);
      const restore = await plan(target, file);
      const database = await openRaw(target);
      await createStorageMetadataRepository(database).writeLocalStateCleanupPending(localStateCleanupPendingRow(REQUESTED as never));
      database.close();
      const before = await snapshot(target);
      expect((await restore.confirm()).kind).toBe("STALE");
      expect(await marker(target)).toEqual(MARKER);
      expect(await snapshot(target)).toEqual(before);

      // A refreshed plan binds the new marker and preserves it.
      expect((await (await plan(target, file)).confirm()).kind).toBe("COMMITTED");
      expect(await marker(target)).toEqual(MARKER);
    },
    TIMEOUT,
  );

  it(
    "fails closed on a malformed current marker: nothing is replaced and the row is not discarded",
    async () => {
      const file = await populatedBackup();
      const target = await replacementDataset(false);
      const database = await openRaw(target);
      await database.table("storageMetadata").put({ ...MARKER, error: "raw" } as never);
      database.close();
      const before = await snapshot(target);
      const service = restoreService(target);
      const inspected = await service.inspect(file, PASS);
      if (inspected.kind === "PLAN_READY") {
        expect((await service.confirm(inspected.plan, { planHash: inspected.plan.planHash, confirmedAt: LATER as never })).kind).not.toBe("COMMITTED");
      }
      expect(await snapshot(target)).toEqual(before);
      expect(await marker(target)).toEqual({ ...MARKER, error: "raw" });
    },
    TIMEOUT,
  );

  it(
    "F: backups exclude the marker; a restore never imports one, even when smuggled",
    async () => {
      const { name, runtime } = await createPopulatedDataset();
      names.push(name);
      runtime.close();
      const database = await openRaw(name);
      await createStorageMetadataRepository(database).writeLocalStateCleanupPending(localStateCleanupPendingRow(REQUESTED as never));
      database.close();
      const file = await backupOf(name);
      const payload = await decryptForTest(parseContainer(file), PASS);
      expect(canonicalizeJson(payload)).not.toContain("LOCAL_STATE_CLEANUP_PENDING");
      expect(Object.keys(payload.tables as object)).not.toContain("storageMetadata");

      const target = await replacementDataset(false);
      expect((await (await plan(target, file)).confirm()).kind).toBe("COMMITTED");
      expect(await marker(target)).toBeNull();

      const smuggled = await sealForTest(canonicalizeJson({ ...payload, tables: { ...(payload.tables as object), storageMetadata: [MARKER] } }), PASS, payload.containerId as string);
      const other = await replacementDataset(false);
      expect((await restoreService(other).inspect(smuggled, PASS)).kind).toBe("FAILED");
      expect(await marker(other)).toBeNull();
    },
    TIMEOUT,
  );
});
