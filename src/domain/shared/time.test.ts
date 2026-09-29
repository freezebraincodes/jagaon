import { describe, it, expect } from "vitest";
import {
  instantSchema,
  localDateSchema,
  isValidIanaTimeZoneId,
  compareInstants,
  instantBefore,
  instantEqual,
  type Instant,
} from "./time";

describe("instantSchema", () => {
  it("accepts a valid UTC Z instant", () => {
    const value = "2026-09-27T10:30:00Z";
    expect(instantSchema.parse(value)).toBe(value);
  });

  it("accepts fractional seconds", () => {
    const value = "2026-09-27T10:30:00.123Z";
    expect(instantSchema.parse(value)).toBe(value);
  });

  it("rejects local time without offset", () => {
    expect(() => instantSchema.parse("2026-09-27T10:30:00")).toThrow();
  });

  it("rejects a numeric offset", () => {
    expect(() => instantSchema.parse("2026-09-27T10:30:00+08:00")).toThrow();
  });

  it("rejects an impossible calendar date", () => {
    expect(() => instantSchema.parse("2026-02-30T10:30:00Z")).toThrow();
  });

  it("rejects a lossy non-canonical value", () => {
    // Missing Z suffix — not a valid UTC instant
    expect(() => instantSchema.parse("2026-09-27T10:30:00.000")).toThrow();
  });

  it("rejects an empty string", () => {
    expect(() => instantSchema.parse("")).toThrow();
  });

  it("brands the output as Instant", () => {
    const parsed: Instant = instantSchema.parse("2026-09-27T10:30:00Z");
    expect(parsed).toBe("2026-09-27T10:30:00Z");
  });
});

describe("localDateSchema", () => {
  it("accepts a real YYYY-MM-DD calendar date", () => {
    const value = "2026-09-27";
    expect(localDateSchema.parse(value)).toBe(value);
  });

  it("rejects an impossible date", () => {
    expect(() => localDateSchema.parse("2026-02-30")).toThrow();
  });

  it("rejects a non-padded month", () => {
    expect(() => localDateSchema.parse("2026-9-27")).toThrow();
  });

  it("rejects a non-padded day", () => {
    expect(() => localDateSchema.parse("2026-09-7")).toThrow();
  });

  it("rejects an empty string", () => {
    expect(() => localDateSchema.parse("")).toThrow();
  });
});

describe("isValidIanaTimeZoneId", () => {
  it("accepts a known IANA zone", () => {
    expect(isValidIanaTimeZoneId("Asia/Singapore")).toBe(true);
  });

  it("accepts another known IANA zone", () => {
    expect(isValidIanaTimeZoneId("America/New_York")).toBe(true);
  });

  it("accepts UTC", () => {
    expect(isValidIanaTimeZoneId("UTC")).toBe(true);
  });

  it("rejects a non-existent zone", () => {
    expect(isValidIanaTimeZoneId("Fake/Zone")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isValidIanaTimeZoneId("")).toBe(false);
  });

  it("rejects a non-IANA format", () => {
    expect(isValidIanaTimeZoneId("SGT")).toBe(false);
  });
});

describe("compareInstants", () => {
  it("compares whole-second against same second with fractional part", () => {
    const whole = "2026-09-27T10:00:00Z" as Instant;
    const frac = "2026-09-27T10:00:00.5Z" as Instant;
    expect(compareInstants(whole, frac)).toBeLessThan(0);
    expect(compareInstants(frac, whole)).toBeGreaterThan(0);
  });

  it("correctly compares .09Z against .1Z (0.09 < 0.1)", () => {
    const a = "2026-09-27T10:00:00.09Z" as Instant;
    const b = "2026-09-27T10:00:00.1Z" as Instant;
    expect(compareInstants(a, b)).toBeLessThan(0);
    expect(compareInstants(b, a)).toBeGreaterThan(0);
  });

  it("returns 0 for equal instants", () => {
    const a = "2026-09-27T10:00:00.123Z" as Instant;
    const b = "2026-09-27T10:00:00.123Z" as Instant;
    expect(compareInstants(a, b)).toBe(0);
    expect(instantEqual(a, b)).toBe(true);
  });

  it("returns 0 for equal whole-second instants", () => {
    const a = "2026-09-27T10:00:00Z" as Instant;
    const b = "2026-09-27T10:00:00Z" as Instant;
    expect(compareInstants(a, b)).toBe(0);
  });

  it("compares correctly ordered instants", () => {
    const a = "2026-09-27T10:00:00Z" as Instant;
    const b = "2026-09-27T11:00:00Z" as Instant;
    expect(instantBefore(a, b)).toBe(true);
  });

  it("compares reversed instants", () => {
    const a = "2026-09-27T11:00:00Z" as Instant;
    const b = "2026-09-27T10:00:00Z" as Instant;
    expect(instantBefore(a, b)).toBe(false);
  });

  it("treats trailing-zero differences as equal (.5Z vs .500Z)", () => {
    const a = "2026-09-27T10:00:00.5Z" as Instant;
    const b = "2026-09-27T10:00:00.500Z" as Instant;
    expect(compareInstants(a, b)).toBe(0);
  });
});