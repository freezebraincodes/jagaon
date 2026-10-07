import { describe, expect, it } from "vitest";
import { validateAiTaskOutput } from "@/application/ai/ai-output-validator";
import { AI_TASK_RUNTIME_BUNDLES } from "@/application/ai/ai-runtime-bundles";
import { outputFixture } from "@/domain/ai/ai-test-fixtures";
import { PACKET_11_FIXTURES, type AiEvaluationFixture } from "./packet-11-fixtures";

/**
 * Packet 11B care-summary fidelity regression (owner instruction 2026-10-05). The 11b.7 smoke
 * stopped on p11.draft-care-preparation-summary.en-sg.ordinary with FACT_FIDELITY_FAILED. Offline
 * diagnosis of the stored trace (closed codes only): both bullets wrote their own section and fact
 * reference identifiers in visible text, bracketed (section inline, fact trailing). Rule r3
 * (VISIBLE_REFERENCE_ID) fails each bullet; the digits inside those identifiers also fail the
 * unsupplied-number rule, and none remains once the identifiers are removed. Units, percent,
 * verbatim question quotation and section/fact coverage all pass. These tests pin that the
 * unchanged validator rejects the shape and accepts the same output without the identifiers.
 */

type Locale = "en-SG" | "zh-SG";
type Candidate = Record<string, any>;

const FIXTURE: Record<Locale, AiEvaluationFixture> = {
  "en-SG": PACKET_11_FIXTURES.find((fixture) => fixture.id === "p11.draft-care-preparation-summary.en-sg.ordinary")!,
  "zh-SG": PACKET_11_FIXTURES.find((fixture) => fixture.id === "p11.draft-care-preparation-summary.zh-sg.ordinary")!,
};
const LOCALES: Locale[] = ["en-SG", "zh-SG"];
const fact = (locale: Locale, ref: string) => (FIXTURE[locale].request.facts as Array<{ ref: string; value: any }>).find((entry) => entry.ref === ref)!.value;
const reading = (locale: Locale) => (locale === "en-SG" ? `A reading of ${fact(locale, "fact-1").value} mmol/L was recorded.` : `记录了 ${fact(locale, "fact-1").value} mmol/L 的读数。`);
const candidate = (locale: Locale): Candidate => {
  const output = outputFixture("DRAFT_CARE_PREPARATION_SUMMARY") as Candidate;
  output.locale = locale;
  output.payload.sections[0].bullets[0].text = reading(locale);
  output.payload.sections[1].bullets[0].text = fact(locale, "fact-2").text;
  return output;
};
const validate = (locale: Locale, output: unknown) => validateAiTaskOutput(FIXTURE[locale].request, AI_TASK_RUNTIME_BUNDLES.DRAFT_CARE_PREPARATION_SUMMARY, output);
const withText = (locale: Locale, edit: (texts: [string, string]) => [string, string]) => {
  const output = candidate(locale);
  const [first, second] = edit([output.payload.sections[0].bullets[0].text, output.payload.sections[1].bullets[0].text]);
  output.payload.sections[0].bullets[0].text = first;
  output.payload.sections[1].bullets[0].text = second;
  return output;
};

describe("baseline", () => {
  it.each(LOCALES)("the identifier-free %s care summary is accepted", (locale) => {
    expect(FIXTURE[locale]).toBeDefined();
    expect(validate(locale, candidate(locale))).toMatchObject({ kind: "ACCEPTED" });
  });
});

// The discovered shape, rebuilt synthetically: each bullet names its own section inline and its own fact at the end, bracketed.
const LABEL: Record<Locale, [string, string]> = { "en-SG": ["Measurements", "Questions"], "zh-SG": ["测量", "问题"] };
const BRACKETS: Record<Locale, [string, string]> = { "en-SG": ["(", ")"], "zh-SG": ["（", "）"] };
const inlineSection = (locale: Locale, text: string, index: number) => `${LABEL[locale][index]} ${BRACKETS[locale][0]}section-${index + 1}${BRACKETS[locale][1]}: ${text}`;
const trailingFact = (locale: Locale, text: string, index: number) => `${text} ${BRACKETS[locale][0]}fact-${index + 1}${BRACKETS[locale][1]}`;
const discovered = (locale: Locale) => withText(locale, (texts) => texts.map((text, index) => trailingFact(locale, inlineSection(locale, text, index), index)) as [string, string]);

describe("own section and fact identifiers written into care bullet text are a fidelity hard gate", () => {
  it.each(LOCALES)("%s: the discovered shape (inline section ref + trailing fact ref in both bullets) is FACT_FIDELITY_FAILED, not repairable", (locale) => {
    expect(validate(locale, discovered(locale))).toEqual({ kind: "REJECTED", reason: "FACT_FIDELITY_FAILED", repairable: false });
  });

  const SINGLE = LOCALES.flatMap((locale) =>
    [0, 1].flatMap((index) => [
      [locale, `sections[${index}].bullets[0]`, "inline section identifier", (texts: [string, string]) => texts.map((text, at) => (at === index ? inlineSection(locale, text, at) : text)) as [string, string]] as const,
      [locale, `sections[${index}].bullets[0]`, "trailing fact identifier", (texts: [string, string]) => texts.map((text, at) => (at === index ? trailingFact(locale, text, at) : text)) as [string, string]] as const,
    ]),
  );
  it.each(SINGLE)("%s %s: a single %s is enough to reject", (locale, _path, _kind, edit) => {
    expect(validate(locale, withText(locale, edit))).toEqual({ kind: "REJECTED", reason: "FACT_FIDELITY_FAILED", repairable: false });
  });

  it.each(LOCALES)("%s: the verbatim patient question survives inside the rejected bullet, so the quotation is not the cause", (locale) => {
    const question = fact(locale, "fact-2").text as string;
    expect(discovered(locale).payload.sections[1].bullets[0].text).toContain(question);
  });

  it.each(LOCALES)("%s: removing only the identifiers (keeping labels, value, unit and question) is accepted", (locale) => {
    const stripped = withText(locale, (texts) => texts.map((text, index) => `${LABEL[locale][index]}: ${text}`) as [string, string]);
    expect(validate(locale, stripped)).toMatchObject({ kind: "ACCEPTED" });
  });
});
