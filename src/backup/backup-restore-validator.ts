import { canonicalizeJson } from "@/application/contracts/canonical-json";
import { isJournalSourceEventName, JOURNAL_DELETED_EVENT_PAYLOAD } from "@/application/journal/journal-stored-rows";
import { HACKATHON_CLOSED_ROW_CODECS } from "@/application/storage/profile-row-codecs";
import { validateAiAuditReferences } from "@/application/ai/ai-audit-lifecycle";
import { validateReverseDependencies } from "@/application/restore/dependency-reconstruction";
import { verifyDataset, type DatasetTables } from "@/storage/dataset-verifier";
import { StorageOperationError } from "@/storage/storage-failure";
import { LOGICAL_STORAGE_SCHEMA_VERSION } from "@/storage/storage-metadata";
import { JAGAON_DEXIE_VERSION, JAGAON_TABLE_NAMES } from "@/storage/table-catalogue";
import type { Instant } from "@/domain/shared/time";
import { decodeBase64Url } from "./base64url";
import { canonicalRowsBytes, isCanonicallyOrdered, toHex } from "./backup-canonicalisation";
import { parseCanonicalContainerV1 } from "./backup-container-reader";
import { canonicaliseBackupHeaderAad, MAX_BACKUP_ENCODED_BYTES, MAX_BACKUP_PLAINTEXT_BYTES } from "./backup-container-v1";
import { migrateBackupPayload, type BackupPayloadMigration } from "./backup-migration-registry";
import { BACKUP_TABLE_NAMES_V1, backupPayloadV1Schema, type BackupTableSetV1 } from "./backup-payload-v1";
import { normaliseBackupPassphrase } from "./passphrase";
import { decodeStrictUtf8, parseStrictJson, StrictJsonError, toPlainData } from "./strict-json";
import type { BackupCryptoPort } from "./web-crypto-port";

/**
 * Untrusted backup validation (storage-backup-spec 8.3–8.4; RST-007–RST-009,
 * BAK-007, BAK-008, BAK-011). The header is validated before key derivation;
 * AES-GCM authenticates the header and ciphertext before any plaintext is
 * used; then the plaintext is parsed strictly, migrated in memory only when a
 * registered migration exists, and validated completely: envelope, manifest
 * counts, order and digests, every row through its closed codec, and every
 * dataset invariant. Nothing is written, logged or sent.
 */

export type ValidatedBackupCandidate = Readonly<{
  containerId: string;
  datasetIdentity: string;
  exportedAt: Instant;
  sourceApplicationVersion: string;
  sourceBackupSchemaVersion: number;
  eventSequenceHighWaterMark: number;
  highestEventSequence: number;
  lastCompletedMigrationId?: string;
  tables: BackupTableSetV1;
  payloadFingerprint: string;
  appliedBackupMigrationIds: string[];
}>;

const PAYLOAD_MAX_DEPTH = 64;

function isRedacted(payload: unknown): boolean {
  return typeof payload === "object" && payload !== null && Object.keys(payload).length === 1 && (payload as { reasonCode?: unknown }).reasonCode === JOURNAL_DELETED_EVENT_PAYLOAD.reasonCode;
}

export function createBackupRestoreValidator(dependencies: {
  crypto: () => BackupCryptoPort;
  limits?: { maxPlaintextBytes: number; maxEncodedBytes: number };
  migrations?: readonly BackupPayloadMigration[];
}) {
  const limits = dependencies.limits ?? { maxPlaintextBytes: MAX_BACKUP_PLAINTEXT_BYTES, maxEncodedBytes: MAX_BACKUP_ENCODED_BYTES };

  async function validate(file: Uint8Array, passphrase: string): Promise<ValidatedBackupCandidate> {
    const container = parseCanonicalContainerV1(file, limits.maxEncodedBytes);
    const crypto = dependencies.crypto();

    // Wrong passphrase and changed content share one outcome (spec 8.3).
    const normalised = normaliseBackupPassphrase(passphrase);
    if (!normalised.ok) throw new StorageOperationError("BACKUP_AUTHENTICATION_FAILED");
    let plaintext: Uint8Array;
    try {
      const key = await crypto.deriveKey(normalised.bytes, decodeBase64Url(container.kdf.salt, 16), container.kdf.iterations);
      normalised.bytes.fill(0);
      plaintext = await crypto.decrypt(key, decodeBase64Url(container.cipher.iv, 12), canonicaliseBackupHeaderAad(container), decodeBase64Url(container.ciphertext));
    } catch (error) {
      if (error instanceof StorageOperationError && error.code === "BACKUP_KDF_UNSUPPORTED") throw error;
      throw new StorageOperationError("BACKUP_AUTHENTICATION_FAILED");
    }

    try {
      if (plaintext.length > limits.maxPlaintextBytes) throw new StorageOperationError("BACKUP_PAYLOAD_INVALID");
      const payloadFingerprint = toHex(await crypto.sha256(plaintext));
      let text: string;
      let raw: Record<string, unknown>;
      try {
        text = decodeStrictUtf8(plaintext);
        raw = toPlainData(parseStrictJson(text, { maxDepth: PAYLOAD_MAX_DEPTH, maxLength: limits.maxPlaintextBytes })) as Record<string, unknown>;
      } catch (error) {
        if (error instanceof StrictJsonError) throw new StorageOperationError("BACKUP_PAYLOAD_INVALID");
        throw error;
      }
      if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.format !== "jagaon-backup-payload") throw new StorageOperationError("BACKUP_PAYLOAD_INVALID");
      if (canonicalizeJson(raw) !== text) throw new StorageOperationError("BACKUP_PAYLOAD_INVALID");
      const sourceBackupSchemaVersion = raw.backupSchemaVersion as number;
      const migrated = migrateBackupPayload(raw, dependencies.migrations);

      const parsed = backupPayloadV1Schema.safeParse(migrated.payload);
      if (!parsed.success) throw new StorageOperationError("BACKUP_PAYLOAD_INVALID");
      const payload = parsed.data;
      if (payload.containerId !== container.containerId) throw new StorageOperationError("BACKUP_PAYLOAD_INVALID");
      if (payload.sourceLogicalStorageSchemaVersion > LOGICAL_STORAGE_SCHEMA_VERSION || payload.sourceDexieVersion > JAGAON_DEXIE_VERSION) {
        throw new StorageOperationError("BACKUP_VERSION_UNSUPPORTED", { storedVersion: payload.sourceLogicalStorageSchemaVersion, supportedVersion: LOGICAL_STORAGE_SCHEMA_VERSION });
      }

      for (const manifest of payload.tableManifests) {
        const rows = payload.tables[manifest.tableName];
        if (rows.length !== manifest.rowCount) throw new StorageOperationError("BACKUP_PAYLOAD_INVALID", { tableName: manifest.tableName });
        if (!isCanonicallyOrdered(manifest.tableName, rows)) throw new StorageOperationError("BACKUP_PAYLOAD_INVALID", { tableName: manifest.tableName });
        if (toHex(await crypto.sha256(canonicalRowsBytes(rows))) !== manifest.canonicalRowsSha256) throw new StorageOperationError("BACKUP_PAYLOAD_INVALID", { tableName: manifest.tableName });
      }

      // Complete dataset closure with the payload's own allowlisted metadata.
      const tables = Object.fromEntries(JAGAON_TABLE_NAMES.map((name) => [name, [] as unknown[]])) as unknown as Record<string, unknown[]>;
      for (const name of BACKUP_TABLE_NAMES_V1) tables[name] = payload.tables[name];
      tables.storageMetadata = [{ key: "EVENT_SEQUENCE_HIGH_WATER_MARK", lastAllocatedSequence: payload.eventSequenceHighWaterMark, updatedAt: payload.exportedAt }];
      const verification = verifyDataset(tables as unknown as DatasetTables, HACKATHON_CLOSED_ROW_CODECS, { requireMetadata: false, auditLinkage: true });
      if (verification.kind === "FAILED") throw new StorageOperationError("BACKUP_PAYLOAD_INVALID", { tableName: verification.tableName });
      // Exact edge completeness and governed fields; the backup is never repaired.
      if (validateReverseDependencies(tables.recordRevisions, tables.reverseDependencies).kind !== "VALID") {
        throw new StorageOperationError("BACKUP_PAYLOAD_INVALID", { tableName: "reverseDependencies" });
      }
      // Every AI audit reference resolves exactly; a dangling or foreign one is never restored (Packet 11A).
      if (validateAiAuditReferences({ recordRevisions: tables.recordRevisions, aiInvocationAudits: tables.aiInvocationAudits }).kind !== "VALID") {
        throw new StorageOperationError("BACKUP_PAYLOAD_INVALID", { tableName: "aiInvocationAudits" });
      }

      const tombstoned = new Set((payload.tables.deletionTombstones as Array<{ recordId: string }>).map((row) => row.recordId));
      for (const event of payload.tables.domainEvents as Array<{ eventName: string; change: { recordId: string }; payload: unknown }>) {
        if (tombstoned.has(event.change.recordId) && isJournalSourceEventName(event.eventName) && !isRedacted(event.payload)) {
          throw new StorageOperationError("BACKUP_PAYLOAD_INVALID", { tableName: "domainEvents" });
        }
      }

      return Object.freeze({
        containerId: payload.containerId,
        datasetIdentity: payload.datasetIdentity,
        exportedAt: payload.exportedAt,
        sourceApplicationVersion: payload.sourceApplicationVersion,
        sourceBackupSchemaVersion,
        eventSequenceHighWaterMark: payload.eventSequenceHighWaterMark,
        highestEventSequence: verification.highestEventSequence,
        ...(payload.lastCompletedMigrationId ? { lastCompletedMigrationId: payload.lastCompletedMigrationId } : {}),
        tables: payload.tables,
        payloadFingerprint,
        appliedBackupMigrationIds: migrated.appliedMigrationIds,
      });
    } finally {
      plaintext.fill(0);
    }
  }

  return Object.freeze({ validate });
}
