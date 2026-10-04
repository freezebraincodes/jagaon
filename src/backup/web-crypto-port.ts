import { StorageOperationError } from "@/storage/storage-failure";

/**
 * Thin browser-native Web Crypto adapter (storage-backup-spec 7.1–7.3).
 * PBKDF2-HMAC-SHA-256 derives a non-extractable AES-256-GCM key; AES-GCM uses
 * a 96-bit IV and a 128-bit tag over the authenticated header. JagaOn
 * implements no primitive, padding, tag or random generator itself, stores no
 * key, and never logs inputs or outputs.
 */

export const BACKUP_KDF_EXPORT_ITERATIONS = 600_000;
export const BACKUP_KDF_MIN_ITERATIONS = 600_000;
export const BACKUP_KDF_MAX_ITERATIONS = 2_000_000;
export const BACKUP_SALT_BYTES = 16;
export const BACKUP_IV_BYTES = 12;
export const BACKUP_CONTAINER_ID_BYTES = 16;

export type BackupCryptoPort = {
  randomBytes(length: number): Uint8Array;
  deriveKey(passphraseBytes: Uint8Array, salt: Uint8Array, iterations: number): Promise<CryptoKey>;
  encrypt(key: CryptoKey, iv: Uint8Array, additionalData: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array>;
  /** Rejects on any authentication failure; the caller maps it to one combined outcome. */
  decrypt(key: CryptoKey, iv: Uint8Array, additionalData: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array>;
  sha256(data: Uint8Array): Promise<Uint8Array>;
};

type CryptoLike = Pick<Crypto, "getRandomValues"> & { subtle?: SubtleCrypto };

function assertIterations(iterations: number): void {
  if (!Number.isSafeInteger(iterations) || iterations < BACKUP_KDF_MIN_ITERATIONS || iterations > BACKUP_KDF_MAX_ITERATIONS) {
    throw new StorageOperationError("BACKUP_KDF_UNSUPPORTED");
  }
}

/**
 * Returns the port, or throws a closed capability failure when the context
 * is not secure or Web Crypto is missing. There is no fallback.
 */
export function createWebCryptoPort(environment: { crypto?: CryptoLike; isSecureContext?: boolean } = globalThis): BackupCryptoPort {
  if (environment.isSecureContext === false) throw new StorageOperationError("SECURE_CONTEXT_REQUIRED");
  const crypto = environment.crypto;
  const subtle = crypto?.subtle;
  if (!crypto || !subtle || typeof crypto.getRandomValues !== "function") throw new StorageOperationError("BACKUP_CRYPTO_UNAVAILABLE");

  const bufferOf = (bytes: Uint8Array) => bytes as Uint8Array<ArrayBuffer>;

  return Object.freeze({
    randomBytes(length: number) {
      return crypto.getRandomValues(new Uint8Array(length));
    },
    async deriveKey(passphraseBytes: Uint8Array, salt: Uint8Array, iterations: number) {
      assertIterations(iterations);
      if (salt.length !== BACKUP_SALT_BYTES) throw new StorageOperationError("BACKUP_KDF_UNSUPPORTED");
      const material = await subtle.importKey("raw", bufferOf(passphraseBytes), "PBKDF2", false, ["deriveKey"]);
      return subtle.deriveKey(
        { name: "PBKDF2", hash: "SHA-256", salt: bufferOf(salt), iterations },
        material,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
    },
    async encrypt(key: CryptoKey, iv: Uint8Array, additionalData: Uint8Array, plaintext: Uint8Array) {
      if (iv.length !== BACKUP_IV_BYTES) throw new StorageOperationError("BACKUP_ENCRYPTION_FAILED");
      const out = await subtle.encrypt({ name: "AES-GCM", iv: bufferOf(iv), additionalData: bufferOf(additionalData), tagLength: 128 }, key, bufferOf(plaintext));
      return new Uint8Array(out);
    },
    async decrypt(key: CryptoKey, iv: Uint8Array, additionalData: Uint8Array, ciphertext: Uint8Array) {
      const out = await subtle.decrypt({ name: "AES-GCM", iv: bufferOf(iv), additionalData: bufferOf(additionalData), tagLength: 128 }, key, bufferOf(ciphertext));
      return new Uint8Array(out);
    },
    async sha256(data: Uint8Array) {
      return new Uint8Array(await subtle.digest("SHA-256", bufferOf(data)));
    },
  });
}
