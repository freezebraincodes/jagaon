// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  VOICE_CONTRACT_VERSION,
  VOICE_EXTRACTOR_VERSION,
  VOICE_GLUCOSE_APP_DEFAULT_WINDOW,
  VOICE_REDIRECT_HEALTH_MESSAGE_KEY,
  VOICE_REDIRECT_MESSAGE_KEY,
  VOICE_REDIRECT_TRANSCRIBED_NOTE_KEY,
  VOICE_VOCABULARY_VERSION,
  candidateMatchesTranscript,
  glucoseHedgeMarked,
  glucoseNeedsConfirmation,
  glucoseValueInAppDefaultWindow,
  voiceAnalysisSchema,
  voiceCandidateSchema,
  voiceRedirectMessageKey,
  voiceRedirectNoticeSchema,
} from "./voice-contracts";

const MED = { recordType: "MEDICATION", recordId: "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f", revisionId: "7a1c2d3e-4a5b-4c6d-9e7f-0a1b2c3d4e5f" } as const;
const origin = { source: "DETERMINISTIC", producerVersion: VOICE_VOCABULARY_VERSION } as const;

const glucose = Object.freeze({ kind: "GLUCOSE_READING", ...origin, valueText: "6.8", unit: "MMOL_PER_L", unitSource: "SPOKEN", state: "UNDERSTOOD", ambiguity: [], span: { start: 0, end: 8 }, sourcePhrase: "6.8 mmol" });
const ambiguousGlucose = Object.freeze({ ...glucose, unit: "UNSTATED", unitSource: null, state: "AMBIGUOUS", ambiguity: ["UNIT_UNSTATED"], span: { start: 0, end: 3 }, sourcePhrase: "6.8" });
const meal = Object.freeze({ kind: "MEAL_NOTE", ...origin, slot: "LUNCH", itemText: "chicken rice", state: "UNDERSTOOD", ambiguity: [], span: { start: 0, end: 22 }, sourcePhrase: "lunch was chicken rice" });
const unresolved = Object.freeze({ kind: "MEDICATION_OCCURRENCE", ...origin, status: "TAKEN", medicineRef: { kind: "UNRESOLVED", phrase: "dark pen" }, reportedAmount: null, state: "AMBIGUOUS", ambiguity: ["MEDICINE_UNRESOLVED"], span: { start: 0, end: 16 }, sourcePhrase: "used my dark pen" });
const mapped = Object.freeze({ ...unresolved, medicineRef: { kind: "MAPPED", phrase: "dark pen", medication: MED, via: "TERMINOLOGY" }, state: "UNDERSTOOD", ambiguity: [] });
const unsupported = Object.freeze({ kind: "UNSUPPORTED_SPAN", ...origin, span: { start: 0, end: 11 }, sourcePhrase: "I was dizzy" });

describe("voice candidate union (voice-contract.13s.7)", () => {
  it("is version 13s.7 (medicine-information requests, HSA preview, owner decision 2026-10-14; the vocabulary stays 13s.4)", () => {
    expect([VOICE_CONTRACT_VERSION, VOICE_EXTRACTOR_VERSION, VOICE_VOCABULARY_VERSION]).toEqual(["voice-contract.13s.7", "voice-extractor.13s.7", "voice-vocabulary.13s.4"]);
  });

  it("accepts each kind", () => {
    for (const candidate of [glucose, ambiguousGlucose, meal, unresolved, mapped, unsupported]) expect(voiceCandidateSchema.safeParse(candidate).success, candidate.kind).toBe(true);
    expect(voiceCandidateSchema.safeParse({ ...meal, slot: "UNSTATED", itemText: null }).success).toBe(true);
    for (const status of ["PLANNED", "SKIPPED"]) expect(voiceCandidateSchema.safeParse({ ...mapped, status }).success, status).toBe(true);
    expect(voiceCandidateSchema.safeParse({ ...mapped, status: "UNKNOWN", state: "AMBIGUOUS", ambiguity: ["STATUS_UNCLEAR"] }).success).toBe(true);
    expect(voiceCandidateSchema.safeParse({ ...glucose, source: "REMOTE_EXTRACTION", producerVersion: "transcript-extraction.13r.1" }).success).toBe(true);
    expect(voiceCandidateSchema.safeParse({ ...glucose, unitSource: "APP_DEFAULT" }).success).toBe(true);
  });

  it("keeps the owner's default-unit boundary: an app default only on an unambiguous reading, never unit-less, never spoken-less mismatch", () => {
    expect(voiceCandidateSchema.safeParse({ ...glucose, unitSource: "APP_DEFAULT", state: "AMBIGUOUS", ambiguity: ["NEGATION"] }).success).toBe(false);
    expect(voiceCandidateSchema.safeParse({ ...glucose, unitSource: null }).success).toBe(false);
    expect(voiceCandidateSchema.safeParse({ ...ambiguousGlucose, unitSource: "APP_DEFAULT" }).success).toBe(false);
    expect(voiceCandidateSchema.safeParse({ ...ambiguousGlucose, unitSource: "SPOKEN" }).success).toBe(false);
    expect(voiceCandidateSchema.safeParse({ ...glucose, unitSource: "GUESSED" }).success).toBe(false);
  });

  it("owner #2 / CR-11: the app default unit (mmol/L) only applies inside 0 < value <= 50; a spoken value outside stays as spoken", () => {
    expect(VOICE_GLUCOSE_APP_DEFAULT_WINDOW).toEqual({ exclusiveMinimum: 0, maximum: 50 });
    expect(["0.1", "6.8", "50", "50.0"].map(glucoseValueInAppDefaultWindow)).toEqual([true, true, true, true]);
    // CR-11: "50.00" is no longer a valid entry (at most one decimal), so it is outside the window too.
    expect(["0", "0.0", "50.01", "50.00", "50.1", "72", "99", "", "x"].map(glucoseValueInAppDefaultWindow)).toEqual([false, false, false, false, false, false, false, false, false]);
    for (const valueText of ["0", "50.1", "72"]) {
      expect(voiceCandidateSchema.safeParse({ ...glucose, valueText, unitSource: "APP_DEFAULT" }).success, valueText).toBe(false);
      expect(voiceCandidateSchema.safeParse({ ...ambiguousGlucose, valueText }).success, valueText).toBe(true);
    }
    expect(voiceCandidateSchema.safeParse({ ...glucose, valueText: "50", unitSource: "APP_DEFAULT" }).success).toBe(true);
  });

  it("CR-11 (AC-11, AC-12): valueText is 1–4 integer digits with at most one decimal; no ceiling at 50 or 99; never two decimals", () => {
    for (const valueText of ["0", "6.8", "60", "99", "100", "999.5", "1234.5", "9999.9"]) expect(voiceCandidateSchema.safeParse({ ...glucose, valueText }).success, valueText).toBe(true);
    for (const valueText of ["9.25", "60.00", "6.80", "12345", "-5", "1e3", "abc", "060", "", ".5", "6.", " 6.8"]) expect(voiceCandidateSchema.safeParse({ ...glucose, valueText }).success, valueText).toBe(false);
  });

  it("CR-11 round 5 (revised B): a hedged phrase never carries the app-default unit", () => {
    for (const sourcePhrase of ["sugar ~6.8", "sugar about 6.8", "血糖6.8左右", "sugar ≈ 6.8"]) {
      const candidate = { ...glucose, unitSource: "APP_DEFAULT", sourcePhrase, span: { start: 0, end: [...sourcePhrase].length } };
      expect(voiceCandidateSchema.safeParse(candidate).success, sourcePhrase).toBe(false);
      expect(voiceCandidateSchema.safeParse({ ...candidate, unitSource: "SPOKEN" }).success, sourcePhrase).toBe(true);
    }
    expect(["sugar about 7", "sugar ~7", "血糖大约七", "血糖七左右", "sugar ≈ 7", "sugar ∼7", "sugar ～7", "sugar roughly 7", "sugar approximately 7", "sugar around 7"].map(glucoseHedgeMarked)).toEqual(Array(10).fill(true));
    // Round 8 (owner decision 2026-10-11): "=" and "＝" are not hedges (before a number they give no value).
    expect(["sugar 7", "sugar maybe 7", "sugar approx 7", "血糖可能七", "sugar 7 or so", "sugar roundabout 7", "sugar = 7", "血糖=7", "血糖＝7"].map(glucoseHedgeMarked)).toEqual(Array(9).fill(false));
  });

  it("CR-11: above 50 mmol/L or zero needs explicit confirmation (a trigger, never a limit)", () => {
    expect(["60", "60.0", "50.1", "100", "1234.5", "0", "0.0"].map(glucoseNeedsConfirmation)).toEqual([true, true, true, true, true, true, true]);
    expect(["0.1", "6.8", "50", "50.0", "9.25", "-5", "x"].map(glucoseNeedsConfirmation)).toEqual([false, false, false, false, false, false, false]);
  });

  it("owner #4: a medicine occurrence carries a reported amount only as spoken words, or null; never a dose instruction", () => {
    expect(voiceCandidateSchema.safeParse({ ...mapped, reportedAmount: { valueText: "10", unitText: "units" } }).success).toBe(true);
    expect(voiceCandidateSchema.safeParse({ ...mapped, reportedAmount: { valueText: "2", unitText: "片" } }).success).toBe(true);
    expect(voiceCandidateSchema.safeParse({ ...mapped, reportedAmount: { valueText: "0.5", unitText: "tablet" } }).success).toBe(true);
    const { reportedAmount: _omitted, ...withoutAmount } = mapped;
    expect(voiceCandidateSchema.safeParse(withoutAmount).success).toBe(false);
    for (const reportedAmount of [
      { valueText: "ten", unitText: "units" },
      { valueText: "12345", unitText: "units" },
      { valueText: "1.234", unitText: "units" },
      { valueText: "10", unitText: "" },
      { valueText: "10", unitText: "u".repeat(25) },
      { valueText: "10" },
      { valueText: "10", unitText: "units", instruction: "take" },
      { valueText: 10, unitText: "units" },
    ]) expect(voiceCandidateSchema.safeParse({ ...mapped, reportedAmount }).success, JSON.stringify(reportedAmount)).toBe(false);
    for (const candidate of [glucose, meal, unsupported]) expect(voiceCandidateSchema.safeParse({ ...candidate, reportedAmount: null }).success, candidate.kind).toBe(false);
  });

  it("refuses extra fields, record ids, committed state, advice, doses, times, clinical classes and free text", () => {
    for (const extra of [{ recordId: "rec-1" }, { committed: true }, { advice: "take 2" }, { dose: "10 units" }, { amount: 2 }, { time: "08:00" }, { clinicalClass: "HIGH" }, { note: "free text" }]) {
      for (const candidate of [glucose, meal, mapped, unsupported]) expect(voiceCandidateSchema.safeParse({ ...candidate, ...extra }).success, `${candidate.kind} ${JSON.stringify(extra)}`).toBe(false);
    }
    expect(voiceCandidateSchema.safeParse({ ...mapped, medicineRef: { ...mapped.medicineRef, guessedFrom: "colour" } }).success).toBe(false);
  });

  it("refuses unknown kinds, statuses and inconsistent ambiguity", () => {
    for (const kind of ["ADHERENCE_STATEMENT", "TIME_OF_DAY_CONTEXT", "SYMPTOM"]) expect(voiceCandidateSchema.safeParse({ ...glucose, kind }).success, kind).toBe(false);
    expect(voiceCandidateSchema.safeParse({ ...mapped, status: "DOUBLE" }).success).toBe(false);
    expect(voiceCandidateSchema.safeParse({ ...unresolved, state: "UNDERSTOOD", ambiguity: [] }).success).toBe(false);
    expect(voiceCandidateSchema.safeParse({ ...mapped, status: "UNKNOWN" }).success).toBe(false);
    expect(voiceCandidateSchema.safeParse({ ...meal, state: "AMBIGUOUS", ambiguity: ["UNIT_UNSTATED"] }).success).toBe(false);
    expect(voiceCandidateSchema.safeParse({ ...glucose, unit: "UNSTATED" }).success).toBe(false);
    expect(voiceCandidateSchema.safeParse({ ...ambiguousGlucose, ambiguity: ["NEGATION", "UNIT_UNSTATED"] }).success).toBe(false);
    expect(voiceCandidateSchema.safeParse({ ...glucose, span: { start: 0, end: 9 } }).success).toBe(false);
    // CR-11: "120" is a valid value now (no hidden ceiling); five integer digits are not.
    expect(voiceCandidateSchema.safeParse({ ...glucose, valueText: "12345" }).success).toBe(false);
    expect(voiceCandidateSchema.safeParse({ ...glucose, producerVersion: "voice-vocabulary.learned" }).success).toBe(false);
    expect(voiceCandidateSchema.safeParse({ ...glucose, source: "MODEL" }).success).toBe(false);
    expect(voiceCandidateSchema.safeParse({ ...mapped, medicineRef: { ...mapped.medicineRef, medication: { ...MED, recordType: "PRESCRIPTION_VERSION" } } }).success).toBe(false);
    expect(voiceCandidateSchema.safeParse({ ...mapped, medicineRef: { ...mapped.medicineRef, via: "GUESS" } }).success).toBe(false);
  });

  it("checks a candidate against its transcript in code points", () => {
    expect(candidateMatchesTranscript({ span: { start: 2, end: 10 }, sourcePhrase: "6.8 mmol" }, "😀 6.8 mmol")).toBe(true);
    expect(candidateMatchesTranscript({ span: { start: 0, end: 8 }, sourcePhrase: "6.8 mmol" }, "😀 6.8 mmol")).toBe(false);
  });

  it("closes the analysis result: a redirect or an over-long transcript carries no candidate", () => {
    const redirect = { kind: "REDIRECT", language: "en", candidates: [], category: "DOSE_TREATMENT", messageKey: VOICE_REDIRECT_MESSAGE_KEY, transcribedNoteKey: VOICE_REDIRECT_TRANSCRIBED_NOTE_KEY, extractorVersion: VOICE_EXTRACTOR_VERSION };
    const health = { ...redirect, category: "HEALTH_QUESTION", messageKey: VOICE_REDIRECT_HEALTH_MESSAGE_KEY };
    expect([voiceAnalysisSchema.safeParse(redirect).success, voiceAnalysisSchema.safeParse(health).success]).toEqual([true, true]);
    expect(voiceAnalysisSchema.safeParse({ ...redirect, candidates: [glucose] }).success).toBe(false);
    expect(voiceAnalysisSchema.safeParse({ ...redirect, messageKey: "free advice" }).success).toBe(false);
    // owner #3: the message key always matches the category; no category, no redirect.
    expect(voiceAnalysisSchema.safeParse({ ...redirect, messageKey: VOICE_REDIRECT_HEALTH_MESSAGE_KEY }).success).toBe(false);
    expect(voiceAnalysisSchema.safeParse({ ...health, messageKey: VOICE_REDIRECT_MESSAGE_KEY }).success).toBe(false);
    expect(voiceAnalysisSchema.safeParse({ ...redirect, category: "DIET" }).success).toBe(false);
    const { category: _category, ...uncategorised } = redirect;
    expect(voiceAnalysisSchema.safeParse(uncategorised).success).toBe(false);
    expect([voiceRedirectMessageKey("DOSE_TREATMENT"), voiceRedirectMessageKey("HEALTH_QUESTION")]).toEqual(["voice.redirect.body", "voice.redirect.healthBody"]);
    expect(voiceAnalysisSchema.safeParse({ kind: "TRANSCRIPT_TOO_LONG", language: "zh", candidates: [glucose], extractorVersion: VOICE_EXTRACTOR_VERSION }).success).toBe(false);
    const analysed = { kind: "ANALYSED", language: "en", candidates: Array.from({ length: 12 }, () => glucose), truncated: true, redirect: null, extractorVersion: VOICE_EXTRACTOR_VERSION };
    const notice = { category: "DOSE_TREATMENT", messageKey: VOICE_REDIRECT_MESSAGE_KEY, transcribedNoteKey: VOICE_REDIRECT_TRANSCRIBED_NOTE_KEY };
    const healthNotice = { category: "HEALTH_QUESTION", messageKey: VOICE_REDIRECT_HEALTH_MESSAGE_KEY, transcribedNoteKey: VOICE_REDIRECT_TRANSCRIBED_NOTE_KEY };
    // Mixed safety content: facts beside a visible redirect, never a medicine occurrence beside it.
    expect(voiceAnalysisSchema.safeParse({ ...analysed, candidates: [glucose, meal], redirect: notice }).success).toBe(true);
    expect(voiceAnalysisSchema.safeParse({ ...analysed, candidates: [glucose, meal], redirect: healthNotice }).success).toBe(true);
    expect(voiceAnalysisSchema.safeParse({ ...analysed, candidates: [glucose, mapped], redirect: notice }).success).toBe(false);
    expect(voiceAnalysisSchema.safeParse({ ...analysed, candidates: [glucose, mapped], redirect: healthNotice }).success).toBe(false);
    expect(voiceAnalysisSchema.safeParse({ ...analysed, redirect: { ...notice, messageKey: "advice" } }).success).toBe(false);
    expect(voiceRedirectNoticeSchema.safeParse({ ...notice, messageKey: VOICE_REDIRECT_HEALTH_MESSAGE_KEY }).success).toBe(false);
    expect(voiceRedirectNoticeSchema.safeParse({ ...healthNotice, messageKey: VOICE_REDIRECT_MESSAGE_KEY }).success).toBe(false);
    expect(voiceAnalysisSchema.safeParse(analysed).success).toBe(true);
    expect(voiceAnalysisSchema.safeParse({ ...analysed, candidates: [...analysed.candidates, glucose] }).success).toBe(false);
    expect(voiceAnalysisSchema.safeParse({ ...analysed, transcript: "kept" }).success).toBe(false);
    expect(voiceAnalysisSchema.safeParse({ ...analysed, language: "ms" }).success).toBe(false);
  });

  it("13s.5: a DISTRESS result carries only its cue key and the cue list version: no candidate, redirect or transcript", () => {
    const distress = { kind: "DISTRESS", language: "en", candidates: [], cueKey: "NOT_WANT_TO_LIVE", cuesVersion: "voice-distress-cues.1", extractorVersion: VOICE_EXTRACTOR_VERSION };
    expect(voiceAnalysisSchema.safeParse(distress).success).toBe(true);
    expect(voiceAnalysisSchema.safeParse({ ...distress, language: "zh" }).success).toBe(true);
    expect(voiceAnalysisSchema.safeParse({ ...distress, candidates: [glucose] }).success).toBe(false);
    expect(voiceAnalysisSchema.safeParse({ ...distress, cueKey: "SAD" }).success).toBe(false);
    expect(voiceAnalysisSchema.safeParse({ ...distress, cuesVersion: "voice-distress-cues.0" }).success).toBe(false);
    expect(voiceAnalysisSchema.safeParse({ ...distress, transcript: "kept" }).success).toBe(false);
    expect(voiceAnalysisSchema.safeParse({ ...distress, redirect: null }).success).toBe(false);
    const { cueKey: _cueKey, ...withoutCue } = distress;
    expect(voiceAnalysisSchema.safeParse(withoutCue).success).toBe(false);
  });
});

describe("13s.6: FEELING_NOTE and ACTIVITY_NOTE (owner decision 2026-10-14)", () => {
  const feeling = Object.freeze({ kind: "FEELING_NOTE", ...origin, span: { start: 0, end: 13 }, sourcePhrase: "Feeling tired", cueKeys: ["tired"], text: "Feeling tired." });
  const activity = Object.freeze({ kind: "ACTIVITY_NOTE", ...origin, span: { start: 0, end: 17 }, sourcePhrase: "Walked 30 minutes", category: "WALKING", label: "Walked 30 minutes", durationMinutes: 30 });

  it("accepts each new kind, deterministic only", () => {
    expect(voiceCandidateSchema.safeParse(feeling).success).toBe(true);
    expect(voiceCandidateSchema.safeParse(activity).success).toBe(true);
    expect(voiceCandidateSchema.safeParse({ ...activity, durationMinutes: null }).success).toBe(true);
    for (const candidate of [feeling, activity]) {
      const remote = voiceCandidateSchema.safeParse({ ...candidate, source: "REMOTE_EXTRACTION", producerVersion: "transcript-extraction.13r.1" });
      expect(remote.success).toBe(false);
      if (!remote.success) expect(remote.error.issues.map((issue) => issue.message)).toContain("DETERMINISTIC_ONLY_KIND");
    }
  });

  it("refuses malformed cue keys, untrimmed or empty words, unknown categories and durations outside 1–1440 whole minutes", () => {
    for (const cueKeys of [[], ["Tired"], ["tired out"], ["tired", "tired"], ["x".repeat(33)], Array.from({ length: 13 }, (_, i) => `cue-${"abcdefghijklm"[i]}`)]) expect(voiceCandidateSchema.safeParse({ ...feeling, cueKeys }).success, JSON.stringify(cueKeys)).toBe(false);
    for (const text of ["", " Feeling tired", "Feeling tired ", "x".repeat(1001)]) expect(voiceCandidateSchema.safeParse({ ...feeling, text }).success, text.slice(0, 20)).toBe(false);
    expect(voiceCandidateSchema.safeParse({ ...feeling, state: "UNDERSTOOD", ambiguity: [] }).success).toBe(false);
    for (const durationMinutes of [0, -5, 1441, 2.5]) expect(voiceCandidateSchema.safeParse({ ...activity, durationMinutes }).success, String(durationMinutes)).toBe(false);
    expect(voiceCandidateSchema.safeParse({ ...activity, category: "DANCING" }).success).toBe(false);
    expect(voiceCandidateSchema.safeParse({ ...activity, label: " Walked" }).success).toBe(false);
    expect(voiceCandidateSchema.safeParse({ ...activity, label: "x".repeat(161) }).success).toBe(false);
  });
});
