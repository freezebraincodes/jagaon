import { z } from "zod";
import { canonicalizeJson } from "@/application/contracts/canonical-json";
import { Base64UrlError, decodeBase64Url } from "./base64url";
import { BACKUP_CONTAINER_ID_BYTES, BACKUP_IV_BYTES, BACKUP_KDF_MAX_ITERATIONS, BACKUP_KDF_MIN_ITERATIONS, BACKUP_SALT_BYTES } from "./web-crypto-port";

/**
 * Locked version 1 encrypted container (storage-backup-spec 7.2). The file is
 * the canonical UTF-8 JSON of this exact closed object. The authenticated
 * additional data is the canonical UTF-8 JSON of every top-level field except
 * `ciphertext` (`JAGAON_BACKUP_HEADER_V1`). The clear header carries no
 * dataset identity, time, count, locale or other patient-derived meaning.
 */

export const BACKUP_CONTAINER_FORMAT = "jagaon-encrypted-backup" as const;
export const BACKUP_AAD_PROFILE = "JAGAON_BACKUP_HEADER_V1" as const;
/** Container version 1 resource bounds (spec 7.5). */
export const MAX_BACKUP_PLAINTEXT_BYTES = 32 * 1024 * 1024;
export const MAX_BACKUP_ENCODED_BYTES = 48 * 1024 * 1024;
/** AES-GCM appends a 128-bit tag. */
const TAG_BYTES = 16;

export type EncryptedBackupContainerV1 = {
  format: typeof BACKUP_CONTAINER_FORMAT;
  containerVersion: 1;
  containerId: string;
  encoding: "BASE64URL_NO_PADDING";
  passphraseEncoding: "UTF-8-NFC";
  kdf: { algorithm: "PBKDF2"; hash: "SHA-256"; iterations: number; salt: string };
  cipher: { algorithm: "AES-GCM"; keyLengthBits: 256; iv: string; tagLengthBits: 128 };
  aadProfile: typeof BACKUP_AAD_PROFILE;
  ciphertext: string;
};

function binary(byteLength: number | null) {
  return z.string().superRefine((value, ctx) => {
    try {
      const bytes = decodeBase64Url(value);
      if (byteLength === null ? bytes.length < TAG_BYTES : bytes.length !== byteLength) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "BINARY_LENGTH" });
      }
    } catch (error) {
      if (!(error instanceof Base64UrlError)) throw error;
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "BASE64URL" });
    }
  });
}

export const encryptedBackupContainerV1Schema = z.strictObject({
  format: z.literal(BACKUP_CONTAINER_FORMAT),
  containerVersion: z.literal(1),
  containerId: binary(BACKUP_CONTAINER_ID_BYTES),
  encoding: z.literal("BASE64URL_NO_PADDING"),
  passphraseEncoding: z.literal("UTF-8-NFC"),
  kdf: z.strictObject({
    algorithm: z.literal("PBKDF2"),
    hash: z.literal("SHA-256"),
    iterations: z.number().int().min(BACKUP_KDF_MIN_ITERATIONS).max(BACKUP_KDF_MAX_ITERATIONS),
    salt: binary(BACKUP_SALT_BYTES),
  }),
  cipher: z.strictObject({
    algorithm: z.literal("AES-GCM"),
    keyLengthBits: z.literal(256),
    iv: binary(BACKUP_IV_BYTES),
    tagLengthBits: z.literal(128),
  }),
  aadProfile: z.literal(BACKUP_AAD_PROFILE),
  ciphertext: binary(null),
});

const utf8 = (text: string) => new TextEncoder().encode(text);

/** `JAGAON_BACKUP_HEADER_V1`: canonical bytes of every field except the ciphertext. */
export function canonicaliseBackupHeaderAad(container: Omit<EncryptedBackupContainerV1, "ciphertext"> | EncryptedBackupContainerV1): Uint8Array {
  const header: Record<string, unknown> = { ...container };
  delete header.ciphertext;
  return utf8(canonicalizeJson(header));
}

/** The exact file bytes: canonical UTF-8 JSON of the closed container. */
export function serialiseBackupContainer(container: EncryptedBackupContainerV1): Uint8Array {
  return utf8(canonicalizeJson(encryptedBackupContainerV1Schema.parse(container)));
}
