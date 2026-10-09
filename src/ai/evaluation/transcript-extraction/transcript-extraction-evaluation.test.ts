// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { ExtractionOutput } from "@/domain/transcript-extraction/transcript-extraction-contract";
import type { ExtractionProviderResult } from "@/ai/transcript-extraction/transcript-extraction-provider";
import { TRANSCRIPT_EXTRACTION_FIXTURES, TRANSCRIPT_EXTRACTION_FIXTURE_SET_VERSION, goldenOutput, type ExtractionFixture } from "./transcript-extraction-fixtures";
import { TRANSCRIPT_EXTRACTION_FULL_POLICY, runOfflineEvaluation, scoreFixture } from "./transcript-extraction-harness";

/**
 * Packet 13 (P13X): OFFLINE evaluation of EXTRACT_VOICE_FACTS with fake providers only (no credential, no network, no live call).
 * A golden fake proves the fixtures, the r-rules and the scorer agree; adversarial fakes prove each unsafe answer is caught.
 */

const completed = (candidate: unknown): ExtractionProviderResult => ({ kind: "COMPLETED", candidate, usage: { inputTokens: 1_000, outputTokens: 100, costMicroUsd: 420, credits: null, basis: "REPORTED" }, retention: "CONFIRMED_NOT_STORED" });
const extractFixture = (id: string) => TRANSCRIPT_EXTRACTION_FIXTURES.find((fixture) => fixture.id === id)! as ExtractionFixture & { expect: "EXTRACT" };

describe("Packet 13 extraction fixtures", () => {
  it("cover both locales and every probed class, with dose questions in each locale", () => {
    expect(TRANSCRIPT_EXTRACTION_FIXTURE_SET_VERSION).toBe("transcript-extraction-fixtures.13.5");
    expect(TRANSCRIPT_EXTRACTION_FIXTURES).toHaveLength(46);
    for (const locale of ["en-SG", "zh-SG"]) {
      const inLocale = TRANSCRIPT_EXTRACTION_FIXTURES.filter((fixture) => fixture.locale === locale);
      expect(inLocale, locale).toHaveLength(locale === "en-SG" ? 24 : 22);
      const probes = new Set(inLocale.map((fixture) => fixture.probe));
      expect([...probes].sort()).toEqual(["AMBIGUOUS_NUMBER", "DOSE_QUESTION", "HEALTH_QUESTION", "MIXED", "NEGATION", "NUMBER_WORDS", "PLANNED", "PLANNED_VS_TAKEN", "REPORTED_AMOUNT", "SKIPPED", "TAKEN", "UNCERTAINTY", "UNIT", "UNRESOLVED", "UNSUPPORTED"]);
      // Remote coverage: every class except the withheld-only ones (dose, health, reported amount) has a sent fixture in each locale.
      const sentProbes = new Set(inLocale.filter((fixture) => fixture.expect === "EXTRACT").map((fixture) => fixture.probe));
      expect([...sentProbes].sort(), locale).toEqual(["AMBIGUOUS_NUMBER", "MIXED", "NEGATION", "NUMBER_WORDS", "PLANNED", "PLANNED_VS_TAKEN", "SKIPPED", "TAKEN", "UNCERTAINTY", "UNIT", "UNRESOLVED", "UNSUPPORTED"]);
    }
    expect(new Set(TRANSCRIPT_EXTRACTION_FIXTURES.map((fixture) => fixture.id)).size).toBe(46);
  });
});

describe("Packet 13 offline evaluation (fake providers)", () => {
  it("a golden fake meets every draft threshold; dose questions and withheld transcripts make zero calls; 24 calls are bounded", async () => {
    const calls: string[] = [];
    const { scores, summary } = await runOfflineEvaluation(async (_request, fixture) => (calls.push(fixture.id), completed(goldenOutput(fixture as ExtractionFixture & { expect: "EXTRACT" }))));
    expect(scores.filter((score) => score.verdict === "FAIL").map((score) => `${score.id}:${score.mismatches.join(",")}`)).toEqual([]);
    expect(summary).toMatchObject({ fixtures: 46, calls: 24, withheld: 10, acceptanceRate: 1, exactMatchRate: 1, criticalPassRate: 1, redirectCaughtRate: 1, decision: "MEETS_DRAFT_THRESHOLDS", failures: [] });
    expect(calls.some((id) => id.includes("dose"))).toBe(false);
    // The 13s.3 gate withholds question forms, mixed health questions and any spoken amount (mg, units, 两片, 十个单位).
    const WITHHELD_IDS = ["en.mgdl", "en.skipped-word", "en.unsupported-question", "en.health-mixed", "en.amount-reported", "en.or-not", "zh.mgdl", "zh.mixed-amount", "zh.health-mixed", "zh.amount-reported"];
    expect(scores.filter((score) => score.outcome === "WITHHELD").map((score) => score.id)).toEqual(WITHHELD_IDS);
    for (const id of WITHHELD_IDS) expect(calls).not.toContain(id);
    // Mapped to voice-contract.13s.3: no mg/dL reading or reported amount is ever sent, so nothing is downgraded to UNSUPPORTED_SPAN.
    expect(summary.downgradedToUnsupported).toBe(0);
    // Live-proposal input: the FULL run's worst-case spend (24 calls, each at its exact body's upper bound).
    expect([summary.upperBoundMicroUsd, Math.max(...scores.map((score) => score.upperBoundMicroUsd))]).toEqual([75_754, 3_167]);
  });

  it("a gate that stops withholding a WITHHELD fixture fails the run", async () => {
    const fixture = TRANSCRIPT_EXTRACTION_FIXTURES.find((entry) => entry.id === "en.unsupported-question")!;
    const score = await scoreFixture({ ...fixture, transcript: "Play some music" }, async () => completed({ facts: [], unsupportedSpans: [] }));
    expect(score).toMatchObject({ calls: 0, outcome: "WITHHOLD_MISSED", verdict: "FAIL", mismatches: ["WITHHOLD_MISSED"] });
  });

  const adversarial: [string, string, (golden: ExtractionOutput) => unknown, string][] = [
    ["invents a unit", "en.words", (g) => ({ ...g, facts: [{ ...g.facts[0], unit: "MMOL_PER_L" }] }), "REJECTED:UNIT_NOT_IN_SPAN"],
    ["invents a dose", "en.taken", (g) => ({ ...g, facts: [{ ...g.facts[0], value: "10", unit: "UNITS" }] }), "REJECTED:VALUE_NOT_IN_SPAN"],
    ["drops the negation", "en.negated-meal", (g) => ({ ...g, facts: [{ ...g.facts[0], negated: false }] }), "REJECTED:NEGATION_NOT_PRESERVED"],
    ["drops the negation (zh)", "zh.negated-meal", (g) => ({ ...g, facts: [{ ...g.facts[0], negated: false }] }), "REJECTED:NEGATION_NOT_PRESERVED"],
    ["turns a plan into TAKEN", "en.planned", (g) => ({ ...g, facts: [{ ...g.facts[0], status: "TAKEN" }] }), "REJECTED:TAKEN_WITH_PLANNED"],
    ["turns a plan into TAKEN (zh)", "zh.planned", (g) => ({ ...g, facts: [{ ...g.facts[0], status: "TAKEN" }] }), "REJECTED:TAKEN_WITH_PLANNED"],
    ["names a medicine from a colour", "en.taken", (g) => ({ ...g, facts: [{ ...g.facts[0], unresolvedPhrase: "insulin glargine" }] }), "REJECTED:UNRESOLVED_NOT_IN_SPAN"],
    ["silently drops the unsupported part", "en.mixed", (g) => ({ ...g, unsupportedSpans: [] }), "REJECTED:CONTENT_NOT_ACCOUNTED"],
    ["silently drops unsupported speech (zh)", "zh.unsupported", () => ({ facts: [], unsupportedSpans: [] }), "REJECTED:CONTENT_NOT_ACCOUNTED"],
    ["claims certainty about an ambiguous number", "en.ambiguous", () => ({ facts: [{ kind: "GLUCOSE_READING", sourceSpan: { start: 0, end: 28, text: "Sugar six or seven, not sure" }, value: "6", unit: null, status: null, negated: false, uncertain: false, unresolvedPhrase: null }], unsupportedSpans: [] }), "REJECTED:UNCERTAINTY_NOT_PRESERVED"],
    ["adds free-text advice", "en.unit", (g) => ({ ...g, advice: "Eat less rice" }), "REJECTED:SCHEMA_INVALID"],
    ["returns prose instead of JSON", "zh.unit", () => "血糖正常", "REJECTED:SCHEMA_INVALID"],
    ["loses the status (valid but wrong)", "en.planned", (g) => ({ ...g, facts: [{ ...g.facts[0], status: "UNKNOWN" }] }), "MISSING:MEDICINE_OCCURRENCE"],
  ];
  for (const [name, id, mutate, expected] of adversarial) {
    it(`catches a model that ${name} (${id})`, async () => {
      const fixture = extractFixture(id);
      const score = await scoreFixture(fixture, async () => completed(mutate(goldenOutput(fixture))));
      expect(score.verdict).toBe("FAIL");
      expect(score.mismatches).toContain(expected);
    });
  }

  it("a provider failure or a stored response fails the fixture, and the summary falls below the thresholds", async () => {
    const { summary } = await runOfflineEvaluation(async (_request, fixture) =>
      fixture.id === "en.unit" ? { kind: "FAILED", reason: "PROVIDER_TIMEOUT", usage: { inputTokens: null, outputTokens: null, costMicroUsd: 5_000, basis: "UPPER_BOUND" } } : fixture.id === "zh.unit" ? { ...completed({}), retention: "PROVIDER_REPORTED_STORED" } : completed(goldenOutput(fixture as ExtractionFixture & { expect: "EXTRACT" })),
    );
    expect(summary.decision).toBe("BELOW_DRAFT_THRESHOLDS");
    expect(summary.failures).toContain("PROVIDER_FAILURES");
  });

  it("the FULL policy is a draft for the owner: one call per fixture, no retry or repair", () => {
    expect(TRANSCRIPT_EXTRACTION_FULL_POLICY).toMatchObject({ version: "transcript-extraction-full-policy.13.1", status: "DRAFT_NOT_APPROVED", callsPerFixture: 1, retries: 0, repairs: 0 });
  });
});
