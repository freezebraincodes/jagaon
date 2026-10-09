// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEEPSEEK_DOCUMENTED_MODELS, deepSeekCostMicroUsd } from "@/ai/deepseek/deepseek-catalogue";
import { plannedFixture, shellCandidate } from "@/ai/evaluation/packet-11-hybrid-test-support";
import { createAiShellHandler } from "@/app/api/ai/shell/ai-shell-handler";
import { aiInvocationAuditRowSchema, type AiInvocationAuditRow, type ShellFieldPath, type ShellTaskRequest } from "@/domain/ai";
import { requestFixture, sourceBackedRequest } from "@/domain/ai/ai-test-fixtures";
import { AI_ACTIVATION_MANIFEST, type AiActivationManifest } from "./ai-activation-manifest";
import { AI_HYBRID_RUNTIME_BUNDLES } from "./ai-hybrid-runtime-bundles";
import { createAiHybridTaskService } from "./ai-hybrid-task-service";
import { PROVIDER_FAILURE_REASONS, type ProviderInvocationResult } from "./ai-provider-port";
import { AI_TASK_RUNTIME_BUNDLES } from "./ai-runtime-bundles";
import { AI_SHELL_ROUTE_PATH, shellRouteCallUpperBound } from "./ai-shell-route-contract";
import * as client from "./browser-shell-client";
import { BROWSER_SHELL_CLIENT_PROVIDER_MODEL, createAiRemoteUseSession, createBrowserShellClient, INTERIM_FAIL_CLOSED_DISCLOSURE, type AiRemoteUseDisclosure, type BrowserShellFetcher } from "./browser-shell-client";
import { projectProviderTaskPayload } from "./detached-payload-projector";
import { projectShellTaskRequest } from "./language/shell-projector";
import { planSlots } from "./language/slot-planner";

/**
 * Packet 11C Addendum B, Task B2b: the browser shell client for POST /api/ai/shell (B-boundary, D1, D2, D6, interim disclosure rule).
 * Fake fetchers only; no live call. Activated behaviour is exercised only with an injected test manifest, a test-only accepting
 * disclosure and a fake fetcher (or the real route handler over a fake DeepSeek transport).
 */

const EN = plannedFixture("p11.explain-pattern.en-sg.ordinary");
const CARE = plannedFixture("p11.draft-care-preparation-summary.en-sg.ordinary");
const REQUEST = (): ShellTaskRequest => structuredClone(projectShellTaskRequest(EN.plan)) as ShellTaskRequest;
const VALID = shellCandidate(EN.plan, new Map<ShellFieldPath, string>([["headline", "A look at {{S1}}."], ["evidence", "This is based on {{S3}}."]]));
const USAGE = { inputTokens: 600, outputTokens: 80, costMicroUsd: 5 };
const ENABLED: AiActivationManifest = { ...AI_ACTIVATION_MANIFEST, tasks: { ...AI_ACTIVATION_MANIFEST.tasks, EXPLAIN_PATTERN: "SYNTHETIC_REMOTE_ENABLED", DRAFT_CARE_PREPARATION_SUMMARY: "SYNTHETIC_REMOTE_ENABLED" } };
/** Test-only. In production a disclosure accepts only through the session, after the patient accepted the dialog (B3). */
const ACCEPTED: AiRemoteUseDisclosure = { decide: async () => "ACCEPTED" };
const SENTINEL = "SENTINEL-technical-detail";

const json = (body: unknown, status = 200, contentType = "application/json; charset=utf-8") => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": contentType } });
const answering = (respond: () => Response | Promise<Response>) => vi.fn<BrowserShellFetcher>(async () => respond());
const signal = () => new AbortController().signal;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("browser shell client: identity and module surface", () => {
  it("exports exactly the client factory, the frozen route identity, the interim fail-closed disclosure and the session disclosure (B3)", () => {
    expect(Object.keys(client).sort()).toEqual(["BROWSER_SHELL_CLIENT_PROVIDER_MODEL", "INTERIM_FAIL_CLOSED_DISCLOSURE", "createAiRemoteUseSession", "createBrowserShellClient"]);
  });

  it("B3: exposes its disclosure as the port's remoteUse, so the hybrid service decides it before the first attempt", () => {
    const session = createAiRemoteUseSession();
    expect(createBrowserShellClient({ disclosure: session.disclosure, fetcher: answering(() => json({})) }).remoteUse).toBe(session.disclosure);
    expect(createBrowserShellClient({ disclosure: INTERIM_FAIL_CLOSED_DISCLOSURE }).remoteUse).toBe(INTERIM_FAIL_CLOSED_DISCLOSURE);
  });

  it("names the D2 route identity (Direct DeepSeek deepseek-flash) for the local audit only, frozen; runtime bundles keep no model pin", () => {
    expect(BROWSER_SHELL_CLIENT_PROVIDER_MODEL).toEqual({ providerKey: "deepseek", modelSnapshot: "deepseek-flash" });
    expect(Object.isFrozen(BROWSER_SHELL_CLIENT_PROVIDER_MODEL)).toBe(true);
    // The same identity the server route's documented deepseek-flash model reports (the route's own constant is server-only).
    const documented = DEEPSEEK_DOCUMENTED_MODELS.find((model) => model.requestModelId === "deepseek-flash")!;
    expect(BROWSER_SHELL_CLIENT_PROVIDER_MODEL.modelSnapshot).toBe(documented.responseModelSnapshot);
    expect(createBrowserShellClient({ disclosure: INTERIM_FAIL_CLOSED_DISCLOSURE, fetcher: answering(() => json({})) }).providerModel).toBe(BROWSER_SHELL_CLIENT_PROVIDER_MODEL);
    for (const bundle of [...Object.values(AI_HYBRID_RUNTIME_BUNDLES), ...Object.values(AI_TASK_RUNTIME_BUNDLES)]) expect(bundle.modelSnapshot).toBeNull();
  });

  it("carries no credential, endpoint, environment read, prompt or provider configuration; one POST call site to the relative route path", () => {
    const source = readFileSync(join(process.cwd(), "src/application/ai/browser-shell-client.ts"), "utf8");
    expect(source).not.toMatch(/process\.env|import\.meta\.env|NEXT_PUBLIC_|API_KEY|Bearer|authorization|https?:\/\/|deepseek\.com|api\.kie|@\/ai\/|@\/app\/|prompt|instructions|temperature|max_output_tokens|"model"|projectProviderTaskPayload|detached-payload-projector/i);
    expect(source.match(/\bfetch\s*\(/g)).toHaveLength(1);
    expect(AI_SHELL_ROUTE_PATH).toBe("/api/ai/shell");
  });
});

describe("interim disclosure rule: remote use fails closed without an accepted disclosure", () => {
  it("the interim gate always answers NOT_ACCEPTED", async () => {
    expect(await INTERIM_FAIL_CLOSED_DISCLOSURE.decide(signal())).toBe("NOT_ACCEPTED");
    expect(Object.isFrozen(INTERIM_FAIL_CLOSED_DISCLOSURE)).toBe(true);
  });

  it.each<[string, AiRemoteUseDisclosure]>([
    ["the interim fail-closed gate", INTERIM_FAIL_CLOSED_DISCLOSURE],
    ["a gate that throws", { decide: async () => Promise.reject(new Error(SENTINEL)) }],
    ["a gate that throws synchronously", { decide: () => { throw new Error(SENTINEL); } }],
    ["a gate with an unknown answer", { decide: async () => "accepted" as never }],
    ["a gate that answers true", { decide: async () => true as never }],
  ])("%s: a closed FAILED result with no POST and no technical text", async (_label, disclosure) => {
    const fetcher = answering(() => json({ kind: "CANDIDATE", candidate: VALID, retention: "CONFIRMED_NOT_STORED", usage: USAGE }));
    const result = await createBrowserShellClient({ disclosure, fetcher }).invoke(REQUEST(), signal());
    expect(result).toEqual({ kind: "FAILED", reason: "MISSING_CONFIGURATION" });
    expect(PROVIDER_FAILURE_REASONS).toContain(result.kind === "FAILED" ? result.reason : null);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("a pending disclosure is abandoned on abort: no POST, the gate sees the same signal", async () => {
    const controller = new AbortController();
    const decide = vi.fn<AiRemoteUseDisclosure["decide"]>(() => new Promise(() => undefined));
    const fetcher = answering(() => json({}));
    const pending = createBrowserShellClient({ disclosure: { decide }, fetcher }).invoke(REQUEST(), controller.signal);
    await Promise.resolve();
    controller.abort();
    expect((await pending).kind).toBe("FAILED");
    expect(decide.mock.calls[0]![0]).toBe(controller.signal);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("a disclosure accepted after the request was aborted never POSTs", async () => {
    const controller = new AbortController();
    const fetcher = answering(() => json({}));
    const disclosure: AiRemoteUseDisclosure = { decide: async () => (controller.abort(), "ACCEPTED") };
    expect((await createBrowserShellClient({ disclosure, fetcher }).invoke(REQUEST(), controller.signal)).kind).toBe("FAILED");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("is asked before every POST (the repair attempt too), and only after the request passed the client-side checks", async () => {
    const decide = vi.fn<AiRemoteUseDisclosure["decide"]>(async () => "ACCEPTED");
    const fetcher = answering(() => json({ kind: "STRUCTURALLY_REJECTED", reason: "SCHEMA_INVALID", repairable: true, retention: "CONFIRMED_NOT_STORED", usage: USAGE }));
    const shell = createBrowserShellClient({ disclosure: { decide }, fetcher });
    await shell.invoke(REQUEST(), signal());
    await shell.invoke(REQUEST(), signal());
    expect(decide).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await shell.invoke({ ...REQUEST(), facts: [] } as never, signal());
    expect(decide).toHaveBeenCalledTimes(2);
  });
});

/**
 * Packet 11C Addendum B, Task B3 (coordinator ruling: once per app session): the session disclosure. It is in memory only (never
 * persisted, so a reload starts a new session), answers NOT_ACCEPTED until the patient accepts the disclosure dialog, and ACCEPTED for
 * the rest of that session, immediately, without asking again (the repair attempt included).
 */
describe("session disclosure (Packet 11C B3)", () => {
  it("answers NOT_ACCEPTED until accept(), then ACCEPTED for the rest of the session", async () => {
    const session = createAiRemoteUseSession();
    expect(session.accepted()).toBe(false);
    expect(await session.disclosure.decide(signal())).toBe("NOT_ACCEPTED");
    session.accept();
    expect(session.accepted()).toBe(true);
    expect(await session.disclosure.decide(signal())).toBe("ACCEPTED");
    session.accept();
    expect(await session.disclosure.decide(signal())).toBe("ACCEPTED");
  });

  it("each session is independent (a new app session, e.g. after a reload, starts not accepted) and the surface is frozen", async () => {
    const first = createAiRemoteUseSession();
    first.accept();
    const second = createAiRemoteUseSession();
    expect(second.accepted()).toBe(false);
    expect(await second.disclosure.decide(signal())).toBe("NOT_ACCEPTED");
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.disclosure)).toBe(true);
    expect(Object.keys(first).sort()).toEqual(["accept", "accepted", "disclosure"]);
  });

  it("is never persisted: the module touches no storage", () => {
    const source = readFileSync(join(process.cwd(), "src/application/ai/browser-shell-client.ts"), "utf8");
    expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|Dexie/);
  });

  it("gates the client: no POST before acceptance, a POST after it (asked again before every POST, answered without asking the patient)", async () => {
    const session = createAiRemoteUseSession();
    const fetcher = answering(() => json({ kind: "CANDIDATE", candidate: VALID, retention: "CONFIRMED_NOT_STORED", usage: USAGE }));
    const shell = createBrowserShellClient({ disclosure: session.disclosure, fetcher });
    expect(await shell.invoke(REQUEST(), signal())).toEqual({ kind: "FAILED", reason: "MISSING_CONFIGURATION" });
    expect(fetcher).not.toHaveBeenCalled();
    session.accept();
    expect((await shell.invoke(REQUEST(), signal())).kind).toBe("COMPLETED");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("Packet 11C B4a: a DECLINED answer never POSTs either (only an explicit ACCEPTED sends)", async () => {
    const fetcher = answering(() => json({ kind: "CANDIDATE", candidate: VALID, retention: "CONFIRMED_NOT_STORED", usage: USAGE }));
    const shell = createBrowserShellClient({ disclosure: { decide: async () => "DECLINED" }, fetcher });
    expect(await shell.invoke(REQUEST(), signal())).toEqual({ kind: "FAILED", reason: "MISSING_CONFIGURATION" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("the POST: only a validated value-blind ShellTaskRequest", () => {
  it("POSTs the strictly parsed approved request to the relative route path, no-store, no redirect, with the caller's signal", async () => {
    const fetcher = answering(() => json({ kind: "CANDIDATE", candidate: VALID, retention: "CONFIRMED_NOT_STORED", usage: USAGE }));
    const controller = new AbortController();
    const request = REQUEST();
    const result = await createBrowserShellClient({ disclosure: ACCEPTED, fetcher }).invoke(request, controller.signal);
    expect(result).toEqual({ kind: "COMPLETED", candidate: VALID, usage: USAGE, retention: "CONFIRMED_NOT_STORED" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(AI_SHELL_ROUTE_PATH);
    expect(init).toEqual({ method: "POST", headers: { "content-type": "application/json" }, body: init.body, cache: "no-store", redirect: "error", signal: controller.signal });
    expect(JSON.parse(init.body as string)).toEqual(request);
    expect(Object.keys(JSON.parse(init.body as string)).sort()).toEqual(Object.keys(request).sort());
  });

  it("POSTs the care request and the source-backed EXPLAIN request unchanged (value-blind: no binding, fact or reference)", async () => {
    const planned = planSlots(sourceBackedRequest() as never, AI_HYBRID_RUNTIME_BUNDLES.EXPLAIN_PATTERN);
    if (planned.kind !== "PLANNED") throw new Error("source-backed");
    for (const request of [projectShellTaskRequest(CARE.plan), projectShellTaskRequest(planned.plan)]) {
      const fetcher = answering(() => json({ kind: "FAILED", reason: "TASK_DISABLED" }));
      await createBrowserShellClient({ disclosure: ACCEPTED, fetcher }).invoke(request, signal());
      const body = fetcher.mock.calls[0]![1].body as string;
      expect(JSON.parse(body)).toEqual(request);
      expect(body).not.toMatch(/periodSummary|facts|sources|boundRefs|sectionRef|revisionId|recordId|\d{4}-\d{2}-\d{2}|mmol/i);
    }
  });

  const legacyDetached = () => {
    const projected = projectProviderTaskPayload(requestFixture("EXPLAIN_PATTERN"), AI_TASK_RUNTIME_BUNDLES.EXPLAIN_PATTERN);
    if (projected.kind !== "PROJECTED") throw new Error(projected.reason);
    return projected.payload;
  };
  const BINDING = (sourceBackedRequest().taskPayload as { periodSummary: unknown }).periodSummary;
  const mutate = (change: (request: any) => void) => () => {
    const request = REQUEST() as any;
    change(request);
    return request;
  };
  it.each<[string, () => unknown]>([
    ["legacy detached-projector output", legacyDetached],
    ["the whole internal source-backed request", () => sourceBackedRequest()],
    ["raw facts", mutate((r) => (r.facts = legacyDetached().facts))],
    ["the periodSummary binding", mutate((r) => (r.periodSummary = BINDING))],
    ["a reading value in a gloss", mutate((r) => (r.slots[0].gloss = "the value 6.2 mmol/L"))],
    ["a date in a gloss", mutate((r) => (r.slots[0].gloss = "recorded on 2026-09-01"))],
    ["a slot source reference", mutate((r) => (r.slots[0].boundRefs = ["fact-1"]))],
    ["a PERIOD_SUMMARY slot", mutate((r) => (r.slots[0].atomKind = "PERIOD_SUMMARY"))],
    ["a caller-chosen model", mutate((r) => (r.model = "deepseek-pro"))],
    ["a prompt", mutate((r) => (r.prompt = "Tell me my diagnosis"))],
    ["an endpoint", mutate((r) => (r.endpoint = "https://example.com"))],
    ["null", () => null],
  ])("refuses %s client-side: closed FAILED, no disclosure asked, no POST", async (_label, body) => {
    const decide = vi.fn<AiRemoteUseDisclosure["decide"]>(async () => "ACCEPTED");
    const fetcher = answering(() => json({}));
    expect(await createBrowserShellClient({ disclosure: { decide }, fetcher }).invoke(body() as ShellTaskRequest, signal())).toEqual({ kind: "FAILED", reason: "PROVIDER_REJECTED" });
    expect(decide).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("the response: strictly parsed with the shared route contract, closed reasons only, no retries", () => {
  const invoke = async (response: () => Response | Promise<Response>) => {
    const fetcher = answering(response);
    const result = await createBrowserShellClient({ disclosure: ACCEPTED, fetcher }).invoke(REQUEST(), signal());
    expect(fetcher).toHaveBeenCalledTimes(1);
    return result;
  };

  it("maps a typed structural rejection (D6) and a FAILED response with its usage", async () => {
    expect(await invoke(() => json({ kind: "STRUCTURALLY_REJECTED", reason: "SCHEMA_INVALID", repairable: true, retention: "CONFIRMED_NOT_STORED", usage: USAGE }))).toEqual({ kind: "STRUCTURALLY_REJECTED", reason: "SCHEMA_INVALID", repairable: true, usage: USAGE, retention: "CONFIRMED_NOT_STORED" });
    // Packet 11C Addendum C (C5): a FAILED body's usage names its basis (reported, or the route's pre-send upper bound); passed on as is.
    expect(await invoke(() => json({ kind: "FAILED", reason: "PROVIDER_FAILED", usage: { ...USAGE, basis: "REPORTED" } }))).toEqual({ kind: "FAILED", reason: "PROVIDER_FAILED", usage: { ...USAGE, basis: "REPORTED" } });
    expect(await invoke(() => json({ kind: "FAILED", reason: "PROVIDER_TIMEOUT", usage: { ...USAGE, basis: "UPPER_BOUND" } }))).toEqual({ kind: "FAILED", reason: "PROVIDER_TIMEOUT", usage: { ...USAGE, basis: "UPPER_BOUND" } });
    // A FAILED the route decided before any provider call carries no usage: nothing was billed.
    expect(await invoke(() => json({ kind: "FAILED", reason: "PROVIDER_RATE_LIMITED" }))).toEqual({ kind: "FAILED", reason: "PROVIDER_RATE_LIMITED" });
  });

  it.each([["TASK_DISABLED"], ["PROFILE_NOT_PERMITTED"], ["PAYLOAD_INVALID"], ["REQUEST_CANCELLED"], ["BUDGET_EXCEEDED"]])("maps the route reason %s, which is not a provider failure reason, to PROVIDER_FAILED", async (reason) => {
    expect(await invoke(() => json({ kind: "FAILED", reason }))).toEqual({ kind: "FAILED", reason: "PROVIDER_FAILED" });
  });

  it.each<[string, () => Response, string]>([
    ["a 400 refusal", () => json({ kind: "FAILED", reason: "PAYLOAD_INVALID" }, 400), "PROVIDER_REJECTED"],
    ["a 413 refusal", () => json({ kind: "FAILED", reason: "BUDGET_EXCEEDED" }, 413), "PROVIDER_REJECTED"],
    ["a 429", () => json(SENTINEL, 429, "text/plain"), "PROVIDER_RATE_LIMITED"],
    ["a 500 page", () => json(`<html>${SENTINEL}</html>`, 500, "text/html"), "PROVIDER_FAILED"],
    ["a 502", () => json({ kind: "CANDIDATE", candidate: VALID, retention: "CONFIRMED_NOT_STORED", usage: USAGE }, 502), "PROVIDER_FAILED"],
    ["a non-JSON 200", () => json(`<html>${SENTINEL}</html>`, 200, "text/html"), "PROVIDER_FAILED"],
    ["a JSON body with a non-JSON content type", () => json({ kind: "FAILED", reason: "PROVIDER_FAILED" }, 200, "text/plain"), "PROVIDER_FAILED"],
    ["malformed JSON", () => json(`{"kind":"CANDIDATE"`), "PROVIDER_FAILED"],
    ["duplicate keys", () => json(`{"kind":"FAILED","kind":"CANDIDATE","reason":"PROVIDER_FAILED"}`), "PROVIDER_FAILED"],
    ["an unknown kind", () => json({ kind: "OK", candidate: VALID }), "PROVIDER_FAILED"],
    ["a candidate without retention", () => json({ kind: "CANDIDATE", candidate: VALID, usage: USAGE }), "PROVIDER_FAILED"],
    ["a candidate reported stored", () => json({ kind: "CANDIDATE", candidate: VALID, retention: "PROVIDER_REPORTED_STORED", usage: USAGE }), "PROVIDER_FAILED"],
    ["a candidate with provider detail", () => json({ kind: "CANDIDATE", candidate: VALID, retention: "CONFIRMED_NOT_STORED", usage: USAGE, model: "deepseek-flash", detail: SENTINEL }), "PROVIDER_FAILED"],
    ["a malformed candidate", () => json({ kind: "CANDIDATE", candidate: { ...VALID, note: SENTINEL }, retention: "CONFIRMED_NOT_STORED", usage: USAGE }), "PROVIDER_FAILED"],
    ["an unbounded usage", () => json({ kind: "CANDIDATE", candidate: VALID, retention: "CONFIRMED_NOT_STORED", usage: { ...USAGE, inputTokens: 1e9 } }), "PROVIDER_FAILED"],
    ["a FAILED with an unknown reason", () => json({ kind: "FAILED", reason: SENTINEL }), "PROVIDER_FAILED"],
    ["a FAILED with a diagnostic", () => json({ kind: "FAILED", reason: "PROVIDER_FAILED", diagnostic: SENTINEL }), "PROVIDER_FAILED"],
    ["an oversize body", () => json({ kind: "FAILED", reason: "PROVIDER_FAILED", padding: "x".repeat(70_000) }), "PROVIDER_FAILED"],
    ["a FAILED with usage but no basis", () => json({ kind: "FAILED", reason: "PROVIDER_FAILED", usage: USAGE }), "PROVIDER_FAILED"],
    ["a pre-call FAILED with usage", () => json({ kind: "FAILED", reason: "PAYLOAD_INVALID", usage: { ...USAGE, basis: "REPORTED" } }), "PROVIDER_FAILED"],
  ])("%s is a closed %s with no technical text", async (label, response, reason) => {
    const result = await invoke(response);
    // Packet 11C Addendum C (C5): a 4xx is the route's own refusal before any provider call (nothing billed, no usage). Any other answer
    // without a readable route usage followed a POST the route may have turned into a billed call: the client counts the request's
    // pre-send upper bound (basis UPPER_BOUND), never zero.
    const refusedByRoute = /\b4\d\d\b/.test(label);
    expect(result).toEqual(refusedByRoute ? { kind: "FAILED", reason } : { kind: "FAILED", reason, usage: shellRouteCallUpperBound(REQUEST()) });
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it.each<[string, BrowserShellFetcher]>([
    ["a network error", async () => Promise.reject(new TypeError(`Failed to fetch ${SENTINEL}`))],
    ["a synchronous throw", () => { throw new Error(SENTINEL); }],
    ["a body that cannot be read", async () => new Response(new ReadableStream({ start: (c) => c.error(new Error(SENTINEL)) }), { headers: { "content-type": "application/json" } })],
  ])("%s is a closed TRANSPORT_FAILED with the pre-send upper bound (C5), never retried", async (_label, fetcher) => {
    const spy = vi.fn(fetcher);
    const result = await createBrowserShellClient({ disclosure: ACCEPTED, fetcher: spy }).invoke(REQUEST(), signal());
    expect(result).toEqual({ kind: "FAILED", reason: "TRANSPORT_FAILED", usage: shellRouteCallUpperBound(REQUEST()) });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("C5: a request refused or not accepted before any POST carries no usage (nothing sent)", async () => {
    const fetcher = answering(() => json({}));
    expect(await createBrowserShellClient({ disclosure: INTERIM_FAIL_CLOSED_DISCLOSURE, fetcher }).invoke(REQUEST(), signal())).toEqual({ kind: "FAILED", reason: "MISSING_CONFIGURATION" });
    expect(await createBrowserShellClient({ disclosure: ACCEPTED, fetcher }).invoke({ ...REQUEST(), facts: [] } as never, signal())).toEqual({ kind: "FAILED", reason: "PROVIDER_REJECTED" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

/** The client inside the real hybrid service (the service owns the per-call timeout, cancellation and the single repair). */
describe("the client under the hybrid service", () => {
  function service(options: { manifest?: AiActivationManifest; disclosure?: AiRemoteUseDisclosure; fetcher: BrowserShellFetcher }) {
    const rows: AiInvocationAuditRow[] = [];
    const hybrid = createAiHybridTaskService({
      releaseProfile: "HACKATHON_DEMO",
      audit: { append: async (row) => void rows.push(row) },
      now: () => "2026-10-08T01:00:00.000Z",
      monotonicMs: () => 0,
      manifest: options.manifest ?? ENABLED,
      provider: createBrowserShellClient({ disclosure: options.disclosure ?? ACCEPTED, fetcher: options.fetcher }),
    });
    return { hybrid, rows };
  }

  it("the shipped manifest: deterministic, no disclosure asked, no POST, one audit row without a provider", async () => {
    const decide = vi.fn<AiRemoteUseDisclosure["decide"]>(async () => "ACCEPTED");
    const fetcher = answering(() => json({}));
    const run = service({ manifest: AI_ACTIVATION_MANIFEST, disclosure: { decide }, fetcher });
    expect(await run.hybrid.execute(EN.request)).toMatchObject({ kind: "COMPOSED", source: "DETERMINISTIC", mode: "NOT_ACTIVATED", reason: "TASK_DISABLED" });
    expect(decide).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(run.rows).toHaveLength(1);
    expect(run.rows[0]).toMatchObject({ outcomeCode: "TASK_DISABLED", providerModel: null, attempts: { count: 0 } });
  });

  it("activated (test manifest) with the interim gate: deterministic, never a POST, and the audit row records nothing sent (B3)", async () => {
    const fetcher = answering(() => json({ kind: "CANDIDATE", candidate: VALID, retention: "CONFIRMED_NOT_STORED", usage: USAGE }));
    const run = service({ disclosure: INTERIM_FAIL_CLOSED_DISCLOSURE, fetcher });
    expect(await run.hybrid.execute(EN.request)).toMatchObject({ kind: "COMPOSED", source: "DETERMINISTIC", mode: "REMOTE_NOT_ACCEPTED", reason: "MISSING_CONFIGURATION" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(run.rows).toHaveLength(1);
    expect(aiInvocationAuditRowSchema.safeParse(run.rows[0]).success).toBe(true);
    // Packet 11C B3 (B2b carry): the decision is made before the attempt is counted, so nothing is over-reported.
    expect(run.rows[0]).toMatchObject({ providerModel: null, attempts: { count: 0, structuralRepairUsed: false, timedOut: false }, sourceRevisions: [] });
    expect(run.rows[0]!.measurements).toMatchObject({ inputTokens: null, outputTokens: null, costMicroUsd: null });
  });

  it("B3: a session not yet accepted is decided before any POST with an honest audit row; once accepted, the repair attempt is not gated by a second ask", async () => {
    const session = createAiRemoteUseSession();
    const fetcher = answering(() => json({ kind: "CANDIDATE", candidate: VALID, retention: "CONFIRMED_NOT_STORED", usage: USAGE }));
    const declined = service({ disclosure: session.disclosure, fetcher });
    expect(await declined.hybrid.execute(EN.request)).toMatchObject({ source: "DETERMINISTIC", mode: "REMOTE_NOT_ACCEPTED" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(declined.rows[0]).toMatchObject({ providerModel: null, attempts: { count: 0 }, sourceRevisions: [] });
    session.accept();
    const repairing = answering(() => json({ kind: "STRUCTURALLY_REJECTED", reason: "SCHEMA_INVALID", repairable: true, retention: "CONFIRMED_NOT_STORED", usage: USAGE }));
    const accepted = service({ disclosure: session.disclosure, fetcher: repairing });
    expect(await accepted.hybrid.execute(EN.request)).toMatchObject({ source: "DETERMINISTIC", reason: "SCHEMA_INVALID" });
    expect(repairing).toHaveBeenCalledTimes(2);
    expect(accepted.rows[0]).toMatchObject({ providerModel: { providerKey: "deepseek" }, attempts: { count: 2, structuralRepairUsed: true } });
  });

  it("activated with an accepted disclosure and a fake route: the AI composition, the D2 identity in the audit row", async () => {
    const run = service({ fetcher: answering(() => json({ kind: "CANDIDATE", candidate: VALID, retention: "CONFIRMED_NOT_STORED", usage: USAGE })) });
    expect(await run.hybrid.execute(EN.request)).toMatchObject({ kind: "COMPOSED", source: "AI", mode: "REMOTE_AI", reason: null });
    expect(run.rows[0]).toMatchObject({ outcomeCode: "ACCEPTED", providerModel: { providerKey: "deepseek", modelSnapshot: "deepseek-flash" }, measurements: USAGE });
    expect(aiInvocationAuditRowSchema.safeParse(run.rows[0]).success).toBe(true);
  });

  it("a route FAILED that carries usage (a billed response refused for retention) is counted in the audit row", async () => {
    const run = service({ fetcher: answering(() => json({ kind: "FAILED", reason: "PROVIDER_FAILED", usage: { ...USAGE, basis: "REPORTED" } })) });
    expect(await run.hybrid.execute(EN.request)).toMatchObject({ source: "DETERMINISTIC", reason: "PROVIDER_FAILED" });
    expect(run.rows[0]!.measurements).toMatchObject(USAGE);
    expect(run.rows[0]).toMatchObject({ auditSchemaVersion: "ai-invocation-audit.11c.2", usageBasis: "REPORTED" });
  });

  it("the bundle's per-call timeout aborts the fetch, and a late answer is never used", async () => {
    vi.useFakeTimers();
    let aborted = false;
    let release!: () => void;
    const fetcher = vi.fn<BrowserShellFetcher>(
      (_url, init) =>
        new Promise((resolve) => {
          init.signal?.addEventListener("abort", () => (aborted = true));
          release = () => resolve(json({ kind: "CANDIDATE", candidate: VALID, retention: "CONFIRMED_NOT_STORED", usage: USAGE }));
        }),
    );
    const run = service({ fetcher });
    const pending = run.hybrid.execute(EN.request);
    await vi.advanceTimersByTimeAsync(AI_HYBRID_RUNTIME_BUNDLES.EXPLAIN_PATTERN.executionBudget.perCallTimeoutMs);
    release();
    expect(await pending).toMatchObject({ source: "DETERMINISTIC", reason: "PROVIDER_TIMEOUT" });
    expect(aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("user cancellation aborts the fetch", async () => {
    let aborted = false;
    const fetcher = vi.fn<BrowserShellFetcher>((_url, init) => new Promise(() => init.signal?.addEventListener("abort", () => (aborted = true))));
    const controller = new AbortController();
    const run = service({ fetcher });
    const pending = run.hybrid.execute(EN.request, controller.signal);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    controller.abort();
    expect(await pending).toMatchObject({ source: "DETERMINISTIC", reason: "REQUEST_CANCELLED" });
    expect(aborted).toBe(true);
  });

  it("the single structural repair is the service's: two POSTs at most, never more", async () => {
    const fetcher = answering(() => json({ kind: "STRUCTURALLY_REJECTED", reason: "SCHEMA_INVALID", repairable: true, retention: "CONFIRMED_NOT_STORED", usage: USAGE }));
    const run = service({ fetcher });
    expect(await run.hybrid.execute(EN.request)).toMatchObject({ source: "DETERMINISTIC", reason: "SCHEMA_INVALID" });
    expect(fetcher).toHaveBeenCalledTimes(AI_HYBRID_RUNTIME_BUNDLES.EXPLAIN_PATTERN.executionBudget.maxAttempts);
    expect(run.rows[0]!.attempts).toEqual({ count: 2, structuralRepairUsed: true, timedOut: false });
  });

  describe("over the real route handler (fake DeepSeek transport, injected test manifest on both sides)", () => {
    const envelope = (text: string, extra: Record<string, unknown> = {}) => ({
      id: "resp_1", object: "response", status: "completed", model: "deepseek-flash",
      output: [{ type: "message", id: "msg_1", status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }],
      usage: { input_tokens: 600, output_tokens: 80, output_tokens_details: { reasoning_tokens: 0 } },
      store: false, error: null, incomplete_details: null, ...extra,
    });
    function viaRoute(candidates: Array<{ text: string; extra?: Record<string, unknown> }>, manifest: AiActivationManifest = ENABLED) {
      const deepseek = vi.fn(async (_url: string, _init: RequestInit) => {
        const next = candidates.shift()!;
        return new Response(JSON.stringify(envelope(next.text, next.extra)), { status: 200, headers: { "content-type": "application/json" } });
      });
      const handle = createAiShellHandler({ environment: { DEEPSEEK_API_KEY: "deepseek-SENTINEL-test" }, activationManifest: manifest, fetcher: deepseek });
      const posts = vi.fn<BrowserShellFetcher>((url, init) => handle(new Request(`http://localhost${url}`, init)));
      return { deepseek, posts };
    }
    const ROUTE_USAGE = { inputTokens: 600, outputTokens: 80, costMicroUsd: deepSeekCostMicroUsd(600, 80) };

    it("accepted end to end: one POST, one provider call, the AI composition", async () => {
      const route = viaRoute([{ text: JSON.stringify(VALID) }]);
      const run = service({ fetcher: route.posts });
      expect(await run.hybrid.execute(EN.request)).toMatchObject({ kind: "COMPOSED", source: "AI" });
      expect(route.posts).toHaveBeenCalledTimes(1);
      expect(route.deepseek).toHaveBeenCalledTimes(1);
      expect(run.rows[0]!.measurements).toMatchObject(ROUTE_USAGE);
    });

    it("a malformed first candidate is repaired once through the route; usage for both attempts", async () => {
      const route = viaRoute([{ text: `${JSON.stringify(VALID)}}` }, { text: JSON.stringify(VALID) }]);
      const run = service({ fetcher: route.posts });
      expect(await run.hybrid.execute(EN.request)).toMatchObject({ source: "AI" });
      expect(route.posts).toHaveBeenCalledTimes(2);
      expect(run.rows[0]!.measurements).toMatchObject({ inputTokens: 1200, outputTokens: 160 });
    });

    it("retention unconfirmed at the route: FAILED with the billed usage, counted by the service", async () => {
      const route = viaRoute([{ text: JSON.stringify(VALID), extra: { store: null } }]);
      const run = service({ fetcher: route.posts });
      expect(await run.hybrid.execute(EN.request)).toMatchObject({ source: "DETERMINISTIC", reason: "PROVIDER_FAILED" });
      expect(route.posts).toHaveBeenCalledTimes(1);
      expect(run.rows[0]!.measurements).toMatchObject(ROUTE_USAGE);
    });

    it("the route's own activation check still refuses when only the browser is activated", async () => {
      const route = viaRoute([{ text: JSON.stringify(VALID) }], AI_ACTIVATION_MANIFEST);
      const run = service({ fetcher: route.posts });
      expect(await run.hybrid.execute(EN.request)).toMatchObject({ source: "DETERMINISTIC", reason: "PROVIDER_FAILED" });
      expect(route.deepseek).not.toHaveBeenCalled();
    });

    it("the interim gate: no POST reaches the route even when both sides are activated", async () => {
      const route = viaRoute([{ text: JSON.stringify(VALID) }]);
      const run = service({ disclosure: INTERIM_FAIL_CLOSED_DISCLOSURE, fetcher: route.posts });
      expect(await run.hybrid.execute(EN.request)).toMatchObject({ source: "DETERMINISTIC" });
      expect(route.posts).not.toHaveBeenCalled();
      expect(route.deepseek).not.toHaveBeenCalled();
    });
  });
});

describe("the default fetcher", () => {
  it("binds the global fetch lazily (nothing is sent at construction) and is used only for an accepted, approved request", async () => {
    const fetchSpy = vi.fn(async () => json({ kind: "FAILED", reason: "TASK_DISABLED" }));
    vi.stubGlobal("fetch", fetchSpy);
    const refused = createBrowserShellClient({ disclosure: INTERIM_FAIL_CLOSED_DISCLOSURE });
    expect(fetchSpy).not.toHaveBeenCalled();
    await refused.invoke(REQUEST(), signal());
    expect(fetchSpy).not.toHaveBeenCalled();
    await createBrowserShellClient({ disclosure: ACCEPTED }).invoke(REQUEST(), signal());
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect((fetchSpy.mock.calls[0] as unknown[])[0]).toBe(AI_SHELL_ROUTE_PATH);
  });
});
