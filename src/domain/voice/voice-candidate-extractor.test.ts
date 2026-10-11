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

/** CR-11 (owner decisions R-1, R-5; design v3.1 §3, AC-1, AC-7, AC-10–AC-14): numbers for a glucose reading, EN and ZH. */
describe("CR-11 spoken and digit glucose values (voice-vocabulary.13s.4)", () => {
  const glucoseOf = (text: string, language: "en" | "zh", defaultUnit = false) => {
    const result = analyseTranscript(text, language, defaultUnit ? { glucoseEntryUnit: "MMOL_PER_L" } : {});
    expect(voiceAnalysisSchema.safeParse(result).success, text).toBe(true);
    return result.kind === "ANALYSED" ? result.candidates.filter((candidate) => candidate.kind === "GLUCOSE_READING") : [];
  };
  const valueOf = (text: string, language: "en" | "zh") => glucoseOf(text, language).map((candidate) => (candidate.kind === "GLUCOSE_READING" ? candidate.valueText : null));

  it("AC-1 / AC-14: spoken tens 21–99 (EN words and hyphen compounds; ZH X十 and X十Y) parse exactly", () => {
    const en: Array<[string, string]> = [
      ["My sugar was sixty mmol", "60"], ["My sugar was 60 mmol", "60"], ["sugar twenty one mmol", "21"], ["sugar twenty-one mmol", "21"], ["sugar thirty mmol", "30"],
      ["sugar forty two mmol", "42"], ["sugar fifty mmol", "50"], ["sugar sixty five mmol", "65"], ["sugar sixty-five mmol", "65"], ["sugar seventy seven mmol", "77"],
      ["sugar eighty eight mmol", "88"], ["sugar ninety nine mmol", "99"], ["sugar sixty point five mmol", "60.5"], ["sugar ninety nine point nine mmol", "99.9"], ["sugar twenty mmol", "20"],
    ];
    for (const [text, value] of en) expect(valueOf(text, "en"), text).toEqual([value]);
    const zh: Array<[string, string]> = [
      ["血糖六十毫摩尔", "60"], ["血糖60毫摩尔", "60"], ["血糖二十一毫摩尔", "21"], ["血糖三十毫摩尔", "30"], ["血糖四十二毫摩尔", "42"], ["血糖六十五毫摩尔", "65"],
      ["血糖九十九毫摩尔", "99"], ["血糖六十点五毫摩尔", "60.5"], ["血糖九十九点九毫摩尔", "99.9"], ["血糖二十毫摩尔", "20"], ["血糖十五毫摩尔", "15"], ["血糖60点5毫摩尔", "60.5"],
    ];
    for (const [text, value] of zh) expect(valueOf(text, "zh"), text).toEqual([value]);
  });

  it("AC-14: never partial: hundreds, approximations, digit by digit and two spoken decimals give NO value (whole phrase not captured)", () => {
    for (const text of ["sugar one hundred twenty mmol", "sugar a hundred and twenty mmol", "sugar sixty something mmol", "sugar sixty-odd", "sugar sixty-ish", "sugar sixty ish mmol", "sugar six zero mmol", "sugar six point two five mmol", "sugar sixty five five mmol", "sugar sixty point mmol"]) {
      expect(glucoseOf(text, "en"), text).toEqual([]);
      const result = analyseTranscript(text, "en");
      if (result.kind === "ANALYSED") expect(result.candidates.some((candidate) => candidate.kind === "UNSUPPORTED_SPAN"), text).toBe(true);
    }
    for (const text of ["血糖一百二十毫摩尔", "血糖一百零五", "血糖六十多", "血糖六十来", "血糖六十几", "血糖六零毫摩尔", "血糖六点二五毫摩尔", "血糖两十", "血糖一十"]) expect(glucoseOf(text, "zh"), text).toEqual([]);
  });

  // Round 5 (owner decision 2026-10-11, revised B): this pinned "about sixty" / 大概六十 as UNCERTAINTY. The core hedges (about, around,
  // approximately, roughly; 大约, 大概, 差不多, 左右; ~ ≈ ～ ∼ =) are now dropped and the reading is always confirmed; other hedges keep it.
  it("AC-14: other hedges and alternatives keep today's ambiguity (edit needed); a time or count follower is not a reading", () => {
    expect(glucoseOf("sugar about sixty mmol", "en")[0]).toMatchObject({ valueText: "60", state: "UNDERSTOOD", ambiguity: [], unitSource: "SPOKEN" });
    expect(glucoseOf("血糖大概六十毫摩尔", "zh")[0]).toMatchObject({ valueText: "60", state: "UNDERSTOOD", ambiguity: [], unitSource: "SPOKEN" });
    expect(glucoseOf("sugar maybe sixty mmol", "en")[0]).toMatchObject({ valueText: "60", ambiguity: expect.arrayContaining(["UNCERTAINTY"]) });
    expect(glucoseOf("血糖可能六十毫摩尔", "zh")[0]).toMatchObject({ valueText: "60", ambiguity: expect.arrayContaining(["UNCERTAINTY"]) });
    for (const candidate of glucoseOf("sugar sixty or seventy mmol", "en")) expect(candidate.ambiguity).toEqual(expect.arrayContaining(["MULTIPLE_NUMBERS"]));
    expect(glucoseOf("sugar sixty minutes", "en")).toEqual([]);
    expect(glucoseOf("血糖六十分钟", "zh")).toEqual([]);
  });

  it("AC-10 / AC-11 / AC-12: digits use the shared format: no ceiling at 99; more than one decimal, five digits or a leading zero give no value", () => {
    for (const [text, value] of [["sugar 100 mmol", "100"], ["sugar 999.5 mmol", "999.5"], ["sugar 1234.5 mmol", "1234.5"], ["sugar 0 mmol", "0"]] as const) expect(valueOf(text, "en"), text).toEqual([value]);
    for (const [text, value] of [["血糖100毫摩尔", "100"], ["血糖1234.5毫摩尔", "1234.5"], ["血糖0毫摩尔", "0"]] as const) expect(valueOf(text, "zh"), text).toEqual([value]);
    for (const text of ["sugar 9.25 mmol", "sugar 60.00 mmol", "sugar 12345 mmol", "sugar 060 mmol"]) expect(glucoseOf(text, "en"), text).toEqual([]);
    for (const text of ["血糖9.25毫摩尔", "血糖9点25毫摩尔", "血糖60.00毫摩尔", "血糖12345毫摩尔"]) expect(glucoseOf(text, "zh"), text).toEqual([]);
  });

  // Fix round 3 (owner ruling 4): this pinned "sugar - 6.8" as a pause (6.8). A dash right before the number is now a sign: no value.
  it("AC-12 (R-7): a sign before a number is never dropped: -5, minus five, 负五 and 零下五 give no value", () => {
    for (const text of ["sugar -5 mmol", "sugar: -5", "sugar minus five mmol", "sugar negative 5 mmol", "sugar −5 mmol", "sugar - 6.8 mmol"]) expect(glucoseOf(text, "en", true), text).toEqual([]);
    for (const text of ["血糖-5毫摩尔", "血糖负五毫摩尔", "血糖零下五", "血糖 - 6.8毫摩尔"]) expect(glucoseOf(text, "zh", true), text).toEqual([]);
  });

  it("AC-7 / AC-13: zero is a value; the app default unit only inside 0 < value ≤ 50; a spoken unit is never overridden; mg/dL stays not a reading", () => {
    expect(glucoseOf("sugar zero mmol", "en")[0]).toMatchObject({ valueText: "0", unit: "MMOL_PER_L", unitSource: "SPOKEN" });
    expect(glucoseOf("血糖零毫摩尔", "zh")[0]).toMatchObject({ valueText: "0", unit: "MMOL_PER_L", unitSource: "SPOKEN" });
    for (const [text, language] of [["sugar zero", "en"], ["My sugar was sixty", "en"], ["sugar 72", "en"], ["血糖零", "zh"], ["血糖六十", "zh"], ["血糖72", "zh"]] as const) {
      expect(glucoseOf(text, language, true)[0], text).toMatchObject({ unit: "UNSTATED", unitSource: null, ambiguity: ["UNIT_UNSTATED"] });
    }
    for (const [text, language] of [["sugar thirty", "en"], ["血糖三十", "zh"]] as const) expect(glucoseOf(text, language, true)[0], text).toMatchObject({ unit: "MMOL_PER_L", unitSource: "APP_DEFAULT", state: "UNDERSTOOD" });
    expect(glucoseOf("sugar 60 mmol", "en", true)[0]).toMatchObject({ unitSource: "SPOKEN" });
    for (const [text, language] of [["sugar 120 mg/dl", "en"], ["sugar one hundred twenty milligrams", "en"], ["血糖120毫克", "zh"]] as const) expect(glucoseOf(text, language, true), text).toEqual([]);
  });
});

describe("CR-11 fix round 1 (m-1): attached dash variants are a sign, exactly like \"-\" and \"−\"", () => {
  const glucose = (text: string, language: "en" | "zh") => {
    const result = analyseTranscript(text, language, { glucoseEntryUnit: "MMOL_PER_L" });
    expect(voiceAnalysisSchema.safeParse(result).success, text).toBe(true);
    return result.kind === "ANALYSED" ? result.candidates.filter((candidate) => candidate.kind === "GLUCOSE_READING") : [];
  };
  const DASHES = ["-", "−", "–", "—", "‑", "‒"];
  it("an attached dash before the number gives no value (EN and ZH); never read as positive", () => {
    for (const dash of DASHES) {
      for (const text of [`sugar ${dash}5 mmol`, `sugar: ${dash}5`, `sugar (${dash}6.8 mmol`]) expect(glucose(text, "en"), JSON.stringify(text)).toEqual([]);
      for (const text of [`血糖${dash}5毫摩尔`, `血糖 ${dash}6.8`, `血糖：${dash}5`]) expect(glucose(text, "zh"), JSON.stringify(text)).toEqual([]);
    }
  });
  // Fix round 3 (owner ruling 4): replaces the round-1 "a spaced dash stays a pause" pin.
  it("round 3: a dash separated from the number only by spaces is a sign too: no value (accepted: a pause dash right before the number)", () => {
    for (const dash of DASHES) {
      for (const text of [`sugar was ${dash} 5`, `sugar ${dash} 5 mmol`, `sugar: ${dash} 5`, `sugar ${dash} 6.8 mmol`, `My sugar was ${dash}  6.8`]) expect(glucose(text, "en"), JSON.stringify(text)).toEqual([]);
      for (const text of [`血糖 ${dash} 5毫摩尔`, `血糖${dash} 5`, `血糖 ${dash} 6.8毫摩尔`, `血糖是 ${dash} 六点八`]) expect(glucose(text, "zh"), JSON.stringify(text)).toEqual([]);
    }
  });
});

/** CR-11 fix round 3 (owner rulings 1 and 4, 2026-10-11). */
describe("CR-11 fix round 3: signs, ranges and excess precision", () => {
  const MEDS = { terms: [{ phrase: "dark pen", medication: { recordType: "MEDICATION" as const, recordId: "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f", revisionId: "7a1c2d3e-4a5b-4c6d-9e7f-0a1b2c3d4e5f" } }], names: [] };
  const summary = (text: string, language: "en" | "zh") => {
    const result = analyseTranscript(text, language, { glucoseEntryUnit: "MMOL_PER_L", medicines: MEDS });
    expect(voiceAnalysisSchema.safeParse(result).success, text).toBe(true);
    if (result.kind !== "ANALYSED") return result.kind;
    return result.candidates
      .map((c) => (c.kind === "GLUCOSE_READING" ? `G(${c.valueText}${c.ambiguity.length ? ` ${c.ambiguity.join("+")}` : ""})` : c.kind === "MEDICATION_OCCURRENCE" ? `D(${c.reportedAmount ? `${c.reportedAmount.valueText} ${c.reportedAmount.unitText}` : "-"}${c.ambiguity.length ? ` ${c.ambiguity.join("+")}` : ""})` : c.kind === "MEAL_NOTE" ? "M" : "U"))
      .join(" ");
  };

  it("round 3b: the full-width hyphen-minus (－) and the small hyphen-minus (﹣) are signs too, attached or spaced; a range stays a range", () => {
    for (const sign of ["－", "﹣"]) {
      for (const text of [`sugar ${sign}5`, `sugar ${sign} 5`, `sugar was ${sign} 5 mmol`, `sugar: ${sign}6.8`]) expect(summary(text, "en"), text).toBe("U");
      for (const text of [`血糖${sign}5`, `血糖 ${sign} 5`, `血糖${sign}5毫摩尔`, `血糖是 ${sign} 六点八`]) expect(summary(text, "zh"), text).toBe("U");
      expect(summary(`血糖7${sign}8`, "zh")).toBe("G(7 UNIT_UNSTATED+MULTIPLE_NUMBERS) G(8 UNIT_UNSTATED+MULTIPLE_NUMBERS)");
      expect(summary(`sugar 6.2 ${sign} 7.0`, "en")).toBe("G(6.2 UNIT_UNSTATED+MULTIPLE_NUMBERS) G(7.0 UNIT_UNSTATED+MULTIPLE_NUMBERS)");
      expect(summary(`血糖七${sign}八`, "zh")).toBe("G(7 UNIT_UNSTATED+MULTIPLE_NUMBERS) G(8 UNIT_UNSTATED+MULTIPLE_NUMBERS)");
    }
  });

  it("round 4 (m-1): ‐ ― ﹘ ➖ ˗ ⁻ ﹢ ⁺ and ± are signs too, attached or spaced (➖ also with its emoji selector); a range stays a range", () => {
    for (const sign of ["‐", "―", "﹘", "➖", "➖\uFE0F", "˗", "⁻", "﹢", "⁺", "±"]) {
      for (const text of [`sugar ${sign}5`, `sugar ${sign} 5 mmol`, `sugar was ${sign} 6.8`]) expect(summary(text, "en"), JSON.stringify(text)).toBe("U");
      for (const text of [`血糖${sign}5`, `血糖 ${sign} 5毫摩尔`, `血糖是 ${sign} 六点八`]) expect(summary(text, "zh"), JSON.stringify(text)).toBe("U");
      expect(summary(`sugar 7${sign}8`, "en"), sign).toBe("G(7 UNIT_UNSTATED+MULTIPLE_NUMBERS) G(8 UNIT_UNSTATED+MULTIPLE_NUMBERS)");
      expect(summary(`sugar 6.2 ${sign} 7.0`, "en"), sign).toBe("G(6.2 UNIT_UNSTATED+MULTIPLE_NUMBERS) G(7.0 UNIT_UNSTATED+MULTIPLE_NUMBERS)");
      expect(summary(`血糖7${sign}8`, "zh"), sign).toBe("G(7 UNIT_UNSTATED+MULTIPLE_NUMBERS) G(8 UNIT_UNSTATED+MULTIPLE_NUMBERS)");
      expect(summary(`血糖七${sign}八`, "zh"), sign).toBe("G(7 UNIT_UNSTATED+MULTIPLE_NUMBERS) G(8 UNIT_UNSTATED+MULTIPLE_NUMBERS)");
    }
  });

  it("ruling 4: a plus sign, attached or spaced, gives no value (never 6 or 6.8)", () => {
    for (const text of ["sugar +6", "sugar + 6", "sugar +6.8", "sugar +6 mmol", "sugar ＋6 mmol"]) expect(summary(text, "en"), text).toBe("U");
    for (const text of ["血糖+6", "血糖 + 6", "血糖＋6毫摩尔"]) expect(summary(text, "zh"), text).toBe("U");
  });

  it("ruling 4: unchanged from the base extractor: ranges, a dash after the number, punctuation not before the number, hyphenated tens, medicine amounts, spoken plus", () => {
    const UNCHANGED: Array<[string, "en" | "zh", string]> = [
      ["sugar 7 - 8 mmol", "en", "U"],
      ["sugar 7-8", "en", "U"],
      ["sugar 7–8 mmol", "en", "G(7 UNIT_UNSTATED+MULTIPLE_NUMBERS) G(8 MULTIPLE_NUMBERS)"],
      ["sugar 6.2 – 7.0 mmol", "en", "G(6.2 UNIT_UNSTATED+MULTIPLE_NUMBERS) G(7.0 MULTIPLE_NUMBERS)"],
      ["sugar 7 –8", "en", "G(7 UNIT_UNSTATED+MULTIPLE_NUMBERS) G(8 UNIT_UNSTATED+MULTIPLE_NUMBERS)"],
      ["血糖七–八", "zh", "G(7 UNIT_UNSTATED+MULTIPLE_NUMBERS) G(8 UNIT_UNSTATED+MULTIPLE_NUMBERS)"],
      ["血糖7–8毫摩尔", "zh", "G(7 UNIT_UNSTATED+MULTIPLE_NUMBERS) G(8 MULTIPLE_NUMBERS)"],
      ["I injected 8–10 units of my dark pen", "en", "D(10 units UNCERTAINTY)"],
      ["我吃了2–3片药", "zh", "D(3 片 UNCERTAINTY+MEDICINE_UNRESOLVED)"],
      ["sugar was 6.8 - before breakfast", "en", "G(6.8)"],
      ["sugar was 6.8, - I felt fine", "en", "G(6.8 UNIT_UNSTATED+UNCERTAINTY) U"],
      ["血糖6.8 - 早餐前", "zh", "G(6.8)"],
      ["sugar plus six mmol", "en", "U"],
      ["血糖正六毫摩尔", "zh", "U"],
    ];
    for (const [text, language, expected] of UNCHANGED) expect(summary(text, language), text).toBe(expected);
    // Hyphenated tens (R-5) stay a value.
    expect(summary("sugar sixty-five mmol", "en")).toBe("G(65)");
  });

  it("ruling 1: excess spoken or written precision is Not captured: no 9, 9.2, 9.3, 60 or 6.8 is ever extracted from it", () => {
    const CASES: Array<[string, "en" | "zh"]> = [
      ["sugar 9.25", "en"], ["sugar 9.25 mmol", "en"], ["sugar nine point two five", "en"], ["sugar nine point two five mmol", "en"], ["sugar 60.00 mmol", "en"], ["sugar 6.80", "en"], ["sugar 6.80 mmol", "en"],
      ["血糖九点二五", "zh"], ["血糖九点二五毫摩尔", "zh"], ["血糖9.25毫摩尔", "zh"], ["血糖9点25", "zh"], ["血糖60.00毫摩尔", "zh"], ["血糖6.80", "zh"], ["血糖六点八零", "zh"],
    ];
    for (const [text, language] of CASES) {
      for (const glucoseEntryUnit of [null, "MMOL_PER_L"] as const) {
        const result = analyseTranscript(text, language, { glucoseEntryUnit });
        expect(result.kind, text).toBe("ANALYSED");
        if (result.kind !== "ANALYSED") continue;
        expect(result.candidates.filter((candidate) => candidate.kind !== "UNSUPPORTED_SPAN"), text).toEqual([]);
        expect(result.candidates.length, text).toBeGreaterThan(0);
        const values = JSON.stringify(result.candidates.map((candidate) => ("valueText" in candidate ? candidate.valueText : null)));
        for (const partial of ["9", "9.2", "9.3", "60", "6.8"]) expect(values, `${text} → ${partial}`).not.toContain(`"${partial}"`);
      }
    }
  });
});

/** CR-11 round 5 (owner-approved 2026-10-11): part A, sign expressions (Unicode classes, brackets, joiners). */
describe("CR-11 round 5 A: a sign before the number is never dropped (dash punctuation, math signs, brackets, quotes, joiners)", () => {
  const values = (text: string, language: "en" | "zh") => {
    const result = analyseTranscript(text, language, { glucoseEntryUnit: "MMOL_PER_L" });
    expect(voiceAnalysisSchema.safeParse(result).success, text).toBe(true);
    return result.kind === "ANALYSED" ? result.candidates.filter((c) => c.kind === "GLUCOSE_READING").map((c) => (c.kind === "GLUCOSE_READING" ? c.valueText : "")) : [];
  };
  const OPENERS = ["(", "（", "[", "［", "{", "「", '"', "'", "“", "‘"];
  const JOINERS = ["\u00AD", "\u200B", "\u200C", "\u200D", "\u2060"];
  it("a sign followed by an opening bracket or quote gives no value, EN and ZH", () => {
    for (const open of OPENERS) {
      for (const text of [`sugar -${open}5`, `sugar - ${open}5`, `sugar −${open} 5 mmol`, `sugar +${open}6`]) expect(values(text, "en"), JSON.stringify(text)).toEqual([]);
      for (const text of [`血糖-${open}5`, `血糖 － ${open}5毫摩尔`, `血糖＋${open}6`]) expect(values(text, "zh"), JSON.stringify(text)).toEqual([]);
    }
    for (const [text, language] of [["sugar -(5)", "en"], ["sugar - (5)", "en"], ["血糖-（5）", "zh"], ["sugar −［5］", "en"], ["血糖＋（6）", "zh"]] as const) expect(values(text, language), text).toEqual([]);
  });
  it("invisible joiners around the sign do not hide it (soft hyphen, zero-width space, ZWNJ, ZWJ, word joiner)", () => {
    for (const joiner of JOINERS) {
      for (const text of [`sugar -${joiner}5`, `sugar ${joiner}-5`, `sugar -${joiner} 5 mmol`]) expect(values(text, "en"), JSON.stringify(text)).toEqual([]);
      for (const text of [`血糖-${joiner}5`, `血糖 ${joiner}－5`]) expect(values(text, "zh"), JSON.stringify(text)).toEqual([]);
    }
  });
  it("a Unicode-class sample: dash punctuation (\\p{Pd}) and the minus/plus math forms are signs", () => {
    for (const sign of ["⸺", "⸻", "‐", "‒", "–", "—", "―", "⸗", "﹘", "﹣", "－", "−", "∓", "±", "⊖", "⊕", "➖", "➕", "➖\uFE0F", "➕\uFE0F", "➖\u20E3", "⁻", "⁺", "˗", "﹢", "＋", "+"]) {
      expect(values(`sugar ${sign}5`, "en"), sign).toEqual([]);
      expect(values(`sugar ${sign} 6.8 mmol`, "en"), sign).toEqual([]);
      expect(values(`血糖${sign}5`, "zh"), sign).toEqual([]);
    }
  });
  it("keeps plain ranges and ignores bracketed glucose numbers under the revised owner decision", () => {
    expect(values("sugar 7 -(8)", "en")).toEqual(["7"]);
    expect(values("sugar 7–8 mmol", "en")).toEqual(["7", "8"]);
    expect(values("血糖七–八", "zh")).toEqual(["7", "8"]);
    expect(values("sugar sixty-five mmol", "en")).toEqual(["65"]);
    expect(values("sugar was 6.8 - before breakfast", "en")).toEqual(["6.8"]);
    expect(values("sugar (7)", "en")).toEqual([]);
    // Round 8 (owner decision 2026-10-11): "=" left this list; it is now a rejected mark (no value), like "＝".
    for (const symbol of ["~", "≈", "～", "∼"]) {
      expect(values(`sugar ${symbol}7 mmol`, "en"), symbol).toEqual(["7"]);
      expect(values(`血糖${symbol}7毫摩尔`, "zh"), symbol).toEqual(["7"]);
    }
  });
});

/** CR-11 round 5 (owner decision 2026-10-11, revised B): hedge words and symbols are dropped; only the number is extracted. */
describe("CR-11 round 5 B: hedges before (or 左右 after) the number are dropped; the reading is always confirmed and never defaults the unit", () => {
  const glucose = (text: string, language: "en" | "zh") => {
    const result = analyseTranscript(text, language, { glucoseEntryUnit: "MMOL_PER_L" });
    expect(voiceAnalysisSchema.safeParse(result).success, text).toBe(true);
    return result.kind === "ANALYSED" ? result.candidates.filter((c) => c.kind === "GLUCOSE_READING") : [];
  };
  // Round 8: "=" is no longer a hedge (owner decision 2026-10-11); see the round 8 tests.
  it("EN about / around / approximately / roughly and ~ ≈ ～ ∼ give the number, with no uncertainty", () => {
    for (const hedge of ["about", "around", "approximately", "roughly", "~", "≈", "～", "∼"]) {
      for (const spaced of [" ", ""]) {
        if (spaced === "" && /^[a-z]/.test(hedge)) continue;
        const spoken = glucose(`My sugar was ${hedge}${spaced}7.8 mmol`, "en");
        expect(spoken.map((c) => [c.valueText, c.unit, c.unitSource, c.ambiguity]), hedge).toEqual([["7.8", "MMOL_PER_L", "SPOKEN", []]]);
        // Unit not said: never the app default, even inside its window; the person must tick "Yes, mmol/L".
        const unstated = glucose(`sugar ${hedge}${spaced}7`, "en");
        expect(unstated.map((c) => [c.valueText, c.unit, c.unitSource, c.ambiguity]), hedge).toEqual([["7", "UNSTATED", null, ["UNIT_UNSTATED"]]]);
      }
    }
    expect(glucose("sugar ～60 mmol", "en").map((c) => c.valueText)).toEqual(["60"]);
    expect(glucose("sugar ≈9.2", "en").map((c) => c.valueText)).toEqual(["9.2"]);
  });
  it("ZH 大约 / 大概 / 差不多 before, 左右 after, and the symbols give the number, with no uncertainty", () => {
    for (const text of ["血糖大约七点八毫摩尔", "血糖大概七点八毫摩尔", "血糖差不多七点八毫摩尔", "血糖七点八毫摩尔左右", "血糖～7.8毫摩尔", "血糖≈7.8毫摩尔"]) {
      expect(glucose(text, "zh").map((c) => [c.valueText, c.unitSource, c.ambiguity]), text).toEqual([["7.8", "SPOKEN", []]]);
    }
    for (const text of ["血糖大约七点八", "血糖七点八左右", "血糖7.8左右", "血糖～7.8"]) expect(glucose(text, "zh").map((c) => [c.valueText, c.unit, c.ambiguity]), text).toEqual([["7.8", "UNSTATED", ["UNIT_UNSTATED"]]]);
    expect(glucose("血糖七点八左右", "zh")[0]!.sourcePhrase).toBe("血糖七点八左右");
  });
  it("all safeguards stay: excess precision, the sign rule, never-partial approximations, alternatives, other hedges", () => {
    for (const [text, language] of [["sugar about 9.25", "en"], ["sugar ~9.25 mmol", "en"], ["血糖大约九点二五", "zh"], ["sugar about -5", "en"], ["sugar ~-5", "en"], ["sugar ~ -(5)", "en"], ["血糖大约-5", "zh"], ["血糖～-5", "zh"], ["sugar sixty-ish", "en"], ["sugar about sixty something", "en"], ["血糖六十多", "zh"], ["血糖六十来", "zh"]] as const) {
      expect(glucose(text, language), text).toEqual([]);
    }
    for (const candidate of glucose("sugar 7 or 8 mmol", "en")) expect(candidate.ambiguity).toEqual(expect.arrayContaining(["MULTIPLE_NUMBERS"]));
    for (const [text, language] of [["sugar maybe 7", "en"], ["sugar I think 7", "en"], ["sugar approx 7", "en"], ["sugar 7.8 or so", "en"], ["血糖可能七", "zh"], ["about my sugar, 7.8", "en"]] as const) {
      expect(glucose(text, language)[0]!.ambiguity, text).toEqual(expect.arrayContaining(["UNCERTAINTY"]));
    }
  });
});


/** CR-11 round 6 (re-review of round 5; owner decisions 2026-10-11: "Do not accept these signs/symbols on input"). */
describe("CR-11 round 6: signs behind hedges, bracket and invisible classes, rejected marks, bracketed ranges", () => {
  const read = (text: string, language: "en" | "zh") => {
    const result = analyseTranscript(text, language, { glucoseEntryUnit: "MMOL_PER_L" });
    expect(voiceAnalysisSchema.safeParse(result).success, text).toBe(true);
    return result.kind === "ANALYSED" ? result.candidates.filter((c) => c.kind === "GLUCOSE_READING").map((c) => (c.kind === "GLUCOSE_READING" ? c.valueText : "")) : [];
  };
  const none = (texts: ReadonlyArray<readonly [string, "en" | "zh"]>) => {
    for (const [text, language] of texts) expect(read(text, language), JSON.stringify(text)).toEqual([]);
  };

  it("A1: a sign separated from the number by a hedge (word, symbol, bracket) gives no value, EN and ZH", () => {
    none([
      ["sugar -~7", "en"], ["sugar - ~7", "en"], ["sugar −≈7", "en"], ["sugar -=7", "en"], ["sugar - = 7", "en"], ["sugar -about 7", "en"], ["sugar - roughly 7", "en"],
      ["sugar -approximately 7", "en"], ["sugar -(about 7)", "en"], ["sugar -(~7)", "en"], ["sugar -around 7.8 mmol", "en"], ["sugar ~-7", "en"], ["sugar about -7", "en"],
      ["血糖-大约7", "zh"], ["血糖-～7", "zh"], ["血糖－大概七点八", "zh"], ["血糖-差不多七", "zh"], ["血糖-（大约7）", "zh"], ["血糖大约-7", "zh"],
    ]);
  });

  it("A2: opening brackets and quotes (\\\\p{Ps}, \\\\p{Pi}) and invisible characters (\\\\p{Cf}, CGJ) between the sign and the number give no value", () => {
    for (const open of ["【", "《", "『", "｛", "〈", "〔", "〖", "⟨", "❨", "⦅", "«", "‹", "‚", "„", "⁅", "⁽", "₍", "(", "（", "[", '"', "“"]) {
      none([[`sugar -${open}5`, "en"], [`sugar - ${open}6.8 mmol`, "en"], [`血糖-${open}5`, "zh"], [`血糖－${open}五`, "zh"]]);
    }
    for (const invisible of ["‎", "‏", "⁡", "͏", "᠎", "­", "​", "⁠", "⁤"]) {
      none([[`sugar -${invisible}5`, "en"], [`sugar ${invisible}-5 mmol`, "en"], [`血糖-${invisible}5`, "zh"]]);
    }
  });

  it("A3: ₋ and ⁒ are signs", () => {
    none([["sugar ₋5", "en"], ["sugar ₋ 5 mmol", "en"], ["sugar ⁒5", "en"], ["血糖₋5", "zh"], ["血糖⁒5", "zh"]]);
  });

  it("A4: bracketed numbers are ignored; quoted and plain ranges retain their existing handling", () => {
    for (const [text, language, values] of [
      ["sugar (7)-(8)", "en", []], ["sugar (7) - (8)", "en", []], ['sugar "7"-"8"', "en", ["7", "8"]], ["血糖（7）-（8）", "zh", []],
      ["sugar 7)-8", "en", ["7", "8"]], ["sugar 7.8]-[8", "en", ["7.8"]], ["sugar 7–8 mmol", "en", ["7", "8"]], ["血糖七–八", "zh", ["7", "8"]],
    ] as const) expect(read(text, language), text).toEqual(values);
  });

  it("owner (a)-(c): the wave dashes, look-alike equals/approximation marks and dash look-alikes before a number give no value", () => {
    for (const mark of ["〜", "〰", "＝", "﹦", "≒", "≃", "≅", "∽", "⁓", "≑", "∾", "ー", "ｰ", "─", "━", "⎯", "﹍", "Ⲻ"]) {
      none([[`sugar ${mark}7`, "en"], [`sugar ${mark} 7.8 mmol`, "en"], [`血糖${mark}7`, "zh"], [`血糖 ${mark} 七点八毫摩尔`, "zh"]]);
    }
  });

  it("kept: the approved hedges give the number; ranges with these marks, sixty-five and medicine amounts are unchanged", () => {
    for (const [text, language, value] of [["sugar ~7", "en", "7"], ["sugar ≈9.2", "en", "9.2"], ["sugar ～60 mmol", "en", "60"], ["sugar ∼7", "en", "7"], ["sugar about 7.8 mmol", "en", "7.8"], ["血糖大约七点八", "zh", "7.8"], ["血糖七点八左右", "zh", "7.8"], ["sugar sixty-five mmol", "en", "65"]] as const) {
      expect(read(text, language), text).toEqual([value]);
    }
    for (const [text, language] of [["sugar 7〜8", "en"], ["sugar 7ー8", "en"], ["sugar 7＝8", "en"], ["血糖7〜8", "zh"], ["血糖7ー8", "zh"], ["血糖7＝8", "zh"]] as const) expect(read(text, language), text).toEqual(["7", "8"]);
    const medicine = analyseTranscript("I injected 8–10 units of my dark pen", "en");
    expect(medicine.kind === "ANALYSED" ? medicine.candidates.map((c) => (c.kind === "MEDICATION_OCCURRENCE" ? c.reportedAmount : c.kind)) : []).toEqual([{ valueText: "10", unitText: "units" }]);
  });
});

/** CR-11 round 7 (re-review of round 6, D1 and the surviving mutants m1, m2). */
describe("CR-11 round 7: padding never pushes a sign out of view; stripping repeats; format characters are invisible", () => {
  const read = (text: string, language: "en" | "zh") => {
    const result = analyseTranscript(text, language, { glucoseEntryUnit: "MMOL_PER_L" });
    expect(voiceAnalysisSchema.safeParse(result).success, JSON.stringify(text)).toBe(true);
    return result.kind === "ANALYSED" ? result.candidates.filter((c) => c.kind === "GLUCOSE_READING").map((c) => (c.kind === "GLUCOSE_READING" ? c.valueText : "")) : [];
  };
  const none = (texts: ReadonlyArray<readonly [string, "en" | "zh"]>) => {
    for (const [text, language] of texts) expect(read(text, language), JSON.stringify(text)).toEqual([]);
  };
  const ZWSP = "​";

  it("D1: spaces, invisible characters, brackets and repeated hedges between the sign and the number give no value, EN and ZH", () => {
    none([
      [`sugar -${" ".repeat(24)}7`, "en"],
      [`sugar -${ZWSP.repeat(24)}7`, "en"],
      [`血糖-${" ".repeat(8)}7`, "zh"],
      [`血糖－${ZWSP.repeat(8)}7`, "zh"],
      ["血糖 -（ 差不多 ～ 7", "zh"],
      ["sugar - ( ( ( ( ( ( ( ( ( ( about 7", "en"],
      [`sugar -${ZWSP.repeat(18)} about 7`, "en"],
      ["sugar - approximately approximately 7", "en"],
      ["sugar - ( approximately ≈ ( about 7", "en"],
      ["血糖-大约大约大约大约7", "zh"],
      [`sugar -${" ".repeat(40)}6.8 mmol`, "en"],
      [`血糖-${" ".repeat(30)}七点八`, "zh"],
    ]);
  });

  it("m1: hedges, brackets and symbols are stripped repeatedly, not once", () => {
    none([["sugar -about about 7", "en"], ["sugar - ( ~ ( about 7", "en"], ["血糖-大约大约7", "zh"], ["血糖 - （ ～ （ 大约7", "zh"]]);
  });

  it("m2: format characters (\\\\p{Cf}) between the sign and the number are invisible: U+2066, U+061C, U+206A, U+2069", () => {
    for (const invisible of ["⁦", "؜", "⁪", "⁩"]) none([[`sugar -${invisible}5`, "en"], [`sugar - ${invisible} 6.8 mmol`, "en"], [`血糖-${invisible}5`, "zh"], [`血糖－${invisible}五`, "zh"]]);
  });

  it("unchanged by the wider look-back: plain readings, ranges and hedged readings", () => {
    expect(read("My sugar was 6.8 mmol", "en")).toEqual(["6.8"]);
    expect(read("sugar 7–8 mmol", "en")).toEqual(["7", "8"]);
    expect(read("sugar (7) - (8)", "en")).toEqual([]);
    expect(read("My sugar was about 7.8 mmol", "en")).toEqual(["7.8"]);
    expect(read("血糖大约七点八", "zh")).toEqual(["7.8"]);
  });
});

/** CR-11 round 8 (owner decisions 2026-10-11): plain "=" is rejected like "＝"; signed medicine amounts are never positive. */
describe("CR-11 round 8: \"=\" gives no value; a signed medicine amount is never a reported amount", () => {
  const MEDS: VoiceMedicineDirectory = { terms: [{ phrase: "dark pen", medication: REF_A }, { phrase: "黑色的笔", medication: REF_A }], names: [] };
  const run = (text: string, language: "en" | "zh") => {
    const result = analyseTranscript(text, language, { glucoseEntryUnit: "MMOL_PER_L", medicines: MEDS });
    expect(voiceAnalysisSchema.safeParse(result).success, text).toBe(true);
    return result.kind === "ANALYSED" ? result.candidates : [];
  };
  const glucose = (text: string, language: "en" | "zh") => run(text, language).filter((c) => c.kind === "GLUCOSE_READING");
  const medicine = (text: string, language: "en" | "zh") => run(text, language).filter((c) => c.kind === "MEDICATION_OCCURRENCE");

  it("\"=\" before the number gives no value for that reading, attached or spaced, EN and ZH", () => {
    for (const [text, language] of [["sugar = 7 mmol", "en"], ["sugar =7", "en"], ["sugar=7.8", "en"], ["My sugar was = 6.8", "en"], ["血糖=7.8", "zh"], ["血糖 = 7.8毫摩尔", "zh"], ["血糖=七点八", "zh"]] as const) {
      expect(glucose(text, language), text).toEqual([]);
      expect(run(text, language).some((c) => c.kind === "UNSUPPORTED_SPAN"), text).toBe(true);
    }
  });

  it("only that candidate is rejected: unrelated facts in the same sentence are kept", () => {
    const withMeal = run("sugar = 7 and I had toast for breakfast", "en");
    expect(withMeal.filter((c) => c.kind === "GLUCOSE_READING")).toEqual([]);
    expect(withMeal.filter((c) => c.kind === "MEAL_NOTE")).toMatchObject([{ slot: "BREAKFAST", itemText: "toast" }]);
    const withMedicine = run("I took the grey pen, sugar = 7", "en");
    expect(withMedicine.filter((c) => c.kind === "GLUCOSE_READING")).toEqual([]);
    expect(withMedicine.filter((c) => c.kind === "MEDICATION_OCCURRENCE")).toMatchObject([{ status: "TAKEN", medicineRef: { kind: "UNRESOLVED", phrase: "grey pen" }, reportedAmount: null }]);
  });

  it("unchanged: ranges with \"=\", the other hedges, and \"about 7.8\" (number plus confirmation, never edit-only)", () => {
    for (const [text, language] of [["sugar 7=8", "en"], ["血糖7=8", "zh"]] as const) expect(glucose(text, language).map((c) => (c.kind === "GLUCOSE_READING" ? c.valueText : "")), text).toEqual(["7", "8"]);
    for (const [text, language, value] of [["sugar ~7", "en", "7"], ["sugar ≈9.2", "en", "9.2"], ["sugar about 7.8", "en", "7.8"], ["血糖大约七点八", "zh", "7.8"], ["血糖七点八左右", "zh", "7.8"]] as const) {
      expect(glucose(text, language).map((c) => [c.kind === "GLUCOSE_READING" ? c.valueText : "", c.ambiguity]), text).toEqual([[value, ["UNIT_UNSTATED"]]]);
    }
  });

  it("a signed medicine amount (minus/dash signs, spaced, bracketed, invisible, hedged, sign words) is never a reported amount, EN and ZH", () => {
    for (const [text, language] of [
      ["I injected -2 units of my dark pen", "en"], ["I injected - 2 units of my dark pen", "en"], ["I injected − 10 units of my dark pen", "en"], ["I injected −10 units of my dark pen", "en"],
      ["I injected ‐2 units of my dark pen", "en"], ["I injected -\u200B2 units of my dark pen", "en"], ["I injected -( 2 units of my dark pen", "en"], ["I injected about -2 units of my dark pen", "en"],
      ["I injected minus 2 units of my dark pen", "en"], ["I injected negative 2 units of my dark pen", "en"], ["I took -2 units of insulin", "en"], ["I took -(2) units of insulin", "en"],
      ["我打了-2个单位的黑色的笔", "zh"], ["我打了－2个单位的黑色的笔", "zh"], ["我打了 - 2个单位的黑色的笔", "zh"], ["我打了负二个单位的黑色的笔", "zh"], ["我打了零下2个单位的黑色的笔", "zh"], ["我打了大约-2个单位的黑色的笔", "zh"], ["我打了-2个单位胰岛素", "zh"],
    ] as const) {
      const found = medicine(text, language);
      expect(found.length, text).toBe(1);
      const occurrence = found[0]!;
      if (occurrence.kind !== "MEDICATION_OCCURRENCE") throw new Error(text);
      expect(occurrence.reportedAmount, text).toBeNull();
      // The number said is an unreported number: the occurrence needs the person's edit (never one tap), as for any other number.
      expect(occurrence.ambiguity, text).toContain("UNCERTAINTY");
      expect(JSON.stringify(found), text).not.toMatch(/"valueText":"(?:2|10)"/);
    }
  });

  it("valid unsigned, range and hedged amounts and a sign elsewhere in the sentence are unchanged; glucose in the same sentence is kept", () => {
    const amount = (text: string, language: "en" | "zh") => medicine(text, language).map((c) => (c.kind === "MEDICATION_OCCURRENCE" ? c.reportedAmount : null));
    expect(amount("I injected 2 units of my dark pen", "en")).toEqual([{ valueText: "2", unitText: "units" }]);
    expect(amount("I injected 10 units of my dark pen", "en")).toEqual([{ valueText: "10", unitText: "units" }]);
    expect(amount("我打了两个单位的黑色的笔", "zh")).toEqual([{ valueText: "2", unitText: "个单位" }]);
    expect(amount("I injected 8–10 units of my dark pen", "en")).toEqual([{ valueText: "10", unitText: "units" }]);
    expect(amount("我吃了2–3片药", "zh")).toEqual([{ valueText: "3", unitText: "片" }]);
    expect(amount("I took 1-2 tablets of metformin", "en")).toEqual([{ valueText: "2", unitText: "tablets" }]);
    expect(amount("I injected about 2 units of my dark pen", "en")).toEqual([{ valueText: "2", unitText: "units" }]);
    expect(amount("sugar -2 and I injected 2 units of my dark pen", "en")).toEqual([{ valueText: "2", unitText: "units" }]);
    const mixed = run("sugar 6.8 mmol and I injected -2 units of my dark pen", "en");
    expect(mixed.filter((c) => c.kind === "GLUCOSE_READING").map((c) => (c.kind === "GLUCOSE_READING" ? c.valueText : ""))).toEqual(["6.8"]);
    expect(mixed.filter((c) => c.kind === "MEDICATION_OCCURRENCE").map((c) => (c.kind === "MEDICATION_OCCURRENCE" ? c.reportedAmount : "x"))).toEqual([null]);
    const mixedZh = run("血糖六点八毫摩尔，我打了-2个单位的黑色的笔", "zh");
    expect(mixedZh.filter((c) => c.kind === "GLUCOSE_READING").map((c) => (c.kind === "GLUCOSE_READING" ? c.valueText : ""))).toEqual(["6.8"]);
    expect(mixedZh.filter((c) => c.kind === "MEDICATION_OCCURRENCE").map((c) => (c.kind === "MEDICATION_OCCURRENCE" ? c.reportedAmount : "x"))).toEqual([null]);
  });
});


/** CR-11 round 9 (re-review of rounds 7–8): never a positive amount or value from a negative expression. */
describe("CR-11 round 9: medicine sign words, equals marks and signed range bounds; padding collapsed before the capped look-back", () => {
  const MEDS: VoiceMedicineDirectory = { terms: [], names: [] };
  const run = (text: string, language: "en" | "zh") => {
    const result = analyseTranscript(text, language, { glucoseEntryUnit: "MMOL_PER_L", medicines: MEDS });
    expect(voiceAnalysisSchema.safeParse(result).success, JSON.stringify(text)).toBe(true);
    return result.kind === "ANALYSED" ? result.candidates : [];
  };
  const amounts = (text: string, language: "en" | "zh") => run(text, language).filter((c) => c.kind === "MEDICATION_OCCURRENCE").map((c) => (c.kind === "MEDICATION_OCCURRENCE" ? c.reportedAmount : "x"));
  const noAmount = (texts: ReadonlyArray<readonly [string, "en" | "zh"]>) => {
    for (const [text, language] of texts) {
      expect(amounts(text, language), JSON.stringify(text)).toEqual([null]);
      expect(JSON.stringify(run(text, language)), JSON.stringify(text)).not.toMatch(/"reportedAmount":\{/);
    }
  };
  const glucose = (text: string, language: "en" | "zh") => run(text, language).filter((c) => c.kind === "GLUCOSE_READING").map((c) => (c.kind === "GLUCOSE_READING" ? c.valueText : ""));

  it("A1: sign words behind hedges, ~, brackets or invisible characters give no amount, EN and ZH", () => {
    noAmount([
      ["I took minus ~2 units of insulin", "en"], ["I injected negative ~ 2 units of insulin", "en"], ["I took minus (2 units) of insulin", "en"], ["I took minus​2 units of insulin", "en"],
      ["I took minus about 2 units of insulin", "en"], ["I injected negative around 2 units of insulin", "en"],
      ["我打了负～2个单位胰岛素", "zh"], ["我打了负～两个单位胰岛素", "zh"], ["我打了负（两个单位胰岛素", "zh"], ["我打了负​两个单位胰岛素", "zh"],
      ["我打了负大约两个单位胰岛素", "zh"], ["我打了负 大概 2个单位胰岛素", "zh"], ["我打了零下大约两个单位胰岛素", "zh"],
    ]);
  });

  it("A2: an equals mark between a sign and the amount does not hide the sign, EN and ZH", () => {
    noAmount([["I took -=2 units of insulin", "en"], ["I took - = 2 units of insulin", "en"], ["I took -＝2 units of insulin", "en"], ["I took -​=2 units of insulin", "en"], ["我打了-=2个单位胰岛素", "zh"], ["我打了负=2个单位胰岛素", "zh"]]);
  });

  it("A3: a range whose lower bound is signed is never the upper amount; unsigned ranges keep it", () => {
    noAmount([["I injected -2-3 units of insulin", "en"], ["I took -2 - 3 units of insulin", "en"], ["我吃了-2–3片药", "zh"], ["I took 2 - -3 units of insulin", "en"], ["I took 2--3 units of insulin", "en"], ["I took 2 – −3 units of insulin", "en"], ["I injected - 10 units of insulin", "en"]]);
    expect(amounts("I injected 8 - 10 units of insulin", "en")).toEqual([{ valueText: "10", unitText: "units" }]);
    expect(amounts("I injected 8–10 units of insulin", "en")).toEqual([{ valueText: "10", unitText: "units" }]);
    expect(amounts("我吃了2–3片药", "zh")).toEqual([{ valueText: "3", unitText: "片" }]);
  });

  it("D: padding of any length between the sign and the amount or reading never hides the sign (collapsed before the capped look-back)", () => {
    noAmount([
      [`I took -${" ".repeat(70)}2 units of insulin`, "en"], [`I took ${"- about ".repeat(12)}2 units of insulin`, "en"], [`I took -${"​".repeat(80)}2 units of insulin`, "en"],
      [`我打了-${" ".repeat(70)}2个单位胰岛素`, "zh"], [`我打了-${"大约".repeat(40)}2个单位胰岛素`, "zh"],
    ]);
    for (const [text, language] of [["sugar -(about) 7", "en"], ["sugar - (about) about 7", "en"], ["血糖-（大约）大约7", "zh"], [`sugar -${"​".repeat(70)}7`, "en"], [`血糖-${"​".repeat(70)}7`, "zh"]] as const) {
      expect(glucose(text, language), JSON.stringify(text)).toEqual([]);
    }
  });

  // Round 9 addendum (owner, final): "-, 2 units", "= 2 units" and "sugar -, 7" were pending here; they are now decided (no amount, no
  // value) and covered by the addendum tests below.
  it("kept: unsigned and hedged amounts and ranges", () => {
    expect(amounts("I took 2 units of insulin", "en")).toEqual([{ valueText: "2", unitText: "units" }]);
    expect(amounts("I took about 2 units of insulin", "en")).toEqual([{ valueText: "2", unitText: "units" }]);
    expect(amounts("我打了两个单位胰岛素", "zh")).toEqual([{ valueText: "2", unitText: "个单位" }]);
    expect(glucose("sugar = 7", "en")).toEqual([]);
    expect(glucose("sugar 7=8", "en")).toEqual(["7", "8"]);
    expect(glucose("sugar about 7.8", "en")).toEqual(["7.8"]);
    expect(glucose("sugar (7)-(8)", "en")).toEqual([]);
  });
});

/** CR-11 round 9 addendum (owner decisions 2026-10-11, final). */
describe("CR-11 round 9 addendum: punctuation or fillers after a sign; equals marks before a medicine amount", () => {
  const run = (text: string, language: "en" | "zh") => {
    const result = analyseTranscript(text, language, { glucoseEntryUnit: "MMOL_PER_L" });
    expect(voiceAnalysisSchema.safeParse(result).success, JSON.stringify(text)).toBe(true);
    return result.kind === "ANALYSED" ? result.candidates : [];
  };
  const glucose = (text: string, language: "en" | "zh") => run(text, language).filter((c) => c.kind === "GLUCOSE_READING").map((c) => (c.kind === "GLUCOSE_READING" ? c.valueText : ""));
  const amounts = (text: string, language: "en" | "zh") => run(text, language).filter((c) => c.kind === "MEDICATION_OCCURRENCE").map((c) => (c.kind === "MEDICATION_OCCURRENCE" ? c.reportedAmount : "x"));

  it("punctuation after a sign: no glucose value, no medicine amount, EN and ZH", () => {
    for (const [text, language] of [["sugar -, 7", "en"], ["sugar - . 7", "en"], ["sugar -… 7", "en"], ["sugar -: 7", "en"], ["sugar -; 7 mmol", "en"], ["sugar −, 6.8 mmol", "en"], ["血糖-，7", "zh"], ["血糖-：7", "zh"], ["血糖-、7", "zh"], ["血糖-。7", "zh"]] as const) {
      expect(glucose(text, language), text).toEqual([]);
    }
    for (const [text, language] of [["I took -, 2 units of insulin", "en"], ["I took -; 2 units of insulin", "en"], ["I took -. 2 units of insulin", "en"], ["I took -: 2 units of insulin", "en"], ["I took negative, 2 units of insulin", "en"], ["我打了-，2个单位胰岛素", "zh"], ["我打了负，两个单位胰岛素", "zh"], ["我打了-；2个单位胰岛素", "zh"]] as const) {
      expect(amounts(text, language), text).toEqual([null]);
    }
  });

  it("filler words after a sign (EN um, uh, er, erm, ah, like, well, maybe; ZH 嗯, 呃, 啊, 那个, 就是): no value, no amount", () => {
    for (const filler of ["um", "uh", "er", "erm", "ah", "like", "well", "maybe"]) {
      expect(glucose(`sugar - ${filler} 7`, "en"), filler).toEqual([]);
      expect(amounts(`I took - ${filler} 2 units of insulin`, "en"), filler).toEqual([null]);
    }
    for (const filler of ["嗯", "呃", "啊", "那个", "就是"]) {
      expect(glucose(`血糖-${filler}7`, "zh"), filler).toEqual([]);
      expect(amounts(`我打了-${filler}2个单位胰岛素`, "zh"), filler).toEqual([null]);
    }
  });

  it("an equals mark directly before a medicine amount: no amount (the existing edit path); ≈ and ~ amounts are unchanged", () => {
    for (const [text, language] of [["I took = 2 units of insulin", "en"], ["I took ＝2 units of insulin", "en"], ["I took =2 units of insulin", "en"], ["我打了=2个单位胰岛素", "zh"], ["我打了＝两个单位胰岛素", "zh"], ["I took ≒2 units of insulin", "en"]] as const) {
      expect(amounts(text, language), text).toEqual([null]);
      const occurrence = run(text, language).find((c) => c.kind === "MEDICATION_OCCURRENCE");
      expect(occurrence?.ambiguity, text).toContain("UNCERTAINTY");
    }
    expect(amounts("I took ≈2 units of insulin", "en")).toEqual([{ valueText: "2", unitText: "units" }]);
    expect(amounts("I took ~2 units of insulin", "en")).toEqual([{ valueText: "2", unitText: "units" }]);
  });

  it("kept: a dash after the number, ranges (also '7, -8' stays signed), 'I took, -2 units', punctuation not right after a sign, unsigned values", () => {
    expect(glucose("sugar was 6.8 - before breakfast", "en")).toEqual(["6.8"]);
    expect(glucose("sugar was 6.8, - I felt fine", "en")).toEqual(["6.8"]);
    expect(glucose("sugar 7–8 mmol", "en")).toEqual(["7", "8"]);
    expect(glucose("sugar (7)-(8)", "en")).toEqual([]);
    expect(glucose("sugar 7, -8", "en")).toEqual(["7"]);
    expect(glucose("sugar 7 about -8", "en")).toEqual(["7"]);
    expect(glucose("sugar like 7", "en")).toEqual(["7"]);
    expect(glucose("sugar maybe 7", "en")).toEqual(["7"]);
    expect(glucose("sugar 6.8 mmol", "en")).toEqual(["6.8"]);
    expect(amounts("I took, -2 units of insulin", "en")).toEqual([null]);
    expect(amounts("I injected 8–10 units of insulin", "en")).toEqual([{ valueText: "10", unitText: "units" }]);
    expect(amounts("I took 2 units of insulin", "en")).toEqual([{ valueText: "2", unitText: "units" }]);
    expect(amounts("我打了两个单位胰岛素", "zh")).toEqual([{ valueText: "2", unitText: "个单位" }]);
  });
});


/** CR-11 round 10 (F1): an opening bracket or quote before a sign never turns it into a range. */
describe("CR-11 round 10: an opener between a number and a sign keeps the sign", () => {
  const run = (text: string, language: "en" | "zh") => {
    const result = analyseTranscript(text, language, { glucoseEntryUnit: "MMOL_PER_L" });
    expect(voiceAnalysisSchema.safeParse(result).success, JSON.stringify(text)).toBe(true);
    return result.kind === "ANALYSED" ? result.candidates : [];
  };
  const glucose = (text: string, language: "en" | "zh") => run(text, language).filter((c) => c.kind === "GLUCOSE_READING").map((c) => (c.kind === "GLUCOSE_READING" ? c.valueText : ""));

  it("glucose: only the first number, never the signed one, EN and ZH", () => {
    expect(glucose("sugar 7 (-8)", "en")).toEqual(["7"]);
    expect(glucose("sugar 7 [-8]", "en")).toEqual(["7"]);
    expect(glucose("血糖7（-8）", "zh")).toEqual(["7"]);
    expect(glucose("血糖7「-8」", "zh")).toEqual(["7"]);
  });

  it("medicine: an opener before the sign gives no amount, EN and ZH", () => {
    for (const [text, language] of [["I took 8 (- 10 units of insulin", "en"], ["我打了2（-3个单位胰岛素", "zh"]] as const) {
      expect(run(text, language).filter((c) => c.kind === "MEDICATION_OCCURRENCE").map((c) => (c.kind === "MEDICATION_OCCURRENCE" ? c.reportedAmount : "x")), text).toEqual([null]);
    }
  });
});
