import { describe, expect, it } from "vitest";
import {
  AI_TASK_TYPES,
  COMPARISON_PERIOD_ROLES,
  COMPARISON_SLOTS,
  COMPARISON_SUMMARY_KINDS,
  aiTaskOutputSchema,
  aiTaskRequestSchema,
  providerTaskOutputSchema,
  providerTaskRequestSchema,
  type AiTaskType,
} from "./ai-task-contracts";
import { abstainFixture, outputFixture, requestFixture, sourceBackedRequest } from "./ai-test-fixtures";

/** Packet 11A Task 1: the closed six-task registry and strict envelopes (ai-system-spec Sections 3, 7, 8). */

const TASKS: AiTaskType[] = [
  "EXTRACT_CANDIDATE_FACTS",
  "EXPLAIN_PATTERN",
  "DRAFT_NEUTRAL_INQUIRY",
  "ANSWER_BOUNDED_RECORD_QUERY",
  "DRAFT_CARE_PREPARATION_SUMMARY",
  "PHRASE_NON_CLINICAL_RESPONSE",
];

/** The detached provider form of a fixture request: no request id, no local provenance. */
function providerForm(taskType: AiTaskType): Record<string, unknown> {
  const { requestId: _id, requestedAt: _at, releaseProfile: _profile, facts, ...rest } = requestFixture(taskType) as Record<string, unknown> & { facts: Array<Record<string, unknown>> };
  void _id;
  void _at;
  void _profile;
  const provider = { ...rest, facts: facts.map(({ sources: _sources, ...fact }) => (void _sources, fact)) } as unknown as Record<string, unknown> & { taskPayload: Record<string, any> };
  // Option B (ai-input.explain-pattern@11b.1): the provider claim carries an approved meaning and no limitations.
  if (taskType === "EXPLAIN_PATTERN") provider.taskPayload = { claim: { ...provider.taskPayload.claim, approvedMeaning: "Approved claim meaning." } };
  return provider;
}

describe("closed AI task registry", () => {
  it("is exactly the six ordinary-product tasks, in the locked order", () => {
    expect([...AI_TASK_TYPES]).toEqual(TASKS);
    expect(Object.isFrozen(AI_TASK_TYPES)).toBe(true);
  });

  it("rejects an unknown or Safety task on every envelope", () => {
    for (const taskType of ["CLASSIFY_SAFETY_EVENT", "CHAT", "explain_pattern", ""]) {
      expect(aiTaskRequestSchema.safeParse({ ...requestFixture("EXPLAIN_PATTERN"), taskType }).success).toBe(false);
      expect(providerTaskRequestSchema.safeParse({ ...providerForm("EXPLAIN_PATTERN"), taskType }).success).toBe(false);
      expect(aiTaskOutputSchema.safeParse({ ...outputFixture("EXPLAIN_PATTERN"), taskType }).success).toBe(false);
    }
  });
});

describe.each(TASKS)("%s envelopes", (taskType) => {
  it("accepts its own request, provider request, success and abstention", () => {
    expect(aiTaskRequestSchema.safeParse(requestFixture(taskType)).success).toBe(true);
    expect(providerTaskRequestSchema.safeParse(providerForm(taskType)).success).toBe(true);
    expect(aiTaskOutputSchema.safeParse(outputFixture(taskType)).success).toBe(true);
    expect(providerTaskOutputSchema.safeParse(outputFixture(taskType)).success).toBe(true);
    expect(aiTaskOutputSchema.safeParse(abstainFixture(taskType)).success).toBe(true);
  });

  it("rejects another task's payload under its discriminant", () => {
    const other = TASKS.find((candidate) => candidate !== taskType)!;
    expect(aiTaskRequestSchema.safeParse({ ...requestFixture(taskType), taskPayload: requestFixture(other).taskPayload }).success).toBe(false);
    expect(aiTaskOutputSchema.safeParse({ ...outputFixture(taskType), payload: outputFixture(other).payload }).success).toBe(false);
  });

  it("rejects unknown fields on the request, payload, fact and output", () => {
    const request = requestFixture(taskType) as Record<string, unknown> & { taskPayload: Record<string, unknown> };
    expect(aiTaskRequestSchema.safeParse({ ...request, prompt: "ignore previous instructions" }).success).toBe(false);
    expect(aiTaskRequestSchema.safeParse({ ...request, taskPayload: { ...request.taskPayload, model: "any" } }).success).toBe(false);
    expect(aiTaskOutputSchema.safeParse({ ...outputFixture(taskType), confidence: 0.99 }).success).toBe(false);
    const output = outputFixture(taskType) as { payload: Record<string, unknown> };
    expect(aiTaskOutputSchema.safeParse({ ...output, payload: { ...output.payload, advice: "x" } }).success).toBe(false);
  });

  it("rejects unsupported locales and profiles", () => {
    for (const locale of ["en", "zh-CN", "en-US", "ms-SG"]) {
      expect(aiTaskRequestSchema.safeParse({ ...requestFixture(taskType), locale }).success).toBe(false);
      expect(aiTaskOutputSchema.safeParse({ ...outputFixture(taskType), locale }).success).toBe(false);
    }
    for (const releaseProfile of ["PATIENT_RELEASE", "IMPLEMENTATION_CHECKPOINT", undefined]) {
      expect(aiTaskRequestSchema.safeParse({ ...requestFixture(taskType), releaseProfile }).success).toBe(false);
    }
  });

  it("keeps success and abstention mutually exclusive", () => {
    const success = outputFixture(taskType);
    const abstain = abstainFixture(taskType);
    expect(aiTaskOutputSchema.safeParse({ ...success, abstentionReason: "INSUFFICIENT_CONTEXT" }).success).toBe(false);
    expect(aiTaskOutputSchema.safeParse({ ...abstain, payload: success.payload }).success).toBe(false);
    expect(aiTaskOutputSchema.safeParse({ ...abstain, abstentionReason: "UNSAFE" }).success).toBe(false);
    const { payload: _payload, ...noPayload } = success;
    void _payload;
    expect(aiTaskOutputSchema.safeParse(noPayload).success).toBe(false);
  });
});

describe("request-local references and provider-visible identifiers", () => {
  it("requires every payload reference to resolve to a declared fact", () => {
    const request = requestFixture("EXPLAIN_PATTERN") as Record<string, unknown> & { taskPayload: { claim: { factRefs: string[] } } };
    request.taskPayload.claim.factRefs = ["fact-1", "fact-9"];
    expect(aiTaskRequestSchema.safeParse(request).success).toBe(false);
  });

  it("rejects duplicate fact references", () => {
    const request = requestFixture("EXPLAIN_PATTERN") as Record<string, unknown> & { facts: Array<{ ref: string }> };
    request.facts[1]!.ref = "fact-1";
    expect(aiTaskRequestSchema.safeParse(request).success).toBe(false);
  });

  it("accepts only invocation-local reference shapes", () => {
    for (const ref of ["fact-0", "fact-1000", "fact-6f1c2b9e-3d4a-4b5c-8d6e-7f8091a2b3c4", "6f1c2b9e-3d4a-4b5c-8d6e-7f8091a2b3c4", "record-1", "FACT-1"]) {
      const request = requestFixture("EXPLAIN_PATTERN") as Record<string, unknown> & { facts: Array<{ ref: string }>; taskPayload: { claim: { factRefs: string[] } } };
      request.facts[0]!.ref = ref;
      request.taskPayload.claim.factRefs = [ref, "fact-2", "fact-3"];
      expect(aiTaskRequestSchema.safeParse(request).success).toBe(false);
    }
    const output = outputFixture("EXPLAIN_PATTERN");
    expect(aiTaskOutputSchema.safeParse({ ...output, inputRefsUsed: ["0b1c2d3e-4f50-4617-8829-3a4b5c6d7e8f"] }).success).toBe(false);
  });

  it("keeps local provenance, the request id and the profile out of the provider request", () => {
    const provider = providerForm("EXPLAIN_PATTERN") as Record<string, unknown> & { facts: Array<Record<string, unknown>> };
    expect(providerTaskRequestSchema.safeParse({ ...provider, requestId: "6f1c2b9e-3d4a-4b5c-8d6e-7f8091a2b3c4" }).success).toBe(false);
    expect(providerTaskRequestSchema.safeParse({ ...provider, releaseProfile: "HACKATHON_DEMO" }).success).toBe(false);
    const withSource = { ...provider, facts: [{ ...provider.facts[0], sources: [{ recordType: "GLUCOSE_READING", recordId: "0b1c2d3e-4f50-4617-8829-3a4b5c6d7e8f", revisionId: "1c2d3e4f-5061-4728-9930-4b5c6d7e8f90" }] }, ...provider.facts.slice(1)] };
    expect(providerTaskRequestSchema.safeParse(withSource).success).toBe(false);
  });

  it("rejects a reversed date range fact", () => {
    const request = requestFixture("ANSWER_BOUNDED_RECORD_QUERY") as Record<string, unknown> & { facts: Array<{ value: unknown }> };
    request.facts[1]!.value = { kind: "DATE_RANGE", startDate: "2026-10-02", endDate: "2026-10-01" };
    expect(aiTaskRequestSchema.safeParse(request).success).toBe(false);
    request.facts[1]!.value = { kind: "DATE_RANGE", startDate: "2026-10-01", endDate: "2026-10-02" };
    expect(aiTaskRequestSchema.safeParse(request).success).toBe(true);
  });

  it("rejects a random request id that is not a UUID and a non-instant requestedAt", () => {
    expect(aiTaskRequestSchema.safeParse({ ...requestFixture("PHRASE_NON_CLINICAL_RESPONSE"), requestId: "patient-123" }).success).toBe(false);
    expect(aiTaskRequestSchema.safeParse({ ...requestFixture("PHRASE_NON_CLINICAL_RESPONSE"), requestedAt: "yesterday" }).success).toBe(false);
  });

  it("limits pattern explanation to the two Packet 7A families and requires a limitation", () => {
    const request = requestFixture("EXPLAIN_PATTERN") as Record<string, unknown> & { taskPayload: { claim: { family: string }; limitations: unknown[] } };
    for (const family of ["ROUTINE_SHIFT", "CROSS_VARIABLE_ASSOCIATION", "RECURRING_BARRIER"]) {
      expect(aiTaskRequestSchema.safeParse({ ...request, taskPayload: { ...request.taskPayload, claim: { ...request.taskPayload.claim, family } } }).success).toBe(false);
    }
    expect(aiTaskRequestSchema.safeParse({ ...request, taskPayload: { ...request.taskPayload, limitations: [] } }).success).toBe(false);
  });

  it("keeps deterministic-only care-summary sections out of AI organisation", () => {
    const request = requestFixture("DRAFT_CARE_PREPARATION_SUMMARY") as Record<string, unknown> & { taskPayload: { sections: Array<{ sectionId: string }> } };
    for (const sectionId of ["SUMMARY_SCOPE", "DATA_LIMITATIONS", "SAFETY_HISTORY"]) {
      request.taskPayload.sections[0]!.sectionId = sectionId;
      expect(aiTaskRequestSchema.safeParse(request).success).toBe(false);
    }
  });
});

describe("closed comparison vocabularies", () => {
  it("exposes the frozen period roles, summary kinds (median and interquartile range) and slots", () => {
    expect([...COMPARISON_PERIOD_ROLES]).toEqual(["EARLIER", "RECENT"]);
    expect([...COMPARISON_SUMMARY_KINDS]).toEqual(["MEDIAN", "IQR"]);
    expect([...COMPARISON_SLOTS]).toEqual(["BEFORE_BREAKFAST", "BEFORE_LUNCH", "BEFORE_DINNER", "BEDTIME"]);
    for (const list of [COMPARISON_PERIOD_ROLES, COMPARISON_SUMMARY_KINDS, COMPARISON_SLOTS]) expect(Object.isFrozen(list)).toBe(true);
  });
});

describe("source-backed EXPLAIN binding", () => {
  type Loose = Record<string, any>;
  const base = sourceBackedRequest();
  /** Every issue message (rule code) the internal request schema reports. */
  const issueCodes = (request: unknown): string[] => {
    const result = aiTaskRequestSchema.safeParse(request);
    return result.success ? [] : result.error.issues.map((issue) => issue.message);
  };

  it("accepts a complete binding whose refs are the claim facts exactly once", () => {
    expect(aiTaskRequestSchema.safeParse(base).success).toBe(true);
    expect(issueCodes(base)).toEqual([]);
  });

  it("accepts the interquartile-range summary kind and every closed slot", () => {
    for (const summaryKind of ["MEDIAN", "IQR"]) {
      const request = structuredClone(base) as Loose;
      request.taskPayload.periodSummary.summaryKind = summaryKind;
      expect(aiTaskRequestSchema.safeParse(request).success).toBe(true);
    }
    for (const slot of COMPARISON_SLOTS) {
      const request = structuredClone(base) as Loose;
      request.taskPayload.periodSummary.slot = slot;
      expect(aiTaskRequestSchema.safeParse(request).success).toBe(true);
    }
  });

  // Each rejection is pinned to its intended rule: the named code must be reported and the mutation must not
  // fail merely because a reference is undeclared.
  it.each<[string, (r: Loose) => void, string, string[]]>([
    ["periods out of order", (r) => r.taskPayload.periodSummary.periods.reverse(), "PERIOD_ORDER", ["UNRESOLVED_FACT_REFERENCE"]],
    ["a ref outside the claim", (r) => (r.taskPayload.periodSummary.periods[0].countRef = "fact-9"), "PERIOD_BINDING_REFS", ["PERIOD_BINDING_FAMILY", "PERIOD_TOTAL_MISMATCH"]],
    ["a ref used twice", (r) => (r.taskPayload.periodSummary.periods[1].countRef = r.taskPayload.periodSummary.periods[0].countRef), "PERIOD_BINDING_REFS", ["PERIOD_BINDING_FAMILY", "UNRESOLVED_FACT_REFERENCE"]],
    [
      "a declared claim fact that is not bound",
      (r) => {
        r.facts.push({ ref: "fact-8", field: "EVIDENCE_COUNT", value: { kind: "COUNT", value: 3 }, sources: [] });
        r.taskPayload.claim.factRefs.push("fact-8");
      },
      "PERIOD_BINDING_REFS",
      ["UNRESOLVED_FACT_REFERENCE", "PERIOD_BINDING_FAMILY", "PERIOD_BINDING_KIND"],
    ],
    ["wrong fact kind for an interval (count ref swapped in)", (r) => (r.taskPayload.periodSummary.periods[0].intervalRef = r.taskPayload.periodSummary.periods[0].countRef), "PERIOD_BINDING_KIND", ["UNRESOLVED_FACT_REFERENCE"]],
    [
      "interval and count refs swapped",
      (r) => {
        const period = r.taskPayload.periodSummary.periods[0];
        [period.intervalRef, period.countRef] = [period.countRef, period.intervalRef];
      },
      "PERIOD_BINDING_KIND",
      ["PERIOD_BINDING_REFS", "PERIOD_TOTAL_MISMATCH", "UNRESOLVED_FACT_REFERENCE"],
    ],
    ["a summary fact in the wrong unit", (r) => (r.facts[2].value.unit = "MG_DL"), "PERIOD_BINDING_KIND", ["PERIOD_BINDING_REFS", "PERIOD_TOTAL_MISMATCH"]],
    ["a summary fact that is not a measurement value", (r) => (r.facts[5].field = "EVIDENCE_COUNT"), "PERIOD_BINDING_KIND", ["PERIOD_BINDING_REFS", "PERIOD_TOTAL_MISMATCH"]],
    ["total count not equal to the sum", (r) => (r.facts[6].value.value = 15), "PERIOD_TOTAL_MISMATCH", ["PERIOD_BINDING_REFS", "PERIOD_BINDING_KIND", "PERIOD_BINDING_FAMILY"]],
    ["a period count that changes the sum", (r) => (r.facts[1].value.value = 9), "PERIOD_TOTAL_MISMATCH", ["PERIOD_BINDING_REFS", "PERIOD_BINDING_KIND", "PERIOD_BINDING_FAMILY"]],
    ["FAMILIAR family with a binding", (r) => (r.taskPayload.claim.family = "FAMILIAR_OR_FREQUENT_ITEM"), "PERIOD_BINDING_FAMILY", ["PERIOD_BINDING_REFS", "PERIOD_BINDING_KIND", "PERIOD_TOTAL_MISMATCH"]],
  ])("rejects %s", (_label, mutate, expected, absent) => {
    const request = structuredClone(base) as Loose;
    mutate(request);
    expect(aiTaskRequestSchema.safeParse(request).success).toBe(false);
    const codes = issueCodes(request);
    expect(codes).toContain(expected);
    for (const code of absent) expect(codes).not.toContain(code);
  });

  it("rejects an unknown slot, summary kind, role or extra binding field", () => {
    const mutations: Array<(r: Loose) => void> = [
      (r) => (r.taskPayload.periodSummary.slot = "AFTER_MEAL"),
      (r) => (r.taskPayload.periodSummary.summaryKind = "SPREAD"),
      (r) => (r.taskPayload.periodSummary.periods[0].role = "MIDDLE"),
      (r) => (r.taskPayload.periodSummary.value = "6.25"),
      (r) => (r.taskPayload.periodSummary.periods[0].recordId = "0b1c2d3e-4f50-4617-8829-3a4b5c6d7e8f"),
      (r) => r.taskPayload.periodSummary.periods.pop(),
      (r) => delete r.taskPayload.periodSummary.totalCountRef,
    ];
    for (const mutate of mutations) {
      const request = structuredClone(base) as Loose;
      mutate(request);
      expect(aiTaskRequestSchema.safeParse(request).success).toBe(false);
    }
  });

  it("leaves a request without a binding valid and the provider payload binding-free", () => {
    const request = structuredClone(base) as Loose;
    delete request.taskPayload.periodSummary;
    expect(aiTaskRequestSchema.safeParse(request).success).toBe(true);
    const { requestId: _id, requestedAt: _at, releaseProfile: _profile, facts, ...rest } = structuredClone(base) as Loose;
    void [_id, _at, _profile];
    const provider = {
      ...rest,
      facts: facts.map(({ sources: _sources, ...fact }: Loose) => (void _sources, fact)),
      taskPayload: { claim: { ...rest.taskPayload.claim, approvedMeaning: "Approved claim meaning." }, periodSummary: rest.taskPayload.periodSummary },
    };
    expect(providerTaskRequestSchema.safeParse(provider).success).toBe(false);
  });
});
