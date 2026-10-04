import { describe, expect, it } from "vitest";
import { normaliseBackupPassphrase, validateConfirmedPassphrase } from "./passphrase";

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("backup passphrase profile (BAK-009)", () => {
  it("counts 12 to 128 Unicode code points after NFC, including Chinese and emoji", () => {
    expect(normaliseBackupPassphrase("12345678901")).toEqual({ ok: false, problem: "TOO_SHORT" });
    expect(normaliseBackupPassphrase("123456789012").ok).toBe(true);
    expect(normaliseBackupPassphrase("晚安晚安晚安晚安晚安晚安").ok).toBe(true);
    expect(normaliseBackupPassphrase("🌙".repeat(12)).ok).toBe(true); // 12 code points, 24 UTF-16 units
    expect(normaliseBackupPassphrase("🌙".repeat(11)).ok).toBe(false);
    expect(normaliseBackupPassphrase("a".repeat(128)).ok).toBe(true);
    expect(normaliseBackupPassphrase("a".repeat(129))).toEqual({ ok: false, problem: "TOO_LONG" });
  });

  it("normalises to NFC and encodes UTF-8 without trimming, case folding or replacement", () => {
    const decomposed = "café au lait ok";
    const composed = "café au lait ok";
    const result = normaliseBackupPassphrase(decomposed);
    if (!result.ok) throw new Error("expected ok");
    expect(decode(result.bytes)).toBe(composed);
    const spaced = normaliseBackupPassphrase("  Spaces Matter  ");
    if (!spaced.ok) throw new Error("expected ok");
    expect(decode(spaced.bytes)).toBe("  Spaces Matter  ");
  });

  it("rejects unpaired surrogates instead of encoding a replacement character", () => {
    expect(normaliseBackupPassphrase("abcdefghijk\uD83D")).toEqual({ ok: false, problem: "INVALID_UNICODE" });
    expect(normaliseBackupPassphrase("\uDE19abcdefghijkl")).toEqual({ ok: false, problem: "INVALID_UNICODE" });
  });

  it("requires the exact same normalised value twice; spaces and case are significant", () => {
    expect(validateConfirmedPassphrase("correct horse battery", "correct horse battery").ok).toBe(true);
    expect(validateConfirmedPassphrase("café au lait ok", "café au lait ok").ok).toBe(true);
    expect(validateConfirmedPassphrase("correct horse battery", "correct horse battery ")).toEqual({ ok: false, problem: "MISMATCH" });
    expect(validateConfirmedPassphrase("correct horse battery", "Correct horse battery")).toEqual({ ok: false, problem: "MISMATCH" });
    expect(validateConfirmedPassphrase("short", "short")).toEqual({ ok: false, problem: "TOO_SHORT" });
  });
});
