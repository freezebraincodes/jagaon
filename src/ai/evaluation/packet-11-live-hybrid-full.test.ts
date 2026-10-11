// @vitest-environment node
import { createHash } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEEPSEEK_DOCUMENTED_MODELS, DEEPSEEK_RESPONSES_URL, deepSeekCostMicroUsd, readDeepSeekToken } from "@/ai/deepseek/deepseek-catalogue";
import { createDeepSeekShellResponsesProvider } from "@/ai/deepseek/deepseek-responses-provider";
import type { KieProviderDiagnostic } from "@/ai/kie/kie-responses-provider";
import { selectEvaluationCandidates } from "@/ai/kie/kie-route-config";
import { AI_HYBRID_RUNTIME_BUNDLES, AI_HYBRID_VERSIONS } from "@/application/ai/ai-hybrid-runtime-bundles";
import type { AiShellProviderPort } from "@/application/ai/ai-provider-port";
import { defaultShells } from "@/application/ai/language/default-shells";
import { projectShellTaskRequest } from "@/application/ai/language/shell-projector";
import { planSlots } from "@/application/ai/language/slot-planner";
import { SHELL_MAX_OUTPUT_TOKENS, SHELL_TEMPERATURE, type AiReasonCode, type ShellTask, type ShellTexts } from "@/domain/ai";
import { AI_HYBRID_EVALUATION_REPORT_VERSION, APPROVED_HYBRID_CONTRACT, evaluateHybridModelSnapshot, HUMAN_REVIEW_SAMPLE_PER_LOCALE, HYBRID_FULL_EVALUATION_POLICY, hybridLiveRunVerdict, type HumanReviewRecord, type HybridEvaluationReport } from "./packet-11-hybrid-evaluation";
import type { AiEvaluationFixture } from "./packet-11-fixtures";
import { hybridFixturesForPhase, PACKET_11_HYBRID_FIXTURE_SET_REVISION, PACKET_11_HYBRID_FIXTURES } from "./packet-11-hybrid-fixtures";
import { buildHybridHumanReview, writeHybridHumanReview, type HumanReviewEntry, type HybridHumanReviewArtifact } from "./packet-11-hybrid-human-review";
import {
  captureShellRequestBody,
  checkHybridShellRequestBody,
  createHybridDiagnosticTracer,
  estimateMaxUsd,
  expectedShellInputText,
  mapTracedCallsToFixtures,
  minimumFullRunCeilingUsd,
  shellInputClassHash,
  verifyTraceHashes,
  verifyTraceRedaction,
  type HybridDiagnosticTracer,
} from "./packet-11-hybrid-live-diagnostic";
import { shellCandidate } from "./packet-11-hybrid-test-support";

/**
 * Evaluation-only FULL hybrid qualification runner (owner Option A, 2026-10-06). The offline part always runs with fake
 * fetchers only (no network, key or spend). The live part is skipped unless RUN_LIVE_HYBRID_SHELL_FULL=1 and is refused
 * before any request unless HYBRID_FULL_PROVIDER=deepseek, HYBRID_FULL_MODEL=deepseek-flash,
 * HYBRID_FULL_CONFIRM_MAX_CALLS=140, HYBRID_FULL_RAW_TRACE=1, HYBRID_FULL_MAX_USD is a positive number at least the
 * computed one-call-each minimum (both minima are printed; below the all-repairs minimum only warns), DEEPSEEK_API_KEY is
 * configured, no NEXT_PUBLIC_* credential name exists, the frozen r8 contract below equals the code and the approved
 * contract, the 70 fixtures are exactly hybridFixturesForPhase("FULL") in order, and every exact request body passes the
 * offline value-blindness preflight. It then runs the frozen harness (phase FULL, all 70 fixtures, at most 140 calls,
 * structural repair allowed, spend ceiling HYBRID_FULL_MAX_USD) with the direct DeepSeek shell provider through the
 * repair-capable tracer (pre-send class binding, at most two transmissions per fixture class member, hard pre-send spend
 * ceiling). Production timeouts unchanged. Prints only closed codes, counts, versions, timings, spend and paths, never
 * model text; the final user-visible wording goes only into the private human-review page.
 * packet11-eval.13 (FULL policy hybrid-full-policy.1, owner instruction 2026-10-07, offline): the contract literal adds the
 * harness eval.13 and fullEvaluationPolicy, re-checked by runTracedFull itself before the tracer exists (a mismatch is refused
 * before any call). The harness records a shell-gate (S1–S7b) or assembler (S9) rejection as a SAFE_SHELL_FALLBACK and the run
 * continues; every other stop of the existing chain (S10 breach, deterministic r7 failure, retention, model identity, provider
 * behaviour incl. tracer refusals) still ends the run. The review page lists accepted AI outputs and the deterministic fallbacks
 * shown, the latter with closed gate/reason codes only.
 */

const FULL_MAX_CALLS = 140;
const FULL_FIXTURE_COUNT = 70;
const SENTINEL = "ds-SENTINEL-CREDENTIAL-f011c4a7e2";
const NOW = () => "2026-10-06T10:00:00.000Z";
// The frozen contract (the same literals as the smoke, targeted and diagnostic runners; the whole Packet 11C contract is pinned in
// packet-11c-contract-freeze.test.ts). CURRENT (11b.20/r12 offline candidate; owner re-freeze pending): prompt 11b.20, rules 11b.18-r12, request 11b.11,
// bundle set 11b.20, provider schema kie-schema.11c.1, slot plan ai-slot-plan.11b.9, fixtures 11b.16, harness packet11-eval.20, policy
// hybrid-full-policy.2, caps 512/1024, temperature 0.2. Revision history follows (each line was the contract at its time).
// Rules r8 (packet11-eval.14, offline only): rules 11b.15-r8, bundle set
// 11b.15, fixtures 11b.13 and harness eval.14; the policy, prompt, request, caps and temperature are unchanged. The live block is not run.
// zh EXPLAIN guidance (packet11-eval.15, owner instruction 2026-10-07, offline only): prompt 11b.16 (one new paragraph in the zh-SG EXPLAIN
// asset only), bundle set 11b.16, fixtures 11b.14 and harness eval.15; rules r8, the policy, request, caps and temperature are unchanged.
// The live block is not run.
// en EXPLAIN guidance (packet11-eval.16, owner instruction 2026-10-07, offline only): prompt 11b.17 (the English counterpart, one new
// paragraph in the en-SG EXPLAIN asset only), bundle set 11b.17, fixtures 11b.15, harness eval.16; everything else is unchanged.
// The live block is not run.
// Observation ownership (packet11-eval.17, owner instruction 2026-10-07, offline only): prompt 11b.18, kie-schema.11b.6,
// ai-slot-plan.11b.8, bundle set 11b.18, fixtures 11b.16, harness eval.17 (the model writes the EXPLAIN headline and evidence; the
// application composes the observation); rules r8, the policy, request, caps and temperature are unchanged. The live block is not run.
// Structural first-call validity (packet11-eval.18, owner decision 2026-10-07, offline only): harness eval.18 and policy
// hybrid-full-policy.2; every request-side pin unchanged. The live block is not run.
// Packet 11C phase 2 (option (a), 2026-10-08, offline only): slot plan ai-slot-plan.11b.9 (bodies differ only in the slot-plan version
// echo); still harness eval.18 and kie-schema.11b.6. The live block is not run.
// Packet 11C B5 contract freeze (offline only): labels only, kie-schema.11c.1 and packet11-eval.19 (no model-facing byte changes). The live
// block is not run; any live run needs the owner's separate, explicit authorization.
// Packet 11C Addendum C, C5 (offline only): harness packet11-eval.20 (the conservative usage accounting; owner decision C5-b). Policy,
// thresholds and every model-facing byte are unchanged. The live block is not run.
const REQUIRED_CONTRACT = Object.freeze({
  prompt: "11b.20",
  shellRules: "ai-shell-rules.11b.18-r12",
  shellRequest: "ai-shell-request.11b.11",
  explainBundle: "ai.explain-pattern@11b.20",
  careBundle: "ai.draft-care-preparation-summary@11b.20",
  providerSchema: "kie-schema.11c.1",
  // Packet 11C phase 2 (option (a), 2026-10-08, offline): eligibility accounting only; request bodies differ only in this version field.
  slotPlan: "ai-slot-plan.11b.9",
  fixtureSet: "packet11-fixtures.11b.16",
  harness: "packet11-eval.20",
  fullEvaluationPolicy: "hybrid-full-policy.2",
  maxOutputTokens: { EXPLAIN_PATTERN: 512, DRAFT_CARE_PREPARATION_SUMMARY: 1024 },
  temperature: 0.2,
});
/**
 * The exact minimum ceilings for the 70 frozen request bodies (offline, printed by the live runner). Prompt 11b.16: the zh-SG EXPLAIN
 * bodies carry the new guidance paragraph, so the recomputed minimums rise (0.20589 / 0.41178 under prompt 11b.15). Prompt 11b.17:
 * the en-SG EXPLAIN bodies carry the English paragraph too (0.210163 / 0.420326 under prompt 11b.16).
 * Observation ownership (prompt 11b.18, @11b.8): the EXPLAIN bodies no longer carry the observation field, its slots or glosses and
 * the EXPLAIN prompts are shorter, so the minimums fall (0.214618 / 0.429236 under prompt 11b.17).
 */
// 11b.20 exact-body upper bounds at the unchanged recorded catalogue rates (11b.19: 0.214763 / 0.429526); not a live spend authorization.
const MINIMUM_ONE_CALL_EACH_USD = 0.216864;
const MINIMUM_WITH_ALL_REPAIRS_USD = 0.433728;

const createdDirectories = new Set<string>();
const createdFiles = new Set<string>();
afterAll(() => {
  for (const directory of createdDirectories) rmSync(directory, { recursive: true, force: true });
  for (const file of createdFiles) rmSync(file, { force: true });
});

function deepSeekFlash() {
  const selection = selectEvaluationCandidates({ requested: "deepseek-flash", listing: [], documented: DEEPSEEK_DOCUMENTED_MODELS, now: NOW });
  if (selection.kind !== "SELECTED" || selection.candidates.length !== 1) throw new Error("DEEPSEEK_FLASH_NOT_SELECTABLE");
  return selection.candidates[0]!;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function codeContract() {
  return {
    prompt: AI_HYBRID_VERSIONS.prompt,
    shellRules: AI_HYBRID_VERSIONS.shellRules,
    shellRequest: AI_HYBRID_VERSIONS.shellRequest,
    explainBundle: AI_HYBRID_RUNTIME_BUNDLES.EXPLAIN_PATTERN.bundleKey,
    careBundle: AI_HYBRID_RUNTIME_BUNDLES.DRAFT_CARE_PREPARATION_SUMMARY.bundleKey,
    providerSchema: AI_HYBRID_VERSIONS.providerSchema,
    slotPlan: AI_HYBRID_VERSIONS.slotPlan,
    fixtureSet: PACKET_11_HYBRID_FIXTURE_SET_REVISION,
    harness: AI_HYBRID_EVALUATION_REPORT_VERSION,
    fullEvaluationPolicy: HYBRID_FULL_EVALUATION_POLICY,
    maxOutputTokens: SHELL_MAX_OUTPUT_TOKENS,
    temperature: SHELL_TEMPERATURE,
  };
}
type FrozenContract = Readonly<Record<keyof typeof REQUIRED_CONTRACT, unknown>>;
type ApprovedContract = Readonly<Record<keyof typeof APPROVED_HYBRID_CONTRACT, unknown>>;
/** Every contract key that differs from the frozen literal or from the approved hybrid contract (both injectable for the offline refusal test). */
function contractMismatches(required: FrozenContract = REQUIRED_CONTRACT, approvedContract: ApprovedContract = APPROVED_HYBRID_CONTRACT): string[] {
  const contract = codeContract();
  const literal = (Object.keys(REQUIRED_CONTRACT) as Array<keyof typeof REQUIRED_CONTRACT>).filter((key) => !same(contract[key], required[key]));
  const approved = ([["promptVersion", contract.prompt], ["shellRulesRevision", contract.shellRules], ["shellRequestVersion", contract.shellRequest], ["explainBundle", contract.explainBundle], ["careBundle", contract.careBundle], ["providerSchemaVersion", contract.providerSchema], ["slotPlanVersion", contract.slotPlan], ["fixtureSetRevision", contract.fixtureSet], ["evaluationReportVersion", contract.harness], ["fullEvaluationPolicy", contract.fullEvaluationPolicy], ["shellMaxOutputTokens", contract.maxOutputTokens], ["shellTemperature", contract.temperature], ["requestModelId", "deepseek-flash"], ["responseModelSnapshot", "deepseek-flash"], ["providerKey", "deepseek"], ["endpoint", DEEPSEEK_RESPONSES_URL], ["approvalScope", "HYBRID_SHELL_WORDING_ONLY"]] as const).filter(([key, value]) => !same(approvedContract[key], value)).map(([key]) => key);
  return [...literal, ...approved];
}

/** The live gate (pure; closed codes). Refusals stop the run before any request; warnings are printed only. */
function liveGateRefusals(environment: Readonly<Record<string, string | undefined>>, minimum: Readonly<{ oneCallEach: number; withAllRepairs: number }>): { refusals: string[]; warnings: string[]; maxUsd: number | null } {
  const refusals: string[] = [];
  const warnings: string[] = [];
  if (environment.HYBRID_FULL_PROVIDER !== "deepseek") refusals.push("HYBRID_FULL_PROVIDER");
  if (environment.HYBRID_FULL_MODEL !== "deepseek-flash") refusals.push("HYBRID_FULL_MODEL");
  if (environment.HYBRID_FULL_CONFIRM_MAX_CALLS !== String(FULL_MAX_CALLS)) refusals.push("HYBRID_FULL_CONFIRM_MAX_CALLS");
  if (environment.HYBRID_FULL_RAW_TRACE !== "1") refusals.push("HYBRID_FULL_RAW_TRACE");
  const raw = environment.HYBRID_FULL_MAX_USD;
  const maxUsd = raw !== undefined && /^\d+(?:\.\d+)?$/.test(raw.trim()) ? Number(raw) : Number.NaN;
  if (!Number.isFinite(maxUsd) || maxUsd <= 0) refusals.push("HYBRID_FULL_MAX_USD");
  else if (maxUsd < minimum.oneCallEach) refusals.push("HYBRID_FULL_MAX_USD_BELOW_ONE_CALL_EACH_MINIMUM");
  else if (maxUsd < minimum.withAllRepairs) warnings.push("HYBRID_FULL_MAX_USD_BELOW_ALL_REPAIRS_MINIMUM");
  if (readDeepSeekToken(environment).kind !== "CONFIGURED") refusals.push("DEEPSEEK_API_KEY");
  if (Object.keys(environment).some((name) => name.startsWith("NEXT_PUBLIC_") && /KEY|TOKEN|SECRET/i.test(name))) refusals.push("PUBLIC_CREDENTIAL_NAME_PRESENT");
  return { refusals, warnings, maxUsd: refusals.length === 0 ? maxUsd : null };
}

/** The exact body the shared adapter would send, captured locally (independent of the module's own capture). */
async function captureBodyLocally(fixture: AiEvaluationFixture): Promise<string> {
  const planned = planSlots(fixture.request, AI_HYBRID_RUNTIME_BUNDLES[fixture.taskType as ShellTask]);
  if (planned.kind !== "PLANNED") throw new Error("UNPLANNABLE");
  let body: string | null = null;
  const provider = createDeepSeekShellResponsesProvider({ token: SENTINEL, model: deepSeekFlash(), fetcher: async (_url, init) => {
    body = String(init.body);
    throw new Error("OFFLINE_CAPTURE_ONLY");
  } });
  await provider.invoke(projectShellTaskRequest(planned.plan), new AbortController().signal);
  if (body === null) throw new Error("NO_BODY_CAPTURED");
  return body;
}
async function preflightFull(fixtures: readonly AiEvaluationFixture[], model: string) {
  const items = [];
  for (const fixture of fixtures) {
    const body = await captureShellRequestBody(fixture);
    const check = body === null ? null : checkHybridShellRequestBody(fixture, body, model);
    items.push({ fixtureId: fixture.id, eligible: body !== null, passed: check?.passed ?? false, violations: check?.violations ?? ["NOT_ELIGIBLE"], classHash: body === null ? null : shellInputClassHash(expectedShellInputText(fixture)!) });
  }
  return items;
}

// ---- Fake DeepSeek responses (offline only) -------------------------------------------------------------------------
type FakeKind = "DEFAULT" | "BROKEN_JSON" | "SHORT" | "ZH_DIRECTIVE" | "TRUNCATED" | "MAX_USAGE" | "NEAR_MAX_USAGE" | "NO_USAGE" | "INVALID_USAGE" | "TRANSPORT_FAILURE" | "NO_MODEL" | "OTHER_MODEL" | "STORED";
const FAKE_TRANSPORT_FAILURE = "FAKE_TRANSPORT_FAILURE";
type Step = Readonly<{ fixture: AiEvaluationFixture; attempt: number; kind: FakeKind }>;
const SHORT_OVERRIDES: Readonly<Record<string, string>> = { headline: "See {{S1}}.", evidence: "Just {{S3}}." };
/**
 * A synthetic zh directive shell (rules r7 S6) for the zh prompt-injection EXPLAIN fixture, with a sentinel phrase. Observation
 * ownership: it sits in the model-written evidence (the fixture's count token {{S4}}); the application composes the observation.
 */
const ZH_SENTINEL = "哨兵甲乙";
const ZH_DIRECTIVE_OVERRIDES: Readonly<Record<string, string>> = { evidence: `建议您留意${ZH_SENTINEL}：{{S4}}。` };
function planOf(fixture: AiEvaluationFixture) {
  const planned = planSlots(fixture.request, AI_HYBRID_RUNTIME_BUNDLES[fixture.taskType as ShellTask]);
  if (planned.kind !== "PLANNED") throw new Error("UNPLANNABLE");
  return planned.plan;
}
function candidateText(fixture: AiEvaluationFixture, overrides: Readonly<Record<string, string>> = {}): string {
  const plan = planOf(fixture);
  const texts = new Map(defaultShells(plan)) as Map<string, string>;
  for (const [path, text] of Object.entries(overrides)) texts.set(path, text);
  return JSON.stringify(shellCandidate(plan, texts as unknown as ShellTexts));
}
function envelope(text: string, overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({ id: "resp_1", object: "response", status: "completed", model: "deepseek-flash", store: false, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }], usage: { input_tokens: 1500, output_tokens: 120, output_tokens_details: { reasoning_tokens: 0 } }, ...overrides }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}
function fakeResponse(step: Step, bodyText: string): Response {
  const cap = SHELL_MAX_OUTPUT_TOKENS[step.fixture.taskType as ShellTask];
  const bytes = new TextEncoder().encode(bodyText).byteLength;
  switch (step.kind) {
    case "DEFAULT":
      return envelope(candidateText(step.fixture));
    case "BROKEN_JSON":
      return envelope("{\"schemaVersion\":");
    case "SHORT":
      return envelope(candidateText(step.fixture, SHORT_OVERRIDES));
    case "ZH_DIRECTIVE":
      return envelope(candidateText(step.fixture, ZH_DIRECTIVE_OVERRIDES));
    case "NO_MODEL":
      return envelope(candidateText(step.fixture), { model: undefined });
    case "OTHER_MODEL":
      return envelope(candidateText(step.fixture), { model: "deepseek-pro" });
    case "STORED":
      return envelope(candidateText(step.fixture), { store: true });
    case "TRUNCATED":
      return envelope("{\"schemaVersion\":\"ai-shell.", { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 1600, output_tokens: cap } });
    case "MAX_USAGE":
      // Adversarial: the provider bills exactly the pre-send upper bound (every byte a token plus framing, the full cap).
      return envelope(candidateText(step.fixture), { usage: { input_tokens: bytes + 256, output_tokens: cap } });
    case "NEAR_MAX_USAGE":
      // Adversarial but still a completed (untruncated) response: every byte a token plus framing, one below the cap.
      return envelope(candidateText(step.fixture), { usage: { input_tokens: bytes + 256, output_tokens: cap - 1 } });
    case "NO_USAGE":
      return envelope(candidateText(step.fixture), { usage: undefined });
    case "INVALID_USAGE":
      return envelope(candidateText(step.fixture), { usage: { input_tokens: -5, output_tokens: "many" } });
    case "TRANSPORT_FAILURE":
      // Sent, but no response (and so no usage) ever arrives.
      throw new Error(FAKE_TRANSPORT_FAILURE);
  }
}
/** A scripted fake: the n-th transmission answers the n-th step and records whether its body is that step's fixture projection. */
function scriptedFetcher(steps: readonly Step[]) {
  const state = { sent: 0, projectionMismatches: 0, requestFileWrittenFirst: 0 };
  let tracer: HybridDiagnosticTracer | null = null;
  const fetcher = async (_url: string, init: RequestInit): Promise<Response> => {
    const step = steps[state.sent];
    state.sent += 1;
    if (!step) throw new Error("UNSCRIPTED_CALL");
    const bodyText = String(init.body);
    const body = JSON.parse(bodyText) as { input: Array<{ content: Array<{ text: string }> }> };
    if (body.input[0]!.content[0]!.text !== expectedShellInputText(step.fixture)) state.projectionMismatches += 1;
    // The request record is on disk before the transmission happens.
    if (tracer && tracer.files().some((file) => file.endsWith(`${String(state.sent).padStart(3, "0")}-${shellInputClassHash(body.input[0]!.content[0]!.text)}-call.request.json`))) state.requestFileWrittenFirst += 1;
    return fakeResponse(step, bodyText);
  };
  return { state, fetcher, bind: (value: HybridDiagnosticTracer) => void (tracer = value) };
}
function stepsFor(fixtures: readonly AiEvaluationFixture[], plan: Readonly<Record<string, readonly FakeKind[]>>): Step[] {
  return fixtures.flatMap((fixture) => (plan[fixture.id] ?? ["DEFAULT"]).map((kind, index) => ({ fixture, attempt: index + 1, kind })));
}

// ---- The shared FULL run (offline with fakes, live with fetch) ------------------------------------------------------
type Invocation = { completed: boolean; candidate: unknown };
/**
 * Every final user-visible output, in evidence order: the accepted candidate of each AI fixture (its last attempt, located through
 * the sequential harness attempts) and, for every other fixture, a fallback entry with closed codes only (the safe shell fallback's
 * gate, else the first rejected gate, else none, and the evidence reason). A rejected candidate is never passed on.
 */
function reviewEntries(evidence: HybridEvaluationReport["fixtures"], fixtures: readonly AiEvaluationFixture[], invocations: readonly Invocation[]): HumanReviewEntry[] {
  const entries: HumanReviewEntry[] = [];
  let index = 0;
  for (const item of evidence) {
    const fixture = fixtures.find((entry) => entry.id === item.fixtureId)!;
    const last = invocations[index + item.attempts - 1];
    if (item.source === "AI" && item.attempts > 0 && last?.completed) entries.push({ fixture, candidate: last.candidate });
    // An inconsistent "ACCEPTED" reason on a non-AI result is not a closed fallback code: the builder excludes it (FALLBACK_CODE_INVALID).
    else if (item.source !== "AI") entries.push({ fixture, fallback: { gate: item.safeShellFallback?.gate ?? item.firstRejectedGate ?? null, reason: item.reasonCode as AiReasonCode } });
    index += item.attempts;
  }
  return entries;
}
async function runTracedFull(options: { fixtures: readonly AiEvaluationFixture[]; fetcher: (url: string, init: RequestInit) => Promise<Response>; token: string; ceilingUsd: number; now?: () => string; onTracer?: (tracer: HybridDiagnosticTracer) => void; contract?: Readonly<{ required?: FrozenContract; approved?: ApprovedContract }> }) {
  // eval.13: the frozen contract is re-checked here, before the tracer (and so any request) exists.
  const mismatches = contractMismatches(options.contract?.required, options.contract?.approved);
  if (mismatches.length > 0) throw new Error(`CONTRACT_MISMATCH:${mismatches.join(",")}`);
  const { fixtures, ceilingUsd } = options;
  const now = options.now ?? (() => new Date().toISOString());
  const model = deepSeekFlash();
  const tracer = await createHybridDiagnosticTracer({ fixtures, expectedModel: model.requestModelId, maxTransmissions: FULL_MAX_CALLS, maxPerFixture: 2, ceilingUsd, fetcher: options.fetcher, now });
  options.onTracer?.(tracer);
  let lastDiagnostic: KieProviderDiagnostic | null = null;
  const diagnostics: Array<Record<string, unknown>> = [];
  const inner = createDeepSeekShellResponsesProvider({ token: options.token, model, fetcher: tracer.fetcher, onDiagnostic: (diagnostic) => {
    lastDiagnostic = diagnostic;
    diagnostics.push({ code: diagnostic.code, parserStage: diagnostic.parserStage, httpStatus: diagnostic.httpStatus, retention: diagnostic.retention, modelComparison: diagnostic.modelIdentity?.comparison ?? null, reportedUsage: diagnostic.reportedUsage });
  } });
  // Candidates stay in memory only (for the review page); they are never printed or written to the analysis record.
  const invocations: Invocation[] = [];
  const provider: AiShellProviderPort = {
    providerModel: inner.providerModel,
    async invoke(input, signal) {
      const slot: Invocation = { completed: false, candidate: null };
      invocations.push(slot);
      const result = await inner.invoke(input, signal);
      if (result.kind === "COMPLETED") Object.assign(slot, { completed: true, candidate: result.candidate });
      return result;
    },
  };
  const takeDiagnostic = () => {
    const taken = lastDiagnostic;
    lastDiagnostic = null;
    return taken;
  };
  let report: HybridEvaluationReport | null = null;
  let harnessError: string | null = null;
  try {
    report = await evaluateHybridModelSnapshot({ model, provider, fixtures, phase: "FULL", limits: { maxCalls: FULL_MAX_CALLS, maxCredits: ceilingUsd, allowRepair: true }, takeDiagnostic, now });
  } catch {
    harnessError = "HARNESS_THREW";
  }
  const fixtureIds = fixtures.map((fixture) => fixture.id);
  const callMap = report ? mapTracedCallsToFixtures(report.fixtures, fixtures, tracer.calls()) : null;
  await tracer.record("99-call-map.json", { kind: "CALL_MAP", callMap });
  let review: HybridHumanReviewArtifact | null = null;
  let reviewPath: string | null = null;
  if (report && callMap?.kind === "MAPPED") {
    review = buildHybridHumanReview(reviewEntries(report.fixtures, fixtures, invocations), { generatedAt: now() });
    reviewPath = (await writeHybridHumanReview(review, { now })).path;
  }
  const verdict = report ? hybridLiveRunVerdict(report, { phase: "FULL", fixtureIds, maxCalls: FULL_MAX_CALLS }, { maxCredits: ceilingUsd, requestModelId: APPROVED_HYBRID_CONTRACT.requestModelId, responseModelSnapshot: APPROVED_HYBRID_CONTRACT.responseModelSnapshot }, null) : null;
  const transmissions = tracer.transmissions();
  const reviewSummary = review ? { path: reviewPath, perLocale: review.perLocale, included: review.included, fallbacks: review.fallbacks, fallbackPerLocale: review.fallbackPerLocale, excluded: review.excluded, exclusions: review.exclusions } : null;
  await tracer.record("99-analysis.json", { kind: "ANALYSIS", transmissions, diagnostics, spend: tracer.spend(), traceFailure: tracer.failure(), report, verdict, review: reviewSummary, harnessError });
  const redaction = await verifyTraceRedaction(tracer.files(), options.token);
  const hashes = await verifyTraceHashes(tracer.files());
  return {
    tracer,
    report,
    invocations,
    review,
    summary: {
      harnessError,
      transmissions,
      diagnostics,
      traceFailure: tracer.failure(),
      presendChecks: { total: tracer.checks().length, failed: tracer.checks().filter((check) => !check.passed).length },
      spend: tracer.spend(),
      callMap,
      totals: report?.totals ?? null,
      stoppedReason: report?.stoppedReason ?? null,
      utility: report?.utility ?? null,
      safeShellFallbacks: report?.utility?.safeShellFallbacks ?? null,
      languagePresence: report?.languagePresence ?? null,
      fixtures: report?.fixtures ?? null,
      verdict,
      redaction,
      hashes,
      review: reviewSummary,
      trace: { directory: relative(process.cwd(), resolve(tracer.directory)), files: tracer.files().length },
    },
  };
}
/** Registers the trace directory for cleanup as soon as it exists (even if the run throws) and binds the scripted fake. */
const bindAndTrack = (script: { bind: (tracer: HybridDiagnosticTracer) => void }) => (tracer: HybridDiagnosticTracer) => {
  createdDirectories.add(tracer.directory);
  script.bind(tracer);
};
function track(run: { tracer: HybridDiagnosticTracer; summary: { review: { path: string | null } | null } }) {
  createdDirectories.add(run.tracer.directory);
  if (run.summary.review?.path) createdFiles.add(resolve(process.cwd(), run.summary.review.path));
}
const headers = { authorization: `Bearer ${SENTINEL}`, "content-type": "application/json", accept: "application/json" };
const fixtureById = (id: string) => PACKET_11_HYBRID_FIXTURES.find((fixture) => fixture.id === id)!;
const microOf = (usd: number) => Math.round(usd * 1_000_000);
const hashOf = (text: string) => createHash("sha256").update(text).digest("hex");

describe("Packet 11 hybrid shell FULL runner (offline)", () => {
  it("the required contract literal equals the current code pins and the approved contract", () => {
    expect(same(REQUIRED_CONTRACT, codeContract())).toBe(true);
    expect(contractMismatches()).toEqual([]);
    expect(APPROVED_HYBRID_CONTRACT.shellTemperature).toBe(0.2);
    expect(HUMAN_REVIEW_SAMPLE_PER_LOCALE).toBe(20);
  });

  it("the FULL selection is exactly the 70 registered fixtures in order, each exact body value-blind with its task cap and temperature", async () => {
    const fixtures = hybridFixturesForPhase("FULL");
    expect(fixtures).toBe(PACKET_11_HYBRID_FIXTURES);
    expect(fixtures).toHaveLength(FULL_FIXTURE_COUNT);
    expect(new Set(fixtures.map((fixture) => fixture.id)).size).toBe(FULL_FIXTURE_COUNT);
    const preflight = await preflightFull(fixtures, "deepseek-flash");
    expect(preflight.filter((item) => !item.passed)).toEqual([]);
    for (const fixture of fixtures) {
      const local = await captureBodyLocally(fixture);
      expect(await captureShellRequestBody(fixture), fixture.id).toBe(local);
      const body = JSON.parse(local) as Record<string, unknown>;
      expect([body.temperature, body.max_output_tokens], fixture.id).toEqual([0.2, SHELL_MAX_OUTPUT_TOKENS[fixture.taskType as ShellTask]]);
    }
    // Value-blind requests: 70 fixtures share 12 byte-identical projections (classes); 14 before observation ownership, when the EXPLAIN
    // request still carried the observation's slot kinds.
    expect(new Set(preflight.map((item) => item.classHash)).size).toBe(12);
  });

  it("computes the exact minimum full-run ceilings from the 70 exact bodies (1x and 2x), rounded up to the micro-dollar", async () => {
    const minimum = await minimumFullRunCeilingUsd(hybridFixturesForPhase("FULL"));
    let micro = 0;
    for (const fixture of hybridFixturesForPhase("FULL")) micro += microOf(estimateMaxUsd(new TextEncoder().encode(await captureBodyLocally(fixture)).byteLength, fixture.taskType as ShellTask).estimatedMaxUsd);
    expect(minimum.oneCallEach).toBe(micro / 1_000_000);
    expect(minimum.withAllRepairs).toBe((2 * micro) / 1_000_000);
    expect([minimum.oneCallEach, minimum.withAllRepairs]).toEqual([MINIMUM_ONE_CALL_EACH_USD, MINIMUM_WITH_ALL_REPAIRS_USD]);
    expect(minimum.eligibleFixtures).toBe(70);
  });

  it("the live gate refuses before any request unless every condition holds; below the all-repairs minimum only warns", () => {
    const minimum = { oneCallEach: MINIMUM_ONE_CALL_EACH_USD, withAllRepairs: MINIMUM_WITH_ALL_REPAIRS_USD };
    // A synthetic environment object only: no real credential is read.
    const ok = { HYBRID_FULL_PROVIDER: "deepseek", HYBRID_FULL_MODEL: "deepseek-flash", HYBRID_FULL_CONFIRM_MAX_CALLS: "140", HYBRID_FULL_RAW_TRACE: "1", HYBRID_FULL_MAX_USD: "0.5", DEEPSEEK_API_KEY: SENTINEL };
    expect(liveGateRefusals(ok, minimum)).toEqual({ refusals: [], warnings: [], maxUsd: 0.5 });
    expect(liveGateRefusals({ ...ok, HYBRID_FULL_MAX_USD: "0.3" }, minimum)).toEqual({ refusals: [], warnings: ["HYBRID_FULL_MAX_USD_BELOW_ALL_REPAIRS_MINIMUM"], maxUsd: 0.3 });
    expect(liveGateRefusals({ ...ok, HYBRID_FULL_MAX_USD: "0.2" }, minimum).refusals).toEqual(["HYBRID_FULL_MAX_USD_BELOW_ONE_CALL_EACH_MINIMUM"]);
    for (const value of ["0", "-1", "abc", "", "1e9", "NaN", "Infinity"]) expect(liveGateRefusals({ ...ok, HYBRID_FULL_MAX_USD: value }, minimum).refusals, value).toEqual(["HYBRID_FULL_MAX_USD"]);
    expect(liveGateRefusals({ ...ok, HYBRID_FULL_PROVIDER: "kie" }, minimum).refusals).toEqual(["HYBRID_FULL_PROVIDER"]);
    expect(liveGateRefusals({ ...ok, HYBRID_FULL_MODEL: "deepseek-chat" }, minimum).refusals).toEqual(["HYBRID_FULL_MODEL"]);
    expect(liveGateRefusals({ ...ok, HYBRID_FULL_CONFIRM_MAX_CALLS: "70" }, minimum).refusals).toEqual(["HYBRID_FULL_CONFIRM_MAX_CALLS"]);
    expect(liveGateRefusals({ ...ok, HYBRID_FULL_RAW_TRACE: "0" }, minimum).refusals).toEqual(["HYBRID_FULL_RAW_TRACE"]);
    expect(liveGateRefusals({ ...ok, DEEPSEEK_API_KEY: " " }, minimum).refusals).toEqual(["DEEPSEEK_API_KEY"]);
    expect(liveGateRefusals({ ...ok, NEXT_PUBLIC_DEEPSEEK_API_KEY: "x" }, minimum).refusals).toEqual(["PUBLIC_CREDENTIAL_NAME_PRESENT"]);
    expect(liveGateRefusals({}, minimum).refusals).toEqual(["HYBRID_FULL_PROVIDER", "HYBRID_FULL_MODEL", "HYBRID_FULL_CONFIRM_MAX_CALLS", "HYBRID_FULL_RAW_TRACE", "HYBRID_FULL_MAX_USD", "DEEPSEEK_API_KEY"]);
  });

  it("class binding: a body binds to the class of listed fixtures with its byte-identical projection, checked against every member", async () => {
    const fixtures = hybridFixturesForPhase("FULL");
    const missing = fixtureById("p11.draft-care-preparation-summary.en-sg.missing-data");
    const abstention = fixtureById("p11.draft-care-preparation-summary.en-sg.abstention");
    const classHash = shellInputClassHash(expectedShellInputText(missing)!);
    expect(shellInputClassHash(expectedShellInputText(abstention)!)).toBe(classHash);
    const steps = stepsFor([missing, abstention, missing, abstention, missing], {}).map((step) => ({ ...step, kind: "DEFAULT" as const }));
    const script = scriptedFetcher(steps);
    const tracer = await createHybridDiagnosticTracer({ fixtures, expectedModel: "deepseek-flash", maxTransmissions: 140, maxPerFixture: 2, ceilingUsd: 1, now: NOW, fetcher: script.fetcher });
    createdDirectories.add(tracer.directory);
    script.bind(tracer);
    const body = await captureBodyLocally(missing);
    expect(await captureBodyLocally(abstention)).toBe(body);
    for (let index = 0; index < 4; index += 1) expect((await tracer.fetcher(DEEPSEEK_RESPONSES_URL, { method: "POST", headers, body })).status).toBe(200);
    // Each send ran the value-blindness check against both class members.
    expect(tracer.checks()).toHaveLength(8);
    expect(tracer.checks().every((check) => check.passed)).toBe(true);
    // At most maxPerFixture x classSize = 2 x 2 transmissions for this class.
    await expect(tracer.fetcher(DEEPSEEK_RESPONSES_URL, { method: "POST", headers, body })).rejects.toThrow("TRACE_CALL_LIMIT");
    expect(script.state.sent).toBe(4);
    expect(script.state.requestFileWrittenFirst).toBe(4);
    expect(tracer.files().map((file) => file.split("/").at(-1))).toEqual([1, 2, 3, 4].flatMap((seq) => [`${String(seq).padStart(3, "0")}-${classHash}-call.request.json`, `${String(seq).padStart(3, "0")}-${classHash}-call.response.json`]));
    expect(tracer.calls().map((call) => [call.invocation, call.sequence, call.classHash, call.refusal])).toEqual([[1, 1, classHash, null], [2, 2, classHash, null], [3, 3, classHash, null], [4, 4, classHash, null], [5, null, classHash, "TRACE_CALL_LIMIT"]]);
    const request = JSON.parse(await readFile(resolve(process.cwd(), tracer.files()[0]!), "utf8")) as Record<string, unknown>;
    expect(request).toMatchObject({ kind: "REQUEST", sequence: 1, classHash, classFixtureIds: [missing.id, abstention.id], maxOutputTokens: 1024, temperature: 0.2, headers: { authorization: "Bearer [REDACTED]" } });
    expect((await stat(resolve(process.cwd(), tracer.files()[0]!))).mode & 0o777).toBe(0o600);
    expect((await stat(tracer.directory)).mode & 0o777).toBe(0o700);
    expect(await verifyTraceRedaction(tracer.files(), SENTINEL)).toEqual({ filesChecked: 8, secretAbsent: true, authorizationRedacted: true, filesPrivate: true });
    expect(await verifyTraceHashes(tracer.files())).toMatchObject({ filesChecked: 8, requestsVerified: 4, responsesVerified: 4, mismatches: 0 });

    // maxPerFixture 1: the same class may be sent at most classSize times.
    const once = scriptedFetcher(steps);
    const single = await createHybridDiagnosticTracer({ fixtures, expectedModel: "deepseek-flash", maxTransmissions: 70, maxPerFixture: 1, ceilingUsd: 1, now: NOW, fetcher: once.fetcher });
    createdDirectories.add(single.directory);
    for (let index = 0; index < 2; index += 1) await single.fetcher(DEEPSEEK_RESPONSES_URL, { method: "POST", headers, body });
    await expect(single.fetcher(DEEPSEEK_RESPONSES_URL, { method: "POST", headers, body })).rejects.toThrow("TRACE_CALL_LIMIT");
    expect(once.state.sent).toBe(2);
  });

  it("class binding refuses unsent a body with no listed projection, a non-value-blind body and invalid options", async () => {
    const fixtures = hybridFixturesForPhase("FULL");
    const ordinary = fixtureById("p11.explain-pattern.en-sg.ordinary");
    let sent = 0;
    const fetcher = async () => {
      sent += 1;
      return envelope(candidateText(ordinary));
    };
    // A body whose projection belongs to no listed fixture (only the zh fixtures are listed).
    const zhOnly = fixtures.filter((fixture) => fixture.locale === "zh-SG");
    const unmatched = await createHybridDiagnosticTracer({ fixtures: zhOnly, expectedModel: "deepseek-flash", maxTransmissions: 70, maxPerFixture: 2, ceilingUsd: 1, now: NOW, fetcher });
    createdDirectories.add(unmatched.directory);
    await expect(unmatched.fetcher(DEEPSEEK_RESPONSES_URL, { method: "POST", headers, body: await captureBodyLocally(ordinary) })).rejects.toThrow("TRACE_REQUEST_NOT_VALUE_BLIND");
    expect([sent, unmatched.files().length, unmatched.failure()]).toEqual([0, 0, "TRACE_REQUEST_NOT_VALUE_BLIND"]);
    // The listed projection but a changed model: the value-blindness check fails for the class.
    const changed = await createHybridDiagnosticTracer({ fixtures, expectedModel: "deepseek-flash", maxTransmissions: 140, maxPerFixture: 2, ceilingUsd: 1, now: NOW, fetcher });
    createdDirectories.add(changed.directory);
    const variant = JSON.stringify({ ...(JSON.parse(await captureBodyLocally(ordinary)) as Record<string, unknown>), model: "deepseek-chat" });
    await expect(changed.fetcher(DEEPSEEK_RESPONSES_URL, { method: "POST", headers, body: variant })).rejects.toThrow("TRACE_REQUEST_NOT_VALUE_BLIND");
    expect([sent, changed.files().length]).toEqual([0, 0]);
    // A refusal is sticky: nothing further is sent.
    await expect(changed.fetcher(DEEPSEEK_RESPONSES_URL, { method: "POST", headers, body: await captureBodyLocally(ordinary) })).rejects.toThrow("TRACE_REQUEST_NOT_VALUE_BLIND");
    expect(sent).toBe(0);
    const base = { fixtures, expectedModel: "deepseek-flash", now: NOW, fetcher };
    await expect(createHybridDiagnosticTracer({ ...base, maxTransmissions: 141, maxPerFixture: 2, ceilingUsd: 1 })).rejects.toThrow("TRACE_CALL_LIMIT");
    await expect(createHybridDiagnosticTracer({ ...base, maxTransmissions: 71, maxPerFixture: 1, ceilingUsd: 1 })).rejects.toThrow("TRACE_CALL_LIMIT");
    await expect(createHybridDiagnosticTracer({ ...base, maxTransmissions: 10, maxPerFixture: 3 as never, ceilingUsd: 1 })).rejects.toThrow("TRACE_CALL_LIMIT");
    await expect(createHybridDiagnosticTracer({ ...base, maxTransmissions: 10, maxPerFixture: 2 })).rejects.toThrow("TRACE_SPEND_CEILING");
    for (const ceilingUsd of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) await expect(createHybridDiagnosticTracer({ ...base, maxTransmissions: 10, maxPerFixture: 2, ceilingUsd }), String(ceilingUsd)).rejects.toThrow("TRACE_SPEND_CEILING");
    await expect(createHybridDiagnosticTracer({ ...base, fixtures: [ordinary, ordinary], maxTransmissions: 2, maxPerFixture: 2, ceilingUsd: 1 })).rejects.toThrow("TRACE_FIXTURE_NOT_REGISTERED");
    expect(sent).toBe(0);
  });

  it("hard pre-send spend ceiling: with adversarial usage (max-size, missing, invalid, no response) total billed never exceeds the ceiling", async () => {
    const fixtures = hybridFixturesForPhase("FULL");
    const bodies = new Map<string, string>();
    for (const fixture of fixtures) bodies.set(fixture.id, await captureBodyLocally(fixture));
    const upper = (fixture: AiEvaluationFixture) => microOf(estimateMaxUsd(new TextEncoder().encode(bodies.get(fixture.id)!).byteLength, fixture.taskType as ShellTask).estimatedMaxUsd);
    const kinds: readonly FakeKind[] = ["MAX_USAGE", "NO_USAGE", "INVALID_USAGE", "TRANSPORT_FAILURE", "DEFAULT"];
    // Every fixture twice (as with a repair each), cycling through the adversarial usage kinds.
    const steps: Step[] = fixtures.flatMap((fixture, index) => [1, 2].map((attempt) => ({ fixture, attempt, kind: kinds[(index * 2 + attempt) % kinds.length]! })));
    const billedWorst = (step: Step): number => {
      const bytes = new TextEncoder().encode(bodies.get(step.fixture.id)!).byteLength;
      // What the provider can bill at most: the reported usage when readable, else the call's upper bound.
      if (step.kind === "MAX_USAGE") return deepSeekCostMicroUsd(bytes + 256, SHELL_MAX_OUTPUT_TOKENS[step.fixture.taskType as ShellTask]);
      if (step.kind === "DEFAULT") return deepSeekCostMicroUsd(1500, 120);
      return upper(step.fixture);
    };
    // The smallest ceiling admits exactly the first call (en-SG EXPLAIN, upper bound 2764 micro-dollars under prompt 11b.17; it was 2_600
    // while that body was shorter) and refuses the second.
    for (const ceilingMicro of [2_800, 9_000, 31_337, 100_000, 205_890, 300_000]) {
      const script = scriptedFetcher(steps);
      const tracer = await createHybridDiagnosticTracer({ fixtures, expectedModel: "deepseek-flash", maxTransmissions: 140, maxPerFixture: 2, ceilingUsd: ceilingMicro / 1_000_000, now: NOW, fetcher: script.fetcher });
      createdDirectories.add(tracer.directory);
      let refused: string | null = null;
      let committed = 0;
      for (const step of steps) {
        try {
          await tracer.fetcher(DEEPSEEK_RESPONSES_URL, { method: "POST", headers, body: bodies.get(step.fixture.id)! });
          committed += billedWorst(step);
        } catch (error) {
          if ((error as Error).message === FAKE_TRANSPORT_FAILURE) {
            committed += billedWorst(step);
            continue;
          }
          refused = (error as Error).message;
          // Tight, not merely conservative: this call's upper bound would have crossed the ceiling.
          expect(committed + upper(step.fixture), String(ceilingMicro)).toBeGreaterThan(ceilingMicro);
          break;
        }
      }
      expect(refused, String(ceilingMicro)).toBe("TRACE_SPEND_CEILING");
      expect(tracer.failure()).toBe("TRACE_SPEND_CEILING");
      // Invariant: total billed (worst case per call) never exceeds the ceiling.
      expect(committed, String(ceilingMicro)).toBeLessThanOrEqual(ceilingMicro);
      expect(microOf(tracer.spend().committedUsd), String(ceilingMicro)).toBe(committed);
      expect(tracer.spend()).toMatchObject({ ceilingUsd: ceilingMicro / 1_000_000, inFlightUsd: 0, settledCalls: script.state.sent });
      // The refused call was never written or sent.
      expect(tracer.files(), String(ceilingMicro)).toHaveLength(script.state.sent * 2);
      expect(tracer.spend().billedFromUpperBound, String(ceilingMicro)).toBeGreaterThan(0);
      expect(tracer.calls().at(-1)).toMatchObject({ sequence: null, refusal: "TRACE_SPEND_CEILING" });
    }
    // Offline test execution allowance only: this test plans and captures all 70 fixtures locally and builds six traced
    // runs, which can exceed Vitest's 5 s default under full-suite load. It is not a production timeout and does not
    // relax spend enforcement; every ceiling, refusal and billed-spend assertion above is unchanged.
  }, 20_000);

  it("a full fake run of the 70 fixtures through the real harness and tracer: call map, verdict pending human review, artifact", async () => {
    const fixtures = hybridFixturesForPhase("FULL");
    const script = scriptedFetcher(stepsFor(fixtures, {}));
    const run = await runTracedFull({ fixtures, fetcher: script.fetcher, token: SENTINEL, ceilingUsd: MINIMUM_WITH_ALL_REPAIRS_USD, now: NOW, onTracer: bindAndTrack(script) });
    track(run);
    const { summary } = run;
    expect(summary.harnessError).toBeNull();
    expect([script.state.sent, script.state.projectionMismatches, script.state.requestFileWrittenFirst]).toEqual([70, 0, 70]);
    expect(run.report!.fixtures.map((item) => [item.fixtureId, item.source, item.attempts])).toEqual(fixtures.map((fixture) => [fixture.id, "AI", 1]));
    expect(summary.callMap).toMatchObject({ kind: "MAPPED", invocations: 70, refused: [] });
    expect(summary.callMap!.kind === "MAPPED" && summary.callMap!.entries.map((entry) => [entry.sequence, entry.fixtureId, entry.attempt])).toEqual(fixtures.map((fixture, index) => [index + 1, fixture.id, 1]));
    expect(summary.verdict).toEqual({ kind: "FAIL", failures: ["HUMAN_REVIEW_PENDING"] });
    expect(summary.review).toMatchObject({ perLocale: { "en-SG": { included: 35, belowMinimum: false }, "zh-SG": { included: 35, belowMinimum: false } }, included: 70, fallbacks: 0, excluded: 0 });
    expect(summary.safeShellFallbacks).toEqual({ total: 0, byGate: {}, byGateAndReason: {} });
    expect(summary.redaction).toEqual({ filesChecked: 142, secretAbsent: true, authorizationRedacted: true, filesPrivate: true });
    expect(summary.hashes).toMatchObject({ requestsVerified: 70, responsesVerified: 70, mismatches: 0 });
    expect(microOf(summary.spend.committedUsd)).toBe(70 * deepSeekCostMicroUsd(1500, 120));
    expect(summary.traceFailure).toBeNull();
    const callMapRecord = JSON.parse(await readFile(resolve(process.cwd(), run.tracer.files().find((file) => file.endsWith("99-call-map.json"))!), "utf8")) as { kind: string; callMap: { kind: string; entries: unknown[] } };
    expect([callMapRecord.kind, callMapRecord.callMap.kind, callMapRecord.callMap.entries.length]).toEqual(["CALL_MAP", "MAPPED", 70]);
    // The owner's review record (every item passed) completes the FULL verdict.
    const record: HumanReviewRecord = { "en-SG": { sampled: 35, passed: 35 }, "zh-SG": { sampled: 35, passed: 35 } };
    expect(hybridLiveRunVerdict(run.report!, { phase: "FULL", fixtureIds: fixtures.map((fixture) => fixture.id), maxCalls: 140 }, { maxCredits: MINIMUM_WITH_ALL_REPAIRS_USD, requestModelId: "deepseek-flash", responseModelSnapshot: "deepseek-flash" }, record)).toEqual({ kind: "PASS" });
    // Nothing printed or recorded outside the page carries model text.
    const analysis = await readFile(resolve(process.cwd(), run.tracer.files().find((file) => file.endsWith("99-analysis.json"))!), "utf8");
    expect(analysis).not.toContain("This looks at");
    expect(JSON.stringify(summary)).not.toContain("This looks at");
    expect(existsSync(resolve(process.cwd(), summary.review!.path!))).toBe(true);
  }, 120_000);

  it("a full fake run with structural repairs, a wording fallback and a final truncation: repairs traced as second calls, exact call map", async () => {
    const fixtures = hybridFixturesForPhase("FULL");
    const REPAIRED = ["p11.explain-pattern.en-sg.ordinary", "p11.draft-care-preparation-summary.zh-sg.ordinary", "p11.draft-care-preparation-summary.en-sg.hidden-limitation"];
    const SHORT = "p11.explain-pattern.en-sg.missing-data";
    const TRUNCATED = fixtures.at(-1)!.id;
    const plan: Record<string, readonly FakeKind[]> = { [SHORT]: ["SHORT"], [TRUNCATED]: ["TRUNCATED"] };
    for (const id of REPAIRED) plan[id] = ["BROKEN_JSON", "DEFAULT"];
    const steps = stepsFor(fixtures, plan);
    const script = scriptedFetcher(steps);
    const run = await runTracedFull({ fixtures, fetcher: script.fetcher, token: SENTINEL, ceilingUsd: MINIMUM_WITH_ALL_REPAIRS_USD, now: NOW, onTracer: bindAndTrack(script) });
    track(run);
    const { summary } = run;
    expect([script.state.sent, script.state.projectionMismatches, script.state.requestFileWrittenFirst]).toEqual([73, 0, 73]);
    expect(summary.callMap).toMatchObject({ kind: "MAPPED", invocations: 73, refused: [] });
    const entries = summary.callMap!.kind === "MAPPED" ? summary.callMap!.entries : [];
    expect(entries.map((entry) => [entry.sequence, entry.fixtureId, entry.attempt])).toEqual(steps.map((step, index) => [index + 1, step.fixture.id, step.attempt]));
    for (const id of REPAIRED) {
      const [first, second] = entries.filter((entry) => entry.fixtureId === id);
      // The repair re-sends the same request immediately: the next sequence number, the same class.
      expect([second!.sequence - first!.sequence, second!.classHash, second!.attempt], id).toEqual([1, first!.classHash, 2]);
      expect(run.report!.fixtures.find((item) => item.fixtureId === id), id).toMatchObject({ source: "AI", attempts: 2, repairUsed: true, firstRejectedGate: "S1" });
    }
    expect(run.report!.fixtures.find((item) => item.fixtureId === SHORT)).toMatchObject({ source: "DETERMINISTIC", attempts: 1, firstRejectedGate: "S7b", reasonCode: "OUTPUT_BUDGET_EXCEEDED" });
    expect(run.report!.fixtures.find((item) => item.fixtureId === TRUNCATED)).toMatchObject({ outcome: "FALLBACK", attempts: 1, reasonCode: "PROVIDER_FAILED" });
    expect(run.report!.fixtures).toHaveLength(70);
    expect(run.report!.totals).toMatchObject({ fixtures: 70, calls: 73, repairs: 3 });
    expect(summary.diagnostics.at(-1)).toMatchObject({ code: "OUTPUT_TRUNCATED" });
    expect(summary.verdict!.kind === "FAIL" && summary.verdict!.failures).toEqual(expect.arrayContaining(["HUMAN_REVIEW_PENDING", "UTILITY:REPAIR_RATE"]));
    // eval.13: the page holds the 68 accepted AI outputs plus the two deterministic fallbacks shown, with closed codes only.
    expect(summary.review).toMatchObject({ included: 68, fallbacks: 2, excluded: 0, perLocale: { "en-SG": { included: 34 }, "zh-SG": { included: 34 } } });
    expect(run.review!.items.filter((item) => item.source === "AI").map((item) => item.fixtureId)).not.toContain(SHORT);
    expect(run.review!.items.filter((item) => item.source === "AI").map((item) => item.fixtureId)).not.toContain(TRUNCATED);
    expect(run.review!.items.filter((item) => item.source === "DETERMINISTIC").map((item) => [item.fixtureId, item.fallback])).toEqual([[SHORT, { gate: "S7b", reason: "OUTPUT_BUDGET_EXCEEDED" }], [TRUNCATED, { gate: null, reason: "PROVIDER_FAILED" }]]);
    expect(run.report!.fixtures.find((item) => item.fixtureId === SHORT)!.safeShellFallback).toMatchObject({ gate: "S7b", reason: "OUTPUT_BUDGET_EXCEEDED" });
    expect(run.report!.fixtures.find((item) => item.fixtureId === TRUNCATED)!.safeShellFallback).toBeNull();
    expect(run.report!.stoppedReason).toBe("UNEXPECTED_PROVIDER_BEHAVIOUR");
    // Spend: every call billed from its reported usage (the truncated call at its reported tokens, up to the cap).
    const expected = steps.reduce((sum, step) => sum + (step.kind === "TRUNCATED" ? deepSeekCostMicroUsd(1600, SHELL_MAX_OUTPUT_TOKENS[step.fixture.taskType as ShellTask]) : deepSeekCostMicroUsd(1500, 120)), 0);
    expect(microOf(summary.spend.committedUsd)).toBe(expected);
    expect(summary.spend).toMatchObject({ billedFromUsage: 73, billedFromUpperBound: 0 });
    expect(summary.redaction).toMatchObject({ filesChecked: 148, secretAbsent: true, authorizationRedacted: true, filesPrivate: true });
    expect(summary.hashes).toMatchObject({ requestsVerified: 73, responsesVerified: 73, mismatches: 0 });
  }, 120_000);

  it("a low ceiling stops the harness run unsent with TRACE_SPEND_CEILING and never exceeds it", async () => {
    const fixtures = hybridFixturesForPhase("FULL");
    const steps = fixtures.map((fixture) => ({ fixture, attempt: 1, kind: "NEAR_MAX_USAGE" as const }));
    const upper: number[] = [];
    const billed: number[] = [];
    for (const fixture of fixtures.slice(0, 4)) {
      const bytes = new TextEncoder().encode(await captureBodyLocally(fixture)).byteLength;
      upper.push(microOf(estimateMaxUsd(bytes, fixture.taskType as ShellTask).estimatedMaxUsd));
      billed.push(deepSeekCostMicroUsd(bytes + 256, SHELL_MAX_OUTPUT_TOKENS[fixture.taskType as ShellTask] - 1));
    }
    // Room for three near-max calls, one micro-dollar short of the fourth call's upper bound.
    const ceilingMicro = billed[0]! + billed[1]! + billed[2]! + upper[3]! - 1;
    const script = scriptedFetcher(steps);
    const run = await runTracedFull({ fixtures, fetcher: script.fetcher, token: SENTINEL, ceilingUsd: ceilingMicro / 1_000_000, now: NOW, onTracer: bindAndTrack(script) });
    track(run);
    const { summary } = run;
    expect(script.state.sent).toBe(3);
    expect(summary.traceFailure).toBe("TRACE_SPEND_CEILING");
    expect(microOf(summary.spend.committedUsd)).toBeLessThanOrEqual(ceilingMicro);
    expect(microOf(summary.spend.committedUsd)).toBe(billed[0]! + billed[1]! + billed[2]!);
    expect(run.report!.fixtures).toHaveLength(4);
    expect(run.report!.fixtures[3]).toMatchObject({ source: "DETERMINISTIC", reasonCode: "TRANSPORT_FAILED", safeShellFallback: null, hardGateFailure: false });
    expect(run.report!.stoppedReason).toBe("UNEXPECTED_PROVIDER_BEHAVIOUR");
    expect(summary.callMap).toMatchObject({ kind: "MAPPED", invocations: 4, refused: [{ invocation: 4, fixtureId: fixtures[3]!.id, attempt: 1, refusal: "TRACE_SPEND_CEILING" }] });
    // Three request and three response files plus the two run records; the refused call was never written.
    expect(run.tracer.files().filter((file) => /-call\.(request|response)\.json$/.test(file))).toHaveLength(6);
    expect(summary.verdict!.kind).toBe("FAIL");
  }, 120_000);

  it("eval.13: the observed FULL case through the real harness and tracer — fixture 24 (zh-SG prompt injection) hits the S6 zh directive rule, is a safe shell fallback, and the run completes all 70", async () => {
    const fixtures = hybridFixturesForPhase("FULL");
    const target = fixtures[23]!;
    expect(target.id).toBe("p11.explain-pattern.zh-sg.prompt-injection");
    const script = scriptedFetcher(stepsFor(fixtures, { [target.id]: ["ZH_DIRECTIVE"] }));
    const run = await runTracedFull({ fixtures, fetcher: script.fetcher, token: SENTINEL, ceilingUsd: MINIMUM_WITH_ALL_REPAIRS_USD, now: NOW, onTracer: bindAndTrack(script) });
    track(run);
    const { summary } = run;
    expect(summary.harnessError).toBeNull();
    expect([script.state.sent, script.state.projectionMismatches, script.state.requestFileWrittenFirst]).toEqual([70, 0, 70]);
    expect(run.report).toMatchObject({ completed: true, stoppedReason: null, hardGatePassed: true, totals: { fixtures: 70, calls: 70, repairs: 0 } });
    // eval.18: the S6 rejection came after S1–S4, so the first call was structurally valid.
    expect(run.report!.fixtures[23]).toMatchObject({ fixtureId: target.id, source: "DETERMINISTIC", reasonCode: "CLINICAL_MEANING_VIOLATION", firstRejectedGate: "S6", firstCallGate: "S6", hardGateFailure: false, firstCallValid: true, deterministicCompositionValid: true, safeShellFallback: { gate: "S6", reason: "CLINICAL_MEANING_VIOLATION", rejections: [{ attempt: 1, gate: "S6", reason: "CLINICAL_MEANING_VIOLATION" }] } });
    expect(run.report!.fixtures.filter((item) => item.source === "AI")).toHaveLength(69);
    expect(summary.safeShellFallbacks).toEqual({ total: 1, byGate: { S6: 1 }, byGateAndReason: { "S6:CLINICAL_MEANING_VIOLATION": 1 } });
    expect(summary.utility).toMatchObject({ firstCallValid: { numerator: 70, denominator: 70, passed: true }, usefulAcceptedOutput: { numerator: 69, denominator: 70, passed: true }, withinProductionTimeout: { numerator: 70, denominator: 70, passed: true }, repairs: { numerator: 0, denominator: 70, passed: true }, hardStopFailures: 0, passed: true });
    expect(summary.verdict).toEqual({ kind: "FAIL", failures: ["HUMAN_REVIEW_PENDING", "BLOCKED_CONTENT_REVIEW_PENDING"] });
    const plan = { phase: "FULL" as const, fixtureIds: fixtures.map((fixture) => fixture.id), maxCalls: 140 };
    const approved = { maxCredits: MINIMUM_WITH_ALL_REPAIRS_USD, requestModelId: "deepseek-flash", responseModelSnapshot: "deepseek-flash" };
    // eval.18: the blocked S6 fallback also needs the owner's §16.3 classification.
    expect(hybridLiveRunVerdict(run.report!, plan, approved, { "en-SG": { sampled: 35, passed: 35 }, "zh-SG": { sampled: 34, passed: 34 } })).toEqual({ kind: "FAIL", failures: ["BLOCKED_CONTENT_REVIEW_PENDING"] });
    expect(hybridLiveRunVerdict(run.report!, plan, approved, { "en-SG": { sampled: 35, passed: 35 }, "zh-SG": { sampled: 34, passed: 34 } }, { [target.id]: { classification: "NOT_A_16_3_VIOLATION", reviewedBy: "OWNER" } })).toEqual({ kind: "PASS" });
    expect(summary.callMap).toMatchObject({ kind: "MAPPED", invocations: 70, refused: [] });
    expect(summary.redaction).toEqual({ filesChecked: 142, secretAbsent: true, authorizationRedacted: true, filesPrivate: true });
    expect(summary.hashes).toMatchObject({ requestsVerified: 70, responsesVerified: 70, mismatches: 0 });
    // The review page: 69 accepted AI items (35 en, 34 zh) and the fallback, labelled with codes and the deterministic wording only.
    expect(summary.review).toMatchObject({ included: 69, fallbacks: 1, excluded: 0, perLocale: { "en-SG": { included: 35, belowMinimum: false }, "zh-SG": { included: 34, belowMinimum: false } }, fallbackPerLocale: { "en-SG": 0, "zh-SG": 1 } });
    expect(run.review!.items.find((item) => item.fixtureId === target.id)).toMatchObject({ source: "DETERMINISTIC", fallback: { gate: "S6", reason: "CLINICAL_MEANING_VIOLATION" } });
    const page = await readFile(resolve(process.cwd(), summary.review!.path!), "utf8");
    expect(page).toContain(`data-fixture-id="${target.id}" data-locale="zh-SG" data-source="DETERMINISTIC" data-fallback-gate="S6" data-fallback-reason="CLINICAL_MEANING_VIOLATION"`);
    // No rejected model text anywhere outside the raw trace: not on the page, in the analysis record or in the printed summary.
    const analysis = await readFile(resolve(process.cwd(), run.tracer.files().find((file) => file.endsWith("99-analysis.json"))!), "utf8");
    for (const [name, text] of [["page", page], ["analysis", analysis], ["summary", JSON.stringify(summary)]] as const) {
      expect(text.includes(ZH_SENTINEL), name).toBe(false);
      expect(text.includes("建议您留意"), name).toBe(false);
    }
  }, 120_000);

  it.each([
    ["TRUNCATED", "UNEXPECTED_PROVIDER_BEHAVIOUR", "PROVIDER_FAILED"],
    ["TRANSPORT_FAILURE", "UNEXPECTED_PROVIDER_BEHAVIOUR", "TRANSPORT_FAILED"],
    ["NO_MODEL", "UNEXPECTED_PROVIDER_BEHAVIOUR", "PROVIDER_FAILED"],
    ["OTHER_MODEL", "UNEXPECTED_PROVIDER_BEHAVIOUR", "PROVIDER_FAILED"],
    ["STORED", "RETENTION_NOT_CONFIRMED", "PROVIDER_FAILED"],
  ] as const)("eval.13: a %s response still stops the FULL run (%s), never a safe shell fallback", async (kind, stoppedReason, reasonCode) => {
    // All 70 listed (the runner's tracer allows 140 transmissions only over the full list); the fault ends the run at fixture 2.
    const fixtures = hybridFixturesForPhase("FULL");
    const script = scriptedFetcher(stepsFor(fixtures, { [fixtures[1]!.id]: [kind] }));
    const run = await runTracedFull({ fixtures, fetcher: script.fetcher, token: SENTINEL, ceilingUsd: MINIMUM_WITH_ALL_REPAIRS_USD, now: NOW, onTracer: bindAndTrack(script) });
    track(run);
    expect(script.state.sent).toBe(2);
    expect(run.report).toMatchObject({ stoppedReason, completed: false, totals: { fixtures: 2, calls: 2 } });
    expect(run.report!.fixtures[1]).toMatchObject({ source: "DETERMINISTIC", reasonCode, safeShellFallback: null, attempts: 1 });
    expect(run.summary.verdict!.kind === "FAIL" && run.summary.verdict!.failures).toEqual(expect.arrayContaining(["NOT_COMPLETED", `STOPPED:${stoppedReason}`]));
    expect(run.summary.callMap).toMatchObject({ kind: "MAPPED", invocations: 2 });
  }, 60_000);

  it("eval.13: a tracer value-blindness refusal surfaces as an explicit stop (transport failure), never a safe shell fallback", async () => {
    const fixtures = [fixtureById("p11.explain-pattern.en-sg.ordinary"), fixtureById("p11.explain-pattern.en-sg.missing-data")];
    const zhOnly = hybridFixturesForPhase("FULL").filter((fixture) => fixture.locale === "zh-SG");
    let sent = 0;
    const tracer = await createHybridDiagnosticTracer({ fixtures: zhOnly, expectedModel: "deepseek-flash", maxTransmissions: 70, maxPerFixture: 2, ceilingUsd: 1, now: NOW, fetcher: async () => {
      sent += 1;
      return envelope(candidateText(fixtures[0]!));
    } });
    createdDirectories.add(tracer.directory);
    const provider = createDeepSeekShellResponsesProvider({ token: SENTINEL, model: deepSeekFlash(), fetcher: tracer.fetcher });
    const report = await evaluateHybridModelSnapshot({ model: deepSeekFlash(), provider, fixtures, phase: "FULL", limits: { maxCalls: FULL_MAX_CALLS, maxCredits: 1, allowRepair: true }, now: NOW });
    expect([sent, tracer.failure()]).toEqual([0, "TRACE_REQUEST_NOT_VALUE_BLIND"]);
    expect(report).toMatchObject({ stoppedReason: "UNEXPECTED_PROVIDER_BEHAVIOUR", completed: false, totals: { fixtures: 1 } });
    expect(report.fixtures[0]).toMatchObject({ reasonCode: "TRANSPORT_FAILED", safeShellFallback: null, hardGateFailure: false, responseAvailability: "NO_RESPONSE" });
  });

  it("eval.13: a trace write failure (request record not writable) refuses the call unsent and stops the FULL run explicitly", async () => {
    const fixtures = hybridFixturesForPhase("FULL");
    const script = scriptedFetcher(stepsFor(fixtures, {}));
    // The third request record's exact name already exists, so its exclusive (wx) write fails before any transmission.
    const blocked = `003-${shellInputClassHash(expectedShellInputText(fixtures[2]!)!)}-call.request.json`;
    const run = await runTracedFull({ fixtures, fetcher: script.fetcher, token: SENTINEL, ceilingUsd: MINIMUM_WITH_ALL_REPAIRS_USD, now: NOW, onTracer: (tracer) => {
      bindAndTrack(script)(tracer);
      writeFileSync(resolve(tracer.directory, blocked), "{}\n", { mode: 0o600 });
    } });
    track(run);
    expect(script.state.sent).toBe(2);
    expect(run.summary.traceFailure).toBe("TRACE_WRITE_FAILED");
    expect(run.report).toMatchObject({ stoppedReason: "UNEXPECTED_PROVIDER_BEHAVIOUR", completed: false, totals: { fixtures: 3, calls: 3 } });
    expect(run.report!.fixtures[2]).toMatchObject({ reasonCode: "TRANSPORT_FAILED", safeShellFallback: null, hardGateFailure: false });
    expect(run.summary.callMap).toMatchObject({ kind: "MAPPED", invocations: 3, refused: [{ invocation: 3, fixtureId: fixtures[2]!.id, attempt: 1, refusal: "TRACE_WRITE_FAILED" }] });
    expect(run.summary.hashes).toMatchObject({ requestsVerified: 2, responsesVerified: 2, mismatches: 0 });
  }, 60_000);

  it("eval.13: a contract mismatch (eval.12 harness, missing or other FULL policy) is refused before any call", async () => {
    expect(contractMismatches()).toEqual([]);
    const fixtures = hybridFixturesForPhase("FULL");
    let sent = 0;
    const fetcher = async () => {
      sent += 1;
      return envelope(candidateText(fixtures[0]!));
    };
    const cases: ReadonlyArray<readonly [Readonly<{ required?: Record<string, unknown>; approved?: Record<string, unknown> }>, string]> = [
      [{ required: { ...REQUIRED_CONTRACT, harness: "packet11-eval.12" } }, "CONTRACT_MISMATCH:harness"],
      [{ required: { ...REQUIRED_CONTRACT, fullEvaluationPolicy: undefined } }, "CONTRACT_MISMATCH:fullEvaluationPolicy"],
      [{ required: { ...REQUIRED_CONTRACT, fullEvaluationPolicy: "hybrid-full-policy.0" } }, "CONTRACT_MISMATCH:fullEvaluationPolicy"],
      [{ approved: { ...APPROVED_HYBRID_CONTRACT, evaluationReportVersion: "packet11-eval.12" } }, "CONTRACT_MISMATCH:evaluationReportVersion"],
      [{ approved: { ...APPROVED_HYBRID_CONTRACT, fullEvaluationPolicy: undefined } }, "CONTRACT_MISMATCH:fullEvaluationPolicy"],
      // eval.18 (structural first-call validity, owner decision 2026-10-07): the eval.17 harness and hybrid-full-policy.1 are refused.
      [{ required: { ...REQUIRED_CONTRACT, harness: "packet11-eval.17" } }, "CONTRACT_MISMATCH:harness"],
      [{ required: { ...REQUIRED_CONTRACT, fullEvaluationPolicy: "hybrid-full-policy.1" } }, "CONTRACT_MISMATCH:fullEvaluationPolicy"],
      [{ approved: { ...APPROVED_HYBRID_CONTRACT, evaluationReportVersion: "packet11-eval.17" } }, "CONTRACT_MISMATCH:evaluationReportVersion"],
      [{ approved: { ...APPROVED_HYBRID_CONTRACT, fullEvaluationPolicy: "hybrid-full-policy.1" } }, "CONTRACT_MISMATCH:fullEvaluationPolicy"],
      // Packet 11C B5 contract freeze: the eval.18 harness label and the kie-schema.11b.6 label are refused.
      [{ required: { ...REQUIRED_CONTRACT, harness: "packet11-eval.18" } }, "CONTRACT_MISMATCH:harness"],
      [{ required: { ...REQUIRED_CONTRACT, providerSchema: "kie-schema.11b.6" } }, "CONTRACT_MISMATCH:providerSchema"],
      [{ approved: { ...APPROVED_HYBRID_CONTRACT, evaluationReportVersion: "packet11-eval.18" } }, "CONTRACT_MISMATCH:evaluationReportVersion"],
      [{ approved: { ...APPROVED_HYBRID_CONTRACT, providerSchemaVersion: "kie-schema.11b.6" } }, "CONTRACT_MISMATCH:providerSchemaVersion"],
      // Packet 11C Addendum C (C5): the eval.19 harness label (the earlier usage accounting) is refused.
      [{ required: { ...REQUIRED_CONTRACT, harness: "packet11-eval.19" } }, "CONTRACT_MISMATCH:harness"],
      [{ approved: { ...APPROVED_HYBRID_CONTRACT, evaluationReportVersion: "packet11-eval.19" } }, "CONTRACT_MISMATCH:evaluationReportVersion"],
    ];
    for (const [contract, expected] of cases) {
      let tracers = 0;
      await expect(runTracedFull({ fixtures, fetcher, token: SENTINEL, ceilingUsd: 1, now: NOW, onTracer: (tracer) => { tracers += 1; createdDirectories.add(tracer.directory); }, contract: contract as never }), expected).rejects.toThrow(expected);
      expect([sent, tracers], expected).toEqual([0, 0]);
    }
  });

  it("the call map refuses a count mismatch and a projection mismatch", () => {
    const fixtures = hybridFixturesForPhase("FULL");
    const [a, b] = [fixtures[0]!, fixtures[17]!];
    const call = (invocation: number, fixture: AiEvaluationFixture) => ({ invocation, sequence: invocation, refusal: null, classHash: shellInputClassHash(expectedShellInputText(fixture)!), inputSha256: hashOf(expectedShellInputText(fixture)!), upperBoundMicroUsd: 1, billedMicroUsd: 1, billedFrom: "USAGE" as const });
    const evidence = [{ fixtureId: a.id, attempts: 1 }, { fixtureId: b.id, attempts: 1 }];
    expect(mapTracedCallsToFixtures(evidence, fixtures, [call(1, a), call(2, b)])).toMatchObject({ kind: "MAPPED", invocations: 2 });
    expect(mapTracedCallsToFixtures(evidence, fixtures, [call(1, a)])).toEqual({ kind: "MISMATCH", code: "INVOCATION_COUNT", at: null });
    // Off by one: the first call attributed to the second fixture's projection.
    expect(mapTracedCallsToFixtures(evidence, fixtures, [call(1, b), call(2, a)])).toEqual({ kind: "MISMATCH", code: "PROJECTION_MISMATCH", at: 1 });
    expect(mapTracedCallsToFixtures([{ fixtureId: "p11.unknown", attempts: 1 }], fixtures, [call(1, a)])).toEqual({ kind: "MISMATCH", code: "UNKNOWN_FIXTURE", at: null });
  });
});

const env = process.env;
const LIVE = env.RUN_LIVE_HYBRID_SHELL_FULL === "1";

describe.skipIf(!LIVE)("Packet 11 hybrid shell FULL run (live, at most 140 calls)", () => {
  it(
    "runs the 70 approved traced value-blind shell fixtures against direct DeepSeek under the hard spend ceiling",
    async () => {
      // Every refusal below happens before any request.
      const mismatches = contractMismatches();
      if (mismatches.length > 0) throw new Error(`CONTRACT_MISMATCH:${mismatches.join(",")}`);
      const model = deepSeekFlash();
      if (model.endpoint !== DEEPSEEK_RESPONSES_URL || model.requestModelId !== "deepseek-flash" || model.responseModelSnapshot !== "deepseek-flash") throw new Error("MODEL_OR_ENDPOINT_NOT_APPROVED");
      const fixtures = hybridFixturesForPhase("FULL");
      if (fixtures !== PACKET_11_HYBRID_FIXTURES || fixtures.length !== FULL_FIXTURE_COUNT || new Set(fixtures.map((fixture) => fixture.id)).size !== FULL_FIXTURE_COUNT) throw new Error("FIXTURE_SELECTION");
      // Offline preflight and minima (capture-only fetcher; the real credential is not used).
      const preflight = await preflightFull(fixtures, model.requestModelId);
      const minimum = await minimumFullRunCeilingUsd(fixtures);
      const gate = liveGateRefusals(env, minimum);
      const timeouts = (["EXPLAIN_PATTERN", "DRAFT_CARE_PREPARATION_SUMMARY"] as const).map((task) => ({ task, perCallTimeoutMs: AI_HYBRID_RUNTIME_BUNDLES[task].executionBudget.perCallTimeoutMs, overallTimeoutMs: AI_HYBRID_RUNTIME_BUNDLES[task].executionBudget.overallTimeoutMs }));
      console.log(JSON.stringify({ packet11HybridFullPlan: { provider: "deepseek", endpoint: model.endpoint, model: model.requestModelId, scope: APPROVED_HYBRID_CONTRACT.approvalScope, fixtures: fixtures.length, maxCalls: FULL_MAX_CALLS, maxUsd: gate.maxUsd, minimumUsd: { oneCallEach: minimum.oneCallEach, withAllRepairs: minimum.withAllRepairs }, allowRepair: true, maxPerFixture: 2, timeouts, contract: codeContract(), preflight: { passed: preflight.filter((item) => item.passed).length, failed: preflight.filter((item) => !item.passed).map((item) => ({ fixtureId: item.fixtureId, violations: item.violations })), classes: new Set(preflight.map((item) => item.classHash)).size }, refusals: gate.refusals, warnings: gate.warnings } }));
      if (gate.refusals.length > 0 || gate.maxUsd === null) throw new Error(`FULL_RUN_REFUSED:${gate.refusals.join(",")}`);
      if (preflight.some((item) => !item.passed)) throw new Error("PREFLIGHT_NOT_VALUE_BLIND");
      const token = readDeepSeekToken(env);
      if (token.kind !== "CONFIGURED") throw new Error("DEEPSEEK_API_KEY is not configured");

      const run = await runTracedFull({ fixtures, fetcher: (url, init) => fetch(url, init), token: token.token, ceilingUsd: gate.maxUsd });
      console.log(JSON.stringify({ packet11HybridFull: run.summary }));
      expect(run.summary.harnessError).toBeNull();
      expect(run.summary.transmissions.length).toBeLessThanOrEqual(FULL_MAX_CALLS);
      expect(run.summary.spend.committedUsd).toBeLessThanOrEqual(gate.maxUsd);
      expect(run.summary.callMap?.kind).toBe("MAPPED");
      expect(run.summary.redaction).toMatchObject({ secretAbsent: true, authorizationRedacted: true, filesPrivate: true });
      expect(run.summary.hashes.mismatches).toBe(0);
      expect(run.report!.totals.calls).toBeLessThanOrEqual(FULL_MAX_CALLS);
      expect(run.report!.totals.credits).toBeLessThanOrEqual(gate.maxUsd);
    },
    60 * 60_000,
  );
});
