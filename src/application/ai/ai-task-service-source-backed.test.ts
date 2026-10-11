import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Dexie from "dexie";
import fakeIndexedDB, { IDBKeyRange as FDBKeyRange } from "fake-indexeddb";
import type { Instant } from "@/domain/shared/time";
import { AI_TASK_TYPES, aiInvocationAuditRowSchema, type AiInvocationAuditRow, type AiTaskRequest, type ShellTaskRequest } from "@/domain/ai";
import { FIXTURE_NOW, sourceBackedRequest } from "@/domain/ai/ai-test-fixtures";
import type { ExplainablePatternView } from "@/application/history/recorded-history-contracts";
import { databases, FACT, higherFixture, NOW } from "@/application/history/history-test-support";
import { AI_ACTIVATION_MANIFEST, type AiActivationManifest } from "./ai-activation-manifest";
import { createAiHybridTaskService } from "./ai-hybrid-task-service";
import type { AiProviderPort, AiShellProviderPort, ProviderInvocationResult } from "./ai-provider-port";
import { AI_TASK_RUNTIME_BUNDLES } from "./ai-runtime-bundles";
import { createAiTaskService } from "./ai-task-service";
import { projectProviderTaskPayload } from "./detached-payload-projector";
import { buildSourceBackedExplainRequest } from "./explain-pattern-request";
import { qualifiedTestRequestClassGate } from "./request-class-test-support";

/**
 * Packet 11C Task 6A (owner instruction 2026-10-08): a source-backed EXPLAIN request (one carrying the local
 * `taskPayload.periodSummary` binding) never enters the legacy fact-sending service. That service projects the
 * internal request with the detached projector, which drops the binding but keeps every fact value and interval
 * date, so the request would leave the device as an ordinary-looking EXPLAIN payload carrying values. The legacy
 * service therefore refuses it (PAYLOAD_INVALID) before projection, provider invocation or any send. Source-backed
 * requests go only through the hybrid service (value-blind shells), which still needs the projector to project
 * them locally (the slot planner reads the projected facts) and is unaffected.
 */

// A pass-through spy pins whether the legacy projector is ever reached; the real implementation runs unchanged.
vi.mock("./detached-payload-projector", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./detached-payload-projector")>();
  return { ...actual, projectProviderTaskPayload: vi.fn(actual.projectProviderTaskPayload) };
});
const projectorSpy = vi.mocked(projectProviderTaskPayload);

const originalIndexedDB = Dexie.dependencies.indexedDB;
const originalIDBKeyRange = Dexie.dependencies.IDBKeyRange;
beforeAll(() => {
  Dexie.dependencies.indexedDB = fakeIndexedDB;
  Dexie.dependencies.IDBKeyRange = FDBKeyRange;
});
afterAll(() => {
  Dexie.dependencies.indexedDB = originalIndexedDB;
  Dexie.dependencies.IDBKeyRange = originalIDBKeyRange;
});
afterEach(async () => {
  vi.unstubAllGlobals();
  projectorSpy.mockClear();
  for (const database of databases) database.close();
  for (const database of databases.splice(0)) await Dexie.delete(database.name);
});

const REQUEST_ID = "6f1c2b9e-3d4a-4b5c-8d6e-7f8091a2b3c4";
const LEGACY_EXPLAIN_BUNDLE_KEY = AI_TASK_RUNTIME_BUNDLES.EXPLAIN_PATTERN.bundleKey;
const REMOTE: AiActivationManifest = { ...AI_ACTIVATION_MANIFEST, tasks: Object.fromEntries(AI_TASK_TYPES.map((taskType) => [taskType, "SYNTHETIC_REMOTE_ENABLED"])) as AiActivationManifest["tasks"] };

/** A real source-backed request: real readings → JournalCommandService → coordinator → evaluator → view → builder. */
async function realSourceBackedRequest(): Promise<AiTaskRequest> {
  const { history } = await higherFixture();
  const result = (await history.loadExplainablePattern({ factId: FACT })) as { kind: string; view?: ExplainablePatternView };
  if (result.kind !== "EXPLAINABLE" || !result.view) throw new Error(`not explainable: ${JSON.stringify(result)}`);
  return buildSourceBackedExplainRequest({ view: result.view, locale: "en-SG", requestId: REQUEST_ID, requestedAt: NOW as Instant });
}

/** The same request addressed to the legacy EXPLAIN bundle: the case a bundle-key check alone would let through. */
const legacyKeyed = (request: AiTaskRequest): AiTaskRequest => ({ ...structuredClone(request), runtimeBundleKey: LEGACY_EXPLAIN_BUNDLE_KEY });

/** Every fact value and interval date the request carries, as JSON string literals (never a timestamp prefix). */
function factValueLiterals(request: AiTaskRequest): string[] {
  const literals: string[] = [];
  for (const fact of request.facts) {
    if (fact.value.kind === "DECIMAL") literals.push(JSON.stringify(fact.value.value));
    if (fact.value.kind === "DATE_RANGE") literals.push(JSON.stringify(fact.value.startDate), JSON.stringify(fact.value.endDate));
  }
  return literals;
}

function legacyHarness(manifest: AiActivationManifest = REMOTE) {
  const rows: AiInvocationAuditRow[] = [];
  const invoke = vi.fn(async (_input: unknown, _signal: AbortSignal): Promise<ProviderInvocationResult> => ({ kind: "FAILED", reason: "TRANSPORT_FAILED" }));
  const provider: AiProviderPort = { providerModel: { providerKey: "fake", modelSnapshot: "fake-model-1" }, invoke };
  let tick = 0;
  const service = createAiTaskService({ releaseProfile: "HACKATHON_DEMO", manifest, provider, audit: { append: async (row) => void rows.push(row) }, now: () => FIXTURE_NOW, monotonicMs: () => (tick += 5) });
  return { service, rows, invoke };
}

function expectRefusedBeforeAnySend(result: unknown, rows: AiInvocationAuditRow[], invoke: ReturnType<typeof vi.fn>, fetchSpy: ReturnType<typeof vi.fn>, request: AiTaskRequest) {
  expect(result).toMatchObject({ kind: "FALLBACK", auditRef: request.requestId, fallback: { kind: "DETERMINISTIC_FALLBACK", taskType: "EXPLAIN_PATTERN", reason: "PAYLOAD_INVALID" } });
  expect(projectorSpy).not.toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalled();
  expect(fetchSpy).not.toHaveBeenCalled();
  // One closed audit row that records no send and carries no fact value, date, binding or source.
  expect(rows).toHaveLength(1);
  expect(aiInvocationAuditRowSchema.parse(rows[0])).toMatchObject({ outcomeCode: "PAYLOAD_INVALID", providerModel: null, attempts: { count: 0, structuralRepairUsed: false, timedOut: false }, sourceRevisions: [], measurements: { inputTokens: null, outputTokens: null, costMicroUsd: null } });
  const audit = JSON.stringify(rows);
  for (const literal of factValueLiterals(request)) expect(audit).not.toContain(literal);
  expect(audit).not.toContain("periodSummary");
}

describe("legacy fact-sending service refuses a source-backed request (Packet 11C Task 6A)", () => {
  it("refuses a real source-backed request before projection, provider invocation or any fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const request = await realSourceBackedRequest();
    expect(request.taskType === "EXPLAIN_PATTERN" && request.taskPayload.periodSummary).toBeTruthy();
    const { service, rows, invoke } = legacyHarness();
    expectRefusedBeforeAnySend(await service.execute(request), rows, invoke, fetchSpy, request);
  });

  it("refuses it even when it is addressed to the legacy EXPLAIN bundle", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const request = legacyKeyed(await realSourceBackedRequest());
    const { service, rows, invoke } = legacyHarness();
    expectRefusedBeforeAnySend(await service.execute(request), rows, invoke, fetchSpy, request);
  });

  it("refuses the hand-built source-backed request on both bundle keys", async () => {
    for (const request of [sourceBackedRequest(), legacyKeyed(sourceBackedRequest())]) {
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const { service, rows, invoke } = legacyHarness();
      expectRefusedBeforeAnySend(await service.execute(request), rows, invoke, fetchSpy, request);
      projectorSpy.mockClear();
    }
  });

  it("refuses it under the shipped deterministic-only manifest too (the refusal does not depend on activation)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const request = legacyKeyed(await realSourceBackedRequest());
    const { service, rows, invoke } = legacyHarness(AI_ACTIVATION_MANIFEST);
    expectRefusedBeforeAnySend(await service.execute(request), rows, invoke, fetchSpy, request);
  });

  it("control: the same facts without the binding still project and are sent exactly as before", async () => {
    // This is the leak the refusal closes: without it, a source-backed request is indistinguishable from this one.
    const bound = legacyKeyed(await realSourceBackedRequest());
    if (bound.taskType !== "EXPLAIN_PATTERN") throw new Error("expected EXPLAIN_PATTERN");
    const { periodSummary: _binding, ...unbound } = bound.taskPayload;
    void _binding;
    const request = { ...bound, taskPayload: unbound } as AiTaskRequest;
    const { service, rows, invoke } = legacyHarness();
    expect(await service.execute(request)).toMatchObject({ kind: "FALLBACK", fallback: { reason: "TRANSPORT_FAILED" } });
    expect(projectorSpy).toHaveBeenCalled();
    expect(invoke).toHaveBeenCalled();
    const sent = JSON.stringify(invoke.mock.calls[0]![0]);
    for (const literal of factValueLiterals(request)) expect(sent).toContain(literal);
    expect(rows[0]).toMatchObject({ outcomeCode: "TRANSPORT_FAILED", attempts: { count: 1 } });
  });
});

describe("hybrid service still handles a source-backed request (Packet 11C Task 6A, no regression)", () => {
  function hybridHarness(manifest: AiActivationManifest) {
    const rows: AiInvocationAuditRow[] = [];
    const calls: ShellTaskRequest[] = [];
    const provider: AiShellProviderPort = { providerModel: { providerKey: "test", modelSnapshot: "test-model" }, invoke: async (input) => { calls.push(input); return { kind: "FAILED", reason: "TRANSPORT_FAILED" }; } };
    // Packet 11C Addendum C (C1): test-only QUALIFIED records (the shipped records are all PENDING).
    const service = createAiHybridTaskService({ releaseProfile: "HACKATHON_DEMO", audit: { append: async (row) => void rows.push(row) }, now: () => FIXTURE_NOW, monotonicMs: () => 0, manifest, provider, requestClassGate: qualifiedTestRequestClassGate() });
    return { service, rows, calls };
  }

  it("composes deterministically while NOT_ACTIVATED, projecting the request locally only", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const request = await realSourceBackedRequest();
    const { service, rows, calls } = hybridHarness(AI_ACTIVATION_MANIFEST);
    const result = await service.execute(request);
    expect(result).toMatchObject({ kind: "COMPOSED", source: "DETERMINISTIC", mode: "NOT_ACTIVATED", reason: "TASK_DISABLED", limitationCopyComplete: true });
    // The slot planner projects the source-backed request locally; the projector must keep doing so.
    expect(projectorSpy).toHaveBeenCalled();
    expect(projectorSpy.mock.results.some((entry) => entry.type === "return" && (entry.value as { kind: string }).kind === "PROJECTED")).toBe(true);
    expect(calls).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcomeCode: "TASK_DISABLED", runtimeBundleKey: "ai.explain-pattern@11b.20", attempts: { count: 0 } });
  });

  it("when remote is enabled in a test manifest, only the value-blind shell request reaches the provider", async () => {
    const request = await realSourceBackedRequest();
    const { service, calls } = hybridHarness(REMOTE);
    const result = await service.execute(request);
    expect(result).toMatchObject({ kind: "COMPOSED", source: "DETERMINISTIC", mode: "REMOTE_AI", reason: "TRANSPORT_FAILED" });
    expect(calls.length).toBeGreaterThan(0);
    const sent = JSON.stringify(calls);
    for (const literal of factValueLiterals(request)) expect(sent).not.toContain(literal);
    expect(sent).not.toContain("periodSummary");
  });
});
