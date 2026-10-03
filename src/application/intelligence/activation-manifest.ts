import { LEARNING_FAMILIES, type LearningFamily } from "@/domain/learning";
import { PATTERN_FAMILIES, type PatternFamily } from "@/domain/patterns";

/**
 * Packet 7A compile-time intelligence activation manifest.
 *
 * Deterministic-engine Sections 1.1 and 2 and the Packet 7A design Section 7:
 * activation is deployment composition only. Every Learning and Pattern
 * family has one exact typed disposition; nothing here reads runtime input.
 */

export type DisabledDisposition =
  | { kind: "DISABLED_NOT_IMPLEMENTED" }
  | { kind: "DISABLED_PRODUCT_SCOPE" }
  | { kind: "DORMANT_PROHIBITED" };

export type PatternRuleVersions = {
  familyRuleVersion: string;
  evidenceGateVersion: string;
  missingnessRuleVersion: string;
  metricRuleVersion: string;
};

export type EnabledPatternDisposition = {
  kind: "ENABLED";
  evaluatorKey: string;
  evaluatorVersion: string;
  configurationVersion: string;
  ruleVersions: PatternRuleVersions;
};

export type EnabledLearningDisposition = {
  kind: "ENABLED";
  evaluatorKey: string;
  evaluatorVersion: string;
  configurationVersion: string;
  assessmentPolicyVersion: string;
  evaluationRuleVersion: string;
  activationPolicyVersion: string;
};

export type IntelligenceActivationManifest = {
  manifestId: string;
  manifestVersion: string;
  learning: Readonly<Record<LearningFamily, EnabledLearningDisposition | DisabledDisposition>>;
  pattern: Readonly<Record<PatternFamily, EnabledPatternDisposition | DisabledDisposition>>;
};

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

const NOT_IMPLEMENTED = { kind: "DISABLED_NOT_IMPLEMENTED" } as const;

export const INTELLIGENCE_ACTIVATION_MANIFEST: IntelligenceActivationManifest = deepFreeze({
  manifestId: "jagaon-hackathon-intelligence",
  manifestVersion: "7a.1",
  learning: {
    ROUTINE: { ...NOT_IMPLEMENTED },
    BEHAVIOUR: { ...NOT_IMPLEMENTED },
    PREFERENCE: { ...NOT_IMPLEMENTED },
    CONTEXT: { ...NOT_IMPLEMENTED },
    BARRIER: { ...NOT_IMPLEMENTED },
    FAMILIAR_ITEM: {
      kind: "ENABLED",
      evaluatorKey: "learning.familiar-item",
      evaluatorVersion: "7a.1",
      configurationVersion: "familiar-item-learning-config.v1",
      assessmentPolicyVersion: "familiar-item-learning-policy.v1",
      evaluationRuleVersion: "familiar-item-learning-rule.v1",
      activationPolicyVersion: "familiar-item-activation.v1",
    },
  },
  pattern: {
    ROUTINE_SHIFT: { ...NOT_IMPLEMENTED },
    FAMILIAR_OR_FREQUENT_ITEM: {
      kind: "ENABLED",
      evaluatorKey: "pattern.familiar-or-frequent-item",
      evaluatorVersion: "7a.1",
      configurationVersion: "familiar-or-frequent-item-config.v1",
      ruleVersions: {
        familyRuleVersion: "familiar-or-frequent-item.v1",
        evidenceGateVersion: "familiar-item-gate.v1",
        missingnessRuleVersion: "missingness.v1",
        metricRuleVersion: "metric-utilities.v1",
      },
    },
    RECURRING_BARRIER: { ...NOT_IMPLEMENTED },
    COMPARABLE_SLOT_TREND: {
      kind: "ENABLED",
      evaluatorKey: "pattern.comparable-slot-trend",
      evaluatorVersion: "7a.1",
      configurationVersion: "comparable-slot-trend-config.v1",
      ruleVersions: {
        familyRuleVersion: "comparable-slot-trend.v1",
        evidenceGateVersion: "comparable-slot-gate.v1",
        missingnessRuleVersion: "missingness.v1",
        metricRuleVersion: "metric-utilities.v1",
      },
    },
    PRESCRIBED_TIMING_ALIGNMENT: { ...NOT_IMPLEMENTED },
    CONTEXT_BOUNDED_DEVIATION: { ...NOT_IMPLEMENTED },
    RETURN_TOWARD_BASELINE: { ...NOT_IMPLEMENTED },
    CROSS_VARIABLE_ASSOCIATION: { kind: "DORMANT_PROHIBITED" },
  },
} satisfies IntelligenceActivationManifest);

// --- Governed configuration (deterministic-engine Sections 5.1, 9.2, 10.1) ----

export const COMPARABLE_SLOT_TREND_CONFIG_V1 = deepFreeze({
  configurationVersion: "comparable-slot-trend-config.v1",
  /** Reference segment `[T - 42 days, T - 14 days)`. */
  referenceWindowStartDays: 42,
  /** Recent segment `[T - 14 days, T)`. */
  recentWindowDays: 14,
  eligibleSlots: ["FASTING", "BEFORE_BREAKFAST", "BEFORE_LUNCH", "BEFORE_DINNER", "BEDTIME", "OVERNIGHT"],
  lifecycleMinima: {
    SIGNAL: { reference: 4, recent: 3, referenceDates: 2, recentDates: 2 },
    EMERGING: { reference: 6, recent: 4, referenceDates: 3, recentDates: 3 },
    SUPPORTED: { reference: 8, recent: 6, referenceDates: 4, recentDates: 3, referenceWeeks: 3, recentWeeks: 2 },
  },
  materialMedianDifferenceMmolL: "1.0",
  maximumMaterialOverlapRatio: "0.5",
  materialDispersionDifferenceMmolL: "0.8",
  materialDispersionRatioHigh: "1.5",
  materialDispersionRatioLow: "0.67",
  stalenessDays: 30,
} as const);

export type ComparableSlotTrendConfig = typeof COMPARABLE_SLOT_TREND_CONFIG_V1;

export const FAMILIAR_OR_FREQUENT_ITEM_CONFIG_V1 = deepFreeze({
  configurationVersion: "familiar-or-frequent-item-config.v1",
  sourceWindowDays: 60,
  signalOccurrences: 2,
  emergingOccurrences: 3,
  supportedOccurrences: 4,
  supportedDistinctDays: 3,
  supportedSpanDays: 7,
  maximumLatestAgeDays: 30,
  stalenessDays: 60,
} as const);

export type FamiliarOrFrequentItemConfig = typeof FAMILIAR_OR_FREQUENT_ITEM_CONFIG_V1;

export const FAMILIAR_ITEM_LEARNING_CONFIG_V1 = deepFreeze({
  configurationVersion: "familiar-item-learning-config.v1",
  sourceWindowDays: 60,
  emerging: { occasions: 2, distinctDays: 2 },
  candidate: { occasions: 3, withinDays: 7 },
  active: { occasions: 4, distinctDays: 3, withinDays: 7 },
  stalenessDays: 60,
} as const);

export type FamiliarItemLearningConfig = typeof FAMILIAR_ITEM_LEARNING_CONFIG_V1;

// --- Resolution -----------------------------------------------------------------

export type PatternFamilyResolution =
  | { kind: "ENABLED"; family: PatternFamily; disposition: EnabledPatternDisposition }
  | {
      kind: "UNAVAILABLE";
      code: "PATTERN_FAMILY_DISABLED";
      family: PatternFamily;
      disposition: DisabledDisposition["kind"];
    }
  | { kind: "UNAVAILABLE"; code: "UNKNOWN_FAMILY" };

export type LearningFamilyResolution =
  | { kind: "ENABLED"; family: LearningFamily; disposition: EnabledLearningDisposition }
  | {
      kind: "UNAVAILABLE";
      code: "LEARNING_FAMILY_DISABLED";
      family: LearningFamily;
      disposition: DisabledDisposition["kind"];
    }
  | { kind: "UNAVAILABLE"; code: "UNKNOWN_FAMILY" };

/** A disabled or dormant family resolves to a typed result and no effect. */
export function resolvePatternFamily(family: PatternFamily): PatternFamilyResolution {
  if (!(PATTERN_FAMILIES as readonly string[]).includes(family)) return { kind: "UNAVAILABLE", code: "UNKNOWN_FAMILY" };
  const disposition = INTELLIGENCE_ACTIVATION_MANIFEST.pattern[family];
  if (disposition.kind === "ENABLED") return { kind: "ENABLED", family, disposition };
  return { kind: "UNAVAILABLE", code: "PATTERN_FAMILY_DISABLED", family, disposition: disposition.kind };
}

export function resolveLearningFamily(family: LearningFamily): LearningFamilyResolution {
  if (!(LEARNING_FAMILIES as readonly string[]).includes(family)) return { kind: "UNAVAILABLE", code: "UNKNOWN_FAMILY" };
  const disposition = INTELLIGENCE_ACTIVATION_MANIFEST.learning[family];
  if (disposition.kind === "ENABLED") return { kind: "ENABLED", family, disposition };
  return { kind: "UNAVAILABLE", code: "LEARNING_FAMILY_DISABLED", family, disposition: disposition.kind };
}

export function enabledPatternFamilies(): PatternFamily[] {
  return PATTERN_FAMILIES.filter((family) => INTELLIGENCE_ACTIVATION_MANIFEST.pattern[family].kind === "ENABLED");
}

export function enabledLearningFamilies(): LearningFamily[] {
  return LEARNING_FAMILIES.filter((family) => INTELLIGENCE_ACTIVATION_MANIFEST.learning[family].kind === "ENABLED");
}
