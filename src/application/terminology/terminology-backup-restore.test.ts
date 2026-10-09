// @vitest-environment jsdom
// The jsdom environment is deliberate: it is the environment of every existing backup and restore test (Web Crypto key wrapping fails
// under the plain node environment with fake IndexedDB). Synthetic data only.
import Dexie from "dexie";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserJournalRuntime } from "@/application/journal/browser-journal-runtime";
import { createRestoreService } from "@/application/restore/restore-service";
import { createPopulatedDataset, installFakeIndexedDb, openRaw, PACKET10_NOW } from "@/application/storage/packet10-test-support";
import { createBackupExportService } from "@/backup/backup-export-service";
import { createBackupSnapshotRepository } from "@/backup/backup-snapshot-repository";
import { capturingFilePort } from "@/backup/backup-test-support";
import { createWebCryptoPort } from "@/backup/web-crypto-port";
import { createTerminologyService } from "./terminology-service";

/** P13S step 3: PATIENT_TERMINOLOGY rows round-trip through the existing backup export and restore (no format change). */
installFakeIndexedDb();
const TIMEOUT = 240_000;
const PASS = "correct horse battery staple";
const LATER = "2026-10-04T03:00:00.000Z";
const names: string[] = [];
afterEach(async () => {
  for (const name of names.splice(0)) await Dexie.delete(name);
});
const uuid = () => crypto.randomUUID();
const ids = { commandId: uuid, correlationId: uuid, recordId: uuid, revisionId: uuid, auditEventId: uuid, transactionId: uuid, domainEventId: uuid } as never;

async function dataset() {
  const { name, runtime } = await createPopulatedDataset();
  names.push(name);
  const database = await openRaw(name);
  const service = createTerminologyService(database, { now: () => PACKET10_NOW, ids, deletion: runtime.recordDeletion });
  const [medicine] = await service.activeMedicines();
  return { runtime, database, service, first: medicine!.medication };
}

describe("patient terminology through backup and restore", () => {
  it(
    "round-trips through backup export and restore (closed codecs validate the rows); existing backups are unaffected",
    async () => {
      const { runtime, database, service, first } = await dataset();
      expect(await service.remember({ language: "en", phrase: "grey pen", medication: first })).toMatchObject({ kind: "COMMITTED" });
      const capture = capturingFilePort();
      const exported = await createBackupExportService({ snapshot: createBackupSnapshotRepository(database), crypto: () => createWebCryptoPort(), file: capture.port, now: () => PACKET10_NOW, timeZone: "Asia/Singapore" }).export({ passphrase: PASS, confirmation: PASS });
      expect(exported.kind).toBe("DOWNLOAD_STARTED");
      database.close();
      runtime.close();

      const target = `p13s-terminology-target-${uuid()}`;
      names.push(target);
      (await createBrowserJournalRuntime(target, { now: () => PACKET10_NOW, seedSyntheticScenarioOnCreate: false })).close();
      const restore = createRestoreService({ databaseName: target, now: () => LATER as never, crypto: () => createWebCryptoPort(), coordinator: { acquireExclusive: async () => () => undefined, announceDeleted: () => undefined }, closeRuntime: vi.fn() });
      const inspected = await restore.inspect(capture.saved[0]!.bytes, PASS);
      expect(inspected.kind).toBe("PLAN_READY");
      if (inspected.kind !== "PLAN_READY") return;
      expect(await restore.confirm(inspected.plan, { planHash: inspected.plan.planHash, confirmedAt: LATER as never })).toEqual({ kind: "COMMITTED" });
      const restoredRuntime = await createBrowserJournalRuntime(target, { now: () => LATER as never });
      const restored = await openRaw(target);
      const restoredService = createTerminologyService(restored, { now: () => LATER as never, ids, deletion: restoredRuntime.recordDeletion });
      expect(await restoredService.list()).toEqual([expect.objectContaining({ phrase: "grey pen", language: "en", medication: first })]);
      restored.close();
      restoredRuntime.close();
    },
    TIMEOUT,
  );

});
