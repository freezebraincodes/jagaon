import { describe, expect, it } from "vitest";
import { enabledInquiryDefinitions, inquiryPayloadSchema, inquiryPresentationSchema, inquiryQueueDecisionSchema } from "@/domain/inquiry";
import type { MedicationEventPayload } from "@/domain/health-records/medication-event";
import type { Instant } from "@/domain/shared/time";
import { INQUIRY_CAPABILITY_MANIFEST, resolveInquirySafetyDisposition, type InquiryCapabilityManifest } from "./inquiry-capability-manifest";
import {
  assessBarrierEligibility,
  barrierDeduplicationKey,
  buildBarrierCandidate,
  type BarrierBasisView,
  type PriorBarrierInquiry,
} from "./medication-occasion-barrier";
import { arbitrateInquiries, type ArbiterCandidate, type BudgetState } from "./inquiry-arbiter";
import { presentationExpired, revalidateForPresentation, snoozeUntil } from "./inquiry-lifecycle-rules";
import { buildBarrierResponseParts } from "./barrier-response";
import { barrierPresentation } from "@/domain/inquiry/inquiry-test-fixtures";

const NOW = "2026-10-03T08:00:00.000Z" as Instant;
const BARRIER = enabledInquiryDefinitions()[0]!;
const M = INQUIRY_CAPABILITY_MANIFEST;
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const RX = { recordType: "PRESCRIPTION_VERSION" as const, recordId: ID(1) as never, revisionId: ID(2) as never };
const MEDICATION = { recordType: "MEDICATION" as const, recordId: ID(3) as never, revisionId: ID(4) as never };
const OCCASION_AT = "2026-10-02T13:00:00.000Z"; // 2 Oct, 9:00 pm Singapore

function event(state: MedicationEventPayload["state"], overrides: Partial<MedicationEventPayload> = {}): MedicationEventPayload {
  const intendedOccasion = {
    expectedAt: { kind: "EXACT" as const, instantUtc: OCCASION_AT as Instant, timeZoneId: "Asia/Singapore", utcOffsetMinutes: 480 },
    prescriptionVersion: RX,
    scheduleKey: "night",
  };
  if (state === "TAKEN") return { state, medication: MEDICATION, intendedOccasion, amountTaken: { kind: "NOT_RECORDED" }, ...overrides } as MedicationEventPayload;
  return { state, medication: MEDICATION, intendedOccasion, ...overrides } as MedicationEventPayload;
}

function basis(state: MedicationEventPayload["state"], revision = 10, overrides: Partial<BarrierBasisView> = {}, payload: Partial<MedicationEventPayload> = {}): BarrierBasisView {
  return {
    ref: { recordType: "MEDICATION_EVENT", recordId: ID(9) as never, revisionId: ID(revision) as never },
    isCurrentHead: true,
    payload: event(state, payload),
    ...overrides,
  };
}

const failing = (assessment: ReturnType<typeof assessBarrierEligibility>) =>
  assessment.dimensions.filter((entry) => entry.outcome !== "PASS").map((entry) => [entry.dimension, entry.reasonCodes[0]]);

describe("Inquiry capability manifest", () => {
  it("structurally omits Safety and resolves only the NOT_APPLICABLE disposition", () => {
    expect(M.safety).toEqual({ kind: "ABSENT", reason: "INQUIRY_SAFETY_CAPABILITY_ABSENT" });
    expect(resolveInquirySafetyDisposition(M, NOW)).toEqual({
      applicability: "NOT_APPLICABLE",
      determinedAt: NOW,
      capabilityManifestVersion: "8.1",
      reason: "INQUIRY_SAFETY_CAPABILITY_ABSENT",
    });
    expect(Object.isFrozen(M) && Object.isFrozen(M.budget) && Object.isFrozen(M.definitions)).toBe(true);
    expect(M.proactiveOrdinaryPush.kind).toBe("DISABLED_PRODUCT_SCOPE");
    expect(M.budget).toMatchObject({
      concurrentPresentedNonSafety: 1,
      contextualPlusOpportunistic: { per24Hours: 2, per7Days: 5 },
      opportunistic: { per24Hours: 1, per7Days: 3 },
      minimumNonInlineIntervalMinutes: 240,
      inlinePerActiveTask: 2,
      contextualPerView: 1,
    });
  });
});

describe("barrier candidate builder", () => {
  it("creates a candidate only after an explicit Skipped or Not sure record for an exact occasion", () => {
    for (const state of ["MISSED", "UNSURE"] as const) {
      const candidate = buildBarrierCandidate(BARRIER, M, basis(state));
      expect(candidate, state).not.toBeNull();
      expect(inquiryPayloadSchema.safeParse(candidate!.payload).success).toBe(true);
      expect(candidate!.payload.expiresAt).toBe("2026-10-16T13:00:00.000Z");
    }
    for (const state of ["TAKEN", "DECLINED_TO_RECORD", "DELAYED"] as const) {
      expect(buildBarrierCandidate(BARRIER, M, basis(state)), state).toBeNull();
    }
    const noOccasion = basis("MISSED");
    noOccasion.payload = { ...noOccasion.payload, intendedOccasion: { expectedAt: { kind: "UNKNOWN" } } } as MedicationEventPayload;
    expect(buildBarrierCandidate(BARRIER, M, noOccasion)).toBeNull();
  });

  it("cannot activate a definition the manifest does not enable", () => {
    const disabled: InquiryCapabilityManifest = { ...M, definitions: { ...M.definitions, MEDICATION_OCCASION_BARRIER_V1: { kind: "DISABLED_PRODUCT_SCOPE" } } };
    expect(buildBarrierCandidate(BARRIER, disabled, basis("MISSED"))).toBeNull();
  });

  it("deduplicates semantically by occasion even when the event revision advances", () => {
    const a = buildBarrierCandidate(BARRIER, M, basis("MISSED", 10))!;
    const b = buildBarrierCandidate(BARRIER, M, basis("UNSURE", 11))!;
    expect(a.payload.deduplicationKey).toBe(b.payload.deduplicationKey);
    expect(barrierDeduplicationKey(BARRIER, { ...a.occasion, localDate: "2026-10-01" })).not.toBe(a.payload.deduplicationKey);
  });
});

describe("eligibility", () => {
  const assess = (b: BarrierBasisView, priors: PriorBarrierInquiry[] = [], now = NOW) =>
    assessBarrierEligibility({ definition: BARRIER, manifest: M, basis: b, priors, now });

  it("evaluates all ten dimensions and passes an explicit recent Skipped record", () => {
    const result = assess(basis("MISSED"));
    expect(result.dimensions).toHaveLength(10);
    expect(result.outcome).toBe("ELIGIBLE");
  });

  it("fails a superseded basis, a reported concern and an occasion beyond the answerable window", () => {
    expect(failing(assess(basis("MISSED", 10, { isCurrentHead: false })))).toEqual([["IDENTIFIABLE_BASIS", "BASIS_NOT_CURRENT"]]);
    expect(failing(assess(basis("MISSED", 10, {}, { reportedSafetyConcerns: ["POSSIBLE_DOUBLE_DOSE"] })))).toEqual([
      ["NEUTRAL_AND_SAFE", "REPORTED_CONCERN_OUTSIDE_DEFINITION"],
    ]);
    expect(failing(assess(basis("MISSED"), [], "2026-10-17T00:00:00.000Z" as Instant))).toEqual([
      ["ANSWERABLE", "OCCASION_NO_LONGER_ANSWERABLE"],
      ["USEFUL_NOW", "OUTSIDE_FACTUAL_COUNT_WINDOW"],
    ]);
  });

  it("applies the governed reconsideration rules for prior dispositions on the same occasion", () => {
    const prior = (state: PriorBarrierInquiry["state"], daysAgo: number, basisRevision = 9): PriorBarrierInquiry => ({
      recordId: ID(50),
      state,
      basisRevisionId: ID(basisRevision),
      stateSince: new Date(Date.parse(NOW) - daysAgo * 86_400_000).toISOString() as Instant,
    });
    expect(failing(assess(basis("MISSED"), [prior("DECLINED", 60)]))).toEqual([["PREVIOUS_DISPOSITION", "PREVIOUSLY_DECLINED"]]);
    expect(failing(assess(basis("MISSED"), [prior("DISMISSED", 3)]))).toEqual([["PREVIOUS_DISPOSITION", "PREVIOUSLY_DISMISSED"]]);
    expect(failing(assess(basis("MISSED"), [prior("NOT_SURE", 3)]))).toEqual([["PREVIOUS_DISPOSITION", "PREVIOUSLY_NOT_SURE"]]);
    expect(failing(assess(basis("MISSED"), [prior("EXPIRED", 3)]))).toEqual([["PREVIOUS_DISPOSITION", "PREVIOUSLY_EXPIRED"]]);
    expect(failing(assess(basis("MISSED"), [prior("ANSWERED", 1, 10)]))).toEqual([["CURRENT_ANSWER_ABSENT", "CURRENT_ANSWER_PRESENT"]]);
    // An answer about a corrected (superseded) representation is not current.
    expect(assess(basis("MISSED"), [prior("ANSWERED", 1, 9)]).outcome).toBe("ELIGIBLE");
  });
});

describe("shared queue arbiter", () => {
  const emptyBudget: BudgetState = { presentedNow: [], history: [] };
  const eligibility = assessBarrierEligibility({ definition: BARRIER, manifest: M, basis: basis("MISSED"), priors: [], now: NOW });
  const candidate = (id: number, overrides: Partial<ArbiterCandidate> = {}): ArbiterCandidate => ({
    inquiryRecordId: ID(id),
    priorityRuleVersion: "inquiry-priority.1",
    presentationClass: "CONTEXTUAL",
    eligibility,
    expiresAt: "2026-10-16T13:00:00.000Z" as Instant,
    firstEligibleAt: NOW,
    inCurrentView: true,
    relevantAt: OCCASION_AT as Instant,
    boundedChoice: true,
    ...overrides,
  });
  const outcomes = (decisions: ReturnType<typeof arbitrateInquiries>) => Object.fromEntries(decisions.map((d) => [d.inquiryRecordId, d.decision.outcome]));

  it("queues one contextual question per view and explains every other decision", () => {
    // A synthetic neutral record-clarification fixture competes with the barrier candidate.
    const fixture = candidate(21, { boundedChoice: false, relevantAt: "2026-09-25T00:00:00.000Z" as Instant });
    const decisions = arbitrateInquiries({ manifest: M, candidates: [fixture, candidate(20)], budget: emptyBudget, now: NOW });
    expect(outcomes(decisions)).toEqual({ [ID(21)]: "NOT_SELECTED", [ID(20)]: "QUEUED" });
    for (const decision of decisions) expect(inquiryQueueDecisionSchema.safeParse(decision.decision).success).toBe(true);
    const loser = decisions.find((d) => d.inquiryRecordId === ID(21))!;
    expect(loser.decision.factors.find((f) => f.factor === "COMPETITION")!.reasonCodes).toContain("LOWER_PRIORITY_THAN_SELECTED");
  });

  it("breaks ties by expiry, first eligibility and stable identifier, independent of input order", () => {
    const a = candidate(30, { expiresAt: "2026-10-10T00:00:00.000Z" as Instant });
    const b = candidate(31);
    const c = candidate(29);
    const forward = arbitrateInquiries({ manifest: M, candidates: [a, b, c], budget: emptyBudget, now: NOW });
    const reversed = arbitrateInquiries({ manifest: M, candidates: [c, b, a], budget: emptyBudget, now: NOW });
    expect(outcomes(forward)[ID(30)]).toBe("QUEUED");
    expect(outcomes(reversed)).toEqual(outcomes(forward));
    const sameExpiry = arbitrateInquiries({ manifest: M, candidates: [b, c], budget: emptyBudget, now: NOW });
    expect(outcomes(sameExpiry)[ID(29)]).toBe("QUEUED");
  });

  it("enforces the concurrent, daily, weekly and minimum-interval budget", () => {
    const at = (hoursAgo: number) => new Date(Date.parse(NOW) - hoursAgo * 3_600_000).toISOString() as Instant;
    const block = (budget: BudgetState) =>
      arbitrateInquiries({ manifest: M, candidates: [candidate(40)], budget, now: NOW })[0]!.decision.factors.find((f) => f.factor === "COMPETITION")!
        .reasonCodes[0];
    expect(block({ presentedNow: [ID(1)], history: [] })).toBe("CONCURRENT_PRESENTATION_LIMIT");
    expect(block({ presentedNow: [], history: [{ inquiryRecordId: ID(1), presentedAt: at(2), presentationClass: "CONTEXTUAL" }] })).toBe(
      "MINIMUM_INTERVAL_NOT_ELAPSED",
    );
    expect(
      block({
        presentedNow: [],
        history: [
          { inquiryRecordId: ID(1), presentedAt: at(20), presentationClass: "CONTEXTUAL" },
          { inquiryRecordId: ID(2), presentedAt: at(10), presentationClass: "CONTEXTUAL" },
        ],
      }),
    ).toBe("CONTEXTUAL_DAILY_LIMIT");
    const week = [30, 50, 70, 90, 110].map((hours, index) => ({ inquiryRecordId: ID(index + 1), presentedAt: at(hours), presentationClass: "CONTEXTUAL" as const }));
    expect(block({ presentedNow: [], history: week })).toBe("CONTEXTUAL_WEEKLY_LIMIT");
    expect(block({ presentedNow: [], history: week.slice(0, 4) })).toBe("BUDGET_AVAILABLE");
  });

  it("never selects a contextual question outside the current view", () => {
    const decisions = arbitrateInquiries({ manifest: M, candidates: [candidate(50, { inCurrentView: false })], budget: emptyBudget, now: NOW });
    expect(decisions[0]!.decision.outcome).toBe("NOT_SELECTED");
  });
});

describe("revalidation, expiry and reconsideration", () => {
  const candidate = buildBarrierCandidate(BARRIER, M, basis("MISSED"))!;
  const revalidate = (b: BarrierBasisView, now = NOW, budget: BudgetState = { presentedNow: [], history: [] }, priors: PriorBarrierInquiry[] = []) =>
    revalidateForPresentation({ definition: BARRIER, manifest: M, payload: candidate.payload, basis: b, priors, budget, now });

  it("confirms the exact still-current basis immediately before display", () => {
    expect(revalidate(basis("MISSED"))).toEqual({ kind: "VALID_FOR_PRESENTATION", basisRevisions: [basis("MISSED").ref] });
  });

  it("withdraws on changed evidence, expires after answerability and defers on budget", () => {
    expect(revalidate(basis("TAKEN", 11))).toEqual({ kind: "WITHDRAW", reason: "EVIDENCE_CHANGED" });
    expect(revalidate(basis("MISSED", 10, { isCurrentHead: false }))).toEqual({ kind: "WITHDRAW", reason: "EVIDENCE_CHANGED" });
    expect(revalidate(basis("MISSED"), "2026-10-16T13:00:00.000Z" as Instant)).toEqual({ kind: "EXPIRE", reason: "ANSWERABILITY_ENDED" });
    expect(revalidate(basis("MISSED"), NOW, { presentedNow: [ID(1)], history: [] })).toEqual({ kind: "DEFER", reason: "CONCURRENT_PRESENTATION_LIMIT" });
  });

  it("expires a contextual presentation after seven days", () => {
    const presentation = inquiryPresentationSchema.parse(barrierPresentation("p-1", "2026-10-02T13:30:00.000Z"));
    expect(presentationExpired(presentation, M, "2026-10-09T13:29:59.000Z" as Instant)).toBe(false);
    expect(presentationExpired(presentation, M, "2026-10-09T13:30:00.000Z" as Instant)).toBe(true);
  });

  it("snoozes to the same local wall-clock time 1, 3 or 7 days later and never guesses another timezone", () => {
    expect(snoozeUntil(M, "TOMORROW", NOW, "Asia/Singapore")).toEqual({ kind: "ELIGIBLE_AGAIN_AT", eligibleAgainAt: "2026-10-04T08:00:00.000Z" });
    expect(snoozeUntil(M, "THREE_DAYS", NOW, "Asia/Singapore")).toEqual({ kind: "ELIGIBLE_AGAIN_AT", eligibleAgainAt: "2026-10-06T08:00:00.000Z" });
    expect(snoozeUntil(M, "NEXT_WEEK", "2026-10-31T20:00:00.000Z" as Instant, "Asia/Singapore")).toEqual({
      kind: "ELIGIBLE_AGAIN_AT",
      eligibleAgainAt: "2026-11-07T20:00:00.000Z",
    });
    expect(snoozeUntil(M, "TOMORROW", NOW, "Europe/London")).toEqual({ kind: "TIMEZONE_RECONCILIATION_REQUIRED" });
  });
});

describe("barrier response builder", () => {
  const presentation = inquiryPresentationSchema.parse(barrierPresentation());
  const build = (rawAnswer: unknown) =>
    buildBarrierResponseParts({ definition: BARRIER, manifest: M, presentation, rawAnswer: rawAnswer as never, determinedAt: NOW });

  it("maps a reviewed option to its fixed semantic value with the NOT_APPLICABLE disposition", () => {
    const result = build({ kind: "BOUNDED_CHOICE", optionKey: "AWAY_FROM_HOME" });
    expect(result).toEqual({
      ok: true,
      parts: {
        responseKind: "CONTEXT",
        rawAnswer: { kind: "BOUNDED_CHOICE", optionKey: "AWAY_FROM_HOME" },
        interpretation: {
          kind: "DETERMINISTIC_MAPPING",
          mappingVersion: "barrier-option-mapping.1",
          meaning: { kind: "REVIEWED_SEMANTIC_VALUE", semanticValueKey: "BARRIER_SELECTED_AWAY_FROM_HOME" },
        },
        safetyDisposition: { applicability: "NOT_APPLICABLE", determinedAt: NOW, capabilityManifestVersion: "8.1", reason: "INQUIRY_SAFETY_CAPABILITY_ABSENT" },
        processing: { state: "RECORDED" },
        terminalState: "ANSWERED",
      },
    });
  });

  it("keeps Something else, Not sure and Prefer not to say free of any barrier meaning", () => {
    const text = build({ kind: "SOMETHING_ELSE", text: { text: "Pen ran out at my daughter's place", language: "en-SG" } });
    expect(text.ok && text.parts.interpretation).toEqual({ kind: "DIRECT", meaning: { kind: "PATIENT_TEXT_RETAINED", rawAnswerKind: "SOMETHING_ELSE" } });
    const notSure = build({ kind: "NOT_SURE" });
    expect(notSure.ok && [notSure.parts.interpretation, notSure.parts.processing, notSure.parts.terminalState]).toEqual([
      { kind: "NONE", reason: "NOT_SURE" },
      { state: "NO_DOMAIN_EFFECT", reason: "NOT_SURE" },
      "NOT_SURE",
    ]);
    const refusal = build({ kind: "PREFER_NOT_TO_SAY" });
    expect(refusal.ok && refusal.parts.terminalState).toBe("DECLINED");
  });

  it("rejects an answer the presentation did not offer before any record exists", () => {
    expect(build({ kind: "DATE", localDate: "2026-10-02" })).toEqual({ ok: false, issue: "RAW_ANSWER_NOT_PERMITTED_BY_CONTRACT" });
  });

  it("produces identical structured effects for en-SG and zh-SG presentations", () => {
    const zh = inquiryPresentationSchema.parse({ ...barrierPresentation("p-zh"), locale: "zh-SG" });
    const en = build({ kind: "BOUNDED_CHOICE", optionKey: "FORGOT" });
    const fromZh = buildBarrierResponseParts({ definition: BARRIER, manifest: M, presentation: zh, rawAnswer: { kind: "BOUNDED_CHOICE", optionKey: "FORGOT" } as never, determinedAt: NOW });
    expect(fromZh).toEqual(en);
  });
});
