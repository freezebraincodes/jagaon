import { describe, expect, it } from "vitest";
import { AI_TASK_TYPES, type AiTaskType } from "@/domain/ai";
import { AI_TASK_RUNTIME_BUNDLES, resolveAiTaskBundle } from "./ai-runtime-bundles";

/** Packet 11A Task 2: immutable task bundles and the Section 14.1 evaluation ceilings. */

const CEILINGS: Record<AiTaskType, { maxFacts: number; input: number; output: number; reasoning: "MINIMUM" | "LOW"; attempts: number; repair: boolean; perCallMs: number; overallMs: number; tier: "LIGHT" | "BALANCED" }> = {
  EXTRACT_CANDIDATE_FACTS: { maxFacts: 5, input: 1600, output: 500, reasoning: "MINIMUM", attempts: 2, repair: true, perCallMs: 10_000, overallMs: 18_000, tier: "LIGHT" },
  EXPLAIN_PATTERN: { maxFacts: 12, input: 2200, output: 350, reasoning: "MINIMUM", attempts: 2, repair: true, perCallMs: 10_000, overallMs: 18_000, tier: "LIGHT" },
  DRAFT_NEUTRAL_INQUIRY: { maxFacts: 6, input: 1200, output: 220, reasoning: "MINIMUM", attempts: 1, repair: false, perCallMs: 8_000, overallMs: 8_000, tier: "LIGHT" },
  ANSWER_BOUNDED_RECORD_QUERY: { maxFacts: 24, input: 2800, output: 500, reasoning: "MINIMUM", attempts: 2, repair: true, perCallMs: 12_000, overallMs: 22_000, tier: "LIGHT" },
  DRAFT_CARE_PREPARATION_SUMMARY: { maxFacts: 32, input: 4000, output: 800, reasoning: "LOW", attempts: 2, repair: true, perCallMs: 18_000, overallMs: 32_000, tier: "BALANCED" },
  PHRASE_NON_CLINICAL_RESPONSE: { maxFacts: 4, input: 900, output: 140, reasoning: "MINIMUM", attempts: 1, repair: false, perCallMs: 6_000, overallMs: 6_000, tier: "LIGHT" },
};

describe("AI task runtime bundles", () => {
  it("has exactly one immutable bundle per registered task", () => {
    expect(Object.keys(AI_TASK_RUNTIME_BUNDLES).sort()).toEqual([...AI_TASK_TYPES].sort());
    expect(Object.isFrozen(AI_TASK_RUNTIME_BUNDLES)).toBe(true);
    for (const taskType of AI_TASK_TYPES) {
      const bundle = AI_TASK_RUNTIME_BUNDLES[taskType];
      expect(Object.isFrozen(bundle)).toBe(true);
      expect(Object.isFrozen(bundle.executionBudget)).toBe(true);
      expect(bundle.taskType).toBe(taskType);
    }
  });

  it.each(AI_TASK_TYPES)("%s pins every component version, a paired locale pack and the deterministic-only route", (taskType) => {
    const bundle = AI_TASK_RUNTIME_BUNDLES[taskType];
    const kebab = taskType.toLowerCase().replaceAll("_", "-");
    // Packet 11B.5 Option B: EXPLAIN_PATTERN components are 11b.1; every other task stays 11a.1.
    const version = taskType === "EXPLAIN_PATTERN" ? "11b.1" : "11a.1";
    // Fixture set 11b.3 (explicit expected outcomes) made both remote-eligible bundles, and their fixture sets, 11b.3.
    const revised = taskType === "EXPLAIN_PATTERN" || taskType === "DRAFT_CARE_PREPARATION_SUMMARY";
    expect(bundle.bundleKey).toBe(`ai.${kebab}@${revised ? "11b.3" : version}`);
    expect(bundle.fixtureSet).toEqual({ id: `ai-fixtures.${kebab}`, version: revised ? "11b.3" : version });
    expect(bundle.outputSchema).toEqual({ id: `ai-output.${kebab}`, version });
    for (const component of [bundle.capabilityProfile, bundle.promptTemplate, bundle.inputSchema, bundle.outputSchema, bundle.validatorProfile, bundle.fallbackProfile, bundle.fixtureSet]) {
      expect(component.id).toMatch(/^[a-z0-9.-]+$/);
      expect(component.version).toMatch(/^\d+[a-z]?\.\d+(-[a-z-]+)?$/);
    }
    expect(Object.keys(bundle.localePack).sort()).toEqual(["en-SG", "zh-SG"]);
    expect(bundle.localePack["en-SG"].version).toBe(bundle.localePack["zh-SG"].version);
    expect(bundle.routeProfile).toBe("deterministic-only.11a.1");
    expect(bundle.modelSnapshot).toBeNull();
    expect(JSON.stringify(bundle)).not.toMatch(/kie|openai|gpt|gemini|deepseek|grok|claude|https?:/i);
  });

  it.each(AI_TASK_TYPES)("%s carries the exact Section 14.1 initial ceilings and logical tier", (taskType) => {
    const bundle = AI_TASK_RUNTIME_BUNDLES[taskType];
    const expected = CEILINGS[taskType];
    expect(bundle.logicalTier).toBe(expected.tier);
    expect(bundle.executionBudget).toMatchObject({
      maxFacts: expected.maxFacts,
      inputTokenCeiling: expected.input,
      outputTokenCeiling: expected.output,
      reasoning: expected.reasoning,
      maxAttempts: expected.attempts,
      structuralRepairAllowed: expected.repair,
      perCallTimeoutMs: expected.perCallMs,
      overallTimeoutMs: expected.overallMs,
      monetaryCeilingUsd: null,
    });
  });

  it("bounds the semantic context where Section 14.1 names it", () => {
    expect(AI_TASK_RUNTIME_BUNDLES.EXTRACT_CANDIDATE_FACTS.executionBudget).toMatchObject({ maxExcerptCodePoints: 1200, maxOutputItems: 8 });
    expect(AI_TASK_RUNTIME_BUNDLES.ANSWER_BOUNDED_RECORD_QUERY.executionBudget).toMatchObject({ maxRecords: 24, maxPeriodDays: 90 });
    expect(AI_TASK_RUNTIME_BUNDLES.DRAFT_CARE_PREPARATION_SUMMARY.executionBudget).toMatchObject({ maxPeriodDays: 180 });
  });

  it("resolves only an exact task and supported locale", () => {
    expect(resolveAiTaskBundle("EXPLAIN_PATTERN", "zh-SG")).toBe(AI_TASK_RUNTIME_BUNDLES.EXPLAIN_PATTERN);
    expect(() => resolveAiTaskBundle("CHAT" as never, "en-SG")).toThrow("UNKNOWN_AI_TASK");
    expect(() => resolveAiTaskBundle("EXPLAIN_PATTERN", "en-US" as never)).toThrow("UNSUPPORTED_AI_LOCALE");
  });
});
