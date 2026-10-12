// @vitest-environment node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Dexie from "dexie";
import fakeIndexedDB, { IDBKeyRange as FDBKeyRange } from "fake-indexeddb";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DEEPSEEK_FLASH_PEAK_USD_PER_MILLION, DEEPSEEK_RESPONSES_URL } from "@/ai/deepseek/deepseek-catalogue";
import { PROVIDER_FAILURE_REASONS } from "@/application/ai/ai-provider-port";
import { AI_SHELL_INPUT_FRAMING_MARGIN_TOKENS, AI_SHELL_PROVIDER_BODY_OVERHEAD_MAX_BYTES, AI_SHELL_ROUTE_PEAK_USD_PER_MILLION } from "@/application/ai/ai-shell-route-contract";
import {
  AI_AUDIT_ONLY_OUTCOME_CODES,
  AI_AUDIT_UNSENT_OUTCOME_CODES,
  AI_AUDIT_USAGE_BASES,
  AI_INVOCATION_AUDIT_LEGACY_SCHEMA_VERSION,
  AI_INVOCATION_AUDIT_SCHEMA_VERSION,
  AI_INVOCATION_OUTCOME_CODES,
  AI_INVOCATION_OUTCOME_CODES_11A,
  AI_REASON_CODES,
} from "@/domain/ai";
import { DEEPSEEK_RESPONSES_PROFILE } from "@/ai/deepseek/deepseek-responses-provider";
import { SHELL_PROVIDER_SCHEMA_VERSION, shellOutputJsonSchema, shellOutputSchemaName } from "@/ai/kie/kie-shell-contracts";
import { PACKET_11_SHELL_PROMPT_VERSION, PACKET_11_SHELL_PROMPTS } from "@/ai/prompts/packet-11-shell-prompts";
import { AI_SHELL_ACCESS_SPEND_POLICY_VERSION, AI_SHELL_DEPLOYMENT_ENV } from "@/app/api/ai/shell/ai-shell-deployment-config";
import { createAiShellHandler } from "@/app/api/ai/shell/ai-shell-handler";
import { TEST_DEPLOYMENT_ENVIRONMENT, testBrowserHeaders } from "@/app/api/ai/shell/ai-shell-route-test-support";
import { AI_DISCLOSURE_POLICY_VERSION, createAiRemoteUseDecisions, INTERIM_FAIL_CLOSED_DISCLOSURE } from "@/application/ai/browser-shell-client";
import { AI_SHELL_ACCESS_HEADER, AI_SHELL_ROUTE_REFUSAL_REASONS } from "@/application/ai/ai-shell-route-contract";
import { BACKUP_PAYLOAD_MIGRATIONS } from "@/backup/backup-migration-registry";
import { BACKUP_PAYLOAD_FORMAT, BACKUP_SCHEMA_VERSION, BACKUP_SCHEMA_VERSION_V1 } from "@/backup/backup-payload-v1";
import { KEEP_WORDING_PREFERENCE_KEY, KEEP_WORDING_PREFERENCE_SCHEMA_VERSION } from "@/storage/app-preference-row";
import type { AppMessages } from "@/i18n/types";
import { AI_ACTIVATION_MANIFEST, type AiActivationManifest } from "@/application/ai/ai-activation-manifest";
import { AI_HYBRID_BUNDLE_VERSION, AI_HYBRID_RUNTIME_BUNDLES, AI_HYBRID_VERSIONS } from "@/application/ai/ai-hybrid-runtime-bundles";
import { AI_MEANING_REGISTRY_REVISION } from "@/application/ai/ai-meaning-registry";
import { AI_TASK_RUNTIME_BUNDLES } from "@/application/ai/ai-runtime-bundles";
import { AI_SHELL_ROUTE_PATH } from "@/application/ai/ai-shell-route-contract";
import { AI_LANGUAGE_COPY_REVISION } from "@/application/ai/language/ai-language-copy";
import { ATOM_RENDERER_VERSION } from "@/application/ai/language/atom-renderer";
import { AI_DEFAULT_SHELLS_VERSION } from "@/application/ai/language/default-shells";
import { SHELL_RULES_REVISION } from "@/application/ai/language/shell-lexicon";
import { projectShellTaskRequest } from "@/application/ai/language/shell-projector";
import { ATOM_SPACING_RESERVE, FIELD_SCHEMA_LIMITS, FIXED_FIELD_BUDGETS } from "@/application/ai/language/slot-planner";
import { buildCareSummaryAiRequest } from "@/application/care-preparation/ai-care-summary-request";
import { NOW, syntheticCareDraft, type SyntheticCareDraftShape } from "@/application/care-preparation/care-preparation-test-support";
import {
  CARE_SUMMARY_AI_ASSISTED_RENDERER_VERSION,
  CARE_SUMMARY_AI_ASSISTED_TEMPLATE_VERSION,
  CARE_SUMMARY_LOCALE_PACK_VERSION,
  CARE_SUMMARY_RENDERER_VERSION,
  CARE_SUMMARY_TEMPLATE_VERSION,
} from "@/application/care-preparation/care-summary-locale-pack";
import { careSummaryAiMarkingText } from "@/application/care-preparation/care-summary-ai-marking";
import { renderDeterministicCareSummary } from "@/application/care-preparation/deterministic-care-summary-renderer";
import { CARE_SUMMARY_AI_MARKING_VERSIONS, CARE_SUMMARY_TEMPLATES_WITH_AI_MARKING, CARE_SUMMARY_TEMPLATES_WITH_DRAFT_NOTICES } from "@/domain/care-preparation/care-summary-snapshot";
import { AI_LOCALES, AI_TASK_TYPES, SHELL_INPUT_VERSIONS, SHELL_MAX_OUTPUT_TOKENS, SHELL_OUTPUT_VERSIONS, SHELL_PROVIDER_REQUEST_VERSION, SHELL_TASKS, SHELL_TEMPERATURE, SLOT_PLAN_VERSION, type AiLocale } from "@/domain/ai";
import { getMessages } from "@/i18n/get-messages";
import { AI_REQUEST_CLASS_CONTRACT, AI_REQUEST_CLASS_DEFINITIONS } from "@/application/ai/request-class-definitions";
import { AI_REMOTE_ELIGIBILITY_POLICY_VERSION, AI_REQUEST_CLASS_QUALIFICATION_RECORDS, SHIPPED_REQUEST_CLASS_GATE } from "@/application/ai/request-class-qualification";
import { DETERMINISTIC_ONLY_TEST_MANIFEST, pendingTestRequestClassGate, qualifiedTestRequestClassGate } from "@/application/ai/request-class-test-support";
import { canonicalizeJson } from "@/application/contracts/canonical-json";
import { requestClassContractDigest, requestClassContractInputsFromCode, splitQualificationModule } from "./packet-11c-request-class-generator";
import { VALIDATOR_RULES_REVISION } from "./packet-11-evaluation";
import { AI_HYBRID_EVALUATION_REPORT_VERSION, APPROVED_HYBRID_CONTRACT, HYBRID_FULL_EVALUATION_POLICY, HYBRID_FULL_UTILITY_THRESHOLDS } from "./packet-11-hybrid-evaluation";
import { hybridFixturesForPhase, PACKET_11_HYBRID_FIXTURE_SET_REVISION } from "./packet-11-hybrid-fixtures";
import { plannedFixture } from "./packet-11-hybrid-test-support";
import { capture, existingFixtureDigest, versionNormalisedFixtureDigest } from "./packet-11-presentation-guard.test";
import { normaliseSlotPlanVersion, SLOT_PLAN_VERSION_OCCURRENCES_PER_BODY } from "./packet-11-slot-plan-version-normalisation";
import { normalise11b20Prompt } from "./packet-11-prompt-change-normalisation";
import { SOURCE_BACKED_SCENARIOS, sourceBackedFixture } from "./packet-11-source-backed-fixtures";

/**
 * PACKET 11C FROZEN CONTRACT MANIFEST (Addendum B, Task B5; offline; coordinator ruling recorded in the SDD ledger). Every frozen version
 * and identity of the bounded AI integration is pinned here, in one place, before any owner-authorized live run:
 * - the language layer (slot plan, atom renderer, application copy, default shells), the shell rules, the shell request profile, the
 *   prompt (version and the exact text of its four assets), the provider output schema (label and the exact four schemas), the r7
 *   validator, the approved-meaning registry, the hybrid bundle keys and shell in/out versions, the 70-fixture set and the harness;
 * - the care-summary template, renderer and locale pack, and the shared disclosure copy (ai-disclosure.11c.1, wording human acceptance
 *   pending: pinned as bytes, never recorded as approved);
 * - the `/api/ai/shell` route's provider and model (D2: Direct DeepSeek `deepseek-flash`, recorded in the contract; NOT a production pin:
 *   every runtime bundle keeps `modelSnapshot: null` and nothing is activated), temperature, caps and the budgets table;
 * - the shipped activation manifest (Packet 11C English activation: EXPLAIN_PATTERN and DRAFT_CARE_PREPARATION_SUMMARY
 *   SYNTHETIC_REMOTE_ENABLED, every other task DETERMINISTIC_ONLY);
 * - the current model-facing request digests: the 70 fixtures (current, and version-normalised to the historical evaluated bytes), the
 *   source-backed EXPLAIN classes and the care snapshot classes.
 * Where several code sources carry one value, they must agree; a disagreement shows every source by name.
 *
 * B5 label resolution: the provider output-schema label moved kie-schema.11b.6 -> kie-schema.11c.1 (its slotPlanVersion enum carries
 * ai-slot-plan.11b.9) and the harness label packet11-eval.18 -> packet11-eval.19 (the contract pins moved in 11C; eval.18-era evidence is
 * an earlier contract). Neither label is part of any model-facing body (checked below on every captured body), so every body digest is
 * unchanged by the bump.
 *
 * Packet 11C Addendum C, Task C5 (owner decisions C5-a, C5-b): the harness label moved packet11-eval.19 -> packet11-eval.20 (the
 * conservative usage accounting; hybrid-full-policy.2 and every threshold unchanged), and two items join the manifest: `audit` (the local
 * audit row ai-invocation-audit.11c.2 beside the still-valid legacy 11a.1 rows, its audit-only outcome codes and usage bases, and the
 * unchanged provider failure reasons) and `callUpperBound` (the shared pre-send upper bound of one shell call). None of them is
 * model-facing: every body digest below is unchanged.
 *
 * Packet 11C Addendum C, Task C1 (owner decision C1): `requestClasses` joins the manifest: the request-class scheme
 * ai-request-class.11c.1, the remote-eligibility policy ai-remote-eligibility.11c.1, the contract digest (sha256 of the canonical frozen
 * contract inputs, computed here from the same sources the items above pin), the digest of the 12 generated class definitions, their
 * count per task and locale and samples, and the shipped qualification records: one per class, ALL PENDING, no evidence, no sign-off.
 * None of it is model-facing (checked on every captured body): every body digest is unchanged.
 *
 * Packet 11C Addendum C, Task C4 (deliberate, for the CL3 re-freeze): `careSummary` adds the AI-assisted care-summary template and
 * renderer 11c.2 (hashed AI marking built from the approved rows ai.demoTag and ai.resultCheck), the AI-marking template list and the
 * sha256 of the marking text per locale; 11c.2 joins the notice templates. Deterministic previews keep 11c.1. Not model-facing.
 *
 * Packet 11C Addendum C, CL3 contract re-freeze (Task RF; every CL1–CL3 version or policy, each read from the code by a reader):
 * - `harness` also pins the unchanged FULL utility thresholds of hybrid-full-policy.2;
 * - `requestClasses`: the contract inputs now also bind each class's captured model-facing body sha256 and the endpoint sha256 (C1-review
 *   carry; every classId changed, records regenerated, all still PENDING), plus the sha256 of the qualification module OUTSIDE its
 *   generated records literal (the rule, schema and gate) and the shipped gate admitting no task;
 * - `remoteUseDisclosure` (C3): the per-request disclosure policy ai-disclosure-policy.11c.2-per-request, read from its behaviour, and
 *   the passcode-field row bytes (no label; human acceptance pending). The dialog copy stays ai-disclosure.11c.1 (`disclosureCopy`):
 *   owner decision U03 changed behaviour only (the primary action waits for non-whitespace passcode input), no dialog row;
 * - `shellAccessSpend` (C6): the policy ai-shell-access-spend.11c.1, the deployment variable NAMES (never a value), the access header
 *   name, the closed refusal reasons, the not-sent marker and the route's check order, read by probing the handler (all faults set,
 *   then each reported fault removed in turn, until the provider call);
 * - `privateWording` (C2): the preference row app-preference.keep-wording.11c.1, backup payload v2 and its one migration, and the
 *   setting's copy group ai-wording-setting.11c.2 (owner decisions U04/U05 moved it from 11c.1);
 * - `historyFallback` (owner decision U12): the copy group ai-history-fallback.11c.1.
 * None of it is model-facing (checked on every captured body): every body digest is unchanged.
 *
 * Packet 11C English activation (owner decisions Q and A, 2026-10-12; deliberate): `activationManifest` moves to ai-activation.11c.1
 * with EXPLAIN_PATTERN and DRAFT_CARE_PREPARATION_SUMMARY SYNTHETIC_REMOTE_ENABLED (the four other tasks DETERMINISTIC_ONLY), and
 * `requestClasses` pins the six en-SG classes QUALIFIED by the owner's sign-off (evidence: the English demo protocol record, a waiver of
 * the manual review, not a completed human-review PASS), the six zh-SG classes PENDING, the shipped gate admitting both tasks (en-SG
 * classes only) and the new sha256 of the qualification module outside its records literal (doc comments only; the rule, schema and
 * gate code are byte-identical). The contract digest, the 12 classIds, the definitions digest, the prompt and rule assets and every
 * model-facing body are unchanged. The route-order probe injects the pre-activation manifest and an all-PENDING gate for its activation
 * and class faults (the shipped state no longer produces them).
 *
 * Changing anything pinned here fails with FROZEN_CONTRACT_CHANGED and the item's name. Update this manifest only deliberately, with the
 * owner's re-approval of the contract and the evidence policy (a changed model-facing byte needs fresh evaluation evidence).
 * Fake fetchers only; no provider call; the global fetch is stubbed to throw.
 */

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const failure = (name: string) =>
  `FROZEN_CONTRACT_CHANGED: "${name}". The Packet 11C contract is frozen (Addendum B, Task B5). A change needs the owner's re-approval, a new label and, for any model-facing byte, fresh evaluation evidence; update this manifest only deliberately.`;
/** The one value every named source carries, or every source by name when they disagree. */
function agree(sources: Readonly<Record<string, unknown>>): unknown {
  const values = Object.values(sources);
  return new Set(values.map((value) => JSON.stringify(value))).size === 1 ? values[0] : { SOURCES_DISAGREE: sources };
}

const LOCALES: readonly AiLocale[] = AI_LOCALES;
const CARE_CLASSES: ReadonlyArray<readonly [SyntheticCareDraftShape, string]> = [["ORDINARY", "ordinary"], ["HIDDEN_LIMITATION", "hidden-limitation"]];
const SENTINEL = "ds-SENTINEL-CREDENTIAL-contract-freeze";
const ENABLED: AiActivationManifest = {
  ...AI_ACTIVATION_MANIFEST,
  tasks: { ...AI_ACTIVATION_MANIFEST.tasks, EXPLAIN_PATTERN: "SYNTHETIC_REMOTE_ENABLED", DRAFT_CARE_PREPARATION_SUMMARY: "SYNTHETIC_REMOTE_ENABLED" },
};

/** Offline re-freeze candidate pins. Passing these tests is not owner re-freeze approval or model qualification. */
const FROZEN = Object.freeze({
  slotPlan: "ai-slot-plan.11b.9",
  atomRenderer: "ai-atoms.11b.7",
  languageCopy: "ai-language-copy.11b.10",
  defaultShells: "ai-shells-default.11b.8",
  // r10 re-freeze (owner decisions 2026-10-09, offline; one freeze, r9 never frozen on its own): r9 refines the r3 zh 留意 alternative
  // to (?<!所)留意 (FULL diagnosis case 2); r10 adds the additive no-implied-urgency / no-assigned-importance directive entries and six
  // Traditional rows (urgency-language assessment). The FULL run under r8 stays FAIL (r9/r10 rescore nothing).
  // The r10 rule text was tightened before commit (coordinator ruling after the independent review: zh modal + attention verb, the zh
  // form of "needs your attention"); the label stays 11b.16-r10 because r10 is uncommitted and has no bound evidence, and the rule text
  // feeds no digest (regenerated with the existing generator: contract digest and classIds unchanged).
  // r11 offline pins (salience option (a), 2026-10-11): additive R11 directive entries (significant, crucial, key in
  // evaluative use; look closely, notice, keep in mind, to watch; 重点, 关键, 显著) and two Traditional rows. Prompt, request bytes and bodies
  // were unchanged by that validator-only step, relative to 11b.18. Batch 2 below changes the prompt/body separately. The old FULL stays FAIL.
  shellRules: "ai-shell-rules.11b.18-r12",
  // r12 offline pins (owner decision 2026-10-11, policy-led prompt): additive R12_DIRECTIVE claim-shape entries (F1 data judgement, F2 benefit
  // or cause, F3 completed-state claim, F4 attributed feeling) and 38 Traditional rows. Batch 2 moved prompt and bundle labels to 11b.19 (two
  // shared edits); the 11b.20 candidate (policy-led rewrite of ROLE, BANS and the two EXPLAIN guidance paragraphs) moves them to 11b.20 and
  // changes every model-facing body again.
  // Request classes are regenerated PENDING, with no inherited evidence/sign-off; historical byte guards invert only documented edits.
  shellRequestProfile: "ai-shell-request.11b.11",
  prompt: { version: "11b.20", assetsSha256: "5c3950c93c0d0de7fe4b158e1fc54248769e1a51fe7ac3b19236a5d2c95b0234" },
  providerSchema: { label: "kie-schema.11c.1", schemasSha256: "0e60fbd6cfc630ba69472862e59533f33e46818f90d1c4af7ffc582958c49672" },
  validatorRules: "11b.2-meaning-r7",
  approvedMeaningRegistry: "ai-meaning-registry.11b.1",
  bundles: {
    bundleSet: "11b.20",
    keys: { EXPLAIN_PATTERN: "ai.explain-pattern@11b.20", DRAFT_CARE_PREPARATION_SUMMARY: "ai.draft-care-preparation-summary@11b.20" },
    shellInputVersions: { EXPLAIN_PATTERN: "ai-shell-input.explain-pattern@11b.8", DRAFT_CARE_PREPARATION_SUMMARY: "ai-shell-input.draft-care-preparation-summary@11b.7" },
    shellOutputVersions: { EXPLAIN_PATTERN: "ai-shell.explain-pattern@11b.8", DRAFT_CARE_PREPARATION_SUMMARY: "ai-shell.draft-care-preparation-summary@11b.7" },
  },
  fixtureSet: { revision: "packet11-fixtures.11b.16", fullFixtureCount: 70 },
  // Packet 11C Addendum C (C5): eval.20, the conservative usage accounting (owner decision C5-b); the policy is unchanged.
  // CL3 re-freeze: the unchanged FULL utility thresholds of that policy are pinned too.
  harness: {
    label: "packet11-eval.20",
    fullEvaluationPolicy: "hybrid-full-policy.2",
    fullUtilityThresholds: {
      firstCallValid: { numerator: 69, denominator: 70, comparison: "AT_LEAST" },
      repairs: { numerator: 1, denominator: 70, comparison: "AT_MOST" },
      usefulAcceptedOutput: { numerator: 67, denominator: 70, comparison: "AT_LEAST" },
      withinProductionTimeout: { numerator: 67, denominator: 70, comparison: "AT_LEAST" },
    },
  },
  // Packet 11C Addendum C (C5, owner decision C5-a): the versioned local audit row and its audit-only outcome codes (never model-facing).
  audit: {
    schemaVersion: "ai-invocation-audit.11c.2",
    legacySchemaVersion: "ai-invocation-audit.11a.1",
    legacyOutcomeCodeCount: 23,
    // Packet 11C Addendum C (C3): + REMOTE_USE_NOT_ACCEPTED (a request that reached the remote decision without its own acceptance).
    // Packet 11C Addendum C (C6, brief item 5: "add audit-only if missing"; deliberate): + REMOTE_AI_DISABLED (the server-side remote-AI
    // switch is off). Audit-only: never a provider failure reason or model-facing (checked below on every captured body).
    auditOnlyOutcomeCodes: ["REMOTE_USE_DECLINED", "DISCLOSURE_CLOSED_MOOT", "REMOTE_USE_NOT_ACCEPTED", "NOT_ELIGIBLE", "SOURCE_UNAVAILABLE", "REQUEST_CLASS_NOT_QUALIFIED", "SPEND_CEILING_REACHED", "SPEND_NOT_CONFIGURED", "SPEND_LEDGER_UNAVAILABLE", "ORIGIN_REJECTED", "ACCESS_DENIED", "REMOTE_AI_DISABLED"],
    unsentOutcomeCodes: ["REMOTE_USE_DECLINED", "DISCLOSURE_CLOSED_MOOT", "REMOTE_USE_NOT_ACCEPTED", "NOT_ELIGIBLE", "SOURCE_UNAVAILABLE"],
    usageBases: ["NONE", "REPORTED", "UPPER_BOUND"],
    providerFailureReasonsUnchanged: ["MISSING_CONFIGURATION", "TRANSPORT_FAILED", "PROVIDER_TIMEOUT", "PROVIDER_REJECTED", "PROVIDER_RATE_LIMITED", "PROVIDER_FAILED", "OPERATIONAL_SPEND_LOCKED"],
  },
  // Packet 11C Addendum C (C5): the shared pre-send upper bound of one shell call (the former tracer estimateMaxUsd).
  callUpperBound: { peakUsdPerMillion: { inputCacheMiss: 0.3, output: 1.2 }, framingMarginTokens: 256, bodyOverheadMaxBytes: 8192 },
  // Packet 11C Addendum C, Task C4 (deliberate freeze change, for the CL3 re-freeze): deterministic previews stay on template/renderer
  // 11c.1 (byte-identical); AI-assisted replacements move to template/renderer 11c.2 with the hashed AI marking (the approved rows
  // ai.demoTag then ai.resultCheck). 11c.2 joins the notice templates. Never model-facing (checked below on every captured body).
  careSummary: {
    template: "care-summary-template.11c.1",
    renderer: "care-summary-renderer.11c.1",
    localePack: "care-summary-locale.11c.1",
    templatesWithDraftNotices: ["care-summary-template.11c.1", "care-summary-template.11c.2"],
    aiAssistedTemplate: "care-summary-template.11c.2",
    aiAssistedRenderer: "care-summary-renderer.11c.2",
    templatesWithAiMarking: ["care-summary-template.11c.2"],
    aiMarkingTextSha256: { "en-SG": "119705928ff2eac844db81bbf2eaa45e9f2bbbe8cd6488f4bab686ad02aee297", "zh-SG": "f2efac82ab2cffd171954a26fcdd9fd716133e6ab99daf5631fbea60b090c5b1" },
  },
  // Owner decision 2026-10-12 (deliberate): the disclosure says "AI" and names no provider, 11c.1 -> 11c.2. Not model-facing.
  disclosureCopy: { label: "ai-disclosure.11c.2", rowsSha256: "469d87ccabdffc952334193bc3de5b174985a855621b04cbd212acc2ef543177" },
  shellRoute: {
    path: "/api/ai/shell",
    providerKey: "deepseek",
    requestModelId: "deepseek-flash",
    responseModelSnapshot: "deepseek-flash",
    endpoint: "https://api.deepseek.com/responses",
    approvalScope: "HYBRID_SHELL_WORDING_ONLY",
    sendsTheEvaluatedClassBody: true,
  },
  sampling: { temperature: 0.2, maxOutputTokens: { EXPLAIN_PATTERN: 512, DRAFT_CARE_PREPARATION_SUMMARY: 1024 } },
  budgets: {
    tableSha256: "eda30d1340e7926ccf7d76ae5589def227c6bdd659ba1277067d727da22f855a",
    shellExecution: {
      EXPLAIN_PATTERN: { outputTokenCeiling: 350, maxAttempts: 2, structuralRepairAllowed: true, perCallTimeoutMs: 10_000, overallTimeoutMs: 18_000 },
      DRAFT_CARE_PREPARATION_SUMMARY: { outputTokenCeiling: 800, maxAttempts: 2, structuralRepairAllowed: true, perCallTimeoutMs: 18_000, overallTimeoutMs: 32_000 },
    },
  },
  // Packet 11C English activation (owner decisions Q and A, deliberate): was ai-activation.11a.1 with every task DETERMINISTIC_ONLY.
  activationManifest: {
    manifestVersion: "ai-activation.11c.1",
    profile: "HACKATHON_DEMO",
    tasks: {
      EXTRACT_CANDIDATE_FACTS: "DETERMINISTIC_ONLY",
      EXPLAIN_PATTERN: "SYNTHETIC_REMOTE_ENABLED",
      DRAFT_NEUTRAL_INQUIRY: "DETERMINISTIC_ONLY",
      ANSWER_BOUNDED_RECORD_QUERY: "DETERMINISTIC_ONLY",
      DRAFT_CARE_PREPARATION_SUMMARY: "SYNTHETIC_REMOTE_ENABLED",
      PHRASE_NON_CLINICAL_RESPONSE: "DETERMINISTIC_ONLY",
    },
  },
  // Packet 11C Addendum C (C1, owner decision C1): remote eligibility is restricted to QUALIFIED request classes. The immutable,
  // generated class definitions are bound to the contract digest (computed from the frozen sources above); the separate owner
  // qualification records ship ALL PENDING (no evidence, no sign-off). Never model-facing.
  // CL3 re-freeze (C1-review carry, deliberate): the contract inputs also bind each class's captured model-facing body sha256 and the
  // endpoint sha256, so the contract digest and every classId changed (was f2814202…, definitions 30836f5d…); the records were
  // regenerated, ALL PENDING. The qualification module is pinned outside its generated records literal.
  // r10 re-freeze (deliberate, includes the r9 refinement): shellRules is a contract input, so the contract digest and all 12 classIds
  // changed (was 5bec1f2a…, definitions d17c62cd…); no request byte, model-facing body, endpoint or prompt changed; records regenerated
  // with the existing generator, ALL PENDING with no evidence.
  // r11 validator-only step: shellRules is a contract input, so the contract digest and all 12 classIds changed again (was 30bb1549…,
  // definitions 6db8b350…); no request byte, model-facing body, endpoint or prompt changed; records regenerated with the existing
  // generator, ALL PENDING with no evidence. Batch 2 then bound the 11b.19 prompts, bodies and bundle keys (contract e415a265…). The 11b.20/r12
  // candidate binds the 11b.20 prompts, bodies and bundle keys and shell rules r12; regenerated with the same derivation, ALL PENDING with no
  // evidence or sign-off; owner approval pending.
  // Packet 11C English activation (owner decisions Q and A, 2026-10-12; deliberate): the owner signed off the six en-SG classes of this
  // contract (QUALIFIED; evidence: the English demo protocol record, a waiver of the manual review, not a completed human-review PASS);
  // the six zh-SG classes stay PENDING. Was: 12 PENDING, no evidence, no sign-off, outside-records sha256 d5531a2a…d17b, no admissible
  // task. The outside-records sha256 changed by doc comments only (the rule, schema and gate code are byte-identical). The contract
  // digest, the definitions digest and every classId are unchanged.
  requestClasses: {
    scheme: "ai-request-class.11c.1",
    remoteEligibilityPolicy: "ai-remote-eligibility.11c.1",
    contractDigest: "4fca780a686e4a5f7512fc928e3df8cdc7d74dd953427bcdaba3cd20885e39b1",
    definitionsSha256: "a80ec876018ac7018af8dc8cb9fdf5e8aaf5f2d0212ab79c217d0616dc7c6ade",
    contractBindings: { classBodies: 12, endpointSha256: "6a440b422e727dd307ca07f0f1df977bd3ac1d0d62917187225a12b9f5f306de", sourceBackedAndCareClassBodiesBound: true },
    classesPerTaskLocale: { "EXPLAIN_PATTERN en-SG": 3, "EXPLAIN_PATTERN zh-SG": 3, "DRAFT_CARE_PREPARATION_SUMMARY en-SG": 3, "DRAFT_CARE_PREPARATION_SUMMARY zh-SG": 3 },
    samples: 70,
    qualificationRecords: {
      count: 12,
      statuses: ["QUALIFIED", "PENDING"],
      withEvidence: 6,
      signedOff: 6,
      qualified: [
        { classId: "a00d8ad562619f605ca03fe406c18abe095410db4d6f53cca02f68601104910d", taskType: "EXPLAIN_PATTERN", locale: "en-SG" },
        { classId: "0c43de4a6cfb9eb6ec40c2ae13404c8f7664b127e864724452dbf0dc3f40a1f7", taskType: "EXPLAIN_PATTERN", locale: "en-SG" },
        { classId: "38ad0280e6382f4e3b314613b464bef0438ea6f6cc19cae2f41a10e0550e320d", taskType: "EXPLAIN_PATTERN", locale: "en-SG" },
        { classId: "5d0c75cef363c190e726f5cb055f4f9b6b265b76b7f8779b612467203ac6adca", taskType: "DRAFT_CARE_PREPARATION_SUMMARY", locale: "en-SG" },
        { classId: "37f7e95a9ff5436dbaab17b1bfefa57d132aaf7f407157c9d3cd2e3a39c9154f", taskType: "DRAFT_CARE_PREPARATION_SUMMARY", locale: "en-SG" },
        { classId: "8c3203f88db4567aa82a51d86967b845960f8f7f226591416c476c2ea670ec6b", taskType: "DRAFT_CARE_PREPARATION_SUMMARY", locale: "en-SG" },
      ],
      signOff: { evidenceRef: "internal-docs/superpowers/reviews/2026-10-12-11c-en-demo-protocol.md", signedOffBy: "JagaOn owner", signedOffAt: "2026-10-11T18:13:14Z" },
      pendingLocales: ["zh-SG"],
      pendingWithoutEvidenceOrSignOff: 6,
    },
    // Owner demo override (owner decision 2026-10-12: English AI care drafts beyond the tested shapes): the gate wrapper and its switch
    // were added outside the records literal; the records, definitions and contract are unchanged.
    qualificationModuleSha256OutsideRecords: "c39bd2b493e180af5eb6b34895abaaec371be4e39767096466a287045740f26e",
    shippedGateAdmissibleTasks: ["EXPLAIN_PATTERN", "DRAFT_CARE_PREPARATION_SUMMARY"],
  },
  // CL3 re-freeze (C3, owner decision C3; label introduced in RF): disclosure acceptance belongs to ONE explicit request (its decision
  // token) and ends when that request settles or its token aborts; a later request never inherits it; the interim default never accepts.
  remoteUseDisclosure: {
    policy: "ai-disclosure-policy.11c.2-per-request",
    behaviour: { duringAcceptedRequest: "ACCEPTED", afterThatRequestSettles: "NOT_ACCEPTED", laterRequestOnSameTokenWithoutDecision: "NOT_ACCEPTED", otherToken: "NOT_ACCEPTED", afterTokenAborts: "NOT_ACCEPTED", declined: "DECLINED", interimDefault: "NOT_ACCEPTED" },
    dialogCopyLabel: "ai-disclosure.11c.2",
    passcodeFieldRowsSha256: "3464497896470f9c7db7c8e0850c1ef8ec5591631f4006a26f56328d71996014",
  },
  // CL3 re-freeze (C6; label introduced in RF): names and order only, never a value.
  shellAccessSpend: {
    policy: "ai-shell-access-spend.11c.1",
    environmentVariableNames: ["JAGAON_REMOTE_AI", "JAGAON_AI_ALLOWED_ORIGINS", "JAGAON_AI_DEMO_PASSCODE", "JAGAON_AI_DAILY_SPEND_LIMIT_USD"],
    accessHeader: "x-jagaon-demo-passcode",
    refusalReasons: ["REQUEST_CLASS_NOT_QUALIFIED", "REMOTE_AI_DISABLED", "ORIGIN_REJECTED", "ACCESS_DENIED", "SPEND_NOT_CONFIGURED", "SPEND_CEILING_REACHED", "SPEND_LEDGER_UNAVAILABLE"],
    checkOrder: [
      "requestChecks: 400 FAILED PAYLOAD_INVALID",
      "remoteAiSwitch: 403 REFUSED REMOTE_AI_DISABLED",
      "originProtection: 403 REFUSED ORIGIN_REJECTED",
      "accessAuthorization: 403 REFUSED ACCESS_DENIED",
      "activation: 200 FAILED TASK_DISABLED",
      "requestClassQualification: 403 REFUSED REQUEST_CLASS_NOT_QUALIFIED",
      "spendReservation: 403 REFUSED SPEND_NOT_CONFIGURED",
      "credentialRead: 200 FAILED MISSING_CONFIGURATION",
      "providerCall",
    ],
    notSentMarker: { field: "notSentToProvider", value: true, preCallAnswersCarryingIt: 8, afterCallAnswerKeys: ["kind", "reason", "usage"] },
  },
  // CL3 re-freeze (C2): the private wording setting. The copy group moved 11c.1 -> 11c.2 by owner decisions U04/U05 (2026-10-09), then
  // 11c.2 -> 11c.3 by owner decision 2026-10-12 ("AI" replaces the provider name; not model-facing).
  privateWording: {
    preferenceRow: { key: "keepWordingOnDevice", schemaVersion: "app-preference.keep-wording.11c.1" },
    backupPayload: { format: "jagaon-backup-payload", schemaVersion: 2, previousSchemaVersion: 1 },
    migrations: [{ migrationId: "jagaon.backup.0001-patient-settings", from: 1, to: 2 }],
    copy: { label: "ai-wording-setting.11c.3", rowsSha256: "5568d1a5f085d4a9d28e17facd799880a2419d5a7126971539eff0862aeb78b3" },
  },
  // CL3 re-freeze (owner decision U12): the history fallback line after an attempted remote request.
  historyFallback: { copy: { label: "ai-history-fallback.11c.1", rowsSha256: "87a23aac11ad7e0560ce034542ea72559d2d0bcb8cb25c32678eab421a60cf17" } },
  runtimeBundles: { modelSnapshot: null, routeProfile: "deterministic-only.11a.1" },
  modelFacingBodies: {
    fixtures70: {
      current: "aa7064a24fe1a1eb95ba0ba62b54ce2990844f89d5b8d4aa292870f1b9d8e856",
      versionNormalisedToHistorical: "a77a79aa1c56b1530758147f12573051c4d786035f8926901bbbdaa19d3edd92",
      normalisedFields: 140,
    },
    sourceBackedExplainClasses: {
      current: { "en-SG": "43ad7c722c83131384b149356a161e95ed18653ffd4b6adfd03f3226fc85b1d8", "zh-SG": "dc0b943bb15015b184e91d8da1d62a8e0baee1c7bd1dc9e722a91667e8306790" },
      versionNormalisedToHistorical: { "en-SG": "c46ab171eac08602ea3d9e4913c447c7c71643e67971ce725a085ad08cfb2d7d", "zh-SG": "b9398514d6b931c94e8acfa78c7faf421606cc9cf2d6f80ee448eedee9e32855" },
    },
    careClasses: {
      "en-SG ordinary": "358bd7e9f19769e41ea9c093f89f274b985e9d99048aae5012bd46f15fa6e6ef",
      "en-SG hidden-limitation": "f1da1c2d28a87e474e7d141af7d0d8a42abc9b69b1ad68eba7554779dee6ea12",
      "zh-SG ordinary": "258e37da92488c0c38f844f92ada39a2db77ad542756ab6b6ae0e6e5b84fba93",
      "zh-SG hidden-limitation": "27ee20f0311a9a401282fb45e43271745fa1b983ec31a124fbffcf08b07e8328",
    },
  },
});
type FrozenItem = keyof typeof FROZEN;

// ---- Captured model-facing bodies (memoised; the real DeepSeek shell adapter with a recording fetcher that throws) ----------------
let bodies: Promise<{ fixtures: string[]; sourceBacked: Array<{ locale: AiLocale; body: string }>; care: Array<{ key: string; body: string }> }> | null = null;
function capturedBodies() {
  bodies ??= (async () => {
    const fixtures: string[] = [];
    for (const fixture of hybridFixturesForPhase("FULL")) {
      const { body } = await capture(fixture);
      if (body !== null) fixtures.push(body);
    }
    const sourceBacked: Array<{ locale: AiLocale; body: string }> = [];
    for (const locale of LOCALES) {
      for (const scenario of SOURCE_BACKED_SCENARIOS) {
        const { body } = await capture({ request: (await sourceBackedFixture(locale, scenario)).request, taskType: "EXPLAIN_PATTERN" });
        if (body === null) throw new Error(`no body for ${locale} ${scenario}`);
        sourceBacked.push({ locale, body });
      }
    }
    const care: Array<{ key: string; body: string }> = [];
    for (const locale of LOCALES) {
      for (const [shape, slug] of CARE_CLASSES) {
        const current = (await renderDeterministicCareSummary(syntheticCareDraft(shape, locale))).payload;
        const built = buildCareSummaryAiRequest({ current, requestId: "33333333-3333-4333-8333-333333333333", requestedAt: NOW });
        if (built.kind !== "READY") throw new Error(built.reason);
        const { body } = await capture({ request: built.request, taskType: "DRAFT_CARE_PREPARATION_SUMMARY" });
        if (body === null) throw new Error(`no body for ${locale} ${slug}`);
        care.push({ key: `${locale} ${slug}`, body });
      }
    }
    return { fixtures, sourceBacked, care };
  })();
  return bodies;
}
/** The one sha256 of a locale's source-backed bodies (all six scenarios are one value-blind class), or every distinct sha. */
const classSha = (entries: ReadonlyArray<{ locale: AiLocale; body: string }>, locale: AiLocale, map: (body: string) => string = (body) => body) => {
  const shas = [...new Set(entries.filter((entry) => entry.locale === locale).map((entry) => sha256(map(entry.body))))];
  return shas.length === 1 ? shas[0] : { MORE_THAN_ONE_CLASS: shas };
};

/** What `/api/ai/shell` sends upstream for an approved request (injected test manifest, fake fetcher that records and throws). */
async function routeTransmission() {
  const fixture = plannedFixture("p11.explain-pattern.en-sg.ordinary");
  const sent: Array<{ url: string; body: string }> = [];
  const handler = createAiShellHandler({
    // Packet 11C Addendum C (C6): plus the route's deployment configuration (TEST values only) and, below, a same-origin browser POST
    // with the demo passcode. Neither is part of the model-facing body (checked by the byte comparison).
    environment: { DEEPSEEK_API_KEY: SENTINEL, ...TEST_DEPLOYMENT_ENVIRONMENT },
    activationManifest: ENABLED,
    // Packet 11C Addendum C (C1): test-only QUALIFIED records, independent of the shipped records (pinned in `requestClasses`).
    requestClassGate: qualifiedTestRequestClassGate(),
    fetcher: async (url, init) => {
      sent.push({ url, body: String(init.body) });
      throw new Error("OFFLINE_CAPTURE_ONLY");
    },
  });
  const response = await handler(new Request(`http://localhost${AI_SHELL_ROUTE_PATH}`, { method: "POST", headers: { "content-type": "application/json", ...testBrowserHeaders() }, body: JSON.stringify(projectShellTaskRequest(fixture.plan)) }));
  const evaluated = (await capture(hybridFixturesForPhase("FULL").find((entry) => entry.id === "p11.explain-pattern.en-sg.ordinary")!)).body;
  return { status: response.status, sent, evaluated };
}

/**
 * A copy group without a runtime version constant: its label is the one beside its rows in both catalogues (exactly one), and its rows
 * are pinned as bytes (the sha256 of both locales' rows).
 */
function catalogueCopy(labelPrefix: string, rows: (messages: AppMessages) => unknown) {
  const pattern = new RegExp(`${labelPrefix.replace(/[.-]/g, "\\$&")}\\.11c\\.\\d+`, "g");
  const labels = [...new Set(LOCALES.flatMap((locale) => readFileSync(join(process.cwd(), `src/i18n/messages/${locale}.ts`), "utf8").match(pattern) ?? []))];
  return { label: labels.length === 1 ? labels[0] : { LABELS: labels }, rowsSha256: sha256(JSON.stringify(Object.fromEntries(LOCALES.map((locale) => [locale, rows(getMessages(locale))])))) };
}

/** C3: the per-request disclosure policy, read from its behaviour (createAiRemoteUseDecisions) and the interim default. */
async function disclosureBehaviour() {
  const decisions = createAiRemoteUseDecisions();
  const decide = (token: AbortSignal | undefined) => decisions.disclosure.decide(token ?? new AbortController().signal);
  const first = new AbortController();
  const duringAcceptedRequest = await decisions.run("ACCEPTED", first.signal, decide);
  const afterThatRequestSettles = await decide(first.signal);
  const laterRequestOnSameTokenWithoutDecision = await decisions.run(undefined, first.signal, decide);
  const second = new AbortController();
  const otherToken = await decisions.run("ACCEPTED", second.signal, () => decide(new AbortController().signal));
  const third = new AbortController();
  const afterTokenAborts = await decisions.run("ACCEPTED", third.signal, (token) => {
    third.abort();
    return decide(token);
  });
  const declined = await decisions.run("DECLINED", new AbortController().signal, decide);
  const interimDefault = await INTERIM_FAIL_CLOSED_DISCLOSURE.decide(new AbortController().signal);
  return { duringAcceptedRequest, afterThatRequestSettles, laterRequestOnSameTokenWithoutDecision, otherToken, afterTokenAborts, declined, interimDefault };
}

/**
 * C6: the route's check order, read by probing `/api/ai/shell` (fake fetcher; TEST deployment values only, never a deployment value):
 * every fault is set, the step that answers is recorded and its fault removed, until the provider call is reached. A swapped check
 * changes the recorded order. Also returns each answer, to read the not-sent marker.
 */
const ROUTE_FAULTS = ["requestChecks", "remoteAiSwitch", "originProtection", "accessAuthorization", "activation", "requestClassQualification", "spendReservation", "credentialRead"] as const;
type RouteFault = (typeof ROUTE_FAULTS)[number];
const ROUTE_STEP_OF: Readonly<Record<string, RouteFault>> = {
  "FAILED PAYLOAD_INVALID": "requestChecks",
  "REFUSED REMOTE_AI_DISABLED": "remoteAiSwitch",
  "REFUSED ORIGIN_REJECTED": "originProtection",
  "REFUSED ACCESS_DENIED": "accessAuthorization",
  "FAILED TASK_DISABLED": "activation",
  "FAILED PROFILE_NOT_PERMITTED": "activation",
  "REFUSED REQUEST_CLASS_NOT_QUALIFIED": "requestClassQualification",
  "REFUSED SPEND_NOT_CONFIGURED": "spendReservation",
  "FAILED MISSING_CONFIGURATION": "credentialRead",
};
let routeProbe: Promise<{ order: string[]; preCall: Array<Record<string, unknown>>; afterCall: Record<string, unknown> | null }> | null = null;
function probeRouteCheckOrder() {
  routeProbe ??= (async () => {
    const approved = projectShellTaskRequest(plannedFixture("p11.explain-pattern.en-sg.ordinary").plan);
    const remaining = new Set<RouteFault>(ROUTE_FAULTS);
    const order: string[] = [];
    const preCall: Array<Record<string, unknown>> = [];
    for (let probe = 0; probe <= ROUTE_FAULTS.length; probe += 1) {
      const has = (fault: RouteFault) => remaining.has(fault);
      const environment: Record<string, string> = { ...TEST_DEPLOYMENT_ENVIRONMENT };
      if (has("remoteAiSwitch")) delete environment[AI_SHELL_DEPLOYMENT_ENV.remoteAi];
      if (has("spendReservation")) delete environment[AI_SHELL_DEPLOYMENT_ENV.dailySpendLimitUsd];
      if (!has("credentialRead")) environment.DEEPSEEK_API_KEY = SENTINEL;
      const sent: string[] = [];
      const handler = createAiShellHandler({
        environment,
        // Packet 11C English activation: the shipped manifest and gate now admit this en-SG request, so the activation and class faults
        // are the pre-activation manifest (every task DETERMINISTIC_ONLY) and an all-PENDING gate over the shipped definitions.
        activationManifest: has("activation") ? DETERMINISTIC_ONLY_TEST_MANIFEST : ENABLED,
        requestClassGate: has("requestClassQualification") ? pendingTestRequestClassGate() : qualifiedTestRequestClassGate(),
        fetcher: async (url) => {
          sent.push(url);
          throw new Error("OFFLINE_CAPTURE_ONLY");
        },
      });
      const headers = { "content-type": "application/json", ...testBrowserHeaders(has("accessAuthorization") ? null : undefined), ...(has("originProtection") ? { Origin: "https://origin-not-allowed.invalid" } : {}) };
      const body = has("requestChecks") ? { ...approved, unexpectedField: true } : approved;
      const response = await handler(new Request(`http://localhost${AI_SHELL_ROUTE_PATH}`, { method: "POST", headers, body: JSON.stringify(body) }));
      const answer = (await response.json()) as Record<string, unknown>;
      if (sent.length > 0) {
        order.push("providerCall");
        return { order, preCall, afterCall: answer };
      }
      const step = ROUTE_STEP_OF[`${String(answer.kind)} ${String(answer.reason)}`];
      if (step === undefined || !remaining.has(step)) {
        order.push(`UNEXPECTED: ${response.status} ${String(answer.kind)} ${String(answer.reason)}`);
        break;
      }
      order.push(`${step}: ${response.status} ${String(answer.kind)} ${String(answer.reason)}`);
      preCall.push(answer);
      remaining.delete(step);
    }
    return { order, preCall, afterCall: null };
  })();
  return routeProbe;
}

/** How each frozen item is read from the code (every source that carries it). */
const ACTUAL: { readonly [K in FrozenItem]: () => unknown } = {
  slotPlan: () => agree({ SLOT_PLAN_VERSION, "AI_HYBRID_VERSIONS.slotPlan": AI_HYBRID_VERSIONS.slotPlan, "APPROVED_HYBRID_CONTRACT.slotPlanVersion": APPROVED_HYBRID_CONTRACT.slotPlanVersion }),
  atomRenderer: () => agree({ ATOM_RENDERER_VERSION, "AI_HYBRID_VERSIONS.atomRenderer": AI_HYBRID_VERSIONS.atomRenderer, "APPROVED_HYBRID_CONTRACT.atomRendererVersion": APPROVED_HYBRID_CONTRACT.atomRendererVersion }),
  languageCopy: () => agree({ AI_LANGUAGE_COPY_REVISION, "AI_HYBRID_VERSIONS.languageCopy": AI_HYBRID_VERSIONS.languageCopy, "APPROVED_HYBRID_CONTRACT.languageCopyRevision": APPROVED_HYBRID_CONTRACT.languageCopyRevision }),
  defaultShells: () => agree({ AI_DEFAULT_SHELLS_VERSION, "AI_HYBRID_VERSIONS.defaultShells": AI_HYBRID_VERSIONS.defaultShells, "APPROVED_HYBRID_CONTRACT.defaultShellVersion": APPROVED_HYBRID_CONTRACT.defaultShellVersion }),
  shellRules: () => agree({ SHELL_RULES_REVISION, "AI_HYBRID_VERSIONS.shellRules": AI_HYBRID_VERSIONS.shellRules, "APPROVED_HYBRID_CONTRACT.shellRulesRevision": APPROVED_HYBRID_CONTRACT.shellRulesRevision }),
  shellRequestProfile: () =>
    agree({
      SHELL_PROVIDER_REQUEST_VERSION,
      "AI_HYBRID_VERSIONS.shellRequest": AI_HYBRID_VERSIONS.shellRequest,
      "APPROVED_HYBRID_CONTRACT.shellRequestVersion": APPROVED_HYBRID_CONTRACT.shellRequestVersion,
      ...Object.fromEntries(SHELL_TASKS.map((task) => [`AI_HYBRID_RUNTIME_BUNDLES.${task}.shellRequestVersion`, AI_HYBRID_RUNTIME_BUNDLES[task].shellRequestVersion])),
    }),
  prompt: () => ({
    version: agree({
      PACKET_11_SHELL_PROMPT_VERSION,
      "AI_HYBRID_VERSIONS.prompt": AI_HYBRID_VERSIONS.prompt,
      "APPROVED_HYBRID_CONTRACT.promptVersion": APPROVED_HYBRID_CONTRACT.promptVersion,
      ...Object.fromEntries(SHELL_TASKS.map((task) => [`AI_HYBRID_RUNTIME_BUNDLES.${task}.promptTemplate.version`, AI_HYBRID_RUNTIME_BUNDLES[task].promptTemplate.version])),
      ...Object.fromEntries(SHELL_TASKS.flatMap((task) => LOCALES.map((locale) => [`PACKET_11_SHELL_PROMPTS.${task}.${locale}.version`, PACKET_11_SHELL_PROMPTS[task][locale].version]))),
    }),
    assetsSha256: sha256(JSON.stringify(SHELL_TASKS.flatMap((task) => LOCALES.map((locale) => PACKET_11_SHELL_PROMPTS[task][locale])))),
  }),
  providerSchema: () => ({
    label: agree({ SHELL_PROVIDER_SCHEMA_VERSION, "AI_HYBRID_VERSIONS.providerSchema": AI_HYBRID_VERSIONS.providerSchema, "APPROVED_HYBRID_CONTRACT.providerSchemaVersion": APPROVED_HYBRID_CONTRACT.providerSchemaVersion }),
    schemasSha256: sha256(JSON.stringify(SHELL_TASKS.flatMap((task) => LOCALES.map((locale) => ({ name: shellOutputSchemaName(task, locale), schema: shellOutputJsonSchema(task, locale) }))))),
  }),
  validatorRules: () => agree({ VALIDATOR_RULES_REVISION, "AI_HYBRID_VERSIONS.validatorRules": AI_HYBRID_VERSIONS.validatorRules, "APPROVED_HYBRID_CONTRACT.validatorRulesRevision": APPROVED_HYBRID_CONTRACT.validatorRulesRevision }),
  approvedMeaningRegistry: () => agree({ AI_MEANING_REGISTRY_REVISION, "APPROVED_HYBRID_CONTRACT.approvedMeaningRegistryRevision": APPROVED_HYBRID_CONTRACT.approvedMeaningRegistryRevision }),
  bundles: () => ({
    bundleSet: AI_HYBRID_BUNDLE_VERSION,
    keys: {
      EXPLAIN_PATTERN: agree({ bundle: AI_HYBRID_RUNTIME_BUNDLES.EXPLAIN_PATTERN.bundleKey, "APPROVED_HYBRID_CONTRACT.explainBundle": APPROVED_HYBRID_CONTRACT.explainBundle }),
      DRAFT_CARE_PREPARATION_SUMMARY: agree({ bundle: AI_HYBRID_RUNTIME_BUNDLES.DRAFT_CARE_PREPARATION_SUMMARY.bundleKey, "APPROVED_HYBRID_CONTRACT.careBundle": APPROVED_HYBRID_CONTRACT.careBundle }),
    },
    shellInputVersions: agree({ SHELL_INPUT_VERSIONS, "APPROVED_HYBRID_CONTRACT.shellInputVersions": APPROVED_HYBRID_CONTRACT.shellInputVersions, bundles: Object.fromEntries(SHELL_TASKS.map((task) => [task, AI_HYBRID_RUNTIME_BUNDLES[task].shellInputVersion])) }),
    shellOutputVersions: agree({ SHELL_OUTPUT_VERSIONS, "APPROVED_HYBRID_CONTRACT.shellSchemaVersions": APPROVED_HYBRID_CONTRACT.shellSchemaVersions, bundles: Object.fromEntries(SHELL_TASKS.map((task) => [task, AI_HYBRID_RUNTIME_BUNDLES[task].shellOutputVersion])) }),
  }),
  fixtureSet: () => ({
    revision: agree({ PACKET_11_HYBRID_FIXTURE_SET_REVISION, "AI_HYBRID_VERSIONS.fixtureSet": AI_HYBRID_VERSIONS.fixtureSet, "APPROVED_HYBRID_CONTRACT.fixtureSetRevision": APPROVED_HYBRID_CONTRACT.fixtureSetRevision }),
    fullFixtureCount: hybridFixturesForPhase("FULL").length,
  }),
  harness: () => ({
    label: agree({ AI_HYBRID_EVALUATION_REPORT_VERSION, "AI_HYBRID_VERSIONS.evaluationReport": AI_HYBRID_VERSIONS.evaluationReport, "APPROVED_HYBRID_CONTRACT.evaluationReportVersion": APPROVED_HYBRID_CONTRACT.evaluationReportVersion }),
    fullEvaluationPolicy: agree({ HYBRID_FULL_EVALUATION_POLICY, "APPROVED_HYBRID_CONTRACT.fullEvaluationPolicy": APPROVED_HYBRID_CONTRACT.fullEvaluationPolicy }),
    fullUtilityThresholds: JSON.parse(JSON.stringify(HYBRID_FULL_UTILITY_THRESHOLDS)) as unknown,
  }),
  audit: () => ({
    schemaVersion: AI_INVOCATION_AUDIT_SCHEMA_VERSION,
    legacySchemaVersion: AI_INVOCATION_AUDIT_LEGACY_SCHEMA_VERSION,
    legacyOutcomeCodeCount: agree({ "AI_INVOCATION_OUTCOME_CODES_11A.length": AI_INVOCATION_OUTCOME_CODES_11A.length, "1 + AI_REASON_CODES.length": 1 + AI_REASON_CODES.length }),
    auditOnlyOutcomeCodes: agree({ AI_AUDIT_ONLY_OUTCOME_CODES: [...AI_AUDIT_ONLY_OUTCOME_CODES], "AI_INVOCATION_OUTCOME_CODES minus the legacy codes": AI_INVOCATION_OUTCOME_CODES.slice(AI_INVOCATION_OUTCOME_CODES_11A.length) }),
    unsentOutcomeCodes: [...AI_AUDIT_UNSENT_OUTCOME_CODES],
    usageBases: [...AI_AUDIT_USAGE_BASES],
    providerFailureReasonsUnchanged: [...PROVIDER_FAILURE_REASONS],
  }),
  callUpperBound: () => ({
    peakUsdPerMillion: agree({ AI_SHELL_ROUTE_PEAK_USD_PER_MILLION, DEEPSEEK_FLASH_PEAK_USD_PER_MILLION }),
    framingMarginTokens: AI_SHELL_INPUT_FRAMING_MARGIN_TOKENS,
    bodyOverheadMaxBytes: AI_SHELL_PROVIDER_BODY_OVERHEAD_MAX_BYTES,
  }),
  careSummary: () => ({
    template: CARE_SUMMARY_TEMPLATE_VERSION,
    renderer: CARE_SUMMARY_RENDERER_VERSION,
    localePack: CARE_SUMMARY_LOCALE_PACK_VERSION,
    templatesWithDraftNotices: [...CARE_SUMMARY_TEMPLATES_WITH_DRAFT_NOTICES],
    aiAssistedTemplate: agree({ CARE_SUMMARY_AI_ASSISTED_TEMPLATE_VERSION, "CARE_SUMMARY_AI_MARKING_VERSIONS.templateVersion": CARE_SUMMARY_AI_MARKING_VERSIONS.templateVersion }),
    aiAssistedRenderer: agree({ CARE_SUMMARY_AI_ASSISTED_RENDERER_VERSION, "CARE_SUMMARY_AI_MARKING_VERSIONS.rendererVersion": CARE_SUMMARY_AI_MARKING_VERSIONS.rendererVersion }),
    templatesWithAiMarking: [...CARE_SUMMARY_TEMPLATES_WITH_AI_MARKING],
    aiMarkingTextSha256: Object.fromEntries(LOCALES.map((locale) => [locale, sha256(careSummaryAiMarkingText(locale))])),
  }),
  disclosureCopy: () => {
    // The disclosure has no runtime version constant: its version is the label beside the corrected row in both catalogues.
    const labels = [...new Set(["en-SG", "zh-SG"].flatMap((locale) => readFileSync(join(process.cwd(), `src/i18n/messages/${locale}.ts`), "utf8").match(/ai-disclosure\.11c\.\d+/g) ?? []))];
    const rows = Object.fromEntries(LOCALES.map((locale) => {
      const ai = getMessages(locale).ai;
      return [locale, { remoteTitle: ai.remoteTitle, remoteBody: ai.remoteBody, remoteLimit: ai.remoteLimit, cancel: ai.cancel, patternConfirm: ai.pattern.confirm, careConfirm: ai.careSummary.confirm }];
    }));
    return { label: labels.length === 1 ? labels[0] : { LABELS: labels }, rowsSha256: sha256(JSON.stringify(rows)) };
  },
  shellRoute: async () => {
    const { status, sent, evaluated } = await routeTransmission();
    const body = sent.length === 1 ? (JSON.parse(sent[0]!.body) as { model?: unknown }) : null;
    return {
      path: AI_SHELL_ROUTE_PATH,
      providerKey: agree({ "DEEPSEEK_RESPONSES_PROFILE.providerKey": DEEPSEEK_RESPONSES_PROFILE.providerKey, "APPROVED_HYBRID_CONTRACT.providerKey": APPROVED_HYBRID_CONTRACT.providerKey }),
      requestModelId: agree({ "route body model": body?.model ?? { status, transmissions: sent.length }, "APPROVED_HYBRID_CONTRACT.requestModelId": APPROVED_HYBRID_CONTRACT.requestModelId }),
      responseModelSnapshot: APPROVED_HYBRID_CONTRACT.responseModelSnapshot,
      endpoint: agree({ "route upstream url": sent[0]?.url ?? null, DEEPSEEK_RESPONSES_URL, "APPROVED_HYBRID_CONTRACT.endpoint": APPROVED_HYBRID_CONTRACT.endpoint }),
      approvalScope: APPROVED_HYBRID_CONTRACT.approvalScope,
      // The route sends exactly the body the evaluation captures for the same approved request (one shared request builder).
      sendsTheEvaluatedClassBody: sent.length === 1 && sent[0]!.body === evaluated,
    };
  },
  sampling: () => ({
    temperature: agree({ SHELL_TEMPERATURE, "APPROVED_HYBRID_CONTRACT.shellTemperature": APPROVED_HYBRID_CONTRACT.shellTemperature }),
    maxOutputTokens: agree({ SHELL_MAX_OUTPUT_TOKENS, "APPROVED_HYBRID_CONTRACT.shellMaxOutputTokens": APPROVED_HYBRID_CONTRACT.shellMaxOutputTokens, bundles: Object.fromEntries(SHELL_TASKS.map((task) => [task, AI_HYBRID_RUNTIME_BUNDLES[task].shellMaxOutputTokens])) }),
  }),
  budgets: () => ({
    // Every task's execution budget (legacy and hybrid bundles), the planner's fixed per-kind field budgets and schema limits.
    tableSha256: sha256(JSON.stringify({
      executionBudgets: Object.fromEntries(AI_TASK_TYPES.map((task) => [task, AI_TASK_RUNTIME_BUNDLES[task].executionBudget])),
      hybridExecutionBudgets: Object.fromEntries(SHELL_TASKS.map((task) => [task, AI_HYBRID_RUNTIME_BUNDLES[task].executionBudget])),
      fixedFieldBudgets: FIXED_FIELD_BUDGETS,
      fieldSchemaLimits: FIELD_SCHEMA_LIMITS,
      atomSpacingReserve: ATOM_SPACING_RESERVE,
    })),
    shellExecution: Object.fromEntries(SHELL_TASKS.map((task) => {
      const { outputTokenCeiling, maxAttempts, structuralRepairAllowed, perCallTimeoutMs, overallTimeoutMs } = AI_HYBRID_RUNTIME_BUNDLES[task].executionBudget;
      return [task, { outputTokenCeiling, maxAttempts, structuralRepairAllowed, perCallTimeoutMs, overallTimeoutMs }];
    })),
  }),
  activationManifest: () => ({
    manifestVersion: AI_ACTIVATION_MANIFEST.manifestVersion,
    profile: AI_ACTIVATION_MANIFEST.profile,
    // Every registered task, in registry order (a missing or extra task shows as a difference).
    tasks: Object.fromEntries([...AI_TASK_TYPES, ...Object.keys(AI_ACTIVATION_MANIFEST.tasks).filter((task) => !(AI_TASK_TYPES as readonly string[]).includes(task))].map((task) => [task, AI_ACTIVATION_MANIFEST.tasks[task as keyof typeof AI_ACTIVATION_MANIFEST.tasks] ?? "MISSING"])),
  }),
  requestClasses: async () => ({
    scheme: AI_REQUEST_CLASS_CONTRACT.scheme,
    remoteEligibilityPolicy: AI_REMOTE_ELIGIBILITY_POLICY_VERSION,
    contractDigest: agree({
      "AI_REQUEST_CLASS_CONTRACT.digest": AI_REQUEST_CLASS_CONTRACT.digest,
      "computed from AI_REQUEST_CLASS_CONTRACT.inputs": requestClassContractDigest(AI_REQUEST_CLASS_CONTRACT.inputs),
      "computed from the frozen sources": requestClassContractDigest(await requestClassContractInputsFromCode()),
      "every definition": [...new Set(AI_REQUEST_CLASS_DEFINITIONS.map((definition) => definition.contractDigest))].join(","),
      "every record": [...new Set(AI_REQUEST_CLASS_QUALIFICATION_RECORDS.map((record) => record.contractDigest))].join(","),
    }),
    definitionsSha256: sha256(canonicalizeJson(AI_REQUEST_CLASS_DEFINITIONS.map((definition) => ({ ...definition, sampleFixtureIds: [...definition.sampleFixtureIds] })))),
    contractBindings: await (async () => {
      const { sourceBacked, care } = await capturedBodies();
      const bound = new Set(Object.values(AI_REQUEST_CLASS_CONTRACT.inputs.modelFacingBodySha256));
      return {
        classBodies: agree({ "inputs.modelFacingBodySha256": Object.keys(AI_REQUEST_CLASS_CONTRACT.inputs.modelFacingBodySha256).length, definitions: AI_REQUEST_CLASS_DEFINITIONS.length }),
        endpointSha256: agree({ "inputs.endpointSha256": AI_REQUEST_CLASS_CONTRACT.inputs.endpointSha256, "sha256(DEEPSEEK_RESPONSES_URL)": sha256(DEEPSEEK_RESPONSES_URL) }),
        // The source-backed EXPLAIN and care class bodies the guards pin are among the bodies the contract binds.
        sourceBackedAndCareClassBodiesBound: [...sourceBacked.map((entry) => entry.body), ...care.map((entry) => entry.body)].every((body) => bound.has(sha256(body))),
      };
    })(),
    classesPerTaskLocale: Object.fromEntries(
      SHELL_TASKS.flatMap((task) => LOCALES.map((locale) => [`${task} ${locale}`, AI_REQUEST_CLASS_DEFINITIONS.filter((definition) => definition.taskType === task && definition.locale === locale).length])),
    ),
    samples: AI_REQUEST_CLASS_DEFINITIONS.reduce((total, definition) => total + definition.sampleFixtureIds.length, 0),
    qualificationRecords: {
      count: AI_REQUEST_CLASS_QUALIFICATION_RECORDS.length,
      statuses: [...new Set(AI_REQUEST_CLASS_QUALIFICATION_RECORDS.map((record) => record.status))],
      withEvidence: AI_REQUEST_CLASS_QUALIFICATION_RECORDS.filter((record) => record.evidenceRef !== null).length,
      signedOff: AI_REQUEST_CLASS_QUALIFICATION_RECORDS.filter((record) => record.signedOffBy !== null || record.signedOffAt !== null).length,
      qualified: AI_REQUEST_CLASS_QUALIFICATION_RECORDS.filter((record) => record.status === "QUALIFIED").map((record) => {
        const definition = AI_REQUEST_CLASS_DEFINITIONS.find((entry) => entry.classId === record.classId);
        return { classId: record.classId, taskType: definition?.taskType ?? "NO_DEFINITION", locale: definition?.locale ?? "NO_DEFINITION" };
      }),
      signOff: agree(
        Object.fromEntries(
          AI_REQUEST_CLASS_QUALIFICATION_RECORDS.filter((record) => record.status === "QUALIFIED").map((record) => [record.classId, { evidenceRef: record.evidenceRef, signedOffBy: record.signedOffBy, signedOffAt: record.signedOffAt }]),
        ),
      ),
      pendingLocales: [...new Set(AI_REQUEST_CLASS_QUALIFICATION_RECORDS.filter((record) => record.status === "PENDING").map((record) => AI_REQUEST_CLASS_DEFINITIONS.find((entry) => entry.classId === record.classId)?.locale ?? "NO_DEFINITION"))],
      pendingWithoutEvidenceOrSignOff: AI_REQUEST_CLASS_QUALIFICATION_RECORDS.filter((record) => record.status === "PENDING" && record.evidenceRef === null && record.signedOffBy === null && record.signedOffAt === null).length,
    },
    // C1-review carry: the rule, schema and gate, frozen independently of the regenerated records literal.
    qualificationModuleSha256OutsideRecords: sha256(splitQualificationModule(readFileSync(join(process.cwd(), "src/application/ai/request-class-qualification.ts"), "utf8")).outside),
    shippedGateAdmissibleTasks: SHELL_TASKS.filter((task) => SHIPPED_REQUEST_CLASS_GATE.anyAdmissible(task)),
  }),
  remoteUseDisclosure: async () => ({
    policy: AI_DISCLOSURE_POLICY_VERSION,
    behaviour: await disclosureBehaviour(),
    dialogCopyLabel: (ACTUAL.disclosureCopy() as { label: unknown }).label,
    passcodeFieldRowsSha256: sha256(JSON.stringify(Object.fromEntries(LOCALES.map((locale) => [locale, getMessages(locale).aiAccess])))),
  }),
  shellAccessSpend: async () => {
    const { order, preCall, afterCall } = await probeRouteCheckOrder();
    const markers = preCall.map((answer) => Object.keys(answer).filter((key) => key !== "kind" && key !== "reason"));
    const field = agree(Object.fromEntries(markers.map((keys, index) => [order[index]!, keys.join(",")])));
    return {
      policy: AI_SHELL_ACCESS_SPEND_POLICY_VERSION,
      environmentVariableNames: Object.values(AI_SHELL_DEPLOYMENT_ENV),
      accessHeader: AI_SHELL_ACCESS_HEADER,
      refusalReasons: [...AI_SHELL_ROUTE_REFUSAL_REASONS],
      checkOrder: order,
      notSentMarker: {
        field,
        value: agree(Object.fromEntries(preCall.map((answer, index) => [order[index]!, typeof field === "string" ? answer[field] : null]))),
        preCallAnswersCarryingIt: preCall.filter((answer) => typeof field === "string" && answer[field] === true).length,
        afterCallAnswerKeys: afterCall === null ? null : Object.keys(afterCall).sort(),
      },
    };
  },
  privateWording: () => ({
    preferenceRow: { key: KEEP_WORDING_PREFERENCE_KEY, schemaVersion: KEEP_WORDING_PREFERENCE_SCHEMA_VERSION },
    backupPayload: { format: BACKUP_PAYLOAD_FORMAT, schemaVersion: BACKUP_SCHEMA_VERSION, previousSchemaVersion: BACKUP_SCHEMA_VERSION_V1 },
    migrations: BACKUP_PAYLOAD_MIGRATIONS.map((migration) => ({ migrationId: migration.migrationId, from: migration.fromBackupSchemaVersion, to: migration.toBackupSchemaVersion })),
    copy: catalogueCopy("ai-wording-setting", (messages) => messages.aiWording),
  }),
  historyFallback: () => ({ copy: catalogueCopy("ai-history-fallback", (messages) => messages.aiHistoryFallback) }),
  runtimeBundles: () => ({
    modelSnapshot: agree(Object.fromEntries([...AI_TASK_TYPES.map((task) => [`legacy ${task}`, AI_TASK_RUNTIME_BUNDLES[task].modelSnapshot]), ...SHELL_TASKS.map((task) => [`hybrid ${task}`, AI_HYBRID_RUNTIME_BUNDLES[task].modelSnapshot])])),
    routeProfile: agree(Object.fromEntries([...AI_TASK_TYPES.map((task) => [`legacy ${task}`, AI_TASK_RUNTIME_BUNDLES[task].routeProfile]), ...SHELL_TASKS.map((task) => [`hybrid ${task}`, AI_HYBRID_RUNTIME_BUNDLES[task].routeProfile])])),
  }),
  modelFacingBodies: async () => {
    const { sourceBacked, care } = await capturedBodies();
    const normalised = await versionNormalisedFixtureDigest();
    return {
      fixtures70: { current: await existingFixtureDigest(), versionNormalisedToHistorical: normalised.digest, normalisedFields: normalised.occurrences },
      sourceBackedExplainClasses: {
        current: Object.fromEntries(LOCALES.map((locale) => [locale, classSha(sourceBacked, locale)])),
        versionNormalisedToHistorical: Object.fromEntries(LOCALES.map((locale) => [locale, classSha(sourceBacked, locale, (body) => normaliseSlotPlanVersion(normalise11b20Prompt(body)).body)])),
      },
      careClasses: Object.fromEntries(care.map((entry) => [entry.key, sha256(entry.body)])),
    };
  },
};

beforeAll(() => {
  Dexie.dependencies.indexedDB = fakeIndexedDB;
  Dexie.dependencies.IDBKeyRange = FDBKeyRange;
  vi.stubGlobal("fetch", () => {
    throw new Error("NETWORK_FORBIDDEN_IN_CONTRACT_FREEZE");
  });
});
afterAll(() => vi.unstubAllGlobals());

describe("Packet 11C frozen contract manifest (Addendum B, Task B5; offline)", () => {
  it.each(Object.keys(FROZEN) as FrozenItem[])("%s is frozen", async (name) => {
    expect(await ACTUAL[name](), failure(name)).toEqual(FROZEN[name]);
  }, 30_000);

  it("the manifest reads every frozen item from the code (no item without a reader)", () => {
    expect(Object.keys(ACTUAL).sort()).toEqual(Object.keys(FROZEN).sort());
  });

  it("a changed value fails with FROZEN_CONTRACT_CHANGED and the item's name; disagreeing sources are named", () => {
    expect(() => expect({ ...FROZEN.harness, label: "packet11-eval.19" }, failure("harness")).toEqual(FROZEN.harness)).toThrow(/FROZEN_CONTRACT_CHANGED: "harness"/);
    expect(agree({ code: "kie-schema.11c.1", contract: "kie-schema.11b.6" })).toEqual({ SOURCES_DISAGREE: { code: "kie-schema.11c.1", contract: "kie-schema.11b.6" } });
  });

  it("no version label of the contract is part of any model-facing body (70 fixtures, source-backed EXPLAIN classes, care classes)", async () => {
    const { fixtures, sourceBacked, care } = await capturedBodies();
    const all = [...fixtures, ...sourceBacked.map((entry) => entry.body), ...care.map((entry) => entry.body)];
    expect(all).toHaveLength(70 + SOURCE_BACKED_SCENARIOS.length * LOCALES.length + CARE_CLASSES.length * LOCALES.length);
    // The schema and harness labels (current and the superseded 11b.6 / eval.18), the fixture set and policy never reach a provider.
    // Packet 11C Addendum C (C5): nor the audit schema label, an audit-only outcome code or a usage basis.
    // Packet 11C Addendum C (C1): nor the request-class scheme, the eligibility policy, the contract digest or any class id.
    // Packet 11C Addendum C (C6): nor the passcode header, a deployment variable name or the route's not-sent marker.
    // CL3 re-freeze: nor the disclosure policy, the access/spend policy, the preference row, backup or migration ids, or the new copy groups.
    const labels = [SHELL_PROVIDER_SCHEMA_VERSION, AI_HYBRID_EVALUATION_REPORT_VERSION, "kie-schema", "packet11-eval", "packet11-fixtures", "hybrid-full-policy", "ai-activation", "care-summary-template", "ai-disclosure", "ai-invocation-audit", "usageBasis", "UPPER_BOUND", ...AI_AUDIT_ONLY_OUTCOME_CODES, "ai-request-class", "ai-remote-eligibility", AI_REQUEST_CLASS_CONTRACT.digest, ...AI_REQUEST_CLASS_DEFINITIONS.map((definition) => definition.classId), "x-jagaon-demo-passcode", "JAGAON_", "notSentToProvider", AI_DISCLOSURE_POLICY_VERSION, AI_SHELL_ACCESS_SPEND_POLICY_VERSION, KEEP_WORDING_PREFERENCE_SCHEMA_VERSION, "keepWordingOnDevice", "jagaon.backup", "jagaon-backup-payload", "ai-wording-setting", "ai-history-fallback"];
    expect(all.flatMap((body, index) => labels.filter((label) => body.includes(label)).map((label) => `${index}: ${label}`))).toEqual([]);
    // The slot-plan version is the only version echo each body carries twice (the documented version-only difference).
    expect(all.filter((body) => normaliseSlotPlanVersion(body).occurrences !== SLOT_PLAN_VERSION_OCCURRENCES_PER_BODY)).toEqual([]);
  }, 60_000);
});
