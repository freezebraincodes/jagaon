import { describe, it, expect } from "vitest";
import { deletionTombstoneSchema, type DeletionTombstone } from "./deletion";
import type { RecordId, AuditEventId, TransactionId } from "./identifiers";
import type { Instant } from "./time";
import type { ChangeInitiator } from "./provenance";

const RID = "f47ac10b-58cc-4372-a567-0e02b2c3d479" as RecordId;
const AID = "d47ac10b-58cc-4372-a567-0e02b2c3d479" as AuditEventId;
const TID = "e47ac10b-58cc-4372-a567-0e02b2c3d479" as TransactionId;
const T0 = "2026-09-27T10:00:00Z" as Instant;

function mkTomb(o?: Partial<DeletionTombstone>): DeletionTombstone {
  return { recordId: RID, recordType: "GLUCOSE_READING", deletedAt: T0, initiator: "PATIENT", auditEventId: AID, transactionId: TID, ...o };
}

describe("deletionTombstoneSchema", () => {
  it("accepts a minimal valid tombstone", () => {
    const t = deletionTombstoneSchema.parse(mkTomb());
    expect(t.recordId).toBe(RID);
    expect(t.recordType).toBe("GLUCOSE_READING");
    expect(t.initiator).toBe("PATIENT");
  });

  it("rejects a payload field", () => {
    expect(() =>
      deletionTombstoneSchema.parse({ ...mkTomb(), payload: { value: 5 } }),
    ).toThrow();
  });

  it("rejects a note field", () => {
    expect(() =>
      deletionTombstoneSchema.parse({ ...mkTomb(), note: "deleted by patient" }),
    ).toThrow();
  });

  it("rejects a clinicalValue field", () => {
    expect(() =>
      deletionTombstoneSchema.parse({ ...mkTomb(), clinicalValue: 5.5 }),
    ).toThrow();
  });

  it("rejects free text", () => {
    expect(() =>
      deletionTombstoneSchema.parse({ ...mkTomb(), freeText: "oops" }),
    ).toThrow();
  });

  it("rejects unknown keys", () => {
    expect(() =>
      deletionTombstoneSchema.parse({ ...mkTomb(), extra: true }),
    ).toThrow();
  });
});