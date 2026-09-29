import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  createTypedRevisionRefSchema,
  type TypedRevisionRef,
} from "./typed-revision-ref";
import type { RecordType } from "./record-catalogue";

const VALID_UUID = "a47ac10b-58cc-4372-a567-0e02b2c3d479";

describe("createTypedRevisionRefSchema", () => {
  const safetyEventRefSchema = createTypedRevisionRefSchema(
    z.literal("SAFETY_EVENT"),
  );
  const prescriptionVersionRefSchema = createTypedRevisionRefSchema(
    z.literal("PRESCRIPTION_VERSION"),
  );

  it("accepts a valid SAFETY_EVENT revision reference", () => {
    const result = safetyEventRefSchema.parse({
      recordType: "SAFETY_EVENT",
      recordId: VALID_UUID,
      revisionId: VALID_UUID,
    });
    expect(result.recordType).toBe("SAFETY_EVENT");
    expect(result.recordId).toBe(VALID_UUID);
    expect(result.revisionId).toBe(VALID_UUID);
  });

  it("accepts a valid PRESCRIPTION_VERSION revision reference", () => {
    const result = prescriptionVersionRefSchema.parse({
      recordType: "PRESCRIPTION_VERSION",
      recordId: VALID_UUID,
      revisionId: VALID_UUID,
    });
    expect(result.recordType).toBe("PRESCRIPTION_VERSION");
  });

  it("enforces exact record type — rejects PRESCRIPTION_VERSION from a SAFETY_EVENT schema", () => {
    expect(() =>
      safetyEventRefSchema.parse({
        recordType: "PRESCRIPTION_VERSION",
        recordId: VALID_UUID,
        revisionId: VALID_UUID,
      }),
    ).toThrow();
  });

  it("enforces exact record type — rejects SAFETY_EVENT from a PRESCRIPTION_VERSION schema", () => {
    expect(() =>
      prescriptionVersionRefSchema.parse({
        recordType: "SAFETY_EVENT",
        recordId: VALID_UUID,
        revisionId: VALID_UUID,
      }),
    ).toThrow();
  });

  it("rejects an unsupported record type", () => {
    expect(() =>
      safetyEventRefSchema.parse({
        recordType: "GLUCOSE_READING",
        recordId: VALID_UUID,
        revisionId: VALID_UUID,
      }),
    ).toThrow();
  });

  it("rejects a malformed recordId", () => {
    expect(() =>
      safetyEventRefSchema.parse({
        recordType: "SAFETY_EVENT",
        recordId: "not-a-uuid",
        revisionId: VALID_UUID,
      }),
    ).toThrow();
  });

  it("rejects a malformed revisionId", () => {
    expect(() =>
      safetyEventRefSchema.parse({
        recordType: "SAFETY_EVENT",
        recordId: VALID_UUID,
        revisionId: "not-a-uuid",
      }),
    ).toThrow();
  });

  it("rejects a missing recordType", () => {
    expect(() =>
      safetyEventRefSchema.parse({
        recordId: VALID_UUID,
        revisionId: VALID_UUID,
      }),
    ).toThrow();
  });

  it("rejects a missing recordId", () => {
    expect(() =>
      safetyEventRefSchema.parse({
        recordType: "SAFETY_EVENT",
        revisionId: VALID_UUID,
      }),
    ).toThrow();
  });

  it("rejects a missing revisionId", () => {
    expect(() =>
      safetyEventRefSchema.parse({
        recordType: "SAFETY_EVENT",
        recordId: VALID_UUID,
      }),
    ).toThrow();
  });

  it("rejects unknown keys", () => {
    expect(() =>
      safetyEventRefSchema.parse({
        recordType: "SAFETY_EVENT",
        recordId: VALID_UUID,
      }),
    ).toThrow();
  });

  it("rejects unknown keys when present", () => {
    expect(() =>
      safetyEventRefSchema.parse({
        recordType: "SAFETY_EVENT",
        recordId: VALID_UUID,
        revisionId: VALID_UUID,
        extra: true,
      }),
    ).toThrow();
  });

  it("rejects bare record IDs (string only)", () => {
    expect(() => safetyEventRefSchema.parse(VALID_UUID)).toThrow();
  });
});

describe("TypedRevisionRef type", () => {
  it("compiles with a specific RecordType literal", () => {
    const ref: TypedRevisionRef<"SAFETY_EVENT"> = {
      recordType: "SAFETY_EVENT",
      recordId: VALID_UUID as never,
      revisionId: VALID_UUID as never,
    };
    expect(ref.recordType).toBe("SAFETY_EVENT");
  });

  it("rejects a mismatched record type at compile time", () => {
    const _bad: TypedRevisionRef<"SAFETY_EVENT"> = {
      // @ts-expect-error — recordType must match the generic parameter
      recordType: "PRESCRIPTION_VERSION",
      recordId: VALID_UUID as never,
      revisionId: VALID_UUID as never,
    };
  });

  it("rejects a non-RecordType literal at compile time", () => {
    // @ts-expect-error — "NOT_A_RECORD" is not an approved RecordType
    const _bad = createTypedRevisionRefSchema(z.literal("NOT_A_RECORD"));
  });
});