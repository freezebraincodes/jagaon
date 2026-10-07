import { describe, expect, it, vi } from "vitest";
import { KIE_GROK_RESPONSES_URL, discoverKieModels, KIE_DOCUMENTED_MODELS, KIE_MODELS_URL, KIE_OPENAI_BASE_URL, KIE_RESPONSES_URL, KieDiscoveryError } from "./kie-model-catalogue";

/** Packet 11B Task 1: current Kie model discovery (docs.kie.ai/ai-agent/codex-cli, retrieved 2026-10-04). */

const TOKEN = "sentinel-token-do-not-leak";
const NOW = "2026-10-05T01:00:00.000Z";
const listing = (models: unknown[]) => ({ object: "list", data: models.map((model) => ({ id: (model as { slug?: string }).slug, object: "model" })), models });
const model = (slug: string, extra: Record<string, unknown> = {}) => ({ slug, display_name: slug, context_window: 272000, default_reasoning_level: "medium", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }], base_instructions: "provider text", ...extra });
const respond = (body: unknown, status = 200) => vi.fn(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
const discover = (fetcher: ReturnType<typeof respond>, token = TOKEN) => discoverKieModels({ token, fetcher, now: () => NOW });
const codeOf = (promise: Promise<unknown>) => promise.then(() => "OK", (error: unknown) => (error instanceof KieDiscoveryError ? error.code : `UNEXPECTED:${String(error)}`));

describe("Kie model discovery", () => {
  it("pins the documented OpenAI-compatible base, listing and Responses endpoints", () => {
    expect(KIE_OPENAI_BASE_URL).toBe("https://api.kie.ai/openai/v1");
    expect(KIE_MODELS_URL).toBe("https://api.kie.ai/openai/v1/models");
    expect(KIE_RESPONSES_URL).toBe("https://api.kie.ai/openai/v1/responses");
  });

  it("calls the listing with a bearer token, GET and no-store, and never an apikey header", async () => {
    const fetcher = respond(listing([model("gpt-5.4")]));
    await discover(fetcher);
    const [url, init] = fetcher.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe(KIE_MODELS_URL);
    expect(init.method).toBe("GET");
    expect(init.cache).toBe("no-store");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(headers.has("apikey")).toBe(false);
  });

  it("keeps only non-secret qualification metadata from .models[].slug", async () => {
    const result = await discover(respond(listing([model("gpt-5.4", { supported_reasoning_levels: ["low", { effort: "medium" }] })])));
    expect(result).toEqual([
      { requestModelId: "gpt-5.4", responseModelSnapshot: "gpt-5.4", provenance: "LISTED", endpoint: KIE_RESPONSES_URL, contextWindow: 272000, defaultReasoningLevel: "medium", supportedReasoningLevels: ["low", "medium"], retrievedAt: NOW, documentationUrl: null },
    ]);
    expect(JSON.stringify(result)).not.toContain("provider text");
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("removes duplicate slugs, keeping the first entry", async () => {
    const result = await discover(respond(listing([model("gpt-5.4"), model("gpt-5.4", { context_window: 1 }), model("gpt-5.5")])));
    expect(result.map((entry) => [entry.requestModelId, entry.contextWindow])).toEqual([["gpt-5.4", 272000], ["gpt-5.5", 272000]]);
  });

  it.each([
    ["no models array", { object: "list", data: [] }],
    ["non-array models", { models: {} }],
    ["missing slug", { models: [{ display_name: "x" }] }],
    ["empty slug", { models: [model("")] }],
    ["slug with whitespace", { models: [model("gpt 5")] }],
    ["non-numeric context window", { models: [model("gpt-5.4", { context_window: "big" })] }],
    ["malformed reasoning level", { models: [model("gpt-5.4", { supported_reasoning_levels: [{ level: 1 }] })] }],
    ["not JSON", "<html>"],
  ])("rejects a malformed listing (%s)", async (_label, body) => {
    expect(await codeOf(discover(respond(body)))).toBe("LISTING_INVALID");
  });

  it.each([
    [401, "AUTHENTICATION_FAILED"],
    [403, "AUTHENTICATION_FAILED"],
    [429, "LISTING_UNAVAILABLE"],
    [500, "LISTING_UNAVAILABLE"],
  ])("maps HTTP %s to %s", async (status, code) => {
    expect(await codeOf(discover(respond({ error: { message: `bad ${TOKEN}` } }, status)))).toBe(code);
  });

  it("rejects a missing token before any request", async () => {
    const fetcher = respond(listing([]));
    expect(await codeOf(discover(fetcher, "   "))).toBe("MISSING_CONFIGURATION");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("never exposes the token in a result or an error", async () => {
    for (const fetcher of [respond({ error: TOKEN }, 401), respond(`not json ${TOKEN}`), vi.fn(async () => Promise.reject(new Error(`network ${TOKEN}`)))]) {
      const error = await discover(fetcher as never).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(KieDiscoveryError);
      expect(JSON.stringify(error) + String(error) + (error as Error).message).not.toContain(TOKEN);
    }
  });

  it("records the documented-unlisted candidates as evaluation-only (DeepSeek kept as history; excluded from selection)", () => {
    expect(KIE_DOCUMENTED_MODELS).toEqual([
      {
        requestModelId: "deepseek-v4-1-flash",
        responseModelSnapshot: "deepseek-v4-1-flash-260910",
        provenance: "DOCUMENTED_UNLISTED_EVALUATION_ONLY",
        endpoint: KIE_RESPONSES_URL,
        documentationUrl: "https://docs.kie.ai/market/deepseek-v4-1-flash.md",
        documentedAt: "2026-10-04",
        supportedReasoningLevels: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
        structuredOutput: "TEXT_FORMAT_JSON_SCHEMA_STRICT",
        unsupportedParameters: ["max_output_tokens", "temperature", "top_p"],
      },
      {
        requestModelId: "grok-4-7",
        responseModelSnapshot: "grok-4-7",
        provenance: "DOCUMENTED_UNLISTED_EVALUATION_ONLY",
        endpoint: KIE_GROK_RESPONSES_URL,
        documentationUrl: "https://docs.kie.ai/market/grok/grok-4-7.md",
        documentedAt: "2026-10-06",
        supportedReasoningLevels: ["low", "medium", "high", "xhigh"],
        structuredOutput: "TEXT_FORMAT_JSON_SCHEMA_STRICT",
        unsupportedParameters: [],
      },
    ]);
    expect(Object.isFrozen(KIE_DOCUMENTED_MODELS[0])).toBe(true);
  });

  it("pins the owner-approved exact identity pair as immutable configuration, never a pattern", () => {
    const [model] = KIE_DOCUMENTED_MODELS;
    expect([model!.requestModelId, model!.responseModelSnapshot]).toEqual(["deepseek-v4-1-flash", "deepseek-v4-1-flash-260910"]);
    expect(() => {
      (model as { responseModelSnapshot: string }).responseModelSnapshot = "deepseek-v4-1-flash-999999";
    }).toThrow();
    expect(model!.responseModelSnapshot).toBe("deepseek-v4-1-flash-260910");
  });
});
