// @vitest-environment node
import Dexie from "dexie";
import fakeIndexedDB, { IDBKeyRange as FDBKeyRange } from "fake-indexeddb";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AI_HYBRID_RUNTIME_BUNDLES } from "@/application/ai/ai-hybrid-runtime-bundles";
import { planSlots, remoteBudgetAccount } from "@/application/ai/language/slot-planner";
import { BOUNDARY_DATE, BOUNDARY_DAY_READINGS } from "@/application/history/history-test-support";
import { aiTaskRequestSchema } from "@/domain/ai";
import {
  CORRECTION,
  eligibilityBudget,
  insufficientEvidence,
  noMaterial,
  SOURCE_BACKED_SCENARIOS,
  sourceBackedFixture,
  type SourceBackedScenario,
} from "./packet-11-source-backed-fixtures";

/**
 * Packet 11C Task 5 real-evaluator fixtures (offline). Every scenario is produced through a fresh fake-indexeddb database, the real
 * JournalCommandService, createIntelligenceCoordinator(...).processPending() and history.loadExplainablePattern; nothing is typed by hand.
 * The tests only reconcile the fixture with itself (period counts = list lengths, total = their sum, summary kind = view kind, the
 * request parses and binds the view's own numbers) and then require the plan literal: PLANNED and remote-eligible.
 *
 * Owner blocker (Task 4) resolved by owner decision option (a) (Packet 11C phase 2, 2026-10-08, offline): under ai-slot-plan.11b.8 en-SG
 * source-backed plans were PLANNED but NOT remote-eligible (BUDGET_EXCEEDED: the LOCAL observation was counted at its fixed budget).
 * ai-slot-plan.11b.9 reserves the LOCAL observation at its final composed wording; REMOTE budgets, the ceiling, copy and every other gate
 * are unchanged. The eligibility tests below require the plan literal and show the planner's own account.
 */
const LOCALES = ["en-SG", "zh-SG"] as const;
const CASES = LOCALES.flatMap((locale) => SOURCE_BACKED_SCENARIOS.map((scenario) => [locale, scenario] as const));
const BUNDLE = AI_HYBRID_RUNTIME_BUNDLES.EXPLAIN_PATTERN;
const EXPECTED_KIND: Readonly<Record<SourceBackedScenario, "HIGHER" | "LOWER" | "VARIABILITY">> = {
  HIGHER: "HIGHER",
  LOWER: "LOWER",
  VARIABILITY: "VARIABILITY",
  CORRECTED: "HIGHER",
  MANY_READINGS: "HIGHER",
  BOUNDARY_DAY: "HIGHER",
};

const originalIndexedDB = Dexie.dependencies.indexedDB;
const originalIDBKeyRange = Dexie.dependencies.IDBKeyRange;
beforeAll(() => {
  Dexie.dependencies.indexedDB = fakeIndexedDB;
  Dexie.dependencies.IDBKeyRange = FDBKeyRange;
  vi.stubGlobal("fetch", () => {
    throw new Error("NETWORK_FORBIDDEN_IN_SOURCE_BACKED_FIXTURES");
  });
});
afterAll(() => {
  Dexie.dependencies.indexedDB = originalIndexedDB;
  Dexie.dependencies.IDBKeyRange = originalIDBKeyRange;
  vi.unstubAllGlobals();
});

describe("Packet 11C source-backed fixtures (real evaluator, offline)", () => {
  it.each(CASES)("%s %s: the view reconciles with itself and the request parses and binds the view's own numbers", async (locale, scenario) => {
    const { id, view, request } = await sourceBackedFixture(locale, scenario);
    expect(id).toBe(`p11c.explain-source-backed.${scenario.toLowerCase().replaceAll("_", "-")}.${locale.toLowerCase()}`);
    expect(view.kind).toBe(EXPECTED_KIND[scenario]);
    for (const period of view.periods) {
      expect(period.count, period.role).toBe(period.readings.length);
      expect(period.summary.kind, period.role).toBe(view.kind === "VARIABILITY" ? "IQR" : "MEDIAN");
    }
    expect(view.totalCount).toBe(view.periods[0].count + view.periods[1].count);
    expect(view.totalCount).toBe(view.periods[0].readings.length + view.periods[1].readings.length);

    expect(aiTaskRequestSchema.safeParse(request).success).toBe(true);
    expect(request.locale).toBe(locale);
    const payload = request.taskPayload as { periodSummary?: { summaryKind: string; periods: Array<{ countRef: string; summaryRef: string }>; totalCountRef: string } };
    expect(payload.periodSummary?.summaryKind).toBe(view.periods[0].summary.kind);
    const valueOf = (ref: string) => request.facts.find((fact) => fact.ref === ref)?.value;
    payload.periodSummary!.periods.forEach((period, index) => {
      expect(valueOf(period.countRef)).toEqual({ kind: "COUNT", value: view.periods[index]!.count });
      expect(valueOf(period.summaryRef)).toEqual({ kind: "DECIMAL", value: view.periods[index]!.summary.valueMmolL, unit: "MMOL_L" });
    });
    expect(valueOf(payload.periodSummary!.totalCountRef)).toEqual({ kind: "COUNT", value: view.totalCount });
  });

  it.each(LOCALES)("%s MANY_READINGS: a period with more than 32 evaluator-assigned readings keeps every reading", async (locale) => {
    const { view } = await sourceBackedFixture(locale, "MANY_READINGS");
    expect(Math.max(...view.periods.map((period) => period.readings.length))).toBeGreaterThan(32);
    const keys = view.periods.flatMap((period) => period.readings.map((entry) => `${entry.ref.recordId}:${entry.ref.revisionId}`));
    expect(new Set(keys).size).toBe(view.totalCount);
    // Task 6R: the count is included readings, not days: 36 readings on 12 days in the earlier period.
    const [earlier] = view.periods;
    expect(earlier.count).toBe(36);
    expect(earlier.readings).toHaveLength(36);
    expect(new Set(earlier.readings.map((entry) => entry.localDate)).size).toBe(12);
  });

  it.each(LOCALES)("%s BOUNDARY_DAY: on the boundary date the before-cutoff reading is earlier and the after-cutoff one recent; the view carries the cutoff", async (locale) => {
    const { view } = await sourceBackedFixture(locale, "BOUNDARY_DAY");
    const [earlier, recent] = view.periods;
    expect(view.sharedBoundary).toEqual({ instant: "2026-09-20T02:00:00.000Z", localDate: BOUNDARY_DATE, localTime: "10:00" });
    expect(earlier.readings.at(-1)).toMatchObject({ localDate: BOUNDARY_DATE, localTime: BOUNDARY_DAY_READINGS.before[0], enteredValue: BOUNDARY_DAY_READINGS.before[1] });
    expect(recent.readings[0]).toMatchObject({ localDate: BOUNDARY_DATE, localTime: BOUNDARY_DAY_READINGS.after[0], enteredValue: BOUNDARY_DAY_READINGS.after[1] });
    expect([earlier.window.endDate, recent.window.startDate]).toEqual([BOUNDARY_DATE, BOUNDARY_DATE]);
    expect(view.periods.map((period) => [period.count, period.readings.length])).toEqual([[9, 9], [7, 7]]);
    expect(view.totalCount).toBe(16);
  });

  it.each(LOCALES)("%s LOWER mirrors HIGHER: same windows and earlier period, recent summary below the earlier one", async (locale) => {
    const higher = await sourceBackedFixture(locale, "HIGHER");
    const lower = await sourceBackedFixture(locale, "LOWER");
    expect(lower.view.periods.map((period) => period.window)).toEqual(higher.view.periods.map((period) => period.window));
    expect(lower.view.periods.map((period) => period.count)).toEqual(higher.view.periods.map((period) => period.count));
    expect(lower.view.periods[0].summary).toEqual(higher.view.periods[0].summary);
    expect(Number(lower.view.periods[1].summary.valueMmolL)).toBeLessThan(Number(lower.view.periods[0].summary.valueMmolL));
  });

  it.each(LOCALES)("%s CORRECTED: after the correction and a re-run of processPending(), the corrected value is the one listed", async (locale) => {
    const { view, correction } = await sourceBackedFixture(locale, "CORRECTED");
    expect(correction).toBeDefined();
    const listed = view.periods.flatMap((period) => period.readings).filter((entry) => entry.ref.recordId === correction!.recordId);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ enteredValue: CORRECTION.correctedValue, localDate: correction!.localDate, localTime: correction!.localTime });
    expect(listed[0]!.ref.revisionId).not.toBe(correction!.previousRevisionId);
    expect(view.periods[1].readings.map((entry) => entry.enteredValue)).not.toContain(CORRECTION.previousValue);
  });

  it.each(CASES)("%s %s: planSlots plans the source-backed request and the plan is remote-eligible", async (locale, scenario) => {
    const { request } = await sourceBackedFixture(locale, scenario);
    const planned = planSlots(request, BUNDLE);
    expect(planned.kind).toBe("PLANNED");
    if (planned.kind !== "PLANNED") return;
    // ai-slot-plan.11b.9 (owner decision option (a)): the LOCAL observation is reserved at its final composed wording. The Task 4 rule
    // (every field at its fixed budget) is kept as `eligibilityBudget` for the historical record: en-SG was over the ceiling under it.
    const account = remoteBudgetAccount(planned.plan, planned.atoms, BUNDLE);
    const historical = eligibilityBudget(planned.plan, planned.atoms);
    const detail = ` — plan.remote is ${JSON.stringify(planned.plan.remote)}: Σ reserved = ${account.total}, ceiling ${account.ceiling} [${account.fields.map((field) => `${field.path} ${field.owner} ${field.reserved}`).join(", ")}]; ai-slot-plan.11b.8 rule Σ = ${historical.sum}`;
    expect(account.total, `${locale} ${scenario}${detail}`).toBeLessThanOrEqual(account.ceiling);
    expect(account.total, `${locale} ${scenario}${detail}`).toBeLessThanOrEqual(historical.sum);
    expect(planned.plan.remote, `${locale} ${scenario}: expected a remote-eligible plan${detail}`).toEqual({ eligible: true });
  });
});

/**
 * Packet 11C Task 6R (2026-10-08, offline): the planner's own remote-eligibility account per scenario x locale, pinned. The 6R changes
 * (view boundary data, copy 11b.10 summaryRoleNotice) never reach the PERIOD_SUMMARY atom or any composed field, so these sums are the
 * same before and after them; BOUNDARY_DAY is the new scenario. Each row: [Σ reserved, ceiling, headline R, observation L, evidence R].
 */
const ELIGIBILITY_ACCOUNT: Readonly<Record<string, readonly number[]>> = {
  "en-SG HIGHER": [457, 525, 133, 222, 102],
  "en-SG LOWER": [457, 525, 133, 222, 102],
  "en-SG VARIABILITY": [486, 525, 133, 251, 102],
  "en-SG CORRECTED": [456, 525, 133, 221, 102],
  "en-SG MANY_READINGS": [458, 525, 133, 223, 102],
  "en-SG BOUNDARY_DAY": [456, 525, 133, 221, 102],
  "zh-SG HIGHER": [249, 525, 67, 112, 70],
  "zh-SG LOWER": [249, 525, 67, 112, 70],
  "zh-SG VARIABILITY": [254, 525, 67, 117, 70],
  "zh-SG CORRECTED": [248, 525, 67, 111, 70],
  "zh-SG MANY_READINGS": [250, 525, 67, 113, 70],
  "zh-SG BOUNDARY_DAY": [248, 525, 67, 111, 70],
};

describe("Packet 11C Task 6R: eligibility sums per scenario x locale are pinned", () => {
  it("every scenario's account is the pinned one", async () => {
    const accounts: Record<string, number[]> = {};
    for (const [locale, scenario] of CASES) {
      const { request } = await sourceBackedFixture(locale, scenario);
      const planned = planSlots(request, BUNDLE);
      if (planned.kind !== "PLANNED") throw new Error(`${locale} ${scenario}: ${planned.reason}`);
      const account = remoteBudgetAccount(planned.plan, planned.atoms, BUNDLE);
      accounts[`${locale} ${scenario}`] = [account.total, account.ceiling, ...account.fields.map((field) => field.reserved)];
    }
    expect(accounts).toEqual(ELIGIBILITY_ACCOUNT);
  });
});

describe("Packet 11C negative builders (real evaluator, offline)", () => {
  it.each(LOCALES)("%s: insufficient evidence and a read-only NO_MATERIAL comparison are INELIGIBLE and never yield a request", async (locale) => {
    const insufficient = await insufficientEvidence(locale);
    expect(insufficient).toEqual({ kind: "INELIGIBLE", reason: "NOT_SUPPORTED" });
    const material = await noMaterial(locale);
    expect(material).toEqual({ kind: "INELIGIBLE", reason: "NO_MATERIAL" });
    for (const result of [insufficient, material]) {
      expect(result).not.toHaveProperty("view");
      expect(result).not.toHaveProperty("request");
    }
  });
});
