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

  it("names the field on each unknown toggle with locale punctuation", () => {
    expect(getMessages("en-SG").onboarding.iDontKnowNamed("Strength")).toBe("I don’t know — add later (Strength)");
    expect(getMessages("zh-SG").onboarding.iDontKnowNamed("浓度")).toBe("我不知道——稍后添加（浓度）");
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

describe("Packet 9A food copy (09-bilingual-copy-matrix.md Section 1)", () => {
  const en = getMessages("en-SG").food;
  const zh = getMessages("zh-SG").food;

  it("ships every approved 9A key with the exact matrix wording", () => {
    expect([en.locationNotSaved, zh.locationNotSaved]).toEqual(["Location is used only for this search and is not saved.", "位置资料仅用于这次搜索，不会被保存。"]);
    expect([en.liveMapLoading, zh.liveMapLoading]).toEqual(["Loading map…", "正在加载地图…"]);
    expect([en.oneMapAttribution, zh.oneMapAttribution]).toEqual(["Map data by OneMap · Singapore Land Authority", "地图资料由 OneMap · 新加坡土地管理局提供"]);
    expect([en.oneMapPrivacy, zh.oneMapPrivacy]).toEqual(["OneMap privacy and terms", "OneMap 隐私与条款"]);
    expect(en.liveGeocoderUnavailable).toBe("Live location search is unavailable. Try a 6-digit postal code or the dated demo data.");
    expect(zh.liveGeocoderUnavailable).toBe("实时地点搜索暂时无法使用。请尝试输入六位数邮政编码，或使用注明日期的演示资料。");
    expect([en.mapTilesUnavailable, zh.mapTilesUnavailable]).toEqual(["The map could not be loaded. The same places remain available in the list.", "地图无法加载。您仍可在列表中查看相同地点。"]);
    expect([en.governedDatasetSource, zh.governedDatasetSource]).toEqual(["HPB Healthier Dining Partners · data.gov.sg", "保健促进局较健康餐饮伙伴 · data.gov.sg"]);
    expect([en.governedDatasetDate("2026-10-02"), zh.governedDatasetDate("2026-10-02")]).toEqual(["Dataset date: 2026-10-02", "数据集日期：2026-10-02"]);
    expect([en.governedDatasetStale, zh.governedDatasetStale]).toEqual(["This is a dated dataset. Check current availability with the outlet.", "这是注明日期的数据集。请向餐饮地点查询最新供应情况。"]);
    expect([en.syntheticFallbackActive, zh.syntheticFallbackActive]).toEqual(["Live providers are unavailable. Showing clearly labelled synthetic demo places.", "实时服务暂时无法使用。现正显示清楚标示的模拟演示地点。"]);
    expect([en.locationTimedOut, zh.locationTimedOut]).toEqual(["Location took too long. Enter a postal code or location instead.", "获取位置所需时间过长。请改为输入邮政编码或地点。"]);
    expect([en.locationUnavailable, zh.locationUnavailable]).toEqual(["Your location is unavailable. Enter a postal code or location instead.", "无法取得您的位置。请改为输入邮政编码或地点。"]);
  });

  it("keeps the governed attribute labels exact and never a lower-GI claim", () => {
    expect([en.attrWholegrains, en.attrLowerSugar, en.attrLowerCalories]).toEqual(["Higher in wholegrains", "Lower in sugar", "Lower in calories"]);
    for (const value of Object.values(en)) {
      const text = typeof value === "function" ? String((value as (...args: string[]) => string)("X", "Y")) : value;
      expect(text).not.toMatch(/lower gi|low gi|glycaemic index|best for (you|diabetes)/i);
    }
  });
});

describe("Packet 9B care-organisation copy (09-bilingual-copy-matrix.md Sections 2–3)", () => {
  const en = getMessages("en-SG");
  const zh = getMessages("zh-SG");

  it("ships every approved Section 2 row with the exact matrix wording", () => {
    const rows: Array<[keyof typeof en.preventiveCare, string, string]> = [
      ["title", "My health checks", "我的健康检查"],
      ["maintainedByYou", "These dates are maintained by you. JagaOn does not decide when care is due.", "这些日期由你维护。JagaOn 不决定何时需要护理。"],
      ["statusScheduled", "Scheduled", "已安排"],
      ["statusRecorded", "Recorded", "已记录"],
      ["statusNoDate", "No date recorded", "未记录日期"],
      ["dateEntered", "Date I entered", "我输入的日期"],
      ["note", "Note", "备注"],
      ["source", "Source", "来源"],
      ["markRecorded", "Mark as recorded", "标记为已记录"],
      ["undoRecorded", "Undo recorded", "撤销已记录"],
      ["edit", "Edit", "编辑"],
      ["history", "History", "历史记录"],
      ["addItem", "Add an item", "添加项目"],
      ["recordLimitation", "These are your records. The app doesn't judge which checks are due, needed or eligible.", "这些是你的记录。应用不会判断哪些检查到期、需要或符合资格。"],
      ["generalHeading", "General preventive-health information", "一般预防保健资讯"],
      ["reviewedTag", "General reviewed information", "一般审阅资讯"],
      ["generalIntro", "Reviewed information for adults living with type 1 diabetes (the demo audience). You open it. Not a schedule for you.", "针对成年第一型糖尿病患者（演示对象）的审阅资讯。由你打开。不是针对你的时间表。"],
      ["generalNotAssessment", "General information — not a personalised due-date assessment.", "一般资讯 — 不是个人化的到期评估。"],
      ["emptyTitle", "No health-check items recorded", "尚未记录健康检查项目"],
      ["emptyBody", "Add a date or note you want JagaOn to organise.", "添加你希望 JagaOn 协助整理的日期或备注。"],
      ["saveFailed", "This was not saved. Your entries are still on screen.", "此项目尚未保存。你输入的资料仍保留在画面上。"],
    ];
    for (const [key, english, chinese] of rows) {
      expect([key, en.preventiveCare[key]]).toEqual([key, english]);
      expect([key, zh.preventiveCare[key]]).toEqual([key, chinese]);
    }
  });

  it("ships every approved Section 3 row with the exact matrix wording", () => {
    const rows: Array<[keyof typeof en.carePreparation, string, string]> = [
      ["title", "Prepare for my visit", "为复诊做准备"],
      ["appointmentEnteredByYou", "Appointment entered by you", "预约由你输入"],
      ["appointmentUnverified", "Details not verified by the clinic", "资料未经诊所核实"],
      ["actionsTag", "Your actions", "你的操作"],
      ["includeHeading", "Include in my summary", "我的摘要包含"],
      ["glucoseReadings", "Glucose readings", "血糖读数"],
      ["insulinRecords", "Insulin records", "胰岛素记录"],
      ["mealNotes", "Meal notes", "饮食笔记"],
      ["walks", "Walks", "散步"],
      ["questionsHeading", "Questions I want to ask", "我想问的问题"],
      ["questionsIntro", "Optional groups. Only questions you tick go into the summary.", "可选的问题组。只有你勾选的问题会进入摘要。"],
      ["medicineInfoQuestions", "Questions about my medicine information", "关于我的药物资讯的问题"],
      ["directionsQuestions", "Questions about my recorded directions", "关于我记录的用药指示的问题"],
      ["routineQuestions", "Questions about routines or barriers I recorded", "关于我记录的作息或情况的问题"],
      ["trendQuestions", "Questions about my recorded trends", "关于我记录的趋势的问题"],
      ["preventiveQuestions", "Questions about general preventive-health information", "关于一般预防保健资讯的问题"],
      ["noneSelected", "None selected", "未选择"],
      ["addOwnQuestion", "Add my own question", "添加我自己的问题"],
      ["questionLabel", "My question", "我的问题"],
      ["questionHint", "JagaOn stores your words and does not answer the question.", "JagaOn 会保存你输入的原文，但不会回答这个问题。"],
      ["selectionLimitation", "Each item is your question or a factual record you chose. JagaOn doesn't answer them, and no clinician has reviewed them.", "每个问题都是你的问题或你选择的事实记录。JagaOn 不回答它们，也没有任何医护人员审阅过。"],
      ["previewSummary", "Preview summary", "预览摘要"],
      ["exportOrPrint", "Export or print my summary", "导出或打印我的摘要"],
      ["localOnly", "Stays on this phone. Nothing is sent to anyone automatically.", "只保存在这部手机上。不会自动发送给任何人。"],
      ["emptySelection", "Choose at least one factual record or question.", "请至少选择一项事实记录或问题。"],
      ["saveFailed", "This was not saved. Your selections are still on screen.", "此操作尚未保存。你的选择仍保留在画面上。"],
    ];
    for (const [key, english, chinese] of rows) {
      expect([key, en.carePreparation[key]]).toEqual([key, english]);
      expect([key, zh.carePreparation[key]]).toEqual([key, chinese]);
    }
  });

  it("keeps identical key sets in both locales", () => {
    expect(Object.keys(zh.preventiveCare).sort()).toEqual(Object.keys(en.preventiveCare).sort());
    expect(Object.keys(zh.carePreparation).sort()).toEqual(Object.keys(en.carePreparation).sort());
  });

  it("renders the primary-frame 10 interpolations", () => {
    expect([en.carePreparation.inDays(22), zh.carePreparation.inDays(22)]).toEqual(["in 22 days", "22 天后"]);
    expect(en.carePreparation.inDays(1)).toBe("in 1 day");
    expect(en.carePreparation.glucoseDetail("12 Aug", "22 Sep", 126)).toBe("12 Aug \u2013 22 Sep \u00b7 126 readings \u00b7 listed by time");
    expect(zh.carePreparation.glucoseDetail("8月12日", "9月22日", 126)).toBe("8月12日 \u2013 9月22日 \u00b7 共 126 次 \u00b7 按时间列出");
  });

  // Matrix Section 5: rows that explicitly negate a claim are checked by exact key above.
  const NEGATING_KEYS = new Set(["maintainedByYou", "recordLimitation", "generalNotAssessment", "selectionLimitation", "localOnly", "appointmentUnverified", "questionHint"]);
  const texts = (catalogue: Record<string, unknown>) =>
    Object.entries(catalogue)
      .filter(([key]) => !NEGATING_KEYS.has(key))
      .map(([key, value]) => [key, typeof value === "function" ? String((value as (...args: unknown[]) => string)(3, "X", 2)) : String(value)] as const);

  it("rejects positive due, eligibility, recommendation, diagnosis, adherence and delivery claims in English", () => {
    for (const catalogue of [en.preventiveCare, en.carePreparation]) {
      for (const [key, text] of texts(catalogue)) {
        expect([key, text]).not.toEqual([key, expect.stringMatching(/\bdue\b|overdue|eligib|recommend|diagnos|\bcause|\brisk|adheren|\bsent\b|deliver|received|reviewed by|confirmed/i)]);
      }
    }
  });

  it("rejects the prohibited Chinese claims", () => {
    for (const catalogue of [zh.preventiveCare, zh.carePreparation]) {
      for (const [key, text] of texts(catalogue)) {
        expect([key, text]).not.toEqual([key, expect.stringMatching(/逾期|应做|符合资格|建议|诊断|原因|风险|依从性|已发送|已送达|已收到|医护人员已审核|诊所已确认/)]);
      }
    }
  });
});

describe("Packet 9C care-summary copy (09-bilingual-copy-matrix.md Section 4)", () => {
  const en = getMessages("en-SG").careSummary;
  const zh = getMessages("zh-SG").careSummary;

  it("ships every approved Section 4 row with the exact matrix wording", () => {
    const rows: Array<[keyof typeof en, string, string]> = [
      ["title", "Preview my summary", "预览我的摘要"],
      ["selectedOnly", "This summary contains only the records and questions you selected.", "此摘要仅包含你所选择的记录和问题。"],
      ["scopeHeading", "Summary scope", "摘要范围"],
      ["carePlanHeading", "Current recorded care plan", "当前记录的护理计划"],
      ["organisationHeading", "Care organisation", "护理安排"],
      ["measurementsHeading", "Recorded measurements", "测量记录"],
      ["medicationHeading", "Medication records", "用药记录"],
      ["questionsHeading", "Questions for my care team", "给护理团队的问题"],
      ["limitationsHeading", "About this summary", "关于此摘要"],
      ["patientReported", "Patient-reported information; not externally verified.", "由使用者自行报告；未经外部核实。"],
      ["missingLimitation", "Missing or unrecorded information may not appear here.", "缺失或未记录的资料可能不会显示在这里。"],
      ["approveAction", "Approve this exact summary", "批准这份确切摘要"],
      ["approvalMeaning", "Approval means you have reviewed this content for local printing. It does not verify the records.", "批准表示你已查看这些内容并同意在本机打印，但并不表示记录已获核实。"],
      ["printAction", "Open print dialog", "打开打印对话框"],
      ["printOpened", "The print dialog was opened. JagaOn cannot tell whether anything was printed or shared.", "打印对话框已打开。JagaOn 无法确定资料是否已打印或分享。"],
      ["printUnavailable", "Printing is unavailable on this device. No summary was sent.", "此设备无法使用打印功能。摘要并未发送。"],
      ["sourceChanged", "A selected record changed. Prepare and review a new summary before printing.", "一项所选记录已更改。请重新制作并查看摘要后再打印。"],
      ["hashMismatch", "This preview no longer matches the approved summary. Prepare it again.", "此预览已不再与获批准的摘要相符。请重新制作摘要。"],
      ["backToPreparation", "Back to visit preparation", "返回复诊准备"],
    ];
    for (const [key, english, chinese] of rows) {
      expect([key, en[key]]).toEqual([key, english]);
      expect([key, zh[key]]).toEqual([key, chinese]);
    }
  });

  it("keeps identical key sets in both locales", () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
  });

  // Rows that explicitly negate sending, verification or review are checked by exact key above.
  const NEGATING = new Set(["approvalMeaning", "printOpened", "printUnavailable", "printUnknown", "patientReported", "missingLimitation", "selectedOnly"]);
  const texts = (catalogue: Record<string, unknown>) =>
    Object.entries(catalogue)
      .filter(([key]) => !NEGATING.has(key))
      .map(([key, value]) => [key, typeof value === "function" ? String((value as (...args: unknown[]) => string)("X")) : String(value)] as const);

  it("makes no positive delivery, receipt, review or clinical claim in English", () => {
    for (const [key, text] of texts(en)) {
      expect([key, text]).not.toEqual([key, expect.stringMatching(/\bsent\b|deliver|received|reviewed by|clinician|confirmed|diagnos|recommend|\brisk|adheren|overdue|\bdue\b/i)]);
    }
  });

  it("makes no positive delivery, receipt, review or clinical claim in Chinese", () => {
    for (const [key, text] of texts(zh)) {
      expect([key, text]).not.toEqual([key, expect.stringMatching(/已发送|已送达|已收到|医护人员已审核|诊所已确认|逾期|应做|符合资格|建议|诊断|原因|风险|依从性/)]);
    }
  });
});
