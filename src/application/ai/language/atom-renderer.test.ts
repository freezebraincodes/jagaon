import { describe, expect, it } from "vitest";
import { careSummaryLocalePack } from "@/application/care-preparation/care-summary-locale-pack";
import { renderAtom } from "./atom-renderer";

describe("atom renderer ai-atoms.11b.6", () => {
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
