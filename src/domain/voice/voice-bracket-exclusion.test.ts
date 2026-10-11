// @vitest-environment node
import { describe, expect, it } from "vitest";
import { analyseTranscript } from "./voice-candidate-extractor";
import { candidateMatchesTranscript, voiceAnalysisSchema } from "./voice-contracts";

describe("owner bracket exclusion: only plain glucose numbers are captured", () => {
  const readings = (text: string, language: "en" | "zh") => {
    const result = analyseTranscript(text, language, { glucoseEntryUnit: "MMOL_PER_L" });
    expect(voiceAnalysisSchema.safeParse(result).success).toBe(true);
    if (result.kind !== "ANALYSED") throw new Error(`unexpected ${result.kind}`);
    for (const candidate of result.candidates) expect(candidateMatchesTranscript(candidate, text)).toBe(true);
    return result.candidates.filter((candidate) => candidate.kind === "GLUCOSE_READING");
  };

  it.each([
    ["sugar 7 (-8)", "en"], ["sugar 7 (8)", "en"],
    ["sugar 7 [8]", "en"], ["sugar 7 {8}", "en"],
    ["sugar 7 ((8))", "en"], ["sugar 7 (eight)", "en"],
    ["血糖7（-8）", "zh"], ["血糖7（8）", "zh"],
    ["血糖7【八】", "zh"], ["血糖7「8」", "zh"],
  ] as const)("keeps only the unbracketed 7 in %s", (text, language) => {
    const captured = readings(text, language);
    expect(captured.map((reading) => reading.valueText)).toEqual(["7"]);
    expect(captured[0]!.ambiguity).not.toContain("MULTIPLE_NUMBERS");
  });

  it.each([
    ["sugar (7)", "en"], ["sugar [7.8] mmol", "en"],
    ["sugar (seven)", "en"], ["sugar (7.8", "en"],
    ["血糖（7）", "zh"], ["血糖【七点八】", "zh"],
  ] as const)("does not extract a bracketed number in %s", (text, language) => {
    expect(readings(text, language)).toEqual([]);
  });

  it("keeps plain readings, original spans, precision and signed-number refusals", () => {
    expect(readings("sugar 7", "en").map((reading) => reading.valueText)).toEqual(["7"]);
    expect(readings("sugar 7.8 mmol", "en").map((reading) => reading.valueText)).toEqual(["7.8"]);
    expect(readings("sugar -7", "en")).toEqual([]);
    expect(readings("sugar -(7)", "en")).toEqual([]);
    expect(readings("sugar 9.25", "en")).toEqual([]);
  });

  it.each([
    ["sugar (7) -8", "en"], ["sugar (7) - 8 mmol", "en"],
    ["sugar (seven) -eight mmol", "en"], ["sugar (7) +8 mmol", "en"],
    ["sugar (7) =8 mmol", "en"], ["血糖（7）-8", "zh"],
    ["血糖（七）-八毫摩尔", "zh"],
  ] as const)("an ignored bracketed number never authorizes a signed value in %s", (text, language) => {
    expect(readings(text, language)).toEqual([]);
  });

  it("a glucose cue inside brackets cannot establish an outside reading", () => {
    expect(readings("(sugar 7) 8", "en")).toEqual([]);
    expect(readings("（血糖7）8", "zh")).toEqual([]);
  });
});
