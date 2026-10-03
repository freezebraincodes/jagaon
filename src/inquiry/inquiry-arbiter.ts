import type { Instant } from "@/domain/shared/time";
import type { InquiryDecisionReasonCodeValue, InquiryPresentationClass } from "@/domain/inquiry/inquiry-registry";
import {
  INQUIRY_PRIORITY_FACTORS,
  type InquiryEligibilityAssessment,
  type InquiryPriorityFactor,
  type InquiryPriorityFactorResult,
  type InquiryQueueDecision,
} from "@/domain/inquiry/inquiry";
import type { InquiryCapabilityManifest } from "./inquiry-capability-manifest";
import { reason } from "./medication-occasion-barrier";

/**
 * Shared deterministic queue arbiter (deterministic-engine Sections 13.3 and
 * 14.1). One patient-level interruption budget applies across every engine
 * and surface; there are no private budgets and no opaque or AI scores.
 * Every candidate receives a component-based decision explaining why it was
 * queued, not selected or blocked.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export type ArbiterCandidate = {
  inquiryRecordId: string;
  priorityRuleVersion: string;
  presentationClass: InquiryPresentationClass;
  eligibility: InquiryEligibilityAssessment;
  expiresAt: Instant | null;
  firstEligibleAt: Instant;
  /** True when the candidate concerns what the patient is viewing or just recorded. */
  inCurrentView: boolean;
  /** Occasion or evidence instant used for time relevance. */
  relevantAt: Instant;
  boundedChoice: boolean;
};

export type PresentationHistoryEntry = {
  inquiryRecordId: string;
  presentedAt: Instant;
  presentationClass: InquiryPresentationClass;
};

export type BudgetState = {
  /** Inquiries other than these candidates whose current head is PRESENTED. */
  presentedNow: readonly string[];
  /** Every committed presentation revision, any chain. */
  history: readonly PresentationHistoryEntry[];
};

export type ArbiterDecision = {
  inquiryRecordId: string;
  decision: InquiryQueueDecision;
};

function factorResult(factor: InquiryPriorityFactor, effect: InquiryPriorityFactorResult["effect"], codes: InquiryDecisionReasonCodeValue[] = []) {
  return { factor, effect, reasonCodes: codes.map(reason) };
}

/** The first budget limit that blocks presenting a candidate of this class now, if any. */
export function budgetBlock(
  manifest: InquiryCapabilityManifest,
  budget: BudgetState,
  presentationClass: InquiryPresentationClass,
  now: Instant,
): InquiryDecisionReasonCodeValue | null {
  const policy = manifest.budget;
  if (budget.presentedNow.length >= policy.concurrentPresentedNonSafety) return "CONCURRENT_PRESENTATION_LIMIT";
  if (presentationClass === "INLINE_CLARIFICATION") return null;
  const nowMs = Date.parse(now);
  const unsolicited = budget.history.filter((entry) => entry.presentationClass !== "INLINE_CLARIFICATION");
  const chainsWithin = (entries: readonly PresentationHistoryEntry[], ms: number) =>
    new Set(entries.filter((entry) => nowMs - Date.parse(entry.presentedAt) < ms).map((entry) => entry.inquiryRecordId)).size;
  if (chainsWithin(unsolicited, DAY_MS) >= policy.contextualPlusOpportunistic.per24Hours) return "CONTEXTUAL_DAILY_LIMIT";
  if (chainsWithin(unsolicited, 7 * DAY_MS) >= policy.contextualPlusOpportunistic.per7Days) return "CONTEXTUAL_WEEKLY_LIMIT";
  if (presentationClass === "OPPORTUNISTIC") {
    const opportunistic = budget.history.filter((entry) => entry.presentationClass === "OPPORTUNISTIC");
    if (chainsWithin(opportunistic, DAY_MS) >= policy.opportunistic.per24Hours) return "CONTEXTUAL_DAILY_LIMIT";
    if (chainsWithin(opportunistic, 7 * DAY_MS) >= policy.opportunistic.per7Days) return "CONTEXTUAL_WEEKLY_LIMIT";
  }
  const lastShown = unsolicited.reduce<number | null>((latest, entry) => {
    const at = Date.parse(entry.presentedAt);
    return latest === null || at > latest ? at : latest;
  }, null);
  if (lastShown !== null && nowMs - lastShown < policy.minimumNonInlineIntervalMinutes * 60_000) return "MINIMUM_INTERVAL_NOT_ELAPSED";
  return null;
}

function baseFactors(candidate: ArbiterCandidate, manifest: InquiryCapabilityManifest, now: Instant): InquiryPriorityFactorResult[] {
  const recent =
    Date.parse(now) - Date.parse(candidate.relevantAt) < manifest.medicationOccasionBarrier.recentOccasionDays * DAY_MS;
  return [
    factorResult("EXPECTED_INFORMATION_VALUE", "NO_CHANGE"),
    factorResult("TIME_RELEVANCE", recent ? "INCREASE_PRIORITY" : "NO_CHANGE", recent ? ["RECENT_OCCASION"] : []),
    factorResult("EVIDENCE_MATURITY", "NO_CHANGE"),
    factorResult("PERMITTED_CONSEQUENCE", "NO_CHANGE", ["PERMITTED_CONSEQUENCE_FACTUAL_COUNT"]),
    factorResult("ANSWERABILITY", "NO_CHANGE", ["OCCASION_ANSWERABLE"]),
    factorResult("BURDEN_AND_SENSITIVITY", candidate.boundedChoice ? "INCREASE_PRIORITY" : "NO_CHANGE", candidate.boundedChoice ? ["LOW_BURDEN_BOUNDED_CHOICE"] : []),
    factorResult("PREVIOUS_DISPOSITION", "NO_CHANGE", ["NO_BLOCKING_DISPOSITION"]),
  ];
}

function tier(factors: readonly InquiryPriorityFactorResult[]): number {
  return factors.reduce(
    (score, entry) => score + (entry.effect === "INCREASE_PRIORITY" ? 1 : entry.effect === "DECREASE_PRIORITY" ? -1 : 0),
    0,
  );
}

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Arbitrates the ordinary candidates of one view. Only eligible candidates
 * compete. Ties use priority tier, patient-visible current usefulness,
 * earliest expiry, oldest first-eligible instant and stable identifier.
 * At most the available budget — and one contextual question per view — is
 * selected.
 */
export function arbitrateInquiries(input: {
  manifest: InquiryCapabilityManifest;
  candidates: readonly ArbiterCandidate[];
  budget: BudgetState;
  now: Instant;
}): ArbiterDecision[] {
  const { manifest, budget, now } = input;
  const decide = (candidate: ArbiterCandidate, factors: InquiryPriorityFactorResult[], outcome: InquiryQueueDecision["outcome"]): ArbiterDecision => ({
    inquiryRecordId: candidate.inquiryRecordId,
    decision: {
      evaluatedAt: now,
      priorityRuleVersion: candidate.priorityRuleVersion,
      interruptionBudgetVersion: manifest.budget.version,
      factors,
      outcome,
    },
  });

  const scored = input.candidates.map((candidate) => ({ candidate, factors: baseFactors(candidate, manifest, now) }));
  const ordered = [...scored].sort(
    (a, b) =>
      tier(b.factors) - tier(a.factors) ||
      Number(b.candidate.inCurrentView) - Number(a.candidate.inCurrentView) ||
      (Date.parse(a.candidate.expiresAt ?? "9999-12-31T00:00:00.000Z") - Date.parse(b.candidate.expiresAt ?? "9999-12-31T00:00:00.000Z")) ||
      Date.parse(a.candidate.firstEligibleAt) - Date.parse(b.candidate.firstEligibleAt) ||
      compareText(a.candidate.inquiryRecordId, b.candidate.inquiryRecordId),
  );

  let selected = 0;
  const decisions = new Map<string, ArbiterDecision>();
  for (const { candidate, factors } of ordered) {
    const competition = (effect: InquiryPriorityFactorResult["effect"], codes: InquiryDecisionReasonCodeValue[]) => [
      ...factors,
      factorResult("COMPETITION", effect, codes),
    ];
    if (candidate.eligibility.outcome !== "ELIGIBLE") {
      decisions.set(candidate.inquiryRecordId, decide(candidate, competition("BLOCK", ["DEFINITION_NOT_ENABLED"]), "BLOCKED"));
      continue;
    }
    const blocked = budgetBlock(manifest, budget, candidate.presentationClass, now);
    if (blocked) {
      decisions.set(candidate.inquiryRecordId, decide(candidate, competition("BLOCK", [blocked]), "BLOCKED"));
      continue;
    }
    if (candidate.presentationClass === "CONTEXTUAL" && !candidate.inCurrentView) {
      decisions.set(candidate.inquiryRecordId, decide(candidate, competition("NO_CHANGE", ["NOT_IN_CURRENT_VIEW"]), "NOT_SELECTED"));
      continue;
    }
    if (selected >= Math.min(manifest.budget.contextualPerView, manifest.budget.concurrentPresentedNonSafety)) {
      decisions.set(
        candidate.inquiryRecordId,
        decide(candidate, competition("DECREASE_PRIORITY", ["LOWER_PRIORITY_THAN_SELECTED", "VIEW_CONTEXTUAL_LIMIT"]), "NOT_SELECTED"),
      );
      continue;
    }
    selected += 1;
    const codes: InquiryDecisionReasonCodeValue[] = ["BUDGET_AVAILABLE", ordered.length === 1 ? "NO_COMPETITION" : "EXPLICIT_RECORD_IN_CURRENT_VIEW"];
    decisions.set(candidate.inquiryRecordId, decide(candidate, competition("NO_CHANGE", codes), "QUEUED"));
  }
  // Decisions keep each factor exactly once in the declared order.
  return input.candidates.map((candidate) => {
    const entry = decisions.get(candidate.inquiryRecordId)!;
    const byFactor = new Map(entry.decision.factors.map((factor) => [factor.factor, factor]));
    return { ...entry, decision: { ...entry.decision, factors: INQUIRY_PRIORITY_FACTORS.map((factor) => byFactor.get(factor)!) } };
  });
}
