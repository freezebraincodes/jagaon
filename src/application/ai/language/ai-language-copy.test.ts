import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AI_ORGANISABLE_SECTIONS, GLOSS_KEYS } from "@/domain/ai";
import { AI_LANGUAGE_COPY, AI_LANGUAGE_COPY_REVISION, buildLanguageCopy } from "./ai-language-copy";

const clone = () => structuredClone(AI_LANGUAGE_COPY) as any;
/**
 * sha256 of JSON.stringify(ai-language-copy.11b.7) without `revision`, `careDraftNotices` and every item template (explainDefaults
 * items and each variant's items set to null), computed from the unchanged 11b.7 file before the presentation correction (2026-10-08).
 */
const COPY_11B7_WITHOUT_ITEMS_DIGEST = "248c8c21bc20283c9d39217c38a016ed912fe9e3821ea80247d1ca5f382d2bc3";
const withoutPresentation = (copy: unknown) => {
  const rest = structuredClone(copy) as any;
  delete rest.revision;
  delete rest.careDraftNotices;
  for (const locale of ["en-SG", "zh-SG"]) {
    rest.explainDefaults[locale].items = null;
    for (const variant of rest.explainObservationVariants[locale]) variant.items = null;
  }
  return rest;
};
describe("language copy ai-language-copy.11b.8", () => {
  it("pins the revision and the approved claim clauses", () => {
    expect(AI_LANGUAGE_COPY_REVISION).toBe("ai-language-copy.11b.8");
    expect(AI_LANGUAGE_COPY.claimClauses.COMPARABLE_SLOT_TREND).toEqual({ "en-SG": "your readings from the same time slot in an earlier and a recent period", "zh-SG": "同一时段在较早期间和近期的读数" });
  });
  it("has a gloss for every gloss key and an intro for every AI-organisable section, in both locales", () => {
    for (const key of GLOSS_KEYS) expect(Object.keys(AI_LANGUAGE_COPY.glosses[key]).sort()).toEqual(["en-SG", "zh-SG"]);
    expect(Object.keys(AI_LANGUAGE_COPY.careIntros).sort()).toEqual([...AI_ORGANISABLE_SECTIONS].sort());
  });
  it.each([
    ["a digit in a gloss", (c: any) => (c.glosses.RECORDED_VALUE["en-SG"] = "value 1"), "LANGUAGE_COPY_DIGIT"],
    ["a reference identifier", (c: any) => (c.careIntros.MEASUREMENTS["en-SG"] = "See fact-x:"), "LANGUAGE_COPY_REFERENCE"],
    ["English copy containing Chinese", (c: any) => (c.claimClauses.COMPARABLE_SLOT_TREND["en-SG"] = "读数"), "LANGUAGE_COPY_LOCALE_MISMATCH"],
    ["Chinese copy without Chinese", (c: any) => (c.careIntros.MEASUREMENTS["zh-SG"] = "Readings:"), "LANGUAGE_COPY_LOCALE_MISMATCH"],
    ["a default template missing its marker", (c: any) => (c.explainDefaults["en-SG"].values = "Recorded values."), "LANGUAGE_COPY_TEMPLATE_INVALID"],
    ["a wrong revision", (c: any) => (c.revision = "ai-language-copy.x"), "LANGUAGE_COPY_INVALID_REVISION"],
    ["the 11b.6 revision", (c: any) => (c.revision = "ai-language-copy.11b.6"), "LANGUAGE_COPY_INVALID_REVISION"],
    ["the 11b.7 revision", (c: any) => (c.revision = "ai-language-copy.11b.7"), "LANGUAGE_COPY_INVALID_REVISION"],
    // 11b.8: the care draft notices are checked like every other entry.
    ["a care draft notice with a digit", (c: any) => (c.careDraftNotices.draft["en-SG"] = "The app sends nothing within 2 days."), "LANGUAGE_COPY_DIGIT"],
    ["an English care draft notice in Chinese", (c: any) => (c.careDraftNotices.questions["en-SG"] = "问题按原话显示。"), "LANGUAGE_COPY_LOCALE_MISMATCH"],
    ["a Chinese care draft notice without Chinese", (c: any) => (c.careDraftNotices.draft["zh-SG"] = "Not sent."), "LANGUAGE_COPY_LOCALE_MISMATCH"],
    ["a missing care draft notice", (c: any) => delete c.careDraftNotices.questions["zh-SG"], "LANGUAGE_COPY_MISSING_ENTRY"],
    // 11b.7: the observation variants are checked like every other template.
    ["an observation variant missing its marker", (c: any) => (c.explainObservationVariants["en-SG"][0].items.next.one = "Your records also include items."), "LANGUAGE_COPY_TEMPLATE_INVALID"],
    ["an observation variant with another group's marker", (c: any) => (c.explainObservationVariants["en-SG"][1].values.first.one = "Values {values} and {items}."), "LANGUAGE_COPY_TEMPLATE_INVALID"],
    ["an observation variant with a digit", (c: any) => (c.explainObservationVariants["zh-SG"][0].dates.first.one = "您在{dates}有 2 条记录。"), "LANGUAGE_COPY_DIGIT"],
    ["an English observation variant in Chinese", (c: any) => (c.explainObservationVariants["en-SG"][0].times.first.other = "记录{times}。"), "LANGUAGE_COPY_LOCALE_MISMATCH"],
    ["a different variant count per locale", (c: any) => c.explainObservationVariants["zh-SG"].pop(), "LANGUAGE_COPY_TEMPLATE_INVALID"],
  ])("rejects %s", (_label, mutate, code) => {
    const copy = clone();
    mutate(copy);
    expect(() => buildLanguageCopy(copy)).toThrow(code);
  });
  it("is deeply frozen", () => {
    expect(Object.isFrozen(AI_LANGUAGE_COPY.glosses.MEANING_CLAUSE)).toBe(true);
    expect(Object.isFrozen(AI_LANGUAGE_COPY.explainObservationVariants["en-SG"][0]!.values.first)).toBe(true);
  });
  it("11b.8 keeps every 11b.7 entry byte-identical except the item templates, and adds only the care draft notices", () => {
    expect(createHash("sha256").update(JSON.stringify(withoutPresentation(AI_LANGUAGE_COPY))).digest("hex")).toBe(COPY_11B7_WITHOUT_ITEMS_DIGEST);
  });
  it("P1 (11b.8): every item template names the supplied text as the person's own words (default and variants, both locales)", () => {
    expect(AI_LANGUAGE_COPY.explainDefaults["en-SG"].items).toBe("Recorded items, in your own words: {items}.");
    expect(AI_LANGUAGE_COPY.explainDefaults["zh-SG"].items).toBe("记录的项目（您的原文）：{items}。");
    expect(AI_LANGUAGE_COPY.explainObservationVariants["en-SG"].map((variant) => variant.items)).toEqual([
      { first: { one: "Item in your records, in your own words: {items}.", other: "Items in your records, in your own words: {items}." }, next: { one: "Also recorded, in your own words: {items}.", other: "Also recorded, in your own words: {items}." } },
      { first: { one: "Item on record, in your own words: {items}.", other: "Items on record, in your own words: {items}." }, next: { one: "Other recorded item, in your own words: {items}.", other: "Other recorded items, in your own words: {items}." } },
    ]);
    expect(AI_LANGUAGE_COPY.explainObservationVariants["zh-SG"].map((variant) => variant.items)).toEqual([
      { first: { one: "记录项目（您的原文）：{items}。", other: "记录项目（您的原文）：{items}。" }, next: { one: "另外记录的项目（您的原文）：{items}。", other: "另外记录的项目（您的原文）：{items}。" } },
      { first: { one: "您记录的项目（原文）：{items}。", other: "您记录的项目（原文）：{items}。" }, next: { one: "其他记录项目（您的原文）：{items}。", other: "其他记录项目（您的原文）：{items}。" } },
    ]);
  });
  it("P3 (11b.8): the fixed bilingual care draft notices", () => {
    expect(AI_LANGUAGE_COPY.careDraftNotices).toEqual({
      questions: { "en-SG": "Questions are shown in your own words; the app does not carry them out.", "zh-SG": "问题按您的原话显示，应用不会照此执行。" },
      draft: { "en-SG": "The app does not send this draft to your care team or confirm that a clinician has reviewed it.", "zh-SG": "应用不会把此草稿发送给护理团队，也不会确认医护人员已审阅。" },
    });
    expect(Object.isFrozen(AI_LANGUAGE_COPY.careDraftNotices.draft)).toBe(true);
  });
});
