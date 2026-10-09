import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Dexie from "dexie";
import { canonicalizeJson } from "@/application/contracts/canonical-json";
import { createPopulatedDataset, installFakeIndexedDb, openRaw, PACKET10_NOW } from "@/application/storage/packet10-test-support";
import { createBackupExportService } from "./backup-export-service";
import { createBackupSnapshotRepository } from "./backup-snapshot-repository";
import { capturingFilePort, decryptForTest, parseContainer, sealForTest } from "./backup-test-support";
import { parseCanonicalContainerV1 } from "./backup-container-reader";
import { createBackupRestoreValidator } from "./backup-restore-validator";
import { BACKUP_PAYLOAD_MIGRATIONS, migrateBackupPayload, type BackupPayloadMigration } from "./backup-migration-registry";
import { createWebCryptoPort } from "./web-crypto-port";
import { encodeBase64Url } from "./base64url";

installFakeIndexedDb();
const TIMEOUT = 180_000;
const PASS = "correct horse battery staple";
let file: Uint8Array;
let payload: Record<string, unknown>;
let name: string;

beforeAll(async () => {
  const dataset = await createPopulatedDataset();
  name = dataset.name;
  dataset.runtime.close();
  const database = await openRaw(name);
  const capture = capturingFilePort();
  await createBackupExportService({ snapshot: createBackupSnapshotRepository(database), crypto: () => createWebCryptoPort(), file: capture.port, now: () => PACKET10_NOW, timeZone: "Asia/Singapore" }).export({ passphrase: PASS, confirmation: PASS });
  database.close();
  file = capture.saved[0]!.bytes;
  payload = await decryptForTest(parseContainer(file), PASS);
}, TIMEOUT);
afterAll(async () => {
  await Dexie.delete(name);
});

const validator = () => createBackupRestoreValidator({ crypto: () => createWebCryptoPort() });
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const bytes = (value: string) => new TextEncoder().encode(value);
const codeOf = async (promise: Promise<unknown>) => promise.then(() => "OK", (error: { code?: string }) => error.code ?? "UNKNOWN");
const reseal = (mutate: (copy: Record<string, unknown>) => void, containerId?: string) => {
  const copy = structuredClone(payload);
  mutate(copy);
  return sealForTest(canonicalizeJson(copy), PASS, containerId ?? (copy.containerId as string));
};

describe("untrusted container preflight (RST-007, RST-009)", () => {
  it("accepts only the exact canonical spelling of a valid container", () => {
    expect(parseCanonicalContainerV1(file).containerVersion).toBe(1);
    const original = text(file);
    const container = JSON.parse(original);
    const variants: Array<[string, string]> = [
      [JSON.stringify(container, null, 1), "BACKUP_FILE_UNSUPPORTED"],
      [`${original}\n`, "BACKUP_FILE_UNSUPPORTED"],
      [original.replace('"format":"jagaon-encrypted-backup"', '"format":"jag\\u0061on-encrypted-backup"'), "BACKUP_FILE_UNSUPPORTED"],
      [original.replace('"iterations":600000', '"iterations":6e5'), "BACKUP_FILE_UNSUPPORTED"],
      [original.replace('{"aadProfile"', '{"extra":1,"aadProfile"'), "BACKUP_FILE_UNSUPPORTED"],
      [original.replace('"containerVersion":1', '"containerVersion":2'), "BACKUP_VERSION_UNSUPPORTED"],
      [original.replace('"iterations":600000', '"iterations":3000000'), "BACKUP_KDF_UNSUPPORTED"],
      [original.replace('"iterations":600000', '"iterations":599999'), "BACKUP_KDF_UNSUPPORTED"],
      [original.replace('"hash":"SHA-256"', '"hash":"SHA-1"'), "BACKUP_KDF_UNSUPPORTED"],
      [original.replace('"algorithm":"AES-GCM"', '"algorithm":"AES-CBC"'), "BACKUP_FILE_UNSUPPORTED"],
      [original.replace('"format":"jagaon-encrypted-backup"', '"format":"other"'), "BACKUP_FILE_UNSUPPORTED"],
      [original.replace(/"aadProfile":"JAGAON_BACKUP_HEADER_V1",/, '"aadProfile":"JAGAON_BACKUP_HEADER_V1","aadProfile":"JAGAON_BACKUP_HEADER_V1",'), "BACKUP_FILE_UNSUPPORTED"],
      ["not json", "BACKUP_FILE_UNSUPPORTED"],
    ];
    for (const [variant, code] of variants) {
      expect(() => parseCanonicalContainerV1(bytes(variant)), variant.slice(0, 60)).toThrow(expect.objectContaining({ code }));
    }
    expect(() => parseCanonicalContainerV1(file, file.length - 1)).toThrow(expect.objectContaining({ code: "BACKUP_FILE_UNSUPPORTED" }));
  });
});

describe("authenticate before use and validate completely (BAK-011, RST-007)", () => {
  it(
    "returns an isolated validated candidate for a genuine backup",
    async () => {
      const candidate = await validator().validate(file, PASS);
      expect(candidate.datasetIdentity).toBe(payload.datasetIdentity);
      expect(candidate.containerId).toBe(parseContainer(file).containerId);
      expect(candidate.payloadFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(candidate.tables).toEqual(payload.tables);
      // Packet 11C C2: the exported setting (never set in this dataset: off), exactly.
      expect(candidate.patientSettings).toEqual({ keepWordingOnDevice: false });
      expect(candidate.sourceBackupSchemaVersion).toBe(2);
    },
    TIMEOUT,
  );

  it(
    "uses one combined outcome for a wrong passphrase and for changed header or ciphertext",
    async () => {
      const container = parseContainer(file);
      const changedIv = { ...container, cipher: { ...container.cipher, iv: encodeBase64Url(new Uint8Array(12).fill(9)) } };
      const raw = Buffer.from(container.ciphertext, "base64url");
      raw[5]! ^= 1;
      const changedCiphertext = { ...container, ciphertext: Buffer.from(raw).toString("base64url") };
      const serialise = (value: unknown) => bytes(canonicalizeJson(value));
      for (const [input, passphrase] of [
        [file, `${PASS}!`],
        [file, "短"],
        [serialise(changedIv), PASS],
        [serialise(changedCiphertext), PASS],
      ] as const) {
        expect(await codeOf(validator().validate(input, passphrase))).toBe("BACKUP_AUTHENTICATION_FAILED");
      }
    },
    TIMEOUT,
  );

  it(
    "rejects container-ID mismatch, manifest count/digest/order changes, unknown tables, prohibited fields and Safety rows",
    async () => {
      const cases: Array<[string, Promise<Uint8Array>]> = [
        ["containerId", reseal(() => undefined, encodeBase64Url(new Uint8Array(16).fill(3)))],
        ["count", reseal((copy) => ((copy.tableManifests as Array<{ rowCount: number }>)[1]!.rowCount += 1))],
        ["digest", reseal((copy) => ((copy.tableManifests as Array<{ canonicalRowsSha256: string }>)[0]!.canonicalRowsSha256 = "0".repeat(64)))],
        ["order", reseal((copy) => (copy.tables as Record<string, unknown[]>).recordHeads!.reverse())],
        ["unknown table", reseal((copy) => ((copy.tables as Record<string, unknown[]>).appPreferences = []))],
        ["prohibited field", reseal((copy) => (copy.passphrase = "x"))],
        ["unknown row field", reseal((copy) => (((copy.tables as Record<string, Array<Record<string, unknown>>>).recordHeads![0]!).note = "x"))],
        ["safety row", reseal((copy) => (((copy.tables as Record<string, Array<Record<string, unknown>>>).recordHeads![0]!).recordType = "SAFETY_EVENT"))],
        ["runtime pointer", reseal((copy) => (copy.requestedRuntimePointers = [{ runtimeKind: "DETERMINISTIC", manifestId: "m", manifestVersion: "1" }]))],
        ["not canonical", sealForTest(JSON.stringify(payload, null, 2), PASS, payload.containerId as string)],
        // Packet 11C C2: the current payload is version 2 (a duplicated version key is still refused).
        ["duplicate key", sealForTest(canonicalizeJson(payload).replace('{"backupSchemaVersion":2', '{"backupSchemaVersion":2,"backupSchemaVersion":2'), PASS, payload.containerId as string)],
        ["patient settings: unknown field", reseal((copy) => (copy.patientSettings = { keepWordingOnDevice: false, language: "en-SG" }))],
        ["patient settings: not a boolean", reseal((copy) => (copy.patientSettings = { keepWordingOnDevice: "false" }))],
        ["patient settings: missing", reseal((copy) => delete copy.patientSettings)],
      ];
      for (const [label, sealed] of cases) {
        // The manifest is recomputed for the reordered rows, so only order fails there.
        expect(await codeOf(validator().validate(await sealed, PASS)), label).toBe("BACKUP_PAYLOAD_INVALID");
      }
      expect(await codeOf(validator().validate(await reseal((copy) => (copy.backupSchemaVersion = 3)), PASS))).toBe("BACKUP_VERSION_UNSUPPORTED");
      expect(await codeOf(validator().validate(await reseal((copy) => (copy.sourceLogicalStorageSchemaVersion = 2)), PASS))).toBe("BACKUP_VERSION_UNSUPPORTED");
    },
    TIMEOUT,
  );
});

describe("closed in-memory backup migration (RST-008)", () => {
  const v0to1: BackupPayloadMigration = {
    migrationId: "jagaon.backup.test-step-0-to-1",
    fromBackupSchemaVersion: 0,
    toBackupSchemaVersion: 1,
    migrate: (old) => ({ ...old, backupSchemaVersion: 1 }),
  };

  // Packet 11C Addendum C, Task C2 (deliberate change): payload version 2 adds the patient settings, so the compiled registry now has
  // exactly one step, version 1 → 2, which adds the "Keep wording on this device" setting as off. Unknown versions still fail closed.
  it("registers exactly the version 1 → 2 step (the setting defaults to off) and fails closed on unknown versions", () => {
    expect(BACKUP_PAYLOAD_MIGRATIONS.map((step) => [step.migrationId, step.fromBackupSchemaVersion, step.toBackupSchemaVersion])).toEqual([["jagaon.backup.0001-patient-settings", 1, 2]]);
    expect(migrateBackupPayload({ backupSchemaVersion: 1 })).toEqual({ payload: { backupSchemaVersion: 2, patientSettings: { keepWordingOnDevice: false } }, appliedMigrationIds: ["jagaon.backup.0001-patient-settings"] });
    expect(migrateBackupPayload({ backupSchemaVersion: 2, patientSettings: { keepWordingOnDevice: true } })).toEqual({ payload: { backupSchemaVersion: 2, patientSettings: { keepWordingOnDevice: true } }, appliedMigrationIds: [] });
    // A version 1 payload never carried the setting; one that claims to is refused, never silently overwritten.
    expect(() => migrateBackupPayload({ backupSchemaVersion: 1, patientSettings: { keepWordingOnDevice: true } })).toThrow(expect.objectContaining({ code: "BACKUP_PAYLOAD_INVALID" }));
    expect(() => migrateBackupPayload({ backupSchemaVersion: 0 })).toThrow(expect.objectContaining({ code: "BACKUP_VERSION_UNSUPPORTED" }));
    expect(() => migrateBackupPayload({ backupSchemaVersion: 3 })).toThrow(expect.objectContaining({ code: "BACKUP_VERSION_UNSUPPORTED" }));
    expect(() => migrateBackupPayload({ backupSchemaVersion: "1" })).toThrow(expect.objectContaining({ code: "BACKUP_PAYLOAD_INVALID" }));
  });

  it(
    "Packet 11C C2: an old version 1 backup (no patient settings) still validates, migrated in memory, with the setting off",
    async () => {
      const old = await reseal((copy) => {
        copy.backupSchemaVersion = 1;
        delete copy.patientSettings;
      });
      const candidate = await validator().validate(old, PASS);
      expect(candidate.sourceBackupSchemaVersion).toBe(1);
      expect(candidate.appliedBackupMigrationIds).toEqual(["jagaon.backup.0001-patient-settings"]);
      expect(candidate.patientSettings).toEqual({ keepWordingOnDevice: false });
      expect(candidate.tables).toEqual(payload.tables);
      const claiming = await reseal((copy) => {
        copy.backupSchemaVersion = 1;
        copy.patientSettings = { keepWordingOnDevice: true };
      });
      expect(await codeOf(validator().validate(claiming, PASS))).toBe("BACKUP_PAYLOAD_INVALID");
    },
    TIMEOUT,
  );

  it(
    "Packet 11C C2: a version 2 backup carries its own setting into the candidate exactly",
    async () => {
      for (const keepWordingOnDevice of [true, false]) {
        const candidate = await validator().validate(await reseal((copy) => (copy.patientSettings = { keepWordingOnDevice })), PASS);
        expect(candidate.sourceBackupSchemaVersion).toBe(2);
        expect(candidate.appliedBackupMigrationIds).toEqual([]);
        expect(candidate.patientSettings).toEqual({ keepWordingOnDevice });
      }
    },
    TIMEOUT,
  );

  it(
    "applies an exact registered step in memory and then validates the result completely",
    async () => {
      const old = await reseal((copy) => {
        copy.backupSchemaVersion = 0;
        delete copy.patientSettings;
      });
      // A test-only 0 → 1 step followed by the registered 1 → 2 step.
      const migrating = createBackupRestoreValidator({ crypto: () => createWebCryptoPort(), migrations: [v0to1, ...BACKUP_PAYLOAD_MIGRATIONS] });
      const candidate = await migrating.validate(old, PASS);
      expect(candidate.appliedBackupMigrationIds).toEqual(["jagaon.backup.test-step-0-to-1", "jagaon.backup.0001-patient-settings"]);
      expect(candidate.sourceBackupSchemaVersion).toBe(0);
      const inventing = createBackupRestoreValidator({ crypto: () => createWebCryptoPort(), migrations: [{ ...v0to1, migrate: (oldPayload) => ({ ...oldPayload, backupSchemaVersion: 1, invented: "value" }) }, ...BACKUP_PAYLOAD_MIGRATIONS] });
      expect(await codeOf(inventing.validate(old, PASS))).toBe("BACKUP_PAYLOAD_INVALID");
    },
    TIMEOUT,
  );
});
