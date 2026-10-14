import { describe, expect, it } from "vitest";
import type { FeelingsChatRequest } from "./feelings-chat-contract";
import { FALLBACK_QUESTIONS } from "./feelings-chat-bank";
import { FEELINGS_CHAT_FEW_SHOTS } from "./feelings-chat-prompt";
import { FEELINGS_CHAT_VALIDATOR_VERSION, contentReasons, questionFormatOk, reusesPatientWords, validateFeelingsChatReply } from "./feelings-chat-validator";

/**
 * Tell JagaOn understands more (design §3.5): the nine rules of the feelings-chat output validator, as table tests. Synthetic text only.
 */

const FIRST = "Feeling tired and a bit worried today.";
const turn1: FeelingsChatRequest = { task: "FEELINGS_CHAT_TURN", turn: 1, maxTurns: 3, messages: [{ role: "patient", text: FIRST }] };
const turn3: FeelingsChatRequest = {
  task: "FEELINGS_CHAT_TURN",
  turn: 3,
  maxTurns: 3,
  messages: [
    { role: "patient", text: FIRST },
    { role: "jagaon_question", text: "What has been making you feel tired lately?" },
    { role: "patient", text: "Not getting enough sleep, only 4 hours a night." },
    { role: "jagaon_question", text: "What has been keeping you up at night?" },
    { role: "patient", text: "Thinking about my son and his job." },
  ],
};
const ask = (question: string) => ({ kind: "QUESTION", question, summary: null, doctorQuestion: null, themes: [], end: false });
const wrap = (summary: string, doctorQuestion: string | null = null, themes: string[] = ["SLEEP"]) => ({ kind: "WRAP_UP", question: null, summary, doctorQuestion, themes, end: true });

describe("feelings-chat validator (feelings-chat-validator.1)", () => {
  it("is versioned", () => {
    expect(FEELINGS_CHAT_VALIDATOR_VERSION).toBe("feelings-chat-validator.1");
  });

  it.each([
    "What has been on your mind lately?",
    "What has been on your mind?",
    "How has your sleep been this week?",
    "How have you been sleeping this week?",
    "What has been making you feel tired lately?",
    "What about your son has been on your mind at night?",
    "How did the day at work feel for you?",
    "What has made you feel depressed this week?",
    "When did you start feeling this way?",
    "How do you feel about your medicines these days?",
    "Are you feeling any better than yesterday?",
    "How has the worry about your sugar readings felt this week?",
    ...FALLBACK_QUESTIONS,
  ])("accepts a harmless question: %s", (question) => {
    const result = validateFeelingsChatReply(ask(question), turn1);
    expect(result, question).toEqual({ ok: true, value: { kind: "QUESTION", question, summary: null, doctorQuestion: null, themes: [], end: false } });
  });

  it.each<[string, string[]]>([
    ["You should take less insulin tonight?", ["ADVICE", "MEDICINE_ACTION"]],
    ["It sounds like you have depression — how long has this been?", ["DIAGNOSIS"]],
    ["Is your sugar high because you are stressed?", ["GLUCOSE_CAUSALITY"]],
    ["Have you tried increasing your Lantus?", ["ADVICE", "MEDICINE_ACTION"]],
    ["Why don't you rest more?", ["ADVICE"]],
    ["Why don’t you rest more?", ["ADVICE"]],
    ["Could you try going to bed earlier tonight?", ["ADVICE"]],
    ["Have you considered talking to a counsellor?", ["ADVICE"]],
    ["Make sure you sleep eight hours, okay?", ["ADVICE"]],
    ["I recommend a short walk, would that help?", ["ADVICE"]],
    ["How about trying a short walk after dinner?", ["ADVICE"]],
    ["How many units did you take this morning?", ["MEDICINE_ACTION"]],
    ["Did you take 10 mg of metformin today?", ["MEDICINE_ACTION"]],
    ["Did you miss a dose today?", ["MEDICINE_ACTION"]],
    ["Are you thinking of stopping your Apidra?", ["MEDICINE_ACTION"]],
    ["Do you want to cut down on your tablets?", ["MEDICINE_ACTION"]],
    ["Could you double your Glucotab tomorrow?", ["MEDICINE_ACTION"]],
    ["Have you been skipping your injections lately?", ["MEDICINE_ACTION"]],
    ["Do you think you might have insomnia?", ["DIAGNOSIS"]],
    ["Do you think you are depressed?", ["DIAGNOSIS"]],
    ["You seem a bit depressed, what happened?", ["DIAGNOSIS"]],
    ["Could this be an anxiety disorder?", ["DIAGNOSIS"]],
    ["Were those symptoms of hypoglycaemia?", ["DIAGNOSIS"]],
    ["Was that a hypoglycemia episode?", ["DIAGNOSIS"]],
    ["Could this be diabetic distress for you?", ["DIAGNOSIS"]],
    ["Do you think it's burnout from work?", ["DIAGNOSIS"]],
    ["Does stress cause your glucose to go up?", ["GLUCOSE_CAUSALITY"]],
    ["Did the worry raise your readings today?", ["GLUCOSE_CAUSALITY"]],
    ["Is your sugar up due to the late dinner?", ["GLUCOSE_CAUSALITY"]],
  ])("rejects %s", (question, reasons) => {
    const result = validateFeelingsChatReply(ask(question), turn1);
    expect(result.ok, question).toBe(false);
    if (!result.ok) for (const reason of reasons) expect(result.reasons, question).toContain(reason);
  });

  it.each([
    ["That sounds hard. What happened today?", "a statement before the question"],
    ["Feeling okay?", "fewer than 3 words"],
    ["How are you feeling today and what has been happening at home and at work and with your family and your friends and your neighbours this week?", "more than 25 words"],
    ["How are you feeling", "no question mark"],
    ["How are you feeling? What happened?", "two questions"],
    ["How are you feeling\ntoday?", "a line break"],
    ["Which is harder: - sleep - work?", "a list"],
  ])("rejects the question format: %s (%s)", (question) => {
    expect(questionFormatOk(question)).toBe(false);
    expect(validateFeelingsChatReply(ask(question), turn1)).toEqual({ ok: false, reasons: ["QUESTION_FORMAT"] });
  });

  it("rejects a question repeated from the chat, and any question at the last turn (TURN_LIMIT)", () => {
    const turn2: FeelingsChatRequest = { ...turn3, turn: 2, messages: turn3.messages.slice(0, 3) };
    expect(validateFeelingsChatReply(ask("What has been making you feel tired lately?"), turn2)).toEqual({ ok: false, reasons: ["QUESTION_REPEATED"] });
    expect(validateFeelingsChatReply(ask("What else has been on your mind?"), turn3)).toEqual({ ok: false, reasons: ["TURN_LIMIT"] });
  });

  it("rejects schema faults: unknown fields, wrong kinds, missing texts, non-JSON", () => {
    const schema = { ok: false, reasons: ["SCHEMA"] };
    expect(validateFeelingsChatReply({ ...ask("What has been on your mind?"), extra: 1 }, turn1)).toEqual(schema);
    expect(validateFeelingsChatReply({ ...ask("What has been on your mind?"), kind: "ADVICE" }, turn1)).toEqual(schema);
    expect(validateFeelingsChatReply({ ...ask("What has been on your mind?"), question: null }, turn1)).toEqual(schema);
    expect(validateFeelingsChatReply({ ...ask("What has been on your mind?"), end: true }, turn1)).toEqual(schema);
    expect(validateFeelingsChatReply({ ...wrap("Feeling tired."), summary: null, end: false }, turn3)).toEqual(schema);
    expect(validateFeelingsChatReply({ ...wrap("Feeling tired."), question: "And?" }, turn3)).toEqual(schema);
    expect(validateFeelingsChatReply('{"kind":"QUESTION"', turn1)).toEqual(schema);
    expect(validateFeelingsChatReply(null, turn1)).toEqual(schema);
  });

  it("accepts the safety stop (WRAP_UP, end true, every text null) as its own valid shape", () => {
    const stop = { kind: "WRAP_UP", question: null, summary: null, doctorQuestion: null, themes: [], end: true };
    expect(validateFeelingsChatReply(stop, turn1)).toEqual({ ok: true, value: stop });
  });

  describe("rule 7: the summary", () => {
    it("accepts a neutral one-line summary of at most 160 characters", () => {
      const summary = "Feeling tired; sleeping about 4 hours a night because of worry about family.";
      expect(validateFeelingsChatReply(wrap(summary), turn3)).toEqual({ ok: true, value: { kind: "WRAP_UP", question: null, summary, doctorQuestion: null, themes: ["SLEEP"], end: true } });
    });

    it.each<[string, string]>([
      ["x".repeat(161), "SUMMARY_FORMAT"],
      ["Feeling tired.\nWorried.", "SUMMARY_FORMAT"],
      ["Feeling tired; she should rest more.", "ADVICE"],
      ["Feeling tired; may need to reduce her insulin.", "MEDICINE_ACTION"],
      ["Feeling tired; signs of depression.", "DIAGNOSIS"],
      ["Feeling tired because her sugar was high.", "GLUCOSE_CAUSALITY"],
    ])("rejects %s (%s)", (summary, reason) => {
      const result = validateFeelingsChatReply(wrap(summary), turn3);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reasons).toContain(reason);
    });
  });

  describe("rule 8: the doctor question", () => {
    const summary = "Feeling tired and worried about family.";
    it("accepts a first-person question that reuses her words", () => {
      const doctorQuestion = "I've only been sleeping about 4 hours a night. Could this affect my diabetes?";
      expect(validateFeelingsChatReply(wrap(summary, doctorQuestion), turn3)).toMatchObject({ ok: true, value: { doctorQuestion } });
    });

    it.each<[string, string]>([
      ["Could poor rest affect diabetes control?", "DOCTOR_QUESTION_FORMAT"],
      ["I have been sleeping 4 hours a night.", "DOCTOR_QUESTION_FORMAT"],
      [`I have been sleeping 4 hours a night, ${"and more ".repeat(20)}?`, "DOCTOR_QUESTION_FORMAT"],
      ["Could my diabetes get worse over time?", "DOCTOR_QUESTION_NOT_OWN_WORDS"],
      ["Should I reduce my insulin because I only sleep 4 hours?", "MEDICINE_ACTION"],
      ["Do I have insomnia from sleeping only 4 hours?", "DIAGNOSIS"],
      ["Is my sugar high because I sleep only 4 hours?", "GLUCOSE_CAUSALITY"],
    ])("rejects %s (%s)", (doctorQuestion, reason) => {
      const result = validateFeelingsChatReply(wrap(summary, doctorQuestion), turn3);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reasons).toContain(reason);
    });

    it("reuse needs a content word of 4+ letters that is not a stopword (stems compared)", () => {
      expect(reusesPatientWords("Could my sleeping affect me?", ["Not getting enough sleep."])).toBe(true);
      expect(reusesPatientWords("Could this be about my son?", ["Worried about my son."])).toBe(false);
      expect(reusesPatientWords("What should I feel about this?", ["I feel really tired today."])).toBe(false);
    });
  });

  describe("rule 9: themes", () => {
    it("accepts allow-listed, unique themes and rejects unknown or repeated ones", () => {
      expect(validateFeelingsChatReply(wrap("Feeling tired.", null, ["SLEEP", "FAMILY", "MOOD"]), turn3).ok).toBe(true);
      expect(validateFeelingsChatReply(wrap("Feeling tired.", null, ["INSOMNIA"]), turn3)).toEqual({ ok: false, reasons: ["THEMES"] });
      expect(validateFeelingsChatReply(wrap("Feeling tired.", null, ["SLEEP", "SLEEP"]), turn3)).toEqual({ ok: false, reasons: ["THEMES"] });
      expect(validateFeelingsChatReply(wrap("Feeling tired.", null, ["sleep"]), turn3)).toEqual({ ok: false, reasons: ["THEMES"] });
    });
  });

  it("the content rules find nothing in the reviewed bank and in every few-shot's good reply; the corrected bad draft is rejected", () => {
    for (const question of FALLBACK_QUESTIONS) expect(contentReasons(question), question).toEqual([]);
    for (const shot of FEELINGS_CHAT_FEW_SHOTS) {
      const request: FeelingsChatRequest = { task: "FEELINGS_CHAT_TURN", turn: shot.request.turn, maxTurns: 3, messages: [...shot.request.messages] };
      expect(validateFeelingsChatReply(shot.reply, request), shot.title).toMatchObject({ ok: true });
      if (shot.badDraft) expect(validateFeelingsChatReply(shot.badDraft.reply, request), shot.title).toMatchObject({ ok: false });
    }
  });
});
