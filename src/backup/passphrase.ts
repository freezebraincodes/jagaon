/**
 * Version 1 backup passphrase profile (storage-backup-spec 7.3). The
 * passphrase is normalised to NFC and encoded as UTF-8; it must contain 12 to
 * 128 Unicode code points after normalisation; every character, including
 * spaces, is significant; ill-formed Unicode is rejected rather than replaced.
 * Nothing here stores, logs or derives a verifier from the value.
 */

export const PASSPHRASE_MIN_CODE_POINTS = 12;
export const PASSPHRASE_MAX_CODE_POINTS = 128;

export type PassphraseProblem = "INVALID_UNICODE" | "TOO_SHORT" | "TOO_LONG";
export type NormalisedPassphrase = { ok: true; bytes: Uint8Array } | { ok: false; problem: PassphraseProblem };

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export function normaliseBackupPassphrase(input: string): NormalisedPassphrase {
  if (typeof input !== "string" || LONE_SURROGATE.test(input)) return { ok: false, problem: "INVALID_UNICODE" };
  const normalised = input.normalize("NFC");
  const codePoints = [...normalised].length;
  if (codePoints < PASSPHRASE_MIN_CODE_POINTS) return { ok: false, problem: "TOO_SHORT" };
  if (codePoints > PASSPHRASE_MAX_CODE_POINTS) return { ok: false, problem: "TOO_LONG" };
  return { ok: true, bytes: new TextEncoder().encode(normalised) };
}

export type ConfirmedPassphrase = NormalisedPassphrase | { ok: false; problem: "MISMATCH" };

/** Both entries must normalise to exactly the same value. */
export function validateConfirmedPassphrase(first: string, second: string): ConfirmedPassphrase {
  const a = normaliseBackupPassphrase(first);
  if (!a.ok) return a;
  if (typeof second !== "string" || LONE_SURROGATE.test(second) || first.normalize("NFC") !== second.normalize("NFC")) return { ok: false, problem: "MISMATCH" };
  return a;
}
