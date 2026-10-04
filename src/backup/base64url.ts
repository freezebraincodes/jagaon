/**
 * Strict base64url without padding (RFC 4648 Section 5; storage-backup-spec
 * 7.2). Decoding accepts only the canonical form: the alphabet, no padding,
 * no impossible length, and zero unused trailing bits, so every value has one
 * spelling. Lengths can be required exactly.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const LOOKUP = new Map([...ALPHABET].map((char, index) => [char, index]));

export class Base64UrlError extends Error {
  readonly name = "Base64UrlError";
  constructor() {
    super("Invalid base64url");
  }
}

export function encodeBase64Url(bytes: Uint8Array): string {
  let out = "";
  let index = 0;
  for (; index + 2 < bytes.length; index += 3) {
    const n = (bytes[index]! << 16) | (bytes[index + 1]! << 8) | bytes[index + 2]!;
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]! + ALPHABET[n & 63]!;
  }
  const rest = bytes.length - index;
  if (rest === 1) {
    const n = bytes[index]! << 16;
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]!;
  } else if (rest === 2) {
    const n = (bytes[index]! << 16) | (bytes[index + 1]! << 8);
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]!;
  }
  return out;
}

export function decodeBase64Url(text: string, expectedByteLength?: number): Uint8Array {
  if (typeof text !== "string" || text.length % 4 === 1) throw new Base64UrlError();
  const values: number[] = [];
  for (const char of text) {
    const value = LOOKUP.get(char);
    if (value === undefined) throw new Base64UrlError();
    values.push(value);
  }
  const bytes = new Uint8Array(Math.floor((values.length * 6) / 8));
  let buffer = 0;
  let bits = 0;
  let offset = 0;
  for (const value of values) {
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[offset++] = (buffer >> bits) & 0xff;
    }
    buffer &= (1 << bits) - 1;
  }
  // Non-zero unused trailing bits would be a second spelling of the same bytes.
  if (buffer !== 0) throw new Base64UrlError();
  if (expectedByteLength !== undefined && bytes.length !== expectedByteLength) throw new Base64UrlError();
  return bytes;
}
