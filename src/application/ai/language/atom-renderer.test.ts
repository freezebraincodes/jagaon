import { describe, expect, it } from "vitest";
import { careSummaryLocalePack } from "@/application/care-preparation/care-summary-locale-pack";
import { ATOM_RENDERER_VERSION, renderAtom, renderSummaryRoleNotice } from "./atom-renderer";

describe("atom renderer ai-atoms.11b.7", () => {
  it("ai-atoms.11b.7 (Packet 11C phase 2): the version moved for the PERIOD_SUMMARY kind and its renderer-owned lead joiner", () => {
    expect(ATOM_RENDERER_VERSION).toBe("ai-atoms.11b.7");
  });
  it.each([["en-SG"], ["zh-SG"]] as const)("%s: decimal strings verbatim with the approved display unit", (locale) => {
    expect(renderAtom({ kind: "DECIMAL", value: "6.20", unit: "MMOL_L" }, locale)).toBe("6.20 mmol/L");
    expect(renderAtom({ kind: "DECIMAL", value: "10.0", unit: "MG_DL" }, locale)).toBe("10.0 mg/dL");
  });
  it("joins decimal lists in supplied order with the approved joiners", () => {
    const two = [{ value: "6.2", unit: "MMOL_L" }, { value: "7.1", unit: "MMOL_L" }];
    const three = [{ value: "6.2", unit: "MMOL_L" }, { value: "6.5", unit: "MMOL_L" }, { value: "7.1", unit: "MMOL_L" }];
    expect(renderAtom({ kind: "DECIMAL_LIST", values: two }, "en-SG")).toBe("6.2 mmol/L and 7.1 mmol/L");
    expect(renderAtom({ kind: "DECIMAL_LIST", values: three }, "en-SG")).toBe("6.2 mmol/L, 6.5 mmol/L and 7.1 mmol/L");
    expect(renderAtom({ kind: "DECIMAL_LIST", values: two }, "zh-SG")).toBe("6.2 mmol/L 和 7.1 mmol/L");
    expect(renderAtom({ kind: "DECIMAL_LIST", values: three }, "zh-SG")).toBe("6.2 mmol/L、6.5 mmol/L 和 7.1 mmol/L");
    expect(renderAtom({ kind: "DECIMAL_LIST", values: [{ value: "6.2", unit: "MMOL_L" }] }, "en-SG")).toBe("6.2 mmol/L");
  });
  it("pluralises counts by locale rules", () => {
    expect(renderAtom({ kind: "COUNT", value: 1, noun: "READINGS" }, "en-SG")).toBe("1 recorded reading");
    expect(renderAtom({ kind: "COUNT", value: 0, noun: "READINGS" }, "en-SG")).toBe("0 recorded readings");
    expect(renderAtom({ kind: "COUNT", value: 10, noun: "READINGS" }, "en-SG")).toBe("10 recorded readings");
    expect(renderAtom({ kind: "COUNT", value: 1, noun: "RECORDS" }, "en-SG")).toBe("1 record");
    expect(renderAtom({ kind: "COUNT", value: 10, noun: "READINGS" }, "zh-SG")).toBe("10 条记录读数");
    expect(renderAtom({ kind: "COUNT", value: 1, noun: "RECORDS" }, "zh-SG")).toBe("1 条记录");
  });
  it.each([["en-SG"], ["zh-SG"]] as const)("%s: dates come only from the care-summary locale pack", (locale) => {
    const pack = careSummaryLocalePack(locale);
    expect(renderAtom({ kind: "DATE", localDate: "2026-10-03" }, locale)).toBe(pack.localDateText("2026-10-03"));
    const joiner = locale === "en-SG" ? " to " : "至";
    expect(renderAtom({ kind: "DATE_RANGE", startDate: "2026-10-01", endDate: "2026-10-07" }, locale)).toBe(`${pack.localDateText("2026-10-01")}${joiner}${pack.localDateText("2026-10-07")}`);
  });
  it("renders times, labels and quoted text verbatim", () => {
    expect(renderAtom({ kind: "TIME", localTime: "09:05" }, "zh-SG")).toBe("09:05");
    expect(renderAtom({ kind: "LABEL", text: "brown  rice {{S2}}" }, "en-SG")).toBe("brown  rice {{S2}}");
    expect(renderAtom({ kind: "QUOTED_TEXT", text: "Is {{S1}} 10 mmol/L?" }, "en-SG")).toBe("“Is {{S1}} 10 mmol/L?”");
    expect(renderAtom({ kind: "QUOTED_TEXT", text: "我可以吗？" }, "zh-SG")).toBe("“我可以吗？”");
  });
  it("renders the approved claim clause", () => {
    expect(renderAtom({ kind: "MEANING", family: "COMPARABLE_SLOT_TREND" }, "zh-SG")).toBe("同一时段在较早期间和近期的读数");
  });
  it("refuses a unit without an approved display form", () => {
    expect(() => renderAtom({ kind: "DECIMAL", value: "70", unit: "KG" }, "en-SG")).toThrow("ATOM_UNSUPPORTED_UNIT");
  });
});

/**
 * Packet 11C Task 4: the application-only PERIOD_SUMMARY atom (ai-language-copy.11b.9). Slot label, then each period with its dates
 * (care-summary locale pack), its role-labelled summary value (median, or interquartile range for VARIABILITY) and its count (READINGS
 * noun). Never projected to a model.
 */
describe("PERIOD_SUMMARY atom (ai-language-copy.11b.9)", () => {
  const periods = (earlier: [number, string], recent: [number, string]) => [
    { role: "EARLIER", startDate: "2026-08-23", endDate: "2026-09-20", count: earlier[0], value: earlier[1] },
    { role: "RECENT", startDate: "2026-09-20", endDate: "2026-10-04", count: recent[0], value: recent[1] },
  ] as const;
  const median = { kind: "PERIOD_SUMMARY", slot: "BEFORE_BREAKFAST", summaryKind: "MEDIAN", periods: periods([8, "6"], [6, "7.35"]) } as const;
  const iqr = { kind: "PERIOD_SUMMARY", slot: "BEFORE_BREAKFAST", summaryKind: "IQR", periods: periods([8, "0.15"], [7, "2.75"]) } as const;

  it("renders the exact MEDIAN wording in both locales (dates from the locale pack, value + mmol/L, READINGS count)", () => {
    expect(renderAtom(median, "en-SG")).toBe("before-breakfast readings: earlier period, 23 Aug 2026 to 20 Sept 2026: median 6 mmol/L from 8 recorded readings; recent period, 20 Sept 2026 to 4 Oct 2026: median 7.35 mmol/L from 6 recorded readings");
    expect(renderAtom(median, "zh-SG")).toBe("早餐前时段：较早期间（2026年8月23日至2026年9月20日）8 条记录读数的中位数为 6 mmol/L；近期（2026年9月20日至2026年10月4日）6 条记录读数的中位数为 7.35 mmol/L");
  });
  it.each([["en-SG"], ["zh-SG"]] as const)("%s: every date comes from the care-summary locale pack", (locale) => {
    const pack = careSummaryLocalePack(locale);
    const text = renderAtom(median, locale);
    for (const date of ["2026-08-23", "2026-09-20", "2026-10-04"]) expect(text).toContain(pack.localDateText(date));
  });
  it("labels a VARIABILITY summary as the interquartile range (IQR), never a median, a recorded spread or the full range", () => {
    const en = renderAtom(iqr, "en-SG");
    const zh = renderAtom(iqr, "zh-SG");
    expect(en).toBe("before-breakfast readings: earlier period, 23 Aug 2026 to 20 Sept 2026: interquartile range 0.15 mmol/L from 8 recorded readings; recent period, 20 Sept 2026 to 4 Oct 2026: interquartile range 2.75 mmol/L from 7 recorded readings");
    expect(zh).toBe("早餐前时段：较早期间（2026年8月23日至2026年9月20日）8 条记录读数的四分位距为 0.15 mmol/L；近期（2026年9月20日至2026年10月4日）7 条记录读数的四分位距为 2.75 mmol/L");
    expect(en).toContain("interquartile range");
    expect(zh).toContain("四分位距");
    for (const text of [en, zh]) for (const forbidden of ["recorded spread", "记录范围", "median", "中位数"]) expect(text).not.toContain(forbidden);
  });
  it("renders a period count above 32 exactly (no cap or truncation)", () => {
    const many = { ...median, periods: periods([36, "6"], [6, "7.35"]) } as const;
    expect(renderAtom(many, "en-SG")).toContain("median 6 mmol/L from 36 recorded readings;");
    expect(renderAtom(many, "zh-SG")).toContain("（2026年8月23日至2026年9月20日）36 条记录读数的中位数为 6 mmol/L");
    const thousand = { ...median, periods: periods([1234, "6"], [6, "7.35"]) } as const;
    expect(renderAtom(thousand, "en-SG")).toContain("from 1234 recorded readings;");
  });
  it.each([
    ["BEFORE_LUNCH", "before-lunch readings: ", "午餐前时段："],
    ["BEFORE_DINNER", "before-dinner readings: ", "晚餐前时段："],
    ["BEDTIME", "bedtime readings: ", "睡前时段："],
  ] as const)("names the %s slot with the approved slot label", (slot, en, zh) => {
    expect(renderAtom({ ...median, slot }, "en-SG").startsWith(en)).toBe(true);
    expect(renderAtom({ ...median, slot }, "zh-SG").startsWith(zh)).toBe(true);
  });
  it.each([
    ["one period", (s: any) => (s.periods = s.periods.slice(0, 1))],
    ["three periods", (s: any) => (s.periods = [...s.periods, s.periods[1]])],
    ["periods out of order", (s: any) => (s.periods = [...s.periods].reverse())],
    ["an unknown summary kind", (s: any) => (s.summaryKind = "SPREAD")],
    ["an unknown slot", (s: any) => (s.slot = "AFTER_LUNCH")],
    ["a fractional count", (s: any) => (s.periods = [{ ...s.periods[0], count: 1.5 }, s.periods[1]])],
  ])("fails closed on %s (ATOM_INVALID_PERIOD_SUMMARY)", (_label, mutate) => {
    const source = structuredClone(median) as any;
    mutate(source);
    expect(() => renderAtom(source, "en-SG")).toThrow("ATOM_INVALID_PERIOD_SUMMARY");
  });
  it("renders the fixed summary-role notice in both locales", () => {
    expect(renderSummaryRoleNotice("en-SG")).toBe("A median or an interquartile range (the spread of the middle half of the readings) is a summary value, not a single reading.");
    expect(renderSummaryRoleNotice("zh-SG")).toBe("中位数或四分位距（中间一半读数的分布宽度）是汇总数值，不是单次读数。");
  });
});
