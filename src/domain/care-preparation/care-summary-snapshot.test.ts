import { describe, expect, it } from "vitest";
import {
  CARE_SUMMARY_MAX_SELECTIONS,
  careSummarySnapshotPayloadSchema,
  careSummarySnapshotRevisionSchema,
  type CareSummaryBlock,
  type CareSummarySnapshotPayload,
} from "./care-summary-snapshot";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ref = (recordType: string, n: number) => ({ recordType, recordId: id(n), revisionId: id(n + 1000) }) as never;
const HASH = "a".repeat(64);
const START = "2026-09-04T16:00:00.000Z";
const END = "2026-10-04T16:00:00.000Z";
const AS_OF = "2026-10-04T02:00:00.000Z";
const GLUCOSE = ref("GLUCOSE_READING", 1);
const QUESTION = ref("CARE_QUESTION", 2);
const APPOINTMENT = ref("APPOINTMENT", 3);

function glucoseBlock(blockId = "fact.glucose", source = GLUCOSE): CareSummaryBlock {
  return {
    kind: "RECORDED_FACT",
    blockId,
    temporalRole: "DURING_SELECTED_PERIOD",
    sourceRevisions: [source],
    factBindings: [
      { kind: "DECIMAL_VALUE", bindingKey: `${blockId}.1.value`, source, sourceField: "MEASUREMENT_VALUE", value: "6.6" as never, unit: { kind: "STANDARD", code: "MMOL_L" } },
      { kind: "TIME_POINT", bindingKey: `${blockId}.1.time`, source, sourceField: "OCCURRENCE_TIME", value: { kind: "EXACT", instantUtc: "2026-10-03T13:00:00.000Z" as never, timeZoneId: "Asia/Singapore" as never, utcOffsetMinutes: 480 } },
    ],
    renderedText: "3 Oct 2026, 9:00 pm · 6.6 mmol/L",
  };
}

function payload(overrides: Partial<CareSummarySnapshotPayload> = {}, factBlocks: CareSummaryBlock[] = [glucoseBlock()]): CareSummarySnapshotPayload {
  const purpose = { kind: "UPCOMING_APPOINTMENT" as const, appointment: APPOINTMENT };
  const selectedPeriod = { startAt: START as never, endAtExclusive: END as never };
  return {
    status: "PREPARED",
    purpose,
    conditionScope: [],
    selectedPeriod,
    asOf: AS_OF as never,
    locale: "en-SG",
    selection: { includedSourceRevisions: [APPOINTMENT, GLUCOSE, QUESTION], excludedCandidates: [] },
    sections: [
      { sectionId: "SUMMARY_SCOPE", titleLocaleAssetId: "care-summary.scope", displayOrder: 0, blocks: [{ kind: "SUMMARY_SCOPE", blockId: "scope", temporalRole: "NOT_APPLICABLE", purpose, conditionScope: [], selectedPeriod, asOf: AS_OF as never, localeAssetId: "care-summary.scope", renderedText: "5 Sept 2026 – 4 Oct 2026" }] },
      { sectionId: "MEASUREMENTS", titleLocaleAssetId: "care-summary.measurements", displayOrder: 1, blocks: factBlocks },
      { sectionId: "QUESTIONS_FOR_CARE_TEAM", titleLocaleAssetId: "care-summary.questions", displayOrder: 2, blocks: [{ kind: "PATIENT_QUESTION", blockId: "question.1", temporalRole: "CURRENT", question: QUESTION, originalPatientText: { text: "可以把笔放在包里吗？", language: "zh-SG" } }] },
      { sectionId: "DATA_LIMITATIONS", titleLocaleAssetId: "care-summary.limitations", displayOrder: 3, blocks: [{ kind: "SUMMARY_LIMITATION", blockId: "limitation.selected", temporalRole: "NOT_APPLICABLE", limitationCode: "SELECTED_RECORDS_ONLY", relatedSources: [], localeAssetId: "care-summary.selected-only", renderedText: "This summary contains only the records and questions you selected." }] },
    ],
    limitations: [{ code: "SELECTED_RECORDS_ONLY", relatedSources: [], blockId: "limitation.selected" }],
    composition: { method: "DETERMINISTIC", templateVersion: "care-summary-template.9c.1" },
    rendering: { rendererVersion: "care-summary-renderer.9c.1", localePackVersion: "care-summary-locale.9c.1", contentHash: HASH as never },
    patientApproval: { state: "NOT_APPROVED" },
    ...overrides,
  } as CareSummarySnapshotPayload;
}

const issuesOf = (value: unknown) => {
  const result = careSummarySnapshotPayloadSchema.safeParse(value);
  return result.success ? [] : [...new Set(result.error.issues.map((issue) => issue.message))].sort();
};

describe("care-summary snapshot payload", () => {
  it("accepts an exact, source-closed, deterministic snapshot", () => {
    expect(issuesOf(payload())).toEqual([]);
  });

  it("rejects an inverted or longer-than-180-day period", () => {
    expect(issuesOf(payload({ selectedPeriod: { startAt: END as never, endAtExclusive: START as never } }))).toContain("SUMMARY_PERIOD_INVALID");
    expect(issuesOf(payload({ selectedPeriod: { startAt: "2026-01-01T00:00:00.000Z" as never, endAtExclusive: END as never } }))).toContain("SUMMARY_PERIOD_TOO_LONG");
  });

  it("rejects an empty selection and more than 32 selected facts or questions", () => {
    expect(issuesOf(payload({ selection: { includedSourceRevisions: [], excludedCandidates: [] } }))).toContain("SUMMARY_SELECTION_EMPTY");
    const many = Array.from({ length: CARE_SUMMARY_MAX_SELECTIONS + 1 }, (_, index) => ref("GLUCOSE_READING", 100 + index));
    const blocks = many.map((source, index) => glucoseBlock(`fact.g${index}`, source));
    const tooMany = payload({ selection: { includedSourceRevisions: [APPOINTMENT, QUESTION, ...many], excludedCandidates: [] } }, blocks);
    expect(issuesOf(tooMany)).toContain("SUMMARY_SELECTION_TOO_LARGE");
  });

  it("rejects duplicate or overlapping included and excluded revisions", () => {
    expect(issuesOf(payload({ selection: { includedSourceRevisions: [APPOINTMENT, GLUCOSE, QUESTION, GLUCOSE], excludedCandidates: [] } }))).toContain("SUMMARY_SELECTION_OVERLAP");
    expect(issuesOf(payload({ selection: { includedSourceRevisions: [APPOINTMENT, GLUCOSE, QUESTION], excludedCandidates: [{ source: GLUCOSE, reason: "PATIENT_EXCLUDED" }] } }))).toContain("SUMMARY_SELECTION_OVERLAP");
  });

  it("rejects a block or binding that uses an unselected source", () => {
    const other = ref("GLUCOSE_READING", 9);
    expect(issuesOf(payload({}, [glucoseBlock("fact.glucose", other)]))).toContain("SUMMARY_SOURCE_NOT_SELECTED");
    const block = glucoseBlock();
    if (block.kind !== "RECORDED_FACT") throw new Error("fact");
    const mismatched = { ...block, factBindings: [{ ...block.factBindings[0]!, source: QUESTION }] };
    expect(issuesOf(payload({}, [mismatched as CareSummaryBlock]))).toContain("SUMMARY_BINDING_MISMATCH");
  });

  it("requires exactly one scope block equal to the snapshot metadata", () => {
    const base = payload();
    const changedScope = { ...base, asOf: "2026-10-04T03:00:00.000Z" as never };
    expect(issuesOf(changedScope)).toContain("SUMMARY_SECTION_INVALID");
  });

  it("rejects reordered, misplaced or missing mandatory sections", () => {
    const base = payload();
    expect(issuesOf({ ...base, sections: [base.sections[1], base.sections[0], base.sections[2], base.sections[3]] })).toContain("SUMMARY_SECTION_INVALID");
    expect(issuesOf({ ...base, sections: base.sections.slice(0, 3) })).toContain("SUMMARY_SECTION_INVALID");
  });

  it("requires the selected-records-only limitation and an exact limitations section", () => {
    const base = payload();
    const withoutSelected = { ...base, limitations: [{ code: "MISSING_OR_UNRECORDED_DATA" as const, relatedSources: [], blockId: "limitation.selected" }] };
    expect(issuesOf(withoutSelected)).toContain("SUMMARY_REQUIRED_LIMITATION_MISSING");
  });

  it("binds approval to the exact rendering hash and blocks an invalidated approval from being actionable", () => {
    expect(issuesOf(payload({ status: "APPROVED", patientApproval: { state: "APPROVED", approvedAt: AS_OF as never, approvedContentHash: HASH as never } }))).toEqual([]);
    expect(issuesOf(payload({ status: "APPROVED", patientApproval: { state: "APPROVED", approvedAt: AS_OF as never, approvedContentHash: "b".repeat(64) as never } }))).toContain("SUMMARY_CONTENT_HASH_MISMATCH");
    expect(issuesOf(payload({ status: "APPROVED" }))).toContain("SUMMARY_CONTENT_HASH_MISMATCH");
    expect(issuesOf(payload({ status: "INVALIDATED" }))).toContain("SUMMARY_INVALIDATED_FOR_EXPORT");
    // An invalidated snapshot may keep its earlier approval only as history.
    expect(issuesOf(payload({ status: "INVALIDATED", invalidation: { invalidatedAt: AS_OF as never, reason: "SOURCE_CORRECTED" }, patientApproval: { state: "APPROVED", approvedAt: AS_OF as never, approvedContentHash: HASH as never } }))).toEqual([]);
  });

  it("allows only en-SG and zh-SG and only deterministic composition", () => {
    expect(issuesOf({ ...payload(), locale: "ms-SG" })).toContain("SUMMARY_LOCALE_INVALID");
    expect(careSummarySnapshotPayloadSchema.safeParse({ ...payload(), composition: { method: "AI_ASSISTED", templateVersion: "x" } }).success).toBe(false);
  });
});

describe("care-summary snapshot revision", () => {
  const revision = (overrides: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    recordType: "CARE_SUMMARY_SNAPSHOT",
    recordId: id(50),
    revisionId: id(51),
    revisionNumber: 1,
    previousRevisionId: null,
    action: "CREATE",
    recordedAt: AS_OF,
    revisionCreatedAt: AS_OF,
    temporal: { kind: "ATEMPORAL" },
    provenance: { sourceKind: "SYSTEM_DERIVATION", captureMethod: "RULE_ENGINE", initiator: "JAGAON_SYSTEM", assistance: "NONE" },
    auditEventId: id(52),
    transactionId: id(53),
    payload: payload(),
    ...overrides,
  });

  it("begins PREPARED as a system derivation", () => {
    expect(careSummarySnapshotRevisionSchema.safeParse(revision()).success).toBe(true);
    expect(careSummarySnapshotRevisionSchema.safeParse(revision({ payload: payload({ status: "PREVIEWED" }) })).success).toBe(false);
    expect(careSummarySnapshotRevisionSchema.safeParse(revision({ provenance: { sourceKind: "PATIENT_ENTRY", captureMethod: "FORM", initiator: "PATIENT", assistance: "NONE" } })).success).toBe(false);
    expect(careSummarySnapshotRevisionSchema.safeParse(revision({ provenance: { sourceKind: "SYSTEM_DERIVATION", captureMethod: "RULE_ENGINE", initiator: "JAGAON_SYSTEM", assistance: "AI_ASSISTED" } })).success).toBe(false);
  });

  it("allows lifecycle updates and system invalidation but never a correction", () => {
    expect(careSummarySnapshotRevisionSchema.safeParse(revision({ action: "UPDATE", revisionNumber: 2, previousRevisionId: id(51), revisionId: id(54), payload: payload({ status: "PREVIEWED" }) })).success).toBe(true);
    expect(careSummarySnapshotRevisionSchema.safeParse(revision({ action: "CORRECT", revisionNumber: 2, previousRevisionId: id(51), revisionId: id(54) })).success).toBe(false);
  });
});
