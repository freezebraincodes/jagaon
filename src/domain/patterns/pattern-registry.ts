import { z } from "zod";

// --- Section 8.10: closed Pattern families and lifecycle -------------------

export const PATTERN_FAMILIES = Object.freeze([
  "ROUTINE_SHIFT",
  "FAMILIAR_OR_FREQUENT_ITEM",
  "RECURRING_BARRIER",
  "COMPARABLE_SLOT_TREND",
  "PRESCRIBED_TIMING_ALIGNMENT",
  "CONTEXT_BOUNDED_DEVIATION",
  "RETURN_TOWARD_BASELINE",
  "CROSS_VARIABLE_ASSOCIATION",
] as const);

export type PatternFamily = (typeof PATTERN_FAMILIES)[number];

export const patternFamilySchema = z.enum(PATTERN_FAMILIES);

export const PATTERN_LIFECYCLE_STATES = Object.freeze([
  "SIGNAL",
  "EMERGING",
  "WATCHING",
  "SUPPORTED",
  "WEAKENING",
  "STALE",
  "SUPERSEDED",
  "REJECTED",
  "RETIRED",
] as const);

export type PatternLifecycleState = (typeof PATTERN_LIFECYCLE_STATES)[number];

// --- Section 8.10: evidence membership, exclusions and limitations ---------

export const PATTERN_EVIDENCE_GROUP_ROLES = Object.freeze([
  "SUPPORTING",
  "CONTRADICTORY",
  "NEUTRAL",
  "BASELINE",
  "RECENT",
  "EXPOSED",
  "COMPARATOR",
  "OUTCOME",
] as const);

export type PatternEvidenceGroupRole = (typeof PATTERN_EVIDENCE_GROUP_ROLES)[number];

export const PATTERN_EXCLUSION_REASONS = Object.freeze([
  "DUPLICATE_LOGICAL_OCCASION",
  "CORRECTED_AWAY",
  "INELIGIBLE_PROVENANCE",
  "INSUFFICIENT_TEMPORAL_PRECISION",
  "OUTSIDE_ANALYSIS_WINDOW",
  "CONTEXT_OR_CARE_BOUNDARY",
  "INCOMPATIBLE_SLOT_OR_CATEGORY",
  "AMBIGUOUS_IDENTITY",
  "UNKNOWN_COMPARISON_STATUS",
  "FAMILY_POLICY_EXCLUSION",
] as const);

export type PatternExclusionReason = (typeof PATTERN_EXCLUSION_REASONS)[number];

export const PATTERN_LIMITATION_CODES = Object.freeze([
  "SPARSE_RECORDING",
  "UNKNOWN_NEGATIVE_STATUS",
  "LIMITED_COMPARISON",
  "HIGH_VARIABILITY",
  "CONTRADICTORY_EVIDENCE",
  "CONTEXT_OVERLAP",
  "CARE_PLAN_BOUNDARY",
  "INSUFFICIENT_TIME_PRECISION",
  "IDENTITY_UNCERTAINTY",
  "MEASUREMENT_METHOD_CHANGE",
  "RECENCY_LIMIT",
] as const);

export type PatternLimitationCode = (typeof PATTERN_LIMITATION_CODES)[number];

/** Roles each family contract gives meaning to (Sections 8.11–8.16). */
export const PATTERN_FAMILY_GROUP_ROLES: Readonly<Record<PatternFamily, readonly PatternEvidenceGroupRole[]>> =
  Object.freeze({
    ROUTINE_SHIFT: ["BASELINE", "RECENT", "CONTRADICTORY"],
    FAMILIAR_OR_FREQUENT_ITEM: ["SUPPORTING", "COMPARATOR", "CONTRADICTORY"],
    RECURRING_BARRIER: ["SUPPORTING", "NEUTRAL", "CONTRADICTORY"],
    COMPARABLE_SLOT_TREND: ["BASELINE", "RECENT", "NEUTRAL", "CONTRADICTORY"],
    PRESCRIBED_TIMING_ALIGNMENT: ["SUPPORTING", "CONTRADICTORY", "NEUTRAL"],
    CONTEXT_BOUNDED_DEVIATION: ["BASELINE", "EXPOSED", "CONTRADICTORY", "NEUTRAL"],
    RETURN_TOWARD_BASELINE: ["BASELINE", "COMPARATOR", "RECENT", "CONTRADICTORY"],
    CROSS_VARIABLE_ASSOCIATION: ["EXPOSED", "OUTCOME", "COMPARATOR", "SUPPORTING", "CONTRADICTORY", "NEUTRAL"],
  });

/**
 * Role pairs whose membership may overlap. Only the comparable-slot family
 * explicitly lets an eligible reading also be named as contradictory.
 */
export const PATTERN_FAMILY_OVERLAPPING_ROLES: Readonly<Record<PatternFamily, readonly string[]>> = Object.freeze({
  ROUTINE_SHIFT: [],
  FAMILIAR_OR_FREQUENT_ITEM: [],
  RECURRING_BARRIER: [],
  COMPARABLE_SLOT_TREND: ["BASELINE|CONTRADICTORY", "CONTRADICTORY|RECENT"],
  PRESCRIBED_TIMING_ALIGNMENT: [],
  CONTEXT_BOUNDED_DEVIATION: [],
  RETURN_TOWARD_BASELINE: [],
  CROSS_VARIABLE_ASSOCIATION: [],
});

// --- Section 8.10: Evidence Gate ---------------------------------------------

export const PATTERN_GATE_DIMENSIONS = Object.freeze([
  "SUPPORT",
  "COVERAGE",
  "COMPARISON",
  "MISSINGNESS",
  "RECENCY",
  "CONSISTENCY",
  "CONTRADICTION",
  "CONTEXT",
  "STABILITY",
  "MAGNITUDE_OR_USEFULNESS",
  "PRIOR_PATIENT_DISPOSITION",
] as const);

export type PatternGateDimension = (typeof PATTERN_GATE_DIMENSIONS)[number];

export type PatternGateOutcome = "PASS" | "FAIL" | "INDETERMINATE" | "NOT_APPLICABLE";
export type PatternGateOverall = "INSUFFICIENT" | "CONTINUE_OBSERVING" | "SUPPORTED";
export type PatternGateRole = "HARD" | "LIMITATION_ONLY" | "NOT_APPLICABLE";

type GateDimensionDefinition = {
  role: PatternGateRole;
  reasonCodes: readonly string[];
};

export type PatternGateDefinition = {
  family: PatternFamily;
  dimensions: Readonly<Record<PatternGateDimension, GateDimensionDefinition>>;
};

/**
 * Closed reviewed reason-code registries keyed by `evidenceGateVersion`.
 * Only the two Packet 7A families have a gate version; a snapshot for any
 * other family cannot validate, so it cannot be manufactured or persisted.
 */
export const PATTERN_GATE_REGISTRY: Readonly<Record<string, PatternGateDefinition>> = Object.freeze({
  "comparable-slot-gate.v1": {
    family: "COMPARABLE_SLOT_TREND",
    dimensions: {
      SUPPORT: {
        role: "HARD",
        reasonCodes: ["SUPPORT_MINIMUM_MET", "SUPPORT_BELOW_SUPPORTED_MINIMUM", "SUPPORT_BELOW_SIGNAL_MINIMUM"],
      },
      COVERAGE: {
        role: "HARD",
        reasonCodes: [
          "COVERAGE_DATES_AND_WEEKS_MET",
          "COVERAGE_BELOW_SUPPORTED_DATES_OR_WEEKS",
          "COVERAGE_BELOW_SIGNAL_DATES",
        ],
      },
      COMPARISON: { role: "HARD", reasonCodes: ["SAME_SLOT_AND_METHOD", "MIXED_MEASUREMENT_METHODS"] },
      MISSINGNESS: { role: "LIMITATION_ONLY", reasonCodes: ["MISSING_READINGS_REMAIN_UNKNOWN"] },
      RECENCY: { role: "LIMITATION_ONLY", reasonCodes: ["RECENT_SEGMENT_HAS_READINGS"] },
      CONSISTENCY: {
        role: "HARD",
        reasonCodes: ["SPLIT_HALVES_AGREE", "SPLIT_HALVES_DISAGREE", "SPLIT_HALVES_NOT_ASSESSED"],
      },
      CONTRADICTION: { role: "NOT_APPLICABLE", reasonCodes: ["CONTRADICTION_ASSESSED_BY_SPLIT_HALVES"] },
      CONTEXT: { role: "HARD", reasonCodes: ["NO_RECORDED_CONTEXT_OR_CARE_BOUNDARY"] },
      STABILITY: {
        role: "HARD",
        reasonCodes: [
          "STABILITY_NOT_REQUIRED_FOR_DIRECTION",
          "VARIABILITY_CONFIRMED_ON_SUCCESSIVE_EVALUATION",
          "VARIABILITY_AWAITING_SUCCESSIVE_EVALUATION",
        ],
      },
      MAGNITUDE_OR_USEFULNESS: {
        role: "HARD",
        reasonCodes: ["MEDIAN_DIFFERENCE_MATERIAL", "VARIABILITY_DIFFERENCE_MATERIAL", "NO_MATERIAL_DIFFERENCE"],
      },
      PRIOR_PATIENT_DISPOSITION: { role: "HARD", reasonCodes: ["NO_PRIOR_PATIENT_DISPOSITION"] },
    },
  },
  "familiar-item-gate.v1": {
    family: "FAMILIAR_OR_FREQUENT_ITEM",
    dimensions: {
      SUPPORT: {
        role: "HARD",
        reasonCodes: [
          "OCCURRENCE_MINIMUM_MET",
          "OCCURRENCES_BELOW_SUPPORTED_MINIMUM",
          "OCCURRENCES_BELOW_SIGNAL_MINIMUM",
        ],
      },
      COVERAGE: {
        role: "HARD",
        reasonCodes: ["DISTINCT_DAYS_WITHIN_SEVEN_DAYS_MET", "DISTINCT_DAYS_WITHIN_SEVEN_DAYS_NOT_MET"],
      },
      COMPARISON: { role: "NOT_APPLICABLE", reasonCodes: ["RECURRENCE_CLAIM_HAS_NO_COMPARATOR"] },
      MISSINGNESS: { role: "LIMITATION_ONLY", reasonCodes: ["UNLOGGED_OCCASIONS_REMAIN_UNKNOWN"] },
      RECENCY: {
        role: "HARD",
        reasonCodes: ["LATEST_OCCURRENCE_WITHIN_THIRTY_DAYS", "LATEST_OCCURRENCE_OLDER_THAN_THIRTY_DAYS"],
      },
      CONSISTENCY: { role: "HARD", reasonCodes: ["EXACT_OR_NORMALISED_IDENTITY"] },
      CONTRADICTION: { role: "HARD", reasonCodes: ["NO_PATIENT_CONTRADICTION_RECORDED"] },
      CONTEXT: { role: "HARD", reasonCodes: ["NO_RECORDED_CONTEXT_BOUNDARY"] },
      STABILITY: { role: "NOT_APPLICABLE", reasonCodes: ["STABILITY_NOT_APPLICABLE_TO_RECURRENCE"] },
      MAGNITUDE_OR_USEFULNESS: { role: "NOT_APPLICABLE", reasonCodes: ["MAGNITUDE_NOT_APPLICABLE_TO_RECURRENCE"] },
      PRIOR_PATIENT_DISPOSITION: { role: "HARD", reasonCodes: ["NO_PRIOR_PATIENT_DISPOSITION"] },
    },
  },
});

/**
 * Deterministic aggregation (deterministic-engine Section 8.1): a failed hard
 * dimension yields INSUFFICIENT, otherwise an indeterminate hard dimension
 * yields CONTINUE_OBSERVING, otherwise SUPPORTED. Dimensions missing from the
 * input are treated as passing so callers can aggregate partial results.
 */
export function aggregatePatternGate(
  gateVersion: string,
  results: readonly { dimension: PatternGateDimension; outcome: PatternGateOutcome }[],
): PatternGateOverall {
  const definition = PATTERN_GATE_REGISTRY[gateVersion];
  if (!definition) throw new RangeError("UNKNOWN_EVIDENCE_GATE_VERSION");
  const hard = results.filter((result) => definition.dimensions[result.dimension].role === "HARD");
  if (hard.some((result) => result.outcome === "FAIL")) return "INSUFFICIENT";
  if (hard.some((result) => result.outcome === "INDETERMINATE")) return "CONTINUE_OBSERVING";
  return "SUPPORTED";
}
