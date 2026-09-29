import { describe, it, expect } from "vitest";
import {
  SUPPORTED_LOCALES,
  supportedLocaleSchema,
  type SupportedLocale,
} from "./locale";

describe("SUPPORTED_LOCALES", () => {
  it("contains exactly en-SG and zh-SG", () => {
    expect(SUPPORTED_LOCALES).toEqual(["en-SG", "zh-SG"]);
    expect(SUPPORTED_LOCALES).toHaveLength(2);
  });
});

describe("supportedLocaleSchema", () => {
  it("accepts en-SG", () => {
    expect(supportedLocaleSchema.parse("en-SG")).toBe("en-SG");
  });

  it("accepts zh-SG", () => {
    expect(supportedLocaleSchema.parse("zh-SG")).toBe("zh-SG");
  });

  it("rejects en-US", () => {
    expect(() => supportedLocaleSchema.parse("en-US")).toThrow();
  });

  it("rejects zh-CN", () => {
    expect(() => supportedLocaleSchema.parse("zh-CN")).toThrow();
  });

  it("rejects a completely unknown locale", () => {
    expect(() => supportedLocaleSchema.parse("ja-JP")).toThrow();
  });

  it("rejects an empty string", () => {
    expect(() => supportedLocaleSchema.parse("")).toThrow();
  });

  it("typed return is SupportedLocale", () => {
    const locale: SupportedLocale = supportedLocaleSchema.parse("en-SG");
    expect(locale).toBe("en-SG");
  });
});