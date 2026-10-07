// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiProviderPort } from "@/application/ai/ai-provider-port";
import type { ProviderTaskRequest } from "@/domain/ai";
import { outputFixture, requestFixture } from "@/domain/ai/ai-test-fixtures";
import { projectProviderTaskPayload } from "@/application/ai/detached-payload-projector";
import { AI_ACTIVATION_MANIFEST } from "@/application/ai/ai-activation-manifest";
import { AI_TASK_RUNTIME_BUNDLES } from "@/application/ai/ai-runtime-bundles";
import { validateAiTaskOutput } from "@/application/ai/ai-output-validator";
import { createDeterministicFallback } from "@/application/ai/ai-fallbacks";
import { createAiTaskService } from "@/application/ai/ai-task-service";
import { promptFor } from "@/ai/prompts/packet-11-prompts";
import { KIE_GROK_RESPONSES_URL, KIE_RESPONSES_URL } from "@/ai/kie/kie-model-catalogue";
import { providerOutputJsonSchema, providerOutputSchemaName } from "@/ai/kie/kie-responses-contracts";
import { createKieResponsesProvider, type KieProviderDiagnostic } from "@/ai/kie/kie-responses-provider";
import { minimumReasoningEffort, selectEvaluationCandidates } from "@/ai/kie/kie-route-config";
import { AI_EVALUATION_REPORT_VERSION, APPROVED_SMOKE_CONTRACT, contractMismatches, evaluateModelSnapshot, KIE_ROUTE_VERSION } from "@/ai/evaluation/packet-11-evaluation";
import { fixturesForPhase } from "@/ai/evaluation/packet-11-fixtures";
import { DEEPSEEK_DOCUMENTED_MODELS, DEEPSEEK_FLASH_PEAK_USD_PER_MILLION, DEEPSEEK_RESPONSES_URL, readDeepSeekToken } from "./deepseek-catalogue";
import { createDeepSeekResponsesProvider } from "./deepseek-responses-provider";

/**
 * Evaluation-only direct DeepSeek Responses provider (owner instruction 2026-10-06). Documentation
 * (api-docs.deepseek.com, retrieved 2026-10-06): POST https://api.deepseek.com/responses; model deepseek-flash
 * (DeepSeek-V4.1-Flash); `instructions` is inserted as the first system message; `reasoning.effort` none disables
 * thinking; `text.format` {type: json_schema, name, schema}; `store` is not supported and "the response always
 * carries store: false"; responses carry `model`, `status`, `output`, `usage`; no credits field (USD pricing).
 * Identity and retention are accepted only from observed response fields. Production stays deterministic-only.
 */

const TOKEN = "deepseek-SENTINEL-credential-4b2e";
const selection = selectEvaluationCandidates({ requested: "deepseek-flash", listing: [], documented: DEEPSEEK_DOCUMENTED_MODELS, now: () => "2026-10-06T01:00:00.000Z" });
const MODEL = (selection.kind === "SELECTED" ? selection.candidates[0] : null)!;
type Task = "EXPLAIN_PATTERN" | "DRAFT_CARE_PREPARATION_SUMMARY";
function payload(taskType: Task = "EXPLAIN_PATTERN", locale: "en-SG" | "zh-SG" = "en-SG"): ProviderTaskRequest {
  const projected = projectProviderTaskPayload({ ...requestFixture(taskType), locale }, AI_TASK_RUNTIME_BUNDLES[taskType]);
  if (projected.kind !== "PROJECTED") throw new Error(projected.reason);
  return projected.payload;
}
const envelope = (taskType: Task = "EXPLAIN_PATTERN") => ({ ...outputFixture(taskType), abstentionReason: null });
/** The documented create-response example's fields. */
const documented = (text: string, extra: Record<string, unknown> = {}) => ({
  id: "24778070-1c36-4ae0-a4bd-870afc7fc13e",
  object: "response",
  created_at: 1753000000,
  status: "completed",
  model: "deepseek-flash",
  output: [
    { type: "reasoning", id: "rs_1", status: "completed", content: [{ type: "reasoning_text", text: "x" }], summary: [] },
    { type: "message", id: "msg_1", status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] },
  ],
  usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 200, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 1200 },
  store: false,
  parallel_tool_calls: true,
  previous_response_id: null,
  error: null,
  incomplete_details: null,
  ...extra,
});
const reply = (body: unknown, status = 200, contentType = "application/json") => vi.fn(async (_url: string, _init: RequestInit) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": contentType } }));
async function call(fetcher: ReturnType<typeof reply> | ((url: string, init: RequestInit) => Promise<Response>), input = payload(), signal = new AbortController().signal, model = MODEL) {
  let diagnostic: KieProviderDiagnostic | null = null;
  const result = await createDeepSeekResponsesProvider({ token: TOKEN, model, fetcher, onDiagnostic: (value) => (diagnostic = value) }).invoke(input, signal);
  return { result, diagnostic: diagnostic as KieProviderDiagnostic | null };
}
const sentBody = (fetcher: ReturnType<typeof reply>) => JSON.parse(fetcher.mock.calls[0]![1].body as string) as Record<string, any>;

afterEach(() => vi.restoreAllMocks());

describe("catalogue, credential and selection", () => {
  it("documents deepseek-flash at the direct DeepSeek Responses endpoint, evaluation-only", () => {
    expect(DEEPSEEK_RESPONSES_URL).toBe("https://api.deepseek.com/responses");
    expect(DEEPSEEK_DOCUMENTED_MODELS).toEqual([
      {
        requestModelId: "deepseek-flash",
        responseModelSnapshot: "deepseek-flash",
        provenance: "DOCUMENTED_UNLISTED_EVALUATION_ONLY",
        endpoint: "https://api.deepseek.com/responses",
        documentationUrl: "https://api-docs.deepseek.com/api/create-response",
        documentedAt: "2026-10-06",
        supportedReasoningLevels: ["none", "low", "high", "max"],
        structuredOutput: "TEXT_FORMAT_JSON_SCHEMA_STRICT",
        unsupportedParameters: [],
      },
    ]);
    expect(DEEPSEEK_FLASH_PEAK_USD_PER_MILLION).toEqual({ inputCacheMiss: 0.3, output: 1.2 });
  });

  it("selects deepseek-flash from the DeepSeek registry with effort none", () => {
    expect(MODEL).toMatchObject({ requestModelId: "deepseek-flash", responseModelSnapshot: "deepseek-flash", endpoint: DEEPSEEK_RESPONSES_URL, provenance: "DOCUMENTED_UNLISTED_EVALUATION_ONLY" });
    expect(minimumReasoningEffort(MODEL)).toBe("none");
  });

  it("reads only the server-side DEEPSEEK_API_KEY, never a public copy", () => {
    expect(readDeepSeekToken({ DEEPSEEK_API_KEY: ` ${TOKEN} ` })).toEqual({ kind: "CONFIGURED", token: TOKEN });
    expect(readDeepSeekToken({ NEXT_PUBLIC_DEEPSEEK_API_KEY: TOKEN })).toEqual({ kind: "MISSING_CONFIGURATION" });
    expect(readDeepSeekToken({ KIE_API_KEY: TOKEN })).toEqual({ kind: "MISSING_CONFIGURATION" });
    expect(readDeepSeekToken({ DEEPSEEK_API_KEY: "  " })).toEqual({ kind: "MISSING_CONFIGURATION" });
  });
});

describe("request: exact endpoint and model, instructions/input separation, strict schema", () => {
  it.each([["EXPLAIN_PATTERN", "en-SG"], ["EXPLAIN_PATTERN", "zh-SG"], ["DRAFT_CARE_PREPARATION_SUMMARY", "en-SG"], ["DRAFT_CARE_PREPARATION_SUMMARY", "zh-SG"]] as const)("%s %s", async (task, locale) => {
    const fetcher = reply(documented(JSON.stringify(envelope(task))));
    const input = payload(task, locale);
    await call(fetcher, input);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://api.deepseek.com/responses");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    const body = sentBody(fetcher);
    expect(Object.keys(body)).toEqual(["model", "stream", "store", "instructions", "input", "reasoning", "text"]);
    expect(body.model).toBe("deepseek-flash");
    expect(body.stream).toBe(false);
    expect(body.store).toBe(false);
    expect(body.reasoning).toEqual({ effort: "none" });
    expect(body.instructions).toBe(promptFor(task, locale)!.text);
    expect(body.input).toEqual([{ role: "user", content: [{ type: "input_text", text: JSON.stringify(input) }] }]);
    expect(body.instructions).not.toContain(JSON.stringify(input));
    expect(body.text).toEqual({ format: { type: "json_schema", name: providerOutputSchemaName(task, locale), schema: providerOutputJsonSchema(task, locale), strict: true } });
    expect(body).not.toHaveProperty("tools");
  });

  it("sends nothing, and never the credential, to an endpoint outside the DeepSeek allowlist", async () => {
    for (const endpoint of [KIE_RESPONSES_URL, KIE_GROK_RESPONSES_URL, "https://api.deepseek.com/chat/completions", "https://example.com/responses"]) {
      const fetcher = reply(documented(JSON.stringify(envelope())));
      const { result, diagnostic } = await call(fetcher, payload(), new AbortController().signal, { ...MODEL, endpoint });
      expect(result).toEqual({ kind: "FAILED", reason: "MISSING_CONFIGURATION" });
      expect(fetcher).not.toHaveBeenCalled();
      expect(diagnostic).toBeNull();
    }
  });

  it("the Kie provider never sends a Kie credential to the DeepSeek endpoint", async () => {
    const fetcher = reply(documented(JSON.stringify(envelope())));
    const result = await createKieResponsesProvider({ token: TOKEN, model: MODEL, fetcher }).invoke(payload(), new AbortController().signal);
    expect(result).toEqual({ kind: "FAILED", reason: "MISSING_CONFIGURATION" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("identifies itself as provider deepseek with the expected snapshot", () => {
    expect(createDeepSeekResponsesProvider({ token: TOKEN, model: MODEL }).providerModel).toEqual({ providerKey: "deepseek", modelSnapshot: "deepseek-flash" });
  });
});

describe("response: identity and retention observed, never inferred", () => {
  it("accepts the documented envelope with model deepseek-flash, store:false and completed status", async () => {
    const { result, diagnostic } = await call(reply(documented(JSON.stringify(envelope()))));
    expect(result).toEqual({
      kind: "COMPLETED",
      candidate: outputFixture("EXPLAIN_PATTERN"),
      // Upper-bound estimate at the documented peak cache-miss rates: 1000 x 0.30 + 200 x 1.20 micro-USD.
      usage: { inputTokens: 1000, outputTokens: 200, costMicroUsd: 540, credits: null },
      responseModel: "deepseek-flash",
      retention: "CONFIRMED_NOT_STORED",
    });
    expect(diagnostic).toMatchObject({ code: "COMPLETED", modelIdentity: { requested: "deepseek-flash", expected: "deepseek-flash", returned: "deepseek-flash", comparison: "IDENTICAL" }, retention: "CONFIRMED_NOT_STORED" });
  });

  it("fails a response without a model identifier", async () => {
    const body: Record<string, unknown> = documented(JSON.stringify(envelope()));
    delete body.model;
    const { result, diagnostic } = await call(reply(body));
    expect(result).toEqual({ kind: "FAILED", reason: "PROVIDER_FAILED" });
    expect(diagnostic).toMatchObject({ code: "RESPONSE_MODEL_MISSING", modelIdentity: { returned: null, comparison: "MISSING" } });
  });

  it.each(["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-flash-0910", "DeepSeek-V4.1-Flash"])("fails the returned identifier %s and records it only as evidence", async (returned) => {
    const { result, diagnostic } = await call(reply(documented(JSON.stringify(envelope()), { model: returned })));
    expect(result).toEqual({ kind: "FAILED", reason: "PROVIDER_FAILED" });
    expect(diagnostic?.code).toBe("RESPONSE_MODEL_MISMATCH");
  });

  it.each([["missing", undefined], ["null", null], ["the string \"false\"", "false"], ["0", 0], ["an object", { value: false }]] as const)("store %s is RETENTION_UNCONFIRMED", async (_label, store) => {
    const body: Record<string, unknown> = documented(JSON.stringify(envelope()));
    if (store === undefined) delete body.store;
    else body.store = store;
    const { result, diagnostic } = await call(reply(body));
    expect(result).toMatchObject({ kind: "COMPLETED", retention: "RETENTION_UNCONFIRMED" });
    expect(diagnostic?.retention).toBe("RETENTION_UNCONFIRMED");
  });

  it("rejects store:true", async () => {
    const { result, diagnostic } = await call(reply(documented(JSON.stringify(envelope()), { store: true })));
    expect(result).toEqual({ kind: "FAILED", reason: "PROVIDER_FAILED" });
    expect(diagnostic).toMatchObject({ code: "RESPONSE_STORED" });
  });

  it.each(["incomplete", "failed", "in_progress"])("fails a %s response", async (status) => {
    const { result, diagnostic } = await call(reply(documented(JSON.stringify(envelope()), { status, incomplete_details: status === "incomplete" ? { reason: "max_output_tokens" } : null })));
    expect(result).toEqual({ kind: "FAILED", reason: "PROVIDER_FAILED" });
    expect(diagnostic?.code).toBe("STATUS_NOT_COMPLETED");
  });

  it("passes malformed structured output to the validator unaccepted (no repair or rewrite here)", async () => {
    const { result } = await call(reply(documented("{not json")));
    expect(result).toMatchObject({ kind: "COMPLETED", candidate: "{not json" });
  });

  it("keeps an object followed by an extra } as the raw string (no trailing-character trimming); the validator rejects it as SCHEMA_INVALID", async () => {
    const text = `${JSON.stringify(outputFixture("EXPLAIN_PATTERN"))}}`;
    const { result } = await call(reply(documented(text)));
    expect(result).toMatchObject({ kind: "COMPLETED", candidate: text });
    expect(validateAiTaskOutput(requestFixture("EXPLAIN_PATTERN"), AI_TASK_RUNTIME_BUNDLES.EXPLAIN_PATTERN, (result as { candidate: unknown }).candidate)).toMatchObject({ kind: "REJECTED", reason: "SCHEMA_INVALID" });
    expect(validateAiTaskOutput(requestFixture("EXPLAIN_PATTERN"), AI_TASK_RUNTIME_BUNDLES.EXPLAIN_PATTERN, text.slice(0, -1))).toMatchObject({ kind: "ACCEPTED" });
  });
});

describe("timeout, provider failure and secret isolation", () => {
  it("an aborted call is a redacted REQUEST_TIMEOUT transport failure", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      controller.abort();
      throw (init.signal as AbortSignal).reason ?? new Error("aborted");
    });
    const { result, diagnostic } = await call(fetcher, payload(), controller.signal);
    expect(result).toEqual({ kind: "FAILED", reason: "TRANSPORT_FAILED" });
    expect(diagnostic).toMatchObject({ code: "REQUEST_TIMEOUT" });
  });

  it.each([[401, "MISSING_CONFIGURATION"], [402, "OPERATIONAL_SPEND_LOCKED"], [429, "PROVIDER_RATE_LIMITED"], [500, "PROVIDER_FAILED"], [503, "PROVIDER_FAILED"], [504, "PROVIDER_TIMEOUT"], [400, "PROVIDER_REJECTED"]] as const)("HTTP %s is %s", async (status, reason) => {
    const { result } = await call(reply({ error: { message: TOKEN } }, status));
    expect(result).toEqual({ kind: "FAILED", reason });
  });

  it("never places the credential in a result or diagnostic", async () => {
    for (const fetcher of [reply(documented(JSON.stringify(envelope()))), reply({ error: { message: TOKEN } }, 500), reply(documented(JSON.stringify(envelope()), { store: true }))]) {
      const outcome = await call(fetcher);
      expect(JSON.stringify(outcome)).not.toContain(TOKEN);
    }
  });
});

describe("unchanged deterministic fallback behaviour", () => {
  it("a failing DeepSeek provider yields exactly the same deterministic fallback as any failing provider", async () => {
    const request = requestFixture("EXPLAIN_PATTERN");
    const manifest = { ...AI_ACTIVATION_MANIFEST, tasks: { ...AI_ACTIVATION_MANIFEST.tasks, EXPLAIN_PATTERN: "SYNTHETIC_REMOTE_ENABLED" as const } };
    const failing = (provider: AiProviderPort) => createAiTaskService({ releaseProfile: "HACKATHON_DEMO", manifest, provider, audit: { append: async () => undefined }, now: () => "2026-10-06T02:00:00.000Z", monotonicMs: () => 0 }).execute(request);
    const viaDeepSeek = await failing(createDeepSeekResponsesProvider({ token: TOKEN, model: MODEL, fetcher: reply({}, 500) }));
    const viaOther = await failing({ providerModel: { providerKey: "other", modelSnapshot: "x" }, invoke: async () => ({ kind: "FAILED", reason: "PROVIDER_FAILED" }) });
    expect(viaDeepSeek).toEqual({ kind: "FALLBACK", fallback: createDeterministicFallback(request, "PROVIDER_FAILED"), auditRef: request.requestId });
    expect(viaDeepSeek).toEqual(viaOther);
  });
});

describe("evaluation contract and spend", () => {
  it("the approved evaluation contract names deepseek-flash on route packet11-responses.11b.6 under harness packet11-eval.4", () => {
    expect(KIE_ROUTE_VERSION).toBe("packet11-responses.11b.6");
    expect(AI_EVALUATION_REPORT_VERSION).toBe("packet11-eval.4");
    expect(APPROVED_SMOKE_CONTRACT).toMatchObject({ requestModelId: "deepseek-flash", responseModelSnapshot: "deepseek-flash", routeVersion: "packet11-responses.11b.6", evaluationReportVersion: "packet11-eval.4" });
    expect(contractMismatches(MODEL)).toEqual([]);
    expect(contractMismatches({ requestModelId: "grok-4-7", responseModelSnapshot: "grok-4-7" })).toEqual(["requestModelId", "responseModelSnapshot"]);
  });

  it("a provider that reports no credits is held to the ceiling by its USD estimate", async () => {
    const fixtures = fixturesForPhase("SMOKE").filter((fixture) => fixture.taskType === "EXPLAIN_PATTERN");
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { input: Array<{ content: Array<{ text: string }> }> };
      const locale = (JSON.parse(body.input[0]!.content[0]!.text) as { locale: "en-SG" | "zh-SG" }).locale;
      const output = { ...envelope(), locale } as Record<string, any>;
      if (locale === "zh-SG") for (const key of ["headline", "observation", "evidence"]) output.payload[key].text = "最近记录的数值是 6.2 和 7.1 mmol/L。";
      return new Response(JSON.stringify(documented(JSON.stringify(output))), { status: 200, headers: { "content-type": "application/json" } });
    });
    const provider = createDeepSeekResponsesProvider({ token: TOKEN, model: MODEL, fetcher });
    // 540 micro-USD per call; a 0.0005 USD ceiling is reached after the first call.
    const report = await evaluateModelSnapshot({ model: MODEL, provider, fixtures, concurrency: 1, phase: "SMOKE", limits: { maxCalls: 2, maxCredits: 0.0005, allowRepair: false }, now: () => "2026-10-06T02:00:00.000Z", monotonicMs: () => 0 });
    expect(report.stoppedReason).toBe("CREDIT_CEILING");
    expect(report.fixtures).toHaveLength(1);
    expect(report.totals.credits).toBe(0.00054);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("the guarded live runner can target the direct DeepSeek provider (source inspection; no live call)", () => {
  const source = (() => {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    return readFileSync(`${process.cwd()}/src/ai/evaluation/packet-11-live-kie.test.ts`, "utf8");
  })();
  const at = (needle: string) => {
    const index = source.indexOf(needle);
    expect(index, needle).toBeGreaterThan(0);
    return index;
  };

  it("chooses the provider from PACKET11_EVALUATION_PROVIDER (kie default, or deepseek) and refuses any other value before a request", () => {
    expect(source).toMatch(/PACKET11_EVALUATION_PROVIDER/);
    expect(at("PACKET11_EVALUATION_PROVIDER_INVALID")).toBeLessThan(at("evaluateModelSnapshot({"));
  });

  it("for deepseek: only DEEPSEEK_API_KEY, a USD ceiling, no Kie listing, the DeepSeek registry and the DeepSeek adapter", () => {
    expect(at("readDeepSeekToken(env)")).toBeLessThan(at("evaluateModelSnapshot({"));
    expect(at("DEEPSEEK_EVALUATION_MAX_USD")).toBeLessThan(at("evaluateModelSnapshot({"));
    expect(at("documented: DEEPSEEK_DOCUMENTED_MODELS")).toBeLessThan(at("evaluateModelSnapshot({"));
    expect(at("createDeepSeekResponsesProvider(providerConfig)")).toBeLessThan(at("evaluateModelSnapshot({"));
    // The DeepSeek branch short-circuits before any Kie listing request.
    expect(source).toMatch(/const listing = provider === "deepseek" \? \[\] : /);
  });

  it("prints the endpoint and spend unit with the closed contract before any model call", () => {
    const print = at("packet11Contract");
    expect(print).toBeLessThan(at("evaluateModelSnapshot({"));
    expect(source.slice(print, print + 400)).toMatch(/endpoint: model\.endpoint/);
    expect(source.slice(print, print + 400)).toMatch(/spendUnit/);
  });
});
