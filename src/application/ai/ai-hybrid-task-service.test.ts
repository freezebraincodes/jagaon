import { afterEach, describe, expect, it, vi } from "vitest";
import { plannedFixture, shellCandidate } from "@/ai/evaluation/packet-11-hybrid-test-support";
import { aiInvocationAuditRowSchema, type AiInvocationAuditRow, type ShellFieldPath, type ShellTaskRequest } from "@/domain/ai";
import { AI_ACTIVATION_MANIFEST } from "./ai-activation-manifest";
import { createAiHybridTaskService } from "./ai-hybrid-task-service";
import type { AiShellProviderPort, ProviderInvocationResult } from "./ai-provider-port";
import { AI_HYBRID_RUNTIME_BUNDLES } from "./ai-hybrid-runtime-bundles";
import { verifyComposition } from "./language/assembler";
import { atomMultiset, composeDeterministic } from "./language/deterministic-composition";
import { planSlots } from "./language/slot-planner";
import { projectShellTaskRequest } from "./language/shell-projector";

// Module spies pin the production wiring: S10 (verifyComposition) and the value-blind projector are the real
// implementations by default; individual tests override a single call.
vi.mock("./language/assembler", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./language/assembler")>();
  return { ...actual, verifyComposition: vi.fn(actual.verifyComposition) };
});
vi.mock("./language/shell-projector", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./language/shell-projector")>();
  return { ...actual, projectShellTaskRequest: vi.fn(actual.projectShellTaskRequest) };
});
const verifySpy = vi.mocked(verifyComposition);
const projectorSpy = vi.mocked(projectShellTaskRequest);
const real = {
  verifyComposition: (await vi.importActual<typeof import("./language/assembler")>("./language/assembler")).verifyComposition,
  projectShellTaskRequest: (await vi.importActual<typeof import("./language/shell-projector")>("./language/shell-projector")).projectShellTaskRequest,
};

const EN = plannedFixture("p11.explain-pattern.en-sg.ordinary");
const ENABLED = { ...AI_ACTIVATION_MANIFEST, tasks: { ...AI_ACTIVATION_MANIFEST.tasks, EXPLAIN_PATTERN: "SYNTHETIC_REMOTE_ENABLED", DRAFT_CARE_PREPARATION_SUMMARY: "SYNTHETIC_REMOTE_ENABLED" } } as typeof AI_ACTIVATION_MANIFEST;
// Observation ownership (@11b.8): the model writes the headline and the evidence; the application composes the observation.
const VALID = shellCandidate(EN.plan, new Map<ShellFieldPath, string>([["headline", "A look at {{S1}}."], ["evidence", "This is based on {{S3}}."]]));
const completed = (candidate: unknown, retention: "CONFIRMED_NOT_STORED" | "RETENTION_UNCONFIRMED" = "CONFIRMED_NOT_STORED"): ProviderInvocationResult => ({ kind: "COMPLETED", candidate, usage: { inputTokens: 10, outputTokens: 5, costMicroUsd: 1 }, responseModel: "test-model", retention });

function harness(results: Array<ProviderInvocationResult | Promise<ProviderInvocationResult>>, overrides: Record<string, unknown> = {}) {
  const calls: ShellTaskRequest[] = [];
  const rows: AiInvocationAuditRow[] = [];
  const provider: AiShellProviderPort = { providerModel: { providerKey: "test", modelSnapshot: "test-model" }, invoke: async (input) => { calls.push(input); return results.shift()!; } };
  const service = createAiHybridTaskService({ releaseProfile: "HACKATHON_DEMO", audit: { append: async (row) => void rows.push(row) }, now: () => "2026-10-06T01:00:00.000Z", monotonicMs: () => 0, manifest: ENABLED, provider, ...overrides });
  return { calls, rows, service };
}
const expectOneValidRow = (rows: AiInvocationAuditRow[], outcomeCode: string, runtimeBundleKey = "ai.explain-pattern@11b.18") => {
  expect(rows).toHaveLength(1);
  expect(aiInvocationAuditRowSchema.safeParse(rows[0]).success).toBe(true);
  expect(rows[0]).toMatchObject({ outcomeCode, runtimeBundleKey });
};
const CARE = plannedFixture("p11.draft-care-preparation-summary.en-sg.ordinary");
const INELIGIBLE_CASES = [
  ["an over-budget care plan", (r: any) => (r.facts.find((fact: any) => fact.field === "QUESTION_TEXT").value.text = `${"Q".repeat(300)}?`), "BUDGET_EXCEEDED"],
  ["a Patterns section", (r: any) => (r.taskPayload.sections[0].sectionId = "PATTERNS"), "PAYLOAD_INVALID"],
  ["a Symptoms and context section", (r: any) => (r.taskPayload.sections[0].sectionId = "SYMPTOMS_AND_CONTEXT"), "PAYLOAD_INVALID"],
] as const;
const ineligibleRequest = (mutate: (request: any) => void) => {
  const request = structuredClone(CARE.request) as any;
  mutate(request);
  return request as typeof CARE.request;
};
afterEach(() => {
  vi.useRealTimers();
  // Drop any unconsumed one-off override and restore the real implementations.
  verifySpy.mockReset().mockImplementation(real.verifyComposition);
  projectorSpy.mockReset().mockImplementation(real.projectShellTaskRequest);
});

describe("hybrid task service", () => {
  it("REMOTE_AI: sends exactly the value-blind request and returns the AI composition", async () => {
    const { calls, rows, service } = harness([completed(VALID)]);
    const result = await service.execute(EN.request);
    expect(calls).toEqual([projectShellTaskRequest(EN.plan)]);
    expect(result).toMatchObject({ kind: "COMPOSED", source: "AI", mode: "REMOTE_AI", reason: null, limitationCopyComplete: true });
    expectOneValidRow(rows, "ACCEPTED");
  });
  it.each([
    ["NOT_ACTIVATED (production manifest)", { manifest: AI_ACTIVATION_MANIFEST }, "NOT_ACTIVATED", "TASK_DISABLED"],
    ["PRIVATE", { privateMode: () => true }, "PRIVATE", "PRIVACY_REJECTED"],
    ["OFFLINE", { online: () => false }, "OFFLINE", "TRANSPORT_FAILED"],
    ["NO_PROVIDER", { provider: undefined }, "NO_PROVIDER", "MISSING_CONFIGURATION"],
  ])("Review Focus %s: no provider call; deterministic composition with the same atoms", async (_label, overrides, mode, reason) => {
    const { calls, rows, service } = harness([completed(VALID)], overrides);
    const result = await service.execute(EN.request);
    expect(calls).toHaveLength(0);
    expect(result).toMatchObject({ kind: "COMPOSED", source: "DETERMINISTIC", mode, reason });
    const ai = await harness([completed(VALID)]).service.execute(EN.request);
    expect(atomMultiset((result as any).composition)).toEqual(atomMultiset((ai as any).composition));
    expectOneValidRow(rows, reason);
    expect(rows[0]!.attempts.count).toBe(0);
  });
  it.each([
    ["S1 malformed twice", [completed(`${JSON.stringify(VALID)}}`), completed(`${JSON.stringify(VALID)}}`)], "SCHEMA_INVALID", 2],
    ["S5 digit", [completed({ ...VALID, shells: { ...(VALID as any).shells, evidence: "About 10 of {{S3}}." } })], "FACT_FIDELITY_FAILED", 1],
    ["S6 directive", [completed({ ...VALID, shells: { ...(VALID as any).shells, evidence: "Please review {{S3}}." } })], "CLINICAL_MEANING_VIOLATION", 1],
    // A model-provided observation is a structural S2 rejection (the application owns the observation): repaired once, then fallback.
    ["S2 model observation twice", [completed({ ...VALID, shells: { ...(VALID as any).shells, observation: "Your records show {{S2}}." } }), completed({ ...VALID, shells: { ...(VALID as any).shells, observation: "Your records show {{S2}}." } })], "SCHEMA_INVALID", 2],
    ["retention unconfirmed", [completed(VALID, "RETENTION_UNCONFIRMED")], "PROVIDER_FAILED", 1],
    ["provider failure", [{ kind: "FAILED", reason: "PROVIDER_REJECTED" } as ProviderInvocationResult], "PROVIDER_REJECTED", 1],
  ])("every rejection (%s) returns the deterministic composition silently", async (_label, results, reason, calls) => {
    const run = harness(results as ProviderInvocationResult[]);
    expect(await run.service.execute(EN.request)).toMatchObject({ kind: "COMPOSED", source: "DETERMINISTIC", reason });
    expect(run.calls).toHaveLength(calls);
    expectOneValidRow(run.rows, reason);
  });
  it("P3 (ai-language-copy.11b.8): a care result carries the fixed draft notices beside the composition, on the AI and the deterministic path; EXPLAIN carries none", async () => {
    const careShells = new Map(CARE.plan.fields.map((field) => [field.path, field.path.endsWith(".intro") ? "Here is what you chose to include." : field.requiredSlots.map((slot) => `{{${slot}}}`).join(" ")])) as Map<ShellFieldPath, string>;
    const ai = await harness([completed(shellCandidate(CARE.plan, careShells))]).service.execute(CARE.request);
    const deterministic = await harness([], { privateMode: () => true }).service.execute(CARE.request);
    const notices = [
      { kind: "QUESTIONS_IN_OWN_WORDS", text: "Questions are shown in your own words; the app does not carry them out." },
      { kind: "DRAFT_NOT_SENT_OR_REVIEWED", text: "The app does not send this draft to your care team or confirm that a clinician has reviewed it." },
    ];
    expect(ai).toMatchObject({ kind: "COMPOSED", source: "AI", notices });
    expect(deterministic).toMatchObject({ kind: "COMPOSED", source: "DETERMINISTIC", notices });
    // Kept apart from the patient facts: no notice text inside the composition or its validated output.
    for (const result of [ai, deterministic] as any[]) {
      expect(JSON.stringify(result.composition.output)).not.toContain("does not send");
      expect([...result.composition.fields.values()].some((field: { text: string }) => field.text.includes("own words"))).toBe(false);
      expect(result).not.toHaveProperty("limitations");
    }
    const explain = await harness([completed(VALID)]).service.execute(EN.request);
    expect(explain).not.toHaveProperty("notices");
  });
  it("Review Focus S10: the accepted REMOTE_AI path runs the real verifyComposition exactly once on the returned composition", async () => {
    const run = harness([completed(VALID)]);
    const result = await run.service.execute(EN.request);
    expect(result).toMatchObject({ kind: "COMPOSED", source: "AI", mode: "REMOTE_AI", reason: null });
    // Observation ownership: S10 sees the whole output, the application's observation variant included (requestId …001 → variant 1).
    expect((verifySpy.mock.calls[0]![2].output.payload as any).observation.text).toBe("Your records list 6.2 mmol/L and 7.1 mmol/L.");
    expect((result as any).composition.output.payload.headline.text).toBe("A look at your readings from the same time slot in an earlier and a recent period.");
    expect(verifySpy).toHaveBeenCalledTimes(1);
    expect(verifySpy.mock.calls[0]![0]).toEqual(EN.request);
    expect(verifySpy.mock.calls[0]![1]).toBe(AI_HYBRID_RUNTIME_BUNDLES.EXPLAIN_PATTERN);
    expect(verifySpy.mock.calls[0]![2]).toBe((result as any).composition);
    expect(verifySpy.mock.results[0]).toMatchObject({ type: "return", value: { kind: "ACCEPTED" } });
    expectOneValidRow(run.rows, "ACCEPTED");
  });
  it("Review Focus S10: a composition verifyComposition rejects returns the deterministic composition with one audit row", async () => {
    verifySpy.mockReturnValueOnce({ kind: "REJECTED", reason: "FACT_FIDELITY_FAILED", repairable: false });
    const run = harness([completed(VALID)]);
    expect(await run.service.execute(EN.request)).toMatchObject({ kind: "COMPOSED", source: "DETERMINISTIC", mode: "REMOTE_AI", reason: "FACT_FIDELITY_FAILED" });
    expect(verifySpy).toHaveBeenCalledTimes(1);
    expect(run.calls).toHaveLength(1);
    expectOneValidRow(run.rows, "FACT_FIDELITY_FAILED");
    expect(run.rows[0]!.attempts.count).toBe(1);
  });
  it("Review Focus S10: a caller cannot replace the verifier through the dependencies", async () => {
    verifySpy.mockReturnValueOnce({ kind: "REJECTED", reason: "FACT_FIDELITY_FAILED", repairable: false });
    const acceptAll = vi.fn((_request: unknown, _bundle: unknown, composition: { output: unknown }) => ({ kind: "ACCEPTED", output: composition.output }));
    const run = harness([completed(VALID)], { verify: acceptAll });
    expect(await run.service.execute(EN.request)).toMatchObject({ kind: "COMPOSED", source: "DETERMINISTIC", reason: "FACT_FIDELITY_FAILED" });
    expect(acceptAll).not.toHaveBeenCalled();
    expectOneValidRow(run.rows, "FACT_FIDELITY_FAILED");
  });
  it("a projector throw returns the deterministic composition (PAYLOAD_INVALID) with one audit row and no provider call", async () => {
    projectorSpy.mockImplementationOnce(() => {
      throw new Error("SHELL_REQUEST_NOT_APPROVED");
    });
    const run = harness([completed(VALID)]);
    expect(await run.service.execute(EN.request)).toMatchObject({ kind: "COMPOSED", source: "DETERMINISTIC", mode: "REMOTE_AI", reason: "PAYLOAD_INVALID" });
    expect(run.calls).toHaveLength(0);
    expect(verifySpy).not.toHaveBeenCalled();
    expectOneValidRow(run.rows, "PAYLOAD_INVALID");
    expect(run.rows[0]!.attempts.count).toBe(0);
  });
  it.each(INELIGIBLE_CASES)("INELIGIBLE (%s): deterministic composition, no projection, no provider call, one audit row", async (_label, mutate, reason) => {
    const request = ineligibleRequest(mutate);
    const planned = planSlots(request, AI_HYBRID_RUNTIME_BUNDLES.DRAFT_CARE_PREPARATION_SUMMARY);
    if (planned.kind !== "PLANNED") throw new Error("expected PLANNED");
    expect(planned.plan.remote).toEqual({ eligible: false, reason });
    const run = harness([completed(VALID)]);
    const result = await run.service.execute(request);
    expect(result).toMatchObject({ kind: "COMPOSED", source: "DETERMINISTIC", mode: "INELIGIBLE", reason });
    expect((result as any).composition).toEqual(composeDeterministic(request, planned.plan, planned.atoms, AI_HYBRID_RUNTIME_BUNDLES.DRAFT_CARE_PREPARATION_SUMMARY));
    expect(run.calls).toHaveLength(0);
    expect(projectorSpy).not.toHaveBeenCalled();
    expect(verifySpy).not.toHaveBeenCalled();
    expectOneValidRow(run.rows, reason, "ai.draft-care-preparation-summary@11b.18");
    expect(run.rows[0]!.attempts).toEqual({ count: 0, structuralRepairUsed: false, timedOut: false });
  });
  it.each([
    ["NOT_ACTIVATED", { manifest: AI_ACTIVATION_MANIFEST }, "TASK_DISABLED"],
    ["PRIVATE", { privateMode: () => true }, "PRIVACY_REJECTED"],
    ["OFFLINE", { online: () => false }, "TRANSPORT_FAILED"],
    ["NO_PROVIDER", { provider: undefined }, "MISSING_CONFIGURATION"],
  ])("eligibility is checked after the %s check", async (mode, overrides, reason) => {
    const run = harness([completed(VALID)], overrides);
    expect(await run.service.execute(ineligibleRequest(INELIGIBLE_CASES[1][1]))).toMatchObject({ kind: "COMPOSED", source: "DETERMINISTIC", mode, reason });
    expect(run.calls).toHaveLength(0);
    expectOneValidRow(run.rows, reason, "ai.draft-care-preparation-summary@11b.18");
  });
  it("one structural repair is allowed and accepted on the second call", async () => {
    const run = harness([completed(`${JSON.stringify(VALID)}}`), completed(VALID)]);
    expect(await run.service.execute(EN.request)).toMatchObject({ source: "AI" });
    expect(run.rows[0]!.attempts).toEqual({ count: 2, structuralRepairUsed: true, timedOut: false });
  });
  it("Review Focus: a provider that settles after the 10 s timeout is never accepted", async () => {
    vi.useFakeTimers();
    let settle!: (value: ProviderInvocationResult) => void;
    const late = new Promise<ProviderInvocationResult>((resolve) => (settle = resolve));
    const run = harness([late]);
    const pending = run.service.execute(EN.request);
    await vi.advanceTimersByTimeAsync(10_000);
    settle(completed(VALID));
    expect(await pending).toMatchObject({ source: "DETERMINISTIC", reason: "PROVIDER_TIMEOUT" });
    expect(run.rows[0]!.attempts.timedOut).toBe(true);
  });
  it("Review Focus: cancellation before and during the call", async () => {
    const before = new AbortController();
    before.abort();
    const first = harness([completed(VALID)]);
    expect(await first.service.execute(EN.request, before.signal)).toMatchObject({ source: "DETERMINISTIC", reason: "REQUEST_CANCELLED" });
    expect(first.calls).toHaveLength(0);
    const during = new AbortController();
    const second = harness([new Promise<ProviderInvocationResult>(() => undefined)]);
    const pending = second.service.execute(EN.request, during.signal);
    await Promise.resolve();
    during.abort();
    expect(await pending).toMatchObject({ source: "DETERMINISTIC", reason: "REQUEST_CANCELLED" });
  });
  it("a planner failure returns the legacy references-only fallback without a call", async () => {
    const request = structuredClone(EN.request) as any;
    request.facts[0].field = "UNCERTAINTY";
    const run = harness([completed(VALID)]);
    expect(await run.service.execute(request)).toMatchObject({ kind: "FALLBACK", fallback: { reason: "PAYLOAD_INVALID", presentation: { kind: "TEMPLATE_PATTERN_CARD" } } });
    expect(run.calls).toHaveLength(0);
  });
  it("rejects malformed requests and tasks outside the hybrid layer", async () => {
    const { service } = harness([]);
    expect(await service.execute({ taskType: "EXPLAIN_PATTERN" } as never)).toEqual({ kind: "REQUEST_REJECTED" });
  });
});

/**
 * Packet 11C Addendum B, Task B2a (D6): the server shell route runs the value-blind shell gates and may answer with a typed structural
 * rejection instead of a candidate. The service treats it exactly like its own validateShellCandidate rejection: the attempt's usage is
 * counted, at most one structural repair is made (only a repairable SCHEMA_INVALID, within maxAttempts), otherwise the deterministic
 * composition with that reason. The repair happens here, once; the route never retries.
 */
describe("typed structural rejection from the server shell gates (D6)", () => {
  const USAGE = { inputTokens: 10, outputTokens: 5, costMicroUsd: 1 };
  const serverRejected = (reason: string, repairable: boolean, retention: "CONFIRMED_NOT_STORED" | "RETENTION_UNCONFIRMED" = "CONFIRMED_NOT_STORED") =>
    ({ kind: "STRUCTURALLY_REJECTED", reason, repairable, usage: USAGE, retention }) as ProviderInvocationResult;
  const MALFORMED = completed(`${JSON.stringify(VALID)}}`);
  const BOTH_ATTEMPTS = { inputTokens: 20, outputTokens: 10, costMicroUsd: 2 };

  it("a repairable rejection is repaired once and the second candidate is accepted; usage is summed over both attempts", async () => {
    const run = harness([serverRejected("SCHEMA_INVALID", true), completed(VALID)]);
    expect(await run.service.execute(EN.request)).toMatchObject({ kind: "COMPOSED", source: "AI", mode: "REMOTE_AI", reason: null });
    expect(run.calls).toEqual([projectShellTaskRequest(EN.plan), projectShellTaskRequest(EN.plan)]);
    expectOneValidRow(run.rows, "ACCEPTED");
    expect(run.rows[0]!.attempts).toEqual({ count: 2, structuralRepairUsed: true, timedOut: false });
    expect(run.rows[0]!.measurements).toMatchObject(BOTH_ATTEMPTS);
  });

  it("a repairable rejection twice falls back after two attempts with that reason; usage counted for both", async () => {
    const run = harness([serverRejected("SCHEMA_INVALID", true), serverRejected("SCHEMA_INVALID", true), completed(VALID)]);
    expect(await run.service.execute(EN.request)).toMatchObject({ kind: "COMPOSED", source: "DETERMINISTIC", mode: "REMOTE_AI", reason: "SCHEMA_INVALID" });
    expect(run.calls).toHaveLength(2);
    expectOneValidRow(run.rows, "SCHEMA_INVALID");
    expect(run.rows[0]!.attempts).toEqual({ count: 2, structuralRepairUsed: true, timedOut: false });
    expect(run.rows[0]!.measurements).toMatchObject(BOTH_ATTEMPTS);
  });

  it.each([
    ["a non-repairable gate rejection", "FACT_FIDELITY_FAILED", false],
    ["a non-repairable schema rejection", "SCHEMA_INVALID", false],
    // The server can never widen the local rule: only a structural SCHEMA_INVALID is ever repaired.
    ["a non-structural reason marked repairable", "CLINICAL_MEANING_VIOLATION", true],
    ["an abstention marked repairable", "MODEL_ABSTAINED", true],
  ])("%s is never repaired: one attempt, its usage, that reason", async (_label, reason, repairable) => {
    const run = harness([serverRejected(reason, repairable), completed(VALID)]);
    expect(await run.service.execute(EN.request)).toMatchObject({ kind: "COMPOSED", source: "DETERMINISTIC", reason });
    expect(run.calls).toHaveLength(1);
    expectOneValidRow(run.rows, reason);
    expect(run.rows[0]!.attempts).toEqual({ count: 1, structuralRepairUsed: false, timedOut: false });
    expect(run.rows[0]!.measurements).toMatchObject(USAGE);
  });

  it.each([
    ["a reason outside the closed shell-gate list", serverRejected("PROVIDER_REJECTED", true)],
    ["an unknown reason", serverRejected("SOMETHING_ELSE", true)],
    ["a rejection whose retention is unconfirmed", serverRejected("SCHEMA_INVALID", true, "RETENTION_UNCONFIRMED")],
    ["a rejection with a non-boolean repairable flag", { ...serverRejected("SCHEMA_INVALID", true), repairable: "true" } as unknown as ProviderInvocationResult],
  ])("%s fails closed (PROVIDER_FAILED), counts its usage and is never repaired", async (_label, result) => {
    const run = harness([result, completed(VALID)]);
    expect(await run.service.execute(EN.request)).toMatchObject({ kind: "COMPOSED", source: "DETERMINISTIC", reason: "PROVIDER_FAILED" });
    expect(run.calls).toHaveLength(1);
    expectOneValidRow(run.rows, "PROVIDER_FAILED");
    expect(run.rows[0]!.measurements).toMatchObject(USAGE);
  });

  it.each([
    ["repaired then accepted", [MALFORMED, completed(VALID)], [serverRejected("SCHEMA_INVALID", true), completed(VALID)]],
    ["rejected twice", [MALFORMED, MALFORMED], [serverRejected("SCHEMA_INVALID", true), serverRejected("SCHEMA_INVALID", true)]],
    ["a final rejection", [completed({ ...VALID, shells: { ...(VALID as any).shells, evidence: "About 10 of {{S3}}." } })], [serverRejected("FACT_FIDELITY_FAILED", false)]],
  ])("the local and the server rejection paths produce the same outcome and audit row (%s)", async (_label, local, server) => {
    const viaLocal = harness(local as ProviderInvocationResult[]);
    const viaServer = harness(server as ProviderInvocationResult[]);
    const localResult = await viaLocal.service.execute(EN.request);
    const serverResult = await viaServer.service.execute(EN.request);
    expect(serverResult).toEqual(localResult);
    expect(viaServer.calls).toEqual(viaLocal.calls);
    expect(viaServer.rows).toEqual(viaLocal.rows);
  });

  it.each([
    ["server then server", [serverRejected("SCHEMA_INVALID", true), serverRejected("SCHEMA_INVALID", true), completed(VALID)]],
    ["local then server", [MALFORMED, serverRejected("SCHEMA_INVALID", true), completed(VALID)]],
    ["server then local", [serverRejected("SCHEMA_INVALID", true), MALFORMED, completed(VALID)]],
  ])("maxAttempts is never exceeded and the repair is never doubled (%s)", async (_label, results) => {
    const run = harness(results);
    expect(await run.service.execute(EN.request)).toMatchObject({ kind: "COMPOSED", source: "DETERMINISTIC", reason: "SCHEMA_INVALID" });
    expect(run.calls).toHaveLength(AI_HYBRID_RUNTIME_BUNDLES.EXPLAIN_PATTERN.executionBudget.maxAttempts);
    expect(run.rows[0]!.attempts).toEqual({ count: 2, structuralRepairUsed: true, timedOut: false });
  });
});

/**
 * Packet 11C Addendum B, Task B2b (B2a review follow-up): a provider FAILED result may carry the bounded usage of a billed attempt that
 * was refused after completion (the shell route's retention refusal). The service folds that usage like any other attempt's, so the
 * billed spend is counted; a FAILED without usage behaves exactly as before.
 */
describe("usage carried by a FAILED result", () => {
  const USAGE = { inputTokens: 10, outputTokens: 5, costMicroUsd: 1 };
  const failedWith = (usage?: unknown) => ({ kind: "FAILED", reason: "PROVIDER_FAILED", ...(usage === undefined ? {} : { usage }) }) as ProviderInvocationResult;

  it("is counted in the audit row; the outcome is unchanged", async () => {
    const run = harness([failedWith(USAGE)]);
    expect(await run.service.execute(EN.request)).toMatchObject({ kind: "COMPOSED", source: "DETERMINISTIC", mode: "REMOTE_AI", reason: "PROVIDER_FAILED" });
    expectOneValidRow(run.rows, "PROVIDER_FAILED");
    expect(run.rows[0]!.attempts).toEqual({ count: 1, structuralRepairUsed: false, timedOut: false });
    expect(run.rows[0]!.measurements).toMatchObject(USAGE);
  });

  it("is summed with an earlier attempt's usage (a repair attempt that failed after completion)", async () => {
    const run = harness([completed(`${JSON.stringify(VALID)}}`), failedWith(USAGE)]);
    expect(await run.service.execute(EN.request)).toMatchObject({ source: "DETERMINISTIC", reason: "PROVIDER_FAILED" });
    expect(run.rows[0]!.measurements).toMatchObject({ inputTokens: 20, outputTokens: 10, costMicroUsd: 2 });
  });

  it("is bounded like any usage, and an unknown reason still fails closed as PROVIDER_FAILED", async () => {
    const run = harness([{ kind: "FAILED", reason: "SOMETHING_ELSE", usage: { inputTokens: 1e9, outputTokens: -1, costMicroUsd: 3 } } as unknown as ProviderInvocationResult]);
    expect(await run.service.execute(EN.request)).toMatchObject({ source: "DETERMINISTIC", reason: "PROVIDER_FAILED" });
    expectOneValidRow(run.rows, "PROVIDER_FAILED");
    expect(run.rows[0]!.measurements).toMatchObject({ inputTokens: null, outputTokens: null, costMicroUsd: 3 });
  });

  it("a FAILED without usage records no usage, exactly as before", async () => {
    const run = harness([failedWith()]);
    await run.service.execute(EN.request);
    expect(run.rows[0]!.measurements).toMatchObject({ inputTokens: null, outputTokens: null, costMicroUsd: null });
  });
});

/**
 * Packet 11C Addendum B, Task B3: a provider that carries a remote-use disclosure (the browser shell client) has it decided by the
 * service BEFORE the first attempt and before any timer: after the activation, private, offline, provider, eligibility, cancellation and
 * projection checks, once per request (never again on the repair). Anything but ACCEPTED ends the request deterministically with nothing
 * sent, and the audit row says so: no attempt, no provider model, no source revision, no usage.
 */
describe("remote-use disclosure decided before the first attempt (Packet 11C B3)", () => {
  type Decide = NonNullable<AiShellProviderPort["remoteUse"]>["decide"];
  function gated(results: Array<ProviderInvocationResult | Promise<ProviderInvocationResult>>, decide: Decide, overrides: Record<string, unknown> = {}) {
    const calls: ShellTaskRequest[] = [];
    const provider: AiShellProviderPort = {
      providerModel: { providerKey: "test", modelSnapshot: "test-model" },
      remoteUse: { decide },
      invoke: async (input) => {
        calls.push(input);
        return results.shift()!;
      },
    };
    const run = harness([], { provider, ...overrides });
    return { ...run, calls, provider };
  }
  const NOTHING_SENT = { providerModel: null, attempts: { count: 0, structuralRepairUsed: false, timedOut: false }, sourceRevisions: [], measurements: { inputTokens: null, outputTokens: null, costMicroUsd: null } };

  it.each([
    ["NOT_ACCEPTED", async () => "NOT_ACCEPTED" as const],
    ["a throw", async () => Promise.reject(new Error("boom"))],
    ["a synchronous throw", () => {
      throw new Error("boom");
    }],
    ["an unknown answer", async () => "accepted" as never],
  ])("%s: the deterministic composition, no provider call, and an audit row that records nothing sent", async (_label, decide) => {
    const run = gated([completed(VALID)], decide as Decide);
    const result = await run.service.execute(EN.request);
    expect(result).toMatchObject({ kind: "COMPOSED", source: "DETERMINISTIC", mode: "REMOTE_NOT_ACCEPTED", reason: "MISSING_CONFIGURATION" });
    expect(run.calls).toHaveLength(0);
    expectOneValidRow(run.rows, "MISSING_CONFIGURATION");
    expect(run.rows[0]).toMatchObject(NOTHING_SENT);
    // The same atoms as the AI path: a not-accepted request is the ordinary deterministic composition.
    const ai = await harness([completed(VALID)]).service.execute(EN.request);
    expect(atomMultiset((result as any).composition)).toEqual(atomMultiset((ai as any).composition));
  });

  it("Packet 11C B4a: DECLINED (the patient's explicit Cancel) is the same deterministic outcome, audited as REQUEST_CANCELLED with nothing sent", async () => {
    const run = gated([completed(VALID)], async () => "DECLINED");
    const result = await run.service.execute(EN.request);
    expect(result).toMatchObject({ kind: "COMPOSED", source: "DETERMINISTIC", mode: "REMOTE_NOT_ACCEPTED", reason: "REQUEST_CANCELLED" });
    expect(run.calls).toHaveLength(0);
    expectOneValidRow(run.rows, "REQUEST_CANCELLED");
    expect(run.rows[0]).toMatchObject(NOTHING_SENT);
  });

  it("ACCEPTED: asked exactly once, with the request's signal, before the first call; the repair attempt is not asked again", async () => {
    let callsWhenDecided = -1;
    const run = gated([completed(`${JSON.stringify(VALID)}}`), completed(VALID)], async () => {
      callsWhenDecided = run.calls.length;
      return "ACCEPTED";
    });
    const decide = vi.spyOn(run.provider.remoteUse!, "decide");
    const controller = new AbortController();
    const result = await run.service.execute(EN.request, controller.signal);
    expect(result).toMatchObject({ kind: "COMPOSED", source: "AI", mode: "REMOTE_AI", reason: null });
    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide.mock.calls[0]![0]).toBe(controller.signal);
    expect(callsWhenDecided).toBe(0);
    expect(run.calls).toHaveLength(2);
    expect(run.rows[0]).toMatchObject({ outcomeCode: "ACCEPTED", providerModel: { providerKey: "test", modelSnapshot: "test-model" }, attempts: { count: 2, structuralRepairUsed: true, timedOut: false } });
  });

  it("is decided before any timer: a decision that takes longer than the overall budget never times the request out", async () => {
    vi.useFakeTimers();
    let answer!: (value: "ACCEPTED") => void;
    const decide = vi.fn<Decide>(() => new Promise((resolve) => (answer = resolve)));
    const run = gated([completed(VALID)], decide);
    const pending = run.service.execute(EN.request);
    const budget = AI_HYBRID_RUNTIME_BUNDLES.EXPLAIN_PATTERN.executionBudget;
    await vi.advanceTimersByTimeAsync(budget.overallTimeoutMs + budget.perCallTimeoutMs + 1);
    expect(run.calls).toHaveLength(0);
    expect(run.rows).toHaveLength(0);
    answer("ACCEPTED");
    expect(await pending).toMatchObject({ source: "AI", reason: null });
    expect(run.rows[0]!.attempts).toEqual({ count: 1, structuralRepairUsed: false, timedOut: false });
  });

  it("works without a caller signal (the decision still receives an AbortSignal)", async () => {
    const decide = vi.fn<Decide>(async () => "ACCEPTED");
    const run = gated([completed(VALID)], decide);
    expect(await run.service.execute(EN.request)).toMatchObject({ source: "AI" });
    expect(decide.mock.calls[0]![0]).toBeInstanceOf(AbortSignal);
  });

  it("an abort while the decision is pending: REQUEST_CANCELLED, nothing sent, the listener released", async () => {
    const controller = new AbortController();
    const removed = vi.spyOn(controller.signal, "removeEventListener");
    const run = gated([completed(VALID)], () => new Promise(() => undefined));
    const pending = run.service.execute(EN.request, controller.signal);
    await Promise.resolve();
    controller.abort();
    expect(await pending).toMatchObject({ source: "DETERMINISTIC", mode: "REMOTE_AI", reason: "REQUEST_CANCELLED" });
    expect(run.calls).toHaveLength(0);
    expect(run.rows[0]).toMatchObject({ outcomeCode: "REQUEST_CANCELLED", ...NOTHING_SENT });
    expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("an acceptance that arrives after the abort is not used", async () => {
    const controller = new AbortController();
    const run = gated([completed(VALID)], async () => (controller.abort(), "ACCEPTED"));
    expect(await run.service.execute(EN.request, controller.signal)).toMatchObject({ source: "DETERMINISTIC", reason: "REQUEST_CANCELLED" });
    expect(run.calls).toHaveLength(0);
    expect(run.rows[0]).toMatchObject(NOTHING_SENT);
  });

  it.each([
    ["NOT_ACTIVATED", { manifest: AI_ACTIVATION_MANIFEST }, EN.request, "TASK_DISABLED"],
    ["PRIVATE", { privateMode: () => true }, EN.request, "PRIVACY_REJECTED"],
    ["OFFLINE", { online: () => false }, EN.request, "TRANSPORT_FAILED"],
    ["INELIGIBLE", {}, ineligibleRequest(INELIGIBLE_CASES[1][1]), "PAYLOAD_INVALID"],
  ])("is never asked when the request is %s", async (mode, overrides, request, reason) => {
    const decide = vi.fn<Decide>(async () => "ACCEPTED");
    const run = gated([completed(VALID)], decide, overrides);
    expect(await run.service.execute(request)).toMatchObject({ source: "DETERMINISTIC", mode, reason });
    expect(decide).not.toHaveBeenCalled();
    expect(run.calls).toHaveLength(0);
  });

  it("is never asked when the value-blind request cannot be projected", async () => {
    projectorSpy.mockImplementationOnce(() => {
      throw new Error("SHELL_REQUEST_NOT_APPROVED");
    });
    const decide = vi.fn<Decide>(async () => "ACCEPTED");
    const run = gated([completed(VALID)], decide);
    expect(await run.service.execute(EN.request)).toMatchObject({ source: "DETERMINISTIC", reason: "PAYLOAD_INVALID" });
    expect(decide).not.toHaveBeenCalled();
  });

  it("is never asked for an already-aborted request", async () => {
    const controller = new AbortController();
    controller.abort();
    const decide = vi.fn<Decide>(async () => "ACCEPTED");
    const run = gated([completed(VALID)], decide);
    expect(await run.service.execute(EN.request, controller.signal)).toMatchObject({ reason: "REQUEST_CANCELLED" });
    expect(decide).not.toHaveBeenCalled();
  });
});
