import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Dexie from "dexie";
import fakeIndexedDB, { IDBKeyRange as FDBKeyRange } from "fake-indexeddb";
import type { Instant } from "@/domain/shared/time";
import { slotToken, type AiLocale, type AiTaskRequest, type ShellFieldPath } from "@/domain/ai";
import { shellCandidate } from "@/ai/evaluation/packet-11-hybrid-test-support";
import {
  EXPLAINABLE_INELIGIBLE_REASONS,
  type ExplainablePatternResult,
  type ExplainablePatternView,
  type RecordedHistoryQueryPort,
} from "@/application/history/recorded-history-contracts";
import { databases, dayBefore, FACT, higherFixture, local, NOW, reading, RECENT, REFERENCE, setup, TODAY } from "@/application/history/history-test-support";
import { AI_ACTIVATION_MANIFEST, type AiActivationManifest } from "./ai-activation-manifest";
import { resolveAiHybridBundle } from "./ai-hybrid-runtime-bundles";
import { createAiHybridTaskService, type AiHybridExecutionResult } from "./ai-hybrid-task-service";
import { renderExplainLimitations } from "./ai-meaning-registry";
import type { AiShellProviderPort, ProviderInvocationResult } from "./ai-provider-port";
import { createPatternExplainer, type PatternExplanation } from "./explain-pattern";
import { renderAtom, renderSummaryRoleNotice } from "./language/atom-renderer";
import { OBSERVATION_PATH } from "./language/observation-composer";
import { planSlots } from "./language/slot-planner";

/**
 * Packet 11C Task 6: the pattern-explanation use case. Every view comes from the real journal -> coordinator ->
 * evaluator -> Recorded-history query; the only fake is `execute` (resolved on demand) and, for the AI case, the
 * provider behind a test-only activated manifest. The shipped manifest stays NOT_ACTIVATED.
 */

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
  for (const database of databases) database.close();
  for (const database of databases.splice(0)) await Dexie.delete(database.name);
});

type Execute = (request: AiTaskRequest, signal?: AbortSignal) => Promise<AiHybridExecutionResult>;

const ENABLED: AiActivationManifest = { ...AI_ACTIVATION_MANIFEST, tasks: { ...AI_ACTIVATION_MANIFEST.tasks, EXPLAIN_PATTERN: "SYNTHETIC_REMOTE_ENABLED" } };

/** The real hybrid service; `invoke` is the provider spy (never reached while NOT_ACTIVATED). */
function hybrid(manifest: AiActivationManifest, invoke: AiShellProviderPort["invoke"]) {
  const provider: AiShellProviderPort = { providerModel: { providerKey: "test", modelSnapshot: "test-model" }, invoke };
  return createAiHybridTaskService({ releaseProfile: "HACKATHON_DEMO", audit: { append: async () => undefined }, now: () => NOW, monotonicMs: () => 0, manifest, provider });
}

/** A fake `execute` that records each call and resolves only when released (then delegates to `inner`). */
function onDemand(inner: Execute) {
  const calls: Array<{ request: AiTaskRequest; signal?: AbortSignal }> = [];
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  let entered!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  const execute: Execute = async (request, signal) => {
    calls.push({ request, signal });
    entered();
    await gate;
    return inner(request, signal);
  };
  return { execute, calls, started, release: () => open() };
}

const counter = () => {
  let n = 0;
  return () => `6f1c2b9e-3d4a-4b5c-8d6e-${(n++).toString(16).padStart(12, "0")}`;
};

function explainer(history: RecordedHistoryQueryPort, execute: Execute) {
  return createPatternExplainer({ history, execute, now: () => NOW as Instant, requestId: counter() });
}

async function viewOf(history: RecordedHistoryQueryPort): Promise<ExplainablePatternView> {
  const result = await history.loadExplainablePattern({ factId: FACT });
  if (result.kind !== "EXPLAINABLE") throw new Error(`not explainable: ${JSON.stringify(result)}`);
  return result.view;
}

/** The PERIOD_SUMMARY atom text for a real view (the same source the slot planner binds). */
function periodAtom(view: ExplainablePatternView, locale: AiLocale): string {
  return renderAtom(
    {
      kind: "PERIOD_SUMMARY",
      slot: view.slot,
      summaryKind: view.periods[0].summary.kind,
      periods: view.periods.map((period) => ({ role: period.role, startDate: period.window.startDate, endDate: period.window.endDate, count: period.count, value: period.summary.valueMmolL })),
    } as never,
    locale,
  );
}

const explained = (result: PatternExplanation) => {
  if (result.kind !== "EXPLAINED") throw new Error(`not explained: ${JSON.stringify(result)}`);
  return result;
};

describe("createPatternExplainer (Packet 11C Task 6)", () => {
  it.each([["en-SG"], ["zh-SG"]] as const)("(a) %s NOT_ACTIVATED: a DETERMINISTIC explanation whose observation holds the period atom; no provider call", async (locale) => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { history } = await higherFixture();
    const invoke = vi.fn<AiShellProviderPort["invoke"]>();
    const run = onDemand(hybrid(AI_ACTIVATION_MANIFEST, invoke).execute);
    const pending = explainer(history, run.execute).explain({ factId: FACT, locale });
    await run.started;
    run.release();
    const result = explained(await pending);

    const view = await viewOf(history);
    expect(result.source).toBe("DETERMINISTIC");
    expect(result.view).toEqual(view);
    expect(result.composition).toMatchObject({ taskType: "EXPLAIN_PATTERN", locale });
    expect(result.composition.fields.get(OBSERVATION_PATH)?.text).toContain(periodAtom(view, locale));
    expect(result.limitations).toEqual(renderExplainLimitations([{ ref: "limitation-1", code: "DOES_NOT_ESTABLISH_CAUSE" }], locale).limitations);
    expect(result.limitations.length).toBeGreaterThan(0);
    expect(result.summaryRoleNotice).toBe(renderSummaryRoleNotice(locale));
    expect(invoke).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    // Exactly one execute call, with the source-backed request for this view and locale.
    expect(run.calls).toHaveLength(1);
    const request = run.calls[0]!.request;
    expect(request).toMatchObject({ taskType: "EXPLAIN_PATTERN", locale, requestedAt: NOW });
    expect(request.taskType === "EXPLAIN_PATTERN" && request.taskPayload.periodSummary?.slot).toBe(view.slot);
  });

  it("(b) a fake AI result: an AI explanation with the model's headline and evidence frames around the same atoms", async () => {
    const { history } = await higherFixture();
    const invoke = vi.fn<AiShellProviderPort["invoke"]>();
    const service = hybrid(ENABLED, invoke);
    // The provider answers with valid shells for the plan of the request it was given (value-blind tokens only).
    const withShells: Execute = async (request, signal) => {
      const planned = planSlots(request, resolveAiHybridBundle("EXPLAIN_PATTERN", request.locale));
      if (planned.kind !== "PLANNED") throw new Error("UNPLANNABLE");
      const plan = planned.plan;
      expect(plan.remote.eligible).toBe(true);
      const home = (path: ShellFieldPath) => plan.slots.find((slot) => slot.homeField === path)!.slotId;
      const candidate = shellCandidate(plan, new Map<ShellFieldPath, string>([["headline", `A look at ${slotToken(home("headline"))}.`], ["evidence", `This is based on ${slotToken(home("evidence"))}.`]]));
      invoke.mockResolvedValueOnce({ kind: "COMPLETED", candidate, usage: { inputTokens: 10, outputTokens: 5, costMicroUsd: 1 }, responseModel: "test-model", retention: "CONFIRMED_NOT_STORED" } satisfies ProviderInvocationResult);
      return service.execute(request, signal);
    };
    const run = onDemand(withShells);
    const pending = explainer(history, run.execute).explain({ factId: FACT, locale: "en-SG" });
    await run.started;
    run.release();
    const result = explained(await pending);

    const view = await viewOf(history);
    expect(result.source).toBe("AI");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(result.composition.fields.get("headline")?.text).toMatch(/^A look at .+\.$/);
    expect(result.composition.fields.get("evidence")?.text).toMatch(/^This is based on .+\.$/);
    expect(result.composition.fields.get(OBSERVATION_PATH)?.text).toContain(periodAtom(view, "en-SG"));
    expect(result.view).toEqual(view);
    expect(result.summaryRoleNotice).toBe(renderSummaryRoleNotice("en-SG"));
    expect(result.limitations).toEqual(renderExplainLimitations([{ ref: "limitation-1", code: "DOES_NOT_ESTABLISH_CAUSE" }], "en-SG").limitations);
  });

  it("(c) a correction and processPending() while execute is pending: STALE_RESULT, and no composition is returned", async () => {
    const { journal, coordinator, history, recorded } = await higherFixture();
    const before = await viewOf(history);
    const run = onDemand(hybrid(AI_ACTIVATION_MANIFEST, vi.fn()).execute);
    const pending = explainer(history, run.execute).explain({ factId: FACT, locale: "en-SG" });
    await run.started;

    const target = recorded.at(-1)!;
    const corrected = await journal.correctGlucoseTime({
      recordId: target.recordId,
      expectedRevisionId: target.revisionId,
      expectedRevisionNumber: 1,
      payload: {
        measurement: { enteredValue: "7.8" as never, enteredUnit: "MMOL_L", normalization: null },
        measurementMethod: "FINGERSTICK_METER",
        context: { kind: "PATIENT_SELECTED_SLOT", slot: "BEFORE_BREAKFAST" },
      },
      temporal: local(dayBefore(TODAY, 12), "07:30"),
      recordedAt: "2026-10-04T01:00:00.000Z" as Instant,
    });
    expect(corrected.kind).toBe("COMMITTED");
    await coordinator.processPending();
    // The source changed underneath the pending request: the re-evaluated view is explainable again, with new refs.
    const after = await viewOf(history);
    expect(after.periods[1].readings.map((r) => r.ref)).not.toEqual(before.periods[1].readings.map((r) => r.ref));

    run.release();
    const result = await pending;
    expect(result).toEqual({ kind: "UNAVAILABLE", reason: "STALE_RESULT" });
    expect(result).not.toHaveProperty("composition");
    expect(run.calls).toHaveLength(1);
  });

  it("(c) the re-load is compared ref by ref: an observation, snapshot or any single reading ref that differs is STALE_RESULT", async () => {
    const { history } = await higherFixture();
    const view = await viewOf(history);
    const moved = (mutate: (copy: ExplainablePatternView) => void) => {
      const copy = structuredClone(view);
      mutate(copy);
      return copy;
    };
    const newId = () => crypto.randomUUID() as never;
    const variants: Array<[string, ExplainablePatternResult]> = [
      ["observation revision", { kind: "EXPLAINABLE", view: moved((v) => (v.observationRef.revisionId = newId())) }],
      ["observation record", { kind: "EXPLAINABLE", view: moved((v) => (v.observationRef.recordId = newId())) }],
      ["snapshot revision", { kind: "EXPLAINABLE", view: moved((v) => (v.snapshotRef.revisionId = newId())) }],
      ["earlier first reading revision", { kind: "EXPLAINABLE", view: moved((v) => (v.periods[0].readings[0]!.ref.revisionId = newId())) }],
      ["recent last reading revision", { kind: "EXPLAINABLE", view: moved((v) => (v.periods[1].readings.at(-1)!.ref.revisionId = newId())) }],
      ["recent last reading record", { kind: "EXPLAINABLE", view: moved((v) => (v.periods[1].readings.at(-1)!.ref.recordId = newId())) }],
      ["a reading moved between periods", { kind: "EXPLAINABLE", view: moved((v) => v.periods[1].readings.unshift(v.periods[0].readings.pop()!)) }],
      ["a reading dropped", { kind: "EXPLAINABLE", view: moved((v) => void v.periods[1].readings.pop()) }],
      ["now ineligible", { kind: "INELIGIBLE", reason: "STALE_SOURCE" }],
    ];
    for (const [label, reloaded] of variants) {
      let loads = 0;
      const port: RecordedHistoryQueryPort = {
        load: history.load,
        loadExplainablePattern: async () => (++loads === 1 ? { kind: "EXPLAINABLE", view: structuredClone(view) } : reloaded),
      };
      const execute = vi.fn(hybrid(AI_ACTIVATION_MANIFEST, vi.fn()).execute);
      const result = await explainer(port, execute).explain({ factId: FACT, locale: "en-SG" });
      expect(result, label).toEqual({ kind: "UNAVAILABLE", reason: "STALE_RESULT" });
      expect(loads, label).toBe(2);
      expect(execute, label).toHaveBeenCalledTimes(1);
    }
  });

  it("(d) abort while execute is pending: CANCELLED, without waiting for execute, and the signal reaches execute", async () => {
    const { history } = await higherFixture();
    const run = onDemand(hybrid(AI_ACTIVATION_MANIFEST, vi.fn()).execute);
    const controller = new AbortController();
    const pending = explainer(history, run.execute).explain({ factId: FACT, locale: "en-SG" }, controller.signal);
    await run.started;
    controller.abort();
    expect(await pending).toEqual({ kind: "UNAVAILABLE", reason: "CANCELLED" });
    expect(run.calls[0]!.signal?.aborted).toBe(true);
    run.release();
  });

  it("(d) abort after execute resolves but before the result is kept: CANCELLED", async () => {
    const { history } = await higherFixture();
    const controller = new AbortController();
    const inner = hybrid(AI_ACTIVATION_MANIFEST, vi.fn()).execute;
    const execute: Execute = async (request, signal) => {
      const result = await inner(request, signal);
      controller.abort();
      return result;
    };
    expect(await explainer(history, execute).explain({ factId: FACT, locale: "en-SG" }, controller.signal)).toEqual({ kind: "UNAVAILABLE", reason: "CANCELLED" });
  });

  it("(d) an already-aborted signal: CANCELLED, and execute is never called", async () => {
    const { history } = await higherFixture();
    const execute = vi.fn<Execute>();
    const controller = new AbortController();
    controller.abort();
    expect(await explainer(history, execute).explain({ factId: FACT, locale: "en-SG" }, controller.signal)).toEqual({ kind: "UNAVAILABLE", reason: "CANCELLED" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("(e) real ineligible factIds return their reason, and execute is never called", async () => {
    const { journal, coordinator, history } = await setup();
    // Before dinner: no material difference (read-only); before breakfast: too few readings to be SUPPORTED.
    const days = [16, 18, 20, 23, 25, 27, 30, 33, 1, 3, 5, 8, 10, 12];
    for (const [i, d] of days.entries()) await reading(journal, dayBefore(TODAY, d), "18:30", i % 2 === 0 ? "7.0" : "7.2", "BEFORE_DINNER");
    for (const [d, v] of [...REFERENCE.slice(0, 4), ...RECENT.slice(0, 3)]) await reading(journal, dayBefore(TODAY, d), "07:30", v);
    await coordinator.processPending();
    const execute = vi.fn<Execute>();
    const explain = explainer(history, execute);
    for (const [factId, reason] of [
      ["NO_MATERIAL:BEFORE_DINNER", "NO_MATERIAL"],
      ["COMPARISON:BEFORE_DINNER", "NOT_FOUND"],
      ["COMPARISON:BEDTIME", "NOT_FOUND"],
      ["not a fact", "NOT_FOUND"],
      [FACT, "NOT_SUPPORTED"],
    ] as const) {
      expect(await explain.explain({ factId, locale: "en-SG" }), factId).toEqual({ kind: "UNAVAILABLE", reason });
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(EXPLAINABLE_INELIGIBLE_REASONS.map((reason) => [reason]))("(e) every view refusal passes through unchanged (%s), and execute is never called", async (reason) => {
    const execute = vi.fn<Execute>();
    const port: RecordedHistoryQueryPort = { load: vi.fn(), loadExplainablePattern: async () => ({ kind: "INELIGIBLE", reason }) };
    expect(await explainer(port, execute).explain({ factId: FACT, locale: "zh-SG" })).toEqual({ kind: "UNAVAILABLE", reason });
    expect(execute).not.toHaveBeenCalled();
  });

  it("fails closed with UNAVAILABLE when execute rejects the request, falls back, throws, or answers for another request", async () => {
    const { history } = await higherFixture();
    const real = hybrid(AI_ACTIVATION_MANIFEST, vi.fn()).execute;
    const cases: Array<[string, Execute]> = [
      ["REQUEST_REJECTED", async () => ({ kind: "REQUEST_REJECTED" })],
      ["FALLBACK", async (request) => ({ kind: "FALLBACK", fallback: { kind: "DETERMINISTIC_FALLBACK" } as never, auditRef: request.requestId })],
      ["throws", async () => Promise.reject(new Error("boom"))],
      ["another request's result", async (request, signal) => ({ ...(await real(request, signal)), auditRef: "someone-else" }) as AiHybridExecutionResult],
      ["another locale's composition", async (request, signal) => real({ ...request, locale: "zh-SG" } as AiTaskRequest, signal)],
      ["incomplete limitation copy", async (request, signal) => ({ ...(await real(request, signal)), limitationCopyComplete: false }) as AiHybridExecutionResult],
      ["no limitations", async (request, signal) => ({ ...(await real(request, signal)), limitations: undefined }) as AiHybridExecutionResult],
    ];
    for (const [label, execute] of cases) {
      expect(await explainer(history, execute).explain({ factId: FACT, locale: "en-SG" }), label).toEqual({ kind: "UNAVAILABLE", reason: "UNAVAILABLE" });
    }
  });

  it("fails closed with UNAVAILABLE when the history port throws, and never calls execute", async () => {
    const execute = vi.fn<Execute>();
    const port: RecordedHistoryQueryPort = { load: vi.fn(), loadExplainablePattern: async () => Promise.reject(new Error("storage")) };
    expect(await explainer(port, execute).explain({ factId: FACT, locale: "en-SG" })).toEqual({ kind: "UNAVAILABLE", reason: "UNAVAILABLE" });
    expect(execute).not.toHaveBeenCalled();
  });
});
