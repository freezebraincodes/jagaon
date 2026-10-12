// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deepSeekCostMicroUsd } from "@/ai/deepseek/deepseek-catalogue";
import { plannedFixture, shellCandidate } from "@/ai/evaluation/packet-11-hybrid-test-support";
import { AI_ACTIVATION_MANIFEST, type AiActivationManifest } from "@/application/ai/ai-activation-manifest";
import { PROVIDER_FAILURE_REASONS } from "@/application/ai/ai-provider-port";
import { AI_SHELL_ACCESS_HEADER, AI_SHELL_ROUTE_REFUSAL_REASONS, aiShellRouteResponseSchema, shellRouteCallUpperBound } from "@/application/ai/ai-shell-route-contract";
import { projectShellTaskRequest } from "@/application/ai/language/shell-projector";
import { qualifiedTestRequestClassGate } from "@/application/ai/request-class-test-support";
import { AI_AUDIT_ONLY_OUTCOME_CODES, AI_REASON_CODES, type ShellFieldPath, type ShellTaskRequest } from "@/domain/ai";
import { createAiShellHandler } from "./ai-shell-handler";
import { AI_SHELL_DEPLOYMENT_ENV, parseAiShellDeploymentConfig } from "./ai-shell-deployment-config";
import { TEST_DEPLOYMENT_ENVIRONMENT, TEST_ORIGIN, TEST_PASSCODE, testBrowserHeaders } from "./ai-shell-route-test-support";
import { InMemoryDailySpendLedger, type SpendLedger, type SpendReserveResult } from "./ai-spend-ledger";

/**
 * Packet 11C Addendum C, Task C6 (owner approval of Addendum C and the C6 amendment): the server-side remote-AI switch, origin protection,
 * access authorization (demo passcode) and the pre-send spend reservation of POST /api/ai/shell. Fake fetchers and fake ledgers only; no
 * provider call. Every configuration value here is a TEST value (ai-shell-route-test-support.ts); nothing is a code default.
 */

const TOKEN = "deepseek-SENTINEL-c6-credential";
const ENABLED: AiActivationManifest = {
  ...AI_ACTIVATION_MANIFEST,
  tasks: { ...AI_ACTIVATION_MANIFEST.tasks, EXPLAIN_PATTERN: "SYNTHETIC_REMOTE_ENABLED", DRAFT_CARE_PREPARATION_SUMMARY: "SYNTHETIC_REMOTE_ENABLED" },
};
const EN = plannedFixture("p11.explain-pattern.en-sg.ordinary");
const shellRequest = (): ShellTaskRequest => structuredClone(projectShellTaskRequest(EN.plan)) as ShellTaskRequest;
const VALID = shellCandidate(EN.plan, new Map<ShellFieldPath, string>([["headline", "A look at {{S1}}."], ["evidence", "This is based on {{S3}}."]]));
const REPORTED_COST = deepSeekCostMicroUsd(600, 80);
const UPPER = shellRouteCallUpperBound(shellRequest()).costMicroUsd;
const CONFIG_KEYS = Object.values(AI_SHELL_DEPLOYMENT_ENV);

const envelope = (text: string, extra: Record<string, unknown> = {}) => ({
  id: "resp_1", object: "response", status: "completed", model: "deepseek-flash",
  output: [{ type: "message", id: "msg_1", status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }],
  usage: { input_tokens: 600, output_tokens: 80, output_tokens_details: { reasoning_tokens: 0 } },
  store: false, error: null, incomplete_details: null, ...extra,
});
const deepseek = (status = 200, extra: Record<string, unknown> = {}) =>
  vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify(status === 200 ? envelope(JSON.stringify(VALID), extra) : { error: "x" }), { status, headers: { "content-type": "application/json" } }));

const usd = (micro: number) => `${Math.floor(micro / 1_000_000)}.${String(micro % 1_000_000).padStart(6, "0")}`;
/** A recording environment: every key read is observable, in order. */
function recordingEnvironment(values: Record<string, string | undefined>) {
  const reads: string[] = [];
  const environment = new Proxy({ ...values } as Record<string, string | undefined>, { get: (target, key) => (reads.push(String(key)), target[String(key)]) });
  return { environment, reads };
}
function post(headers: Record<string, string> = testBrowserHeaders(), body: unknown = shellRequest(), signal?: AbortSignal) {
  return new Request("http://localhost/api/ai/shell", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal });
}
/** A ledger that records every port call and delegates to an in-memory ledger. */
function spyLedger(inner: SpendLedger = new InMemoryDailySpendLedger({ dailyLimitMicroUsd: 1_000_000 })) {
  const log: Array<readonly unknown[]> = [];
  const ledger: SpendLedger = {
    reserve: async (amount, now) => (log.push(["reserve", amount]), inner.reserve(amount, now)),
    commit: async (token, billed, basis) => (log.push(["commit", billed, basis]), inner.commit(token, billed, basis)),
    release: async (token) => (log.push(["release"]), inner.release(token)),
  };
  return { ledger, log };
}
type Options = Partial<Parameters<typeof createAiShellHandler>[0]>;
const ENV = { DEEPSEEK_API_KEY: TOKEN, ...TEST_DEPLOYMENT_ENVIRONMENT };
const handler = (options: Options = {}) => createAiShellHandler({ environment: ENV, activationManifest: ENABLED, requestClassGate: qualifiedTestRequestClassGate(), ...options });
const refused = (reason: string) => ({ kind: "REFUSED", reason, notSentToProvider: true });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("C6 deployment configuration: one parsed, validated object; missing or invalid means disabled (no defaults)", () => {
  it("names exactly four server-only variables, none public", () => {
    expect(AI_SHELL_DEPLOYMENT_ENV).toEqual({ remoteAi: "JAGAON_REMOTE_AI", allowedOrigins: "JAGAON_AI_ALLOWED_ORIGINS", demoPasscode: "JAGAON_AI_DEMO_PASSCODE", dailySpendLimitUsd: "JAGAON_AI_DAILY_SPEND_LIMIT_USD" });
    for (const name of CONFIG_KEYS) expect(name).not.toMatch(/^NEXT_PUBLIC_/);
  });

  it("an empty environment: switch off, no origins, no passcode, no daily limit", () => {
    // Owner decision 2026-10-12 (optional passcodes; deliberate change): no passcode configured means none is required.
    expect(parseAiShellDeploymentConfig({})).toEqual({ remoteAiEnabled: false, allowedOrigins: null, passcodeRequired: false, passcodeDigest: null, dailySpendLimitMicroUsd: null });
  });

  it("the switch is on only for the exact value `on`", () => {
    expect(parseAiShellDeploymentConfig({ JAGAON_REMOTE_AI: "on" }).remoteAiEnabled).toBe(true);
    for (const value of ["ON", "On", "true", "1", "yes", " on", "on ", "", "off", undefined]) expect(parseAiShellDeploymentConfig({ JAGAON_REMOTE_AI: value }).remoteAiEnabled, String(value)).toBe(false);
  });

  it("allowed origins: an exact comma-separated list of http(s) origins; any invalid entry invalidates the list", () => {
    expect(parseAiShellDeploymentConfig({ JAGAON_AI_ALLOWED_ORIGINS: "https://demo.example" }).allowedOrigins).toEqual(["https://demo.example"]);
    expect(parseAiShellDeploymentConfig({ JAGAON_AI_ALLOWED_ORIGINS: "https://demo.example, http://localhost:3000" }).allowedOrigins).toEqual(["https://demo.example", "http://localhost:3000"]);
    for (const value of ["", " ", "*", "https://*.example", "https://demo.example/", "https://demo.example/path", "demo.example", "null", "ftp://demo.example", "https://demo.example,,https://b.example", "https://Demo.Example", "https://demo.example:443", undefined]) {
      expect(parseAiShellDeploymentConfig({ JAGAON_AI_ALLOWED_ORIGINS: value }).allowedOrigins, String(value)).toBeNull();
    }
  });

  it("the passcode: 8 to 128 visible ASCII characters; only its digest is kept (the configuration never holds the secret)", () => {
    const config = parseAiShellDeploymentConfig({ JAGAON_AI_DEMO_PASSCODE: TEST_PASSCODE });
    expect(config.passcodeDigest).toBeInstanceOf(Uint8Array);
    expect(config.passcodeDigest?.byteLength).toBe(32);
    expect(JSON.stringify(config)).not.toContain(TEST_PASSCODE);
    expect(inspect(config, { depth: 5 })).not.toContain(TEST_PASSCODE);
    for (const value of ["", "short7c", "has space inside", "x".repeat(129), "pässcode-unicode", "tab\tinside1", undefined]) {
      expect(parseAiShellDeploymentConfig({ JAGAON_AI_DEMO_PASSCODE: value }).passcodeDigest, String(value)).toBeNull();
    }
    expect(parseAiShellDeploymentConfig({ JAGAON_AI_DEMO_PASSCODE: "x".repeat(128) }).passcodeDigest).not.toBeNull();
  });

  it("the daily limit: a positive USD decimal with at most 6 decimals, held as whole micro-USD; anything else is not configured", () => {
    const limit = (value: string | undefined) => parseAiShellDeploymentConfig({ JAGAON_AI_DAILY_SPEND_LIMIT_USD: value }).dailySpendLimitMicroUsd;
    expect(limit("1")).toBe(1_000_000);
    expect(limit("1.00")).toBe(1_000_000);
    expect(limit("0.5")).toBe(500_000);
    expect(limit("0.000001")).toBe(1);
    expect(limit("12.345678")).toBe(12_345_678);
    for (const value of ["0", "0.0", "0.000000", "-1", "1e3", "abc", "1.0000001", " 1", "1 ", "1,000", "", ".5", "5.", "01", "Infinity", "NaN", "1000000", undefined]) expect(limit(value), String(value)).toBeNull();
  });

  it("a throwing environment read is a missing value (fail closed)", () => {
    const hostile = new Proxy({}, { get: () => { throw new Error("unreadable"); } });
    expect(parseAiShellDeploymentConfig(hostile)).toEqual({ remoteAiEnabled: false, allowedOrigins: null, passcodeRequired: false, passcodeDigest: null, dailySpendLimitMicroUsd: null });
  });
});

describe("C6 route order: every refusal happens before the credential read and before any provider call", () => {
  const cases: Array<[string, { env?: Record<string, string | undefined>; headers?: Record<string, string>; ledger?: SpendLedger }, string]> = [
    ["the switch missing", { env: { JAGAON_REMOTE_AI: undefined } }, "REMOTE_AI_DISABLED"],
    ["the switch off", { env: { JAGAON_REMOTE_AI: "off" } }, "REMOTE_AI_DISABLED"],
    ["the switch invalid", { env: { JAGAON_REMOTE_AI: "true" } }, "REMOTE_AI_DISABLED"],
    ["no allowed origins configured", { env: { JAGAON_AI_ALLOWED_ORIGINS: undefined } }, "ORIGIN_REJECTED"],
    ["an invalid allowed-origin list", { env: { JAGAON_AI_ALLOWED_ORIGINS: "*" } }, "ORIGIN_REJECTED"],
    ["no Origin header", { headers: { "sec-fetch-site": "same-origin", [AI_SHELL_ACCESS_HEADER]: TEST_PASSCODE } }, "ORIGIN_REJECTED"],
    ["an Origin outside the list", { headers: { ...testBrowserHeaders(), Origin: "https://elsewhere.example" } }, "ORIGIN_REJECTED"],
    ["an Origin differing only in its port", { headers: { ...testBrowserHeaders(), Origin: `${TEST_ORIGIN}:3000` } }, "ORIGIN_REJECTED"],
    ["Sec-Fetch-Site cross-site", { headers: { ...testBrowserHeaders(), "Sec-Fetch-Site": "cross-site" } }, "ORIGIN_REJECTED"],
    ["Sec-Fetch-Site same-site", { headers: { ...testBrowserHeaders(), "Sec-Fetch-Site": "same-site" } }, "ORIGIN_REJECTED"],
    ["Sec-Fetch-Site none", { headers: { ...testBrowserHeaders(), "Sec-Fetch-Site": "none" } }, "ORIGIN_REJECTED"],
    ["no Sec-Fetch-Site header", { headers: { origin: TEST_ORIGIN, [AI_SHELL_ACCESS_HEADER]: TEST_PASSCODE } }, "ORIGIN_REJECTED"],
    // Owner decision 2026-10-12 (optional passcodes; deliberate change): "no passcode configured" is no longer a refusal (it grants
    // access without a passcode; see "optional AI passcode" below). A present but invalid one still refuses every request.
    ["an invalid configured passcode", { env: { JAGAON_AI_DEMO_PASSCODE: "short" } }, "ACCESS_DENIED"],
    ["an invalid configured passcode, with a header", { env: { JAGAON_AI_DEMO_PASSCODE: "has space inside" }, headers: testBrowserHeaders("has space inside") }, "ACCESS_DENIED"],
    ["no passcode header", { headers: testBrowserHeaders(null) }, "ACCESS_DENIED"],
    ["a wrong passcode of the same length", { headers: testBrowserHeaders(TEST_PASSCODE.replace(/.$/, "X")) }, "ACCESS_DENIED"],
    ["a wrong passcode of another length", { headers: testBrowserHeaders("TEST-ONLY") }, "ACCESS_DENIED"],
    ["an empty passcode header", { headers: testBrowserHeaders("") }, "ACCESS_DENIED"],
    ["no daily limit configured", { env: { JAGAON_AI_DAILY_SPEND_LIMIT_USD: undefined } }, "SPEND_NOT_CONFIGURED"],
    ["an invalid daily limit", { env: { JAGAON_AI_DAILY_SPEND_LIMIT_USD: "0" } }, "SPEND_NOT_CONFIGURED"],
    ["a daily limit below one call's upper bound", { env: { JAGAON_AI_DAILY_SPEND_LIMIT_USD: usd(UPPER - 1) } }, "SPEND_CEILING_REACHED"],
    ["a ledger that throws", { ledger: { reserve: async () => { throw new Error("down"); }, commit: async () => undefined, release: async () => undefined } }, "SPEND_LEDGER_UNAVAILABLE"],
    ["a ledger with a malformed answer", { ledger: { reserve: async () => ({ kind: "MAYBE" }) as unknown as SpendReserveResult, commit: async () => undefined, release: async () => undefined } }, "SPEND_LEDGER_UNAVAILABLE"],
    ["a ledger that refuses the ceiling", { ledger: { reserve: async () => ({ kind: "REFUSED", reason: "SPEND_CEILING_REACHED" }), commit: async () => undefined, release: async () => undefined } }, "SPEND_CEILING_REACHED"],
    ["a ledger that reports itself unavailable", { ledger: { reserve: async () => ({ kind: "REFUSED", reason: "SPEND_LEDGER_UNAVAILABLE" }), commit: async () => undefined, release: async () => undefined } }, "SPEND_LEDGER_UNAVAILABLE"],
  ];

  it.each(cases)("%s: 403 REFUSED (not sent to provider), no credential read, no fetch, no usage", async (_label, setup, reason) => {
    const fetcher = deepseek();
    const { environment, reads } = recordingEnvironment({ ...ENV, ...setup.env });
    const response = await handler({ environment, fetcher, ...(setup.ledger ? { spendLedger: setup.ledger } : {}) })(post(setup.headers));
    const body = await response.json();
    expect([response.status, body]).toEqual([403, refused(reason)]);
    expect(aiShellRouteResponseSchema.safeParse(body).success).toBe(true);
    expect(reads).not.toContain("DEEPSEEK_API_KEY");
    expect(reads.every((key) => CONFIG_KEYS.includes(key as never))).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("the global fetch is never reached either (the route's own transport is the injected fake)", async () => {
    const globalFetch = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", globalFetch);
    try {
      for (const [, setup] of cases) await handler({ environment: { ...ENV, ...setup.env }, fetcher: deepseek(), ...(setup.ledger ? { spendLedger: setup.ledger } : {}) })(post(setup.headers));
      expect(globalFetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("order: request checks -> switch -> origin -> access -> activation -> class -> spend -> credential", async () => {
    const off = { ...ENV, JAGAON_REMOTE_AI: "off" };
    const hostile = { origin: "https://elsewhere.example", "sec-fetch-site": "cross-site", [AI_SHELL_ACCESS_HEADER]: "wrong-passcode" };
    // The existing request checks come first: a malformed body is PAYLOAD_INVALID even with everything else wrong, and reads nothing.
    const early = recordingEnvironment(off);
    const malformed = await handler({ environment: early.environment })(post(hostile, { ...shellRequest(), facts: [] }));
    expect([malformed.status, await malformed.json()]).toEqual([400, { kind: "FAILED", reason: "PAYLOAD_INVALID", notSentToProvider: true }]);
    expect(early.reads).toEqual([]);
    // The switch before origin and access.
    expect(await (await handler({ environment: off })(post(hostile))).json()).toEqual(refused("REMOTE_AI_DISABLED"));
    // Origin before access.
    expect(await (await handler()(post(hostile))).json()).toEqual(refused("ORIGIN_REJECTED"));
    // Access before activation.
    expect(await (await handler({ activationManifest: AI_ACTIVATION_MANIFEST })(post(testBrowserHeaders("wrong-passcode")))).json()).toEqual(refused("ACCESS_DENIED"));
    // Activation before class and spend (the shipped manifest keeps its closed FAILED answer; nothing reserved).
    const spy = spyLedger();
    const admit = vi.fn(() => ({ admitted: true as const, classId: "x" }));
    expect(await (await handler({ activationManifest: AI_ACTIVATION_MANIFEST, spendLedger: spy.ledger, requestClassGate: { admit, anyAdmissible: () => true } })(post())).json()).toEqual({ kind: "FAILED", reason: "TASK_DISABLED", notSentToProvider: true });
    expect(admit).not.toHaveBeenCalled();
    expect(spy.log).toEqual([]);
    // Class before spend (the shipped all-PENDING records): nothing reserved.
    expect(await (await handler({ requestClassGate: undefined, spendLedger: spy.ledger })(post())).json()).toEqual(refused("REQUEST_CLASS_NOT_QUALIFIED"));
    expect(spy.log).toEqual([]);
    // Spend before the credential: the reservation is the last check before the credential read.
    const late = recordingEnvironment(ENV);
    const fetcher = deepseek();
    expect(await (await handler({ environment: late.environment, spendLedger: spy.ledger, fetcher })(post())).json()).toMatchObject({ kind: "CANDIDATE" });
    expect(spy.log[0]).toEqual(["reserve", UPPER]);
    expect(late.reads.filter((key) => key === "DEEPSEEK_API_KEY")).toEqual(["DEEPSEEK_API_KEY"]);
    expect(late.reads.indexOf("DEEPSEEK_API_KEY")).toBe(late.reads.length - 1);
    expect(new Set(late.reads.slice(0, -1))).toEqual(new Set(CONFIG_KEYS));
  });

  it("the configuration is parsed once per route instance (the deployment environment does not change while it runs)", async () => {
    const { environment, reads } = recordingEnvironment(ENV);
    const handle = handler({ environment, fetcher: deepseek() });
    await handle(post());
    await handle(post());
    for (const key of CONFIG_KEYS) expect(reads.filter((read) => read === key), key).toHaveLength(1);
    expect(reads.filter((read) => read === "DEEPSEEK_API_KEY")).toHaveLength(2);
  });

  it("the route contract: REFUSED always carries the not-sent marker and one closed audit-only reason, never usage", () => {
    expect([...AI_SHELL_ROUTE_REFUSAL_REASONS]).toEqual(["REQUEST_CLASS_NOT_QUALIFIED", "REMOTE_AI_DISABLED", "ORIGIN_REJECTED", "ACCESS_DENIED", "SPEND_NOT_CONFIGURED", "SPEND_CEILING_REACHED", "SPEND_LEDGER_UNAVAILABLE"]);
    for (const reason of AI_SHELL_ROUTE_REFUSAL_REASONS) {
      expect((AI_AUDIT_ONLY_OUTCOME_CODES as readonly string[]).includes(reason), reason).toBe(true);
      expect((AI_REASON_CODES as readonly string[]).includes(reason), reason).toBe(false);
      expect((PROVIDER_FAILURE_REASONS as readonly string[]).includes(reason), reason).toBe(false);
      expect(aiShellRouteResponseSchema.safeParse(refused(reason)).success, reason).toBe(true);
      expect(aiShellRouteResponseSchema.safeParse({ kind: "REFUSED", reason }).success, reason).toBe(false);
      expect(aiShellRouteResponseSchema.safeParse({ kind: "REFUSED", reason, notSentToProvider: false }).success, reason).toBe(false);
      expect(aiShellRouteResponseSchema.safeParse({ ...refused(reason), usage: { inputTokens: 1, outputTokens: 1, costMicroUsd: 1, basis: "REPORTED" } }).success, reason).toBe(false);
      expect(aiShellRouteResponseSchema.safeParse({ kind: "FAILED", reason }).success, reason).toBe(false);
    }
  });
});

describe("C6 spend settlement (owner rule: commit reported usage; transmitted without usage commits the full upper bound; release only the unused part; never transmitted releases all)", () => {
  it("a completed call commits its reported cost; the rest of the reservation is released", async () => {
    const spy = spyLedger();
    expect(await (await handler({ spendLedger: spy.ledger, fetcher: deepseek() })(post())).json()).toMatchObject({ kind: "CANDIDATE" });
    expect(spy.log).toEqual([["reserve", UPPER], ["commit", REPORTED_COST, "REPORTED"]]);
  });

  it("a billed response refused for retention commits its reported cost", async () => {
    const spy = spyLedger();
    expect(await (await handler({ spendLedger: spy.ledger, fetcher: deepseek(200, { store: true }) })(post())).json()).toMatchObject({ kind: "FAILED", usage: { basis: "REPORTED" } });
    expect(spy.log).toEqual([["reserve", UPPER], ["commit", REPORTED_COST, "REPORTED"]]);
  });

  it.each<[string, () => ReturnType<typeof vi.fn>]>([
    ["provider HTTP 500 (usage unreadable)", () => deepseek(500)],
    ["provider HTTP 429", () => deepseek(429)],
    ["a transport failure after the call started", () => vi.fn(async (_url: string, _init: RequestInit): Promise<Response> => Promise.reject(new Error("offline")))],
  ])("%s commits the full reserved upper bound (never zero)", async (_label, make) => {
    const spy = spyLedger();
    const body = await (await handler({ spendLedger: spy.ledger, fetcher: make() })(post())).json();
    expect(body).toMatchObject({ kind: "FAILED", usage: { basis: "UPPER_BOUND" } });
    expect(spy.log).toEqual([["reserve", UPPER], ["commit", UPPER, "UPPER_BOUND"]]);
  });

  it("a timeout after the call started commits the full upper bound", async () => {
    vi.useFakeTimers();
    const spy = spyLedger();
    const pending = handler({ spendLedger: spy.ledger, fetcher: vi.fn((_url: string, _init: RequestInit) => new Promise<Response>(() => undefined)) })(post());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await (await pending).json()).toMatchObject({ kind: "FAILED", reason: "PROVIDER_TIMEOUT" });
    expect(spy.log).toEqual([["reserve", UPPER], ["commit", UPPER, "UPPER_BOUND"]]);
  });

  it("never transmitted releases the whole reservation: missing credential, the rate limit, a request cancelled before the call", async () => {
    const missing = spyLedger();
    expect(await (await handler({ spendLedger: missing.ledger, environment: { ...TEST_DEPLOYMENT_ENVIRONMENT } })(post())).json()).toEqual({ kind: "FAILED", reason: "MISSING_CONFIGURATION", notSentToProvider: true });
    expect(missing.log).toEqual([["reserve", UPPER], ["release"]]);

    const limited = spyLedger();
    const handle = handler({ spendLedger: limited.ledger, fetcher: deepseek(), rateLimit: { maxRequests: 1, windowMs: 60_000 }, now: () => new Date("2026-10-08T01:00:00.000Z") });
    await handle(post());
    expect(await (await handle(post())).json()).toEqual({ kind: "FAILED", reason: "PROVIDER_RATE_LIMITED", notSentToProvider: true });
    expect(limited.log).toEqual([["reserve", UPPER], ["commit", REPORTED_COST, "REPORTED"], ["reserve", UPPER], ["release"]]);

    const cancelled = spyLedger();
    const controller = new AbortController();
    controller.abort();
    const fetcher = deepseek();
    expect(await (await handler({ spendLedger: cancelled.ledger, fetcher })(post(testBrowserHeaders(), shellRequest(), controller.signal))).json()).toEqual({ kind: "FAILED", reason: "REQUEST_CANCELLED", notSentToProvider: true });
    expect(fetcher).not.toHaveBeenCalled();
    expect(cancelled.log).toEqual([["reserve", UPPER], ["release"]]);
  });

  // Fix round 1 (review item 5): the remaining settlement paths.
  it("a STRUCTURALLY_REJECTED answer (a completed, billed call) commits its reported cost", async () => {
    const spy = spyLedger();
    const malformed = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify(envelope(`${JSON.stringify(VALID)}}`)), { status: 200, headers: { "content-type": "application/json" } }));
    expect(await (await handler({ spendLedger: spy.ledger, fetcher: malformed })(post())).json()).toMatchObject({ kind: "STRUCTURALLY_REJECTED" });
    expect(spy.log).toEqual([["reserve", UPPER], ["commit", REPORTED_COST, "REPORTED"]]);
  });

  it("a cancellation after the provider call started commits the full upper bound", async () => {
    const spy = spyLedger();
    const controller = new AbortController();
    const fetcher = vi.fn((_url: string, _init: RequestInit) => new Promise<Response>(() => undefined));
    const pending = handler({ spendLedger: spy.ledger, fetcher })(post(testBrowserHeaders(), shellRequest(), controller.signal));
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    controller.abort();
    expect(await (await pending).json()).toMatchObject({ kind: "FAILED", reason: "REQUEST_CANCELLED", usage: { basis: "UPPER_BOUND" } });
    expect(spy.log).toEqual([["reserve", UPPER], ["commit", UPPER, "UPPER_BOUND"]]);
  });

  it("an unexpected throw after the reservation (outside the bounded call) answers with the upper bound and commits it in full", async () => {
    const spy = spyLedger();
    // The credential read itself throws: the route cannot know what happened, so it counts conservatively.
    const environment = new Proxy({ ...ENV } as Record<string, string | undefined>, { get: (target, key) => { if (key === "DEEPSEEK_API_KEY") throw new Error("unreadable"); return target[String(key)]; } });
    const body = await (await handler({ spendLedger: spy.ledger, environment, fetcher: deepseek() })(post())).json();
    expect(body).toEqual({ kind: "FAILED", reason: "PROVIDER_FAILED", usage: { ...shellRouteCallUpperBound(shellRequest()) } });
    expect(spy.log).toEqual([["reserve", UPPER], ["commit", UPPER, "UPPER_BOUND"]]);
  });

  it("a settlement failure never changes the answer (best effort; the reservation stays held, which only over-counts)", async () => {
    const ledger: SpendLedger = { reserve: async () => ({ kind: "RESERVED", token: Object.freeze({}) as never }), commit: async () => { throw new Error("down"); }, release: async () => { throw new Error("down"); } };
    expect(await (await handler({ spendLedger: ledger, fetcher: deepseek() })(post())).json()).toMatchObject({ kind: "CANDIDATE" });
    expect(await (await handler({ spendLedger: ledger, environment: { ...TEST_DEPLOYMENT_ENVIRONMENT } })(post())).json()).toEqual({ kind: "FAILED", reason: "MISSING_CONFIGURATION", notSentToProvider: true });
  });

  it("concurrency within one instance: concurrent requests never reserve beyond the configured daily limit", async () => {
    const resolvers: Array<() => void> = [];
    let holding = true;
    const completed = () => new Response(JSON.stringify(envelope(JSON.stringify(VALID))), { status: 200, headers: { "content-type": "application/json" } });
    // The first calls are held in flight (their reservations stay held) until released; later calls answer at once.
    const fetcher = vi.fn((_url: string, _init: RequestInit) => (holding ? new Promise<Response>((resolve) => resolvers.push(() => resolve(completed()))) : Promise.resolve(completed())));
    const ledger = new InMemoryDailySpendLedger({ dailyLimitMicroUsd: 3 * UPPER });
    const handle = handler({ fetcher, spendLedger: ledger, environment: { ...ENV, JAGAON_AI_DAILY_SPEND_LIMIT_USD: usd(3 * UPPER) } });
    const pending = Array.from({ length: 8 }, () => handle(post()));
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    expect(ledger.snapshot(new Date()).heldMicroUsd).toBe(3 * UPPER);
    holding = false;
    resolvers.forEach((resolve) => resolve());
    const bodies = await Promise.all(pending.map(async (response) => (await response).json()));
    expect(bodies.filter((body) => body.kind === "CANDIDATE")).toHaveLength(3);
    expect(bodies.filter((body) => body.kind === "REFUSED")).toEqual(Array.from({ length: 5 }, () => refused("SPEND_CEILING_REACHED")));
    expect(fetcher).toHaveBeenCalledTimes(3);
    // Only the reported cost stays committed; the unused remainder is available again.
    expect(ledger.snapshot(new Date())).toMatchObject({ committedMicroUsd: 3 * REPORTED_COST, heldMicroUsd: 0 });
    expect(await (await handle(post())).json()).toMatchObject({ kind: "CANDIDATE" });
  });

  it("the default ledger is the in-memory daily guard over the configured limit (spent per instance, UTC day of the injected clock)", async () => {
    const env = { ...ENV, JAGAON_AI_DAILY_SPEND_LIMIT_USD: usd(UPPER + REPORTED_COST) };
    let now = new Date("2026-10-08T23:00:00.000Z");
    const handle = handler({ environment: env, fetcher: deepseek(), now: () => now });
    expect(await (await handle(post())).json()).toMatchObject({ kind: "CANDIDATE" });
    // Committed REPORTED_COST + a new UPPER fits exactly; a third does not.
    expect(await (await handle(post())).json()).toMatchObject({ kind: "CANDIDATE" });
    expect(await (await handle(post())).json()).toEqual(refused("SPEND_CEILING_REACHED"));
    now = new Date("2026-10-09T00:00:00.000Z");
    expect(await (await handle(post())).json()).toMatchObject({ kind: "CANDIDATE" });
  });
});

/**
 * C6 fix round 1 (review item 1; brief item 5 and the C5 carry): every FAILED decided before the provider call carries the explicit
 * `notSentToProvider: true` marker (never together with usage), so the browser records it with zero attempts and usage basis NONE. A
 * FAILED after the call started keeps the C5 accounting (usage, no marker).
 */
describe("C6 fix round 1: pre-call FAILED answers are marked not sent to the provider", () => {
  const notSent = (reason: string) => ({ kind: "FAILED", reason, notSentToProvider: true });
  it.each<[string, () => Promise<Response>, number, string]>([
    ["server activation (shipped manifest)", () => handler({ activationManifest: AI_ACTIVATION_MANIFEST })(post()), 200, "TASK_DISABLED"],
    ["another release profile", () => handler({ releaseProfile: "PRODUCTION" })(post()), 200, "PROFILE_NOT_PERMITTED"],
    ["a missing credential", () => handler({ environment: { ...TEST_DEPLOYMENT_ENVIRONMENT } })(post()), 200, "MISSING_CONFIGURATION"],
    ["a request cancelled before the call", () => { const c = new AbortController(); c.abort(); return handler({ fetcher: deepseek() })(post(testBrowserHeaders(), shellRequest(), c.signal)); }, 200, "REQUEST_CANCELLED"],
    ["a malformed body", () => handler()(post(testBrowserHeaders(), { nope: true })), 400, "PAYLOAD_INVALID"],
    // Owner decision 2026-10-12 (optional passcodes; deliberate change): GET is now the passcode probe; another method stays 405.
    ["a DELETE", () => handler()(new Request("http://localhost/api/ai/shell", { method: "DELETE" })), 405, "PAYLOAD_INVALID"],
  ])("%s: FAILED with the not-sent marker and no usage", async (_label, run, status, reason) => {
    const response = await run();
    const body = await response.json();
    expect([response.status, body]).toEqual([status, notSent(reason)]);
    expect(aiShellRouteResponseSchema.safeParse(body).success).toBe(true);
  });

  it("the rate limit: FAILED PROVIDER_RATE_LIMITED with the not-sent marker", async () => {
    const handle = handler({ fetcher: deepseek(), rateLimit: { maxRequests: 1, windowMs: 60_000 }, now: () => new Date("2026-10-08T01:00:00.000Z") });
    await handle(post());
    expect(await (await handle(post())).json()).toEqual(notSent("PROVIDER_RATE_LIMITED"));
  });

  it("an answer after transmission (provider HTTP 500 or 429) keeps its usage and is never marked not sent", async () => {
    for (const status of [500, 429]) {
      const body = await (await handler({ fetcher: deepseek(status) })(post())).json();
      expect(body).toMatchObject({ kind: "FAILED", usage: { basis: "UPPER_BOUND" } });
      expect(body).not.toHaveProperty("notSentToProvider");
    }
  });

  it("the contract: the marker is `true` only, and never together with usage", () => {
    const usage = { inputTokens: 1, outputTokens: 1, costMicroUsd: 1, basis: "UPPER_BOUND" };
    expect(aiShellRouteResponseSchema.safeParse(notSent("PROVIDER_TIMEOUT")).success).toBe(true);
    expect(aiShellRouteResponseSchema.safeParse({ ...notSent("PROVIDER_TIMEOUT"), usage }).success).toBe(false);
    expect(aiShellRouteResponseSchema.safeParse({ ...notSent("PROVIDER_FAILED"), usage: { ...usage, basis: "REPORTED" } }).success).toBe(false);
    expect(aiShellRouteResponseSchema.safeParse({ kind: "FAILED", reason: "TASK_DISABLED", notSentToProvider: false }).success).toBe(false);
    expect(aiShellRouteResponseSchema.safeParse({ kind: "FAILED", reason: "PROVIDER_FAILED", usage }).success).toBe(true);
  });
});

describe("C6 passcode and rate limit", () => {
  it("the passcode is never echoed in a response or logged", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
    const WRONG = "WRONG-passcode-sentinel";
    const responses = [
      await handler({ fetcher: deepseek() })(post()),
      await handler({ fetcher: deepseek() })(post(testBrowserHeaders(WRONG))),
      await handler({ fetcher: deepseek(500) })(post()),
      await handler({ environment: { ...ENV, JAGAON_REMOTE_AI: "off" } })(post()),
      await handler({ requestClassGate: undefined })(post()),
    ];
    for (const response of responses) {
      const text = `${JSON.stringify([...response.headers.entries()])}${await response.text()}`;
      expect(text).not.toContain(TEST_PASSCODE);
      expect(text).not.toContain(WRONG);
      expect(text).not.toContain(TOKEN);
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    for (const file of ["ai-shell-handler.ts", "ai-shell-deployment-config.ts", "ai-spend-ledger.ts"]) {
      expect(readFileSync(join(process.cwd(), "src/app/api/ai/shell", file), "utf8"), file).not.toMatch(/console\.|process\.env/);
    }
  });

  it("the passcode comparison is constant-time over equal-length digests", () => {
    const source = readFileSync(join(process.cwd(), "src/app/api/ai/shell/ai-shell-deployment-config.ts"), "utf8");
    expect(source).toMatch(/import \{[^}]*timingSafeEqual[^}]*\} from "node:crypto"/);
    expect(source).toMatch(/timingSafeEqual\(/);
    expect(source).toMatch(/createHash\("sha256"\)/);
  });

  it("the rate limit is unchanged: 10 requests per minute per instance, after the credential read", async () => {
    const source = readFileSync(join(process.cwd(), "src/app/api/ai/shell/ai-shell-handler.ts"), "utf8");
    expect(source).toContain("const DEFAULT_RATE_LIMIT = Object.freeze({ maxRequests: 10, windowMs: 60_000 });");
    const fetcher = deepseek();
    const handle = handler({ fetcher, now: () => new Date("2026-10-08T01:00:00.000Z") });
    const bodies = [];
    for (let index = 0; index < 11; index += 1) bodies.push(await (await handle(post())).json());
    expect(bodies.slice(0, 10).every((body) => body.kind === "CANDIDATE")).toBe(true);
    expect(bodies[10]).toEqual({ kind: "FAILED", reason: "PROVIDER_RATE_LIMITED", notSentToProvider: true });
    expect(fetcher).toHaveBeenCalledTimes(10);
  });
});

/**
 * Owner decision 2026-10-12 (optional passcodes): "when JAGAON_AI_DEMO_PASSCODE or JAGAON_VOICE_DEMO_PASSCODE is empty or missing, no
 * passcode is asked". With none configured (missing, empty or whitespace-only) access is granted without a passcode; the switch, origin,
 * activation, qualification, spend reservation, rate limit and the order of checks are unchanged. A present but invalid passcode keeps
 * the fail-closed behaviour (ACCESS_DENIED for every request).
 */
describe("optional AI passcode (Owner decision 2026-10-12, optional passcodes)", () => {
  const NONE = [undefined, "", " ", "  \t "];

  it("configuration: missing, empty or whitespace-only → not required; valid → required with its digest; invalid → required, no digest", () => {
    for (const value of NONE) expect(parseAiShellDeploymentConfig({ JAGAON_AI_DEMO_PASSCODE: value }), JSON.stringify(value)).toMatchObject({ passcodeRequired: false, passcodeDigest: null });
    const valid = parseAiShellDeploymentConfig({ JAGAON_AI_DEMO_PASSCODE: TEST_PASSCODE });
    expect(valid.passcodeRequired).toBe(true);
    expect(valid.passcodeDigest?.byteLength).toBe(32);
    for (const value of ["short7c", "has space inside", " padded-passcode", "x".repeat(129), "pässcode-unicode"]) {
      expect(parseAiShellDeploymentConfig({ JAGAON_AI_DEMO_PASSCODE: value }), value).toMatchObject({ passcodeRequired: true, passcodeDigest: null });
    }
    expect(Object.isFrozen(parseAiShellDeploymentConfig({}))).toBe(true);
  });

  it("no passcode configured: a request without the header reaches the provider; one call, the reservation first, the credential read last", async () => {
    for (const value of NONE) {
      const fetcher = deepseek();
      const spy = spyLedger();
      const { environment, reads } = recordingEnvironment({ ...ENV, JAGAON_AI_DEMO_PASSCODE: value });
      const response = await handler({ environment, fetcher, spendLedger: spy.ledger })(post(testBrowserHeaders(null)));
      expect(await response.json(), JSON.stringify(value)).toMatchObject({ kind: "CANDIDATE" });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(spy.log[0]).toEqual(["reserve", UPPER]);
      expect(reads.indexOf("DEEPSEEK_API_KEY")).toBe(reads.length - 1);
    }
    // A stray header is not needed, not compared and never echoed.
    const stray = await handler({ environment: { ...ENV, JAGAON_AI_DEMO_PASSCODE: undefined }, fetcher: deepseek() })(post(testBrowserHeaders("STRAY-header-sentinel")));
    expect(await stray.text()).not.toContain("STRAY-header-sentinel");
  });

  it("no passcode configured: switch, origin, activation, class, spend and rate limit still refuse in the same order, before the credential read", async () => {
    const env = { ...ENV, JAGAON_AI_DEMO_PASSCODE: undefined };
    const noHeader = testBrowserHeaders(null);
    const cases: Array<[string, Options, Record<string, string>, unknown]> = [
      ["switch off", { environment: { ...env, JAGAON_REMOTE_AI: "off" } }, noHeader, refused("REMOTE_AI_DISABLED")],
      ["foreign origin", { environment: env }, { ...noHeader, Origin: "https://elsewhere.example" }, refused("ORIGIN_REJECTED")],
      ["cross-site", { environment: env }, { ...noHeader, "Sec-Fetch-Site": "cross-site" }, refused("ORIGIN_REJECTED")],
      ["not activated (shipped manifest)", { environment: env, activationManifest: AI_ACTIVATION_MANIFEST }, noHeader, { kind: "FAILED", reason: "TASK_DISABLED", notSentToProvider: true }],
      ["not qualified (shipped records)", { environment: env, requestClassGate: undefined }, noHeader, refused("REQUEST_CLASS_NOT_QUALIFIED")],
      ["no daily limit", { environment: { ...env, JAGAON_AI_DAILY_SPEND_LIMIT_USD: undefined } }, noHeader, refused("SPEND_NOT_CONFIGURED")],
      ["daily limit reached", { environment: { ...env, JAGAON_AI_DAILY_SPEND_LIMIT_USD: usd(UPPER - 1) } }, noHeader, refused("SPEND_CEILING_REACHED")],
    ];
    for (const [label, options, headers, expected] of cases) {
      const fetcher = deepseek();
      const { environment, reads } = recordingEnvironment((options.environment ?? env) as Record<string, string | undefined>);
      const response = await handler({ ...options, environment, fetcher })(post(headers));
      expect(await response.json(), label).toEqual(expected);
      expect(reads, label).not.toContain("DEEPSEEK_API_KEY");
      expect(fetcher, label).not.toHaveBeenCalled();
    }
    // The rate limit is unchanged.
    const fetcher = deepseek();
    const handle = handler({ environment: env, fetcher, now: () => new Date("2026-10-12T01:00:00.000Z") });
    const bodies = [];
    for (let index = 0; index < 11; index += 1) bodies.push(await (await handle(post(noHeader))).json());
    expect(bodies[10]).toEqual({ kind: "FAILED", reason: "PROVIDER_RATE_LIMITED", notSentToProvider: true });
    expect(fetcher).toHaveBeenCalledTimes(10);
  });

  it("a configured passcode is still required (none or a wrong one: ACCESS_DENIED, nothing read or sent)", async () => {
    for (const headers of [testBrowserHeaders(null), testBrowserHeaders("TEST-ONLY-wrong")]) {
      const fetcher = deepseek();
      const { environment, reads } = recordingEnvironment(ENV);
      expect(await (await handler({ environment, fetcher })(post(headers))).json()).toEqual(refused("ACCESS_DENIED"));
      expect(reads).not.toContain("DEEPSEEK_API_KEY");
      expect(fetcher).not.toHaveBeenCalled();
    }
  });

  describe("GET /api/ai/shell: the passcode probe ({ passcodeRequired } only)", () => {
    const probe = (headers: Record<string, string> = { "Sec-Fetch-Site": "same-origin" }) => new Request("http://localhost/api/ai/shell", { method: "GET", headers });
    const answer = async (response: Response) => {
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      return [response.status, await response.json()] as const;
    };

    it("answers whether a passcode is required, reading only the passcode variable (never the credential, nothing else)", async () => {
      for (const value of NONE) {
        const { environment, reads } = recordingEnvironment({ ...ENV, JAGAON_AI_DEMO_PASSCODE: value });
        const fetcher = deepseek();
        expect(await answer(await handler({ environment, fetcher })(probe())), JSON.stringify(value)).toEqual([200, { passcodeRequired: false }]);
        expect(reads).not.toContain("DEEPSEEK_API_KEY");
        expect(fetcher).not.toHaveBeenCalled();
      }
      const configured = await handler()(probe({}));
      const text = await configured.clone().text();
      expect(await answer(configured)).toEqual([200, { passcodeRequired: true }]);
      expect(text).not.toContain(TEST_PASSCODE);
      expect(text).not.toContain(TOKEN);
      // A present but invalid passcode: required (every request is refused anyway).
      expect(await answer(await handler({ environment: { ...ENV, JAGAON_AI_DEMO_PASSCODE: "short" } })(probe()))).toEqual([200, { passcodeRequired: true }]);
      // Nothing else is revealed: the switch, origins, limit or activation do not change the answer's shape.
      expect(await answer(await handler({ environment: { JAGAON_AI_DEMO_PASSCODE: undefined }, activationManifest: AI_ACTIVATION_MANIFEST })(probe()))).toEqual([200, { passcodeRequired: false }]);
    });

    it("a request the browser marks cross-site gets the conservative answer; its own per-instance window (429); other methods unchanged", async () => {
      const env = { ...ENV, JAGAON_AI_DEMO_PASSCODE: undefined };
      expect(await answer(await handler({ environment: env })(probe({ "Sec-Fetch-Site": "cross-site" })))).toEqual([200, { passcodeRequired: true }]);
      const rated = handler({ environment: env, rateLimit: { maxRequests: 2, windowMs: 60_000 }, fetcher: deepseek() });
      expect((await answer(await rated(probe())))[0]).toBe(200);
      expect((await answer(await rated(probe())))[0]).toBe(200);
      expect(await answer(await rated(probe()))).toEqual([429, { passcodeRequired: true }]);
      // The probe does not use the provider-call window: a POST is still answered.
      expect(await (await rated(post(testBrowserHeaders(null)))).json()).toMatchObject({ kind: "CANDIDATE" });
      const put = await handler()(new Request("http://localhost/api/ai/shell", { method: "PUT" }));
      expect([put.status, await put.json()]).toEqual([405, { kind: "FAILED", reason: "PAYLOAD_INVALID", notSentToProvider: true }]);
    });

    it("the route module exports GET (the probe) next to POST", () => {
      const source = readFileSync(join(process.cwd(), "src/app/api/ai/shell/route.ts"), "utf8");
      expect(source).toMatch(/export async function GET\(request: Request\)/);
      expect(source).toMatch(/export async function POST\(request: Request\)/);
    });
  });
});

