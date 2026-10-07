// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderTaskRequest } from "@/domain/ai";
import { outputFixture, requestFixture } from "@/domain/ai/ai-test-fixtures";
import { projectProviderTaskPayload } from "@/application/ai/detached-payload-projector";
import { AI_TASK_RUNTIME_BUNDLES } from "@/application/ai/ai-runtime-bundles";
import { promptFor } from "@/ai/prompts/packet-11-prompts";
import { APPROVED_SMOKE_CONTRACT, contractMismatches, KIE_ROUTE_VERSION } from "@/ai/evaluation/packet-11-evaluation";
import { KIE_DOCUMENTED_MODELS, KIE_GROK_RESPONSES_URL, KIE_RESPONSES_URL, type KieModelSnapshot } from "./kie-model-catalogue";
import { providerOutputJsonSchema, providerOutputSchemaName } from "./kie-responses-contracts";
import { createKieResponsesProvider, type KieProviderDiagnostic } from "./kie-responses-provider";
import { KIE_EXCLUDED_EVALUATION_MODELS, minimumReasoningEffort, resolveProductKieRoute, selectEvaluationCandidates } from "./kie-route-config";

/**
 * Grok 4.7 evaluation-only adapter (owner approval 2026-10-06). Documentation (docs.kie.ai/market/grok/grok-4-7.md,
 * retrieved 2026-10-06): POST https://api.kie.ai/grok/v1/responses; model, stream, input (string or role/content
 * messages), reasoning.effort low..xhigh, text.format json_schema strict (required). No `instructions` field, no
 * system/developer role, no `store` and no response `model` are documented. Owner policy: model identity and
 * retention may be established only from observed response fields, never inferred; a response without a usable
 * model identifier or a boolean `store: false` fails. Production routing stays deterministic-only.
 */

const TOKEN = "sentinel-token-do-not-leak";
const GROK = KIE_DOCUMENTED_MODELS.find((model) => model.requestModelId === "grok-4-7")!;
const snapshot = (overrides: Partial<KieModelSnapshot> = {}): KieModelSnapshot => {
  const selected = selectEvaluationCandidates({ requested: "grok-4-7", listing: [], now: () => "2026-10-06T01:00:00.000Z" });
  if (selected.kind !== "SELECTED") throw new Error(selected.reason);
  return { ...selected.candidates[0]!, ...overrides };
};
type Task = "EXPLAIN_PATTERN" | "DRAFT_CARE_PREPARATION_SUMMARY";
function payload(taskType: Task, locale: "en-SG" | "zh-SG" = "en-SG"): ProviderTaskRequest {
  const projected = projectProviderTaskPayload({ ...requestFixture(taskType), locale }, AI_TASK_RUNTIME_BUNDLES[taskType]);
  if (projected.kind !== "PROJECTED") throw new Error(projected.reason);
  return projected.payload;
}
const envelope = (taskType: Task = "EXPLAIN_PATTERN") => ({ ...outputFixture(taskType), abstentionReason: null });
/** The documented Grok response example's fields, plus whatever the test adds. */
const grokResponse = (text: string, extra: Record<string, unknown> = {}) => ({
  output: [
    { type: "reasoning", id: "rs_xxx", summary: [] },
    { type: "message", role: "assistant", id: "msg_xxx", content: [{ type: "output_text", text }], status: "completed" },
  ],
  usage: { total_tokens: 1300, output_tokens: 300, input_tokens: 1000 },
  credits_consumed: 0.31,
  status: "completed",
  ...extra,
});
const OBSERVED = { model: "grok-4-7", store: false };
const reply = (body: unknown, contentType = "application/json") => vi.fn(async (_url: string, _init: RequestInit) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200, headers: { "content-type": contentType } }));
async function call(fetcher: ReturnType<typeof reply> | ((url: string, init: RequestInit) => Promise<Response>), model = snapshot(), input = payload("EXPLAIN_PATTERN"), signal = new AbortController().signal) {
  let diagnostic: KieProviderDiagnostic | null = null;
  const result = await createKieResponsesProvider({ token: TOKEN, model, fetcher, onDiagnostic: (value) => (diagnostic = value) }).invoke(input, signal);
  return { result, diagnostic: diagnostic as KieProviderDiagnostic | null };
}
const sentBody = (fetcher: ReturnType<typeof reply>) => JSON.parse(fetcher.mock.calls[0]![1].body as string) as Record<string, any>;

afterEach(() => vi.restoreAllMocks());

describe("catalogue and candidate selection", () => {
  it("documents grok-4-7 as evaluation-only, at the Grok endpoint, with strict structured output", () => {
    expect(KIE_GROK_RESPONSES_URL).toBe("https://api.kie.ai/grok/v1/responses");
    expect(GROK).toEqual({
      requestModelId: "grok-4-7",
      responseModelSnapshot: "grok-4-7",
      provenance: "DOCUMENTED_UNLISTED_EVALUATION_ONLY",
      endpoint: KIE_GROK_RESPONSES_URL,
      documentationUrl: "https://docs.kie.ai/market/grok/grok-4-7.md",
      documentedAt: "2026-10-06",
      supportedReasoningLevels: ["low", "medium", "high", "xhigh"],
      structuredOutput: "TEXT_FORMAT_JSON_SCHEMA_STRICT",
      unsupportedParameters: [],
    });
    expect(Object.isFrozen(GROK)).toBe(true);
  });

  it("selects grok-4-7 from documentation alone, at the Grok endpoint, with minimum effort low", () => {
    const model = snapshot();
    expect(model).toMatchObject({ requestModelId: "grok-4-7", responseModelSnapshot: "grok-4-7", provenance: "DOCUMENTED_UNLISTED_EVALUATION_ONLY", endpoint: KIE_GROK_RESPONSES_URL });
    expect(minimumReasoningEffort(model)).toBe("low");
  });

  it.each(["deepseek-v4-1-flash", "kimi-k3"])("refuses the excluded model %s even when it is listed", (id) => {
    expect(KIE_EXCLUDED_EVALUATION_MODELS).toContain(id);
    const listed: KieModelSnapshot = { ...snapshot(), requestModelId: id, responseModelSnapshot: id, provenance: "LISTED", endpoint: KIE_RESPONSES_URL };
    expect(selectEvaluationCandidates({ requested: id, listing: [listed], now: () => "x" })).toEqual({ kind: "REJECTED", reason: "EXCLUDED_MODEL" });
  });
});

describe("request mapping: exact endpoint, model, non-streaming, strict schema", () => {
  it.each([["EXPLAIN_PATTERN", "en-SG"], ["EXPLAIN_PATTERN", "zh-SG"], ["DRAFT_CARE_PREPARATION_SUMMARY", "en-SG"], ["DRAFT_CARE_PREPARATION_SUMMARY", "zh-SG"]] as const)("%s %s posts the documented Grok request", async (task, locale) => {
    const fetcher = reply(grokResponse(JSON.stringify(envelope(task)), OBSERVED));
    const input = payload(task, locale);
    await call(fetcher, snapshot(), input);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://api.kie.ai/grok/v1/responses");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    const body = sentBody(fetcher);
    expect(Object.keys(body)).toEqual(["model", "stream", "store", "input", "reasoning", "text"]);
    expect(body.model).toBe("grok-4-7");
    expect(body.stream).toBe(false);
    expect(body.store).toBe(false);
    expect(body.reasoning).toEqual({ effort: "low" });
    expect(body.text).toEqual({ format: { type: "json_schema", name: providerOutputSchemaName(task, locale), schema: providerOutputJsonSchema(task, locale), strict: true } });
    expect(body).not.toHaveProperty("instructions");
    expect(body).not.toHaveProperty("tools");
  });

  it("never sends the credential or a request to an endpoint outside the allowlist", async () => {
    const fetcher = reply(grokResponse(JSON.stringify(envelope()), OBSERVED));
    const { result, diagnostic } = await call(fetcher, snapshot({ endpoint: "https://example.com/grok/v1/responses" }));
    expect(result).toEqual({ kind: "FAILED", reason: "MISSING_CONFIGURATION" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(diagnostic).toBeNull();
  });

  it("keeps the existing instructions-field layout for the OpenAI-protocol endpoint", async () => {
    const fetcher = reply(grokResponse(JSON.stringify(envelope()), { model: "gpt-5.4", store: false }));
    await call(fetcher, { ...snapshot(), requestModelId: "gpt-5.4", responseModelSnapshot: "gpt-5.4", provenance: "LISTED", endpoint: KIE_RESPONSES_URL, supportedReasoningLevels: ["low", "medium"] });
    const body = sentBody(fetcher);
    expect(fetcher.mock.calls[0]![0]).toBe(KIE_RESPONSES_URL);
    expect(Object.keys(body)).toEqual(["model", "stream", "store", "instructions", "input", "reasoning", "text"]);
    expect(body.input).toHaveLength(1);
  });
});

describe("prompt/data separation (no instructions field is documented for Grok)", () => {
  it.each([["EXPLAIN_PATTERN", "en-SG"], ["DRAFT_CARE_PREPARATION_SUMMARY", "zh-SG"]] as const)("%s %s: static instructions and the synthetic JSON travel as two separate user messages", async (task, locale) => {
    const fetcher = reply(grokResponse(JSON.stringify(envelope(task)), OBSERVED));
    const input = payload(task, locale);
    await call(fetcher, snapshot(), input);
    const messages = sentBody(fetcher).input as Array<{ role: string; content: Array<{ type: string; text: string }> }>;
    expect(messages).toHaveLength(2);
    expect(messages.map((message) => message.role)).toEqual(["user", "user"]);
    for (const message of messages) expect(message.content).toHaveLength(1);
    expect(messages[0]!.content[0]).toEqual({ type: "input_text", text: promptFor(task, locale)!.text });
    expect(messages[1]!.content[0]).toEqual({ type: "input_text", text: JSON.stringify(input) });
  });

  it("never merges data into the instruction message", async () => {
    const fetcher = reply(grokResponse(JSON.stringify(envelope("DRAFT_CARE_PREPARATION_SUMMARY")), OBSERVED));
    const input = payload("DRAFT_CARE_PREPARATION_SUMMARY");
    await call(fetcher, snapshot(), input);
    const [instructions, data] = sentBody(fetcher).input as Array<{ content: Array<{ text: string }> }>;
    const question = (input.facts as Array<{ value: { kind: string; text?: string } }>).find((fact) => fact.value.kind === "TEXT")!.value.text!;
    expect(data!.content[0]!.text).toContain(question);
    expect(instructions!.content[0]!.text).not.toContain(question);
    expect(instructions!.content[0]!.text).not.toContain("fact-1");
    expect(instructions!.content[0]!.text).not.toContain("{");
  });
});

describe("response parsing: identity and retention are observed, never inferred", () => {
  it("accepts the documented envelope only when it carries the exact model and boolean store:false", async () => {
    const { result, diagnostic } = await call(reply(grokResponse(JSON.stringify(envelope()), OBSERVED)));
    expect(result).toMatchObject({ kind: "COMPLETED", responseModel: "grok-4-7", retention: "CONFIRMED_NOT_STORED", usage: { inputTokens: 1000, outputTokens: 300, credits: 0.31 } });
    expect(diagnostic).toMatchObject({ code: "COMPLETED", modelIdentity: { requested: "grok-4-7", expected: "grok-4-7", returned: "grok-4-7", comparison: "IDENTICAL" }, retention: "CONFIRMED_NOT_STORED" });
  });

  it("fails a response with no model identifier (the documented example's shape)", async () => {
    const { result, diagnostic } = await call(reply(grokResponse(JSON.stringify(envelope()), { store: false })));
    expect(result).toEqual({ kind: "FAILED", reason: "PROVIDER_FAILED" });
    expect(diagnostic).toMatchObject({ code: "RESPONSE_MODEL_MISSING", parserStage: "MODEL", modelIdentity: { returned: null, comparison: "MISSING" } });
  });

  it("fails a different or dated model identifier and records it only as evidence", async () => {
    const { result, diagnostic } = await call(reply(grokResponse(JSON.stringify(envelope()), { model: "grok-4-7-0901", store: false })));
    expect(result).toEqual({ kind: "FAILED", reason: "PROVIDER_FAILED" });
    expect(diagnostic).toMatchObject({ code: "RESPONSE_MODEL_MISMATCH", modelIdentity: { expected: "grok-4-7", returned: "grok-4-7-0901", comparison: "VERSION_SUFFIXED" } });
  });

  it.each([["missing", {}], ["null", { store: null }], ["the string \"false\"", { store: "false" }], ["0", { store: 0 }], ["an object", { store: { value: false } }]] as const)("store %s is RETENTION_UNCONFIRMED, never confirmed", async (_label, store) => {
    const { result, diagnostic } = await call(reply(grokResponse(JSON.stringify(envelope()), { model: "grok-4-7", ...store })));
    expect(result).toMatchObject({ kind: "COMPLETED", retention: "RETENTION_UNCONFIRMED" });
    expect(diagnostic?.retention).toBe("RETENTION_UNCONFIRMED");
  });

  it("rejects store:true whatever else the response contains", async () => {
    const { result, diagnostic } = await call(reply(grokResponse(JSON.stringify(envelope()), { model: "grok-4-7", store: true })));
    expect(result).toEqual({ kind: "FAILED", reason: "PROVIDER_FAILED" });
    expect(diagnostic).toMatchObject({ code: "RESPONSE_STORED", retention: "PROVIDER_REPORTED_STORED" });
  });

  it("refuses a streamed (event-stream) answer: the request is non-streaming", async () => {
    const { result, diagnostic } = await call(reply("event: response.output_text.delta\ndata: {}\n\n", "text/event-stream"));
    expect(result).toEqual({ kind: "FAILED", reason: "PROVIDER_FAILED" });
    expect(diagnostic).toMatchObject({ code: "CONTENT_TYPE_EVENT_STREAM" });
  });

  it("parses the documented output list into the single structured candidate", async () => {
    const { result } = await call(reply(grokResponse(JSON.stringify(envelope()), OBSERVED)));
    expect(result.kind === "COMPLETED" && result.candidate).toEqual(outputFixture("EXPLAIN_PATTERN"));
  });
});

describe("timeout, credits and secret isolation", () => {
  it("an aborted call (production timeout) is a redacted REQUEST_TIMEOUT transport failure", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      controller.abort();
      throw (init.signal as AbortSignal).reason ?? new Error("aborted");
    });
    const { result, diagnostic } = await call(fetcher, snapshot(), payload("EXPLAIN_PATTERN"), controller.signal);
    expect(result).toEqual({ kind: "FAILED", reason: "TRANSPORT_FAILED" });
    expect(diagnostic).toMatchObject({ code: "REQUEST_TIMEOUT", parserStage: "TRANSPORT" });
  });

  it("reports provider credits so the evaluation ceiling can stop the run", async () => {
    const { result } = await call(reply(grokResponse(JSON.stringify(envelope()), { ...OBSERVED, credits_consumed: 0.62 })));
    expect(result.kind === "COMPLETED" && result.usage.credits).toBe(0.62);
  });

  it("never places the credential in a result or diagnostic", async () => {
    for (const body of [grokResponse(JSON.stringify(envelope()), OBSERVED), grokResponse(JSON.stringify(envelope()), { store: false }), { error: { message: TOKEN } }]) {
      const outcome = await call(reply(body));
      expect(JSON.stringify(outcome)).not.toContain(TOKEN);
    }
  });
});

describe("contract and production", () => {
  it("Grok 4.7 is no longer the approved candidate (unsuitable at 10 s); the Kie DeepSeek pair stays rejected", () => {
    expect(KIE_ROUTE_VERSION).toBe("packet11-responses.11b.6");
    expect(APPROVED_SMOKE_CONTRACT).toMatchObject({ requestModelId: "deepseek-flash", responseModelSnapshot: "deepseek-flash", routeVersion: "packet11-responses.11b.6" });
    expect(contractMismatches(snapshot())).toEqual(["requestModelId", "responseModelSnapshot"]);
    expect(contractMismatches({ requestModelId: "deepseek-v4-1-flash", responseModelSnapshot: "deepseek-v4-1-flash-260910" })).toEqual(["requestModelId", "responseModelSnapshot"]);
  });

  it("keeps production deterministic-only: no bundle pins a model and the product route is unconfigured", () => {
    for (const bundle of Object.values(AI_TASK_RUNTIME_BUNDLES)) {
      expect(bundle.modelSnapshot).toBeNull();
      expect(bundle.routeProfile).toBe("deterministic-only.11a.1");
      expect(resolveProductKieRoute(bundle, { KIE_API_KEY: TOKEN })).toEqual({ kind: "MISSING_CONFIGURATION" });
    }
  });
});
