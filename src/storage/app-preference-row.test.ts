import { describe, it, expect } from "vitest";
import {
  appPreferenceRowSchema,
  createKeepWordingPreferenceRow,
  createLanguagePreferenceRow,
  KEEP_WORDING_PREFERENCE_KEY,
  KEEP_WORDING_PREFERENCE_SCHEMA_VERSION,
  type AppPreferenceRow,
} from "./app-preference-row";
import { type Instant, instantSchema } from "@/domain/shared/time";

// Use the production instant schema for branded instant values.
function makeInstant(iso: string): Instant {
  return instantSchema.parse(iso);
}

describe("createLanguagePreferenceRow", () => {
  it("preserves the en-SG locale and a valid instant exactly", () => {
    const at = makeInstant("2026-09-30T10:00:00Z");
    const row = createLanguagePreferenceRow("en-SG", at);
    expect(row).toEqual({
      key: "language",
      value: "en-SG",
      updatedAt: "2026-09-30T10:00:00Z",
    });
  });

  it("preserves the zh-SG locale and a valid instant exactly", () => {
    const at = makeInstant("2026-09-30T10:00:00Z");
    const row = createLanguagePreferenceRow("zh-SG", at);
    expect(row).toEqual({
      key: "language",
      value: "zh-SG",
      updatedAt: "2026-09-30T10:00:00Z",
    });
  });

  it("produces a row that round-trips through appPreferenceRowSchema", () => {
    const at = makeInstant("2026-09-30T10:00:00Z");
    const row = createLanguagePreferenceRow("en-SG", at);
    const parsed = appPreferenceRowSchema.parse(row);
    expect(parsed).toEqual(row);
  });

  it("does not coerce, trim, or normalise the value", () => {
    const at = makeInstant("2026-09-30T10:00:00Z");
    const row = createLanguagePreferenceRow("zh-SG", at);
    // Exact referential equality for the value, not a normalised copy.
    expect(row.value).toBe("zh-SG");
  });
});

describe("appPreferenceRowSchema acceptance", () => {
  it("accepts a language row with en-SG", () => {
    const result = appPreferenceRowSchema.safeParse({
      key: "language",
      value: "en-SG",
      updatedAt: "2026-09-30T10:00:00Z",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a language row with zh-SG", () => {
    const result = appPreferenceRowSchema.safeParse({
      key: "language",
      value: "zh-SG",
      updatedAt: "2026-09-30T10:00:00Z",
    });
    expect(result.success).toBe(true);
  });
});

describe("appPreferenceRowSchema rejection", () => {
  it("rejects an arbitrary key", () => {
    const result = appPreferenceRowSchema.safeParse({
      key: "theme",
      value: "en-SG",
      updatedAt: "2026-09-30T10:00:00Z",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unsupported locale", () => {
    const result = appPreferenceRowSchema.safeParse({
      key: "language",
      value: "fr-FR",
      updatedAt: "2026-09-30T10:00:00Z",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a malformed instant", () => {
    const result = appPreferenceRowSchema.safeParse({
      key: "language",
      value: "en-SG",
      updatedAt: "2026-09-30 10:00:00",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing field (no key)", () => {
    const result = appPreferenceRowSchema.safeParse({
      value: "en-SG",
      updatedAt: "2026-09-30T10:00:00Z",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing field (no value)", () => {
    const result = appPreferenceRowSchema.safeParse({
      key: "language",
      updatedAt: "2026-09-30T10:00:00Z",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing field (no updatedAt)", () => {
    const result = appPreferenceRowSchema.safeParse({
      key: "language",
      value: "en-SG",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown field", () => {
    const result = appPreferenceRowSchema.safeParse({
      key: "language",
      value: "en-SG",
      updatedAt: "2026-09-30T10:00:00Z",
      extra: true,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-string key", () => {
    const result = appPreferenceRowSchema.safeParse({
      key: 42,
      value: "en-SG",
      updatedAt: "2026-09-30T10:00:00Z",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-string value", () => {
    const result = appPreferenceRowSchema.safeParse({
      key: "language",
      value: 1,
      updatedAt: "2026-09-30T10:00:00Z",
    });
    expect(result.success).toBe(false);
  });
});

/**
 * Packet 11C Addendum C, Task C2 (hybrid spec D11): the patient's "Keep wording on this device" setting is one more closed key of the
 * same settings row. The new row names its own version (the C5 pattern); the existing language row is unchanged and still valid.
 */
describe("keepWordingOnDevice preference row (Packet 11C C2)", () => {
  const at = "2026-10-08T01:00:00.000Z";
  it("creates and accepts the versioned row for on and off, exactly", () => {
    for (const value of [true, false]) {
      const row = createKeepWordingPreferenceRow(value, makeInstant(at));
      expect(row).toEqual({ key: "keepWordingOnDevice", preferenceSchemaVersion: "app-preference.keep-wording.11c.1", value, updatedAt: at });
      expect(appPreferenceRowSchema.parse(row)).toEqual(row);
    }
    expect(KEEP_WORDING_PREFERENCE_KEY).toBe("keepWordingOnDevice");
    expect(KEEP_WORDING_PREFERENCE_SCHEMA_VERSION).toBe("app-preference.keep-wording.11c.1");
  });
  it("still accepts the unversioned language row exactly as before", () => {
    expect(appPreferenceRowSchema.safeParse({ key: "language", value: "zh-SG", updatedAt: at }).success).toBe(true);
    expect(appPreferenceRowSchema.safeParse({ key: "language", preferenceSchemaVersion: "app-preference.keep-wording.11c.1", value: "zh-SG", updatedAt: at }).success).toBe(false);
  });
  it("rejects a missing or unknown version, a non-boolean value, a missing field and an unknown field", () => {
    const base = { key: "keepWordingOnDevice", preferenceSchemaVersion: "app-preference.keep-wording.11c.1", value: true, updatedAt: at };
    for (const bad of [
      { ...base, preferenceSchemaVersion: undefined },
      { ...base, preferenceSchemaVersion: "app-preference.keep-wording.11c.2" },
      { ...base, value: "true" },
      { ...base, value: 1 },
      { ...base, value: "en-SG" },
      { key: base.key, preferenceSchemaVersion: base.preferenceSchemaVersion, updatedAt: at },
      { ...base, updatedAt: "2026-10-08 01:00" },
      { ...base, extra: true },
    ]) {
      expect(appPreferenceRowSchema.safeParse(JSON.parse(JSON.stringify(bad))).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

// Compile-time proof: the type is the exact closed shape specified.
describe("AppPreferenceRow type contract", () => {
  it("has exactly key, value, and updatedAt fields", () => {
    const row: AppPreferenceRow = {
      key: "language",
      value: "en-SG",
      updatedAt: "2026-09-30T10:00:00Z" as Instant,
    };
    expect(Object.keys(row).sort()).toEqual(["key", "updatedAt", "value"]);
  });
});
