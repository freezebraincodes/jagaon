// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AI_TASK_RUNTIME_BUNDLES } from "@/application/ai/ai-runtime-bundles";
import { projectProviderTaskPayload } from "@/application/ai/detached-payload-projector";
import { projectShellTaskRequest } from "@/application/ai/language/shell-projector";
import { plannedFixture } from "@/ai/evaluation/packet-11-hybrid-test-support";
import type { ProviderTaskRequest } from "@/domain/ai";
import { requestFixture, sourceBackedRequest } from "@/domain/ai/ai-test-fixtures";
import { createAiTaskHandler } from "./ai-task-handler";
import * as route from "./route";

/**
 * Packet 11C Addendum B, Task B2a (B-boundary, D1): the legacy fact-sending route POST /api/ai/task is RETIRED. It refuses every request
 * with one closed reason before reading the body, any credential or the environment, and it constructs no provider, so a later activation
 * cannot re-open the legacy path. The app never calls it; evaluation runners call the provider adapters directly, never this route.
 *
 * Deliberate retarget (2026-10-08): the Packet 11B Task 3 tests of this file (admission, server recheck, Kie outcomes, retention, Option B
 * approved meaning at the route, Packet 11C Task 6A source-backed refusal) tested a route that no longer sends anything. Their guarantees
 * now hold more strongly — nothing is ever sent — and the value-blind successor POST /api/ai/shell carries its own admission, retention,
 * credential and refusal tests (src/app/api/ai/shell/route.test.ts). The Task 6A refusals are kept below as retirement cases.
 */

const RETIRED = { kind: "UNAVAILABLE", reason: "TASK_DISABLED" };
function detached(taskType: "EXPLAIN_PATTERN" | "DRAFT_CARE_PREPARATION_SUMMARY" = "EXPLAIN_PATTERN"): ProviderTaskRequest {
  const projected = projectProviderTaskPayload(requestFixture(taskType), AI_TASK_RUNTIME_BUNDLES[taskType]);
  if (projected.kind !== "PROJECTED") throw new Error(projected.reason);
  return projected.payload;
}
const BINDING = (sourceBackedRequest().taskPayload as { periodSummary: unknown }).periodSummary;

function request(body: unknown, init: { headers?: Record<string, string>; method?: string; raw?: string } = {}) {
  const method = init.method ?? "POST";
  return new Request("http://localhost/api/ai/task", {
    method,
    headers: { "content-type": "application/json", ...init.headers },
    body: method === "GET" || method === "HEAD" ? undefined : (init.raw ?? JSON.stringify(body)),
  });
}

/** Records every read of a provider credential name from process.env while a request is handled. */
function recordCredentialReads() {
  const reads: string[] = [];
  const original = process.env;
  process.env = new Proxy(original, { get: (target, key) => (typeof key === "string" && /API_KEY|TOKEN|SECRET/.test(key) && reads.push(key), Reflect.get(target, key)) });
  return { reads, restore: () => void (process.env = original) };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("retired legacy route module", () => {
  it("exports only a force-dynamic POST handler and reads no environment or credential", () => {
    expect(route.dynamic).toBe("force-dynamic");
    expect(Object.keys(route).sort()).toEqual(["POST", "dynamic"]);
    const source = readFileSync(join(process.cwd(), "src/app/api/ai/task/route.ts"), "utf8");
    expect(source).not.toMatch(/process\.env|import\.meta\.env|NEXT_PUBLIC_|KIE_API_KEY|DEEPSEEK_API_KEY/);
  });

  it("the handler constructs no provider and imports no provider adapter, credential reader, projector or network code", () => {
    const handler = readFileSync(join(process.cwd(), "src/app/api/ai/task/ai-task-handler.ts"), "utf8");
    expect(handler).not.toMatch(/from\s+["']@\/ai\//);
    expect(handler).not.toMatch(/create\w*Provider\(|readKieToken|readDeepSeekToken|resolveProductKieRoute|projectProviderTaskPayload|\bfetch\b|request\.(?:body|json|text)|environment/);
  });
});

describe("every request is refused with the closed TASK_DISABLED reason before any body, credential or network access", () => {
  const cases: Array<[string, () => Request]> = [
    ["a valid legacy EXPLAIN payload", () => request(detached())],
    ["a valid legacy care payload", () => request(detached("DRAFT_CARE_PREPARATION_SUMMARY"))],
    ["an approved value-blind shell request (the route is not its successor)", () => request(projectShellTaskRequest(plannedFixture("p11.explain-pattern.en-sg.ordinary").plan))],
    // Packet 11C Task 6A cases, kept: a source-backed request can no longer reach any send path through this route.
    ["a legacy EXPLAIN payload carrying taskPayload.periodSummary", () => request({ ...detached(), taskPayload: { ...(detached().taskPayload as object), periodSummary: BINDING } })],
    ["the whole internal source-backed request", () => request(sourceBackedRequest())],
    ["a legacy payload whose facts carry sources", () => request({ ...detached(), facts: detached().facts.map((fact) => ({ ...fact, sources: [] })) })],
    ["malformed JSON", () => request(undefined, { raw: "{not json" })],
    ["an empty body", () => request(undefined, { raw: "" })],
    ["a text/plain body", () => request(detached(), { headers: { "content-type": "text/plain" } })],
    ["an oversize body", () => request(undefined, { raw: JSON.stringify({ ...detached(), padding: "x".repeat(100_000) }) })],
    ["a GET", () => request(undefined, { method: "GET" })],
  ];

  it.each(cases)("refuses %s (retired handler and the route's POST export)", async (_label, make) => {
    const fetchSpy = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchSpy);
    const probe = recordCredentialReads();
    try {
      for (const response of [await createAiTaskHandler()(make()), await route.POST(make())]) {
        expect(response.status).toBe(410);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("content-type")).toMatch(/^application\/json/);
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
        expect(await response.json()).toEqual(RETIRED);
      }
    } finally {
      probe.restore();
    }
    expect(probe.reads).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("leaves the request body unread", async () => {
    const pending = request(detached());
    await createAiTaskHandler()(pending);
    expect(pending.bodyUsed).toBe(false);
  });
});
