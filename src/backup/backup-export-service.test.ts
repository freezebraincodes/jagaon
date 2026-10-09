import { afterEach, describe, expect, it, vi } from "vitest";
import Dexie from "dexie";
import { canonicalizeJson } from "@/application/contracts/canonical-json";
import { createDeletionFixture } from "@/application/deletion/packet10-deletion-fixture";
import { createPopulatedDataset, installFakeIndexedDb, openRaw, PACKET10_NOW, readAllTables } from "@/application/storage/packet10-test-support";
import { createJournalCommandService } from "@/application/journal/journal-command-service";
import { createBackupExportService, backupFileName, type BackupFilePort } from "./backup-export-service";
import { createBackupSnapshotRepository } from "./backup-snapshot-repository";
import { capturingFilePort, decryptForTest, parseContainer } from "./backup-test-support";
import { BACKUP_TABLE_NAMES_V1 } from "./backup-payload-v1";
import { decodeBase64Url } from "./base64url";
import { createWebCryptoPort } from "./web-crypto-port";
import { MAX_BACKUP_ENCODED_BYTES, MAX_BACKUP_PLAINTEXT_BYTES, serialiseBackupContainer } from "./backup-container-v1";
import { createKeepWordingPreferenceRepository } from "@/storage/keep-wording-preference-repository";

installFakeIndexedDb();
const INTEGRATION_TIMEOUT_MS = 120_000;
const PASSPHRASE = "correct horse battery staple 晚安";
const names: string[] = [];
afterEach(async () => {
  for (const name of names.splice(0)) await Dexie.delete(name);
});

async function setup(file: BackupFilePort = capturingFilePort().port, limits?: { maxPlaintextBytes: number; maxEncodedBytes: number }) {
  const { name, runtime } = await createPopulatedDataset();
  names.push(name);
  runtime.close();
  const database = await openRaw(name);
  const service = createBackupExportService({
    snapshot: createBackupSnapshotRepository(database),
    crypto: () => createWebCryptoPort(),
    file,
    now: () => PACKET10_NOW,
    timeZone: "Asia/Singapore",
    limits,
  });
  return { name, database, service };
}

const sha256Hex = async (text: string) =>
  [...new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");

describe("Packet 10B encrypted backup export", () => {
  it(
    "BAK-002/003 encrypts exactly the 14 v1 tables and allowlisted metadata with matching manifests",
    async () => {
      const capture = capturingFilePort();
      const h = await setup(capture.port);
      const before = await readAllTables(h.database);
      const steps: number[] = [];
      const result = await h.service.export({ passphrase: PASSPHRASE, confirmation: PASSPHRASE }, { onStepCompleted: (step) => steps.push(step) });
      expect(result).toEqual({ kind: "DOWNLOAD_STARTED", fileName: "JagaOn-backup-2026-10-04.jagaon", preparedAt: PACKET10_NOW });
      expect(steps).toEqual([0, 1, 2, 3]);
      const [saved] = capture.saved;
      expect(saved!.fileName).toBe("JagaOn-backup-2026-10-04.jagaon");
      const container = parseContainer(saved!.bytes);
      // The file is exactly the canonical serialisation of its own closed container.
      expect(new TextDecoder().decode(serialiseBackupContainer(container))).toBe(new TextDecoder().decode(saved!.bytes));
      expect(Object.keys(container).sort()).toEqual(["aadProfile", "cipher", "ciphertext", "containerId", "containerVersion", "encoding", "format", "kdf", "passphraseEncoding"]);
      expect(container.kdf).toMatchObject({ algorithm: "PBKDF2", hash: "SHA-256", iterations: 600_000 });
      const payload = await decryptForTest(container, PASSPHRASE);
      expect(payload.containerId).toBe(container.containerId);
      // Canonical JSON sorts keys; the set is exactly the 14 v1 tables.
      expect(Object.keys(payload.tables as object).sort()).toEqual([...BACKUP_TABLE_NAMES_V1].sort());
      expect(payload).not.toHaveProperty("appPreferences");
      const identity = before.storageMetadata.find((row) => (row as { key: string }).key === "DATABASE_IDENTITY") as { datasetIdentity: string };
      expect(payload).toMatchObject({
        format: "jagaon-backup-payload",
        // Packet 11C Addendum C (C2, deliberate change): payload version 2 carries the patient settings (default off when never set).
        backupSchemaVersion: 2,
        patientSettings: { keepWordingOnDevice: false },
        datasetIdentity: identity.datasetIdentity,
        exportedAt: PACKET10_NOW,
        sourceApplicationVersion: "0.1.0",
        sourceDexieVersion: 2,
        sourceLogicalStorageSchemaVersion: 1,
        canonicalJsonProfile: "JAGAON_CANONICAL_JSON_V1",
        requestedRuntimePointers: [],
      });
      expect(payload.eventSequenceHighWaterMark).toBe(
        (before.storageMetadata.find((row) => (row as { key: string }).key === "EVENT_SEQUENCE_HIGH_WATER_MARK") as { lastAllocatedSequence: number }).lastAllocatedSequence,
      );
      const tables = payload.tables as Record<string, unknown[]>;
      for (const manifest of payload.tableManifests as Array<{ tableName: string; rowCount: number; canonicalRowsSha256: string; tableEnvelopeSchemaVersion: number }>) {
        expect(manifest.tableEnvelopeSchemaVersion).toBe(1);
        expect(manifest.rowCount).toBe(tables[manifest.tableName]!.length);
        expect(manifest.rowCount).toBe((before as Record<string, unknown[]>)[manifest.tableName]!.length);
        expect(manifest.canonicalRowsSha256).toBe(await sha256Hex(canonicalizeJson(tables[manifest.tableName])));
      }
      // No write happened: export allocated no sequence and changed no table.
      expect(await readAllTables(h.database)).toEqual(before);
      h.database.close();
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "BAK-006/007/008 uses fresh randomness and authenticates every header field and the ciphertext",
    async () => {
      const capture = capturingFilePort();
      const h = await setup(capture.port);
      await h.service.export({ passphrase: PASSPHRASE, confirmation: PASSPHRASE });
      await h.service.export({ passphrase: PASSPHRASE, confirmation: PASSPHRASE });
      const [a, b] = capture.saved.map((entry) => parseContainer(entry.bytes));
      expect(a!.containerId).not.toBe(b!.containerId);
      expect(a!.kdf.salt).not.toBe(b!.kdf.salt);
      expect(a!.cipher.iv).not.toBe(b!.cipher.iv);
      expect(a!.ciphertext).not.toBe(b!.ciphertext);
      await expect(decryptForTest(b!, PASSPHRASE)).resolves.toBeTruthy();

      const other = (value: string, bytes: number) => {
        const decoded = decodeBase64Url(value);
        decoded[0]! ^= 1;
        return Buffer.from(decoded).toString("base64url").slice(0, Math.ceil((bytes * 4) / 3));
      };
      const mutations: Array<(c: typeof a) => typeof a> = [
        (c) => ({ ...c!, containerId: other(c!.containerId, 16) }),
        (c) => ({ ...c!, kdf: { ...c!.kdf, salt: other(c!.kdf.salt, 16) } }),
        (c) => ({ ...c!, kdf: { ...c!.kdf, iterations: 600_001 } }),
        (c) => ({ ...c!, cipher: { ...c!.cipher, iv: other(c!.cipher.iv, 12) } }),
        (c) => ({ ...c!, aadProfile: "JAGAON_BACKUP_HEADER_V2" as never }),
        (c) => ({ ...c!, passphraseEncoding: "UTF-8" as never }),
      ];
      for (const mutate of mutations) await expect(decryptForTest(mutate(a)!, PASSPHRASE)).rejects.toBeTruthy();
      const raw = decodeBase64Url(a!.ciphertext);
      const variants = [
        (() => { const copy = raw.slice(); copy[10]! ^= 0x80; return copy; })(),
        (() => { const copy = raw.slice(); copy[copy.length - 1]! ^= 1; return copy; })(),
        raw.slice(0, -1),
        new Uint8Array([...raw, 0]),
        decodeBase64Url(b!.ciphertext),
      ];
      for (const ciphertext of variants) {
        await expect(decryptForTest({ ...a!, ciphertext: Buffer.from(ciphertext).toString("base64url") }, PASSPHRASE)).rejects.toBeTruthy();
      }
      await expect(decryptForTest(a!, `${PASSPHRASE}x`)).rejects.toBeTruthy();
      h.database.close();
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "BAK-012 enforces the plaintext and encoded bounds at the boundary with no partial output",
    async () => {
      expect(MAX_BACKUP_PLAINTEXT_BYTES).toBe(33_554_432);
      expect(MAX_BACKUP_ENCODED_BYTES).toBe(50_331_648);
      const probe = capturingFilePort();
      const sizing = await setup(probe.port);
      await sizing.service.export({ passphrase: PASSPHRASE, confirmation: PASSPHRASE });
      const fileBytes = probe.saved[0]!.bytes.length;
      const plaintextBytes = decodeBase64Url(parseContainer(probe.saved[0]!.bytes).ciphertext).length - 16;
      sizing.database.close();

      const exact = capturingFilePort();
      const atLimit = await setup(exact.port, { maxPlaintextBytes: plaintextBytes, maxEncodedBytes: fileBytes });
      expect((await atLimit.service.export({ passphrase: PASSPHRASE, confirmation: PASSPHRASE })).kind).toBe("DOWNLOAD_STARTED");
      atLimit.database.close();

      for (const limits of [
        { maxPlaintextBytes: plaintextBytes - 1, maxEncodedBytes: fileBytes },
        { maxPlaintextBytes: plaintextBytes, maxEncodedBytes: fileBytes - 1 },
      ]) {
        const none = capturingFilePort();
        const over = await setup(none.port, limits);
        expect(await over.service.export({ passphrase: PASSPHRASE, confirmation: PASSPHRASE })).toMatchObject({
          kind: "FAILED",
          failure: { errorCode: "BACKUP_TOO_LARGE_FOR_FORMAT_V1", userMessageKey: "packet10.backup.backupTooLarge" },
        });
        expect(none.saved).toEqual([]);
        over.database.close();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "BAK-013/017 persists no passphrase or plaintext and makes no network request",
    async () => {
      const capture = capturingFilePort();
      const h = await setup(capture.port);
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method));
      expect((await h.service.export({ passphrase: PASSPHRASE, confirmation: PASSPHRASE })).kind).toBe("DOWNLOAD_STARTED");
      expect(fetchSpy).not.toHaveBeenCalled();
      for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
      const fileText = new TextDecoder().decode(capture.saved[0]!.bytes);
      expect(fileText).not.toContain(PASSPHRASE);
      // The clear header carries no dataset identity, time, count, locale or record content (spec 7.2).
      const { ciphertext: _ciphertext, ...header } = parseContainer(capture.saved[0]!.bytes);
      expect(_ciphertext.length).toBeGreaterThan(0);
      const headerText = JSON.stringify(header);
      for (const secret of [PASSPHRASE, "GLUCOSE", "datasetIdentity", "2026", "mmol", "en-SG", "count"]) expect(headerText).not.toContain(secret);
      const stored = JSON.stringify(await readAllTables(h.database));
      expect(stored).not.toContain(PASSPHRASE);
      expect(stored).not.toContain(parseContainer(capture.saved[0]!.bytes).containerId);
      fetchSpy.mockRestore();
      for (const spy of consoleSpies) spy.mockRestore();
      h.database.close();
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "BAK-014 a backup after permanent deletion carries no deleted payload, only the tombstone",
    async () => {
      const deletion = await createDeletionFixture();
      names.push(deletion.name);
      const target = await deletion.targetWithDependent("GLUCOSE_READING", "PATTERN_EVIDENCE_SNAPSHOT");
      const before = await deletion.tables();
      const payloadText = JSON.stringify(
        (before.recordRevisions as Array<{ recordId: string; revision: { payload: unknown } }>).find((row) => row.recordId === target.recordId)!.revision.payload,
      );
      const prepared = await deletion.service.prepare(target);
      if (prepared.kind !== "PLAN_READY") throw new Error(prepared.kind);
      expect((await deletion.service.confirm(prepared.plan, { planHash: prepared.plan.planHash, confirmedAt: PACKET10_NOW })).kind).toBe("DELETED");
      const capture = capturingFilePort();
      const service = createBackupExportService({ snapshot: createBackupSnapshotRepository(deletion.database), crypto: () => createWebCryptoPort(), file: capture.port, now: () => PACKET10_NOW, timeZone: "Asia/Singapore" });
      expect((await service.export({ passphrase: PASSPHRASE, confirmation: PASSPHRASE })).kind).toBe("DOWNLOAD_STARTED");
      const payload = await decryptForTest(parseContainer(capture.saved[0]!.bytes), PASSPHRASE);
      const tables = payload.tables as Record<string, Array<Record<string, unknown>>>;
      expect(tables.deletionTombstones!.some((row) => row.recordId === target.recordId)).toBe(true);
      expect(tables.recordRevisions!.some((row) => row.recordId === target.recordId)).toBe(false);
      const others = (before.recordRevisions as Array<{ recordId: string; revision: { payload: unknown } }>).filter((row) => row.recordId !== target.recordId && JSON.stringify(row.revision.payload) === payloadText);
      if (others.length === 0) expect(JSON.stringify(payload)).not.toContain(payloadText);
      deletion.database.close();
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "BAK-001 a concurrent commit is wholly inside or wholly outside the snapshot",
    async () => {
      const h = await setup();
      const journal = createJournalCommandService(h.database, {
        now: () => PACKET10_NOW,
        ids: { commandId: () => crypto.randomUUID() as never, correlationId: () => crypto.randomUUID() as never, recordId: () => crypto.randomUUID() as never, revisionId: () => crypto.randomUUID() as never, auditEventId: () => crypto.randomUUID() as never, transactionId: () => crypto.randomUUID() as never, domainEventId: () => crypto.randomUUID() as never, workItemId: () => crypto.randomUUID() as never },
      });
      const snapshots = createBackupSnapshotRepository(h.database);
      const exact = { kind: "EXACT" as const, instantUtc: "2026-10-04T01:00:00.000Z" as never, timeZoneId: "Asia/Singapore" as never, utcOffsetMinutes: 480 };
      const [snapshot, committed] = await Promise.all([
        snapshots.readValidatedSnapshot(),
        journal.recordGlucose({ payload: { measurement: { enteredValue: "5.9" as never, enteredUnit: "MMOL_L", normalization: null }, measurementMethod: "FINGERSTICK_METER", context: { kind: "PATIENT_SELECTED_SLOT", slot: "BEDTIME" } }, temporal: { kind: "POINT", occurrence: exact }, recordedAt: PACKET10_NOW }),
      ]);
      if (committed.kind !== "COMMITTED") throw new Error("commit");
      const inRevisions = snapshot.tables.recordRevisions.some((row) => (row as { recordId: string }).recordId === committed.recordId);
      const inHeads = snapshot.tables.recordHeads.some((row) => (row as { recordId: string }).recordId === committed.recordId);
      const inEvents = snapshot.tables.domainEvents.some((row) => (row as { change: { recordId: string } }).change.recordId === committed.recordId);
      expect(new Set([inRevisions, inHeads, inEvents]).size).toBe(1);
      h.database.close();
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "Packet 11C C2: exports the patient's 'Keep wording on this device' setting from the same read, and no appPreferences row",
    async () => {
      const capture = capturingFilePort();
      const h = await setup(capture.port);
      await createKeepWordingPreferenceRepository(h.database).persist(true, PACKET10_NOW);
      const before = await readAllTables(h.database);
      const snapshot = await createBackupSnapshotRepository(h.database).readValidatedSnapshot();
      expect(snapshot.patientSettings).toEqual({ keepWordingOnDevice: true });
      await h.service.export({ passphrase: PASSPHRASE, confirmation: PASSPHRASE });
      const payload = await decryptForTest(parseContainer(capture.saved[0]!.bytes), PASSPHRASE);
      expect(payload).toMatchObject({ backupSchemaVersion: 2, patientSettings: { keepWordingOnDevice: true } });
      expect(Object.keys(payload.patientSettings as object)).toEqual(["keepWordingOnDevice"]);
      expect(JSON.stringify(payload)).not.toContain("app-preference.keep-wording");
      expect(Object.keys(payload.tables as object)).not.toContain("appPreferences");
      expect(await readAllTables(h.database)).toEqual(before);
      h.database.close();
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it("BAK-015 reports confirmed writes, started downloads and cancellations distinctly", async () => {
    for (const outcome of ["FILE_WRITE_CONFIRMED", "DOWNLOAD_STARTED", "CANCELLED"] as const) {
      const h = await setup(capturingFilePort(outcome).port);
      const result = await h.service.export({ passphrase: PASSPHRASE, confirmation: PASSPHRASE });
      expect(result.kind).toBe(outcome);
      h.database.close();
    }
  }, INTEGRATION_TIMEOUT_MS);

  it("rejects a mismatched passphrase and an unavailable capability before reading anything", async () => {
    const read = vi.fn();
    const service = createBackupExportService({ snapshot: { readValidatedSnapshot: read }, crypto: () => createWebCryptoPort({ isSecureContext: false }), file: capturingFilePort().port, now: () => PACKET10_NOW });
    expect(await service.export({ passphrase: PASSPHRASE, confirmation: `${PASSPHRASE} ` })).toEqual({ kind: "PASSPHRASE_REJECTED", problem: "MISMATCH" });
    expect(await service.export({ passphrase: PASSPHRASE, confirmation: PASSPHRASE })).toMatchObject({ kind: "FAILED", failure: { errorCode: "SECURE_CONTEXT_REQUIRED", userMessageKey: "packet10.backup.backupFailed" } });
    expect(read).not.toHaveBeenCalled();
  });

  it("names the file with the product and local export date only", () => {
    expect(backupFileName("2026-10-03T16:30:00.000Z" as never, "Asia/Singapore")).toBe("JagaOn-backup-2026-10-04.jagaon");
    expect(backupFileName("2026-10-03T16:30:00.000Z" as never, "UTC")).toBe("JagaOn-backup-2026-10-03.jagaon");
  });
});
