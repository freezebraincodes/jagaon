// @vitest-environment node
import { createHash } from "node:crypto";
import Dexie from "dexie";
import fakeIndexedDB, { IDBKeyRange as FDBKeyRange } from "fake-indexeddb";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AI_HYBRID_RUNTIME_BUNDLES } from "@/application/ai/ai-hybrid-runtime-bundles";
import { composeAiResult } from "@/application/ai/language/ai-composition";
import { verifyComposition } from "@/application/ai/language/assembler";
import { defaultShells } from "@/application/ai/language/default-shells";
import { composeDeterministic } from "@/application/ai/language/deterministic-composition";
import { GLOSSES_BY_KIND, projectShellTaskRequest } from "@/application/ai/language/shell-projector";
import { planSlots } from "@/application/ai/language/slot-planner";
import { SLOT_PLAN_VERSION, type AiLocale, type AiTaskRequest, type ShellFieldPath, type ShellTexts, type SlotPlan } from "@/domain/ai";
import { capture, existingFixtureDigest, versionNormalisedFixtureDigest } from "./packet-11-presentation-guard.test";
import { SOURCE_BACKED_SCENARIOS, sourceBackedFixture, type SourceBackedScenario } from "./packet-11-source-backed-fixtures";
import { CURRENT_SLOT_PLAN_VERSION, differingPaths, HISTORICAL_SLOT_PLAN_VERSION, normaliseSlotPlanVersion, SLOT_PLAN_VERSION_OCCURRENCES_PER_BODY } from "./packet-11-slot-plan-version-normalisation";

/**
 * Packet 11C Task 4 byte guard (evaluation-only, offline). A source-backed EXPLAIN request (real evaluator -> history view -> Task 3
 * builder) plans into the existing remote shape (S1 MEANING headline, S3 COUNT evidence) plus one application-owned (LOCAL)
 * PERIOD_SUMMARY observation atom, so its model-facing body must be byte-identical to the already-evaluated request class:
 * en-SG c46ab171…, zh-SG b9398514… (9 stored fixtures per locale). The body is captured exactly as the presentation guard captures the
 * 70 fixture bodies (its exported `capture`): the real DeepSeek shell adapter with a fetcher that records the body and throws. No
 * provider call is made; the global fetch is stubbed to throw.
 *
 * Version-only difference (Packet 11C phase 2, owner decision option (a), 2026-10-08, offline): ai-slot-plan.11b.9 changes only the
 * planner's remote-eligibility accounting, so every body carries slot plan version 11b.9 where the historical class body carries 11b.8,
 * in exactly two fields (the shell input's `slotPlanVersion` and the output schema's echo enum). Byte identity with the class is therefore
 * checked after the documented structural normalisation (`normaliseSlotPlanVersion`), which must touch exactly those two fields; any
 * other difference fails with the differing keys. The current (un-normalised) class hashes are pinned too.
 */
const CLASS_BODY_SHA: Readonly<Record<AiLocale, string>> = {
  "en-SG": "c46ab171eac08602ea3d9e4913c447c7c71643e67971ce725a085ad08cfb2d7d",
  "zh-SG": "b9398514d6b931c94e8acfa78c7faf421606cc9cf2d6f80ee448eedee9e32855",
};
/** The same class bodies under ai-slot-plan.11b.9 (current values; any future change shows here). */
const CURRENT_CLASS_BODY_SHA: Readonly<Record<AiLocale, string>> = {
  "en-SG": "1756934e47137b7434d3499c6952f30adf6056161fc5f6523c53ec526f22a13b",
  "zh-SG": "63f161dcddc2195bec407c79aec6abf4a5edb3f73db2f37b0df51ea382c136ae",
};
const HISTORICAL_FIXTURE_DIGEST = "a77a79aa1c56b1530758147f12573051c4d786035f8926901bbbdaa19d3edd92";
const LOCALES = ["en-SG", "zh-SG"] as const;
const SCENARIOS: readonly SourceBackedScenario[] = SOURCE_BACKED_SCENARIOS;
const CASES = LOCALES.flatMap((locale) => SCENARIOS.map((scenario) => [locale, scenario] as const));
const BUNDLE = AI_HYBRID_RUNTIME_BUNDLES.EXPLAIN_PATTERN;
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const captureBody = async (request: AiTaskRequest) => (await capture({ request, taskType: "EXPLAIN_PATTERN" })).body;
const ordinaryBody = async (locale: AiLocale) => {
  const { hybridFixturesForPhase } = await import("./packet-11-hybrid-fixtures");
  const ordinary = hybridFixturesForPhase("FULL").find((fixture) => fixture.id === `p11.explain-pattern.${locale.toLowerCase()}.ordinary`)!;
  return (await capture(ordinary)).body!;
};
/** Requires a version-only difference from the historical class body: exactly 2 normalised fields, then byte identity (else: the keys). */
async function expectVersionOnlyDifference(body: string, locale: AiLocale, label: string) {
  const normalised = normaliseSlotPlanVersion(body);
  expect(normalised.occurrences, label).toBe(SLOT_PLAN_VERSION_OCCURRENCES_PER_BODY);
  expect(normalised.paths, label).toEqual(["input[0].content[0].text#slotPlanVersion", "text.format.schema.properties.slotPlanVersion.enum[0]"]);
  if (sha256(normalised.body) !== CLASS_BODY_SHA[locale]) {
    const reference = normaliseSlotPlanVersion(await ordinaryBody(locale)).body;
    expect.fail(`${label}: the body differs from the historical class beyond the slot-plan version field: ${sha256(reference) === CLASS_BODY_SHA[locale] ? differingPaths(normalised.body, reference).join(", ") : "(the class reference itself moved)"}`);
  }
  expect(sha256(normalised.body), label).toBe(CLASS_BODY_SHA[locale]);
  expect(sha256(body), label).toBe(CURRENT_CLASS_BODY_SHA[locale]);
}
const OBSERVATION_FRAME: Readonly<Record<AiLocale, readonly [string, string]>> = { "en-SG": ["Readings by period — ", "."], "zh-SG": ["按期间的读数：", "。"] };
const remoteDefaults = (plan: SlotPlan): ShellTexts => new Map([...defaultShells(plan)].filter(([path]) => path !== "observation")) as ShellTexts;

const originalIndexedDB = Dexie.dependencies.indexedDB;
const originalIDBKeyRange = Dexie.dependencies.IDBKeyRange;
beforeAll(() => {
  Dexie.dependencies.indexedDB = fakeIndexedDB;
  Dexie.dependencies.IDBKeyRange = FDBKeyRange;
  vi.stubGlobal("fetch", () => {
    throw new Error("NETWORK_FORBIDDEN_IN_SOURCE_BACKED_GUARD");
  });
});
afterAll(() => {
  Dexie.dependencies.indexedDB = originalIndexedDB;
  Dexie.dependencies.IDBKeyRange = originalIDBKeyRange;
  vi.unstubAllGlobals();
});

async function plannedSourceBacked(locale: AiLocale, scenario: SourceBackedScenario = "HIGHER") {
  const fixture = await sourceBackedFixture(locale, scenario);
  const planned = planSlots(fixture.request, BUNDLE);
  if (planned.kind !== "PLANNED") throw new Error(`expected PLANNED, got ${planned.reason}`);
  return { ...fixture, plan: planned.plan, atoms: planned.atoms };
}

describe("Packet 11C source-backed EXPLAIN byte guard (offline)", () => {
  it.each(CASES)("%s %s: a source-backed plan keeps the existing remote shape: S1 MEANING headline, S2 LOCAL PERIOD_SUMMARY, S3 COUNT evidence", async (locale, scenario) => {
    const { request, view } = await sourceBackedFixture(locale, scenario);
    expect(view.kind).toBe(scenario === "VARIABILITY" ? "VARIABILITY" : scenario === "LOWER" ? "LOWER" : "HIGHER");
    const planned = planSlots(request, BUNDLE);
    expect(planned.kind).toBe("PLANNED");
    if (planned.kind !== "PLANNED") return;
    const plan = planned.plan;
    expect(plan.slots.map((slot) => [slot.slotId, slot.atomKind, slot.homeField])).toEqual([["S1", "MEANING", "headline"], ["S2", "PERIOD_SUMMARY", "observation"], ["S3", "COUNT", "evidence"]]);
    expect(plan.fields.map((field) => [field.path, field.owner])).toEqual([["headline", "REMOTE"], ["observation", "LOCAL"], ["evidence", "REMOTE"]]);
    expect(plan.remote).toEqual({ eligible: true });
  });

  it.each(CASES)("%s %s: the model-facing body is byte-identical to the stored request class, apart from the documented slot-plan version field", async (locale, scenario) => {
    const { request } = await sourceBackedFixture(locale, scenario);
    const body = await captureBody(request);
    expect(body, "no body was captured (the plan is not remote-eligible)").not.toBeNull();
    await expectVersionOnlyDifference(body!, locale, `${locale} ${scenario}`);
  });

  it("Task 6R: the BOUNDARY_DAY regression scenario is covered by every shape, version-only body, eligibility and composition case above and below", () => {
    expect(SCENARIOS).toContain("BOUNDARY_DAY");
    expect(CASES.filter(([, scenario]) => scenario === "BOUNDARY_DAY")).toEqual([["en-SG", "BOUNDARY_DAY"], ["zh-SG", "BOUNDARY_DAY"]]);
  });

  it.each(LOCALES)("%s: the class hash is the stored class (the ordinary fixture of the 70 has the same body, version-normalised)", async (locale) => {
    expect(SLOT_PLAN_VERSION).toBe(CURRENT_SLOT_PLAN_VERSION);
    await expectVersionOnlyDifference(await ordinaryBody(locale), locale, `${locale} ordinary`);
  });

  it.each(CASES)("%s %s: no value, count, date, slot, binding, atom kind or source reaches the model-facing request", async (locale, scenario) => {
    const { request, view, plan } = await plannedSourceBacked(locale, scenario);
    const body = await captureBody(request);
    if (body === null) throw new Error("expected a body");
    for (const forbidden of ["PERIOD_SUMMARY", "periodSummary", view.slot, view.observationRef.recordId, view.snapshotRef.recordId]) expect(body).not.toContain(forbidden);
    for (const period of view.periods) {
      for (const date of [period.window.startDate, period.window.endDate]) expect(body).not.toContain(date);
      for (const reading of period.readings) expect(body).not.toContain(reading.ref.recordId);
    }
    // The value-blind shell input inside the body: the only numbers are field budgets and sentence limits.
    const shell = projectShellTaskRequest(plan);
    const numbers = JSON.stringify(shell).replace(/"(?:maxCodePoints|maxSentences)":\d+/g, "").replace(/"S\d+"|"ai-[^"]*"|"[^"]*@[^"]*"/g, "");
    expect(numbers).not.toMatch(/\d/);
  });

  it("PERIOD_SUMMARY can never be projected", async () => {
    for (const locale of LOCALES) {
      const { plan } = await plannedSourceBacked(locale);
      // Even a plan forced to be eligible with the observation forced to REMOTE is refused by the projector's closed approval.
      const forced = { ...plan, remote: { eligible: true }, fields: plan.fields.map((field) => (field.path === "observation" ? { ...field, owner: "REMOTE" } : field)) } as unknown as SlotPlan;
      expect(() => projectShellTaskRequest(forced)).toThrow("SHELL_REQUEST_NOT_APPROVED");
    }
    expect(GLOSSES_BY_KIND.PERIOD_SUMMARY).toEqual([]);
  });

  it("the existing 70-fixture digest is unchanged apart from the documented slot-plan version field (140 fields normalised)", async () => {
    expect(await versionNormalisedFixtureDigest()).toEqual({ digest: HISTORICAL_FIXTURE_DIGEST, occurrences: 70 * SLOT_PLAN_VERSION_OCCURRENCES_PER_BODY });
    expect(await existingFixtureDigest()).not.toBe(HISTORICAL_FIXTURE_DIGEST);
  });
});

describe("Packet 11C phase 2: the version-only normalisation touches exactly the slot-plan version fields", () => {
  const shellInputOf = (body: string) => JSON.parse((JSON.parse(body) as { input: Array<{ content: Array<{ text: string }> }> }).input[0]!.content[0]!.text) as Record<string, unknown>;
  const withShellInput = (body: string, edit: (input: Record<string, unknown>) => void) => {
    const root = JSON.parse(body) as { input: Array<{ content: Array<{ text: string }> }> };
    const input = shellInputOf(body);
    edit(input);
    root.input[0]!.content[0]!.text = JSON.stringify(input);
    return JSON.stringify(root);
  };

  it.each(LOCALES)("%s: exactly the two version fields are rewritten; the same string planted under any other key is left alone and reported", async (locale) => {
    const body = await ordinaryBody(locale);
    expect(shellInputOf(body).slotPlanVersion).toBe(CURRENT_SLOT_PLAN_VERSION);
    const planted = withShellInput(body, (input) => {
      input.shellInputVersion = CURRENT_SLOT_PLAN_VERSION;
    });
    const plantedRoot = JSON.parse(planted) as { instructions: string };
    plantedRoot.instructions = `${plantedRoot.instructions} ${CURRENT_SLOT_PLAN_VERSION}`;
    const result = normaliseSlotPlanVersion(JSON.stringify(plantedRoot));
    expect(result.occurrences).toBe(SLOT_PLAN_VERSION_OCCURRENCES_PER_BODY);
    expect(shellInputOf(result.body).slotPlanVersion).toBe(HISTORICAL_SLOT_PLAN_VERSION);
    expect(shellInputOf(result.body).shellInputVersion).toBe(CURRENT_SLOT_PLAN_VERSION);
    expect((JSON.parse(result.body) as { instructions: string }).instructions.endsWith(` ${CURRENT_SLOT_PLAN_VERSION}`)).toBe(true);
    expect(differingPaths(result.body, normaliseSlotPlanVersion(body).body)).toEqual(["instructions", "input[0].content[0].text#shellInputVersion"]);
  });

  it.each(LOCALES)("%s: any other body difference survives normalisation and is named by its keys; a historical body is not normalised again (no silent no-op)", async (locale) => {
    const body = await ordinaryBody(locale);
    const changed = withShellInput(body, (input) => {
      (input.fields as Array<{ maxCodePoints: number }>)[0]!.maxCodePoints += 1;
    });
    const normalised = normaliseSlotPlanVersion(changed);
    expect(normalised.occurrences).toBe(SLOT_PLAN_VERSION_OCCURRENCES_PER_BODY);
    expect(sha256(normalised.body)).not.toBe(CLASS_BODY_SHA[locale]);
    expect(differingPaths(normalised.body, normaliseSlotPlanVersion(body).body)).toEqual(["input[0].content[0].text#fields[0].maxCodePoints"]);
    const historical = normaliseSlotPlanVersion(body).body;
    expect(normaliseSlotPlanVersion(historical)).toEqual({ body: historical, occurrences: 0, paths: [] });
    expect(() => normaliseSlotPlanVersion(body.replace("{", "{ "))).toThrow("VERSION_NORMALISATION_NOT_CANONICAL");
  });
});

describe("Packet 11C source-backed composition: deterministic and AI variants 1–2, real r7", () => {
  it.each(CASES)("%s %s: the observation is the approved frame around the exact PERIOD_SUMMARY atom, and r7 accepts the composition", async (locale, scenario) => {
    const { request, plan, atoms } = await plannedSourceBacked(locale, scenario);
    const atom = atoms.S2!.text;
    const [open, close] = OBSERVATION_FRAME[locale];
    const outcomes: string[] = [];
    const compositions = [{ label: "deterministic", composition: composeDeterministic(request, plan, atoms, BUNDLE) }];
    for (let variant = 1; variant <= 2; variant += 1) {
      const result = composeAiResult(request, plan, atoms, remoteDefaults(plan), BUNDLE, { variant });
      if (result.kind === "ACCEPTED") compositions.push({ label: `variant ${variant}`, composition: result.composition });
      else outcomes.push(`variant ${variant}: ${result.gate} ${result.reason}${"invariant" in result ? ` ${result.invariant}` : ""}`);
    }
    for (const { label, composition } of compositions) {
      const observation = composition.fields.get("observation" as ShellFieldPath)!;
      expect(observation.text, label).toBe(`${open}${atom}${close}`);
      expect(observation.spans, label).toEqual([{ slotId: "S2", start: open.length, end: open.length + atom.length }]);
      expect(observation.text.slice(observation.spans[0]!.start, observation.spans[0]!.end), label).toBe(atom);
      const verdict = verifyComposition(request, BUNDLE, composition);
      if (verdict.kind !== "ACCEPTED") outcomes.push(`${label}: r7 ${verdict.reason}`);
    }
    expect(outcomes).toEqual([]);
  });
});
