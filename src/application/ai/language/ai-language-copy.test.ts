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
/**
 * Packet 11C Task 4: sha256 of JSON.stringify(ai-language-copy.11b.8) without `revision`, computed from the unchanged 11b.8 file before
 * the 11b.9 additions (2026-10-08).
 */
const COPY_11B8_DIGEST = "e37b5e56b0e4f28f0cdb81f6554e6adccf1cb85e78c5ccb7293b20aeec450f66";
/** The 11b.9 additions (period summary copy, slot labels, the summary-role notice and the "periods" observation group), removed. */
const without11b9 = (copy: unknown) => {
  const rest = structuredClone(copy) as any;
  delete rest.comparisonSlotLabels;
  delete rest.periodSummary;
  delete rest.summaryRoleNotice;
  for (const locale of ["en-SG", "zh-SG"]) {
    delete rest.explainDefaults[locale].periods;
    for (const variant of rest.explainObservationVariants[locale]) delete variant.periods;
  }
  return rest;
};
/**
 * Packet 11C Task 6R: sha256 of JSON.stringify(ai-language-copy.11b.9) without `revision` and `summaryRoleNotice`, computed from the
 * unchanged 11b.9 file before the 11b.10 change (2026-10-08).
 */
const COPY_11B9_WITHOUT_NOTICE_DIGEST = "b0c5823f17190a91bba323c6cebe4428080c2de03dce11c8fbdbe98fe6dad0cd";
const withoutPresentation = (copy: unknown) => {
  const rest = without11b9(copy);
  delete rest.revision;
  delete rest.careDraftNotices;
  for (const locale of ["en-SG", "zh-SG"]) {
    rest.explainDefaults[locale].items = null;
    for (const variant of rest.explainObservationVariants[locale]) variant.items = null;
  }
  return rest;
};
describe("language copy ai-language-copy.11b.10", () => {
  it("pins the revision and the approved claim clauses", () => {
    expect(AI_LANGUAGE_COPY_REVISION).toBe("ai-language-copy.11b.10");
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
    ["the 11b.8 revision", (c: any) => (c.revision = "ai-language-copy.11b.8"), "LANGUAGE_COPY_INVALID_REVISION"],
    ["the 11b.9 revision", (c: any) => (c.revision = "ai-language-copy.11b.9"), "LANGUAGE_COPY_INVALID_REVISION"],
    // 11b.9: every new string is checked with checkText; templates after marker removal.
    ["a slot label with a digit", (c: any) => (c.comparisonSlotLabels.BEDTIME["en-SG"] = "bedtime 2"), "LANGUAGE_COPY_DIGIT"],
    ["an English slot label in Chinese", (c: any) => (c.comparisonSlotLabels.BEFORE_LUNCH["en-SG"] = "午餐前"), "LANGUAGE_COPY_LOCALE_MISMATCH"],
    ["a missing slot label", (c: any) => delete c.comparisonSlotLabels.BEFORE_DINNER, "LANGUAGE_COPY_MISSING_ENTRY"],
    ["a period template with a digit", (c: any) => (c.periodSummary["en-SG"].MEDIAN = "{role}, {range}: median {value} from {count} in 2 periods"), "LANGUAGE_COPY_DIGIT"],
    ["a period template missing its value marker", (c: any) => (c.periodSummary["en-SG"].IQR = "{role}, {range}: interquartile range from {count}"), "LANGUAGE_COPY_TEMPLATE_INVALID"],
    ["a period template with an unknown marker", (c: any) => (c.periodSummary["zh-SG"].MEDIAN = "{role}（{range}）{count}的中位数为 {value}{slot}"), "LANGUAGE_COPY_TEMPLATE_INVALID"],
    ["a Chinese period template without Chinese", (c: any) => (c.periodSummary["zh-SG"].IQR = "{role} ({range}) {count}: {value}"), "LANGUAGE_COPY_LOCALE_MISMATCH"],
    ["a period lead without its slot marker", (c: any) => (c.periodSummary["en-SG"].lead = "readings"), "LANGUAGE_COPY_TEMPLATE_INVALID"],
    ["a period role with a reference identifier", (c: any) => (c.periodSummary["en-SG"].roles.EARLIER = "fact-x period"), "LANGUAGE_COPY_REFERENCE"],
    ["a missing period role", (c: any) => delete c.periodSummary["zh-SG"].roles.RECENT, "LANGUAGE_COPY_MISSING_ENTRY"],
    ["a period joiner with words", (c: any) => (c.periodSummary["en-SG"].join = " and then "), "LANGUAGE_COPY_TEMPLATE_INVALID"],
    ["a summary-role notice with a digit", (c: any) => (c.summaryRoleNotice["en-SG"] = "A median of 2 periods is a summary value."), "LANGUAGE_COPY_DIGIT"],
    ["a Chinese summary-role notice without Chinese", (c: any) => (c.summaryRoleNotice["zh-SG"] = "A summary value."), "LANGUAGE_COPY_LOCALE_MISMATCH"],
    ["a periods observation template without its marker", (c: any) => (c.explainDefaults["en-SG"].periods = "Readings by period."), "LANGUAGE_COPY_TEMPLATE_INVALID"],
    ["a periods observation variant with a digit", (c: any) => (c.explainObservationVariants["zh-SG"][1].periods.first.one = "按 2 个期间的读数：{periods}。"), "LANGUAGE_COPY_DIGIT"],
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
  it("11b.9 keeps every 11b.8 entry byte-identical and only adds the period summary copy, slot labels, notice and periods group", () => {
    const rest = without11b9(AI_LANGUAGE_COPY);
    delete rest.revision;
    expect(createHash("sha256").update(JSON.stringify(rest)).digest("hex")).toBe(COPY_11B8_DIGEST);
  });
  it("11b.9: the exact approved period summary copy, slot labels and summary-role notice (IQR, never a recorded spread)", () => {
    expect(AI_LANGUAGE_COPY.comparisonSlotLabels).toEqual({
      BEFORE_BREAKFAST: { "en-SG": "before-breakfast", "zh-SG": "早餐前" },
      BEFORE_LUNCH: { "en-SG": "before-lunch", "zh-SG": "午餐前" },
      BEFORE_DINNER: { "en-SG": "before-dinner", "zh-SG": "晚餐前" },
      BEDTIME: { "en-SG": "bedtime", "zh-SG": "睡前" },
    });
    expect(AI_LANGUAGE_COPY.periodSummary).toEqual({
      "en-SG": { lead: "{slot} readings", MEDIAN: "{role}, {range}: median {value} from {count}", IQR: "{role}, {range}: interquartile range {value} from {count}", roles: { EARLIER: "earlier period", RECENT: "recent period" }, join: "; " },
      "zh-SG": { lead: "{slot}时段", MEDIAN: "{role}（{range}）{count}的中位数为 {value}", IQR: "{role}（{range}）{count}的四分位距为 {value}", roles: { EARLIER: "较早期间", RECENT: "近期" }, join: "；" },
    });
    expect(JSON.stringify(AI_LANGUAGE_COPY.periodSummary)).not.toMatch(/SPREAD|recorded spread|记录范围/);
    expect(Object.isFrozen(AI_LANGUAGE_COPY.periodSummary["zh-SG"].roles)).toBe(true);
  });
  it("11b.10 keeps every 11b.9 entry byte-identical and changes only the summary-role notice", () => {
    const rest = structuredClone(AI_LANGUAGE_COPY) as any;
    delete rest.revision;
    delete rest.summaryRoleNotice;
    expect(createHash("sha256").update(JSON.stringify(rest)).digest("hex")).toBe(COPY_11B9_WITHOUT_NOTICE_DIGEST);
    expect(Object.keys(AI_LANGUAGE_COPY)).toContain("summaryRoleNotice");
  });
  it("11b.10 (owner decision 2026-10-08): the summary-role notice identifies variability as the IQR and explains it as the spread of the middle half of the readings", () => {
    expect(AI_LANGUAGE_COPY.summaryRoleNotice).toEqual({
      "en-SG": "A median, or an interquartile range (IQR: the spread of the middle half of the readings), is a summary value, not a single reading.",
      "zh-SG": "中位数或四分位距（IQR，即中间一半读数的分布宽度）是汇总数值，不是单次读数。",
    });
    // Never the full range or a bare "spread"/"range"/"记录范围" on its own: each names the interquartile range.
    expect(AI_LANGUAGE_COPY.summaryRoleNotice["en-SG"]).toMatch(/interquartile range \(IQR: the spread of the middle half of the readings\)/);
    expect(AI_LANGUAGE_COPY.summaryRoleNotice["zh-SG"]).toMatch(/四分位距（IQR，即中间一半读数的分布宽度）/);
    expect(JSON.stringify(AI_LANGUAGE_COPY.summaryRoleNotice)).not.toMatch(/记录范围|full range|recorded spread/);
    expect(Object.isFrozen(AI_LANGUAGE_COPY.summaryRoleNotice)).toBe(true);
  });
  it("11b.10: the unchanged checkText accepts the Latin “IQR” inside the zh notice (and the IQR-free zh alternative), and still rejects a digit or an English-only notice", () => {
    const build = (zh: string) => {
      const copy = clone();
      copy.summaryRoleNotice["zh-SG"] = zh;
      return () => buildLanguageCopy(copy);
    };
    expect(build("中位数或四分位距（IQR，即中间一半读数的分布宽度）是汇总数值，不是单次读数。")).not.toThrow();
    expect(build("中位数或四分位距（即中间一半读数的分布宽度）是汇总数值，不是单次读数。")).not.toThrow();
    expect(build("中位数或四分位距（IQR，即中间 50% 读数的分布宽度）是汇总数值。")).toThrow("LANGUAGE_COPY_DIGIT");
    expect(build("A median, or an interquartile range (IQR), is a summary value.")).toThrow("LANGUAGE_COPY_LOCALE_MISMATCH");
  });
  it("11b.9: the period joiner is an explicit per-locale allow-list (en ';'/',' with spaces; zh one of '；' '，' '、'), checkText unchanged", () => {
    const build = (locale: "en-SG" | "zh-SG", join: string) => {
      const copy = clone();
      copy.periodSummary[locale].join = join;
      return () => buildLanguageCopy(copy);
    };
    for (const join of ["; ", ";", ", ", " ; "]) expect(build("en-SG", join), JSON.stringify(join)).not.toThrow();
    for (const join of ["；", "，", "、"]) expect(build("zh-SG", join), JSON.stringify(join)).not.toThrow();
    for (const join of ["%", "/", "a", "1", "#", "@", ". ", ";;", ";a", "；", "", "  "]) expect(build("en-SG", join), `en ${JSON.stringify(join)}`).toThrow("LANGUAGE_COPY_TEMPLATE_INVALID");
    // ASCII separators in zh are a locale mismatch: rejected, as are spaces, letters, digits and other symbols.
    for (const join of [";", "; ", ",", "；；", "； ", "%", "/", "a", "1", "。", ""]) expect(build("zh-SG", join), `zh ${JSON.stringify(join)}`).toThrow("LANGUAGE_COPY_TEMPLATE_INVALID");
  });
  it("11b.9: one approved periods observation template per locale, used by the default and every variant (first/next, one/other)", () => {
    expect(AI_LANGUAGE_COPY.explainDefaults["en-SG"].periods).toBe("Readings by period — {periods}.");
    expect(AI_LANGUAGE_COPY.explainDefaults["zh-SG"].periods).toBe("按期间的读数：{periods}。");
    for (const locale of ["en-SG", "zh-SG"] as const) {
      const template = AI_LANGUAGE_COPY.explainDefaults[locale].periods;
      for (const variant of AI_LANGUAGE_COPY.explainObservationVariants[locale]) {
        expect(variant.periods).toEqual({ first: { one: template, other: template }, next: { one: template, other: template } });
      }
    }
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
