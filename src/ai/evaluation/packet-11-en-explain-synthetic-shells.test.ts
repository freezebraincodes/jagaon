import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AI_HYBRID_RUNTIME_BUNDLES } from "@/application/ai/ai-hybrid-runtime-bundles";
import { verifyComposition } from "@/application/ai/language/assembler";
import { atomMultiset } from "@/application/ai/language/deterministic-composition";
import { meaningfulWording } from "@/application/ai/language/shell-validator";
import { VALIDATOR_RULES_REVISION } from "./packet-11-evaluation";
import { PACKET_11_HYBRID_FIXTURES } from "./packet-11-hybrid-fixtures";
import { buildHybridHumanReview } from "./packet-11-hybrid-human-review";
import { EN_EXPLAIN_SYNTHETIC_LABEL, EN_EXPLAIN_SYNTHETIC_SHELLS, enExplainSyntheticCompositions, enExplainSyntheticReviewEntries } from "./packet-11-en-explain-synthetic-shells";
import { ZH_EXPLAIN_SYNTHETIC_SHELLS } from "./packet-11-zh-explain-synthetic-shells";

/**
 * SYNTHETIC wording examples for the prompt 11b.17 en-SG EXPLAIN guidance (owner instruction 2026-10-07, offline only). Every shell is
 * hand-written for this test: not provider output, not qualification evidence, nothing copied from a stored trace. Each set goes through
 * the real shell gates (S1–S7b), the assembler and the unchanged r7 composition verifier.
 */
const SHAPES: ReadonlyArray<readonly [string, "B" | "C" | "D"]> = [
  ["abstention", "B"],
  ["invalid-reference", "C"], ["prompt-injection", "C"], ["forbidden-medication-action", "C"], ["forbidden-dose", "C"], ["forbidden-adherence", "C"], ["forbidden-authority", "C"],
  ["forbidden-cause", "D"],
];
const INSPECTED = SHAPES.map(([name]) => `p11.explain-pattern.en-sg.${name}`);
/** The brief's linking wording between slots (test-only check on the model-written shells; the atoms are patient data). */
const LINKING = /\b(for|noted under|under|linked|related|because|due to|corresponds?)\b/i;
/** Wider: other words that would relate one recorded fact to another. */
const RELATING = /\b(link\w*|relat\w*|correspond\w*|caus\w*|associat\w*|tied|paired|along with|together with|with|after|before|during|while|regarding|about|belong\w*|goes with|go with)\b/i;

describe(`en-SG EXPLAIN wording examples for prompt 11b.17 (${EN_EXPLAIN_SYNTHETIC_LABEL})`, () => {
  const examples = enExplainSyntheticCompositions();

  it("covers exactly the 7 shape-C/D en-SG EXPLAIN fixtures and en abstention (shape B), each labelled SYNTHETIC; the zh examples stay 13", () => {
    expect(EN_EXPLAIN_SYNTHETIC_LABEL).toBe("SYNTHETIC");
    expect(EN_EXPLAIN_SYNTHETIC_SHELLS.map((entry) => entry.fixtureId)).toEqual(INSPECTED);
    expect(examples.map((entry) => entry.fixtureId)).toEqual(INSPECTED);
    for (const [index, example] of examples.entries()) {
      expect(example.label, example.fixtureId).toBe("SYNTHETIC");
      const fixture = PACKET_11_HYBRID_FIXTURES.find((entry) => entry.id === example.fixtureId)!;
      expect(fixture.taskType).toBe("EXPLAIN_PATTERN");
      expect(fixture.request.locale).toBe("en-SG");
      // The value-blind shape: B = two DATE slots, C = DECIMAL_LIST + one LABEL, D = DECIMAL_LIST + two LABEL slots.
      const kinds = example.observationAtomKinds.join(",");
      expect(kinds, example.fixtureId).toBe({ B: "DATE,DATE", C: "DECIMAL_LIST,LABEL", D: "DECIMAL_LIST,LABEL,LABEL" }[SHAPES[index]![1]]);
    }
    expect(ZH_EXPLAIN_SYNTHETIC_SHELLS).toHaveLength(13);
  });

  it.each(INSPECTED)("%s: passes S1–S7b, assembles, passes the unchanged r7 verifier and keeps every atom byte-identical to the deterministic composition", (fixtureId) => {
    expect(VALIDATOR_RULES_REVISION).toBe("11b.2-meaning-r7");
    const example = examples.find((entry) => entry.fixtureId === fixtureId)!;
    expect(example.shellGate).toEqual({ kind: "VALID" });
    expect(example.verify).toBe("ACCEPTED");
    const composition = example.composition!;
    const fixture = PACKET_11_HYBRID_FIXTURES.find((entry) => entry.id === fixtureId)!;
    expect(verifyComposition(fixture.request, AI_HYBRID_RUNTIME_BUNDLES.EXPLAIN_PATTERN, composition).kind).toBe("ACCEPTED");
    expect(example.atomEqual).toBe(true);
    expect(atomMultiset(composition)).toEqual(atomMultiset(example.deterministic));
    for (const [path, field] of composition.fields) {
      for (const span of field.spans) expect(field.text.slice(span.start, span.end), `${path} ${span.slotId}`).toBe(example.atoms[span.slotId]!.text);
    }
    expect(composition).toMatchObject({ taskType: "EXPLAIN_PATTERN", locale: "en-SG" });
  });

  it.each(INSPECTED)("%s: every field is a complete neutral sentence with real wording; the observation is no fragment and links no slot to another", (fixtureId) => {
    const shells = EN_EXPLAIN_SYNTHETIC_SHELLS.find((entry) => entry.fixtureId === fixtureId)!;
    for (const field of ["headline", "observation", "evidence"] as const) {
      const text = shells[field];
      expect(text, field).toMatch(/\.$/);
      expect(meaningfulWording(text, "en-SG"), `${field}: ${text}`).toBe(true);
      expect(text, field).not.toMatch(LINKING);
      // No value, unit, date or count of its own (the tokens aside).
      expect(text.replace(/\{\{S\d+\}\}/g, ""), field).not.toMatch(/[0-9]|\b(one|two|both|twice|several|once|today|week|month|mmol|mg)\b/i);
    }
    expect(shells.observation, "observation").not.toMatch(RELATING);
    // The text before the first token is not a bare label or lead-in (the default "Recorded values:" shape, "In your records,").
    expect(shells.observation.split("{{S")[0]).not.toMatch(/[,:;]\s*$/);
    expect(shells.observation).not.toMatch(/^(In|From|Within) your (records|entries|journal)[,:]?\s*\{\{S/i);
  });

  it("varies naturally: no single observation, headline or evidence template", () => {
    const distinct = (field: "headline" | "observation" | "evidence") => new Set(EN_EXPLAIN_SYNTHETIC_SHELLS.map((entry) => entry[field].replace(/\{\{S\d+\}\}/g, "{{S}}"))).size;
    expect(distinct("observation")).toBeGreaterThanOrEqual(7);
    expect(distinct("headline")).toBeGreaterThanOrEqual(3);
    expect(distinct("evidence")).toBeGreaterThanOrEqual(3);
  });

  it("exports the 8 assembled synthetic compositions for the review page (all accepted AI items, none excluded, no token text)", () => {
    const entries = enExplainSyntheticReviewEntries();
    expect(entries.map((entry) => entry.fixture.id)).toEqual(INSPECTED);
    const review = buildHybridHumanReview(entries, { generatedAt: "2026-10-07T00:00:00.000Z" });
    expect(review).toMatchObject({ included: 8, excluded: 0, fallbacks: 0 });
    expect(review.items.every((item) => item.source === "AI" && item.locale === "en-SG" && item.taskType === "EXPLAIN_PATTERN")).toBe(true);
    expect(review.html).not.toMatch(/\{\{S\d+\}\}/);
  });

  it("the helper is evaluation-only and network-free (no provider, tracer, environment, fetch, URL or file write)", () => {
    const source = readFileSync(join(process.cwd(), "src/ai/evaluation/packet-11-en-explain-synthetic-shells.ts"), "utf8");
    expect(source).not.toMatch(/@\/ai\/kie|@\/ai\/deepseek|packet-11-hybrid-live-diagnostic|packet-11-hybrid-human-review|fetch\s*\(|https?:\/\/|process\.env|test-results|writeFile/);
    expect(source).toMatch(/SYNTHETIC/);
  });
});
