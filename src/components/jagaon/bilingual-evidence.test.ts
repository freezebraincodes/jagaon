import { describe, it, expect } from "vitest";
import { getMessages } from "@/i18n/get-messages";
import { ALL_SCREENS, PACKET_6_ENABLED_SCREENS } from "@/components/jagaon/screen-manifest";

describe("bilingual evidence — en-SG and zh-SG parity", () => {
  const en = getMessages("en-SG");
  const zh = getMessages("zh-SG");

  it("every screen has bilingual copy coverage", () => {
    // Verify that every message section is present in both locales
    const sections = [
      "shared", "today", "glucose", "readingTime", "insulin",
      "meal", "medication", "food", "more", "settings", "help",
    ] as const;
    for (const section of sections) {
      expect(en[section]).toBeDefined();
      expect(zh[section]).toBeDefined();
    }
  });

  it("app name is JagaOn in both locales", () => {
    expect(en.shared.appName).toBe("JagaOn");
    expect(zh.shared.appName).toBe("JagaOn");
  });

  it("every non-interpolated string is non-empty in both locales", () => {
    function checkNonEmpty(obj: Record<string, unknown>, path: string) {
      for (const [key, value] of Object.entries(obj)) {
        if (typeof value === "string") {
          expect(value.length, `${path}.${key}`).toBeGreaterThan(0);
        } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
          checkNonEmpty(value as Record<string, unknown>, `${path}.${key}`);
        }
      }
    }
    checkNonEmpty(en, "en-SG");
    checkNonEmpty(zh, "zh-SG");
  });

  it("interpolated greeting works with ASCII and CJK names", () => {
    expect(en.today.greeting("Alex")).toBe("Hello, Alex");
    expect(zh.today.greeting("陈先生")).toBe("陈先生，您好");
  });

  it("interpolated resultsCount works in both locales", () => {
    expect(en.food.resultsCount(5)).toBe("5 places found");
    expect(zh.food.resultsCount(5)).toBe("找到 5 个地点");
  });

  it("glucose no-interpretation copy is present and correct in both locales", () => {
    expect(en.glucose.noInterpretation).toContain("without deciding");
    expect(zh.glucose.noInterpretation).toContain("不会判断");
  });

  it("insulin no-dose-recommendation copy is present in both locales", () => {
    expect(en.insulin.recordOnly).toContain("does not calculate");
    expect(zh.insulin.recordOnly).toContain("不会计算或建议剂量");
  });

  it("meal no-nutrition-inference copy is present in both locales", () => {
    expect(en.meal.noNutritionInference).toContain("without estimating");
    expect(zh.meal.noNutritionInference).toContain("不会估算营养");
  });

  it("medication recorded-verbatim copy is present in both locales", () => {
    expect(en.medication.recordedVerbatim).toContain("exactly as recorded");
    expect(zh.medication.recordedVerbatim).toContain("按原记录显示");
  });

  it("emergency numbers are identical across locales", () => {
    expect(en.help.call995).toContain("995");
    expect(zh.help.call995).toContain("995");
    expect(en.help.nurseFirst).toContain("6262 6262");
    expect(zh.help.nurseFirst).toContain("6262 6262");
    expect(en.help.accessibleEmergency).toContain("70995");
    expect(zh.help.accessibleEmergency).toContain("70995");
  });

  it("food no-badge default is stated in both locales", () => {
    // The copy doesn't mention HPB/lower-GI/healthier badges
    const prohibited = ["HPB", "lower GI", "healthier choice", "低GI", "较健康"];
    for (const term of prohibited) {
      expect(en.food.subtitle).not.toContain(term);
      expect(zh.food.subtitle).not.toContain(term);
    }
  });

  it("GPS pre-permission copy states no location history in both locales", () => {
    expect(en.food.prePermissionBody).toContain("not save a location history");
    expect(zh.food.prePermissionBody).toContain("不会保存位置记录");
  });

  it("demo boundary is present and non-empty in both locales", () => {
    expect(en.shared.demoBoundary).toContain("synthetic data");
    expect(zh.shared.demoBoundary).toContain("模拟资料");
  });

  it("settings language labels are correct", () => {
    expect(en.settings.english).toBe("English");
    // Chinese label in en-SG is shown in Chinese characters
    expect(en.settings.chinese).toBe("简体中文");
    // English label in zh-SG is shown as English
    expect(zh.settings.english).toBe("English");
    expect(zh.settings.chinese).toBe("简体中文");
  });

  it("future feature placeholder is present", () => {
    expect(en.today.futureFeature).toContain("later demo packet");
    expect(zh.today.futureFeature).toContain("后续演示阶段");
  });

  it("all 11 Packet 6 screens are enabled (no Packet 7-9 routes)", () => {
    expect(ALL_SCREENS.size).toBe(11);
    const deferred = [
      "TRENDS", "WEEKLY_TRENDS", "REMINDERS", "CREATE_REMINDER",
      "PREVENTIVE_CARE", "APPOINTMENTS", "SCHEDULE_APPOINTMENT",
      "LIVE_FOOD_PROVIDER",
    ];
    for (const route of deferred) {
      expect(PACKET_6_ENABLED_SCREENS).not.toContain(route);
    }
  });
});

describe("catalogue wording boundaries", () => {
  function strings(obj: Record<string, unknown>): string[] {
    return Object.values(obj).flatMap((value) => {
      if (typeof value === "string") return [value];
      if (typeof value === "function") return [String((value as (...a: unknown[]) => string)("X", "Y"))];
      if (value && typeof value === "object") return strings(value as Record<string, unknown>);
      return [];
    });
  }

  it("contains no diagnosis, risk, urgency, missed-dose or take-now wording in either locale", () => {
    const en = strings(getMessages("en-SG"));
    const zh = strings(getMessages("zh-SG"));
    const englishProhibited = [
      /\bmissed\b/i, /take now/i, /take it now/i, /\boverdue\b/i, /\brisk\b/i, /diagnos/i,
      /you should/i, /too (high|low)/i, /\bin range\b/i, /double (up|dose)/i, /catch[- ]up/i,
      /lower gi/i, /healthier/i,
    ];
    const chineseProhibited = [/漏服/, /立即服用/, /过期未/, /风险/, /诊断/, /您应该/, /偏高了/, /偏低了/, /低GI/i, /较健康/];
    for (const text of en) for (const pattern of englishProhibited) expect(text, text).not.toMatch(pattern);
    for (const text of zh) for (const pattern of chineseProhibited) expect(text, text).not.toMatch(pattern);
  });

  it("keeps parameterised messages aligned across locales", () => {
    const en = getMessages("en-SG");
    const zh = getMessages("zh-SG");
    function shape(obj: Record<string, unknown>, path = ""): string[] {
      return Object.entries(obj).flatMap(([key, value]) =>
        value && typeof value === "object"
          ? shape(value as Record<string, unknown>, `${path}${key}.`)
          : [`${path}${key}:${typeof value}:${typeof value === "function" ? (value as () => string).length : ""}`],
      );
    }
    expect(shape(zh).sort()).toEqual(shape(en).sort());
  });
});
