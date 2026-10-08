import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiProviderPort, ProviderInvocationResult } from "@/application/ai/ai-provider-port";
import { outputFixture } from "@/domain/ai/ai-test-fixtures";
import { KIE_DOCUMENTED_MODELS, type KieModelSnapshot } from "@/ai/kie/kie-model-catalogue";
import { createKieResponsesProvider, type KieProviderDiagnostic } from "@/ai/kie/kie-responses-provider";
import { createAiTaskService } from "@/application/ai/ai-task-service";
import { validateAiTaskOutput } from "@/application/ai/ai-output-validator";
import { resolveAiTaskBundle } from "@/application/ai/ai-runtime-bundles";
import { AI_ACTIVATION_MANIFEST } from "@/application/ai/ai-activation-manifest";
import { aiInvocationAuditRowSchema, type AiInvocationAuditRow } from "@/domain/ai";
import { AI_EVALUATION_HARD_GATE_REASONS, evaluateModelSnapshot, evaluationPlan, liveRunVerdict, type AiModelEvaluationReport } from "./packet-11-evaluation";
import { fixturesForPhase, PACKET_11_FIXTURES, type AiEvaluationFixture } from "./packet-11-fixtures";

/** Packet 11B Task 4: offline evaluator with a fake provider. No network, key or credits. */

const SENTINEL = "SENTINEL-SECRET-0f3a";
const MODEL: KieModelSnapshot = { ...KIE_DOCUMENTED_MODELS[0]!, contextWindow: null, defaultReasoningLevel: null, retrievedAt: "2026-10-05T01:00:00.000Z" };
const SMOKE = fixturesForPhase("SMOKE");
const LIMITS = { maxCalls: 4, maxCredits: 1, allowRepair: false };
const usage = (credits = 0.02) => ({ inputTokens: 800, outputTokens: 150, costMicroUsd: null, credits });

/** A valid, fixture-faithful output for the ordinary smoke fixtures. */
function validOutput(fixture: AiEvaluationFixture): unknown {
  const base = outputFixture(fixture.taskType) as Record<string, any>;
  if (fixture.locale === "en-SG") return base;
  const zh = structuredClone(base);
  zh.locale = "zh-SG";
  if (fixture.taskType === "EXPLAIN_PATTERN") {
    zh.payload.headline.text = "最近记录的数值是 6.2 和 7.1 mmol/L。";
    zh.payload.observation.text = "最近记录的数值是 6.2 和 7.1 mmol/L。";
    zh.payload.evidence.text = "这使用了 10 个已记录的读数。";
  } else {
    zh.payload.sections[0].bullets[0].text = "记录了一个 6.2 mmol/L 的读数。";
    zh.payload.sections[1].bullets[0].text = "问题：我可以把笔放在包里吗？(演示)";
  }
  return zh;
}

function fake(script: (fixture: AiEvaluationFixture, call: number) => ProviderInvocationResult | Promise<ProviderInvocationResult>, fixtures: readonly AiEvaluationFixture[] = SMOKE) {
  const seen = new Map<string, number>();
  const invoke = vi.fn(async (input: { taskType: string; locale: string; facts: unknown[] }) => {
    const fixture = fixtures.find((entry) => entry.taskType === input.taskType && entry.locale === input.locale && JSON.stringify(entry.request.facts.map((fact) => fact.value)) === JSON.stringify((input.facts as Array<{ value: unknown }>).map((fact) => fact.value)))!;
    const call = (seen.get(fixture.id) ?? 0) + 1;
    seen.set(fixture.id, call);
    const result = await script(fixture, call);
    // The offline fake stands in for a retention-confirming provider unless a test says otherwise.
    return result.kind === "COMPLETED" && !("retention" in result) ? { ...result, retention: "CONFIRMED_NOT_STORED" as const } : result;
  });
  const provider: AiProviderPort = { providerModel: { providerKey: "kie", modelSnapshot: MODEL.responseModelSnapshot }, invoke: invoke as never };
  return { provider, invoke };
}

let tick = 0;
const run = (provider: AiProviderPort, options: Partial<Parameters<typeof evaluateModelSnapshot>[0]> = {}) =>
  evaluateModelSnapshot({ model: MODEL, provider, fixtures: SMOKE, concurrency: 1, phase: "SMOKE", limits: LIMITS, now: () => "2026-10-05T02:00:00.000Z", monotonicMs: () => (tick += 100), ...options });

afterEach(() => {
  tick = 0;
  vi.restoreAllMocks();
});

describe("evaluation plan", () => {
  it("states the smoke and full call ceilings before any request", () => {
    const smoke = evaluationPlan(fixturesForPhase("SMOKE"), "SMOKE");
    expect(smoke).toMatchObject({ phase: "SMOKE", fixtureCount: 4, maxCalls: 4, allowRepair: false });
    const full = evaluationPlan(PACKET_11_FIXTURES, "FULL");
    // packet11-fixtures.11b.2: 70 fixtures (EXPLAIN_PATTERN AMBIGUOUS excluded), one repair each.
    expect(full).toMatchObject({ phase: "FULL", fixtureCount: 70, maxCalls: 140, allowRepair: true });
    for (const plan of [smoke, full]) {
      expect(plan.estimatedInputTokens).toBeGreaterThan(0);
      expect(plan.estimatedOutputTokens).toBeGreaterThan(0);
      expect(plan.estimatedCredits.basis).toBe("ESTIMATE_FROM_DOCUMENTED_EXAMPLE_NOT_A_CAP");
    }
  });
});

describe("offline evaluator", () => {
  it("accepts faithful output and aggregates first-call validity, tokens, credits and latency by task and locale", async () => {
    const { provider, invoke } = fake((fixture) => ({ kind: "COMPLETED", candidate: validOutput(fixture), usage: usage() }));
    const report = await run(provider);
    expect(invoke).toHaveBeenCalledTimes(4);
    expect(report).toMatchObject({ phase: "SMOKE", stoppedReason: null, completed: true, hardGatePassed: true, totals: { fixtures: 4, accepted: 4, fallback: 0, calls: 4, firstCallValid: 4, repairs: 0, inputTokens: 3200, outputTokens: 600 } });
    expect(report.totals.credits).toBeCloseTo(0.08);
    expect(report.byTaskLocale.map((row) => [row.taskType, row.locale, row.accepted, row.calls])).toEqual([
      ["DRAFT_CARE_PREPARATION_SUMMARY", "en-SG", 1, 1],
      ["DRAFT_CARE_PREPARATION_SUMMARY", "zh-SG", 1, 1],
      ["EXPLAIN_PATTERN", "en-SG", 1, 1],
      ["EXPLAIN_PATTERN", "zh-SG", 1, 1],
    ]);
    expect(report.fixtures[0]).toMatchObject({ fixtureId: SMOKE[0]!.id, outcome: "ACCEPTED", reasonCode: "ACCEPTED", attempts: 1, firstCallValid: true, hardGateFailure: false, latencyMs: 100 });
  });

  it("fails the hard gate on one changed number and stops the run", async () => {
    const { provider, invoke } = fake((fixture) => {
      const output = validOutput(fixture) as Record<string, any>;
      if (fixture.taskType === "EXPLAIN_PATTERN") output.payload.evidence.text = fixture.locale === "en-SG" ? "This uses 11 recorded readings." : "这使用了 11 个已记录的读数。";
      return { kind: "COMPLETED", candidate: output, usage: usage() };
    });
    const report = await run(provider);
    expect(report).toMatchObject({ hardGatePassed: false, stoppedReason: "HARD_GATE", completed: false });
    expect(report.fixtures).toHaveLength(1);
    expect(report.fixtures[0]).toMatchObject({ outcome: "FALLBACK", reasonCode: "FACT_FIDELITY_FAILED", hardGateFailure: true });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it.each(AI_EVALUATION_HARD_GATE_REASONS)("treats %s as a hard-gate reason", (reason) => {
    expect(["PRIVACY_REJECTED", "REFERENCE_MISMATCH", "FACT_FIDELITY_FAILED", "AUTHORITY_BOUNDARY_VIOLATION", "CLINICAL_MEANING_VIOLATION"]).toContain(reason);
  });

  it("fails the hard gate on forbidden clinical meaning in Chinese", async () => {
    const { provider } = fake((fixture) => {
      const output = validOutput(fixture) as Record<string, any>;
      if (fixture.locale === "zh-SG" && fixture.taskType === "EXPLAIN_PATTERN") output.payload.observation.text = "这些读数偏高。";
      return { kind: "COMPLETED", candidate: output, usage: usage() };
    });
    const report = await run(provider);
    expect(report.fixtures[1]).toMatchObject({ reasonCode: "CLINICAL_MEANING_VIOLATION", hardGateFailure: true });
    expect(report.stoppedReason).toBe("HARD_GATE");
  });

  it("records an abstention as a fallback, not a hard-gate failure", async () => {
    const { provider } = fake((fixture) => {
      const { payload: _payload, ...rest } = validOutput(fixture) as Record<string, unknown>;
      void _payload;
      return { kind: "COMPLETED", candidate: { ...rest, outcome: "ABSTAIN", abstentionReason: "AMBIGUOUS_INPUT" }, usage: usage() };
    });
    const report = await run(provider, { phase: "FULL", limits: { maxCalls: 8, maxCredits: 5, allowRepair: true } });
    expect(report).toMatchObject({ hardGatePassed: true, stoppedReason: null, totals: { abstained: 4, accepted: 0 } });
  });

  it("uses the permitted structural repair in the full phase and counts it", async () => {
    const full = fixturesForPhase("SMOKE");
    const { provider } = fake((fixture, call) => (call === 1 ? { kind: "COMPLETED", candidate: "{not json", usage: usage() } : { kind: "COMPLETED", candidate: validOutput(fixture), usage: usage() }), full);
    const report = await run(provider, { phase: "FULL", limits: { maxCalls: 8, maxCredits: 5, allowRepair: true } });
    expect(report.totals).toMatchObject({ accepted: 4, calls: 8, repairs: 4, firstCallValid: 0 });
  });

  it("never repairs in the smoke phase and stops at the first schema rejection", async () => {
    const { provider, invoke } = fake(() => ({ kind: "COMPLETED", candidate: "{not json", usage: usage() }));
    const report = await run(provider);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({ stoppedReason: "SMOKE_FALLBACK", completed: false });
    expect(report.fixtures.map((fixture) => [fixture.reasonCode, fixture.attempts, fixture.schemaConformant])).toEqual([["SCHEMA_INVALID", 1, false]]);
  });

  it("stops at the call cap without a further provider call", async () => {
    const { provider, invoke } = fake((fixture) => ({ kind: "COMPLETED", candidate: validOutput(fixture), usage: usage() }));
    const report = await run(provider, { limits: { ...LIMITS, maxCalls: 2 } });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(report).toMatchObject({ stoppedReason: "CALL_CAP", completed: false, totals: { fixtures: 2 } });
  });

  it("stops once reported credits reach the configured ceiling", async () => {
    const { provider, invoke } = fake((fixture) => ({ kind: "COMPLETED", candidate: validOutput(fixture), usage: usage(0.6) }));
    const report = await run(provider, { limits: { ...LIMITS, maxCredits: 1 } });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(report.stoppedReason).toBe("CREDIT_CEILING");
    expect(report.totals.credits).toBeCloseTo(1.2);
  });

  it("stops on unexpected provider behaviour such as a refused schema", async () => {
    const { provider, invoke } = fake(() => ({ kind: "FAILED", reason: "PROVIDER_REJECTED" }));
    const report = await run(provider);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({ stoppedReason: "UNEXPECTED_PROVIDER_BEHAVIOUR", fixtures: [{ reasonCode: "PROVIDER_REJECTED" }] });
  });

  it("stops when the provider reports a different model than the candidate", async () => {
    const { provider, invoke } = fake((fixture) => ({ kind: "COMPLETED", candidate: validOutput(fixture), usage: usage(), responseModel: "deepseek-v4-flash" }));
    const report = await run(provider);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({ stoppedReason: "UNEXPECTED_PROVIDER_BEHAVIOUR", fixtures: [{ responseModel: "deepseek-v4-flash" }] });
  });

  it("requires concurrency exactly 1", async () => {
    const { provider } = fake((fixture) => ({ kind: "COMPLETED", candidate: validOutput(fixture), usage: usage() }));
    await expect(run(provider, { concurrency: 2 as never })).rejects.toThrow("CONCURRENCY_MUST_BE_1");
  });

  it("keeps no secret, prompt, payload or raw response in the report or the console, and orders deterministically", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
    const script = (fixture: AiEvaluationFixture): ProviderInvocationResult => {
      const output = validOutput(fixture) as Record<string, any>;
      if (fixture.taskType === "DRAFT_CARE_PREPARATION_SUMMARY") output.payload.sections[0].bullets[0].text = `${SENTINEL} 6.2 mmol/L`;
      return { kind: "COMPLETED", candidate: output, usage: usage() };
    };
    const first: AiModelEvaluationReport = await run(fake(script).provider);
    tick = 0;
    const second = await run(fake(script).provider);
    const json = JSON.stringify(first);
    expect(json).not.toContain(SENTINEL);
    for (const forbidden of ["mmol", "pen in my bag", "instructions", "wording component", "6.2", "Recent recorded"]) expect(json).not.toContain(forbidden);
    expect(second).toEqual(first);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe("live-run completion guard (owner condition 2026-10-05)", () => {
  const plan = evaluationPlan(fixturesForPhase("SMOKE"), "SMOKE");
  const verdict = (report: AiModelEvaluationReport, candidates = 1, maxCredits = 2) => liveRunVerdict(report, plan, { maxCredits, candidateCount: candidates, requestModelId: MODEL.requestModelId, responseModelSnapshot: MODEL.responseModelSnapshot });
  const faithful = () => fake((fixture) => ({ kind: "COMPLETED", candidate: validOutput(fixture), usage: usage(), responseModel: MODEL.responseModelSnapshot }));

  it("passes a completed four-fixture, four-call smoke report within the credit ceiling", async () => {
    const report = await run(faithful().provider);
    expect(verdict(report)).toEqual({ kind: "PASS" });
    expect(report.fixtures.map((fixture) => [fixture.responseModel, fixture.schemaConformant])).toEqual(Array(4).fill([MODEL.responseModelSnapshot, true]));
  });

  it("fails on a provider failure even though no clinical hard gate failed", async () => {
    const report = await run(fake(() => ({ kind: "FAILED", reason: "PROVIDER_FAILED" })).provider);
    expect(report.hardGatePassed).toBe(true);
    const result = verdict(report);
    expect(result.kind).toBe("FAIL");
    expect(result.kind === "FAIL" && result.failures).toEqual(expect.arrayContaining(["NOT_COMPLETED", "STOPPED:UNEXPECTED_PROVIDER_BEHAVIOUR", "FIXTURE_COUNT", "CALL_COUNT"]));
  });

  it("fails on a timeout", async () => {
    const report = await run(fake(() => ({ kind: "FAILED", reason: "PROVIDER_TIMEOUT" })).provider);
    expect(verdict(report)).toMatchObject({ kind: "FAIL" });
  });

  it("fails on a credit-ceiling stop", async () => {
    const report = await run(fake((fixture) => ({ kind: "COMPLETED", candidate: validOutput(fixture), usage: usage(0.6), responseModel: MODEL.responseModelSnapshot })).provider, { limits: { ...LIMITS, maxCredits: 1 } });
    const result = verdict(report, 1, 1);
    expect(result.kind === "FAIL" && result.failures).toEqual(expect.arrayContaining(["NOT_COMPLETED", "STOPPED:CREDIT_CEILING", "CREDITS_OVER_CEILING"]));
  });

  it("fails on a partial fixture run", async () => {
    const report = await run(faithful().provider, { fixtures: SMOKE.slice(0, 3) });
    const result = verdict(report);
    expect(result.kind === "FAIL" && result.failures).toEqual(expect.arrayContaining(["FIXTURE_COUNT", "CALL_COUNT"]));
  });

  it("fails on a missing or substituted fixture even at the right count", async () => {
    const report = await run(faithful().provider);
    const tampered = { ...report, fixtures: [...report.fixtures.slice(0, 3), { ...report.fixtures[3]!, fixtureId: "p11.unexpected" }] };
    expect(verdict(tampered)).toMatchObject({ kind: "FAIL", failures: expect.arrayContaining(["FIXTURE_SET"]) });
  });

  it("fails on a clinical hard-gate failure", async () => {
    const report = await run(fake((fixture) => {
      const output = validOutput(fixture) as Record<string, any>;
      if (fixture.taskType === "EXPLAIN_PATTERN") output.payload.observation.text = "These readings are dangerous.";
      return { kind: "COMPLETED", candidate: output, usage: usage(), responseModel: MODEL.responseModelSnapshot };
    }).provider);
    expect(verdict(report)).toMatchObject({ kind: "FAIL", failures: expect.arrayContaining(["HARD_GATE"]) });
  });

  it("fails on any repair, a fallback outcome or a second candidate in the smoke phase", async () => {
    const report = await run(faithful().provider);
    expect(verdict({ ...report, totals: { ...report.totals, repairs: 1 } })).toMatchObject({ kind: "FAIL", failures: expect.arrayContaining(["UNEXPECTED_REPAIR"]) });
    expect(verdict(report, 2)).toMatchObject({ kind: "FAIL", failures: expect.arrayContaining(["SMOKE_CANDIDATE_COUNT"]) });
    const schemaFailure = await run(fake(() => ({ kind: "COMPLETED", candidate: "{not json", usage: usage(), responseModel: MODEL.responseModelSnapshot })).provider);
    expect(verdict(schemaFailure)).toMatchObject({ kind: "FAIL", failures: expect.arrayContaining(["FIXTURE_NOT_ACCEPTED"]) });
  });

  it("fails when the report names a different model than the approved candidate", async () => {
    const report = await run(faithful().provider);
    expect(liveRunVerdict(report, plan, { maxCredits: 2, candidateCount: 1, requestModelId: "gpt-5.4", responseModelSnapshot: MODEL.responseModelSnapshot })).toMatchObject({ kind: "FAIL", failures: expect.arrayContaining(["MODEL_MISMATCH"]) });
    const substituted = await run(fake((fixture) => ({ kind: "COMPLETED", candidate: validOutput(fixture), usage: usage(), responseModel: "deepseek-v4-flash" })).provider);
    expect(verdict(substituted)).toMatchObject({ kind: "FAIL", failures: expect.arrayContaining(["RESPONSE_MODEL_MISMATCH"]) });
  });

  it("smoke stays no-repair, concurrency 1 and exactly four calls", async () => {
    expect(plan).toMatchObject({ maxCalls: 4, allowRepair: false, fixtureCount: 4 });
    const { provider, invoke } = faithful();
    const report = await run(provider, { limits: { maxCalls: plan.maxCalls, maxCredits: 2, allowRepair: plan.allowRepair } });
    expect(invoke).toHaveBeenCalledTimes(4);
    expect(report.totals).toMatchObject({ calls: 4, repairs: 0, fixtures: 4 });
    await expect(run(provider, { concurrency: 2 as never })).rejects.toThrow("CONCURRENCY_MUST_BE_1");
  });
});

describe("live runner wiring", () => {
  const source = readFileSync(join(process.cwd(), "src/ai/evaluation/packet-11-live-kie.test.ts"), "utf8");

  it("is skipped unless explicitly flagged and confirms the call count before any request", () => {
    expect(source).toMatch(/describe\.skipIf\(!LIVE\)/);
    expect(source).toContain('env.RUN_LIVE_KIE_EVALUATION === "1"');
    expect(source.indexOf("KIE_EVALUATION_CONFIRM_MAX_CALLS !==")).toBeLessThan(source.indexOf("discoverKieModels({"));
  });

  it("prints the exact contract, fixture-set and bundle revisions after the contract check and before any model call", () => {
    const printed = source.indexOf("packet11Contract:");
    expect(printed).toBeGreaterThan(source.indexOf("contractMismatches("));
    expect(printed).toBeLessThan(source.indexOf("evaluateModelSnapshot({"));
    expect(source).toMatch(/packet11Contract: \{ \.\.\.APPROVED_SMOKE_CONTRACT, explainPatternBundle: AI_TASK_RUNTIME_BUNDLES\.EXPLAIN_PATTERN\.bundleKey/);
  });

  it("checks the smoke candidate count before any model call and fails on any non-passing verdict", () => {
    expect(source.indexOf("SMOKE_CANDIDATE_COUNT")).toBeLessThan(source.indexOf("evaluateModelSnapshot({"));
    expect(source).toContain("liveRunVerdict(report, plan,");
    expect(source).toMatch(/if \(verdict\.kind === "FAIL"\) throw new Error/);
    expect(source).not.toMatch(/expect\(report\.hardGatePassed\)/);
  });
});

describe("DIAGNOSTIC phase (owner instruction 2026-10-05)", () => {
  const diagnosticFixtures = fixturesForPhase("DIAGNOSTIC");
  const plan = evaluationPlan(diagnosticFixtures, "DIAGNOSTIC");
  const DIAGNOSTIC: KieProviderDiagnostic = { code: "BODY_NOT_JSON", httpStatus: 200, contentTypeClass: "OTHER", topLevelKeys: null, bodyValidJson: false, documentedSchemaParsed: null, parserStage: "JSON_PARSE", modelIdentity: null, envelopeOtherwiseValid: null, mismatchUsage: null, reportedUsage: null, retention: null };

  it("contains exactly the failed smoke call's fixture: EXPLAIN_PATTERN / en-SG / ordinary", () => {
    expect(diagnosticFixtures.map((fixture) => [fixture.id, fixture.taskType, fixture.locale, fixture.category])).toEqual([["p11.explain-pattern.en-sg.ordinary", "EXPLAIN_PATTERN", "en-SG", "ORDINARY"]]);
    expect(diagnosticFixtures[0]).toBe(fixturesForPhase("SMOKE")[0]);
    expect(plan).toMatchObject({ phase: "DIAGNOSTIC", fixtureCount: 1, fixtureIds: ["p11.explain-pattern.en-sg.ordinary"], maxCalls: 1, allowRepair: false });
  });

  it("sends exactly the same request body as the failed smoke call", async () => {
    const bodies: string[] = [];
    const fetcher = async (_url: string, init: RequestInit) => {
      bodies.push(init.body as string);
      return new Response("{}", { status: 500 });
    };
    for (const phase of ["SMOKE", "DIAGNOSTIC"] as const) {
      const provider = createKieResponsesProvider({ token: "t", model: MODEL, fetcher });
      await run(provider, { phase, fixtures: fixturesForPhase(phase), limits: { maxCalls: 1, maxCredits: 1, allowRepair: false } });
    }
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
  });

  it("makes at most one call, never repairs, and attaches only the redacted diagnostic", async () => {
    const { provider, invoke } = fake(() => ({ kind: "COMPLETED", candidate: "{not json", usage: usage() }), diagnosticFixtures);
    const report = await run(provider, { phase: "DIAGNOSTIC", fixtures: diagnosticFixtures, limits: { maxCalls: plan.maxCalls, maxCredits: 1, allowRepair: false }, takeDiagnostic: () => DIAGNOSTIC });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(report.fixtures).toEqual([expect.objectContaining({ attempts: 1, repairUsed: false, diagnostic: DIAGNOSTIC })]);
    expect(report.stoppedReason).toBe("SMOKE_FALLBACK");
  });

  it("fails the live completion guard unless the single call completed and was accepted", async () => {
    const failing = await run(fake(() => ({ kind: "FAILED", reason: "PROVIDER_FAILED" }), diagnosticFixtures).provider, { phase: "DIAGNOSTIC", fixtures: diagnosticFixtures, limits: { maxCalls: 1, maxCredits: 1, allowRepair: false } });
    expect(liveRunVerdict(failing, plan, { maxCredits: 1, candidateCount: 1, requestModelId: MODEL.requestModelId, responseModelSnapshot: MODEL.responseModelSnapshot })).toMatchObject({ kind: "FAIL" });
    const passing = await run(fake((fixture) => ({ kind: "COMPLETED", candidate: validOutput(fixture), usage: usage(), responseModel: MODEL.responseModelSnapshot }), diagnosticFixtures).provider, { phase: "DIAGNOSTIC", fixtures: diagnosticFixtures, limits: { maxCalls: 1, maxCredits: 1, allowRepair: false } });
    expect(liveRunVerdict(passing, plan, { maxCredits: 1, candidateCount: 1, requestModelId: MODEL.requestModelId, responseModelSnapshot: MODEL.responseModelSnapshot })).toEqual({ kind: "PASS" });
    expect(liveRunVerdict(passing, plan, { maxCredits: 1, candidateCount: 2, requestModelId: MODEL.requestModelId, responseModelSnapshot: MODEL.responseModelSnapshot })).toMatchObject({ kind: "FAIL", failures: expect.arrayContaining(["SMOKE_CANDIDATE_COUNT"]) });
  });

  it("the live runner accepts the diagnostic phase and never continues into another phase", () => {
    const source = readFileSync(join(process.cwd(), "src/ai/evaluation/packet-11-live-kie.test.ts"), "utf8");
    expect(source).toContain('env.KIE_EVALUATION_PHASE === "diagnostic"');
    expect(source.match(/fixturesForPhase\(/g)).toHaveLength(1);
    expect(source).toContain("onDiagnostic");
  });
});

describe("public route isolation", () => {
  it("the application route never observes or returns the diagnostic", () => {
    // Packet 11C B2b (B2a review follow-up): the app's provider route is now the value-blind shell route; the retired legacy route stays pinned.
    for (const file of ["src/app/api/ai/task/ai-task-handler.ts", "src/app/api/ai/shell/ai-shell-handler.ts", "src/app/api/ai/shell/route.ts"]) {
      expect(readFileSync(join(process.cwd(), file), "utf8"), file).not.toMatch(/onDiagnostic|KieProviderDiagnostic|diagnostic/i);
    }
  });
});

describe("model-identity evidence in the redacted evaluation report", () => {
  const diagnosticFixtures = fixturesForPhase("DIAGNOSTIC");
  const mismatchFetch = (model: string) => async () =>
    new Response(
      JSON.stringify({
        status: "completed",
        model,
        output: [
          { type: "reasoning", summary: [{ type: "summary_text", text: "SENTINEL-SUMMARY" }] },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify({ ...(validOutput(diagnosticFixtures[0]!) as object), abstentionReason: null, note: "SENTINEL-OUTPUT" }) }] },
        ],
        usage: { input_tokens: 900, output_tokens: 160, output_tokens_details: { reasoning_tokens: 0 } },
        credits_consumed: 0.04,
        store: false,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  it("carries the exact safe returned identifier and mismatch usage, counted toward totals, and nothing else", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
    let last: KieProviderDiagnostic | null = null;
    const provider = createKieResponsesProvider({ token: SENTINEL, model: MODEL, fetcher: mismatchFetch("deepseek/deepseek-v4-1-flash-260910"), onDiagnostic: (diagnostic) => (last = diagnostic) });
    const report = await run(provider, {
      phase: "DIAGNOSTIC",
      fixtures: diagnosticFixtures,
      limits: { maxCalls: 1, maxCredits: 1, allowRepair: false },
      takeDiagnostic: () => {
        const taken = last;
        last = null;
        return taken;
      },
    });
    expect(report.fixtures[0]).toMatchObject({
      reasonCode: "PROVIDER_FAILED",
      inputTokens: 900,
      outputTokens: 160,
      credits: 0.04,
      diagnostic: { code: "RESPONSE_MODEL_MISMATCH", modelIdentity: { requested: "deepseek-v4-1-flash", expected: "deepseek-v4-1-flash-260910", returned: "deepseek/deepseek-v4-1-flash-260910", comparison: "NAMESPACE_PREFIXED" }, mismatchUsage: { inputTokens: 900, outputTokens: 160, reasoningTokens: 0, credits: 0.04 } },
    });
    expect(report.totals.credits).toBeCloseTo(0.04);
    const json = JSON.stringify(report);
    for (const secret of [SENTINEL, "SENTINEL-SUMMARY", "SENTINEL-OUTPUT", "wording component", "Recent recorded", "mmol"]) expect(json, secret).not.toContain(secret);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("stops at the credit ceiling using credits reported on a mismatched call", async () => {
    let last: KieProviderDiagnostic | null = null;
    const provider = createKieResponsesProvider({ token: "t", model: MODEL, fetcher: mismatchFetch("deepseek-v4-flash"), onDiagnostic: (diagnostic) => (last = diagnostic) });
    const report = await run(provider, { phase: "FULL", fixtures: fixturesForPhase("SMOKE"), limits: { maxCalls: 8, maxCredits: 0.04, allowRepair: true }, takeDiagnostic: () => last });
    expect(report.totals).toMatchObject({ calls: 1, credits: 0.04 });
  });
});

describe("exact dual identity in evidence and audits (owner approval 2026-10-05)", () => {
  it("records the expected response snapshot, never the request alias, in the AI audit row", async () => {
    const fixture = fixturesForPhase("SMOKE")[0]!;
    const rows: AiInvocationAuditRow[] = [];
    const fetcher = async () =>
      new Response(JSON.stringify({ status: "completed", model: "deepseek-v4-1-flash-260910", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify({ ...(validOutput(fixture) as object), abstentionReason: null }) }] }], usage: { input_tokens: 644, output_tokens: 234 }, credits_consumed: 0.02, store: false }), { status: 200, headers: { "content-type": "application/json" } });
    const provider = createKieResponsesProvider({ token: "t", model: MODEL, fetcher });
    const service = createAiTaskService({
      releaseProfile: "HACKATHON_DEMO",
      manifest: { ...AI_ACTIVATION_MANIFEST, tasks: { ...AI_ACTIVATION_MANIFEST.tasks, EXPLAIN_PATTERN: "SYNTHETIC_REMOTE_ENABLED" } },
      provider,
      audit: { append: async (row) => void rows.push(row) },
      now: () => "2026-10-05T02:00:00.000Z",
      monotonicMs: () => 0,
    });
    expect(await service.execute(fixture.request)).toMatchObject({ kind: "ACCEPTED" });
    const row = aiInvocationAuditRowSchema.parse(rows[0]);
    expect(row.providerModel).toEqual({ providerKey: "kie", modelSnapshot: "deepseek-v4-1-flash-260910" });
    expect(JSON.stringify(row)).not.toContain('"deepseek-v4-1-flash"');
  });

  it("reports both identifiers in the redacted report and fails the guard on a returned request alias", async () => {
    const report = await run(fake((fixture) => ({ kind: "COMPLETED", candidate: validOutput(fixture), usage: usage(), responseModel: MODEL.responseModelSnapshot })).provider);
    expect(report.model).toMatchObject({ requestModelId: "deepseek-v4-1-flash", responseModelSnapshot: "deepseek-v4-1-flash-260910", provenance: "DOCUMENTED_UNLISTED_EVALUATION_ONLY" });
    const plan = evaluationPlan(fixturesForPhase("SMOKE"), "SMOKE");
    expect(liveRunVerdict(report, plan, { maxCredits: 0.25, candidateCount: 1, requestModelId: MODEL.requestModelId, responseModelSnapshot: MODEL.responseModelSnapshot })).toEqual({ kind: "PASS" });
    const alias = await run(fake((fixture) => ({ kind: "COMPLETED", candidate: validOutput(fixture), usage: usage(), responseModel: MODEL.requestModelId })).provider);
    expect(alias.stoppedReason).toBe("UNEXPECTED_PROVIDER_BEHAVIOUR");
    expect(liveRunVerdict(alias, plan, { maxCredits: 0.25, candidateCount: 1, requestModelId: MODEL.requestModelId, responseModelSnapshot: MODEL.responseModelSnapshot })).toMatchObject({ kind: "FAIL", failures: expect.arrayContaining(["RESPONSE_MODEL_MISMATCH"]) });
  });
});

describe("reference diagnostic in evaluation evidence", () => {
  it("attaches the value-free diagnostic only to a REFERENCE_MISMATCH fixture", async () => {
    const diagnosticFixtures = fixturesForPhase("DIAGNOSTIC");
    const omitted = (validOutput(diagnosticFixtures[0]!) as Record<string, any>);
    omitted.inputRefsUsed = omitted.inputRefsUsed.filter((entry: string) => entry !== "claim-1");
    const rejected = await run(fake(() => ({ kind: "COMPLETED", candidate: omitted, usage: usage(), responseModel: MODEL.responseModelSnapshot }), diagnosticFixtures).provider, { phase: "DIAGNOSTIC", fixtures: diagnosticFixtures, limits: { maxCalls: 1, maxCredits: 1, allowRepair: false } });
    expect(rejected.fixtures[0]).toMatchObject({ reasonCode: "REFERENCE_MISMATCH", referenceDiagnostic: { findings: expect.arrayContaining([expect.objectContaining({ category: "CITED_REFERENCE_NOT_LISTED", referenceKind: "CLAIM", fixtureReferences: ["claim-1"] })]) } });
    const accepted = await run(fake((fixture) => ({ kind: "COMPLETED", candidate: validOutput(fixture), usage: usage(), responseModel: MODEL.responseModelSnapshot })).provider);
    expect(accepted.fixtures.every((fixture) => fixture.referenceDiagnostic === null)).toBe(true);
  });
});

describe("live runner without a model-listing request (owner instruction 2026-10-05)", () => {
  const source = readFileSync(join(process.cwd(), "src/ai/evaluation/packet-11-live-kie.test.ts"), "utf8");

  it("skips the listing GET only when explicitly told to, after the call-count confirmation", () => {
    expect(source).toMatch(/env\.KIE_EVALUATION_NO_LISTING === "1"\s*\?\s*\[\]\s*:\s*await discoverKieModels\(/);
    expect(source.indexOf("KIE_EVALUATION_CONFIRM_MAX_CALLS !==")).toBeLessThan(source.indexOf("env.KIE_EVALUATION_NO_LISTING"));
  });

  it("with an empty listing selects only the owner-approved documented candidate with its exact pair", async () => {
    const { selectEvaluationCandidates } = await import("@/ai/kie/kie-route-config");
    const selection = selectEvaluationCandidates({ requested: "grok-4-7", listing: [], now: () => "2026-10-06T04:00:00.000Z" });
    expect(selection).toMatchObject({ kind: "SELECTED", candidates: [{ requestModelId: "grok-4-7", responseModelSnapshot: "grok-4-7", provenance: "DOCUMENTED_UNLISTED_EVALUATION_ONLY" }] });
    // DeepSeek is not qualified and Kimi K3 is excluded (owner 2026-10-06): refused before any request.
    expect(selectEvaluationCandidates({ requested: "deepseek-v4-1-flash", listing: [], now: () => "x" })).toEqual({ kind: "REJECTED", reason: "EXCLUDED_MODEL" });
    expect(selectEvaluationCandidates({ requested: "gpt-5.4", listing: [], now: () => "x" })).toEqual({ kind: "REJECTED", reason: "UNKNOWN_MODEL" });
  });
});

describe("schema diagnostic in evaluation evidence", () => {
  it("attaches the value-free schema diagnostic only to a SCHEMA_INVALID fixture and stops the smoke", async () => {
    const smoke = fixturesForPhase("SMOKE");
    const { provider, invoke } = fake((fixture) => {
      const output = validOutput(fixture) as Record<string, any>;
      if (fixture.taskType === "DRAFT_CARE_PREPARATION_SUMMARY") output.payload.sections[0].bullets[0].factRefs = ["fact-1", "fact-1"];
      return { kind: "COMPLETED", candidate: output, usage: usage(), responseModel: MODEL.responseModelSnapshot };
    });
    const report = await run(provider);
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(report.stoppedReason).toBe("SMOKE_FALLBACK");
    expect(report.fixtures.map((fixture) => fixture.schemaDiagnostic === null)).toEqual([true, true, false]);
    expect(report.fixtures[2]).toMatchObject({
      fixtureId: smoke[2]!.id,
      reasonCode: "SCHEMA_INVALID",
      schemaDiagnostic: { version: "packet11-schemadiag.1", findings: [{ category: "DUPLICATE_ITEM", path: "payload.sections[].bullets[].factRefs", rule: "unique", count: 1, boundary: null }] },
      referenceDiagnostic: null,
    });
  });
});

describe("meaning diagnostic in evaluation evidence", () => {
  it("attaches the value-free meaning diagnostic only to a CLINICAL_MEANING_VIOLATION fixture", async () => {
    const { provider } = fake((fixture) => {
      const output = validOutput(fixture) as Record<string, any>;
      // Option B: limitation-style wording can only appear in a generated field such as evidence.
      output.payload.evidence.text = "This does not establish a cause, but the meal caused the rise.";
      return { kind: "COMPLETED", candidate: output, usage: usage(), responseModel: MODEL.responseModelSnapshot };
    });
    const report = await run(provider);
    expect(report.fixtures).toHaveLength(1);
    expect(report.fixtures[0]).toMatchObject({
      reasonCode: "CLINICAL_MEANING_VIOLATION",
      meaningDiagnostic: { version: "packet11-meaningdiag.1", findings: [{ category: "CAUSATION", rule: "clinical.causation.en", path: "payload.evidence.text", count: 1 }] },
      schemaDiagnostic: null,
      referenceDiagnostic: null,
    });
    expect(JSON.stringify(report)).not.toMatch(/establish|meal/);
    const accepted = await run(fake((fixture) => ({ kind: "COMPLETED", candidate: validOutput(fixture), usage: usage(), responseModel: MODEL.responseModelSnapshot })).provider);
    expect(accepted.fixtures.every((fixture) => fixture.meaningDiagnostic === null)).toBe(true);
  });
});

describe("CARE_DIAGNOSTIC phase (Packet 11B corrective pass)", () => {
  it("contains exactly the care-summary en-SG ordinary fixture, one call, no repair", () => {
    const fixtures = fixturesForPhase("CARE_DIAGNOSTIC");
    expect(fixtures.map((fixture) => fixture.id)).toEqual(["p11.draft-care-preparation-summary.en-sg.ordinary"]);
    expect(fixtures[0]).toBe(fixturesForPhase("SMOKE")[2]);
    expect(evaluationPlan(fixtures, "CARE_DIAGNOSTIC")).toMatchObject({ phase: "CARE_DIAGNOSTIC", fixtureCount: 1, maxCalls: 1, allowRepair: false });
  });

  it("captures the value-free schema diagnostic and fails the guard on a schema failure", async () => {
    const fixtures = fixturesForPhase("CARE_DIAGNOSTIC");
    const plan = evaluationPlan(fixtures, "CARE_DIAGNOSTIC");
    const { provider, invoke } = fake((fixture) => {
      const output = validOutput(fixture) as Record<string, any>;
      output.payload.sections[0].bullets[0].factRefs = ["fact-1", "fact-1"];
      return { kind: "COMPLETED", candidate: output, usage: usage(), responseModel: MODEL.responseModelSnapshot };
    }, fixtures);
    const report = await run(provider, { phase: "CARE_DIAGNOSTIC", fixtures, limits: { maxCalls: 1, maxCredits: 0.25, allowRepair: false } });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(report.fixtures[0]).toMatchObject({ reasonCode: "SCHEMA_INVALID", schemaDiagnostic: { findings: [{ category: "DUPLICATE_ITEM", path: "payload.sections[].bullets[].factRefs" }] } });
    expect(liveRunVerdict(report, plan, { maxCredits: 0.25, candidateCount: 1, requestModelId: MODEL.requestModelId, responseModelSnapshot: MODEL.responseModelSnapshot })).toMatchObject({ kind: "FAIL" });
  });

  it("the live runner accepts the care_diagnostic phase", () => {
    const source = readFileSync(join(process.cwd(), "src/ai/evaluation/packet-11-live-kie.test.ts"), "utf8");
    expect(source).toContain('env.KIE_EVALUATION_PHASE === "care_diagnostic"');
  });
});

describe("validatorRulesRevision evidence and the approved smoke contract (owner instruction 2026-10-05)", () => {
  const smokePlan = evaluationPlan(fixturesForPhase("SMOKE"), "SMOKE");
  const approved = { maxCredits: 0.25, candidateCount: 1, requestModelId: MODEL.requestModelId, responseModelSnapshot: MODEL.responseModelSnapshot };

  it("pins the exact approved contract as closed constants", async () => {
    const evaluation = await import("./packet-11-evaluation");
    expect(evaluation.VALIDATOR_RULES_REVISION).toBe("11b.2-meaning-r7");
    expect(evaluation.APPROVED_SMOKE_CONTRACT).toEqual({
      requestModelId: "deepseek-flash",
      responseModelSnapshot: "deepseek-flash",
      promptVersion: "11b.11",
      providerSchemaVersion: "kie-schema.11b.3",
      routeVersion: "packet11-responses.11b.6",
      validatorRulesRevision: "11b.2-meaning-r7",
      approvedMeaningRegistryRevision: "ai-meaning-registry.11b.1",
      fixtureSetRevision: "packet11-fixtures.11b.3",
      evaluationReportVersion: "packet11-eval.4",
    });
    expect(Object.isFrozen(evaluation.APPROVED_SMOKE_CONTRACT)).toBe(true);
    expect(evaluation.contractMismatches({ requestModelId: "deepseek-flash", responseModelSnapshot: "deepseek-flash" })).toEqual([]);
    expect(evaluation.contractMismatches({ requestModelId: "deepseek-flash", responseModelSnapshot: "deepseek-v4-flash" })).toEqual(["responseModelSnapshot"]);
    expect(evaluation.contractMismatches({ requestModelId: "grok-4-7", responseModelSnapshot: "grok-4-7" })).toEqual(["requestModelId", "responseModelSnapshot"]);
    expect(evaluation.contractMismatches(MODEL)).toEqual(["requestModelId", "responseModelSnapshot"]);
  });

  it("records the exact revision in every report, from the harness, never from the provider", async () => {
    const fixtures = fixturesForPhase("DIAGNOSTIC");
    const fetcher = async () =>
      new Response(
        JSON.stringify({
          status: "completed",
          model: MODEL.responseModelSnapshot,
          validatorRulesRevision: "provider-supplied-SENTINEL",
          promptVersion: "provider-supplied-SENTINEL",
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify({ ...(validOutput(fixtures[0]!) as object), abstentionReason: null }) }] }],
          usage: { input_tokens: 644, output_tokens: 200 },
          credits_consumed: 0.02,
          store: false,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const report = await run(createKieResponsesProvider({ token: "t", model: MODEL, fetcher }), { phase: "DIAGNOSTIC", fixtures, limits: { maxCalls: 1, maxCredits: 0.25, allowRepair: false } });
    expect(report).toMatchObject({ validatorRulesRevision: "11b.2-meaning-r7", promptVersion: "11b.11", providerSchemaVersion: "kie-schema.11b.3", routeVersion: "packet11-responses.11b.6", approvedMeaningRegistryRevision: "ai-meaning-registry.11b.1", fixtureSetRevision: "packet11-fixtures.11b.3" });
    expect(JSON.stringify(report)).not.toContain("SENTINEL");
  });

  it("fails the live verdict when any contract version in the report differs from the approved contract", async () => {
    const report = await run(fake((fixture) => ({ kind: "COMPLETED", candidate: validOutput(fixture), usage: usage(), responseModel: MODEL.responseModelSnapshot })).provider);
    expect(liveRunVerdict(report, smokePlan, approved)).toEqual({ kind: "PASS" });
    for (const field of ["promptVersion", "providerSchemaVersion", "routeVersion", "validatorRulesRevision"] as const) {
      expect(liveRunVerdict({ ...report, [field]: "x" }, smokePlan, approved)).toMatchObject({ kind: "FAIL", failures: expect.arrayContaining([`CONTRACT_VERSION_MISMATCH:${field}`]) });
    }
  });

  it("evidence collected under kie-responses.11b.5, 11b.4, 11b.3, 11b.2 or 11b.1 cannot qualify packet11-responses.11b.6", async () => {
    const report = await run(fake((fixture) => ({ kind: "COMPLETED", candidate: validOutput(fixture), usage: usage(), responseModel: MODEL.responseModelSnapshot })).provider);
    expect(report.routeVersion).toBe("packet11-responses.11b.6");
    expect(liveRunVerdict(report, smokePlan, approved)).toEqual({ kind: "PASS" });
    for (const earlier of ["kie-responses.11b.5", "kie-responses.11b.4", "kie-responses.11b.3", "kie-responses.11b.2", "kie-responses.11b.1"]) {
      expect(liveRunVerdict({ ...report, routeVersion: earlier }, smokePlan, approved)).toEqual({ kind: "FAIL", failures: ["CONTRACT_VERSION_MISMATCH:routeVersion"] });
    }
  });

  it("evidence collected under validator rules r6, r5, r4, r3, r2 or r1 cannot qualify r7", async () => {
    const report = await run(fake((fixture) => ({ kind: "COMPLETED", candidate: validOutput(fixture), usage: usage(), responseModel: MODEL.responseModelSnapshot })).provider);
    expect(report.validatorRulesRevision).toBe("11b.2-meaning-r7");
    expect(liveRunVerdict(report, smokePlan, approved)).toEqual({ kind: "PASS" });
    for (const earlier of ["11b.2-meaning-r6", "11b.2-meaning-r5", "11b.2-meaning-r4", "11b.2-meaning-r3", "11b.2-meaning-r2", "11b.2-meaning-r1"]) {
      expect(liveRunVerdict({ ...report, validatorRulesRevision: earlier }, smokePlan, approved)).toEqual({ kind: "FAIL", failures: ["CONTRACT_VERSION_MISMATCH:validatorRulesRevision"] });
    }
  });

  it("evidence collected under prompt 11b.10, 11b.9, 11b.8, 11b.7, 11b.6, 11b.5, 11b.4, 11b.3, 11b.2 or 11b.1 cannot qualify prompt 11b.11", async () => {
    const report = await run(fake((fixture) => ({ kind: "COMPLETED", candidate: validOutput(fixture), usage: usage(), responseModel: MODEL.responseModelSnapshot })).provider);
    expect(report.promptVersion).toBe("11b.11");
    expect(liveRunVerdict(report, smokePlan, approved)).toEqual({ kind: "PASS" });
    for (const earlier of ["11b.10", "11b.9", "11b.8", "11b.7", "11b.6", "11b.5", "11b.4", "11b.3", "11b.2", "11b.1"]) {
      expect(liveRunVerdict({ ...report, promptVersion: earlier }, smokePlan, approved)).toEqual({ kind: "FAIL", failures: ["CONTRACT_VERSION_MISMATCH:promptVersion"] });
    }
  });

  it("the live runner verifies the approved contract before any request, and the route never sees the revision", () => {
    const source = readFileSync(join(process.cwd(), "src/ai/evaluation/packet-11-live-kie.test.ts"), "utf8");
    expect(source.indexOf("contractMismatches(")).toBeGreaterThan(0);
    expect(source.indexOf("contractMismatches(")).toBeLessThan(source.indexOf("evaluateModelSnapshot({"));
    expect(source).toMatch(/if \(mismatches\.length > 0\) throw new Error/);
    // Both bundle versions are printed with the closed contract before any model call (owner instruction 2026-10-05).
    for (const printed of ["explainPatternBundle: AI_TASK_RUNTIME_BUNDLES.EXPLAIN_PATTERN.bundleKey", "careSummaryBundle: AI_TASK_RUNTIME_BUNDLES.DRAFT_CARE_PREPARATION_SUMMARY.bundleKey"]) {
      expect(source.indexOf(printed), printed).toBeGreaterThan(source.indexOf("contractMismatches("));
      expect(source.indexOf(printed), printed).toBeLessThan(source.indexOf("evaluateModelSnapshot({"));
    }
    // Packet 11C B2b (B2a review follow-up): the value-blind shell route is pinned beside the retired legacy route.
    for (const file of ["src/app/api/ai/task/ai-task-handler.ts", "src/app/api/ai/task/route.ts", "src/app/api/ai/shell/ai-shell-handler.ts", "src/app/api/ai/shell/route.ts"]) {
      expect(readFileSync(join(process.cwd(), file), "utf8"), file).not.toMatch(/validatorRulesRevision|VALIDATOR_RULES_REVISION/);
    }
  });
});

describe("closed abstention-reason evidence (owner instruction 2026-10-05)", () => {
  const diagnostic = fixturesForPhase("DIAGNOSTIC");
  const once = (candidate: unknown) => run(fake(() => ({ kind: "COMPLETED", candidate, usage: usage(), responseModel: MODEL.responseModelSnapshot }), diagnostic).provider, { phase: "DIAGNOSTIC", fixtures: diagnostic, limits: { maxCalls: 1, maxCredits: 0.25, allowRepair: false } });
  const abstain = (reason: unknown) => {
    const { payload: _payload, ...rest } = validOutput(diagnostic[0]!) as Record<string, unknown>;
    void _payload;
    return { ...rest, outcome: "ABSTAIN", abstentionReason: reason };
  };

  it.each(["INSUFFICIENT_CONTEXT", "AMBIGUOUS_INPUT", "CANNOT_PRESERVE_MEANING"])("records the closed reason %s for a valid ABSTAIN variant", async (reason) => {
    const report = await once(abstain(reason));
    expect(report.fixtures[0]).toMatchObject({ outcome: "FALLBACK", reasonCode: "MODEL_ABSTAINED", abstentionReason: reason });
  });

  it.each([["an unknown reason", "TIRED"], ["a malicious string", "SENTINEL-<script> Tan Ah Kow S1234567D"], ["a number", 7], ["null", null]])("never coerces %s: it stays SCHEMA_INVALID with no reason recorded", async (_label, reason) => {
    const report = await once(abstain(reason));
    expect(report.fixtures[0]).toMatchObject({ reasonCode: "SCHEMA_INVALID", abstentionReason: null });
    expect(JSON.stringify(report)).not.toMatch(/SENTINEL|TIRED|Tan Ah Kow|S1234567D/);
  });

  it("records no reason for accepted output, and ignores provider-supplied evidence metadata", async () => {
    expect((await once(validOutput(diagnostic[0]!))).fixtures[0]).toMatchObject({ outcome: "ACCEPTED", abstentionReason: null });
    const fetcher = async () =>
      new Response(
        JSON.stringify({
          status: "completed",
          model: MODEL.responseModelSnapshot,
          abstentionReason: "AMBIGUOUS_INPUT",
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify({ ...(validOutput(diagnostic[0]!) as object), abstentionReason: null }) }] }],
          usage: { input_tokens: 600, output_tokens: 200 },
          credits_consumed: 0.02,
          store: false,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const report = await run(createKieResponsesProvider({ token: "t", model: MODEL, fetcher }), { phase: "DIAGNOSTIC", fixtures: diagnostic, limits: { maxCalls: 1, maxCredits: 0.25, allowRepair: false } });
    expect(report.fixtures[0]).toMatchObject({ outcome: "ACCEPTED", abstentionReason: null });
  });

  it("leaves the application-facing result and the production audit record unchanged", async () => {
    const rows: AiInvocationAuditRow[] = [];
    const service = createAiTaskService({
      releaseProfile: "HACKATHON_DEMO",
      manifest: { ...AI_ACTIVATION_MANIFEST, tasks: { ...AI_ACTIVATION_MANIFEST.tasks, EXPLAIN_PATTERN: "SYNTHETIC_REMOTE_ENABLED" } },
      provider: { providerModel: { providerKey: "kie", modelSnapshot: MODEL.responseModelSnapshot }, invoke: async () => ({ kind: "COMPLETED", candidate: abstain("AMBIGUOUS_INPUT"), usage: usage() }) },
      audit: { append: async (row) => void rows.push(row) },
      now: () => "2026-10-06T04:00:00.000Z",
      monotonicMs: () => 0,
    });
    const result = await service.execute(diagnostic[0]!.request);
    expect(result).toMatchObject({ kind: "FALLBACK", fallback: { reason: "MODEL_ABSTAINED" } });
    expect(JSON.stringify(result)).not.toContain("AMBIGUOUS_INPUT");
    expect(aiInvocationAuditRowSchema.safeParse({ ...rows[0], abstentionReason: "AMBIGUOUS_INPUT" }).success).toBe(false);
    expect(JSON.stringify(rows[0])).not.toContain("AMBIGUOUS_INPUT");
  });
});

describe("provider-side retention evidence and qualification (owner instruction 2026-10-05)", () => {
  const plan = evaluationPlan(SMOKE, "SMOKE");
  const verdictOf = (report: AiModelEvaluationReport) => liveRunVerdict(report, plan, { maxCredits: 2, candidateCount: 1, requestModelId: MODEL.requestModelId, responseModelSnapshot: MODEL.responseModelSnapshot });
  const accepted = (retention?: string) => fake((fixture) => ({ kind: "COMPLETED", candidate: validOutput(fixture), usage: usage(), responseModel: MODEL.responseModelSnapshot, ...(retention === undefined ? {} : { retention }) }) as ProviderInvocationResult);

  it("records CONFIRMED_NOT_STORED per fixture and still qualifies", async () => {
    const report = await run(accepted().provider);
    expect(report.fixtures.map((fixture) => fixture.retention)).toEqual(["CONFIRMED_NOT_STORED", "CONFIRMED_NOT_STORED", "CONFIRMED_NOT_STORED", "CONFIRMED_NOT_STORED"]);
    expect(verdictOf(report)).toEqual({ kind: "PASS" });
  });

  it("an unconfirmed result keeps the validator's outcome as evidence but stops the run and prevents qualification", async () => {
    const report = await run(accepted("RETENTION_UNCONFIRMED").provider);
    expect(report.fixtures).toHaveLength(1);
    expect(report.fixtures[0]).toMatchObject({ outcome: "ACCEPTED", retention: "RETENTION_UNCONFIRMED" });
    expect(report.stoppedReason).toBe("RETENTION_NOT_CONFIRMED");
    expect(verdictOf(report)).toMatchObject({ kind: "FAIL", failures: expect.arrayContaining(["RETENTION_NOT_CONFIRMED"]) });
  });

  it("treats a provider result that carries no retention result as unconfirmed", async () => {
    const plain: AiProviderPort = { providerModel: { providerKey: "kie", modelSnapshot: MODEL.responseModelSnapshot }, invoke: async () => ({ kind: "COMPLETED", candidate: validOutput(SMOKE[0]!), usage: usage(), responseModel: MODEL.responseModelSnapshot }) };
    const report = await run(plain);
    expect(report.fixtures[0]).toMatchObject({ retention: "RETENTION_UNCONFIRMED" });
    expect(verdictOf(report)).toMatchObject({ kind: "FAIL", failures: expect.arrayContaining(["RETENTION_NOT_CONFIRMED"]) });
  });

  it("a stored response is a provider failure with deterministic fallback, billed usage counted, and no qualification", async () => {
    const diagnostic = fixturesForPhase("DIAGNOSTIC");
    let last: KieProviderDiagnostic | null = null;
    const fetcher = async () =>
      new Response(JSON.stringify({ status: "completed", model: MODEL.responseModelSnapshot, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify({ ...(validOutput(diagnostic[0]!) as object), abstentionReason: null }) }] }], usage: { input_tokens: 687, output_tokens: 210 }, credits_consumed: 0.02, store: true }), { status: 200, headers: { "content-type": "application/json" } });
    const provider = createKieResponsesProvider({ token: SENTINEL, model: MODEL, fetcher, onDiagnostic: (value) => (last = value) });
    const takeDiagnostic = () => {
      const taken = last;
      last = null;
      return taken;
    };
    const report = await run(provider, { phase: "DIAGNOSTIC", fixtures: diagnostic, limits: { maxCalls: 1, maxCredits: 0.05, allowRepair: false }, takeDiagnostic });
    expect(report.fixtures[0]).toMatchObject({ outcome: "FALLBACK", reasonCode: "PROVIDER_FAILED", retention: "PROVIDER_REPORTED_STORED", credits: 0.02 });
    expect(report.totals.credits).toBe(0.02);
    expect(liveRunVerdict(report, evaluationPlan(diagnostic, "DIAGNOSTIC"), { maxCredits: 0.05, candidateCount: 1, requestModelId: MODEL.requestModelId, responseModelSnapshot: MODEL.responseModelSnapshot })).toMatchObject({ kind: "FAIL", failures: expect.arrayContaining(["RETENTION_NOT_CONFIRMED"]) });
  });

  it("never places the retention result in the application result or the audit row", async () => {
    const rows: AiInvocationAuditRow[] = [];
    const service = createAiTaskService({
      releaseProfile: "HACKATHON_DEMO",
      manifest: { ...AI_ACTIVATION_MANIFEST, tasks: { ...AI_ACTIVATION_MANIFEST.tasks, EXPLAIN_PATTERN: "SYNTHETIC_REMOTE_ENABLED" } },
      provider: { providerModel: { providerKey: "kie", modelSnapshot: MODEL.responseModelSnapshot }, invoke: async () => ({ kind: "COMPLETED", candidate: validOutput(SMOKE[0]!), usage: usage(), retention: "CONFIRMED_NOT_STORED" }) },
      audit: { append: async (row) => void rows.push(row) },
      now: () => "2026-10-05T04:00:00.000Z",
      monotonicMs: () => 0,
    });
    const result = await service.execute(SMOKE[0]!.request);
    expect(JSON.stringify(result)).not.toMatch(/retention|CONFIRMED_NOT_STORED|"store"/);
    expect(JSON.stringify(rows)).not.toMatch(/retention|CONFIRMED_NOT_STORED|"store"/);
    expect(aiInvocationAuditRowSchema.safeParse({ ...rows[0], retention: "CONFIRMED_NOT_STORED" }).success).toBe(false);
  });
});

describe("reference identifiers stay out of visible text (prompt 11b.4; owner instruction 2026-10-05)", () => {
  const explain = SMOKE.filter((fixture) => fixture.taskType === "EXPLAIN_PATTERN");
  const VISIBLE_REF = /\b(?:fact|claim|option|record|section|limitation)-\d{1,3}\b/;
  type Explain = { payload: { headline: { text: string; claimRefs: string[] }; observation: { text: string; claimRefs: string[] }; evidence: { text: string; factRefs: string[] } } };
  // Option B (11b.1): the model writes no limitations, so its visible text is headline, observation and evidence.
  const visibleTexts = (output: Explain) => [output.payload.headline.text, output.payload.observation.text, output.payload.evidence.text];
  /** The offline contract: no reference identifier in any generated sentence. */
  const visibleReferenceIds = (output: Explain) => visibleTexts(output).filter((text) => VISIBLE_REF.test(text)).length;
  const verdict = (fixture: AiEvaluationFixture, candidate: unknown) => {
    const result = validateAiTaskOutput(fixture.request, resolveAiTaskBundle(fixture.taskType, fixture.locale), candidate);
    return result.kind === "ACCEPTED" ? "ACCEPTED" : result.reason;
  };
  const FIELDS = ["headline", "observation", "evidence"] as const;
  const inject = (output: Explain, field: (typeof FIELDS)[number], ref: string): Explain => {
    const copy = structuredClone(output);
    copy.payload[field].text = `${copy.payload[field].text.replace(/[.。]$/, "")} (${ref}).`;
    return copy;
  };

  it.each(explain.map((fixture) => [fixture.locale, fixture] as const))("%s: an approved output carries every reference only in its structured field and is accepted", (_locale, fixture) => {
    const output = validOutput(fixture) as Explain;
    expect(visibleReferenceIds(output)).toBe(0);
    expect(output.payload.headline.claimRefs).toEqual(["claim-1"]);
    expect(output.payload.observation.claimRefs).toEqual(["claim-1"]);
    expect(output.payload.evidence.factRefs.length).toBeGreaterThan(0);
    expect(output.payload).not.toHaveProperty("limitations");
    expect(verdict(fixture, output)).toBe("ACCEPTED");
  });

  it.each(explain.flatMap((fixture) => FIELDS.flatMap((field) => ["claim-1", "fact-2", "limitation-1"].map((ref) => [fixture.locale, field, ref, fixture] as const))))("%s: %s text containing %s fails the offline contract and the validator", (_locale, field, ref, fixture) => {
    const output = inject(validOutput(fixture) as Explain, field, ref);
    expect(visibleReferenceIds(output)).toBe(1);
    expect(verdict(fixture, output)).toBe("FACT_FIDELITY_FAILED");
  });

  it.each(explain.map((fixture) => [fixture.locale, fixture] as const))("%s: an identifier whose digits equal a supplied value (claim-10) is still rejected", (_locale, fixture) => {
    expect(verdict(fixture, inject(validOutput(fixture) as Explain, "headline", "claim-10"))).toBe("FACT_FIDELITY_FAILED");
  });

  it.each(explain.map((fixture) => [fixture.locale, fixture] as const))("%s: removing the visible reference restores acceptance with every supplied value unchanged", (_locale, fixture) => {
    const original = validOutput(fixture) as Explain;
    const repaired = inject(original, "headline", "claim-1");
    repaired.payload.headline.text = original.payload.headline.text;
    expect(verdict(fixture, repaired)).toBe("ACCEPTED");
    const numbers = (output: Explain) => visibleTexts(output).join(" ").match(/\d+(?:\.\d+)?/g);
    expect(numbers(repaired)).toEqual(numbers(original));
    expect(numbers(original)).toEqual(expect.arrayContaining(["6.2", "7.1"]));
  });

  it("still rejects output that follows an injected instruction or states forbidden clinical meaning", () => {
    const fixture = explain.find((entry) => entry.locale === "en-SG")!;
    for (const sentence of ["These readings are dangerous.", "This shows you have diabetes.", "This indicates that you have diabetes.", "Increase your insulin dose before dinner."]) {
      const output = structuredClone(validOutput(fixture)) as Explain;
      output.payload.observation.text = sentence;
      expect(["CLINICAL_MEANING_VIOLATION", "AUTHORITY_BOUNDARY_VIOLATION"], sentence).toContain(verdict(fixture, output));
    }
  });
});
