import { describe, expect, it } from "vitest";
import { createClosedRowCodecRegistry, createUnionRowCodec, emptyInProfileRowCodec, EMPTY_IN_PROFILE_TABLES, STORAGE_OWNED_CLOSED_CODECS } from "./closed-row-codecs";
import { StorageRowValidationError, type StorageRowCodec } from "./storage-row-codec";
import { storageMetadataRowCodec } from "./storage-metadata";
import { acceptedCareAuditRowFixture, currentAuditRowFixture, deterministicAuditRowFixture } from "@/domain/ai/ai-test-fixtures";

const accepts = (tag: string): StorageRowCodec<unknown> => ({
  validateForWrite(value) {
    if ((value as { tag?: string }).tag !== tag) throw new Error("no");
    return value;
  },
  validateAfterRead(value) {
    if ((value as { tag?: string }).tag !== tag) throw new Error("no");
    return value;
  },
});

function failure(fn: () => unknown): StorageRowValidationError {
  try {
    fn();
  } catch (error) {
    if (error instanceof StorageRowValidationError) return error;
    throw error;
  }
  throw new Error("expected rejection");
}

describe("closed row-codec registry", () => {
  it("rejects every row in tables that are empty in the profile", () => {
    for (const table of EMPTY_IN_PROFILE_TABLES) {
      const codec = STORAGE_OWNED_CLOSED_CODECS[table];
      expect(failure(() => codec.validateForWrite({})).code).toBe("STORAGE_VALIDATION_FAILED");
      const read = failure(() => codec.validateAfterRead({ requestId: "x" }));
      expect(read.code).toBe("STORAGE_INTEGRITY_FAILED");
      expect(read.table).toBe(table);
    }
  });

  it("keeps exactly the three runtime-governance tables empty in the profile (Packet 11A)", () => {
    expect(EMPTY_IN_PROFILE_TABLES).toEqual(["runtimeManifests", "governedAssets", "runtimeActivationAudits"]);
  });

  it("enables the exact AI invocation audit codec at both boundaries without accepting payload fields", () => {
    const codec = STORAGE_OWNED_CLOSED_CODECS.aiInvocationAudits;
    for (const row of [deterministicAuditRowFixture(), acceptedCareAuditRowFixture()]) {
      expect(codec.validateForWrite(row)).toEqual(row);
      expect(codec.validateAfterRead(row)).toEqual(row);
    }
    expect(failure(() => codec.validateForWrite({ ...acceptedCareAuditRowFixture(), rawResponse: "{}" })).code).toBe("STORAGE_VALIDATION_FAILED");
    const read = failure(() => codec.validateAfterRead({ ...deterministicAuditRowFixture(), prompt: "6.2 mmol/L" }));
    expect(read).toMatchObject({ code: "STORAGE_INTEGRITY_FAILED", table: "aiInvocationAudits" });
    expect(JSON.stringify(read) + read.message).not.toContain("6.2");
  });

  // Packet 11C Addendum C (C5): both audit schema versions pass the codec at both boundaries; a legacy-shaped row cannot carry a new code.
  it("accepts legacy (11a.1) and current (11c.2) AI audit rows at both boundaries, and nothing in between", () => {
    const codec = STORAGE_OWNED_CLOSED_CODECS.aiInvocationAudits;
    const current = currentAuditRowFixture({ ...deterministicAuditRowFixture(), outcomeCode: "NOT_ELIGIBLE" });
    for (const row of [deterministicAuditRowFixture(), current, currentAuditRowFixture(acceptedCareAuditRowFixture(), "UPPER_BOUND")]) {
      expect(codec.validateForWrite(row)).toEqual(row);
      expect(codec.validateAfterRead(row)).toEqual(row);
    }
    expect(failure(() => codec.validateForWrite({ ...deterministicAuditRowFixture(), outcomeCode: "NOT_ELIGIBLE" })).code).toBe("STORAGE_VALIDATION_FAILED");
    expect(failure(() => codec.validateAfterRead({ ...current, auditSchemaVersion: "ai-invocation-audit.12a.1" })).code).toBe("STORAGE_INTEGRITY_FAILED");
  });

  it("accepts a union row only through a registered member and retains no rejected value", () => {
    const codec = createUnionRowCodec("auditEvents", [accepts("a"), accepts("b")]);
    expect(codec.validateForWrite({ tag: "b" })).toEqual({ tag: "b" });
    const error = failure(() => codec.validateAfterRead({ tag: "c", glucose: "6.2" }));
    expect(error).toMatchObject({ code: "STORAGE_INTEGRITY_FAILED", table: "auditEvents", boundary: "READ" });
    expect(JSON.stringify(error)).not.toContain("6.2");
    expect(error.message).not.toContain("6.2");
    expect(failure(() => createUnionRowCodec("domainEvents", []).validateForWrite({ tag: "a" })).code).toBe("STORAGE_VALIDATION_FAILED");
  });

  it("requires every one of the 16 tables when assembling a registry", () => {
    const codec = emptyInProfileRowCodec("recordRevisions");
    const registry = createClosedRowCodecRegistry({ recordRevisions: codec, auditEvents: codec, domainEvents: codec });
    expect(Object.keys(registry)).toHaveLength(16);
    expect(() => createClosedRowCodecRegistry({ recordRevisions: codec, auditEvents: codec } as never)).toThrow(StorageRowValidationError);
  });

  it("closes storageMetadata to the four profile keys", () => {
    const at = "2026-10-04T02:00:00.000Z";
    expect(storageMetadataRowCodec.validateAfterRead({ key: "EVENT_SEQUENCE_HIGH_WATER_MARK", lastAllocatedSequence: 3, updatedAt: at })).toMatchObject({ lastAllocatedSequence: 3 });
    expect(failure(() => storageMetadataRowCodec.validateAfterRead({ key: "ACTIVE_DETERMINISTIC_RUNTIME", manifestId: "m", manifestVersion: "1" })).code).toBe("STORAGE_INTEGRITY_FAILED");
    expect(failure(() => storageMetadataRowCodec.validateAfterRead({ key: "AI_ROUTE_CIRCUIT:any", state: "OPEN" })).code).toBe("STORAGE_INTEGRITY_FAILED");
    expect(failure(() => storageMetadataRowCodec.validateAfterRead({ key: "INTEGRITY_LOCK", locked: true })).code).toBe("STORAGE_INTEGRITY_FAILED");
    expect(failure(() => storageMetadataRowCodec.validateForWrite({ key: "toString" })).code).toBe("STORAGE_VALIDATION_FAILED");
  });
});
