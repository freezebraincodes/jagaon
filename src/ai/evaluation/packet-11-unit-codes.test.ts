import { describe, expect, it } from "vitest";
import { validateAiTaskOutput } from "@/application/ai/ai-output-validator";
import { AI_TASK_RUNTIME_BUNDLES } from "@/application/ai/ai-runtime-bundles";
import type { AiTaskRequest } from "@/domain/ai";
import { outputFixture } from "@/domain/ai/ai-test-fixtures";
import { PACKET_11_FIXTURES } from "./packet-11-fixtures";

/**
 * Validator rules r6 (owner instruction 2026-10-05). The 11b.8 full evaluation showed raw unit codes
 * (MMOL_L, MG_DL) in visible text in 56 of 70 outputs; zh-SG tripped LOCALE_INVALID only when several
 * code fragments landed in one field, and en-SG had no gate at all. A raw unit code is an internal
 * identifier, like a reference identifier (r3), so it fails fidelity in every generated field of both
 * tasks. Verbatim patient-authored text stays exempt. The display forms mmol/L and mg/dL are accepted.
 */

type Locale = "en-SG" | "zh-SG";
type Code = "MMOL_L" | "MG_DL";
type Candidate = Record<string, any>;
const LOCALES: Locale[] = ["en-SG", "zh-SG"];
const CODES: Code[] = ["MMOL_L", "MG_DL"];
const DISPLAY: Record<Code, string> = { MMOL_L: "mmol/L", MG_DL: "mg/dL" };

const fixture = (id: string) => PACKET_11_FIXTURES.find((entry) => entry.id === id)!;
const facts = (request: AiTaskRequest) => request.facts as Array<{ ref: string; field: string; value: any }>;

// EXPLAIN_PATTERN: the ordinary fixture supplies MMOL_L, the changed-number-unit fixture supplies MG_DL.
const explainRequest = (locale: Locale, code: Code) => fixture(`p11.explain-pattern.${locale.toLowerCase()}.${code === "MMOL_L" ? "ordinary" : "changed-number-unit"}`).request;
function explainOutput(locale: Locale, code: Code, unit: string): Candidate {
  const request = explainRequest(locale, code);
  const values = facts(request).filter((entry) => entry.value.kind === "DECIMAL");
  const count = facts(request).find((entry) => entry.value.kind === "COUNT")!;
  const factRefs = facts(request).map((entry) => entry.ref);
  const [first, second] = values.map((entry) => entry.value.value as string);
  const text = locale === "en-SG"
    ? { reading: `Recent recorded values were ${first} and ${second} ${unit}.`, evidence: `This uses ${count.value.value} recorded readings, including ${first} ${unit}.` }
    : { reading: `最近记录的数值为 ${first} 和 ${second} ${unit}。`, evidence: `这基于 ${count.value.value} 条记录读数，包括 ${first} ${unit}。` };
  return {
    schemaVersion: "ai-output.explain-pattern@11b.1",
    taskType: "EXPLAIN_PATTERN",
    outcome: "SUCCESS",
    locale,
    inputRefsUsed: ["claim-1", ...factRefs],
    payload: {
      headline: { text: text.reading, claimRefs: ["claim-1"] },
      observation: { text: text.reading, claimRefs: ["claim-1"] },
      evidence: { text: text.evidence, factRefs },
    },
  };
}

// DRAFT_CARE_PREPARATION_SUMMARY: the ordinary fixture, with the measurement re-labelled MG_DL for the MG_DL cases.
function careRequest(locale: Locale, code: Code, question?: string): AiTaskRequest {
  const request = structuredClone(fixture(`p11.draft-care-preparation-summary.${locale.toLowerCase()}.ordinary`).request) as AiTaskRequest;
  const entries = facts(request);
  entries.find((entry) => entry.ref === "fact-1")!.value.unit = code;
  if (question !== undefined) entries.find((entry) => entry.ref === "fact-2")!.value.text = question;
  return request;
}
function careOutput(request: AiTaskRequest, locale: Locale, unit: string, questionText?: string): Candidate {
  const value = facts(request).find((entry) => entry.ref === "fact-1")!.value.value as string;
  const output = outputFixture("DRAFT_CARE_PREPARATION_SUMMARY") as Candidate;
  output.locale = locale;
  output.payload.sections[0].bullets[0].text = locale === "en-SG" ? `A reading of ${value} ${unit} was recorded.` : `记录了 ${value} ${unit} 的读数。`;
  output.payload.sections[1].bullets[0].text = questionText ?? facts(request).find((entry) => entry.ref === "fact-2")!.value.text;
  return output;
}

const explain = (locale: Locale, code: Code, output: unknown) => validateAiTaskOutput(explainRequest(locale, code), AI_TASK_RUNTIME_BUNDLES.EXPLAIN_PATTERN, output);
const care = (request: AiTaskRequest, output: unknown) => validateAiTaskOutput(request, AI_TASK_RUNTIME_BUNDLES.DRAFT_CARE_PREPARATION_SUMMARY, output);
const REJECTED = { kind: "REJECTED", reason: "FACT_FIDELITY_FAILED", repairable: false };
const CASES = LOCALES.flatMap((locale) => CODES.map((code) => [locale, code] as const));

describe("controls: approved display forms are accepted", () => {
  it.each(CASES)("EXPLAIN_PATTERN %s with %s rendered as its display form", (locale, code) => {
    expect(explain(locale, code, explainOutput(locale, code, DISPLAY[code]))).toMatchObject({ kind: "ACCEPTED" });
  });
  it.each(CASES)("DRAFT_CARE_PREPARATION_SUMMARY %s with %s rendered as its display form", (locale, code) => {
    const request = careRequest(locale, code);
    expect(care(request, careOutput(request, locale, DISPLAY[code]))).toMatchObject({ kind: "ACCEPTED" });
  });
});

describe("r6: a raw unit code in generated text fails fidelity", () => {
  it.each(CASES)("EXPLAIN_PATTERN %s: raw %s in the generated text is rejected", (locale, code) => {
    expect(explain(locale, code, explainOutput(locale, code, code))).toEqual(REJECTED);
  });
  it.each(CASES)("DRAFT_CARE_PREPARATION_SUMMARY %s: raw %s in a bullet is rejected", (locale, code) => {
    const request = careRequest(locale, code);
    expect(care(request, careOutput(request, locale, code))).toEqual(REJECTED);
  });
  it.each(LOCALES)("EXPLAIN_PATTERN %s: one raw code in only the evidence field is enough", (locale) => {
    const output = explainOutput(locale, "MMOL_L", DISPLAY.MMOL_L);
    output.payload.evidence.text = output.payload.evidence.text.replace("mmol/L", "MMOL_L");
    expect(explain(locale, "MMOL_L", output)).toEqual(REJECTED);
  });
  it.each(LOCALES)("EXPLAIN_PATTERN %s: a case variant of the code is still a code", (locale) => {
    expect(explain(locale, "MMOL_L", explainOutput(locale, "MMOL_L", "Mmol_L"))).toEqual(REJECTED);
  });
});

describe("verbatim patient-authored text stays exempt", () => {
  const QUESTION: Record<Locale, string> = { "en-SG": "Is MMOL_L on the meter the same as mmol/L? (demo)", "zh-SG": "仪表上的 MMOL_L 和 mmol/L 一样吗？(演示)" };
  it.each(LOCALES)("%s: a question that contains a unit code and is copied exactly is accepted", (locale) => {
    const request = careRequest(locale, "MMOL_L", QUESTION[locale]);
    expect(care(request, careOutput(request, locale, DISPLAY.MMOL_L))).toMatchObject({ kind: "ACCEPTED" });
  });
  it.each(LOCALES)("%s: the same code outside the verbatim question is rejected", (locale) => {
    const request = careRequest(locale, "MMOL_L", QUESTION[locale]);
    const output = careOutput(request, locale, DISPLAY.MMOL_L);
    output.payload.sections[0].bullets[0].text = output.payload.sections[0].bullets[0].text.replace("mmol/L", "MMOL_L");
    expect(care(request, output)).toEqual(REJECTED);
  });
});

describe("standalone unit mentions (the packet11-eval.3 fixture 5 shape)", () => {
  // Stored failure: headline and evidence rendered mg/dL after each value; observation named the unit on its own, as a raw code.
  const STANDALONE: Record<Locale, Record<Code, string>> = {
    "en-SG": { MMOL_L: "These readings are recorded in MMOL_L.", MG_DL: "These readings are recorded in MG_DL." },
    "zh-SG": { MMOL_L: "这些读数以 MMOL_L 记录。", MG_DL: "这些读数以 MG_DL 记录。" },
  };
  it.each(CASES)("EXPLAIN_PATTERN %s: a raw %s named without a number is rejected even when every value uses the display form", (locale, code) => {
    const output = explainOutput(locale, code, DISPLAY[code]);
    output.payload.observation.text = STANDALONE[locale][code];
    expect(explain(locale, code, output)).toEqual(REJECTED);
  });
  it.each(CASES)("EXPLAIN_PATTERN %s: the display form of %s named without a number is accepted", (locale, code) => {
    const output = explainOutput(locale, code, DISPLAY[code]);
    output.payload.observation.text = STANDALONE[locale][code].replace(code, DISPLAY[code]);
    expect(explain(locale, code, output)).toMatchObject({ kind: "ACCEPTED" });
  });
});
