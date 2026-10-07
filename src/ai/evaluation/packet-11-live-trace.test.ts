// @vitest-environment node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { outputFixture } from "@/domain/ai/ai-test-fixtures";
import { KIE_DOCUMENTED_MODELS, KIE_GROK_RESPONSES_URL, KIE_RESPONSES_URL, type KieModelSnapshot } from "@/ai/kie/kie-model-catalogue";
import { selectEvaluationCandidates } from "@/ai/kie/kie-route-config";
import { projectProviderTaskPayload } from "@/application/ai/detached-payload-projector";
import { AI_TASK_RUNTIME_BUNDLES } from "@/application/ai/ai-runtime-bundles";
import { KIE_MAX_RESPONSE_BYTES, KIE_PROVIDER_SCHEMA_VERSION, providerOutputJsonSchema } from "@/ai/kie/kie-responses-contracts";
import { createKieResponsesProvider, type KieProviderDiagnostic } from "@/ai/kie/kie-responses-provider";
import { PACKET_11_PROMPT_VERSION, promptFor } from "@/ai/prompts/packet-11-prompts";
import { APPROVED_SMOKE_CONTRACT, KIE_ROUTE_VERSION, VALIDATOR_RULES_REVISION, evaluateModelSnapshot } from "./packet-11-evaluation";
import { fixturesForPhase, PACKET_11_FIXTURES, type AiEvaluationFixture } from "./packet-11-fixtures";
import { createPacket11LiveTracer, PACKET_11_TRACE_FORMAT_VERSION, PACKET_11_TRACE_ROOT, rawTraceRequested } from "./packet-11-live-trace";

/**
 * Packet 11B evaluation-only raw request/response trace (owner instruction
 * 2026-10-05). Offline: every response comes from a fake fetcher. No network,
 * key or credits.
 */

const TOKEN = "kie-SENTINEL-CREDENTIAL-7d1e5a90c4";
const MODEL: KieModelSnapshot = { ...KIE_DOCUMENTED_MODELS[0]!, contextWindow: null, defaultReasoningLevel: null, retrievedAt: "2026-10-06T01:00:00.000Z" };
const DIAGNOSTIC = fixturesForPhase("DIAGNOSTIC");
const FIXTURE = DIAGNOSTIC[0]!;
const LIMITS = { maxCalls: 1, maxCredits: 0.05, allowRepair: false };
const NOW = () => "2026-10-06T04:00:00.000Z";
const created: string[] = [];

function envelope(text: string, model: unknown = MODEL.responseModelSnapshot, retention: Record<string, unknown> = { store: false }): string {
  return JSON.stringify({
    id: "resp_1",
    object: "response",
    status: "completed",
    model,
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
    usage: { input_tokens: 687, output_tokens: 81, output_tokens_details: { reasoning_tokens: 0 } },
    credits_consumed: 0.01,
    ...retention,
  });
}

function abstain(reason: unknown) {
  const { payload: _payload, ...rest } = outputFixture(FIXTURE.taskType) as Record<string, unknown>;
  void _payload;
  return { ...rest, outcome: "ABSTAIN", abstentionReason: reason };
}

type FakeFetch = (url: string, init: RequestInit) => Promise<Response>;
function fakeFetch(body: string | Uint8Array) {
  return vi.fn<FakeFetch>(async () => new Response(body as BodyInit, { status: 200, headers: { "content-type": "application/json" } }));
}

/** The live runner's wiring: the adapter's redacted diagnostic is handed to the evaluator per call. */
function wired(fetcher: FakeFetch) {
  let last: KieProviderDiagnostic | null = null;
  const provider = createKieResponsesProvider({ token: TOKEN, model: MODEL, fetcher, onDiagnostic: (diagnostic) => (last = diagnostic) });
  const takeDiagnostic = () => {
    const taken = last;
    last = null;
    return taken;
  };
  return { provider, takeDiagnostic };
}

async function traced(fetcher: FakeFetch, fixtures: readonly AiEvaluationFixture[] = DIAGNOSTIC) {
  const tracer = await createPacket11LiveTracer({ fetcher, now: NOW });
  created.push(tracer.directory);
  const { provider, takeDiagnostic } = wired(tracer.fetcher);
  const report = await evaluateModelSnapshot({ model: MODEL, provider, fixtures, concurrency: 1, phase: "DIAGNOSTIC", limits: LIMITS, now: NOW, monotonicMs: () => 0, takeDiagnostic, observer: tracer.observer });
  return { tracer, report };
}

async function untraced(fetcher: FakeFetch) {
  const { provider, takeDiagnostic } = wired(fetcher);
  return evaluateModelSnapshot({ model: MODEL, provider, fixtures: DIAGNOSTIC, concurrency: 1, phase: "DIAGNOSTIC", limits: LIMITS, now: NOW, monotonicMs: () => 0, takeDiagnostic });
}

const filesIn = (directory: string) => readdirSync(directory).sort().map((name) => join(directory, name));
const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

afterEach(() => vi.restoreAllMocks());
afterAll(() => {
  for (const directory of created) {
    chmodSync(directory, 0o700);
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("raw trace activation", () => {
  it("is requested only by the exact explicit flag", () => {
    expect(rawTraceRequested({ KIE_EVALUATION_RAW_TRACE: "1" })).toBe(true);
    for (const value of [undefined, "", "0", "true", "yes", " 1", "1 "]) expect(rawTraceRequested({ KIE_EVALUATION_RAW_TRACE: value })).toBe(false);
  });

  it("writes only under the Git-ignored trace root, in a unique private directory per invocation", async () => {
    const first = await createPacket11LiveTracer({ fetcher: fakeFetch(""), now: NOW });
    const second = await createPacket11LiveTracer({ fetcher: fakeFetch(""), now: NOW });
    created.push(first.directory, second.directory);
    expect(PACKET_11_TRACE_ROOT).toBe("test-results/packet-11-live-trace");
    for (const tracer of [first, second]) {
      expect(relative(resolve(process.cwd(), PACKET_11_TRACE_ROOT), tracer.directory)).toMatch(/^[0-9TZ]+-[0-9a-f]{16}$/);
      expect(statSync(tracer.directory).mode & 0o777).toBe(0o700);
    }
    expect(first.directory).not.toBe(second.directory);
    // --no-index: the ignore rules themselves, not merely the absence of tracked files.
    expect(() => execFileSync("git", ["check-ignore", "-q", "--no-index", `${PACKET_11_TRACE_ROOT}/probe/01-call.request.json`], { cwd: process.cwd() })).not.toThrow();
  });
});

describe("request and response evidence", () => {
  it("records the exact request body with a redacted credential, and the exact raw response with closed outcomes", async () => {
    const reply = envelope(JSON.stringify(abstain("AMBIGUOUS_INPUT")));
    const fetcher = fakeFetch(reply);
    const { tracer, report } = await traced(fetcher);
    const [requestFile, responseFile] = filesIn(tracer.directory);
    expect(tracer.files()).toEqual([relative(process.cwd(), requestFile!), relative(process.cwd(), responseFile!)]);
    expect(requestFile).toMatch(/01-p11\.explain-pattern\.en-sg\.ordinary-call1\.request\.json$/);
    expect(responseFile).toMatch(/01-p11\.explain-pattern\.en-sg\.ordinary-call1\.response\.json$/);
    for (const file of [requestFile!, responseFile!]) expect(statSync(file).mode & 0o777).toBe(0o600);

    const request = readJson(requestFile!);
    const sent = fetcher.mock.calls[0]![1].body as string;
    expect(request).toMatchObject({ traceFormatVersion: PACKET_11_TRACE_FORMAT_VERSION, kind: "REQUEST", fixtureId: FIXTURE.id, callIndex: 1, recordedAt: "2026-10-06T04:00:00.000Z", endpoint: KIE_RESPONSES_URL, method: "POST" });
    expect(request.headers).toEqual({ accept: "application/json", authorization: "Bearer [REDACTED]", "content-type": "application/json" });
    expect(request.bodyText).toBe(sent);
    expect(request.body).toEqual(JSON.parse(sent));
    expect(request.body).toMatchObject({ model: "deepseek-v4-1-flash", stream: false, instructions: promptFor(FIXTURE.taskType, FIXTURE.locale)!.text, reasoning: { effort: "none" } });
    expect(request.body.input[0].content[0].type).toBe("input_text");
    expect(request.body.text.format).toEqual({ type: "json_schema", name: expect.any(String), schema: providerOutputJsonSchema(FIXTURE.taskType, FIXTURE.locale), strict: true });
    expect(request.bodyByteCount).toBe(Buffer.byteLength(sent, "utf8"));
    expect(request.bodySha256).toBe(sha256(request.bodyText));

    const response = readJson(responseFile!);
    expect(response).toMatchObject({
      traceFormatVersion: PACKET_11_TRACE_FORMAT_VERSION,
      kind: "RESPONSE",
      fixtureId: FIXTURE.id,
      callIndex: 1,
      transport: "RESPONSE_RECEIVED",
      httpStatus: 200,
      contentTypeClass: "JSON",
      body: { readResult: "COMPLETE", encoding: "utf8", raw: reply, byteCount: Buffer.byteLength(reply, "utf8") },
      parsedEnvelope: JSON.parse(reply),
      outputText: JSON.stringify(abstain("AMBIGUOUS_INPUT")),
      returnedModel: "deepseek-v4-1-flash-260910",
      usage: { inputTokens: 687, outputTokens: 81, reasoningTokens: 0, creditsConsumed: 0.01 },
      adapter: { outcome: "COMPLETED", failureReason: null, diagnosticCode: "COMPLETED" },
      validation: { verdict: "REJECTED", reasonCode: "MODEL_ABSTAINED", schema: "PASSED", reference: "PASSED", meaning: "NOT_APPLICABLE" },
      abstentionReason: "AMBIGUOUS_INPUT",
      finalDecision: { outcome: "FALLBACK", reasonCode: "MODEL_ABSTAINED" },
    });
    expect(response.body.sha256).toBe(sha256(response.body.raw));
    expect(report.fixtures[0]).toMatchObject({ reasonCode: "MODEL_ABSTAINED", abstentionReason: "AMBIGUOUS_INPUT" });
  });

  it("records an ABSTAIN without a reason as the raw data it is, while the gate stays SCHEMA_INVALID", async () => {
    const { tracer } = await traced(fakeFetch(envelope(JSON.stringify(abstain(null)))));
    const response = readJson(filesIn(tracer.directory)[1]!);
    expect(JSON.parse(response.outputText)).toMatchObject({ outcome: "ABSTAIN", abstentionReason: null });
    expect(response).toMatchObject({ validation: { verdict: "REJECTED", reasonCode: "SCHEMA_INVALID", schema: "FAILED", reference: "NOT_REACHED", meaning: "NOT_REACHED" }, abstentionReason: null, finalDecision: { outcome: "FALLBACK", reasonCode: "SCHEMA_INVALID" } });
    expect(response.validation.schemaDiagnostic.findings[0]).toMatchObject({ category: "REQUIRED_FIELD_MISSING", path: "abstentionReason" });
  });

  it("records an accepted call as accepted", async () => {
    const { tracer } = await traced(fakeFetch(envelope(JSON.stringify(outputFixture(FIXTURE.taskType)))));
    expect(readJson(filesIn(tracer.directory)[1]!)).toMatchObject({ validation: { verdict: "ACCEPTED", reasonCode: null, schema: "PASSED", reference: "PASSED", meaning: "PASSED" }, abstentionReason: null, finalDecision: { outcome: "ACCEPTED", reasonCode: "ACCEPTED" } });
  });

  it("still records the redacted request and a closed transport result when transmission fails", async () => {
    const fetcher = vi.fn<FakeFetch>(async () => {
      throw new TypeError("fetch failed");
    });
    const { tracer, report } = await traced(fetcher);
    const [requestFile, responseFile] = filesIn(tracer.directory);
    expect(readJson(requestFile!)).toMatchObject({ kind: "REQUEST", headers: { authorization: "Bearer [REDACTED]" } });
    expect(readJson(responseFile!)).toMatchObject({ transport: "TRANSPORT_FAILED", httpStatus: null, body: { readResult: "NOT_RECEIVED", raw: null, sha256: null }, parsedEnvelope: null, adapter: { outcome: "FAILED", failureReason: "TRANSPORT_FAILED", diagnosticCode: "TRANSPORT_FAILED" }, validation: { verdict: "NOT_RUN" } });
    expect(report.fixtures[0]).toMatchObject({ outcome: "FALLBACK", reasonCode: "TRANSPORT_FAILED" });
  });

  it("records an oversized body as such without storing it or relaxing the adapter's size limit", async () => {
    const big = new Uint8Array(KIE_MAX_RESPONSE_BYTES + 10).fill(0x20);
    const { tracer, report } = await traced(fakeFetch(big));
    const response = readJson(filesIn(tracer.directory)[1]!);
    expect(response).toMatchObject({ httpStatus: 200, body: { readResult: "OVERSIZED", raw: null, sha256: null }, parsedEnvelope: null, adapter: { outcome: "FAILED", diagnosticCode: "BODY_OVERSIZED" } });
    expect(response.body.byteCount).toBeGreaterThan(KIE_MAX_RESPONSE_BYTES);
    expect(report).toEqual(await untraced(fakeFetch(big)));
  });

  it("stores a non-UTF-8 body losslessly as base64 with a matching digest", async () => {
    const bytes = new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]);
    const { tracer } = await traced(fakeFetch(bytes));
    const response = readJson(filesIn(tracer.directory)[1]!);
    expect(response.body).toMatchObject({ readResult: "COMPLETE", encoding: "base64", raw: Buffer.from(bytes).toString("base64"), byteCount: 4 });
    expect(response.body.sha256).toBe(sha256(Buffer.from(response.body.raw, "base64")));
  });
});

describe("secret isolation and inert provider data", () => {
  it("never writes or prints the credential", async () => {
    const log = vi.spyOn(console, "log");
    const error = vi.spyOn(console, "error");
    const write = vi.spyOn(process.stdout, "write");
    const { tracer } = await traced(fakeFetch(envelope(JSON.stringify(abstain("INSUFFICIENT_CONTEXT")))));
    const all = filesIn(tracer.directory).map((file) => readFileSync(file, "utf8")).join("\n");
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain(TOKEN.slice(4, 20));
    expect(all).toContain("Bearer [REDACTED]");
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("keeps hostile model strings inert: exact JSON data, registry-derived file names, unchanged gates", async () => {
    const hostile = ["$(touch /tmp/pwned)", "`rm -rf ~`", "<script>alert(1)</script>", "\u001b[2J\u001b[31m", "line break", "../../../etc/passwd", "\"},\"injected\":true,{\""].join(" | ");
    const reply = envelope(JSON.stringify({ ...(outputFixture(FIXTURE.taskType) as object), extra: hostile }), "../../evil-model");
    const log = vi.spyOn(console, "log");
    const { tracer, report } = await traced(fakeFetch(reply));
    expect(readdirSync(tracer.directory).every((name) => /^\d{2}-p11\.[a-z0-9.-]+-call\d\.(request|response)\.json$/.test(name))).toBe(true);
    const response = readJson(filesIn(tracer.directory)[1]!);
    expect(response.body.raw).toBe(reply);
    expect(response.returnedModel).toBe("../../evil-model");
    expect(JSON.parse(response.parsedEnvelope.output[0].content[0].text).extra).toBe(hostile);
    expect(JSON.parse(response.outputText).extra).toBe(hostile);
    expect(response.adapter).toMatchObject({ outcome: "FAILED", diagnosticCode: "RESPONSE_MODEL_MISMATCH" });
    expect(log).not.toHaveBeenCalled();
    expect(report).toEqual(await untraced(fakeFetch(reply)));
  });

  it("leaves the evaluation report, provider results and fallback rules identical to an untraced run", async () => {
    for (const reply of [envelope(JSON.stringify(outputFixture(FIXTURE.taskType))), envelope(JSON.stringify(abstain("CANNOT_PRESERVE_MEANING"))), envelope("{not json"), envelope(JSON.stringify(abstain("TIRED")))]) {
      const { report } = await traced(fakeFetch(reply));
      expect(report).toEqual(await untraced(fakeFetch(reply)));
    }
  });
});

describe("synthetic fixture binding", () => {
  it("refuses a fixture that is not the registered frozen entry, or not HACKATHON_DEMO", async () => {
    const fetcher = fakeFetch(envelope("{}"));
    const tracer = await createPacket11LiveTracer({ fetcher, now: NOW });
    created.push(tracer.directory);
    expect(() => tracer.observer.beginFixture(structuredClone(FIXTURE) as AiEvaluationFixture)).toThrow("TRACE_FIXTURE_NOT_REGISTERED");
    const other = { ...FIXTURE, request: { ...FIXTURE.request, releaseProfile: "PRODUCTION" } } as unknown as AiEvaluationFixture;
    expect(() => tracer.observer.beginFixture(other)).toThrow("TRACE_FIXTURE_NOT_REGISTERED");
    expect(PACKET_11_FIXTURES.every((fixture) => fixture.request.releaseProfile === "HACKATHON_DEMO")).toBe(true);
    expect(readdirSync(tracer.directory)).toEqual([]);
  });

  it("refuses to transmit an ordinary request with no bound fixture, or a payload that is not the fixture's projection", async () => {
    const fetcher = fakeFetch(envelope("{}"));
    const tracer = await createPacket11LiveTracer({ fetcher, now: NOW });
    created.push(tracer.directory);
    const init = { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ model: "m", input: [{ role: "user", content: [{ type: "input_text", text: "{}" }] }] }) };
    await expect(tracer.fetcher(KIE_RESPONSES_URL, init)).rejects.toThrow("TRACE_NO_BOUND_FIXTURE");
    tracer.observer.beginFixture(FIXTURE);
    await expect(tracer.fetcher(KIE_RESPONSES_URL, init)).rejects.toThrow("TRACE_REQUEST_NOT_FIXTURE_PROJECTION");
    expect(fetcher).not.toHaveBeenCalled();
    expect(readdirSync(tracer.directory)).toEqual([]);
  });

  it("aborts the evaluation without transmitting when evidence cannot be written", async () => {
    const fetcher = fakeFetch(envelope(JSON.stringify(outputFixture(FIXTURE.taskType))));
    const tracer = await createPacket11LiveTracer({ fetcher, now: NOW });
    created.push(tracer.directory);
    chmodSync(tracer.directory, 0o500);
    const provider = createKieResponsesProvider({ token: TOKEN, model: MODEL, fetcher: tracer.fetcher });
    await expect(evaluateModelSnapshot({ model: MODEL, provider, fixtures: DIAGNOSTIC, concurrency: 1, phase: "DIAGNOSTIC", limits: LIMITS, now: NOW, monotonicMs: () => 0, observer: tracer.observer })).rejects.toThrow("TRACE_WRITE_FAILED");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("unchanged approved contract", () => {
  it("keeps the approved model identity and contract revisions", () => {
    expect(APPROVED_SMOKE_CONTRACT).toEqual({ requestModelId: "deepseek-flash", responseModelSnapshot: "deepseek-flash", promptVersion: "11b.11", providerSchemaVersion: "kie-schema.11b.3", routeVersion: "packet11-responses.11b.6", validatorRulesRevision: "11b.2-meaning-r7", approvedMeaningRegistryRevision: "ai-meaning-registry.11b.1", fixtureSetRevision: "packet11-fixtures.11b.3", evaluationReportVersion: "packet11-eval.4" });
    expect([PACKET_11_PROMPT_VERSION, KIE_PROVIDER_SCHEMA_VERSION, KIE_ROUTE_VERSION, VALIDATOR_RULES_REVISION]).toEqual(["11b.11", "kie-schema.11b.3", "packet11-responses.11b.6", "11b.2-meaning-r7"]);
  });
});

describe("retention in the trace (owner instruction 2026-10-05)", () => {
  const output = () => JSON.stringify(outputFixture(FIXTURE.taskType));

  it("records requestedStore false on the request, and the returned store with its closed result on the response", async () => {
    const { tracer } = await traced(fakeFetch(envelope(output())));
    const [requestFile, responseFile] = filesIn(tracer.directory);
    const request = readJson(requestFile!);
    expect(request.requestedStore).toBe(false);
    expect(request.body.store).toBe(false);
    expect(request.bodyText).toContain('"store":false');
    expect(readJson(responseFile!)).toMatchObject({ requestedStore: false, returnedStorePresent: true, returnedStore: false, retention: "CONFIRMED_NOT_STORED", adapter: { outcome: "COMPLETED" } });
    expect(tracer.summary()[0]).toMatchObject({ retention: "CONFIRMED_NOT_STORED" });
  });

  it.each([
    ["store: true", { store: true }, true, true, "PROVIDER_REPORTED_STORED"],
    ["absent store", {}, false, null, "RETENTION_UNCONFIRMED"],
    ["string store", { store: "false" }, true, "false", "RETENTION_UNCONFIRMED"],
  ] as const)("records %s as returned, with its closed retention result", async (_label, retention, present, returned, result) => {
    const { tracer } = await traced(fakeFetch(envelope(output(), MODEL.responseModelSnapshot, retention)));
    expect(readJson(filesIn(tracer.directory)[1]!)).toMatchObject({ requestedStore: false, returnedStorePresent: present, returnedStore: returned, retention: result });
  });

  it("records no retention result when no response arrived", async () => {
    const { tracer } = await traced(vi.fn<FakeFetch>(async () => Promise.reject(new TypeError("fetch failed"))));
    expect(readJson(filesIn(tracer.directory)[1]!)).toMatchObject({ requestedStore: false, returnedStorePresent: false, returnedStore: null, retention: null });
  });

  it("sends the identical store: false body with and without tracing", async () => {
    const plain = fakeFetch(envelope(output()));
    await untraced(plain);
    const tracedFetch = fakeFetch(envelope(output()));
    await traced(tracedFetch);
    expect(tracedFetch.mock.calls[0]![1].body).toBe(plain.mock.calls[0]![1].body);
    expect(JSON.parse(plain.mock.calls[0]![1].body as string).store).toBe(false);
  });

  it("refuses to transmit a fixture request whose body does not carry store: false", async () => {
    const capture = fakeFetch(envelope(output()));
    await untraced(capture);
    const [url, init] = capture.mock.calls[0]!;
    const fetcher = fakeFetch(envelope(output()));
    const tracer = await createPacket11LiveTracer({ fetcher, now: NOW });
    created.push(tracer.directory);
    tracer.observer.beginFixture(FIXTURE);
    for (const store of [true, undefined]) {
      const body = { ...JSON.parse(init.body as string), store };
      await expect(tracer.fetcher(url, { ...init, body: JSON.stringify(body) })).rejects.toThrow("TRACE_REQUEST_RETENTION_UNSAFE");
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(readdirSync(tracer.directory)).toEqual([]);
  });
});

describe("Grok request layout under the trace (route kie-responses.11b.5, owner approval 2026-10-06)", () => {
  const selected = selectEvaluationCandidates({ requested: "grok-4-7", listing: [], now: () => "2026-10-06T01:00:00.000Z" });
  const GROK = (selected.kind === "SELECTED" ? selected.candidates[0] : null)!;
  const projection = () => {
    const projected = projectProviderTaskPayload(FIXTURE.request, AI_TASK_RUNTIME_BUNDLES[FIXTURE.taskType]);
    if (projected.kind !== "PROJECTED") throw new Error(projected.reason);
    return JSON.stringify(projected.payload);
  };
  const message = (text: string) => ({ role: "user", content: [{ type: "input_text", text }] });
  const send = (tracer: Awaited<ReturnType<typeof createPacket11LiveTracer>>, input: unknown[]) =>
    tracer.fetcher(KIE_GROK_RESPONSES_URL, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ model: "grok-4-7", store: false, input }) });

  it("traces a Grok diagnostic: instructions and data as separate messages, sent only to the Grok endpoint", async () => {
    const fetcher = vi.fn<FakeFetch>(async () => new Response(envelope(JSON.stringify({ ...(outputFixture(FIXTURE.taskType) as object), abstentionReason: null }), "grok-4-7"), { status: 200, headers: { "content-type": "application/json" } }));
    const tracer = await createPacket11LiveTracer({ fetcher, now: NOW });
    created.push(tracer.directory);
    let last: KieProviderDiagnostic | null = null;
    const provider = createKieResponsesProvider({ token: TOKEN, model: GROK, fetcher: tracer.fetcher, onDiagnostic: (diagnostic) => (last = diagnostic) });
    const report = await evaluateModelSnapshot({ model: GROK, provider, fixtures: DIAGNOSTIC, concurrency: 1, phase: "DIAGNOSTIC", limits: LIMITS, now: NOW, monotonicMs: () => 0, takeDiagnostic: () => last, observer: tracer.observer });
    expect(report.fixtures[0]).toMatchObject({ outcome: "ACCEPTED", responseModel: "grok-4-7", retention: "CONFIRMED_NOT_STORED" });
    expect(fetcher.mock.calls[0]![0]).toBe(KIE_GROK_RESPONSES_URL);
    const request = readJson(filesIn(tracer.directory).find((file) => file.endsWith(".request.json"))!);
    expect(request.endpoint).toBe(KIE_GROK_RESPONSES_URL);
    expect(request.headers.authorization).toBe("Bearer [REDACTED]");
    expect(request.body.input.map((entry: { content: Array<{ text: string }> }) => entry.content[0]!.text)).toEqual([promptFor(FIXTURE.taskType, FIXTURE.locale)!.text, projection()]);
    expect(JSON.stringify(readdirSync(tracer.directory).map((name) => readFileSync(join(tracer.directory, name), "utf8")))).not.toContain(TOKEN);
  });

  it("refuses data merged into the instruction message, data placed before the instructions, or data repeated", async () => {
    const fetcher = fakeFetch(envelope("{}"));
    const tracer = await createPacket11LiveTracer({ fetcher, now: NOW });
    created.push(tracer.directory);
    tracer.observer.beginFixture(FIXTURE);
    const prompt = promptFor(FIXTURE.taskType, FIXTURE.locale)!.text;
    await expect(send(tracer, [message(`${prompt}\n${projection()}`)])).rejects.toThrow("TRACE_REQUEST_NOT_FIXTURE_PROJECTION");
    await expect(send(tracer, [message(projection()), message(prompt)])).rejects.toThrow("TRACE_REQUEST_NOT_FIXTURE_PROJECTION");
    await expect(send(tracer, [message(`${prompt}${projection()}`), message(projection())])).rejects.toThrow("TRACE_REQUEST_NOT_FIXTURE_PROJECTION");
    expect(fetcher).not.toHaveBeenCalled();
    expect(readdirSync(tracer.directory)).toEqual([]);
  });
});
