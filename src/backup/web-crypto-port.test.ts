import { describe, expect, it, vi } from "vitest";
import { createWebCryptoPort } from "./web-crypto-port";

const hex = (value: string) => new Uint8Array(value.match(/../g)!.map((pair) => parseInt(pair, 16)));
const toHex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const utf8 = (text: string) => new TextEncoder().encode(text);

/*
 * Known-answer vectors, each independently confirmed during preparation with
 * OpenSSL (Node `crypto`) and Python `hashlib`:
 * - RFC 7914 Section 11 PBKDF2-HMAC-SHA-256 vectors;
 * - NIST GCM test case 16 (AES-256, 96-bit IV, AAD, 128-bit tag);
 * - the exact JagaOn export profile: PBKDF2-HMAC-SHA-256, 600,000 iterations,
 *   16-byte salt, NFC/UTF-8 passphrase, then AES-256-GCM.
 */
const PROFILE_PASSPHRASE = "correct horse battery staple 晚安 🌙";
const PROFILE_SALT = hex("000102030405060708090a0b0c0d0e0f");
const PROFILE_KEY = "ea4bca6233ce71622e687320249c7f09b69f303f6f03c68ec5bc0d5963bab2a3";
const PROFILE_IV = hex("101112131415161718191a1b");
const PROFILE_AAD = utf8('{"aadProfile":"JAGAON_BACKUP_HEADER_V1"}');
const PROFILE_CIPHERTEXT = "3512856b6670efbfef059d4358d1fc290ba6915d7b98a5d03d2e3f5487e23832bc7a2886";

describe("Web Crypto backup port (BAK-004, BAK-005, BAK-010)", () => {
  const port = createWebCryptoPort();

  it("BAK-004 platform PBKDF2-HMAC-SHA-256 matches the RFC 7914 vectors", async () => {
    const subtle = globalThis.crypto.subtle;
    const derive = async (password: string, salt: string, iterations: number) => {
      const key = await subtle.importKey("raw", utf8(password), "PBKDF2", false, ["deriveBits"]);
      return toHex(new Uint8Array(await subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: utf8(salt), iterations }, key, 512)));
    };
    expect(await derive("passwd", "salt", 1)).toBe("55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc49ca9cccf179b645991664b39d77ef317c71b845b1e30bd509112041d3a19783");
    expect(await derive("Password", "NaCl", 80000)).toBe("4ddcd8f60b98be21830cee5ef22701f9641a4418d04c0414aeff08876b34ab56a1d425a1225833549adb841b51c9b3176a272bdebba1d078478f62b397f33c8d");
  });

  it("BAK-004 the exact 600,000-iteration profile derives a non-extractable AES-256-GCM key matching the independent vector", async () => {
    const key = await port.deriveKey(utf8(PROFILE_PASSPHRASE.normalize("NFC")), PROFILE_SALT, 600_000);
    expect(key.extractable).toBe(false);
    expect(key.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
    expect([...key.usages].sort()).toEqual(["decrypt", "encrypt"]);
    await expect(globalThis.crypto.subtle.exportKey("raw", key)).rejects.toBeTruthy();
    const ciphertext = await port.encrypt(key, PROFILE_IV, PROFILE_AAD, utf8("JagaOn synthetic KAT"));
    expect(toHex(ciphertext)).toBe(PROFILE_CIPHERTEXT);
    // The same encryption under the independently derived raw key agrees.
    const raw = await globalThis.crypto.subtle.importKey("raw", hex(PROFILE_KEY), "AES-GCM", false, ["encrypt"]);
    expect(toHex(new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: "AES-GCM", iv: PROFILE_IV, additionalData: PROFILE_AAD, tagLength: 128 }, raw, utf8("JagaOn synthetic KAT"))))).toBe(PROFILE_CIPHERTEXT);
    expect(new TextDecoder().decode(await port.decrypt(key, PROFILE_IV, PROFILE_AAD, hex(PROFILE_CIPHERTEXT)))).toBe("JagaOn synthetic KAT");
  });

  it("BAK-005 AES-256-GCM matches NIST test case 16 and rejects any tag, AAD or ciphertext change", async () => {
    const key = await globalThis.crypto.subtle.importKey("raw", hex("feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308"), "AES-GCM", false, ["encrypt", "decrypt"]);
    const iv = hex("cafebabefacedbaddecaf888");
    const aad = hex("feedfacedeadbeeffeedfacedeadbeefabaddad2");
    const plaintext = hex("d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39");
    const expected = "522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662" + "76fc6ece0f4e1768cddf8853bb2d551b";
    const ciphertext = await port.encrypt(key, iv, aad, plaintext);
    expect(toHex(ciphertext)).toBe(expected);
    expect(toHex(await port.decrypt(key, iv, aad, ciphertext))).toBe(toHex(plaintext));
    const flipped = ciphertext.slice();
    flipped[flipped.length - 1]! ^= 1;
    await expect(port.decrypt(key, iv, aad, flipped)).rejects.toBeTruthy();
    const badAad = aad.slice();
    badAad[0]! ^= 1;
    await expect(port.decrypt(key, iv, badAad, ciphertext)).rejects.toBeTruthy();
    await expect(port.decrypt(key, iv, aad, ciphertext.slice(0, -1))).rejects.toBeTruthy();
  });

  it("BAK-010 rejects iterations outside 600,000–2,000,000 before any derivation", async () => {
    const importKey = vi.spyOn(globalThis.crypto.subtle, "importKey");
    for (const iterations of [599_999, 2_000_001, 1.5e6 + 0.5, 0]) {
      await expect(port.deriveKey(utf8("correct horse battery"), PROFILE_SALT, iterations)).rejects.toMatchObject({ code: "BACKUP_KDF_UNSUPPORTED" });
    }
    expect(importKey).not.toHaveBeenCalled();
    importKey.mockRestore();
  });

  it("generates fresh random salt, IV and container identity from the platform", () => {
    const a = port.randomBytes(16);
    const b = port.randomBytes(16);
    expect(a).toHaveLength(16);
    expect(toHex(a)).not.toBe(toHex(b));
  });

  it("requires a secure context and native Web Crypto, with no fallback", () => {
    expect(() => createWebCryptoPort({ crypto: globalThis.crypto, isSecureContext: false })).toThrow(expect.objectContaining({ code: "SECURE_CONTEXT_REQUIRED" }));
    expect(() => createWebCryptoPort({ crypto: { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) } as never })).toThrow(
      expect.objectContaining({ code: "BACKUP_CRYPTO_UNAVAILABLE" }),
    );
  });
});
