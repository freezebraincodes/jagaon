import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  INTELLIGENCE_ACTIVATION_MANIFEST,
  COMPARABLE_SLOT_TREND_CONFIG_V1,
  FAMILIAR_OR_FREQUENT_ITEM_CONFIG_V1,
  FAMILIAR_ITEM_LEARNING_CONFIG_V1,
  enabledLearningFamilies,
  enabledPatternFamilies,
  resolveLearningFamily,
  resolvePatternFamily,
} from "./activation-manifest";

describe("closed Packet 7A activation manifest", () => {
  it("names an exact disposition for every Learning family", () => {
    expect(
      Object.fromEntries(Object.entries(INTELLIGENCE_ACTIVATION_MANIFEST.learning).map(([k, v]) => [k, v.kind])),
    ).toEqual({
      ROUTINE: "DISABLED_NOT_IMPLEMENTED",
      BEHAVIOUR: "DISABLED_NOT_IMPLEMENTED",
      PREFERENCE: "DISABLED_NOT_IMPLEMENTED",
      CONTEXT: "DISABLED_NOT_IMPLEMENTED",
      BARRIER: "DISABLED_NOT_IMPLEMENTED",
      FAMILIAR_ITEM: "ENABLED",
    });
  });

  it("names an exact disposition for every Pattern family", () => {
    expect(
      Object.fromEntries(Object.entries(INTELLIGENCE_ACTIVATION_MANIFEST.pattern).map(([k, v]) => [k, v.kind])),
    ).toEqual({
      ROUTINE_SHIFT: "DISABLED_NOT_IMPLEMENTED",
      FAMILIAR_OR_FREQUENT_ITEM: "ENABLED",
      RECURRING_BARRIER: "DISABLED_NOT_IMPLEMENTED",
      COMPARABLE_SLOT_TREND: "ENABLED",
      PRESCRIBED_TIMING_ALIGNMENT: "DISABLED_NOT_IMPLEMENTED",
      CONTEXT_BOUNDED_DEVIATION: "DISABLED_NOT_IMPLEMENTED",
      RETURN_TOWARD_BASELINE: "DISABLED_NOT_IMPLEMENTED",
      CROSS_VARIABLE_ASSOCIATION: "DORMANT_PROHIBITED",
    });
  });

  it("pins exact evaluator, configuration and rule versions for enabled families", () => {
    expect(INTELLIGENCE_ACTIVATION_MANIFEST.manifestId).toBe("jagaon-hackathon-intelligence");
    expect(INTELLIGENCE_ACTIVATION_MANIFEST.manifestVersion).toBe("7a.1");
    expect(INTELLIGENCE_ACTIVATION_MANIFEST.pattern.COMPARABLE_SLOT_TREND).toEqual({
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
    });
    expect(INTELLIGENCE_ACTIVATION_MANIFEST.pattern.FAMILIAR_OR_FREQUENT_ITEM).toEqual({
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
    });
    expect(INTELLIGENCE_ACTIVATION_MANIFEST.learning.FAMILIAR_ITEM).toEqual({
      kind: "ENABLED",
      evaluatorKey: "learning.familiar-item",
      evaluatorVersion: "7a.1",
      configurationVersion: "familiar-item-learning-config.v1",
      assessmentPolicyVersion: "familiar-item-learning-policy.v1",
      evaluationRuleVersion: "familiar-item-learning-rule.v1",
      activationPolicyVersion: "familiar-item-activation.v1",
    });
  });

  it("carries the governed thresholds exactly", () => {
    expect(COMPARABLE_SLOT_TREND_CONFIG_V1).toEqual({
      configurationVersion: "comparable-slot-trend-config.v1",
      referenceWindowStartDays: 42,
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
    });
    expect(FAMILIAR_OR_FREQUENT_ITEM_CONFIG_V1).toEqual({
      configurationVersion: "familiar-or-frequent-item-config.v1",
      sourceWindowDays: 60,
      signalOccurrences: 2,
      emergingOccurrences: 3,
      supportedOccurrences: 4,
      supportedDistinctDays: 3,
      supportedSpanDays: 7,
      maximumLatestAgeDays: 30,
      stalenessDays: 60,
    });
    expect(FAMILIAR_ITEM_LEARNING_CONFIG_V1).toEqual({
      configurationVersion: "familiar-item-learning-config.v1",
      sourceWindowDays: 60,
      emerging: { occasions: 2, distinctDays: 2 },
      candidate: { occasions: 3, withinDays: 7 },
      active: { occasions: 4, distinctDays: 3, withinDays: 7 },
      stalenessDays: 60,
    });
  });

  it("is deeply frozen", () => {
    expect(Object.isFrozen(INTELLIGENCE_ACTIVATION_MANIFEST)).toBe(true);
    expect(Object.isFrozen(INTELLIGENCE_ACTIVATION_MANIFEST.pattern)).toBe(true);
    expect(Object.isFrozen(INTELLIGENCE_ACTIVATION_MANIFEST.pattern.COMPARABLE_SLOT_TREND)).toBe(true);
    expect(Object.isFrozen(COMPARABLE_SLOT_TREND_CONFIG_V1.lifecycleMinima.SUPPORTED)).toBe(true);
  });

  it("lists only the enabled families", () => {
    expect(enabledPatternFamilies()).toEqual(["FAMILIAR_OR_FREQUENT_ITEM", "COMPARABLE_SLOT_TREND"]);
    expect(enabledLearningFamilies()).toEqual(["FAMILIAR_ITEM"]);
  });

  it("returns a typed unavailable result for disabled, dormant and unknown families", () => {
    expect(resolvePatternFamily("ROUTINE_SHIFT")).toEqual({
      kind: "UNAVAILABLE",
      code: "PATTERN_FAMILY_DISABLED",
      family: "ROUTINE_SHIFT",
      disposition: "DISABLED_NOT_IMPLEMENTED",
    });
    expect(resolvePatternFamily("CROSS_VARIABLE_ASSOCIATION")).toEqual({
      kind: "UNAVAILABLE",
      code: "PATTERN_FAMILY_DISABLED",
      family: "CROSS_VARIABLE_ASSOCIATION",
      disposition: "DORMANT_PROHIBITED",
    });
    expect(resolvePatternFamily("SLEEP_QUALITY" as never)).toEqual({ kind: "UNAVAILABLE", code: "UNKNOWN_FAMILY" });
    expect(resolveLearningFamily("BARRIER")).toEqual({
      kind: "UNAVAILABLE",
      code: "LEARNING_FAMILY_DISABLED",
      family: "BARRIER",
      disposition: "DISABLED_NOT_IMPLEMENTED",
    });
    expect(resolvePatternFamily("COMPARABLE_SLOT_TREND").kind).toBe("ENABLED");
  });

  it("cannot be activated from query parameters, browser storage or the environment", () => {
    const source = readFileSync(join(process.cwd(), "src/application/intelligence/activation-manifest.ts"), "utf8");
    for (const escapeHatch of ["localStorage", "sessionStorage", "process.env", "URLSearchParams", "location", "window"]) {
      expect(source.includes(escapeHatch), escapeHatch).toBe(false);
    }
  });
});
