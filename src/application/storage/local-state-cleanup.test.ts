import { afterEach, describe, expect, it } from "vitest";
import Dexie from "dexie";
import { canonicalizeJson } from "@/application/contracts/canonical-json";
import { createBrowserJournalRuntime, JagaOnStorageLockedError, LocalStateCleanupUnconfirmedError } from "@/application/journal/browser-journal-runtime";
import { createRestoreService } from "@/application/restore/restore-service";
import { createBackupExportService } from "@/backup/backup-export-service";
import { createBackupSnapshotRepository } from "@/backup/backup-snapshot-repository";
import { capturingFilePort, decryptForTest, parseContainer, sealForTest } from "@/backup/backup-test-support";
import { createWebCryptoPort } from "@/backup/web-crypto-port";
import { createStorageMetadataRepository } from "@/storage/storage-metadata";
import { installFakeIndexedDb, openRaw, PACKET10_NOW } from "./packet10-test-support";

/**
 * Packet 10 Corrective Pass C: the durable LOCAL_STATE_CLEANUP_PENDING marker
 * through the real runtime and IndexedDB.
 */

installFakeIndexedDb();
const TIMEOUT = 240_000;
const PASS = "correct horse battery staple";
const names: string[] = [];
afterEach(async () => {
  for (const name of names.splice(0)) await Dexie.delete(name);
});
const fresh = () => {
  const name = `cleanup-${crypto.randomUUID()}`;
  names.push(name);
  return name;
};
const now = () => PACKET10_NOW;
const MARKER = { key: "LOCAL_STATE_CLEANUP_PENDING", requestedAt: PACKET10_NOW };

async function rawMarker(name: string) {
  const database = await openRaw(name);
  const row = await database.table("storageMetadata").get("LOCAL_STATE_CLEANUP_PENDING");
  database.close();
  return row ?? null;
}

describe("durable local-state cleanup marker (Corrective Pass C)", () => {
  it(
    "A/D: is written in the transaction that creates the replacement dataset and survives reopening as EXISTING",
    async () => {
      const name = fresh();
      const created = await createBrowserJournalRuntime(name, { now, seedSyntheticScenarioOnCreate: false, localStateCleanup: { requestedAt: PACKET10_NOW, when: "IF_CREATED" } });
      expect(created.datasetLifecycle).toBe("CREATED");
      expect(await created.localStateCleanup.isPending()).toBe(true);
      created.close();
      expect(await rawMarker(name)).toEqual(MARKER);

      // A later launch sees an ordinary EXISTING dataset, but the marker is still there.
      const reopened = await createBrowserJournalRuntime(name, { now });
      expect(reopened.datasetLifecycle).toBe("EXISTING");
      expect(await reopened.localStateCleanup.isPending()).toBe(true);
      await reopened.localStateCleanup.complete();
      expect(await reopened.localStateCleanup.isPending()).toBe(false);
      reopened.close();
      expect(await rawMarker(name)).toBeNull();
    },
    TIMEOUT,
  );

  it(
    "D: the marker exists as soon as the dataset exists (identity and marker commit together)",
    async () => {
      const name = fresh();
      const runtime = await createBrowserJournalRuntime(name, { now, seedSyntheticScenarioOnCreate: false, localStateCleanup: { requestedAt: PACKET10_NOW, when: "IF_CREATED" } });
      runtime.close();
      const database = await openRaw(name);
      const metadata = createStorageMetadataRepository(database);
      const identity = await metadata.readIdentity();
      expect(identity?.createdAt).toBe(PACKET10_NOW);
      expect(await metadata.readLocalStateCleanupPending()).toEqual(MARKER);
      database.close();
    },
    TIMEOUT,
  );

  it(
    "E: IF_CREATED never marks an existing dataset; ALWAYS marks it explicitly",
    async () => {
      const name = fresh();
      (await createBrowserJournalRuntime(name, { now, seedSyntheticScenarioOnCreate: false })).close();
      const existing = await createBrowserJournalRuntime(name, { now, localStateCleanup: { requestedAt: PACKET10_NOW, when: "IF_CREATED" } });
      expect(existing.datasetLifecycle).toBe("EXISTING");
      expect(await existing.localStateCleanup.isPending()).toBe(false);
      existing.close();
      expect(await rawMarker(name)).toBeNull();
      const explicit = await createBrowserJournalRuntime(name, { now, localStateCleanup: { requestedAt: PACKET10_NOW, when: "ALWAYS" } });
      expect(await explicit.localStateCleanup.isPending()).toBe(true);
      explicit.close();
      expect(await rawMarker(name)).toEqual(MARKER);
    },
    TIMEOUT,
  );

  it(
    "E: an ordinary first launch creates no marker",
    async () => {
      const name = fresh();
      const runtime = await createBrowserJournalRuntime(name, { now, seedSyntheticScenarioOnCreate: false });
      expect(runtime.datasetLifecycle).toBe("CREATED");
      expect(await runtime.localStateCleanup.isPending()).toBe(false);
      runtime.close();
      expect(await rawMarker(name)).toBeNull();
    },
    TIMEOUT,
  );

  it(
    "fails closed when the marker cannot be persisted: no dataset is created and the caller is told",
    async () => {
      const name = fresh();
      const error = await createBrowserJournalRuntime(name, { now, seedSyntheticScenarioOnCreate: false, localStateCleanup: { requestedAt: "not-an-instant" as never, when: "IF_CREATED" } }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(LocalStateCleanupUnconfirmedError);
      expect(await Dexie.exists(name)).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "E: a malformed stored marker locks launch integrity",
    async () => {
      const name = fresh();
      (await createBrowserJournalRuntime(name, { now, seedSyntheticScenarioOnCreate: false })).close();
      const database = await openRaw(name);
      await database.table("storageMetadata").put({ ...MARKER, error: "raw" } as never);
      database.close();
      expect(await createBrowserJournalRuntime(name, { now }).catch((caught: unknown) => caught)).toBeInstanceOf(JagaOnStorageLockedError);
    },
    TIMEOUT,
  );

  it(
    "E: backup excludes the marker and restore neither imports nor manufactures it",
    async () => {
      const source = fresh();
      (await createBrowserJournalRuntime(source, { now })).close();
      (await createBrowserJournalRuntime(source, { now, localStateCleanup: { requestedAt: PACKET10_NOW, when: "ALWAYS" } })).close();
      expect(await rawMarker(source)).toEqual(MARKER);
      const database = await openRaw(source);
      const capture = capturingFilePort();
      await createBackupExportService({ snapshot: createBackupSnapshotRepository(database), crypto: () => createWebCryptoPort(), file: capture.port, now, timeZone: "Asia/Singapore" }).export({ passphrase: PASS, confirmation: PASS });
      database.close();
      const payload = await decryptForTest(parseContainer(capture.saved[0]!.bytes), PASS);
      const text = canonicalizeJson(payload);
      expect(text).not.toContain("LOCAL_STATE_CLEANUP_PENDING");
      expect(Object.keys(payload.tables as object)).not.toContain("storageMetadata");

      // Restoring into an empty dataset creates no marker.
      const target = fresh();
      const restore = createRestoreService({ databaseName: target, now: () => "2026-10-04T03:00:00.000Z" as never, crypto: () => createWebCryptoPort(), coordinator: { acquireExclusive: async () => () => undefined, announceDeleted: () => undefined }, closeRuntime: () => undefined });
      const inspected = await restore.inspect(capture.saved[0]!.bytes, PASS);
      if (inspected.kind !== "PLAN_READY") throw new Error(inspected.kind);
      expect((await restore.confirm(inspected.plan, { planHash: inspected.plan.planHash, confirmedAt: "2026-10-04T03:00:00.000Z" as never })).kind).toBe("COMMITTED");
      expect(await rawMarker(target)).toBeNull();

      // A payload that smuggles the marker in a metadata table is rejected before any change.
      const smuggled = await sealForTest(canonicalizeJson({ ...payload, tables: { ...(payload.tables as object), storageMetadata: [MARKER] } }), PASS, payload.containerId as string);
      const other = fresh();
      const rejected = await createRestoreService({ databaseName: other, now: () => "2026-10-04T03:00:00.000Z" as never, crypto: () => createWebCryptoPort(), coordinator: { acquireExclusive: async () => () => undefined, announceDeleted: () => undefined }, closeRuntime: () => undefined }).inspect(smuggled, PASS);
      expect(rejected.kind).toBe("FAILED");
      expect(await rawMarker(other)).toBeNull();
    },
    TIMEOUT,
  );
});
