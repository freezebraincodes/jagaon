import { describe, expect, it } from "vitest";
import {
  inquiryPresentationSchema,
  inquiryResponsePayloadSchema,
  inquiryResponseRevisionSchema,
  terminalStateForRawAnswer,
  validateRawAnswerAgainstPresentation,
  type InquiryAnswerContract,
} from "./index";
import { BARRIER_CONTRACT, IDS, NOT_APPLICABLE_DISPOSITION, SYSTEM_PROVENANCE, T0, barrierPresentation, responsePayload, responseRevision } from "./inquiry-test-fixtures";

const issues = (result: { success: boolean; error?: { issues: { message: string }[] } }) =>
  result.success ? [] : result.error!.issues.map((issue) => issue.message);

describe("INQUIRY_RESPONSE payload", () => {
  it("accepts a reviewed bounded choice with its deterministic semantic value", () => {
    expect(inquiryResponsePayloadSchema.safeParse(responsePayload()).success).toBe(true);
  });

  it("requires the response kind to agree with the raw answer", () => {
    expect(issues(inquiryResponsePayloadSchema.safeParse(responsePayload({ responseKind: "NOT_SURE" })))).toContain(
      "RESPONSE_KIND_DISAGREES_WITH_RAW_ANSWER",
    );
    expect(
      issues(
        inquiryResponsePayloadSchema.safeParse(
          responsePayload({ responseKind: "FREE_TEXT", rawAnswer: { kind: "BOUNDED_CHOICE", optionKey: "FORGOT" } }),
        ),
      ),
    ).toContain("RESPONSE_KIND_DISAGREES_WITH_RAW_ANSWER");
  });

  it("gives Not sure and Prefer not to say no meaning and no domain effect", () => {
    const notSure = responsePayload({
      responseKind: "NOT_SURE",
      rawAnswer: { kind: "NOT_SURE" },
      interpretation: { kind: "NONE", reason: "NOT_SURE" },
      processing: { state: "NO_DOMAIN_EFFECT", reason: "NOT_SURE" },
    });
    expect(inquiryResponsePayloadSchema.safeParse(notSure).success).toBe(true);
    expect(
      issues(
        inquiryResponsePayloadSchema.safeParse({
          ...notSure,
          interpretation: { kind: "DIRECT", meaning: { kind: "REVIEWED_SEMANTIC_VALUE", semanticValueKey: "BARRIER_SELECTED_FORGOT" } },
        }),
      ),
    ).toContain("NOT_SURE_CREATES_NO_MEANING");
    const refusal = responsePayload({
      responseKind: "PREFER_NOT_TO_SAY",
      rawAnswer: { kind: "PREFER_NOT_TO_SAY" },
      interpretation: { kind: "NONE", reason: "PREFER_NOT_TO_SAY" },
      processing: { state: "NO_DOMAIN_EFFECT", reason: "PREFER_NOT_TO_SAY" },
    });
    expect(inquiryResponsePayloadSchema.safeParse(refusal).success).toBe(true);
    expect(
      issues(inquiryResponsePayloadSchema.safeParse({ ...refusal, processing: { state: "NO_DOMAIN_EFFECT", reason: "NOT_SURE" } })),
    ).toContain("PROCESSING_REASON_DISAGREES_WITH_RAW_ANSWER");
  });

  it("retains Something else text verbatim without classifying it", () => {
    const text = { text: "我的孙子生日", language: "zh-SG" };
    const payload = responsePayload({
      responseKind: "FREE_TEXT",
      rawAnswer: { kind: "SOMETHING_ELSE", text },
      interpretation: { kind: "DIRECT", meaning: { kind: "PATIENT_TEXT_RETAINED", rawAnswerKind: "SOMETHING_ELSE" } },
      processing: { state: "NO_DOMAIN_EFFECT", reason: "PATIENT_TEXT_RETAINED_ONLY" },
    });
    const parsed = inquiryResponsePayloadSchema.parse(payload);
    expect(parsed.rawAnswer).toEqual({ kind: "SOMETHING_ELSE", text });
  });

  it("represents every raw-answer and processing variant at the contract level", () => {
    const raws = [
      [{ kind: "CONFIRMATION", value: "CONFIRMED" }, "CONFIRMATION"],
      [{ kind: "CORRECTION", correction: { kind: "RECORDED_INFORMATION_IS_NOT_CORRECT" } }, "CORRECTION"],
      [{ kind: "CORRECTION", correction: { kind: "REPLACEMENT_VALUE", value: { kind: "DATE_RANGE", startLocalDate: "2026-10-01", endLocalDate: "2026-10-02" } } }, "CORRECTION"],
      [{ kind: "DATE", localDate: "2026-10-01" }, "CONTEXT"],
      [{ kind: "DATE_RANGE", startLocalDate: "2026-10-01", endLocalDate: "2026-10-03" }, "STATUS_CHANGE"],
      [{ kind: "SHORT_TEXT", text: { text: "late", language: "en-SG" } }, "FREE_TEXT"],
      [{ kind: "CARE_QUESTION_TEXT", text: { text: "Ask about pens", language: "en-SG" } }, "CARE_PREPARATION"],
    ] as const;
    for (const [rawAnswer, responseKind] of raws) {
      const payload = responsePayload({ rawAnswer, responseKind, interpretation: { kind: "NONE", reason: "RAW_TEXT_ONLY" } });
      expect(inquiryResponsePayloadSchema.safeParse(payload).success, rawAnswer.kind).toBe(true);
    }
    expect(
      inquiryResponsePayloadSchema.safeParse(
        responsePayload({ rawAnswer: { kind: "DATE_RANGE", startLocalDate: "2026-10-03", endLocalDate: "2026-10-01" }, responseKind: "CONTEXT" }),
      ).success,
    ).toBe(false);
    for (const processing of [
      { state: "AWAITING_PATIENT_CONFIRMATION", confirmationInquiry: { recordType: "INQUIRY", recordId: IDS.inquiry, revisionId: IDS.inquiryRev1 } },
      { state: "APPLIED", resultingRecords: [{ recordType: "CONTEXT_WINDOW", recordId: IDS.event, revisionId: IDS.eventRev }] },
      { state: "REJECTED", reason: "DESTINATION_VALIDATION_FAILED" },
    ]) {
      expect(inquiryResponsePayloadSchema.safeParse(responsePayload({ processing })).success, processing.state).toBe(true);
    }
  });
});

describe("capability-discriminated Safety disposition", () => {
  it("records NOT_APPLICABLE with the capability-manifest version and the closed reason", () => {
    const parsed = inquiryResponsePayloadSchema.parse(responsePayload());
    expect(parsed.safetyDisposition).toEqual(NOT_APPLICABLE_DISPOSITION);
    expect(
      inquiryResponsePayloadSchema.safeParse(
        responsePayload({ safetyDisposition: { ...NOT_APPLICABLE_DISPOSITION, reason: "NO_SAFETY_ROUTE" } }),
      ).success,
    ).toBe(false);
    expect(
      inquiryResponsePayloadSchema.safeParse(
        responsePayload({ safetyDisposition: { ...NOT_APPLICABLE_DISPOSITION, policyPackVersion: "pack-1" } }),
      ).success,
    ).toBe(false);
    const { capabilityManifestVersion: _drop, ...missing } = NOT_APPLICABLE_DISPOSITION;
    expect(inquiryResponsePayloadSchema.safeParse(responsePayload({ safetyDisposition: missing })).success).toBe(false);
    expect(inquiryResponsePayloadSchema.safeParse(responsePayload({ safetyDisposition: undefined })).success).toBe(false);
  });

  it("keeps the SCREENED variant representable at the contract level only", () => {
    const screened = {
      applicability: "SCREENED",
      screening: { evaluatedAt: T0, policyPackVersion: "safety-pack.1", outcome: { kind: "NO_SAFETY_ROUTE" } },
    };
    expect(inquiryResponsePayloadSchema.safeParse(responsePayload({ safetyDisposition: screened })).success).toBe(true);
  });

  it("forbids a NOT_APPLICABLE response from routing to Safety", () => {
    const routed = responsePayload({
      processing: { state: "SAFETY_ROUTED", safetyEvent: { recordType: "SAFETY_EVENT", recordId: IDS.event, revisionId: IDS.eventRev } },
    });
    expect(issues(inquiryResponsePayloadSchema.safeParse(routed))).toContain("NOT_APPLICABLE_CANNOT_ROUTE_TO_SAFETY");
  });
});

describe("INQUIRY_RESPONSE revision", () => {
  it("requires a patient-initiated inquiry provenance for the raw answer", () => {
    expect(inquiryResponseRevisionSchema.safeParse(responseRevision()).success).toBe(true);
    expect(issues(inquiryResponseRevisionSchema.safeParse(responseRevision({ provenance: SYSTEM_PROVENANCE })))).toContain(
      "RESPONSE_MUST_BE_PATIENT_INITIATED_THROUGH_INQUIRY",
    );
    expect(inquiryResponseRevisionSchema.safeParse(responseRevision({ action: "UPDATE" })).success).toBe(false);
  });
});

describe("Safety applicability timing across a correction", () => {
  // T1 is three hours after the original submission at T0.
  const T1 = "2026-10-02T16:00:00.000Z";
  const disposition = (determinedAt: string) => ({ ...NOT_APPLICABLE_DISPOSITION, determinedAt });
  const correction = (determinedAt: string, overrides: Record<string, unknown> = {}) =>
    responseRevision({
      revisionId: "22222222-2222-4222-8222-222222222223",
      revisionNumber: 2,
      previousRevisionId: IDS.responseRev1,
      action: "CORRECT",
      revisionCreatedAt: T1,
      payload: responsePayload({
        rawAnswer: { kind: "BOUNDED_CHOICE", optionKey: "FORGOT" },
        interpretation: {
          kind: "DETERMINISTIC_MAPPING",
          mappingVersion: "barrier-option-mapping.1",
          meaning: { kind: "REVIEWED_SEMANTIC_VALUE", semanticValueKey: "BARRIER_SELECTED_FORGOT" },
        },
        safetyDisposition: disposition(determinedAt),
      }),
      ...overrides,
    });

  it("accepts a payload whose applicability was resolved after the original answer", () => {
    expect(inquiryResponsePayloadSchema.safeParse(responsePayload({ safetyDisposition: disposition(T1) })).success).toBe(true);
  });

  it("rejects applicability resolved before the answer existed", () => {
    const early = responsePayload({ answeredAt: T1, safetyDisposition: disposition(T0) });
    expect(issues(inquiryResponsePayloadSchema.safeParse(early))).toContain("DISPOSITION_DETERMINED_BEFORE_ANSWER");
  });

  it("binds a CREATE revision's determination to its submission", () => {
    expect(inquiryResponseRevisionSchema.safeParse(responseRevision()).success).toBe(true);
    const late = responseRevision({ revisionCreatedAt: T1, payload: responsePayload({ safetyDisposition: disposition(T1) }) });
    expect(issues(inquiryResponseRevisionSchema.safeParse(late))).toContain("DISPOSITION_NOT_RESOLVED_AT_SUBMISSION");
  });

  it("accepts a later CORRECT revision that keeps the first answeredAt and re-resolves at the correction time", () => {
    const parsed = inquiryResponseRevisionSchema.safeParse(correction(T1));
    expect(issues(parsed)).toEqual([]);
    if (!parsed.success) throw new Error("expected a valid correction");
    expect(parsed.data.payload.answeredAt).toBe(T0);
    expect(parsed.data.payload.safetyDisposition).toEqual(disposition(T1));
  });

  it("rejects a CORRECT revision that retains or backdates the earlier determination", () => {
    expect(issues(inquiryResponseRevisionSchema.safeParse(correction(T0)))).toContain("DISPOSITION_NOT_RE_RESOLVED_AT_CORRECTION");
    expect(issues(inquiryResponseRevisionSchema.safeParse(correction("2026-10-02T14:00:00.000Z")))).toContain(
      "DISPOSITION_NOT_RE_RESOLVED_AT_CORRECTION",
    );
  });

  it("keeps a later correction NOT_APPLICABLE and unable to route to Safety", () => {
    const routed = correction(T1, {
      payload: {
        ...correction(T1).payload,
        processing: { state: "SAFETY_ROUTED", safetyEvent: { recordType: "SAFETY_EVENT", recordId: IDS.event, revisionId: IDS.eventRev } },
      },
    });
    expect(issues(inquiryResponseRevisionSchema.safeParse(routed))).toContain("NOT_APPLICABLE_CANNOT_ROUTE_TO_SAFETY");
  });

  it("lets SYSTEM_DERIVE carry an earlier determination forward but never a future one", () => {
    const derive = (determinedAt: string) =>
      correction(determinedAt, { action: "SYSTEM_DERIVE", provenance: SYSTEM_PROVENANCE });
    expect(issues(inquiryResponseRevisionSchema.safeParse(derive(T0)))).toEqual([]);
    expect(issues(inquiryResponseRevisionSchema.safeParse(derive("2026-10-02T17:00:00.000Z")))).toContain(
      "DISPOSITION_DETERMINED_AFTER_REVISION",
    );
  });
});

describe("lossless sub-millisecond Instant ordering", () => {
  // Distinct instants inside one millisecond; Date.parse would treat them as equal.
  const EARLY = "2026-10-02T13:00:00.0001Z";
  const LATE = "2026-10-02T13:00:00.0009Z";
  const disposition = (determinedAt: string) => ({ ...NOT_APPLICABLE_DISPOSITION, determinedAt });

  it("detects a disposition at .0001Z as before an answer at .0009Z", () => {
    const early = responsePayload({ answeredAt: LATE, safetyDisposition: disposition(EARLY) });
    expect(issues(inquiryResponsePayloadSchema.safeParse(early))).toContain("DISPOSITION_DETERMINED_BEFORE_ANSWER");
    const later = responsePayload({ answeredAt: EARLY, safetyDisposition: disposition(LATE) });
    expect(inquiryResponsePayloadSchema.safeParse(later).success).toBe(true);
  });

  it("rejects a CREATE whose answeredAt, determinedAt and revisionCreatedAt differ within one millisecond", () => {
    const valid = responseRevision({ recordedAt: EARLY, revisionCreatedAt: EARLY, payload: responsePayload({ answeredAt: EARLY, safetyDisposition: disposition(EARLY) }) });
    expect(issues(inquiryResponseRevisionSchema.safeParse(valid))).toEqual([]);
    const determinedLater = responseRevision({
      recordedAt: EARLY,
      revisionCreatedAt: EARLY,
      payload: responsePayload({ answeredAt: EARLY, safetyDisposition: disposition(LATE) }),
    });
    expect(issues(inquiryResponseRevisionSchema.safeParse(determinedLater))).toContain("DISPOSITION_NOT_RESOLVED_AT_SUBMISSION");
    const createdLater = responseRevision({
      recordedAt: EARLY,
      revisionCreatedAt: LATE,
      payload: responsePayload({ answeredAt: EARLY, safetyDisposition: disposition(EARLY) }),
    });
    expect(issues(inquiryResponseRevisionSchema.safeParse(createdLater))).toContain("DISPOSITION_NOT_RESOLVED_AT_SUBMISSION");
  });

  const correctionAt = (revisionCreatedAt: string, determinedAt: string, overrides: Record<string, unknown> = {}) =>
    responseRevision({
      revisionId: "22222222-2222-4222-8222-222222222223",
      revisionNumber: 2,
      previousRevisionId: IDS.responseRev1,
      action: "CORRECT",
      revisionCreatedAt,
      payload: responsePayload({ safetyDisposition: disposition(determinedAt) }),
      ...overrides,
    });

  it("requires CORRECT to equal its revisionCreatedAt exactly, not to the millisecond", () => {
    expect(issues(inquiryResponseRevisionSchema.safeParse(correctionAt(LATE, LATE)))).toEqual([]);
    expect(issues(inquiryResponseRevisionSchema.safeParse(correctionAt(LATE, EARLY)))).toContain("DISPOSITION_NOT_RE_RESOLVED_AT_CORRECTION");
    expect(issues(inquiryResponseRevisionSchema.safeParse(correctionAt(EARLY, LATE)))).toContain("DISPOSITION_NOT_RE_RESOLVED_AT_CORRECTION");
    // Trailing-zero precision is the same instant.
    expect(issues(inquiryResponseRevisionSchema.safeParse(correctionAt("2026-10-02T13:00:00.0009Z", "2026-10-02T13:00:00.000900Z")))).toEqual([]);
  });

  it("rejects a SYSTEM_DERIVE determination one sub-millisecond step in the future", () => {
    const derive = (revisionCreatedAt: string, determinedAt: string) =>
      correctionAt(revisionCreatedAt, determinedAt, { action: "SYSTEM_DERIVE", provenance: SYSTEM_PROVENANCE });
    expect(issues(inquiryResponseRevisionSchema.safeParse(derive(LATE, EARLY)))).toEqual([]);
    expect(issues(inquiryResponseRevisionSchema.safeParse(derive(EARLY, LATE)))).toContain("DISPOSITION_DETERMINED_AFTER_REVISION");
  });
});

describe("raw-answer binding to the exact presentation", () => {
  const presentation = inquiryPresentationSchema.parse(barrierPresentation());
  const contract = BARRIER_CONTRACT as unknown as InquiryAnswerContract;

  it("accepts only offered options, uncertainty paths and bounded text", () => {
    expect(validateRawAnswerAgainstPresentation(contract, presentation, { kind: "BOUNDED_CHOICE", optionKey: "FORGOT" } as never, 280)).toBeNull();
    expect(validateRawAnswerAgainstPresentation(contract, presentation, { kind: "NOT_SURE" }, 280)).toBeNull();
    expect(validateRawAnswerAgainstPresentation(contract, presentation, { kind: "PREFER_NOT_TO_SAY" }, 280)).toBeNull();
    const long = { kind: "SOMETHING_ELSE", text: { text: "x".repeat(281), language: "und" } } as const;
    expect(validateRawAnswerAgainstPresentation(contract, presentation, long, 280)).toBe("TEXT_EXCEEDS_CONTRACT_LIMIT");
    expect(validateRawAnswerAgainstPresentation(contract, presentation, { kind: "DATE", localDate: "2026-10-01" } as never, 280)).toBe(
      "RAW_ANSWER_NOT_PERMITTED_BY_CONTRACT",
    );
  });

  it("rejects an option that was not visible and an unoffered refusal path", () => {
    const trimmed = { ...presentation, content: { ...presentation.content, options: presentation.content.options.slice(1) } };
    expect(validateRawAnswerAgainstPresentation(contract, trimmed, { kind: "BOUNDED_CHOICE", optionKey: "FORGOT" } as never, 280)).toBe(
      "OPTION_NOT_PRESENTED",
    );
    const noRefusal = { ...contract, allowPreferNotToSay: false } as InquiryAnswerContract;
    expect(validateRawAnswerAgainstPresentation(noRefusal, presentation, { kind: "PREFER_NOT_TO_SAY" }, 280)).toBe(
      "RAW_ANSWER_NOT_PERMITTED_BY_CONTRACT",
    );
  });

  it("maps Not sure to NOT_SURE, refusal to DECLINED and every other answer to ANSWERED", () => {
    expect(terminalStateForRawAnswer({ kind: "NOT_SURE" })).toBe("NOT_SURE");
    expect(terminalStateForRawAnswer({ kind: "PREFER_NOT_TO_SAY" })).toBe("DECLINED");
    expect(terminalStateForRawAnswer({ kind: "SOMETHING_ELSE", text: { text: "x", language: "und" } })).toBe("ANSWERED");
  });
});
