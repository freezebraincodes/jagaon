import { sha256Hex } from "@/application/intelligence/metrics";
import type { MedicationEventPayload } from "@/domain/health-records/medication-event";
import type { TypedRevisionRef } from "@/domain/shared/typed-revision-ref";
import type { Instant } from "@/domain/shared/time";
import type { EnabledInquiryDefinition, InquiryDecisionReasonCodeValue } from "@/domain/inquiry/inquiry-registry";
import type {
  InquiryDecisionReasonCode,
  InquiryDeduplicationKey,
  InquiryEligibilityAssessment,
  InquiryEligibilityDimension,
  InquiryEligibilityResult,
  InquiryLifecycleState,
  InquiryPayload,
} from "@/domain/inquiry/inquiry";
import type { InquiryCapabilityManifest } from "./inquiry-capability-manifest";

/**
 * Pure candidate builder and eligibility evaluator for
 * `MEDICATION_OCCASION_BARRIER_V1` (deterministic-engine Sections 13.1–13.2,
 * 14.2; Packet 8 design Section 5.3).
 *
 * A candidate exists only for a medication event that the patient explicitly
 * saved as skipped (`MISSED`) or `UNSURE` for one exact scheduled occasion.
 * An absent event, a taken or declined event, or an occasion without an
 * exact recorded prescription time cannot create a question.
 */

const DAY_MS = 86_400_000;

export const ELIGIBLE_BARRIER_STATES = Object.freeze(["MISSED", "UNSURE"] as const);

export type ExactOccasion = {
  prescription: TypedRevisionRef<"PRESCRIPTION_VERSION">;
  scheduleKey: string;
  expectedAt: Instant;
  /** Local calendar date of the occasion in the configured home timezone. */
  localDate: string;
};

/** The exact medication-event revision a barrier question may rest on. */
export type BarrierBasisView = {
  ref: TypedRevisionRef<"MEDICATION_EVENT">;
  isCurrentHead: boolean;
  payload: MedicationEventPayload;
};

/** The current head of a prior inquiry that shares the candidate's deduplication key. */
export type PriorBarrierInquiry = {
  recordId: string;
  state: InquiryLifecycleState;
  basisRevisionId: string;
  /** Creation time of the revision that reached `state`. */
  stateSince: Instant;
};

export function reason(code: InquiryDecisionReasonCodeValue): InquiryDecisionReasonCode {
  return code as InquiryDecisionReasonCode;
}

export function localDateInOffset(instant: string, utcOffsetMinutes: number): string {
  return new Date(Date.parse(instant) + utcOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

/**
 * Resolves the exact recorded occasion of an event. Only an `EXACT` expected
 * time bound to a prescription revision and schedule key qualifies; JagaOn
 * never guesses which occasion an event belongs to.
 */
export function exactOccasionOf(payload: MedicationEventPayload, homeUtcOffsetMinutes: number): ExactOccasion | null {
  const occasion = payload.intendedOccasion;
  if (!occasion || occasion.expectedAt.kind !== "EXACT" || !occasion.prescriptionVersion || !occasion.scheduleKey) return null;
  return {
    prescription: occasion.prescriptionVersion,
    scheduleKey: occasion.scheduleKey,
    expectedAt: occasion.expectedAt.instantUtc,
    localDate: localDateInOffset(occasion.expectedAt.instantUtc, homeUtcOffsetMinutes),
  };
}

/** Stable occasion identity: the prescription record, its schedule key and the local date. */
export function occasionIdentity(occasion: Pick<ExactOccasion, "prescription" | "scheduleKey" | "localDate">): string {
  return `${occasion.prescription.recordId}|${occasion.scheduleKey}|${occasion.localDate}`;
}

/**
 * Semantic deduplication: equivalent questions about one occasion share one
 * key even when the medication-event revision advances.
 */
export function barrierDeduplicationKey(definition: EnabledInquiryDefinition, occasion: ExactOccasion): InquiryDeduplicationKey {
  return `${definition.definitionKey}:${sha256Hex(occasionIdentity(occasion)).slice(0, 32)}` as InquiryDeduplicationKey;
}

export type BarrierCandidate = {
  payload: InquiryPayload;
  occasion: ExactOccasion;
};

export function buildBarrierCandidate(
  definition: EnabledInquiryDefinition,
  manifest: InquiryCapabilityManifest,
  basis: BarrierBasisView,
): BarrierCandidate | null {
  if (manifest.definitions[definition.definitionKey]?.kind !== "ENABLED") return null;
  if (!(ELIGIBLE_BARRIER_STATES as readonly string[]).includes(basis.payload.state)) return null;
  const occasion = exactOccasionOf(basis.payload, manifest.medicationOccasionBarrier.homeUtcOffsetMinutes);
  if (!occasion) return null;
  const expiresAt = new Date(Date.parse(occasion.expectedAt) + manifest.medicationOccasionBarrier.answerableDays * DAY_MS).toISOString() as Instant;
  return {
    occasion,
    payload: {
      definition: { definitionKey: definition.definitionKey, definitionVersion: definition.definitionVersion } as InquiryPayload["definition"],
      basis: { purpose: "RECORD_CLARIFICATION", records: [basis.ref] },
      answerContract: { ...definition.answerContract, optionKeys: [...definition.answerContract.optionKeys] } as InquiryPayload["answerContract"],
      deduplicationKey: barrierDeduplicationKey(definition, occasion),
      sensitivity: definition.sensitivity,
      expiresAt,
      lifecycle: { state: "CANDIDATE" },
    },
  };
}

function result(dimension: InquiryEligibilityDimension, pass: boolean, code: InquiryDecisionReasonCodeValue): InquiryEligibilityResult {
  return { dimension, outcome: pass ? "PASS" : "FAIL", reasonCodes: [reason(code)] };
}

/** Prior dispositions that block asking about the same occasion again. */
function previousDispositionBlock(
  priors: readonly PriorBarrierInquiry[],
  basis: BarrierBasisView,
  manifest: InquiryCapabilityManifest,
  now: Instant,
): InquiryDecisionReasonCodeValue | null {
  const daysSince = (at: Instant) => (Date.parse(now) - Date.parse(at)) / DAY_MS;
  const rules = manifest.reconsideration;
  for (const prior of priors) {
    // Refusal never resurfaces automatically in the MVP.
    if (prior.state === "DECLINED") return "PREVIOUSLY_DECLINED";
    if (prior.state === "DISMISSED" && daysSince(prior.stateSince) < rules.dismissedDays) return "PREVIOUSLY_DISMISSED";
    if (prior.state === "NOT_SURE" && (daysSince(prior.stateSince) < rules.notSureDays || prior.basisRevisionId === basis.ref.revisionId)) {
      return "PREVIOUSLY_NOT_SURE";
    }
    if (prior.state === "EXPIRED" && daysSince(prior.stateSince) < rules.expiredDays) return "PREVIOUSLY_EXPIRED";
  }
  return null;
}

/**
 * Deterministic eligibility over every hard dimension exactly once. A failed
 * or indeterminate dimension can never be treated as permission to ask.
 */
export function assessBarrierEligibility(input: {
  definition: EnabledInquiryDefinition;
  manifest: InquiryCapabilityManifest;
  basis: BarrierBasisView;
  priors: readonly PriorBarrierInquiry[];
  now: Instant;
}): InquiryEligibilityAssessment {
  const { definition, manifest, basis, priors, now } = input;
  const policy = manifest.medicationOccasionBarrier;
  const occasion = exactOccasionOf(basis.payload, policy.homeUtcOffsetMinutes);
  const stateEligible = (ELIGIBLE_BARRIER_STATES as readonly string[]).includes(basis.payload.state);
  const enabled = manifest.definitions[definition.definitionKey]?.kind === "ENABLED" && definition.purpose === "RECORD_CLARIFICATION";

  const identifiable: InquiryDecisionReasonCodeValue = !basis.isCurrentHead
    ? "BASIS_NOT_CURRENT"
    : !stateEligible
      ? "BASIS_STATE_NOT_ELIGIBLE"
      : !occasion
        ? "BASIS_OCCASION_NOT_EXACT"
        : "BASIS_CURRENT_EXPLICIT_STATE";

  const currentAnswer = priors.some(
    (prior) => (prior.state === "ANSWERED" || prior.state === "NOT_SURE" || prior.state === "DECLINED") && prior.basisRevisionId === basis.ref.revisionId,
  );
  const ageDays = occasion ? (Date.parse(now) - Date.parse(occasion.expectedAt)) / DAY_MS : Number.POSITIVE_INFINITY;
  const answerable = ageDays < policy.answerableDays;
  const withinWindow = ageDays < policy.factualCountWindowDays;
  const blocking = previousDispositionBlock(priors, basis, manifest, now);
  const contract = definition.answerContract;

  const dimensions: InquiryEligibilityResult[] = [
    result("APPROVED_PURPOSE", enabled, enabled ? "PURPOSE_APPROVED" : "DEFINITION_NOT_ENABLED"),
    result("IDENTIFIABLE_BASIS", identifiable === "BASIS_CURRENT_EXPLICIT_STATE", identifiable),
    result("PERMITTED_CONSEQUENCE", true, "PERMITTED_CONSEQUENCE_FACTUAL_COUNT"),
    result("CURRENT_ANSWER_ABSENT", !currentAnswer, currentAnswer ? "CURRENT_ANSWER_PRESENT" : "NO_CURRENT_ANSWER"),
    // Reported extra/wrong/device concerns are outside this ordinary definition.
    result(
      "NEUTRAL_AND_SAFE",
      !basis.payload.reportedSafetyConcerns,
      basis.payload.reportedSafetyConcerns ? "REPORTED_CONCERN_OUTSIDE_DEFINITION" : "REVIEWED_NEUTRAL_TEMPLATE",
    ),
    result("ANSWERABLE", answerable, answerable ? "OCCASION_ANSWERABLE" : "OCCASION_NO_LONGER_ANSWERABLE"),
    result("PREVIOUS_DISPOSITION", blocking === null, blocking ?? "NO_BLOCKING_DISPOSITION"),
    result("USEFUL_NOW", withinWindow, withinWindow ? "WITHIN_FACTUAL_COUNT_WINDOW" : "OUTSIDE_FACTUAL_COUNT_WINDOW"),
    result("UNCERTAINTY_PATH", contract.allowNotSure && contract.allowPreferNotToSay, "UNCERTAINTY_AND_REFUSAL_OFFERED"),
    result("DEFINED_DESTINATION", true, "DESTINATION_DEFINED"),
  ];
  return {
    evaluatedAt: now,
    ruleVersion: definition.ruleVersions.eligibility,
    dimensions,
    outcome: dimensions.every((entry) => entry.outcome === "PASS") ? "ELIGIBLE" : "INELIGIBLE",
  };
}
