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
import { createAiShellHandler } from "@/app/api/ai/shell/ai-shell-handler";
import { TEST_DEPLOYMENT_ENVIRONMENT, testBrowserHeaders } from "@/app/api/ai/shell/ai-shell-route-test-support";
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
import { AI_REMOTE_ELIGIBILITY_POLICY_VERSION, AI_REQUEST_CLASS_QUALIFICATION_RECORDS } from "@/application/ai/request-class-qualification";
import { qualifiedTestRequestClassGate } from "@/application/ai/request-class-test-support";
import { canonicalizeJson } from "@/application/contracts/canonical-json";
import { requestClassContractDigest, requestClassContractInputsFromCode } from "./packet-11c-request-class-generator";
import { VALIDATOR_RULES_REVISION } from "./packet-11-evaluation";
import { AI_HYBRID_EVALUATION_REPORT_VERSION, APPROVED_HYBRID_CONTRACT, HYBRID_FULL_EVALUATION_POLICY } from "./packet-11-hybrid-evaluation";
import { hybridFixturesForPhase, PACKET_11_HYBRID_FIXTURE_SET_REVISION } from "./packet-11-hybrid-fixtures";
import { plannedFixture } from "./packet-11-hybrid-test-support";
import { capture, existingFixtureDigest, versionNormalisedFixtureDigest } from "./packet-11-presentation-guard.test";
import { normaliseSlotPlanVersion, SLOT_PLAN_VERSION_OCCURRENCES_PER_BODY } from "./packet-11-slot-plan-version-normalisation";
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
 * - the shipped activation manifest (every task DETERMINISTIC_ONLY);
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

/** The frozen contract, as literals. */
const FROZEN = Object.freeze({
  slotPlan: "ai-slot-plan.11b.9",
  atomRenderer: "ai-atoms.11b.7",
  languageCopy: "ai-language-copy.11b.10",
  defaultShells: "ai-shells-default.11b.8",
  shellRules: "ai-shell-rules.11b.15-r8",
  shellRequestProfile: "ai-shell-request.11b.11",
  prompt: { version: "11b.18", assetsSha256: "e6e1160cc8796109c3fb974db97a9d9562d2ee888be1ba071744a8de1bf07c9b" },
  providerSchema: { label: "kie-schema.11c.1", schemasSha256: "0e60fbd6cfc630ba69472862e59533f33e46818f90d1c4af7ffc582958c49672" },
  validatorRules: "11b.2-meaning-r7",
  approvedMeaningRegistry: "ai-meaning-registry.11b.1",
  bundles: {
    bundleSet: "11b.18",
    keys: { EXPLAIN_PATTERN: "ai.explain-pattern@11b.18", DRAFT_CARE_PREPARATION_SUMMARY: "ai.draft-care-preparation-summary@11b.18" },
    shellInputVersions: { EXPLAIN_PATTERN: "ai-shell-input.explain-pattern@11b.8", DRAFT_CARE_PREPARATION_SUMMARY: "ai-shell-input.draft-care-preparation-summary@11b.7" },
    shellOutputVersions: { EXPLAIN_PATTERN: "ai-shell.explain-pattern@11b.8", DRAFT_CARE_PREPARATION_SUMMARY: "ai-shell.draft-care-preparation-summary@11b.7" },
  },
  fixtureSet: { revision: "packet11-fixtures.11b.16", fullFixtureCount: 70 },
  // Packet 11C Addendum C (C5): eval.20, the conservative usage accounting (owner decision C5-b); the policy is unchanged.
  harness: { label: "packet11-eval.20", fullEvaluationPolicy: "hybrid-full-policy.2" },
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
  disclosureCopy: { label: "ai-disclosure.11c.1", rowsSha256: "aa65470dd59aa8122f81e7e77dcb105c9724b6541696eb9b23af9d3c84300df1" },
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
  activationManifest: { manifestVersion: "ai-activation.11a.1", profile: "HACKATHON_DEMO", everyTask: "DETERMINISTIC_ONLY" },
  // Packet 11C Addendum C (C1, owner decision C1): remote eligibility is restricted to QUALIFIED request classes. The immutable,
  // generated class definitions are bound to the contract digest (computed from the frozen sources above); the separate owner
  // qualification records ship ALL PENDING (no evidence, no sign-off). Never model-facing.
  requestClasses: {
    scheme: "ai-request-class.11c.1",
    remoteEligibilityPolicy: "ai-remote-eligibility.11c.1",
    contractDigest: "f28142029e09578a84b5bf14ca69b5b49e9d92b874866bc9794471ee57b5d39b",
    definitionsSha256: "30836f5da23fce91fc3947a80fcfe185eeb4976e02f323784a915ae4ae2dcf18",
    classesPerTaskLocale: { "EXPLAIN_PATTERN en-SG": 3, "EXPLAIN_PATTERN zh-SG": 3, "DRAFT_CARE_PREPARATION_SUMMARY en-SG": 3, "DRAFT_CARE_PREPARATION_SUMMARY zh-SG": 3 },
    samples: 70,
    qualificationRecords: { count: 12, statuses: ["PENDING"], withEvidence: 0, signedOff: 0 },
  },
  runtimeBundles: { modelSnapshot: null, routeProfile: "deterministic-only.11a.1" },
  modelFacingBodies: {
    fixtures70: {
      current: "5e7c96959d1d60b441abc54e7384cc0cb30dc33594ba9603f4e64c16de423ff8",
      versionNormalisedToHistorical: "a77a79aa1c56b1530758147f12573051c4d786035f8926901bbbdaa19d3edd92",
      normalisedFields: 140,
    },
    sourceBackedExplainClasses: {
      current: { "en-SG": "1756934e47137b7434d3499c6952f30adf6056161fc5f6523c53ec526f22a13b", "zh-SG": "63f161dcddc2195bec407c79aec6abf4a5edb3f73db2f37b0df51ea382c136ae" },
      versionNormalisedToHistorical: { "en-SG": "c46ab171eac08602ea3d9e4913c447c7c71643e67971ce725a085ad08cfb2d7d", "zh-SG": "b9398514d6b931c94e8acfa78c7faf421606cc9cf2d6f80ee448eedee9e32855" },
    },
    careClasses: {
      "en-SG ordinary": "e5d0f9fab5493efd23154fcc52b9361fcaea581e7dd551415a1047bcbe2f1044",
      "en-SG hidden-limitation": "2e775b9a049c17f49796567da14c32aee265e3e6106efdd189df2d3d0f504716",
      "zh-SG ordinary": "99eb6c946b5aca943e92afbcf674fe7ca12c1d9de13017c55dd97570536f4f17",
      "zh-SG hidden-limitation": "c44369ac4759bd7baf0d8df1cfd15f94cfeb227c526e78d970b310bb6629afdb",
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
    // Packet 11C Addendum C (C1): test-only QUALIFIED records (the shipped records are all PENDING; pinned in `requestClasses`).
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
    everyTask: agree({ ...AI_ACTIVATION_MANIFEST.tasks, taskCount: Object.keys(AI_ACTIVATION_MANIFEST.tasks).length === AI_TASK_TYPES.length ? "DETERMINISTIC_ONLY" : Object.keys(AI_ACTIVATION_MANIFEST.tasks) }),
  }),
  requestClasses: () => ({
    scheme: AI_REQUEST_CLASS_CONTRACT.scheme,
    remoteEligibilityPolicy: AI_REMOTE_ELIGIBILITY_POLICY_VERSION,
    contractDigest: agree({
      "AI_REQUEST_CLASS_CONTRACT.digest": AI_REQUEST_CLASS_CONTRACT.digest,
      "computed from AI_REQUEST_CLASS_CONTRACT.inputs": requestClassContractDigest(AI_REQUEST_CLASS_CONTRACT.inputs),
      "computed from the frozen sources": requestClassContractDigest(requestClassContractInputsFromCode()),
      "every definition": [...new Set(AI_REQUEST_CLASS_DEFINITIONS.map((definition) => definition.contractDigest))].join(","),
      "every record": [...new Set(AI_REQUEST_CLASS_QUALIFICATION_RECORDS.map((record) => record.contractDigest))].join(","),
    }),
    definitionsSha256: sha256(canonicalizeJson(AI_REQUEST_CLASS_DEFINITIONS.map((definition) => ({ ...definition, sampleFixtureIds: [...definition.sampleFixtureIds] })))),
    classesPerTaskLocale: Object.fromEntries(
      SHELL_TASKS.flatMap((task) => LOCALES.map((locale) => [`${task} ${locale}`, AI_REQUEST_CLASS_DEFINITIONS.filter((definition) => definition.taskType === task && definition.locale === locale).length])),
    ),
    samples: AI_REQUEST_CLASS_DEFINITIONS.reduce((total, definition) => total + definition.sampleFixtureIds.length, 0),
    qualificationRecords: {
      count: AI_REQUEST_CLASS_QUALIFICATION_RECORDS.length,
      statuses: [...new Set(AI_REQUEST_CLASS_QUALIFICATION_RECORDS.map((record) => record.status))],
      withEvidence: AI_REQUEST_CLASS_QUALIFICATION_RECORDS.filter((record) => record.evidenceRef !== null).length,
      signedOff: AI_REQUEST_CLASS_QUALIFICATION_RECORDS.filter((record) => record.signedOffBy !== null || record.signedOffAt !== null).length,
    },
  }),
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
        versionNormalisedToHistorical: Object.fromEntries(LOCALES.map((locale) => [locale, classSha(sourceBacked, locale, (body) => normaliseSlotPlanVersion(body).body)])),
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
    const labels = [SHELL_PROVIDER_SCHEMA_VERSION, AI_HYBRID_EVALUATION_REPORT_VERSION, "kie-schema", "packet11-eval", "packet11-fixtures", "hybrid-full-policy", "ai-activation", "care-summary-template", "ai-disclosure", "ai-invocation-audit", "usageBasis", "UPPER_BOUND", ...AI_AUDIT_ONLY_OUTCOME_CODES, "ai-request-class", "ai-remote-eligibility", AI_REQUEST_CLASS_CONTRACT.digest, ...AI_REQUEST_CLASS_DEFINITIONS.map((definition) => definition.classId), "x-jagaon-demo-passcode", "JAGAON_", "notSentToProvider"];
    expect(all.flatMap((body, index) => labels.filter((label) => body.includes(label)).map((label) => `${index}: ${label}`))).toEqual([]);
    // The slot-plan version is the only version echo each body carries twice (the documented version-only difference).
    expect(all.filter((body) => normaliseSlotPlanVersion(body).occurrences !== SLOT_PLAN_VERSION_OCCURRENCES_PER_BODY)).toEqual([]);
  }, 60_000);
});
