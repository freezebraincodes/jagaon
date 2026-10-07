import { describe, expect, it } from "vitest";
import { AUDIT_FIXTURE_REVISION, acceptedCareAuditRowFixture, deterministicAuditRowFixture } from "@/domain/ai/ai-test-fixtures";
import { aiAuditReferencesIn, aiAuditsAffectedByDeletion, validateAiAuditReferences } from "./ai-audit-lifecycle";

/**
 * Packet 11A Task 5 (owner decision, blocker 1 option b): AI invocation audits
 * in the Packet 10 deletion and restore lifecycle (storage-backup-spec 6.6,
 * 6.7, 8.4–8.7). Pure rules shared by the deletion planner, the restore
 * overlay, candidate inspection, target verification and reconciliation.
 */

const CARE = acceptedCareAuditRowFixture();
const SNAPSHOT = CARE.downstream!;
const revision = (ref: { recordType: string; recordId: string; revisionId: string }, payload: unknown = {}) => ({ ...ref, revisionNumber: 1, revision: { payload } });
const source = revision(AUDIT_FIXTURE_REVISION, { measurement: { enteredValue: "6.2" } });
const snapshot = (auditRef: unknown = CARE.requestId) => revision(SNAPSHOT, { composition: { method: "AI_ASSISTED", templateVersion: "t1", aiInvocationAuditRef: auditRef, validatedAt: "2026-10-04T08:00:01.000Z" } });
const valid = () => ({ recordRevisions: [source, snapshot()], aiInvocationAudits: [CARE, deterministicAuditRowFixture()] });
const reason = (tables: { recordRevisions: unknown[]; aiInvocationAudits: unknown[] }) => {
  const result = validateAiAuditReferences(tables);
  return result.kind === "VALID" ? "VALID" : result.reason;
};

describe("AI audit references in revision payloads", () => {
  it("collects every audit reference key at any depth and nothing else", () => {
    const payload = {
      composition: { aiInvocationAuditRef: "a" },
      presentations: [{ wordingSource: { kind: "VALIDATED_AI_ASSISTED", aiInvocation: "b" } }, { wordingSource: { kind: "DETERMINISTIC_TEMPLATE" } }],
      interpretation: { aiInvocation: 7 },
      note: "aiInvocation",
    };
    expect(aiAuditReferencesIn(payload)).toEqual(["a", "b", 7]);
    expect(aiAuditReferencesIn({ composition: { method: "DETERMINISTIC" } })).toEqual([]);
  });
});

describe("deletion closure selection (spec 6.6)", () => {
  const purge = (recordIds: string[], revisionIds: string[]) => aiAuditsAffectedByDeletion(valid().aiInvocationAudits, { recordIds: new Set(recordIds), revisionIds: new Set(revisionIds) });

  it("removes an audit whose source revision or source record is purged", () => {
    expect(purge([], [AUDIT_FIXTURE_REVISION.revisionId])).toEqual([CARE.requestId]);
    expect(purge([AUDIT_FIXTURE_REVISION.recordId], [])).toEqual([CARE.requestId]);
  });

  it("removes an audit whose downstream record is purged", () => {
    expect(purge([SNAPSHOT.recordId], [])).toEqual([CARE.requestId]);
  });

  it("keeps unrelated audits and audits that never carried a patient reference", () => {
    expect(purge(["0b7e1f7a-1c2d-4e3f-8a9b-0c1d2e3f4aff"], ["0b7e1f7a-1c2d-4e3f-8a9b-0c1d2e3f4afe"])).toEqual([]);
    const second = { ...CARE, requestId: "7a1c2b9a-4d3e-4f5a-8b7c-1d2e3f4a5b6c" };
    expect(aiAuditsAffectedByDeletion([second, CARE], { recordIds: new Set(), revisionIds: new Set([AUDIT_FIXTURE_REVISION.revisionId]) })).toEqual([CARE.requestId, second.requestId].sort());
  });
});

describe("restore reference validation (spec 8.4–8.7)", () => {
  it("accepts resolvable sources, downstream and back-references", () => {
    expect(reason(valid())).toBe("VALID");
    expect(reason({ recordRevisions: [], aiInvocationAudits: [] })).toBe("VALID");
    expect(reason({ recordRevisions: [source, revision(SNAPSHOT, { composition: { method: "AI_ASSISTED", aiInvocationAuditRef: CARE.requestId } })], aiInvocationAudits: [{ ...CARE, downstream: null }] })).toBe("VALID");
  });

  it("rejects a malformed or duplicated audit row", () => {
    expect(reason({ ...valid(), aiInvocationAudits: [{ ...CARE, rawResponse: "{}" }] })).toBe("MALFORMED");
    expect(reason({ ...valid(), aiInvocationAudits: [CARE, CARE] })).toBe("DUPLICATE");
  });

  it("rejects a dangling source or downstream reference", () => {
    expect(reason({ ...valid(), recordRevisions: [snapshot()] })).toBe("DANGLING");
    expect(reason({ ...valid(), recordRevisions: [source] })).toBe("DANGLING");
  });

  it("rejects a source or downstream that resolves to a different record", () => {
    expect(reason({ ...valid(), recordRevisions: [{ ...source, recordType: "INTAKE_EVENT" }, snapshot()] })).toBe("MISMATCH");
    expect(reason({ ...valid(), recordRevisions: [source, { ...snapshot(), recordId: "0b7e1f7a-1c2d-4e3f-8a9b-0c1d2e3f4aaa" }] })).toBe("MISMATCH");
  });

  it("rejects a downstream revision that does not reference the audit back", () => {
    expect(reason({ ...valid(), recordRevisions: [source, revision(SNAPSHOT, { composition: { method: "DETERMINISTIC" } })] })).toBe("MISMATCH");
  });

  it("rejects a payload reference to an unknown audit", () => {
    expect(reason({ ...valid(), recordRevisions: [source, snapshot("8a1c2b9a-4d3e-4f5a-8b7c-1d2e3f4a5b6c")] })).toBe("DANGLING");
  });

  it("rejects a payload reference to a non-accepted, foreign-task or differently-bound audit", () => {
    expect(reason({ recordRevisions: [source, snapshot()], aiInvocationAudits: [{ ...CARE, outcomeCode: "FACT_FIDELITY_FAILED", downstream: null }] })).toBe("MISMATCH");
    const inquiry = revision({ recordType: "INQUIRY", recordId: "0b7e1f7a-1c2d-4e3f-8a9b-0c1d2e3f4ab1", revisionId: "0b7e1f7a-1c2d-4e3f-8a9b-0c1d2e3f4ab2" }, { presentations: [{ wordingSource: { aiInvocation: CARE.requestId } }] });
    expect(reason({ recordRevisions: [source, snapshot(), inquiry], aiInvocationAudits: [CARE] })).toBe("MISMATCH");
    const other = revision({ ...SNAPSHOT, recordId: "0b7e1f7a-1c2d-4e3f-8a9b-0c1d2e3f4ab3", revisionId: "0b7e1f7a-1c2d-4e3f-8a9b-0c1d2e3f4ab4" }, { composition: { aiInvocationAuditRef: CARE.requestId } });
    expect(reason({ recordRevisions: [source, snapshot(), other], aiInvocationAudits: [CARE] })).toBe("MISMATCH");
  });

  it("rejects a reference from a record type no AI task owns, or a non-string reference", () => {
    const response = revision({ recordType: "INQUIRY_RESPONSE", recordId: "0b7e1f7a-1c2d-4e3f-8a9b-0c1d2e3f4ac1", revisionId: "0b7e1f7a-1c2d-4e3f-8a9b-0c1d2e3f4ac2" }, { interpretation: { kind: "AI_ASSISTED_CANDIDATE", aiInvocation: CARE.requestId } });
    expect(reason({ ...valid(), recordRevisions: [source, snapshot(), response] })).toBe("UNKNOWN");
    expect(reason({ ...valid(), recordRevisions: [source, snapshot(7)] })).toBe("MALFORMED");
  });
});
