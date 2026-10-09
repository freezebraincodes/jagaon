// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyseTranscript, type VoiceAnalysisOptions } from "@/domain/voice/voice-candidate-extractor";
import { reviewVoiceCandidates, voiceSaveIntentSchema, type VoiceFactDecision, type VoiceReviewInput } from "./voice-review-contract";

const DARK = { recordType: "MEDICATION", recordId: "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f", revisionId: "7a1c2d3e-4a5b-4c6d-9e7f-0a1b2c3d4e5f" } as const;
const GREY = { recordType: "MEDICATION", recordId: "1b2c3d4e-5f60-4a1b-8c2d-3e4f5a6b7c8d", revisionId: "2b2c3d4e-5f60-4a1b-9c2d-3e4f5a6b7c8d" } as const;
const REMOVED = { recordType: "MEDICATION", recordId: "9b2c3d4e-5f60-4a1b-8c2d-3e4f5a6b7c8d", revisionId: "8b2c3d4e-5f60-4a1b-9c2d-3e4f5a6b7c8d" } as const;
const OPTIONS: VoiceAnalysisOptions = { medicines: { terms: [{ phrase: "dark pen", medication: DARK }, { phrase: "黑色的笔", medication: DARK }], names: [] } };
const completed = (sessionToken = 3) => ({ sessionToken, state: "COMPLETED" as const });
const review = (transcript: string, decisions: VoiceFactDecision[], language: "en" | "zh" = "en", overrides: Partial<VoiceReviewInput> = {}, options: VoiceAnalysisOptions = OPTIONS) =>
  reviewVoiceCandidates({ analysis: analyseTranscript(transcript, language, options), reviewedSessionToken: 3, currentSession: completed(), knownMedications: [DARK, GREY], decisions, ...overrides });
const save = (candidateIndex: number, extra: Partial<Extract<VoiceFactDecision, { action: "SAVE" }>> = {}): VoiceFactDecision => ({ candidateIndex, action: "SAVE", ...extra });

describe("voice review → save intents (multi-fact, review C3)", () => {
  it("saves each explicitly confirmed fact separately: glucose, meal and a mapped medicine", () => {
    const result = review("My sugar was 6.8 mmol, I had chicken rice for lunch and I injected my dark pen", [save(0), save(1), save(2)]);
    expect(result).toEqual({
      kind: "INTENTS",
      intents: [
        { candidateIndex: 0, intent: { kind: "GLUCOSE", valueText: "6.8", unit: "MMOL_PER_L", unitSource: "SPOKEN" } },
        { candidateIndex: 1, intent: { kind: "MEAL", slot: "LUNCH", itemText: "chicken rice" } },
        { candidateIndex: 2, intent: { kind: "MEDICATION_EVENT", medication: DARK, status: "TAKEN", reportedAmount: null } },
      ],
      rejected: [],
    });
    expect(review("血糖六点八毫摩尔，我午饭吃了鸡饭，然后打了黑色的笔", [save(0), save(1), save(2)], "zh")).toMatchObject({ kind: "INTENTS", intents: [{ intent: { kind: "GLUCOSE" } }, { intent: { kind: "MEAL", slot: "LUNCH", itemText: "鸡饭" } }, { intent: { kind: "MEDICATION_EVENT", status: "TAKEN" } }] });
    // A skipped fact is not saved; the others still are.
    expect(review("My sugar was 6.8 mmol, I had chicken rice for lunch", [{ candidateIndex: 0, action: "SKIP" }, save(1)])).toMatchObject({ kind: "INTENTS", intents: [{ candidateIndex: 1 }] });
  });

  it("only UNIT_UNSTATED is resolved by a unit answer; an app-default unit is labelled as such", () => {
    expect(review("Sugar reading 9.2", [save(0)])).toMatchObject({ kind: "NO_INTENT", reason: "NO_CONFIRMATION", rejected: [{ reason: "UNIT_NOT_ANSWERED" }] });
    expect(review("Sugar reading 9.2", [save(0, { answers: { unit: "MMOL_PER_L" } })])).toMatchObject({ intents: [{ intent: { valueText: "9.2", unitSource: "PERSON" } }] });
    expect(review("blood sugar 9.2", [save(0)], "en", {}, { ...OPTIONS, glucoseEntryUnit: "MMOL_PER_L" })).toMatchObject({ intents: [{ intent: { valueText: "9.2", unitSource: "APP_DEFAULT" } }] });
    expect(review("血糖9.2", [save(0)], "zh", {}, { ...OPTIONS, glucoseEntryUnit: "MMOL_PER_L" })).toMatchObject({ intents: [{ intent: { unitSource: "APP_DEFAULT" } }] });
  });

  it("negation, uncertainty, comparison, target, past time, correction and several numbers are never saved after a unit tick (C3)", () => {
    const en = ["My sugar was not 6.8 mmol", "My sugar was not 6.8", "My sugar was below 4 mmol", "my sugar target is 7 mmol", "Yesterday my sugar was 9 mmol", "My sugar was 6.8 mmol. No, sorry, it was 8.6.", "My sugar at 9 was 6.8 mmol", "sugar between 6 and 8 mmol"];
    for (const text of en) {
      expect(review(text, [save(0, { answers: { unit: "MMOL_PER_L" } })]), text).toMatchObject({ kind: "NO_INTENT", rejected: [{ reason: "NEEDS_EDIT" }] });
    }
    const zh = ["血糖不是七点二毫摩尔", "血糖不是七点二", "血糖低于四毫摩尔", "血糖目标是七毫摩尔", "昨天血糖九毫摩尔", "血糖七点二毫摩尔。不对，是八点六。", "我的血糖是七点二，不过昨天是九"];
    for (const text of zh) expect(review(text, [save(0, { answers: { unit: "MMOL_PER_L" } })], "zh"), text).toMatchObject({ kind: "NO_INTENT", rejected: [{ reason: "NEEDS_EDIT" }] });
    // An explicit, complete edit by the person is the only way through (or manual entry).
    expect(review("My sugar was not 6.8 mmol", [save(0, { edit: { kind: "GLUCOSE_READING", valueText: "8.6", unit: "MMOL_PER_L" } })])).toMatchObject({ intents: [{ intent: { valueText: "8.6", unitSource: "PERSON" } }] });
  });

  it("another person's fact is never saved in this profile, not even from an edit", () => {
    for (const [text, language] of [["my wife's sugar was 9.1 mmol", "en"], ["My mother's blood sugar is 12 mmol", "en"], ["我妈妈的血糖是十二毫摩尔", "zh"]] as const) {
      expect(review(text, [save(0, { edit: { kind: "GLUCOSE_READING", valueText: "9.1", unit: "MMOL_PER_L" } })], language), text).toMatchObject({ kind: "NO_INTENT", rejected: [{ reason: "OTHER_PERSON" }] });
    }
  });

  it("medicines: an unresolved description needs a pick from the profile; a planned dose is not an event; unclear status needs an answer", () => {
    expect(review("I took my blue pill", [save(0)])).toMatchObject({ rejected: [{ reason: "MEDICINE_NOT_ANSWERED" }] });
    expect(review("I took my blue pill", [save(0, { answers: { medication: GREY } })])).toMatchObject({ intents: [{ intent: { kind: "MEDICATION_EVENT", medication: GREY, status: "TAKEN" } }] });
    expect(review("I took my blue pill", [save(0, { answers: { medication: REMOVED } })])).toMatchObject({ rejected: [{ reason: "MEDICINE_NOT_IN_PROFILE" }] });
    expect(review("I need to inject my dark pen", [save(0)])).toMatchObject({ rejected: [{ reason: "PLANNED_NOT_AN_EVENT" }] });
    expect(review("我需要打黑色的笔", [save(0)], "zh")).toMatchObject({ rejected: [{ reason: "PLANNED_NOT_AN_EVENT" }] });
    expect(review("I forgot my dark pen", [save(0)])).toMatchObject({ rejected: [{ reason: "STATUS_NOT_ANSWERED" }] });
    expect(review("I forgot my dark pen", [save(0, { answers: { status: "SKIPPED" } })])).toMatchObject({ intents: [{ intent: { status: "SKIPPED", medication: DARK } }] });
    // A mapping to a removed canonical record is not saved.
    expect(review("I injected my dark pen", [save(0)], "en", { knownMedications: [GREY] })).toMatchObject({ rejected: [{ reason: "MEDICINE_NOT_IN_PROFILE" }] });
  });

  it("owner #4 (13s.3): a reported amount travels unchanged; a plan is never an event; a negated injection is never TAKEN", () => {
    expect(review("I injected 10 units of my dark pen", [save(0)])).toEqual({
      kind: "INTENTS",
      intents: [{ candidateIndex: 0, intent: { kind: "MEDICATION_EVENT", medication: DARK, status: "TAKEN", reportedAmount: { valueText: "10", unitText: "units" } } }],
      rejected: [],
    });
    expect(review("我打了十个单位的灰色的笔", [save(0, { answers: { medication: GREY } })], "zh")).toEqual({
      kind: "INTENTS",
      intents: [{ candidateIndex: 0, intent: { kind: "MEDICATION_EVENT", medication: GREY, status: "TAKEN", reportedAmount: { valueText: "10", unitText: "个单位" } } }],
      rejected: [],
    });
    const rejectedOnly = (reason: string) => ({ kind: "NO_INTENT", reason: "NO_CONFIRMATION", rejected: [{ candidateIndex: 0, reason }] });
    // Round 4 (minor): a skip that carries an amount may be a different amount: never one tap, the person must edit.
    expect(review("I didn't inject 10 units of my dark pen", [save(0)])).toEqual(rejectedOnly("NEEDS_EDIT"));
    for (const [text, language] of [["I did not inject my dark pen", "en"], ["我没打黑色的笔", "zh"]] as const) {
      expect(review(text, [save(0)], language), text).toEqual({ kind: "INTENTS", intents: [{ candidateIndex: 0, intent: { kind: "MEDICATION_EVENT", medication: DARK, status: "SKIPPED", reportedAmount: null } }], rejected: [] });
    }
    for (const [text, language] of [["I need to inject", "en"], ["我需要打针", "zh"]] as const) {
      expect(review(text, [save(0, { answers: { medication: DARK } })], language), text).toEqual(rejectedOnly("PLANNED_NOT_AN_EVENT"));
    }
    // Round 4 (I3): a plan or habit is never a one-tap TAKEN.
    for (const [text, language] of [["Tomorrow I inject my dark pen", "en"], ["明天打黑色的笔", "zh"], ["我平时打黑色的笔", "zh"], ["Usually I took my dark pen", "en"]] as const) {
      expect(review(text, [save(0, { answers: { status: "TAKEN" } })], language), text).toEqual(rejectedOnly("NEEDS_EDIT"));
    }
    for (const [text, language] of [["How many units should I inject?", "en"], ["我应该打几个单位？", "zh"]] as const) expect(review(text, [], language), text).toEqual({ kind: "NO_INTENT", reason: "REDIRECTED" });
    // An edit carries no amount: the person's edit is the medicine and status only.
    expect(review("I injected 10 units of my dark pen", [save(0, { edit: { kind: "MEDICATION_OCCURRENCE", medication: DARK, status: "TAKEN" } })])).toEqual({
      kind: "INTENTS",
      intents: [{ candidateIndex: 0, intent: { kind: "MEDICATION_EVENT", medication: DARK, status: "TAKEN", reportedAmount: null } }],
      rejected: [],
    });
  });

  it("review I2 (13s.3): a glucose value outside 0 < value <= 50 mmol/L is refused, from the transcript or from an edit", () => {
    const outOfRange = { kind: "NO_INTENT", reason: "NO_CONFIRMATION", rejected: [{ candidateIndex: 0, reason: "OUT_OF_RANGE" }] };
    for (const text of ["sugar 99 mmol", "sugar 0 mmol"]) expect(review(text, [save(0)]), text).toEqual(outOfRange);
    for (const text of ["sugar 72", "sugar 50.1"]) expect(review(text, [save(0, { answers: { unit: "MMOL_PER_L" } })]), text).toEqual(outOfRange);
    expect(review("血糖72", [save(0, { answers: { unit: "MMOL_PER_L" } })], "zh")).toEqual(outOfRange);
    for (const valueText of ["72", "0", "50.1"]) {
      expect(review("Sugar 6.8 mmol", [save(0, { edit: { kind: "GLUCOSE_READING", valueText, unit: "MMOL_PER_L" } })]), valueText).toEqual(outOfRange);
    }
    const saved = (valueText: string) => ({ kind: "INTENTS", intents: [{ candidateIndex: 0, intent: { kind: "GLUCOSE", valueText, unit: "MMOL_PER_L", unitSource: "PERSON" } }], rejected: [] });
    expect(review("sugar 50", [save(0, { answers: { unit: "MMOL_PER_L" } })])).toEqual(saved("50"));
    expect(review("sugar 0.1", [save(0, { answers: { unit: "MMOL_PER_L" } })])).toEqual(saved("0.1"));
  });

  it("round 4 (C1): a reading next to anything not understood, or another person named anywhere, is never one tap", () => {
    // A name or another person in a neighbouring clause or sentence: OTHER_PERSON (never saved) or UNCERTAINTY (edit only).
    for (const [text, language, reason] of [
      ["Ah Ma, sugar 7.2", "en", "OTHER_PERSON"],
      ["Sugar 7.2, for Ah Ma", "en", "OTHER_PERSON"],
      ["阿公，血糖七点二", "zh", "OTHER_PERSON"],
      ["帮阿嬷记录，血糖七点二", "zh", "OTHER_PERSON"],
      ["John, sugar 6.8", "en", "NEEDS_EDIT"],
      ["小明，血糖六点八", "zh", "NEEDS_EDIT"],
      ["Is my sugar 7.2", "en", "NEEDS_EDIT"],
    ] as const) {
      const index = analyseTranscript(text, language, { ...OPTIONS, glucoseEntryUnit: "MMOL_PER_L" }).candidates.findIndex((candidate) => candidate.kind === "GLUCOSE_READING");
      expect(review(text, [save(index, { answers: { unit: "MMOL_PER_L" } })], language, {}, { ...OPTIONS, glucoseEntryUnit: "MMOL_PER_L" }), text).toEqual({ kind: "NO_INTENT", reason: "NO_CONFIRMATION", rejected: [{ candidateIndex: index, reason }] });
    }
    // The demo phrasings stay one tap with the app default unit.
    for (const [text, language] of [["My blood sugar is 7.2", "en"], ["血糖9.2", "zh"], ["Today's sugar 7.2", "en"], ["我刚测了血糖，七点二", "zh"]] as const) {
      expect(review(text, [save(0)], language, {}, { ...OPTIONS, glucoseEntryUnit: "MMOL_PER_L" }), text).toEqual({ kind: "INTENTS", intents: [{ candidateIndex: 0, intent: { kind: "GLUCOSE", valueText: text.includes("9.2") ? "9.2" : "7.2", unit: "MMOL_PER_L", unitSource: "APP_DEFAULT" } }], rejected: [] });
    }
  });

  it("a redirect notice does not block separated facts; a full redirect, over-long, cancelled or stale review yields nothing", () => {
    expect(review("sugar 15 mmol, how many units now", [save(0)])).toMatchObject({ kind: "INTENTS", intents: [{ intent: { kind: "GLUCOSE", valueText: "15" } }] });
    expect(review("How many tablets should I take?", [])).toEqual({ kind: "NO_INTENT", reason: "REDIRECTED" });
    expect(review(`sugar 6.8 mmol ${"a".repeat(1300)}`, [save(0)])).toEqual({ kind: "NO_INTENT", reason: "TRANSCRIPT_TOO_LONG" });
    for (const state of ["CANCELLED", "TIMED_OUT", "FAILED", "LISTENING", "STOPPING"] as const) expect(review("Sugar 6.8 mmol", [save(0)], "en", { currentSession: { sessionToken: 3, state } }), state).toEqual({ kind: "NO_INTENT", reason: "SESSION_NOT_COMPLETED" });
    expect(review("Sugar 6.8 mmol", [save(0)], "en", { currentSession: completed(4) })).toEqual({ kind: "NO_INTENT", reason: "STALE_REVIEW" });
  });

  it("refuses malformed decisions as a whole and never saves an unsupported span", () => {
    for (const decisions of [[save(1)], [{ candidateIndex: -1, action: "SAVE" }], [save(0), save(0)], [save(0, { answers: { unit: "MG_DL" as "MMOL_PER_L" } })], [{ ...save(0), valueText: "12" }], [{ candidateIndex: 0, action: "MAYBE" }]]) {
      expect(review("Sugar 6.8 mmol", decisions as VoiceFactDecision[]), JSON.stringify(decisions)).toEqual({ kind: "NO_INTENT", reason: "INVALID_DECISIONS" });
    }
    expect(review("I felt dizzy", [save(0)])).toMatchObject({ kind: "NO_INTENT", rejected: [{ reason: "NOT_A_FACT" }] });
    expect(review("Sugar 6.8 mmol", [save(0, { edit: { kind: "MEAL_NOTE", slot: null, itemText: "rice" } })])).toMatchObject({ rejected: [{ reason: "EDIT_KIND_MISMATCH" }] });
  });

  it("the intent schema is closed: no record id, dose, time, free note or invented unit", () => {
    for (const extra of [{ recordId: "r" }, { note: "x" }, { dose: "2" }, { time: "08:00" }]) expect(voiceSaveIntentSchema.safeParse({ kind: "GLUCOSE", valueText: "6.8", unit: "MMOL_PER_L", unitSource: "SPOKEN", ...extra }).success).toBe(false);
    expect(voiceSaveIntentSchema.safeParse({ kind: "GLUCOSE", valueText: "6.8", unit: "UNSTATED", unitSource: "SPOKEN" }).success).toBe(false);
    expect(voiceSaveIntentSchema.safeParse({ kind: "MEDICATION_EVENT", medication: DARK, status: "PLANNED" }).success).toBe(false);
    expect(voiceSaveIntentSchema.safeParse({ kind: "MEDICATION_EVENT", medication: DARK, status: "TAKEN", amount: 10 }).success).toBe(false);
    expect(voiceSaveIntentSchema.safeParse({ kind: "MEDICATION_EVENT", medication: DARK, status: "TAKEN", reportedAmount: null, amount: 10 }).success).toBe(false);
    expect(voiceSaveIntentSchema.safeParse({ kind: "MEDICATION_EVENT", medication: DARK, status: "TAKEN", reportedAmount: { valueText: "ten", unitText: "units" } }).success).toBe(false);
    expect(voiceSaveIntentSchema.safeParse({ kind: "MEDICATION_EVENT", medication: DARK, status: "TAKEN", reportedAmount: { valueText: "10", unitText: "units" } }).success).toBe(true);
  });

  it("imports no journal or storage code", () => {
    const source = readFileSync(join(process.cwd(), "src/application/voice/voice-review-contract.ts"), "utf8");
    const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]!);
    expect(imports.filter((specifier) => /journal|storage|dexie|backup|react/.test(specifier))).toEqual([]);
  });
});
