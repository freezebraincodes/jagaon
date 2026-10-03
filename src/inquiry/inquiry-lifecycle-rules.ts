import type { Instant } from "@/domain/shared/time";
import type { EnabledInquiryDefinition } from "@/domain/inquiry/inquiry-registry";
import type { InquiryPayload, InquiryPresentation } from "@/domain/inquiry/inquiry";
import type { TypedRevisionRef } from "@/domain/shared/typed-revision-ref";
import type { RecordType } from "@/domain/shared/record-catalogue";
import type { InquiryCapabilityManifest, SnoozeChoice } from "./inquiry-capability-manifest";
import { assessBarrierEligibility, type BarrierBasisView, type PriorBarrierInquiry } from "./medication-occasion-barrier";
import { budgetBlock, type BudgetState } from "./inquiry-arbiter";

/**
 * Presentation revalidation, expiry and governed reconsideration
 * (deterministic-engine Sections 13.4, 14.2 and 14.3).
 */

const DAY_MS = 86_400_000;

export type RevalidationOutcome =
  | { kind: "VALID_FOR_PRESENTATION"; basisRevisions: TypedRevisionRef<RecordType>[] }
  | { kind: "DEFER"; reason: "CONCURRENT_PRESENTATION_LIMIT" | "CONTEXTUAL_DAILY_LIMIT" | "CONTEXTUAL_WEEKLY_LIMIT" | "MINIMUM_INTERVAL_NOT_ELAPSED" }
  | { kind: "EXPIRE"; reason: "ANSWERABILITY_ENDED" | "DEFINITION_WITHDRAWN" }
  | {
      kind: "WITHDRAW";
      reason: "EVIDENCE_CHANGED" | "ELIGIBILITY_CHANGED" | "CURRENT_ANSWER_AVAILABLE" | "PATIENT_PREFERENCE";
    };

/**
 * Rechecks the exact candidate immediately before display: source heads,
 * expiry, deduplication and prior dispositions, budget and current
 * eligibility. A stale candidate is never shown merely because it was queued.
 */
export function revalidateForPresentation(input: {
  definition: EnabledInquiryDefinition;
  manifest: InquiryCapabilityManifest;
  payload: InquiryPayload;
  basis: BarrierBasisView;
  priors: readonly PriorBarrierInquiry[];
  budget: BudgetState;
  now: Instant;
}): RevalidationOutcome {
  const { definition, manifest, payload, basis, priors, budget, now } = input;
  if (payload.expiresAt && Date.parse(now) >= Date.parse(payload.expiresAt)) return { kind: "EXPIRE", reason: "ANSWERABILITY_ENDED" };
  if (manifest.definitions[definition.definitionKey]?.kind !== "ENABLED") return { kind: "EXPIRE", reason: "DEFINITION_WITHDRAWN" };
  const basisRef = payload.basis.purpose === "RECORD_CLARIFICATION" ? payload.basis.records[0] : null;
  if (!basisRef || basisRef.revisionId !== basis.ref.revisionId || !basis.isCurrentHead) return { kind: "WITHDRAW", reason: "EVIDENCE_CHANGED" };

  const assessment = assessBarrierEligibility({ definition, manifest, basis, priors, now });
  if (assessment.outcome !== "ELIGIBLE") {
    const failed = assessment.dimensions.find((entry) => entry.outcome !== "PASS")!;
    if (failed.dimension === "CURRENT_ANSWER_ABSENT") return { kind: "WITHDRAW", reason: "CURRENT_ANSWER_AVAILABLE" };
    if (failed.dimension === "PREVIOUS_DISPOSITION") return { kind: "WITHDRAW", reason: "PATIENT_PREFERENCE" };
    if (failed.dimension === "IDENTIFIABLE_BASIS") return { kind: "WITHDRAW", reason: "EVIDENCE_CHANGED" };
    if (failed.dimension === "ANSWERABLE" || failed.dimension === "USEFUL_NOW") return { kind: "EXPIRE", reason: "ANSWERABILITY_ENDED" };
    return { kind: "WITHDRAW", reason: "ELIGIBILITY_CHANGED" };
  }
  const blocked = budgetBlock(manifest, budget, definition.presentationClass, now);
  if (blocked === "CONCURRENT_PRESENTATION_LIMIT" || blocked === "CONTEXTUAL_DAILY_LIMIT" || blocked === "CONTEXTUAL_WEEKLY_LIMIT" || blocked === "MINIMUM_INTERVAL_NOT_ELAPSED") {
    return { kind: "DEFER", reason: blocked };
  }
  return { kind: "VALID_FOR_PRESENTATION", basisRevisions: [basis.ref] };
}

/** A contextual presentation stops being answerable after its governed expiry. */
export function presentationExpired(presentation: InquiryPresentation, manifest: InquiryCapabilityManifest, now: Instant): boolean {
  const policy = manifest.presentationExpiry;
  const limitMs =
    presentation.presentationClass === "INLINE_CLARIFICATION"
      ? policy.inlineMinutes * 60_000
      : presentation.surface === "HOME_PROMPT"
        ? policy.homeCardHours * 3_600_000
        : policy.contextualDays * DAY_MS;
  return Date.parse(now) - Date.parse(presentation.presentedAt) >= limitMs;
}

export type SnoozeResolution = { kind: "ELIGIBLE_AGAIN_AT"; eligibleAgainAt: Instant } | { kind: "TIMEZONE_RECONCILIATION_REQUIRED" };

/**
 * Snooze preserves the selected local wall-clock time in the configured home
 * timezone and adds 1, 3 or 7 local calendar days. Only the configured fixed-
 * offset home timezone resolves; anything else stays snoozed for
 * reconciliation rather than guessing an instant.
 */
export function snoozeUntil(manifest: InquiryCapabilityManifest, choice: SnoozeChoice, now: Instant, timeZoneId: string): SnoozeResolution {
  const policy = manifest.medicationOccasionBarrier;
  if (timeZoneId !== policy.homeTimeZoneId) return { kind: "TIMEZONE_RECONCILIATION_REQUIRED" };
  const offset = policy.homeUtcOffsetMinutes * 60_000;
  const local = new Date(Date.parse(now) + offset);
  const shifted = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate() + manifest.reconsideration.snoozeDays[choice],
    local.getUTCHours(),
    local.getUTCMinutes(),
    local.getUTCSeconds(),
    local.getUTCMilliseconds(),
  );
  return { kind: "ELIGIBLE_AGAIN_AT", eligibleAgainAt: new Date(shifted - offset).toISOString() as Instant };
}
