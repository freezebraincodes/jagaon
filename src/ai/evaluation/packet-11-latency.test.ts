// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AI_TASK_RUNTIME_BUNDLES } from "@/application/ai/ai-runtime-bundles";
import { outputFixture } from "@/domain/ai/ai-test-fixtures";
import { KIE_DOCUMENTED_MODELS, type KieModelSnapshot } from "@/ai/kie/kie-model-catalogue";
import { createKieResponsesProvider, type KieProviderDiagnostic } from "@/ai/kie/kie-responses-provider";
import { LATENCY_PROBE_PLAN, latencyRunVerdict, runLatencyProbes } from "./packet-11-latency";

/** Packet 11B evaluation-only latency characterisation (owner instruction 2026-10-05). No live call. */

const TOKEN = "SENTINEL-TOKEN-7c1";
const MODEL: KieModelSnapshot = { ...KIE_DOCUMENTED_MODELS[0]!, contextWindow: null, defaultReasoningLevel: null, retrievedAt: "2026-10-05T03:00:00.000Z" };
const SNAPSHOT = "deepseek-v4-1-flash-260910";
type Step = { delayMs: number; status?: number; body?: unknown; raw?: string; contentType?: string };

const body = (extra: Record<string, unknown> = {}, envelope: Record<string, unknown> = {}) => ({
  status: "completed",
  model: SNAPSHOT,
  output: [
    { type: "reasoning", summary: [{ type: "summary_text", text: "SENTINEL-SUMMARY" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify({ ...outputFixture("EXPLAIN_PATTERN"), abstentionReason: null, ...envelope }) }] },
  ],
  usage: { input_tokens: 644, output_tokens: 234, output_tokens_details: { reasoning_tokens: 0 } },
  credits_consumed: 0.02,
  ...extra,
});

/** A fake Kie endpoint that answers each sequential call after a scripted delay, honouring abort. */
function scripted(steps: Step[]) {
  let index = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const bodies: string[] = [];
  const fetcher = vi.fn((_url: string, init: RequestInit) => {
    const step = steps[index++]!;
    bodies.push(init.body as string);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        inFlight -= 1;
        resolve(new Response(step.raw ?? JSON.stringify(step.body ?? body()), { status: step.status ?? 200, headers: { "content-type": step.contentType ?? "application/json" } }));
      }, step.delayMs);
      init.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        inFlight -= 1;
        reject(new DOMException("aborted", "AbortError"));
      });
    });
  });
  return { fetcher, bodies, maxInFlight: () => maxInFlight };
}

async function probe(steps: Step[], options: { maxCredits?: number } = {}) {
  vi.useFakeTimers();
  const endpoint = scripted(steps);
  let clock = 0;
  const pending = runLatencyProbes({
    model: MODEL,
    createProvider: (onDiagnostic: (diagnostic: KieProviderDiagnostic) => void) => createKieResponsesProvider({ token: TOKEN, model: MODEL, fetcher: endpoint.fetcher, onDiagnostic }),
    maxCredits: options.maxCredits ?? LATENCY_PROBE_PLAN.maxCredits,
    monotonicMs: () => clock + Date.now(),
    now: () => "2026-10-05T03:00:00.000Z",
  });
  await vi.advanceTimersByTimeAsync(LATENCY_PROBE_PLAN.timeoutMs * 4);
  clock = 0;
  return { report: await pending, endpoint };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("latency probe plan", () => {
  it("is exactly three sequential probes of EXPLAIN_PATTERN en-SG at a 20 s evaluation-only timeout", () => {
    expect(LATENCY_PROBE_PLAN).toEqual({ fixtureId: "p11.explain-pattern.en-sg.ordinary", probes: 3, timeoutMs: 20_000, productionLimitMs: 10_000, maxCredits: 0.25, maxCalls: 3 });
  });

  it("leaves every production bundle timeout unchanged", () => {
    expect(AI_TASK_RUNTIME_BUNDLES.EXPLAIN_PATTERN.executionBudget).toMatchObject({ perCallTimeoutMs: 10_000, overallTimeoutMs: 18_000 });
    expect(AI_TASK_RUNTIME_BUNDLES.DRAFT_CARE_PREPARATION_SUMMARY.executionBudget).toMatchObject({ perCallTimeoutMs: 18_000, overallTimeoutMs: 32_000 });
    expect(Object.isFrozen(AI_TASK_RUNTIME_BUNDLES.EXPLAIN_PATTERN.executionBudget)).toBe(true);
  });
});

describe("latency probes", () => {
  it("makes exactly three sequential calls with the same request, reasoning none, and records every measurement", async () => {
    const { report, endpoint } = await probe([{ delayMs: 4_500 }, { delayMs: 12_000 }, { delayMs: 9_000 }]);
    expect(endpoint.fetcher).toHaveBeenCalledTimes(3);
    expect(endpoint.maxInFlight()).toBe(1);
    expect(new Set(endpoint.bodies).size).toBe(1);
    const request = JSON.parse(endpoint.bodies[0]!);
    expect(request).toMatchObject({ model: "deepseek-v4-1-flash", stream: false, reasoning: { effort: "none" } });
    expect(report.stoppedReason).toBeNull();
    expect(report.probes.map((entry) => [entry.outcome, entry.latencyMs, entry.withinProductionLimit])).toEqual([
      ["COMPLETED", 4_500, true],
      ["COMPLETED", 12_000, false],
      ["COMPLETED", 9_000, true],
    ]);
    expect(report.probes[0]).toMatchObject({ httpStatus: 200, contentTypeClass: "JSON", responseModel: SNAPSHOT, schemaConformant: true, validator: "ACCEPTED", inputTokens: 644, outputTokens: 234, reasoningTokens: 0, credits: 0.02 });
    expect(report.summary).toMatchObject({ calls: 3, completed: 3, timeouts: 0, completedWithinProductionLimit: 2, completedWithinTimeout: 3, credits: 0.06 });
  });

  it("records a 20 s timeout as measurement data and continues", async () => {
    const { report, endpoint } = await probe([{ delayMs: 25_000 }, { delayMs: 5_000 }, { delayMs: 6_000 }]);
    expect(endpoint.fetcher).toHaveBeenCalledTimes(3);
    expect(report.probes[0]).toMatchObject({ outcome: "TIMEOUT", latencyMs: 20_000, withinProductionLimit: false, responseModel: null, credits: null });
    expect(report.summary).toMatchObject({ calls: 3, completed: 2, timeouts: 1 });
    expect(report.stoppedReason).toBeNull();
  });

  it.each([
    ["a different model snapshot", { delayMs: 3_000, body: body({ model: "deepseek-v4-1-flash" }) }, "RESPONSE_MODEL_MISMATCH"],
    ["a non-JSON body", { delayMs: 3_000, raw: "<html>busy</html>", contentType: "text/html" }, "MALFORMED_RESPONSE"],
    ["an event stream", { delayMs: 3_000, raw: "data: {}\n\n", contentType: "text/event-stream" }, "MALFORMED_RESPONSE"],
    ["a strict-schema failure", { delayMs: 3_000, body: body({}, { extra: true }) }, "SCHEMA_OR_VALIDATOR_FAILURE"],
    ["an HTTP 500", { delayMs: 3_000, status: 500, body: { error: { message: "x" } } }, "UNEXPECTED_PROVIDER_BEHAVIOUR"],
  ])("stops early on %s", async (_label, step, reason) => {
    const { report, endpoint } = await probe([step as Step, { delayMs: 3_000 }, { delayMs: 3_000 }]);
    expect(endpoint.fetcher).toHaveBeenCalledTimes(1);
    expect(report.stoppedReason).toBe(reason);
  });

  it("stops early on a clinical hard-gate failure", async () => {
    const dangerous = structuredClone(outputFixture("EXPLAIN_PATTERN")) as Record<string, any>;
    dangerous.payload.observation.text = "These readings are dangerous.";
    const { report, endpoint } = await probe([{ delayMs: 3_000, body: { ...body(), output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify({ ...dangerous, abstentionReason: null }) }] }] } }, { delayMs: 3_000 }, { delayMs: 3_000 }]);
    expect(endpoint.fetcher).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({ stoppedReason: "HARD_GATE", probes: [{ validator: "CLINICAL_MEANING_VIOLATION" }] });
  });

  it("stops before the next call once reported credits reach the ceiling", async () => {
    const { report, endpoint } = await probe([{ delayMs: 3_000, body: body({ credits_consumed: 0.2 }) }, { delayMs: 3_000, body: body({ credits_consumed: 0.1 }) }, { delayMs: 3_000 }]);
    expect(endpoint.fetcher).toHaveBeenCalledTimes(2);
    expect(report).toMatchObject({ stoppedReason: "CREDIT_CEILING", summary: { calls: 2, credits: 0.3 } });
  });

  it("keeps no token, prompt, payload, generated text or reasoning summary, and never logs", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
    const { report } = await probe([{ delayMs: 3_000 }, { delayMs: 3_000 }, { delayMs: 3_000 }]);
    const json = JSON.stringify(report);
    for (const secret of [TOKEN, "SENTINEL-SUMMARY", "Recent recorded", "wording component", "mmol", "6.2"]) expect(json, secret).not.toContain(secret);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe("live latency runner wiring", () => {
  const source = readFileSync(join(process.cwd(), "src/ai/evaluation/packet-11-live-latency.test.ts"), "utf8");

  it("is skipped unless explicitly flagged and confirms three calls and the ceiling before any request", () => {
    expect(source).toMatch(/describe\.skipIf\(!LIVE\)/);
    expect(source).toContain('env.RUN_LIVE_KIE_LATENCY === "1"');
    expect(source.indexOf("KIE_LATENCY_CONFIRM_MAX_CALLS !==")).toBeLessThan(source.indexOf("runLatencyProbes("));
    expect(source).toContain("LATENCY_PROBE_PLAN.maxCredits");
    expect(source).not.toMatch(/fixturesForPhase\(|evaluateModelSnapshot\(/);
  });

  it("is a separate npm command that loads only the ignored local environment file", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["evaluate:packet11:latency"]).toBe("node --env-file=.env.local ./node_modules/vitest/vitest.mjs run --no-file-parallelism src/ai/evaluation/packet-11-live-latency.test.ts");
  });
});

describe("latency-run completion guard (owner condition 2026-10-05)", () => {
  type Report = Awaited<ReturnType<typeof runLatencyProbes>>;
  const accepted = (probe: number, extra: Record<string, unknown> = {}) => ({ probe, outcome: "COMPLETED", latencyMs: 4_400, httpStatus: 200, contentTypeClass: "JSON", diagnosticCode: "COMPLETED", responseModel: SNAPSHOT, schemaConformant: true, validator: "ACCEPTED", inputTokens: 644, outputTokens: 240, reasoningTokens: 0, credits: 0.02, withinProductionLimit: true, referenceDiagnostic: null, schemaDiagnostic: null, meaningDiagnostic: null, ...extra });
  const report = (probes: unknown[], stoppedReason: string | null = null): Report =>
    ({
      reportVersion: "packet11-latency.1",
      generatedAt: "2026-10-05T03:00:00.000Z",
      model: { requestModelId: "deepseek-v4-1-flash", responseModelSnapshot: SNAPSHOT, provenance: "DOCUMENTED_UNLISTED_EVALUATION_ONLY" },
      plan: LATENCY_PROBE_PLAN,
      stoppedReason,
      probes,
      summary: { calls: probes.length, completed: probes.length, timeouts: 0, failed: 0, completedWithinProductionLimit: probes.length, completedWithinTimeout: probes.length, credits: 0.02 * probes.length },
    }) as unknown as Report;
  const verdict = (value: Report) => latencyRunVerdict(value, { maxCredits: 0.25, responseModelSnapshot: SNAPSHOT });

  it("passes only three completed, accepted, exact-snapshot probes", () => {
    expect(verdict(report([accepted(1), accepted(2), accepted(3)]))).toEqual({ kind: "PASS" });
  });

  it("cannot pass the observed sequence ACCEPTED, ACCEPTED, REFERENCE_MISMATCH", () => {
    const observed = report([accepted(1, { outputTokens: 247, latencyMs: 4_454 }), accepted(2, { outputTokens: 243, latencyMs: 4_398 }), accepted(3, { outputTokens: 201, latencyMs: 4_133, validator: "REFERENCE_MISMATCH" })], "HARD_GATE");
    const result = verdict(observed);
    expect(result).toMatchObject({ kind: "FAIL", failures: expect.arrayContaining(["STOPPED:HARD_GATE", "VALIDATOR:3:REFERENCE_MISMATCH"]) });
  });

  it("fails the same sequence even if a stop reason were missing", () => {
    expect(verdict(report([accepted(1), accepted(2), accepted(3, { validator: "REFERENCE_MISMATCH" })]))).toMatchObject({ kind: "FAIL", failures: ["VALIDATOR:3:REFERENCE_MISMATCH"] });
  });

  it.each([
    ["a timeout", accepted(2, { outcome: "TIMEOUT", validator: null, schemaConformant: null, responseModel: null }), "TIMEOUT:2"],
    ["a transport or provider failure", accepted(2, { outcome: "FAILED", validator: null, schemaConformant: null, diagnosticCode: "HTTP_5XX" }), "FAILED:2"],
    ["a wrong snapshot", accepted(2, { responseModel: "deepseek-v4-1-flash" }), "RESPONSE_MODEL_MISMATCH:2"],
    ["a strict-schema failure", accepted(2, { schemaConformant: false, validator: "SCHEMA_INVALID" }), "SCHEMA_INVALID:2"],
    ["a factual hard gate", accepted(2, { validator: "FACT_FIDELITY_FAILED" }), "VALIDATOR:2:FACT_FIDELITY_FAILED"],
    ["an authority hard gate", accepted(2, { validator: "AUTHORITY_BOUNDARY_VIOLATION" }), "VALIDATOR:2:AUTHORITY_BOUNDARY_VIOLATION"],
    ["a clinical meaning violation", accepted(2, { validator: "CLINICAL_MEANING_VIOLATION" }), "VALIDATOR:2:CLINICAL_MEANING_VIOLATION"],
    ["a locale failure", accepted(2, { validator: "LOCALE_INVALID" }), "VALIDATOR:2:LOCALE_INVALID"],
    ["an abstention", accepted(2, { validator: "MODEL_ABSTAINED" }), "VALIDATOR:2:MODEL_ABSTAINED"],
  ])("fails on %s", (_label, middle, failure) => {
    expect(verdict(report([accepted(1), middle, accepted(3)]))).toMatchObject({ kind: "FAIL", failures: expect.arrayContaining([failure]) });
  });

  it("fails when a probe is skipped, missing, duplicated or the call count is incomplete", () => {
    expect(verdict(report([accepted(1), accepted(2)]))).toMatchObject({ kind: "FAIL", failures: expect.arrayContaining(["CALL_COUNT", "PROBE_MISSING:3"]) });
    expect(verdict(report([accepted(1), accepted(3), accepted(3)]))).toMatchObject({ kind: "FAIL", failures: expect.arrayContaining(["PROBE_MISSING:2"]) });
    expect(verdict(report([]))).toMatchObject({ kind: "FAIL", failures: expect.arrayContaining(["CALL_COUNT"]) });
  });

  it("fails when reported credits exceed the ceiling or the report names another snapshot", () => {
    const expensive = { ...report([accepted(1), accepted(2), accepted(3)]), summary: { ...report([]).summary, calls: 3, credits: 0.3 } } as Report;
    expect(verdict(expensive)).toMatchObject({ kind: "FAIL", failures: expect.arrayContaining(["CREDITS_OVER_CEILING"]) });
    const other = { ...report([accepted(1), accepted(2), accepted(3)]), model: { requestModelId: "deepseek-v4-1-flash", responseModelSnapshot: "x", provenance: "LISTED" } } as Report;
    expect(verdict(other)).toMatchObject({ kind: "FAIL", failures: expect.arrayContaining(["MODEL_MISMATCH"]) });
  });

  it("fails an end-to-end harness run whose third output cites an unsupplied reference", async () => {
    const invented = structuredClone(outputFixture("EXPLAIN_PATTERN")) as Record<string, any>;
    invented.payload.evidence.factRefs = ["fact-1", "fact-4"];
    invented.inputRefsUsed = [...invented.inputRefsUsed, "fact-4"];
    const { report: run } = await probe([{ delayMs: 3_000 }, { delayMs: 3_000 }, { delayMs: 3_000, body: { ...body(), output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify({ ...invented, abstentionReason: null }) }] }] } }]);
    expect(run.probes.map((entry) => entry.validator)).toEqual(["ACCEPTED", "ACCEPTED", "REFERENCE_MISMATCH"]);
    expect(verdict(run)).toMatchObject({ kind: "FAIL", failures: expect.arrayContaining(["VALIDATOR:3:REFERENCE_MISMATCH"]) });
  });

  it("the live latency runner throws on any non-passing verdict", () => {
    const source = readFileSync(join(process.cwd(), "src/ai/evaluation/packet-11-live-latency.test.ts"), "utf8");
    expect(source).toContain("latencyRunVerdict(report,");
    expect(source).toMatch(/if \(verdict\.kind === "FAIL"\) throw new Error/);
    expect(source).not.toMatch(/expect\(report\.summary\.calls\)\.toBeLessThanOrEqual/);
  });
});

describe("reference diagnostic in latency evidence", () => {
  it("attaches the value-free reference diagnostic only to a REFERENCE_MISMATCH probe", async () => {
    const invented = structuredClone(outputFixture("EXPLAIN_PATTERN")) as Record<string, any>;
    invented.payload.evidence.factRefs = ["fact-1", "fact-417"];
    invented.inputRefsUsed = [...invented.inputRefsUsed, "fact-417"];
    const { report } = await probe([{ delayMs: 3_000 }, { delayMs: 3_000 }, { delayMs: 3_000, body: { ...body(), output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify({ ...invented, abstentionReason: null }) }] }] } }]);
    expect(report.probes.map((entry) => entry.referenceDiagnostic === null)).toEqual([true, true, false]);
    expect(report.probes[2]!.referenceDiagnostic).toMatchObject({ version: "packet11-refdiag.1", fixtureId: "p11.explain-pattern.en-sg.ordinary", findings: expect.arrayContaining([expect.objectContaining({ category: "INVENTED_OR_UNSUPPLIED_REFERENCE", referenceKind: "FACT", path: "evidence.factRefs", count: 1, fixtureReferences: [] })]) });
    expect(JSON.stringify(report)).not.toContain("417");
  });
});

describe("schema diagnostic in latency evidence", () => {
  it("attaches the value-free schema diagnostic only to a SCHEMA_INVALID probe", async () => {
    const { report } = await probe([{ delayMs: 3_000, body: body({}, { extra: "Tan Ah Kow" }) }]);
    expect(report.probes[0]).toMatchObject({ validator: "SCHEMA_INVALID", schemaDiagnostic: { findings: [{ category: "UNKNOWN_FIELD_PRESENT", path: "$", rule: "strict_object", count: 1, boundary: null }] } });
    expect(JSON.stringify(report)).not.toMatch(/Tan Ah Kow|"extra"/);
  });
});

describe("meaning diagnostic in latency evidence", () => {
  it("attaches the value-free meaning diagnostic only to a meaning-gate probe", async () => {
    const flagged = structuredClone(outputFixture("EXPLAIN_PATTERN")) as Record<string, any>;
    // Option B: the model writes no limitations; limitation-style wording is exercised in the evidence field.
    flagged.payload.evidence.text = "The cause of the difference is not established, but stress caused it.";
    const { report } = await probe([{ delayMs: 3_000, body: { ...body(), output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify({ ...flagged, abstentionReason: null }) }] }] } }]);
    expect(report.probes[0]).toMatchObject({ validator: "CLINICAL_MEANING_VIOLATION", meaningDiagnostic: { findings: [{ category: "CAUSATION", rule: "clinical.causation.en", path: "payload.evidence.text", count: 1 }] } });
    expect(JSON.stringify(report)).not.toMatch(/established|stress/);
  });
});
