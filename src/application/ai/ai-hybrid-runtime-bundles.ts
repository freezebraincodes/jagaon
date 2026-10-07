import { deepFreeze } from "@/application/deep-freeze";
import { AI_LOCALES, SHELL_INPUT_VERSIONS, shellMaxOutputTokens, SHELL_OUTPUT_VERSIONS, SHELL_PROVIDER_REQUEST_VERSION, SHELL_TASKS, SLOT_PLAN_VERSION, type AiLocale, type ShellMaxOutputTokens, type ShellTask } from "@/domain/ai";
import { AI_TASK_RUNTIME_BUNDLES, type AiComponentRef, type AiTaskRuntimeBundle } from "./ai-runtime-bundles";

/**
 * Packet 11B.6 hybrid bundles (spec Section 13). Separate from the legacy 11b.3 bundles, which stay the
 * evidence path. The assembled output schema, execution budget, timeouts, deterministic-only route profile
 * and null model are inherited unchanged; the hybrid component versions ride in the existing audit slots.
 * Bundle set 11b.7 (Packet 11B.7 hardening): fixed field budgets, remote eligibility and the 11b.7 shell
 * contracts; H2 moved the shell rules (r2), prompt (11b.13) and provider schema (kie-schema.11b.5); H3 moved the
 * fixture set (packet11-fixtures.11b.5, audit fixtureSet component "11b.5") and the harness (packet11-eval.6).
 * Bundle set 11b.8 (shell rules r3, owner list revision): the shell rules moved (ai-shell-rules.11b.8-r3), so the bundle
 * keys and the validatorProfile component are 11b.8; the fixture set is packet11-fixtures.11b.6 (audit component "11b.6");
 * every other component keeps its 11b.7 version (capability, input schema, locale packs, fallback, shell in/out, slot plan).
 * Bundle set 11b.9 (Packet 11B.9, owner decision 2026-10-06): the shell request profile ai-shell-request.11b.9 sends the
 * fixed max_output_tokens SHELL_MAX_OUTPUT_TOKENS (512). Both are recorded as bundle components (shellRequestVersion,
 * shellMaxOutputTokens); the request builder itself always uses the domain constant. The execution budget, the output
 * token ceiling included (EXPLAIN 350, care 800), is inherited unchanged, so the slot planner, remote eligibility and
 * the S10 budget are as before. The fixture set is packet11-fixtures.11b.7 (audit component "11b.7") and the harness
 * packet11-eval.7. The validator profile stays 11b.8 (rules r3) and every other component keeps 11b.7. The route profile
 * stays deterministic-only and the model null.
 * Bundle set 11b.10 (Packet 11B.10, owner instruction 2026-10-06): per-task caps. The request profile is
 * ai-shell-request.11b.10 and each bundle's shellMaxOutputTokens is its task's cap (EXPLAIN 512, care 1024); the
 * execution budget (350/800, timeouts, maxAttempts) is still inherited unchanged. The fixture set is
 * packet11-fixtures.11b.8 (audit component "11b.8") and the harness packet11-eval.8; every other component is unchanged.
 * Bundle set 11b.11 (Packet 11B.11, shell rules r4, owner instruction 2026-10-06, offline only): wording quality. The shell
 * rules moved (ai-shell-rules.11b.11-r4: zh register at S7, meaningful wording at S7b), so the validatorProfile component is
 * 11b.11; the prompt is 11b.14; the fixture set is packet11-fixtures.11b.9 (audit component "11b.9") and the harness
 * packet11-eval.9. The request profile (ai-shell-request.11b.10), the per-task caps (512/1024), the execution budget and
 * timeouts, the shell in/out versions, slot plan, atoms, default shells and language copy are unchanged.
 * Bundle set 11b.12 (Packet 11B.12, shell rules r5, owner instruction 2026-10-06, offline only): clinical labels. The shell
 * rules moved (ai-shell-rules.11b.12-r5: gate S6b), so the validatorProfile component is 11b.12; the prompt is 11b.15; the
 * fixture set is packet11-fixtures.11b.10 (audit component "11b.10") and the harness packet11-eval.10. The request profile,
 * the per-task caps (512/1024), the execution budget and timeouts and every other component are unchanged.
 * Bundle set 11b.13 (Packet 11B.13, shell rules r6, owner instruction 2026-10-06, offline only): clinical-label boundary
 * precision. The shell rules moved (ai-shell-rules.11b.13-r6), so the validatorProfile component is 11b.13; the fixture set is
 * packet11-fixtures.11b.11 (audit component "11b.11") and the harness packet11-eval.11. The prompt stays 11b.15; the request
 * profile, the per-task caps (512/1024), the execution budget and timeouts and every other component are unchanged.
 * Bundle set 11b.14 (Packet 11B.14, shell rules r7, owner instruction 2026-10-06, offline only): final stabilisation. The shell
 * rules moved (ai-shell-rules.11b.14-r7: contextual English up/down), so the validatorProfile component is 11b.14; the request
 * profile is ai-shell-request.11b.11 (the fixed temperature 0.2 added; the builder always uses the domain constant); the fixture
 * set is packet11-fixtures.11b.12 (audit component "11b.12") and the harness packet11-eval.12. The prompt stays 11b.15; the
 * per-task caps (512/1024), the execution budget and timeouts and every other component are unchanged.
 * Bundle set 11b.15 (Packet 11B.15, shell rules r8, owner instruction 2026-10-07, offline only): S6 placeholder provenance. The
 * shell rules moved (ai-shell-rules.11b.15-r8: an S6 match that splits a token stand-in no longer counts; a token-separated copy is
 * read as well), so the validatorProfile component is 11b.15 and the bundle keys are @11b.15; the fixture set is
 * packet11-fixtures.11b.13 (audit component "11b.13") and the harness packet11-eval.14. The request profile (ai-shell-request.11b.11),
 * the prompt (11b.15), the per-task caps (512/1024), the temperature, the execution budget and timeouts and every other component are
 * unchanged.
 * Bundle set 11b.16 (zh EXPLAIN guidance, owner instruction 2026-10-07, offline only): the prompt moved (11b.16: one new paragraph in
 * the zh-SG EXPLAIN asset only; the one shared prompt version labels all four assets), so the promptTemplate component is 11b.16 and
 * the bundle keys are @11b.16; the fixture set is packet11-fixtures.11b.14 (audit component "11b.14") and the harness packet11-eval.15.
 * The validatorProfile component stays 11b.15 (rules r8 unchanged); the request profile (ai-shell-request.11b.11), the per-task caps
 * (512/1024), the temperature, the execution budget and timeouts and every other component are unchanged.
 * Bundle set 11b.17 (en EXPLAIN guidance, owner instruction 2026-10-07, offline only): the prompt moved (11b.17: the English counterpart
 * in the en-SG EXPLAIN asset only), so the promptTemplate component is 11b.17 and the bundle keys are @11b.17; the fixture set is
 * packet11-fixtures.11b.15 (audit component "11b.15") and the harness packet11-eval.16. The validatorProfile component stays 11b.15
 * (rules r8 unchanged); every other component, the request profile, caps, temperature, budget and timeouts are unchanged.
 * Bundle set 11b.18 (observation ownership, owner instruction 2026-10-07, offline only): the application composes every EXPLAIN
 * observation; the model writes the EXPLAIN headline and evidence (care unchanged). Moved: slot plan ai-slot-plan.11b.8 (field
 * ownership), EXPLAIN shell input/output @11b.8 (care stays @11b.7), provider schema kie-schema.11b.6, language copy
 * ai-language-copy.11b.7 (observation variants; defaults unchanged), prompt 11b.18, validatorProfile component 11b.18 (the gates read
 * the remote fields only; shell rules ai-shell-rules.11b.15-r8 unchanged), bundle keys @11b.18, fixture set packet11-fixtures.11b.16
 * (audit component "11b.16") and harness packet11-eval.17. The request profile, caps, temperature, budget, timeouts, atoms, default
 * shells, r7 and the meaning registry are unchanged. packet11-eval.18 (structural first-call validity, owner decision 2026-10-07)
 * moved the harness only.
 * Presentation correction P1/P3 (owner instruction 2026-10-08, offline): application copy ai-language-copy.11b.8 and default shells
 * ai-shells-default.11b.7 only (supplied EXPLAIN items quoted as the person's own words; fixed care-draft notices). Nothing reaches the
 * model: bundle keys stay @11b.18 and every model-facing request byte and remote eligibility is unchanged.
 */
export const AI_HYBRID_BUNDLE_VERSION = "11b.18";
/** The components unchanged since bundle set 11b.7. */
const AI_HYBRID_UNCHANGED_COMPONENT_VERSION = "11b.7";
/** The validator profile: shell rules r8 (11b.15) plus field ownership in the validator (11b.18). */
const AI_HYBRID_VALIDATOR_PROFILE_VERSION = "11b.18";
export const AI_HYBRID_VERSIONS = deepFreeze({
  slotPlan: SLOT_PLAN_VERSION,
  atomRenderer: "ai-atoms.11b.6",
  defaultShells: "ai-shells-default.11b.7",
  shellRules: "ai-shell-rules.11b.15-r8",
  languageCopy: "ai-language-copy.11b.8",
  prompt: "11b.18",
  providerSchema: "kie-schema.11b.6",
  validatorRules: "11b.2-meaning-r7",
  fixtureSet: "packet11-fixtures.11b.16",
  evaluationReport: "packet11-eval.18",
  shellRequest: SHELL_PROVIDER_REQUEST_VERSION,
} as const);
/** The audit fixtureSet component of bundle set 11b.18 (packet11-fixtures.11b.16). */
const AI_HYBRID_FIXTURE_SET_COMPONENT_VERSION = "11b.16";

export type AiHybridRuntimeBundle = AiTaskRuntimeBundle &
  Readonly<{
    languageLayer: "SLOT_SHELL";
    shellInputVersion: string;
    shellOutputVersion: string;
    /** Bundle set 11b.10: the shell request profile (ai-shell-request.11b.10; ai-shell-request.11b.11 since bundle set 11b.14). */
    shellRequestVersion: typeof SHELL_PROVIDER_REQUEST_VERSION;
    /** Bundle set 11b.10: this task's fixed max_output_tokens (recorded; not the output token ceiling). */
    shellMaxOutputTokens: ShellMaxOutputTokens;
  }>;

const at = (ref: AiComponentRef, version: string): AiComponentRef => ({ id: ref.id, version });

function hybridBundle(task: ShellTask): AiHybridRuntimeBundle {
  const base = AI_TASK_RUNTIME_BUNDLES[task];
  const name = task.toLowerCase().replaceAll("_", "-");
  return {
    ...base,
    bundleKey: `ai.${name}@${AI_HYBRID_BUNDLE_VERSION}`,
    capabilityProfile: at(base.capabilityProfile, AI_HYBRID_UNCHANGED_COMPONENT_VERSION),
    promptTemplate: at(base.promptTemplate, AI_HYBRID_VERSIONS.prompt),
    inputSchema: at(base.inputSchema, AI_HYBRID_UNCHANGED_COMPONENT_VERSION),
    outputSchema: base.outputSchema,
    validatorProfile: at(base.validatorProfile, AI_HYBRID_VALIDATOR_PROFILE_VERSION),
    localePack: { "en-SG": at(base.localePack["en-SG"], AI_HYBRID_UNCHANGED_COMPONENT_VERSION), "zh-SG": at(base.localePack["zh-SG"], AI_HYBRID_UNCHANGED_COMPONENT_VERSION) },
    fallbackProfile: at(base.fallbackProfile, AI_HYBRID_UNCHANGED_COMPONENT_VERSION),
    fixtureSet: at(base.fixtureSet, AI_HYBRID_FIXTURE_SET_COMPONENT_VERSION),
    languageLayer: "SLOT_SHELL",
    shellInputVersion: SHELL_INPUT_VERSIONS[task],
    shellOutputVersion: SHELL_OUTPUT_VERSIONS[task],
    shellRequestVersion: SHELL_PROVIDER_REQUEST_VERSION,
    shellMaxOutputTokens: shellMaxOutputTokens(task),
  };
}

export const AI_HYBRID_RUNTIME_BUNDLES: Readonly<Record<ShellTask, AiHybridRuntimeBundle>> = deepFreeze(
  Object.fromEntries(SHELL_TASKS.map((task) => [task, hybridBundle(task)])) as Record<ShellTask, AiHybridRuntimeBundle>,
);

export function resolveAiHybridBundle(taskType: ShellTask, locale: AiLocale): AiHybridRuntimeBundle {
  if (!(SHELL_TASKS as readonly string[]).includes(taskType)) throw new Error("UNKNOWN_SHELL_TASK");
  if (!(AI_LOCALES as readonly string[]).includes(locale)) throw new Error("UNSUPPORTED_AI_LOCALE");
  return AI_HYBRID_RUNTIME_BUNDLES[taskType];
}
