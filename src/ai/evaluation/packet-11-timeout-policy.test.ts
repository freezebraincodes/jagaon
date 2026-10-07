import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiProviderPort, ProviderInvocationResult } from "@/application/ai/ai-provider-port";
import { outputFixture } from "@/domain/ai/ai-test-fixtures";
import { KIE_DOCUMENTED_MODELS, type KieModelSnapshot } from "@/ai/kie/kie-model-catalogue";
import {
  AI_EVALUATION_REPORT_VERSION,
  APPROVED_SMOKE_CONTRACT,
  contractMismatches,
  evaluateModelSnapshot,
  evaluationPlan,
  fullUtilityGates,
  liveRunVerdict,
  type AiModelEvaluationReport,
  type EvaluationCallObservation,
  type FixtureEvidence,
} from "./packet-11-evaluation";
import { fixturesForPhase, type AiEvaluationFixture } from "./packet-11-fixtures";

/**
 * FULL-phase timeout policy (owner instruction 2026-10-06). In FULL a provider timeout is a closed
 * PROVIDER_TIMEOUT fallback that exposes no provider output, counts as one attempted call and against
 * the utility and latency gates, and the run continues without any retry. Diagnostic and SMOKE phases
 * stay strict. A timeout with no response is never a model-identity or retention failure. The FULL
 * verdict applies the ai-system-spec Section 16.4 utility gates with the documented 95% thresholds.
 * The production timeouts (EXPLAIN_PATTERN 10 s, care summary 18 s) are unchanged.
 */

const SENTINEL = "SENTINEL-LATE-OUTPUT-7c1e";
const MODEL: KieModelSnapshot = { ...KIE_DOCUMENTED_MODELS[0]!, contextWindow: null, defaultReasoningLevel: null, retrievedAt: "2026-10-06T01:00:00.000Z" };
const SMOKE = fixturesForPhase("SMOKE");
const FULL_LIMITS = { maxCalls: 8, maxCredits: 7.5, allowRepair: true };
const SMOKE_LIMITS = { maxCalls: 4, maxCredits: 1, allowRepair: false };
const usage = (credits = 0.02) => ({ inputTokens: 800, outputTokens: 150, costMicroUsd: null, credits });

function validOutput(fixture: AiEvaluationFixture): Record<string, any> {
  const base = structuredClone(outputFixture(fixture.taskType)) as Record<string, any>;
  if (fixture.locale === "en-SG") return base;
  base.locale = "zh-SG";
  if (fixture.taskType === "EXPLAIN_PATTERN") {
    base.payload.headline.text = "最近记录的数值是 6.2 和 7.1 mmol/L。";
    base.payload.observation.text = "最近记录的数值是 6.2 和 7.1 mmol/L。";
    base.payload.evidence.text = "这使用了 10 个已记录的读数。";
  } else {
    base.payload.sections[0].bullets[0].text = "记录了一个 6.2 mmol/L 的读数。";
    base.payload.sections[1].bullets[0].text = "问题：我可以把笔放在包里吗？(演示)";
  }
  return base;
}
const completed = (fixture: AiEvaluationFixture, candidate: unknown = validOutput(fixture), credits = 0.02): ProviderInvocationResult => ({ kind: "COMPLETED", candidate, usage: usage(credits), responseModel: MODEL.responseModelSnapshot, retention: "CONFIRMED_NOT_STORED" } as ProviderInvocationResult);

type Script = (fixture: AiEvaluationFixture, call: number, signal: AbortSignal) => ProviderInvocationResult | Promise<ProviderInvocationResult>;
function provider(script: Script) {
  const perFixture = new Map<string, number>();
  const invoke = vi.fn(async (input: { taskType: string; locale: string }, signal: AbortSignal) => {
    const fixture = SMOKE.find((entry) => entry.taskType === input.taskType && entry.locale === input.locale)!;
    const call = (perFixture.get(fixture.id) ?? 0) + 1;
    perFixture.set(fixture.id, call);
    return script(fixture, call, signal);
  });
  const port: AiProviderPort = { providerModel: { providerKey: "kie", modelSnapshot: MODEL.responseModelSnapshot }, invoke: invoke as never };
  return { port, invoke, perFixture };
}
/** A provider that only answers once the service aborts the call at its production per-call timeout. */
const untilAborted = (signal: AbortSignal, late: () => ProviderInvocationResult) => new Promise<ProviderInvocationResult>((resolve) => signal.addEventListener("abort", () => resolve(late())));

let tick = 0;
const observed: Array<{ evidence: FixtureEvidence; calls: readonly EvaluationCallObservation[] }> = [];
const run = (port: AiProviderPort, phase: "FULL" | "SMOKE" | "DIAGNOSTIC", options: Partial<Parameters<typeof evaluateModelSnapshot>[0]> = {}) =>
  evaluateModelSnapshot({
    model: MODEL,
    provider: port,
    fixtures: phase === "DIAGNOSTIC" ? SMOKE.slice(0, 1) : SMOKE,
    concurrency: 1,
    phase,
    limits: phase === "FULL" ? FULL_LIMITS : SMOKE_LIMITS,
    now: () => "2026-10-06T02:00:00.000Z",
    monotonicMs: () => (tick += 100),
    observer: { beginFixture: () => undefined, endFixture: async (evidence, calls) => void observed.push({ evidence, calls }) },
    ...options,
  });
const verdictFor = (report: AiModelEvaluationReport, fixtures = SMOKE, maxCredits = 7.5) =>
  liveRunVerdict(report, evaluationPlan(fixtures, report.phase), { maxCredits, candidateCount: 1, requestModelId: MODEL.requestModelId, responseModelSnapshot: MODEL.responseModelSnapshot });

afterEach(() => {
  tick = 0;
  observed.length = 0;
  vi.useRealTimers();
});

describe("FULL: a provider timeout is a counted fallback and the run continues", () => {
  it("continues past a provider-reported timeout with a closed PROVIDER_TIMEOUT result and no retry", async () => {
    const fake = provider((fixture) => (fixture.id === SMOKE[1]!.id ? { kind: "FAILED", reason: "PROVIDER_TIMEOUT" } : completed(fixture)));
    const report = await run(fake.port, "FULL");
    expect(report.stoppedReason).toBeNull();
    expect(report.completed).toBe(true);
    expect(report.fixtures.map((fixture) => fixture.reasonCode)).toEqual(["ACCEPTED", "PROVIDER_TIMEOUT", "ACCEPTED", "ACCEPTED"]);
    expect(report.fixtures[1]).toMatchObject({ outcome: "FALLBACK", attempts: 1, repairUsed: false, timedOutCalls: 1, responseAvailability: "NO_RESPONSE", responseModel: null, retention: null, schemaConformant: null });
    expect(fake.perFixture.get(SMOKE[1]!.id)).toBe(1);
    expect(fake.invoke).toHaveBeenCalledTimes(4);
  });

  it("continues past the service's own production timeout, never retries, and attributes nothing to the next fixture", async () => {
    vi.useFakeTimers();
    const fake = provider((fixture, _call, signal) => (fixture.id === SMOKE[0]!.id ? untilAborted(signal, () => completed(fixture, { ...validOutput(fixture), note: SENTINEL })) : completed(fixture)));
    const pending = run(fake.port, "FULL");
    await vi.advanceTimersByTimeAsync(10_000);
    const report = await pending;
    expect(report.completed).toBe(true);
    expect(report.fixtures[0]).toMatchObject({ outcome: "FALLBACK", reasonCode: "PROVIDER_TIMEOUT", attempts: 1, repairUsed: false, timedOutCalls: 1, responseAvailability: "NO_RESPONSE", responseModel: null, retention: null, schemaConformant: null });
    expect(report.fixtures.slice(1).map((fixture) => [fixture.outcome, fixture.attempts, fixture.timedOutCalls])).toEqual([["ACCEPTED", 1, 0], ["ACCEPTED", 1, 0], ["ACCEPTED", 1, 0]]);
    expect(fake.perFixture.get(SMOKE[0]!.id)).toBe(1);
  });

  it("counts a call the service cut off even when the provider ignores the abort and never settles", async () => {
    vi.useFakeTimers();
    const fake = provider((fixture) => (fixture.id === SMOKE[1]!.id ? new Promise<ProviderInvocationResult>(() => undefined) : completed(fixture)));
    const pending = run(fake.port, "FULL");
    await vi.advanceTimersByTimeAsync(10_000);
    const report = await pending;
    expect(report.completed).toBe(true);
    expect(report.fixtures[1]).toMatchObject({ reasonCode: "PROVIDER_TIMEOUT", attempts: 1, timedOutCalls: 1, responseAvailability: "NO_RESPONSE" });
    expect(report.utility?.withinProductionTimeout).toMatchObject({ numerator: 3, denominator: 4 });
  });

  it("never exposes generated text from a timed-out call, even when the provider answers late", async () => {
    vi.useFakeTimers();
    const fake = provider((fixture, _call, signal) => (fixture.id === SMOKE[0]!.id ? untilAborted(signal, () => completed(fixture, { ...validOutput(fixture), note: SENTINEL })) : completed(fixture)));
    const pending = run(fake.port, "FULL");
    await vi.advanceTimersByTimeAsync(10_000);
    const report = await pending;
    expect(JSON.stringify(report)).not.toContain(SENTINEL);
    expect(JSON.stringify(observed)).not.toContain(SENTINEL);
    expect(observed[0]!.calls).toEqual([expect.objectContaining({ adapterOutcome: "FAILED", validation: null, schemaDiagnostic: null, referenceDiagnostic: null, meaningDiagnostic: null, abstentionReason: null })]);
  });

  it("counts a timeout as one attempted call in the call totals", async () => {
    const report = await run(provider((fixture) => (fixture.id === SMOKE[2]!.id ? { kind: "FAILED", reason: "PROVIDER_TIMEOUT" } : completed(fixture))).port, "FULL");
    expect(report.totals).toMatchObject({ fixtures: 4, calls: 4, accepted: 3, fallback: 1, timeouts: 1, timedOutCalls: 1, repairs: 0 });
    expect(report.byTaskLocale.find((group) => group.taskType === "DRAFT_CARE_PREPARATION_SUMMARY" && group.locale === "en-SG")).toMatchObject({ calls: 1, fallback: 1, timeouts: 1, timedOutCalls: 1 });
  });

  it("counts a timeout against the utility and latency gates", async () => {
    vi.useFakeTimers();
    let clock = 0;
    const fake = provider((fixture, _call, signal) => (fixture.id === SMOKE[3]!.id ? untilAborted(signal, () => ({ kind: "FAILED", reason: "TRANSPORT_FAILED" })) : completed(fixture)));
    const pending = run(fake.port, "FULL", { monotonicMs: () => (clock = Date.now()) });
    await vi.advanceTimersByTimeAsync(20_000);
    const report = await pending;
    expect(report.fixtures[3]!.latencyMs).toBeGreaterThanOrEqual(18_000);
    expect(report.totals.maxLatencyMs).toBe(report.fixtures[3]!.latencyMs);
    expect(report.utility).toMatchObject({
      usefulAcceptedOutput: { numerator: 3, denominator: 4, thresholdPercent: 95, comparison: "AT_LEAST", passed: false },
      withinProductionTimeout: { numerator: 3, denominator: 4, thresholdPercent: 95, comparison: "AT_LEAST", passed: false },
      fallbacks: 1,
      timeouts: 1,
    });
    expect(report.utility).toMatchObject({ firstCallValid: { numerator: 3, denominator: 4, thresholdPercent: 98, comparison: "AT_LEAST", passed: false }, repairs: { numerator: 0, denominator: 4, thresholdPercent: 2, comparison: "AT_MOST", passed: true } });
    expect(verdictFor(report)).toEqual({ kind: "FAIL", failures: ["UTILITY:USEFUL_ACCEPTED_OUTPUT", "UTILITY:WITHIN_PRODUCTION_TIMEOUT", "UTILITY:FIRST_CALL_VALID"] });
    expect(clock).toBeGreaterThan(0);
  });

  it("does not report a no-response timeout as a model-identity or retention failure", async () => {
    const report = await run(provider((fixture) => (fixture.id === SMOKE[1]!.id ? { kind: "FAILED", reason: "PROVIDER_TIMEOUT" } : completed(fixture))).port, "FULL");
    const result = verdictFor(report);
    expect(result.kind === "FAIL" && result.failures).not.toEqual(expect.arrayContaining(["RESPONSE_MODEL_MISMATCH"]));
    expect(result.kind === "FAIL" && result.failures).not.toEqual(expect.arrayContaining(["RETENTION_NOT_CONFIRMED"]));
  });
});

describe("FULL: other stops are unchanged", () => {
  it("still stops immediately on a hard-gate failure", async () => {
    const fake = provider((fixture) => {
      const output = validOutput(fixture);
      if (fixture.id === SMOKE[0]!.id) output.payload.evidence.text = "This uses 10 recorded readings in MMOL_L.";
      return completed(fixture, output);
    });
    const report = await run(fake.port, "FULL");
    expect(report.stoppedReason).toBe("HARD_GATE");
    expect(report.fixtures).toHaveLength(1);
    expect(fake.invoke).toHaveBeenCalledTimes(1);
  });

  it("still stops immediately at the credit ceiling, timeouts included", async () => {
    const fake = provider((fixture) => (fixture.id === SMOKE[0]!.id ? { kind: "FAILED", reason: "PROVIDER_TIMEOUT" } : completed(fixture, validOutput(fixture), 0.6)));
    const report = await run(fake.port, "FULL", { limits: { ...FULL_LIMITS, maxCredits: 1 } });
    expect(report.stoppedReason).toBe("CREDIT_CEILING");
    expect(report.fixtures.map((fixture) => fixture.reasonCode)).toEqual(["PROVIDER_TIMEOUT", "ACCEPTED", "ACCEPTED"]);
    expect(fake.invoke).toHaveBeenCalledTimes(3);
  });

  it("still stops on a completed response that does not confirm non-retention", async () => {
    const fake = provider((fixture) => ({ ...completed(fixture), retention: "PROVIDER_REPORTED_STORED" } as ProviderInvocationResult));
    const report = await run(fake.port, "FULL");
    expect(report.stoppedReason).toBe("RETENTION_NOT_CONFIRMED");
    expect(verdictFor(report)).toMatchObject({ kind: "FAIL", failures: expect.arrayContaining(["RETENTION_NOT_CONFIRMED"]) });
  });

  it("still stops on any other provider failure", async () => {
    const report = await run(provider((fixture) => (fixture.id === SMOKE[1]!.id ? { kind: "FAILED", reason: "PROVIDER_FAILED" } : completed(fixture))).port, "FULL");
    expect(report.stoppedReason).toBe("UNEXPECTED_PROVIDER_BEHAVIOUR");
    expect(report.fixtures).toHaveLength(2);
  });
});

describe("SMOKE and diagnostic phases stay strict", () => {
  it.each(["SMOKE", "DIAGNOSTIC"] as const)("%s: a timeout stops the phase immediately", async (phase) => {
    const fake = provider(() => ({ kind: "FAILED", reason: "PROVIDER_TIMEOUT" }));
    const report = await run(fake.port, phase);
    expect(report.stoppedReason).toBe("UNEXPECTED_PROVIDER_BEHAVIOUR");
    expect(report.fixtures).toHaveLength(1);
    expect(fake.invoke).toHaveBeenCalledTimes(1);
    expect(report.utility).toBeNull();
    const result = verdictFor(report, phase === "DIAGNOSTIC" ? SMOKE.slice(0, 1) : SMOKE);
    expect(result).toMatchObject({ kind: "FAIL", failures: expect.arrayContaining(["NOT_COMPLETED", "STOPPED:UNEXPECTED_PROVIDER_BEHAVIOUR", "NO_RESPONSE_RECEIVED"]) });
    // No response arrived, so the record says so instead of claiming an identity or retention failure.
    expect(report.fixtures[0]).toMatchObject({ responseAvailability: "NO_RESPONSE", responseModel: null, retention: null });
    expect(result.kind === "FAIL" && result.failures).not.toEqual(expect.arrayContaining(["RESPONSE_MODEL_MISMATCH"]));
    expect(result.kind === "FAIL" && result.failures).not.toEqual(expect.arrayContaining(["RETENTION_NOT_CONFIRMED"]));
  });
});

describe("FULL utility gates: documented thresholds and exact arithmetic", () => {
  const item = (overrides: Partial<FixtureEvidence>): FixtureEvidence =>
    ({ expectedOutcome: "SUCCESS", outcome: "ACCEPTED", reasonCode: "ACCEPTED", attempts: 1, timedOutCalls: 0, responseAvailability: "RECEIVED", hardGateFailure: false, retention: "CONFIRMED_NOT_STORED", repairUsed: false, firstCallValid: true, ...overrides }) as FixtureEvidence;
  const timeout = item({ outcome: "FALLBACK", reasonCode: "PROVIDER_TIMEOUT", timedOutCalls: 1, responseAvailability: "NO_RESPONSE", retention: null, firstCallValid: false });
  const localeFallback = item({ outcome: "FALLBACK", reasonCode: "LOCALE_INVALID", firstCallValid: true });
  const set = (accepted: number, timeouts: number, fallbacks: number) => [...Array(accepted).fill(item({})), ...Array(timeouts).fill(timeout), ...Array(fallbacks).fill(localeFallback)];

  it("67 accepted + 2 timeouts + 1 other fallback of 70 passes useful (67/70 = 95.71%) and timeout (68/70 = 97.14%) but fails first-call validity (68/70 = 97.14% < 98%)", () => {
    const gates = fullUtilityGates(set(67, 2, 1));
    expect(gates.usefulAcceptedOutput).toEqual({ numerator: 67, denominator: 70, percent: 95.71, thresholdPercent: 95, comparison: "AT_LEAST", passed: true });
    expect(gates.withinProductionTimeout).toEqual({ numerator: 68, denominator: 70, percent: 97.14, thresholdPercent: 95, comparison: "AT_LEAST", passed: true });
    expect(gates.firstCallValid).toMatchObject({ numerator: 68, denominator: 70, percent: 97.14, passed: false });
    expect(gates).toMatchObject({ expectedSuccessFixtures: 70, fallbacks: 3, timeouts: 2, timedOutCalls: 2, hardGateFailures: 0, retentionFailuresOnReceivedResponses: 0, passed: false });
    expect(gates.fallbacksByReason).toEqual({ LOCALE_INVALID: 1, PROVIDER_TIMEOUT: 2 });
  });

  it("68 accepted + 1 timeout + 1 other fallback of 70 passes every gate", () => {
    const gates = fullUtilityGates(set(68, 1, 1));
    expect([gates.usefulAcceptedOutput, gates.withinProductionTimeout, gates.firstCallValid, gates.repairs].map((gate) => [gate.numerator, gate.denominator, gate.percent, gate.passed])).toEqual([
      [68, 70, 97.14, true],
      [69, 70, 98.57, true],
      [69, 70, 98.57, true],
      [0, 70, 0, true],
    ]);
    expect(gates.passed).toBe(true);
  });

  it("fails 66 accepted of 70: 66/70 = 94.29% is below 95%", () => {
    expect(fullUtilityGates(set(66, 2, 2)).usefulAcceptedOutput).toEqual({ numerator: 66, denominator: 70, percent: 94.29, thresholdPercent: 95, comparison: "AT_LEAST", passed: false });
  });

  it("fails 4 timed-out calls of 70: 66/70 within the production timeout = 94.29%", () => {
    expect(fullUtilityGates(set(66, 4, 0)).withinProductionTimeout).toEqual({ numerator: 66, denominator: 70, percent: 94.29, thresholdPercent: 95, comparison: "AT_LEAST", passed: false });
  });

  it("counts every attempted call, repairs included, in the timeout denominator", () => {
    const gates = fullUtilityGates([...set(68, 1, 0), item({ attempts: 2, repairUsed: true })]);
    expect(gates.withinProductionTimeout).toMatchObject({ numerator: 70, denominator: 71 });
  });

  it("treats exactly 95% as passing (integer arithmetic, no rounding drift)", () => {
    expect(fullUtilityGates(set(19, 1, 0)).usefulAcceptedOutput).toEqual({ numerator: 19, denominator: 20, percent: 95, thresholdPercent: 95, comparison: "AT_LEAST", passed: true });
  });

  it("fails on any hard-gate failure or a received response without confirmed non-retention", () => {
    expect(fullUtilityGates([...set(69, 0, 0), item({ hardGateFailure: true, outcome: "FALLBACK", reasonCode: "FACT_FIDELITY_FAILED" })])).toMatchObject({ hardGateFailures: 1, passed: false });
    expect(fullUtilityGates([...set(69, 0, 0), item({ retention: "RETENTION_UNCONFIRMED" })])).toMatchObject({ retentionFailuresOnReceivedResponses: 1, passed: false });
  });

  it("requires every expected ABSTAIN or FALLBACK fixture to produce exactly that safe outcome (none in the 11b.3 set)", () => {
    expect(fullUtilityGates(set(70, 0, 0)).expectedNonSuccess).toEqual({ fixtures: 0, met: 0, passed: true });
    expect(fullUtilityGates([...set(69, 0, 0), item({ expectedOutcome: "ABSTAIN" })]).expectedNonSuccess).toEqual({ fixtures: 1, met: 0, passed: false });
  });

  it("cannot pass with no expected-success fixtures", () => {
    expect(fullUtilityGates([]).passed).toBe(false);
  });
});

describe("FULL utility gates: first-call validity >= 98% and repairs <= 2% (owner instruction 2026-10-06)", () => {
  const item = (overrides: Partial<FixtureEvidence>): FixtureEvidence =>
    ({ expectedOutcome: "SUCCESS", outcome: "ACCEPTED", reasonCode: "ACCEPTED", attempts: 1, timedOutCalls: 0, responseAvailability: "RECEIVED", hardGateFailure: false, retention: "CONFIRMED_NOT_STORED", repairUsed: false, firstCallValid: true, ...overrides }) as FixtureEvidence;
  const firstCallInvalid = item({ firstCallValid: false });
  const repaired = item({ attempts: 2, repairUsed: true, firstCallValid: false });
  const timeout = item({ outcome: "FALLBACK", reasonCode: "PROVIDER_TIMEOUT", timedOutCalls: 1, responseAvailability: "NO_RESPONSE", retention: null, firstCallValid: false });
  const many = (count: number, entry: FixtureEvidence) => Array<FixtureEvidence>(count).fill(entry);

  it("first-call validity passes at 69/70 = 98.57%", () => {
    expect(fullUtilityGates([...many(69, item({})), firstCallInvalid]).firstCallValid).toEqual({ numerator: 69, denominator: 70, percent: 98.57, thresholdPercent: 98, comparison: "AT_LEAST", passed: true });
  });
  it("first-call validity fails at 68/70 = 97.14%", () => {
    expect(fullUtilityGates([...many(68, item({})), ...many(2, firstCallInvalid)]).firstCallValid).toEqual({ numerator: 68, denominator: 70, percent: 97.14, thresholdPercent: 98, comparison: "AT_LEAST", passed: false });
  });
  it("first-call validity passes at exactly 98% (49/50) and fails just below (48/50 = 96%)", () => {
    expect(fullUtilityGates([...many(49, item({})), firstCallInvalid]).firstCallValid).toMatchObject({ numerator: 49, denominator: 50, percent: 98, passed: true });
    expect(fullUtilityGates([...many(48, item({})), ...many(2, firstCallInvalid)]).firstCallValid).toMatchObject({ numerator: 48, denominator: 50, percent: 96, passed: false });
  });
  it("a timed-out first call is not a valid first call", () => {
    expect(fullUtilityGates([...many(68, item({})), ...many(2, timeout)]).firstCallValid).toMatchObject({ numerator: 68, denominator: 70, passed: false });
  });
  it("repairs pass at 1/70 = 1.43% and at 0/70", () => {
    expect(fullUtilityGates([...many(69, item({})), repaired]).repairs).toEqual({ numerator: 1, denominator: 70, percent: 1.43, thresholdPercent: 2, comparison: "AT_MOST", passed: true });
    expect(fullUtilityGates(many(70, item({}))).repairs).toEqual({ numerator: 0, denominator: 70, percent: 0, thresholdPercent: 2, comparison: "AT_MOST", passed: true });
  });
  it("repairs fail at 2/70 = 2.86%", () => {
    expect(fullUtilityGates([...many(68, item({})), ...many(2, repaired)]).repairs).toEqual({ numerator: 2, denominator: 70, percent: 2.86, thresholdPercent: 2, comparison: "AT_MOST", passed: false });
  });
  it("repairs pass at exactly 2% (1/50) and fail just above (2/50 = 4%)", () => {
    expect(fullUtilityGates([...many(49, item({})), repaired]).repairs).toMatchObject({ numerator: 1, denominator: 50, percent: 2, passed: true });
    expect(fullUtilityGates([...many(48, item({})), ...many(2, repaired)]).repairs).toMatchObject({ numerator: 2, denominator: 50, percent: 4, passed: false });
  });
  it("both gates fail on an empty denominator (no expected-SUCCESS fixtures)", () => {
    const gates = fullUtilityGates([]);
    expect(gates.firstCallValid).toEqual({ numerator: 0, denominator: 0, percent: 0, thresholdPercent: 98, comparison: "AT_LEAST", passed: false });
    expect(gates.repairs).toEqual({ numerator: 0, denominator: 0, percent: 0, thresholdPercent: 2, comparison: "AT_MOST", passed: false });
    expect(gates.passed).toBe(false);
  });
  it("either failing gate fails the overall utility result", () => {
    expect(fullUtilityGates([...many(68, item({})), ...many(2, firstCallInvalid)]).passed).toBe(false);
    expect(fullUtilityGates([...many(67, item({})), ...many(3, repaired)]).passed).toBe(false);
    expect(fullUtilityGates([...many(69, item({})), repaired]).passed).toBe(true);
  });
  it("the FULL verdict fails UTILITY:FIRST_CALL_VALID and UTILITY:REPAIR_RATE from a live-shaped run", async () => {
    // Every first call is schema-invalid; the one permitted repair returns valid output.
    const fake = provider((fixture, call) => (call === 1 ? completed(fixture, "{not json") : completed(fixture)));
    const report = await run(fake.port, "FULL");
    expect(report.totals).toMatchObject({ fixtures: 4, accepted: 4, repairs: 4, calls: 8 });
    expect(report.utility).toMatchObject({ firstCallValid: { numerator: 0, denominator: 4, passed: false }, repairs: { numerator: 4, denominator: 4, passed: false } });
    expect(verdictFor(report)).toEqual({ kind: "FAIL", failures: ["UTILITY:FIRST_CALL_VALID", "UTILITY:REPAIR_RATE"] });
  });
});

describe("evaluation harness contract version", () => {
  it("is report version packet11-eval.4, pinned in the approved contract and checked before any call", () => {
    expect(AI_EVALUATION_REPORT_VERSION).toBe("packet11-eval.4");
    expect(APPROVED_SMOKE_CONTRACT.evaluationReportVersion).toBe("packet11-eval.4");
    expect(contractMismatches({ requestModelId: "deepseek-flash", responseModelSnapshot: "deepseek-flash" })).toEqual([]);
  });

  it("rejects evidence produced under the earlier harness", async () => {
    const report = await run(provider((fixture) => completed(fixture)).port, "FULL");
    expect(verdictFor(report)).toEqual({ kind: "PASS" });
    for (const earlier of ["packet11-eval.3", "packet11-eval.2", "packet11-eval.1"]) expect(verdictFor({ ...report, reportVersion: earlier })).toEqual({ kind: "FAIL", failures: ["CONTRACT_VERSION_MISMATCH:evaluationReportVersion"] });
  });
});
