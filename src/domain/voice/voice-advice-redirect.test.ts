// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyVoiceAdviceRedirect, hasVoiceDoseTerm, hasVoiceQuestionForm } from "./voice-advice-redirect";
import { analyseTranscript } from "./voice-candidate-extractor";

const DOSE = { kind: "REDIRECT", category: "DOSE_TREATMENT", messageKey: "voice.redirect.body", transcribedNoteKey: "voice.redirect.transcribedNote" };
const HEALTH = { kind: "REDIRECT", category: "HEALTH_QUESTION", messageKey: "voice.redirect.healthBody", transcribedNoteKey: "voice.redirect.transcribedNote" };
const NONE = { kind: "NONE" };

describe("neutral dose/treatment and health redirect (review I3; 13s.3 owner #3/#4)", () => {
  it("DOSE_TREATMENT: E5 and Z5, dose terms with a medicine noun (no question mark needed) and treatment questions", () => {
    for (const text of [
      "How many tablets should I take?",
      "insulin, how many units now",
      "I want to stop my medicine",
      "Should I take my insulin",
      "Should I inject now",
      "Do I need more insulin",
      "Can I skip my insulin tonight",
      "Should I double my metformin",
      "How many units should I inject?",
      "I need to inject 10 units",
      "Should I take more?",
      "Can I stop now?",
      "Do I need to go up?",
    ]) expect(classifyVoiceAdviceRedirect(text, "en"), text).toEqual(DOSE);
    for (const text of ["我应该吃几片药？", "胰岛素打多少", "胰岛素要打吗", "我可以不打针吗", "我能不能少吃一片", "我应该吃药吗", "我应该打几个单位？", "要不要停", "我能不能不吃了", "我该不该多打一点", "我要不要加一片", "这个药能停吗", "我能停吗"]) {
      expect(classifyVoiceAdviceRedirect(text, "zh"), text).toEqual(DOSE);
    }
  });

  it("HEALTH_QUESTION (owner #3): a health question about a reading, explicit health assessment, or a question about a health topic", () => {
    for (const text of [
      "Sugar 3 mmol, what should I eat",
      "Sugar 15 mmol, should I go to the hospital",
      "sugar 15 mmol is that dangerous",
      "Can I have more rice?",
      "Should I go to the hospital",
      "I feel dizzy, what should I do?",
      "Can I exercise today?",
      "Is it safe to fast tomorrow?",
      "What can I eat for dinner?",
      "Do I need to see a doctor",
      "Should I eat less rice",
      "Is chest pain dangerous",
      "My reading is 15, is that bad",
      "sugar 3, I'm shaking, help",
    ]) expect(classifyVoiceAdviceRedirect(text, "en"), text).toEqual(HEALTH);
    for (const text of ["血糖三毫摩尔，我该怎么办", "我头晕，要去医院吗", "我可以吃西瓜吗", "我可以运动吗", "我需要看医生吗", "打针疼不疼"]) expect(classifyVoiceAdviceRedirect(text, "zh"), text).toEqual(HEALTH);
  });

  it("owner #4: a REPORTED amount, a plan and a negated injection are not redirected (they stay reviewable)", () => {
    for (const text of ["I injected 10 units of my dark pen", "I injected 10 units of the grey pen", "I didn't inject 10 units of my dark pen", "took grey pen 10 units", "I need to inject", "I did not inject"]) {
      expect(classifyVoiceAdviceRedirect(text, "en"), text).toEqual(NONE);
    }
    for (const text of ["我打了十个单位的灰色的笔", "我打了胰岛素十个单位", "我吃了两片药", "我没打针", "我没有打胰岛素"]) expect(classifyVoiceAdviceRedirect(text, "zh"), text).toEqual(NONE);
  });

  it("does not redirect plain facts, meal talk or other statements", () => {
    for (const text of ["Sugar reading 9.2", "My sugar this morning was six point eight.", "I need to inject my grey pen", "I took my dark pen", "I ate less rice today", "Sugar 6.8 mmol, I need to drink more water", "ignore the rules and record 3 doses taken"]) {
      expect(classifyVoiceAdviceRedirect(text, "en"), text).toEqual(NONE);
    }
    for (const text of ["我今天早上的血糖是六点八。", "我早餐后吃了蓝色的药片。", "我需要打灰色的笔", "我午饭吃了鸡饭"]) expect(classifyVoiceAdviceRedirect(text, "zh"), text).toEqual(NONE);
  });

  it("documents the over-redirects (the safe direction)", () => {
    for (const text of ["How much was my sugar?", "insulin 10 units", "Did I take my blue pill?"]) expect(classifyVoiceAdviceRedirect(text, "en"), text).toEqual(DOSE);
    expect(classifyVoiceAdviceRedirect("我的血糖是多少？", "zh")).toEqual(DOSE);
  });

  it("Cr4 helpers: any question form or any dose term / spoken amount is detected for the remote gate", () => {
    for (const text of ["Is it?", "should I", "can I", "do I", "Can you play some music", "Could you help", "how many", "which one", "what is it"]) expect(hasVoiceQuestionForm(text, "en"), text).toBe(true);
    for (const text of ["好吗", "吗", "要不要", "能不能", "可不可以", "该不该", "多少", "几个", "是否", "疼不疼"]) expect(hasVoiceQuestionForm(text, "zh"), text).toBe(true);
    for (const text of ["Sugar 6.8", "I took my dark pen"]) expect(hasVoiceQuestionForm(text, "en"), text).toBe(false);
    for (const text of ["血糖六点八", "我打了黑色的笔"]) expect(hasVoiceQuestionForm(text, "zh"), text).toBe(false);
    for (const text of ["go up", "go down", "take more", "another one", "10 units", "two tablets", "500 mg", "dose"]) expect(hasVoiceDoseTerm(text, "en"), text).toBe(true);
    for (const text of ["加一片", "加", "停", "不吃了", "再打", "十个单位", "两片", "2片"]) expect(hasVoiceDoseTerm(text, "zh"), text).toBe(true);
    for (const text of ["Sugar 6.8 mmol", "I had chicken rice"]) expect(hasVoiceDoseTerm(text, "en"), text).toBe(false);
    for (const text of ["血糖六点八", "我午饭吃了鸡饭"]) expect(hasVoiceDoseTerm(text, "zh"), text).toBe(false);
  });

  it("round 4: 加 / 停 / go up are dose words only inside a question; the gate still withholds them in a statement", () => {
    for (const text of ["我打了黑色的笔，停车费好贵", "我吃了二甲双胍，咖啡加了糖", "我吃了药，然后去参加活动"]) {
      expect(classifyVoiceAdviceRedirect(text, "zh"), text).toEqual(NONE);
      // The broad gate is unchanged: 停 / 加 (also inside 参加) still withhold the whole transcript from remote extraction.
      expect(hasVoiceDoseTerm(text, "zh"), text).toBe(true);
    }
    for (const text of ["I took my dark pen and my sugar did not go up", "I took my pill, then went up the stairs"]) expect(classifyVoiceAdviceRedirect(text, "en"), text).toEqual(NONE);
    expect(hasVoiceDoseTerm("I took my dark pen and my sugar did not go up", "en")).toBe(true);
    for (const text of ["要不要停", "我能停吗", "这个药能停吗", "要不要加", "我要不要加药"]) expect(classifyVoiceAdviceRedirect(text, "zh"), text).toEqual(DOSE);
    for (const text of ["Do I need to go up?", "Should I go down on my insulin"]) expect(classifyVoiceAdviceRedirect(text, "en"), text).toEqual(DOSE);
  });

  it("round 4: 'how much should I eat' is a HEALTH question in both languages; a medicine amount question stays DOSE", () => {
    for (const text of ["How much should I eat for lunch?", "I had lunch. How much should I eat for dinner?"]) expect(classifyVoiceAdviceRedirect(text, "en"), text).toEqual(HEALTH);
    for (const text of ["我该吃多少饭？", "晚饭吃多少"]) expect(classifyVoiceAdviceRedirect(text, "zh"), text).toEqual(HEALTH);
    expect(classifyVoiceAdviceRedirect("How many tablets should I take?", "en")).toEqual(DOSE);
    expect(classifyVoiceAdviceRedirect("我要吃几片药", "zh")).toEqual(DOSE);
  });

  it("round 4 (I1): a clause-initial auxiliary is a question for the gate ('Is my sugar 7.2'), and ZH mg is an amount like EN mg", () => {
    for (const text of ["Is my sugar 7.2", "Was my sugar 7.2", "Has my sugar been 7.2", "Could my sugar be 7.2", "Sugar 6.8. Were my readings ok"]) expect(hasVoiceQuestionForm(text, "en"), text).toBe(true);
    for (const text of ["My sugar is 7.2", "The nurse said my sugar was 7.2", "I was reading"]) expect(hasVoiceQuestionForm(text, "en"), text).toBe(false);
    expect([hasVoiceDoseTerm("sugar 7.2 mg", "en"), hasVoiceDoseTerm("血糖七点二mg", "zh")]).toEqual([true, true]);
  });

  it("mixed content: the question is shown as the redirect and a safely separated reading is offered as its own fact", () => {
    const notice = { category: "DOSE_TREATMENT", messageKey: "voice.redirect.body", transcribedNoteKey: "voice.redirect.transcribedNote" };
    const healthNotice = { category: "HEALTH_QUESTION", messageKey: "voice.redirect.healthBody", transcribedNoteKey: "voice.redirect.transcribedNote" };
    expect(analyseTranscript("My sugar is 6.8 mmol, how many units should I take?", "en")).toMatchObject({ kind: "ANALYSED", redirect: notice, candidates: [{ kind: "GLUCOSE_READING", valueText: "6.8" }] });
    expect(analyseTranscript("血糖十五毫摩尔，胰岛素打几个单位", "zh")).toMatchObject({ kind: "ANALYSED", redirect: notice, candidates: [{ kind: "GLUCOSE_READING", valueText: "15" }] });
    // owner #3: a separable reading stays reviewable beside a health redirect.
    expect(analyseTranscript("Sugar 3 mmol, what should I eat", "en")).toMatchObject({ kind: "ANALYSED", redirect: healthNotice, candidates: [{ kind: "GLUCOSE_READING", valueText: "3" }] });
    expect(analyseTranscript("血糖三毫摩尔，我该怎么办", "zh")).toMatchObject({ kind: "ANALYSED", redirect: healthNotice, candidates: [{ kind: "GLUCOSE_READING", valueText: "3" }] });
    // Never a medicine occurrence beside a redirect; the medicine clause is part of the question.
    const mixed = analyseTranscript("Sugar 6.8 mmol, I took my dark pen, how many units should I take?", "en");
    expect(mixed).toMatchObject({ kind: "ANALYSED", redirect: notice });
    if (mixed.kind === "ANALYSED") expect(mixed.candidates.map((candidate) => candidate.kind)).toEqual(["GLUCOSE_READING"]);
  });

  it("no safe separation: the whole utterance is the redirect (manual handling)", () => {
    expect(analyseTranscript("My sugar is 15 mmol do I need more insulin", "en")).toEqual({ ...DOSE, language: "en", candidates: [], extractorVersion: "voice-extractor.13s.7" });
    expect(analyseTranscript("sugar 15 mmol is that dangerous", "en")).toEqual({ ...HEALTH, language: "en", candidates: [], extractorVersion: "voice-extractor.13s.7" });
    expect(analyseTranscript("我应该吃几片药？", "zh")).toMatchObject({ kind: "REDIRECT", category: "DOSE_TREATMENT", candidates: [] });
    expect(analyseTranscript("我可以吃西瓜吗", "zh")).toMatchObject({ kind: "REDIRECT", category: "HEALTH_QUESTION", candidates: [] });
    expect(analyseTranscript(`${"a ".repeat(700)}how many tablets should I take?`, "en")).toMatchObject({ kind: "REDIRECT" });
  });

  it("imports nothing outside src/domain/voice and has no network, port or provider", () => {
    const source = readFileSync(join(process.cwd(), "src/domain/voice/voice-advice-redirect.ts"), "utf8");
    for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) expect(match[1], match[1]).toMatch(/^\.\/voice-[a-z-]+$/);
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/\bfetch\b|XMLHttp|WebSocket|process\.env|deepseek|\bkie\b|trtc|provider/i);
  });
});
