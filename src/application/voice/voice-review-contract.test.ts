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
    // Owner decision 2026-10-14: a distress analysis never yields an intent, even with a save decision.
    for (const [text, language] of [["My sugar was 6.8 mmol and I want to die", "en"], ["血糖六点八，I can't go on", "zh"]] as const) {
      expect(review(text, [save(0)], language), text).toEqual({ kind: "NO_INTENT", reason: "DISTRESS" });
      expect(review(text, [], language), text).toEqual({ kind: "NO_INTENT", reason: "DISTRESS" });
    }
    // An edit carries no amount: the person's edit is the medicine and status only.
    expect(review("I injected 10 units of my dark pen", [save(0, { edit: { kind: "MEDICATION_OCCURRENCE", medication: DARK, status: "TAKEN" } })])).toEqual({
      kind: "INTENTS",
      intents: [{ candidateIndex: 0, intent: { kind: "MEDICATION_EVENT", medication: DARK, status: "TAKEN", reportedAmount: null } }],
      rejected: [],
    });
  });

  // CR-11 (owner decisions 2026-10-11; replaces the 13s.3 review I2 OUT_OF_RANGE refusal, whose old expectations this updates).
  it("CR-11 (AC-1, AC-2, AC-7, AC-11): above 50 mmol/L or zero saves only with the explicit confirmation, formatted to one decimal", () => {
    const required = { kind: "NO_INTENT", reason: "NO_CONFIRMATION", rejected: [{ candidateIndex: 0, reason: "CONFIRMATION_REQUIRED" }] };
    const saved = (valueText: string, unitSource: "SPOKEN" | "PERSON") => ({ kind: "INTENTS", intents: [{ candidateIndex: 0, intent: { kind: "GLUCOSE", valueText, unit: "MMOL_PER_L", unitSource } }], rejected: [] });
    for (const [text, language, valueText] of [
      ["My sugar was 60 mmol", "en", "60.0"],
      ["My sugar was sixty mmol", "en", "60.0"],
      ["sugar 99 mmol", "en", "99.0"],
      ["sugar 0 mmol", "en", "0.0"],
      ["sugar zero mmol", "en", "0.0"],
      ["sugar 100 mmol", "en", "100.0"],
      ["sugar 999.5 mmol", "en", "999.5"],
      ["sugar 1234.5 mmol", "en", "1234.5"],
      ["血糖60毫摩尔", "zh", "60.0"],
      ["血糖六十毫摩尔", "zh", "60.0"],
      ["血糖零毫摩尔", "zh", "0.0"],
    ] as const) {
      expect(review(text, [save(0)], language), text).toEqual(required);
      expect(review(text, [save(0, { confirmed: true })], language), text).toEqual(saved(valueText, "SPOKEN"));
    }
    // An unstated unit outside the app-default window needs BOTH the explicit unit answer and the confirmation (never guessed).
    for (const [text, language] of [["sugar 72", "en"], ["My sugar was sixty", "en"], ["血糖72", "zh"], ["血糖六十", "zh"]] as const) {
      expect(review(text, [save(0, { confirmed: true })], language, {}, { ...OPTIONS, glucoseEntryUnit: "MMOL_PER_L" }), text).toMatchObject({ rejected: [{ reason: "UNIT_NOT_ANSWERED" }] });
      expect(review(text, [save(0, { answers: { unit: "MMOL_PER_L" } })], language, {}, { ...OPTIONS, glucoseEntryUnit: "MMOL_PER_L" }), text).toEqual(required);
      expect(review(text, [save(0, { answers: { unit: "MMOL_PER_L" }, confirmed: true })], language, {}, { ...OPTIONS, glucoseEntryUnit: "MMOL_PER_L" }), text).toMatchObject({ kind: "INTENTS", intents: [{ intent: { unitSource: "PERSON" } }] });
    }
    // An edit above 50 (or zero) needs the confirmation too; a confirmed edit to 45 (the card's latch) saves formatted.
    for (const [valueText, stored] of [["72", "72.0"], ["0", "0.0"], ["50.1", "50.1"]] as const) {
      const edit = { kind: "GLUCOSE_READING" as const, valueText, unit: "MMOL_PER_L" as const };
      expect(review("Sugar 6.8 mmol", [save(0, { edit })]), valueText).toEqual(required);
      expect(review("Sugar 6.8 mmol", [save(0, { edit, confirmed: true })]), valueText).toEqual(saved(stored, "PERSON"));
    }
    expect(review("My sugar was 60 mmol", [save(0, { edit: { kind: "GLUCOSE_READING", valueText: "45", unit: "MMOL_PER_L" }, confirmed: true })])).toEqual(saved("45.0", "PERSON"));
    // At or below 50 nothing changes: one Save, formatted ("50" → "50.0").
    expect(review("sugar 50", [save(0, { answers: { unit: "MMOL_PER_L" } })])).toEqual(saved("50.0", "PERSON"));
    expect(review("sugar 0.1", [save(0, { answers: { unit: "MMOL_PER_L" } })])).toEqual(saved("0.1", "PERSON"));
  });

  it("CR-11 round 5 (revised B): a hedged proposal (about, ~, 大约, 左右 ...) needs Save as shown whatever its value; the unit is never defaulted", () => {
    const required = { kind: "NO_INTENT", reason: "NO_CONFIRMATION", rejected: [{ candidateIndex: 0, reason: "CONFIRMATION_REQUIRED" }] };
    const withDefault = { ...OPTIONS, glucoseEntryUnit: "MMOL_PER_L" as const };
    for (const [text, language, valueText] of [["My sugar was about 7.8 mmol", "en", "7.8"], ["sugar ~7 mmol", "en", "7.0"], ["sugar ≈9.2 mmol", "en", "9.2"], ["sugar ～60 mmol", "en", "60.0"], ["血糖大约七点八毫摩尔", "zh", "7.8"], ["血糖七点八毫摩尔左右", "zh", "7.8"], ["血糖～7毫摩尔", "zh", "7.0"]] as const) {
      expect(review(text, [save(0)], language, {}, withDefault), text).toEqual(required);
      expect(review(text, [save(0, { confirmed: true })], language, {}, withDefault), text).toEqual({ kind: "INTENTS", intents: [{ candidateIndex: 0, intent: { kind: "GLUCOSE", valueText, unit: "MMOL_PER_L", unitSource: "SPOKEN" } }], rejected: [] });
    }
    for (const [text, language] of [["sugar about 7", "en"], ["sugar ~7", "en"], ["血糖大约七", "zh"], ["血糖七左右", "zh"]] as const) {
      expect(review(text, [save(0, { confirmed: true })], language, {}, withDefault), text).toMatchObject({ rejected: [{ reason: "UNIT_NOT_ANSWERED" }] });
      expect(review(text, [save(0, { answers: { unit: "MMOL_PER_L" } })], language, {}, withDefault), text).toEqual(required);
      expect(review(text, [save(0, { answers: { unit: "MMOL_PER_L" }, confirmed: true })], language, {}, withDefault), text).toMatchObject({ kind: "INTENTS", intents: [{ intent: { valueText: "7.0", unitSource: "PERSON" } }] });
    }
    // Unchanged: an unhedged reading inside the window is one Save with the app default.
    expect(review("blood sugar 9.2", [save(0)], "en", {}, withDefault)).toMatchObject({ kind: "INTENTS", intents: [{ intent: { valueText: "9.2", unitSource: "APP_DEFAULT" } }] });
  });

  it("CR-11 (AC-10, AC-12): an edit with more than one decimal, a sign, an exponent or a leading zero is refused as malformed (never rounded)", () => {
    for (const valueText of ["9.25", "60.00", "6.80", "-5", "1e3", "abc", "060", "12345"]) {
      expect(review("Sugar 6.8 mmol", [save(0, { edit: { kind: "GLUCOSE_READING", valueText, unit: "MMOL_PER_L" }, confirmed: true })]), valueText).toEqual({ kind: "NO_INTENT", reason: "INVALID_DECISIONS" });
    }
    for (const valueText of ["60", "6.8", "9.2"]) expect(voiceSaveIntentSchema.safeParse({ kind: "GLUCOSE", valueText, unit: "MMOL_PER_L", unitSource: "PERSON" }).success, valueText).toBe(valueText === "6.8" || valueText === "9.2");
    expect(voiceSaveIntentSchema.safeParse({ kind: "GLUCOSE", valueText: "9.25", unit: "MMOL_PER_L", unitSource: "PERSON" }).success).toBe(false);
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
    expect(review("sugar 15 mmol, how many units now", [save(0)])).toMatchObject({ kind: "INTENTS", intents: [{ intent: { kind: "GLUCOSE", valueText: "15.0" } }] });
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

describe("13s.6: feelings and activities (owner decision 2026-10-14)", () => {
  it("a FEELING_NOTE becomes a FEELING_NOTE intent with her words and the cue keys; an edit replaces the words (trimmed)", () => {
    expect(review("Feeling tired and a bit worried today.", [save(0)])).toEqual({
      kind: "INTENTS",
      intents: [{ candidateIndex: 0, intent: { kind: "FEELING_NOTE", text: "Feeling tired and a bit worried today.", cueKeys: ["tired", "worried"] } }],
      rejected: [],
    });
    expect(review("Feeling tired", [save(0, { edit: { kind: "FEELING_NOTE", text: "  Tired after a long night.  " } })])).toMatchObject({ intents: [{ intent: { kind: "FEELING_NOTE", text: "Tired after a long night.", cueKeys: ["tired"] } }] });
    expect(review("Feeling tired", [save(0, { edit: { kind: "FEELING_NOTE", text: "   " } })])).toMatchObject({ kind: "NO_INTENT", rejected: [{ reason: "TEXT_INVALID" }] });
    expect(review("Feeling tired", [save(0, { edit: { kind: "FEELING_NOTE", text: "x".repeat(1001) } })])).toMatchObject({ kind: "NO_INTENT", rejected: [{ reason: "TEXT_INVALID" }] });
    expect(review("Feeling tired", [save(0, { edit: { kind: "MEAL_NOTE", slot: null, itemText: "rice" } })])).toMatchObject({ kind: "NO_INTENT", rejected: [{ reason: "EDIT_KIND_MISMATCH" }] });
    expect(review("Feeling tired", [{ candidateIndex: 0, action: "SKIP" }])).toEqual({ kind: "NO_INTENT", reason: "NO_CONFIRMATION" });
  });

  it("an ACTIVITY_NOTE becomes an ACTIVITY intent; an edit replaces the label and the duration (or clears it)", () => {
    expect(review("Walked 30 minutes after dinner", [save(0)])).toEqual({
      kind: "INTENTS",
      intents: [{ candidateIndex: 0, intent: { kind: "ACTIVITY", category: "WALKING", label: "Walked 30 minutes after dinner", durationMinutes: 30 } }],
      rejected: [],
    });
    expect(review("Walked 30 minutes after dinner", [save(0, { edit: { kind: "ACTIVITY_NOTE", label: "Walk by the river", durationMinutes: 45 } })])).toMatchObject({ intents: [{ intent: { kind: "ACTIVITY", category: "WALKING", label: "Walk by the river", durationMinutes: 45 } }] });
    expect(review("Walked 30 minutes after dinner", [save(0, { edit: { kind: "ACTIVITY_NOTE", label: "Walked", durationMinutes: null } })])).toMatchObject({ intents: [{ intent: { durationMinutes: null } }] });
    expect(review("Walked 30 minutes after dinner", [save(0, { edit: { kind: "ACTIVITY_NOTE", label: " ", durationMinutes: null } })])).toMatchObject({ kind: "NO_INTENT", rejected: [{ reason: "TEXT_INVALID" }] });
    // A duration outside 1–1440 whole minutes is a malformed decision (the whole review is refused, fail closed).
    for (const durationMinutes of [0, 1441, 2.5]) expect(review("Walked 30 minutes", [save(0, { edit: { kind: "ACTIVITY_NOTE", label: "Walked", durationMinutes } })]), String(durationMinutes)).toEqual({ kind: "NO_INTENT", reason: "INVALID_DECISIONS" });
  });

  it("a feeling, an activity and a reading in one utterance are each decided separately; distress still yields nothing", () => {
    const result = review("Walked 30 minutes. My sugar was 6.8 mmol. Feeling good.", [save(0), save(2)]);
    expect(result).toMatchObject({ kind: "INTENTS", intents: [{ candidateIndex: 0, intent: { kind: "ACTIVITY" } }, { candidateIndex: 2, intent: { kind: "FEELING_NOTE", cueKeys: ["good"] } }] });
    expect(review("I feel so tired I want to die", [save(0)])).toEqual({ kind: "NO_INTENT", reason: "DISTRESS" });
  });

  it("the intent schema accepts only her trimmed words, valid cue keys and whole minutes", () => {
    expect(voiceSaveIntentSchema.safeParse({ kind: "FEELING_NOTE", text: "Tired", cueKeys: ["tired"] }).success).toBe(true);
    expect(voiceSaveIntentSchema.safeParse({ kind: "FEELING_NOTE", text: " Tired", cueKeys: ["tired"] }).success).toBe(false);
    expect(voiceSaveIntentSchema.safeParse({ kind: "FEELING_NOTE", text: "Tired", cueKeys: [] }).success).toBe(false);
    expect(voiceSaveIntentSchema.safeParse({ kind: "FEELING_NOTE", text: "Tired", cueKeys: ["Tired"] }).success).toBe(false);
    expect(voiceSaveIntentSchema.safeParse({ kind: "ACTIVITY", category: "WALKING", label: "Walk", durationMinutes: null }).success).toBe(true);
    expect(voiceSaveIntentSchema.safeParse({ kind: "ACTIVITY", category: "DANCING", label: "Walk", durationMinutes: null }).success).toBe(false);
    expect(voiceSaveIntentSchema.safeParse({ kind: "ACTIVITY", category: "WALKING", label: "Walk", durationMinutes: 0 }).success).toBe(false);
  });
});
