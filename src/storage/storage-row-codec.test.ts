import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  StorageRowValidationError,
  createStorageRowCodec,
  type StorageRowCodec,
} from "./storage-row-codec";

const fixtureSchema = z
  .object({
    key: z.literal("language"),
    value: z.enum(["en-SG", "zh-SG"]),
  })
  .strict();

type Fixture = z.infer<typeof fixtureSchema>;

const codec: StorageRowCodec<Fixture> = createStorageRowCodec(
  "appPreferences",
  fixtureSchema,
);

describe("createStorageRowCodec", () => {
  it("preserves a valid write value exactly", () => {
    const value = { key: "language", value: "en-SG" } as const;
    expect(codec.validateForWrite(value)).toEqual(value);
  });

  it("preserves a valid stored value exactly after read validation", () => {
    const value = { key: "language", value: "zh-SG" } as const;
    expect(codec.validateAfterRead(value)).toEqual(value);
  });

  it("reports invalid write input as STORAGE_VALIDATION_FAILED", () => {
    expect.assertions(5);
    try {
      codec.validateForWrite({ key: "language", value: "fr-FR" });
    } catch (error) {
      expect(error).toBeInstanceOf(StorageRowValidationError);
      expect(error).toMatchObject({
        code: "STORAGE_VALIDATION_FAILED",
        table: "appPreferences",
        boundary: "WRITE",
      });
      expect((error as Error).message).toBe(
        "Storage row failed validation before write",
      );
      expect("issues" in (error as object)).toBe(false);
      expect("input" in (error as object)).toBe(false);
    }
  });

  it("reports malformed stored input as STORAGE_INTEGRITY_FAILED", () => {
    expect.assertions(5);
    try {
      codec.validateAfterRead({ key: "language", value: "fr-FR" });
    } catch (error) {
      expect(error).toBeInstanceOf(StorageRowValidationError);
      expect(error).toMatchObject({
        code: "STORAGE_INTEGRITY_FAILED",
        table: "appPreferences",
        boundary: "READ",
      });
      expect((error as Error).message).toBe(
        "Stored row failed integrity validation after read",
      );
      expect("issues" in (error as object)).toBe(false);
      expect("input" in (error as object)).toBe(false);
    }
  });

  it("rejects an unknown field at the write boundary", () => {
    expect(() =>
      codec.validateForWrite({
        key: "language",
        value: "en-SG",
        patientText: "must not leak",
      }),
    ).toThrow(StorageRowValidationError);
  });

  it("rejects an unknown field at the read boundary", () => {
    expect(() =>
      codec.validateAfterRead({
        key: "language",
        value: "en-SG",
        extra: true,
      }),
    ).toThrow(StorageRowValidationError);
  });

  it("does not retain rejected input or raw validation details", () => {
    let captured: StorageRowValidationError | undefined;
    try {
      codec.validateAfterRead({
        key: "language",
        value: "SECRET_PATIENT_VALUE",
      });
    } catch (error) {
      captured = error as StorageRowValidationError;
    }

    expect(captured).toBeDefined();
    const serialised = JSON.stringify(captured);
    expect(serialised).not.toContain("SECRET_PATIENT_VALUE");
    expect(serialised).not.toContain("Zod");
    expect(Object.keys(captured ?? {}).sort()).toEqual([
      "boundary",
      "code",
      "name",
      "table",
    ]);
  });
});
