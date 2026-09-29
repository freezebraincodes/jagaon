import { describe, it, expect } from "vitest";
import { auditActionSchema, type DomainMutationAudit } from "./audit";
import type { Instant } from "./time";

describe("auditActionSchema", () => {
  it("accepts all RevisionAction values plus DELETE", () => {
    for (const v of [
      "CREATE",
      "UPDATE",
      "CORRECT",
      "SUPERSEDE",
      "CONFIRM",
      "REJECT",
      "EXPIRE",
      "SYSTEM_DERIVE",
      "DELETE",
    ]) {
      expect(auditActionSchema.parse(v)).toBe(v);
    }
  });

  it("rejects unknown actions", () => {
    expect(() => auditActionSchema.parse("MERGE")).toThrow();
  });
});

describe("DomainMutationAudit generic contract", () => {
  it("accepts a string reason code and optional note reference", () => {
    type Reason = "ROUTINE" | "CLINICAL";
    const audit: DomainMutationAudit<Reason, string> = {
      auditEventId: "f47ac10b-58cc-4372-a567-0e02b2c3d479" as never,
      transactionId: "e47ac10b-58cc-4372-a567-0e02b2c3d479" as never,
      recordId: "d47ac10b-58cc-4372-a567-0e02b2c3d479" as never,
      recordType: "GLUCOSE_READING",
      previousRevisionId: null,
      resultingRevisionId: "a47ac10b-58cc-4372-a567-0e02b2c3d479" as never,
      action: "CREATE",
      initiator: "PATIENT",
      assistance: "NONE",
      occurredAt: "2026-09-27T10:00:00Z" as Instant,
      reasonCode: "ROUTINE",
      noteRef: "note-1",
    };
    expect(audit.reasonCode).toBe("ROUTINE");
  });

  it("defaults TNoteRef to never so noteRef is not usable without a type argument", () => {
    type Reason = "ROUTINE";
    const audit: DomainMutationAudit<Reason> = {
      auditEventId: "f47ac10b-58cc-4372-a567-0e02b2c3d479" as never,
      transactionId: "e47ac10b-58cc-4372-a567-0e02b2c3d479" as never,
      recordId: "d47ac10b-58cc-4372-a567-0e02b2c3d479" as never,
      recordType: "GLUCOSE_READING",
      previousRevisionId: null,
      resultingRevisionId: "a47ac10b-58cc-4372-a567-0e02b2c3d479" as never,
      action: "CREATE",
      initiator: "PATIENT",
      assistance: "NONE",
      occurredAt: "2026-09-27T10:00:00Z" as Instant,
      reasonCode: "ROUTINE",
      // noteRef is omitted because TNoteRef defaults to never
    };
    expect(audit.reasonCode).toBe("ROUTINE");
  });

  it("rejects a non-string reason code at compile time", () => {
    // @ts-expect-error: TReasonCode extends string, so a number is not allowed.
    type Bad = DomainMutationAudit<42>;
  });
});