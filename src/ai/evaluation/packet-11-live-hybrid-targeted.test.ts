// @vitest-environment node
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { DEEPSEEK_DOCUMENTED_MODELS, DEEPSEEK_RESPONSES_URL, deepSeekCostMicroUsd, readDeepSeekToken } from "@/ai/deepseek/deepseek-catalogue";
import { createDeepSeekShellResponsesProvider } from "@/ai/deepseek/deepseek-responses-provider";
import type { KieProviderDiagnostic } from "@/ai/kie/kie-responses-provider";
import { selectEvaluationCandidates } from "@/ai/kie/kie-route-config";
import { AI_HYBRID_RUNTIME_BUNDLES, AI_HYBRID_VERSIONS } from "@/application/ai/ai-hybrid-runtime-bundles";
import type { AiShellProviderPort } from "@/application/ai/ai-provider-port";
import { defaultShells } from "@/application/ai/language/default-shells";
import { planSlots } from "@/application/ai/language/slot-planner";
import { SHELL_MAX_OUTPUT_TOKENS, SHELL_TEMPERATURE, type AiReasonCode, type ShellTask, type ShellTexts } from "@/domain/ai";
import { AI_HYBRID_EVALUATION_REPORT_VERSION, APPROVED_HYBRID_CONTRACT, evaluateHybridModelSnapshot, HYBRID_FULL_EVALUATION_POLICY, hybridLiveRunVerdict, type HybridEvaluationReport } from "./packet-11-hybrid-evaluation";
import type { AiEvaluationFixture } from "./packet-11-fixtures";
import { PACKET_11_HYBRID_FIXTURE_SET_REVISION, PACKET_11_HYBRID_FIXTURES } from "./packet-11-hybrid-fixtures";
import { buildHybridHumanReview, PACKET_11_HYBRID_REVIEW_ROOT, writeHybridHumanReview, type HumanReviewEntry, type HybridHumanReviewArtifact } from "./packet-11-hybrid-human-review";
import {
  captureShellRequestBody,
  checkHybridShellRequestBody,
  createHybridDiagnosticTracer,
  estimateMaxUsd,
  expectedShellInputText,
  mapTracedCallsToFixtures,
  minimumFullRunCeilingUsd,
  PACKET_11_HYBRID_TRACE_ROOT,
  shellInputClassHash,
  sweepShellCandidate,
  verifyTraceHashes,
  verifyTraceRedaction,
  type HybridDiagnosticTracer,
  type ShellSweep,
} from "./packet-11-hybrid-live-diagnostic";
import { shellCandidate } from "./packet-11-hybrid-test-support";

/**
 * Evaluation-only targeted EXPLAIN diagnostic runner (owner request 2026-10-07): exactly six fixed EXPLAIN fixtures, in order,
 * one call each, no repair. The offline part always runs with fake fetchers only (no network, key or spend) and writes its trace
 * and review page only under a fresh temporary root that it removes. The live part is skipped unless
 * RUN_LIVE_HYBRID_SHELL_TARGETED=1 and is refused before any request unless HYBRID_TARGETED_PROVIDER=deepseek,
 * HYBRID_TARGETED_MODEL=deepseek-flash, HYBRID_TARGETED_CONFIRM_MAX_CALLS=6, HYBRID_TARGETED_RAW_TRACE=1,
 * 0 < HYBRID_TARGETED_MAX_USD <= 0.02 and at least the summed pre-send upper bounds of the six exact bodies, DEEPSEEK_API_KEY is
 * configured, no NEXT_PUBLIC_* credential name exists, the frozen contract below equals the code and the approved contract, the
 * fixture list equals the fixed list in order and every exact body passes the offline value-blindness preflight. It prints the
 * full plan before any request, then runs the unchanged harness (phase DIAGNOSTIC: strict, it stops at the first fallback, hard
 * gate or provider issue; at most 6 calls; repair refused; spend ceiling HYBRID_TARGETED_MAX_USD) with the direct DeepSeek shell
 * provider through the repair-capable tracer in class-binding mode (maxPerFixture 1, maxTransmissions 6, hard pre-send spend
 * ceiling). Production timeouts unchanged. Prints only closed codes, counts, versions, timings, spend and paths, never model text;
 * the final user-visible wording goes only into the private review page (existing builder, owner review pending).
 */

/** The fixed list, in this order (three fixtures share task and locale, hence class binding, not task+locale binding). */
const TARGETED_IDS = Object.freeze([
  "p11.explain-pattern.en-sg.forbidden-adherence",
  "p11.explain-pattern.en-sg.forbidden-cause",
  "p11.explain-pattern.en-sg.abstention",
  "p11.explain-pattern.zh-sg.forbidden-adherence",
  "p11.explain-pattern.zh-sg.forbidden-cause",
  "p11.explain-pattern.zh-sg.abstention",
] as const);
const TARGETED_MAX_CALLS = 6;
const TARGETED_MAX_USD_LIMIT = 0.02;
const SENTINEL = "ds-SENTINEL-CREDENTIAL-3c9e71b2d4";
const NOW = () => "2026-10-07T10:00:00.000Z";
// The frozen contract (the same literals as the smoke and FULL runners: prompt 11b.17, rules r8, request 11b.11, bundles @11b.17,
// fixtures 11b.15, harness eval.16, policy hybrid-full-policy.1, caps 512/1024, temperature 0.2). The live block is not run.
// Observation ownership (packet11-eval.17, owner instruction 2026-10-07, offline only): prompt 11b.18, kie-schema.11b.6,
// ai-slot-plan.11b.8, bundle set 11b.18, fixtures 11b.16, harness eval.17 (the model writes the EXPLAIN headline and evidence; the
// application composes the observation); rules r8, the policy, request, caps and temperature are unchanged. The live block is not run.
const REQUIRED_CONTRACT = Object.freeze({
  prompt: "11b.18",
  shellRules: "ai-shell-rules.11b.15-r8",
  shellRequest: "ai-shell-request.11b.11",
  explainBundle: "ai.explain-pattern@11b.18",
  careBundle: "ai.draft-care-preparation-summary@11b.18",
  providerSchema: "kie-schema.11b.6",
  // Packet 11C phase 2 (option (a), 2026-10-08, offline): eligibility accounting only; request bodies differ only in this version field.
  slotPlan: "ai-slot-plan.11b.9",
  fixtureSet: "packet11-fixtures.11b.16",
  harness: "packet11-eval.18",
  fullEvaluationPolicy: "hybrid-full-policy.2",
  maxOutputTokens: { EXPLAIN_PATTERN: 512, DRAFT_CARE_PREPARATION_SUMMARY: 1024 },
  temperature: 0.2,
});
/**
 * The pre-send per-call upper bounds (`estimateMaxUsd` of each exact body: every byte an input token plus 256 framing tokens, the
 * full 512-token cap, peak rates; rounded up to the micro-dollar) and their sum, recomputed offline from the exact bodies below.
 */
// Observation ownership (prompt 11b.18, @11b.8): the EXPLAIN bodies carry the headline and evidence only, so every body is shorter
// (en 6,405 bytes, zh 6,470) and the bounds fall (11b.17: 0.002805 / 0.002847 / 0.002789 / 0.002817 / 0.002854 / 0.002808, sum 0.01692).
const PER_CALL_UPPER_BOUND_USD: Readonly<Record<(typeof TARGETED_IDS)[number], number>> = Object.freeze({
  "p11.explain-pattern.en-sg.forbidden-adherence": 0.002613,
  "p11.explain-pattern.en-sg.forbidden-cause": 0.002613,
  "p11.explain-pattern.en-sg.abstention": 0.002613,
  "p11.explain-pattern.zh-sg.forbidden-adherence": 0.002633,
  "p11.explain-pattern.zh-sg.forbidden-cause": 0.002633,
  "p11.explain-pattern.zh-sg.abstention": 0.002633,
});
const UPPER_BOUND_SUM_USD = 0.015738;

// ---- Offline write confinement: every trace and review file of an offline test goes under a fresh temp root -----------------
const tempRoots = new Set<string>();
afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});
/**
 * Runs `body` with the process working directory reported as a fresh temporary root (a throwaway Git repository that ignores
 * /test-results/, so the tracer's and the review writer's ignore checks hold there). Nothing is written under the project.
 */
async function inTempRoot<T>(body: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "p11-targeted-"));
  tempRoots.add(root);
  execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
  writeFileSync(join(root, ".gitignore"), "/test-results/\n");
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
  try {
    return await body(root);
  } finally {
    cwd.mockRestore();
  }
}

// ---- Contract, selection and gate (pure; closed codes) -------------------------------------------------------------------
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
/** Every contract key that differs from the frozen literal or from the approved hybrid contract (both injectable for the refusal test). */
function contractMismatches(required: FrozenContract = REQUIRED_CONTRACT, approvedContract: ApprovedContract = APPROVED_HYBRID_CONTRACT): string[] {
  const contract = codeContract();
  const literal = (Object.keys(REQUIRED_CONTRACT) as Array<keyof typeof REQUIRED_CONTRACT>).filter((key) => !same(contract[key], required[key]));
  const approved = ([["promptVersion", contract.prompt], ["shellRulesRevision", contract.shellRules], ["shellRequestVersion", contract.shellRequest], ["explainBundle", contract.explainBundle], ["careBundle", contract.careBundle], ["providerSchemaVersion", contract.providerSchema], ["slotPlanVersion", contract.slotPlan], ["fixtureSetRevision", contract.fixtureSet], ["evaluationReportVersion", contract.harness], ["fullEvaluationPolicy", contract.fullEvaluationPolicy], ["shellMaxOutputTokens", contract.maxOutputTokens], ["shellTemperature", contract.temperature], ["requestModelId", "deepseek-flash"], ["responseModelSnapshot", "deepseek-flash"], ["providerKey", "deepseek"], ["endpoint", DEEPSEEK_RESPONSES_URL], ["approvalScope", "HYBRID_SHELL_WORDING_ONLY"]] as const).filter(([key, value]) => !same(approvedContract[key], value)).map(([key]) => key);
  return [...literal, ...approved];
}

/** The six registered hybrid fixtures of the fixed list, in order. */
function targetedFixtures(): readonly AiEvaluationFixture[] {
  return TARGETED_IDS.map((id) => {
    const fixture = PACKET_11_HYBRID_FIXTURES.find((entry) => entry.id === id);
    if (!fixture) throw new Error("FIXTURE_SELECTION");
    return fixture;
  });
}
/** Null when the list is exactly the fixed list (registered fixtures, same ids, same order), else the closed refusal code. */
function fixtureSelectionRefusal(fixtures: readonly AiEvaluationFixture[]): "FIXTURE_SELECTION" | null {
  const ok = fixtures.length === TARGETED_IDS.length && fixtures.every((fixture, index) => fixture.id === TARGETED_IDS[index] && PACKET_11_HYBRID_FIXTURES.includes(fixture));
  return ok ? null : "FIXTURE_SELECTION";
}

/** The live gate (pure; closed codes). Every refusal stops the run before any request. */
function liveGateRefusals(environment: Readonly<Record<string, string | undefined>>, upperBoundSumUsd: number): { refusals: string[]; maxUsd: number | null } {
  const refusals: string[] = [];
  if (environment.HYBRID_TARGETED_PROVIDER !== "deepseek") refusals.push("HYBRID_TARGETED_PROVIDER");
  if (environment.HYBRID_TARGETED_MODEL !== "deepseek-flash") refusals.push("HYBRID_TARGETED_MODEL");
  if (environment.HYBRID_TARGETED_CONFIRM_MAX_CALLS !== String(TARGETED_MAX_CALLS)) refusals.push("HYBRID_TARGETED_CONFIRM_MAX_CALLS");
  if (environment.HYBRID_TARGETED_RAW_TRACE !== "1") refusals.push("HYBRID_TARGETED_RAW_TRACE");
  const raw = environment.HYBRID_TARGETED_MAX_USD;
  const maxUsd = raw !== undefined && /^\d+(?:\.\d+)?$/.test(raw.trim()) ? Number(raw) : Number.NaN;
  if (!Number.isFinite(maxUsd) || maxUsd <= 0 || maxUsd > TARGETED_MAX_USD_LIMIT) refusals.push("HYBRID_TARGETED_MAX_USD");
  else if (!(Number.isFinite(upperBoundSumUsd) && upperBoundSumUsd > 0) || maxUsd < upperBoundSumUsd) refusals.push("HYBRID_TARGETED_MAX_USD_BELOW_UPPER_BOUND_SUM");
  if (readDeepSeekToken(environment).kind !== "CONFIGURED") refusals.push("DEEPSEEK_API_KEY");
  if (Object.keys(environment).some((name) => name.startsWith("NEXT_PUBLIC_") && /KEY|TOKEN|SECRET/i.test(name))) refusals.push("PUBLIC_CREDENTIAL_NAME_PRESENT");
  return { refusals, maxUsd: refusals.length === 0 ? maxUsd : null };
}

/**
 * The offline value-blindness preflight of every exact body (the shared adapter's capture-only fetcher; nothing is sent and no
 * credential is used), each body's pre-send upper bound, and their sum (minimumFullRunCeilingUsd over the six, micro-dollar exact).
 */
async function preflightTargeted(fixtures: readonly AiEvaluationFixture[], model: string) {
  const items = [];
  for (const fixture of fixtures) {
    const body = await captureShellRequestBody(fixture);
    const check = body === null ? null : checkHybridShellRequestBody(fixture, body, model);
    const parsed = body === null ? null : (JSON.parse(body) as { temperature?: unknown; max_output_tokens?: unknown });
    const bodyByteCount = body === null ? null : new TextEncoder().encode(body).byteLength;
    items.push({
      fixtureId: fixture.id,
      eligible: body !== null,
      passed: check?.passed ?? false,
      violations: check?.violations ?? ["NOT_ELIGIBLE"],
      classHash: body === null ? null : shellInputClassHash(expectedShellInputText(fixture)!),
      bodyByteCount,
      maxOutputTokens: parsed?.max_output_tokens ?? null,
      temperature: parsed?.temperature ?? null,
      upperBoundUsd: bodyByteCount === null ? null : estimateMaxUsd(bodyByteCount, fixture.taskType as ShellTask).estimatedMaxUsd,
    });
  }
  const minimum = await minimumFullRunCeilingUsd(fixtures);
  return { items, upperBoundSumUsd: minimum.oneCallEach, eligible: minimum.eligibleFixtures, classes: new Set(items.map((item) => item.classHash)).size };
}

// ---- Fake DeepSeek responses (offline only) -------------------------------------------------------------------------------
type FakeKind = "DEFAULT" | "BROKEN_JSON" | "SHORT_HEADLINE" | "TRUNCATED" | "NEAR_MAX_USAGE";
type Step = Readonly<{ fixture: AiEvaluationFixture; kind: FakeKind }>;
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
  const bytes = new TextEncoder().encode(bodyText).byteLength;
  const cap = SHELL_MAX_OUTPUT_TOKENS[step.fixture.taskType as ShellTask];
  switch (step.kind) {
    case "DEFAULT":
      return envelope(candidateText(step.fixture));
    case "BROKEN_JSON":
      return envelope("{\"schemaVersion\":");
    case "SHORT_HEADLINE":
      // A one-word filler headline around the headline token: rejected at the r4 wording gate (S7b).
      return envelope(candidateText(step.fixture, { headline: "See {{S1}}." }));
    case "TRUNCATED":
      return envelope("{\"schemaVersion\":\"ai-shell.", { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 1600, output_tokens: cap } });
    case "NEAR_MAX_USAGE":
      // Adversarial but completed: every byte a token plus framing, one below the cap.
      return envelope(candidateText(step.fixture), { usage: { input_tokens: bytes + 256, output_tokens: cap - 1 } });
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
    const input = (JSON.parse(bodyText) as { input: Array<{ content: Array<{ text: string }> }> }).input[0]!.content[0]!.text;
    if (input !== expectedShellInputText(step.fixture)) state.projectionMismatches += 1;
    // The request record is on disk before the transmission happens.
    if (tracer && tracer.files().some((file) => file.endsWith(`${String(state.sent).padStart(3, "0")}-${shellInputClassHash(input)}-call.request.json`))) state.requestFileWrittenFirst += 1;
    return fakeResponse(step, bodyText);
  };
  return { state, fetcher, bind: (value: HybridDiagnosticTracer) => void (tracer = value) };
}
const stepsFor = (fixtures: readonly AiEvaluationFixture[], plan: Readonly<Record<string, FakeKind>> = {}): Step[] => fixtures.map((fixture) => ({ fixture, kind: plan[fixture.id] ?? "DEFAULT" }));

// ---- The shared targeted run (offline with fakes, live with fetch) --------------------------------------------------------
type Invocation = { completed: boolean; candidate: unknown };
/** Walks the sequential harness attempts in evidence order: the provider invocation index of each (fixture, attempt). */
function attemptsOf(evidence: HybridEvaluationReport["fixtures"], fixtures: readonly AiEvaluationFixture[]) {
  const out: Array<{ fixture: AiEvaluationFixture; attempt: number; invocation: number }> = [];
  for (const item of evidence) {
    const fixture = fixtures.find((entry) => entry.id === item.fixtureId)!;
    for (let attempt = 1; attempt <= item.attempts; attempt += 1) out.push({ fixture, attempt, invocation: out.length });
  }
  return out;
}
/** The final user-visible output of each fixture: the accepted candidate (its last attempt) or the fallback's closed codes. */
function reviewEntries(evidence: HybridEvaluationReport["fixtures"], fixtures: readonly AiEvaluationFixture[], invocations: readonly Invocation[]): HumanReviewEntry[] {
  const entries: HumanReviewEntry[] = [];
  let index = 0;
  for (const item of evidence) {
    const fixture = fixtures.find((entry) => entry.id === item.fixtureId)!;
    const last = invocations[index + item.attempts - 1];
    if (item.source === "AI" && item.attempts > 0 && last?.completed) entries.push({ fixture, candidate: last.candidate });
    else if (item.source !== "AI") entries.push({ fixture, fallback: { gate: item.safeShellFallback?.gate ?? item.firstRejectedGate ?? null, reason: item.reasonCode as AiReasonCode } });
    index += item.attempts;
  }
  return entries;
}
async function runTracedTargeted(options: {
  fetcher: (url: string, init: RequestInit) => Promise<Response>;
  token: string;
  ceilingUsd: number;
  fixtures?: readonly AiEvaluationFixture[];
  now?: () => string;
  onTracer?: (tracer: HybridDiagnosticTracer) => void;
  contract?: Readonly<{ required?: FrozenContract; approved?: ApprovedContract }>;
}) {
  // Every refusal here happens before the tracer (and so any request) exists.
  const mismatches = contractMismatches(options.contract?.required, options.contract?.approved);
  if (mismatches.length > 0) throw new Error(`CONTRACT_MISMATCH:${mismatches.join(",")}`);
  const fixtures = options.fixtures ?? targetedFixtures();
  const selection = fixtureSelectionRefusal(fixtures);
  if (selection) throw new Error(selection);
  const { ceilingUsd } = options;
  if (!(Number.isFinite(ceilingUsd) && ceilingUsd > 0 && ceilingUsd <= TARGETED_MAX_USD_LIMIT)) throw new Error("TARGETED_CEILING_OUT_OF_RANGE");
  const now = options.now ?? (() => new Date().toISOString());
  const model = deepSeekFlash();
  const tracer = await createHybridDiagnosticTracer({ fixtures, expectedModel: model.requestModelId, maxTransmissions: TARGETED_MAX_CALLS, maxPerFixture: 1, ceilingUsd, fetcher: options.fetcher, now });
  options.onTracer?.(tracer);
  let lastDiagnostic: KieProviderDiagnostic | null = null;
  const diagnostics: Array<Record<string, unknown>> = [];
  const inner = createDeepSeekShellResponsesProvider({ token: options.token, model, fetcher: tracer.fetcher, onDiagnostic: (diagnostic) => {
    lastDiagnostic = diagnostic;
    diagnostics.push({ code: diagnostic.code, parserStage: diagnostic.parserStage, httpStatus: diagnostic.httpStatus, retention: diagnostic.retention, modelComparison: diagnostic.modelIdentity?.comparison ?? null, reportedUsage: diagnostic.reportedUsage });
  } });
  // Candidates stay in memory only (for the sweep and the review page); they are never printed or written to the analysis record.
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
    report = await evaluateHybridModelSnapshot({ model, provider, fixtures, phase: "DIAGNOSTIC", limits: { maxCalls: TARGETED_MAX_CALLS, maxCredits: ceilingUsd, allowRepair: false }, takeDiagnostic, now });
  } catch {
    harnessError = "HARNESS_THREW";
  }
  const fixtureIds = fixtures.map((fixture) => fixture.id);
  const callMap = report ? mapTracedCallsToFixtures(report.fixtures, fixtures, tracer.calls()) : null;
  await tracer.record("99-call-map.json", { kind: "CALL_MAP", callMap });
  // One sweep per completed call (closed codes and counts only), located through the same sequential attempt walk.
  const sweeps: Array<{ fixtureId: string; attempt: number; sweep: ShellSweep }> = [];
  if (report && callMap?.kind === "MAPPED") {
    for (const { fixture, attempt, invocation } of attemptsOf(report.fixtures, fixtures)) {
      const slot = invocations[invocation];
      if (slot?.completed) sweeps.push({ fixtureId: fixture.id, attempt, sweep: sweepShellCandidate(fixture, slot.candidate) });
    }
  }
  let review: HybridHumanReviewArtifact | null = null;
  let reviewPath: string | null = null;
  if (report && callMap?.kind === "MAPPED") {
    review = buildHybridHumanReview(reviewEntries(report.fixtures, fixtures, invocations), { generatedAt: now() });
    reviewPath = (await writeHybridHumanReview(review, { now })).path;
  }
  const verdict = report ? hybridLiveRunVerdict(report, { phase: "DIAGNOSTIC", fixtureIds, maxCalls: TARGETED_MAX_CALLS }, { maxCredits: ceilingUsd, requestModelId: APPROVED_HYBRID_CONTRACT.requestModelId, responseModelSnapshot: APPROVED_HYBRID_CONTRACT.responseModelSnapshot }, null) : null;
  const transmissions = tracer.transmissions();
  const reviewSummary = review ? { path: reviewPath, perLocale: review.perLocale, included: review.included, fallbacks: review.fallbacks, fallbackPerLocale: review.fallbackPerLocale, excluded: review.excluded, exclusions: review.exclusions, ownerReview: "PENDING" as const } : null;
  await tracer.record("99-analysis.json", { kind: "ANALYSIS", transmissions, diagnostics, spend: tracer.spend(), traceFailure: tracer.failure(), report, sweeps, verdict, review: reviewSummary, harnessError });
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
      completed: report?.completed ?? null,
      languagePresence: report?.languagePresence ?? null,
      fixtures: report?.fixtures ?? null,
      sweeps,
      verdict,
      redaction,
      hashes,
      review: reviewSummary,
      trace: { directory: relative(process.cwd(), resolve(tracer.directory)), files: tracer.files().length },
    },
  };
}
const headers = { authorization: `Bearer ${SENTINEL}`, "content-type": "application/json", accept: "application/json" };
const microOf = (usd: number) => Math.round(usd * 1_000_000);
const bodyBytes = async (fixture: AiEvaluationFixture) => new TextEncoder().encode((await captureShellRequestBody(fixture))!).byteLength;
const upperMicro = async (fixture: AiEvaluationFixture) => microOf(estimateMaxUsd(await bodyBytes(fixture), fixture.taskType as ShellTask).estimatedMaxUsd);
/** The real project root, read before any temp-root redirection. */
const PROJECT_ROOT = process.cwd();
/** Every given relative path lies under the temp root's trace or review root and none exists under the project. */
function confinedToTempRoot(root: string, paths: readonly string[]): boolean {
  return paths.every((path) => {
    const inTemp = resolve(root, path);
    const underRoots = [PACKET_11_HYBRID_TRACE_ROOT, PACKET_11_HYBRID_REVIEW_ROOT].some((base) => inTemp.startsWith(`${resolve(root, base)}/`));
    return underRoots && existsSync(inTemp) && !existsSync(resolve(PROJECT_ROOT, path));
  });
}

describe("Packet 11 hybrid shell targeted EXPLAIN diagnostic runner (offline)", () => {
  it("the required contract literal equals the current code pins and the approved contract", () => {
    expect(same(REQUIRED_CONTRACT, codeContract())).toBe(true);
    expect(contractMismatches()).toEqual([]);
    expect(APPROVED_HYBRID_CONTRACT).toMatchObject({ requestModelId: "deepseek-flash", responseModelSnapshot: "deepseek-flash", providerKey: "deepseek", endpoint: "https://api.deepseek.com/responses", approvalScope: "HYBRID_SHELL_WORDING_ONLY", shellTemperature: 0.2 });
    expect(deepSeekFlash()).toMatchObject({ requestModelId: "deepseek-flash", responseModelSnapshot: "deepseek-flash", endpoint: DEEPSEEK_RESPONSES_URL });
  });

  it("the fixed list is exactly the six registered EXPLAIN fixtures in order; any other list is refused before any request", async () => {
    expect([...TARGETED_IDS]).toEqual([
      "p11.explain-pattern.en-sg.forbidden-adherence",
      "p11.explain-pattern.en-sg.forbidden-cause",
      "p11.explain-pattern.en-sg.abstention",
      "p11.explain-pattern.zh-sg.forbidden-adherence",
      "p11.explain-pattern.zh-sg.forbidden-cause",
      "p11.explain-pattern.zh-sg.abstention",
    ]);
    const fixtures = targetedFixtures();
    expect(fixtures.map((fixture) => [fixture.id, fixture.taskType, fixture.locale])).toEqual(TARGETED_IDS.map((id, index) => [id, "EXPLAIN_PATTERN", index < 3 ? "en-SG" : "zh-SG"]));
    expect(fixtures.every((fixture) => PACKET_11_HYBRID_FIXTURES.includes(fixture))).toBe(true);
    expect(fixtureSelectionRefusal(fixtures)).toBeNull();
    const ordinary = PACKET_11_HYBRID_FIXTURES.find((fixture) => fixture.id === "p11.explain-pattern.en-sg.ordinary")!;
    const wrong: ReadonlyArray<readonly AiEvaluationFixture[]> = [
      [fixtures[1]!, fixtures[0]!, ...fixtures.slice(2)],
      fixtures.slice(0, 5),
      [...fixtures, ordinary],
      [ordinary, ...fixtures.slice(1)],
      [fixtures[0]!, fixtures[0]!, ...fixtures.slice(2)],
      [...fixtures].reverse(),
      // A structurally equal copy that is not the registered fixture object.
      [structuredClone(fixtures[0]!), ...fixtures.slice(1)],
    ];
    // Under a temp root, so that even a regression that let a run start would write nothing under the project.
    await inTempRoot(async () => {
      for (const list of wrong) {
        expect(fixtureSelectionRefusal(list)).toBe("FIXTURE_SELECTION");
        let sent = 0;
        let tracers = 0;
        await expect(runTracedTargeted({ fixtures: list, fetcher: async () => { sent += 1; return envelope("{}"); }, token: SENTINEL, ceilingUsd: 0.02, now: NOW, onTracer: () => void (tracers += 1) })).rejects.toThrow("FIXTURE_SELECTION");
        expect([sent, tracers]).toEqual([0, 0]);
      }
    });
  });

  it("every exact body passes the value-blindness preflight with cap 512 and temperature 0.2; the per-call upper bounds sum within USD 0.02", async () => {
    const fixtures = targetedFixtures();
    const preflight = await preflightTargeted(fixtures, "deepseek-flash");
    expect(preflight.items.map((item) => [item.fixtureId, item.eligible, item.passed, item.violations, item.maxOutputTokens, item.temperature])).toEqual(TARGETED_IDS.map((id) => [id, true, true, [], 512, 0.2]));
    // Observation ownership: four distinct value-blind projections. Per locale, adherence and abstention now send byte-identical
    // requests (headline S1 + evidence S4; the observation is never sent), so their class holds two listed fixtures and maxPerFixture 1
    // allows two sends of that body; forbidden-cause (evidence S5) is its own class. Six sends in all.
    expect(preflight.classes).toBe(4);
    const classOf = Object.fromEntries(preflight.items.map((item) => [item.fixtureId, item.classHash]));
    for (const locale of ["en-sg", "zh-sg"]) {
      expect(classOf[`p11.explain-pattern.${locale}.forbidden-adherence`]).toBe(classOf[`p11.explain-pattern.${locale}.abstention`]);
      expect(classOf[`p11.explain-pattern.${locale}.forbidden-cause`]).not.toBe(classOf[`p11.explain-pattern.${locale}.abstention`]);
    }
    expect(preflight.eligible).toBe(6);
    expect(Object.fromEntries(preflight.items.map((item) => [item.fixtureId, item.upperBoundUsd]))).toEqual(PER_CALL_UPPER_BOUND_USD);
    const sumMicro = Object.values(PER_CALL_UPPER_BOUND_USD).reduce((sum, usd) => sum + microOf(usd), 0);
    expect(preflight.upperBoundSumUsd).toBe(sumMicro / 1_000_000);
    expect(preflight.upperBoundSumUsd).toBe(UPPER_BOUND_SUM_USD);
    expect(UPPER_BOUND_SUM_USD).toBeLessThanOrEqual(TARGETED_MAX_USD_LIMIT);
    for (const fixture of fixtures) expect(await upperMicro(fixture), fixture.id).toBe(microOf(PER_CALL_UPPER_BOUND_USD[fixture.id as (typeof TARGETED_IDS)[number]]));
  });

  it("the live gate refuses before any request unless every condition holds", () => {
    // A synthetic environment object only: no real credential is read.
    const ok = { HYBRID_TARGETED_PROVIDER: "deepseek", HYBRID_TARGETED_MODEL: "deepseek-flash", HYBRID_TARGETED_CONFIRM_MAX_CALLS: "6", HYBRID_TARGETED_RAW_TRACE: "1", HYBRID_TARGETED_MAX_USD: "0.02", DEEPSEEK_API_KEY: SENTINEL };
    expect(liveGateRefusals(ok, UPPER_BOUND_SUM_USD)).toEqual({ refusals: [], maxUsd: 0.02 });
    expect(liveGateRefusals({ ...ok, HYBRID_TARGETED_MAX_USD: String(UPPER_BOUND_SUM_USD) }, UPPER_BOUND_SUM_USD)).toEqual({ refusals: [], maxUsd: UPPER_BOUND_SUM_USD });
    expect(liveGateRefusals({ ...ok, HYBRID_TARGETED_MAX_USD: "0.015737" }, UPPER_BOUND_SUM_USD).refusals).toEqual(["HYBRID_TARGETED_MAX_USD_BELOW_UPPER_BOUND_SUM"]);
    expect(liveGateRefusals({ ...ok, HYBRID_TARGETED_MAX_USD: "0.01" }, UPPER_BOUND_SUM_USD).refusals).toEqual(["HYBRID_TARGETED_MAX_USD_BELOW_UPPER_BOUND_SUM"]);
    expect(liveGateRefusals(ok, Number.NaN).refusals).toEqual(["HYBRID_TARGETED_MAX_USD_BELOW_UPPER_BOUND_SUM"]);
    for (const value of ["0", "-1", "abc", "", "1e-2", "NaN", "Infinity", "0.020001", "0.03", "1"]) expect(liveGateRefusals({ ...ok, HYBRID_TARGETED_MAX_USD: value }, UPPER_BOUND_SUM_USD).refusals, value).toEqual(["HYBRID_TARGETED_MAX_USD"]);
    expect(liveGateRefusals({ ...ok, HYBRID_TARGETED_PROVIDER: "kie" }, UPPER_BOUND_SUM_USD).refusals).toEqual(["HYBRID_TARGETED_PROVIDER"]);
    expect(liveGateRefusals({ ...ok, HYBRID_TARGETED_MODEL: "deepseek-chat" }, UPPER_BOUND_SUM_USD).refusals).toEqual(["HYBRID_TARGETED_MODEL"]);
    for (const value of ["5", "7", "140", "06"]) expect(liveGateRefusals({ ...ok, HYBRID_TARGETED_CONFIRM_MAX_CALLS: value }, UPPER_BOUND_SUM_USD).refusals, value).toEqual(["HYBRID_TARGETED_CONFIRM_MAX_CALLS"]);
    expect(liveGateRefusals({ ...ok, HYBRID_TARGETED_RAW_TRACE: "0" }, UPPER_BOUND_SUM_USD).refusals).toEqual(["HYBRID_TARGETED_RAW_TRACE"]);
    expect(liveGateRefusals({ ...ok, DEEPSEEK_API_KEY: " " }, UPPER_BOUND_SUM_USD).refusals).toEqual(["DEEPSEEK_API_KEY"]);
    expect(liveGateRefusals({ ...ok, NEXT_PUBLIC_DEEPSEEK_API_KEY: "x" }, UPPER_BOUND_SUM_USD).refusals).toEqual(["PUBLIC_CREDENTIAL_NAME_PRESENT"]);
    expect(liveGateRefusals({}, UPPER_BOUND_SUM_USD).refusals).toEqual(["HYBRID_TARGETED_PROVIDER", "HYBRID_TARGETED_MODEL", "HYBRID_TARGETED_CONFIRM_MAX_CALLS", "HYBRID_TARGETED_RAW_TRACE", "HYBRID_TARGETED_MAX_USD", "DEEPSEEK_API_KEY"]);
  });

  it("six-call maximum: the tracer sends each fixture's body once and refuses a seventh call unsent", async () => {
    await inTempRoot(async (root) => {
      const fixtures = targetedFixtures();
      const script = scriptedFetcher([...stepsFor(fixtures), ...stepsFor(fixtures)]);
      const tracer = await createHybridDiagnosticTracer({ fixtures, expectedModel: "deepseek-flash", maxTransmissions: TARGETED_MAX_CALLS, maxPerFixture: 1, ceilingUsd: 0.02, now: NOW, fetcher: script.fetcher });
      script.bind(tracer);
      expect(resolve(tracer.directory).startsWith(resolve(root, PACKET_11_HYBRID_TRACE_ROOT))).toBe(true);
      for (const fixture of fixtures) expect((await tracer.fetcher(DEEPSEEK_RESPONSES_URL, { method: "POST", headers, body: (await captureShellRequestBody(fixture))! })).status, fixture.id).toBe(200);
      await expect(tracer.fetcher(DEEPSEEK_RESPONSES_URL, { method: "POST", headers, body: (await captureShellRequestBody(fixtures[0]!))! })).rejects.toThrow("TRACE_CALL_LIMIT");
      expect([script.state.sent, script.state.projectionMismatches, script.state.requestFileWrittenFirst]).toEqual([6, 0, 6]);
      expect(tracer.calls().map((call) => [call.invocation, call.sequence, call.refusal])).toEqual([[1, 1, null], [2, 2, null], [3, 3, null], [4, 4, null], [5, 5, null], [6, 6, null], [7, null, "TRACE_CALL_LIMIT"]]);
      expect(tracer.files()).toHaveLength(12);
      expect(confinedToTempRoot(root, tracer.files())).toBe(true);
      // A repeated fixture (same class, per-class limit 1 x 1) is refused unsent even below the total.
      const again = scriptedFetcher(stepsFor(fixtures));
      const second = await createHybridDiagnosticTracer({ fixtures, expectedModel: "deepseek-flash", maxTransmissions: TARGETED_MAX_CALLS, maxPerFixture: 1, ceilingUsd: 0.02, now: NOW, fetcher: again.fetcher });
      const body = (await captureShellRequestBody(fixtures[1]!))!;
      await second.fetcher(DEEPSEEK_RESPONSES_URL, { method: "POST", headers, body });
      await expect(second.fetcher(DEEPSEEK_RESPONSES_URL, { method: "POST", headers, body })).rejects.toThrow("TRACE_CALL_LIMIT");
      expect(again.state.sent).toBe(1);
      // Observation ownership: the shared class (en adherence and abstention, byte-identical bodies) admits exactly two sends of it.
      const shared = scriptedFetcher(stepsFor([fixtures[0]!, fixtures[2]!]));
      const third = await createHybridDiagnosticTracer({ fixtures, expectedModel: "deepseek-flash", maxTransmissions: TARGETED_MAX_CALLS, maxPerFixture: 1, ceilingUsd: 0.02, now: NOW, fetcher: shared.fetcher });
      const sharedBody = (await captureShellRequestBody(fixtures[0]!))!;
      expect(sharedBody).toBe((await captureShellRequestBody(fixtures[2]!))!);
      await third.fetcher(DEEPSEEK_RESPONSES_URL, { method: "POST", headers, body: sharedBody });
      await third.fetcher(DEEPSEEK_RESPONSES_URL, { method: "POST", headers, body: sharedBody });
      await expect(third.fetcher(DEEPSEEK_RESPONSES_URL, { method: "POST", headers, body: sharedBody })).rejects.toThrow("TRACE_CALL_LIMIT");
      expect(shared.state.sent).toBe(2);
      // More than six transmissions cannot even be configured over the six listed fixtures with one send each.
      await expect(createHybridDiagnosticTracer({ fixtures, expectedModel: "deepseek-flash", maxTransmissions: 7, maxPerFixture: 1, ceilingUsd: 0.02, now: NOW, fetcher: again.fetcher })).rejects.toThrow("TRACE_CALL_LIMIT");
    });
  });

  it("pre-send spend refusal: a ceiling below the first upper bound sends nothing; a low ceiling stops before overspending", async () => {
    const fixtures = targetedFixtures();
    const upper = await Promise.all(fixtures.map(upperMicro));
    const nearMax = await Promise.all(fixtures.map(async (fixture) => deepSeekCostMicroUsd((await bodyBytes(fixture)) + 256, SHELL_MAX_OUTPUT_TOKENS.EXPLAIN_PATTERN - 1)));
    await inTempRoot(async () => {
      // (a) One micro-dollar short of the first call's upper bound: refused before any write or send.
      const none = scriptedFetcher(stepsFor(fixtures));
      const first = await runTracedTargeted({ fetcher: none.fetcher, token: SENTINEL, ceilingUsd: (upper[0]! - 1) / 1_000_000, now: NOW, onTracer: none.bind });
      expect(none.state.sent).toBe(0);
      expect(first.summary.traceFailure).toBe("TRACE_SPEND_CEILING");
      expect(first.summary.spend).toMatchObject({ committedUsd: 0, inFlightUsd: 0, settledCalls: 0 });
      expect(first.report!.fixtures).toHaveLength(1);
      expect(first.report!.fixtures[0]).toMatchObject({ source: "DETERMINISTIC", reasonCode: "TRANSPORT_FAILED", responseAvailability: "NO_RESPONSE" });
      expect(first.report!.stoppedReason).toBe("UNEXPECTED_PROVIDER_BEHAVIOUR");
      expect(first.summary.callMap).toMatchObject({ kind: "MAPPED", invocations: 1, transmissions: 0, refused: [{ invocation: 1, fixtureId: TARGETED_IDS[0], attempt: 1, refusal: "TRACE_SPEND_CEILING" }] });
      expect(first.tracer.files().filter((file) => /-call\.(request|response)\.json$/.test(file))).toEqual([]);
      expect(first.summary.verdict).toMatchObject({ kind: "FAIL" });

      // (b) Room for two near-max calls, one micro-dollar short of the third call's upper bound.
      const ceilingMicro = nearMax[0]! + nearMax[1]! + upper[2]! - 1;
      const low = scriptedFetcher(fixtures.map((fixture) => ({ fixture, kind: "NEAR_MAX_USAGE" as const })));
      const run = await runTracedTargeted({ fetcher: low.fetcher, token: SENTINEL, ceilingUsd: ceilingMicro / 1_000_000, now: NOW, onTracer: low.bind });
      expect(low.state.sent).toBe(2);
      expect(run.summary.traceFailure).toBe("TRACE_SPEND_CEILING");
      expect(microOf(run.summary.spend.committedUsd)).toBe(nearMax[0]! + nearMax[1]!);
      expect(microOf(run.summary.spend.committedUsd)).toBeLessThanOrEqual(ceilingMicro);
      // Tight: the refused call's upper bound would have crossed the ceiling.
      expect(microOf(run.summary.spend.committedUsd) + upper[2]!).toBeGreaterThan(ceilingMicro);
      expect(run.report!.fixtures.map((item) => [item.fixtureId, item.source])).toEqual([[TARGETED_IDS[0], "AI"], [TARGETED_IDS[1], "AI"], [TARGETED_IDS[2], "DETERMINISTIC"]]);
      expect(run.report!.stoppedReason).toBe("UNEXPECTED_PROVIDER_BEHAVIOUR");
      expect(run.summary.callMap).toMatchObject({ kind: "MAPPED", invocations: 3, transmissions: 2, refused: [{ invocation: 3, fixtureId: TARGETED_IDS[2], attempt: 1, refusal: "TRACE_SPEND_CEILING" }] });
      expect(run.tracer.files().filter((file) => /-call\.(request|response)\.json$/.test(file))).toHaveLength(4);
      expect(run.summary.hashes).toMatchObject({ requestsVerified: 2, responsesVerified: 2, mismatches: 0 });
      expect(run.summary.verdict!.kind === "FAIL" && run.summary.verdict!.failures).toEqual(expect.arrayContaining(["NOT_COMPLETED", "STOPPED:UNEXPECTED_PROVIDER_BEHAVIOUR", "FIXTURE_SET", "CALL_COUNT"]));
    });
  }, 60_000);

  it.each([
    ["BROKEN_JSON", "S1", "SCHEMA_INVALID", "SMOKE_FALLBACK"],
    ["SHORT_HEADLINE", "S7b", "OUTPUT_BUDGET_EXCEEDED", "SMOKE_FALLBACK"],
    ["TRUNCATED", null, "PROVIDER_FAILED", "UNEXPECTED_PROVIDER_BEHAVIOUR"],
  ] as const)("strict stopping: a %s fallback at fixture 2 stops the run; later fixtures are never sent", async (kind, gate, reasonCode, stoppedReason) => {
    const fixtures = targetedFixtures();
    await inTempRoot(async () => {
      const script = scriptedFetcher(stepsFor(fixtures, { [TARGETED_IDS[1]]: kind }));
      const run = await runTracedTargeted({ fetcher: script.fetcher, token: SENTINEL, ceilingUsd: UPPER_BOUND_SUM_USD, now: NOW, onTracer: script.bind });
      expect(run.summary.harnessError).toBeNull();
      // The structural failure is not repaired (allowRepair false: the harness refuses the repair before the provider).
      expect([script.state.sent, script.state.projectionMismatches]).toEqual([2, 0]);
      expect(run.report).toMatchObject({ completed: false, totals: { fixtures: 2, calls: 2, repairs: 0 } });
      expect(run.report!.fixtures[0]).toMatchObject({ fixtureId: TARGETED_IDS[0], source: "AI", outcome: "ACCEPTED" });
      expect(run.report!.fixtures[1]).toMatchObject({ fixtureId: TARGETED_IDS[1], source: "DETERMINISTIC", outcome: "FALLBACK", attempts: 1, firstRejectedGate: gate, reasonCode, hardGateFailure: false, safeShellFallback: null });
      expect(run.report!.stoppedReason).toBe(stoppedReason);
      expect(run.summary.callMap).toMatchObject({ kind: "MAPPED", invocations: 2, transmissions: 2, refused: [] });
      expect(run.summary.sweeps.map((item) => [item.fixtureId, item.sweep.authoritative.verdict])).toEqual(kind === "TRUNCATED" ? [[TARGETED_IDS[0], "ACCEPTED"]] : [[TARGETED_IDS[0], "ACCEPTED"], [TARGETED_IDS[1], "REJECTED"]]);
      expect(run.summary.verdict!.kind === "FAIL" && run.summary.verdict!.failures).toEqual(expect.arrayContaining(["NOT_COMPLETED", `STOPPED:${run.report!.stoppedReason}`, "FIXTURE_SET", "CALL_COUNT", "FIXTURE_NOT_ACCEPTED"]));
      expect(run.summary.review).toMatchObject({ included: 1, fallbacks: 1, excluded: 0 });
      expect(run.summary.redaction).toMatchObject({ secretAbsent: true, authorizationRedacted: true, filesPrivate: true });
      expect(run.summary.hashes).toMatchObject({ requestsVerified: 2, responsesVerified: 2, mismatches: 0 });
    });
  }, 60_000);

  it("a contract mismatch is refused before any request (no tracer, nothing sent)", async () => {
    expect(contractMismatches()).toEqual([]);
    let sent = 0;
    const fetcher = async () => {
      sent += 1;
      return envelope("{}");
    };
    const cases: ReadonlyArray<readonly [Readonly<{ required?: Record<string, unknown>; approved?: Record<string, unknown> }>, string]> = [
      [{ required: { ...REQUIRED_CONTRACT, prompt: "11b.16" } }, "CONTRACT_MISMATCH:prompt"],
      [{ required: { ...REQUIRED_CONTRACT, harness: "packet11-eval.15" } }, "CONTRACT_MISMATCH:harness"],
      [{ required: { ...REQUIRED_CONTRACT, temperature: 0.3 } }, "CONTRACT_MISMATCH:temperature"],
      [{ required: { ...REQUIRED_CONTRACT, maxOutputTokens: { EXPLAIN_PATTERN: 1024, DRAFT_CARE_PREPARATION_SUMMARY: 1024 } } }, "CONTRACT_MISMATCH:maxOutputTokens"],
      [{ approved: { ...APPROVED_HYBRID_CONTRACT, requestModelId: "deepseek-pro" } }, "CONTRACT_MISMATCH:requestModelId"],
      [{ approved: { ...APPROVED_HYBRID_CONTRACT, endpoint: "https://api.deepseek.com/chat/completions" } }, "CONTRACT_MISMATCH:endpoint"],
      [{ approved: { ...APPROVED_HYBRID_CONTRACT, approvalScope: "UNRESTRICTED" } }, "CONTRACT_MISMATCH:approvalScope"],
    ];
    // Under a temp root, so that even a regression that let a run start would write nothing under the project.
    await inTempRoot(async () => {
      for (const [contract, expected] of cases) {
        let tracers = 0;
        await expect(runTracedTargeted({ fetcher, token: SENTINEL, ceilingUsd: 0.02, now: NOW, onTracer: () => void (tracers += 1), contract: contract as never }), expected).rejects.toThrow(expected);
        expect([sent, tracers], expected).toEqual([0, 0]);
      }
      for (const ceilingUsd of [0, -1, 0.021, Number.NaN, Number.POSITIVE_INFINITY]) {
        let tracers = 0;
        await expect(runTracedTargeted({ fetcher, token: SENTINEL, ceilingUsd, now: NOW, onTracer: () => void (tracers += 1) }), String(ceilingUsd)).rejects.toThrow("TARGETED_CEILING_OUT_OF_RANGE");
        expect(tracers).toBe(0);
      }
    });
    expect(sent).toBe(0);
  });

  it("a full fake run of six accepted responses through the real harness and tracer: DIAGNOSTIC PASS, sweeps, call map, hashes, review page", async () => {
    const fixtures = targetedFixtures();
    await inTempRoot(async (root) => {
      const script = scriptedFetcher(stepsFor(fixtures));
      // The minimum ceiling the live gate allows: the summed per-call upper bounds.
      const run = await runTracedTargeted({ fetcher: script.fetcher, token: SENTINEL, ceilingUsd: UPPER_BOUND_SUM_USD, now: NOW, onTracer: script.bind });
      const { summary } = run;
      expect(summary.harnessError).toBeNull();
      expect([script.state.sent, script.state.projectionMismatches, script.state.requestFileWrittenFirst]).toEqual([6, 0, 6]);
      expect(run.report).toMatchObject({ phase: "DIAGNOSTIC", completed: true, stoppedReason: null, hardGatePassed: true, totals: { fixtures: 6, calls: 6, repairs: 0 }, limits: { maxCalls: 6, maxCredits: UPPER_BOUND_SUM_USD, allowRepair: false } });
      expect(run.report!.fixtures.map((item) => [item.fixtureId, item.source, item.outcome, item.attempts, item.atomEqual, item.firstCallValid])).toEqual(TARGETED_IDS.map((id) => [id, "AI", "ACCEPTED", 1, true, true]));
      // The DIAGNOSTIC verdict needs no owner review record: a clean run passes with no failure code.
      expect(summary.verdict).toEqual({ kind: "PASS" });
      expect(summary.callMap).toMatchObject({ kind: "MAPPED", invocations: 6, transmissions: 6, refused: [] });
      expect(summary.callMap!.kind === "MAPPED" && summary.callMap!.entries.map((entry) => [entry.sequence, entry.fixtureId, entry.attempt])).toEqual(TARGETED_IDS.map((id, index) => [index + 1, id, 1]));
      expect(summary.sweeps.map((item) => [item.fixtureId, item.attempt, item.sweep.authoritative.verdict, item.sweep.assembly, item.sweep.r7, item.sweep.atomEqual])).toEqual(TARGETED_IDS.map((id) => [id, 1, "ACCEPTED", "ASSEMBLED", "ACCEPTED", true]));
      expect(summary.spend).toMatchObject({ settledCalls: 6, billedFromUsage: 6, billedFromUpperBound: 0, inFlightUsd: 0 });
      expect(microOf(summary.spend.committedUsd)).toBe(6 * deepSeekCostMicroUsd(1500, 120));
      expect(summary.traceFailure).toBeNull();
      // Each send is checked against every member of its class: 2 + 1 + 2 per locale (observation ownership: two shared classes).
      expect(summary.presendChecks).toEqual({ total: 10, failed: 0 });
      // The runner's tracer allows six transmissions in all: a seventh (any listed body) is refused unsent.
      await expect(run.tracer.fetcher(DEEPSEEK_RESPONSES_URL, { method: "POST", headers, body: (await captureShellRequestBody(fixtures[0]!))! })).rejects.toThrow("TRACE_CALL_LIMIT");
      expect(script.state.sent).toBe(6);
      // 6 request + 6 response records, the call map and the analysis record.
      expect(summary.redaction).toEqual({ filesChecked: 14, secretAbsent: true, authorizationRedacted: true, filesPrivate: true });
      expect(summary.hashes).toEqual({ filesChecked: 14, requestsVerified: 6, responsesVerified: 6, mismatches: 0 });
      // Review page: final wording only, AI vs atoms marked, owner review pending; written under the temp root only.
      expect(summary.review).toMatchObject({ included: 6, fallbacks: 0, excluded: 0, ownerReview: "PENDING", perLocale: { "en-SG": { included: 3 }, "zh-SG": { included: 3 } } });
      const pagePath = resolve(root, summary.review!.path!);
      expect(pagePath.startsWith(resolve(root, PACKET_11_HYBRID_REVIEW_ROOT))).toBe(true);
      const page = await readFile(pagePath, "utf8");
      for (const id of TARGETED_IDS) expect(page, id).toContain(`data-fixture-id="${id}"`);
      expect(page).toMatch(/class="ai"/);
      expect(page).toMatch(/class="fact"/);
      expect(page).not.toContain(SENTINEL);
      expect(page).not.toMatch(/\{\{|\}\}/);
      // Nothing printed or recorded outside the page and the raw trace carries model text.
      const accepted = JSON.parse(candidateText(fixtures[0]!)) as { shells: { headline: string } };
      const marker = accepted.shells.headline.replace(/\{\{S\d+\}\}/g, "").trim().slice(0, 12);
      expect(marker.length).toBeGreaterThan(5);
      expect(page).toContain(marker);
      const analysis = await readFile(resolve(root, run.tracer.files().find((file) => file.endsWith("99-analysis.json"))!), "utf8");
      expect(analysis.includes(marker)).toBe(false);
      expect(JSON.stringify(summary).includes(marker)).toBe(false);
      expect(JSON.stringify(summary)).not.toContain(SENTINEL);
      // Every trace record and the review page exist only under the temp root (removed after the file), never under the project.
      expect(confinedToTempRoot(root, [...run.tracer.files(), summary.review!.path!])).toBe(true);
    });
  }, 60_000);
});

const env = process.env;
const LIVE = env.RUN_LIVE_HYBRID_SHELL_TARGETED === "1";

describe.skipIf(!LIVE)("Packet 11 hybrid shell targeted EXPLAIN diagnostic (live, at most six calls)", () => {
  it(
    "runs the six fixed traced value-blind EXPLAIN fixtures against direct DeepSeek under the hard spend ceiling",
    async () => {
      // Every refusal below happens before any request.
      const mismatches = contractMismatches();
      if (mismatches.length > 0) throw new Error(`CONTRACT_MISMATCH:${mismatches.join(",")}`);
      const model = deepSeekFlash();
      if (model.endpoint !== DEEPSEEK_RESPONSES_URL || model.requestModelId !== "deepseek-flash" || model.responseModelSnapshot !== "deepseek-flash") throw new Error("MODEL_OR_ENDPOINT_NOT_APPROVED");
      const fixtures = targetedFixtures();
      const selection = fixtureSelectionRefusal(fixtures);
      // Offline preflight and per-call upper bounds (capture-only fetcher; the real credential is not used).
      const preflight = await preflightTargeted(fixtures, model.requestModelId);
      const gate = liveGateRefusals(env, preflight.upperBoundSumUsd);
      const timeouts = { perCallTimeoutMs: AI_HYBRID_RUNTIME_BUNDLES.EXPLAIN_PATTERN.executionBudget.perCallTimeoutMs, overallTimeoutMs: AI_HYBRID_RUNTIME_BUNDLES.EXPLAIN_PATTERN.executionBudget.overallTimeoutMs };
      console.log(JSON.stringify({ packet11HybridTargetedPlan: { provider: "deepseek", endpoint: model.endpoint, model: model.requestModelId, scope: APPROVED_HYBRID_CONTRACT.approvalScope, phase: "DIAGNOSTIC", fixtureIds: fixtures.map((fixture) => fixture.id), maxCalls: TARGETED_MAX_CALLS, maxPerFixture: 1, allowRepair: false, maxUsd: gate.maxUsd, perCallUpperBoundUsd: preflight.items.map((item) => ({ fixtureId: item.fixtureId, bodyByteCount: item.bodyByteCount, upperBoundUsd: item.upperBoundUsd })), upperBoundSumUsd: preflight.upperBoundSumUsd, timeouts, contract: codeContract(), preflight: { passed: preflight.items.filter((item) => item.passed).length, failed: preflight.items.filter((item) => !item.passed).map((item) => ({ fixtureId: item.fixtureId, violations: item.violations })), classes: preflight.classes, items: preflight.items.map((item) => ({ fixtureId: item.fixtureId, passed: item.passed, violations: item.violations, classHash: item.classHash, maxOutputTokens: item.maxOutputTokens, temperature: item.temperature })) }, selection, refusals: gate.refusals } }));
      if (selection) throw new Error(selection);
      if (gate.refusals.length > 0 || gate.maxUsd === null) throw new Error(`TARGETED_RUN_REFUSED:${gate.refusals.join(",")}`);
      if (preflight.items.some((item) => !item.passed) || preflight.eligible !== TARGETED_MAX_CALLS) throw new Error("PREFLIGHT_NOT_VALUE_BLIND");
      const token = readDeepSeekToken(env);
      if (token.kind !== "CONFIGURED") throw new Error("DEEPSEEK_API_KEY is not configured");

      const run = await runTracedTargeted({ fetcher: (url, init) => fetch(url, init), token: token.token, ceilingUsd: gate.maxUsd });
      console.log(JSON.stringify({ packet11HybridTargeted: run.summary }));
      expect(run.summary.harnessError).toBeNull();
      expect(run.summary.transmissions.length).toBeLessThanOrEqual(TARGETED_MAX_CALLS);
      expect(run.summary.spend.committedUsd).toBeLessThanOrEqual(gate.maxUsd);
      expect(run.summary.callMap?.kind).toBe("MAPPED");
      expect(run.summary.redaction).toMatchObject({ secretAbsent: true, authorizationRedacted: true, filesPrivate: true });
      expect(run.summary.hashes.mismatches).toBe(0);
      expect(run.report!.totals.calls).toBeLessThanOrEqual(TARGETED_MAX_CALLS);
      expect(run.report!.totals.credits).toBeLessThanOrEqual(gate.maxUsd);
    },
    10 * 60_000,
  );
});
