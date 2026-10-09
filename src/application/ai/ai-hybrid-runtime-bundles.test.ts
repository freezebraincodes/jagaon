import { describe, expect, it } from "vitest";
import { aiInvocationAuditRowSchema, SHELL_INPUT_VERSIONS, SHELL_MAX_OUTPUT_TOKENS, SHELL_PROVIDER_REQUEST_VERSION, SHELL_OUTPUT_VERSIONS, SLOT_PLAN_VERSION } from "@/domain/ai";
import { AI_TASK_RUNTIME_BUNDLES } from "./ai-runtime-bundles";
import { AI_HYBRID_BUNDLE_VERSION, AI_HYBRID_RUNTIME_BUNDLES, AI_HYBRID_VERSIONS, resolveAiHybridBundle } from "./ai-hybrid-runtime-bundles";

describe("hybrid runtime bundles 11b.18 (observation ownership)", () => {
  it("pins the hybrid bundle keys and versions", () => {
    expect(AI_HYBRID_BUNDLE_VERSION).toBe("11b.18");
    expect(AI_HYBRID_RUNTIME_BUNDLES.EXPLAIN_PATTERN.bundleKey).toBe("ai.explain-pattern@11b.18");
    expect(AI_HYBRID_RUNTIME_BUNDLES.DRAFT_CARE_PREPARATION_SUMMARY.bundleKey).toBe("ai.draft-care-preparation-summary@11b.18");
    expect(AI_HYBRID_RUNTIME_BUNDLES.EXPLAIN_PATTERN.promptTemplate).toEqual({ id: "ai-prompt.explain-pattern", version: "11b.18" });
    expect(AI_HYBRID_RUNTIME_BUNDLES.EXPLAIN_PATTERN.shellInputVersion).toBe("ai-shell-input.explain-pattern@11b.8");
    expect(AI_HYBRID_RUNTIME_BUNDLES.EXPLAIN_PATTERN.shellOutputVersion).toBe("ai-shell.explain-pattern@11b.8");
    expect(AI_HYBRID_RUNTIME_BUNDLES.DRAFT_CARE_PREPARATION_SUMMARY.shellInputVersion).toBe("ai-shell-input.draft-care-preparation-summary@11b.7");
    expect(AI_HYBRID_RUNTIME_BUNDLES.DRAFT_CARE_PREPARATION_SUMMARY.shellOutputVersion).toBe("ai-shell.draft-care-preparation-summary@11b.7");
    // Packet 11C B5 contract freeze: labels only (provider schema kie-schema.11c.1, harness packet11-eval.19); no model-facing byte changed.
    // Packet 11C Addendum C (C5): harness packet11-eval.20 (the usage accounting); no model-facing byte changed.
    expect(AI_HYBRID_VERSIONS).toMatchObject({ slotPlan: "ai-slot-plan.11b.9", shellRules: "ai-shell-rules.11b.16-r10", prompt: "11b.18", providerSchema: "kie-schema.11c.1", validatorRules: "11b.2-meaning-r7", fixtureSet: "packet11-fixtures.11b.16", evaluationReport: "packet11-eval.20", shellRequest: "ai-shell-request.11b.11" });
    // Unchanged by 11b.9, 11b.10, 11b.11, 11b.12, 11b.13 and 11b.14 (the prompt also stays 11b.15 in 11b.13 and 11b.14): the shell in/out
    // versions, atoms, default shells and language copy. The request profile moved once more in 11b.14 (ai-shell-request.11b.11, temperature 0.2).
    // 11b.18: the language copy adds the observation variants (ai-language-copy.11b.7); atoms and default shells stay.
    // Presentation correction P1/P3 (2026-10-08): application copy 11b.8 and default shells 11b.7; atoms and bundle keys stay.
    // Packet 11C Task 4 (2026-10-08): application copy 11b.9 and default shells 11b.8 (local PERIOD_SUMMARY observation); atoms and bundle keys stay.
    // Packet 11C phase 2 (option (a), 2026-10-08): atoms 11b.7 (the PERIOD_SUMMARY kind and its lead joiner), slot plan 11b.9 (eligibility
    // accounting); bundle keys, prompt, rules, request profile and provider schema version stay.
    // Packet 11C Task 6R (2026-10-08): application copy 11b.10 (the summary-role notice only); atoms, default shells and bundle keys stay.
    expect(AI_HYBRID_VERSIONS).toMatchObject({ atomRenderer: "ai-atoms.11b.7", defaultShells: "ai-shells-default.11b.8", languageCopy: "ai-language-copy.11b.10" });
    expect(AI_HYBRID_VERSIONS.shellRequest).toBe(SHELL_PROVIDER_REQUEST_VERSION);
  });
  it("carries the audit component versions (validator profile 11b.18: rules r8 plus field ownership, the others 11b.7) and the domain contract versions", () => {
    for (const task of ["EXPLAIN_PATTERN", "DRAFT_CARE_PREPARATION_SUMMARY"] as const) {
      const bundle = AI_HYBRID_RUNTIME_BUNDLES[task];
      for (const ref of [bundle.capabilityProfile, bundle.inputSchema, bundle.localePack["en-SG"], bundle.localePack["zh-SG"], bundle.fallbackProfile]) expect(ref.version, `${task} ${ref.id}`).toBe("11b.7");
      expect(bundle.validatorProfile, task).toEqual({ id: AI_TASK_RUNTIME_BUNDLES[task].validatorProfile.id, version: "11b.18" });
      expect(bundle.promptTemplate.version, task).toBe("11b.18");
      expect(bundle.shellInputVersion).toBe(SHELL_INPUT_VERSIONS[task]);
      expect(bundle.shellOutputVersion).toBe(SHELL_OUTPUT_VERSIONS[task]);
      // Fixture set packet11-fixtures.11b.12 (bundle set 11b.14) rides in the audit fixtureSet component.
      expect(bundle.fixtureSet, task).toEqual({ id: AI_TASK_RUNTIME_BUNDLES[task].fixtureSet.id, version: "11b.16" });
    }
    expect(AI_HYBRID_VERSIONS.slotPlan).toBe(SLOT_PLAN_VERSION);
  });
  it("keeps the legacy assembled output schema, budgets, timeouts, route profile and null model", () => {
    for (const task of ["EXPLAIN_PATTERN", "DRAFT_CARE_PREPARATION_SUMMARY"] as const) {
      const hybrid = AI_HYBRID_RUNTIME_BUNDLES[task];
      const legacy = AI_TASK_RUNTIME_BUNDLES[task];
      expect(hybrid.outputSchema).toEqual(legacy.outputSchema);
      // Fix round 1: the whole execution budget, the output token ceiling included, is inherited unchanged.
      expect(hybrid.executionBudget).toEqual(legacy.executionBudget);
      expect(hybrid.executionBudget.outputTokenCeiling, task).toBe(task === "EXPLAIN_PATTERN" ? 350 : 800);
      expect(hybrid.routeProfile).toBe("deterministic-only.11a.1");
      expect(hybrid.modelSnapshot).toBeNull();
    }
  });
  it("leaves the legacy 11b.3 bundles unchanged", () => {
    expect(AI_TASK_RUNTIME_BUNDLES.EXPLAIN_PATTERN.bundleKey).toBe("ai.explain-pattern@11b.3");
    expect(AI_TASK_RUNTIME_BUNDLES.DRAFT_CARE_PREPARATION_SUMMARY.bundleKey).toBe("ai.draft-care-preparation-summary@11b.3");
  });
  it("produces an untransmitted audit row that the unchanged audit schema accepts", () => {
    const bundle = resolveAiHybridBundle("EXPLAIN_PATTERN", "zh-SG");
    const row = {
      requestId: "8c1f6b1e-2d3a-4b5c-8d6e-7f8091a2b3c4", taskType: "EXPLAIN_PATTERN", locale: "zh-SG",
      requestedAt: "2026-10-06T01:00:00.000Z", completedAt: "2026-10-06T01:00:00.010Z", outcomeCode: "TASK_DISABLED",
      routeProfileKey: bundle.routeProfile, runtimeBundleKey: bundle.bundleKey, activationManifestVersion: "ai-activation.11a.1",
      components: { capabilityProfile: bundle.capabilityProfile, promptTemplate: bundle.promptTemplate, inputSchema: bundle.inputSchema, outputSchema: bundle.outputSchema, validatorProfile: bundle.validatorProfile, localePack: bundle.localePack["zh-SG"], fallbackProfile: bundle.fallbackProfile, fixtureSet: bundle.fixtureSet },
      logicalTier: bundle.logicalTier, providerModel: null, attempts: { count: 0, structuralRepairUsed: false, timedOut: false },
      measurements: { inputTokens: null, outputTokens: null, costMicroUsd: null, latencyMs: 10 }, sourceRevisions: [], downstream: null,
    };
    expect(aiInvocationAuditRowSchema.safeParse(row).success).toBe(true);
  });
  it("is deeply frozen and refuses other tasks", () => {
    expect(Object.isFrozen(AI_HYBRID_RUNTIME_BUNDLES.EXPLAIN_PATTERN.executionBudget)).toBe(true);
    expect(() => resolveAiHybridBundle("EXTRACT_CANDIDATE_FACTS" as never, "en-SG")).toThrow("UNKNOWN_SHELL_TASK");
  });
});

describe("bundle set 11b.17 records the shell request profile and the task's output cap as components", () => {
  it("every hybrid bundle names ai-shell-request.11b.11 and its task's cap (EXPLAIN 512, care 1024), frozen", () => {
    const expected = { EXPLAIN_PATTERN: 512, DRAFT_CARE_PREPARATION_SUMMARY: 1024 } as const;
    for (const task of ["EXPLAIN_PATTERN", "DRAFT_CARE_PREPARATION_SUMMARY"] as const) {
      const bundle = AI_HYBRID_RUNTIME_BUNDLES[task];
      expect(bundle.shellMaxOutputTokens, task).toBe(SHELL_MAX_OUTPUT_TOKENS[task]);
      expect(bundle.shellMaxOutputTokens, task).toBe(expected[task]);
      expect(bundle.shellRequestVersion, task).toBe("ai-shell-request.11b.11");
      expect(bundle.shellRequestVersion, task).toBe(SHELL_PROVIDER_REQUEST_VERSION);
      expect(Object.isFrozen(bundle), task).toBe(true);
      expect(() => { (bundle as { shellMaxOutputTokens: number }).shellMaxOutputTokens = 4096; }, task).toThrow();
      expect(bundle.shellMaxOutputTokens, task).toBe(expected[task]);
      // Timeouts and attempts are inherited unchanged (EXPLAIN 10 s / 18 s).
      expect(bundle.executionBudget, task).toMatchObject({ perCallTimeoutMs: AI_TASK_RUNTIME_BUNDLES[task].executionBudget.perCallTimeoutMs, overallTimeoutMs: AI_TASK_RUNTIME_BUNDLES[task].executionBudget.overallTimeoutMs, maxAttempts: AI_TASK_RUNTIME_BUNDLES[task].executionBudget.maxAttempts });
      // The cap is not the output token ceiling: that stays the legacy bundle's.
      expect(bundle.executionBudget.outputTokenCeiling, task).toBe(AI_TASK_RUNTIME_BUNDLES[task].executionBudget.outputTokenCeiling);
    }
    // The legacy bundles carry neither component.
    for (const task of ["EXPLAIN_PATTERN", "DRAFT_CARE_PREPARATION_SUMMARY"] as const) {
      expect(AI_TASK_RUNTIME_BUNDLES[task], task).not.toHaveProperty("shellMaxOutputTokens");
      expect(AI_TASK_RUNTIME_BUNDLES[task], task).not.toHaveProperty("shellRequestVersion");
    }
  });
});

describe("bundle set 11b.17 keeps the EXPLAIN timeouts", () => {
  it("EXPLAIN stays 10 s per call and 18 s overall", () => {
    expect(AI_HYBRID_RUNTIME_BUNDLES.EXPLAIN_PATTERN.executionBudget).toMatchObject({ perCallTimeoutMs: 10_000, overallTimeoutMs: 18_000, maxAttempts: 2 });
  });
});
