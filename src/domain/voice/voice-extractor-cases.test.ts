// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyseTranscript, type VoiceMedicineDirectory } from "./voice-candidate-extractor";
import { candidateMatchesTranscript, voiceAnalysisSchema, type VoiceAnalysis } from "./voice-contracts";
import { gateRemoteTranscriptExtraction } from "./voice-remote-extraction-gate";
import { voiceVocabulary } from "./voice-vocabulary";

/**
 * Every probe case of the independent S1–S7 review (scratchpad p13review cases1–4: C1, C2, I1, I2, I3), the 13s.3 re-review
 * adversarial cases (adv, adv2, adv3: Cr1–Cr4, I1–I3, M2–M5), the owner's #2–#4 distinctions, the third re-review's round-4 cases
 * (r3, r3b, r3c, r3d: C1, I1–I5 and the minors, plus their EN/ZH counterparts), the brief's E1–E5/Z1–Z5 and the multi-fact demo
 * utterances, and the recheck-6 cases (counterfactuals with the straight and curly apostrophe, 本来会/本该/要是…就, 想问/请问/问一下,
 * Singlish anot / can or not, code-switched 要不要打/打多少, spoken counts), pinned EXACTLY in EN and ZH.
 *
 * Each entry is [transcript, language, summary with no unit default, summary with the app default MMOL_PER_L, remote gate]. Summary
 * notation: G(value unit[:unitSource] reasons) glucose, M(slot items reasons) meal, D(status ref:phrase reasons[ amt=value unit])
 * medicine occurrence, U("…") not understood, REDIRECT:DOSE|HEALTH (whole transcript), R:DOSE+|R:HEALTH+ (redirect notice with the
 * separable facts kept reviewable). The gate is PERMIT or WITHHOLD:<reason>.
 *
 * The directory remembers "dark pen" / "黑色的笔" (terms) and "metformin" / "二甲双胍" (names) to pin reuse; "grey pen" / "灰色的笔"
 * are not remembered, to pin the clarification path.
 */
type Case = [text: string, language: "en" | "zh", noDefault: string, withDefault: string, gate: string];
const CASES = JSON.parse(readFileSync(join(process.cwd(), "src/domain/voice/voice-extractor-cases.fixture.json"), "utf8")) as Case[];
const DARK_PEN = { recordType: "MEDICATION", recordId: "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f", revisionId: "7a1c2d3e-4a5b-4c6d-9e7f-0a1b2c3d4e5f" } as const;
const METFORMIN = { recordType: "MEDICATION", recordId: "1b2c3d4e-5f60-4a1b-8c2d-3e4f5a6b7c8d", revisionId: "2b2c3d4e-5f60-4a1b-9c2d-3e4f5a6b7c8d" } as const;
const DIRECTORY: VoiceMedicineDirectory = {
  terms: [
    { phrase: "dark pen", medication: DARK_PEN },
    { phrase: "黑色的笔", medication: DARK_PEN },
  ],
  names: [
    { name: "metformin", medication: METFORMIN },
    { name: "二甲双胍", medication: METFORMIN },
  ],
};

const SHORT_CATEGORY = { DOSE_TREATMENT: "DOSE", HEALTH_QUESTION: "HEALTH" } as const;

export function summarise(result: VoiceAnalysis): string {
  if (result.kind === "REDIRECT") return `REDIRECT:${SHORT_CATEGORY[result.category]}`;
  if (result.kind !== "ANALYSED") return result.kind;
  return (result.redirect ? `R:${SHORT_CATEGORY[result.redirect.category]}+ ` : "") + result.candidates
    .map((c) => {
      if (c.kind === "GLUCOSE_READING") return `G(${c.valueText} ${c.unit}${c.unitSource ? `:${c.unitSource}` : ""} ${c.ambiguity.join("+") || "OK"})`;
      if (c.kind === "MEAL_NOTE") return `M(${c.slot} ${JSON.stringify(c.itemText)} ${c.ambiguity.join("+") || "OK"})`;
      if (c.kind === "MEDICATION_OCCURRENCE") return `D(${c.status} ${c.medicineRef.kind}:${c.medicineRef.phrase} ${c.ambiguity.join("+") || "OK"}${c.reportedAmount ? ` amt=${c.reportedAmount.valueText} ${c.reportedAmount.unitText}` : ""})`;
      return `U(${JSON.stringify(c.sourcePhrase)})`;
    })
    .join(" ");
}

describe("pinned extraction cases (review probes, adversarial re-review, owner decisions, brief scripts, demo)", () => {
  it("has exactly 645 unique cases", () => {
    expect(CASES).toHaveLength(645);
    expect(new Set(CASES.map(([text, language]) => `${language}|${text}`)).size).toBe(645);
  });
  for (const [text, language, noDefault, withDefault, gate] of CASES) {
    it(`${language} ${JSON.stringify(text)}`, () => {
      const plain = analyseTranscript(text, language, { medicines: DIRECTORY });
      const defaulted = analyseTranscript(text, language, { medicines: DIRECTORY, glucoseEntryUnit: "MMOL_PER_L" });
      for (const result of [plain, defaulted]) {
        expect(voiceAnalysisSchema.safeParse(result).success).toBe(true);
        for (const candidate of result.candidates) expect(candidateMatchesTranscript(candidate, text), candidate.sourcePhrase).toBe(true);
        // C2: a glucose fact always carries its own cue; never a unit or a number alone.
        const cue = new RegExp(voiceVocabulary(language).glucoseCues.join("|"), "i");
        for (const candidate of result.candidates.filter((c) => c.kind === "GLUCOSE_READING")) expect(candidate.sourcePhrase).toMatch(cue);
      }
      expect(summarise(plain)).toBe(noDefault);
      expect(summarise(defaulted)).toBe(withDefault);
      const decision = gateRemoteTranscriptExtraction(text, language);
      expect(decision.kind === "PERMIT" ? "PERMIT" : `WITHHOLD:${decision.reason}`).toBe(gate);
    });
  }
});
