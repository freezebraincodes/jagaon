import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import Dexie from "dexie";
import fakeIndexedDB, { IDBKeyRange as FDBKeyRange } from "fake-indexeddb";
import type { Instant } from "@/domain/shared/time";
import { aiTaskRequestSchema } from "@/domain/ai/ai-task-contracts";
import type { ExplainablePatternView } from "@/application/history/recorded-history-contracts";
import { databases, FACT, higherFixture, largePeriodFixture, NOW, variabilityFixture } from "@/application/history/history-test-support";
import { AI_HYBRID_RUNTIME_BUNDLES } from "./ai-hybrid-runtime-bundles";
import { projectProviderTaskPayload } from "./detached-payload-projector";
import { buildSourceBackedExplainRequest } from "./explain-pattern-request";

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
  for (const database of databases) database.close();
  for (const database of databases.splice(0)) await Dexie.delete(database.name);
});

const REQUEST_ID = "6f1c2b9e-3d4a-4b5c-8d6e-7f8091a2b3c4";
const BUNDLE = AI_HYBRID_RUNTIME_BUNDLES.EXPLAIN_PATTERN;

async function viewOf(history: { loadExplainablePattern(request: { factId: string }): Promise<unknown> }): Promise<ExplainablePatternView> {
  const result = (await history.loadExplainablePattern({ factId: FACT })) as { kind: string; view?: ExplainablePatternView };
  if (result.kind !== "EXPLAINABLE" || !result.view) throw new Error(`not explainable: ${JSON.stringify(result)}`);
  return result.view;
}

const build = (view: ExplainablePatternView, locale: "en-SG" | "zh-SG" = "en-SG") =>
  buildSourceBackedExplainRequest({ view, locale, requestId: REQUEST_ID, requestedAt: NOW as Instant });

/** The facts the request must carry, derived from the real view (never typed by hand). */
function expectedFacts(view: ExplainablePatternView) {
  const [earlier, recent] = view.periods;
  const snapshot = { recordType: view.snapshotRef.recordType, recordId: view.snapshotRef.recordId, revisionId: view.snapshotRef.revisionId };
  const observation = { recordType: view.observationRef.recordType, recordId: view.observationRef.recordId, revisionId: view.observationRef.revisionId };
  const period = (p: typeof earlier, base: number) => [
    { ref: `fact-${base}`, field: "EFFECTIVE_INTERVAL", value: { kind: "DATE_RANGE", startDate: p.window.startDate, endDate: p.window.endDate }, sources: [observation] },
    { ref: `fact-${base + 1}`, field: "EVIDENCE_COUNT", value: { kind: "COUNT", value: p.count }, sources: [snapshot] },
    { ref: `fact-${base + 2}`, field: "MEASUREMENT_VALUE", value: { kind: "DECIMAL", value: p.summary.valueMmolL, unit: "MMOL_L" }, sources: [snapshot] },
  ];
  return [...period(earlier, 1), ...period(recent, 4), { ref: "fact-7", field: "EVIDENCE_COUNT", value: { kind: "COUNT", value: view.totalCount }, sources: [snapshot] }];
}

describe("buildSourceBackedExplainRequest (Packet 11C Task 3)", () => {
  it("turns a real HIGHER view into a valid, ordered, source-backed EXPLAIN_PATTERN request", async () => {
    const { history } = await higherFixture();
    const view = await viewOf(history);
    expect(view.kind).toBe("HIGHER");
    const request = build(view);

    expect(aiTaskRequestSchema.safeParse(request).success).toBe(true);
    expect(request).toMatchObject({
      taskType: "EXPLAIN_PATTERN",
      locale: "en-SG",
      requestId: REQUEST_ID,
      requestedAt: NOW,
      releaseProfile: "HACKATHON_DEMO",
      runtimeBundleKey: AI_HYBRID_RUNTIME_BUNDLES.EXPLAIN_PATTERN.bundleKey,
    });
    expect(request.facts).toHaveLength(7);
    expect(request.facts).toEqual(expectedFacts(view));

    // Counts equal the view's counts and sit on the snapshot alone, never on per-reading refs.
    const countFacts = request.facts.filter((fact) => fact.field === "EVIDENCE_COUNT");
    expect(countFacts.map((fact) => fact.value)).toEqual([
      { kind: "COUNT", value: view.periods[0].count },
      { kind: "COUNT", value: view.periods[1].count },
      { kind: "COUNT", value: view.totalCount },
    ]);
    for (const fact of countFacts) expect(fact.sources).toEqual([{ recordType: "PATTERN_EVIDENCE_SNAPSHOT", recordId: view.snapshotRef.recordId, revisionId: view.snapshotRef.revisionId }]);
    expect(request.facts.filter((fact) => fact.field === "EFFECTIVE_INTERVAL").map((fact) => fact.sources)).toEqual([
      [{ recordType: "PATTERN_OBSERVATION", recordId: view.observationRef.recordId, revisionId: view.observationRef.revisionId }],
      [{ recordType: "PATTERN_OBSERVATION", recordId: view.observationRef.recordId, revisionId: view.observationRef.revisionId }],
    ]);

    if (request.taskType !== "EXPLAIN_PATTERN") throw new Error("wrong task");
    expect(request.taskPayload).toEqual({
      claim: { ref: "claim-1", family: "COMPARABLE_SLOT_TREND", factRefs: ["fact-1", "fact-2", "fact-3", "fact-4", "fact-5", "fact-6", "fact-7"] },
      limitations: [{ ref: "limitation-1", code: "DOES_NOT_ESTABLISH_CAUSE" }],
      periodSummary: {
        slot: view.slot,
        summaryKind: "MEDIAN",
        periods: [
          { role: "EARLIER", intervalRef: "fact-1", countRef: "fact-2", summaryRef: "fact-3" },
          { role: "RECENT", intervalRef: "fact-4", countRef: "fact-5", summaryRef: "fact-6" },
        ],
        totalCountRef: "fact-7",
      },
    });
  });

  it("binds the interquartile range for a real VARIABILITY view, in both periods, as a MMOL_L decimal", async () => {
    const { history } = await variabilityFixture();
    const view = await viewOf(history);
    expect(view.kind).toBe("VARIABILITY");
    const request = build(view);
    expect(aiTaskRequestSchema.safeParse(request).success).toBe(true);
    if (request.taskType !== "EXPLAIN_PATTERN") throw new Error("wrong task");
    expect(request.taskPayload.periodSummary?.summaryKind).toBe("IQR");
    expect(request.facts).toEqual(expectedFacts(view));
    expect(request.facts.filter((fact) => fact.field === "MEASUREMENT_VALUE").map((fact) => fact.value)).toEqual(
      view.periods.map((period) => ({ kind: "DECIMAL", value: period.summary.valueMmolL, unit: "MMOL_L" })),
    );
  });

  it("builds a request for a period of more than 32 readings, with exact counts and nothing truncated or thrown", async () => {
    const { history } = await largePeriodFixture();
    const view = await viewOf(history);
    expect(view.periods[0].readings.length).toBeGreaterThan(32);
    const before = structuredClone(view);
    const request = build(view);

    expect(aiTaskRequestSchema.safeParse(request).success).toBe(true);
    expect(request.facts).toHaveLength(7);
    expect(request.facts).toEqual(expectedFacts(view));
    expect(request.facts[1]).toMatchObject({ value: { kind: "COUNT", value: view.periods[0].count }, sources: [{ recordType: "PATTERN_EVIDENCE_SNAPSHOT" }] });
    expect(request.facts[1]!.sources).toHaveLength(1);
    expect(request.facts[6]!.value).toEqual({ kind: "COUNT", value: view.periods[0].count + view.periods[1].count });
    for (const fact of request.facts) expect(fact.sources.every((source) => source.recordType !== "GLUCOSE_READING")).toBe(true);
    // The view is untouched and still lists every reading.
    expect(view).toEqual(before);
    expect(view.periods.map((period) => period.readings.length)).toEqual(view.periods.map((period) => period.count));
  });

  it("builds the same structure for zh-SG; only the locale differs", async () => {
    const { history } = await higherFixture();
    const view = await viewOf(history);
    const en = build(view, "en-SG");
    const zh = build(view, "zh-SG");
    expect(zh.locale).toBe("zh-SG");
    expect({ ...zh, locale: "en-SG" }).toEqual(en);
  });

  it("is deterministic and does not mutate the view", async () => {
    const { history } = await higherFixture();
    const view = await viewOf(history);
    const before = structuredClone(view);
    expect(build(view)).toEqual(build(view));
    expect(view).toEqual(before);
  });

  it("projects to a provider payload with no individual reading, record id, source link or period binding", async () => {
    for (const fixture of [higherFixture, variabilityFixture, largePeriodFixture]) {
      const { history } = await fixture();
      const view = await viewOf(history);
      const request = build(view);
      const projected = projectProviderTaskPayload(request, BUNDLE);
      if (projected.kind !== "PROJECTED") throw new Error(`projection fell back: ${projected.reason}`);
      const json = JSON.stringify(projected.payload);

      expect(json).not.toContain("periodSummary");
      expect(json).not.toContain("sources");
      expect(json).not.toContain("recordType");
      expect(json).not.toContain("recordId");
      expect(json).not.toContain("revisionId");
      const ids = [view.observationRef, view.snapshotRef, ...view.periods.flatMap((period) => period.readings.map((r) => r.ref))];
      for (const id of ids) {
        expect(json).not.toContain(id.recordId);
        expect(json).not.toContain(id.revisionId);
      }
      // No supporting reading's own value (a reading equal to a summary value is that summary, not the reading).
      const summaryValues = new Set(view.periods.map((period) => period.summary.valueMmolL));
      for (const period of view.periods) {
        for (const supporting of period.readings) {
          if (!summaryValues.has(supporting.enteredValue)) expect(json).not.toContain(`"${supporting.enteredValue}"`);
        }
      }
      // No per-reading date: the only dates are the two periods' own interval endpoints.
      const intervalDates = new Set(view.periods.flatMap((period) => [period.window.startDate, period.window.endDate]));
      for (const supporting of view.periods.flatMap((period) => period.readings)) {
        if (!intervalDates.has(supporting.localDate)) expect(json).not.toContain(supporting.localDate);
      }
      // Exactly the request's own facts without provenance, no more.
      expect(projected.payload.facts).toEqual(request.facts.map(({ sources: _sources, ...fact }) => (void _sources, fact)));
      expect(Object.keys(projected.payload.taskPayload).sort()).toEqual(["claim"]);
    }
  });

  it("refuses a view whose summary kind disagrees with its kind, or whose periods are reversed (fail closed, never a request)", async () => {
    for (const fixture of [higherFixture, variabilityFixture]) {
      const { history } = await fixture();
      const view = await viewOf(history);
      expect(() => build(view)).not.toThrow();

      // MEDIAN <-> IQR swapped against the view kind (both periods, so the periods still agree with each other).
      const swapped = structuredClone(view);
      for (const period of swapped.periods) period.summary.kind = period.summary.kind === "MEDIAN" ? "IQR" : "MEDIAN";
      expect(() => build(swapped)).toThrow("SOURCE_BACKED_VIEW_INVALID");

      // Periods reversed: RECENT first, EARLIER second.
      const reversed = structuredClone(view);
      reversed.periods = [reversed.periods[1], reversed.periods[0]];
      expect(() => build(reversed)).toThrow("SOURCE_BACKED_VIEW_INVALID");
    }
  });
});
