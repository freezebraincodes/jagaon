// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VOICE_MAX_CANDIDATES, VOICE_TRANSCRIPT_MAX_CODE_POINTS, VOICE_VOCABULARY_VERSION, candidateMatchesTranscript, voiceAnalysisSchema, type VoiceAnalysis } from "./voice-contracts";
import { analyseTranscript, extractVoiceCandidates, normaliseVoicePhrase, type VoiceMedicineDirectory } from "./voice-candidate-extractor";

const REF_A = { recordType: "MEDICATION", recordId: "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f", revisionId: "7a1c2d3e-4a5b-4c6d-9e7f-0a1b2c3d4e5f" } as const;
const REF_B = { recordType: "MEDICATION", recordId: "1b2c3d4e-5f60-4a1b-8c2d-3e4f5a6b7c8d", revisionId: "2b2c3d4e-5f60-4a1b-9c2d-3e4f5a6b7c8d" } as const;
const analysed = (text: string, language: "en" | "zh", medicines?: VoiceMedicineDirectory): Extract<VoiceAnalysis, { kind: "ANALYSED" }> => {
  const result = analyseTranscript(text, language, medicines ? { medicines } : {});
  expect(voiceAnalysisSchema.safeParse(result).success, text).toBe(true);
  if (result.kind !== "ANALYSED") throw new Error(`expected ANALYSED for ${text}, got ${result.kind}`);
  for (const candidate of result.candidates) expect(candidateMatchesTranscript(candidate, text)).toBe(true);
  return result;
};

describe("multi-fact extraction", () => {
  it("keeps the facts of one utterance separate, each with its own span and source", () => {
    const text = "My sugar was 6.8 mmol, I had chicken rice for lunch and I need to inject my grey pen";
    const result = analysed(text, "en");
    expect(result.candidates.map((candidate) => candidate.kind)).toEqual(["GLUCOSE_READING", "MEAL_NOTE", "MEDICATION_OCCURRENCE"]);
    for (const candidate of result.candidates) expect(candidate).toMatchObject({ source: "DETERMINISTIC", producerVersion: VOICE_VOCABULARY_VERSION });
    expect(result.candidates[1]).toMatchObject({ slot: "LUNCH", itemText: "chicken rice", sourcePhrase: "I had chicken rice for lunch" });
    expect(result.candidates[2]).toMatchObject({ status: "PLANNED", medicineRef: { kind: "UNRESOLVED", phrase: "grey pen" }, state: "AMBIGUOUS", ambiguity: ["MEDICINE_UNRESOLVED"] });
  });

  it('"I need to inject" is never TAKEN; forgot / remembered later / not sure is UNKNOWN', () => {
    for (const text of ["I need to inject my grey pen", "I'm going to take my pill", "I haven't taken my insulin yet"]) expect(analysed(text, "en").candidates[0], text).toMatchObject({ status: "PLANNED" });
    for (const text of ["I forgot my dark pen", "I am not sure I took the white tablet", "maybe I took my pill"]) expect(analysed(text, "en").candidates[0], text).toMatchObject({ status: "UNKNOWN", ambiguity: expect.arrayContaining(["STATUS_UNCLEAR"]) });
    for (const text of ["我需要打灰色的笔", "我待会要吃药"]) expect(analysed(text, "zh").candidates[0], text).toMatchObject({ status: "PLANNED" });
    for (const text of ["我忘了吃药", "我不确定有没有打针"]) expect(analysed(text, "zh").candidates[0], text).toMatchObject({ status: "UNKNOWN" });
    expect(analysed("I didn't take my pill", "en").candidates[0]).toMatchObject({ status: "SKIPPED" });
    expect(analysed("我今天没打针", "zh").candidates[0]).toMatchObject({ status: "SKIPPED" });
  });

  it("never infers a medicine from a colour or description: only an exact remembered term or exact canonical name maps it", () => {
    const directory: VoiceMedicineDirectory = { terms: [{ phrase: "dark pen", medication: REF_A }], names: [{ name: "Insulin Glargine", medication: REF_B }] };
    expect(analysed("I injected my dark pen", "en", directory).candidates[0]).toMatchObject({ medicineRef: { kind: "MAPPED", phrase: "dark pen", medication: REF_A, via: "TERMINOLOGY" }, state: "UNDERSTOOD" });
    expect(analysed("I injected my DARK  PEN", "en", directory).candidates[0]).toMatchObject({ medicineRef: { kind: "MAPPED", via: "TERMINOLOGY" } });
    expect(analysed("I injected my insulin glargine", "en", directory).candidates[0]).toMatchObject({ medicineRef: { kind: "MAPPED", medication: REF_B, via: "EXACT_NAME" } });
    for (const text of ["I injected my darker pen", "I injected my grey pen", "I injected my black pen", "I took my blue pill", "I injected my insulin"]) {
      expect(analysed(text, "en", directory).candidates[0], text).toMatchObject({ medicineRef: { kind: "UNRESOLVED" }, ambiguity: expect.arrayContaining(["MEDICINE_UNRESOLVED"]) });
    }
    const zh: VoiceMedicineDirectory = { terms: [{ phrase: "黑色的笔", medication: REF_A }], names: [] };
    expect(analysed("我打了黑色的笔", "zh", zh).candidates[0]).toMatchObject({ medicineRef: { kind: "MAPPED", via: "TERMINOLOGY" } });
    expect(analysed("我打了灰色的笔", "zh", zh).candidates[0]).toMatchObject({ medicineRef: { kind: "UNRESOLVED", phrase: "灰色的笔" } });
  });

  it("normalises phrases deterministically per language", () => {
    expect(normaliseVoicePhrase("  Dark   PEN ", "en")).toBe("dark pen");
    expect(normaliseVoicePhrase(" 黑色 的笔 ", "zh")).toBe("黑色的笔");
  });

  it("never drops the unsupported part of a mixed utterance", () => {
    const result = analysed("Sugar 6.8 mmol, I felt dizzy, and I took my dark pen", "en", { terms: [{ phrase: "dark pen", medication: REF_A }], names: [] });
    expect(result.candidates.map((candidate) => candidate.kind)).toEqual(["GLUCOSE_READING", "UNSUPPORTED_SPAN", "MEDICATION_OCCURRENCE"]);
    expect(result.candidates[1]).toMatchObject({ sourcePhrase: "I felt dizzy" });
    expect(analysed("", "en").candidates).toEqual([]);
  });

  it("a question is never a fact", () => {
    expect(analysed("Did I have lunch", "en").candidates.map((candidate) => candidate.kind)).toEqual(["UNSUPPORTED_SPAN"]);
    expect(analysed("我吃午饭了吗", "zh").candidates.map((candidate) => candidate.kind)).toEqual(["UNSUPPORTED_SPAN"]);
  });

  it("selects one vocabulary per session", () => {
    expect(analysed("sugar 6.8 mmol", "zh").candidates.map((candidate) => candidate.kind)).toEqual(["UNSUPPORTED_SPAN"]);
    expect(analysed("血糖六点八", "en").candidates.map((candidate) => candidate.kind)).toEqual(["UNSUPPORTED_SPAN"]);
  });
});

describe("limits", () => {
  it(`refuses a transcript over ${VOICE_TRANSCRIPT_MAX_CODE_POINTS} code points with no candidates`, () => {
    const atLimit = `sugar 6.8 mmol ${"a".repeat(VOICE_TRANSCRIPT_MAX_CODE_POINTS - 15)}`;
    expect([...atLimit]).toHaveLength(VOICE_TRANSCRIPT_MAX_CODE_POINTS);
    expect(analyseTranscript(atLimit, "en").kind).toBe("ANALYSED");
    expect(analyseTranscript(`${atLimit}a`, "en")).toMatchObject({ kind: "TRANSCRIPT_TOO_LONG", candidates: [] });
    expect(analyseTranscript("😀".repeat(VOICE_TRANSCRIPT_MAX_CODE_POINTS), "en").kind).toBe("ANALYSED");
  });

  it(`lists at most ${VOICE_MAX_CANDIDATES} candidates in order and marks the rest truncated`, () => {
    const text = Array.from({ length: 14 }, (_, index) => `Sugar ${index + 1} mmol.`).join(" ");
    const result = analysed(text, "en");
    expect(result.candidates).toHaveLength(VOICE_MAX_CANDIDATES);
    expect(result.truncated).toBe(true);
    expect(result.candidates.map((candidate) => (candidate.kind === "GLUCOSE_READING" ? candidate.valueText : ""))).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"]);
  });

  it("computes spans in code points after astral characters", () => {
    const text = "😀😀 sugar 6.8 mmol";
    expect(analysed(text, "en").candidates[0]!.span).toEqual({ start: 3, end: 17 });
  });

  it("is deterministic and pure (no clock, random, storage or network in the source)", () => {
    const text = "My sugar was 9 or 10 mmol. I took my pill.";
    expect(extractVoiceCandidates(text, "en")).toEqual(extractVoiceCandidates(text, "en"));
    const source = readFileSync(join(process.cwd(), "src/domain/voice/voice-candidate-extractor.ts"), "utf8");
    expect(source).not.toMatch(/Date\.|Math\.random|crypto|localStorage|sessionStorage|indexedDB|\bfetch\b|process\.env|^import .* from "(?!\.\/|zod)/m);
  });
});

describe("owner default-unit boundary (unitSource)", () => {
  const withDefault = { glucoseEntryUnit: "MMOL_PER_L" as const };
  it("proposes the app's entry unit only for an unambiguous, positively stated reading of the current person", () => {
    expect(analyseTranscript("blood sugar 9.2", "en", withDefault)).toMatchObject({ candidates: [{ valueText: "9.2", unit: "MMOL_PER_L", unitSource: "APP_DEFAULT", state: "UNDERSTOOD", ambiguity: [] }] });
    expect(analyseTranscript("血糖9.2", "zh", withDefault)).toMatchObject({ candidates: [{ valueText: "9.2", unit: "MMOL_PER_L", unitSource: "APP_DEFAULT" }] });
    expect(analyseTranscript("blood sugar 9.2 mmol", "en", withDefault)).toMatchObject({ candidates: [{ unitSource: "SPOKEN" }] });
  });

  it("never applies the default to negated, uncertain, corrected, other-person or multi-number readings, nor without the setting", () => {
    for (const text of ["My sugar was not 6.8", "My sugar was below 4", "my sugar target is 7", "Yesterday my sugar was 9", "my wife's sugar was 9.1", "My sugar at 9 was 6.8", "My sugar was 6.8. No, sorry, it was 8.6."]) {
      const result = analyseTranscript(text, "en", withDefault);
      if (result.kind !== "ANALYSED") throw new Error(text);
      for (const candidate of result.candidates.filter((c) => c.kind === "GLUCOSE_READING")) expect(candidate, text).toMatchObject({ unitSource: null, unit: "UNSTATED", state: "AMBIGUOUS" });
    }
    for (const text of ["血糖不是七点二", "血糖低于四", "血糖目标是七", "昨天血糖九", "我妈妈的血糖是十二"]) {
      const result = analyseTranscript(text, "zh", withDefault);
      if (result.kind !== "ANALYSED") throw new Error(text);
      for (const candidate of result.candidates.filter((c) => c.kind === "GLUCOSE_READING")) expect(candidate, text).toMatchObject({ unitSource: null, state: "AMBIGUOUS" });
    }
    expect(analyseTranscript("blood sugar 9.2", "en")).toMatchObject({ candidates: [{ unit: "UNSTATED", unitSource: null }] });
    // Never relabels another unit, never makes a measurement from a unit: no glucose candidate at all.
    for (const text of ["ketones 1.2", "sugar 9 mg", "insulin 10 mmol"]) {
      const result = analyseTranscript(text, "en", withDefault);
      if (result.kind === "ANALYSED") expect(result.candidates.filter((c) => c.kind === "GLUCOSE_READING"), text).toEqual([]);
    }
  });
});
