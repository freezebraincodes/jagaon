import { z } from "zod";
import type { CommandName } from "./command-event-names";
import type { CommandEnvelope } from "./command-envelope";

// ---------------------------------------------------------------------------
// Sha256Digest — 64 lowercase hex characters (Section 2.3)
// ---------------------------------------------------------------------------

export type Sha256Digest = string & { readonly __brand: "Sha256Digest" };

const sha256HexRegex = /^[0-9a-f]{64}$/;

export const sha256DigestSchema = z
  .string()
  .regex(sha256HexRegex, "Must be exactly 64 lowercase hexadecimal characters")
  .transform((val) => val as Sha256Digest);

// ---------------------------------------------------------------------------
// Canonical JSON serialisation (Section 2.3)
// ---------------------------------------------------------------------------

/**
 * Deterministically serialise a plain-data value to canonical JSON text.
 *
 * - Object keys are sorted lexicographically by UTF-16 code unit at every depth.
 * - Array order is preserved.
 * - Strings are preserved exactly without trimming or Unicode normalisation.
 * - `null`, booleans, and finite numbers use their JSON representations.
 * - Sparse arrays, non-finite numbers, `undefined`, bigint, symbols, functions,
 *   cyclic structures, symbol-keyed properties, accessor properties,
 *   non-enumerable properties, and non-plain objects are rejected.
 * - `toJSON` and other object-defined conversion behaviour is never invoked.
 */
export function canonicalizeJson(value: unknown): string {
  const strings: string[] = [];
  const seen = new WeakSet<object>();

  serialize(value, strings, seen);

  return strings.join("");
}

function isPlainObject(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

function serialize(
  value: unknown,
  out: string[],
  seen: WeakSet<object>,
): void {
  if (value === null) {
    out.push("null");
    return;
  }

  if (typeof value === "boolean") {
    out.push(value ? "true" : "false");
    return;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new CanonicalJsonError("Non-finite numbers are not permitted");
    }
    out.push(JSON.stringify(value));
    return;
  }

  if (typeof value === "string") {
    out.push(JSON.stringify(value));
    return;
  }

  if (typeof value === "undefined") {
    throw new CanonicalJsonError("undefined is not permitted");
  }

  if (typeof value === "bigint") {
    throw new CanonicalJsonError("bigint is not permitted");
  }

  if (typeof value === "symbol") {
    throw new CanonicalJsonError("symbols are not permitted");
  }

  if (typeof value === "function") {
    throw new CanonicalJsonError("functions are not permitted");
  }

  // From here value is an object.
  const obj = value as Record<string, unknown>;

  if (Array.isArray(value)) {
    const arr = value as unknown[];

    // Require the normal Array.prototype.
    if (Object.getPrototypeOf(arr) !== Array.prototype) {
      throw new CanonicalJsonError(
        "Arrays with a custom prototype are not permitted",
      );
    }

    // Reject every own symbol property, regardless of enumerability.
    const arrSymKeys = Object.getOwnPropertySymbols(arr);
    for (const sk of arrSymKeys) {
      const desc = Object.getOwnPropertyDescriptor(arr, sk);
      if (desc !== undefined) {
        throw new CanonicalJsonError(
          "Symbol-keyed properties are not permitted on arrays",
        );
      }
    }

    // Audit every own string-keyed property. The only non-index property
    // permitted is the built-in non-enumerable `length`. Every index from
    // 0 through length-1 must be an own enumerable data property.
    // A key is a canonical array index only when it is an integer in
    // [0, length) and key === String(index), rejecting numeric-looking
    // aliases such as "01", "1e0", "+1", and "-0".
    const len = arr.length;
    for (const key of Object.getOwnPropertyNames(arr)) {
      if (key === "length") continue;
      const numericIndex = Number(key);
      if (
        !Number.isInteger(numericIndex) ||
        numericIndex < 0 ||
        numericIndex >= len ||
        key !== String(numericIndex)
      ) {
        throw new CanonicalJsonError(
          "Non-index string properties are not permitted on arrays",
        );
      }
      const desc = Object.getOwnPropertyDescriptor(arr, key);
      if (desc === undefined) continue;
      if (!desc.enumerable) {
        throw new CanonicalJsonError(
          "Non-enumerable array elements are not permitted",
        );
      }
      if (desc.get !== undefined || desc.set !== undefined) {
        throw new CanonicalJsonError(
          "Accessor properties are not permitted on arrays",
        );
      }
    }

    // Reject sparse arrays: every index must be an own data property.
    for (let i = 0; i < len; i++) {
      const desc = Object.getOwnPropertyDescriptor(arr, String(i));
      if (desc === undefined) {
        throw new CanonicalJsonError("Sparse arrays are not permitted");
      }
    }

    if (seen.has(arr)) {
      throw new CanonicalJsonError("Cyclic structures are not permitted");
    }
    seen.add(arr);

    out.push("[");
    for (let i = 0; i < len; i++) {
      if (i > 0) out.push(",");
      serialize(arr[i], out, seen);
    }
    out.push("]");

    seen.delete(arr);
    return;
  }

  // Plain object check — reject non-plain objects (Date, Map, class instances,
  // etc.) and objects with a non-Object/null prototype.
  if (!isPlainObject(value)) {
    throw new CanonicalJsonError("Non-plain objects are not permitted");
  }

  if (seen.has(obj)) {
    throw new CanonicalJsonError("Cyclic structures are not permitted");
  }
  seen.add(obj);

  // Collect enumerable own string-keyed properties. Reject symbol keys,
  // accessor properties, and non-enumerable properties.
  const keys: string[] = [];
  for (const key of Object.getOwnPropertyNames(obj)) {
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    if (desc === undefined) continue;
    if (!desc.enumerable) {
      throw new CanonicalJsonError(
        "Non-enumerable properties are not permitted",
      );
    }
    if (desc.get !== undefined || desc.set !== undefined) {
      throw new CanonicalJsonError("Accessor properties are not permitted");
    }
    keys.push(key);
  }

  // Reject every own symbol-keyed property, enumerable or non-enumerable.
  const symKeys = Object.getOwnPropertySymbols(obj);
  for (const sk of symKeys) {
    const desc = Object.getOwnPropertyDescriptor(obj, sk);
    if (desc !== undefined) {
      throw new CanonicalJsonError(
        "Symbol-keyed properties are not permitted",
      );
    }
  }

  // Sort keys lexicographically by UTF-16 code unit.
  keys.sort((a, b) => {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  });

  out.push("{");
  for (let i = 0; i < keys.length; i++) {
    if (i > 0) out.push(",");
    const key = keys[i];
    out.push(JSON.stringify(key));
    out.push(":");
    serialize(obj[key], out, seen);
  }
  out.push("}");

  seen.delete(obj);
}

class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalJsonError";
  }
}

// ---------------------------------------------------------------------------
// SHA-256 hashing via Web Crypto (Section 2.3)
// ---------------------------------------------------------------------------

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Canonicalise the value, UTF-8 encode it, hash it with SHA-256 using
 * the browser-compatible Web Crypto API, and return the digest as a
 * 64-character lowercase hexadecimal `Sha256Digest`.
 */
export async function hashCanonicalJson(
  value: unknown,
): Promise<Sha256Digest> {
  const canonical = canonicalizeJson(value);
  const encoder = new TextEncoder();
  const data = encoder.encode(canonical);
  const hashBuffer = await globalThis.crypto.subtle.digest("SHA-256", data);
  const hashBytes = new Uint8Array(hashBuffer);
  return toHex(hashBytes) as Sha256Digest;
}

/**
 * Hash the complete validated command envelope. The envelope is treated as
 * a plain-data structure and canonicalised before hashing. No fields are
 * omitted or transformed.
 */
export async function hashCommandEnvelope<
  TName extends CommandName,
  TPayload,
>(
  envelope: CommandEnvelope<TName, TPayload>,
): Promise<Sha256Digest> {
  return hashCanonicalJson(envelope);
}
