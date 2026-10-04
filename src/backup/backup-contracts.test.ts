import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { APPLICATION_VERSION } from "@/config/application-version";
import { canonicaliseBackupTable, canonicalRowsBytes, createBackupManifest, BackupCanonicalisationError, toHex } from "./backup-canonicalisation";
import { canonicaliseBackupHeaderAad, encryptedBackupContainerV1Schema, serialiseBackupContainer, type EncryptedBackupContainerV1 } from "./backup-container-v1";
import { BACKUP_TABLE_NAMES_V1, backupPayloadV1Schema, type BackupTableSetV1 } from "./backup-payload-v1";
import { encodeBase64Url } from "./base64url";
import { createWebCryptoPort } from "./web-crypto-port";

const b64 = (length: number, fill = 1) => encodeBase64Url(new Uint8Array(length).fill(fill));

function container(): EncryptedBackupContainerV1 {
  return {
    format: "jagaon-encrypted-backup",
    containerVersion: 1,
    containerId: b64(16),
    encoding: "BASE64URL_NO_PADDING",
    passphraseEncoding: "UTF-8-NFC",
    kdf: { algorithm: "PBKDF2", hash: "SHA-256", iterations: 600_000, salt: b64(16, 2) },
    cipher: { algorithm: "AES-GCM", keyLengthBits: 256, iv: b64(12, 3), tagLengthBits: 128 },
    aadProfile: "JAGAON_BACKUP_HEADER_V1",
    ciphertext: b64(40, 4),
  };
}

const emptyTables = () => Object.fromEntries(BACKUP_TABLE_NAMES_V1.map((name) => [name, []])) as unknown as BackupTableSetV1;

describe("version 1 container contract", () => {
  it("accepts the exact closed shape and rejects unknown fields, wrong versions and wrong binary lengths", () => {
    expect(encryptedBackupContainerV1Schema.safeParse(container()).success).toBe(true);
    const bad: Array<Record<string, unknown>> = [
      { ...container(), extra: 1 },
      { ...container(), containerVersion: 2 },
      { ...container(), containerId: b64(15) },
      { ...container(), kdf: { ...container().kdf, salt: b64(8) } },
      { ...container(), kdf: { ...container().kdf, iterations: 599_999 } },
      { ...container(), kdf: { ...container().kdf, iterations: 2_000_001 } },
      { ...container(), kdf: { ...container().kdf, hash: "SHA-1" } },
      { ...container(), cipher: { ...container().cipher, iv: b64(16) } },
      { ...container(), cipher: { ...container().cipher, tagLengthBits: 96 } },
      { ...container(), ciphertext: b64(15) },
      { ...container(), ciphertext: `${b64(40)}=` },
      { ...container(), encoding: "BASE64" },
    ];
    for (const value of bad) expect(encryptedBackupContainerV1Schema.safeParse(value).success, JSON.stringify(value).slice(0, 80)).toBe(false);
  });

  it("authenticates every clear header field in canonical order and excludes only the ciphertext", () => {
    const aad = new TextDecoder().decode(canonicaliseBackupHeaderAad(container()));
    expect(aad).not.toContain("ciphertext");
    expect(aad.startsWith('{"aadProfile":"JAGAON_BACKUP_HEADER_V1","cipher":{"algorithm":"AES-GCM","iv":')).toBe(true);
    for (const field of ["containerId", "containerVersion", "encoding", "format", "kdf", "passphraseEncoding", "salt", "iterations", "keyLengthBits", "tagLengthBits"]) expect(aad).toContain(`"${field}"`);
    // Insertion order never matters.
    const reordered = { ...container(), aadProfile: "JAGAON_BACKUP_HEADER_V1" as const, format: "jagaon-encrypted-backup" as const };
    expect(new TextDecoder().decode(canonicaliseBackupHeaderAad(reordered))).toBe(aad);
    expect(new TextDecoder().decode(serialiseBackupContainer(container()))).toContain('"ciphertext":');
  });
});

describe("version 1 payload contract and canonical manifest", () => {
  const payload = (tables = emptyTables(), manifests = BACKUP_TABLE_NAMES_V1.map((tableName) => ({ tableName, tableEnvelopeSchemaVersion: 1, rowCount: 0, canonicalRowsSha256: "0".repeat(64) }))) => ({
    format: "jagaon-backup-payload",
    backupSchemaVersion: 1,
    containerId: b64(16),
    datasetIdentity: "6f1c2b9e-3d4a-4b5c-8d6e-7f8091a2b3c4",
    exportedAt: "2026-10-04T02:00:00.000Z",
    sourceApplicationVersion: "0.1.0",
    sourceDexieVersion: 2,
    sourceLogicalStorageSchemaVersion: 1,
    canonicalJsonProfile: "JAGAON_CANONICAL_JSON_V1",
    eventSequenceHighWaterMark: 0,
    requestedRuntimePointers: [],
    tableManifests: manifests,
    tables,
  });

  it("requires exactly the 14 tables, ordered manifests and no excluded device state", () => {
    expect(BACKUP_TABLE_NAMES_V1).toHaveLength(14);
    expect(BACKUP_TABLE_NAMES_V1).not.toContain("appPreferences");
    expect(BACKUP_TABLE_NAMES_V1).not.toContain("storageMetadata");
    expect(backupPayloadV1Schema.safeParse(payload()).success).toBe(true);
    const { recordHeads: _omitted, ...missing } = emptyTables();
    expect(backupPayloadV1Schema.safeParse(payload(missing as never)).success).toBe(false);
    expect(backupPayloadV1Schema.safeParse(payload({ ...emptyTables(), appPreferences: [] } as never)).success).toBe(false);
    expect(backupPayloadV1Schema.safeParse(payload(emptyTables(), [...payload().tableManifests].reverse())).success).toBe(false);
    expect(backupPayloadV1Schema.safeParse({ ...payload(), passphrase: "x" }).success).toBe(false);
    expect(backupPayloadV1Schema.safeParse({ ...payload(), requestedRuntimePointers: [{ runtimeKind: "DETERMINISTIC", manifestId: "m", manifestVersion: "1" }] }).success).toBe(false);
    expect(backupPayloadV1Schema.safeParse({ ...payload(), backupSchemaVersion: 2 }).success).toBe(false);
  });

  it("orders rows by exact primary key regardless of input order and rejects duplicates", () => {
    const rows = [{ eventId: "c", n: 1 }, { eventId: "a", n: 2 }, { eventId: "b", n: 3 }];
    const sorted = canonicaliseBackupTable("domainEvents", rows);
    expect(sorted.map((row) => (row as { eventId: string }).eventId)).toEqual(["a", "b", "c"]);
    expect(toHex(canonicalRowsBytes(canonicaliseBackupTable("domainEvents", [...rows].reverse())))).toBe(toHex(canonicalRowsBytes(sorted)));
    expect(() => canonicaliseBackupTable("domainEvents", [...rows, { eventId: "a", n: 9 }])).toThrow(BackupCanonicalisationError);
    const compound = canonicaliseBackupTable("eventConsumerReceipts", [
      { eventId: "e", consumer: "B", handlerVersion: "1" },
      { eventId: "e", consumer: "A", handlerVersion: "2" },
      { eventId: "d", consumer: "Z", handlerVersion: "1" },
    ]);
    expect(compound.map((row) => (row as { consumer: string }).consumer)).toEqual(["Z", "A", "B"]);
  });

  it("produces stable per-table digests that change with any single-field mutation", async () => {
    const sha256 = createWebCryptoPort().sha256;
    const tables = { ...emptyTables(), recordHeads: [{ recordId: "r1", state: "ACTIVE" }] };
    const a = await createBackupManifest(tables, sha256);
    const b = await createBackupManifest({ ...emptyTables(), recordHeads: [{ state: "ACTIVE", recordId: "r1" }] }, sha256);
    const c = await createBackupManifest({ ...emptyTables(), recordHeads: [{ recordId: "r1", state: "DELETED" }] }, sha256);
    expect(a).toEqual(b);
    expect(a.find((entry) => entry.tableName === "recordHeads")!.canonicalRowsSha256).not.toBe(c.find((entry) => entry.tableName === "recordHeads")!.canonicalRowsSha256);
    expect(a.map((entry) => entry.tableName)).toEqual([...BACKUP_TABLE_NAMES_V1]);
    expect(a[0]!.canonicalRowsSha256).toBe("4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"); // SHA-256 of "[]"
  });

  it("records the package.json application version", () => {
    expect(APPLICATION_VERSION).toBe(JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")).version);
  });
});
