// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { providerTaskRequestSchema, type ProviderTaskRequest } from "@/domain/ai";
import { outputFixture, requestFixture } from "@/domain/ai/ai-test-fixtures";
import { projectProviderTaskPayload } from "@/application/ai/detached-payload-projector";
import { AI_TASK_RUNTIME_BUNDLES } from "@/application/ai/ai-runtime-bundles";
import { validateAiTaskOutput } from "@/application/ai/ai-output-validator";
import { promptFor } from "@/ai/prompts/packet-11-prompts";
import { KIE_RESPONSES_URL, type KieModelSnapshot } from "./kie-model-catalogue";
import { KIE_MAX_RESPONSE_BYTES, providerOutputJsonSchema } from "./kie-responses-contracts";
import { classifyKieRetention, createKieResponsesProvider, KIE_RETENTION_RESULTS, type KieProviderDiagnostic } from "./kie-responses-provider";

/** Packet 11B Task 2: the native-fetch Kie Responses adapter against a fake fetch. No live call. */

const TOKEN = "sentinel-token-do-not-leak";
const MODEL: KieModelSnapshot = {
  requestModelId: "deepseek-v4-1-flash",
  responseModelSnapshot: "deepseek-v4-1-flash-260910",
  provenance: "DOCUMENTED_UNLISTED_EVALUATION_ONLY",
  endpoint: KIE_RESPONSES_URL,
  contextWindow: null,
  defaultReasoningLevel: null,
  supportedReasoningLevels: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
  retrievedAt: "2026-10-05T01:00:00.000Z",
  documentationUrl: "https://docs.kie.ai/market/deepseek-v4-1-flash.md",
};

function payload(taskType: "EXPLAIN_PATTERN" | "DRAFT_CARE_PREPARATION_SUMMARY" = "EXPLAIN_PATTERN"): ProviderTaskRequest {
  const request = requestFixture(taskType);
  const projected = projectProviderTaskPayload(request, AI_TASK_RUNTIME_BUNDLES[taskType]);
  if (projected.kind !== "PROJECTED") throw new Error(projected.reason);
  return projected.payload;
}

/** The provider-facing envelope: a single root object with explicit nulls. */
const providerEnvelope = (taskType: "EXPLAIN_PATTERN" | "DRAFT_CARE_PREPARATION_SUMMARY" = "EXPLAIN_PATTERN") => ({ ...outputFixture(taskType), abstentionReason: null });
const completed = (text: string, extra: Record<string, unknown> = {}) => ({
  id: "resp_x",
  object: "response",
  created_at: 1790128600,
  model: MODEL.responseModelSnapshot,
  status: "completed",
  output: [
    { type: "reasoning", id: "rs_x", status: "completed", summary: [] },
    { type: "message", id: "msg_x", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] },
  ],
  usage: { input_tokens: 812, input_tokens_details: { cached_tokens: 0 }, output_tokens: 140, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 952 },
  credits_consumed: 0.02,
  ...extra,
});
const reply = (body: unknown, status = 200) => vi.fn(async (_url: string, _init: RequestInit) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
const provider = (fetcher: ReturnType<typeof reply> | ((url: string, init: RequestInit) => Promise<Response>)) => createKieResponsesProvider({ token: TOKEN, model: MODEL, fetcher });
const invoke = (fetcher: Parameters<typeof provider>[0], input = payload(), signal = new AbortController().signal) => provider(fetcher).invoke(input, signal);

afterEach(() => vi.restoreAllMocks());

describe("Kie Responses request", () => {
  it("posts exactly the documented non-streaming, strict-schema, tool-free request", async () => {
    const fetcher = reply(completed(JSON.stringify(providerEnvelope())));
    await invoke(fetcher);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(KIE_RESPONSES_URL);
    expect(init.method).toBe("POST");
    expect(init.cache).toBe("no-store");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.has("apikey")).toBe(false);
    const body = JSON.parse(init.body as string);
    expect(Object.keys(body).sort()).toEqual(["input", "instructions", "model", "reasoning", "store", "stream", "text"]);
    expect(body).toMatchObject({ model: "deepseek-v4-1-flash", stream: false, store: false, reasoning: { effort: "none" } });
    expect(body.instructions).toBe(promptFor("EXPLAIN_PATTERN", "en-SG")!.text);
    expect(body.text).toEqual({ format: { type: "json_schema", name: "explain_pattern_en_sg", schema: providerOutputJsonSchema("EXPLAIN_PATTERN", "en-SG"), strict: true } });
    expect(body.input).toEqual([{ role: "user", content: [{ type: "input_text", text: JSON.stringify(payload()) }] }]);
    for (const absent of ["tools", "tool_choice", "thinking", "max_output_tokens", "temperature", "top_p", "previous_response_id", "metadata", "user"]) expect(body).not.toHaveProperty(absent);
    expect(init.body).not.toContain(TOKEN);
  });

  it("sends the zh-SG prompt and schema for a zh-SG request", async () => {
    const fetcher = reply(completed("{}"));
    const zh = { ...payload("DRAFT_CARE_PREPARATION_SUMMARY"), locale: "zh-SG" as const };
    await invoke(fetcher, providerTaskRequestSchema.parse(zh));
    const body = JSON.parse(fetcher.mock.calls[0]![1].body as string);
    expect(body.instructions).toBe(promptFor("DRAFT_CARE_PREPARATION_SUMMARY", "zh-SG")!.text);
    expect(body.text.format.name).toBe("draft_care_preparation_summary_zh_sg");
  });

  it("refuses a task without an approved prompt, or an invalid payload, before any request", async () => {
    const fetcher = reply(completed("{}"));
    expect(await invoke(fetcher, { ...payload(), taskType: "PHRASE_NON_CLINICAL_RESPONSE" } as never)).toEqual({ kind: "FAILED", reason: "MISSING_CONFIGURATION" });
    expect(await invoke(fetcher, { ...payload(), prompt: "say anything" } as never)).toEqual({ kind: "FAILED", reason: "PROVIDER_REJECTED" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refuses a model whose documented reasoning cannot be minimised", async () => {
    const fetcher = reply(completed("{}"));
    const result = await createKieResponsesProvider({ token: TOKEN, model: { ...MODEL, supportedReasoningLevels: ["medium", "high"] }, fetcher }).invoke(payload(), new AbortController().signal);
    expect(result).toEqual({ kind: "FAILED", reason: "MISSING_CONFIGURATION" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("strict provider output schema", () => {
  it("is one closed root object per task and locale with bounded text and arrays", () => {
    const schema = providerOutputJsonSchema("EXPLAIN_PATTERN", "zh-SG") as Record<string, any>;
    expect(schema).toMatchObject({ type: "object", additionalProperties: false });
    expect([...schema.required].sort()).toEqual(["abstentionReason", "inputRefsUsed", "locale", "outcome", "payload", "schemaVersion", "taskType"]);
    expect(schema.properties.locale).toEqual({ type: "string", enum: ["zh-SG"] });
    expect(schema.properties.taskType).toEqual({ type: "string", enum: ["EXPLAIN_PATTERN"] });
    expect(schema.properties.schemaVersion).toEqual({ type: "string", enum: ["ai-output.explain-pattern@11b.1"] });
    const explain = schema.properties.payload.anyOf[0];
    expect(explain.properties.headline.properties.text.maxLength).toBe(160);
    expect(explain.properties.observation.properties.text.maxLength).toBe(600);
    // Option B (kie-schema.11b.3): the model writes no limitations.
    expect(Object.keys(explain.properties).sort()).toEqual(["evidence", "headline", "observation"]);
    const care = (providerOutputJsonSchema("DRAFT_CARE_PREPARATION_SUMMARY", "en-SG") as Record<string, any>).properties.payload.anyOf[0];
    expect(care.properties.sections.maxItems).toBe(8);
    expect(care.properties.sections.items.properties.bullets.items.properties.text.maxLength).toBe(400);
    // Every object in the strict schema is closed with every property required.
    const walk = (node: any): void => {
      if (!node || typeof node !== "object") return;
      if (node.type === "object") {
        expect(node.additionalProperties).toBe(false);
        expect([...node.required].sort()).toEqual(Object.keys(node.properties).sort());
      }
      Object.values(node).forEach(walk);
    };
    walk(schema);
    walk(providerOutputJsonSchema("DRAFT_CARE_PREPARATION_SUMMARY", "zh-SG"));
  });
});

describe("Kie Responses result", () => {
  it("returns the untrusted candidate, normalised to the 11A envelope, with bounded usage and credits", async () => {
    const result = await invoke(reply(completed(JSON.stringify(providerEnvelope()))));
    expect(result).toEqual({ kind: "COMPLETED", candidate: outputFixture("EXPLAIN_PATTERN"), usage: { inputTokens: 812, outputTokens: 140, costMicroUsd: null, credits: 0.02 }, responseModel: "deepseek-v4-1-flash-260910", retention: "RETENTION_UNCONFIRMED" });
    // The adapter does not accept: the 11A validator decides.
    if (result.kind !== "COMPLETED") throw new Error("completed");
    const request = { ...requestFixture("EXPLAIN_PATTERN") };
    expect(validateAiTaskOutput(request, AI_TASK_RUNTIME_BUNDLES.EXPLAIN_PATTERN, result.candidate).kind).toBe("ACCEPTED");
  });

  it("normalises an abstention by dropping only the null payload", async () => {
    const abstain = { ...outputFixture("EXPLAIN_PATTERN"), outcome: "ABSTAIN", payload: null, abstentionReason: "INSUFFICIENT_CONTEXT" };
    const result = await invoke(reply(completed(JSON.stringify(abstain))));
    expect(result).toMatchObject({ kind: "COMPLETED", candidate: { outcome: "ABSTAIN", abstentionReason: "INSUFFICIENT_CONTEXT" } });
    expect((result as { candidate: object }).candidate).not.toHaveProperty("payload");
  });

  it("passes malformed or duplicate-key output text through unparsed for the validator to reject", async () => {
    for (const text of ["{not json", '{"outcome":"SUCCESS","outcome":"ABSTAIN"}']) {
      const result = await invoke(reply(completed(text)));
      expect(result).toMatchObject({ kind: "COMPLETED", candidate: text });
    }
  });

  it.each([
    [400, "PROVIDER_REJECTED"],
    [401, "MISSING_CONFIGURATION"],
    [403, "MISSING_CONFIGURATION"],
    [402, "OPERATIONAL_SPEND_LOCKED"],
    [404, "PROVIDER_REJECTED"],
    [408, "PROVIDER_TIMEOUT"],
    [429, "PROVIDER_RATE_LIMITED"],
    [500, "PROVIDER_FAILED"],
    [503, "PROVIDER_FAILED"],
    [504, "PROVIDER_TIMEOUT"],
  ])("maps HTTP %s to %s", async (status, reason) => {
    expect(await invoke(reply({ error: { message: `details ${TOKEN}`, type: "x" } }, status))).toEqual({ kind: "FAILED", reason });
  });

  it.each([
    ["error object", { error: { message: "bad", type: "invalid_request_error" } }, "PROVIDER_FAILED"],
    ["pre-check failure", { code: 500, msg: "busy", data: null }, "PROVIDER_FAILED"],
    ["insufficient credits", { code: 402, msg: "Credits insufficient", data: null }, "OPERATIONAL_SPEND_LOCKED"],
    ["rate limited", { code: 429, msg: "slow down", data: null }, "PROVIDER_RATE_LIMITED"],
    ["incomplete", completed("{}", { status: "incomplete" }), "PROVIDER_FAILED"],
    ["no message", completed("{}", { output: [{ type: "reasoning", id: "r", summary: [] }] }), "PROVIDER_FAILED"],
    ["two messages", completed("{}", { output: [completed("{}").output[1], completed("{}").output[1]] }), "PROVIDER_FAILED"],
    ["two text parts", completed("{}", { output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "{}" }, { type: "output_text", text: "{}" }] }] }), "PROVIDER_FAILED"],
    ["refusal part", completed("{}", { output: [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "no" }] }] }), "PROVIDER_FAILED"],
    ["tool call", completed("{}", { output: [{ type: "function_call", name: "x", arguments: "{}" }, completed("{}").output[1]] }), "PROVIDER_FAILED"],
    ["substituted model", completed("{}", { model: "deepseek-v4-flash" }), "PROVIDER_FAILED"],
    ["missing usage", { ...completed("{}"), usage: undefined }, "PROVIDER_FAILED"],
    ["negative credits", completed("{}", { credits_consumed: -1 }), "PROVIDER_FAILED"],
  ])("treats an HTTP-200 %s as a failure, never a success", async (_label, body, reason) => {
    expect(await invoke(reply(body))).toEqual({ kind: "FAILED", reason });
  });

  it("rejects a non-JSON or oversized response body without buffering it all", async () => {
    expect(await invoke(reply("<html>busy</html>"))).toEqual({ kind: "FAILED", reason: "PROVIDER_FAILED" });
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(64 * 1024).fill(32));
      },
    });
    const result = await invoke(async () => new Response(endless, { status: 200 }));
    expect(result).toEqual({ kind: "FAILED", reason: "PROVIDER_FAILED" });
    expect(pulled * 64 * 1024).toBeLessThanOrEqual(KIE_MAX_RESPONSE_BYTES + 2 * 64 * 1024);
  });

  it("passes the abort signal to fetch and reports an aborted call as a transport failure", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const pending = invoke(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          seen = init.signal ?? undefined;
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
      payload(),
      controller.signal,
    );
    controller.abort();
    expect(await pending).toEqual({ kind: "FAILED", reason: "TRANSPORT_FAILED" });
    expect(seen?.aborted).toBe(true);
  });

  it("writes nothing to the console and never returns the token", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
    const results = [
      await invoke(reply(completed(JSON.stringify(providerEnvelope())))),
      await invoke(reply({ error: { message: TOKEN } }, 500)),
      await invoke(async () => Promise.reject(new Error(TOKEN))),
    ];
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(JSON.stringify(results)).not.toContain(TOKEN);
  });
});

describe("redacted provider diagnostics (evaluation-only)", () => {
  type Diagnostic = import("./kie-responses-provider").KieProviderDiagnostic;
  const SECRETS = [TOKEN, "upstream detail", "wording component", "kaya", "Recent recorded", "6.2", "7.1", "SENTINEL-OUT"];
  const json = (body: unknown, status = 200, contentType = "application/json") => async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: contentType ? { "content-type": contentType } : {} });

  async function diagnose(fetcher: (url: string, init: RequestInit) => Promise<Response>, signal = new AbortController().signal) {
    const seen: Diagnostic[] = [];
    const result = await createKieResponsesProvider({ token: TOKEN, model: MODEL, fetcher, onDiagnostic: (diagnostic) => seen.push(diagnostic) }).invoke(payload(), signal);
    expect(seen).toHaveLength(1);
    const text = JSON.stringify(seen[0]);
    for (const secret of SECRETS) expect(text, secret).not.toContain(secret);
    // The application-facing result never carries the diagnostic.
    expect(Object.keys(result).sort()).toEqual(result.kind === "FAILED" ? ["kind", "reason"] : ["candidate", "kind", "responseModel", "retention", "usage"]);
    return { result, diagnostic: seen[0]! };
  }

  const okBody = (extra: Record<string, unknown> = {}) => completed(JSON.stringify({ ...providerEnvelope(), abstentionReason: null, note: "SENTINEL-OUT" }), extra);

  it.each([
    ["transport failure", async () => Promise.reject(new Error(`network ${TOKEN}`)), { code: "TRANSPORT_FAILED", httpStatus: null, contentTypeClass: null, parserStage: "TRANSPORT" }, "TRANSPORT_FAILED"],
    ["HTTP 4xx with an error body", json({ error: { message: `upstream detail ${TOKEN}`, type: "invalid_request_error" } }, 400), { code: "HTTP_4XX", httpStatus: 400, contentTypeClass: "JSON", topLevelKeys: ["error"], bodyValidJson: true, parserStage: "HTTP_STATUS" }, "PROVIDER_REJECTED"],
    ["HTTP 5xx with text", json(`upstream detail ${TOKEN}`, 503, "text/plain"), { code: "HTTP_5XX", httpStatus: 503, contentTypeClass: "TEXT", topLevelKeys: null, bodyValidJson: false, parserStage: "HTTP_STATUS" }, "PROVIDER_FAILED"],
    ["an event stream", json('event: response.created\ndata: {"output":"Recent recorded 6.2"}\n\n', 200, "text/event-stream; charset=utf-8"), { code: "CONTENT_TYPE_EVENT_STREAM", httpStatus: 200, contentTypeClass: "EVENT_STREAM", bodyValidJson: false, parserStage: "JSON_PARSE" }, "PROVIDER_FAILED"],
    ["a missing body", async () => new Response(null, { status: 200 }), { code: "BODY_MISSING", httpStatus: 200, contentTypeClass: "MISSING", parserStage: "BODY_READ" }, "PROVIDER_FAILED"],
    ["invalid UTF-8", async () => new Response(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]), { status: 200, headers: { "content-type": "application/json" } }), { code: "BODY_NOT_UTF8", parserStage: "BODY_READ" }, "PROVIDER_FAILED"],
    ["non-JSON text", json("<html>upstream detail</html>", 200, "text/html"), { code: "BODY_NOT_JSON", contentTypeClass: "OTHER", bodyValidJson: false, parserStage: "JSON_PARSE" }, "PROVIDER_FAILED"],
    ["an HTTP-200 error object", json({ error: { message: "upstream detail" } }), { code: "ERROR_ENVELOPE", topLevelKeys: ["error"], bodyValidJson: true, documentedSchemaParsed: false, parserStage: "ERROR_ENVELOPE" }, "PROVIDER_FAILED"],
    ["an HTTP-200 code/msg envelope", json({ code: 500, msg: "upstream detail", data: null }), { code: "ERROR_ENVELOPE", topLevelKeys: ["code", "data", "msg"], parserStage: "ERROR_ENVELOPE" }, "PROVIDER_FAILED"],
    ["an unknown envelope", json({ result: { text: "Recent recorded 6.2" } }), { code: "UNKNOWN_PROVIDER_ENVELOPE", topLevelKeys: ["result"], documentedSchemaParsed: false, parserStage: "RESPONSE_SCHEMA" }, "PROVIDER_FAILED"],
    ["a JSON array", json(["Recent recorded 6.2"]), { code: "UNKNOWN_PROVIDER_ENVELOPE", topLevelKeys: null, bodyValidJson: true, parserStage: "RESPONSE_SCHEMA" }, "PROVIDER_FAILED"],
    ["an incomplete status", json(okBody({ status: "incomplete" })), { code: "STATUS_NOT_COMPLETED", documentedSchemaParsed: true, parserStage: "STATUS" }, "PROVIDER_FAILED"],
    ["a substituted model", json(okBody({ model: "deepseek-v4-flash" })), { code: "RESPONSE_MODEL_MISMATCH", parserStage: "MODEL" }, "PROVIDER_FAILED"],
    ["a non-message output item", json(okBody({ output: [{ type: "function_call", name: "x", arguments: "{}" }] })), { code: "OUTPUT_SHAPE_INVALID", parserStage: "OUTPUT" }, "PROVIDER_FAILED"],
    ["two messages", json(okBody({ output: [completed("{}").output[1], completed("{}").output[1]] })), { code: "OUTPUT_SHAPE_INVALID", parserStage: "OUTPUT" }, "PROVIDER_FAILED"],
    ["no output text", json(okBody({ output: [{ type: "reasoning", id: "r", summary: [] }] })), { code: "OUTPUT_TEXT_MISSING", parserStage: "OUTPUT" }, "PROVIDER_FAILED"],
    ["a non-array output", json(okBody({ output: "Recent recorded 6.2" })), { code: "OUTPUT_SHAPE_INVALID", documentedSchemaParsed: false, parserStage: "RESPONSE_SCHEMA" }, "PROVIDER_FAILED"],
    ["missing usage", json({ ...okBody(), usage: undefined }), { code: "USAGE_MISSING_OR_INVALID", documentedSchemaParsed: false, parserStage: "RESPONSE_SCHEMA" }, "PROVIDER_FAILED"],
    ["invalid credits", json(okBody({ credits_consumed: -1 })), { code: "CREDITS_INVALID", documentedSchemaParsed: false, parserStage: "RESPONSE_SCHEMA" }, "PROVIDER_FAILED"],
  ] as const)("classifies %s without leaking", async (_label, fetcher, expected, reason) => {
    const { result, diagnostic } = await diagnose(fetcher as never);
    expect(result).toEqual({ kind: "FAILED", reason });
    expect(diagnostic).toMatchObject(expected);
  });

  it("classifies an aborted call as a request timeout", async () => {
    const controller = new AbortController();
    const pending = diagnose((_url, init) => new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))), controller.signal);
    controller.abort();
    expect((await pending).diagnostic).toMatchObject({ code: "REQUEST_TIMEOUT", parserStage: "TRANSPORT" });
  });

  it("classifies an oversized body", async () => {
    const endless = new ReadableStream<Uint8Array>({ pull: (controller) => controller.enqueue(new Uint8Array(64 * 1024).fill(32)) });
    expect((await diagnose(async () => new Response(endless, { status: 200, headers: { "content-type": "application/json" } }))).diagnostic).toMatchObject({ code: "BODY_OVERSIZED", parserStage: "BODY_READ" });
  });

  it("records a completed call, including a missing model identifier, without changing the result", async () => {
    const ok = await diagnose(json(okBody()));
    expect(ok.result.kind).toBe("COMPLETED");
    expect(ok.diagnostic).toEqual({
      code: "COMPLETED",
      httpStatus: 200,
      contentTypeClass: "JSON",
      topLevelKeys: ["created_at", "credits_consumed", "id", "model", "object", "output", "status", "usage"],
      bodyValidJson: true,
      documentedSchemaParsed: true,
      parserStage: "COMPLETE",
      modelIdentity: { requested: "deepseek-v4-1-flash", expected: "deepseek-v4-1-flash-260910", returned: "deepseek-v4-1-flash-260910", comparison: "IDENTICAL" },
      envelopeOtherwiseValid: true,
      mismatchUsage: null,
      reportedUsage: { inputTokens: 812, outputTokens: 140, reasoningTokens: 0, credits: 0.02 },
      retention: "RETENTION_UNCONFIRMED",
    });
    // Exact pinning: a response without the expected snapshot is never accepted.
    const missing = await diagnose(json({ ...okBody(), model: undefined }));
    expect(missing.result).toEqual({ kind: "FAILED", reason: "PROVIDER_FAILED" });
    expect(missing.diagnostic).toMatchObject({ code: "RESPONSE_MODEL_MISSING", parserStage: "MODEL" });
  });

  it("never reports a non-identifier property name, which could carry a value", async () => {
    const { diagnostic } = await diagnose(json({ "Recent recorded 6.2 mmol/L": 1, error: "x" }));
    expect(diagnostic.topLevelKeys).toEqual(["<non-identifier>", "error"]);
  });
});

describe("evaluation-only model-identity diagnostic", () => {
  type Diagnostic = import("./kie-responses-provider").KieProviderDiagnostic;
  const OUTPUT_SENTINEL = "SENTINEL-GENERATED-OUTPUT";
  const SUMMARY_SENTINEL = "SENTINEL-REASONING-SUMMARY";
  const REQUESTED = "deepseek-v4-1-flash";
  const EXPECTED = "deepseek-v4-1-flash-260910";
  const respond = (model: unknown, extra: Record<string, unknown> = {}) => async () =>
    new Response(
      JSON.stringify({
        ...completed(JSON.stringify({ ...providerEnvelope(), note: OUTPUT_SENTINEL })),
        output: [
          { type: "reasoning", id: "rs_x", summary: [{ type: "summary_text", text: SUMMARY_SENTINEL }] },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify({ ...providerEnvelope(), note: OUTPUT_SENTINEL }), annotations: [{ type: "x", text: OUTPUT_SENTINEL }] }] },
        ],
        usage: { input_tokens: 812, output_tokens: 140, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 952 },
        credits_consumed: 0.03,
        model,
        ...extra,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  async function identify(model: unknown, extra: Record<string, unknown> = {}) {
    const seen: Diagnostic[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
    const result = await createKieResponsesProvider({ token: TOKEN, model: MODEL, fetcher: respond(model, extra), onDiagnostic: (diagnostic) => seen.push(diagnostic) }).invoke(payload(), new AbortController().signal);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    const text = JSON.stringify(seen);
    for (const secret of [TOKEN, OUTPUT_SENTINEL, SUMMARY_SENTINEL, "wording component", "Recent recorded", "6.2"]) expect(text, secret).not.toContain(secret);
    return { result, diagnostic: seen[0]! };
  }

  it("classifies the exact expected snapshot as identical and keeps the normal completed result", async () => {
    const { result, diagnostic } = await identify(EXPECTED);
    expect(result.kind).toBe("COMPLETED");
    expect(diagnostic).toMatchObject({ code: "COMPLETED", modelIdentity: { requested: REQUESTED, expected: EXPECTED, returned: EXPECTED, comparison: "IDENTICAL" } });
  });

  it.each([
    [REQUESTED, "OTHER_SAFE_IDENTIFIER"],
    ["deepseek/deepseek-v4-1-flash-260910", "NAMESPACE_PREFIXED"],
    ["deepseek-v4-1-flash-260910-2", "VERSION_SUFFIXED"],
    ["deepseek-v4-1-flash-260910:2", "VERSION_SUFFIXED"],
    ["deepseek/deepseek-v4-1-flash-260910-2", "NAMESPACE_PREFIXED_AND_VERSIONED"],
    ["deepseek-v4-1-flash-260911", "OTHER_SAFE_IDENTIFIER"],
    ["deepseek-v4-1-flash-261010", "OTHER_SAFE_IDENTIFIER"],
    ["deepseek-v4-1-flash-26091", "OTHER_SAFE_IDENTIFIER"],
    ["DeepSeek-V4-1-Flash-260910", "OTHER_SAFE_IDENTIFIER"],
    ["deepseek-v4-flash", "OTHER_SAFE_IDENTIFIER"],
    ["mydeepseek-v4-1-flash-260910", "OTHER_SAFE_IDENTIFIER"],
  ])("keeps %s distinct as %s, records it exactly and still fails the call", async (model, comparison) => {
    const { result, diagnostic } = await identify(model);
    expect(result).toEqual({ kind: "FAILED", reason: "PROVIDER_FAILED" });
    expect(diagnostic).toMatchObject({ code: "RESPONSE_MODEL_MISMATCH", parserStage: "MODEL", modelIdentity: { requested: REQUESTED, expected: EXPECTED, returned: model, comparison } });
  });

  it("retains numeric usage only for an otherwise-valid completed response rejected for model mismatch", async () => {
    const { diagnostic } = await identify(REQUESTED);
    expect(diagnostic).toMatchObject({ envelopeOtherwiseValid: true, mismatchUsage: { inputTokens: 812, outputTokens: 140, reasoningTokens: 0, credits: 0.03 } });
    const broken = await identify(REQUESTED, { output: [{ type: "function_call", name: "x" }] });
    expect(broken.diagnostic).toMatchObject({ envelopeOtherwiseValid: false, mismatchUsage: null });
    const incomplete = await identify(REQUESTED, { status: "incomplete" });
    expect(incomplete.diagnostic).toMatchObject({ code: "STATUS_NOT_COMPLETED", modelIdentity: null, mismatchUsage: null });
    const identical = await identify(EXPECTED);
    expect(identical.diagnostic).toMatchObject({ mismatchUsage: null });
  });

  it.each([
    ["an empty string", ""],
    ["an oversized identifier", `deepseek-${"x".repeat(120)}`],
    ["whitespace", "deepseek v4 1 flash"],
    ["a trailing space", `${EXPECTED} `],
    ["a control character", `${EXPECTED}\u0000`],
    ["a newline", `${EXPECTED}\nX`],
    ["a query string", `${EXPECTED}?key=abc`],
    ["a URL", `https://api.example/${EXPECTED}`],
    ["a credential prefix", "sk-abcdef0123456789abcdef0123456789"],
    ["a bearer-like value", "Bearer-abcdef0123456789"],
    ["an embedded key-like run", "deepseek-0123456789abcdef0123456789abcdef"],
    ["an at-sign", `user@${EXPECTED}`],
  ])("rejects and does not record %s", async (_label, model) => {
    const { result, diagnostic } = await identify(model);
    expect(result).toEqual({ kind: "FAILED", reason: "PROVIDER_FAILED" });
    expect(diagnostic.modelIdentity).toEqual({ requested: REQUESTED, expected: EXPECTED, returned: null, comparison: "INVALID_IDENTIFIER" });
    if (model.length > 0) expect(JSON.stringify(diagnostic)).not.toContain(model);
  });

  it("rejects a missing identifier and reports it as MISSING", async () => {
    const { result, diagnostic } = await identify(undefined);
    expect(result).toEqual({ kind: "FAILED", reason: "PROVIDER_FAILED" });
    expect(diagnostic).toMatchObject({ code: "RESPONSE_MODEL_MISSING", modelIdentity: { requested: REQUESTED, expected: EXPECTED, returned: null, comparison: "MISSING" } });
  });

  it("records no identity when the documented envelope did not parse", async () => {
    const { diagnostic } = await identify(42);
    expect(diagnostic).toMatchObject({ documentedSchemaParsed: false, modelIdentity: null, mismatchUsage: null });
  });
});

describe("exact dual model identity (owner approval 2026-10-05)", () => {
  it("sends the request alias and accepts only the exact expected response snapshot", async () => {
    const fetcher = reply(completed(JSON.stringify(providerEnvelope())));
    const result = await invoke(fetcher);
    expect(JSON.parse(fetcher.mock.calls[0]![1].body as string).model).toBe("deepseek-v4-1-flash");
    expect(result).toMatchObject({ kind: "COMPLETED", responseModel: "deepseek-v4-1-flash-260910" });
  });

  it.each(["deepseek-v4-1-flash", "deepseek-v4-1-flash-260911", "deepseek/deepseek-v4-1-flash-260910", "deepseek-v4-1-flash-26091", "DeepSeek-V4-1-Flash-260910", "deepseek-v4-1-flash-260910 ", "deepseek-v4-1-flash-260910-1"])(
    "rejects %s when deepseek-v4-1-flash-260910 is expected",
    async (model) => {
      expect(await invoke(reply(completed(JSON.stringify(providerEnvelope()), { model })))).toEqual({ kind: "FAILED", reason: "PROVIDER_FAILED" });
    },
  );

  it("names the exact response snapshot, not the request alias, as provider-model evidence", () => {
    expect(provider(reply({})).providerModel).toEqual({ providerKey: "kie", modelSnapshot: "deepseek-v4-1-flash-260910" });
  });
});

describe("reported numeric usage in the evaluation-only diagnostic", () => {
  it("records only provider-reported numbers for a schema-parsed response, and nothing when they are absent", async () => {
    const seen: Array<import("./kie-responses-provider").KieProviderDiagnostic> = [];
    const run = (body: unknown) => createKieResponsesProvider({ token: TOKEN, model: MODEL, fetcher: reply(body), onDiagnostic: (diagnostic) => seen.push(diagnostic) }).invoke(payload(), new AbortController().signal);
    await run(completed(JSON.stringify(providerEnvelope()), { usage: { input_tokens: 10, output_tokens: 20 }, credits_consumed: undefined }));
    expect(seen.at(-1)!.reportedUsage).toEqual({ inputTokens: 10, outputTokens: 20, reasoningTokens: null, credits: null });
    await run({ error: { message: "x" } });
    expect(seen.at(-1)!.reportedUsage).toBeNull();
  });
});

describe("versioned provider schema contract (Packet 11B corrective pass)", () => {
  type Node = Record<string, any>;
  const explain = providerOutputJsonSchema("EXPLAIN_PATTERN", "en-SG") as Node;
  const care = providerOutputJsonSchema("DRAFT_CARE_PREPARATION_SUMMARY", "zh-SG") as Node;
  const explainPayload = explain.properties.payload.anyOf[0];
  const carePayload = care.properties.payload.anyOf[0];
  const careSection = carePayload.properties.sections.items;

  it("is provider schema version kie-schema.11b.3 on route packet11-responses.11b.6", async () => {
    const contracts = await import("./kie-responses-contracts");
    expect(contracts.KIE_PROVIDER_SCHEMA_VERSION).toBe("kie-schema.11b.3");
    const evaluation = await import("@/ai/evaluation/packet-11-evaluation");
    expect(evaluation.KIE_ROUTE_VERSION).toBe("packet11-responses.11b.6");
  });

  it("describes every reference-bearing field", () => {
    for (const node of [explain.properties.inputRefsUsed, explainPayload.properties.headline.properties.claimRefs, explainPayload.properties.observation.properties.claimRefs, explainPayload.properties.evidence.properties.factRefs, care.properties.inputRefsUsed, careSection.properties.sectionRef, careSection.properties.bullets.items.properties.factRefs]) {
      expect(typeof node.description).toBe("string");
      expect(node.description.length).toBeGreaterThan(20);
    }
    expect(explain.properties.inputRefsUsed.description).toMatch(/every reference .* exactly once/i);
  });

  it("adds uniqueItems exactly where the 11A contract already requires uniqueness", () => {
    for (const node of [explain.properties.inputRefsUsed, explainPayload.properties.headline.properties.claimRefs, explainPayload.properties.observation.properties.claimRefs, explainPayload.properties.evidence.properties.factRefs, care.properties.inputRefsUsed, carePayload.properties.sections, careSection.properties.bullets.items.properties.factRefs]) {
      expect(node.uniqueItems).toBe(true);
    }
    // Care-summary bullets are not unique in the 11A contract and stay unconstrained.
    expect(careSection.properties.bullets.uniqueItems).toBeUndefined();
  });

  it("sends the versioned schema in the request", async () => {
    const fetcher = reply(completed(JSON.stringify(providerEnvelope())));
    await invoke(fetcher);
    const body = JSON.parse(fetcher.mock.calls[0]![1].body as string);
    expect(body.text.format.schema.properties.inputRefsUsed.uniqueItems).toBe(true);
  });
});

describe("provider-side retention (store: false; owner instruction 2026-10-05)", () => {
  const bodyOf = (fetcher: ReturnType<typeof reply>) => fetcher.mock.calls[0]![1].body as string;

  it("sends store: false in the exact serialized body, with every other field unchanged", async () => {
    const fetcher = reply(completed(JSON.stringify(providerEnvelope()), { store: false }));
    await invoke(fetcher);
    const serialized = bodyOf(fetcher);
    expect(serialized).toContain('"stream":false,"store":false,');
    expect(JSON.parse(serialized)).toEqual({
      model: "deepseek-v4-1-flash",
      stream: false,
      store: false,
      instructions: promptFor("EXPLAIN_PATTERN", "en-SG")!.text,
      input: [{ role: "user", content: [{ type: "input_text", text: JSON.stringify(payload()) }] }],
      reasoning: { effort: "none" },
      text: { format: { type: "json_schema", name: "explain_pattern_en_sg", schema: providerOutputJsonSchema("EXPLAIN_PATTERN", "en-SG"), strict: true } },
    });
  });

  it("cannot be overridden to true by configuration or by the task payload", async () => {
    const fetcher = reply(completed(JSON.stringify(providerEnvelope()), { store: false }));
    await createKieResponsesProvider({ token: TOKEN, model: MODEL, fetcher, store: true } as never).invoke(payload(), new AbortController().signal);
    expect(JSON.parse(bodyOf(fetcher)).store).toBe(false);
    const smuggled = reply(completed(JSON.stringify(providerEnvelope()), { store: false }));
    await invoke(smuggled, { ...payload(), store: true } as never);
    for (const [, init] of smuggled.mock.calls) expect(JSON.parse(init.body as string).store).toBe(false);
    expect(bodyOf(fetcher)).not.toMatch(/"store":true/);
  });

  it("classifies the returned store property into exactly three closed results", () => {
    expect(KIE_RETENTION_RESULTS).toEqual(["CONFIRMED_NOT_STORED", "PROVIDER_REPORTED_STORED", "RETENTION_UNCONFIRMED"]);
    expect(classifyKieRetention(false)).toBe("CONFIRMED_NOT_STORED");
    expect(classifyKieRetention(true)).toBe("PROVIDER_REPORTED_STORED");
    for (const malformed of [undefined, null, "false", "true", 0, 1, {}, [], "no"]) expect(classifyKieRetention(malformed)).toBe("RETENTION_UNCONFIRMED");
  });

  it("confirms retention only for an explicit store: false", async () => {
    let diagnostic: KieProviderDiagnostic | null = null;
    const result = await createKieResponsesProvider({ token: TOKEN, model: MODEL, fetcher: reply(completed(JSON.stringify(providerEnvelope()), { store: false })), onDiagnostic: (value) => (diagnostic = value) }).invoke(payload(), new AbortController().signal);
    expect(result).toMatchObject({ kind: "COMPLETED", retention: "CONFIRMED_NOT_STORED" });
    expect(diagnostic).toMatchObject({ code: "COMPLETED", retention: "CONFIRMED_NOT_STORED" });
  });

  it("rejects a completed response that reports store: true, keeping only its billed usage as evidence", async () => {
    let diagnostic: KieProviderDiagnostic | null = null;
    const result = await createKieResponsesProvider({ token: TOKEN, model: MODEL, fetcher: reply(completed(JSON.stringify(providerEnvelope()), { store: true })), onDiagnostic: (value) => (diagnostic = value) }).invoke(payload(), new AbortController().signal);
    expect(result).toEqual({ kind: "FAILED", reason: "PROVIDER_FAILED" });
    expect(diagnostic).toMatchObject({ code: "RESPONSE_STORED", parserStage: "RETENTION", retention: "PROVIDER_REPORTED_STORED", mismatchUsage: { inputTokens: 812, outputTokens: 140, credits: 0.02 } });
  });

  it.each([["absent", {}], ["null", { store: null }], ["a string", { store: "false" }], ["a number", { store: 0 }], ["an object", { store: {} }]])("marks %s store as RETENTION_UNCONFIRMED without accepting it as confirmed", async (_label, extra) => {
    let diagnostic: KieProviderDiagnostic | null = null;
    const body = completed(JSON.stringify(providerEnvelope()), extra);
    if (!("store" in extra)) delete (body as Record<string, unknown>).store;
    const result = await createKieResponsesProvider({ token: TOKEN, model: MODEL, fetcher: reply(body), onDiagnostic: (value) => (diagnostic = value) }).invoke(payload(), new AbortController().signal);
    expect(result).toMatchObject({ kind: "COMPLETED", retention: "RETENTION_UNCONFIRMED" });
    expect(diagnostic).toMatchObject({ code: "COMPLETED", retention: "RETENTION_UNCONFIRMED" });
    // The property name may appear among topLevelKeys; its value never does.
    expect(JSON.stringify(diagnostic)).not.toMatch(/"store":/);
    expect(Object.keys(diagnostic!)).not.toContain("store");
  });
});
