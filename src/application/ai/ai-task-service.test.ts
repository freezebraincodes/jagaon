import { afterEach, describe, expect, it, vi } from "vitest";
import { AI_TASK_TYPES, aiInvocationAuditRowSchema, type AiInvocationAuditRow, type AiTaskType } from "@/domain/ai";
import { FIXTURE_NOW, FIXTURE_REQUEST_ID, abstainFixture, outputFixture, requestFixture } from "@/domain/ai/ai-test-fixtures";
import { AI_ACTIVATION_MANIFEST, AI_DETERMINISTIC_ONLY_MANIFEST, type AiActivationManifest, type AiTaskActivationState } from "./ai-activation-manifest";
import type { AiProviderPort, ProviderInvocationResult } from "./ai-provider-port";
import { createAiTaskService } from "./ai-task-service";

/**
 * Packet 11A Task 4: provider-neutral orchestration. Without an injected manifest
 * the service is deterministic-only, so the provider is never called. Remote paths
 * are exercised only through an injected test manifest and a fake provider; no
 * network, credential or real provider exists in 11A.
 * Packet 11C English activation (owner decisions Q and A, 2026-10-12; I-8 review
 * follow-up): the shipped manifest now enables EXPLAIN_PATTERN and
 * DRAFT_CARE_PREPARATION_SUMMARY for the value-blind hybrid shell path; this legacy
 * service (it sends record values) defaults to `AI_DETERMINISTIC_ONLY_MANIFEST`
 * instead, pinned below.
 */

const MODEL = { providerKey: "fake", modelSnapshot: "fake-model-1" } as const;
const USAGE = { inputTokens: 400, outputTokens: 80, costMicroUsd: null };

function manifestWith(state: AiTaskActivationState): AiActivationManifest {
  return { ...AI_ACTIVATION_MANIFEST, tasks: Object.fromEntries(AI_TASK_TYPES.map((taskType) => [taskType, state])) as AiActivationManifest["tasks"] };
}

function harness(options: { manifest?: AiActivationManifest; profile?: unknown; provider?: AiProviderPort | null } = {}) {
  const rows: AiInvocationAuditRow[] = [];
  let tick = 0;
  const service = createAiTaskService({
    releaseProfile: "profile" in options ? options.profile : "HACKATHON_DEMO",
    manifest: options.manifest,
    provider: options.provider ?? undefined,
    audit: { append: async (row) => void rows.push(row) },
    now: () => FIXTURE_NOW,
    monotonicMs: () => (tick += 5),
  });
  return { service, rows };
}

function fakeProvider(...results: Array<ProviderInvocationResult | ((signal: AbortSignal) => Promise<ProviderInvocationResult>)>) {
  const invoke = vi.fn(async (_input: unknown, signal: AbortSignal) => {
    const next = results.shift();
    if (!next) throw new Error("UNEXPECTED_PROVIDER_CALL");
    return typeof next === "function" ? next(signal) : next;
  });
  return { provider: { providerModel: MODEL, invoke } satisfies AiProviderPort, invoke };
}

const completed = (candidate: unknown): ProviderInvocationResult => ({ kind: "COMPLETED", candidate, usage: USAGE });
const request = (taskType: AiTaskType = "EXPLAIN_PATTERN") => requestFixture(taskType);

afterEach(() => vi.useRealTimers());

describe("deterministic-only 11A manifest", () => {
  it.each(AI_TASK_TYPES)("%s returns its deterministic fallback without calling the provider", async (taskType) => {
    const { provider, invoke } = fakeProvider();
    const { service, rows } = harness({ provider });
    const result = await service.execute(request(taskType));
    expect(result).toMatchObject({ kind: "FALLBACK", auditRef: FIXTURE_REQUEST_ID, fallback: { kind: "DETERMINISTIC_FALLBACK", taskType, reason: "TASK_DISABLED" } });
    expect(invoke).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1);
    expect(aiInvocationAuditRowSchema.parse(rows[0])).toMatchObject({ requestId: FIXTURE_REQUEST_ID, taskType, outcomeCode: "TASK_DISABLED", routeProfileKey: "deterministic-only.11a.1", providerModel: null, attempts: { count: 0 }, sourceRevisions: [], downstream: null });
  });

  it("Packet 11C English activation (I-8 follow-up): with NO manifest injected and a provider supplied, it never calls the provider for any task, although the shipped manifest enables two tasks", async () => {
    expect(Object.values(AI_ACTIVATION_MANIFEST.tasks)).toContain("SYNTHETIC_REMOTE_ENABLED");
    expect(AI_DETERMINISTIC_ONLY_MANIFEST).toEqual({ manifestVersion: "ai-activation.11a.1", profile: "HACKATHON_DEMO", tasks: Object.fromEntries(AI_TASK_TYPES.map((taskType) => [taskType, "DETERMINISTIC_ONLY"])) });
    expect(Object.isFrozen(AI_DETERMINISTIC_ONLY_MANIFEST) && Object.isFrozen(AI_DETERMINISTIC_ONLY_MANIFEST.tasks)).toBe(true);
    const { provider, invoke } = fakeProvider(...AI_TASK_TYPES.map(() => completed(outputFixture("EXPLAIN_PATTERN"))));
    const { service, rows } = harness({ provider });
    for (const taskType of AI_TASK_TYPES) {
      expect(await service.execute(request(taskType)), taskType).toMatchObject({ kind: "FALLBACK", fallback: { kind: "DETERMINISTIC_FALLBACK", taskType, reason: "TASK_DISABLED" } });
    }
    expect(invoke).not.toHaveBeenCalled();
    expect(rows.map((row) => [row.taskType, row.outcomeCode, row.attempts.count])).toEqual(AI_TASK_TYPES.map((taskType) => [taskType, "TASK_DISABLED", 0]));
    // Injection still works: the shipped manifest, injected explicitly, enables exactly its two tasks here (the evaluation seam).
    const injected = fakeProvider(completed(outputFixture("EXPLAIN_PATTERN")));
    await harness({ provider: injected.provider, manifest: AI_ACTIVATION_MANIFEST }).service.execute(request("EXPLAIN_PATTERN"));
    expect(injected.invoke).toHaveBeenCalledTimes(1);
  });

  it("a registered-disabled task falls back as TASK_DISABLED", async () => {
    const { service } = harness({ manifest: manifestWith("REGISTERED_DISABLED") });
    expect(await service.execute(request())).toMatchObject({ kind: "FALLBACK", fallback: { reason: "TASK_DISABLED" } });
  });
});

describe("pre-transmission gates", () => {
  it("rejects a malformed request without audit, fallback or provider call", async () => {
    const { provider, invoke } = fakeProvider();
    const { service, rows } = harness({ manifest: manifestWith("SYNTHETIC_REMOTE_ENABLED"), provider });
    expect(await service.execute({ ...request(), requestId: "not-a-uuid" } as never)).toEqual({ kind: "REQUEST_REJECTED" });
    expect(rows).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("an unknown runtime bundle falls back as PAYLOAD_INVALID", async () => {
    const { provider, invoke } = fakeProvider();
    const { service, rows } = harness({ manifest: manifestWith("SYNTHETIC_REMOTE_ENABLED"), provider });
    const result = await service.execute({ ...request(), runtimeBundleKey: "ai.explain-pattern@11a.9" });
    expect(result).toMatchObject({ kind: "FALLBACK", fallback: { reason: "PAYLOAD_INVALID" } });
    expect(invoke).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({ outcomeCode: "PAYLOAD_INVALID", runtimeBundleKey: "ai.explain-pattern@11b.3" });
  });

  it.each([["SANDBOX"], [undefined], ["hackathon_demo"]])("profile %s is not permitted", async (profile) => {
    const { provider, invoke } = fakeProvider();
    const { service } = harness({ manifest: manifestWith("SYNTHETIC_REMOTE_ENABLED"), profile, provider });
    expect(await service.execute(request())).toMatchObject({ kind: "FALLBACK", fallback: { reason: "PROFILE_NOT_PERMITTED" } });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("a projection rejection falls back before transmission", async () => {
    const { provider, invoke } = fakeProvider();
    const { service, rows } = harness({ manifest: manifestWith("SYNTHETIC_REMOTE_ENABLED"), provider });
    const withMedication = request();
    (withMedication.facts[0] as { field: string }).field = "MEDICATION_NAME";
    expect(await service.execute(withMedication)).toMatchObject({ kind: "FALLBACK", fallback: { reason: "PRIVACY_REJECTED" } });
    expect(invoke).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({ attempts: { count: 0 }, sourceRevisions: [] });
  });

  it("a missing provider falls back as MISSING_CONFIGURATION", async () => {
    const { service } = harness({ manifest: manifestWith("SYNTHETIC_REMOTE_ENABLED"), provider: null });
    expect(await service.execute(request())).toMatchObject({ kind: "FALLBACK", fallback: { reason: "MISSING_CONFIGURATION" } });
  });

  it("an already-cancelled request is never transmitted", async () => {
    const { provider, invoke } = fakeProvider();
    const { service } = harness({ manifest: manifestWith("SYNTHETIC_REMOTE_ENABLED"), provider });
    const controller = new AbortController();
    controller.abort();
    expect(await service.execute(request(), controller.signal)).toMatchObject({ kind: "FALLBACK", fallback: { reason: "REQUEST_CANCELLED" } });
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("injected remote path (test manifest only)", () => {
  const remote = () => manifestWith("SYNTHETIC_REMOTE_ENABLED");

  it("sends only the detached provider payload", async () => {
    const { provider, invoke } = fakeProvider(completed(outputFixture("EXPLAIN_PATTERN")));
    const { service } = harness({ manifest: remote(), provider });
    await service.execute(request());
    const sent = JSON.stringify(invoke.mock.calls[0]![0]);
    expect(sent).not.toContain(FIXTURE_REQUEST_ID);
    expect(sent).not.toContain("sources");
    expect(sent).not.toContain("HACKATHON_DEMO");
    expect(sent).not.toContain(FIXTURE_NOW);
  });

  it("accepts a valid output and audits it with bounded measurements and local sources", async () => {
    const { provider } = fakeProvider(completed(JSON.stringify(outputFixture("EXPLAIN_PATTERN"))));
    const { service, rows } = harness({ manifest: remote(), provider });
    const result = await service.execute(request());
    // Option B: the application adds the registry-rendered limitation copy to an accepted EXPLAIN_PATTERN result.
    expect(result).toEqual({
      kind: "ACCEPTED",
      output: outputFixture("EXPLAIN_PATTERN"),
      auditRef: FIXTURE_REQUEST_ID,
      limitations: [{ limitationRef: "limitation-1", code: "DOES_NOT_ESTABLISH_CAUSE", text: "This describes your records; it does not explain the cause." }],
      limitationCopyComplete: true,
    });
    const row = aiInvocationAuditRowSchema.parse(rows[0]);
    expect(row).toMatchObject({ outcomeCode: "ACCEPTED", providerModel: MODEL, attempts: { count: 1, structuralRepairUsed: false, timedOut: false }, measurements: { inputTokens: 400, outputTokens: 80, costMicroUsd: null }, downstream: null });
    expect(row.sourceRevisions).toEqual([request().facts[0]!.sources[0]]);
    // The audit holds no prompt, payload, response, rendered text or copied value.
    const stored = JSON.stringify(row);
    for (const forbidden of ["6.2", "7.1", "mmol", "Recent recorded", "claim-1", "fact-1", "DOES_NOT_ESTABLISH_CAUSE"]) expect(stored).not.toContain(forbidden);
  });

  it.each(["TRANSPORT_FAILED", "PROVIDER_REJECTED", "PROVIDER_RATE_LIMITED", "PROVIDER_FAILED", "OPERATIONAL_SPEND_LOCKED"] as const)("provider error %s falls back without retry", async (reason) => {
    const { provider, invoke } = fakeProvider({ kind: "FAILED", reason });
    const { service, rows } = harness({ manifest: remote(), provider });
    expect(await service.execute(request())).toMatchObject({ kind: "FALLBACK", fallback: { reason } });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(aiInvocationAuditRowSchema.parse(rows[0])).toMatchObject({ outcomeCode: reason, attempts: { count: 1 } });
  });

  it("a provider that throws is a transport failure", async () => {
    const { provider } = fakeProvider(async () => {
      throw new Error("socket closed");
    });
    const { service } = harness({ manifest: remote(), provider });
    expect(await service.execute(request())).toMatchObject({ kind: "FALLBACK", fallback: { reason: "TRANSPORT_FAILED" } });
  });

  it("a provider that throws synchronously is a transport failure and leaves no timer armed", async () => {
    vi.useFakeTimers();
    const provider: AiProviderPort = {
      providerModel: MODEL,
      invoke: () => {
        throw new Error("not configured");
      },
    };
    const { service, rows } = harness({ manifest: remote(), provider });
    expect(await service.execute(request())).toMatchObject({ kind: "FALLBACK", fallback: { reason: "TRANSPORT_FAILED" } });
    expect(rows[0]).toMatchObject({ outcomeCode: "TRANSPORT_FAILED", attempts: { count: 1 } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out at the per-call ceiling, aborts the call and does not retry", async () => {
    vi.useFakeTimers();
    let aborted = false;
    const { provider, invoke } = fakeProvider((signal) => new Promise(() => signal.addEventListener("abort", () => (aborted = true))));
    const { service, rows } = harness({ manifest: remote(), provider });
    const pending = service.execute(request());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toMatchObject({ kind: "FALLBACK", fallback: { reason: "PROVIDER_TIMEOUT" } });
    expect(aborted).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(rows[0]).toMatchObject({ outcomeCode: "PROVIDER_TIMEOUT", attempts: { count: 1, timedOut: true } });
  });

  it("a repair attempt is bounded by the remaining overall ceiling", async () => {
    vi.useFakeTimers();
    const { provider, invoke } = fakeProvider(
      () => new Promise((resolve) => setTimeout(() => resolve(completed("{not json")), 9_000)),
      () => new Promise(() => undefined),
    );
    const { service } = harness({ manifest: remote(), provider });
    const pending = service.execute(request());
    await vi.advanceTimersByTimeAsync(9_000);
    expect(invoke).toHaveBeenCalledTimes(2);
    // The second call gets 18s - 9s = 9s, not a fresh 10s.
    await vi.advanceTimersByTimeAsync(9_000);
    expect(await pending).toMatchObject({ kind: "FALLBACK", fallback: { reason: "PROVIDER_TIMEOUT" } });
  });

  it("user cancellation during the call falls back as REQUEST_CANCELLED", async () => {
    const controller = new AbortController();
    const { provider } = fakeProvider((signal) => new Promise(() => signal.addEventListener("abort", () => undefined)));
    const { service, rows } = harness({ manifest: remote(), provider });
    const pending = service.execute(request(), controller.signal);
    controller.abort();
    expect(await pending).toMatchObject({ kind: "FALLBACK", fallback: { reason: "REQUEST_CANCELLED" } });
    expect(rows[0]).toMatchObject({ outcomeCode: "REQUEST_CANCELLED", attempts: { count: 1 } });
  });

  it("an abstention falls back without retry", async () => {
    const { provider, invoke } = fakeProvider(completed(abstainFixture("EXPLAIN_PATTERN")));
    const { service } = harness({ manifest: remote(), provider });
    expect(await service.execute(request())).toMatchObject({ kind: "FALLBACK", fallback: { reason: "MODEL_ABSTAINED" } });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("a structural failure uses the one permitted repair attempt", async () => {
    const { provider, invoke } = fakeProvider(completed("{not json"), completed(outputFixture("EXPLAIN_PATTERN")));
    const { service, rows } = harness({ manifest: remote(), provider });
    expect(await service.execute(request())).toMatchObject({ kind: "ACCEPTED" });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(rows[0]).toMatchObject({ outcomeCode: "ACCEPTED", attempts: { count: 2, structuralRepairUsed: true }, measurements: { inputTokens: 800, outputTokens: 160 } });
  });

  it("a second structural failure falls back as SCHEMA_INVALID", async () => {
    const { provider, invoke } = fakeProvider(completed("{not json"), completed("{still not json"));
    const { service } = harness({ manifest: remote(), provider });
    expect(await service.execute(request())).toMatchObject({ kind: "FALLBACK", fallback: { reason: "SCHEMA_INVALID" } });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("a task without repair never retries a structural failure", async () => {
    const { provider, invoke } = fakeProvider(completed("{not json"));
    const { service } = harness({ manifest: remote(), provider });
    expect(await service.execute(request("PHRASE_NON_CLINICAL_RESPONSE"))).toMatchObject({ kind: "FALLBACK", fallback: { reason: "SCHEMA_INVALID" } });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("an invalid meaning falls back immediately without repair", async () => {
    const output = outputFixture("EXPLAIN_PATTERN") as { payload: { observation: { text: string } } };
    output.payload.observation.text = "These readings are dangerous.";
    const { provider, invoke } = fakeProvider(completed(output));
    const { service, rows } = harness({ manifest: remote(), provider });
    expect(await service.execute(request())).toMatchObject({ kind: "FALLBACK", fallback: { reason: "CLINICAL_MEANING_VIOLATION" } });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(rows[0])).not.toContain("dangerous");
  });
});
