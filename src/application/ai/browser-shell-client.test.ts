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
import { AI_SHELL_ACCESS_HEADER, AI_SHELL_ROUTE_PATH, AI_SHELL_ROUTE_REFUSAL_REASONS, shellRouteCallUpperBound } from "./ai-shell-route-contract";
import { TEST_DEPLOYMENT_ENVIRONMENT, TEST_ORIGIN, TEST_PASSCODE } from "@/app/api/ai/shell/ai-shell-route-test-support";
import * as client from "./browser-shell-client";
import { BROWSER_SHELL_CLIENT_PROVIDER_MODEL, createAiRemoteUseDecisions, createBrowserShellClient, INTERIM_FAIL_CLOSED_DISCLOSURE, type AiRemoteUseDisclosure, type BrowserShellFetcher } from "./browser-shell-client";
import { projectProviderTaskPayload } from "./detached-payload-projector";
import { projectShellTaskRequest } from "./language/shell-projector";
import { planSlots } from "./language/slot-planner";
import type { AiRequestClassGate } from "./request-class-qualification";
import { qualifiedTestRequestClassGate } from "./request-class-test-support";

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
/** Test-only. In production a disclosure accepts only the one request the patient accepted the dialog for (C3, per-request decisions). */
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
  // Packet 11C Addendum C, C3 (deliberate retarget): the per-request decisions replace the B3 session disclosure.
  // CL3 contract re-freeze (Task RF, deliberate): plus the label of the per-request disclosure policy (a string; pinned by the freeze).
  it("exports exactly the client factory, the frozen route identity, the interim fail-closed disclosure and the per-request decisions (C3)", () => {
    // Owner decision 2026-10-12 (optional passcodes; deliberate change): plus the passcode probe client (the same one network site).
    expect(Object.keys(client).sort()).toEqual(["AI_DISCLOSURE_POLICY_VERSION", "BROWSER_SHELL_CLIENT_PROVIDER_MODEL", "INTERIM_FAIL_CLOSED_DISCLOSURE", "createAiRemoteUseDecisions", "createBrowserShellClient", "fetchAiPasscodeRequirement"]);
    expect(client.AI_DISCLOSURE_POLICY_VERSION).toBe("ai-disclosure-policy.11c.2-per-request");
  });

  it("B3: exposes its disclosure as the port's remoteUse, so the hybrid service decides it before the first attempt", () => {
    const decisions = createAiRemoteUseDecisions();
    expect(createBrowserShellClient({ disclosure: decisions.disclosure, fetcher: answering(() => json({})) }).remoteUse).toBe(decisions.disclosure);
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
    expect(result).toEqual({ kind: "FAILED", reason: "MISSING_CONFIGURATION", notSentToProvider: true });
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
 * Packet 11C Addendum C, Task C3 (owner decision: disclosure acceptance is per explicit request; one permitted structural repair shares
 * that request's decision; a new request needs a new decision). Replaces the B3 session disclosure. A decision is bound to ONE request's
 * token (its AbortSignal, created by the patient's action) for exactly that request's run; it never covers another token, a later run
 * or an aborted request, and it is in memory only.
 */
describe("per-request remote-use decisions (Packet 11C Addendum C, C3)", () => {
  type Decisions = ReturnType<typeof createAiRemoteUseDecisions>;
  /** Runs one request under `decision` and answers what the disclosure says for its token while it runs (and after). */
  async function during(decisions: Decisions, decision: "ACCEPTED" | "DECLINED" | undefined, token: AbortSignal | undefined) {
    let seen: AbortSignal | undefined;
    let inside: string | undefined;
    await decisions.run(decision, token, async (own) => {
      seen = own;
      inside = own ? await decisions.disclosure.decide(own) : undefined;
    });
    const after = seen ? await decisions.disclosure.decide(seen) : undefined;
    return { seen, inside, after };
  }

  it("an acceptance holds for its own request's token while that request runs, and ends when it settles", async () => {
    const decisions = createAiRemoteUseDecisions();
    const token = signal();
    expect(await decisions.disclosure.decide(token)).toBe("NOT_ACCEPTED");
    expect(await during(decisions, "ACCEPTED", token)).toEqual({ seen: token, inside: "ACCEPTED", after: "NOT_ACCEPTED" });
    // Another token (another request, the other flow) is never covered, before, during or after.
    const other = signal();
    await decisions.run("ACCEPTED", token, async () => expect(await decisions.disclosure.decide(other)).toBe("NOT_ACCEPTED"));
    expect(await decisions.disclosure.decide(other)).toBe("NOT_ACCEPTED");
  });

  it("a later request on a token that already carried a decision gets no acceptance (one decision, one request)", async () => {
    const decisions = createAiRemoteUseDecisions();
    const reused = signal();
    await during(decisions, "ACCEPTED", reused);
    expect((await during(decisions, "ACCEPTED", reused)).inside).toBe("NOT_ACCEPTED");
    expect((await during(decisions, undefined, reused)).inside).toBe("NOT_ACCEPTED");
    // A concurrent second request on a token whose acceptance is still live ends it for both (fails safe).
    const shared = signal();
    let release!: () => void;
    const first = decisions.run("ACCEPTED", shared, () => new Promise<void>((resolve) => (release = resolve)));
    expect(await decisions.disclosure.decide(shared)).toBe("ACCEPTED");
    await decisions.run(undefined, shared, async () => expect(await decisions.disclosure.decide(shared)).toBe("NOT_ACCEPTED"));
    expect(await decisions.disclosure.decide(shared)).toBe("NOT_ACCEPTED");
    release();
    await first;
  });

  it("a decline is DECLINED for its request and stays DECLINED for that token (B5: a reused declined signal fails safe)", async () => {
    const decisions = createAiRemoteUseDecisions();
    const token = signal();
    expect(await during(decisions, "DECLINED", token)).toEqual({ seen: token, inside: "DECLINED", after: "DECLINED" });
    expect((await during(decisions, "ACCEPTED", token)).inside).toBe("DECLINED");
    expect((await during(decisions, undefined, token)).inside).toBe("DECLINED");
  });

  it("an aborted request's token is never accepted (a new click, Retry, locale, period or view change or unmount aborts it)", async () => {
    const decisions = createAiRemoteUseDecisions();
    const controller = new AbortController();
    await decisions.run("ACCEPTED", controller.signal, async (own) => {
      expect(await decisions.disclosure.decide(own!)).toBe("ACCEPTED");
      controller.abort();
      expect(await decisions.disclosure.decide(own!)).toBe("NOT_ACCEPTED");
    });
  });

  it("a decision without a caller signal gets its own fresh token; no decision and no signal passes no token", async () => {
    const decisions = createAiRemoteUseDecisions();
    const accepted = await during(decisions, "ACCEPTED", undefined);
    expect(accepted.seen).toBeInstanceOf(AbortSignal);
    expect(accepted.inside).toBe("ACCEPTED");
    expect(accepted.after).toBe("NOT_ACCEPTED");
    expect((await during(decisions, "DECLINED", undefined)).inside).toBe("DECLINED");
    expect((await during(decisions, undefined, undefined)).seen).toBeUndefined();
    // Only the two exact decisions count; anything else is no decision.
    expect((await during(decisions, "accepted" as never, signal())).inside).toBe("NOT_ACCEPTED");
  });

  it("each instance is independent, the surface is frozen, and a failing request still ends its acceptance", async () => {
    const first = createAiRemoteUseDecisions();
    const second = createAiRemoteUseDecisions();
    const token = signal();
    await first.run("ACCEPTED", token, async () => expect(await second.disclosure.decide(token)).toBe("NOT_ACCEPTED"));
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.disclosure)).toBe(true);
    expect(Object.keys(first).sort()).toEqual(["disclosure", "run"]);
    const failing = signal();
    await expect(first.run("ACCEPTED", failing, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await first.disclosure.decide(failing)).toBe("NOT_ACCEPTED");
  });

  it("is never persisted: the module touches no storage", () => {
    const source = readFileSync(join(process.cwd(), "src/application/ai/browser-shell-client.ts"), "utf8");
    expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|Dexie/);
  });

  it("gates the client per request: the per-send check reads the request's own decision token, not the per-call signal", async () => {
    const decisions = createAiRemoteUseDecisions();
    const fetcher = answering(() => json({ kind: "CANDIDATE", candidate: VALID, retention: "CONFIRMED_NOT_STORED", usage: USAGE }));
    const shell = createBrowserShellClient({ disclosure: decisions.disclosure, fetcher });
    // No decision: no POST.
    expect(await shell.invoke(REQUEST(), signal())).toEqual({ kind: "FAILED", reason: "MISSING_CONFIGURATION", notSentToProvider: true });
    const token = signal();
    await decisions.run("ACCEPTED", token, async (own) => {
      // The per-call signal alone carries no decision; the request's token does (the repair attempt sends the same token).
      expect(await shell.invoke(REQUEST(), signal())).toEqual({ kind: "FAILED", reason: "MISSING_CONFIGURATION", notSentToProvider: true });
      expect((await shell.invoke(REQUEST(), signal(), own)).kind).toBe("COMPLETED");
      expect((await shell.invoke(REQUEST(), signal(), own)).kind).toBe("COMPLETED");
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    // After the request settled its token no longer sends.
    expect(await shell.invoke(REQUEST(), signal(), token)).toEqual({ kind: "FAILED", reason: "MISSING_CONFIGURATION", notSentToProvider: true });
    // An aborted token never sends, even while its request runs.
    const controller = new AbortController();
    await decisions.run("ACCEPTED", controller.signal, async (own) => {
      controller.abort();
      expect(await shell.invoke(REQUEST(), signal(), own)).toEqual({ kind: "FAILED", reason: "MISSING_CONFIGURATION", notSentToProvider: true });
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("Packet 11C B4a: a DECLINED answer never POSTs either (only an explicit ACCEPTED sends)", async () => {
    const fetcher = answering(() => json({ kind: "CANDIDATE", candidate: VALID, retention: "CONFIRMED_NOT_STORED", usage: USAGE }));
    const shell = createBrowserShellClient({ disclosure: { decide: async () => "DECLINED" }, fetcher });
    expect(await shell.invoke(REQUEST(), signal())).toEqual({ kind: "FAILED", reason: "MISSING_CONFIGURATION", notSentToProvider: true });
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
    expect(await createBrowserShellClient({ disclosure: { decide }, fetcher }).invoke(body() as ShellTaskRequest, signal())).toEqual({ kind: "FAILED", reason: "PROVIDER_REJECTED", notSentToProvider: true });
    expect(decide).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

/**
 * C6 fix round 1 (review item 1): every answer decided before the provider call is marked `notSentToProvider` (never with usage): the
 * route's own marked FAILED, any 4xx from the route, and the client's own refusals before the POST. Anything that may have been sent (a
 * 5xx, a network error, an unreadable answer) keeps the C5 conservative accounting.
 */
describe("C6 fix round 1: answers decided before the provider call are marked not sent", () => {
  const run = async (respond: () => Response | Promise<Response>) => createBrowserShellClient({ disclosure: ACCEPTED, fetcher: answering(respond) }).invoke(REQUEST(), signal());
  it("forwards the route's marker on a pre-call FAILED (the reason mapped as before)", async () => {
    expect(await run(() => json({ kind: "FAILED", reason: "PROVIDER_RATE_LIMITED", notSentToProvider: true }))).toEqual({ kind: "FAILED", reason: "PROVIDER_RATE_LIMITED", notSentToProvider: true });
    expect(await run(() => json({ kind: "FAILED", reason: "MISSING_CONFIGURATION", notSentToProvider: true }))).toEqual({ kind: "FAILED", reason: "MISSING_CONFIGURATION", notSentToProvider: true });
    expect(await run(() => json({ kind: "FAILED", reason: "TASK_DISABLED", notSentToProvider: true }))).toEqual({ kind: "FAILED", reason: "PROVIDER_FAILED", notSentToProvider: true });
  });
  it("a non-403 4xx from the route is a refusal before any provider call: marked, no usage", async () => {
    expect(await run(() => json({ kind: "FAILED", reason: "PAYLOAD_INVALID", notSentToProvider: true }, 400))).toEqual({ kind: "FAILED", reason: "PROVIDER_REJECTED", notSentToProvider: true });
    expect(await run(() => json(SENTINEL, 413, "text/plain"))).toEqual({ kind: "FAILED", reason: "PROVIDER_REJECTED", notSentToProvider: true });
    expect(await run(() => json(SENTINEL, 429, "text/plain"))).toEqual({ kind: "FAILED", reason: "PROVIDER_RATE_LIMITED", notSentToProvider: true });
    // A 403 that is not a conforming REFUSED is still a refusal before any provider call.
    expect(await run(() => json(SENTINEL, 403, "text/plain"))).toEqual({ kind: "FAILED", reason: "PROVIDER_REJECTED", notSentToProvider: true });
  });
  it("anything that may have been transmitted is never marked: a 5xx, a network error, an unreadable 200", async () => {
    const bound = shellRouteCallUpperBound(REQUEST());
    expect(await run(() => json(SENTINEL, 502, "text/plain"))).toEqual({ kind: "FAILED", reason: "PROVIDER_FAILED", usage: bound });
    expect(await run(() => Promise.reject(new Error(SENTINEL)))).toEqual({ kind: "FAILED", reason: "TRANSPORT_FAILED", usage: bound });
    expect(await run(() => json(`<html>${SENTINEL}</html>`, 200, "text/html"))).toEqual({ kind: "FAILED", reason: "PROVIDER_FAILED", usage: bound });
    // A FAILED body with usage keeps it, unmarked.
    expect(await run(() => json({ kind: "FAILED", reason: "PROVIDER_TIMEOUT", usage: { ...USAGE, basis: "UPPER_BOUND" } }))).toEqual({ kind: "FAILED", reason: "PROVIDER_TIMEOUT", usage: { ...USAGE, basis: "UPPER_BOUND" } });
  });
  it("the client's own refusals before the POST are marked: an invalid request, no acceptance (the body-cap refusal shares the path)", async () => {
    const fetcher = answering(() => json({}));
    expect(await createBrowserShellClient({ disclosure: ACCEPTED, fetcher }).invoke(null as never, signal())).toEqual({ kind: "FAILED", reason: "PROVIDER_REJECTED", notSentToProvider: true });
    expect(await createBrowserShellClient({ disclosure: INTERIM_FAIL_CLOSED_DISCLOSURE, fetcher }).invoke(REQUEST(), signal())).toEqual({ kind: "FAILED", reason: "MISSING_CONFIGURATION", notSentToProvider: true });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

/**
 * Packet 11C Addendum C, Task C6: the demo passcode travels only as a request header on the remote POST (read per send from the app's
 * in-memory entry), and a closed route refusal is reported to the wiring as a closed code only (boolean-level signals; no configuration).
 */
describe("C6: the demo passcode header and the route-refusal signal", () => {
  const PASSCODE = "TEST-ONLY-passcode-value";
  it("sends the entered passcode as the one extra request header, never in the body", async () => {
    const fetcher = answering(() => json({ kind: "FAILED", reason: "TASK_DISABLED" }));
    await createBrowserShellClient({ disclosure: ACCEPTED, fetcher, accessPasscode: () => PASSCODE }).invoke(REQUEST(), signal());
    const init = fetcher.mock.calls[0]![1];
    expect(init.headers).toEqual({ "content-type": "application/json", [AI_SHELL_ACCESS_HEADER]: PASSCODE });
    expect(String(init.body)).not.toContain(PASSCODE);
    expect(JSON.parse(String(init.body))).toEqual(REQUEST());
  });

  it("no passcode (none entered, a throwing reader, or a value that is not a valid header) sends no passcode header", async () => {
    for (const accessPasscode of [() => null, () => "", () => { throw new Error("x"); }, () => "pässcode-unicode", () => "line\nbreak-passcode", () => "x".repeat(129)]) {
      const fetcher = answering(() => json({ kind: "FAILED", reason: "TASK_DISABLED" }));
      await createBrowserShellClient({ disclosure: ACCEPTED, fetcher, accessPasscode }).invoke(REQUEST(), signal());
      expect(fetcher.mock.calls[0]![1].headers).toEqual({ "content-type": "application/json" });
    }
  });

  it("the passcode is read only when a POST is made (never for a refused, unaccepted or invalid request)", async () => {
    const accessPasscode = vi.fn(() => PASSCODE);
    const fetcher = answering(() => json({}));
    await createBrowserShellClient({ disclosure: INTERIM_FAIL_CLOSED_DISCLOSURE, fetcher, accessPasscode }).invoke(REQUEST(), signal());
    await createBrowserShellClient({ disclosure: ACCEPTED, fetcher, accessPasscode }).invoke(null as never, signal());
    expect(accessPasscode).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reports each closed route refusal to the wiring (the code only); nothing for any other answer; a throwing listener changes nothing", async () => {
    for (const reason of AI_SHELL_ROUTE_REFUSAL_REASONS) {
      const onRefusal = vi.fn();
      const result = await createBrowserShellClient({ disclosure: ACCEPTED, fetcher: answering(() => json({ kind: "REFUSED", reason, notSentToProvider: true }, 403)), onRefusal }).invoke(REQUEST(), signal());
      expect(onRefusal.mock.calls).toEqual([[reason]]);
      expect(result).toMatchObject({ refusal: reason });
    }
    const onRefusal = vi.fn();
    for (const answer of [() => json({ kind: "FAILED", reason: "TASK_DISABLED" }), () => json({ kind: "REFUSED", reason: "ACCESS_DENIED" }, 403), () => json(SENTINEL, 403, "text/plain")]) {
      await createBrowserShellClient({ disclosure: ACCEPTED, fetcher: answering(answer), onRefusal }).invoke(REQUEST(), signal());
    }
    expect(onRefusal).not.toHaveBeenCalled();
    const throwing = () => { throw new Error(SENTINEL); };
    expect(await createBrowserShellClient({ disclosure: ACCEPTED, fetcher: answering(() => json({ kind: "REFUSED", reason: "REMOTE_AI_DISABLED", notSentToProvider: true }, 403)), onRefusal: throwing }).invoke(REQUEST(), signal())).toEqual({ kind: "FAILED", reason: "PROVIDER_REJECTED", refusal: "REMOTE_AI_DISABLED", notSentToProvider: true });
  });

  it("stores nothing: no browser storage API in the client", () => {
    const source = readFileSync(join(process.cwd(), "src/application/ai/browser-shell-client.ts"), "utf8");
    expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|console\./);
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

  it("C1: the route's 403 REFUSED REQUEST_CLASS_NOT_QUALIFIED is a closed PROVIDER_REJECTED carrying that refusal and no usage", async () => {
    // Packet 11C Addendum C (C6): every REFUSED carries the route's "not sent to provider" marker, passed on to the hybrid service.
    const refused = { kind: "REFUSED", reason: "REQUEST_CLASS_NOT_QUALIFIED", notSentToProvider: true };
    expect(await invoke(() => json(refused, 403))).toEqual({ kind: "FAILED", reason: "PROVIDER_REJECTED", refusal: "REQUEST_CLASS_NOT_QUALIFIED", notSentToProvider: true });
    // Any other 403 body (or an unknown refusal reason) is the plain closed refusal, still without usage.
    expect(await invoke(() => json({ kind: "REFUSED", reason: SENTINEL }, 403))).toEqual({ kind: "FAILED", reason: "PROVIDER_REJECTED", notSentToProvider: true });
    expect(await invoke(() => json(SENTINEL, 403, "text/plain"))).toEqual({ kind: "FAILED", reason: "PROVIDER_REJECTED", notSentToProvider: true });
    expect(await invoke(() => json({ kind: "FAILED", reason: "PAYLOAD_INVALID" }, 400))).toEqual({ kind: "FAILED", reason: "PROVIDER_REJECTED", notSentToProvider: true });
    // REFUSED is a 403 answer only: with 200 it is a non-conforming answer after a POST (the pre-send upper bound counts).
    expect(await invoke(() => json(refused))).toEqual({ kind: "FAILED", reason: "PROVIDER_FAILED", usage: shellRouteCallUpperBound(REQUEST()) });
  });

  it("C6: every closed route refusal (with the not-sent marker) is PROVIDER_REJECTED carrying the refusal and the marker, never usage", async () => {
    for (const reason of AI_SHELL_ROUTE_REFUSAL_REASONS) {
      expect(await invoke(() => json({ kind: "REFUSED", reason, notSentToProvider: true }, 403)), reason).toEqual({ kind: "FAILED", reason: "PROVIDER_REJECTED", refusal: reason, notSentToProvider: true });
    }
    // Without the marker the 403 body is non-conforming: the plain closed refusal, with no refusal code and no marker.
    expect(await invoke(() => json({ kind: "REFUSED", reason: "ACCESS_DENIED" }, 403))).toEqual({ kind: "FAILED", reason: "PROVIDER_REJECTED", notSentToProvider: true });
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
    // C6 fix round 1: and marked not sent to the provider.
    expect(result).toEqual(refusedByRoute ? { kind: "FAILED", reason, notSentToProvider: true } : { kind: "FAILED", reason, usage: shellRouteCallUpperBound(REQUEST()) });
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
    expect(await createBrowserShellClient({ disclosure: INTERIM_FAIL_CLOSED_DISCLOSURE, fetcher }).invoke(REQUEST(), signal())).toEqual({ kind: "FAILED", reason: "MISSING_CONFIGURATION", notSentToProvider: true });
    expect(await createBrowserShellClient({ disclosure: ACCEPTED, fetcher }).invoke({ ...REQUEST(), facts: [] } as never, signal())).toEqual({ kind: "FAILED", reason: "PROVIDER_REJECTED", notSentToProvider: true });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

/** The client inside the real hybrid service (the service owns the per-call timeout, cancellation and the single repair). */
describe("the client under the hybrid service", () => {
  // Packet 11C Addendum C (C1): a remote path needs a QUALIFIED class; test-only QUALIFIED records unless `requestClassGate` says otherwise.
  function service(options: { manifest?: AiActivationManifest; disclosure?: AiRemoteUseDisclosure; fetcher: BrowserShellFetcher; requestClassGate?: AiRequestClassGate | "SHIPPED"; accessPasscode?: () => string | null }) {
    const rows: AiInvocationAuditRow[] = [];
    const hybrid = createAiHybridTaskService({
      releaseProfile: "HACKATHON_DEMO",
      audit: { append: async (row) => void rows.push(row) },
      now: () => "2026-10-08T01:00:00.000Z",
      monotonicMs: () => 0,
      manifest: options.manifest ?? ENABLED,
      // Packet 11C Addendum C (C6): the entered demo passcode (test value), sent as a header by the client; the route checks it.
      provider: createBrowserShellClient({ disclosure: options.disclosure ?? ACCEPTED, fetcher: options.fetcher, accessPasscode: options.accessPasscode ?? (() => TEST_PASSCODE) }),
      ...(options.requestClassGate === "SHIPPED" ? {} : { requestClassGate: options.requestClassGate ?? qualifiedTestRequestClassGate() }),
    });
    return { hybrid, rows };
  }

  it("C1: the shipped request-class gate (all PENDING) with an activated test manifest: deterministic, no disclosure, no POST, one REQUEST_CLASS_NOT_QUALIFIED row", async () => {
    const decide = vi.fn<AiRemoteUseDisclosure["decide"]>(async () => "ACCEPTED");
    const fetcher = answering(() => json({ kind: "CANDIDATE", candidate: VALID, retention: "CONFIRMED_NOT_STORED", usage: USAGE }));
    const run = service({ disclosure: { decide }, fetcher, requestClassGate: "SHIPPED" });
    expect(await run.hybrid.execute(EN.request)).toMatchObject({ kind: "COMPOSED", source: "DETERMINISTIC", mode: "CLASS_NOT_QUALIFIED", reason: "TASK_DISABLED" });
    expect(decide).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(run.rows).toHaveLength(1);
    expect(run.rows[0]).toMatchObject({ outcomeCode: "REQUEST_CLASS_NOT_QUALIFIED", providerModel: null, attempts: { count: 0 }, usageBasis: "NONE" });
    expect(aiInvocationAuditRowSchema.safeParse(run.rows[0]).success).toBe(true);
  });

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

  it("C3: a request without its own acceptance is decided before any POST with a truthful row; an accepted request's repair is not asked again", async () => {
    const decisions = createAiRemoteUseDecisions();
    const fetcher = answering(() => json({ kind: "CANDIDATE", candidate: VALID, retention: "CONFIRMED_NOT_STORED", usage: USAGE }));
    const notAccepted = service({ disclosure: decisions.disclosure, fetcher });
    expect(await notAccepted.hybrid.execute(EN.request, signal())).toMatchObject({ source: "DETERMINISTIC", mode: "REMOTE_NOT_ACCEPTED", reason: "MISSING_CONFIGURATION" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(notAccepted.rows[0]).toMatchObject({ outcomeCode: "REMOTE_USE_NOT_ACCEPTED", providerModel: null, attempts: { count: 0 }, sourceRevisions: [], usageBasis: "NONE" });
    expect(aiInvocationAuditRowSchema.safeParse(notAccepted.rows[0]).success).toBe(true);
    // One acceptance, one request: the repairable rejection is repaired once under the same decision, never asked again.
    const repairing = answering(() => json({ kind: "STRUCTURALLY_REJECTED", reason: "SCHEMA_INVALID", repairable: true, retention: "CONFIRMED_NOT_STORED", usage: USAGE }));
    const decide = vi.fn<AiRemoteUseDisclosure["decide"]>((token) => decisions.disclosure.decide(token));
    const accepted = service({ disclosure: { decide }, fetcher: repairing });
    const result = await decisions.run("ACCEPTED", signal(), (token) => accepted.hybrid.execute(EN.request, token));
    expect(result).toMatchObject({ source: "DETERMINISTIC", reason: "SCHEMA_INVALID" });
    expect(repairing).toHaveBeenCalledTimes(2);
    expect(accepted.rows[0]).toMatchObject({ providerModel: { providerKey: "deepseek" }, attempts: { count: 2, structuralRepairUsed: true } });
    // Asked once by the service, then re-read (never prompted) by the client before each of the two sends, all on the request's token.
    expect(decide).toHaveBeenCalledTimes(3);
    expect(new Set(decide.mock.calls.map((call) => call[0])).size).toBe(1);
    // The next request (a new click or Retry) has no acceptance of its own: nothing is sent.
    const next = service({ disclosure: decisions.disclosure, fetcher: repairing });
    expect(await next.hybrid.execute(EN.request, signal())).toMatchObject({ mode: "REMOTE_NOT_ACCEPTED" });
    expect(repairing).toHaveBeenCalledTimes(2);
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
    // Packet 11C Addendum C (C1): the route side gets test-only QUALIFIED records too, unless `routeGate` is "SHIPPED" (the default).
    // Packet 11C Addendum C (C6): the route gets the deployment configuration (TEST values; `deployment` overrides single entries), and
    // the posts carry what a same-origin browser adds itself (Origin, Sec-Fetch-Site); the passcode header comes from the client.
    function viaRoute(candidates: Array<{ text: string; extra?: Record<string, unknown> }>, manifest: AiActivationManifest = ENABLED, routeGate: "TEST" | "SHIPPED" = "TEST", deployment: Record<string, string | undefined> = {}) {
      const deepseek = vi.fn(async (_url: string, _init: RequestInit) => {
        const next = candidates.shift()!;
        return new Response(JSON.stringify(envelope(next.text, next.extra)), { status: 200, headers: { "content-type": "application/json" } });
      });
      const handle = createAiShellHandler({ environment: { DEEPSEEK_API_KEY: "deepseek-SENTINEL-test", ...TEST_DEPLOYMENT_ENVIRONMENT, ...deployment }, activationManifest: manifest, fetcher: deepseek, ...(routeGate === "TEST" ? { requestClassGate: qualifiedTestRequestClassGate() } : {}) });
      const posts = vi.fn<BrowserShellFetcher>((url, init) => handle(new Request(`http://localhost${url}`, { ...init, headers: { ...(init.headers as Record<string, string>), Origin: TEST_ORIGIN, "Sec-Fetch-Site": "same-origin" } })));
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

    it("C1: the route's own class check refuses (403, before any credential read) when only the browser has the class qualified; audited REQUEST_CLASS_NOT_QUALIFIED", async () => {
      const route = viaRoute([{ text: JSON.stringify(VALID) }], ENABLED, "SHIPPED");
      const run = service({ fetcher: route.posts });
      expect(await run.hybrid.execute(EN.request)).toMatchObject({ source: "DETERMINISTIC", mode: "REMOTE_AI", reason: "PROVIDER_REJECTED" });
      expect(route.posts).toHaveBeenCalledTimes(1);
      expect(route.deepseek).not.toHaveBeenCalled();
      expect(run.rows).toHaveLength(1);
      // Packet 11C Addendum C (C6, C5 review carry): the refusal is marked "not sent to provider": zero attempts, usage basis NONE.
      expect(run.rows[0]).toMatchObject({ outcomeCode: "REQUEST_CLASS_NOT_QUALIFIED", attempts: { count: 0, structuralRepairUsed: false }, providerModel: null, usageBasis: "NONE", measurements: { inputTokens: null, outputTokens: null, costMicroUsd: null } });
      expect(aiInvocationAuditRowSchema.safeParse(run.rows[0]).success).toBe(true);
    });

    // C6 fix round 1 (review item 1): answers decided before the provider call record exactly 0 attempts and usage basis NONE.
    it("fix round 1 end to end: the route's rate limit, a missing credential and server TASK_DISABLED each give 0 attempts / NONE", async () => {
      const cases: Array<[string, () => ReturnType<typeof viaRoute>, string]> = [
        ["a missing credential", () => viaRoute([{ text: JSON.stringify(VALID) }], ENABLED, "TEST", { DEEPSEEK_API_KEY: undefined }), "MISSING_CONFIGURATION"],
        ["server TASK_DISABLED (only the browser is activated)", () => viaRoute([{ text: JSON.stringify(VALID) }], AI_ACTIVATION_MANIFEST), "PROVIDER_FAILED"],
      ];
      for (const [label, make, code] of cases) {
        const route = make();
        const run = service({ fetcher: route.posts });
        await run.hybrid.execute(EN.request);
        expect(route.posts, label).toHaveBeenCalledTimes(1);
        expect(route.deepseek, label).not.toHaveBeenCalled();
        expect(run.rows[0], label).toMatchObject({ outcomeCode: code, attempts: { count: 0, structuralRepairUsed: false, timedOut: false }, providerModel: null, usageBasis: "NONE" });
        expect(aiInvocationAuditRowSchema.safeParse(run.rows[0]).success, label).toBe(true);
      }
      // The rate limit (default 10 per minute per instance): the 11th request through one route instance.
      const route = viaRoute(Array.from({ length: 11 }, () => ({ text: JSON.stringify(VALID) })));
      const run = service({ fetcher: route.posts });
      for (let index = 0; index < 11; index += 1) await run.hybrid.execute(EN.request);
      expect(route.deepseek).toHaveBeenCalledTimes(10);
      expect(run.rows[10]).toMatchObject({ outcomeCode: "PROVIDER_RATE_LIMITED", attempts: { count: 0 }, providerModel: null, usageBasis: "NONE" });
    });

    it("fix round 1: a 4xx answer and the client's own per-send refusal each give 0 attempts / NONE", async () => {
      const bad = service({ fetcher: answering(() => json({ kind: "FAILED", reason: "PAYLOAD_INVALID", notSentToProvider: true }, 400)) });
      await bad.hybrid.execute(EN.request);
      expect(bad.rows[0]).toMatchObject({ outcomeCode: "PROVIDER_REJECTED", attempts: { count: 0 }, usageBasis: "NONE" });
      // The service's decision accepts; the client's per-send re-check does not (e.g. the decision ended): nothing is POSTed.
      let asked = 0;
      const fetcher = answering(() => json({}));
      const perSend = service({ fetcher, disclosure: { decide: async () => (asked++ === 0 ? "ACCEPTED" : "NOT_ACCEPTED") } });
      await perSend.hybrid.execute(EN.request);
      expect(fetcher).not.toHaveBeenCalled();
      expect(perSend.rows[0]).toMatchObject({ outcomeCode: "MISSING_CONFIGURATION", attempts: { count: 0 }, providerModel: null, usageBasis: "NONE" });
    });

    it.each<[string, Record<string, string | undefined>, (() => string | null) | undefined, string]>([
      ["the remote-AI switch off", { JAGAON_REMOTE_AI: undefined }, undefined, "REMOTE_AI_DISABLED"],
      ["no allowed origins configured", { JAGAON_AI_ALLOWED_ORIGINS: undefined }, undefined, "ORIGIN_REJECTED"],
      ["no passcode entered", {}, () => null, "ACCESS_DENIED"],
      ["a wrong passcode", {}, () => "TEST-ONLY-wrong-passcode", "ACCESS_DENIED"],
      ["no daily limit configured", { JAGAON_AI_DAILY_SPEND_LIMIT_USD: undefined }, undefined, "SPEND_NOT_CONFIGURED"],
      ["a daily limit below one call", { JAGAON_AI_DAILY_SPEND_LIMIT_USD: "0.000001" }, undefined, "SPEND_CEILING_REACHED"],
    ])("C6 end to end: %s is refused by the route before any provider call and audited truthfully (0 attempts, NONE)", async (_label, deployment, accessPasscode, code) => {
      const route = viaRoute([{ text: JSON.stringify(VALID) }], ENABLED, "TEST", deployment);
      const run = service({ fetcher: route.posts, ...(accessPasscode ? { accessPasscode } : {}) });
      expect(await run.hybrid.execute(EN.request)).toMatchObject({ source: "DETERMINISTIC", mode: "REMOTE_AI", reason: "PROVIDER_REJECTED" });
      expect(route.posts).toHaveBeenCalledTimes(1);
      expect(route.deepseek).not.toHaveBeenCalled();
      expect(run.rows).toHaveLength(1);
      expect(run.rows[0]).toMatchObject({ outcomeCode: code, attempts: { count: 0, structuralRepairUsed: false, timedOut: false }, providerModel: null, usageBasis: "NONE" });
      expect(aiInvocationAuditRowSchema.safeParse(run.rows[0]).success).toBe(true);
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

/** Owner UI decision U12: `onPost` observes each POST that actually leaves the browser, with the request's decision token. */
describe("U12: the POST observer", () => {
  it("is told the decision token right before each POST (a 403 refusal included), and never when nothing is POSTed", async () => {
    const onPost = vi.fn();
    const token = signal();
    const refused = answering(() => json({ kind: "REFUSED", reason: "ACCESS_DENIED", notSentToProvider: true }, 403));
    await createBrowserShellClient({ disclosure: ACCEPTED, fetcher: refused, onPost }).invoke(REQUEST(), signal(), token);
    expect(refused).toHaveBeenCalledTimes(1);
    expect(onPost.mock.calls).toEqual([[token]]);
    // Nothing POSTed: not accepted, or a request the client refuses itself.
    const silent = answering(() => json({ kind: "CANDIDATE", candidate: VALID, retention: "CONFIRMED_NOT_STORED", usage: USAGE }));
    const quiet = vi.fn();
    await createBrowserShellClient({ disclosure: INTERIM_FAIL_CLOSED_DISCLOSURE, fetcher: silent, onPost: quiet }).invoke(REQUEST(), signal(), signal());
    await createBrowserShellClient({ disclosure: ACCEPTED, fetcher: silent, onPost: quiet }).invoke({ ...REQUEST(), taskType: "UNKNOWN" } as unknown as ShellTaskRequest, signal(), signal());
    expect(silent).not.toHaveBeenCalled();
    expect(quiet).not.toHaveBeenCalled();
  });

  it("a throwing observer changes nothing: the POST and its answer proceed", async () => {
    const fetcher = answering(() => json({ kind: "CANDIDATE", candidate: VALID, retention: "CONFIRMED_NOT_STORED", usage: USAGE }));
    const result = await createBrowserShellClient({ disclosure: ACCEPTED, fetcher, onPost: () => { throw new Error("x"); } }).invoke(REQUEST(), signal());
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe("COMPLETED");
  });
});

/** Owner decision 2026-10-12 (optional passcodes): the passcode probe, GET /api/ai/shell, `{ passcodeRequired }` only. */
describe("the AI passcode probe (Owner decision 2026-10-12, optional passcodes)", () => {
  it("one same-origin GET with no body and no passcode; the route's boolean; anything else is unknown (null)", async () => {
    const fetcher = answering(() => json({ passcodeRequired: false }));
    expect(await client.fetchAiPasscodeRequirement({ fetcher })).toBe(false);
    expect(fetcher).toHaveBeenCalledWith(AI_SHELL_ROUTE_PATH, { method: "GET", cache: "no-store", redirect: "error", signal: expect.any(AbortSignal) });
    expect(await client.fetchAiPasscodeRequirement({ fetcher: answering(() => json({ passcodeRequired: true })) })).toBe(true);
    for (const answer of [
      () => json({ passcodeRequired: false }, 429),
      () => json({ passcodeRequired: false }, 500),
      () => json({ passcodeRequired: "no" }),
      () => json({ passcodeRequired: false, extra: 1 }),
      () => json({}),
      () => json("not json", 200, "text/plain"),
      () => json({ passcodeRequired: false }, 200, "text/html"),
      () => json("x".repeat(70_000)),
      () => {
        throw new TypeError(SENTINEL);
      },
    ]) {
      expect(await client.fetchAiPasscodeRequirement({ fetcher: answering(answer) })).toBeNull();
    }
    // A stalled probe is abandoned after its time limit: unknown (null), so the AI action never hangs.
    vi.useFakeTimers();
    try {
      const stalled: BrowserShellFetcher = (_input, init) => new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("timeout", "TimeoutError"))));
      const pending = client.fetchAiPasscodeRequirement({ fetcher: stalled });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await pending).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("against the real route handler: false with no passcode configured, true with one; no credential read, no provider call", async () => {
    for (const [environment, expected] of [[{ ...TEST_DEPLOYMENT_ENVIRONMENT, JAGAON_AI_DEMO_PASSCODE: undefined }, false], [TEST_DEPLOYMENT_ENVIRONMENT, true]] as const) {
      const reads: string[] = [];
      const provider = vi.fn();
      const handle = createAiShellHandler({ environment: new Proxy({ ...environment, DEEPSEEK_API_KEY: "SENTINEL-key" } as Record<string, string | undefined>, { get: (target, key) => (reads.push(String(key)), target[String(key)]) }), fetcher: provider });
      const fetcher = vi.fn<BrowserShellFetcher>(async (url, init) => handle(new Request(`${TEST_ORIGIN}${url}`, { ...init, headers: { "Sec-Fetch-Site": "same-origin" } })));
      expect(await client.fetchAiPasscodeRequirement({ fetcher })).toBe(expected);
      expect(reads).not.toContain("DEEPSEEK_API_KEY");
      expect(provider).not.toHaveBeenCalled();
    }
  });
});

/**
 * Owner decision 2026-10-12 (AI credit dialog): the wiring is told (with the request's decision token) when the route answered that the
 * AI credit is used up: the daily spend limit (REFUSED SPEND_CEILING_REACHED) or the provider's balance (FAILED OPERATIONAL_SPEND_LOCKED,
 * which the shared Responses adapter maps from DeepSeek's HTTP 402). Closed codes only; no provider detail reaches the browser.
 */
describe("the AI credit-limit signal (Owner decision 2026-10-12, AI credit dialog)", () => {
  it("is told the decision token for SPEND_CEILING_REACHED and for OPERATIONAL_SPEND_LOCKED; the results are unchanged", async () => {
    const onCreditLimit = vi.fn();
    const token = signal();
    const ceiling = await createBrowserShellClient({ disclosure: ACCEPTED, fetcher: answering(() => json({ kind: "REFUSED", reason: "SPEND_CEILING_REACHED", notSentToProvider: true }, 403)), onCreditLimit }).invoke(REQUEST(), signal(), token);
    expect(ceiling).toEqual({ kind: "FAILED", reason: "PROVIDER_REJECTED", refusal: "SPEND_CEILING_REACHED", notSentToProvider: true });
    const usage = { ...USAGE, basis: "UPPER_BOUND" as const };
    const balance = await createBrowserShellClient({ disclosure: ACCEPTED, fetcher: answering(() => json({ kind: "FAILED", reason: "OPERATIONAL_SPEND_LOCKED", usage })), onCreditLimit }).invoke(REQUEST(), signal(), token);
    expect(balance).toEqual({ kind: "FAILED", reason: "OPERATIONAL_SPEND_LOCKED", usage });
    expect(onCreditLimit.mock.calls).toEqual([[token], [token]]);
    // Without a decision token, the per-call signal is the token (as for onPost).
    const callSignal = signal();
    const plain = vi.fn();
    await createBrowserShellClient({ disclosure: ACCEPTED, fetcher: answering(() => json({ kind: "REFUSED", reason: "SPEND_CEILING_REACHED", notSentToProvider: true }, 403)), onCreditLimit: plain }).invoke(REQUEST(), callSignal);
    expect(plain.mock.calls).toEqual([[callSignal]]);
  });

  it("is not told for any other answer (other refusals, other failures, a candidate, an unreadable answer); a throwing listener changes nothing", async () => {
    const onCreditLimit = vi.fn();
    const answers = [
      ...AI_SHELL_ROUTE_REFUSAL_REASONS.filter((reason) => reason !== "SPEND_CEILING_REACHED").map((reason) => () => json({ kind: "REFUSED", reason, notSentToProvider: true }, 403)),
      () => json({ kind: "FAILED", reason: "PROVIDER_FAILED", usage: { ...USAGE, basis: "REPORTED" } }),
      () => json({ kind: "FAILED", reason: "PROVIDER_RATE_LIMITED", notSentToProvider: true }),
      () => json({ kind: "FAILED", reason: "MISSING_CONFIGURATION", notSentToProvider: true }),
      () => json({ kind: "CANDIDATE", candidate: VALID, retention: "CONFIRMED_NOT_STORED", usage: USAGE }),
      () => json({ kind: "REFUSED", reason: "SPEND_CEILING_REACHED", notSentToProvider: true }, 200),
      () => json(SENTINEL, 402, "text/plain"),
      () => json({ kind: "FAILED", reason: "OPERATIONAL_SPEND_LOCKED" }, 402),
    ];
    for (const answer of answers) await createBrowserShellClient({ disclosure: ACCEPTED, fetcher: answering(answer), onCreditLimit }).invoke(REQUEST(), signal(), signal());
    // Nothing POSTed at all.
    await createBrowserShellClient({ disclosure: INTERIM_FAIL_CLOSED_DISCLOSURE, fetcher: answering(() => json({ kind: "REFUSED", reason: "SPEND_CEILING_REACHED", notSentToProvider: true }, 403)), onCreditLimit }).invoke(REQUEST(), signal(), signal());
    expect(onCreditLimit).not.toHaveBeenCalled();
    const throwing = () => {
      throw new Error(SENTINEL);
    };
    expect(await createBrowserShellClient({ disclosure: ACCEPTED, fetcher: answering(() => json({ kind: "REFUSED", reason: "SPEND_CEILING_REACHED", notSentToProvider: true }, 403)), onCreditLimit: throwing }).invoke(REQUEST(), signal())).toMatchObject({ refusal: "SPEND_CEILING_REACHED" });
  });

  it("end to end with the real route over a fake DeepSeek transport: HTTP 402 Insufficient Balance arrives as OPERATIONAL_SPEND_LOCKED, with no provider text", async () => {
    const insufficient = vi.fn(async () => new Response(JSON.stringify({ error: { message: `Insufficient Balance ${SENTINEL}`, type: "unknown_error" } }), { status: 402, headers: { "content-type": "application/json" } }));
    const handle = createAiShellHandler({ environment: { ...TEST_DEPLOYMENT_ENVIRONMENT, DEEPSEEK_API_KEY: "SENTINEL-key" }, fetcher: insufficient, activationManifest: ENABLED, requestClassGate: qualifiedTestRequestClassGate() });
    const seen: string[] = [];
    const fetcher = vi.fn<BrowserShellFetcher>(async (url, init) => {
      const response = await handle(new Request(`${TEST_ORIGIN}${url}`, { ...init, headers: { ...(init.headers as Record<string, string>), Origin: TEST_ORIGIN, "Sec-Fetch-Site": "same-origin" } }));
      const text = await response.text();
      seen.push(text);
      return new Response(text, { status: response.status, headers: response.headers });
    });
    const onCreditLimit = vi.fn();
    const token = signal();
    const result = await createBrowserShellClient({ disclosure: ACCEPTED, fetcher, accessPasscode: () => TEST_PASSCODE, onCreditLimit }).invoke(REQUEST(), signal(), token);
    expect(insufficient).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ kind: "FAILED", reason: "OPERATIONAL_SPEND_LOCKED" });
    expect(onCreditLimit.mock.calls).toEqual([[token]]);
    expect(seen.join("")).not.toMatch(/Insufficient|SENTINEL|unknown_error/);
  });
});

