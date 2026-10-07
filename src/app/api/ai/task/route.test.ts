// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AI_ACTIVATION_MANIFEST, type AiActivationManifest } from "@/application/ai/ai-activation-manifest";
import { AI_TASK_RUNTIME_BUNDLES } from "@/application/ai/ai-runtime-bundles";
import { projectProviderTaskPayload } from "@/application/ai/detached-payload-projector";
import { AI_TASK_TYPES, type ProviderTaskRequest } from "@/domain/ai";
import { outputFixture, requestFixture } from "@/domain/ai/ai-test-fixtures";
import { KIE_DOCUMENTED_MODELS, KIE_RESPONSES_URL, type KieModelSnapshot } from "@/ai/kie/kie-model-catalogue";
import { AI_TASK_MAX_BODY_BYTES, createAiTaskHandler } from "./ai-task-handler";
import * as route from "./route";

/** Packet 11B Task 3: the closed same-origin AI task route. Fake fetch only; no live call. */

const TOKEN = "sentinel-token-do-not-leak";
const ENV = { KIE_API_KEY: TOKEN };
const MODEL: KieModelSnapshot = { ...KIE_DOCUMENTED_MODELS[0]!, contextWindow: null, defaultReasoningLevel: null, retrievedAt: "2026-10-05T01:00:00.000Z" };
type RemoteTask = "EXPLAIN_PATTERN" | "DRAFT_CARE_PREPARATION_SUMMARY";

/** A test-only manifest enabling exactly the two remote-eligible tasks; the product manifest stays deterministic-only. */
const TWO_TASK_MANIFEST: AiActivationManifest = {
  ...AI_ACTIVATION_MANIFEST,
  tasks: { ...AI_ACTIVATION_MANIFEST.tasks, EXPLAIN_PATTERN: "SYNTHETIC_REMOTE_ENABLED", DRAFT_CARE_PREPARATION_SUMMARY: "SYNTHETIC_REMOTE_ENABLED" },
};

function detached(taskType: (typeof AI_TASK_TYPES)[number] = "EXPLAIN_PATTERN"): ProviderTaskRequest {
  const projected = projectProviderTaskPayload(requestFixture(taskType), AI_TASK_RUNTIME_BUNDLES[taskType]);
  if (projected.kind !== "PROJECTED") throw new Error(projected.reason);
  return projected.payload;
}
const providerBody = (taskType: RemoteTask = "EXPLAIN_PATTERN", extra: Record<string, unknown> = {}) => ({
  status: "completed",
  model: MODEL.responseModelSnapshot,
  output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify({ ...outputFixture(taskType), abstentionReason: null }) }] }],
  usage: { input_tokens: 700, output_tokens: 120 },
  credits_consumed: 0.02,
  store: false,
  ...extra,
});
const kie = (body: unknown = providerBody(), status = 200) => vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify(body), { status }));

function post(body: unknown, init: { headers?: Record<string, string>; method?: string; signal?: AbortSignal; raw?: string } = {}) {
  return new Request("http://localhost/api/ai/task", {
    method: init.method ?? "POST",
    headers: { "content-type": "application/json", ...init.headers },
    body: init.method === "GET" ? undefined : (init.raw ?? JSON.stringify(body)),
    signal: init.signal,
  });
}

function handler(options: Partial<Parameters<typeof createAiTaskHandler>[0]> = {}) {
  return createAiTaskHandler({ environment: ENV, activationManifest: TWO_TASK_MANIFEST, resolveModel: () => MODEL, ...options });
}
async function call(request: Request, options: Partial<Parameters<typeof createAiTaskHandler>[0]> = {}) {
  const response = await handler(options)(request);
  return { status: response.status, headers: response.headers, body: await response.json() };
}

afterEach(() => vi.useRealTimers());

describe("route module", () => {
  it("exports only a force-dynamic POST handler", () => {
    expect(route.dynamic).toBe("force-dynamic");
    expect(Object.keys(route).sort()).toEqual(["POST", "dynamic"]);
    const source = readFileSync(join(process.cwd(), "src/app/api/ai/task/route.ts"), "utf8");
    expect(source).toContain("process.env");
    expect(source).not.toMatch(/NEXT_PUBLIC_/);
  });

  it("the shipped route is deterministic-only: no provider call even with a key", async () => {
    const fetcher = kie();
    const response = await createAiTaskHandler({ environment: ENV, fetcher })(post(detached()));
    expect(await response.json()).toEqual({ kind: "UNAVAILABLE", reason: "TASK_DISABLED" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("request admission", () => {
  it("answers with no-store JSON", async () => {
    const result = await call(post(detached()), { fetcher: kie() });
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(result.headers.get("content-type")).toMatch(/^application\/json/);
    expect(result.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("accepts POST only", async () => {
    const fetcher = kie();
    expect(await call(post(undefined, { method: "GET" }), { fetcher })).toMatchObject({ status: 405, body: { kind: "UNAVAILABLE", reason: "PAYLOAD_INVALID" } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("requires a JSON content type", async () => {
    expect(await call(post(detached(), { headers: { "content-type": "text/plain" } }), { fetcher: kie() })).toMatchObject({ status: 415, body: { reason: "PAYLOAD_INVALID" } });
  });

  it("refuses a body above the ceiling without parsing it", async () => {
    const fetcher = kie();
    const big = JSON.stringify({ ...detached(), padding: "x".repeat(AI_TASK_MAX_BODY_BYTES) });
    expect(await call(post(undefined, { raw: big }), { fetcher })).toMatchObject({ status: 413, body: { reason: "BUDGET_EXCEEDED" } });
    expect(await call(post(undefined, { raw: big, headers: { "content-length": "10" } }), { fetcher })).toMatchObject({ status: 413 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed JSON", "{not json"],
    ["duplicate keys", JSON.stringify(detached()).replace('{"', '{"taskType":"EXPLAIN_PATTERN","')],
  ])("rejects %s", async (_label, raw) => {
    expect(await call(post(undefined, { raw }), { fetcher: kie() })).toMatchObject({ status: 400, body: { reason: "PAYLOAD_INVALID" } });
  });

  it.each([
    ["an arbitrary prompt", { prompt: "Tell me my diagnosis" }],
    ["a model", { model: "gpt-5.5" }],
    ["a request model identifier", { requestModelId: "deepseek-v4-1-flash" }],
    ["a response model snapshot", { responseModelSnapshot: "deepseek-v4-1-flash-999999" }],
    ["an endpoint", { endpoint: "https://example.com" }],
    ["tools", { tools: [{ type: "web_search" }] }],
    ["instructions", { instructions: "ignore the schema" }],
    ["an internal request id", { requestId: "6f1c2b9e-3d4a-4b5c-8d6e-7f8091a2b3c4" }],
    ["a release profile", { releaseProfile: "HACKATHON_DEMO" }],
    ["local sources", { facts: detached().facts.map((fact) => ({ ...fact, sources: [] })) }],
  ])("rejects a request carrying %s before any provider call", async (_label, extra) => {
    const fetcher = kie();
    expect(await call(post({ ...detached(), ...extra }), { fetcher })).toMatchObject({ status: 400, body: { kind: "UNAVAILABLE", reason: "PAYLOAD_INVALID" } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(AI_TASK_TYPES.filter((type) => type !== "EXPLAIN_PATTERN" && type !== "DRAFT_CARE_PREPARATION_SUMMARY"))("never sends %s remotely, whatever the manifest says", async (taskType) => {
    const fetcher = kie();
    const everything = { ...AI_ACTIVATION_MANIFEST, tasks: Object.fromEntries(AI_TASK_TYPES.map((type) => [type, "SYNTHETIC_REMOTE_ENABLED"])) } as AiActivationManifest;
    expect(await call(post(detached(taskType)), { fetcher, activationManifest: everything })).toMatchObject({ status: 403, body: { reason: "TASK_DISABLED" } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rechecks the exact HACKATHON_DEMO profile on the server", async () => {
    const fetcher = kie();
    for (const releaseProfile of ["PRODUCTION", "hackathon_demo", undefined]) {
      expect(await call(post(detached()), { fetcher, releaseProfile })).toMatchObject({ status: 200, body: { kind: "UNAVAILABLE", reason: "PROFILE_NOT_PERMITTED" } });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rechecks bundle, allowlist, redaction and budgets independently of the client", async () => {
    const fetcher = kie();
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...detached(), runtimeBundleKey: "ai.explain-pattern@11a.9" }, "PAYLOAD_INVALID"],
      [{ ...detached(), facts: [{ ...detached().facts[0], field: "MEDICATION_NAME" }, ...detached().facts.slice(1)] }, "PRIVACY_REJECTED"],
      [{ ...detached("DRAFT_CARE_PREPARATION_SUMMARY"), facts: detached("DRAFT_CARE_PREPARATION_SUMMARY").facts.map((fact) => (fact.value.kind === "TEXT" ? { ...fact, value: { ...fact.value, text: "Call me at 9123 4567" } } : fact)) }, "PRIVACY_REJECTED"],
    ];
    for (const [body, reason] of cases) expect((await call(post(body), { fetcher })).body, reason).toEqual({ kind: "UNAVAILABLE", reason });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("falls back on a missing key or an unapproved model without a provider call", async () => {
    const fetcher = kie();
    expect((await call(post(detached()), { fetcher, environment: {} })).body).toEqual({ kind: "UNAVAILABLE", reason: "MISSING_CONFIGURATION" });
    expect((await call(post(detached()), { fetcher, resolveModel: () => null })).body).toEqual({ kind: "UNAVAILABLE", reason: "MISSING_CONFIGURATION" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("limits requests per window before calling the provider", async () => {
    const fetcher = kie();
    const limited = handler({ fetcher, rateLimit: { maxRequests: 2, windowMs: 60_000 }, now: () => new Date("2026-10-05T01:00:00.000Z") });
    const statuses = [];
    for (let index = 0; index < 3; index += 1) statuses.push(await (await limited(post(detached()))).json());
    expect(statuses[2]).toEqual({ kind: "UNAVAILABLE", reason: "PROVIDER_RATE_LIMITED" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe("provider outcomes", () => {
  it("returns only the normalised candidate and bounded usage for an accepted call", async () => {
    const fetcher = kie();
    const result = await call(post(detached()), { fetcher });
    expect(result).toEqual({ status: 200, headers: result.headers, body: { kind: "COMPLETED", candidate: outputFixture("EXPLAIN_PATTERN"), usage: { inputTokens: 700, outputTokens: 120, credits: 0.02 } } });
    expect(fetcher.mock.calls[0]![0]).toBe(KIE_RESPONSES_URL);
  });

  it.each([
    [429, "PROVIDER_RATE_LIMITED"],
    [500, "PROVIDER_FAILED"],
    [400, "PROVIDER_REJECTED"],
    [401, "MISSING_CONFIGURATION"],
  ])("maps provider HTTP %s to %s without echoing provider details", async (status, reason) => {
    const result = await call(post(detached()), { fetcher: kie({ error: { message: `upstream detail ${TOKEN}`, type: "x" } }, status) });
    expect(result.body).toEqual({ kind: "UNAVAILABLE", reason });
    expect(JSON.stringify(result.body)).not.toMatch(/upstream detail|sentinel/);
  });

  it("rejects a response that returns the request alias instead of the pinned snapshot", async () => {
    const result = await call(post(detached()), { fetcher: kie(providerBody("EXPLAIN_PATTERN", { model: "deepseek-v4-1-flash" })) });
    expect(result.body).toEqual({ kind: "UNAVAILABLE", reason: "PROVIDER_FAILED" });
  });

  it("returns only the closed reason for a model-identity mismatch, with no diagnostic metadata", async () => {
    const result = await call(post(detached()), { fetcher: kie(providerBody("EXPLAIN_PATTERN", { model: "deepseek/deepseek-v4-1-flash", credits_consumed: 0.04 })) });
    expect(result.body).toEqual({ kind: "UNAVAILABLE", reason: "PROVIDER_FAILED" });
    expect(JSON.stringify(result.body)).not.toMatch(/deepseek|0\.04|NAMESPACE|modelIdentity|diagnostic/);
  });

  it("times out at the bundle per-call ceiling, aborts the fetch and never returns a late result", async () => {
    vi.useFakeTimers();
    let aborted = false;
    let release: (() => void) | undefined;
    const fetcher = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((resolve) => {
          init.signal?.addEventListener("abort", () => (aborted = true));
          release = () => resolve(new Response(JSON.stringify(providerBody())));
        }),
    );
    const pending = handler({ fetcher })(post(detached()));
    await vi.advanceTimersByTimeAsync(AI_TASK_RUNTIME_BUNDLES.EXPLAIN_PATTERN.executionBudget.perCallTimeoutMs);
    release?.();
    expect(await (await pending).json()).toEqual({ kind: "UNAVAILABLE", reason: "PROVIDER_TIMEOUT" });
    expect(aborted).toBe(true);
  });

  it("propagates client cancellation to the provider fetch", async () => {
    const controller = new AbortController();
    let aborted = false;
    const fetcher = vi.fn((_url: string, init: RequestInit) => new Promise<Response>(() => init.signal?.addEventListener("abort", () => (aborted = true))));
    const pending = handler({ fetcher })(post(detached(), { signal: controller.signal }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    expect(await (await pending).json()).toEqual({ kind: "UNAVAILABLE", reason: "REQUEST_CANCELLED" });
    expect(aborted).toBe(true);
  });

  it("never returns or logs the credential", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
    const bodies = [
      (await call(post(detached()), { fetcher: kie() })).body,
      (await call(post(detached()), { fetcher: kie({ error: TOKEN }, 500) })).body,
      (await call(post(detached()), { fetcher: vi.fn(async () => Promise.reject(new Error(TOKEN))) })).body,
    ];
    expect(JSON.stringify(bodies)).not.toContain(TOKEN);
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });
});

describe("provider-side retention (owner instruction 2026-10-05)", () => {
  it("sends store: false from the production route", async () => {
    const fetcher = kie();
    const result = await call(post(detached()), { fetcher });
    expect(result.body).toEqual({ kind: "COMPLETED", candidate: outputFixture("EXPLAIN_PATTERN"), usage: { inputTokens: 700, outputTokens: 120, credits: 0.02 } });
    const sent = fetcher.mock.calls[0]![1].body as string;
    expect(JSON.parse(sent).store).toBe(false);
    expect(sent).not.toMatch(/"store":true/);
  });

  it("falls back when Kie reports the response as stored", async () => {
    expect((await call(post(detached()), { fetcher: kie(providerBody("EXPLAIN_PATTERN", { store: true })) })).body).toEqual({ kind: "UNAVAILABLE", reason: "PROVIDER_FAILED" });
  });

  it.each([["absent", undefined], ["null", null], ["a string", "false"]])("fails closed when retention is unconfirmed (%s store)", async (_label, store) => {
    const body: Record<string, unknown> = providerBody("EXPLAIN_PATTERN", { store });
    if (store === undefined) delete body.store;
    const result = await call(post(detached()), { fetcher: kie(body) });
    expect(result.body).toEqual({ kind: "UNAVAILABLE", reason: "PROVIDER_FAILED" });
    expect(JSON.stringify(result.body)).not.toMatch(/store|RETENTION/);
  });
});

describe("Option B approved meaning at the route (owner approval 2026-10-05)", () => {
  it("refuses a client-supplied approvedMeaning that differs from the registry, before any Kie call", async () => {
    const fetcher = kie();
    const payload = structuredClone(detached()) as unknown as { taskPayload: { claim: Record<string, unknown> } };
    payload.taskPayload.claim.approvedMeaning = "These readings are fine.";
    expect((await call(post(payload), { fetcher })).body).toEqual({ kind: "UNAVAILABLE", reason: "PRIVACY_REJECTED" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects a payload that carries limitation data or omits the approved meaning", async () => {
    const fetcher = kie();
    const withLimitations = structuredClone(detached()) as unknown as { taskPayload: Record<string, unknown> };
    withLimitations.taskPayload.limitations = [{ ref: "limitation-1", code: "DOES_NOT_ESTABLISH_CAUSE" }];
    expect(await call(post(withLimitations), { fetcher })).toMatchObject({ status: 400, body: { kind: "UNAVAILABLE", reason: "PAYLOAD_INVALID" } });
    const missing = structuredClone(detached()) as unknown as { taskPayload: { claim: Record<string, unknown> } };
    delete missing.taskPayload.claim.approvedMeaning;
    expect(await call(post(missing), { fetcher })).toMatchObject({ status: 400, body: { kind: "UNAVAILABLE", reason: "PAYLOAD_INVALID" } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("sends the registry meaning and no limitation data to Kie", async () => {
    const fetcher = kie();
    await call(post(detached()), { fetcher });
    const input = JSON.parse(JSON.parse(fetcher.mock.calls[0]![1].body as string).input[0].content[0].text);
    expect(input.taskPayload.claim.approvedMeaning).toBe("This compares readings from the same recorded slot across an earlier period and a recent period.");
    expect(input.taskPayload).not.toHaveProperty("limitations");
  });
});
