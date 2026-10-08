import Dexie from "dexie";
import { buildSourceBackedExplainRequest } from "@/application/ai/explain-pattern-request";
import { AI_HYBRID_RUNTIME_BUNDLES } from "@/application/ai/ai-hybrid-runtime-bundles";
import { OUTPUT_CODE_POINTS_PER_TOKEN } from "@/application/ai/ai-output-validator";
import { defaultShells } from "@/application/ai/language/default-shells";
import { ATOM_SPACING_RESERVE } from "@/application/ai/language/slot-planner";
import {
  boundaryDayFixture,
  databases,
  dayBefore,
  FACT,
  higherFixture,
  largePeriodFixture,
  local,
  NOW,
  reading,
  RECENT,
  REFERENCE,
  setup,
  TODAY,
  variabilityFixture,
} from "@/application/history/history-test-support";
import type { ExplainablePatternResult, ExplainablePatternView, HistoryComparison } from "@/application/history/recorded-history-contracts";
import { slotTokenMatcher, type AiLocale, type AiTaskRequest, type AtomTable, type ShellFieldPath, type SlotPlan } from "@/domain/ai";
import type { Instant } from "@/domain/shared/time";

/**
 * Packet 11C source-backed EXPLAIN fixtures (evaluation-only; synthetic HACKATHON_DEMO data). Nothing here is typed by hand: each
 * scenario records readings through the real JournalCommandService, runs createIntelligenceCoordinator(...).processPending() (the real
 * evaluator and its validated evidence snapshot), loads the ExplainablePatternView from the recorded-history query and builds the request
 * with the Task 3 builder. The readings come from the shared real-evaluator harness (`history-test-support`).
 *
 * The caller installs fake-indexeddb as Dexie's dependency; each fixture closes and deletes its own database before returning.
 * Scenarios: HIGHER (the default), LOWER (HIGHER mirrored: the same earlier readings, recent readings below them), VARIABILITY (IQR),
 * CORRECTED (HIGHER with one recent reading corrected through the journal, then processPending() re-run) and MANY_READINGS (36 readings
 * in the earlier period) and BOUNDARY_DAY (Task 6R: HIGHER plus one reading on the shared-boundary date before the 10:00 cutoff, which
 * the evaluator puts in the earlier period, and one after it, in the recent period). Negative builders: insufficient evidence (NOT_SUPPORTED) and a read-only NO_MATERIAL comparison; they return
 * the INELIGIBLE result and never yield a request.
 *
 * Each fixture also carries the READY 7A history comparison for the same fact (`comparison`, from `history.load`), so a review page can
 * show the existing approved card text unchanged, and, for CORRECTED, the correction it made (`correction`).
 */
export const SOURCE_BACKED_SCENARIOS = Object.freeze(["HIGHER", "LOWER", "VARIABILITY", "CORRECTED", "MANY_READINGS", "BOUNDARY_DAY"] as const);
export type SourceBackedScenario = (typeof SOURCE_BACKED_SCENARIOS)[number];
export type SourceBackedCorrection = Readonly<{ recordId: string; previousRevisionId: string; localDate: string; localTime: string }>;
export type SourceBackedFixture = Readonly<{
  id: string;
  view: ExplainablePatternView;
  request: AiTaskRequest;
  /** The existing 7A READY comparison for the same fact (approved card input), or null when the history view has none. */
  comparison: HistoryComparison | null;
  /** CORRECTED only: the reading that was corrected. */
  correction?: SourceBackedCorrection;
}>;

type Harness = Awaited<ReturnType<typeof setup>>;

/** LOWER mirrors HIGHER: RECENT reflected below the earlier median by the same distances (7.2 -> 4.8, …), on the same days and time. */
const LOWER_RECENT: Array<[number, string]> = [[1, "4.8"], [3, "4.6"], [5, "4.9"], [8, "4.4"], [10, "4.7"], [12, "4.5"]];

async function lowerFixture(): Promise<Harness> {
  const harness = await setup();
  for (const [d, v] of [...REFERENCE, ...LOWER_RECENT]) await reading(harness.journal, dayBefore(TODAY, d), "07:30", v);
  await harness.coordinator.processPending();
  return harness;
}

/** CORRECTED: the recent reading recorded 3 days before NOW as 7.4 is corrected to 7.8 (same date and time), then the evaluator re-runs. */
export const CORRECTION = Object.freeze({ recentIndex: 1, previousValue: "7.4", correctedValue: "7.8" });

async function correctedFixture(): Promise<Harness & { correction: SourceBackedCorrection }> {
  const harness = await higherFixture();
  const [days, value] = RECENT[CORRECTION.recentIndex]!;
  if (value !== CORRECTION.previousValue) throw new Error("SOURCE_BACKED_FIXTURE_CORRECTION_TARGET_CHANGED");
  const target = harness.recorded[REFERENCE.length + CORRECTION.recentIndex]!;
  const localDate = dayBefore(TODAY, days);
  const corrected = await harness.journal.correctGlucoseTime({
    recordId: target.recordId,
    expectedRevisionId: target.revisionId,
    expectedRevisionNumber: 1,
    payload: {
      measurement: { enteredValue: CORRECTION.correctedValue as never, enteredUnit: "MMOL_L", normalization: null },
      measurementMethod: "FINGERSTICK_METER",
      context: { kind: "PATIENT_SELECTED_SLOT", slot: "BEFORE_BREAKFAST" },
    },
    temporal: local(localDate, "07:30"),
    recordedAt: "2026-10-04T01:00:00.000Z" as Instant,
  });
  if (corrected.kind !== "COMMITTED") throw new Error("SOURCE_BACKED_FIXTURE_CORRECTION_FAILED");
  await harness.coordinator.processPending();
  return { ...harness, correction: Object.freeze({ recordId: target.recordId, previousRevisionId: target.revisionId, localDate, localTime: "07:30" }) };
}

const BUILDERS: Readonly<Record<SourceBackedScenario, () => Promise<Harness & { correction?: SourceBackedCorrection }>>> = {
  HIGHER: higherFixture,
  LOWER: lowerFixture,
  VARIABILITY: variabilityFixture,
  CORRECTED: correctedFixture,
  MANY_READINGS: largePeriodFixture,
  BOUNDARY_DAY: boundaryDayFixture,
};

/** Fixed request ids (UUID v4), so every fixture request is deterministic. */
const REQUEST_IDS: Readonly<Record<SourceBackedScenario, Readonly<Record<AiLocale, string>>>> = {
  HIGHER: { "en-SG": "3b1f6c2e-8a4d-4e5f-9a1b-2c3d4e5f6a71", "zh-SG": "3b1f6c2e-8a4d-4e5f-9a1b-2c3d4e5f6a72" },
  VARIABILITY: { "en-SG": "3b1f6c2e-8a4d-4e5f-9a1b-2c3d4e5f6a73", "zh-SG": "3b1f6c2e-8a4d-4e5f-9a1b-2c3d4e5f6a74" },
  MANY_READINGS: { "en-SG": "3b1f6c2e-8a4d-4e5f-9a1b-2c3d4e5f6a75", "zh-SG": "3b1f6c2e-8a4d-4e5f-9a1b-2c3d4e5f6a76" },
  LOWER: { "en-SG": "3b1f6c2e-8a4d-4e5f-9a1b-2c3d4e5f6a77", "zh-SG": "3b1f6c2e-8a4d-4e5f-9a1b-2c3d4e5f6a78" },
  CORRECTED: { "en-SG": "3b1f6c2e-8a4d-4e5f-9a1b-2c3d4e5f6a79", "zh-SG": "3b1f6c2e-8a4d-4e5f-9a1b-2c3d4e5f6a7a" },
  BOUNDARY_DAY: { "en-SG": "3b1f6c2e-8a4d-4e5f-9a1b-2c3d4e5f6a7b", "zh-SG": "3b1f6c2e-8a4d-4e5f-9a1b-2c3d4e5f6a7c" },
};

async function release(harness: Harness): Promise<void> {
  harness.database.close();
  const index = databases.indexOf(harness.database);
  if (index >= 0) databases.splice(index, 1);
  await Dexie.delete(harness.database.name);
}

export async function sourceBackedFixture(locale: AiLocale, scenario: SourceBackedScenario = "HIGHER"): Promise<SourceBackedFixture> {
  const harness = await BUILDERS[scenario]();
  try {
    const result = await harness.history.loadExplainablePattern({ factId: FACT });
    if (result.kind !== "EXPLAINABLE") throw new Error(`SOURCE_BACKED_FIXTURE_NOT_EXPLAINABLE:${scenario}:${result.reason}`);
    const request = buildSourceBackedExplainRequest({ view: result.view, locale, requestId: REQUEST_IDS[scenario][locale], requestedAt: NOW });
    const ready = await harness.history.load({ period: "THIRTY_DAYS" });
    const comparison = ready.status === "READY" ? (ready.comparisons.find((entry) => entry.factId === FACT) ?? null) : null;
    return Object.freeze({
      id: `p11c.explain-source-backed.${scenario.toLowerCase().replaceAll("_", "-")}.${locale.toLowerCase()}`,
      view: result.view,
      request,
      comparison,
      ...(harness.correction ? { correction: harness.correction } : {}),
    });
  } finally {
    await release(harness);
  }
}

/** A negative result must stay INELIGIBLE: if it were ever explainable, building its request is refused rather than returned. */
async function negative(locale: AiLocale, build: (harness: Harness) => Promise<string>): Promise<ExplainablePatternResult> {
  const harness = await setup();
  try {
    const result = await harness.history.loadExplainablePattern({ factId: await build(harness) });
    if (result.kind === "EXPLAINABLE") {
      buildSourceBackedExplainRequest({ view: result.view, locale, requestId: REQUEST_IDS.HIGHER[locale], requestedAt: NOW });
      throw new Error("SOURCE_BACKED_NEGATIVE_FIXTURE_IS_EXPLAINABLE");
    }
    return result;
  } finally {
    await release(harness);
  }
}

/** Too few comparable readings: the evaluator does not SUPPORT the comparison (NOT_SUPPORTED). */
export function insufficientEvidence(locale: AiLocale): Promise<ExplainablePatternResult> {
  return negative(locale, async ({ journal, coordinator }) => {
    for (const [d, v] of [...REFERENCE.slice(0, 4), ...RECENT.slice(0, 3)]) await reading(journal, dayBefore(TODAY, d), "07:30", v);
    await coordinator.processPending();
    return FACT;
  });
}

/** A read-only NO_MATERIAL comparison (before dinner, no material difference): never explained (NO_MATERIAL). */
export function noMaterial(locale: AiLocale): Promise<ExplainablePatternResult> {
  return negative(locale, async ({ journal, coordinator }) => {
    const days = [16, 18, 20, 23, 25, 27, 30, 33, 1, 3, 5, 8, 10, 12];
    for (const [i, d] of days.entries()) await reading(journal, dayBefore(TODAY, d), "18:30", i % 2 === 0 ? "7.0" : "7.2", "BEFORE_DINNER");
    await coordinator.processPending();
    return "NO_MATERIAL:BEFORE_DINNER";
  });
}

const codePoints = (text: string) => [...text].length;

/**
 * Evaluation-only readout of the HISTORICAL ai-slot-plan.11b.8 remote-eligibility check (owner decision 3) for a PLANNED EXPLAIN plan: Σ
 * over every field (LOCAL too) of its fixed budget + its atoms' code points + ATOM_SPACING_RESERVE each, against floor(outputTokenCeiling ×
 * OUTPUT_CODE_POINTS_PER_TOKEN). `sumIfLocalAtProse` is the same sum with a LOCAL field counted at its composed approved prose (Task 4
 * option (a) as first sketched). Since ai-slot-plan.11b.9 (owner decision option (a), Packet 11C phase 2) the planner's own account is
 * `remoteBudgetAccount` (slot-planner.ts); this readout is kept only for the before/after record.
 */
export function eligibilityBudget(plan: SlotPlan, atoms: AtomTable) {
  const ceiling = Math.floor(AI_HYBRID_RUNTIME_BUNDLES.EXPLAIN_PATTERN.executionBudget.outputTokenCeiling * OUTPUT_CODE_POINTS_PER_TOKEN);
  const defaults = defaultShells(plan);
  const fields = plan.fields.map((field) => ({
    path: field.path as ShellFieldPath,
    owner: field.owner,
    budget: field.maxCodePoints,
    atomCost: field.requiredSlots.reduce((sum, slot) => sum + codePoints(atoms[slot]!.text) + ATOM_SPACING_RESERVE, 0),
    prose: codePoints((defaults.get(field.path) ?? "").replace(slotTokenMatcher(), "").trim()),
  }));
  const sum = fields.reduce((total, field) => total + field.budget + field.atomCost, 0);
  const sumIfLocalAtProse = fields.reduce((total, field) => total + (field.owner === "LOCAL" ? field.prose : field.budget) + field.atomCost, 0);
  return Object.freeze({ ceiling, sum, overBy: Math.max(0, sum - ceiling), sumIfLocalAtProse, fields: Object.freeze(fields) });
}
