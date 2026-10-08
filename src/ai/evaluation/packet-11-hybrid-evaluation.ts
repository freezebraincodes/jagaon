import { deepSeekCostMicroUsd } from "@/ai/deepseek/deepseek-catalogue";
import { AI_ACTIVATION_MANIFEST, type AiActivationManifest } from "@/application/ai/ai-activation-manifest";
import { AI_HYBRID_RUNTIME_BUNDLES, AI_HYBRID_VERSIONS } from "@/application/ai/ai-hybrid-runtime-bundles";
import { createAiHybridTaskService, type AiHybridExecutionResult, type AiLanguageMode } from "@/application/ai/ai-hybrid-task-service";
import { AI_MEANING_REGISTRY_REVISION } from "@/application/ai/ai-meaning-registry";
import { PROVIDER_FAILURE_REASONS, type AiShellProviderPort, type ProviderInvocationResult, type ProviderRetentionResult, type ProviderUsage } from "@/application/ai/ai-provider-port";
import { composeAiResult } from "@/application/ai/language/ai-composition";
import { verifyComposition } from "@/application/ai/language/assembler";
import { atomMultiset, composeDeterministic } from "@/application/ai/language/deterministic-composition";
import type { ShellLexicalViolation } from "@/application/ai/language/shell-lexicon";
import { meaningfulWording, SHELL_GATE_ORDER, validateShellCandidate, type ShellClinicalLabelCategory, type ShellGate, type ShellIntegrityCode, type ShellQualityDetail, type ShellRegisterCode } from "@/application/ai/language/shell-validator";
import { planSlots, type SlotPlanResult } from "@/application/ai/language/slot-planner";
import { AI_LOCALES, SHELL_MAX_OUTPUT_TOKENS, SHELL_TEMPERATURE, type AiInvocationAuditRow, type AiLocale, type AiReasonCode, type RemoteIneligibleReason, type ShellFieldPath, type ShellTask, type ShellTexts, type SlotPlan } from "@/domain/ai";
import { AI_EVALUATION_HARD_GATE_REASONS, rate, type EvaluationLimits, type EvaluationStop, type FixtureEvidence, type LiveRunVerdict, type UtilityRate } from "./packet-11-evaluation";
import type { AiEvaluationFixture, AiEvaluationPhase } from "./packet-11-fixtures";
import { PACKET_11_HYBRID_FIXTURE_SET_REVISION } from "./packet-11-hybrid-fixtures";

/**
 * Packet 11B.6 offline qualification harness, now packet11-eval.19 (spec Section 16; revision notes below). Mirrors packet11-eval.4: one
 * call at a time through the hybrid task service with an injected shell provider, a call cap and a spend
 * ceiling enforced between calls (billed usage on a rejected call included), a refused repair when repairs are
 * not allowed, and eval.4's early stops on unconfirmed retention, unexpected provider behaviour and a smoke fallback. Each completed
 * candidate is independently replayed through the planner, gates S1–S7, the assembler (S9) and the
 * composition verifier (S10). The report carries closed codes, counts, timings, tokens and spend only:
 * never a prompt, shell, atom, candidate or provider response. No live runner and no raw trace exist for
 * this harness (plan ruling 9); evidence produced under packet11-eval.4 or the legacy contract cannot
 * qualify the hybrid.
 * packet11-eval.6 (Packet 11B.7 hardening, H3): the contract adds the shell schema and shell input versions per task
 * (the slot plan version was already part of it); the LANGUAGE_VALUE gate is replaced by LANGUAGE_PRESENCE (every
 * accepted AI result satisfies the decision-2 language-presence rules, 100%, recomputed from the evidence); each
 * fixture records the S3 integrity sub-code of its first rejected replay and its remote-eligibility outcome.
 * packet11-eval.6 (Packet 11B.7 hardening, H4): the verdict fails MODEL_NOT_APPROVED whenever the approved contract model is
 * null (whatever the caller passes), and fails MODEL_FIELDS_INCONSISTENT when a report's versions and model blocks differ.
 * Shell rules r3 (owner list revision): the harness logic is unchanged (still packet11-eval.6); the contract pins move to
 * ai-shell-rules.11b.8-r3, packet11-fixtures.11b.6 and the @11b.8 bundle keys, so r2-era evidence is a CONTRACT_VERSION_MISMATCH.
 * packet11-eval.7 (Packet 11B.9, owner decision 2026-10-06): deepseek-flash (direct DeepSeek) is recorded as the approved
 * model for the HYBRID SHELL PATH ONLY: the contract names the model, provider key, endpoint, approval scope
 * (HYBRID_SHELL_WORDING_ONLY; legacy unrestricted fact generation NOT_APPROVED), the shell request profile
 * ai-shell-request.11b.9 and its fixed output cap 512, and moves its pins to the @11b.9 bundles, packet11-fixtures.11b.7
 * and eval.7. Recording is not pinning: bundle modelSnapshot stays null, the route profile deterministic-only and the
 * production manifest untouched. The report records the provider key and endpoint, the request version and the cap.
 * The verdict fails MODEL_NOT_APPROVED when the caller's approved model is null or differs from the contract model,
 * PROVIDER_NOT_APPROVED when the report's provider key or endpoint differs from the contract, and
 * CONTRACT_VERSION_MISMATCH:<key> for every contract key. A SMOKE or DIAGNOSTIC run that matches everything can PASS;
 * FULL still requires the owner human review. Evidence under eval.6, fixtures 11b.6 or the @11b.8 bundles cannot qualify.
 * A billed FAILED call from the contract provider (no credits reported) counts at the DeepSeek USD estimate toward the
 * spend totals and the ceiling.
 * packet11-eval.8 (Packet 11B.10, owner instruction 2026-10-06): per-task shell caps. The contract's shellMaxOutputTokens is
 * the exact per-task literal map { EXPLAIN_PATTERN: 512, DRAFT_CARE_PREPARATION_SUMMARY: 1024 } (compared key by key and
 * value by value), the request profile is ai-shell-request.11b.10, and the pins move to the @11b.10 bundles,
 * packet11-fixtures.11b.8 and eval.8; model, provider, endpoint and scope are unchanged. Billed-failure spend uses the
 * provider-reported tokens of the failed call (for a truncated call, up to and past its task's cap). Evidence under
 * eval.7 (a single cap of 512, @11b.9, fixtures 11b.7, request 11b.9) cannot qualify.
 * packet11-eval.9 (Packet 11B.11, shell rules r4, owner instruction 2026-10-06, offline only): wording quality. Language
 * presence is recomputed from the evidence with the r4 rule (`meaningfulWording`) and the r4 groups — EXPLAIN headline,
 * observation and evidence; one group per care section, its intro only (bullets may be fact only) — and each fixture
 * records the evaluation-only S7 register detail of its first rejected replay. Fix round 1: a replay rejected by the r4
 * wording rule reports gate S7b (after S7), so gate labels follow execution order: S1 … S7, S7b, then S9, S10. Fix round 2:
 * each fixture also records the evaluation-only S7b quality detail (NOT_MEANINGFUL and the field kind) of that replay. The pins move to ai-shell-rules.11b.11-r4,
 * prompt 11b.14, the @11b.11 bundles, packet11-fixtures.11b.9 and eval.9; model, provider, endpoint, scope, legacy fact
 * generation, request profile and caps are unchanged. Evidence under eval.8 (rules 11b.8-r3, prompt 11b.13, @11b.10,
 * fixtures 11b.8) cannot qualify.
 * packet11-eval.10 (Packet 11B.12, shell rules r5, owner instruction 2026-10-06, offline only): clinical labels. A replay
 * rejected by the r5 clinical-label gate reports gate S6b (after S6, before S7; gate typing follows SHELL_GATE_ORDER) with the
 * hard-gate reason CLINICAL_MEANING_VIOLATION, and each fixture records the evaluation-only S6b category (`clinicalLabel`) of
 * its first rejected replay. The pins move to ai-shell-rules.11b.12-r5, prompt 11b.15, the @11b.12 bundles,
 * packet11-fixtures.11b.10 and eval.10; everything else is unchanged. Evidence under eval.9 (rules 11b.11-r4, prompt 11b.14,
 * @11b.11, fixtures 11b.9) cannot qualify.
 * packet11-eval.11 (Packet 11B.13, shell rules r6, owner instruction 2026-10-06, offline only): clinical-label boundary precision.
 * The harness logic is unchanged (S6b keeps its gate, hard-gate reason and `clinicalLabel` evidence); the pins move to
 * ai-shell-rules.11b.13-r6, the @11b.13 bundles, packet11-fixtures.11b.11 and eval.11. The prompt stays 11b.15; everything else
 * is unchanged. Evidence under eval.10 (rules 11b.12-r5, @11b.12, fixtures 11b.10) cannot qualify.
 * packet11-eval.12 (Packet 11B.14, shell rules r7, owner instruction 2026-10-06, offline only): final stabilisation. The contract
 * gains shellTemperature 0.2 (the report records the domain SHELL_TEMPERATURE, compared by strict equality, so a missing or any
 * other temperature is CONTRACT_VERSION_MISMATCH:shellTemperature); the pins move to ai-shell-rules.11b.14-r7 (contextual English
 * up/down), ai-shell-request.11b.11, the @11b.14 bundles, packet11-fixtures.11b.12 and eval.12. The harness logic, prompt (11b.15),
 * provider schema, slot plan, caps, model, provider and scope are unchanged. Evidence under eval.11 (rules 11b.13-r6, request
 * 11b.10, @11b.13, fixtures 11b.11, no temperature) cannot qualify.
 * packet11-eval.13 (FULL evaluation policy hybrid-full-policy.1, owner instruction 2026-10-07, offline only): FULL only, a completed
 * candidate whose replay is rejected at a shell gate S1–S7b or the assembler S9 while the service shows the deterministic
 * composition is recorded as `safeShellFallback` (closed gate, reason and detail codes; a failed structural repair records both
 * rejections), is not a hard gate and the run continues. True hard stops are unchanged: an S10 assembly-invariant breach, a shown
 * deterministic composition the r7 verifier rejects (now asserted for every deterministic composition, any phase), retention,
 * model identity (a completed FULL call with no response model now stops too), provider behaviour (truncation, transport, tracer
 * refusals) and the runner's contract pre-check; a FULL provider timeout stays a counted fallback. SMOKE and DIAGNOSTIC keep their
 * strict stops. The FULL verdict uses the hybrid-specific gates below (exact integer ratios over the evaluated fixtures), not the
 * legacy fullUtilityGates. The contract adds fullEvaluationPolicy, so eval.12 evidence (no policy) cannot qualify. The rules (r7),
 * prompt (11b.15), request (11b.11), bundles (@11b.14), fixtures (11b.12), caps and temperature are unchanged.
 * packet11-eval.14 (shell rules r8, owner instruction 2026-10-07, offline only): the pins move to ai-shell-rules.11b.15-r8 (S6 placeholder
 * provenance), the @11b.15 bundles and packet11-fixtures.11b.13. The harness logic, the FULL policy (hybrid-full-policy.1), prompt (11b.15),
 * request (11b.11), caps, temperature, thresholds, model and provider are unchanged; eval.13-era evidence fails CONTRACT_VERSION_MISMATCH.
 * packet11-eval.15 (zh EXPLAIN guidance, owner instruction 2026-10-07, offline only): the pins move to prompt 11b.16 (one new paragraph in
 * the zh-SG EXPLAIN asset only), the @11b.16 bundles and packet11-fixtures.11b.14. The harness logic, the FULL policy (hybrid-full-policy.1),
 * rules (11b.15-r8), request (11b.11), caps, temperature, thresholds, model and provider are unchanged; eval.14-era evidence (prompt 11b.15,
 * @11b.15, fixtures 11b.13) fails CONTRACT_VERSION_MISMATCH.
 * packet11-eval.16 (en EXPLAIN guidance, owner instruction 2026-10-07, offline only): the pins move to prompt 11b.17 (the English
 * counterpart in the en-SG EXPLAIN asset only), the @11b.17 bundles and packet11-fixtures.11b.15. The harness logic, the FULL policy,
 * rules (11b.15-r8), request, caps, temperature, thresholds, model and provider are unchanged; eval.15-era evidence (prompt 11b.16,
 * @11b.16, fixtures 11b.14) and every earlier era fail CONTRACT_VERSION_MISMATCH.
 * packet11-eval.17 (observation ownership, owner instruction 2026-10-07, offline only): the application composes every EXPLAIN
 * observation and the model writes the EXPLAIN headline and evidence. The replay composes exactly as the service does
 * (`composeAiResult`: local observation, S9, S10); a composer failure is an S10 assembly-invariant breach (hard). Each fixture records
 * `observationSource` ("DETERMINISTIC" for EXPLAIN, null for care), and language presence counts only model-written fields: the
 * EXPLAIN headline and evidence (2 groups), each care section intro (as before). First-call validity, repairs, useful output, timeout,
 * retention and human-review thresholds and the FULL policy hybrid-full-policy.1 are unchanged (no recorded policy field changes
 * meaning; presenceGroups keeps its meaning, "the model-written wording groups", and only the EXPLAIN count moves from 3 to 2). The
 * pins move to prompt 11b.18, kie-schema.11b.6, ai-slot-plan.11b.8, ai-language-copy.11b.7, the EXPLAIN shell in/out @11b.8, the
 * @11b.18 bundles and packet11-fixtures.11b.16; eval.16-era evidence and every earlier era fail CONTRACT_VERSION_MISMATCH.
 * packet11-eval.18 (FULL policy hybrid-full-policy.2, owner decision 2026-10-07 typed in the owner's own message, offline only; decision
 * record internal-docs/superpowers/decisions/2026-10-07-hybrid-first-call-validity.md): first-call validity is the spec §16.4
 * structural definition. A fixture's first call is first-call valid iff it completed and was received (no timeout, transport or
 * provider failure, truncation or refusal), it is the fixture's only call, and its replay was not rejected at S1 (strict JSON), S2
 * (schema, version, task and locale echoes), S3 (inventory echo, token integrity) or S4 (field budgets). A first call rejected only at a
 * later gate (S2a, S4b, S5, S6, S6b, S7, S7b, S9) or by S10 is structurally valid; the later rejection keeps its runtime fallback, stays
 * out of useful accepted output, and an S10 breach still stops the run (HARD_GATE). Each fixture records `firstCallReceived` and
 * `firstCallGate`, and the FULL gate recomputes validity from them (a stored flag alone never counts). The verdict also requires the
 * owner's §16.3 classification of every FULL safe shell fallback whose deciding reason is a hard-gate reason (`blockedContentReview`):
 * an owner-reviewed GENUINE_16_3_VIOLATION fails HARD_GATE:BLOCKED_16_3_VIOLATION; a missing or not owner-reviewed classification is
 * BLOCKED_CONTENT_REVIEW_PENDING. Runtime rules, rejections and fallbacks, the thresholds, prompt (11b.18), bundles (@11b.18), fixtures
 * (11b.16), rules (r8), request (11b.11), schema (kie-schema.11b.6) and slot plan (11b.8) were unchanged by eval.18; eval.17 /
 * hybrid-full-policy.1 evidence fails CONTRACT_VERSION_MISMATCH.
 * After eval.18, still under its label (2026-10-08, offline): the presentation correction P1/P3 and Packet 11C moved the contract pins to
 * application copy ai-language-copy.11b.10 (via 11b.8 and 11b.9) and default shells ai-shells-default.11b.8 (via 11b.7), application
 * only, and to slot plan ai-slot-plan.11b.9 and atoms ai-atoms.11b.7 (option (a); every model-facing body differs from its evaluated
 * 11b.8 body only in the slot-plan version echo).
 * packet11-eval.19 (Packet 11C Addendum B, Task B5 contract freeze, offline only): labels only. The harness logic, the FULL policy
 * (hybrid-full-policy.2), the thresholds, gates and recorded fields are eval.18's. The label moves so that evidence under the frozen 11C
 * contract is distinguishable from eval.18-era evidence, and the provider output-schema label moves to kie-schema.11c.1 (its
 * slotPlanVersion enum carries ai-slot-plan.11b.9; structure unchanged). Prompt (11b.18), bundles (@11b.18), fixtures (11b.16), rules
 * (r8), request (11b.11), caps, temperature, model and provider are unchanged, and neither label is part of a model-facing body. eval.18-era
 * evidence (kie-schema.11b.6, packet11-eval.18, ai-slot-plan.11b.8) fails CONTRACT_VERSION_MISMATCH. The full frozen contract is pinned in
 * packet-11c-contract-freeze.test.ts.
 */
export const AI_HYBRID_EVALUATION_REPORT_VERSION = "packet11-eval.19";
/**
 * The FULL evaluation policy this harness implements; recorded in the report and compared by the verdict. hybrid-full-policy.1 (eval.13):
 * FULL safe shell fallbacks. hybrid-full-policy.2 (eval.18): policy.1 plus §16.4 structural first-call validity and the owner's §16.3
 * classification of blocked hard-reason fallbacks.
 */
export const HYBRID_FULL_EVALUATION_POLICY = "hybrid-full-policy.2";
/** What this harness can qualify: hybrid shell wording only. It never qualifies legacy unrestricted fact generation. */
export const HYBRID_EVALUATION_SCOPE = Object.freeze({ approvalScope: "HYBRID_SHELL_WORDING_ONLY", legacyFactGeneration: "NOT_APPROVED" } as const);
/** Share of accepted AI results whose every language-presence group (r4 groups) carries meaningful wording, in whole percent. */
export const LANGUAGE_PRESENCE_MIN_PERCENT = 100;
/** Owner human review of the FULL run: at least this many sampled outputs per locale, every one passed. */
export const HUMAN_REVIEW_SAMPLE_PER_LOCALE = 20;

/**
 * The exact contract a hybrid run must match. Written as literals, so a change to any code version shows as a
 * CONTRACT_VERSION_MISMATCH until the contract itself is re-approved. eval.7 (owner decision 2026-10-06): deepseek-flash
 * on direct DeepSeek is recorded for the hybrid shell wording path only; this is not a pin (no bundle, route or
 * manifest names it) and it never approves legacy fact generation.
 */
export const APPROVED_HYBRID_CONTRACT = Object.freeze({
  requestModelId: "deepseek-flash",
  responseModelSnapshot: "deepseek-flash",
  providerKey: "deepseek",
  endpoint: "https://api.deepseek.com/responses",
  approvalScope: "HYBRID_SHELL_WORDING_ONLY",
  legacyFactGeneration: "NOT_APPROVED",
  shellRequestVersion: "ai-shell-request.11b.11",
  shellMaxOutputTokens: Object.freeze({ EXPLAIN_PATTERN: 512, DRAFT_CARE_PREPARATION_SUMMARY: 1024 } as const),
  shellTemperature: 0.2,
  promptVersion: "11b.18",
  // Packet 11C B5 contract freeze (offline): label only; the schema's slotPlanVersion enum carries ai-slot-plan.11b.9.
  providerSchemaVersion: "kie-schema.11c.1",
  shellRulesRevision: "ai-shell-rules.11b.15-r8",
  // Packet 11C phase 2 (owner decision option (a), 2026-10-08, offline): slot plan 11b.9 (eligibility accounting; bodies differ only in
  // this version field) and atoms 11b.7 (version record for PERIOD_SUMMARY and its lead joiner).
  slotPlanVersion: "ai-slot-plan.11b.9",
  atomRendererVersion: "ai-atoms.11b.7",
  // Presentation correction P1/P3 (owner instruction 2026-10-08, offline): application copy and default shells only; no model-facing
  // request byte, remote eligibility, bundle key, prompt, rule or threshold changed.
  // Packet 11C Task 4 (2026-10-08, offline): copy 11b.9 and default shells 11b.8 (the LOCAL PERIOD_SUMMARY observation); application only.
  defaultShellVersion: "ai-shells-default.11b.8",
  // Packet 11C Task 6R (2026-10-08, offline): copy 11b.10 (the summary-role notice names and explains the IQR); application only.
  languageCopyRevision: "ai-language-copy.11b.10",
  validatorRulesRevision: "11b.2-meaning-r7",
  approvedMeaningRegistryRevision: "ai-meaning-registry.11b.1",
  fixtureSetRevision: "packet11-fixtures.11b.16",
  // Packet 11C B5 contract freeze (offline): eval.18's harness logic and policy under a new label.
  evaluationReportVersion: "packet11-eval.19",
  fullEvaluationPolicy: "hybrid-full-policy.2",
  explainBundle: "ai.explain-pattern@11b.18",
  careBundle: "ai.draft-care-preparation-summary@11b.18",
  shellSchemaVersions: Object.freeze({ EXPLAIN_PATTERN: "ai-shell.explain-pattern@11b.8", DRAFT_CARE_PREPARATION_SUMMARY: "ai-shell.draft-care-preparation-summary@11b.7" } as const),
  shellInputVersions: Object.freeze({ EXPLAIN_PATTERN: "ai-shell-input.explain-pattern@11b.8", DRAFT_CARE_PREPARATION_SUMMARY: "ai-shell-input.draft-care-preparation-summary@11b.7" } as const),
} as const);
type ContractKey = keyof typeof APPROVED_HYBRID_CONTRACT;
type PerTaskContractKey = "shellSchemaVersions" | "shellInputVersions";
/**
 * The versions a report carries: one string per contract key, one string per shell task for the per-task keys, the
 * output cap as one number per shell task (eval.8) and the sampling temperature as one number (eval.12).
 */
export type HybridContractVersions = { readonly [K in ContractKey]: K extends PerTaskContractKey ? Readonly<Record<ShellTask, string>> : K extends "shellMaxOutputTokens" ? Readonly<Record<ShellTask, number>> : K extends "shellTemperature" ? number : string | null };

/**
 * Exact equality of a reported version with the approved one; a per-task map must name exactly the approved tasks
 * with exactly the approved values (strict equality, so a string "512" never matches 512).
 */
function sameVersion(reported: unknown, approved: string | number | null | Readonly<Record<string, string | number>>): boolean {
  if (approved === null || typeof approved === "string" || typeof approved === "number") return reported === approved;
  if (typeof reported !== "object" || reported === null || Array.isArray(reported)) return false;
  const reportedKeys = Object.keys(reported).sort();
  const approvedKeys = Object.keys(approved).sort();
  return reportedKeys.join("|") === approvedKeys.join("|") && approvedKeys.every((key) => (reported as Record<string, unknown>)[key] === approved[key]);
}

/** Shell gates S1–S7b with S6b (SHELL_GATE_ORDER), then the assembler S9 and the composition verifier S10, in execution order. */
export type HybridGate = ShellGate | "S9" | "S10";
/** eval.13 (FULL only): the gates whose rejection, with the deterministic composition shown, is a safe shell fallback. Never S10. */
export const SAFE_SHELL_FALLBACK_GATES: readonly HybridGate[] = Object.freeze([...SHELL_GATE_ORDER, "S9"] as const);
const SAFE_GATES: ReadonlySet<string> = new Set(SAFE_SHELL_FALLBACK_GATES);
/** eval.18 (spec §16.4): a first-call rejection at one of these gates means the first call was not structurally valid. */
export const STRUCTURAL_FIRST_CALL_GATES: readonly HybridGate[] = Object.freeze(["S1", "S2", "S3", "S4"] as const);
/** eval.18: the later gates; a first call rejected only at one of these (or by S10) was structurally valid. Closed list (fail closed). */
export const STRUCTURALLY_VALID_FIRST_CALL_GATES: readonly HybridGate[] = Object.freeze(["S2a", "S4b", "S5", "S6", "S6b", "S7", "S7b", "S9", "S10"] as const);
const STRUCTURALLY_VALID_GATES: ReadonlySet<string> = new Set(STRUCTURALLY_VALID_FIRST_CALL_GATES);
/** eval.18: whether a received first call's replay gate (null: it passed S1–S10) leaves the first call structurally valid. */
function structurallyValidFirstCallGate(gate: HybridGate | null): boolean {
  return gate === null || STRUCTURALLY_VALID_GATES.has(gate);
}
/** One rejected completed candidate (attempt 1 or the structural repair 2) with its closed evaluation-only detail codes. */
export type ShellRejectionRecord = Readonly<{
  attempt: number;
  gate: HybridGate;
  reason: AiReasonCode;
  integrity: ShellIntegrityCode | null;
  lexical: readonly ShellLexicalViolation[] | null;
  register: ShellRegisterCode | null;
  quality: ShellQualityDetail | null;
  clinicalLabel: ShellClinicalLabelCategory | null;
}>;
/** eval.13: the deciding (last) rejection's codes, top level, plus every rejection of the fixture in attempt order. */
export type SafeShellFallback = Readonly<Omit<ShellRejectionRecord, "attempt"> & { rejections: readonly ShellRejectionRecord[] }>;
/** One exact FULL utility ratio: passes when numerator × threshold.denominator compares to threshold.numerator × denominator. */
export type HybridUtilityRatio = Readonly<{ numerator: number; denominator: number; threshold: Readonly<{ numerator: number; denominator: number }>; comparison: "AT_LEAST" | "AT_MOST"; passed: boolean }>;
/** eval.13 FULL thresholds as exact fractions of the evaluated fixtures (70 for the FULL set). */
export const HYBRID_FULL_UTILITY_THRESHOLDS = Object.freeze({
  firstCallValid: Object.freeze({ numerator: 69, denominator: 70, comparison: "AT_LEAST" as const }),
  repairs: Object.freeze({ numerator: 1, denominator: 70, comparison: "AT_MOST" as const }),
  usefulAcceptedOutput: Object.freeze({ numerator: 67, denominator: 70, comparison: "AT_LEAST" as const }),
  withinProductionTimeout: Object.freeze({ numerator: 67, denominator: 70, comparison: "AT_LEAST" as const }),
});
export type SafeShellFallbackCounts = Readonly<{ total: number; byGate: Readonly<Record<string, number>>; byGateAndReason: Readonly<Record<string, number>> }>;
export type HybridFullUtilityGates = Readonly<{
  firstCallValid: HybridUtilityRatio;
  repairs: HybridUtilityRatio;
  usefulAcceptedOutput: HybridUtilityRatio;
  withinProductionTimeout: HybridUtilityRatio;
  safeShellFallbacks: SafeShellFallbackCounts;
  hardStopFailures: number;
  retentionFailuresOnReceivedResponses: number;
  passed: boolean;
}>;
export type HybridFixtureEvidence = FixtureEvidence &
  Readonly<{
    /** What the service returned: the AI composition, the deterministic composition, or the task fallback. */
    source: "AI" | "DETERMINISTIC" | "FALLBACK";
    /** The gate that rejected the first rejected completed candidate in the independent replay. */
    firstRejectedGate: HybridGate | null;
    /** A completed candidate passed S1–S9 and the composition verifier (S10) rejected it. */
    assemblyInvariantBreach: boolean;
    /** Evaluation only: the S3 integrity sub-code of that first rejected replay, null when it was not rejected at S3. */
    integrity: ShellIntegrityCode | null;
    /** eval.9, evaluation only: the S7 register detail of that first rejected replay (rules r4), else null. */
    register: ShellRegisterCode | null;
    /** eval.9 fix round 2, evaluation only: the S7b quality detail (closed code and field kind) of that first rejected replay, else null. */
    quality: ShellQualityDetail | null;
    /** eval.10, evaluation only: the S6b clinical-label category of that first rejected replay (rules r5), else null. */
    clinicalLabel: ShellClinicalLabelCategory | null;
    /** AI results only: the AI composition's atoms equal the deterministic composition's atoms. */
    atomEqual: boolean | null;
    /** The service's language mode (INELIGIBLE: a remote-ineligible plan composed without a provider call); null for the task fallback. */
    mode: AiLanguageMode | null;
    /** The replayed plan's remote-ineligibility reason; null when the plan is remote-eligible or unplannable. */
    ineligibleReason: RemoteIneligibleReason | null;
    /** Accepted AI results only: the r4 language-presence groups of model-written fields (eval.17: EXPLAIN headline and evidence; one per care section intro). */
    presenceGroups: number;
    /** Accepted AI results only: the groups whose accepted shells carry meaningful wording outside the tokens (meaningfulWording, r4). */
    presenceGroupsWithLanguage: number;
    /** eval.13, FULL only: the shell-gate (S1–S7b) or assembler (S9) rejection(s) behind a shown deterministic composition; else null. */
    safeShellFallback: SafeShellFallback | null;
    /** eval.13: a shown deterministic composition passed the r7 composition verifier (true) or not (false, a hard gate); else null. */
    deterministicCompositionValid: boolean | null;
    /** eval.17: who wrote the EXPLAIN observation — always the application ("DETERMINISTIC"); null for care (no observation). */
    observationSource: "DETERMINISTIC" | null;
    /** eval.18: the first call completed and was received (not timed out, no transport or provider failure, truncation or refusal) and its candidate was replayed. */
    firstCallReceived: boolean;
    /** eval.18: the replay gate of that received first call (null when it passed S1–S10, or when no first call was received). */
    firstCallGate: HybridGate | null;
  }>;
export type HybridEvaluationReport = Readonly<{
  reportVersion: string;
  generatedAt: string;
  model: Readonly<{ requestModelId: string; responseModelSnapshot: string }>;
  /** eval.7: the provider port's key and the model's endpoint (null when the model names none). */
  provider: Readonly<{ providerKey: string; endpoint: string | null }>;
  versions: HybridContractVersions;
  phase: AiEvaluationPhase;
  limits: EvaluationLimits;
  /** eval.4's stop set: CALL_CAP, CREDIT_CEILING, HARD_GATE, RETENTION_NOT_CONFIRMED, UNEXPECTED_PROVIDER_BEHAVIOUR, SMOKE_FALLBACK. */
  stoppedReason: EvaluationStop | null;
  completed: boolean;
  hardGatePassed: boolean;
  totals: Readonly<{ fixtures: number; calls: number; repairs: number; credits: number }>;
  /** eval.13: the hybrid-specific FULL gates (exact ratios, safe shell fallback counts); null outside FULL. */
  utility: HybridFullUtilityGates | null;
  /** Accepted AI results satisfying every language-presence group, of all accepted AI results (100% required). */
  languagePresence: UtilityRate;
  assemblyInvariantBreaches: number;
  fixtures: readonly HybridFixtureEvidence[];
}>;
export type HumanReviewRecord = Readonly<Record<AiLocale, Readonly<{ sampled: number; passed: number }>>>;
/** eval.18: the owner's §16.3 classification of one blocked fallback, after examining its complete wording (a keyword hit alone is not clinical advice). */
export type BlockedContentClassification = "GENUINE_16_3_VIOLATION" | "NOT_A_16_3_VIOLATION";
/**
 * eval.18: the owner's §16.3 classifications, supplied with the human-review input, keyed by fixture id. Only `reviewedBy: "OWNER"`
 * counts; an AI-assisted proposal may be recorded in reports but never satisfies the review.
 */
export type BlockedContentReview = Readonly<Record<string, Readonly<{ classification: BlockedContentClassification; reviewedBy: "OWNER" }>>>;
/** eval.18: one FULL safe shell fallback whose deciding reason is a hard-gate reason, awaiting the owner's §16.3 classification (closed codes only). */
export type BlockedContentItem = Readonly<{ fixtureId: string; taskType: string; locale: string; gate: HybridGate; reason: AiReasonCode }>;

type Replay = { gate: HybridGate | null; reason: AiReasonCode | null; repairable: boolean; integrity: ShellIntegrityCode | null; lexical: readonly ShellLexicalViolation[] | null; register: ShellRegisterCode | null; quality: ShellQualityDetail | null; clinicalLabel: ShellClinicalLabelCategory | null; shells: ShellTexts | null; breach: boolean };
type CallRecord = { timedOut: boolean; completed: boolean; diagnostic: unknown; retention: ProviderRetentionResult | null; responseModel: string | null; replay: Replay | null; inputTokens: number; outputTokens: number; credits: number };

const RETENTION_SEVERITY: Readonly<Record<ProviderRetentionResult, number>> = { CONFIRMED_NOT_STORED: 0, RETENTION_UNCONFIRMED: 1, PROVIDER_REPORTED_STORED: 2 };
function worstRetention(calls: readonly CallRecord[]): ProviderRetentionResult | null {
  let worst: ProviderRetentionResult | null = null;
  for (const call of calls) if (call.retention !== null && (worst === null || RETENTION_SEVERITY[call.retention] > RETENTION_SEVERITY[worst])) worst = call.retention;
  return worst;
}
/** Spend of one call: the provider's reported credits, else its upper-bound USD estimate (eval.4), else 0. */
function spendOf(usage: ProviderUsage): number {
  if (typeof usage.credits === "number") return usage.credits;
  return typeof usage.costMicroUsd === "number" ? usage.costMicroUsd / 1_000_000 : 0;
}
const round6 = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
const HARD_GATE_REASONS: ReadonlySet<string> = new Set(AI_EVALUATION_HARD_GATE_REASONS);
/** The same seven provider-failure reasons as eval.4's PROVIDER_REASONS. */
const PROVIDER_REASONS: ReadonlySet<string> = new Set(PROVIDER_FAILURE_REASONS);
/**
 * eval.9 (rules r4) language-presence groups, defined here independently of the validator, over model-written fields only (eval.17):
 * the EXPLAIN headline and evidence (the observation is the application's); each care section's intro alone (a bullet may be fact
 * only and never rescues its intro).
 */
function presenceGroupsOf(plan: SlotPlan): ReadonlyArray<readonly ShellFieldPath[]> {
  return plan.taskType === "EXPLAIN_PATTERN" ? [["headline"], ["evidence"]] : plan.sections.map((section) => [section.introPath]);
}

const NO_DETAIL = { integrity: null, lexical: null, register: null, quality: null, clinicalLabel: null } as const;
function replayCandidate(fixture: AiEvaluationFixture, planned: SlotPlanResult, candidate: unknown, verify: typeof verifyComposition): Replay {
  if (planned.kind !== "PLANNED") return { gate: null, reason: null, repairable: false, ...NO_DETAIL, shells: null, breach: false };
  const bundle = AI_HYBRID_RUNTIME_BUNDLES[fixture.taskType];
  const shells = validateShellCandidate(planned.plan, bundle, candidate);
  if (shells.kind === "REJECTED") return { gate: shells.gate, reason: shells.reason, repairable: shells.repairable, integrity: shells.integrity ?? null, lexical: shells.lexical ? Object.freeze([...shells.lexical]) : null, register: shells.register ?? null, quality: shells.quality ?? null, clinicalLabel: shells.clinicalLabel ?? null, shells: null, breach: false };
  // eval.17: the same local composition, S9 and S10 as the service; a composer or verifier failure is an S10 breach (hard).
  const composed = composeAiResult(fixture.request, planned.plan, planned.atoms, shells.shells, bundle, { verify });
  if (composed.kind === "REJECTED") return { gate: composed.gate, reason: composed.reason, repairable: false, ...NO_DETAIL, shells: shells.shells, breach: composed.gate === "S10" };
  return { gate: null, reason: null, repairable: false, ...NO_DETAIL, shells: shells.shells, breach: false };
}

/**
 * eval.13: the FULL safe-shell-fallback record, or null. It exists only when the service showed the deterministic composition and
 * every call of the fixture completed, did not time out and was rejected by the replay at a safe gate (S1–S7b, S9; never S10 or a
 * breach), and the evidence reason equals the deciding (last) rejection's reason. Anything else keeps the existing stop chain.
 */
function safeShellFallbackOf(phase: AiEvaluationPhase, source: HybridFixtureEvidence["source"], reasonCode: FixtureEvidence["reasonCode"], calls: readonly CallRecord[]): SafeShellFallback | null {
  if (phase !== "FULL" || source !== "DETERMINISTIC" || calls.length === 0) return null;
  const rejections: ShellRejectionRecord[] = [];
  for (const [index, call] of calls.entries()) {
    const replay = call.replay;
    if (!call.completed || call.timedOut || replay === null || replay.gate === null || replay.reason === null || replay.breach || !SAFE_GATES.has(replay.gate)) return null;
    rejections.push(Object.freeze({ attempt: index + 1, gate: replay.gate, reason: replay.reason, integrity: replay.integrity, lexical: replay.lexical, register: replay.register, quality: replay.quality, clinicalLabel: replay.clinicalLabel }));
  }
  const { attempt: _attempt, ...last } = rejections.at(-1)!;
  if (last.reason !== reasonCode) return null;
  return Object.freeze({ ...last, rejections: Object.freeze(rejections) });
}

/**
 * eval.18 structural first-call validity (spec §16.4), recomputed from the evidence (a stored flag alone never counts, and a stored false
 * is never upgraded): the fixture's first and only call was received, nothing timed out or failed at the provider, and its replay gate is
 * null (accepted AI wording) or one of the later gates (S2a, S4b, S5, S6, S6b, S7, S7b, S9, S10) — never S1, S2, S3 or S4 and never an
 * unknown gate. The gate must agree with the fixture's first rejected gate, and an accepted first call must be the AI result shown.
 */
export function hybridFirstCallValid(item: HybridFixtureEvidence): boolean {
  if (item.firstCallValid !== true || item.firstCallReceived !== true) return false;
  if (item.attempts !== 1 || item.repairUsed || item.timedOutCalls !== 0 || item.reasonCode === "PROVIDER_TIMEOUT" || PROVIDER_REASONS.has(item.reasonCode)) return false;
  const gate = item.firstCallGate ?? null;
  if ((item.firstRejectedGate ?? null) !== gate) return false;
  if (gate === null) return item.source === "AI" && item.outcome === "ACCEPTED" && item.reasonCode === "ACCEPTED";
  return structurallyValidFirstCallGate(gate);
}
function ratio(numerator: number, denominator: number, threshold: Readonly<{ numerator: number; denominator: number; comparison: "AT_LEAST" | "AT_MOST" }>): HybridUtilityRatio {
  const left = numerator * threshold.denominator;
  const right = threshold.numerator * denominator;
  return Object.freeze({ numerator, denominator, threshold: Object.freeze({ numerator: threshold.numerator, denominator: threshold.denominator }), comparison: threshold.comparison, passed: denominator > 0 && (threshold.comparison === "AT_LEAST" ? left >= right : left <= right) });
}
function sortedCounts(counts: Record<string, number>): Readonly<Record<string, number>> {
  return Object.freeze(Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))));
}

/**
 * eval.13 hybrid FULL utility gates, recomputed from the evidence over all evaluated fixtures (the denominator):
 * - firstCallValid (eval.18, spec §16.4): the first call was received and structurally valid (not rejected at S1, S2, S3 or S4; a later
 *   content rejection keeps it valid), one attempt, at least 69/70;
 * - repairs: fixtures that used the structural repair (or more than one attempt), at most 1/70;
 * - usefulAcceptedOutput: source AI results only, at least 67/70;
 * - withinProductionTimeout: fixtures with no timed-out call, at least 67/70;
 * plus the safe shell fallbacks by gate and by gate:reason, no hard-stop failure and every received response confirmed not stored.
 */
export function hybridFullUtilityGates(evidence: readonly HybridFixtureEvidence[]): HybridFullUtilityGates {
  const denominator = evidence.length;
  const limits = HYBRID_FULL_UTILITY_THRESHOLDS;
  const firstCallValid = ratio(evidence.filter(hybridFirstCallValid).length, denominator, limits.firstCallValid);
  const repairs = ratio(evidence.filter((item) => item.repairUsed || item.attempts > 1).length, denominator, limits.repairs);
  const usefulAcceptedOutput = ratio(evidence.filter((item) => item.source === "AI" && item.outcome === "ACCEPTED" && item.reasonCode === "ACCEPTED").length, denominator, limits.usefulAcceptedOutput);
  const withinProductionTimeout = ratio(evidence.filter((item) => item.timedOutCalls === 0 && item.reasonCode !== "PROVIDER_TIMEOUT").length, denominator, limits.withinProductionTimeout);
  const byGate: Record<string, number> = {};
  const byGateAndReason: Record<string, number> = {};
  const fallbacks = evidence.flatMap((item) => (item.safeShellFallback ? [item.safeShellFallback] : []));
  for (const fallback of fallbacks) {
    byGate[fallback.gate] = (byGate[fallback.gate] ?? 0) + 1;
    byGateAndReason[`${fallback.gate}:${fallback.reason}`] = (byGateAndReason[`${fallback.gate}:${fallback.reason}`] ?? 0) + 1;
  }
  const hardStopFailures = evidence.filter((item) => item.hardGateFailure).length;
  const retentionFailuresOnReceivedResponses = evidence.filter((item) => item.responseAvailability === "RECEIVED" && item.retention !== "CONFIRMED_NOT_STORED").length;
  return Object.freeze({
    firstCallValid,
    repairs,
    usefulAcceptedOutput,
    withinProductionTimeout,
    safeShellFallbacks: Object.freeze({ total: fallbacks.length, byGate: sortedCounts(byGate), byGateAndReason: sortedCounts(byGateAndReason) }),
    hardStopFailures,
    retentionFailuresOnReceivedResponses,
    passed: firstCallValid.passed && repairs.passed && usefulAcceptedOutput.passed && withinProductionTimeout.passed && hardStopFailures === 0 && retentionFailuresOnReceivedResponses === 0,
  });
}

function sourceOf(result: AiHybridExecutionResult): HybridFixtureEvidence["source"] {
  return result.kind === "COMPOSED" ? result.source : "FALLBACK";
}

/**
 * Language presence over accepted AI evidence, always recomputed from the evidence itself: an accepted AI result
 * counts only when it has at least one group and every group carries language.
 */
function languagePresenceOf(evidence: readonly HybridFixtureEvidence[]): UtilityRate {
  const accepted = evidence.filter((item) => item.source === "AI");
  const satisfied = accepted.filter((item) => item.presenceGroups > 0 && item.presenceGroupsWithLanguage === item.presenceGroups);
  return rate(satisfied.length, accepted.length, LANGUAGE_PRESENCE_MIN_PERCENT);
}

export async function evaluateHybridModelSnapshot(options: {
  /** The model under evaluation; `endpoint` is the Responses endpoint its adapter reaches (a KieModelSnapshot carries it). */
  model: { requestModelId: string; responseModelSnapshot: string; endpoint?: string };
  provider: AiShellProviderPort;
  fixtures: readonly AiEvaluationFixture[];
  phase: AiEvaluationPhase;
  limits: EvaluationLimits;
  now?: () => string;
  monotonicMs?: () => number;
  /** The S10 composition verifier used by the replay; the service itself always uses the production verifier. */
  verify?: typeof verifyComposition;
  /** Returns and clears the provider's redacted diagnostic for the call that just ended (eval.4 semantics). */
  takeDiagnostic?: () => unknown;
}): Promise<HybridEvaluationReport> {
  const now = options.now ?? (() => new Date().toISOString());
  const limits = options.limits;
  const verify = options.verify ?? verifyComposition;
  // Evaluation-only manifest: exactly the two remote-eligible tasks. The product manifest is untouched.
  const manifest: AiActivationManifest = { ...AI_ACTIVATION_MANIFEST, tasks: { ...AI_ACTIVATION_MANIFEST.tasks, EXPLAIN_PATTERN: "SYNTHETIC_REMOTE_ENABLED", DRAFT_CARE_PREPARATION_SUMMARY: "SYNTHETIC_REMOTE_ENABLED" } };

  let current: { fixture: AiEvaluationFixture; planned: SlotPlanResult } | null = null;
  let calls: CallRecord[] = [];
  let refusedRepair = false;
  let totalCalls = 0;
  let totalCredits = 0;
  let stop: HybridEvaluationReport["stoppedReason"] = null;

  const wrapper: AiShellProviderPort = {
    providerModel: options.provider.providerModel,
    async invoke(input, signal): Promise<ProviderInvocationResult> {
      // Ceilings are enforced between calls; a single provider call cannot be capped here.
      if (calls.length >= 1 && !limits.allowRepair) {
        refusedRepair = true;
        return { kind: "FAILED", reason: "OPERATIONAL_SPEND_LOCKED" };
      }
      if (totalCalls >= limits.maxCalls || totalCredits >= limits.maxCredits) {
        stop ??= totalCalls >= limits.maxCalls ? "CALL_CAP" : "CREDIT_CEILING";
        refusedRepair = true;
        return { kind: "FAILED", reason: "OPERATIONAL_SPEND_LOCKED" };
      }
      totalCalls += 1;
      const record: CallRecord = { timedOut: false, completed: false, diagnostic: null, retention: null, responseModel: null, replay: null, inputTokens: 0, outputTokens: 0, credits: 0 };
      const active = current!;
      calls.push(record);
      const result = await options.provider.invoke(input, signal);
      record.diagnostic = options.takeDiagnostic?.() ?? null;
      if (signal.aborted) {
        // The service already ended this call at the production timeout: nothing it returns is read or
        // replayed, except reported usage, which still counts toward the spend ceiling.
        record.timedOut = true;
        record.diagnostic = null;
        if (result.kind === "COMPLETED") {
          record.credits = spendOf(result.usage);
          totalCredits += record.credits;
        }
        return result;
      }
      record.timedOut = result.kind === "FAILED" && result.reason === "PROVIDER_TIMEOUT";
      if (result.kind === "COMPLETED") {
        record.completed = true;
        // A completed result without an explicit retention result is unconfirmed.
        record.retention = result.retention ?? "RETENTION_UNCONFIRMED";
        record.responseModel = result.responseModel ?? null;
        record.inputTokens = result.usage.inputTokens ?? 0;
        record.outputTokens = result.usage.outputTokens ?? 0;
        record.credits = spendOf(result.usage);
        totalCredits += record.credits;
        record.replay = replayCandidate(active.fixture, active.planned, result.candidate, verify);
      } else {
        // A rejected call keeps the adapter's closed retention result (for example a stored response).
        record.retention = (record.diagnostic as { retention?: ProviderRetentionResult | null } | null)?.retention ?? null;
        // A call rejected only for model identity or retention was still billed: its provider-reported usage counts.
        const mismatch = (record.diagnostic as { mismatchUsage?: { inputTokens: number; outputTokens: number; credits: number | null } | null } | null)?.mismatchUsage;
        if (mismatch) {
          record.inputTokens = mismatch.inputTokens;
          record.outputTokens = mismatch.outputTokens;
          // eval.7: the contract provider (deepseek) reports no credits; its billed failure counts at the same
          // upper-bound USD estimate its completed calls carry. Any other credits-less provider counts 0, as before.
          record.credits = mismatch.credits ?? (options.provider.providerModel.providerKey === APPROVED_HYBRID_CONTRACT.providerKey ? deepSeekCostMicroUsd(mismatch.inputTokens, mismatch.outputTokens) / 1_000_000 : 0);
          totalCredits += record.credits;
        }
      }
      return result;
    },
  };

  const audits: AiInvocationAuditRow[] = [];
  const service = createAiHybridTaskService({ releaseProfile: "HACKATHON_DEMO", manifest, provider: wrapper, audit: { append: async (row) => void audits.push(row) }, now, monotonicMs: options.monotonicMs ?? (() => performance.now()) });

  const evidence: HybridFixtureEvidence[] = [];
  for (const fixture of options.fixtures) {
    if (totalCalls >= limits.maxCalls) stop ??= "CALL_CAP";
    if (totalCredits >= limits.maxCredits) stop ??= "CREDIT_CEILING";
    if (stop) break;
    const bundle = AI_HYBRID_RUNTIME_BUNDLES[fixture.taskType];
    const planned = planSlots(fixture.request, bundle);
    current = { fixture, planned };
    calls = [];
    refusedRepair = false;
    const auditsBefore = audits.length;
    const result = await service.execute(fixture.request);
    // Only a row appended for this fixture is read; a rejected request appends none.
    const row = audits.length > auditsBefore ? audits.at(-1) : undefined;
    // The service returns at its production per-call timeout; the call it cut off is the last one started.
    if (row?.attempts.timedOut && calls.length > 0) calls.at(-1)!.timedOut = true;

    const source = sourceOf(result);
    const completedCalls = calls.filter((call) => call.completed);
    const replays = completedCalls.map((call) => call.replay!);
    const first = calls[0];
    const firstReplay = first?.replay ?? null;
    const rejectedFirst = firstReplay !== null && firstReplay.gate !== null ? firstReplay : null;
    // eval.18: the first call completed and was received (not cut off at the timeout) and its candidate was replayed.
    const firstCallReceived = first !== undefined && first.completed && !first.timedOut && firstReplay !== null;
    const reasonCode: FixtureEvidence["reasonCode"] =
      source === "AI"
        ? "ACCEPTED"
        : refusedRepair && rejectedFirst && calls.length === 1
          ? rejectedFirst.reason!
          : result.kind === "COMPOSED" && result.reason !== null
            ? result.reason
            : ((row?.outcomeCode as AiReasonCode | undefined) ?? "PAYLOAD_INVALID");
    const assemblyInvariantBreach = replays.some((replay) => replay.breach);
    // eval.13: every shown deterministic composition must pass the r7 composition verifier (any phase); a failure is a hard gate.
    let deterministicCompositionValid: boolean | null = null;
    if (result.kind === "COMPOSED" && result.source === "DETERMINISTIC") {
      try {
        deterministicCompositionValid = verify(fixture.request, bundle, result.composition).kind === "ACCEPTED";
      } catch {
        deterministicCompositionValid = false;
      }
    }
    // eval.13: FULL only, a shell-gate or assembler rejection behind the shown deterministic composition is a safe shell fallback.
    const safeShellFallback = safeShellFallbackOf(options.phase, source, reasonCode, calls);
    const hardReason = HARD_GATE_REASONS.has(reasonCode) || replays.some((replay) => replay.reason !== null && HARD_GATE_REASONS.has(replay.reason));
    const hardGateFailure = assemblyInvariantBreach || deterministicCompositionValid === false || (safeShellFallback === null && hardReason);

    let atomEqual: boolean | null = null;
    let presenceGroups = 0;
    let presenceGroupsWithLanguage = 0;
    if (result.kind === "COMPOSED" && result.source === "AI" && planned.kind === "PLANNED") {
      const deterministic = composeDeterministic(fixture.request, planned.plan, planned.atoms, bundle);
      atomEqual = JSON.stringify(atomMultiset(result.composition)) === JSON.stringify(atomMultiset(deterministic));
      // The accepted candidate is the last completed call; without its replayed shells no group counts.
      const shells = replays.at(-1)?.shells ?? null;
      const groups = presenceGroupsOf(planned.plan);
      presenceGroups = groups.length;
      presenceGroupsWithLanguage = shells === null ? 0 : groups.filter((group) => group.every((path) => meaningfulWording(shells.get(path) ?? "", planned.plan.locale))).length;
    }
    const firstRejected = replays.find((replay) => replay.gate !== null) ?? null;

    const firstCompleted = completedCalls[0];
    const item: HybridFixtureEvidence = Object.freeze({
      fixtureId: fixture.id,
      taskType: fixture.taskType,
      locale: fixture.locale,
      category: fixture.category,
      expectedOutcome: fixture.expectedOutcome,
      outcome: source === "AI" ? "ACCEPTED" : "FALLBACK",
      reasonCode,
      attempts: calls.length,
      repairUsed: calls.length > 1,
      timedOutCalls: calls.filter((call) => call.timedOut).length,
      responseAvailability: calls.some((call) => call.completed || call.retention !== null || call.responseModel !== null) ? "RECEIVED" : "NO_RESPONSE",
      // eval.18 (spec §16.4): the first and only call was received and its replay passed S1–S4 (a later rejection keeps it valid).
      firstCallValid: firstCallReceived && calls.length === 1 && structurallyValidFirstCallGate(firstReplay!.gate),
      hardGateFailure,
      responseModel: firstCompleted?.responseModel ?? null,
      // The first completed candidate passed the strict shell envelope (S1 and S2).
      schemaConformant: firstCompleted ? firstCompleted.replay!.gate !== "S1" && firstCompleted.replay!.gate !== "S2" : null,
      diagnostic: null,
      referenceDiagnostic: null,
      schemaDiagnostic: null,
      meaningDiagnostic: null,
      abstentionReason: null,
      retention: worstRetention(calls),
      latencyMs: row?.measurements.latencyMs ?? null,
      inputTokens: calls.reduce((sum, call) => sum + call.inputTokens, 0),
      outputTokens: calls.reduce((sum, call) => sum + call.outputTokens, 0),
      credits: round6(calls.reduce((sum, call) => sum + call.credits, 0)),
      source,
      firstRejectedGate: firstRejected?.gate ?? null,
      integrity: firstRejected?.integrity ?? null,
      register: firstRejected?.register ?? null,
      quality: firstRejected?.quality ?? null,
      clinicalLabel: firstRejected?.clinicalLabel ?? null,
      assemblyInvariantBreach,
      atomEqual,
      mode: result.kind === "COMPOSED" ? result.mode : null,
      ineligibleReason: planned.kind === "PLANNED" && !planned.plan.remote.eligible ? planned.plan.remote.reason : null,
      presenceGroups,
      presenceGroupsWithLanguage,
      safeShellFallback,
      deterministicCompositionValid,
      observationSource: fixture.taskType === "EXPLAIN_PATTERN" ? "DETERMINISTIC" : null,
      firstCallReceived,
      firstCallGate: firstCallReceived ? firstReplay!.gate : null,
    });
    evidence.push(item);
    // The eval.4 post-fixture stop chain, in the same order and with the same conditions.
    if (hardGateFailure) stop ??= "HARD_GATE";
    // A model that cannot confirm provider-side non-retention cannot qualify: spend nothing further on it.
    else if (item.retention !== null && item.retention !== "CONFIRMED_NOT_STORED") stop ??= "RETENTION_NOT_CONFIRMED";
    else if (calls.some((call) => call.responseModel !== null && call.responseModel !== options.model.responseModelSnapshot)) stop ??= "UNEXPECTED_PROVIDER_BEHAVIOUR";
    // eval.13, FULL only: a completed call that names no response model is an identity failure too (the run would otherwise continue).
    else if (options.phase === "FULL" && calls.some((call) => call.completed && call.responseModel === null)) stop ??= "UNEXPECTED_PROVIDER_BEHAVIOUR";
    // FULL only: a provider timeout is a counted fallback and the run continues (never retried).
    else if (options.phase === "FULL" && reasonCode === "PROVIDER_TIMEOUT") {
      if (totalCredits >= limits.maxCredits) stop ??= "CREDIT_CEILING";
    }
    else if (PROVIDER_REASONS.has(reasonCode) && !(reasonCode === "OPERATIONAL_SPEND_LOCKED" && refusedRepair)) stop ??= "UNEXPECTED_PROVIDER_BEHAVIOUR";
    // Smoke and diagnostic runs stop at the first non-accepted ordinary fixture.
    else if (options.phase !== "FULL" && item.outcome !== "ACCEPTED") stop ??= "SMOKE_FALLBACK";
    else if (totalCredits >= limits.maxCredits) stop ??= "CREDIT_CEILING";
    if (stop) break;
  }

  const perTask = (key: "shellOutputVersion" | "shellInputVersion"): Readonly<Record<ShellTask, string>> =>
    Object.freeze({ EXPLAIN_PATTERN: AI_HYBRID_RUNTIME_BUNDLES.EXPLAIN_PATTERN[key], DRAFT_CARE_PREPARATION_SUMMARY: AI_HYBRID_RUNTIME_BUNDLES.DRAFT_CARE_PREPARATION_SUMMARY[key] });
  const provider = Object.freeze({ providerKey: options.provider.providerModel.providerKey, endpoint: options.model.endpoint ?? null });
  const versions: HybridContractVersions = {
    requestModelId: options.model.requestModelId,
    responseModelSnapshot: options.model.responseModelSnapshot,
    providerKey: provider.providerKey,
    endpoint: provider.endpoint,
    approvalScope: HYBRID_EVALUATION_SCOPE.approvalScope,
    legacyFactGeneration: HYBRID_EVALUATION_SCOPE.legacyFactGeneration,
    shellRequestVersion: AI_HYBRID_VERSIONS.shellRequest,
    shellMaxOutputTokens: Object.freeze({ EXPLAIN_PATTERN: SHELL_MAX_OUTPUT_TOKENS.EXPLAIN_PATTERN, DRAFT_CARE_PREPARATION_SUMMARY: SHELL_MAX_OUTPUT_TOKENS.DRAFT_CARE_PREPARATION_SUMMARY }),
    shellTemperature: SHELL_TEMPERATURE,
    promptVersion: AI_HYBRID_VERSIONS.prompt,
    providerSchemaVersion: AI_HYBRID_VERSIONS.providerSchema,
    shellRulesRevision: AI_HYBRID_VERSIONS.shellRules,
    slotPlanVersion: AI_HYBRID_VERSIONS.slotPlan,
    atomRendererVersion: AI_HYBRID_VERSIONS.atomRenderer,
    defaultShellVersion: AI_HYBRID_VERSIONS.defaultShells,
    languageCopyRevision: AI_HYBRID_VERSIONS.languageCopy,
    validatorRulesRevision: AI_HYBRID_VERSIONS.validatorRules,
    approvedMeaningRegistryRevision: AI_MEANING_REGISTRY_REVISION,
    fixtureSetRevision: PACKET_11_HYBRID_FIXTURE_SET_REVISION,
    evaluationReportVersion: AI_HYBRID_EVALUATION_REPORT_VERSION,
    fullEvaluationPolicy: HYBRID_FULL_EVALUATION_POLICY,
    explainBundle: AI_HYBRID_RUNTIME_BUNDLES.EXPLAIN_PATTERN.bundleKey,
    careBundle: AI_HYBRID_RUNTIME_BUNDLES.DRAFT_CARE_PREPARATION_SUMMARY.bundleKey,
    shellSchemaVersions: perTask("shellOutputVersion"),
    shellInputVersions: perTask("shellInputVersion"),
  };
  return Object.freeze({
    reportVersion: AI_HYBRID_EVALUATION_REPORT_VERSION,
    generatedAt: now(),
    model: Object.freeze({ requestModelId: options.model.requestModelId, responseModelSnapshot: options.model.responseModelSnapshot }),
    provider,
    versions: Object.freeze(versions),
    phase: options.phase,
    limits,
    stoppedReason: stop,
    completed: stop === null && evidence.length === options.fixtures.length,
    hardGatePassed: evidence.every((item) => !item.hardGateFailure),
    totals: Object.freeze({
      fixtures: evidence.length,
      calls: evidence.reduce((sum, item) => sum + item.attempts, 0),
      repairs: evidence.filter((item) => item.repairUsed).length,
      credits: round6(evidence.reduce((sum, item) => sum + item.credits, 0)),
    }),
    utility: options.phase === "FULL" ? hybridFullUtilityGates(evidence) : null,
    languagePresence: languagePresenceOf(evidence),
    assemblyInvariantBreaches: evidence.filter((item) => item.assemblyInvariantBreach).length,
    fixtures: Object.freeze(evidence),
  });
}

/**
 * eval.18: every FULL safe shell fallback whose deciding reason (or any recorded rejection reason, or the fixture's reason) is in
 * AI_EVALUATION_HARD_GATE_REASONS, in evidence order. Each needs the owner's §16.3 classification: genuine §16.3 violations stay hard
 * qualification failures even when blocked. The runtime rejection and fallback are unchanged.
 */
export function blockedContentRequiringClassification(evidence: readonly HybridFixtureEvidence[]): readonly BlockedContentItem[] {
  return Object.freeze(evidence.flatMap((fixture) => {
    const fallback = fixture.safeShellFallback;
    if (fallback == null) return [];
    const reasons = [fallback.reason, fixture.reasonCode, ...(Array.isArray(fallback.rejections) ? fallback.rejections.map((rejection) => rejection.reason) : [])];
    if (!reasons.some((reason) => HARD_GATE_REASONS.has(reason))) return [];
    return [Object.freeze({ fixtureId: fixture.fixtureId, taskType: fixture.taskType, locale: fixture.locale, gate: fallback.gate, reason: fallback.reason })];
  }));
}
const BLOCKED_CONTENT_CLASSIFICATIONS: ReadonlySet<unknown> = new Set<BlockedContentClassification>(["GENUINE_16_3_VIOLATION", "NOT_A_16_3_VIOLATION"]);
/** eval.18: the owner's classification of one fixture, or null when it is missing, malformed or not owner-reviewed (own keys only). */
function ownerClassificationOf(review: unknown, fixtureId: string): BlockedContentClassification | null {
  if (typeof review !== "object" || review === null || Array.isArray(review) || !Object.hasOwn(review, fixtureId)) return null;
  const entry = (review as Record<string, unknown>)[fixtureId];
  if (typeof entry !== "object" || entry === null) return null;
  const { classification, reviewedBy } = entry as { classification?: unknown; reviewedBy?: unknown };
  return reviewedBy === "OWNER" && BLOCKED_CONTENT_CLASSIFICATIONS.has(classification) ? (classification as BlockedContentClassification) : null;
}

/** eval.13: a recorded safe shell fallback is consistent with the rest of its fixture's evidence. */
function validSafeShellFallback(fixture: HybridFixtureEvidence): boolean {
  const fallback = fixture.safeShellFallback;
  if (fallback == null || !Array.isArray(fallback.rejections) || fallback.rejections.length === 0 || fallback.rejections.length !== fixture.attempts) return false;
  const last = fallback.rejections.at(-1)!;
  return (
    fixture.source === "DETERMINISTIC" &&
    fixture.outcome === "FALLBACK" &&
    !fixture.assemblyInvariantBreach &&
    fixture.timedOutCalls === 0 &&
    fixture.deterministicCompositionValid === true &&
    fallback.rejections.every((rejection, index) => rejection.attempt === index + 1 && SAFE_GATES.has(rejection.gate)) &&
    SAFE_GATES.has(fallback.gate) &&
    last.gate === fallback.gate &&
    last.reason === fallback.reason &&
    fallback.reason === fixture.reasonCode
  );
}

/**
 * Completion condition for a hybrid run. Every failure is accumulated. The caller must approve exactly the contract
 * model (eval.7: deepseek-flash), and the report must name the contract provider and endpoint; a null contract model
 * would fail every verdict. Gates are recomputed from the per-fixture evidence; no stored aggregate in the report is
 * trusted. eval.18: a FULL verdict also requires the owner's §16.3 classification (`blockedContentReview`, supplied with the human
 * review) of every blocked hard-reason fallback; null or missing entries are pending (fail closed).
 */
export function hybridLiveRunVerdict(
  report: HybridEvaluationReport,
  plan: { phase: AiEvaluationPhase; fixtureIds: readonly string[]; maxCalls: number },
  approved: { maxCredits: number; requestModelId: string | null; responseModelSnapshot: string | null },
  humanReview: HumanReviewRecord | null,
  blockedContentReview: BlockedContentReview | null = null,
): LiveRunVerdict {
  const failures: string[] = [];
  // Smoke and diagnostic phases share the strict single-candidate, no-repair rules.
  const smoke = plan.phase !== "FULL";
  const contract: Readonly<{ requestModelId: string | null; responseModelSnapshot: string | null; providerKey: string; endpoint: string }> = APPROVED_HYBRID_CONTRACT;
  const modelApproved = approved.requestModelId !== null && approved.responseModelSnapshot !== null;
  // The contract itself must name a model: a null contract model fails whatever the caller passes, so a report whose
  // versions model keys were forged to null can never match it.
  const contractModelApproved = contract.requestModelId !== null && contract.responseModelSnapshot !== null;
  // eval.7: the caller's approved model must be exactly the contract model.
  const sameAsContract = approved.requestModelId === contract.requestModelId && approved.responseModelSnapshot === contract.responseModelSnapshot;
  if (!modelApproved || !contractModelApproved || !sameAsContract) failures.push("MODEL_NOT_APPROVED");
  // The versions block and the model block must name the same model.
  if (report.versions.requestModelId !== report.model.requestModelId || report.versions.responseModelSnapshot !== report.model.responseModelSnapshot) failures.push("MODEL_FIELDS_INCONSISTENT");
  // eval.7: the provider block and the versions block must both name the contract provider and endpoint.
  const providerBlock = (report as { provider?: { providerKey?: unknown; endpoint?: unknown } | null }).provider;
  if (providerBlock?.providerKey !== contract.providerKey || providerBlock?.endpoint !== contract.endpoint || report.versions.providerKey !== contract.providerKey || report.versions.endpoint !== contract.endpoint) failures.push("PROVIDER_NOT_APPROVED");
  if (report.phase !== plan.phase) failures.push("PHASE_MISMATCH");
  // Every contract key is compared, the model keys included (the contract names its model).
  for (const key of Object.keys(APPROVED_HYBRID_CONTRACT) as ContractKey[]) {
    if (!sameVersion(report.versions[key], APPROVED_HYBRID_CONTRACT[key])) failures.push(`CONTRACT_VERSION_MISMATCH:${key}`);
  }
  if (report.reportVersion !== APPROVED_HYBRID_CONTRACT.evaluationReportVersion) failures.push("CONTRACT_VERSION_MISMATCH:reportVersion");
  if (!report.completed) failures.push("NOT_COMPLETED");
  if (report.stoppedReason !== null) failures.push(`STOPPED:${report.stoppedReason}`);
  // eval.13: the hard gate is also recomputed from the evidence: a hard reason without a valid FULL safe shell fallback, or a shown
  // deterministic composition the r7 verifier rejected, fails it whatever the stored flags say.
  const validFallback = (fixture: HybridFixtureEvidence) => !smoke && validSafeShellFallback(fixture);
  const hardReason = (fixture: HybridFixtureEvidence) => HARD_GATE_REASONS.has(fixture.reasonCode) && !validFallback(fixture);
  if (!report.hardGatePassed || report.fixtures.some((fixture) => fixture.hardGateFailure || hardReason(fixture) || fixture.deterministicCompositionValid === false)) failures.push("HARD_GATE");
  // eval.13: a safe shell fallback exists only in FULL, only at S1–S7b or S9, only behind a shown deterministic composition.
  if (report.fixtures.some((fixture) => fixture.safeShellFallback != null && (smoke || !validSafeShellFallback(fixture)))) failures.push("SAFE_SHELL_FALLBACK_INVALID");
  if (report.assemblyInvariantBreaches !== 0 || report.fixtures.some((fixture) => fixture.assemblyInvariantBreach)) failures.push("ASSEMBLY_INVARIANT_BREACH");
  const ids = report.fixtures.map((fixture) => fixture.fixtureId);
  if (ids.length !== plan.fixtureIds.length || ids.some((id, index) => id !== plan.fixtureIds[index])) failures.push("FIXTURE_SET");
  const calls = report.fixtures.reduce((sum, fixture) => sum + fixture.attempts, 0);
  const repairs = report.fixtures.filter((fixture) => fixture.repairUsed).length;
  const credits = round6(report.fixtures.reduce((sum, fixture) => sum + fixture.credits, 0));
  // Smoke: exactly the planned calls. Full: one call per fixture plus counted repairs, never above the cap.
  const callsOk = smoke ? calls === plan.maxCalls && report.totals.calls === calls : calls === report.fixtures.length + repairs && calls <= plan.maxCalls && report.totals.calls === calls;
  if (!callsOk) failures.push("CALL_COUNT");
  if (!(credits <= approved.maxCredits) || !(report.totals.credits <= approved.maxCredits)) failures.push("CREDITS_OVER_CEILING");
  // Identity and retention are judged on received responses only; a fixture with no response has neither.
  const received = report.fixtures.filter((fixture) => fixture.responseAvailability !== "NO_RESPONSE");
  if (modelApproved) {
    if (report.model.requestModelId !== approved.requestModelId || report.model.responseModelSnapshot !== approved.responseModelSnapshot) failures.push("MODEL_MISMATCH");
    if (received.some((fixture) => fixture.responseModel !== approved.responseModelSnapshot)) failures.push("RESPONSE_MODEL_MISMATCH");
  }
  if (received.length === 0) failures.push("NO_RESPONSE_RECEIVED");
  if (received.some((fixture) => fixture.retention !== "CONFIRMED_NOT_STORED")) failures.push("RETENTION_NOT_CONFIRMED");
  if (report.fixtures.some((fixture) => fixture.source === "AI" && fixture.atomEqual !== true)) failures.push("ATOM_INEQUALITY");
  if (smoke) {
    if (repairs !== 0 || report.totals.repairs !== 0) failures.push("UNEXPECTED_REPAIR");
    if (report.fixtures.some((fixture) => fixture.outcome !== "ACCEPTED")) failures.push("FIXTURE_NOT_ACCEPTED");
  } else {
    // eval.13: the hybrid-specific FULL gates, recomputed from the evidence (the legacy fullUtilityGates are not used).
    const utility = hybridFullUtilityGates(report.fixtures);
    if (!utility.usefulAcceptedOutput.passed) failures.push("UTILITY:USEFUL_ACCEPTED_OUTPUT");
    if (!utility.withinProductionTimeout.passed) failures.push("UTILITY:WITHIN_PRODUCTION_TIMEOUT");
    if (!utility.firstCallValid.passed) failures.push("UTILITY:FIRST_CALL_VALID");
    if (!utility.repairs.passed) failures.push("UTILITY:REPAIR_RATE");
    if (!languagePresenceOf(report.fixtures).passed) failures.push("LANGUAGE_PRESENCE");
    const reviews = AI_LOCALES.map((locale) => humanReview?.[locale]);
    const counted = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= 0;
    if (reviews.some((review) => !review || !counted(review.sampled) || review.sampled < HUMAN_REVIEW_SAMPLE_PER_LOCALE)) failures.push("HUMAN_REVIEW_PENDING");
    if (reviews.some((review) => review && (!counted(review.passed) || review.passed !== review.sampled))) failures.push("HUMAN_REVIEW_FAILED");
    // eval.18: every blocked hard-reason fallback needs the owner's §16.3 classification; a genuine violation fails qualification.
    const classifications = blockedContentRequiringClassification(report.fixtures).map((item) => ownerClassificationOf(blockedContentReview, item.fixtureId));
    if (classifications.includes("GENUINE_16_3_VIOLATION")) failures.push("HARD_GATE:BLOCKED_16_3_VIOLATION");
    if (classifications.includes(null)) failures.push("BLOCKED_CONTENT_REVIEW_PENDING");
  }
  return failures.length === 0 ? { kind: "PASS" } : { kind: "FAIL", failures };
}
