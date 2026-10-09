// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEEPSEEK_DOCUMENTED_MODELS, DEEPSEEK_RESPONSES_URL, deepSeekCostMicroUsd } from "@/ai/deepseek/deepseek-catalogue";
import { createDeepSeekShellResponsesProvider } from "@/ai/deepseek/deepseek-responses-provider";
import { PACKET_11_ADVERSARIAL_SHELLS, PACKET_11_HYBRID_FIXTURES } from "@/ai/evaluation/packet-11-hybrid-fixtures";
import { plannedFixture, shellCandidate } from "@/ai/evaluation/packet-11-hybrid-test-support";
import { selectEvaluationCandidates } from "@/ai/kie/kie-route-config";
import { AI_ACTIVATION_MANIFEST, type AiActivationManifest } from "@/application/ai/ai-activation-manifest";
import { createAiHybridTaskService } from "@/application/ai/ai-hybrid-task-service";
import { AI_HYBRID_RUNTIME_BUNDLES } from "@/application/ai/ai-hybrid-runtime-bundles";
import type { AiShellProviderPort, ProviderInvocationResult } from "@/application/ai/ai-provider-port";
import { AI_SHELL_MAX_BODY_BYTES, AI_SHELL_ROUTE_POST_CALL_FAILURE_REASONS, aiShellRouteResponseSchema, shellCallUpperBound, shellRouteCallUpperBound } from "@/application/ai/ai-shell-route-contract";
import { AI_TASK_RUNTIME_BUNDLES } from "@/application/ai/ai-runtime-bundles";
import { projectProviderTaskPayload } from "@/application/ai/detached-payload-projector";
import { defaultShells } from "@/application/ai/language/default-shells";
import { projectShellTaskRequest } from "@/application/ai/language/shell-projector";
import { planSlots } from "@/application/ai/language/slot-planner";
import type { AiInvocationAuditRow, AiTaskRequest, ShellFieldPath, ShellTaskRequest } from "@/domain/ai";
import { requestFixture, sourceBackedRequest } from "@/domain/ai/ai-test-fixtures";
import { createAiShellHandler } from "./ai-shell-handler";
import * as route from "./route";

/**
 * Packet 11C Addendum B, Task B2a: the value-blind shell route POST /api/ai/shell (B-boundary, D1, D2, D6). Fake fetchers only; no live
 * call. The provider is fixed (Direct DeepSeek, deepseek-flash); activation is tested only with an injected test manifest.
 */

const TOKEN = "deepseek-SENTINEL-route-credential";
const ENV = { DEEPSEEK_API_KEY: TOKEN };
const ENABLED: AiActivationManifest = {
  ...AI_ACTIVATION_MANIFEST,
  tasks: { ...AI_ACTIVATION_MANIFEST.tasks, EXPLAIN_PATTERN: "SYNTHETIC_REMOTE_ENABLED", DRAFT_CARE_PREPARATION_SUMMARY: "SYNTHETIC_REMOTE_ENABLED" },
};
const EN = plannedFixture("p11.explain-pattern.en-sg.ordinary");
const ZH = plannedFixture("p11.explain-pattern.zh-sg.ordinary");
const CARE = plannedFixture("p11.draft-care-preparation-summary.en-sg.ordinary");
const CARE_ZH = plannedFixture("p11.draft-care-preparation-summary.zh-sg.ordinary");
const shellRequest = (fixture = EN): ShellTaskRequest => structuredClone(projectShellTaskRequest(fixture.plan)) as ShellTaskRequest;
const VALID = shellCandidate(EN.plan, new Map<ShellFieldPath, string>([["headline", "A look at {{S1}}."], ["evidence", "This is based on {{S3}}."]]));
const USAGE = { inputTokens: 600, outputTokens: 80, costMicroUsd: deepSeekCostMicroUsd(600, 80) };

/** A documented DeepSeek Responses envelope around one output text. */
const envelope = (text: string, extra: Record<string, unknown> = {}) => ({
  id: "resp_1", object: "response", status: "completed", model: "deepseek-flash",
  output: [{ type: "message", id: "msg_1", status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }],
  usage: { input_tokens: 600, output_tokens: 80, output_tokens_details: { reasoning_tokens: 0 } },
  store: false, error: null, incomplete_details: null, ...extra,
});
const deepseek = (candidate: unknown = VALID, extra: Record<string, unknown> = {}, status = 200) =>
  vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify(status === 200 ? envelope(typeof candidate === "string" ? candidate : JSON.stringify(candidate), extra) : candidate), { status, headers: { "content-type": "application/json" } }));

function post(body: unknown, init: { headers?: Record<string, string>; method?: string; signal?: AbortSignal; raw?: string } = {}) {
  return new Request("http://localhost/api/ai/shell", {
    method: init.method ?? "POST",
    headers: { "content-type": "application/json", ...init.headers },
    body: init.method === "GET" ? undefined : (init.raw ?? JSON.stringify(body)),
    signal: init.signal,
  });
}
/** A recording environment: any read of the credential (or any other key) is observable. */
function recordingEnvironment(values: Record<string, string> = ENV) {
  const reads: string[] = [];
  const environment = new Proxy({ ...values } as Record<string, string | undefined>, { get: (target, key) => (reads.push(String(key)), target[String(key)]) });
  return { environment, reads };
}
type Options = Partial<Parameters<typeof createAiShellHandler>[0]>;
const handler = (options: Options = {}) => createAiShellHandler({ environment: ENV, activationManifest: ENABLED, ...options });
async function call(request: Request, options: Options = {}) {
  const response = await handler(options)(request);
  return { status: response.status, headers: response.headers, body: await response.json() };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("route module", () => {
  it("exports only a force-dynamic POST handler that reads the server environment", () => {
    expect(route.dynamic).toBe("force-dynamic");
    expect(Object.keys(route).sort()).toEqual(["POST", "dynamic"]);
    const source = readFileSync(join(process.cwd(), "src/app/api/ai/shell/route.ts"), "utf8");
    expect(source).toContain("process.env");
    expect(source).not.toMatch(/NEXT_PUBLIC_/);
  });

  it("the shipped route is NOT_ACTIVATED: a valid approved request is refused server-side with no credential read and no fetch", async () => {
    const fetcher = deepseek();
    const { environment, reads } = recordingEnvironment();
    const response = await createAiShellHandler({ environment, fetcher })(post(shellRequest()));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ kind: "FAILED", reason: "TASK_DISABLED" });
    expect(reads).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  /**
   * Packet 11C B2b (B2a review follow-up): the route module itself, through its exported POST, with a recording process.env. The module
   * is re-imported after the probe is installed, because it hands process.env to the handler when it is evaluated.
   */
  it("route.POST (shipped manifest) refuses every request kind with no credential read and no network call", async () => {
    const reads: string[] = [];
    const original = process.env;
    const fetchSpy = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchSpy);
    process.env = new Proxy({ ...original, DEEPSEEK_API_KEY: TOKEN, KIE_API_KEY: TOKEN }, { get: (target, key) => (typeof key === "string" && /API_KEY|TOKEN|SECRET/.test(key) && reads.push(key), Reflect.get(target, key)) });
    try {
      vi.resetModules();
      const fresh = await import("./route");
      const make: Array<[string, () => Request, number, unknown]> = [
        ["an approved request", () => post(shellRequest()), 200, { kind: "FAILED", reason: "TASK_DISABLED" }],
        ["an approved care request", () => post(shellRequest(CARE)), 200, { kind: "FAILED", reason: "TASK_DISABLED" }],
        ["raw facts", () => post({ ...shellRequest(), facts: [] }), 400, { kind: "FAILED", reason: "PAYLOAD_INVALID" }],
        ["the internal source-backed request", () => post(sourceBackedRequest()), 400, { kind: "FAILED", reason: "PAYLOAD_INVALID" }],
        ["malformed JSON", () => post(undefined, { raw: "{not json" }), 400, { kind: "FAILED", reason: "PAYLOAD_INVALID" }],
        ["a GET", () => post(undefined, { method: "GET" }), 405, { kind: "FAILED", reason: "PAYLOAD_INVALID" }],
      ];
      for (const [label, request, status, body] of make) {
        const response = await fresh.POST(request());
        expect(response.status, label).toBe(status);
        expect(await response.json(), label).toEqual(body);
      }
      expect(reads).toEqual([]);
      // Positive control: the installed probe records a credential read.
      void process.env.DEEPSEEK_API_KEY;
      expect(reads).toEqual(["DEEPSEEK_API_KEY"]);
    } finally {
      process.env = original;
      vi.resetModules();
      vi.unstubAllGlobals();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rechecks the exact HACKATHON_DEMO profile on the server", async () => {
    const fetcher = deepseek();
    for (const releaseProfile of ["PRODUCTION", "hackathon_demo", undefined]) {
      expect((await call(post(shellRequest()), { fetcher, releaseProfile })).body).toEqual({ kind: "FAILED", reason: "PROFILE_NOT_PERMITTED" });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("request admission: only an approved value-blind ShellTaskRequest, refused before any credential read or fetch", () => {
  const legacyDetached = (taskType: "EXPLAIN_PATTERN" | "DRAFT_CARE_PREPARATION_SUMMARY" = "EXPLAIN_PATTERN") => {
    const projected = projectProviderTaskPayload(requestFixture(taskType), AI_TASK_RUNTIME_BUNDLES[taskType]);
    if (projected.kind !== "PROJECTED") throw new Error(projected.reason);
    return projected.payload;
  };
  const BINDING = (sourceBackedRequest().taskPayload as { periodSummary: unknown }).periodSummary;
  const mutate = (fixture: typeof EN, change: (request: any) => void) => () => {
    const request = shellRequest(fixture) as any;
    change(request);
    return request;
  };
  const refusals: Array<[string, () => unknown]> = [
    // Raw facts, values, dates and questions.
    ["raw patient facts", mutate(EN, (r) => (r.facts = legacyDetached().facts))],
    ["a reading value in a gloss", mutate(EN, (r) => (r.slots[0].gloss = "the value 6.2 mmol/L"))],
    ["a reading value in a field", mutate(EN, (r) => (r.value = "6.2"))],
    ["a date in a gloss", mutate(EN, (r) => (r.slots[0].gloss = "recorded on 1 September"))],
    ["an ISO date in a gloss", mutate(EN, (r) => (r.slots[0].gloss = "2026-09-01"))],
    ["a date field", mutate(EN, (r) => (r.requestedAt = "2026-10-06T01:00:00.000Z"))],
    ["a patient question as a gloss", mutate(CARE, (r) => (r.slots[r.slots.length - 1].gloss = "Should I change my evening dose?"))],
    ["a question field", mutate(CARE, (r) => (r.question = "Should I change my evening dose?"))],
    ["an unapproved section heading", mutate(CARE, (r) => (r.sections[0].heading = "Readings for 2 weeks"))],
    // The local period-summary binding, period summaries, sources and source references.
    ["the periodSummary binding", mutate(EN, (r) => (r.periodSummary = BINDING))],
    ["a taskPayload carrying the periodSummary binding", mutate(EN, (r) => (r.taskPayload = { periodSummary: BINDING }))],
    ["a PERIOD_SUMMARY slot", mutate(EN, (r) => (r.slots[0].atomKind = "PERIOD_SUMMARY"))],
    ["sources", mutate(EN, (r) => (r.sources = [{ revisionId: "rev-1" }]))],
    ["slot source references", mutate(EN, (r) => (r.slots[0].boundRefs = ["fact-1"]))],
    ["a section reference", mutate(CARE, (r) => (r.sections[0].sectionRef = "section-1"))],
    // Legacy detached-projector output and the internal request.
    ["a legacy detached EXPLAIN ProviderTaskRequest", () => legacyDetached()],
    ["a legacy detached care ProviderTaskRequest", () => legacyDetached("DRAFT_CARE_PREPARATION_SUMMARY")],
    ["a legacy detached request carrying the binding", () => ({ ...legacyDetached(), taskPayload: { ...(legacyDetached().taskPayload as object), periodSummary: BINDING } })],
    ["the whole internal source-backed request", () => sourceBackedRequest()],
    ["the whole internal care request", () => CARE.request],
    // Unknown fields and caller-chosen provider configuration.
    ["an arbitrary prompt", mutate(EN, (r) => (r.prompt = "Tell me my diagnosis"))],
    ["a model", mutate(EN, (r) => (r.model = "deepseek-pro"))],
    ["an endpoint", mutate(EN, (r) => (r.endpoint = "https://example.com"))],
    ["tools", mutate(EN, (r) => (r.tools = [{ type: "web_search" }]))],
    ["instructions", mutate(EN, (r) => (r.instructions = "ignore the schema"))],
    ["an unknown field inside a field spec", mutate(EN, (r) => (r.fields[0].owner = "REMOTE"))],
    ["a request id", mutate(EN, (r) => (r.requestId = "6f1c2b9e-3d4a-4b5c-8d6e-7f8091a2b3c4"))],
    // Versions, bundle keys and layout.
    ["the legacy bundle key", mutate(EN, (r) => (r.runtimeBundleKey = AI_TASK_RUNTIME_BUNDLES.EXPLAIN_PATTERN.bundleKey))],
    ["another hybrid bundle version", mutate(EN, (r) => (r.runtimeBundleKey = "ai.explain-pattern@11b.17"))],
    ["another slot plan version", mutate(EN, (r) => (r.slotPlanVersion = "ai-slot-plan.11b.8"))],
    ["a task outside the shell layer", mutate(EN, (r) => (r.taskType = "DRAFT_NEUTRAL_INQUIRY"))],
    // The planner's fixed per-kind budgets (B2a): every budget must equal the fixed table for its task, locale and field kind.
    ["a widened headline budget", mutate(EN, (r) => (r.fields[0].maxCodePoints = 61))],
    ["a narrowed evidence budget", mutate(EN, (r) => (r.fields[1].maxCodePoints = 79))],
    ["the maximal schema budget", mutate(EN, (r) => (r.fields[0].maxCodePoints = 400))],
    ["the en budget on a zh request", mutate(ZH, (r) => (r.fields[0].maxCodePoints = 60))],
    ["a widened care intro budget", mutate(CARE, (r) => (r.fields[0].maxCodePoints = 61))],
    ["a widened care bullet budget", mutate(CARE, (r) => (r.fields[1].maxCodePoints = 41))],
    ["the en care bullet budget on a zh request", mutate(CARE_ZH, (r) => (r.fields[1].maxCodePoints = 40))],
    ["two sentences in a headline", mutate(EN, (r) => (r.fields[0].maxSentences = 2))],
    ["an atom-only headline", mutate(EN, (r) => (r.fields[0].mayBeAtomOnly = true))],
    ["an intro that may be atom-only", mutate(CARE, (r) => (r.fields[0].mayBeAtomOnly = true))],
    ["a bullet that may not be atom-only", mutate(CARE, (r) => (r.fields[1].mayBeAtomOnly = false))],
    // Not an object at all.
    ["an array", () => [shellRequest()]],
    ["null", () => null],
  ];

  it.each(refusals)("refuses %s with PAYLOAD_INVALID 400 before any credential read or fetch", async (_label, body) => {
    const fetcher = deepseek();
    const { environment, reads } = recordingEnvironment();
    expect(await call(post(body()), { fetcher, environment })).toMatchObject({ status: 400, body: { kind: "FAILED", reason: "PAYLOAD_INVALID" } });
    expect(reads).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each<[string, () => Request, number, string]>([
    ["a GET", () => post(undefined, { method: "GET" }), 405, "PAYLOAD_INVALID"],
    ["a PUT", () => post(shellRequest(), { method: "PUT" }), 405, "PAYLOAD_INVALID"],
    ["a text/plain body", () => post(shellRequest(), { headers: { "content-type": "text/plain" } }), 415, "PAYLOAD_INVALID"],
    ["a missing content type", () => new Request("http://localhost/api/ai/shell", { method: "POST", body: new Blob([JSON.stringify(shellRequest())]) }), 415, "PAYLOAD_INVALID"],
    ["a body above the cap", () => post(undefined, { raw: JSON.stringify({ ...shellRequest(), padding: "x".repeat(AI_SHELL_MAX_BODY_BYTES) }) }), 413, "BUDGET_EXCEEDED"],
    ["a body above the cap with a false content length", () => post(undefined, { raw: JSON.stringify({ ...shellRequest(), padding: "x".repeat(AI_SHELL_MAX_BODY_BYTES) }), headers: { "content-length": "10" } }), 413, "BUDGET_EXCEEDED"],
    ["a declared length above the cap", () => post(shellRequest(), { headers: { "content-length": String(AI_SHELL_MAX_BODY_BYTES + 1) } }), 413, "BUDGET_EXCEEDED"],
    ["malformed JSON", () => post(undefined, { raw: "{not json" }), 400, "PAYLOAD_INVALID"],
    ["duplicate keys", () => post(undefined, { raw: JSON.stringify(shellRequest()).replace('{"', '{"taskType":"EXPLAIN_PATTERN","') }), 400, "PAYLOAD_INVALID"],
  ])("refuses %s before any credential read or fetch", async (_label, request, status, reason) => {
    const fetcher = deepseek();
    const { environment, reads } = recordingEnvironment();
    expect(await call(request(), { fetcher, environment })).toMatchObject({ status, body: { kind: "FAILED", reason } });
    expect(reads).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("control: the recording probe observes the credential read once every request check has passed, and only the DeepSeek key is read", async () => {
    const fetcher = deepseek();
    const { environment, reads } = recordingEnvironment();
    expect((await call(post(shellRequest()), { fetcher, environment })).body).toMatchObject({ kind: "CANDIDATE" });
    expect(reads).toEqual(["DEEPSEEK_API_KEY"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("the largest approved request fits the body cap with room to spare", () => {
    const sizes = PACKET_11_HYBRID_FIXTURES.flatMap((fixture) => {
      const planned = planSlots(fixture.request, AI_HYBRID_RUNTIME_BUNDLES[fixture.taskType as "EXPLAIN_PATTERN"]);
      return planned.kind === "PLANNED" && planned.plan.remote.eligible ? [new TextEncoder().encode(JSON.stringify(projectShellTaskRequest(planned.plan))).byteLength] : [];
    });
    expect(sizes.length).toBeGreaterThan(20);
    expect(Math.max(...sizes) * 2).toBeLessThan(AI_SHELL_MAX_BODY_BYTES);
  });
});

describe("accepted requests and the server shell gates", () => {
  it("returns exactly the strictly parsed candidate, the closed retention code and the bounded usage, no-store", async () => {
    const fetcher = deepseek();
    const result = await call(post(shellRequest()), { fetcher });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ kind: "CANDIDATE", candidate: VALID, retention: "CONFIRMED_NOT_STORED", usage: USAGE });
    expect(aiShellRouteResponseSchema.safeParse(result.body).success).toBe(true);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(result.headers.get("content-type")).toMatch(/^application\/json/);
    expect(result.headers.get("x-content-type-options")).toBe("nosniff");
    expect(fetcher.mock.calls[0]![0]).toBe(DEEPSEEK_RESPONSES_URL);
    expect(fetcher.mock.calls[0]![1].headers).toMatchObject({ authorization: `Bearer ${TOKEN}` });
  });

  it("D2: sends the same model-facing body the evaluated Direct DeepSeek deepseek-flash shell provider sends, byte for byte", async () => {
    const selection = selectEvaluationCandidates({ requested: "deepseek-flash", listing: [], documented: DEEPSEEK_DOCUMENTED_MODELS, now: () => "2026-10-08T00:00:00.000Z" });
    if (selection.kind !== "SELECTED") throw new Error("deepseek-flash");
    const sourceBacked = planSlots(sourceBackedRequest() as AiTaskRequest, AI_HYBRID_RUNTIME_BUNDLES.EXPLAIN_PATTERN);
    if (sourceBacked.kind !== "PLANNED") throw new Error("source-backed");
    for (const plan of [EN.plan, ZH.plan, CARE.plan, CARE_ZH.plan, sourceBacked.plan]) {
      const request = projectShellTaskRequest(plan);
      const viaRoute = deepseek(shellCandidate(plan, defaultShells(plan)));
      await call(post(request), { fetcher: viaRoute });
      const direct = deepseek(shellCandidate(plan, defaultShells(plan)));
      await createDeepSeekShellResponsesProvider({ token: TOKEN, model: selection.candidates[0]!, fetcher: direct }).invoke(request, new AbortController().signal);
      expect(viaRoute.mock.calls[0]![1].body, plan.taskType).toBe(direct.mock.calls[0]![1].body);
      expect(JSON.parse(viaRoute.mock.calls[0]![1].body as string).model).toBe("deepseek-flash");
    }
  });

  it("accepts the default shells of every remote-eligible fixture (the server gates agree with the local plan)", async () => {
    let eligible = 0;
    for (const fixture of PACKET_11_HYBRID_FIXTURES) {
      const planned = planSlots(fixture.request, AI_HYBRID_RUNTIME_BUNDLES[fixture.taskType as "EXPLAIN_PATTERN"]);
      if (planned.kind !== "PLANNED" || planned.plan.remote.eligible !== true) continue;
      eligible += 1;
      const candidate = shellCandidate(planned.plan, defaultShells(planned.plan));
      expect((await call(post(projectShellTaskRequest(planned.plan)), { fetcher: deepseek(candidate) })).body, fixture.id).toEqual({ kind: "CANDIDATE", candidate, retention: "CONFIRMED_NOT_STORED", usage: USAGE });
    }
    expect(eligible).toBeGreaterThan(20);
  });

  it("returns the typed structural rejection of every adversarial shell at the server gates, without the candidate", async () => {
    let cases = 0;
    for (const entry of PACKET_11_ADVERSARIAL_SHELLS.filter((item) => item.expectedGate !== "S9")) {
      const fixture = PACKET_11_HYBRID_FIXTURES.find((item) => item.id === entry.baseFixtureId)!;
      const planned = planSlots(fixture.request, AI_HYBRID_RUNTIME_BUNDLES[fixture.taskType as "EXPLAIN_PATTERN"]);
      if (planned.kind !== "PLANNED") throw new Error(entry.id);
      const base = shellCandidate(planned.plan, defaultShells(planned.plan)) as any;
      const candidate = entry.raw === "EXTRA_BRACE" ? `${JSON.stringify(base)}}` : { ...base, ...(entry.envelope ?? {}), shells: { ...base.shells, ...entry.override } };
      if (entry.introOverride) candidate.shells.sections[entry.introOverride.sectionIndex].intro = entry.introOverride.text;
      if (entry.bulletOverride) candidate.shells.sections[entry.bulletOverride.sectionIndex].bullets[entry.bulletOverride.bulletIndex] = entry.bulletOverride.text;
      const fetcher = deepseek(candidate);
      const result = await call(post(projectShellTaskRequest(planned.plan)), { fetcher });
      const repairable = entry.expectedReason === "SCHEMA_INVALID" && (entry.expectedGate === "S1" || entry.expectedGate === "S2");
      expect(result.body, entry.id).toEqual({ kind: "STRUCTURALLY_REJECTED", reason: entry.expectedReason, repairable, retention: "CONFIRMED_NOT_STORED", usage: USAGE });
      expect(aiShellRouteResponseSchema.safeParse(result.body).success, entry.id).toBe(true);
      // The route makes one call and never retries; the evaluation-only gate details never leave the server.
      expect(fetcher, entry.id).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(result.body), entry.id).not.toMatch(/shells|headline|evidence|\{\{S|gate|integrity|lexical|register|quality|clinicalLabel/);
      cases += 1;
    }
    expect(cases).toBeGreaterThan(20);
  });

  it("an abstention is a non-repairable MODEL_ABSTAINED rejection", async () => {
    const abstain = { ...(VALID as object), outcome: "ABSTAIN", abstentionReason: "INSUFFICIENT_CONTEXT", shells: null };
    expect((await call(post(shellRequest()), { fetcher: deepseek(abstain) })).body).toEqual({ kind: "STRUCTURALLY_REJECTED", reason: "MODEL_ABSTAINED", repairable: false, retention: "CONFIRMED_NOT_STORED", usage: USAGE });
  });
});

describe("provider outcomes", () => {
  it.each([
    [429, "PROVIDER_RATE_LIMITED"],
    [500, "PROVIDER_FAILED"],
    [400, "PROVIDER_REJECTED"],
    [401, "MISSING_CONFIGURATION"],
  ])("maps provider HTTP %s to %s without echoing provider details", async (status, reason) => {
    const result = await call(post(shellRequest()), { fetcher: deepseek({ error: { message: `upstream detail ${TOKEN}`, type: "x" } }, {}, status) });
    // Packet 11C Addendum C (C5): the transmitted call's usage is unreadable, so it carries its pre-send upper bound (nothing else).
    expect(result.body).toMatchObject({ kind: "FAILED", reason, usage: { basis: "UPPER_BOUND" } });
    expect(Object.keys(result.body).sort()).toEqual(["kind", "reason", "usage"]);
    expect(JSON.stringify(result.body)).not.toMatch(/upstream detail|SENTINEL/);
  });

  it("falls back on a missing key without a provider call", async () => {
    const fetcher = deepseek();
    expect((await call(post(shellRequest()), { fetcher, environment: {} })).body).toEqual({ kind: "FAILED", reason: "MISSING_CONFIGURATION" });
    // Another provider's key is never read as this route's credential.
    expect((await call(post(shellRequest()), { fetcher, environment: { KIE_API_KEY: TOKEN, NEXT_PUBLIC_DEEPSEEK_API_KEY: TOKEN } })).body).toEqual({ kind: "FAILED", reason: "MISSING_CONFIGURATION" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ["reported as stored", { store: true }],
    ["from another model", { model: "deepseek-pro" }],
  ])("fails closed on a response %s, with no candidate and no detail (only the billed usage)", async (_label, extra) => {
    const result = await call(post(shellRequest()), { fetcher: deepseek(VALID, extra) });
    // Packet 11C Addendum C (C5): the billed call's reported usage is forwarded (it was dropped inside the adapter before C5).
    expect(result.body).toEqual({ kind: "FAILED", reason: "PROVIDER_FAILED", usage: { ...USAGE, basis: "REPORTED" } });
    expect(JSON.stringify(result.body)).not.toMatch(/store|RETENTION|deepseek|headline/);
  });

  // Packet 11C B2b (B2a review follow-up): a completed, billed response refused for retention reports its bounded usage, so the browser
  // service counts the spend. Still no candidate, retention code or detail.
  it("fails closed on a completed response with retention unconfirmed, reporting only the bounded usage", async () => {
    const result = await call(post(shellRequest()), { fetcher: deepseek(VALID, { store: null }) });
    expect(result.body).toEqual({ kind: "FAILED", reason: "PROVIDER_FAILED", usage: { ...USAGE, basis: "REPORTED" } });
    expect(aiShellRouteResponseSchema.safeParse(result.body).success).toBe(true);
    expect(JSON.stringify(result.body)).not.toMatch(/store|RETENTION|deepseek|headline|candidate/);
  });

  /**
   * Packet 11C Addendum C, Task C5 (supersedes the B5 "retention refusal only" pin; owner decision: preserve reported usage on failed
   * attempts, account conservatively when an attempted call might have been billed but usage is missing). A FAILED decided before any
   * provider call carries no usage. Every FAILED after the route called the provider carries that call's usage: the reported usage when
   * the provider reported it, otherwise the call's pre-send upper bound (the adapter's, for the exact body it sent), each with its basis.
   */
  it("a FAILED before any provider call carries no usage; every FAILED after a provider call carries reported usage or the upper bound", async () => {
    const aborted = new AbortController();
    aborted.abort();
    const beforeCall: Array<[string, () => Promise<{ body: unknown }>]> = [
      ["a GET", () => call(post(undefined, { method: "GET" }), { fetcher: deepseek() })],
      ["a non-JSON content type", () => call(post(shellRequest(), { headers: { "content-type": "text/plain" } }), { fetcher: deepseek() })],
      ["an oversized body", () => call(post(undefined, { raw: "x".repeat(AI_SHELL_MAX_BODY_BYTES + 1) }), { fetcher: deepseek() })],
      ["malformed JSON", () => call(post(undefined, { raw: "{not json" }), { fetcher: deepseek() })],
      ["raw facts", () => call(post({ ...shellRequest(), facts: [] }), { fetcher: deepseek() })],
      ["the shipped manifest", () => call(post(shellRequest()), { fetcher: deepseek(), activationManifest: AI_ACTIVATION_MANIFEST })],
      ["another release profile", () => call(post(shellRequest()), { fetcher: deepseek(), releaseProfile: "PRODUCTION" })],
      ["a missing key", () => call(post(shellRequest()), { fetcher: deepseek(), environment: {} })],
      ["a request cancelled before the call", () => call(post(shellRequest(), { signal: aborted.signal }), { fetcher: deepseek() })],
    ];
    for (const [label, run] of beforeCall) {
      const { body } = await run();
      expect(body, label).toMatchObject({ kind: "FAILED" });
      expect(Object.keys(body as object).sort(), label).toEqual(["kind", "reason"]);
    }
    // The rate limit refuses before any call: no usage either.
    const limited = handler({ fetcher: deepseek(), rateLimit: { maxRequests: 1, windowMs: 60_000 }, now: () => new Date("2026-10-08T01:00:00.000Z") });
    await limited(post(shellRequest()));
    expect(await (await limited(post(shellRequest()))).json()).toEqual({ kind: "FAILED", reason: "PROVIDER_RATE_LIMITED" });

    const reported: Array<[string, Record<string, unknown>]> = [
      ["a response reported as stored", { store: true }],
      ["a response from another model", { model: "deepseek-pro" }],
      ["an incomplete (truncated) response", { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }],
      ["a response with retention unconfirmed", { store: null }],
    ];
    for (const [label, extra] of reported) {
      expect((await call(post(shellRequest()), { fetcher: deepseek(VALID, extra) })).body, label).toEqual({ kind: "FAILED", reason: "PROVIDER_FAILED", usage: { ...USAGE, basis: "REPORTED" } });
    }

    // No readable usage after transmission: the adapter's pre-send upper bound of the exact body it sent (never zero).
    const exactBound = (fetcher: ReturnType<typeof vi.fn>) => {
      const { inputTokens, outputTokens, costMicroUsd } = shellCallUpperBound(new TextEncoder().encode(String((fetcher.mock.calls[0]![1] as RequestInit).body)).byteLength, "EXPLAIN_PATTERN");
      return { inputTokens, outputTokens, costMicroUsd, basis: "UPPER_BOUND" };
    };
    const unreadable: Array<[string, () => ReturnType<typeof vi.fn>, string]> = [
      ["provider HTTP 429", () => deepseek({ error: "x" }, {}, 429), "PROVIDER_RATE_LIMITED"],
      ["provider HTTP 500", () => deepseek({ error: "x" }, {}, 500), "PROVIDER_FAILED"],
      ["provider HTTP 400", () => deepseek({ error: "x" }, {}, 400), "PROVIDER_REJECTED"],
      ["provider HTTP 401", () => deepseek({ error: "x" }, {}, 401), "MISSING_CONFIGURATION"],
      ["a transport failure", () => vi.fn(async (_url: string, _init: RequestInit): Promise<Response> => Promise.reject(new Error("offline"))), "TRANSPORT_FAILED"],
    ];
    for (const [label, make, reason] of unreadable) {
      const fetcher = make();
      const { body } = await call(post(shellRequest()), { fetcher });
      expect(body, label).toEqual({ kind: "FAILED", reason, usage: exactBound(fetcher) });
      expect(aiShellRouteResponseSchema.safeParse(body).success, label).toBe(true);
    }
  });

  // C5 fix round 1: a provider that throws after its request was transmitted may have been billed: the route's pre-send upper bound.
  it("a provider throw after transmission is FAILED TRANSPORT_FAILED with the route's upper bound (basis UPPER_BOUND), never without usage", async () => {
    // A response whose headers cannot be read makes the real adapter's invoke reject after the fetch returned.
    const hostile = { ok: true, status: 200, body: null, headers: { get: () => { throw new Error("hostile headers"); } } } as unknown as Response;
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => hostile);
    const { body } = await call(post(shellRequest()), { fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(body).toEqual({ kind: "FAILED", reason: "TRANSPORT_FAILED", usage: shellRouteCallUpperBound(shellRequest()) });
    expect(aiShellRouteResponseSchema.safeParse(body).success).toBe(true);
  });

  it("the tightened contract refuses usage on a FAILED that cannot follow a provider call, and an implicit basis on a FAILED", () => {
    const usage = { inputTokens: 1, outputTokens: 1, costMicroUsd: 1 };
    for (const reason of AI_SHELL_ROUTE_POST_CALL_FAILURE_REASONS) expect(aiShellRouteResponseSchema.safeParse({ kind: "FAILED", reason, usage: { ...usage, basis: "UPPER_BOUND" } }).success, reason).toBe(true);
    for (const reason of ["PAYLOAD_INVALID", "BUDGET_EXCEEDED", "TASK_DISABLED", "PROFILE_NOT_PERMITTED", "PRIVACY_REJECTED", "SCHEMA_INVALID"]) {
      expect(aiShellRouteResponseSchema.safeParse({ kind: "FAILED", reason, usage: { ...usage, basis: "REPORTED" } }).success, reason).toBe(false);
      expect(aiShellRouteResponseSchema.safeParse({ kind: "FAILED", reason }).success, reason).toBe(true);
    }
    expect(aiShellRouteResponseSchema.safeParse({ kind: "FAILED", reason: "PROVIDER_FAILED", usage }).success).toBe(false);
    expect(aiShellRouteResponseSchema.safeParse({ kind: "FAILED", reason: "PROVIDER_FAILED", usage: { ...usage, basis: "ESTIMATE" } }).success).toBe(false);
    // A completed call's usage is reported: an explicit or implicit REPORTED basis, never an upper bound.
    expect(aiShellRouteResponseSchema.safeParse({ kind: "STRUCTURALLY_REJECTED", reason: "SCHEMA_INVALID", repairable: true, retention: "CONFIRMED_NOT_STORED", usage }).success).toBe(true);
    expect(aiShellRouteResponseSchema.safeParse({ kind: "STRUCTURALLY_REJECTED", reason: "SCHEMA_INVALID", repairable: true, retention: "CONFIRMED_NOT_STORED", usage: { ...usage, basis: "REPORTED" } }).success).toBe(true);
    expect(aiShellRouteResponseSchema.safeParse({ kind: "STRUCTURALLY_REJECTED", reason: "SCHEMA_INVALID", repairable: true, retention: "CONFIRMED_NOT_STORED", usage: { ...usage, basis: "UPPER_BOUND" } }).success).toBe(false);
    // The audit-only outcome codes are not route reasons.
    expect(aiShellRouteResponseSchema.safeParse({ kind: "FAILED", reason: "REMOTE_USE_DECLINED" }).success).toBe(false);
  });

  it("limits requests per window before calling the provider", async () => {
    const fetcher = deepseek();
    const limited = handler({ fetcher, rateLimit: { maxRequests: 2, windowMs: 60_000 }, now: () => new Date("2026-10-08T01:00:00.000Z") });
    const bodies = [];
    for (let index = 0; index < 3; index += 1) bodies.push(await (await limited(post(shellRequest()))).json());
    expect(bodies[2]).toEqual({ kind: "FAILED", reason: "PROVIDER_RATE_LIMITED" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("times out at the bundle per-call ceiling, aborts the fetch and never returns a late result", async () => {
    vi.useFakeTimers();
    let aborted = false;
    let release: (() => void) | undefined;
    const fetcher = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((resolve) => {
          init.signal?.addEventListener("abort", () => (aborted = true));
          release = () => resolve(new Response(JSON.stringify(envelope(JSON.stringify(VALID)))));
        }),
    );
    const pending = handler({ fetcher })(post(shellRequest()));
    await vi.advanceTimersByTimeAsync(AI_HYBRID_RUNTIME_BUNDLES.EXPLAIN_PATTERN.executionBudget.perCallTimeoutMs);
    release?.();
    // Packet 11C Addendum C (C5): the call was made and may be billed; its usage is unknown, so the route reports its pre-send upper bound.
    expect(await (await pending).json()).toEqual({ kind: "FAILED", reason: "PROVIDER_TIMEOUT", usage: shellRouteCallUpperBound(shellRequest()) });
    expect(aborted).toBe(true);
  });

  it("propagates client cancellation to the provider fetch", async () => {
    const controller = new AbortController();
    let aborted = false;
    const fetcher = vi.fn((_url: string, init: RequestInit) => new Promise<Response>(() => init.signal?.addEventListener("abort", () => (aborted = true))));
    const pending = handler({ fetcher })(post(shellRequest(), { signal: controller.signal }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    // C5: cancelled after the provider call started: potentially billed, so the pre-send upper bound (the browser counts its own too).
    expect(await (await pending).json()).toEqual({ kind: "FAILED", reason: "REQUEST_CANCELLED", usage: shellRouteCallUpperBound(shellRequest()) });
    expect(aborted).toBe(true);
  });

  it("never returns or logs the credential", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
    const bodies = [
      (await call(post(shellRequest()), { fetcher: deepseek() })).body,
      (await call(post(shellRequest()), { fetcher: deepseek({ error: TOKEN }, {}, 500) })).body,
      (await call(post(shellRequest()), { fetcher: vi.fn(async () => Promise.reject(new Error(TOKEN))) })).body,
    ];
    expect(JSON.stringify(bodies)).not.toContain(TOKEN);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("every response body parses strictly with the shared route contract", async () => {
    const bodies = [
      (await call(post(shellRequest()), { fetcher: deepseek() })).body,
      (await call(post(shellRequest()), { fetcher: deepseek(`${JSON.stringify(VALID)}}`) })).body,
      (await call(post(shellRequest()), { fetcher: deepseek({}, {}, 500) })).body,
      (await call(post({ nope: true }), { fetcher: deepseek() })).body,
    ];
    for (const body of bodies) expect(aiShellRouteResponseSchema.safeParse(body).success, JSON.stringify(body)).toBe(true);
  });
});

/**
 * D6 end to end (test-only adapter; the browser shell client is Task B2b): the hybrid service calls the route once per attempt, the route
 * returns a typed rejection for an S1-malformed candidate, and the one structural repair happens in the service, never in the route.
 */
describe("the structural repair happens once, in the hybrid service (D6)", () => {
  function viaRoute(handle: (request: Request) => Promise<Response>): AiShellProviderPort {
    return {
      providerModel: { providerKey: "deepseek", modelSnapshot: "deepseek-flash" },
      invoke: async (input, signal): Promise<ProviderInvocationResult> => {
        const body = aiShellRouteResponseSchema.parse(await (await handle(post(input, { signal }))).json());
        if (body.kind === "FAILED") return { kind: "FAILED", reason: body.reason as "PROVIDER_FAILED" };
        if (body.kind === "STRUCTURALLY_REJECTED") return body;
        return { kind: "COMPLETED", candidate: body.candidate, usage: body.usage, retention: body.retention };
      },
    };
  }
  async function run(candidates: unknown[]) {
    const queue = [...candidates];
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify(envelope(typeof queue[0] === "string" ? (queue.shift() as string) : JSON.stringify(queue.shift())))));
    const rows: AiInvocationAuditRow[] = [];
    const service = createAiHybridTaskService({ releaseProfile: "HACKATHON_DEMO", manifest: ENABLED, provider: viaRoute(handler({ fetcher })), audit: { append: async (row) => void rows.push(row) }, now: () => "2026-10-08T01:00:00.000Z", monotonicMs: () => 0 });
    return { result: await service.execute(EN.request), rows, fetcher };
  }

  it("a malformed first candidate is repaired once and the second is accepted; usage is counted for both attempts", async () => {
    const { result, rows, fetcher } = await run([`${JSON.stringify(VALID)}}`, VALID]);
    expect(result).toMatchObject({ kind: "COMPOSED", source: "AI", mode: "REMOTE_AI", reason: null });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.attempts).toEqual({ count: 2, structuralRepairUsed: true, timedOut: false });
    expect(rows[0]!.measurements).toMatchObject({ inputTokens: 1200, outputTokens: 160, costMicroUsd: 2 * USAGE.costMicroUsd });
  });

  it("malformed twice falls back after maxAttempts; a final gate rejection is never repaired", async () => {
    const twice = await run([`${JSON.stringify(VALID)}}`, `${JSON.stringify(VALID)}}`, VALID]);
    expect(twice.result).toMatchObject({ kind: "COMPOSED", source: "DETERMINISTIC", reason: "SCHEMA_INVALID" });
    expect(twice.fetcher).toHaveBeenCalledTimes(2);
    const final = await run([{ ...(VALID as any), shells: { ...(VALID as any).shells, evidence: "About 10 of {{S3}}." } }, VALID]);
    expect(final.result).toMatchObject({ kind: "COMPOSED", source: "DETERMINISTIC", reason: "FACT_FIDELITY_FAILED" });
    expect(final.fetcher).toHaveBeenCalledTimes(1);
    expect(final.rows[0]!.measurements).toMatchObject(USAGE);
  });
});
