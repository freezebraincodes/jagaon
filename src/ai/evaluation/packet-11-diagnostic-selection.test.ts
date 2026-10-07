import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluationPlan } from "./packet-11-evaluation";
import { fixturesForPhase, PACKET_11_FIXTURES, PACKET_11_OFFLINE_NEGATIVE_FIXTURES } from "./packet-11-fixtures";

/**
 * Targeted one-call diagnostics (owner approval 2026-10-06). The DIAGNOSTIC phase may name exactly one
 * live qualification fixture; every other phase refuses a selection, and an unknown or offline-only
 * fixture is refused before any request. The plan stays one call with no repair.
 */

const CHANGED_UNIT = "p11.explain-pattern.en-sg.changed-number-unit";
const ABSTENTION = "p11.explain-pattern.en-sg.abstention";

describe("DIAGNOSTIC fixture selection", () => {
  it("keeps the default diagnostic fixture when nothing is selected", () => {
    expect(fixturesForPhase("DIAGNOSTIC").map((fixture) => fixture.id)).toEqual(["p11.explain-pattern.en-sg.ordinary"]);
  });

  it.each([CHANGED_UNIT, ABSTENTION])("selects exactly the live fixture %s, as a one-call plan without repair", (id) => {
    const fixtures = fixturesForPhase("DIAGNOSTIC", id);
    expect(fixtures).toEqual([PACKET_11_FIXTURES.find((fixture) => fixture.id === id)]);
    expect(evaluationPlan(fixtures, "DIAGNOSTIC")).toMatchObject({ phase: "DIAGNOSTIC", fixtureCount: 1, fixtureIds: [id], maxCalls: 1, allowRepair: false });
  });

  it("refuses an unknown fixture", () => {
    expect(() => fixturesForPhase("DIAGNOSTIC", "p11.explain-pattern.en-sg.not-a-fixture")).toThrow("DIAGNOSTIC_FIXTURE_NOT_LIVE");
  });

  it.each(PACKET_11_OFFLINE_NEGATIVE_FIXTURES.map((fixture) => fixture.id))("refuses the offline-only negative fixture %s", (id) => {
    expect(() => fixturesForPhase("DIAGNOSTIC", id)).toThrow("DIAGNOSTIC_FIXTURE_NOT_LIVE");
  });

  it.each(["SMOKE", "FULL", "CARE_DIAGNOSTIC"] as const)("refuses any selection in the %s phase", (phase) => {
    expect(() => fixturesForPhase(phase, CHANGED_UNIT)).toThrow("FIXTURE_SELECTION_DIAGNOSTIC_ONLY");
  });

  it("an empty selection is the default, never a wildcard", () => {
    expect(fixturesForPhase("DIAGNOSTIC", "").map((fixture) => fixture.id)).toEqual(["p11.explain-pattern.en-sg.ordinary"]);
    expect(fixturesForPhase("FULL", "")).toHaveLength(70);
  });
});

describe("the live runner passes the selection before the plan and before any request", () => {
  const source = readFileSync(join(process.cwd(), "src/ai/evaluation/packet-11-live-kie.test.ts"), "utf8");
  it("reads KIE_EVALUATION_FIXTURE_ID into fixturesForPhase, before the printed plan and the first request", () => {
    const selection = source.indexOf("fixturesForPhase(phase, env.KIE_EVALUATION_FIXTURE_ID)");
    expect(selection).toBeGreaterThan(0);
    expect(selection).toBeLessThan(source.indexOf("packet11LivePlan"));
    expect(selection).toBeLessThan(source.indexOf("discoverKieModels("));
    expect(selection).toBeLessThan(source.indexOf("evaluateModelSnapshot({"));
  });
});
