import { describe, expect, it } from "vitest";
import { validateAiTaskOutput } from "@/application/ai/ai-output-validator";
import { AI_TASK_RUNTIME_BUNDLES } from "@/application/ai/ai-runtime-bundles";
import type { AiTaskRequest } from "@/domain/ai";
import { outputFixture } from "@/domain/ai/ai-test-fixtures";
import { conformsToStrictSchema } from "./packet-11-evaluation";
import { PACKET_11_FIXTURES } from "./packet-11-fixtures";
import { diagnoseSchemaFailure } from "./packet-11-schema-diagnostics";

/**
 * Validator rules r7 (owner instruction 2026-10-06). The direct DeepSeek full run failed a zh-SG fixture for the
 * digit "2" (a count of the supplied readings) while English "two readings" and Chinese "一条" passed, because the
 * no-new-numbers rule read digits only. A spelled-out cardinal attached to a count noun (English) or a measure word
 * (Chinese) is now a number too, and fails fidelity unless that number is supplied. Verbatim patient text stays
 * exempt; ordinals, pronoun "one", idioms and the Chinese indefinite article 一个 are not counts. Strict JSON parsing
 * is unchanged: no trailing-character trimming or repair.
 */

type Locale = "en-SG" | "zh-SG";
type Candidate = Record<string, any>;
const explainFixture = (locale: Locale) => PACKET_11_FIXTURES.find((fixture) => fixture.id === `p11.explain-pattern.${locale.toLowerCase()}.ordinary`)!;
const careFixture = (locale: Locale) => PACKET_11_FIXTURES.find((fixture) => fixture.id === `p11.draft-care-preparation-summary.${locale.toLowerCase()}.ordinary`)!;
// EXPLAIN ordinary supplies 6.2 and 7.1 mmol/L and an evidence count of 10.
function explain(locale: Locale, sentence: string, request: AiTaskRequest = explainFixture(locale).request): unknown {
  const factRefs = (request.facts as Array<{ ref: string }>).map((fact) => fact.ref);
  const count = (request.facts as Array<{ value: { kind: string; value: unknown } }>).find((fact) => fact.value.kind === "COUNT")!.value.value;
  const output: Candidate = {
    schemaVersion: "ai-output.explain-pattern@11b.1",
    taskType: "EXPLAIN_PATTERN",
    outcome: "SUCCESS",
    locale,
    inputRefsUsed: ["claim-1", ...factRefs],
    payload: {
      headline: { text: locale === "en-SG" ? "Recent recorded values were 6.2 and 7.1 mmol/L." : "最近记录的数值为 6.2 和 7.1 mmol/L。", claimRefs: ["claim-1"] },
      observation: { text: sentence, claimRefs: ["claim-1"] },
      evidence: { text: locale === "en-SG" ? `This uses ${count} recorded readings.` : `这基于 ${count} 条记录读数。`, factRefs },
    },
  };
  return validateAiTaskOutput(request, AI_TASK_RUNTIME_BUNDLES.EXPLAIN_PATTERN, output);
}
function withCount(locale: Locale, count: number): AiTaskRequest {
  const request = structuredClone(explainFixture(locale).request) as AiTaskRequest;
  (request.facts as Array<{ value: { kind: string; value: unknown } }>).find((fact) => fact.value.kind === "COUNT")!.value.value = count;
  return request;
}
const REJECTED = { kind: "REJECTED", reason: "FACT_FIDELITY_FAILED", repairable: false };

describe("r7: an unsupplied spelled-out count fails fidelity", () => {
  it.each([
    ["en-SG", "Recent values came from two readings of 6.2 and 7.1 mmol/L."],
    ["en-SG", "Values of 6.2 and 7.1 mmol/L were compared across two periods."],
    ["en-SG", "Two Readings were recorded: 6.2 and 7.1 mmol/L."],
    ["en-SG", "The values 6.2 and 7.1 mmol/L span three recorded days."],
    ["en-SG", "One reading was 6.2 mmol/L and another was 7.1 mmol/L."],
    ["zh-SG", "最近记录了一条 6.2 mmol/L 的读数和一条 7.1 mmol/L 的读数。"],
    ["zh-SG", "两次记录的数值为 6.2 和 7.1 mmol/L。"],
    ["zh-SG", "三个读数中包括 6.2 和 7.1 mmol/L。"],
    ["zh-SG", "数值 6.2 和 7.1 mmol/L 来自 2 次记录。"],
  ] as const)("%s: %s", (locale, sentence) => {
    expect(explain(locale, sentence)).toEqual(REJECTED);
  });
});

describe("r7 false-positive controls", () => {
  it.each([
    ["en-SG", "Recent recorded values were 6.2 and 7.1 mmol/L."],
    ["zh-SG", "最近记录的数值为 6.2 和 7.1 mmol/L。"],
  ] as const)("%s: supplied numeric facts and decimal values are accepted", (locale, sentence) => {
    expect(explain(locale, sentence)).toMatchObject({ kind: "ACCEPTED" });
  });

  it.each([
    ["en-SG", "These values come from ten recorded readings."],
    ["zh-SG", "这些数值来自十条记录读数。"],
  ] as const)("%s: a spelled-out count equal to the supplied evidence count (10) is accepted", (locale, sentence) => {
    expect(explain(locale, sentence)).toMatchObject({ kind: "ACCEPTED" });
  });

  it.each([
    ["en-SG", "The two readings were 6.2 and 7.1 mmol/L."],
    ["zh-SG", "两次记录的数值为 6.2 和 7.1 mmol/L。"],
  ] as const)("%s: a count that is explicitly supplied (evidence count 2) is accepted", (locale, sentence) => {
    expect(explain(locale, sentence, withCount(locale, 2))).toMatchObject({ kind: "ACCEPTED" });
  });

  it.each([
    ["en-SG", "Of the recorded values, the earlier one was 6.2 mmol/L and the later one was 7.1 mmol/L."],
    ["en-SG", "One of the recorded values was 6.2 mmol/L; the other was 7.1 mmol/L."],
    ["en-SG", "Each one of the recorded values is listed: 6.2 and 7.1 mmol/L."],
    ["en-SG", "The first recorded value was 6.2 mmol/L and the second was 7.1 mmol/L."],
    ["zh-SG", "第一次记录的数值为 6.2 mmol/L，之后为 7.1 mmol/L。"],
    ["zh-SG", "一些记录的数值为 6.2 和 7.1 mmol/L。"],
    ["zh-SG", "这是一个关于 6.2 和 7.1 mmol/L 的记录比较。"],
    ["zh-SG", "一段时间内记录的数值为 6.2 和 7.1 mmol/L。"],
  ] as const)("%s non-count idiom, ordinal or article: %s", (locale, sentence) => {
    expect(explain(locale, sentence)).toMatchObject({ kind: "ACCEPTED" });
  });

  it.each([
    ["en-SG", "Should I check two readings each day? (demo)"],
    ["zh-SG", "我每天要测两次吗？(演示)"],
  ] as const)("%s: a spelled-out count inside the verbatim patient question is exempt, but not outside it", (locale, question) => {
    const fixture = careFixture(locale);
    const request = structuredClone(fixture.request) as AiTaskRequest;
    (request.facts as Array<{ ref: string; value: { text?: string } }>).find((fact) => fact.ref === "fact-2")!.value.text = question;
    const value = (request.facts as Array<{ ref: string; value: { value?: string } }>).find((fact) => fact.ref === "fact-1")!.value.value;
    const output = structuredClone(outputFixture("DRAFT_CARE_PREPARATION_SUMMARY")) as Candidate;
    output.locale = locale;
    output.payload.sections[0].bullets[0].text = locale === "en-SG" ? `A reading of ${value} mmol/L was recorded.` : `记录了 ${value} mmol/L 的读数。`;
    output.payload.sections[1].bullets[0].text = question;
    expect(validateAiTaskOutput(request, AI_TASK_RUNTIME_BUNDLES.DRAFT_CARE_PREPARATION_SUMMARY, output)).toMatchObject({ kind: "ACCEPTED" });
    output.payload.sections[0].bullets[0].text = locale === "en-SG" ? `Two readings of ${value} mmol/L were recorded.` : `记录了两次 ${value} mmol/L 的读数。`;
    expect(validateAiTaskOutput(request, AI_TASK_RUNTIME_BUNDLES.DRAFT_CARE_PREPARATION_SUMMARY, output)).toEqual(REJECTED);
  });
});

describe("r7 compares a spelled-out count with supplied counts and numeric values only", () => {
  it.each([
    ["en-SG", "The recorded values came from two readings: 6.2 and 7.1 mmol/L."],
    ["zh-SG", "两次记录的数值为 6.2 和 7.1 mmol/L。"],
  ] as const)("%s: a date component that happens to equal the number (02) does not make the count supplied", (locale, sentence) => {
    const request = structuredClone(explainFixture(locale).request) as AiTaskRequest;
    const facts = request.facts as Array<Record<string, unknown>>;
    facts.push({ ...facts[0], ref: "fact-9", field: "OCCURRENCE_TIME", value: { kind: "DATE", localDate: "2026-10-02" } });
    (request.taskPayload as { claim: { factRefs: string[] } }).claim.factRefs.push("fact-9");
    expect(explain(locale, sentence, request)).toEqual(REJECTED);
  });
});

describe("strict parsing is unchanged: no trimming or repair of trailing characters", () => {
  it.each(["en-SG", "zh-SG"] as const)("%s: a valid object followed by an extra } is SCHEMA_INVALID at the root", (locale) => {
    const fixture = explainFixture(locale);
    const body: Candidate = { ...(outputFixture("EXPLAIN_PATTERN") as Candidate), locale };
    if (locale === "zh-SG") for (const key of ["headline", "observation", "evidence"]) body.payload[key].text = "最近记录的数值为 6.2 和 7.1 mmol/L。";
    expect(validateAiTaskOutput(fixture.request, AI_TASK_RUNTIME_BUNDLES.EXPLAIN_PATTERN, JSON.stringify(body))).toMatchObject({ kind: "ACCEPTED" });
    const withExtraBrace = `${JSON.stringify(body)}}`;
    expect(validateAiTaskOutput(fixture.request, AI_TASK_RUNTIME_BUNDLES.EXPLAIN_PATTERN, withExtraBrace)).toMatchObject({ kind: "REJECTED", reason: "SCHEMA_INVALID" });
    expect(conformsToStrictSchema(fixture, withExtraBrace)).toBe(false);
    expect(diagnoseSchemaFailure(fixture, withExtraBrace)?.findings).toEqual([{ category: "ROOT_TYPE_INVALID", path: "$", rule: "strict_json", count: 1, boundary: null }]);
  });
});
