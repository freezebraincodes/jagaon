// @vitest-environment node
import Dexie from "dexie";
import fakeIndexedDB, { IDBKeyRange as FDBKeyRange } from "fake-indexeddb";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DEEPSEEK_DOCUMENTED_MODELS, DEEPSEEK_FLASH_PEAK_USD_PER_MILLION, deepSeekCostMicroUsd } from "@/ai/deepseek/deepseek-catalogue";
import { createDeepSeekShellResponsesProvider } from "@/ai/deepseek/deepseek-responses-provider";
import { estimateMaxUsd } from "@/ai/evaluation/packet-11-hybrid-live-diagnostic";
import { hybridFixturesForPhase } from "@/ai/evaluation/packet-11-hybrid-fixtures";
import { SOURCE_BACKED_SCENARIOS, sourceBackedFixture } from "@/ai/evaluation/packet-11-source-backed-fixtures";
import { selectEvaluationCandidates } from "@/ai/kie/kie-route-config";
import { AI_HYBRID_RUNTIME_BUNDLES } from "@/application/ai/ai-hybrid-runtime-bundles";
import {
  AI_SHELL_INPUT_FRAMING_MARGIN_TOKENS,
  AI_SHELL_MAX_BODY_BYTES,
  AI_SHELL_PROVIDER_BODY_OVERHEAD_MAX_BYTES,
  AI_SHELL_ROUTE_PEAK_USD_PER_MILLION,
  shellCallUpperBound,
  shellRouteCallUpperBound,
} from "@/application/ai/ai-shell-route-contract";
import { projectShellTaskRequest } from "@/application/ai/language/shell-projector";
import { planSlots } from "@/application/ai/language/slot-planner";
import { buildCareSummaryAiRequest } from "@/application/care-preparation/ai-care-summary-request";
import { NOW, syntheticCareDraft } from "@/application/care-preparation/care-preparation-test-support";
import { renderDeterministicCareSummary } from "@/application/care-preparation/deterministic-care-summary-renderer";
import { AI_LOCALES, SHELL_TASKS, type AiTaskRequest, type ShellTask, type ShellTaskRequest } from "@/domain/ai";

/**
 * Packet 11C Addendum C, Task C5: the pre-send upper bound of one shell call, shared by the shared Responses adapter, the shell route,
 * the browser shell client, the hybrid service and the evaluation harness (and the C6 spend ledger). Offline: the real DeepSeek shell
 * adapter builds each body with a recording fetcher that throws; nothing is sent.
 */

const utf8 = (text: string) => new TextEncoder().encode(text).byteLength;
const SENTINEL = "ds-SENTINEL-CREDENTIAL-upper-bound";
function deepSeekFlash() {
  const selection = selectEvaluationCandidates({ requested: "deepseek-flash", listing: [], documented: DEEPSEEK_DOCUMENTED_MODELS, now: () => "2026-10-08T00:00:00.000Z" });
  if (selection.kind !== "SELECTED" || selection.candidates.length !== 1) throw new Error("DEEPSEEK_FLASH_NOT_SELECTABLE");
  return selection.candidates[0]!;
}
/** The exact model-facing body the adapter builds for one approved shell request (captured, never sent). */
async function bodyOf(request: ShellTaskRequest): Promise<string> {
  let body: string | null = null;
  const provider = createDeepSeekShellResponsesProvider({ token: SENTINEL, model: deepSeekFlash(), fetcher: async (_url, init) => {
    body = String(init.body);
    throw new Error("OFFLINE_CAPTURE_ONLY");
  } });
  await provider.invoke(request, new AbortController().signal);
  if (body === null) throw new Error("NO_BODY");
  return body;
}
function shellRequestOf(request: AiTaskRequest): ShellTaskRequest | null {
  const planned = planSlots(request, AI_HYBRID_RUNTIME_BUNDLES[request.taskType as ShellTask]);
  return planned.kind === "PLANNED" && planned.plan.remote.eligible === true ? projectShellTaskRequest(planned.plan) : null;
}
/** Every evaluated class request: the 70 FULL fixtures (remote-eligible ones), the source-backed EXPLAIN classes and the care classes. */
async function evaluatedRequests(): Promise<ShellTaskRequest[]> {
  const requests: ShellTaskRequest[] = [];
  for (const fixture of hybridFixturesForPhase("FULL")) {
    const shell = shellRequestOf(fixture.request);
    if (shell) requests.push(shell);
  }
  for (const locale of AI_LOCALES) {
    for (const scenario of SOURCE_BACKED_SCENARIOS) requests.push(shellRequestOf((await sourceBackedFixture(locale, scenario)).request)!);
    for (const shape of ["ORDINARY", "HIDDEN_LIMITATION"] as const) {
      const built = buildCareSummaryAiRequest({ current: (await renderDeterministicCareSummary(syntheticCareDraft(shape, locale))).payload, requestId: "33333333-3333-4333-8333-333333333333", requestedAt: NOW });
      if (built.kind !== "READY") throw new Error(built.reason);
      requests.push(shellRequestOf(built.request)!);
    }
  }
  return requests;
}

beforeAll(() => {
  Dexie.dependencies.indexedDB = fakeIndexedDB;
  Dexie.dependencies.IDBKeyRange = FDBKeyRange;
  vi.stubGlobal("fetch", () => {
    throw new Error("NETWORK_FORBIDDEN_IN_UPPER_BOUND_TEST");
  });
});
afterAll(() => vi.unstubAllGlobals());

describe("shell call upper bound (Packet 11C Addendum C, C5)", () => {
  it("uses the DeepSeek catalogue's peak prices and the evaluation tracer's framing margin", () => {
    expect(AI_SHELL_ROUTE_PEAK_USD_PER_MILLION).toEqual(DEEPSEEK_FLASH_PEAK_USD_PER_MILLION);
    expect(AI_SHELL_INPUT_FRAMING_MARGIN_TOKENS).toBe(256);
  });

  it("is exactly the evaluation tracer's estimate (estimateMaxUsd now delegates to it) and the catalogue's cost of the bounded tokens", () => {
    for (const task of SHELL_TASKS) {
      for (const bytes of [0, 1, 999, 4_096, 7_777, 16_384, 40_000, 65_536]) {
        const bound = shellCallUpperBound(bytes, task);
        // The pre-C5 estimateMaxUsd formula, written out: every body byte one input token plus 256, the task's cap, peak prices.
        const inputTokensUpperBound = bytes + 256;
        const outputTokensMax = task === "EXPLAIN_PATTERN" ? 512 : 1024;
        const legacyMicro = Math.ceil(inputTokensUpperBound * 0.3 + outputTokensMax * 1.2);
        expect(bound).toEqual({ inputTokens: inputTokensUpperBound, outputTokens: outputTokensMax, costMicroUsd: legacyMicro, basis: "UPPER_BOUND" });
        expect(estimateMaxUsd(bytes, task)).toEqual({ inputTokensUpperBound, outputTokensMax, estimatedMaxUsd: legacyMicro / 1_000_000 });
        expect(bound.costMicroUsd).toBe(deepSeekCostMicroUsd(bound.inputTokens, bound.outputTokens));
      }
    }
    expect(() => shellCallUpperBound(-1, "EXPLAIN_PATTERN")).toThrow("INVALID_BODY_BYTE_COUNT");
    expect(() => shellCallUpperBound(1.5, "EXPLAIN_PATTERN")).toThrow("INVALID_BODY_BYTE_COUNT");
  });

  it("the body overhead constant covers every evaluated class body, so the route bound is never below the exact-body bound", async () => {
    const requests = await evaluatedRequests();
    expect(requests.length).toBeGreaterThanOrEqual(40);
    let maxOverhead = 0;
    for (const request of requests) {
      const body = await bodyOf(request);
      const requestJson = JSON.stringify(request);
      // The request JSON is carried as one JSON string inside the body: its escaped form without the enclosing quotes.
      const embedded = utf8(JSON.stringify(requestJson)) - 2;
      expect(body.includes(JSON.stringify(requestJson).slice(1, -1))).toBe(true);
      expect(embedded).toBeLessThanOrEqual(2 * utf8(requestJson));
      const overhead = utf8(body) - embedded;
      maxOverhead = Math.max(maxOverhead, overhead);
      expect(overhead, `${request.taskType} ${request.locale}`).toBeLessThanOrEqual(AI_SHELL_PROVIDER_BODY_OVERHEAD_MAX_BYTES);
      const route = shellRouteCallUpperBound(request);
      const exact = shellCallUpperBound(utf8(body), request.taskType);
      expect(route.inputTokens).toBeGreaterThanOrEqual(exact.inputTokens);
      expect(route.costMicroUsd).toBeGreaterThanOrEqual(exact.costMicroUsd);
      expect(route.outputTokens).toBe(exact.outputTokens);
    }
    // The measured maximum under the frozen prompt 11b.18 and schema kie-schema.11c.1 (pinned exactly, so any change to the fixed part
    // of a body shows here); the constant is that maximum rounded up to 8 KiB.
    expect(maxOverhead).toBe(5_626);
    expect(AI_SHELL_PROVIDER_BODY_OVERHEAD_MAX_BYTES).toBe(8_192);
  }, 60_000);

  it("even the largest route request stays inside the audit and route usage bounds", () => {
    const worstInput = AI_SHELL_PROVIDER_BODY_OVERHEAD_MAX_BYTES + 2 * AI_SHELL_MAX_BODY_BYTES + AI_SHELL_INPUT_FRAMING_MARGIN_TOKENS;
    for (const task of SHELL_TASKS) {
      const bound = shellCallUpperBound(worstInput - AI_SHELL_INPUT_FRAMING_MARGIN_TOKENS, task);
      expect(bound.inputTokens).toBeLessThanOrEqual(100_000);
      expect(bound.costMicroUsd).toBeLessThanOrEqual(10_000_000);
    }
  });
});
