import { describe, expect, it } from "vitest";
import { aiTaskRequestSchema, type AiTaskRequest } from "@/domain/ai";
import { outputFixture, requestFixture } from "@/domain/ai/ai-test-fixtures";
import { MEANING_RULES, meaningScanText } from "./ai-meaning-rules";
import { validateAiTaskOutput } from "./ai-output-validator";
import { AI_TASK_RUNTIME_BUNDLES } from "./ai-runtime-bundles";

/**
 * Packet 11B corrective pass (owner instruction 2026-10-06): the meaning gate
 * must accept faithful, non-clinical statements of the required limitation
 * DOES_NOT_ESTABLISH_CAUSE and neutral process wording, while every genuine
 * forbidden meaning still fails. Acceptance is structural (whole-sentence
 * templates), never a general negation bypass.
 */

const request = (zh: boolean) => aiTaskRequestSchema.parse({ ...requestFixture("EXPLAIN_PATTERN"), locale: zh ? "zh-SG" : "en-SG" }) as AiTaskRequest;
function output(zh: boolean, field: "limitation" | "observation", text: string) {
  const value = structuredClone(outputFixture("EXPLAIN_PATTERN")) as Record<string, any>;
  if (zh) {
    value.locale = "zh-SG";
    value.payload.headline.text = "最近记录的数值是 6.2 和 7.1 mmol/L。";
    value.payload.observation.text = "最近记录的数值是 6.2 和 7.1 mmol/L。";
    value.payload.evidence.text = "这使用了 10 个已记录的读数。";
  }
  // Option B (11b.1): the model writes no limitations, so limitation-style sentences are exercised in the
  // generated evidence field; the meaning rules applied are identical.
  if (field === "limitation") value.payload.evidence.text = text;
  else value.payload.observation.text = text;
  return value;
}
const verdict = (zh: boolean, field: "limitation" | "observation", text: string) => {
  const result = validateAiTaskOutput(request(zh), AI_TASK_RUNTIME_BUNDLES.EXPLAIN_PATTERN, output(zh, field, text));
  return result.kind === "ACCEPTED" ? "ACCEPTED" : result.reason;
};

describe("faithful DOES_NOT_ESTABLISH_CAUSE limitations are accepted (previous false positives)", () => {
  it.each([
    ["This does not establish a cause."],
    ["This comparison does not establish what caused the difference."],
    ["This does not show what caused the change."],
    ["It does not tell us the reason for the difference."],
    ["The cause of the difference is not established."],
    ["This does not establish a cause"],
    ["This does not establish a cause!"],
    ["  This does not  establish a cause.  "],
    ["These records cannot establish the cause."],
    ["This does not explain why the readings differed."],
  ])("en-SG: %s", (text) => {
    expect(verdict(false, "limitation", text)).toBe("ACCEPTED");
  });

  it.each([["这不能确定原因。"], ["这无法说明差异的原因。"], ["这并不说明是什么导致了差异。"], ["这些记录无法确定变化的原因。"], ["这不能确定原因"], ["这不能确定原因！"], ["这不解释读数不同的原因。"]])("zh-SG: %s", (text) => {
    expect(verdict(true, "limitation", text)).toBe("ACCEPTED");
  });
});

describe("neutral process wording is accepted", () => {
  it.each([["This summary will be based on 10 recorded readings."], ["This explanation is based on the selected recorded information."], ["This summary will be based on your selected records."]])("en-SG: %s", (text) => {
    expect(verdict(false, "observation", text)).toBe("ACCEPTED");
  });

  it.each([["这份说明基于所选的记录资料。"], ["这份摘要将基于您选择的 10 个记录。"]])("zh-SG: %s", (text) => {
    expect(verdict(true, "observation", text)).toBe("ACCEPTED");
  });
});

describe("neighbouring genuine claims still fail", () => {
  it.each([
    ["The meal caused the change.", "observation"],
    ["The cause of the difference is the meal.", "observation"],
    ["The reason for the difference is your diet.", "observation"],
    ["This does not establish a cause, but the meal caused the rise.", "limitation"],
    ["This does not establish a cause; the meal caused the rise.", "limitation"],
    ["This does not establish a cause. The meal caused the rise.", "limitation"],
    ["The cause of the difference is not established, but stress is likely to raise it.", "limitation"],
    ["It does not tell us the reason for the difference, which is stress.", "limitation"],
    ["Not because of the meal, but because of stress.", "limitation"],
    ["Your doctor does not establish a cause.", "limitation"],
    ["This does not establish a cause of your diabetes.", "limitation"],
    ["Your readings will be higher next week.", "observation"],
    ["This summary will be based on readings that will keep rising.", "observation"],
    ["This summary will be based on 10 recorded readings and your readings are too high.", "observation"],
    ["The summary will be based on the readings, so you will get worse.", "observation"],
    ["This does not establish a cause. These readings are dangerous.", "limitation"],
    ["This does not establish a cause. Take your tablet now.", "limitation"],
  ] as const)("en-SG rejects: %s", (text, field) => {
    expect(verdict(false, field, text)).toBe("CLINICAL_MEANING_VIOLATION");
  });

  it.each([
    ["是榴莲导致了差异。", "observation"],
    ["差异的原因是饮食。", "observation"],
    ["这不能确定原因，但饮食导致了变化。", "limitation"],
    ["这不能确定原因。饮食导致了变化。", "limitation"],
    ["这无法说明差异的原因，因为您吃了榴莲。", "limitation"],
    ["这份摘要将基于记录，读数将会上升。", "observation"],
    ["这不能确定原因。读数偏高。", "limitation"],
    ["这不能确定 cause, but the meal caused it。", "limitation"],
  ] as const)("zh-SG rejects: %s", (text, field) => {
    expect(verdict(true, field, text)).toBe("CLINICAL_MEANING_VIOLATION");
  });
});

describe("shared immutable meaning rules", () => {
  it("are frozen, non-global definitions with closed ids, categories and locales", () => {
    expect(Object.isFrozen(MEANING_RULES)).toBe(true);
    for (const rule of MEANING_RULES) {
      expect(Object.isFrozen(rule)).toBe(true);
      expect(Object.isFrozen(rule.pattern)).toBe(true);
      expect(rule.pattern.global).toBe(false);
      expect(rule.pattern.sticky).toBe(false);
      expect(rule.id).toMatch(/^(clinical|authority)\.[a-z_]+\.(en|zh)$/);
    }
    expect(new Set(MEANING_RULES.map((rule) => rule.id)).size).toBe(MEANING_RULES.length);
  });

  it("strips only whole faithful limitation and process sentences before scanning", () => {
    expect(meaningScanText("This does not establish a cause.").trim()).toBe("");
    expect(meaningScanText("This does not establish a cause, but the meal caused it.")).toContain("caused");
    expect(meaningScanText("这不能确定原因。读数偏高。")).toContain("偏高");
  });
});

describe("false reassurance is rejected (Packet 11 bilingual review gate: no implied reassurance)", () => {
  it.each([
    ["Everything looks fine.", "observation"],
    ["Your readings look okay.", "observation"],
    ["It's all good.", "observation"],
    ["There is nothing to worry about.", "observation"],
    ["You are healthy.", "observation"],
    ["You're fine.", "observation"],
    ["Looks fine overall.", "observation"],
    ["Seems okay.", "observation"],
    ["They look fine.", "observation"],
    ["That's okay.", "observation"],
    ["These readings seem fine, probably.", "observation"],
    ["These readings are perfectly healthy.", "observation"],
    ["Your results are safe.", "observation"],
    ["All clear.", "observation"],
    ["Rest assured, the readings are recorded.", "observation"],
    ["No need to follow up.", "observation"],
    ["No follow-up is needed.", "observation"],
    ["There is no need to worry.", "observation"],
    ["No need to see anyone about this.", "observation"],
    ["You don't need to worry about these readings.", "observation"],
    ["Don't worry about these readings.", "observation"],
    ["You can safely ignore these readings.", "observation"],
    ["This confirms there is no problem.", "observation"],
    ["The AI result shows there is no cause for concern.", "observation"],
    ["You are free of any problem.", "observation"],
    ["This cannot determine whether everything is normal, but your readings look fine.", "limitation"],
    ["This cannot determine whether everything is normal. Your readings look fine.", "limitation"],
    ["Everything looks fine, but this is not medical advice.", "observation"],
    ["Everything looks fine; this is not medical advice.", "observation"],
    ["This explanation is not reassurance, but everything looks fine.", "limitation"],
  ] as const)("en-SG rejects: %s", (text, field) => {
    expect(verdict(false, field, text)).toBe("CLINICAL_MEANING_VIOLATION");
  });

  it.each([
    ["一切都很好。", "observation"],
    ["读数都很健康。", "observation"],
    ["您很健康。", "observation"],
    ["没什么好担心的。", "observation"],
    ["不用担心。", "observation"],
    ["不需要复诊。", "observation"],
    ["无需随访。", "observation"],
    ["可以忽略这些读数。", "observation"],
    ["这确认没有问题。", "observation"],
    ["请放心。", "observation"],
    ["身体健康。", "observation"],
    ["没有问题。", "observation"],
    ["读数是安全的。", "observation"],
    ["这些资料无法判断一切是否正常，但读数没问题。", "limitation"],
    ["这些资料无法判断一切是否正常。读数都很好。", "limitation"],
    ["一切都 fine。", "observation"],
    ["Everything 没问题。", "observation"],
    ["No need to 担心。", "observation"],
  ] as const)("zh-SG rejects: %s", (text, field) => {
    expect(verdict(true, field, text)).toBe("CLINICAL_MEANING_VIOLATION");
  });
});

describe("truthful limitations and neutral wording stay accepted (reassurance controls)", () => {
  it.each([
    ["This information cannot determine whether everything is normal.", "limitation"],
    ["The records cannot show whether your readings are fine.", "limitation"],
    ["No conclusion about safety or health can be made.", "limitation"],
    ["This explanation is not reassurance.", "limitation"],
    ["Recorded information should be reviewed rather than treated as an all-clear.", "limitation"],
    ["No data recorded.", "observation"],
    ["No selected records.", "observation"],
    ["This information is not available.", "observation"],
    ["The readings were 6.2 and 7.1 mmol/L.", "observation"],
    ["The second reading was higher than the first.", "observation"],
    ["Both readings were recorded in the morning.", "observation"],
  ] as const)("en-SG accepts: %s", (text, field) => {
    expect(verdict(false, field, text)).toBe("ACCEPTED");
  });

  it.each([
    ["这些资料无法判断一切是否正常。", "limitation"],
    ["无法对安全或健康作出结论。", "limitation"],
    ["这份说明不是保证。", "limitation"],
    ["记录的资料应该被查看，而不是当作一切正常。", "limitation"],
    ["没有记录数据。", "observation"],
    ["没有所选的记录。", "observation"],
    ["目前没有可用资料。", "observation"],
    ["最近记录的数值是 6.2 和 7.1 mmol/L。", "observation"],
  ] as const)("zh-SG accepts: %s", (text, field) => {
    expect(verdict(true, field, text)).toBe("ACCEPTED");
  });

  it("does not exempt a sentence merely because it contains a negation", () => {
    for (const text of ["No need to worry.", "It is not a problem, everything is fine.", "Nothing is wrong."]) expect(verdict(false, "observation", text)).toBe("CLINICAL_MEANING_VIOLATION");
    for (const text of ["不用担心。", "没有问题。", "不需要复诊。"]) expect(verdict(true, "observation", text)).toBe("CLINICAL_MEANING_VIOLATION");
  });

  it("classifies reassurance with dedicated closed rule ids", () => {
    const ids = MEANING_RULES.filter((entry) => entry.category === "FALSE_REASSURANCE").map((entry) => entry.id);
    expect(ids).toEqual(["clinical.reassurance_status.en", "clinical.reassurance_status.zh", "clinical.reassurance_no_action.en", "clinical.reassurance_no_action.zh"]);
    expect(MEANING_RULES.filter((entry) => entry.category === "FALSE_REASSURANCE").every((entry) => entry.kind === "CLINICAL")).toBe(true);
  });
});

describe("r3: 'shows you have <condition>' is diagnosis wording (owner instruction 2026-10-05)", () => {
  it.each([
    "This shows you have diabetes.",
    "These readings show that you have a condition.",
    "The records showed you have high blood pressure.",
    "This is showing you have diabetes.",
    "Your records show you are diabetic.",
    "This shows that you've got diabetes.",
    "The data has shown you have a heart condition.",
  ])("en-SG rejects: %s", (text) => {
    expect(verdict(false, "observation", text)).toBe("CLINICAL_MEANING_VIOLATION");
  });

  it.each([
    ["The recent median was 7.1 mmol/L, compared with 6.2 mmol/L in the earlier period.", "observation"],
    ["This shows your recorded readings for this period.", "observation"],
    ["The records show 10 recorded readings.", "observation"],
    ["This describes your records; it does not explain the cause.", "limitation"],
    ["This does not explain why the readings differed.", "limitation"],
  ] as const)("en-SG still accepts: %s", (text, field) => {
    expect(verdict(false, field, text)).toBe("ACCEPTED");
  });
});

describe("r4: Chinese 'shows you have <condition>' is diagnosis wording (owner instruction 2026-10-05)", () => {
  it.each([
    "这显示您有糖尿病。",
    "记录显示您患有高血压。",
    "这些读数显示出您有某种疾病。",
    "数据显示了您有心脏问题。",
    "记录显示您是糖尿病患者。",
    "这显示您得了糖尿病。",
    "这显示你有糖尿病。",
    "这说明你有糖尿病。",
    "这表明你有高血压。",
  ])("zh-SG rejects: %s", (text) => {
    expect(verdict(true, "observation", text)).toBe("CLINICAL_MEANING_VIOLATION");
  });

  it.each([
    ["这说明您有糖尿病。", "observation"],
    ["这表明您的血糖控制不好。", "observation"],
    ["这可以诊断为糖尿病。", "observation"],
    ["您的病情正在恶化。", "observation"],
  ] as const)("zh-SG existing diagnosis patterns still reject: %s", (text, field) => {
    expect(verdict(true, field, text)).toBe("CLINICAL_MEANING_VIOLATION");
  });

  it.each([
    ["最近记录的数值是 6.2 和 7.1 mmol/L。", "observation"],
    ["这显示您记录的读数。", "observation"],
    ["这只描述您的记录；并不解释原因。", "limitation"],
    ["这不解释读数不同的原因。", "limitation"],
  ] as const)("zh-SG still accepts: %s", (text, field) => {
    expect(verdict(true, field, text)).toBe("ACCEPTED");
  });
});
