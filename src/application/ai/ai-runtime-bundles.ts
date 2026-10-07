import { deepFreeze } from "@/application/deep-freeze";
import { AI_LOCALES, AI_TASK_TYPES, type AiLocale, type AiTaskType } from "@/domain/ai";

/**
 * Packet 11A immutable task runtime bundles (ai-system-spec Sections 11, 13,
 * 14.1). Each bundle pins exact component versions and a paired en-SG/zh-SG
 * locale pack. In 11A the route is deterministic-only: there is no provider,
 * model snapshot or prompt text, and no monetary ceiling can be set until an
 * approved model and price snapshot exist (Section 14.3).
 */

export type AiComponentRef = Readonly<{ id: string; version: string }>;
export type AiReasoningBudget = "MINIMUM" | "LOW";
export type AiLogicalTier = "LIGHT" | "BALANCED" | "STRONG";

export type AiExecutionBudget = Readonly<{
  maxFacts: number;
  maxExcerptCodePoints?: number;
  maxOutputItems?: number;
  maxRecords?: number;
  maxPeriodDays?: number;
  inputTokenCeiling: number;
  outputTokenCeiling: number;
  reasoning: AiReasoningBudget;
  maxAttempts: 1 | 2;
  structuralRepairAllowed: boolean;
  perCallTimeoutMs: number;
  overallTimeoutMs: number;
  monetaryCeilingUsd: number | null;
}>;

export type AiTaskRuntimeBundle = Readonly<{
  bundleKey: string;
  taskType: AiTaskType;
  capabilityProfile: AiComponentRef;
  promptTemplate: AiComponentRef;
  inputSchema: AiComponentRef;
  outputSchema: AiComponentRef;
  validatorProfile: AiComponentRef;
  localePack: Readonly<Record<AiLocale, AiComponentRef>>;
  logicalTier: AiLogicalTier;
  routeProfile: "deterministic-only.11a.1";
  modelSnapshot: null;
  executionBudget: AiExecutionBudget;
  fallbackProfile: AiComponentRef;
  fixtureSet: AiComponentRef;
}>;

export const AI_BUNDLE_VERSION = "11a.1";

/** Section 14.1 initial evaluation ceilings; Section 11 starting tiers. */
const BUDGETS: Record<AiTaskType, { tier: AiLogicalTier; budget: Omit<AiExecutionBudget, "monetaryCeilingUsd"> }> = {
  // One excerpt plus at most four context facts; at most eight candidates.
  EXTRACT_CANDIDATE_FACTS: { tier: "LIGHT", budget: { maxFacts: 5, maxExcerptCodePoints: 1200, maxOutputItems: 8, inputTokenCeiling: 1600, outputTokenCeiling: 500, reasoning: "MINIMUM", maxAttempts: 2, structuralRepairAllowed: true, perCallTimeoutMs: 10_000, overallTimeoutMs: 18_000 } },
  EXPLAIN_PATTERN: { tier: "LIGHT", budget: { maxFacts: 12, inputTokenCeiling: 2200, outputTokenCeiling: 350, reasoning: "MINIMUM", maxAttempts: 2, structuralRepairAllowed: true, perCallTimeoutMs: 10_000, overallTimeoutMs: 18_000 } },
  DRAFT_NEUTRAL_INQUIRY: { tier: "LIGHT", budget: { maxFacts: 6, inputTokenCeiling: 1200, outputTokenCeiling: 220, reasoning: "MINIMUM", maxAttempts: 1, structuralRepairAllowed: false, perCallTimeoutMs: 8_000, overallTimeoutMs: 8_000 } },
  ANSWER_BOUNDED_RECORD_QUERY: { tier: "LIGHT", budget: { maxFacts: 24, maxRecords: 24, maxPeriodDays: 90, inputTokenCeiling: 2800, outputTokenCeiling: 500, reasoning: "MINIMUM", maxAttempts: 2, structuralRepairAllowed: true, perCallTimeoutMs: 12_000, overallTimeoutMs: 22_000 } },
  DRAFT_CARE_PREPARATION_SUMMARY: { tier: "BALANCED", budget: { maxFacts: 32, maxPeriodDays: 180, inputTokenCeiling: 4000, outputTokenCeiling: 800, reasoning: "LOW", maxAttempts: 2, structuralRepairAllowed: true, perCallTimeoutMs: 18_000, overallTimeoutMs: 32_000 } },
  PHRASE_NON_CLINICAL_RESPONSE: { tier: "LIGHT", budget: { maxFacts: 4, inputTokenCeiling: 900, outputTokenCeiling: 140, reasoning: "MINIMUM", maxAttempts: 1, structuralRepairAllowed: false, perCallTimeoutMs: 6_000, overallTimeoutMs: 6_000 } },
};

const kebab = (taskType: AiTaskType) => taskType.toLowerCase().replaceAll("_", "-");
const ref = (id: string, version = AI_BUNDLE_VERSION): AiComponentRef => ({ id, version });

/**
 * Packet 11B.5 Option B (owner approval 2026-10-05): EXPLAIN_PATTERN's input,
 * output, validator, fallback, locale pack, fixture set and bundle are 11b.1
 * (approved claim meaning in the payload; application-rendered limitations).
 * Every other bundle and component stays at 11a.1.
 */
const TASK_COMPONENT_VERSION: Partial<Record<AiTaskType, string>> = { EXPLAIN_PATTERN: "11b.1" };

/**
 * Component changes after 11b.1 (owner instruction 2026-10-05): the EXPLAIN_PATTERN fixture set was 11b.2
 * (AMBIGUOUS excluded from qualification, kept as an offline negative fixture). Fixture set 11b.3 records an
 * explicit expected outcome on every EXPLAIN_PATTERN and care-summary fixture. Changing a component creates a
 * new bundle version, so both bundles are 11b.3; every other component keeps its version (EXPLAIN 11b.1,
 * care summary 11a.1).
 */
const TASK_REVISIONS: Partial<Record<AiTaskType, { bundle: string; fixtureSet: string }>> = {
  EXPLAIN_PATTERN: { bundle: "11b.3", fixtureSet: "11b.3" },
  DRAFT_CARE_PREPARATION_SUMMARY: { bundle: "11b.3", fixtureSet: "11b.3" },
};

function bundleFor(taskType: AiTaskType): AiTaskRuntimeBundle {
  const name = kebab(taskType);
  const { tier, budget } = BUDGETS[taskType];
  const version = TASK_COMPONENT_VERSION[taskType] ?? AI_BUNDLE_VERSION;
  const revisions = TASK_REVISIONS[taskType];
  return {
    bundleKey: `ai.${name}@${revisions?.bundle ?? version}`,
    taskType,
    capabilityProfile: ref(`ai-capability.${name}`),
    // No prompt exists for a deterministic-only bundle; the version says so explicitly.
    promptTemplate: ref(`ai-prompt.${name}`, `${AI_BUNDLE_VERSION}-absent`),
    inputSchema: ref(`ai-input.${name}`, version),
    outputSchema: ref(`ai-output.${name}`, version),
    validatorProfile: ref(`ai-validator.${name}`, version),
    localePack: { "en-SG": ref(`ai-locale.${name}.en-sg`, version), "zh-SG": ref(`ai-locale.${name}.zh-sg`, version) },
    logicalTier: tier,
    routeProfile: "deterministic-only.11a.1",
    modelSnapshot: null,
    executionBudget: { ...budget, monetaryCeilingUsd: null },
    fallbackProfile: ref(`ai-fallback.${name}`, version),
    fixtureSet: ref(`ai-fixtures.${name}`, revisions?.fixtureSet ?? version),
  };
}

export const AI_TASK_RUNTIME_BUNDLES: Readonly<Record<AiTaskType, AiTaskRuntimeBundle>> = deepFreeze(
  Object.fromEntries(AI_TASK_TYPES.map((taskType) => [taskType, bundleFor(taskType)])) as Record<AiTaskType, AiTaskRuntimeBundle>,
);

/** The exact bundle for a task; both locales share one paired, atomically versioned bundle. */
export function resolveAiTaskBundle(taskType: AiTaskType, locale: AiLocale): AiTaskRuntimeBundle {
  if (!(AI_TASK_TYPES as readonly string[]).includes(taskType)) throw new Error("UNKNOWN_AI_TASK");
  if (!(AI_LOCALES as readonly string[]).includes(locale)) throw new Error("UNSUPPORTED_AI_LOCALE");
  return AI_TASK_RUNTIME_BUNDLES[taskType];
}
