import { canonicalizeJson } from "@/application/contracts/canonical-json";
import { StorageOperationError } from "@/storage/storage-failure";
import { encryptedBackupContainerV1Schema, MAX_BACKUP_ENCODED_BYTES, type EncryptedBackupContainerV1 } from "./backup-container-v1";
import { decodeStrictUtf8, parseStrictJson, StrictJsonError, toPlainData } from "./strict-json";
import { BACKUP_KDF_MAX_ITERATIONS, BACKUP_KDF_MIN_ITERATIONS } from "./web-crypto-port";

/**
 * Untrusted-file preflight (storage-backup-spec 8.3). Before any key
 * derivation: the encoded-size bound, strict UTF-8 and bounded strict JSON,
 * the exact closed container, the closed KDF range, and byte-for-byte
 * canonical re-serialisation. Filename and MIME type are never trusted.
 */

const CONTAINER_MAX_DEPTH = 4;

export function parseCanonicalContainerV1(bytes: Uint8Array, maxEncodedBytes = MAX_BACKUP_ENCODED_BYTES): EncryptedBackupContainerV1 {
  if (bytes.length > maxEncodedBytes) throw new StorageOperationError("BACKUP_FILE_UNSUPPORTED");
  let parsed: unknown;
  let text: string;
  try {
    text = decodeStrictUtf8(bytes);
    parsed = toPlainData(parseStrictJson(text, { maxDepth: CONTAINER_MAX_DEPTH, maxLength: maxEncodedBytes }));
  } catch (error) {
    if (error instanceof StrictJsonError) throw new StorageOperationError("BACKUP_FILE_UNSUPPORTED");
    throw error;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new StorageOperationError("BACKUP_FILE_UNSUPPORTED");
  const candidate = parsed as Record<string, unknown>;
  if (candidate.format !== "jagaon-encrypted-backup") throw new StorageOperationError("BACKUP_FILE_UNSUPPORTED");
  if (candidate.containerVersion !== 1) {
    throw new StorageOperationError(
      typeof candidate.containerVersion === "number" && Number.isSafeInteger(candidate.containerVersion) && candidate.containerVersion > 1
        ? "BACKUP_VERSION_UNSUPPORTED"
        : "BACKUP_FILE_UNSUPPORTED",
      typeof candidate.containerVersion === "number" ? { storedVersion: candidate.containerVersion, supportedVersion: 1 } : {},
    );
  }
  const kdf = candidate.kdf as Record<string, unknown> | undefined;
  if (
    !kdf ||
    kdf.algorithm !== "PBKDF2" ||
    kdf.hash !== "SHA-256" ||
    typeof kdf.iterations !== "number" ||
    !Number.isSafeInteger(kdf.iterations) ||
    kdf.iterations < BACKUP_KDF_MIN_ITERATIONS ||
    kdf.iterations > BACKUP_KDF_MAX_ITERATIONS
  ) {
    throw new StorageOperationError("BACKUP_KDF_UNSUPPORTED");
  }
  const result = encryptedBackupContainerV1Schema.safeParse(candidate);
  if (!result.success) throw new StorageOperationError("BACKUP_FILE_UNSUPPORTED");
  // One canonical spelling only: whitespace, key order, number and escape forms must match.
  if (canonicalizeJson(result.data) !== text!) throw new StorageOperationError("BACKUP_FILE_UNSUPPORTED");
  return result.data as EncryptedBackupContainerV1;
}
