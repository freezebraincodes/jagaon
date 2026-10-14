import { describe, it, expect } from "vitest";
import { getMessages } from "@/i18n/get-messages";
import { AI_LANGUAGE_COPY } from "@/application/ai/language/ai-language-copy";
import { ALL_SCREENS, PACKET_6_ENABLED_SCREENS } from "@/components/jagaon/screen-manifest";

describe("bilingual evidence — en-SG and zh-SG parity", () => {
  const en = getMessages("en-SG");
  const zh = getMessages("zh-SG");

  it("every screen has bilingual copy coverage", () => {
    // Verify that every message section is present in both locales
    const sections = [
      "shared", "today", "glucose", "readingTime", "insulin",
      "meal", "medication", "food", "more", "settings", "help", "onboarding",
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

  it("the 11 Packet 6 screens, My medicines, Packet 7A Recorded history, Packet 8 Medication schedule and the Packet 9B care screens are enabled (no Packet 7B or later routes)", () => {
    // Packet 10 adds exactly DATA_BACKUP; the Packet 13 slice adds exactly TELL_JAGAON.
    // Owner decision 2026-10-12: My notes adds exactly MY_NOTES (reached from More).
    expect(ALL_SCREENS.size).toBe(20);
    expect(PACKET_6_ENABLED_SCREENS).toContain("MY_NOTES");
    expect(PACKET_6_ENABLED_SCREENS).toContain("TELL_JAGAON");
    expect(PACKET_6_ENABLED_SCREENS).toContain("CARE_SUMMARY_PREVIEW");
    expect(PACKET_6_ENABLED_SCREENS).toContain("PREVENTIVE_CARE");
    expect(PACKET_6_ENABLED_SCREENS).toContain("CARE_PREPARATION");
    expect(PACKET_6_ENABLED_SCREENS).toContain("HISTORY");
    expect(PACKET_6_ENABLED_SCREENS).toContain("MEDICATION_SCHEDULE");
    const deferred = [
      "TRENDS", "WEEKLY_TRENDS", "REMINDERS", "CREATE_REMINDER",
      "APPOINTMENTS", "SCHEDULE_APPOINTMENT",
      "LIVE_FOOD_PROVIDER",
    ];
    for (const route of deferred) {
      expect(PACKET_6_ENABLED_SCREENS).not.toContain(route);
    }
  });
});

describe("catalogue wording boundaries", () => {
  function entries(obj: Record<string, unknown>, path = ""): Array<[string, string]> {
    return Object.entries(obj).flatMap(([key, value]): Array<[string, string]> => {
      const at = `${path}${key}`;
      if (typeof value === "string") return [[at, value]];
      if (typeof value === "function") return [[at, String((value as (...a: unknown[]) => string)("X", "Y"))]];
      if (value && typeof value === "object") return entries(value as Record<string, unknown>, `${at}.`);
      return [];
    });
  }

  // Approved sentences that name a prohibited idea only to deny it.
  const DENIAL_SENTENCES = new Set([
    "onboarding.noSensitiveData",
    "onboarding.notMissed",
    "onboarding.skippedBody",
    "today.noMedicinesNotMissed",
  ]);

  // Exact governed source names (Packet 9A matrix); the programme name is not a product claim.
  const SOURCE_NAME_KEYS = new Set(["food.governedDatasetSource"]);

  it("contains no diagnosis, risk, urgency, missed-dose or take-now wording in either locale", () => {
    const englishProhibited = [
      /\bmissed\b/i, /take now/i, /take it now/i, /\boverdue\b/i, /\brisk\b/i, /diagnos/i,
      /you should/i, /too (high|low)/i, /\bin range\b/i, /double (up|dose)/i, /catch[- ]up/i,
      /lower gi/i, /healthier/i, /recommended dose/i,
    ];
    const chineseProhibited = [/漏服/, /漏用/, /立即服用/, /过期未/, /风险/, /诊断/, /您应该/, /偏高了/, /偏低了/, /低GI/i, /较健康/];
    // HSA-bounded mode (owner decision 2026-10-14): the `hsa*` blocks are PREVIEW copy, shown only while the mode is off, and may
    // use wording beyond the wellness boundary (for example "healthier places"). They are checked by the hard-line test below instead.
    const isPreviewKey = (key: string) => key.startsWith("hsa");
    for (const [key, text] of entries(getMessages("en-SG"))) {
      if (DENIAL_SENTENCES.has(key) || SOURCE_NAME_KEYS.has(key) || isPreviewKey(key)) continue;
      for (const pattern of englishProhibited) expect(text, key).not.toMatch(pattern);
    }
    for (const [key, text] of entries(getMessages("zh-SG"))) {
      if (DENIAL_SENTENCES.has(key) || SOURCE_NAME_KEYS.has(key) || isPreviewKey(key)) continue;
      for (const pattern of chineseProhibited) expect(text, key).not.toMatch(pattern);
    }
    // The exempted source name is pinned exactly so it cannot drift into a claim.
    expect(getMessages("en-SG").food.governedDatasetSource).toBe("HPB Healthier Dining Partners \u00b7 data.gov.sg");
    expect(getMessages("zh-SG").food.governedDatasetSource).toBe("保健促进局较健康餐饮伙伴 · data.gov.sg");
  });

  it("keeps PREVIEW copy within the hard lines that hold whatever the HSA-bounded mode (owner decision 2026-10-14)", () => {
    // No dosing, take-now, double-up or medication-change wording, and no diagnosis, in any preview block.
    const hardLines = [/take now/i, /take it now/i, /double (up|dose)/i, /recommended dose/i, /catch[- ]up/i, /you should/i, /diagnos/i];
    const preview = entries(getMessages("en-SG")).filter(([key]) => key.startsWith("hsa"));
    expect(preview.length).toBeGreaterThan(0);
    for (const [key, text] of preview) for (const pattern of hardLines) expect(text, key).not.toMatch(pattern);
  });

  it("keeps each denial sentence a denial in both locales", () => {
    const en = getMessages("en-SG");
    const zh = getMessages("zh-SG");
    expect(en.onboarding.notMissed).toMatch(/does not mean/);
    expect(en.today.noMedicinesNotMissed).toMatch(/does not mean/);
    expect(en.onboarding.skippedBody).toMatch(/does not mean/);
    expect(en.onboarding.noSensitiveData).toMatch(/does not ask/);
    expect(zh.onboarding.notMissed).toMatch(/不代表/);
    expect(zh.today.noMedicinesNotMissed).toMatch(/不代表/);
    expect(zh.onboarding.skippedBody).toMatch(/不代表/);
    expect(zh.onboarding.noSensitiveData).toMatch(/不会询问/);
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

  it("passes user-entered onboarding values through unchanged in both locales", () => {
    for (const locale of ["en-SG", "zh-SG"] as const) {
      const msg = getMessages(locale).onboarding;
      expect(msg.directionsFor("Oxatril (demo)")).toContain("Oxatril (demo)");
      expect(msg.removeBody("Lantus (demo)")).toContain("Lantus (demo)");
      expect(msg.editNamed("陈女士（示例）")).toContain("陈女士（示例）");
    }
  });

  it("pins the Packet 11C Task 7 explanation-panel copy (history.explanation) with en/zh parity and full-width zh punctuation", () => {
    const en = getMessages("en-SG").history.explanation;
    const zh = getMessages("zh-SG").history.explanation;
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    expect(Object.keys(en).sort()).toEqual(
      ["action", "aiLabel", "boundaryNote", "earlierRange", "offsetReading", "periodHeading", "reconciliation", "recentRange", "singaporeTime", "stale", "supportingHeading", "title", "unavailable"].sort(),
    );
    const pairs: Array<[string, string, string]> = [
      ["action", en.action, zh.action],
      ["title", en.title, zh.title],
      ["aiLabel", en.aiLabel, zh.aiLabel],
      ["supportingHeading", en.supportingHeading(14), zh.supportingHeading(14)],
      ["periodHeading.EARLIER", en.periodHeading("EARLIER", 8), zh.periodHeading("EARLIER", 8)],
      ["periodHeading.RECENT", en.periodHeading("RECENT", 6), zh.periodHeading("RECENT", 6)],
      ["reconciliation", en.reconciliation(8, 6, 14), zh.reconciliation(8, 6, 14)],
      ["unavailable", en.unavailable, zh.unavailable],
      ["stale", en.stale, zh.stale],
      ["earlierRange", en.earlierRange("S", "C"), zh.earlierRange("S", "C")],
      ["recentRange", en.recentRange("C", "E"), zh.recentRange("C", "E")],
      ["boundaryNote", en.boundaryNote("C"), zh.boundaryNote("C")],
      ["singaporeTime", en.singaporeTime("D", "T"), zh.singaporeTime("D", "T")],
      ["offsetReading", en.offsetReading("R", "O", "S"), zh.offsetReading("R", "O", "S")],
    ];
    expect(Object.fromEntries(pairs.map(([key, english, chinese]) => [key, [english, chinese]]))).toEqual({
      action: ["Show how this comparison was worked out", "查看这项比较的依据"],
      title: ["How this comparison was worked out", "这项比较的依据"],
      aiLabel: ["AI-assisted wording", "AI 辅助措辞"],
      // history-explanation.11c.2 (Packet 11C B4, owner decisions 2 and 3 and D7; wording human acceptance pending): the list heading
      // names the readings included in this comparison; endpoints and the cutoff name Singapore time; a reading recorded at another
      // offset shows its own local time and offset label, then its Singapore-time equivalent.
      supportingHeading: ["Readings included in this comparison (14)", "此比较包含的读数（14 条）"],
      singaporeTime: ["D, T Singapore time", "D 新加坡时间T"],
      offsetReading: ["R (O; S)", "R（O；S）"],
      "periodHeading.EARLIER": ["Earlier period (8)", "较早期间（8 条）"],
      "periodHeading.RECENT": ["Recent period (6)", "近期（6 条）"],
      reconciliation: ["8 + 6 = 14 readings, matching the count above.", "8 + 6 = 14 条读数，与上方数量一致。"],
      unavailable: ["This comparison cannot be explained right now. The comparison above is unchanged.", "目前无法说明这项比较。上方的比较保持不变。"],
      stale: ["A supporting record changed. Reopen this comparison to see the update.", "一项支持记录已更改。请重新打开这项比较查看更新。"],
      earlierRange: ["S up to, but not including, C", "S至C之前"],
      recentRange: ["C up to, but not including, E", "C起至E之前"],
      boundaryNote: [
        "The two periods meet at C. A reading recorded before then is in the earlier period; a reading recorded at or after it is in the recent period.",
        "两个期间以C为分界：在此之前记录的读数属于较早期间，在此时或之后记录的读数属于近期。",
      ],
    });
    for (const [key, , chinese] of pairs) {
      // Full-width punctuation only; these keys do not address the reader, so they need neither 您 nor 你.
      expect(chinese, key).not.toMatch(/[()[\]:;,!?]|\.(?!\d)/);
      expect(chinese, key).not.toMatch(/你/);
    }
    // Wording boundary: the panel copy never names the full range, a spread or a clinical judgement.
    for (const [key, english, chinese] of pairs) {
      expect(english, key).not.toMatch(/\brange\b|spread|normal|high|low|risk/i);
      expect(chinese, key).not.toMatch(/范围|偏高|偏低|风险/);
    }
  });

  it("pins the care-draft notice copy: the approved notices in AI_LANGUAGE_COPY and the printed section heading (careSummary.draftNotices.label)", () => {
    // Packet 11C B1a: the notice text has one runtime source, AI_LANGUAGE_COPY.careDraftNotices (rendered into the snapshot's
    // CARE_DRAFT_NOTICE blocks); the Checkpoint 2 i18n mirror was removed. `label` is now the printed section's heading
    // (asset care-summary.section.draft-notices, care-summary-locale.11c.1), new wording, human acceptance pending.
    const en = { label: getMessages("en-SG").careSummary.draftNotices.label, questions: AI_LANGUAGE_COPY.careDraftNotices.questions["en-SG"], draft: AI_LANGUAGE_COPY.careDraftNotices.draft["en-SG"] };
    const zh = { label: getMessages("zh-SG").careSummary.draftNotices.label, questions: AI_LANGUAGE_COPY.careDraftNotices.questions["zh-SG"], draft: AI_LANGUAGE_COPY.careDraftNotices.draft["zh-SG"] };
    expect(Object.keys(getMessages("en-SG").careSummary.draftNotices)).toEqual(["label"]);
    expect(Object.keys(getMessages("zh-SG").careSummary.draftNotices)).toEqual(["label"]);
    expect({ en, zh }).toEqual({
      en: {
        label: "Notes about this draft",
        questions: "Questions are shown in your own words; the app does not carry them out.",
        draft: "The app does not send this draft to your care team or confirm that a clinician has reviewed it.",
      },
      zh: {
        label: "关于此草稿的说明",
        questions: "问题按您的原话显示，应用不会照此执行。",
        draft: "应用不会把此草稿发送给护理团队，也不会确认医护人员已审阅。",
      },
    });
    for (const key of ["label", "questions", "draft"] as const) {
      // Full-width punctuation only; where the reader is addressed it is 您, never 你.
      expect(zh[key], key).not.toMatch(/[()[\]:;,!?]|\.(?!\d)/);
      expect(zh[key], key).not.toMatch(/你/);
    }
    expect(zh.questions).toContain("您");
    // Each notice names sending or review only to deny it.
    expect(en.questions).toMatch(/does not carry them out/);
    expect(en.draft).toMatch(/^The app does not send .* or confirm that a clinician has reviewed it\.$/);
    expect(zh.questions).toMatch(/不会照此执行/);
    expect(zh.draft).toMatch(/^应用不会把此草稿发送给护理团队，也不会确认医护人员已审阅。$/);
  });

  it("pins the Packet 11C B1a (D3) re-prepare message with en/zh parity, 您 and full-width zh punctuation (human acceptance pending)", () => {
    const en = getMessages("en-SG").careSummary.templateSuperseded;
    const zh = getMessages("zh-SG").careSummary.templateSuperseded;
    expect({ en, zh }).toEqual({
      en: "This summary was made with an earlier version of JagaOn. Prepare it again before you approve it.",
      zh: "此摘要由较早版本的 JagaOn 制作。请您重新制作摘要，然后再批准。",
    });
    expect(zh).not.toMatch(/[()[\]:;,!?]|\.(?!\d)|你/);
    expect(zh).toContain("您");
    // Non-technical: no version label, code or template wording.
    expect(`${en} ${zh}`).not.toMatch(/9c|11c|template|renderer|SUMMARY_|模板/i);
  });

  it("pins the Packet 11 shared AI disclosure copy (ai.*): the approved rows exactly, the corrected remoteBody (ai-disclosure.11c.2), en/zh parity", () => {
    const en = getMessages("en-SG").ai;
    const zh = getMessages("zh-SG").ai;
    // Packet 11C B4b (deliberate): plus the shared fallback rows and the care-summary flow rows (pinned in the next test).
    // Packet 11C Addendum C, C4 (deliberate): plus the approved marking rows demoTag and resultCheck (pinned against the matrix in
    // src/i18n/packet-11c-ai-marking-rows.test.ts).
    expect(Object.keys(en).sort()).toEqual(["cancel", "cancelled", "careSummary", "demoTag", "pattern", "remoteBody", "remoteLimit", "remoteNotAccepted", "remoteTitle", "resultCheck", "retry", "unavailable"]);
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    expect(Object.keys(en.pattern)).toEqual(["confirm"]);
    expect(Object.keys(en.careSummary)).toEqual(["confirm", "action", "loading", "resultTitle", "resultBody", "fallback", "changed", "notEligible"]);
    expect(Object.keys(zh.pattern)).toEqual(["confirm"]);
    expect(Object.keys(zh.careSummary)).toEqual(Object.keys(en.careSummary));
    const disclosureOnly = (messages: typeof en) => ({ cancel: messages.cancel, remoteTitle: messages.remoteTitle, remoteLimit: messages.remoteLimit, pattern: messages.pattern, careSummary: { confirm: messages.careSummary.confirm }, remoteBody: messages.remoteBody, remoteNotAccepted: messages.remoteNotAccepted });
    expect({ en: disclosureOnly(en), zh: disclosureOnly(zh) }).toEqual({
      en: {
        // APPROVED_PACKET_11 rows (11-bilingual-copy-state-matrix.md Sections 2-4), exact.
        cancel: "Cancel",
        remoteTitle: "Use AI for this synthetic demo?",
        remoteLimit: "Do not enter real patient information in this hackathon demo.",
        pattern: { confirm: "Generate explanation" },
        careSummary: { confirm: "Organise selected information" },
        // ai-disclosure.11c.2 (owner wording 2026-10-12): replaces the approved row, which named Kie.ai and said the
        // selected information is sent. The request is value-blind. Owner decision 2026-10-12: the copy says "AI" and names no provider,
        // so the model can change without a copy change.
        remoteBody: "To suggest wording, JagaOn sends AI a request that contains no values, dates, names or your own text. JagaOn fills in your records itself and checks the result before showing it.",
        // ai-remote-use.11c.1 (Packet 11C B4a; human acceptance pending): the result when the disclosure was not accepted (nothing sent).
        remoteNotAccepted: "AI wording was not used. This is JagaOn's standard wording.",
      },
      zh: {
        cancel: "取消",
        remoteTitle: "是否在此模拟演示中使用 AI？",
        remoteLimit: "请勿在此黑客松演示中输入真实病患资料。",
        pattern: { confirm: "生成说明" },
        careSummary: { confirm: "整理所选资料" },
        remoteBody: "为了建议措辞，JagaOn 会向 AI 发送一个不包含数值、日期、姓名或您自己文字的请求。JagaOn 会自行填入您的记录，并在显示前检查结果。",
        remoteNotAccepted: "未使用 AI 措辞。以下是 JagaOn 的标准措辞。",
      },
    });
    const zhStrings = [zh.cancel, zh.remoteTitle, zh.remoteBody, zh.remoteLimit, zh.pattern.confirm, zh.careSummary.confirm, zh.remoteNotAccepted];
    const enStrings = [en.cancel, en.remoteTitle, en.remoteBody, en.remoteLimit, en.pattern.confirm, en.careSummary.confirm, en.remoteNotAccepted];
    for (const text of zhStrings) {
      // Full-width punctuation only; where the reader is addressed it is 您, never 你.
      expect(text).not.toMatch(/[()[\]:;,!?]|\.(?!\d)/);
      expect(text).not.toMatch(/你/);
    }
    expect(zh.remoteBody).toContain("您");
    // The disclosure names no AI provider (owner decision 2026-10-12) and claims no consent, confidentiality, storage or deletion.
    for (const text of [...enStrings, ...zhStrings]) {
      expect(text).not.toMatch(/Kie|DeepSeek/i);
      expect(text).not.toMatch(/consent|agree|confidential|private|privacy|secure|safe|stored|store|retain|delete|encrypt|medical advice|diagnos|recommend/i);
      expect(text).not.toMatch(/同意|保密|隐私|安全|保存|储存|删除|加密|建议您|诊断/);
    }
    expect(en.remoteBody).toContain("JagaOn sends AI a request");
    expect(zh.remoteBody).toContain("JagaOn 会向 AI 发送");
    // Value-blind: the body denies sending values, dates, names and the person's own text, in both locales.
    expect(en.remoteBody).toMatch(/contains no values, dates, names or your own text/);
    expect(zh.remoteBody).toMatch(/不包含数值、日期、姓名或您自己文字/);
  });

  it("pins the Packet 11C B4b care-summary AI wording copy: the approved rows exactly, one new row (ai-care-summary.11c.1), en/zh parity", () => {
    const en = getMessages("en-SG").ai;
    const zh = getMessages("zh-SG").ai;
    const flow = (messages: typeof en) => ({ unavailable: messages.unavailable, cancelled: messages.cancelled, retry: messages.retry, careSummary: messages.careSummary });
    expect({ en: flow(en), zh: flow(zh) }).toEqual({
      en: {
        // APPROVED_PACKET_11 rows (11-bilingual-copy-state-matrix.md Sections 2 and 4), exact.
        unavailable: "AI is not available right now. Your recorded information has not changed.",
        cancelled: "AI request cancelled. Your recorded information has not changed.",
        retry: "Try AI again",
        careSummary: {
          confirm: "Organise selected information",
          action: "Organise with AI",
          loading: "Organising your selected information…",
          resultTitle: "AI-assisted organisation",
          resultBody: "The selected facts and questions are unchanged. Review every item before approving.",
          fallback: "Your structured summary is still ready without AI.",
          changed: "Your selected information changed before the AI result was saved. Review the latest summary and try again if you wish.",
          // ai-care-summary.11c.1 (Packet 11C B4b; new wording, human acceptance pending): a preview the AI path cannot organise
          // (B1b NOT_ELIGIBLE, e.g. more facts than one request may carry). Nothing was sent.
          notEligible: "AI organisation is not available for this summary.",
        },
      },
      zh: {
        unavailable: "AI 目前无法使用。您已记录的资料没有改变。",
        cancelled: "已取消 AI 请求。您已记录的资料没有改变。",
        retry: "再次尝试 AI",
        careSummary: {
          confirm: "整理所选资料",
          action: "使用 AI 整理",
          loading: "正在整理您选择的资料…",
          resultTitle: "AI 辅助整理",
          resultBody: "所选的事实和问题没有改变。批准前，请检查每一项。",
          fallback: "即使不使用 AI，您的结构化摘要仍可使用。",
          changed: "保存 AI 结果前，您选择的资料已有更改。请检查最新摘要；如有需要，可再试一次。",
          notEligible: "此摘要无法使用 AI 整理。",
        },
      },
    });
    for (const text of [zh.unavailable, zh.cancelled, zh.retry, ...Object.values(zh.careSummary)]) {
      // Full-width punctuation only; where the reader is addressed it is 您, never 你.
      expect(text).not.toMatch(/[()[\]:;,!?]|\.(?!\d)/);
      expect(text).not.toMatch(/你/);
    }
    // Non-technical, and no claim of consent, confidentiality, medical review or advice.
    for (const text of [en.unavailable, en.cancelled, en.retry, ...Object.values(en.careSummary), zh.unavailable, zh.cancelled, zh.retry, ...Object.values(zh.careSummary)]) {
      expect(text).not.toMatch(/[A-Z]{2,}_[A-Z]|SUMMARY_|TOO_MANY|\b32\b|Kie|DeepSeek/);
      expect(text).not.toMatch(/consent|confidential|privacy|medical advice|diagnos|recommend|reviewed by|clinician/i);
      expect(text).not.toMatch(/同意|保密|隐私|诊断|医护人员已审/);
    }
  });

  it("uses the design's compact bilingual boundary", () => {
    expect(getMessages("en-SG").onboarding.compactBoundary).toBe(
      "Hackathon demo. Synthetic data only. Not for patient use.",
    );
    expect(getMessages("zh-SG").onboarding.compactBoundary).toBe("黑客松演示。仅使用模拟资料。不供病患使用。");
  });
});
