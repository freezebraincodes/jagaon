import { describe, it, expect } from "vitest";
import { domainValidationCodeSchema, DomainValidationCode } from "./validation";

const APPROVED_CODES = [
  "INVALID_IDENTIFIER",
  "INVALID_TIMESTAMP",
  "INVALID_TEMPORAL_RANGE",
  "INSUFFICIENT_TEMPORAL_PRECISION",
  "INVALID_REVISION_LINEAGE",
  "REVISION_CONFLICT",
  "INVALID_ACTION_FOR_ENTITY",
  "INVALID_PROVENANCE_COMBINATION",
  "MISSING_SOURCE_REFERENCE",
  "MISSING_AUDIT_LINK",
  "DELETED_RECORD_NOT_ACTIONABLE",
] as const;

describe("domainValidationCodeSchema", () => {
  it("parses every approved validation code", () => {
    for (const code of APPROVED_CODES) {
      expect(domainValidationCodeSchema.parse(code)).toBe(code);
    }
  });

  it("rejects an unknown validation code", () => {
    expect(() => domainValidationCodeSchema.parse("UNKNOWN_ERROR")).toThrow();
  });

  it("rejects a non-string value", () => {
    expect(() => domainValidationCodeSchema.parse(42)).toThrow();
  });

  it("has exactly eleven codes matching DomainValidationCode", () => {
    const expected = Object.values(DomainValidationCode);
    expect(APPROVED_CODES).toEqual(expected);
    expect(expected).toHaveLength(11);
  });
});