import { describe, it, expect } from "vitest";
import {
  createBoundedTextSchema,
  countCodePoints,
} from "./text";

describe("countCodePoints", () => {
  it("counts ASCII characters correctly", () => {
    expect(countCodePoints("hello")).toBe(5);
  });

  it("counts Chinese characters by code point, not UTF-16 code units", () => {
    // Each CJK character is one code point but may or may not be a surrogate pair
    expect(countCodePoints("你好世界")).toBe(4);
  });

  it("counts supplementary plane characters correctly", () => {
    // U+1F600 (grinning face emoji) is one code point but two UTF-16 code units
    expect(countCodePoints("😀")).toBe(1);
    expect(countCodePoints("Hello 😀 World")).toBe(13);
  });

  it("counts an empty string as zero", () => {
    expect(countCodePoints("")).toBe(0);
  });
});

describe("createBoundedTextSchema", () => {
  const schema = createBoundedTextSchema(1, 100);

  it("accepts a simple English name within bounds", () => {
    expect(schema.parse("Alice")).toBe("Alice");
  });

  it("accepts Chinese characters within bounds", () => {
    expect(schema.parse("李明")).toBe("李明");
  });

  it("accepts supplementary Unicode characters within bounds", () => {
    expect(schema.parse("😀")).toBe("😀");
  });

  it("accepts the maximum length", () => {
    const max = "a".repeat(100);
    expect(schema.parse(max)).toBe(max);
  });

  it("rejects the empty string when min is 1", () => {
    expect(() => schema.parse("")).toThrow();
  });

  it("rejects exceeding the maximum length", () => {
    expect(() => schema.parse("a".repeat(101))).toThrow();
  });

  it("rejects leading whitespace", () => {
    expect(() => schema.parse(" Alice")).toThrow();
  });

  it("rejects trailing whitespace", () => {
    expect(() => schema.parse("Alice ")).toThrow();
  });

  it("rejects surrounding whitespace", () => {
    expect(() => schema.parse(" Alice ")).toThrow();
  });

  it("accepts internal whitespace", () => {
    expect(schema.parse("Alice Chen")).toBe("Alice Chen");
  });

  it("counts code points, not UTF-16 code units, for length bounds", () => {
    // 50 emoji = 50 code points but 100 UTF-16 code units
    const emoji50 = "😀".repeat(50);
    expect(schema.parse(emoji50)).toBe(emoji50);
    // 51 emoji = 51 code points — exceeds max 100 code points? No, 51 < 100
    const emoji51 = "😀".repeat(51);
    expect(schema.parse(emoji51)).toBe(emoji51);
    // 101 emoji = 101 code points — exceeds max
    const emoji101 = "😀".repeat(101);
    expect(() => schema.parse(emoji101)).toThrow();
  });
});