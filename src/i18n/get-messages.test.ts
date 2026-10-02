import { describe, it, expect } from "vitest";
import { getMessages } from "./get-messages";
import type { AppMessages } from "./types";
import { enSGMessages } from "./messages/en-SG";
import { zhSGMessages } from "./messages/zh-SG";

describe("getMessages", () => {
  it("returns the en-SG catalogue intact", () => {
    const messages = getMessages("en-SG");
    expect(messages).toEqual<AppMessages>(enSGMessages);
  });

  it("returns the zh-SG catalogue intact", () => {
    const messages = getMessages("zh-SG");
    expect(messages).toEqual<AppMessages>(zhSGMessages);
  });

  it("has identical top-level keys in both locales", () => {
    const en = getMessages("en-SG");
    const zh = getMessages("zh-SG");
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
  });

  it("appName is JagaOn in both locales", () => {
    expect(getMessages("en-SG").shared.appName).toBe("JagaOn");
    expect(getMessages("zh-SG").shared.appName).toBe("JagaOn");
  });

  it("demo boundary is present and non-empty in both locales", () => {
    expect(getMessages("en-SG").shared.demoBoundary.length).toBeGreaterThan(0);
    expect(getMessages("zh-SG").shared.demoBoundary.length).toBeGreaterThan(0);
  });

  it("interpolates greeting with a display name", () => {
    expect(getMessages("en-SG").today.greeting("Alex")).toBe("Hello, Alex");
    expect(getMessages("zh-SG").today.greeting("陈先生")).toBe("陈先生，您好");
  });

  it("interpolates resultsCount with a number", () => {
    expect(getMessages("en-SG").food.resultsCount(3)).toBe("3 places found");
    expect(getMessages("zh-SG").food.resultsCount(3)).toBe("找到 3 个地点");
  });

  it("interpolates ambiguousBody with a query", () => {
    expect(getMessages("en-SG").food.ambiguousBody("Bugis")).toContain("Bugis");
    expect(getMessages("zh-SG").food.ambiguousBody("武吉士")).toContain("武吉士");
  });

  it("interpolates offlineBody with a date", () => {
    const en = getMessages("en-SG").food.offlineBody("2026-10-01");
    expect(en).toContain("2026-10-01");
    const zh = getMessages("zh-SG").food.offlineBody("2026-10-01");
    expect(zh).toContain("2026-10-01");
  });

  it("does not interpret glucose readings in either locale", () => {
    expect(getMessages("en-SG").glucose.noInterpretation).toContain("without deciding");
    expect(getMessages("zh-SG").glucose.noInterpretation).toContain("不会判断");
  });

  it("does not recommend doses in either locale", () => {
    expect(getMessages("en-SG").insulin.recordOnly).toContain("does not calculate");
    expect(getMessages("zh-SG").insulin.recordOnly).toContain("不会计算或建议剂量");
  });

  it("does not infer nutrition in either locale", () => {
    expect(getMessages("en-SG").meal.noNutritionInference).toContain("without estimating");
    expect(getMessages("zh-SG").meal.noNutritionInference).toContain("不会估算营养");
  });

  it("shows recorded directions verbatim note in both locales", () => {
    expect(getMessages("en-SG").medication.recordedVerbatim).toContain("exactly as recorded");
    expect(getMessages("zh-SG").medication.recordedVerbatim).toContain("按原记录显示");
  });

  it("keeps safety-critical zh-SG rows exactly as approved in the copy matrix", () => {
    const zh = getMessages("zh-SG");
    expect(zh.shared.demoBoundary).toBe(
      "黑客松演示版本。本原型只使用模拟资料，不可用于实际病患护理。",
    );
    expect(zh.shared.notSaved).toBe("尚未保存。您填写的内容仍保留在此页。");
    // Medicine names stay untranslated data inside reviewed copy.
    expect(zh.medication.glarginePurpose).toBe(
      "Insulin glargine 是一种长效胰岛素，用于降低糖尿病患者的高血糖。",
    );
    expect(zh.medication.aspartPurpose).toBe(
      "Insulin aspart 是一种速效胰岛素，用于控制餐后血糖。",
    );
    expect(zh.medication.generalLimit).toBe("仅供一般参考，不能取代医护人员的建议。");
    expect(zh.help.accessibleEmergency).toBe(
      "聋人、听障或言语障碍人士如遇紧急情况：发送短信至 70995",
    );
    expect(zh.food.prePermissionBody).toBe(
      "JagaOn 会向浏览器申请一次当前位置，不会保存位置记录。",
    );
  });

  it("emergency numbers are identical across locales", () => {
    expect(getMessages("en-SG").help.call995).toContain("995");
    expect(getMessages("zh-SG").help.call995).toContain("995");
    expect(getMessages("en-SG").help.nurseFirst).toContain("6262 6262");
    expect(getMessages("zh-SG").help.nurseFirst).toContain("6262 6262");
  });
});
