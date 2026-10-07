import { describe, expect, it } from "vitest";
import { AI_INVOCATION_OUTCOME_CODES, aiInvocationAuditRowSchema } from "./ai-invocation-audit";
import { AI_REASON_CODES } from "./ai-task-contracts";
import { AUDIT_FIXTURE_REVISION as REVISION, acceptedCareAuditRowFixture as acceptedCareRow, auditComponentsFixture as components, deterministicAuditRowFixture as deterministicRow } from "./ai-test-fixtures";

/** Packet 11A: the minimal local AI invocation audit row (storage-backup-spec 2.7, 4.6, 6.6). */

const parse = (row: unknown) => aiInvocationAuditRowSchema.safeParse(row);

describe("AI invocation audit row", () => {
  it("accepts a minimal deterministic outcome and a bounded remote outcome", () => {
    expect(parse(deterministicRow()).success).toBe(true);
    expect(parse(acceptedCareRow()).success).toBe(true);
  });

  it("closes the outcome code to ACCEPTED plus the 22 matrix reason codes", () => {
    expect(AI_INVOCATION_OUTCOME_CODES).toEqual(["ACCEPTED", ...AI_REASON_CODES]);
    expect(parse({ ...deterministicRow(), outcomeCode: "OK" }).success).toBe(false);
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
