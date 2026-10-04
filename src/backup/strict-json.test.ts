import { describe, expect, it } from "vitest";
import { decodeStrictUtf8, parseStrictJson, StrictJsonError, toPlainData } from "./strict-json";

const limits = { maxDepth: 8, maxLength: 10_000 };
const reason = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return (error as StrictJsonError).reason;
  }
  return "OK";
};

describe("bounded strict JSON (RST-007, SEC-003)", () => {
  it("parses plain data and keeps __proto__ as an ordinary key", () => {
    const value = toPlainData(parseStrictJson('{"a":[1,-2.5e3,true,null,"x\\u00e9"],"__proto__":{"polluted":1}}', limits)) as Record<string, unknown>;
    expect(value.a).toEqual([1, -2500, true, null, "xé"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(value)).toEqual(["a", "__proto__"]);
  });

  it("rejects duplicate keys, excessive depth, oversize input and every non-JSON form", () => {
    expect(reason(() => parseStrictJson('{"a":1,"a":2}', limits))).toBe("DUPLICATE_KEY");
    expect(reason(() => parseStrictJson("[".repeat(10) + "]".repeat(10), limits))).toBe("TOO_DEEP");
    expect(reason(() => parseStrictJson(`"${"a".repeat(10_000)}"`, limits))).toBe("TOO_LARGE");
    for (const text of ["{a:1}", "[1,]", "{'a':1}", "01", "NaN", "1e999", '"\\x41"', '"tab\there"', "[1] x", "", "undefined", "+1"]) {
      expect(reason(() => parseStrictJson(text, limits)), text).toBe("SYNTAX");
    }
  });

  it("rejects ill-formed UTF-8 instead of replacing it", () => {
    expect(reason(() => decodeStrictUtf8(new Uint8Array([0x7b, 0xff, 0x7d])))).toBe("INVALID_UTF8");
    expect(decodeStrictUtf8(new TextEncoder().encode("晚安"))).toBe("晚安");
  });
});
