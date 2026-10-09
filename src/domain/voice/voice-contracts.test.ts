// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  VOICE_CONTRACT_VERSION,
  VOICE_EXTRACTOR_VERSION,
  VOICE_GLUCOSE_MMOL_PER_L_RANGE,
  VOICE_REDIRECT_HEALTH_MESSAGE_KEY,
  VOICE_REDIRECT_MESSAGE_KEY,
  VOICE_REDIRECT_TRANSCRIBED_NOTE_KEY,
  VOICE_VOCABULARY_VERSION,
  candidateMatchesTranscript,
  glucoseValueInRange,
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

describe("voice candidate union (voice-contract.13s.3)", () => {
  it("is version 13s.3", () => {
    expect([VOICE_CONTRACT_VERSION, VOICE_EXTRACTOR_VERSION, VOICE_VOCABULARY_VERSION]).toEqual(["voice-contract.13s.3", "voice-extractor.13s.3", "voice-vocabulary.13s.3"]);
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

  it("owner #2: the app default unit (mmol/L) only applies inside 0 < value <= 50; a spoken value outside stays as spoken", () => {
    expect(VOICE_GLUCOSE_MMOL_PER_L_RANGE).toEqual({ exclusiveMinimum: 0, maximum: 50 });
    expect(["0.1", "6.8", "50", "50.00"].map(glucoseValueInRange)).toEqual([true, true, true, true]);
    expect(["0", "0.0", "50.01", "50.1", "72", "99", "", "x"].map(glucoseValueInRange)).toEqual([false, false, false, false, false, false, false, false]);
    for (const valueText of ["0", "50.1", "72"]) {
      expect(voiceCandidateSchema.safeParse({ ...glucose, valueText, unitSource: "APP_DEFAULT" }).success, valueText).toBe(false);
      expect(voiceCandidateSchema.safeParse({ ...ambiguousGlucose, valueText }).success, valueText).toBe(true);
    }
    expect(voiceCandidateSchema.safeParse({ ...glucose, valueText: "50", unitSource: "APP_DEFAULT" }).success).toBe(true);
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
    expect(voiceCandidateSchema.safeParse({ ...glucose, valueText: "120" }).success).toBe(false);
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
});
