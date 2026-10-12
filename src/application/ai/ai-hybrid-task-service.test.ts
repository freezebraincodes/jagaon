import { afterEach, describe, expect, it, vi } from "vitest";
import { plannedFixture, shellCandidate } from "@/ai/evaluation/packet-11-hybrid-test-support";
import { AI_AUDIT_ONLY_OUTCOME_CODES, aiInvocationAuditRowSchema, type AiInvocationAuditRow, type ShellFieldPath, type ShellTaskRequest } from "@/domain/ai";
import { AI_ACTIVATION_MANIFEST } from "./ai-activation-manifest";
import { createAiHybridTaskService } from "./ai-hybrid-task-service";
import { PROVIDER_FAILURE_REASONS, type AiShellProviderPort, type ProviderInvocationResult } from "./ai-provider-port";
import { AI_SHELL_ROUTE_POST_CALL_FAILURE_REASONS, aiShellRouteResponseSchema, shellRouteCallUpperBound } from "./ai-shell-route-contract";
import { AI_HYBRID_RUNTIME_BUNDLES } from "./ai-hybrid-runtime-bundles";
import { verifyComposition } from "./language/assembler";
import { atomMultiset, composeDeterministic } from "./language/deterministic-composition";
import { planSlots } from "./language/slot-planner";
import { projectShellTaskRequest } from "./language/shell-projector";
import { requestClassIdentity, SHIPPED_REQUEST_CLASS_GATE, type AiRequestClassGate } from "./request-class-qualification";
import { DETERMINISTIC_ONLY_TEST_MANIFEST, pendingTestRequestClassGate, qualifiedTestRequestClassGate } from "./request-class-test-support";

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
  // Packet 11C Addendum C (C1): a remote path needs a QUALIFIED class; these tests inject test-only QUALIFIED records (independent of the
  // shipped records). An override `requestClassGate: undefined` restores the production default. Packet 11C English activation (owner
  // decisions Q and A): the shipped manifest enables both tasks and the shipped records qualify only the en-SG classes, so tests whose
  // subject is "not activated" or "not qualified" inject DETERMINISTIC_ONLY_TEST_MANIFEST or pendingTestRequestClassGate() instead.
  const service = createAiHybridTaskService({ releaseProfile: "HACKATHON_DEMO", audit: { append: async (row) => void rows.push(row) }, now: () => "2026-10-06T01:00:00.000Z", monotonicMs: () => 0, manifest: ENABLED, provider, requestClassGate: qualifiedTestRequestClassGate(), ...overrides });
  return { calls, rows, service };
}
const expectOneValidRow = (rows: AiInvocationAuditRow[], outcomeCode: string, runtimeBundleKey = "ai.explain-pattern@11b.20") => {
  expect(rows).toHaveLength(1);
  expect(aiInvocationAuditRowSchema.safeParse(rows[0]).success).toBe(true);
  // Packet 11C Addendum C (C5): every row the service writes is a current (11c.2) row.
  expect(rows[0]).toMatchObject({ auditSchemaVersion: "ai-invocation-audit.11c.2", outcomeCode, runtimeBundleKey });
};
const CARE = plannedFixture("p11.draft-care-preparation-summary.en-sg.ordinary");
const ZH = plannedFixture("p11.explain-pattern.zh-sg.ordinary");
const CARE_ZH = plannedFixture("p11.draft-care-preparation-summary.zh-sg.ordinary");
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
  describe("Packet 11C Addendum C, C1: only a QUALIFIED request class may be sent", () => {
    const unqualifiedRow = (row: AiInvocationAuditRow) => {
      expect(row).toMatchObject({ outcomeCode: "REQUEST_CLASS_NOT_QUALIFIED", attempts: { count: 0, structuralRepairUsed: false, timedOut: false }, providerModel: null, sourceRevisions: [], usageBasis: "NONE" });
      expect(row.measurements).toMatchObject({ inputTokens: null, outputTokens: null, costMicroUsd: null });
    };
    // Packet 11C English activation (owner decisions Q and A): the shipped records qualify the en-SG classes only, so the unqualified
    // path is pinned for the zh-SG classes under the shipped records and for every class under an all-PENDING gate (pre-activation).
    it.each([
      ["an all-PENDING gate over the shipped definitions (pre-activation)", { requestClassGate: pendingTestRequestClassGate() }, [EN, CARE, ZH, CARE_ZH]],
      ["the production default (no gate injected: the shipped records), zh-SG", { requestClassGate: undefined }, [ZH, CARE_ZH]],
      ["the shipped gate, zh-SG", { requestClassGate: SHIPPED_REQUEST_CLASS_GATE }, [ZH, CARE_ZH]],
    ] as const)("an unqualified class under %s composes deterministically, sends nothing, asks no disclosure and writes one REQUEST_CLASS_NOT_QUALIFIED row", async (_label, overrides, fixtures) => {
      for (const fixture of fixtures) {
        const decide = vi.fn(async () => "ACCEPTED" as const);
        const invoke = vi.fn();
        const rows: AiInvocationAuditRow[] = [];
        const run = harness([], { ...overrides, provider: { providerModel: { providerKey: "test", modelSnapshot: "test-model" }, remoteUse: { decide }, invoke }, audit: { append: async (row: AiInvocationAuditRow) => void rows.push(row) } });
        const result = await run.service.execute(fixture.request);
        expect(result).toMatchObject({ kind: "COMPOSED", source: "DETERMINISTIC", mode: "CLASS_NOT_QUALIFIED", reason: "TASK_DISABLED" });
        // The same deterministic composition as any other fallback (the same atoms).
        expect((result as any).composition).toEqual(composeDeterministic(fixture.request, fixture.plan, fixture.atoms, AI_HYBRID_RUNTIME_BUNDLES[fixture.plan.taskType]));
        expect(projectorSpy).toHaveBeenCalled();
        expect(decide).not.toHaveBeenCalled();
        expect(invoke).not.toHaveBeenCalled();
        expectOneValidRow(rows, "REQUEST_CLASS_NOT_QUALIFIED", AI_HYBRID_RUNTIME_BUNDLES[fixture.plan.taskType].bundleKey);
        unqualifiedRow(rows[0]!);
      }
    });
    it("the production default (no gate injected: the shipped records) admits the en-SG classes: the disclosure is asked once and the exact value-blind request is sent", async () => {
      for (const [label, fixture] of [["en-SG explanation", EN], ["en-SG care", CARE]] as const) {
        const decide = vi.fn(async () => "ACCEPTED" as const);
        const sent: ShellTaskRequest[] = [];
        const run = harness([], { requestClassGate: undefined, provider: { providerModel: { providerKey: "test", modelSnapshot: "test-model" }, remoteUse: { decide }, invoke: async (input: ShellTaskRequest) => (sent.push(input), completed(fixture === EN ? VALID : {})) } });
        await run.service.execute(fixture.request);
        expect(decide, label).toHaveBeenCalledTimes(1);
        expect(sent[0], label).toEqual(projectShellTaskRequest(fixture.plan));
        expect(SHIPPED_REQUEST_CLASS_GATE.admit(sent[0]!), label).toEqual({ admitted: true, classId: requestClassIdentity(sent[0]!).classId });
      }
    });
    it("the class is decided on the projected value-blind request, after every earlier check and before the disclosure", async () => {
      const admit = vi.fn<AiRequestClassGate["admit"]>(() => ({ admitted: false, classId: null, reason: "NO_DEFINITION" }));
      const gate: AiRequestClassGate = { admit, anyAdmissible: () => false };
      for (const overrides of [{ manifest: DETERMINISTIC_ONLY_TEST_MANIFEST }, { privateMode: () => true }, { online: () => false }, { provider: undefined }]) {
        await harness([], { ...overrides, requestClassGate: gate }).service.execute(EN.request);
        await harness([], { requestClassGate: gate }).service.execute(ineligibleRequest(INELIGIBLE_CASES[1][1]));
      }
      expect(admit).not.toHaveBeenCalled();
      const run = harness([completed(VALID)], { requestClassGate: gate });
      await run.service.execute(EN.request);
      expect(admit).toHaveBeenCalledTimes(1);
      expect(admit.mock.calls[0]![0]).toEqual(projectShellTaskRequest(EN.plan));
      expect(run.calls).toHaveLength(0);
      expectOneValidRow(run.rows, "REQUEST_CLASS_NOT_QUALIFIED");
    });
    it("a QUALIFIED class proceeds unchanged (the class id of exactly the request sent); a gate that throws fails closed", async () => {
      const gate = qualifiedTestRequestClassGate();
      const run = harness([completed(VALID)], { requestClassGate: gate });
      expect(await run.service.execute(EN.request)).toMatchObject({ source: "AI", mode: "REMOTE_AI" });
      expect(gate.admitted).toEqual([requestClassIdentity(run.calls[0]!).classId]);
      const throwing: AiRequestClassGate = { admit: () => { throw new Error("broken"); }, anyAdmissible: () => true };
      const broken = harness([completed(VALID)], { requestClassGate: throwing });
      expect(await broken.service.execute(EN.request)).toMatchObject({ source: "DETERMINISTIC", mode: "CLASS_NOT_QUALIFIED", reason: "TASK_DISABLED" });
      expect(broken.calls).toHaveLength(0);
      expectOneValidRow(broken.rows, "REQUEST_CLASS_NOT_QUALIFIED");
    });
    it("a cancellation while deciding is REQUEST_CANCELLED with nothing sent", async () => {
      const controller = new AbortController();
      const gate: AiRequestClassGate = { admit: (request) => { controller.abort(); return qualifiedTestRequestClassGate().admit(request); }, anyAdmissible: () => true };
      const run = harness([completed(VALID)], { requestClassGate: gate });
      expect(await run.service.execute(EN.request, controller.signal)).toMatchObject({ source: "DETERMINISTIC", reason: "REQUEST_CANCELLED" });
      expect(run.calls).toHaveLength(0);
      expectOneValidRow(run.rows, "REQUEST_CANCELLED");
    });
    it("the route's closed class refusal (a provider FAILED with refusal REQUEST_CLASS_NOT_QUALIFIED) is audited truthfully, never repaired", async () => {
      const run = harness([{ kind: "FAILED", reason: "PROVIDER_REJECTED", refusal: "REQUEST_CLASS_NOT_QUALIFIED" }, completed(VALID)]);
      expect(await run.service.execute(EN.request)).toMatchObject({ source: "DETERMINISTIC", mode: "REMOTE_AI", reason: "PROVIDER_REJECTED" });
      expect(run.calls).toHaveLength(1);
      expectOneValidRow(run.rows, "REQUEST_CLASS_NOT_QUALIFIED");
      // The POST reached the app's own route, which refused it before any provider call: one attempt, nothing billed.
      expect(run.rows[0]).toMatchObject({ attempts: { count: 1 }, measurements: { inputTokens: null, outputTokens: null, costMicroUsd: null } });
    });
  });

  /**
   * Packet 11C Addendum C, Task C6 (C5 review carry): a route refusal decided before the provider call carries the explicit "not sent to
   * provider" marker, so it is never counted as a provider attempt: zero attempts, usage basis NONE, the truthful audit-only code.
   */
  describe("C6: route refusals marked not sent to the provider", () => {
    const REFUSALS = ["REQUEST_CLASS_NOT_QUALIFIED", "REMOTE_AI_DISABLED", "ORIGIN_REJECTED", "ACCESS_DENIED", "SPEND_NOT_CONFIGURED", "SPEND_CEILING_REACHED", "SPEND_LEDGER_UNAVAILABLE"] as const;
    it.each(REFUSALS.map((code) => [code]))("a first-call %s refusal is a zero-attempt row (basis NONE, no provider model), never repaired", async (code) => {
      const run = harness([{ kind: "FAILED", reason: "PROVIDER_REJECTED", refusal: code, notSentToProvider: true }, completed(VALID)]);
      expect(await run.service.execute(EN.request)).toMatchObject({ source: "DETERMINISTIC", mode: "REMOTE_AI", reason: "PROVIDER_REJECTED" });
      expect(run.calls).toHaveLength(1);
      expectOneValidRow(run.rows, code);
      expect(run.rows[0]).toMatchObject({ attempts: { count: 0, structuralRepairUsed: false, timedOut: false }, providerModel: null, usageBasis: "NONE", measurements: { inputTokens: null, outputTokens: null, costMicroUsd: null } });
    });
    it("a refusal of the single repair keeps the first transmitted attempt only (its usage, basis REPORTED; the repair was not sent)", async () => {
      const malformed = `${JSON.stringify(VALID)}}`;
      const run = harness([completed(malformed), { kind: "FAILED", reason: "PROVIDER_REJECTED", refusal: "SPEND_CEILING_REACHED", notSentToProvider: true }]);
      expect(await run.service.execute(EN.request)).toMatchObject({ source: "DETERMINISTIC", reason: "PROVIDER_REJECTED" });
      expect(run.calls).toHaveLength(2);
      expectOneValidRow(run.rows, "SPEND_CEILING_REACHED");
      expect(run.rows[0]).toMatchObject({ attempts: { count: 1, structuralRepairUsed: false, timedOut: false }, usageBasis: "REPORTED", measurements: { inputTokens: 10, outputTokens: 5, costMicroUsd: 1 } });
    });
    // Fix round 1 (review item 1): every FAILED marked not sent (and carrying no usage) is uncounted, audited with its existing closed
    // reason; a refusal code outside the closed list is ignored (the closed reason is audited).
    it.each(["MISSING_CONFIGURATION", "PROVIDER_RATE_LIMITED", "PROVIDER_REJECTED", "PROVIDER_FAILED", "TRANSPORT_FAILED"] as const)("a FAILED %s marked not sent is a zero-attempt row with its closed reason (basis NONE)", async (reason) => {
      const run = harness([{ kind: "FAILED", reason, notSentToProvider: true }, completed(VALID)]);
      expect(await run.service.execute(EN.request)).toMatchObject({ source: "DETERMINISTIC", reason });
      expect(run.calls).toHaveLength(1);
      expectOneValidRow(run.rows, reason);
      expect(run.rows[0]).toMatchObject({ attempts: { count: 0, structuralRepairUsed: false, timedOut: false }, providerModel: null, usageBasis: "NONE" });
      const odd = harness([{ kind: "FAILED", reason: "PROVIDER_REJECTED", refusal: "REMOTE_USE_DECLINED", notSentToProvider: true } as unknown as ProviderInvocationResult]);
      await odd.service.execute(EN.request);
      expectOneValidRow(odd.rows, "PROVIDER_REJECTED");
      expect(odd.rows[0]).toMatchObject({ attempts: { count: 0 }, usageBasis: "NONE" });
    });
    it("C5 accounting stays for anything that may have been transmitted: a marked FAILED with usage, an unmarked FAILED, a throw", async () => {
      const usage = { inputTokens: 1, outputTokens: 1, costMicroUsd: 1, basis: "UPPER_BOUND" as const };
      const withUsage = harness([{ kind: "FAILED", reason: "PROVIDER_FAILED", usage, notSentToProvider: true } as ProviderInvocationResult]);
      await withUsage.service.execute(EN.request);
      expect(withUsage.rows[0]).toMatchObject({ attempts: { count: 1 }, usageBasis: "UPPER_BOUND" });
      const unmarked = harness([{ kind: "FAILED", reason: "PROVIDER_REJECTED" }]);
      await unmarked.service.execute(EN.request);
      expect(unmarked.rows[0]).toMatchObject({ attempts: { count: 1 }, usageBasis: "REPORTED" });
      const calls: ShellTaskRequest[] = [];
      const provider: AiShellProviderPort = { providerModel: { providerKey: "test", modelSnapshot: "test-model" }, invoke: async (input) => { calls.push(input); throw new Error("after send"); } };
      const threw = harness([], { provider });
      await threw.service.execute(EN.request);
      expect(threw.rows[0]).toMatchObject({ outcomeCode: "TRANSPORT_FAILED", attempts: { count: 1 }, usageBasis: "UPPER_BOUND" });
    });
  });

  describe("C6 coordinator addition: the remote switch known off on the client", () => {
    it("an activated, qualified request is audited REMOTE_AI_DISABLED (not REMOTE_USE_NOT_ACCEPTED): no disclosure asked, nothing sent", async () => {
      const decide = vi.fn(async () => "ACCEPTED" as const);
      const calls: ShellTaskRequest[] = [];
      const provider: AiShellProviderPort = { providerModel: { providerKey: "test", modelSnapshot: "test-model" }, remoteUse: { decide }, invoke: async (input) => (calls.push(input), completed(VALID)) };
      const run = harness([], { provider, remoteSwitchKnownOff: () => true });
      expect(await run.service.execute(EN.request)).toMatchObject({ source: "DETERMINISTIC", mode: "REMOTE_DISABLED", reason: "TASK_DISABLED" });
      expect(decide).not.toHaveBeenCalled();
      expect(calls).toHaveLength(0);
      expectOneValidRow(run.rows, "REMOTE_AI_DISABLED");
      expect(run.rows[0]).toMatchObject({ attempts: { count: 0 }, providerModel: null, usageBasis: "NONE" });
    });
    it("a throwing switch check counts as off; an unqualified class keeps REQUEST_CLASS_NOT_QUALIFIED; not activated keeps its reason", async () => {
      const throwing = harness([completed(VALID)], { remoteSwitchKnownOff: () => { throw new Error("unknown"); } });
      expect(await throwing.service.execute(EN.request)).toMatchObject({ mode: "REMOTE_DISABLED" });
      expectOneValidRow(throwing.rows, "REMOTE_AI_DISABLED");
      const unqualified = harness([completed(VALID)], { remoteSwitchKnownOff: () => true, requestClassGate: pendingTestRequestClassGate() });
      await unqualified.service.execute(EN.request);
      expectOneValidRow(unqualified.rows, "REQUEST_CLASS_NOT_QUALIFIED");
      const notActivated = harness([completed(VALID)], { remoteSwitchKnownOff: () => true, manifest: DETERMINISTIC_ONLY_TEST_MANIFEST });
      await notActivated.service.execute(EN.request);
      expectOneValidRow(notActivated.rows, "TASK_DISABLED");
      // The shipped manifest and records (en-SG qualified) with the switch known off: REMOTE_AI_DISABLED, nothing sent.
      const shipped = harness([completed(VALID)], { remoteSwitchKnownOff: () => true, manifest: AI_ACTIVATION_MANIFEST, requestClassGate: undefined });
      expect(await shipped.service.execute(EN.request)).toMatchObject({ source: "DETERMINISTIC", mode: "REMOTE_DISABLED" });
      expect(shipped.calls).toHaveLength(0);
      expectOneValidRow(shipped.rows, "REMOTE_AI_DISABLED");
    });
    it("not known off (false or absent): the request proceeds as before", async () => {
      const run = harness([completed(VALID)], { remoteSwitchKnownOff: () => false });
      expect(await run.service.execute(EN.request)).toMatchObject({ source: "AI", mode: "REMOTE_AI" });
    });
  });
  it.each([
    ["NOT_ACTIVATED (a task that is not activated)", { manifest: DETERMINISTIC_ONLY_TEST_MANIFEST }, "NOT_ACTIVATED", "TASK_DISABLED"],
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
  /**
   * Packet 11C Addendum C, Task C2 (hybrid spec D11, Section 9.2 mode resolver: PRIVATE / OFFLINE / NOT_ACTIVATED / NO_PROVIDER): the
   * patient's "Keep wording on this device" setting is the first mode check (after the local planning step), before activation, so its
   * explicit request is audited as what it is under every manifest: mode PRIVATE, PRIVACY_REJECTED, no attempt, usage basis NONE, no
   * provider model, no source, no usage.
   * Nothing is planned for sending: no projection, class check, switch check or disclosure, and no provider call.
   */
  describe("Packet 11C Addendum C, C2: private mode (Keep wording on this device)", () => {
    const privateRow = (row: AiInvocationAuditRow) => {
      expect(row).toMatchObject({ auditSchemaVersion: "ai-invocation-audit.11c.2", outcomeCode: "PRIVACY_REJECTED", attempts: { count: 0, structuralRepairUsed: false, timedOut: false }, providerModel: null, sourceRevisions: [], usageBasis: "NONE" });
      expect(row.measurements).toMatchObject({ inputTokens: null, outputTokens: null, costMicroUsd: null });
    };
    it.each([
      // Packet 11C English activation: the shipped manifest and records now enable and qualify the en-SG requests; the setting still keeps
      // the wording on the device.
      ["the shipped manifest and records (both tasks enabled, en-SG classes QUALIFIED)", { manifest: AI_ACTIVATION_MANIFEST, requestClassGate: undefined }],
      ["the pre-activation manifest (deterministic-only)", { manifest: DETERMINISTIC_ONLY_TEST_MANIFEST, requestClassGate: undefined }],
      ["an activated manifest with a QUALIFIED class", {}],
    ])("under %s: mode PRIVATE, one exact PRIVACY_REJECTED row, nothing projected, gated, disclosed or sent", async (_label, overrides) => {
      for (const fixture of [EN, CARE]) {
        const decide = vi.fn(async () => "ACCEPTED" as const);
        const invoke = vi.fn();
        const admit = vi.fn<AiRequestClassGate["admit"]>(() => ({ admitted: true, classId: "test", reason: null }) as never);
        const switchKnownOff = vi.fn(() => false);
        const rows: AiInvocationAuditRow[] = [];
        const run = harness([], {
          requestClassGate: { admit, anyAdmissible: () => true },
          ...overrides,
          privateMode: () => true,
          remoteSwitchKnownOff: switchKnownOff,
          provider: { providerModel: { providerKey: "test", modelSnapshot: "test-model" }, remoteUse: { decide }, invoke },
          audit: { append: async (row: AiInvocationAuditRow) => void rows.push(row) },
        });
        projectorSpy.mockClear();
        const result = await run.service.execute(fixture.request);
        expect(result).toMatchObject({ kind: "COMPOSED", source: "DETERMINISTIC", mode: "PRIVATE", reason: "PRIVACY_REJECTED" });
        expect((result as any).composition).toEqual(composeDeterministic(fixture.request, fixture.plan, fixture.atoms, AI_HYBRID_RUNTIME_BUNDLES[fixture.plan.taskType]));
        expect(projectorSpy).not.toHaveBeenCalled();
        expect(admit).not.toHaveBeenCalled();
        expect(switchKnownOff).not.toHaveBeenCalled();
        expect(decide).not.toHaveBeenCalled();
        expect(invoke).not.toHaveBeenCalled();
        expectOneValidRow(rows, "PRIVACY_REJECTED", AI_HYBRID_RUNTIME_BUNDLES[fixture.plan.taskType].bundleKey);
        privateRow(rows[0]!);
      }
    });
    it("the setting is read per request (no rebuild): off sends, on keeps the wording on the device, off sends again", async () => {
      let keep = false;
      const run = harness([completed(VALID), completed(VALID)], { privateMode: () => keep });
      expect(await run.service.execute(EN.request)).toMatchObject({ source: "AI", mode: "REMOTE_AI" });
      keep = true;
      expect(await run.service.execute(EN.request)).toMatchObject({ source: "DETERMINISTIC", mode: "PRIVATE" });
      keep = false;
      expect(await run.service.execute(EN.request)).toMatchObject({ source: "AI", mode: "REMOTE_AI" });
      expect(run.calls).toHaveLength(2);
      expect(run.rows.map((row) => row.outcomeCode)).toEqual(["ACCEPTED", "PRIVACY_REJECTED", "ACCEPTED"]);
    });
    it("a check that throws keeps the wording on the device (fail closed)", async () => {
      const run = harness([completed(VALID)], { privateMode: () => { throw new Error("broken"); } });
      expect(await run.service.execute(EN.request)).toMatchObject({ source: "DETERMINISTIC", mode: "PRIVATE", reason: "PRIVACY_REJECTED" });
      expect(run.calls).toHaveLength(0);
      privateRow(run.rows[0]!);
      // Fix round 1 (I-1): an asynchronous value is awaited; a rejection also keeps the wording on the device.
      const rejecting = harness([completed(VALID)], { privateMode: async () => { throw new Error("unreadable"); } });
      expect(await rejecting.service.execute(EN.request)).toMatchObject({ source: "DETERMINISTIC", mode: "PRIVATE", reason: "PRIVACY_REJECTED" });
      expect(rejecting.calls).toHaveLength(0);
      const stored = harness([completed(VALID)], { privateMode: async () => true });
      expect(await stored.service.execute(EN.request)).toMatchObject({ mode: "PRIVATE" });
      expect(stored.calls).toHaveLength(0);
    });
    it("coordinator ruling: switching it on while a request is in flight does not cancel or alter that request; the next request is private", async () => {
      let keep = false;
      let release!: (result: ProviderInvocationResult) => void;
      const pending = new Promise<ProviderInvocationResult>((resolve) => (release = resolve));
      const run = harness([pending, completed(VALID)], { privateMode: () => keep });
      const inFlight = run.service.execute(EN.request);
      await vi.waitFor(() => expect(run.calls).toHaveLength(1));
      keep = true;
      release(completed(VALID));
      expect(await inFlight).toMatchObject({ source: "AI", mode: "REMOTE_AI" });
      expect(await run.service.execute(EN.request)).toMatchObject({ source: "DETERMINISTIC", mode: "PRIVATE" });
      expect(run.calls).toHaveLength(1);
      expect(run.rows.map((row) => row.outcomeCode)).toEqual(["ACCEPTED", "PRIVACY_REJECTED"]);
    });
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
    expectOneValidRow(run.rows, reason, "ai.draft-care-preparation-summary@11b.20");
    expect(run.rows[0]!.attempts).toEqual({ count: 0, structuralRepairUsed: false, timedOut: false });
  });
  it.each([
    ["NOT_ACTIVATED", { manifest: DETERMINISTIC_ONLY_TEST_MANIFEST }, "TASK_DISABLED"],
    ["PRIVATE", { privateMode: () => true }, "PRIVACY_REJECTED"],
    ["OFFLINE", { online: () => false }, "TRANSPORT_FAILED"],
    ["NO_PROVIDER", { provider: undefined }, "MISSING_CONFIGURATION"],
  ])("eligibility is checked after the %s check", async (mode, overrides, reason) => {
    const run = harness([completed(VALID)], overrides);
    expect(await run.service.execute(ineligibleRequest(INELIGIBLE_CASES[1][1]))).toMatchObject({ kind: "COMPOSED", source: "DETERMINISTIC", mode, reason });
    expect(run.calls).toHaveLength(0);
    expectOneValidRow(run.rows, reason, "ai.draft-care-preparation-summary@11b.20");
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
    const run = harness([{ kind: "FAILED", reason: "SOMETHING_ELSE", usage: { inputTokens: 100_000, outputTokens: 7, costMicroUsd: 1e9 } } as unknown as ProviderInvocationResult]);
    expect(await run.service.execute(EN.request)).toMatchObject({ source: "DETERMINISTIC", reason: "PROVIDER_FAILED" });
    expectOneValidRow(run.rows, "PROVIDER_FAILED");
    expect(run.rows[0]!.measurements).toMatchObject({ inputTokens: 100_000, outputTokens: 7, costMicroUsd: null });
  });

  it.each([
    ["a negative count", { inputTokens: 10, outputTokens: -1, costMicroUsd: 3 }],
    ["an implausible count", { inputTokens: 1e9, outputTokens: 7, costMicroUsd: 3 }],
    ["a missing count", { inputTokens: null, outputTokens: 7, costMicroUsd: 3 }],
  ])("Packet 11C Addendum C (C5): an unreadable usage (%s) is not treated as zero: the call counts at its upper bound", async (_label, usage) => {
    const run = harness([{ kind: "FAILED", reason: "PROVIDER_FAILED", usage } as unknown as ProviderInvocationResult]);
    await run.service.execute(EN.request);
    const bound = shellRouteCallUpperBound(projectShellTaskRequest(EN.plan));
    expect(run.rows[0]).toMatchObject({ measurements: { inputTokens: bound.inputTokens, outputTokens: bound.outputTokens, costMicroUsd: bound.costMicroUsd }, usageBasis: "UPPER_BOUND" });
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
    // Packet 11C Addendum C (C3, carried from the C5 review): the closed reason stays MISSING_CONFIGURATION (matrix codes unchanged); the
    // audit row records the truthful audit-only REMOTE_USE_NOT_ACCEPTED (no acceptance existed for this request; nothing was sent).
    expect(result).toMatchObject({ kind: "COMPOSED", source: "DETERMINISTIC", mode: "REMOTE_NOT_ACCEPTED", reason: "MISSING_CONFIGURATION" });
    expect(run.calls).toHaveLength(0);
    expectOneValidRow(run.rows, "REMOTE_USE_NOT_ACCEPTED");
    expect(run.rows[0]).toMatchObject({ ...NOTHING_SENT, usageBasis: "NONE" });
    // The same atoms as the AI path: a not-accepted request is the ordinary deterministic composition.
    const ai = await harness([completed(VALID)]).service.execute(EN.request);
    expect(atomMultiset((result as any).composition)).toEqual(atomMultiset((ai as any).composition));
  });

  it("Packet 11C B4a: DECLINED (the patient's explicit Cancel) is the same deterministic outcome; C5: audited as REMOTE_USE_DECLINED with nothing sent", async () => {
    const run = gated([completed(VALID)], async () => "DECLINED");
    const result = await run.service.execute(EN.request);
    // The closed fallback reason stays REQUEST_CANCELLED (matrix reason codes are unchanged); the audit row records the truthful,
    // audit-only outcome (Packet 11C Addendum C, C5; it was REQUEST_CANCELLED under the B4a interim ruling).
    expect(result).toMatchObject({ kind: "COMPOSED", source: "DETERMINISTIC", mode: "REMOTE_NOT_ACCEPTED", reason: "REQUEST_CANCELLED" });
    expect(run.calls).toHaveLength(0);
    expectOneValidRow(run.rows, "REMOTE_USE_DECLINED");
    expect(run.rows[0]).toMatchObject({ ...NOTHING_SENT, usageBasis: "NONE" });
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

  it("Packet 11C Addendum C (C3): every attempt of the request (the repair too) carries the request's own decision token, never a new one", async () => {
    const tokens: Array<AbortSignal | undefined> = [];
    const results = [completed(`${JSON.stringify(VALID)}}`), completed(VALID)];
    const provider: AiShellProviderPort = {
      providerModel: { providerKey: "test", modelSnapshot: "test-model" },
      remoteUse: { decide: async () => "ACCEPTED" },
      invoke: async (_input, _signal, decisionToken) => {
        tokens.push(decisionToken);
        return results.shift()!;
      },
    };
    const controller = new AbortController();
    expect(await harness([], { provider }).service.execute(EN.request, controller.signal)).toMatchObject({ source: "AI" });
    expect(tokens).toEqual([controller.signal, controller.signal]);
    // Without a caller signal the decision and every attempt share one service-made token (which nothing can accept).
    const unsignalled: Array<AbortSignal | undefined> = [];
    const decided: AbortSignal[] = [];
    const again = [completed(VALID)];
    const second: AiShellProviderPort = { ...provider, remoteUse: { decide: async (token) => (decided.push(token), "ACCEPTED") }, invoke: async (_input, _signal, token) => (unsignalled.push(token), again.shift()!) };
    await harness([], { provider: second }).service.execute(EN.request);
    expect(unsignalled).toEqual([decided[0]]);
    // A provider without a disclosure (the server-side adapters) receives no token.
    const plain: Array<number> = [];
    await harness([], { provider: { providerModel: provider.providerModel, invoke: async (...args: unknown[]) => (plain.push(args.length), completed(VALID)) } }).service.execute(EN.request);
    expect(plain).toEqual([2]);
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
    ["NOT_ACTIVATED", { manifest: DETERMINISTIC_ONLY_TEST_MANIFEST }, EN.request, "TASK_DISABLED"],
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

/**
 * Packet 11C Addendum C, Task C5 (owner decision): preserve reported usage on failed attempts; where an attempted call might have been
 * billed but its usage is missing, count the call's pre-send upper bound (never zero) and mark the row's usage basis UPPER_BOUND.
 */
describe("conservative usage accounting (Packet 11C Addendum C, C5)", () => {
  const BOUND = shellRouteCallUpperBound(projectShellTaskRequest(EN.plan));
  const REPORTED = { inputTokens: 10, outputTokens: 5, costMicroUsd: 1 };
  const measured = (row: AiInvocationAuditRow) => ({ inputTokens: row.measurements.inputTokens, outputTokens: row.measurements.outputTokens, costMicroUsd: row.measurements.costMicroUsd, usageBasis: (row as { usageBasis?: string }).usageBasis });

  it("the audit-only outcome codes are never provider failure reasons or route reasons", () => {
    for (const code of AI_AUDIT_ONLY_OUTCOME_CODES) {
      expect((PROVIDER_FAILURE_REASONS as readonly string[]).includes(code), code).toBe(false);
      expect((AI_SHELL_ROUTE_POST_CALL_FAILURE_REASONS as readonly string[]).includes(code), code).toBe(false);
      expect(aiShellRouteResponseSchema.safeParse({ kind: "FAILED", reason: code }).success, code).toBe(false);
    }
  });

  it("reported usage only: basis REPORTED", async () => {
    const run = harness([completed(VALID)]);
    await run.service.execute(EN.request);
    expect(measured(run.rows[0]!)).toEqual({ ...REPORTED, usageBasis: "REPORTED" });
  });

  it("nothing sent: basis NONE, no usage", async () => {
    const run = harness([], { manifest: DETERMINISTIC_ONLY_TEST_MANIFEST });
    await run.service.execute(EN.request);
    expect(measured(run.rows[0]!)).toEqual({ inputTokens: null, outputTokens: null, costMicroUsd: null, usageBasis: "NONE" });
  });

  it("a call cut off at the per-call timeout is counted at its pre-send upper bound", async () => {
    vi.useFakeTimers();
    const run = harness([new Promise<ProviderInvocationResult>(() => undefined)]);
    const pending = run.service.execute(EN.request);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toMatchObject({ reason: "PROVIDER_TIMEOUT" });
    expectOneValidRow(run.rows, "PROVIDER_TIMEOUT");
    expect(measured(run.rows[0]!)).toEqual({ inputTokens: BOUND.inputTokens, outputTokens: BOUND.outputTokens, costMicroUsd: BOUND.costMicroUsd, usageBasis: "UPPER_BOUND" });
  });

  it("a call cancelled while in flight is counted at its pre-send upper bound", async () => {
    const during = new AbortController();
    const run = harness([new Promise<ProviderInvocationResult>(() => undefined)]);
    const pending = run.service.execute(EN.request, during.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    during.abort();
    expect(await pending).toMatchObject({ reason: "REQUEST_CANCELLED" });
    expectOneValidRow(run.rows, "REQUEST_CANCELLED");
    expect(measured(run.rows[0]!)).toMatchObject({ costMicroUsd: BOUND.costMicroUsd, usageBasis: "UPPER_BOUND" });
  });

  it("a provider that throws (possibly after sending) is TRANSPORT_FAILED at the pre-send upper bound", async () => {
    const run = harness([], { provider: { providerModel: { providerKey: "test", modelSnapshot: "test-model" }, invoke: async () => Promise.reject(new Error("boom")) } satisfies AiShellProviderPort });
    expect(await run.service.execute(EN.request)).toMatchObject({ reason: "TRANSPORT_FAILED" });
    expect(measured(run.rows[0]!)).toMatchObject({ costMicroUsd: BOUND.costMicroUsd, usageBasis: "UPPER_BOUND" });
  });

  it("a completed call whose usage is missing or unreadable is counted at its pre-send upper bound", async () => {
    const run = harness([{ kind: "COMPLETED", candidate: VALID, usage: { inputTokens: null, outputTokens: 5, costMicroUsd: null }, retention: "CONFIRMED_NOT_STORED" }]);
    expect(await run.service.execute(EN.request)).toMatchObject({ source: "AI" });
    expect(measured(run.rows[0]!)).toEqual({ inputTokens: BOUND.inputTokens, outputTokens: BOUND.outputTokens, costMicroUsd: BOUND.costMicroUsd, usageBasis: "UPPER_BOUND" });
  });

  it("a FAILED with an upper-bound usage (from the route or the adapter) is counted as given, basis UPPER_BOUND", async () => {
    const given = { inputTokens: 3000, outputTokens: 512, costMicroUsd: 1515, basis: "UPPER_BOUND" as const };
    const run = harness([{ kind: "FAILED", reason: "PROVIDER_TIMEOUT", usage: given }]);
    await run.service.execute(EN.request);
    expect(measured(run.rows[0]!)).toEqual({ inputTokens: 3000, outputTokens: 512, costMicroUsd: 1515, usageBasis: "UPPER_BOUND" });
  });

  it("a FAILED with reported usage keeps it (basis REPORTED); a FAILED without usage was not sent (no usage)", async () => {
    const reported = harness([{ kind: "FAILED", reason: "PROVIDER_FAILED", usage: { ...REPORTED, basis: "REPORTED" } }]);
    await reported.service.execute(EN.request);
    expect(measured(reported.rows[0]!)).toEqual({ ...REPORTED, usageBasis: "REPORTED" });
    const unsent = harness([{ kind: "FAILED", reason: "MISSING_CONFIGURATION" }]);
    await unsent.service.execute(EN.request);
    expect(measured(unsent.rows[0]!)).toEqual({ inputTokens: null, outputTokens: null, costMicroUsd: null, usageBasis: "REPORTED" });
  });

  it("a reported first attempt plus an unreadable repair attempt: the sum, basis UPPER_BOUND", async () => {
    vi.useFakeTimers();
    const run = harness([completed(`${JSON.stringify(VALID)}}`), new Promise<ProviderInvocationResult>(() => undefined)]);
    const pending = run.service.execute(EN.request);
    await vi.advanceTimersByTimeAsync(18_000);
    await pending;
    expect(run.rows[0]!.attempts).toMatchObject({ count: 2, structuralRepairUsed: true, timedOut: true });
    expect(measured(run.rows[0]!)).toEqual({ inputTokens: 10 + BOUND.inputTokens, outputTokens: 5 + BOUND.outputTokens, costMicroUsd: 1 + BOUND.costMicroUsd, usageBasis: "UPPER_BOUND" });
  });
});

/**
 * Packet 11C Addendum C, Task C5: one audit row per explicit request, also when nothing reaches the service's execute (the use cases and
 * the browser wiring call `recordUnsent` for a request that was not eligible, became moot, was cancelled or could not read its source).
 */
describe("recordUnsent: the zero-attempt row of an explicit request (Packet 11C Addendum C, C5)", () => {
  const unsent = (outcome: string, overrides: Record<string, unknown> = {}) => ({ requestId: "5b4c3d2e-1f0a-4b9c-8d7e-6f5a4b3c2d1e", taskType: "EXPLAIN_PATTERN" as const, locale: "en-SG" as const, requestedAt: "2026-10-06T00:59:59.000Z" as never, outcome: outcome as never, ...overrides });

  it.each(["DISCLOSURE_CLOSED_MOOT", "NOT_ELIGIBLE", "SOURCE_UNAVAILABLE", "SOURCE_CHANGED", "REQUEST_CANCELLED", "PAYLOAD_INVALID"])("%s: one valid current row, nothing sent", async (outcome) => {
    const run = harness([completed(VALID)]);
    expect(await run.service.recordUnsent(unsent(outcome))).toBe(true);
    expectOneValidRow(run.rows, outcome);
    expect(run.rows[0]).toMatchObject({ requestId: "5b4c3d2e-1f0a-4b9c-8d7e-6f5a4b3c2d1e", taskType: "EXPLAIN_PATTERN", locale: "en-SG", requestedAt: "2026-10-06T00:59:59.000Z", completedAt: "2026-10-06T01:00:00.000Z", providerModel: null, attempts: { count: 0, structuralRepairUsed: false, timedOut: false }, sourceRevisions: [], downstream: null, usageBasis: "NONE", activationManifestVersion: ENABLED.manifestVersion });
    expect(run.calls).toHaveLength(0);
  });

  it("uses the hybrid bundle of the request's own task and locale", async () => {
    const run = harness([]);
    await run.service.recordUnsent(unsent("NOT_ELIGIBLE", { taskType: "DRAFT_CARE_PREPARATION_SUMMARY", locale: "zh-SG" }));
    expectOneValidRow(run.rows, "NOT_ELIGIBLE", "ai.draft-care-preparation-summary@11b.20");
    expect(run.rows[0]!.components.localePack.id).toBe("ai-locale.draft-care-preparation-summary.zh-sg");
  });

  it.each([
    ["ACCEPTED", unsent("ACCEPTED")],
    ["a provider failure", unsent("PROVIDER_FAILED")],
    ["a server refusal (needs a transmission)", unsent("SPEND_CEILING_REACHED")],
    ["the declined disclosure (decided inside execute)", unsent("REMOTE_USE_DECLINED")],
    ["a non-hybrid task", unsent("NOT_ELIGIBLE", { taskType: "DRAFT_NEUTRAL_INQUIRY" })],
    ["a malformed request id", unsent("NOT_ELIGIBLE", { requestId: "request-1" })],
    ["an unknown locale", unsent("NOT_ELIGIBLE", { locale: "fr-FR" })],
  ])("refuses %s and writes nothing", async (_label, input) => {
    const run = harness([]);
    expect(await run.service.recordUnsent(input as never)).toBe(false);
    expect(run.rows).toHaveLength(0);
  });

  it("an audit store failure is reported as false, never thrown", async () => {
    const run = harness([], { audit: { append: async () => Promise.reject(new Error("storage")) } });
    expect(await run.service.recordUnsent(unsent("NOT_ELIGIBLE"))).toBe(false);
  });
});
