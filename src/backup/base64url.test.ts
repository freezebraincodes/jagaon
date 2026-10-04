import { describe, expect, it } from "vitest";
import { Base64UrlError, decodeBase64Url, encodeBase64Url } from "./base64url";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("strict base64url without padding", () => {
  it("matches the RFC 4648 test vectors in the URL-safe alphabet without padding", () => {
    const vectors: Array<[string, string]> = [["", ""], ["f", "Zg"], ["fo", "Zm8"], ["foo", "Zm9v"], ["foob", "Zm9vYg"], ["fooba", "Zm9vYmE"], ["foobar", "Zm9vYmFy"]];
    for (const [plain, encoded] of vectors) {
      expect(encodeBase64Url(bytes(plain))).toBe(encoded);
      expect(new TextDecoder().decode(decodeBase64Url(encoded))).toBe(plain);
    }
    expect(encodeBase64Url(new Uint8Array([0xfb, 0xff]))).toBe("-_8");
    expect([...decodeBase64Url("-_8")]).toEqual([0xfb, 0xff]);
  });

  it("rejects padding, the standard alphabet, impossible lengths and non-canonical trailing bits", () => {
    for (const value of ["Zg==", "Zm8=", "+/8", "Z", "Zm9vY", "Zh", "Zm9", "Zm 9v", "Zm9v\n"]) {
      expect(() => decodeBase64Url(value), value).toThrow(Base64UrlError);
    }
  });

  it("enforces an exact decoded length when required", () => {
    const sixteen = encodeBase64Url(new Uint8Array(16).fill(7));
    expect(decodeBase64Url(sixteen, 16)).toHaveLength(16);
    expect(() => decodeBase64Url(sixteen, 12)).toThrow(Base64UrlError);
  });
});
