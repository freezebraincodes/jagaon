import { describe, expect, it } from "vitest";
import { validateAiTaskOutput } from "@/application/ai/ai-output-validator";
import { AI_TASK_RUNTIME_BUNDLES } from "@/application/ai/ai-runtime-bundles";
import { providerOutputJsonSchema } from "@/ai/kie/kie-responses-contracts";
import { conformsToStrictSchema } from "./packet-11-evaluation";
import { PACKET_11_FIXTURES, type AiEvaluationFixture } from "./packet-11-fixtures";
import { diagnoseSchemaFailure } from "./packet-11-schema-diagnostics";

/**
 * Packet 11B duplicate-reference guard (owner instruction 2026-10-05). The
 * 11b.6 smoke stopped on p11.explain-pattern.zh-sg.ordinary: the model
 * repeated one fact reference in payload.evidence.factRefs and the local
 * validator rejected it as SCHEMA_INVALID / DUPLICATE_ITEM. These tests pin
 * that rejection for every structured reference array in both locales. They
 * guard existing behaviour: uniqueness, the validator and reference closure
 * are unchanged and no automatic repair is added.
 */

type Locale = "en-SG" | "zh-SG";
type Candidate = Record<string, any>;

const FIXTURE: Record<Locale, AiEvaluationFixture> = {
  "en-SG": PACKET_11_FIXTURES.find((fixture) => fixture.id === "p11.explain-pattern.en-sg.ordinary")!,
  "zh-SG": PACKET_11_FIXTURES.find((fixture) => fixture.id === "p11.explain-pattern.zh-sg.ordinary")!,
};
const TEXT: Record<Locale, { headline: string; observation: string; evidence: string }> = {
  "en-SG": { headline: "Recent recorded values were 6.2 and 7.1 mmol/L.", observation: "Recent recorded values were 6.2 and 7.1 mmol/L.", evidence: "This uses 10 recorded readings." },
  "zh-SG": { headline: "最近记录的数值为 6.2 和 7.1 mmol/L。", observation: "最近记录的数值为 6.2 和 7.1 mmol/L。", evidence: "这基于 10 条记录读数。" },
};
const candidate = (locale: Locale): Candidate => ({
  schemaVersion: "ai-output.explain-pattern@11b.1",
  taskType: "EXPLAIN_PATTERN",
  outcome: "SUCCESS",
  locale,
  inputRefsUsed: ["claim-1", "fact-1", "fact-2", "fact-3"],
  payload: {
    headline: { text: TEXT[locale].headline, claimRefs: ["claim-1"] },
    observation: { text: TEXT[locale].observation, claimRefs: ["claim-1"] },
    evidence: { text: TEXT[locale].evidence, factRefs: ["fact-1", "fact-2", "fact-3"] },
  },
});
const validate = (locale: Locale, output: unknown) => validateAiTaskOutput(FIXTURE[locale].request, AI_TASK_RUNTIME_BUNDLES.EXPLAIN_PATTERN, output);
const LOCALES: Locale[] = ["en-SG", "zh-SG"];

describe("baseline", () => {
  it.each(LOCALES)("the unique-reference %s candidate is accepted", (locale) => {
    expect(FIXTURE[locale]).toBeDefined();
    expect(validate(locale, candidate(locale))).toMatchObject({ kind: "ACCEPTED" });
  });
});

const ARRAYS = [
  { path: "payload.evidence.factRefs", duplicate: (output: Candidate) => output.payload.evidence.factRefs.push("fact-2") },
  { path: "payload.headline.claimRefs", duplicate: (output: Candidate) => output.payload.headline.claimRefs.push("claim-1") },
  { path: "payload.observation.claimRefs", duplicate: (output: Candidate) => output.payload.observation.claimRefs.push("claim-1") },
  { path: "inputRefsUsed", duplicate: (output: Candidate) => output.inputRefsUsed.splice(2, 0, "fact-1") },
] as const;
const CASES = LOCALES.flatMap((locale) => ARRAYS.map((array) => [locale, array.path, array] as const));

describe("duplicate references are rejected in every structured reference array", () => {
  it.each(CASES)("%s %s with one repeated reference is SCHEMA_INVALID / DUPLICATE_ITEM", (locale, path, array) => {
    const output = candidate(locale);
    array.duplicate(output);
    expect(validate(locale, output)).toMatchObject({ kind: "REJECTED", reason: "SCHEMA_INVALID" });
    expect(conformsToStrictSchema(FIXTURE[locale], output)).toBe(false);
    expect(diagnoseSchemaFailure(FIXTURE[locale], output)?.findings).toEqual([{ category: "DUPLICATE_ITEM", path, rule: "unique", count: 1, boundary: null }]);
  });

  it.each(LOCALES)("%s rejects a duplicate even when every reference is otherwise valid and in the inventory", (locale) => {
    // Same set of identifiers, so reference closure alone would pass: only uniqueness rejects it.
    const output = candidate(locale);
    output.payload.evidence.factRefs = ["fact-1", "fact-2", "fact-3", "fact-1"];
    expect(new Set(output.payload.evidence.factRefs)).toEqual(new Set(["fact-1", "fact-2", "fact-3"]));
    expect(validate(locale, output)).toMatchObject({ kind: "REJECTED", reason: "SCHEMA_INVALID" });
  });
});

describe("offline reproduction of the 11b.6 smoke stop (closed codes only)", () => {
  it("a zh-SG candidate shaped like the stored failure fails with exactly the recorded diagnostic", () => {
    // Shape recorded from the redacted trace: four evidence.factRefs entries with three unique,
    // unique claimRefs, and a unique four-entry inventory. No provider text is reproduced here.
    const output = candidate("zh-SG");
    output.payload.evidence.factRefs = ["fact-1", "fact-2", "fact-3", "fact-3"];
    expect(validate("zh-SG", output)).toMatchObject({ kind: "REJECTED", reason: "SCHEMA_INVALID" });
    expect(diagnoseSchemaFailure(FIXTURE["zh-SG"], output)?.findings).toEqual([{ category: "DUPLICATE_ITEM", path: "payload.evidence.factRefs", rule: "unique", count: 1, boundary: null }]);
  });
});

describe("the provider schema still declares uniqueness on every reference array", () => {
  it.each(LOCALES)("%s EXPLAIN_PATTERN schema marks claimRefs, factRefs and inputRefsUsed uniqueItems", (locale) => {
    const schema = providerOutputJsonSchema("EXPLAIN_PATTERN", locale) as { properties: { inputRefsUsed: { uniqueItems?: boolean }; payload: { anyOf: Array<{ properties?: Record<string, { properties: Record<string, { uniqueItems?: boolean }> }> }> } } };
    const success = schema.properties.payload.anyOf.find((variant) => variant.properties?.headline)!;
    expect(schema.properties.inputRefsUsed.uniqueItems).toBe(true);
    expect(success.properties!.headline!.properties.claimRefs!.uniqueItems).toBe(true);
    expect(success.properties!.observation!.properties.claimRefs!.uniqueItems).toBe(true);
    expect(success.properties!.evidence!.properties.factRefs!.uniqueItems).toBe(true);
  });
});
