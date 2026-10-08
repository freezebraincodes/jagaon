// @vitest-environment node
import { rmSync } from "node:fs";
import { relative, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEEPSEEK_DOCUMENTED_MODELS, DEEPSEEK_RESPONSES_URL, readDeepSeekToken } from "@/ai/deepseek/deepseek-catalogue";
import { createDeepSeekShellResponsesProvider } from "@/ai/deepseek/deepseek-responses-provider";
import type { KieProviderDiagnostic } from "@/ai/kie/kie-responses-provider";
import { selectEvaluationCandidates } from "@/ai/kie/kie-route-config";
import { AI_HYBRID_RUNTIME_BUNDLES, AI_HYBRID_VERSIONS } from "@/application/ai/ai-hybrid-runtime-bundles";
import type { AiShellProviderPort } from "@/application/ai/ai-provider-port";
import { defaultShells } from "@/application/ai/language/default-shells";
import { projectShellTaskRequest } from "@/application/ai/language/shell-projector";
import { SHELL_MAX_OUTPUT_TOKENS, SHELL_TEMPERATURE, type ShellTask } from "@/domain/ai";
import { AI_HYBRID_EVALUATION_REPORT_VERSION, APPROVED_HYBRID_CONTRACT, HYBRID_FULL_EVALUATION_POLICY, evaluateHybridModelSnapshot, hybridLiveRunVerdict } from "./packet-11-hybrid-evaluation";
import { hybridFixturesForPhase, PACKET_11_HYBRID_FIXTURE_SET_REVISION } from "./packet-11-hybrid-fixtures";
import { checkHybridShellRequestBody, createHybridDiagnosticTracer, estimateMaxUsd, sweepShellCandidate, verifyTraceRedaction } from "./packet-11-hybrid-live-diagnostic";
import { plannedFixture, shellCandidate } from "./packet-11-hybrid-test-support";

/**
 * Packet 11B.10 four-fixture hybrid smoke (owner approval 2026-10-06: direct DeepSeek deepseek-flash, hybrid shell
 * wording only, at most 4 calls, no retry or repair, at most USD 0.02, raw trace). The offline part always runs with
 * fake fetchers only. The live part is skipped unless RUN_LIVE_HYBRID_SHELL_SMOKE=1 and is refused before any request
 * unless HYBRID_SMOKE_PROVIDER=deepseek, HYBRID_SMOKE_MODEL=deepseek-flash, HYBRID_SMOKE_CONFIRM_MAX_CALLS=4,
 * 0 < HYBRID_SMOKE_MAX_USD <= 0.02, HYBRID_SMOKE_RAW_TRACE=1, DEEPSEEK_API_KEY is configured, the exact contract below
 * holds, the four fixtures are exactly the approved ones in order, every exact request body passes the offline
 * value-blindness preflight with its task cap, and the summed upper-bound estimate is within the ceiling. Production
 * timeouts unchanged; no listing or balance query. Prints only closed codes, counts, versions, timings, spend and paths.
 */

const SMOKE_IDS = Object.freeze([
  "p11.explain-pattern.en-sg.ordinary",
  "p11.explain-pattern.zh-sg.ordinary",
  "p11.draft-care-preparation-summary.en-sg.ordinary",
  "p11.draft-care-preparation-summary.zh-sg.ordinary",
]);
const SENTINEL = "ds-SENTINEL-CREDENTIAL-9a7b3c55e0";
const NOW = () => "2026-10-06T09:00:00.000Z";
// The frozen contract (the same literals as the FULL, targeted and diagnostic runners; the whole Packet 11C contract is pinned in
// packet-11c-contract-freeze.test.ts). CURRENT (Packet 11C B5 contract freeze, offline): prompt 11b.18, rules 11b.15-r8, request 11b.11,
// bundle set 11b.18, provider schema kie-schema.11c.1, slot plan ai-slot-plan.11b.9, fixtures 11b.16, harness packet11-eval.19, policy
// hybrid-full-policy.2, caps 512/1024, temperature 0.2. Revision history follows (each line was the contract at its time).
// Rules r4 (Packet 11B.11, offline only): prompt 11b.14, rules r4, bundle set 11b.11, fixtures 11b.9, harness eval.9.
// Rules r5 (Packet 11B.12, offline only): prompt 11b.15, rules r5, bundle set 11b.12, fixtures 11b.10, harness eval.10.
// Rules r6 (Packet 11B.13, offline only): prompt 11b.15 (unchanged), rules r6, bundle set 11b.13, fixtures 11b.11, harness eval.11.
// Rules r7 (Packet 11B.14, offline only): prompt 11b.15 (unchanged), rules r7, request 11b.11 (temperature 0.2), bundle set 11b.14,
// fixtures 11b.12, harness eval.12; caps unchanged.
// FULL policy (packet11-eval.13, owner instruction 2026-10-07, offline only): harness eval.13 and fullEvaluationPolicy
// hybrid-full-policy.1 (FULL-only safe shell fallbacks); the smoke stays strict and every other pin is unchanged.
// Rules r8 (packet11-eval.14, owner instruction 2026-10-07, offline only): rules 11b.15-r8 (S6 placeholder provenance), bundle set
// 11b.15, fixtures 11b.13, harness eval.14; the policy, prompt, request, caps and temperature are unchanged. The live block is not run.
// zh EXPLAIN guidance (packet11-eval.15, owner instruction 2026-10-07, offline only): prompt 11b.16 (one new paragraph in the zh-SG EXPLAIN
// asset only), bundle set 11b.16, fixtures 11b.14, harness eval.15; rules r8, the policy, request, caps and temperature are unchanged.
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
const REQUIRED_CONTRACT = Object.freeze({
  prompt: "11b.18",
  shellRules: "ai-shell-rules.11b.15-r8",
  shellRequest: "ai-shell-request.11b.11",
  explainBundle: "ai.explain-pattern@11b.18",
  careBundle: "ai.draft-care-preparation-summary@11b.18",
  providerSchema: "kie-schema.11c.1",
  // Packet 11C phase 2 (option (a), 2026-10-08, offline): eligibility accounting only; request bodies differ only in this version field.
  slotPlan: "ai-slot-plan.11b.9",
  fixtureSet: "packet11-fixtures.11b.16",
  harness: "packet11-eval.19",
  fullEvaluationPolicy: "hybrid-full-policy.2",
  maxOutputTokens: { EXPLAIN_PATTERN: 512, DRAFT_CARE_PREPARATION_SUMMARY: 1024 },
  temperature: 0.2,
});
const created = new Set<string>();
afterAll(() => {
  for (const directory of created) rmSync(directory, { recursive: true, force: true });
});

function deepSeekFlash() {
  const selection = selectEvaluationCandidates({ requested: "deepseek-flash", listing: [], documented: DEEPSEEK_DOCUMENTED_MODELS, now: NOW });
  if (selection.kind !== "SELECTED" || selection.candidates.length !== 1) throw new Error("DEEPSEEK_FLASH_NOT_SELECTABLE");
  return selection.candidates[0]!;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const keyOf = (input: unknown) => `${(input as { taskType?: unknown }).taskType}|${(input as { locale?: unknown }).locale}`;
/** The exact body the shared adapter would send, captured offline: the fetcher records it and never transmits. */
async function captureBody(fixtureId: string): Promise<string> {
  let body: string | null = null;
  const provider = createDeepSeekShellResponsesProvider({ token: SENTINEL, model: deepSeekFlash(), fetcher: async (_url, init) => {
    body = String(init.body);
    throw new Error("OFFLINE_CAPTURE_ONLY");
  } });
  await provider.invoke(projectShellTaskRequest(plannedFixture(fixtureId).plan), new AbortController().signal);
  if (body === null) throw new Error("NO_BODY_CAPTURED");
  return body;
}
async function preflightAll(model: string) {
  const fixtures = hybridFixturesForPhase("SMOKE");
  const items = [];
  for (const fixture of fixtures) {
    const check = checkHybridShellRequestBody(fixture, await captureBody(fixture.id), model);
    items.push({ fixtureId: fixture.id, maxOutputTokens: SHELL_MAX_OUTPUT_TOKENS[fixture.taskType as ShellTask], passed: check.passed, violations: check.violations, summary: check.summary, estimate: estimateMaxUsd(check.summary.bodyByteCount, fixture.taskType as ShellTask) });
  }
  const estimatedMaxUsd = Math.round(items.reduce((sum, item) => sum + item.estimate.estimatedMaxUsd, 0) * 1_000_000) / 1_000_000;
  return { fixtures, items, estimatedMaxUsd };
}
/** A fake DeepSeek envelope carrying the fixture's default shells, as a completed, not-stored response. */
function fakeResponse(init: RequestInit): Response {
  const body = JSON.parse(String(init.body)) as { input: Array<{ content: Array<{ text: string }> }> };
  const shell = JSON.parse(body.input[0]!.content[0]!.text) as { taskType: string; locale: string };
  const fixture = hybridFixturesForPhase("SMOKE").find((item) => item.taskType === shell.taskType && item.locale === shell.locale)!;
  const plan = plannedFixture(fixture.id).plan;
  const text = JSON.stringify(shellCandidate(plan, defaultShells(plan)));
  return new Response(JSON.stringify({ id: "resp_1", object: "response", status: "completed", model: "deepseek-flash", store: false, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }], usage: { input_tokens: 1500, output_tokens: 120, output_tokens_details: { reasoning_tokens: 0 } } }), { status: 200, headers: { "content-type": "application/json" } });
}

describe("Packet 11 hybrid shell smoke (offline)", () => {
  it("rules r5: the required contract literal equals the current code pins (checked offline; the live block is not run)", () => {
    const code = {
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
    expect(same(REQUIRED_CONTRACT, code)).toBe(true);
    expect(REQUIRED_CONTRACT).toMatchObject({ prompt: "11b.18", shellRules: "ai-shell-rules.11b.15-r8", shellRequest: "ai-shell-request.11b.11", explainBundle: "ai.explain-pattern@11b.18", careBundle: "ai.draft-care-preparation-summary@11b.18", fixtureSet: "packet11-fixtures.11b.16", harness: "packet11-eval.19", fullEvaluationPolicy: "hybrid-full-policy.2", temperature: 0.2 });
    // Packet 11C B5 contract freeze: the provider output-schema label (label only; no body byte).
    expect(REQUIRED_CONTRACT.providerSchema).toBe("kie-schema.11c.1");
    expect(APPROVED_HYBRID_CONTRACT.shellTemperature).toBe(REQUIRED_CONTRACT.temperature);
  });
  it("r7: each of the four smoke bodies carries temperature 0.2 beside its task cap and passes the preflight", async () => {
    for (const id of SMOKE_IDS) {
      const body = JSON.parse(await captureBody(id)) as Record<string, unknown>;
      expect(body.temperature, id).toBe(0.2);
      expect(Object.keys(body).slice(-2), id).toEqual(["temperature", "max_output_tokens"]);
    }
  });
  it("selects exactly the four approved fixtures in order, each value-blind with its task cap, within the USD 0.02 estimate", async () => {
    const { fixtures, items, estimatedMaxUsd } = await preflightAll("deepseek-flash");
    expect(fixtures.map((fixture) => fixture.id)).toEqual(SMOKE_IDS);
    expect(items.map((item) => [item.passed, item.violations, item.maxOutputTokens])).toEqual([[true, [], 512], [true, [], 512], [true, [], 1024], [true, [], 1024]]);
    expect(items.map((item) => item.estimate.outputTokensMax)).toEqual([512, 512, 1024, 1024]);
    expect(items.every((item) => item.summary.fixtureValuesFound === 0 && item.summary.fixtureStringsScanned > 0)).toBe(true);
    expect(estimatedMaxUsd).toBeLessThanOrEqual(0.02);
  });

  it("runs four traced calls through the hybrid harness with fake DeepSeek responses and a passing approved verdict", async () => {
    const fixtures = hybridFixturesForPhase("SMOKE");
    let sent = 0;
    const tracer = await createHybridDiagnosticTracer({ fixtures, expectedModel: "deepseek-flash", maxTransmissions: 4, now: NOW, fetcher: async (_url, init) => {
      sent += 1;
      return fakeResponse(init);
    } });
    created.add(tracer.directory);
    const model = deepSeekFlash();
    const provider = createDeepSeekShellResponsesProvider({ token: SENTINEL, model, fetcher: tracer.fetcher });
    const report = await evaluateHybridModelSnapshot({ model, provider, fixtures, phase: "SMOKE", limits: { maxCalls: 4, maxCredits: 0.02, allowRepair: false }, now: NOW });
    expect(sent).toBe(4);
    expect(report.fixtures.map((item) => [item.fixtureId, item.source, item.attempts, item.atomEqual])).toEqual(SMOKE_IDS.map((id) => [id, "AI", 1, true]));
    expect(hybridLiveRunVerdict(report, { phase: "SMOKE", fixtureIds: SMOKE_IDS, maxCalls: 4 }, { maxCredits: 0.02, requestModelId: "deepseek-flash", responseModelSnapshot: "deepseek-flash" }, null)).toEqual({ kind: "PASS" });
    expect(tracer.files()).toHaveLength(8);
    expect(tracer.transmissions().map((item) => item.status)).toEqual(["completed", "completed", "completed", "completed"]);
    expect(await verifyTraceRedaction(tracer.files(), SENTINEL)).toEqual({ filesChecked: 8, secretAbsent: true, authorizationRedacted: true, filesPrivate: true });
  });

  it("refuses unsent a repeated fixture, an unlisted fixture's body and a fifth call", async () => {
    const fixtures = hybridFixturesForPhase("SMOKE");
    let sent = 0;
    const tracer = await createHybridDiagnosticTracer({ fixtures, expectedModel: "deepseek-flash", maxTransmissions: 4, now: NOW, fetcher: async (_url, init) => {
      sent += 1;
      return fakeResponse(init);
    } });
    created.add(tracer.directory);
    const headers = { authorization: `Bearer ${SENTINEL}`, "content-type": "application/json", accept: "application/json" };
    const first = await captureBody(SMOKE_IDS[0]!);
    expect((await tracer.fetcher(DEEPSEEK_RESPONSES_URL, { method: "POST", headers, body: first })).status).toBe(200);
    await expect(tracer.fetcher(DEEPSEEK_RESPONSES_URL, { method: "POST", headers, body: first })).rejects.toThrow("TRACE_CALL_LIMIT");
    expect(sent).toBe(1);

    const other = await createHybridDiagnosticTracer({ fixtures, expectedModel: "deepseek-flash", maxTransmissions: 4, now: NOW, fetcher: async (_url, init) => {
      sent += 1;
      return fakeResponse(init);
    } });
    created.add(other.directory);
    // Same task and locale as the first smoke fixture, but not its projection.
    await expect(other.fetcher(DEEPSEEK_RESPONSES_URL, { method: "POST", headers, body: await captureBody("p11.explain-pattern.en-sg.abstention") })).rejects.toThrow("TRACE_REQUEST_NOT_VALUE_BLIND");
    expect(sent).toBe(1);
    await expect(createHybridDiagnosticTracer({ fixtures, expectedModel: "deepseek-flash", maxTransmissions: 5, now: NOW, fetcher: fetch })).rejects.toThrow("TRACE_CALL_LIMIT");
    await expect(createHybridDiagnosticTracer({ fixtures: [fixtures[0]!, fixtures[0]!], expectedModel: "deepseek-flash", maxTransmissions: 1, now: NOW, fetcher: fetch })).rejects.toThrow("TRACE_FIXTURE_NOT_REGISTERED");
  });
});

const env = process.env;
const LIVE = env.RUN_LIVE_HYBRID_SHELL_SMOKE === "1";

describe.skipIf(!LIVE)("Packet 11 hybrid shell smoke (live, at most four calls)", () => {
  it(
    "sends the four approved traced value-blind shell requests to direct DeepSeek",
    async () => {
      // Every refusal happens before any request.
      if (env.HYBRID_SMOKE_PROVIDER !== "deepseek") throw new Error("HYBRID_SMOKE_PROVIDER must be deepseek");
      if (env.HYBRID_SMOKE_MODEL !== "deepseek-flash") throw new Error("HYBRID_SMOKE_MODEL must be deepseek-flash");
      if (env.HYBRID_SMOKE_CONFIRM_MAX_CALLS !== "4") throw new Error("Set HYBRID_SMOKE_CONFIRM_MAX_CALLS=4");
      if (env.HYBRID_SMOKE_RAW_TRACE !== "1") throw new Error("HYBRID_SMOKE_RAW_TRACE=1 is required");
      const maxUsd = Number(env.HYBRID_SMOKE_MAX_USD);
      if (!Number.isFinite(maxUsd) || maxUsd <= 0 || maxUsd > 0.02) throw new Error("HYBRID_SMOKE_MAX_USD must be in (0, 0.02]");
      const token = readDeepSeekToken(env);
      if (token.kind !== "CONFIGURED") throw new Error("DEEPSEEK_API_KEY is not configured");
      if (Object.keys(env).some((name) => name.startsWith("NEXT_PUBLIC_") && /KEY|TOKEN|SECRET/i.test(name))) throw new Error("PUBLIC_CREDENTIAL_NAME_PRESENT");

      const contract = {
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
      const contractMismatch = (Object.keys(REQUIRED_CONTRACT) as Array<keyof typeof REQUIRED_CONTRACT>).filter((key) => !same(contract[key], REQUIRED_CONTRACT[key]));
      const approvedMismatch = ([["promptVersion", contract.prompt], ["shellRulesRevision", contract.shellRules], ["shellRequestVersion", contract.shellRequest], ["explainBundle", contract.explainBundle], ["careBundle", contract.careBundle], ["providerSchemaVersion", contract.providerSchema], ["slotPlanVersion", contract.slotPlan], ["fixtureSetRevision", contract.fixtureSet], ["evaluationReportVersion", contract.harness], ["fullEvaluationPolicy", contract.fullEvaluationPolicy], ["shellMaxOutputTokens", contract.maxOutputTokens], ["shellTemperature", contract.temperature], ["requestModelId", "deepseek-flash"], ["responseModelSnapshot", "deepseek-flash"], ["providerKey", "deepseek"], ["endpoint", DEEPSEEK_RESPONSES_URL], ["approvalScope", "HYBRID_SHELL_WORDING_ONLY"]] as const).filter(([key, value]) => !same(APPROVED_HYBRID_CONTRACT[key], value)).map(([key]) => key);
      if (contractMismatch.length > 0 || approvedMismatch.length > 0) throw new Error(`CONTRACT_MISMATCH:${[...contractMismatch, ...approvedMismatch].join(",")}`);
      const model = deepSeekFlash();
      if (model.endpoint !== DEEPSEEK_RESPONSES_URL || model.requestModelId !== "deepseek-flash" || model.responseModelSnapshot !== "deepseek-flash") throw new Error("MODEL_OR_ENDPOINT_NOT_APPROVED");

      // Offline preflight of every exact body (a capture-only fetcher; the real credential is not used).
      const preflight = await preflightAll(model.requestModelId);
      const fixtures = preflight.fixtures;
      if (!same(fixtures.map((fixture) => fixture.id), SMOKE_IDS)) throw new Error("FIXTURE_SELECTION");
      const timeouts = fixtures.map((fixture) => ({ fixtureId: fixture.id, perCallTimeoutMs: AI_HYBRID_RUNTIME_BUNDLES[fixture.taskType as ShellTask].executionBudget.perCallTimeoutMs, overallTimeoutMs: AI_HYBRID_RUNTIME_BUNDLES[fixture.taskType as ShellTask].executionBudget.overallTimeoutMs }));
      console.log(JSON.stringify({ packet11HybridSmokePlan: { provider: "deepseek", endpoint: model.endpoint, model: model.requestModelId, scope: APPROVED_HYBRID_CONTRACT.approvalScope, fixtureIds: SMOKE_IDS, maxCalls: 4, maxUsd, allowRepair: false, timeouts, contract, preflight: preflight.items, estimatedMaxUsd: preflight.estimatedMaxUsd } }));
      if (preflight.items.some((item) => !item.passed)) throw new Error("PREFLIGHT_NOT_VALUE_BLIND");
      if (preflight.estimatedMaxUsd > maxUsd) throw new Error("PREFLIGHT_ESTIMATE_OVER_CEILING");

      const tracer = await createHybridDiagnosticTracer({ fixtures, expectedModel: model.requestModelId, maxTransmissions: 4, fetcher: (url, init) => fetch(url, init) });
      let lastDiagnostic: KieProviderDiagnostic | null = null;
      const diagnostics: Array<Record<string, unknown>> = [];
      const inner = createDeepSeekShellResponsesProvider({ token: token.token, model, fetcher: tracer.fetcher, onDiagnostic: (diagnostic) => {
        lastDiagnostic = diagnostic;
        diagnostics.push({ code: diagnostic.code, parserStage: diagnostic.parserStage, httpStatus: diagnostic.httpStatus, retention: diagnostic.retention, modelComparison: diagnostic.modelIdentity?.comparison ?? null, reportedUsage: diagnostic.reportedUsage });
      } });
      const candidates = new Map<string, unknown>();
      const provider: AiShellProviderPort = {
        providerModel: inner.providerModel,
        async invoke(input, signal) {
          const result = await inner.invoke(input, signal);
          if (result.kind === "COMPLETED") candidates.set(keyOf(input), result.candidate);
          return result;
        },
      };
      const takeDiagnostic = () => {
        const taken = lastDiagnostic;
        lastDiagnostic = null;
        return taken;
      };
      let report: Awaited<ReturnType<typeof evaluateHybridModelSnapshot>> | null = null;
      try {
        report = await evaluateHybridModelSnapshot({ model, provider, fixtures, phase: "SMOKE", limits: { maxCalls: 4, maxCredits: maxUsd, allowRepair: false }, takeDiagnostic });
      } finally {
        const transmissions = tracer.transmissions();
        const sweeps = fixtures.map((fixture) => {
          const key = `${fixture.taskType}|${fixture.locale}`;
          return { fixtureId: fixture.id, sweep: candidates.has(key) ? sweepShellCandidate(fixture, candidates.get(key)) : null };
        });
        const verdict = report ? hybridLiveRunVerdict(report, { phase: "SMOKE", fixtureIds: SMOKE_IDS, maxCalls: 4 }, { maxCredits: maxUsd, requestModelId: APPROVED_HYBRID_CONTRACT.requestModelId, responseModelSnapshot: APPROVED_HYBRID_CONTRACT.responseModelSnapshot }, null) : null;
        await tracer.record("99-analysis.json", { kind: "ANALYSIS", transmissions, diagnostics, sweeps, report, verdict });
        const redaction = await verifyTraceRedaction(tracer.files(), token.token);
        console.log(JSON.stringify({ packet11HybridSmoke: { transmissions, diagnostics, traceFailure: tracer.failure(), presendChecks: tracer.checks().map((check) => ({ passed: check.passed, violations: check.violations })), sweeps, report, verdict, redaction, trace: { directory: relative(process.cwd(), resolve(tracer.directory)), files: tracer.files() } } }));
        expect(transmissions.length).toBeLessThanOrEqual(4);
        expect(tracer.failure()).toBeNull();
        expect(redaction).toMatchObject({ secretAbsent: true, authorizationRedacted: true, filesPrivate: true });
      }
      expect(report!.totals.calls).toBeLessThanOrEqual(4);
      expect(report!.totals.credits).toBeLessThanOrEqual(maxUsd);
    },
    10 * 60_000,
  );
});
