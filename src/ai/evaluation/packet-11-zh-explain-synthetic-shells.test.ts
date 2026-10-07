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
import { ZH_EXPLAIN_SYNTHETIC_LABEL, ZH_EXPLAIN_SYNTHETIC_SHELLS, zhExplainSyntheticCompositions, zhExplainSyntheticReviewEntries } from "./packet-11-zh-explain-synthetic-shells";

/**
 * SYNTHETIC wording examples for the prompt 11b.16 zh-SG EXPLAIN guidance (owner instruction 2026-10-07, offline only). Every shell
 * below is hand-written for this test: it is not provider output and not qualification evidence, and no text is copied from any
 * stored trace. Each set goes through the real shell gates (S1–S7b), the assembler and the unchanged r7 composition verifier.
 */
const INSPECTED = [
  // Owner-failed in the original FULL review (fragments with no predicate).
  "abstention", "changed-number-unit", "forbidden-classification", "forbidden-prediction", "forbidden-diagnosis", "forbidden-triage",
  // Recovered after the r8 checker fix (unsupported reading-to-item link).
  "invalid-reference", "prompt-injection", "forbidden-medication-action", "forbidden-dose", "forbidden-adherence", "forbidden-authority", "forbidden-cause",
].map((name) => `p11.explain-pattern.zh-sg.${name}`);
/** The guidance's linking terms plus near synonyms that would also relate one slot to another. */
const LINKING = /对应|分别|由于|因为|所以|因此|导致|引起|属于|同期|伴随|相应|针对/;
/** The inspected fragment shapes: a locative or label lead-in and then the values, with no verb of its own. */
const FRAGMENT = /^(在)?(您的)?记录(的数值)?(中|里|当中)?[，,：:]?\{\{S\d+\}\}/;

describe(`zh-SG EXPLAIN wording examples for prompt 11b.16 (${ZH_EXPLAIN_SYNTHETIC_LABEL})`, () => {
  const examples = zhExplainSyntheticCompositions();

  it("covers exactly the 13 inspected zh-SG EXPLAIN fixtures, each labelled SYNTHETIC", () => {
    expect(ZH_EXPLAIN_SYNTHETIC_LABEL).toBe("SYNTHETIC");
    expect(ZH_EXPLAIN_SYNTHETIC_SHELLS.map((entry) => entry.fixtureId)).toEqual(INSPECTED);
    expect(examples.map((entry) => entry.fixtureId)).toEqual(INSPECTED);
    for (const example of examples) {
      expect(example.label, example.fixtureId).toBe("SYNTHETIC");
      const fixture = PACKET_11_HYBRID_FIXTURES.find((entry) => entry.id === example.fixtureId)!;
      expect(fixture.taskType).toBe("EXPLAIN_PATTERN");
      expect(fixture.request.locale).toBe("zh-SG");
    }
  });

  it.each(INSPECTED)("%s: passes S1–S7b, assembles, passes the unchanged r7 verifier and keeps every atom byte-identical to the deterministic composition", (fixtureId) => {
    expect(VALIDATOR_RULES_REVISION).toBe("11b.2-meaning-r7");
    const example = examples.find((entry) => entry.fixtureId === fixtureId)!;
    expect(example.shellGate).toEqual({ kind: "VALID" });
    expect(example.verify).toBe("ACCEPTED");
    const composition = example.composition!;
    const fixture = PACKET_11_HYBRID_FIXTURES.find((entry) => entry.id === fixtureId)!;
    // Re-verified here with the production verifier, independently of the helper.
    expect(verifyComposition(fixture.request, AI_HYBRID_RUNTIME_BUNDLES.EXPLAIN_PATTERN, composition).kind).toBe("ACCEPTED");
    expect(example.atomEqual).toBe(true);
    expect(atomMultiset(composition)).toEqual(atomMultiset(example.deterministic));
    for (const [path, field] of composition.fields) {
      for (const span of field.spans) expect(field.text.slice(span.start, span.end), `${path} ${span.slotId}`).toBe(example.atoms[span.slotId]!.text);
    }
    expect(composition).toMatchObject({ taskType: "EXPLAIN_PATTERN", locale: "zh-SG" });
  });

  it.each(INSPECTED)("%s: every field is a complete neutral sentence with real wording; the observation is no fragment and links no slot to another", (fixtureId) => {
    const shells = ZH_EXPLAIN_SYNTHETIC_SHELLS.find((entry) => entry.fixtureId === fixtureId)!;
    for (const field of ["headline", "observation", "evidence"] as const) {
      const text = shells[field];
      expect(text, field).toMatch(/。$/);
      expect(meaningfulWording(text, "zh-SG"), `${field}: ${text}`).toBe(true);
      expect(text, field).not.toMatch(LINKING);
      // No value, unit, date or count of its own (the tokens aside), and the 您 register.
      expect(text.replace(/\{\{S\d+\}\}/g, ""), field).not.toMatch(/[0-9０-９]|你|两|几|一|[日月年]|mmol|mg/);
    }
    expect(shells.observation).not.toMatch(FRAGMENT);
    // The text before the first token is not a bare lead-in that ends in punctuation.
    expect(shells.observation.split("{{S")[0]).not.toMatch(/[，,：:]$/);
    const assembled = examples.find((entry) => entry.fixtureId === fixtureId)!.composition!;
    for (const [path, field] of assembled.fields) expect(field.text, path).not.toMatch(/对应|分别对应|由于/);
  });

  it("varies naturally: no single observation, headline or evidence template", () => {
    const distinct = (field: "headline" | "observation" | "evidence") => new Set(ZH_EXPLAIN_SYNTHETIC_SHELLS.map((entry) => entry[field])).size;
    expect(distinct("observation")).toBeGreaterThanOrEqual(10);
    expect(distinct("headline")).toBeGreaterThanOrEqual(3);
    expect(distinct("evidence")).toBeGreaterThanOrEqual(3);
  });

  it("exports the 13 assembled synthetic compositions for the review page (all accepted AI items, none excluded, no token text)", () => {
    const entries = zhExplainSyntheticReviewEntries();
    expect(entries.map((entry) => entry.fixture.id)).toEqual(INSPECTED);
    const review = buildHybridHumanReview(entries, { generatedAt: "2026-10-07T00:00:00.000Z" });
    expect(review).toMatchObject({ included: 13, excluded: 0, fallbacks: 0 });
    expect(review.items.every((item) => item.source === "AI" && item.locale === "zh-SG" && item.taskType === "EXPLAIN_PATTERN")).toBe(true);
    expect(review.html).not.toMatch(/\{\{S\d+\}\}/);
  });

  it("the helper is evaluation-only and network-free (no provider, tracer, environment, fetch, URL or file write)", () => {
    const source = readFileSync(join(process.cwd(), "src/ai/evaluation/packet-11-zh-explain-synthetic-shells.ts"), "utf8");
    expect(source).not.toMatch(/@\/ai\/kie|@\/ai\/deepseek|packet-11-hybrid-live-diagnostic|packet-11-hybrid-human-review|fetch\s*\(|https?:\/\/|process\.env|test-results|writeFile/);
    expect(source).toMatch(/SYNTHETIC/);
  });
});
