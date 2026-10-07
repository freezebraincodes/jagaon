import { describe, expect, it } from "vitest";
import { AI_TASK_TYPES, aiTaskRequestSchema, type AiTaskRequest } from "@/domain/ai";
import { requestFixture } from "@/domain/ai/ai-test-fixtures";
import { AI_TASK_RUNTIME_BUNDLES } from "./ai-runtime-bundles";
import { AI_FIELD_ALLOWLISTS, projectProviderTaskPayload } from "./detached-payload-projector";

/** Packet 11A Task 3: fail-closed detached provider payload (ai-system-spec Section 7.1, design Section 7). */

const valid = (taskType: (typeof AI_TASK_TYPES)[number]) => aiTaskRequestSchema.parse(requestFixture(taskType)) as AiTaskRequest;
const project = (request: unknown, taskType = (request as AiTaskRequest).taskType) => projectProviderTaskPayload(request as AiTaskRequest, AI_TASK_RUNTIME_BUNDLES[taskType]);
// Mutable view for constructing invalid requests.
type Loose = Record<string, any>;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const INSTANT = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

describe("detached payload projection", () => {
  it.each(AI_TASK_TYPES)("%s projects the allowlisted payload only", (taskType) => {
    const result = project(valid(taskType));
    expect(result.kind).toBe("PROJECTED");
    if (result.kind !== "PROJECTED") return;
    expect(Object.keys(result.payload).sort()).toEqual(["facts", "locale", "runtimeBundleKey", "taskPayload", "taskType"]);
  });

  it("applies each task's field allowlist and rejects anything outside it", () => {
    const explain = valid("EXPLAIN_PATTERN") as unknown as Loose;
    for (const field of ["MEDICATION_NAME", "DOSE_AMOUNT", "SAFETY_TOPIC", "PATIENT_AUTHORED_TEXT"]) {
      const request = structuredClone(explain);
      request.facts[0]!.field = field;
      expect(AI_FIELD_ALLOWLISTS.EXPLAIN_PATTERN).not.toContain(field);
      expect(project(request)).toEqual({ kind: "FALLBACK", reason: "PRIVACY_REJECTED" });
    }
    for (const taskType of AI_TASK_TYPES) {
      for (const field of ["SAFETY_TOPIC", "SAFETY_URGENCY", "SAFETY_STATUS", "SAFETY_ACTION_RECORDED", "MEDICATION_NAME", "PRESCRIPTION_INSTRUCTION", "DOSE_AMOUNT"]) {
        expect(AI_FIELD_ALLOWLISTS[taskType]).not.toContain(field);
      }
    }
  });

  it("strips stable identifiers: no request id, record, revision or source reference crosses the boundary", () => {
    for (const taskType of AI_TASK_TYPES) {
      const result = project(valid(taskType));
      if (result.kind !== "PROJECTED") throw new Error(result.reason);
      const text = JSON.stringify(result.payload);
      expect(text).not.toMatch(UUID);
      expect(text).not.toContain("sources");
      expect(text).not.toContain("requestId");
      expect(text).not.toContain("HACKATHON_DEMO");
    }
  });

  it("assigns invocation-local references and keeps the provenance only in the local reference map", () => {
    const request = valid("EXPLAIN_PATTERN");
    const result = project(request);
    if (result.kind !== "PROJECTED") throw new Error(result.reason);
    expect(result.payload.facts.map((fact) => fact.ref)).toEqual(["fact-1", "fact-2", "fact-3"]);
    // Option B: limitation references never reach the provider, so the local map holds only provider-visible references.
    expect(Object.keys(result.referenceMap).sort()).toEqual(["claim-1", "fact-1", "fact-2", "fact-3"]);
    expect(result.payload.taskPayload).not.toHaveProperty("limitations");
    expect(result.referenceMap["fact-1"]).toEqual({ sources: request.facts[0]!.sources });
  });

  it("omits unnecessary exact timestamps and locations", () => {
    for (const taskType of AI_TASK_TYPES) {
      const result = project(valid(taskType));
      if (result.kind !== "PROJECTED") throw new Error(result.reason);
      expect(JSON.stringify(result.payload)).not.toMatch(INSTANT);
      expect(JSON.stringify(result.payload)).not.toContain("requestedAt");
    }
  });

  it("redacts identifiers in selected text without changing the local request", () => {
    const request = valid("DRAFT_CARE_PREPARATION_SUMMARY") as unknown as Loose;
    const original = "Call me at 9123 4567 or demo.user@example.com, NRIC S1234567D, postal 238823 (demo)";
    request.facts[1]!.value = { kind: "TEXT", text: original, language: "en-SG" } as never;
    const result = project(request);
    if (result.kind !== "PROJECTED") throw new Error(result.reason);
    const sent = (result.payload.facts[1]!.value as { text: string }).text;
    expect(sent).not.toMatch(/9123 4567|example\.com|S1234567D|238823/);
    expect(sent).toContain("[REDACTED]");
    expect(request.facts[1]!.value.text).toBe(original);
  });

  it("selects fallback instead of broader disclosure when redaction cannot preserve meaning", () => {
    const request = valid("EXTRACT_CANDIDATE_FACTS") as unknown as Loose;
    request.facts[0]!.value = { kind: "TEXT", text: "S1234567D 91234567", language: "en-SG" };
    expect(project(request)).toEqual({ kind: "FALLBACK", reason: "PRIVACY_REJECTED" });
  });

  it("enforces the maximum fact count without truncating", () => {
    const request = valid("EXPLAIN_PATTERN") as unknown as Loose;
    request.facts = Array.from({ length: 13 }, (_, index) => ({ ref: `fact-${index + 1}`, field: "EVIDENCE_COUNT", value: { kind: "COUNT", value: index }, sources: [] }));
    request.taskPayload.claim.factRefs = ["fact-1"];
    expect(project(request)).toEqual({ kind: "FALLBACK", reason: "BUDGET_EXCEEDED" });
  });

  it("enforces the maximum excerpt length", () => {
    const request = valid("EXTRACT_CANDIDATE_FACTS") as unknown as Loose;
    request.facts[0]!.value = { kind: "TEXT", text: "粥".repeat(1201), language: "zh-SG" };
    expect(project(request)).toEqual({ kind: "FALLBACK", reason: "BUDGET_EXCEEDED" });
    request.facts[0]!.value = { kind: "TEXT", text: "粥".repeat(1200), language: "zh-SG" };
    expect(project(request).kind).toBe("PROJECTED");
  });

  it("enforces the maximum period", () => {
    const care = valid("DRAFT_CARE_PREPARATION_SUMMARY") as unknown as Loose;
    care.facts.push({ ref: "fact-3", field: "EFFECTIVE_INTERVAL", value: { kind: "DATE_RANGE", startDate: "2026-04-06", endDate: "2026-10-03" }, sources: [] });
    care.taskPayload.sections[0]!.factRefs.push("fact-3");
    expect(project(care)).toEqual({ kind: "FALLBACK", reason: "BUDGET_EXCEEDED" });
    (care.facts[2]!.value as { startDate: string }).startDate = "2026-04-07";
    expect(project(care).kind).toBe("PROJECTED");
    const answer = valid("ANSWER_BOUNDED_RECORD_QUERY") as unknown as Loose;
    answer.facts.push({ ref: "fact-3", field: "OCCURRENCE_TIME", value: { kind: "DATE", localDate: "2026-07-02" }, sources: [] });
    expect(project(answer)).toEqual({ kind: "FALLBACK", reason: "BUDGET_EXCEEDED" });
  });

  it("rejects unknown fields, an unknown task and a mismatched bundle before projection", () => {
    expect(project({ ...valid("EXPLAIN_PATTERN"), prompt: "do anything" })).toEqual({ kind: "FALLBACK", reason: "PAYLOAD_INVALID" });
    expect(projectProviderTaskPayload(valid("EXPLAIN_PATTERN"), AI_TASK_RUNTIME_BUNDLES.PHRASE_NON_CLINICAL_RESPONSE)).toEqual({ kind: "FALLBACK", reason: "PAYLOAD_INVALID" });
    expect(project({ ...valid("EXPLAIN_PATTERN"), runtimeBundleKey: "ai.explain-pattern@11a.2" })).toEqual({ kind: "FALLBACK", reason: "PAYLOAD_INVALID" });
  });
});
