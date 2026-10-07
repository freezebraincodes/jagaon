import { describe, expect, it } from "vitest";
import { AI_TASK_TYPES, aiTaskRequestSchema, type AiTaskRequest, type AiTaskType } from "@/domain/ai";
import { abstainFixture, outputFixture, requestFixture } from "@/domain/ai/ai-test-fixtures";
import { AI_TASK_RUNTIME_BUNDLES } from "./ai-runtime-bundles";
import { validateAiTaskOutput } from "./ai-output-validator";

/** Packet 11A Task 3: deterministic whole-result validation in the locked order (design Section 9). */

type Json = Record<string, any>;
const request = (taskType: AiTaskType, locale: "en-SG" | "zh-SG" = "en-SG") => aiTaskRequestSchema.parse({ ...requestFixture(taskType), locale }) as AiTaskRequest;
const validate = (taskType: AiTaskType, candidate: unknown, locale: "en-SG" | "zh-SG" = "en-SG") => validateAiTaskOutput(request(taskType, locale), AI_TASK_RUNTIME_BUNDLES[taskType], candidate);
const out = (taskType: AiTaskType) => outputFixture(taskType) as Json;
const rejected = (reason: string, repairable = false) => ({ kind: "REJECTED", reason, repairable });

/** Same meaning as the English fixtures, in natural zh-SG. */
const ZH: Record<AiTaskType, Json> = {
  EXTRACT_CANDIDATE_FACTS: out("EXTRACT_CANDIDATE_FACTS"),
  EXPLAIN_PATTERN: {
    ...out("EXPLAIN_PATTERN"),
    locale: "zh-SG",
    payload: {
      headline: { text: "这个时段记录的读数有所不同", claimRefs: ["claim-1"] },
      observation: { text: "最近记录的数值是 6.2 和 7.1 mmol/L。", claimRefs: ["claim-1"] },
      evidence: { text: "这使用了 10 个已记录的读数。", factRefs: ["fact-1", "fact-2", "fact-3"] },
    },
  },
  DRAFT_NEUTRAL_INQUIRY: {
    ...out("DRAFT_NEUTRAL_INQUIRY"),
    locale: "zh-SG",
    payload: {
      observation: { text: "您在这个时间记录了 3 项。", factRefs: ["fact-1"] },
      question: { text: "记录的时间正确吗？" },
      optionLabels: [{ optionRef: "option-1", label: "正确" }, { optionRef: "option-2", label: "不正确" }],
    },
  },
  ANSWER_BOUNDED_RECORD_QUERY: { ...out("ANSWER_BOUNDED_RECORD_QUERY"), locale: "zh-SG", payload: { segments: [{ text: "2026年10月1日，您记录了 6.2 mmol/L。", recordRefs: ["record-1"] }] } },
  DRAFT_CARE_PREPARATION_SUMMARY: {
    ...out("DRAFT_CARE_PREPARATION_SUMMARY"),
    locale: "zh-SG",
    payload: {
      sections: [
        { sectionRef: "section-1", bullets: [{ text: "记录了一个 6.2 mmol/L 的读数。", factRefs: ["fact-1"] }] },
        { sectionRef: "section-2", bullets: [{ text: "问题：Can I keep the pen in my bag? (demo)", factRefs: ["fact-2"] }] },
      ],
    },
  },
  PHRASE_NON_CLINICAL_RESPONSE: { ...out("PHRASE_NON_CLINICAL_RESPONSE"), locale: "zh-SG", payload: { message: { text: "您的记录已保存。", factRefs: [] } } },
};

describe("accepted whole results", () => {
  it.each(AI_TASK_TYPES)("%s accepts the exact en-SG output and returns it whole", (taskType) => {
    expect(validate(taskType, out(taskType))).toEqual({ kind: "ACCEPTED", output: out(taskType) });
  });

  it.each(AI_TASK_TYPES.filter((taskType) => taskType !== "EXTRACT_CANDIDATE_FACTS"))("%s accepts direct zh-SG output", (taskType) => {
    expect(validate(taskType, ZH[taskType], "zh-SG").kind).toBe("ACCEPTED");
  });

  it("parses a strict JSON string candidate", () => {
    expect(validate("EXPLAIN_PATTERN", JSON.stringify(out("EXPLAIN_PATTERN"))).kind).toBe("ACCEPTED");
  });
});

describe("1–2. strict JSON, exact schema, task and locale", () => {
  it("treats malformed JSON, duplicate keys and unknown fields as the only repairable structural failures", () => {
    expect(validate("EXPLAIN_PATTERN", "{not json")).toEqual(rejected("SCHEMA_INVALID", true));
    expect(validate("EXPLAIN_PATTERN", '{"outcome":"SUCCESS","outcome":"ABSTAIN"}')).toEqual(rejected("SCHEMA_INVALID", true));
    expect(validate("EXPLAIN_PATTERN", { ...out("EXPLAIN_PATTERN"), extra: true })).toEqual(rejected("SCHEMA_INVALID", true));
  });

  it("is not repairable when the bundle permits no structural repair", () => {
    expect(validate("PHRASE_NON_CLINICAL_RESPONSE", "{")).toEqual(rejected("SCHEMA_INVALID", false));
  });

  it("rejects another task, schema version or locale", () => {
    expect(validate("EXPLAIN_PATTERN", out("ANSWER_BOUNDED_RECORD_QUERY"))).toEqual(rejected("SCHEMA_INVALID", true));
    expect(validate("EXPLAIN_PATTERN", { ...out("EXPLAIN_PATTERN"), schemaVersion: "ai-output.explain-pattern@11a.2" })).toEqual(rejected("SCHEMA_INVALID", true));
    expect(validate("EXPLAIN_PATTERN", { ...out("EXPLAIN_PATTERN"), locale: "zh-SG" })).toEqual(rejected("LOCALE_INVALID"));
  });

  it("turns a valid abstention into a non-repairable model abstention", () => {
    expect(validate("EXPLAIN_PATTERN", abstainFixture("EXPLAIN_PATTERN"))).toEqual(rejected("MODEL_ABSTAINED"));
  });
});

describe("3. request-local reference closure", () => {
  it("rejects invented references in inputRefsUsed and in the payload", () => {
    expect(validate("EXPLAIN_PATTERN", { ...out("EXPLAIN_PATTERN"), inputRefsUsed: [...out("EXPLAIN_PATTERN").inputRefsUsed, "fact-9"] })).toEqual(rejected("REFERENCE_MISMATCH"));
    const invented = out("ANSWER_BOUNDED_RECORD_QUERY");
    invented.payload.segments[0].recordRefs = ["record-2"];
    invented.inputRefsUsed.push("record-2");
    expect(validate("ANSWER_BOUNDED_RECORD_QUERY", invented)).toEqual(rejected("REFERENCE_MISMATCH"));
  });

  it("requires payload references to be declared in inputRefsUsed", () => {
    const output = out("EXPLAIN_PATTERN");
    output.inputRefsUsed = ["claim-1"];
    expect(validate("EXPLAIN_PATTERN", output)).toEqual(rejected("REFERENCE_MISMATCH"));
  });

  it("keeps inquiry options exact: same references, count and order", () => {
    const reordered = out("DRAFT_NEUTRAL_INQUIRY");
    reordered.payload.optionLabels.reverse();
    expect(validate("DRAFT_NEUTRAL_INQUIRY", reordered)).toEqual(rejected("REFERENCE_MISMATCH"));
    const dropped = out("DRAFT_NEUTRAL_INQUIRY");
    dropped.payload.optionLabels.pop();
    expect(validate("DRAFT_NEUTRAL_INQUIRY", dropped)).toEqual(rejected("REFERENCE_MISMATCH"));
  });

  it("allows only the supplied care-summary sections, each bullet bound to its own section's facts", () => {
    const unknown = out("DRAFT_CARE_PREPARATION_SUMMARY");
    unknown.payload.sections[0].sectionRef = "section-3";
    unknown.inputRefsUsed.push("section-3");
    expect(validate("DRAFT_CARE_PREPARATION_SUMMARY", unknown)).toEqual(rejected("REFERENCE_MISMATCH"));
    const crossed = out("DRAFT_CARE_PREPARATION_SUMMARY");
    crossed.payload.sections[0].bullets[0].factRefs = ["fact-2"];
    expect(validate("DRAFT_CARE_PREPARATION_SUMMARY", crossed)).toEqual(rejected("REFERENCE_MISMATCH"));
  });

  it("binds every extraction candidate to the excerpt and a requested field", () => {
    const wrongField = out("EXTRACT_CANDIDATE_FACTS");
    wrongField.payload.candidates[0].field = "ACTIVITY_LABEL";
    expect(validate("EXTRACT_CANDIDATE_FACTS", wrongField)).toEqual(rejected("AUTHORITY_BOUNDARY_VIOLATION"));
  });
});

describe("4. factual and value fidelity", () => {
  it("requires every source span to equal the submitted excerpt exactly", () => {
    const output = out("EXTRACT_CANDIDATE_FACTS");
    output.payload.candidates[0].quotation = "kaya bread";
    expect(validate("EXTRACT_CANDIDATE_FACTS", output)).toEqual(rejected("FACT_FIDELITY_FAILED"));
    const offset = out("EXTRACT_CANDIDATE_FACTS");
    offset.payload.candidates[0].start = 5;
    expect(validate("EXTRACT_CANDIDATE_FACTS", offset)).toEqual(rejected("FACT_FIDELITY_FAILED"));
  });

  it.each([
    ["changed decimal", (o: Json) => (o.payload.observation.text = "Recent recorded values were 6.2 and 7.4 mmol/L.")],
    ["changed unit", (o: Json) => (o.payload.observation.text = "Recent recorded values were 6.2 and 7.1 mg/dL.")],
    ["changed count", (o: Json) => (o.payload.evidence.text = "This uses 11 recorded readings.")],
    ["invented percentage", (o: Json) => (o.payload.evidence.text = "This uses 10 recorded readings, 40% of them recent.")],
  ])("rejects a %s in explanation wording", (_label, change) => {
    const output = out("EXPLAIN_PATTERN");
    change(output);
    expect(validate("EXPLAIN_PATTERN", output)).toEqual(rejected("FACT_FIDELITY_FAILED"));
  });

  it("rejects a changed date in a record answer, in both locales", () => {
    const en = out("ANSWER_BOUNDED_RECORD_QUERY");
    en.payload.segments[0].text = "On 2 Oct 2026 you recorded 6.2 mmol/L.";
    expect(validate("ANSWER_BOUNDED_RECORD_QUERY", en)).toEqual(rejected("FACT_FIDELITY_FAILED"));
    const zh = structuredClone(ZH.ANSWER_BOUNDED_RECORD_QUERY);
    zh.payload.segments[0].text = "2026年10月3日，您记录了 6.2 mmol/L。";
    expect(validate("ANSWER_BOUNDED_RECORD_QUERY", zh, "zh-SG")).toEqual(rejected("FACT_FIDELITY_FAILED"));
  });

  it("Option B: the model may not write limitations or cite a limitation reference (the application renders them)", () => {
    const written = out("EXPLAIN_PATTERN");
    written.payload.limitations = [{ limitationRef: "limitation-1", text: "This does not explain why the readings differed." }];
    expect(validate("EXPLAIN_PATTERN", written)).toEqual(rejected("SCHEMA_INVALID", true));
    const cited = out("EXPLAIN_PATTERN");
    cited.inputRefsUsed.push("limitation-1");
    expect(validate("EXPLAIN_PATTERN", cited)).toEqual(rejected("REFERENCE_MISMATCH"));
  });

  it("requires every selected care-summary fact to remain", () => {
    const output = out("DRAFT_CARE_PREPARATION_SUMMARY");
    output.payload.sections = [output.payload.sections[0]];
    expect(validate("DRAFT_CARE_PREPARATION_SUMMARY", output)).toEqual(rejected("FACT_FIDELITY_FAILED"));
  });

  it("rejects the whole result when only one bullet is wrong", () => {
    const output = out("DRAFT_CARE_PREPARATION_SUMMARY");
    output.payload.sections[0].bullets.push({ text: "Another reading of 9.9 mmol/L was recorded.", factRefs: ["fact-1"] });
    expect(validate("DRAFT_CARE_PREPARATION_SUMMARY", output)).toEqual(rejected("FACT_FIDELITY_FAILED"));
  });
});

/** Direct and indirect forbidden meanings in English, Chinese and mixed language (ai-system-spec 15.2, test-release 7.4). */
const FORBIDDEN: Array<[string, string, "en-SG" | "zh-SG", "CLINICAL_MEANING_VIOLATION" | "AUTHORITY_BOUNDARY_VIOLATION"]> = [
  ["clinical risk", "You are at risk of a hypo.", "en-SG", "CLINICAL_MEANING_VIOLATION"],
  ["indirect risk", "This could be dangerous for you.", "en-SG", "CLINICAL_MEANING_VIOLATION"],
  ["causal attribution", "The kaya toast caused the change.", "en-SG", "CLINICAL_MEANING_VIOLATION"],
  ["indirect cause", "This is probably because of your dinner.", "en-SG", "CLINICAL_MEANING_VIOLATION"],
  ["clinical classification", "This reading is high.", "en-SG", "CLINICAL_MEANING_VIOLATION"],
  ["euphemistic classification", "Your sugar is a bit on the high side.", "en-SG", "CLINICAL_MEANING_VIOLATION"],
  ["prediction", "Your readings will keep rising next week.", "en-SG", "CLINICAL_MEANING_VIOLATION"],
  ["diagnosis", "This suggests your diabetes is worsening.", "en-SG", "CLINICAL_MEANING_VIOLATION"],
  ["medication action", "Take your insulin now.", "en-SG", "CLINICAL_MEANING_VIOLATION"],
  ["dose selection", "You may want to increase the dose.", "en-SG", "CLINICAL_MEANING_VIOLATION"],
  ["adherence", "You missed this dose again.", "en-SG", "CLINICAL_MEANING_VIOLATION"],
  ["triage", "Please see a doctor urgently.", "en-SG", "CLINICAL_MEANING_VIOLATION"],
  ["safety wording", "Call an ambulance if you feel faint.", "en-SG", "CLINICAL_MEANING_VIOLATION"],
  ["recipient claim", "Your doctor has reviewed this summary.", "en-SG", "AUTHORITY_BOUNDARY_VIOLATION"],
  ["application action claim", "I have updated your record.", "en-SG", "AUTHORITY_BOUNDARY_VIOLATION"],
  ["zh clinical risk", "你有风险。", "zh-SG", "CLINICAL_MEANING_VIOLATION"],
  ["zh causal attribution", "这是导致变化的原因。", "zh-SG", "CLINICAL_MEANING_VIOLATION"],
  ["zh classification", "这个读数偏高。", "zh-SG", "CLINICAL_MEANING_VIOLATION"],
  ["zh medication action", "现在服用胰岛素。", "zh-SG", "CLINICAL_MEANING_VIOLATION"],
  ["zh adherence", "你漏服了这次剂量。", "zh-SG", "CLINICAL_MEANING_VIOLATION"],
  ["zh dose selection", "可以增加剂量。", "zh-SG", "CLINICAL_MEANING_VIOLATION"],
  ["zh prediction", "下周读数会继续上升。", "zh-SG", "CLINICAL_MEANING_VIOLATION"],
  ["zh triage", "请立刻去急诊。", "zh-SG", "CLINICAL_MEANING_VIOLATION"],
  ["zh recipient claim", "医生已经看过这份摘要。", "zh-SG", "AUTHORITY_BOUNDARY_VIOLATION"],
  ["mixed-language risk", "这个 reading is too high 了。", "zh-SG", "CLINICAL_MEANING_VIOLATION"],
  ["mixed-language cause", "因为 dinner 所以读数改变。", "zh-SG", "CLINICAL_MEANING_VIOLATION"],
];

describe("5. authority and forbidden meaning", () => {
  it.each(FORBIDDEN)("rejects %s", (_label, text, locale, reason) => {
    const output = structuredClone(locale === "zh-SG" ? ZH.PHRASE_NON_CLINICAL_RESPONSE : out("PHRASE_NON_CLINICAL_RESPONSE"));
    output.payload.message.text = text;
    expect(validate("PHRASE_NON_CLINICAL_RESPONSE", output, locale)).toEqual(rejected(reason));
  });

  it("rejects an emergency number at the earlier fidelity gate (locked gate order)", () => {
    const output = out("PHRASE_NON_CLINICAL_RESPONSE");
    output.payload.message.text = "Call 995 if you feel faint.";
    expect(validate("PHRASE_NON_CLINICAL_RESPONSE", output)).toEqual(rejected("FACT_FIDELITY_FAILED"));
  });

  it("rejects forbidden meaning in any generated field of any task", () => {
    const explain = out("EXPLAIN_PATTERN");
    explain.payload.evidence.text = "These readings are dangerous.";
    expect(validate("EXPLAIN_PATTERN", explain)).toEqual(rejected("CLINICAL_MEANING_VIOLATION"));
    const inquiry = out("DRAFT_NEUTRAL_INQUIRY");
    inquiry.payload.question.text = "Did you skip your medicine?";
    expect(validate("DRAFT_NEUTRAL_INQUIRY", inquiry)).toEqual(rejected("CLINICAL_MEANING_VIOLATION"));
  });

  it("permits a verbatim quotation of the patient's own selected words", () => {
    const care = aiTaskRequestSchema.parse(requestFixture("DRAFT_CARE_PREPARATION_SUMMARY")) as AiTaskRequest & { facts: Array<{ value: { text?: string } }> };
    care.facts[1]!.value = { kind: "TEXT", text: "Should I increase my insulin dose? (demo)", language: "en-SG" } as never;
    const output = out("DRAFT_CARE_PREPARATION_SUMMARY");
    output.payload.sections[1].bullets[0].text = "Your question: Should I increase my insulin dose? (demo)";
    expect(validateAiTaskOutput(care, AI_TASK_RUNTIME_BUNDLES.DRAFT_CARE_PREPARATION_SUMMARY, output).kind).toBe("ACCEPTED");
    output.payload.sections[1].bullets[0].text = "You should increase your insulin dose.";
    expect(validateAiTaskOutput(care, AI_TASK_RUNTIME_BUNDLES.DRAFT_CARE_PREPARATION_SUMMARY, output)).toEqual(rejected("CLINICAL_MEANING_VIOLATION"));
  });
});

describe("6. locale and presentation", () => {
  it("rejects Chinese generated wording in an en-SG result and English wording in a zh-SG result", () => {
    const en = out("PHRASE_NON_CLINICAL_RESPONSE");
    en.payload.message.text = "您的记录已保存。";
    expect(validate("PHRASE_NON_CLINICAL_RESPONSE", en)).toEqual(rejected("LOCALE_INVALID"));
    const zh = structuredClone(ZH.PHRASE_NON_CLINICAL_RESPONSE);
    zh.payload.message.text = "Your entry is saved.";
    expect(validate("PHRASE_NON_CLINICAL_RESPONSE", zh, "zh-SG")).toEqual(rejected("LOCALE_INVALID"));
  });
});

describe("7. output budget", () => {
  it("rejects more extraction candidates than the bundle allows", () => {
    const output = out("EXTRACT_CANDIDATE_FACTS");
    output.payload.candidates = Array.from({ length: 9 }, () => output.payload.candidates[0]);
    expect(validate("EXTRACT_CANDIDATE_FACTS", output)).toEqual(rejected("SCHEMA_INVALID", true));
  });

  it("rejects an output larger than the bundle's output ceiling", () => {
    const output = out("PHRASE_NON_CLINICAL_RESPONSE");
    output.payload.message.text = "Saved. ".repeat(40).trim();
    expect(validate("PHRASE_NON_CLINICAL_RESPONSE", output)).toEqual(rejected("OUTPUT_BUDGET_EXCEEDED"));
  });
});

describe("r3: internal reference identifiers never appear in visible generated text (owner instruction 2026-10-05)", () => {
  const KINDS = ["fact", "claim", "option", "record", "section", "limitation"] as const;
  // Option B (11b.1): headline, observation and evidence are the model's only visible EXPLAIN_PATTERN text.
  const FIELDS = ["headline", "observation", "evidence"] as const;
  const withText = (field: (typeof FIELDS)[number], suffix: string, base: Json = out("EXPLAIN_PATTERN")) => {
    const value = structuredClone(base);
    value.payload[field].text = `${value.payload[field].text} ${suffix}`;
    return value;
  };

  // "-10" collides with the supplied count 10, so the number check alone would accept it.
  it.each(KINDS.flatMap((kind) => FIELDS.map((field) => [`${kind}-10`, field] as const)))("rejects %s written in %s text, even when its digits are a supplied number", (ref, field) => {
    expect(validate("EXPLAIN_PATTERN", withText(field, `(${ref})`))).toEqual(rejected("FACT_FIDELITY_FAILED"));
  });

  it.each(["CLAIM-10", "Fact-10", "see limitation-10."])("rejects any letter case or punctuation: %s", (suffix) => {
    expect(validate("EXPLAIN_PATTERN", withText("observation", suffix))).toEqual(rejected("FACT_FIDELITY_FAILED"));
  });

  it("rejects an identifier adjacent to Chinese text", () => {
    const value = structuredClone(ZH.EXPLAIN_PATTERN);
    value.payload.evidence.text = "这使用了 10 个已记录的读数（参见fact-10）。";
    expect(validate("EXPLAIN_PATTERN", value, "zh-SG")).toEqual(rejected("FACT_FIDELITY_FAILED"));
  });

  it("rejects an identifier in a care-summary bullet", () => {
    const value = structuredClone(out("DRAFT_CARE_PREPARATION_SUMMARY"));
    value.payload.sections[0].bullets[0].text = "A reading of 6.2 mmol/L was recorded (section-1).";
    expect(validate("DRAFT_CARE_PREPARATION_SUMMARY", value)).toEqual(rejected("FACT_FIDELITY_FAILED"));
  });

  it("removes verbatim patient-authored quoted text before the check", () => {
    const question = "Can I keep the pen in my bag? See section-2 and fact-10 (demo)";
    const base = requestFixture("DRAFT_CARE_PREPARATION_SUMMARY") as Json;
    base.facts[1].value.text = question;
    const quoted = aiTaskRequestSchema.parse(base) as AiTaskRequest;
    const value = structuredClone(out("DRAFT_CARE_PREPARATION_SUMMARY"));
    value.payload.sections[1].bullets[0].text = question;
    expect(validateAiTaskOutput(quoted, AI_TASK_RUNTIME_BUNDLES.DRAFT_CARE_PREPARATION_SUMMARY, value)).toMatchObject({ kind: "ACCEPTED" });
    value.payload.sections[1].bullets[0].text = `${question} (section-2)`;
    expect(validateAiTaskOutput(quoted, AI_TASK_RUNTIME_BUNDLES.DRAFT_CARE_PREPARATION_SUMMARY, value)).toEqual(rejected("FACT_FIDELITY_FAILED"));
  });

  it("does not flag ordinary hyphenated words or the approved fixtures", () => {
    expect(validate("EXPLAIN_PATTERN", withText("observation", "This is a fact-based, record-keeping summary."))).toMatchObject({ kind: "ACCEPTED" });
    for (const task of ["EXPLAIN_PATTERN", "DRAFT_CARE_PREPARATION_SUMMARY"] as const) {
      expect(validate(task, out(task))).toMatchObject({ kind: "ACCEPTED" });
      expect(validate(task, ZH[task], "zh-SG")).toMatchObject({ kind: "ACCEPTED" });
    }
  });
});

describe("r4: Chinese diagnosis wording with verbatim patient quotations (owner instruction 2026-10-05)", () => {
  const question = "记录显示您有糖尿病吗？(演示)";
  const zhCareRequest = () => {
    const base = requestFixture("DRAFT_CARE_PREPARATION_SUMMARY") as Json;
    base.locale = "zh-SG";
    base.facts[1].value = { kind: "TEXT", text: question, language: "zh-SG" };
    return aiTaskRequestSchema.parse(base) as AiTaskRequest;
  };
  const care = (text: string) => {
    const value = structuredClone(ZH.DRAFT_CARE_PREPARATION_SUMMARY);
    value.payload.sections[1].bullets[0].text = text;
    return value;
  };

  it("accepts the patient's own question copied verbatim, even though it contains 显示您有", () => {
    expect(validateAiTaskOutput(zhCareRequest(), AI_TASK_RUNTIME_BUNDLES.DRAFT_CARE_PREPARATION_SUMMARY, care(question))).toMatchObject({ kind: "ACCEPTED" });
  });

  it("rejects the same wording when it is generated rather than quoted", () => {
    const value = care(question);
    value.payload.sections[0].bullets[0].text = "记录显示您有糖尿病，读数是 6.2 mmol/L。";
    expect(validateAiTaskOutput(zhCareRequest(), AI_TASK_RUNTIME_BUNDLES.DRAFT_CARE_PREPARATION_SUMMARY, value)).toEqual(rejected("CLINICAL_MEANING_VIOLATION"));
  });

  it("keeps reference-ID rejection ahead of meaning, with its existing code", () => {
    const value = care(question);
    value.payload.sections[0].bullets[0].text = "记录显示您有糖尿病（fact-1）。";
    expect(validateAiTaskOutput(zhCareRequest(), AI_TASK_RUNTIME_BUNDLES.DRAFT_CARE_PREPARATION_SUMMARY, value)).toEqual(rejected("FACT_FIDELITY_FAILED"));
  });
});
