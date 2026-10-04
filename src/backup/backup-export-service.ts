import { APPLICATION_VERSION } from "@/config/application-version";
import type { Instant } from "@/domain/shared/time";
import { normaliseStorageFailure, StorageOperationError, type StorageOperationFailure } from "@/storage/storage-failure";
import { LOGICAL_STORAGE_SCHEMA_VERSION } from "@/storage/storage-metadata";
import { JAGAON_DEXIE_VERSION } from "@/storage/table-catalogue";
import { encodeBase64Url } from "./base64url";
import { canonicaliseBackupPayload, createBackupManifest } from "./backup-canonicalisation";
import {
  BACKUP_AAD_PROFILE,
  BACKUP_CONTAINER_FORMAT,
  canonicaliseBackupHeaderAad,
  MAX_BACKUP_ENCODED_BYTES,
  MAX_BACKUP_PLAINTEXT_BYTES,
  serialiseBackupContainer,
  type EncryptedBackupContainerV1,
} from "./backup-container-v1";
import { BACKUP_PAYLOAD_FORMAT, BACKUP_SCHEMA_VERSION, backupPayloadV1Schema, CANONICAL_JSON_PROFILE, type BackupPayloadV1 } from "./backup-payload-v1";
import type { BackupSnapshotRepository } from "./backup-snapshot-repository";
import { validateConfirmedPassphrase, type PassphraseProblem } from "./passphrase";
import { BACKUP_CONTAINER_ID_BYTES, BACKUP_IV_BYTES, BACKUP_KDF_EXPORT_ITERATIONS, BACKUP_SALT_BYTES, type BackupCryptoPort } from "./web-crypto-port";

/**
 * Encrypted backup export (storage-backup-spec 7.5–7.6; BAK-006–BAK-017).
 * The locked pipeline order is: capability preflight → one validated
 * snapshot → canonical payload and manifest (size checked) → non-extractable
 * key from the confirmed passphrase → AES-256-GCM with the authenticated
 * header → closed container (size checked) → patient-chosen save. Nothing is
 * written to IndexedDB, logged, cached or sent anywhere.
 */

export type BackupSaveOutcome = "FILE_WRITE_CONFIRMED" | "DOWNLOAD_STARTED" | "CANCELLED";

export type BackupFilePort = {
  save(file: Blob, fileName: string): Promise<BackupSaveOutcome>;
};

export type BackupExportStep = 0 | 1 | 2 | 3;

export type BackupExportResult =
  | { kind: "FILE_WRITE_CONFIRMED" | "DOWNLOAD_STARTED"; fileName: string; preparedAt: Instant }
  | { kind: "CANCELLED" }
  | { kind: "PASSPHRASE_REJECTED"; problem: PassphraseProblem | "MISMATCH" }
  | { kind: "FAILED"; failure: StorageOperationFailure };

export type BackupExportService = {
  export(request: { passphrase: string; confirmation: string }, events?: { onStepCompleted?(step: BackupExportStep): void }): Promise<BackupExportResult>;
};

/** Product name and local export date only (spec 7.6). */
export function backupFileName(at: Instant, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(at));
  const part = (type: string) => parts.find((entry) => entry.type === type)!.value;
  return `JagaOn-backup-${part("year")}-${part("month")}-${part("day")}.jagaon`;
}

export function createBackupExportService(dependencies: {
  snapshot: BackupSnapshotRepository;
  /** Resolved lazily; throws a closed capability failure without Web Crypto. */
  crypto: () => BackupCryptoPort;
  file: BackupFilePort;
  now(): Instant;
  timeZone?: string;
  limits?: { maxPlaintextBytes: number; maxEncodedBytes: number };
}): BackupExportService {
  const limits = dependencies.limits ?? { maxPlaintextBytes: MAX_BACKUP_PLAINTEXT_BYTES, maxEncodedBytes: MAX_BACKUP_ENCODED_BYTES };
  const timeZone = dependencies.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  return Object.freeze({
    async export(request: { passphrase: string; confirmation: string }, events: { onStepCompleted?(step: BackupExportStep): void } = {}) {
      const exportedAt = dependencies.now();
      const confirmed = validateConfirmedPassphrase(request.passphrase, request.confirmation);
      if (!confirmed.ok) return { kind: "PASSPHRASE_REJECTED", problem: confirmed.problem };
      let passphraseBytes: Uint8Array | null = confirmed.bytes;
      let plaintext: Uint8Array | null = null;
      try {
        const crypto = dependencies.crypto();

        const snapshot = await dependencies.snapshot.readValidatedSnapshot();
        const containerIdBytes = crypto.randomBytes(BACKUP_CONTAINER_ID_BYTES);
        const salt = crypto.randomBytes(BACKUP_SALT_BYTES);
        const iv = crypto.randomBytes(BACKUP_IV_BYTES);
        const containerId = encodeBase64Url(containerIdBytes);
        const payload: BackupPayloadV1 = {
          format: BACKUP_PAYLOAD_FORMAT,
          backupSchemaVersion: BACKUP_SCHEMA_VERSION,
          containerId,
          datasetIdentity: snapshot.identity.datasetIdentity,
          exportedAt,
          sourceApplicationVersion: APPLICATION_VERSION,
          sourceDexieVersion: JAGAON_DEXIE_VERSION,
          sourceLogicalStorageSchemaVersion: LOGICAL_STORAGE_SCHEMA_VERSION,
          canonicalJsonProfile: CANONICAL_JSON_PROFILE,
          eventSequenceHighWaterMark: snapshot.eventSequenceHighWaterMark,
          ...(snapshot.identity.lastCompletedMigrationId ? { lastCompletedMigrationId: snapshot.identity.lastCompletedMigrationId } : {}),
          requestedRuntimePointers: [],
          tableManifests: await createBackupManifest(snapshot.tables, crypto.sha256),
          tables: snapshot.tables,
        };
        if (!backupPayloadV1Schema.safeParse(payload).success) throw new StorageOperationError("BACKUP_VALIDATION_FAILED");
        plaintext = canonicaliseBackupPayload(payload);
        if (plaintext.length > limits.maxPlaintextBytes) throw new StorageOperationError("BACKUP_TOO_LARGE_FOR_FORMAT_V1");
        events.onStepCompleted?.(0);

        const key = await crypto.deriveKey(passphraseBytes, salt, BACKUP_KDF_EXPORT_ITERATIONS);
        passphraseBytes.fill(0);
        passphraseBytes = null;
        events.onStepCompleted?.(1);

        const header: Omit<EncryptedBackupContainerV1, "ciphertext"> = {
          format: BACKUP_CONTAINER_FORMAT,
          containerVersion: 1,
          containerId,
          encoding: "BASE64URL_NO_PADDING",
          passphraseEncoding: "UTF-8-NFC",
          kdf: { algorithm: "PBKDF2", hash: "SHA-256", iterations: BACKUP_KDF_EXPORT_ITERATIONS, salt: encodeBase64Url(salt) },
          cipher: { algorithm: "AES-GCM", keyLengthBits: 256, iv: encodeBase64Url(iv), tagLengthBits: 128 },
          aadProfile: BACKUP_AAD_PROFILE,
        };
        let ciphertext: Uint8Array;
        try {
          ciphertext = await crypto.encrypt(key, iv, canonicaliseBackupHeaderAad(header), plaintext);
        } catch (error) {
          if (error instanceof StorageOperationError) throw error;
          throw new StorageOperationError("BACKUP_ENCRYPTION_FAILED");
        }
        plaintext.fill(0);
        plaintext = null;
        const file = serialiseBackupContainer({ ...header, ciphertext: encodeBase64Url(ciphertext) });
        if (file.length > limits.maxEncodedBytes) throw new StorageOperationError("BACKUP_TOO_LARGE_FOR_FORMAT_V1");
        events.onStepCompleted?.(2);

        const fileName = backupFileName(exportedAt, timeZone);
        const saved = await dependencies.file.save(new Blob([file as Uint8Array<ArrayBuffer>], { type: "application/octet-stream" }), fileName);
        if (saved === "CANCELLED") return { kind: "CANCELLED" };
        events.onStepCompleted?.(3);
        return { kind: saved, fileName, preparedAt: exportedAt };
      } catch (error) {
        return { kind: "FAILED", failure: normaliseStorageFailure("EXPORT_BACKUP", error, exportedAt) };
      } finally {
        // References are dropped; JavaScript cannot promise physical erasure (spec 7.3).
        passphraseBytes?.fill(0);
        plaintext?.fill(0);
      }
    },
  });
}

