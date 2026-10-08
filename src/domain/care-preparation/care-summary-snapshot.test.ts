import { describe, expect, it } from "vitest";
import { AI_ORGANISABLE_SECTIONS } from "@/domain/ai/ai-task-contracts";
import { careSummaryExportPayloadSchema, careSummaryExportRevisionSchema } from "./care-summary-export";
import {
  CARE_DRAFT_NOTICE_KINDS,
  CARE_SUMMARY_AI_WORDING_SECTIONS,
  CARE_SUMMARY_MAX_SELECTIONS,
  CARE_SUMMARY_PAYLOAD_SECTION_ORDER,
  CARE_SUMMARY_SECTION_ORDER,
  CARE_SUMMARY_TEMPLATES_WITH_DRAFT_NOTICES,
  careSummaryAiReplacementIssues,
  careSummaryCompositionSchema,
  careSummaryContentOf,
  careSummaryExportProjection,
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

/**
 * Packet 11C Addendum B, Task B1a (decision 5, D3): a snapshot made under a notice template carries the applicable care-draft
 * notices as block content in its own last section, so they are inside the hashed export projection. A 9c.1 snapshot never does.
 */
describe("care-summary snapshot: care-draft notice blocks (Packet 11C B1a)", () => {
  const NOTICE_TEMPLATE = "care-summary-template.11c.1";
  const notice = (noticeKind: "QUESTIONS_IN_OWN_WORDS" | "DRAFT_NOT_SENT_OR_REVIEWED", blockId = `notice.${noticeKind.toLowerCase().replaceAll("_", "-")}`): CareSummaryBlock =>
    ({ kind: "CARE_DRAFT_NOTICE", blockId, temporalRole: "NOT_APPLICABLE", noticeKind, renderedText: `${noticeKind} text` }) as CareSummaryBlock;
  const noticeSection = (blocks: CareSummaryBlock[], displayOrder = 4) => ({ sectionId: "CARE_DRAFT_NOTICES", titleLocaleAssetId: "care-summary.section.draft-notices", displayOrder, blocks }) as CareSummarySnapshotPayload["sections"][number];
  const withNotices = (blocks: CareSummaryBlock[], template = NOTICE_TEMPLATE) => {
    const base = payload({ composition: { method: "DETERMINISTIC", templateVersion: template } });
    return { ...base, sections: [...base.sections, noticeSection(blocks)] } as CareSummarySnapshotPayload;
  };
  const withoutQuestions = (value: CareSummarySnapshotPayload) => {
    const sections = value.sections.filter((section) => section.sectionId !== "QUESTIONS_FOR_CARE_TEAM").map((section, displayOrder) => ({ ...section, displayOrder }));
    return { ...value, selection: { ...value.selection, includedSourceRevisions: [APPOINTMENT, GLUCOSE] }, sections } as CareSummarySnapshotPayload;
  };

  it("declares the notice section after DATA_LIMITATIONS, outside the AI-organisable content order, for the notice templates only", () => {
    expect(CARE_SUMMARY_PAYLOAD_SECTION_ORDER).toEqual([...CARE_SUMMARY_SECTION_ORDER, "CARE_DRAFT_NOTICES"]);
    expect(CARE_SUMMARY_SECTION_ORDER).not.toContain("CARE_DRAFT_NOTICES");
    expect(CARE_DRAFT_NOTICE_KINDS).toEqual(["QUESTIONS_IN_OWN_WORDS", "DRAFT_NOT_SENT_OR_REVIEWED"]);
    expect(CARE_SUMMARY_TEMPLATES_WITH_DRAFT_NOTICES).toEqual([NOTICE_TEMPLATE]);
  });

  it("accepts the questions notice then the draft notice with a questions section, and the draft notice alone without one", () => {
    expect(issuesOf(withNotices([notice("QUESTIONS_IN_OWN_WORDS"), notice("DRAFT_NOT_SENT_OR_REVIEWED")]))).toEqual([]);
    const noQuestions = withoutQuestions(withNotices([notice("DRAFT_NOT_SENT_OR_REVIEWED")]));
    expect(issuesOf(noQuestions)).toEqual([]);
  });

  it("requires exactly the applicable notices, in fixed order, under a notice template", () => {
    // Missing notice section, missing draft notice, wrong order, a questions notice without questions, a duplicate.
    expect(issuesOf(payload({ composition: { method: "DETERMINISTIC", templateVersion: NOTICE_TEMPLATE } }))).toContain("SUMMARY_SECTION_INVALID");
    expect(issuesOf(withNotices([notice("QUESTIONS_IN_OWN_WORDS")]))).toContain("SUMMARY_SECTION_INVALID");
    expect(issuesOf(withNotices([notice("DRAFT_NOT_SENT_OR_REVIEWED")]))).toContain("SUMMARY_SECTION_INVALID");
    expect(issuesOf(withNotices([notice("DRAFT_NOT_SENT_OR_REVIEWED"), notice("QUESTIONS_IN_OWN_WORDS")]))).toContain("SUMMARY_SECTION_INVALID");
    expect(issuesOf(withoutQuestions(withNotices([notice("QUESTIONS_IN_OWN_WORDS"), notice("DRAFT_NOT_SENT_OR_REVIEWED")])))).toContain("SUMMARY_SECTION_INVALID");
    expect(issuesOf(withNotices([notice("QUESTIONS_IN_OWN_WORDS"), notice("DRAFT_NOT_SENT_OR_REVIEWED"), notice("DRAFT_NOT_SENT_OR_REVIEWED", "notice.again")]))).toContain("SUMMARY_SECTION_INVALID");
  });

  it("never lets a 9c.1 snapshot carry notices, and keeps notices out of every other section and position", () => {
    expect(issuesOf(withNotices([notice("QUESTIONS_IN_OWN_WORDS"), notice("DRAFT_NOT_SENT_OR_REVIEWED")], "care-summary-template.9c.1"))).toContain("SUMMARY_SECTION_INVALID");
    const valid = withNotices([notice("QUESTIONS_IN_OWN_WORDS"), notice("DRAFT_NOT_SENT_OR_REVIEWED")]);
    // Notices before the limitations section, or a notice block inside the limitations section.
    const [scope, measurements, questions, limitations, notices] = valid.sections;
    expect(issuesOf({ ...valid, sections: [scope, measurements, questions, { ...notices!, displayOrder: 3 }, { ...limitations!, displayOrder: 4 }] })).toContain("SUMMARY_SECTION_INVALID");
    const mixed = { ...limitations!, blocks: [...limitations!.blocks, notice("DRAFT_NOT_SENT_OR_REVIEWED", "notice.extra")] };
    expect(issuesOf({ ...valid, sections: [scope, measurements, questions, mixed, notices] })).toContain("SUMMARY_SECTION_INVALID");
    // A notice is application wording: strict shape, no source, no extra fields.
    const extra = { ...(notice("DRAFT_NOT_SENT_OR_REVIEWED") as object), relatedSources: [GLUCOSE] } as unknown as CareSummaryBlock;
    expect(careSummarySnapshotPayloadSchema.safeParse(withNotices([notice("QUESTIONS_IN_OWN_WORDS"), extra])).success).toBe(false);
    expect(careSummarySnapshotPayloadSchema.safeParse(withNotices([notice("QUESTIONS_IN_OWN_WORDS"), { ...(notice("DRAFT_NOT_SENT_OR_REVIEWED") as object), renderedText: "" } as never])).success).toBe(false);
  });

  it("puts the notice blocks into the hashed export projection and the immutable content", () => {
    const value = withNotices([notice("QUESTIONS_IN_OWN_WORDS"), notice("DRAFT_NOT_SENT_OR_REVIEWED")]);
    const projection = careSummaryExportProjection({ ...value, rendererVersion: value.rendering.rendererVersion, localePackVersion: value.rendering.localePackVersion });
    expect(projection.sections.at(-1)!.blocks.map((block) => block.kind)).toEqual(["CARE_DRAFT_NOTICE", "CARE_DRAFT_NOTICE"]);
    expect(careSummaryContentOf(value).sections.at(-1)!.sectionId).toBe("CARE_DRAFT_NOTICES");
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

/**
 * Packet 11C Addendum B, Task B1b (original Task 1 Step 1): the composition union keeps the deterministic branch and adds exactly
 * `{ method: "AI_ASSISTED"; templateVersion; aiInvocationAuditRef; validatedAt }`. An AI-assisted snapshot uses a notice template (so its
 * notices are identical to the deterministic snapshot it replaces), records the AI assistance only on its creating revision, and may
 * differ from the snapshot it replaces only in the rendered wording of recorded-fact blocks in the AI-organisable sections.
 */
describe("care-summary snapshot: AI-assisted composition (Packet 11C B1b)", () => {
  const NOTICE_TEMPLATE = "care-summary-template.11c.1";
  const AUDIT = "11111111-1111-4111-8111-111111111111";
  const VALIDATED = "2026-10-04T02:05:00.000Z";
  const notice = (noticeKind: "QUESTIONS_IN_OWN_WORDS" | "DRAFT_NOT_SENT_OR_REVIEWED"): CareSummaryBlock =>
    ({ kind: "CARE_DRAFT_NOTICE", blockId: `notice.${noticeKind.toLowerCase().replaceAll("_", "-")}`, temporalRole: "NOT_APPLICABLE", noticeKind, renderedText: `${noticeKind} text` }) as CareSummaryBlock;
  const aiComposition = (overrides: Record<string, unknown> = {}) => ({ method: "AI_ASSISTED", templateVersion: NOTICE_TEMPLATE, aiInvocationAuditRef: AUDIT, validatedAt: VALIDATED, ...overrides });
  /** A current (11c.1) deterministic snapshot with its notices. */
  const current = (overrides: Partial<CareSummarySnapshotPayload> = {}): CareSummarySnapshotPayload => {
    const base = payload({ composition: { method: "DETERMINISTIC", templateVersion: NOTICE_TEMPLATE }, rendering: { rendererVersion: "care-summary-renderer.11c.1", localePackVersion: "care-summary-locale.11c.1", contentHash: HASH as never } });
    const notices = { sectionId: "CARE_DRAFT_NOTICES", titleLocaleAssetId: "care-summary.section.draft-notices", displayOrder: 4, blocks: [notice("QUESTIONS_IN_OWN_WORDS"), notice("DRAFT_NOT_SENT_OR_REVIEWED")] } as CareSummarySnapshotPayload["sections"][number];
    return { ...base, sections: [...base.sections, notices], ...overrides } as CareSummarySnapshotPayload;
  };
  /** The same snapshot re-worded by validated AI output: only the measurement block's rendered text changes. */
  const reworded = (from: CareSummarySnapshotPayload, text = "3 Oct 2026, 9:00 pm · A reading of 6.6 mmol/L.", overrides: Partial<CareSummarySnapshotPayload> = {}): CareSummarySnapshotPayload => ({
    ...from,
    sections: from.sections.map((section) => (section.sectionId === "MEASUREMENTS" ? { ...section, blocks: section.blocks.map((block) => ({ ...block, renderedText: text })) } : section)) as CareSummarySnapshotPayload["sections"],
    composition: aiComposition() as never,
    rendering: { ...from.rendering, contentHash: "b".repeat(64) as never },
    ...overrides,
  });

  it("keeps the deterministic branch and adds exactly method, templateVersion, aiInvocationAuditRef and validatedAt", () => {
    expect(careSummaryCompositionSchema.safeParse({ method: "DETERMINISTIC", templateVersion: NOTICE_TEMPLATE }).success).toBe(true);
    expect(careSummaryCompositionSchema.safeParse(aiComposition()).success).toBe(true);
    // Missing audit reference or validation time (unvalidated output), unknown fields, a malformed reference.
    for (const missing of ["aiInvocationAuditRef", "validatedAt", "templateVersion"]) {
      const full: Record<string, unknown> = aiComposition();
      const { [missing]: _dropped, ...rest } = full;
      expect(careSummaryCompositionSchema.safeParse(rest).success, missing).toBe(false);
    }
    expect(careSummaryCompositionSchema.safeParse(aiComposition({ model: "x" })).success).toBe(false);
    expect(careSummaryCompositionSchema.safeParse(aiComposition({ aiInvocationAuditRef: "not-a-request-id" })).success).toBe(false);
    expect(careSummaryCompositionSchema.safeParse(aiComposition({ validatedAt: "yesterday" })).success).toBe(false);
    expect(careSummaryCompositionSchema.safeParse({ method: "DETERMINISTIC", templateVersion: NOTICE_TEMPLATE, aiInvocationAuditRef: AUDIT }).success).toBe(false);
    expect(careSummaryCompositionSchema.safeParse({ ...aiComposition(), method: "AI_GENERATED" }).success).toBe(false);
  });

  it("accepts an AI-assisted payload only under a notice template and only when validated no earlier than its asOf", () => {
    const ai = reworded(current());
    expect(issuesOf(ai)).toEqual([]);
    expect(issuesOf({ ...ai, composition: aiComposition({ templateVersion: "care-summary-template.9c.1" }), sections: ai.sections.slice(0, 4) })).toContain("SUMMARY_AI_VALIDATION_MISSING");
    expect(issuesOf({ ...ai, composition: aiComposition({ validatedAt: "2026-10-04T01:59:59.999Z" }) })).toContain("SUMMARY_AI_VALIDATION_MISSING");
  });

  it("records the AI assistance on the creating revision only, never on a lifecycle revision or an export record", () => {
    const revision = (overrides: Record<string, unknown> = {}) => ({
      schemaVersion: 1,
      recordType: "CARE_SUMMARY_SNAPSHOT",
      recordId: id(60),
      revisionId: id(61),
      revisionNumber: 1,
      previousRevisionId: null,
      action: "CREATE",
      recordedAt: AS_OF,
      revisionCreatedAt: VALIDATED,
      temporal: { kind: "ATEMPORAL" },
      provenance: { sourceKind: "SYSTEM_DERIVATION", captureMethod: "RULE_ENGINE", initiator: "JAGAON_SYSTEM", assistance: "AI_ASSISTED" },
      auditEventId: id(62),
      transactionId: id(63),
      payload: reworded(current()),
      ...overrides,
    });
    const messages = (value: unknown) => {
      const result = careSummarySnapshotRevisionSchema.safeParse(value);
      return result.success ? [] : [...new Set(result.error.issues.map((issue) => issue.message))].sort();
    };
    expect(messages(revision())).toEqual([]);
    // The creating revision of an AI-assisted snapshot must say so.
    expect(messages(revision({ provenance: { sourceKind: "SYSTEM_DERIVATION", captureMethod: "RULE_ENGINE", initiator: "JAGAON_SYSTEM", assistance: "NONE" } }))).toEqual(["SUMMARY_AI_PROVENANCE_MISSING"]);
    // AI assistance without a validated AI composition (the prohibited path), or through an AI extraction path.
    expect(messages(revision({ payload: current() }))).toEqual(["SUMMARY_AI_VALIDATION_MISSING"]);
    expect(messages(revision({ provenance: { sourceKind: "SYSTEM_DERIVATION", captureMethod: "AI_EXTRACTION", initiator: "JAGAON_SYSTEM", assistance: "AI_ASSISTED" } }))).toContain("SUMMARY_REQUIRES_SYSTEM_DERIVATION");
    // A lifecycle revision (preview, approval, invalidation, supersession) is never AI-assisted, even for an AI-assisted snapshot.
    const update = { action: "UPDATE", revisionNumber: 2, previousRevisionId: id(61), revisionId: id(64), payload: reworded(current(), undefined, { status: "PREVIEWED" }) };
    expect(messages(revision({ ...update, provenance: { sourceKind: "SYSTEM_DERIVATION", captureMethod: "RULE_ENGINE", initiator: "JAGAON_SYSTEM", assistance: "NONE" } }))).toEqual([]);
    expect(messages(revision(update))).toEqual(["AI_ASSISTANCE_NOT_PERMITTED"]);
    // An export record never carries AI assistance (domain 11.8; pinned here beside the composition branch).
    const exportRevision = {
      schemaVersion: 1,
      recordType: "CARE_SUMMARY_EXPORT",
      recordId: id(70),
      revisionId: id(71),
      revisionNumber: 1,
      previousRevisionId: null,
      action: "CREATE",
      recordedAt: AS_OF,
      revisionCreatedAt: AS_OF,
      temporal: { kind: "ATEMPORAL" },
      provenance: { sourceKind: "PATIENT_ENTRY", captureMethod: "FORM", initiator: "PATIENT", assistance: "AI_ASSISTED" },
      auditEventId: id(72),
      transactionId: id(73),
      payload: { snapshot: { recordType: "CARE_SUMMARY_SNAPSHOT", recordId: id(60), revisionId: id(61) }, approvedContentHash: HASH, method: "PRINT_DIALOG", artifactFormat: "PRINTABLE_DOCUMENT", requestedAt: AS_OF, outcome: { state: "REQUESTED" }, externalConfirmation: { state: "NONE" }, replacesExports: [] },
    };
    const exported = careSummaryExportRevisionSchema.safeParse(exportRevision);
    expect(exported.success ? [] : exported.error.issues.map((issue) => issue.message)).toContain("AI_ASSISTANCE_NOT_PERMITTED");
    expect(careSummaryExportPayloadSchema.safeParse({ ...exportRevision.payload, composition: aiComposition() }).success).toBe(false);
  });

  it("names the AI-wording sections exactly as the AI-organisable sections", () => {
    expect(CARE_SUMMARY_AI_WORDING_SECTIONS).toEqual(AI_ORGANISABLE_SECTIONS);
    expect(CARE_SUMMARY_AI_WORDING_SECTIONS).not.toContain("SUMMARY_SCOPE");
    expect(CARE_SUMMARY_AI_WORDING_SECTIONS).not.toContain("DATA_LIMITATIONS");
    expect(CARE_SUMMARY_AI_WORDING_SECTIONS).not.toContain("SAFETY_HISTORY");
    expect(CARE_SUMMARY_AI_WORDING_SECTIONS).not.toContain("CARE_DRAFT_NOTICES");
  });

  it("allows a replacement to change only the rendered wording of recorded-fact blocks in the AI-organisable sections", () => {
    const from = current();
    expect(careSummaryAiReplacementIssues(from, reworded(from))).toEqual([]);
    const edit = (mutate: (value: CareSummarySnapshotPayload) => void) => {
      const value = structuredClone(reworded(from));
      mutate(value);
      return careSummaryAiReplacementIssues(from, value);
    };
    const factBlock = (value: CareSummarySnapshotPayload) => value.sections[1]!.blocks[0] as Extract<CareSummaryBlock, { kind: "RECORDED_FACT" }>;
    // Values, sources, questions, limitations, notices, scope, selection, purpose, period, locale: all must be identical.
    expect(edit((value) => ((factBlock(value).factBindings[0] as { value: string }).value = "6.7"))).toEqual(["AI_REPLACEMENT_CONTENT_CHANGED"]);
    expect(edit((value) => (factBlock(value).temporalRole = "CURRENT"))).toEqual(["AI_REPLACEMENT_CONTENT_CHANGED"]);
    expect(edit((value) => ((value.sections[2]!.blocks[0] as { originalPatientText: { text: string } }).originalPatientText.text = "rewritten"))).toEqual(["AI_REPLACEMENT_CONTENT_CHANGED"]);
    expect(edit((value) => ((value.sections[3]!.blocks[0] as { renderedText: string }).renderedText = "softened"))).toEqual(["AI_REPLACEMENT_CONTENT_CHANGED"]);
    expect(edit((value) => ((value.sections[4]!.blocks[1] as { renderedText: string }).renderedText = "changed notice"))).toEqual(["AI_REPLACEMENT_CONTENT_CHANGED"]);
    expect(edit((value) => ((value.sections[0]!.blocks[0] as { renderedText: string }).renderedText = "changed scope"))).toEqual(["AI_REPLACEMENT_CONTENT_CHANGED"]);
    expect(edit((value) => value.selection.excludedCandidates.push({ source: ref("GLUCOSE_READING", 7), reason: "PATIENT_EXCLUDED" }))).toEqual(["AI_REPLACEMENT_CONTENT_CHANGED"]);
    expect(edit((value) => (value.purpose = { kind: "ROUTINE_REVIEW" }))).toEqual(["AI_REPLACEMENT_CONTENT_CHANGED"]);
    expect(edit((value) => (value.locale = "zh-SG"))).toEqual(["AI_REPLACEMENT_CONTENT_CHANGED"]);
    expect(edit((value) => (value.limitations[0]!.blockId = "limitation.other"))).toEqual(["AI_REPLACEMENT_CONTENT_CHANGED"]);
    expect(edit((value) => (value.sections[1]!.titleLocaleAssetId = "care-summary.other"))).toEqual(["AI_REPLACEMENT_CONTENT_CHANGED"]);
    expect(edit((value) => (value.sections = value.sections.slice(0, 4) as never))).toEqual(["AI_REPLACEMENT_CONTENT_CHANGED"]);
    expect(edit((value) => (value.rendering.localePackVersion = "care-summary-locale.9c.1"))).toEqual(["AI_REPLACEMENT_CONTENT_CHANGED"]);
    // A new content hash and an actual wording change are required; the result is a fresh, unapproved PREPARED snapshot.
    expect(careSummaryAiReplacementIssues(from, reworded(from, factBlock(from).renderedText, { rendering: from.rendering }))).toEqual(["AI_REPLACEMENT_WORDING_UNCHANGED"]);
    expect(edit((value) => (value.status = "PREVIEWED"))).toEqual(["AI_REPLACEMENT_LIFECYCLE_INVALID"]);
    expect(edit((value) => (value.replacesSnapshot = { recordType: "CARE_SUMMARY_SNAPSHOT", recordId: id(80), revisionId: id(81) } as never))).toEqual([]);
    // Only from a deterministic snapshot, only into a validated AI composition under the same template.
    expect(edit((value) => (value.composition = { method: "DETERMINISTIC", templateVersion: NOTICE_TEMPLATE }))).toEqual(["AI_REPLACEMENT_COMPOSITION_INVALID"]);
    expect(edit((value) => (value.composition = aiComposition({ templateVersion: "care-summary-template.9c.1" }) as never))).toEqual(["AI_REPLACEMENT_COMPOSITION_INVALID"]);
    expect(careSummaryAiReplacementIssues(reworded(from), reworded(from, "3 Oct 2026, 9:00 pm · Another reading of 6.6 mmol/L.", { rendering: { ...from.rendering, contentHash: "d".repeat(64) as never } }))).toEqual(["AI_REPLACEMENT_SOURCE_NOT_DETERMINISTIC"]);
  });
});
