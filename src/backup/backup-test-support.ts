import { canonicaliseBackupHeaderAad, type EncryptedBackupContainerV1 } from "./backup-container-v1";
import { decodeBase64Url } from "./base64url";
import type { BackupFilePort, BackupSaveOutcome } from "./backup-export-service";
import { createWebCryptoPort } from "./web-crypto-port";

/** Test-only helpers: capture saved files and decrypt them. Never imported by runtime code. */

/** jsdom's Blob has no arrayBuffer(); FileReader works in every environment. */
export function blobBytes(file: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

export function capturingFilePort(outcome: BackupSaveOutcome = "DOWNLOAD_STARTED") {
  const saved: Array<{ bytes: Uint8Array; fileName: string; type: string }> = [];
  const port: BackupFilePort = {
    async save(file, fileName) {
      saved.push({ bytes: await blobBytes(file), fileName, type: file.type });
      return outcome;
    },
  };
  return { port, saved };
}

export function parseContainer(bytes: Uint8Array): EncryptedBackupContainerV1 {
  return JSON.parse(new TextDecoder().decode(bytes)) as EncryptedBackupContainerV1;
}

export async function decryptForTest(container: EncryptedBackupContainerV1, passphrase: string): Promise<Record<string, unknown>> {
  const crypto = createWebCryptoPort();
  const key = await crypto.deriveKey(new TextEncoder().encode(passphrase.normalize("NFC")), decodeBase64Url(container.kdf.salt), container.kdf.iterations);
  const plaintext = await crypto.decrypt(key, decodeBase64Url(container.cipher.iv), canonicaliseBackupHeaderAad(container), decodeBase64Url(container.ciphertext));
  return JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>;
}

/** Seals any payload text as a real v1 container (test-only, for validation-stage fixtures). */
export async function sealForTest(payloadText: string, passphrase: string, containerId?: string): Promise<Uint8Array> {
  const { encodeBase64Url } = await import("./base64url");
  const { serialiseBackupContainer } = await import("./backup-container-v1");
  const crypto = createWebCryptoPort();
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const header = {
    format: "jagaon-encrypted-backup" as const,
    containerVersion: 1 as const,
    containerId: containerId ?? encodeBase64Url(crypto.randomBytes(16)),
    encoding: "BASE64URL_NO_PADDING" as const,
    passphraseEncoding: "UTF-8-NFC" as const,
    kdf: { algorithm: "PBKDF2" as const, hash: "SHA-256" as const, iterations: 600_000, salt: encodeBase64Url(salt) },
    cipher: { algorithm: "AES-GCM" as const, keyLengthBits: 256 as const, iv: encodeBase64Url(iv), tagLengthBits: 128 as const },
    aadProfile: "JAGAON_BACKUP_HEADER_V1" as const,
  };
  const key = await crypto.deriveKey(new TextEncoder().encode(passphrase.normalize("NFC")), salt, 600_000);
  const ciphertext = await crypto.encrypt(key, iv, canonicaliseBackupHeaderAad(header), new TextEncoder().encode(payloadText));
  return serialiseBackupContainer({ ...header, ciphertext: encodeBase64Url(ciphertext) });
}
