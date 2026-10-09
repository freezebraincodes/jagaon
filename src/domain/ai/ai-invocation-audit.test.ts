import { describe, expect, it } from "vitest";
import {
  AI_AUDIT_ONLY_OUTCOME_CODES,
  AI_AUDIT_UNSENT_OUTCOME_CODES,
  AI_INVOCATION_AUDIT_LEGACY_SCHEMA_VERSION,
  AI_INVOCATION_AUDIT_SCHEMA_VERSION,
  AI_INVOCATION_OUTCOME_CODES,
  AI_INVOCATION_OUTCOME_CODES_11A,
  aiInvocationAuditRowSchema,
  aiInvocationAuditSchemaVersionOf,
} from "./ai-invocation-audit";
import { AI_REASON_CODES } from "./ai-task-contracts";
import { AUDIT_FIXTURE_REVISION as REVISION, acceptedCareAuditRowFixture as acceptedCareRow, auditComponentsFixture as components, currentAuditRowFixture, deterministicAuditRowFixture as deterministicRow } from "./ai-test-fixtures";

/** Packet 11A: the minimal local AI invocation audit row (storage-backup-spec 2.7, 4.6, 6.6). */

const parse = (row: unknown) => aiInvocationAuditRowSchema.safeParse(row);

describe("AI invocation audit row", () => {
  it("accepts a minimal deterministic outcome and a bounded remote outcome", () => {
    expect(parse(deterministicRow()).success).toBe(true);
    expect(parse(acceptedCareRow()).success).toBe(true);
  });

  it("closes the legacy outcome code to ACCEPTED plus the 22 matrix reason codes", () => {
    expect(AI_INVOCATION_OUTCOME_CODES_11A).toEqual(["ACCEPTED", ...AI_REASON_CODES]);
    expect(parse({ ...deterministicRow(), outcomeCode: "OK" }).success).toBe(false);
  });
});

/**
 * Packet 11C Addendum C (C5, owner decision C5-a: explicit, truthful outcome codes with a versioned audit and backup compatibility).
 * The audit-only codes live in their own list: never a provider failure reason, never a matrix reason code, never in a route body or
 * any model-facing contract. A current row names its schema version and its usage basis; a legacy row (no version field) keeps
 * exactly the 11A vocabulary, so every row written before C5 still validates, and a legacy-shaped row can never carry a new code.
 */
describe("AI invocation audit row versions (Packet 11C Addendum C, C5)", () => {
  const current = (row: Record<string, unknown> & { attempts: { count: number } }, basis?: "NONE" | "REPORTED" | "UPPER_BOUND") => currentAuditRowFixture(row, basis);

  it("names the versions: legacy rows are ai-invocation-audit.11a.1 (no field), new rows ai-invocation-audit.11c.2", () => {
    expect(AI_INVOCATION_AUDIT_LEGACY_SCHEMA_VERSION).toBe("ai-invocation-audit.11a.1");
    expect(AI_INVOCATION_AUDIT_SCHEMA_VERSION).toBe("ai-invocation-audit.11c.2");
    expect(aiInvocationAuditSchemaVersionOf(aiInvocationAuditRowSchema.parse(deterministicRow()))).toBe("ai-invocation-audit.11a.1");
    expect(aiInvocationAuditSchemaVersionOf(aiInvocationAuditRowSchema.parse(current(deterministicRow())))).toBe("ai-invocation-audit.11c.2");
    // The parsed rows keep their exact shape: a legacy row gains no field, a current row loses none.
    expect(aiInvocationAuditRowSchema.parse(deterministicRow())).toEqual(deterministicRow());
    expect(aiInvocationAuditRowSchema.parse(current(acceptedCareRow()))).toEqual(current(acceptedCareRow()));
    expect(Object.keys(aiInvocationAuditRowSchema.parse(deterministicRow()))).toEqual(Object.keys(deterministicRow()));
    expect(Object.keys(aiInvocationAuditRowSchema.parse(current(deterministicRow())))).toEqual(Object.keys(current(deterministicRow())));
  });

  // Disjointness from the provider failure reasons and the route contract is pinned in ai-hybrid-task-service.test.ts (application).
  it("adds exactly the audit-only outcome codes, disjoint from the matrix reason codes", () => {
    expect(AI_AUDIT_ONLY_OUTCOME_CODES).toEqual([
      "REMOTE_USE_DECLINED",
      "DISCLOSURE_CLOSED_MOOT",
      // Packet 11C Addendum C, C3 (deliberate addition under 11c.2): a request that reached the remote decision with no acceptance of its own.
      "REMOTE_USE_NOT_ACCEPTED",
      "NOT_ELIGIBLE",
      "SOURCE_UNAVAILABLE",
      "REQUEST_CLASS_NOT_QUALIFIED",
      "SPEND_CEILING_REACHED",
      "SPEND_NOT_CONFIGURED",
      "SPEND_LEDGER_UNAVAILABLE",
      "ORIGIN_REJECTED",
      "ACCESS_DENIED",
    ]);
    expect(AI_INVOCATION_OUTCOME_CODES).toEqual([...AI_INVOCATION_OUTCOME_CODES_11A, ...AI_AUDIT_ONLY_OUTCOME_CODES]);
    for (const code of AI_AUDIT_ONLY_OUTCOME_CODES) expect((AI_REASON_CODES as readonly string[]).includes(code), code).toBe(false);
    expect(AI_AUDIT_UNSENT_OUTCOME_CODES).toEqual(["REMOTE_USE_DECLINED", "DISCLOSURE_CLOSED_MOOT", "REMOTE_USE_NOT_ACCEPTED", "NOT_ELIGIBLE", "SOURCE_UNAVAILABLE"]);
  });

  it.each(AI_AUDIT_ONLY_OUTCOME_CODES.map((code) => [code]))("a current zero-attempt row may record %s; a legacy row never can", (code) => {
    expect(parse(current({ ...deterministicRow(), outcomeCode: code })).success).toBe(true);
    expect(parse({ ...deterministicRow(), outcomeCode: code }).success).toBe(false);
  });

  it("a current row still accepts every legacy code; an unknown code or version is refused", () => {
    for (const code of AI_INVOCATION_OUTCOME_CODES_11A) expect(parse(current({ ...deterministicRow(), outcomeCode: code, downstream: null })).success, code).toBe(true);
    expect(parse(current({ ...deterministicRow(), outcomeCode: "OK" })).success).toBe(false);
    expect(parse({ ...current(deterministicRow()), auditSchemaVersion: "ai-invocation-audit.11c.3" }).success).toBe(false);
    expect(parse({ ...current(deterministicRow()), auditSchemaVersion: "ai-invocation-audit.11a.1" }).success).toBe(false);
  });

  it("the version and the usage basis come together: neither alone is a valid row", () => {
    const { usageBasis: _basis, ...withoutBasis } = current(deterministicRow());
    expect(parse(withoutBasis).success).toBe(false);
    expect(parse({ ...deterministicRow(), usageBasis: "NONE" }).success).toBe(false);
  });

  it("usage basis NONE exactly when nothing was sent; REPORTED or UPPER_BOUND only for a transmitted row", () => {
    expect(parse(current(deterministicRow(), "NONE")).success).toBe(true);
    expect(parse(current(deterministicRow(), "REPORTED")).success).toBe(false);
    expect(parse(current(deterministicRow(), "UPPER_BOUND")).success).toBe(false);
    expect(parse(current(acceptedCareRow(), "REPORTED")).success).toBe(true);
    expect(parse(current(acceptedCareRow(), "UPPER_BOUND")).success).toBe(true);
    expect(parse(current(acceptedCareRow(), "NONE")).success).toBe(false);
    expect(parse({ ...current(acceptedCareRow()), usageBasis: "ESTIMATED" }).success).toBe(false);
  });

  it.each(["REMOTE_USE_DECLINED", "DISCLOSURE_CLOSED_MOOT", "REMOTE_USE_NOT_ACCEPTED", "NOT_ELIGIBLE", "SOURCE_UNAVAILABLE"])("%s is decided before anything is sent: a row with an attempt is refused", (code) => {
    expect(parse(current({ ...acceptedCareRow(), outcomeCode: code, downstream: null }, "REPORTED")).success).toBe(false);
  });

  it("the C1/C6 refusal codes may follow a transmission to the app's own route (attempt counted, nothing billed by the provider)", () => {
    for (const code of ["REQUEST_CLASS_NOT_QUALIFIED", "SPEND_CEILING_REACHED", "SPEND_NOT_CONFIGURED", "SPEND_LEDGER_UNAVAILABLE", "ORIGIN_REJECTED", "ACCESS_DENIED"]) {
      expect(parse(current({ ...acceptedCareRow(), outcomeCode: code, downstream: null, measurements: { inputTokens: null, outputTokens: null, latencyMs: 10, costMicroUsd: null } }, "REPORTED")).success, code).toBe(true);
    }
  });

  it("every 11A rule still applies to a current row (untransmitted data, downstream ownership, prohibited fields)", () => {
    expect(parse(current({ ...deterministicRow(), sourceRevisions: [REVISION] })).success).toBe(false);
    expect(parse(current({ ...acceptedCareRow(), outcomeCode: "FACT_FIDELITY_FAILED" })).success).toBe(false);
    expect(parse({ ...current(acceptedCareRow()), prompt: "Explain these readings" }).success).toBe(false);
    expect(parse(current({ ...deterministicRow(), completedAt: "2026-10-04T07:59:59.000Z" })).success).toBe(false);
  });

  it.each(["requestId", "taskType", "requestedAt", "outcomeCode", "routeProfileKey"])("requires indexed field %s", (field) => {
    const row: Record<string, unknown> = deterministicRow();
    delete row[field];
    expect(parse(row).success).toBe(false);
  });

  it("requires a random UUID v4 request id and ordered instants", () => {
    expect(parse({ ...deterministicRow(), requestId: "request-1" }).success).toBe(false);
    expect(parse({ ...deterministicRow(), completedAt: "2026-10-04T07:59:59.000Z" }).success).toBe(false);
  });

  it("pins every component to the row's own task, bundle and locale", () => {
    expect(parse({ ...deterministicRow(), runtimeBundleKey: "ai.phrase-non-clinical-response@11a.1" }).success).toBe(false);
    expect(parse({ ...deterministicRow(), components: components("phrase-non-clinical-response") }).success).toBe(false);
    expect(parse({ ...deterministicRow(), components: components("explain-pattern", "zh-sg") }).success).toBe(false);
    expect(parse({ ...deterministicRow(), locale: "zh-SG", components: components("explain-pattern", "zh-sg") }).success).toBe(true);
    expect(parse({ ...deterministicRow(), components: { ...components("explain-pattern"), promptTemplate: { id: "ai-prompt.explain-pattern", version: "latest" } } }).success).toBe(false);
  });

  it("bounds attempts, tokens, latency and cost", () => {
    const row = acceptedCareRow();
    expect(parse({ ...row, attempts: { ...row.attempts, count: 3 } }).success).toBe(false);
    expect(parse({ ...row, measurements: { ...row.measurements, inputTokens: -1 } }).success).toBe(false);
    expect(parse({ ...row, measurements: { ...row.measurements, outputTokens: 1.5 } }).success).toBe(false);
    expect(parse({ ...row, measurements: { ...row.measurements, latencyMs: 600_001 } }).success).toBe(false);
    expect(parse({ ...row, measurements: { ...row.measurements, costMicroUsd: 10_000_001 } }).success).toBe(false);
  });

  it("carries no provider, attempt, measurement or patient reference when nothing was transmitted", () => {
    const row = deterministicRow();
    expect(parse({ ...row, sourceRevisions: [REVISION] }).success).toBe(false);
    expect(parse({ ...row, providerModel: { providerKey: "kie", modelSnapshot: "example-model-2026-09-30" } }).success).toBe(false);
    expect(parse({ ...row, measurements: { ...row.measurements, inputTokens: 10 } }).success).toBe(false);
    expect(parse({ ...row, attempts: { ...row.attempts, count: 1 } }).success).toBe(false);
  });

  it("allows a downstream reference only for an accepted task that owns that record type", () => {
    const row = acceptedCareRow();
    expect(parse({ ...row, outcomeCode: "FACT_FIDELITY_FAILED" }).success).toBe(false);
    expect(parse({ ...row, downstream: { ...row.downstream, recordType: "INQUIRY" } }).success).toBe(false);
    expect(parse({ ...row, outcomeCode: "FACT_FIDELITY_FAILED", downstream: null }).success).toBe(true);
  });

  it("rejects duplicated or malformed local source references", () => {
    const row = acceptedCareRow();
    expect(parse({ ...row, sourceRevisions: [REVISION, REVISION] }).success).toBe(false);
    expect(parse({ ...row, sourceRevisions: [{ ...REVISION, recordType: "NOT_A_TYPE" }] }).success).toBe(false);
    // Exactly the request maximum (32 facts x 32 sources) so a source list is never truncated.
    const sources = (length: number) => Array.from({ length }, (_, index) => ({ ...REVISION, revisionId: `0b7e1f7a-1c2d-4e3f-8a9b-${index.toString(16).padStart(12, "0")}` }));
    expect(parse({ ...row, sourceRevisions: sources(1024) }).success).toBe(true);
    expect(parse({ ...row, sourceRevisions: sources(1025) }).success).toBe(false);
  });

  it.each([
    ["prompt", "Explain these readings"],
    ["providerPayload", { facts: [] }],
    ["rawResponse", "{\"outcome\":\"SUCCESS\"}"],
    ["renderedText", "Recent recorded values were 6.2 and 7.1 mmol/L."],
    ["credential", "sk-demo"],
    ["healthValue", "6.2"],
    ["inputFingerprint", "a".repeat(64)],
    ["providerRequestId", "provider-123"],
    ["note", "anything"],
  ])("rejects the prohibited or unknown field %s", (field, value) => {
    expect(parse({ ...acceptedCareRow(), [field]: value }).success).toBe(false);
  });

  it("has no free-text slot: a model snapshot or route key cannot carry prose or a health value", () => {
    expect(parse({ ...acceptedCareRow(), providerModel: { providerKey: "kie", modelSnapshot: "glucose 6.2 mmol/L" } }).success).toBe(false);
    expect(parse({ ...deterministicRow(), routeProfileKey: "Your reading is 6.2" }).success).toBe(false);
  });
});
