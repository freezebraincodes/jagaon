import { describe, it, expect } from "vitest";
import type {
  DomainValidationCode,
  DeletionPolicy,
  PrescriptionChangeCandidateState,
  RecordId,
  RecordType,
  Instant,
  DeletionTombstone,
  RecordRevision,
  RecordHead,
  ValidationResult,
  DomainMutationAudit,
} from "./index";

// Compile-time fixture: confirm canonical type names are available from the
// shared barrel. If any were accidentally aliased away or missing, the type
// annotations below would fail to compile.
describe("shared barrel canonical type names", () => {
  it("exports DomainValidationCode", () => {
    const _v: DomainValidationCode = "INVALID_IDENTIFIER";
    expect(_v).toBe("INVALID_IDENTIFIER");
  });

  it("exports DeletionPolicy", () => {
    const _v: DeletionPolicy = "PATIENT_DELETABLE";
    expect(_v).toBe("PATIENT_DELETABLE");
  });

  it("exports PrescriptionChangeCandidateState", () => {
    const _v: PrescriptionChangeCandidateState = "PENDING_RECONCILIATION";
    expect(_v).toBe("PENDING_RECONCILIATION");
  });

  it("exports RecordId", () => {
    const _v: RecordId = "f47ac10b-58cc-4372-a567-0e02b2c3d479" as RecordId;
    expect(_v).toBe("f47ac10b-58cc-4372-a567-0e02b2c3d479");
  });

  it("exports RecordType", () => {
    const _v: RecordType = "GLUCOSE_READING";
    expect(_v).toBe("GLUCOSE_READING");
  });

  it("exports Instant", () => {
    const _v: Instant = "2026-09-27T10:00:00Z" as Instant;
    expect(_v).toBe("2026-09-27T10:00:00Z");
  });

  it("exports DeletionTombstone", () => {
    const _v: DeletionTombstone = {} as DeletionTombstone;
    expect(_v).toBeDefined();
  });

  it("exports RecordRevision", () => {
    const _v: RecordRevision<string, unknown, unknown, unknown> = {} as RecordRevision<string, unknown, unknown, unknown>;
    expect(_v).toBeDefined();
  });

  it("exports RecordHead", () => {
    const _v: RecordHead = {} as RecordHead;
    expect(_v).toBeDefined();
  });

  it("exports ValidationResult", () => {
    const _v: ValidationResult = { ok: true };
    expect(_v.ok).toBe(true);
  });

  it("exports DomainMutationAudit", () => {
    const _v: DomainMutationAudit<"ROUTINE"> = {} as DomainMutationAudit<"ROUTINE">;
    expect(_v).toBeDefined();
  });
});