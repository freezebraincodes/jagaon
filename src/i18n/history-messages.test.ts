import { describe, expect, it } from "vitest";
import { getMessages } from "./get-messages";

const en = getMessages("en-SG").history;
const zh = getMessages("zh-SG").history;

/** Independent copy of the 07a copy-matrix strings (static rows). */
const STATIC: Record<string, [string, string]> = {
  title: ["Recorded history", "记录历史"],
  periodThisWeek: ["This week", "本周"],
  periodLastWeek: ["Last week", "上周"],
  periodThirtyDays: ["30 days", "30天"],
  loading: ["Loading recorded history…", "正在载入记录历史…"],
  unavailableTitle: ["Recorded history is unavailable", "暂时无法显示记录历史"],
  unavailableBody: [
    "Your existing records are unchanged. Try again when storage is available.",
    "您现有的记录没有改变。请在储存空间恢复后重试。",
  ],
  retry: ["Try again", "重试"],
  emptyTitle: ["No readings recorded for this period", "这段期间没有读数记录"],
  emptyBody: [
    "Entries you record will appear here. This does not mean no measurements were taken.",
    "您记录的项目会显示在这里。这不表示没有进行测量。",
  ],
  insufficientTitle: ["Not enough comparable records yet", "暂时没有足够的可比较记录"],
  insufficientBody: [
    "JagaOn can show the recorded counts and range, but cannot compare these periods yet.",
    "JagaOn可以显示记录次数和范围，但暂时无法比较这些期间。",
  ],
  recordedLegend: ["recorded", "已记录"],
  notRecordedLegend: ["not recorded", "未记录"],
  chartSlotsNote: [
    "Two display positions per day: morning and evening. Shown as recorded.",
    "每天显示两个位置：早上和晚上。内容按记录显示。",
  ],
  recordedDataTag: ["Your recorded data", "您记录的数据"],
  factsTitle: ["What these records show", "这些记录显示"],
  sourcePatientEntered: ["records entered in this demo", "在本演示中输入的记录"],
  correctionUpdated: ["Updated after a corrected record.", "已根据更正后的记录更新。"],
  nonCausalLimitation: ["This describes your records; it does not explain the cause.", "这只描述您的记录；并不解释原因。"],
  loggingLimitation: [
    "This is a record, not a clinical analysis. Numbers describe what you entered and do not explain why.",
    "这是记录，并非临床分析。数字只描述您输入的内容，并不解释原因。",
  ],
  bookletTitle: ["Booklet stamps", "记录册印章"],
  bookletOnly: ["logging completion only", "仅代表记录完成"],
  bookletExplanation: [
    "A stamp means both display positions were recorded that day. It says nothing about the values.",
    "印章表示当天两个显示位置都有记录，并不说明数值的意义。",
  ],
  actionsTag: ["Your actions", "您的操作"],
  addFacts: ["Add these facts to appointment notes", "将这些事实加入看诊备注"],
  selectFacts: ["Select facts for appointment notes", "选择要加入看诊备注的事实"],
  factSelected: ["Selected for appointment notes", "已选择加入看诊备注"],
  factNotSelected: ["Not selected", "未选择"],
  selectionSaved: ["Selection saved on this device. No summary was sent.", "选择已储存在此设备上。没有发送任何摘要。"],
  familyUnavailable: ["This comparison is not available in this demo.", "本演示不提供这项比较。"],
};

describe("Packet 7A history catalogue", () => {
  it("matches the copy matrix exactly in both locales", () => {
    for (const [key, [english, chinese]] of Object.entries(STATIC)) {
      expect((en as unknown as Record<string, string>)[key], key).toBe(english);
      expect((zh as unknown as Record<string, string>)[key], key).toBe(chinese);
    }
  });

  it("interpolates every parameterised row with identical meaning", () => {
    expect([en.readingsTitle("mmol/L"), zh.readingsTitle("mmol/L")]).toEqual(["Readings, mmol/L", "读数，mmol/L"]);
    expect(en.chartDescription(12, 14, "mmol/L")).toBe(
      "Chart of 12 recorded readings across 14 display positions, in mmol/L. Missing positions are labelled not recorded.",
    );
    expect(zh.chartDescription(12, 14, "mmol/L")).toBe("图表显示14个位置中的12个读数记录，单位为mmol/L。没有记录的位置标为未记录。");
    expect([en.periodRange("15–21 Sep"), zh.periodRange("9月15日–21日")]).toEqual(["15–21 Sep", "9月15日–21日"]);
    expect(en.readingCount(12, "15–21 Sep")).toBe("12 readings were recorded from 15–21 Sep.");
    expect(zh.readingCount(12, "9月15日–21日")).toBe("9月15日–21日期间记录了12个读数。");
    expect(en.valueRange("3.9", "10.2", "mmol/L")).toBe("Recorded values ranged from 3.9 to 10.2 mmol/L.");
    expect(zh.valueRange("3.9", "10.2", "mmol/L")).toBe("记录数值介于3.9至10.2 mmol/L。");
    expect(en.slotCount("before breakfast", 5)).toBe("before breakfast: 5 recorded readings.");
    expect(zh.slotCount("早餐前", 5)).toBe("早餐前：5个读数记录。");
    const comparison = "For comparable before breakfast records, the recent median was 7.3 mmol/L, compared with 6 mmol/L in the earlier period.";
    expect(en.comparisonHigher("before breakfast", "7.3", "6", "mmol/L")).toBe(comparison);
    expect(en.comparisonLower("before breakfast", "7.3", "6", "mmol/L")).toBe(comparison);
    expect(zh.comparisonHigher("早餐前", "7.3", "6", "mmol/L")).toBe("在可比较的早餐前记录中，近期中位数为7.3 mmol/L，较早期间为6 mmol/L。");
    expect(en.comparisonVariability("bedtime", "1.2", "0.4", "mmol/L")).toBe(
      "For comparable bedtime records, the recent recorded spread was 1.2 mmol/L, compared with 0.4 mmol/L earlier.",
    );
    expect(zh.comparisonVariability("睡前", "1.2", "0.4", "mmol/L")).toBe("在可比较的睡前记录中，近期记录范围为1.2 mmol/L，较早期间为0.4 mmol/L。");
    expect(en.noMaterialComparison("before dinner")).toBe(
      "The comparable before dinner records did not meet the governed threshold for a numerical difference.",
    );
    expect(zh.noMaterialComparison("晚餐前")).toBe("可比较的晚餐前记录未达到受控规则所设的数值差异门槛。");
    expect(en.repeatedItem("Kaya toast", 5, 4)).toBe("“Kaya toast” appears in 5 records across 4 days.");
    expect(zh.repeatedItem("Kaya toast", 5, 4)).toBe("“Kaya toast”在4天内的5条记录中出现。");
    expect(en.repeatedContext("Morning walk", 6, 6)).toBe("Recorded context “Morning walk” appears 6 times across 6 days.");
    expect(zh.repeatedContext("Morning walk", 6, 6)).toBe("记录情境“Morning walk”在6天内出现6次。");
    expect(en.notRecordedPosition("Wednesday evening")).toBe("No reading was recorded for Wednesday evening.");
    expect(zh.notRecordedPosition("周三晚上")).toBe("周三晚上没有读数记录。");
    expect(en.notRecordedPositions("Wednesday evening and Sunday evening")).toBe(
      "No reading was recorded for Wednesday evening and Sunday evening.",
    );
    expect(zh.notRecordedPositions("周三晚上和周日晚上")).toBe("周三晚上和周日晚上没有读数记录。");
    expect(en.sourceSummary(en.sourcePatientEntered)).toBe("Source: records entered in this demo.");
    expect(zh.sourceSummary(zh.sourcePatientEntered)).toBe("来源：在本演示中输入的记录。");
    expect(en.correctionSummary(1)).toBe("1 recorded item’s earlier revision was kept after correction.");
    expect(zh.correctionSummary(1)).toBe("更正后保留了1个记录项目的较早版本。");
    expect(en.evidenceWindow("20 Sep – 4 Oct", "23 Aug – 20 Sep")).toBe(
      "Evidence windows: recent 20 Sep – 4 Oct; earlier comparison 23 Aug – 20 Sep.",
    );
    expect(zh.evidenceWindow("9月20日至10月4日", "8月23日至9月20日")).toBe("证据期间：近期9月20日至10月4日；较早比较期间8月23日至9月20日。");
    expect(en.completeStamp("Mon 28 Sep")).toBe("Both display positions recorded on Mon 28 Sep.");
    expect(zh.completeStamp("9月28日")).toBe("9月28日的两个显示位置都有记录。");
    expect(en.incompleteStamp("Tue 29 Sep", 1)).toBe("1 of 2 display positions recorded on Tue 29 Sep.");
    expect(zh.incompleteStamp("9月29日", 1)).toBe("9月29日的两个显示位置中有1个记录。");
    expect(en.disabledFamily("ROUTINE_SHIFT")).toBe("ROUTINE_SHIFT is not enabled in this demo. No conclusion was produced.");
    expect(zh.disabledFamily("ROUTINE_SHIFT")).toBe("本演示未启用ROUTINE_SHIFT。系统没有作出结论。");
  });

  it("keeps patient-entered labels verbatim in both locales", () => {
    expect(zh.repeatedItem("Kaya toast", 2, 2)).toContain("Kaya toast");
    expect(en.repeatedItem("咖椰吐司", 2, 2)).toContain("咖椰吐司");
  });

  it("defines the typed slot, position and period labels", () => {
    expect(en.slotLabels).toEqual({
      BEFORE_BREAKFAST: "before breakfast",
      BEFORE_LUNCH: "before lunch",
      BEFORE_DINNER: "before dinner",
      BEDTIME: "bedtime",
    });
    expect(zh.slotLabels).toEqual({ BEFORE_BREAKFAST: "早餐前", BEFORE_LUNCH: "午餐前", BEFORE_DINNER: "晚餐前", BEDTIME: "睡前" });
    expect(en.positionLabels).toEqual({ MORNING: "morning", EVENING: "evening" });
    expect(zh.positionLabels).toEqual({ MORNING: "早上", EVENING: "晚上" });
    expect(en.periodLabels).toEqual({ THIS_WEEK: "this week", LAST_WEEK: "last week", THIRTY_DAYS: "30 days" });
    expect(zh.periodLabels).toEqual({ THIS_WEEK: "本周", LAST_WEEK: "上周", THIRTY_DAYS: "30天" });
  });

  it("has identical keys in both locales", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
  });

  it("contains no prohibited clinical, causal, adherence, prediction or delivery meaning", () => {
    const strings = (catalogue: typeof en) =>
      Object.values(catalogue).flatMap((value) =>
        typeof value === "string"
          ? [value]
          : typeof value === "function"
            ? [(value as (...args: unknown[]) => string)("X", 2, 3, "Y")]
            : Object.values(value as Record<string, string>),
      );
    // Permitted denials and record-only limitations from the matrix.
    const DENIALS = [/does not explain the cause/, /do not explain why/, /not a clinical analysis/, /does not mean no measurements/, /No summary was sent/];
    const PROHIBITED = [
      /\bhigh\b/i, /\blow\b/i, /\bnormal\b/i, /abnormal/i, /\bsafe\b/i, /unsafe/i, /target/i, /improv/i, /worsen/i,
      /\bcontrol/i, /\brisk\b/i, /\bcaus/i, /effect/i, /missed/i, /adheren/i, /complian/i, /predict/i, /diagnos/i,
      /\bdose\b/i, /recommend/i, /should/i, /clinician/i, /doctor/i, /reviewed/i, /delivered/i, /\bsent\b/i,
    ];
    for (const text of strings(en)) {
      const stripped = DENIALS.reduce((value, pattern) => value.replace(pattern, ""), text);
      for (const pattern of PROHIBITED) expect(stripped, text).not.toMatch(pattern);
    }
    const ZH_PROHIBITED = [/偏高/, /偏低/, /正常/, /异常/, /安全/, /风险/, /改善/, /恶化/, /控制/, /漏/, /依从/, /预测/, /诊断/, /剂量/, /建议/, /医生/, /已发送/];
    for (const text of strings(zh)) for (const pattern of ZH_PROHIBITED) expect(text, text).not.toMatch(pattern);
  });
});
