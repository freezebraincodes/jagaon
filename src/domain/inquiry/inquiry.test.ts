import { describe, expect, it } from "vitest";
import {
  INQUIRY_DEFINITION_REGISTRY,
  INQUIRY_SURFACE_DISPOSITIONS,
  enabledInquiryDefinitions,
  findInquiryDefinition,
  inquiryEligibilityAssessmentSchema,
  inquiryPayloadSchema,
  inquiryQueueDecisionSchema,
  inquiryRevisionSchema,
  validateInquiryTransition,
  type InquiryRevision,
} from "./index";
import {
  IDS,
  SYSTEM_PROVENANCE,
  PATIENT_INQUIRY_PROVENANCE,
  T0,
  allDimensions,
  allFactors,
  barrierPayload,
  barrierPresentation,
  inquiryRevision,
} from "./inquiry-test-fixtures";

const issues = (result: { success: boolean; error?: { issues: { message: string }[] } }) =>
  result.success ? [] : result.error!.issues.map((issue) => issue.message);

describe("closed Inquiry definition registry", () => {
  it("enables exactly MEDICATION_OCCASION_BARRIER_V1 and disables every other definition explicitly", () => {
    expect(enabledInquiryDefinitions().map((d) => d.definitionKey)).toEqual(["MEDICATION_OCCASION_BARRIER_V1"]);
    const dispositions = Object.fromEntries(INQUIRY_DEFINITION_REGISTRY.map((d) => [d.definitionKey, d.disposition.kind]));
    expect(dispositions).toEqual({
      MEDICATION_OCCASION_BARRIER_V1: "ENABLED",
      PATTERN_CONTEXT_V1: "DISABLED_NOT_IMPLEMENTED",
      PRESCRIPTION_SCHEDULE_RECONCILIATION_V1: "DISABLED_NOT_IMPLEMENTED",
      RECORD_TIME_CLARIFICATION_V1: "DISABLED_NOT_IMPLEMENTED",
      PROGRESSIVE_ROUTINE_LEARNING_V1: "DISABLED_NOT_IMPLEMENTED",
      RECURRING_BARRIER_CONFIRMATION_V1: "DISABLED_NOT_IMPLEMENTED",
      CARE_QUESTION_PREPARATION_V1: "DISABLED_PRODUCT_SCOPE",
      CURRENT_MEDICATION_ACTION_V1: "DISABLED_PRODUCT_SCOPE",
      SYMPTOM_FOLLOW_UP_V1: "DISABLED_PRODUCT_SCOPE",
    });
    expect(new Set(INQUIRY_DEFINITION_REGISTRY.map((d) => d.definitionKey)).size).toBe(INQUIRY_DEFINITION_REGISTRY.length);
    expect(Object.isFrozen(INQUIRY_DEFINITION_REGISTRY)).toBe(true);
  });

  it("gives disabled definitions no template, option or answer contract", () => {
    for (const definition of INQUIRY_DEFINITION_REGISTRY) {
      if (definition.disposition.kind === "ENABLED") continue;
      expect(Object.keys(definition).sort()).toEqual(["definitionKey", "definitionVersion", "disposition", "purpose"]);
    }
  });

  it("maps every reviewed option to one fixed semantic value and uses the dialog surface only", () => {
    const barrier = enabledInquiryDefinitions()[0]!;
    expect(barrier.reviewedOptions.map((o) => o.optionKey)).toEqual(barrier.answerContract.optionKeys);
    expect(new Set(barrier.reviewedOptions.map((o) => o.semanticValueKey)).size).toBe(5);
    expect(barrier.aiWordingPermitted).toBe(false);
    expect(barrier.surfaces).toEqual(["DIALOG"]);
    expect(INQUIRY_SURFACE_DISPOSITIONS.CONVERSATIONAL_MESSAGE.kind).toBe("DISABLED_PRODUCT_SCOPE");
  });

  it("resolves only registered definition versions", () => {
    expect(findInquiryDefinition("MEDICATION_OCCASION_BARRIER_V1", "2")).toBeNull();
    expect(findInquiryDefinition("UNKNOWN_V1", "1")).toBeNull();
  });
});

describe("INQUIRY payload", () => {
  it("accepts a barrier candidate whose purpose, basis and contract agree with the definition", () => {
    expect(inquiryPayloadSchema.safeParse(barrierPayload()).success).toBe(true);
  });

  it("rejects an unknown definition, a disagreeing purpose, an altered contract or a foreign basis type", () => {
    expect(issues(inquiryPayloadSchema.safeParse({ ...barrierPayload(), definition: { definitionKey: "MADE_UP_V1", definitionVersion: "1" } }))).toContain(
      "UNKNOWN_DEFINITION",
    );
    expect(
      issues(inquiryPayloadSchema.safeParse({ ...barrierPayload(), basis: { purpose: "RECONCILIATION", records: [barrierPayload().basis.records[0]] } })),
    ).toContain("PURPOSE_DISAGREES_WITH_DEFINITION");
    expect(
      issues(inquiryPayloadSchema.safeParse({ ...barrierPayload(), answerContract: { ...barrierPayload().answerContract, allowPreferNotToSay: false } })),
    ).toContain("ANSWER_CONTRACT_DISAGREES_WITH_DEFINITION");
    const glucose = { recordType: "GLUCOSE_READING", recordId: IDS.event, revisionId: IDS.eventRev };
    expect(issues(inquiryPayloadSchema.safeParse({ ...barrierPayload(), basis: { purpose: "RECORD_CLARIFICATION", records: [glucose] } }))).toContain(
      "BASIS_RECORD_TYPE_NOT_PERMITTED",
    );
  });

  it("requires duplicate-free exact basis references", () => {
    const ref = barrierPayload().basis.records[0];
    expect(inquiryPayloadSchema.safeParse({ ...barrierPayload(), basis: { purpose: "RECORD_CLARIFICATION", records: [ref, ref] } }).success).toBe(false);
  });

  it("represents every approved purpose and answer-contract variant at the contract level", () => {
    const ref = { recordType: "MEDICATION_EVENT", recordId: IDS.event, revisionId: IDS.eventRev };
    const pattern = {
      purpose: "PATTERN_CONTEXT",
      observation: { recordType: "PATTERN_OBSERVATION", recordId: IDS.event, revisionId: IDS.eventRev },
      evidenceSnapshot: { recordType: "PATTERN_EVIDENCE_SNAPSHOT", recordId: IDS.inquiry, revisionId: IDS.inquiryRev1 },
    };
    const bases = [
      pattern,
      { purpose: "RECONCILIATION", records: [ref] },
      { purpose: "RECORD_CLARIFICATION", records: [ref] },
      { purpose: "PROGRESSIVE_LEARNING", operationalNeed: "usual-breakfast-time", relatedRecords: [] },
      { purpose: "CARE_PREPARATION", basis: [ref] },
    ];
    for (const purpose of bases) {
      const definition = INQUIRY_DEFINITION_REGISTRY.find((d) => d.purpose === purpose.purpose && d.disposition.kind !== "ENABLED")!;
      const payload = {
        ...barrierPayload(),
        definition: { definitionKey: definition.definitionKey, definitionVersion: definition.definitionVersion },
        basis: purpose,
      };
      expect(inquiryPayloadSchema.safeParse(payload).success, purpose.purpose).toBe(true);
    }
    const contracts = [
      { kind: "CONFIRMATION_WITH_CORRECTION", allowNotSure: true },
      { kind: "STATUS_RECONCILIATION", optionKeys: ["FORGOT"], allowNotSure: true, allowPreferNotToSay: false },
      { kind: "DATE_OR_RANGE", allowSingleDate: true, allowRange: false, allowNotSure: true, allowPreferNotToSay: true },
      { kind: "OPTIONAL_SHORT_TEXT", maximumCodePoints: 200, allowNotSure: true, allowPreferNotToSay: true },
      { kind: "CARE_QUESTION_BUILDER", allowShortText: true },
    ];
    const disabled = { definitionKey: "PATTERN_CONTEXT_V1", definitionVersion: "1" };
    for (const contract of contracts) {
      expect(inquiryPayloadSchema.safeParse({ ...barrierPayload(), definition: disabled, basis: pattern, answerContract: contract }).success, contract.kind).toBe(true);
    }
    expect(
      inquiryPayloadSchema.safeParse({
        ...barrierPayload(),
        definition: disabled,
        basis: pattern,
        answerContract: { kind: "DATE_OR_RANGE", allowSingleDate: false, allowRange: false, allowNotSure: true, allowPreferNotToSay: true },
      }).success,
    ).toBe(false);
  });

  it("represents every lifecycle variant", () => {
    const ref = (type: string) => ({ recordType: type, recordId: IDS.response, revisionId: IDS.responseRev1 });
    const presentedRef = { recordType: "INQUIRY", recordId: IDS.inquiry, revisionId: IDS.inquiryRev1 };
    const lifecycles = [
      { state: "CANDIDATE" },
      { state: "ELIGIBLE", assessment: { evaluatedAt: T0, ruleVersion: "barrier-eligibility.1", dimensions: allDimensions(), outcome: "ELIGIBLE" } },
      {
        state: "QUEUED",
        eligibility: { evaluatedAt: T0, ruleVersion: "barrier-eligibility.1", dimensions: allDimensions(), outcome: "ELIGIBLE" },
        decision: { evaluatedAt: T0, priorityRuleVersion: "p.1", interruptionBudgetVersion: "b.1", factors: allFactors(), outcome: "QUEUED" },
      },
      { state: "PRESENTED", presentation: barrierPresentation() },
      { state: "ANSWERED", response: ref("INQUIRY_RESPONSE") },
      { state: "NOT_SURE", response: ref("INQUIRY_RESPONSE") },
      { state: "DECLINED", response: ref("INQUIRY_RESPONSE") },
      { state: "SNOOZED", presentedRevision: presentedRef, presentationKey: "p-1", snoozedAt: T0, eligibleAgainAt: "2026-10-03T13:00:00.000Z" },
      { state: "DISMISSED", presentedRevision: presentedRef, presentationKey: "p-1", dismissedAt: T0 },
      { state: "EXPIRED", expiredAt: T0, reason: "TIME_RELEVANCE_ENDED" },
      { state: "SUPERSEDED", replacement: presentedRef },
      { state: "WITHDRAWN", withdrawnAt: T0, reason: "EVIDENCE_CHANGED" },
    ];
    for (const lifecycle of lifecycles) {
      expect(inquiryPayloadSchema.safeParse(barrierPayload(lifecycle)).success, lifecycle.state).toBe(true);
    }
  });
});

describe("deterministic eligibility and queue evidence", () => {
  const base = { evaluatedAt: T0, ruleVersion: "barrier-eligibility.1" };

  it("requires every hard dimension exactly once and every one to pass for ELIGIBLE", () => {
    expect(inquiryEligibilityAssessmentSchema.safeParse({ ...base, dimensions: allDimensions(), outcome: "ELIGIBLE" }).success).toBe(true);
    expect(issues(inquiryEligibilityAssessmentSchema.safeParse({ ...base, dimensions: allDimensions().slice(1), outcome: "INELIGIBLE" }))).toContain(
      "EVERY_DIMENSION_EXACTLY_ONCE",
    );
    const indeterminate = allDimensions().map((d, i) => (i === 3 ? { ...d, outcome: "INDETERMINATE" } : d));
    expect(issues(inquiryEligibilityAssessmentSchema.safeParse({ ...base, dimensions: indeterminate, outcome: "ELIGIBLE" }))).toContain(
      "OUTCOME_DISAGREES_WITH_DIMENSIONS",
    );
  });

  it("rejects unknown reason codes and a QUEUED decision with a blocking factor", () => {
    const unknown = allDimensions().map((d) => ({ ...d, reasonCodes: ["SOUNDS_PLAUSIBLE"] }));
    expect(inquiryEligibilityAssessmentSchema.safeParse({ ...base, dimensions: unknown, outcome: "ELIGIBLE" }).success).toBe(false);
    const decision = { evaluatedAt: T0, priorityRuleVersion: "p.1", interruptionBudgetVersion: "b.1", factors: allFactors("BLOCK"), outcome: "QUEUED" };
    expect(issues(inquiryQueueDecisionSchema.safeParse(decision))).toContain("QUEUED_WITH_BLOCKING_FACTOR");
  });
});

describe("presentation contract", () => {
  it("requires the exact declared option subset and order, the deterministic template and the dialog surface", () => {
    const reordered = barrierPresentation();
    reordered.content.options.reverse();
    expect(issues(inquiryPayloadSchema.safeParse(barrierPayload({ state: "PRESENTED", presentation: reordered })))).toContain(
      "PRESENTED_OPTIONS_DISAGREE_WITH_DEFINITION",
    );
    const card = { ...barrierPresentation(), surface: "INSIGHT_CARD" };
    expect(issues(inquiryPayloadSchema.safeParse(barrierPayload({ state: "PRESENTED", presentation: card })))).toContain("SURFACE_NOT_PERMITTED");
    const chat = { ...barrierPresentation(), surface: "CONVERSATIONAL_MESSAGE" };
    expect(issues(inquiryPayloadSchema.safeParse(barrierPayload({ state: "PRESENTED", presentation: chat })))).toContain("SURFACE_DISABLED_IN_MVP");
    const ai = {
      ...barrierPresentation(),
      wordingSource: {
        kind: "VALIDATED_AI_ASSISTED",
        fallbackTemplateKey: "medication-occasion-barrier.dialog",
        fallbackTemplateVersion: "1",
        aiInvocation: "call-1",
        meaningValidatorVersion: "v1",
      },
    };
    expect(issues(inquiryPayloadSchema.safeParse(barrierPayload({ state: "PRESENTED", presentation: ai })))).toContain("WORDING_SOURCE_NOT_PERMITTED");
  });

  it("cannot present at or after the inquiry expiry", () => {
    const late = barrierPresentation("p-2", "2026-10-16T13:00:00.000Z");
    expect(issues(inquiryPayloadSchema.safeParse(barrierPayload({ state: "PRESENTED", presentation: late })))).toContain("PRESENTED_AT_OR_AFTER_EXPIRY");
  });
});

describe("INQUIRY revision and transitions", () => {
  it("binds system lifecycle states to system provenance and patient interactions to the patient", () => {
    expect(inquiryRevisionSchema.safeParse(inquiryRevision()).success).toBe(true);
    const presentedRef = { recordType: "INQUIRY", recordId: IDS.inquiry, revisionId: IDS.inquiryRev1 };
    const dismissed = inquiryRevision({
      action: "UPDATE",
      provenance: SYSTEM_PROVENANCE,
      payload: barrierPayload({ state: "DISMISSED", presentedRevision: presentedRef, presentationKey: "p-1", dismissedAt: T0 }),
    });
    expect(issues(inquiryRevisionSchema.safeParse(dismissed))).toContain("INITIATOR_DISAGREES_WITH_LIFECYCLE");
    expect(inquiryRevisionSchema.safeParse({ ...dismissed, provenance: PATIENT_INQUIRY_PROVENANCE }).success).toBe(true);
  });

  const presented = (key = "p-1") =>
    inquiryRevisionSchema.parse(
      inquiryRevision({
        revisionId: IDS.inquiryRev1,
        action: "SYSTEM_DERIVE",
        payload: barrierPayload({ state: "PRESENTED", presentation: barrierPresentation(key) }),
      }),
    ) as InquiryRevision;
  const next = (lifecycle: unknown, action = "UPDATE", provenance: unknown = PATIENT_INQUIRY_PROVENANCE) =>
    inquiryRevisionSchema.parse(
      inquiryRevision({ revisionId: IDS.inquiryRev2, revisionNumber: 2, previousRevisionId: IDS.inquiryRev1, action, provenance, payload: barrierPayload(lifecycle) }),
    ) as InquiryRevision;

  it("keeps dismissal, snooze and terminal states distinct and closes dismissal", () => {
    const presentedRef = { recordType: "INQUIRY", recordId: IDS.inquiry, revisionId: IDS.inquiryRev1 };
    const dismissed = next({ state: "DISMISSED", presentedRevision: presentedRef, presentationKey: "p-1", dismissedAt: T0 });
    expect(validateInquiryTransition(presented(), dismissed, new Set(["p-1"]))).toBeNull();
    const reopened = next({ state: "PRESENTED", presentation: barrierPresentation("p-2") }, "SYSTEM_DERIVE", SYSTEM_PROVENANCE);
    expect(validateInquiryTransition(dismissed, reopened, new Set(["p-1"]))).toBe("TRANSITION_NOT_ALLOWED");
  });

  it("rejects a reused presentation key and a snooze that does not reference the presentation", () => {
    const again = next({ state: "PRESENTED", presentation: barrierPresentation("p-1") }, "SYSTEM_DERIVE", SYSTEM_PROVENANCE);
    expect(validateInquiryTransition(presented(), again, new Set(["p-1"]))).toBe("PRESENTATION_KEY_REUSED");
    const wrong = next({
      state: "SNOOZED",
      presentedRevision: { recordType: "INQUIRY", recordId: IDS.inquiry, revisionId: IDS.inquiryRev2 },
      presentationKey: "p-1",
      snoozedAt: T0,
      eligibleAgainAt: "2026-10-03T13:00:00.000Z",
    });
    expect(validateInquiryTransition(presented(), wrong, new Set(["p-1"]))).toBe("SNOOZE_DOES_NOT_REFERENCE_PRESENTATION");
  });

  it("does not let a snoozed inquiry jump straight back to PRESENTED", () => {
    const presentedRef = { recordType: "INQUIRY", recordId: IDS.inquiry, revisionId: IDS.inquiryRev1 };
    const snoozed = next({ state: "SNOOZED", presentedRevision: presentedRef, presentationKey: "p-1", snoozedAt: T0, eligibleAgainAt: "2026-10-03T13:00:00.000Z" });
    const shown = next({ state: "PRESENTED", presentation: barrierPresentation("p-2", "2026-10-04T00:00:00.000Z") }, "SYSTEM_DERIVE", SYSTEM_PROVENANCE);
    expect(validateInquiryTransition(snoozed, shown, new Set(["p-1"]))).toBe("TRANSITION_NOT_ALLOWED");
  });

  it("fixes definition, basis, contract and deduplication key within one chain", () => {
    const changed = inquiryRevisionSchema.parse(
      inquiryRevision({
        revisionId: IDS.inquiryRev2,
        revisionNumber: 2,
        previousRevisionId: IDS.inquiryRev1,
        action: "SYSTEM_DERIVE",
        payload: { ...barrierPayload({ state: "WITHDRAWN", withdrawnAt: T0, reason: "DUPLICATE" }), deduplicationKey: "other-key" },
      }),
    ) as InquiryRevision;
    expect(validateInquiryTransition(presented(), changed, new Set(["p-1"]))).toBe("CHAIN_IDENTITY_CHANGED");
  });
});
