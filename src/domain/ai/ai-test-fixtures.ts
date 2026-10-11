import type { AiTaskRequest, AiTaskType } from "./ai-task-contracts";

/**
 * Test-only synthetic Packet 11 fixtures. Every value is invented; no real
 * patient, record or provider data. Never imported by runtime modules.
 */

export const FIXTURE_NOW = "2026-10-04T02:00:00.000Z";
export const FIXTURE_REQUEST_ID = "6f1c2b9e-3d4a-4b5c-8d6e-7f8091a2b3c4";
const SOURCE = { recordType: "GLUCOSE_READING", recordId: "0b1c2d3e-4f50-4617-8829-3a4b5c6d7e8f", revisionId: "1c2d3e4f-5061-4728-9930-4b5c6d7e8f90" } as const;

const glucose = (ref: string, value: string) => ({ ref, field: "MEASUREMENT_VALUE", value: { kind: "DECIMAL", value, unit: "MMOL_L" }, knowledgeClass: "PATIENT_STATED", sources: [SOURCE] });
const count = (ref: string, value: number) => ({ ref, field: "EVIDENCE_COUNT", value: { kind: "COUNT", value }, sources: [] });
const text = (ref: string, field: string, value: string) => ({ ref, field, value: { kind: "TEXT", text: value, language: "en-SG" }, sources: [SOURCE] });

const BASE = {
  requestId: FIXTURE_REQUEST_ID,
  requestedAt: FIXTURE_NOW,
  locale: "en-SG",
  releaseProfile: "HACKATHON_DEMO",
};

/** One valid internal request per task, typed loosely so tests can mutate it. */
/** Component version per task: EXPLAIN_PATTERN is 11b.1 (Packet 11B.5 Option B); every other task 11a.1. */
const VERSION = (taskType: AiTaskType) => (taskType === "EXPLAIN_PATTERN" ? "11b.1" : "11a.1");
/** Runtime bundle version: EXPLAIN_PATTERN 11b.2 after its fixture-set correction; every other task 11a.1. */
const BUNDLE_VERSION = (taskType: AiTaskType) => (taskType === "EXPLAIN_PATTERN" || taskType === "DRAFT_CARE_PREPARATION_SUMMARY" ? "11b.3" : "11a.1");

export function requestFixture(taskType: AiTaskType): Record<string, unknown> & AiTaskRequest {
  const byTask: Record<AiTaskType, Record<string, unknown>> = {
    EXTRACT_CANDIDATE_FACTS: {
      facts: [text("fact-1", "PATIENT_AUTHORED_TEXT", "Had kaya toast and teh at the kopitiam")],
      taskPayload: { excerptRef: "fact-1", targetFields: ["INTAKE_ITEM_LABEL", "INTAKE_KIND"] },
    },
    EXPLAIN_PATTERN: {
      facts: [glucose("fact-1", "6.2"), glucose("fact-2", "7.1"), count("fact-3", 10)],
      taskPayload: {
        claim: { ref: "claim-1", family: "COMPARABLE_SLOT_TREND", factRefs: ["fact-1", "fact-2", "fact-3"] },
        limitations: [{ ref: "limitation-1", code: "DOES_NOT_ESTABLISH_CAUSE" }],
      },
    },
    DRAFT_NEUTRAL_INQUIRY: {
      facts: [count("fact-1", 3)],
      taskPayload: {
        purpose: "RECORD_CLARIFICATION",
        questionIntentCode: "CONFIRM_RECORDED_TIME",
        options: [
          { ref: "option-1", meaningCode: "YES" },
          { ref: "option-2", meaningCode: "NO" },
        ],
        supportingFactRefs: ["fact-1"],
      },
    },
    ANSWER_BOUNDED_RECORD_QUERY: {
      facts: [glucose("fact-1", "6.2"), { ref: "fact-2", field: "OCCURRENCE_TIME", value: { kind: "DATE", localDate: "2026-10-01" }, sources: [SOURCE] }],
      taskPayload: { queryKind: "RECORDS_IN_PERIOD", records: [{ ref: "record-1", factRefs: ["fact-1", "fact-2"] }] },
    },
    DRAFT_CARE_PREPARATION_SUMMARY: {
      facts: [glucose("fact-1", "6.2"), text("fact-2", "QUESTION_TEXT", "Can I keep the pen in my bag? (demo)")],
      taskPayload: {
        sections: [
          { ref: "section-1", sectionId: "MEASUREMENTS", factRefs: ["fact-1"] },
          { ref: "section-2", sectionId: "QUESTIONS_FOR_CARE_TEAM", factRefs: ["fact-2"] },
        ],
      },
    },
    PHRASE_NON_CLINICAL_RESPONSE: {
      facts: [],
      taskPayload: { intentCode: "RECORD_SAVED_ACKNOWLEDGEMENT", factRefs: [] },
    },
  };
  return structuredClone({ ...BASE, taskType, runtimeBundleKey: `ai.${taskType.toLowerCase().replaceAll("_", "-")}@${BUNDLE_VERSION(taskType)}`, ...byTask[taskType] }) as never;
}

// --- Packet 11C source-backed EXPLAIN_PATTERN request ---

const periodSource = (n: number) => ({
  recordType: "GLUCOSE_READING",
  recordId: `0b1c2d3e-4f50-4617-8829-3a4b5c6d7e${(80 + n).toString(16)}`,
  revisionId: `1c2d3e4f-5061-4728-9930-4b5c6d7e8f${(16 + n).toString(16)}`,
});
const periodInterval = (ref: string, startDate: string, endDate: string, n: number) => ({ ref, field: "EFFECTIVE_INTERVAL", value: { kind: "DATE_RANGE", startDate, endDate }, sources: [periodSource(n)] });
const periodCount = (ref: string, value: number, n: number) => ({ ref, field: "EVIDENCE_COUNT", value: { kind: "COUNT", value }, sources: [periodSource(n)] });
const periodMedian = (ref: string, value: string, n: number) => ({ ref, field: "MEASUREMENT_VALUE", value: { kind: "DECIMAL", value, unit: "MMOL_L" }, sources: [periodSource(n)] });

/**
 * A valid source-backed EXPLAIN_PATTERN request (bundle 11b.18): an earlier and a recent period (interval, count,
 * median value) plus the total evidence count (8 + 6 = 14), bound by `taskPayload.periodSummary`. Typed loosely so
 * tests can mutate it.
 */
export function sourceBackedRequest(): Record<string, unknown> & AiTaskRequest {
  return structuredClone({
    ...BASE,
    taskType: "EXPLAIN_PATTERN",
    runtimeBundleKey: "ai.explain-pattern@11b.20",
    facts: [
      periodInterval("fact-1", "2026-09-01", "2026-09-14", 1),
      periodCount("fact-2", 8, 2),
      periodMedian("fact-3", "6.25", 3),
      periodInterval("fact-4", "2026-09-15", "2026-09-28", 4),
      periodCount("fact-5", 6, 5),
      periodMedian("fact-6", "7.35", 6),
      periodCount("fact-7", 14, 7),
    ],
    taskPayload: {
      claim: { ref: "claim-1", family: "COMPARABLE_SLOT_TREND", factRefs: ["fact-1", "fact-2", "fact-3", "fact-4", "fact-5", "fact-6", "fact-7"] },
      limitations: [{ ref: "limitation-1", code: "DOES_NOT_ESTABLISH_CAUSE" }],
      periodSummary: {
        slot: "BEFORE_BREAKFAST",
        summaryKind: "MEDIAN",
        periods: [
          { role: "EARLIER", intervalRef: "fact-1", countRef: "fact-2", summaryRef: "fact-3" },
          { role: "RECENT", intervalRef: "fact-4", countRef: "fact-5", summaryRef: "fact-6" },
        ],
        totalCountRef: "fact-7",
      },
    },
  }) as never;
}

const SCHEMA_VERSION = (taskType: AiTaskType) => `ai-output.${taskType.toLowerCase().replaceAll("_", "-")}@${VERSION(taskType)}`;

/** One valid SUCCESS output per task, matching `requestFixture`. */
export function outputFixture(taskType: AiTaskType): Record<string, unknown> {
  const byTask: Record<AiTaskType, { inputRefsUsed: string[]; payload: unknown }> = {
    EXTRACT_CANDIDATE_FACTS: {
      inputRefsUsed: ["fact-1"],
      payload: { candidates: [{ field: "INTAKE_ITEM_LABEL", sourceRef: "fact-1", start: 4, end: 14, quotation: "kaya toast" }] },
    },
    EXPLAIN_PATTERN: {
      inputRefsUsed: ["claim-1", "fact-1", "fact-2", "fact-3"],
      payload: {
        headline: { text: "Your recorded readings in this slot differed", claimRefs: ["claim-1"] },
        observation: { text: "Recent recorded values were 6.2 and 7.1 mmol/L.", claimRefs: ["claim-1"] },
        evidence: { text: "This uses 10 recorded readings.", factRefs: ["fact-1", "fact-2", "fact-3"] },
      },
    },
    DRAFT_NEUTRAL_INQUIRY: {
      inputRefsUsed: ["fact-1", "option-1", "option-2"],
      payload: {
        observation: { text: "You recorded 3 entries at this time.", factRefs: ["fact-1"] },
        question: { text: "Is the recorded time correct?" },
        optionLabels: [
          { optionRef: "option-1", label: "Yes" },
          { optionRef: "option-2", label: "No" },
        ],
      },
    },
    ANSWER_BOUNDED_RECORD_QUERY: {
      inputRefsUsed: ["record-1", "fact-1", "fact-2"],
      payload: { segments: [{ text: "On 1 Oct 2026 you recorded 6.2 mmol/L.", recordRefs: ["record-1"] }] },
    },
    DRAFT_CARE_PREPARATION_SUMMARY: {
      inputRefsUsed: ["section-1", "section-2", "fact-1", "fact-2"],
      payload: {
        sections: [
          { sectionRef: "section-1", bullets: [{ text: "A reading of 6.2 mmol/L was recorded.", factRefs: ["fact-1"] }] },
          { sectionRef: "section-2", bullets: [{ text: "Can I keep the pen in my bag? (demo)", factRefs: ["fact-2"] }] },
        ],
      },
    },
    PHRASE_NON_CLINICAL_RESPONSE: {
      inputRefsUsed: [],
      payload: { message: { text: "Your entry is saved.", factRefs: [] } },
    },
  };
  return structuredClone({ schemaVersion: SCHEMA_VERSION(taskType), taskType, outcome: "SUCCESS", locale: "en-SG", ...byTask[taskType] });
}

export function abstainFixture(taskType: AiTaskType): Record<string, unknown> {
  return { schemaVersion: SCHEMA_VERSION(taskType), taskType, outcome: "ABSTAIN", locale: "en-SG", inputRefsUsed: [], abstentionReason: "INSUFFICIENT_CONTEXT" };
}

// --- AI invocation audit rows (storage-backup-spec 2.7) ---

const AUDIT_REQUEST_ID = "6f1c2b9a-4d3e-4f5a-8b7c-1d2e3f4a5b6c";
export const AUDIT_FIXTURE_REVISION = { recordType: "GLUCOSE_READING", recordId: "0b7e1f7a-1c2d-4e3f-8a9b-0c1d2e3f4a51", revisionId: "0b7e1f7a-1c2d-4e3f-8a9b-0c1d2e3f4a52" } as const;

export const auditComponentsFixture = (name: string, locale = "en-sg") => ({
  capabilityProfile: { id: `ai-capability.${name}`, version: "11a.1" },
  promptTemplate: { id: `ai-prompt.${name}`, version: "11a.1-absent" },
  inputSchema: { id: `ai-input.${name}`, version: "11a.1" },
  outputSchema: { id: `ai-output.${name}`, version: "11a.1" },
  validatorProfile: { id: `ai-validator.${name}`, version: "11a.1" },
  localePack: { id: `ai-locale.${name}.${locale}`, version: "11a.1" },
  fallbackProfile: { id: `ai-fallback.${name}`, version: "11a.1" },
  fixtureSet: { id: `ai-fixtures.${name}`, version: "11a.1" },
});

/** A pre-transmission deterministic outcome: no provider, no attempt and no patient reference. */
export const deterministicAuditRowFixture = () => ({
  requestId: AUDIT_REQUEST_ID,
  taskType: "EXPLAIN_PATTERN",
  locale: "en-SG",
  requestedAt: "2026-10-04T08:00:00.000Z",
  completedAt: "2026-10-04T08:00:00.010Z",
  outcomeCode: "TASK_DISABLED",
  routeProfileKey: "deterministic-only.11a.1",
  runtimeBundleKey: "ai.explain-pattern@11a.1",
  activationManifestVersion: "ai-activation.11a.1",
  components: auditComponentsFixture("explain-pattern"),
  logicalTier: "LIGHT",
  providerModel: null,
  attempts: { count: 0, structuralRepairUsed: false, timedOut: false },
  measurements: { inputTokens: null, outputTokens: null, latencyMs: 10, costMicroUsd: null },
  sourceRevisions: [],
  downstream: null,
});

/** A remote outcome as 11B will write it: exact model snapshot, bounded measurements and local sources. */
export const acceptedCareAuditRowFixture = () => ({
  ...deterministicAuditRowFixture(),
  requestId: "7c2d3e4f-5a6b-4c7d-9e8f-0a1b2c3d4e5f",
  taskType: "DRAFT_CARE_PREPARATION_SUMMARY",
  outcomeCode: "ACCEPTED",
  routeProfileKey: "kie-synthetic.11b.1",
  runtimeBundleKey: "ai.draft-care-preparation-summary@11b.1",
  components: auditComponentsFixture("draft-care-preparation-summary"),
  logicalTier: "BALANCED",
  providerModel: { providerKey: "kie", modelSnapshot: "example-model-2026-09-30" },
  attempts: { count: 1, structuralRepairUsed: false, timedOut: false },
  measurements: { inputTokens: 1200, outputTokens: 300, latencyMs: 4200, costMicroUsd: 900 },
  sourceRevisions: [AUDIT_FIXTURE_REVISION],
  downstream: { recordType: "CARE_SUMMARY_SNAPSHOT", recordId: "0b7e1f7a-1c2d-4e3f-8a9b-0c1d2e3f4a59", revisionId: "0b7e1f7a-1c2d-4e3f-8a9b-0c1d2e3f4a5a" },
});


/** A transmitted EXPLAIN_PATTERN audit naming exact local sources (no downstream: the result is transient). */
export const explainAuditRowFixture = (requestId: string, sourceRevisions: ReadonlyArray<{ recordType: string; recordId: string; revisionId: string }>) => ({
  ...acceptedCareAuditRowFixture(),
  requestId,
  taskType: "EXPLAIN_PATTERN",
  routeProfileKey: "kie-synthetic.11b.1",
  runtimeBundleKey: "ai.explain-pattern@11b.1",
  components: auditComponentsFixture("explain-pattern"),
  logicalTier: "LIGHT",
  sourceRevisions: sourceRevisions.map(({ recordType, recordId, revisionId }) => ({ recordType, recordId, revisionId })),
  downstream: null,
});

/**
 * Packet 11C Addendum C (C5): the fixtures above are LEGACY rows (audit schema ai-invocation-audit.11a.1, which carries no version
 * field), exactly as Packet 11A–11C CP5 wrote them and as existing backups hold them. This returns the same row as a CURRENT
 * (ai-invocation-audit.11c.2) row: the explicit schema version and the usage basis (NONE when nothing was sent).
 */
export const currentAuditRowFixture = <T extends { attempts: { count: number } }>(row: T, usageBasis?: "NONE" | "REPORTED" | "UPPER_BOUND") => ({
  auditSchemaVersion: "ai-invocation-audit.11c.2",
  ...row,
  usageBasis: usageBasis ?? (row.attempts.count === 0 ? "NONE" : "REPORTED"),
});
