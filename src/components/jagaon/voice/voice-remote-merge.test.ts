// @vitest-environment node
import { describe, expect, it } from "vitest";
import { analyseTranscript, type VoiceMedicineDirectory } from "@/domain/voice/voice-candidate-extractor";
import { codePointLength, type VoiceAnalysis } from "@/domain/voice/voice-contracts";
import { mergeRemoteCandidates } from "./voice-remote-merge";

const DARK = { recordType: "MEDICATION", recordId: "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f", revisionId: "7a1c2d3e-4a5b-4c6d-9e7f-0a1b2c3d4e5f" } as const;
const DIRECTORY: VoiceMedicineDirectory = { terms: [{ phrase: "dark pen", medication: DARK }], names: [] };
const REMOTE = { source: "REMOTE_EXTRACTION", producerVersion: "transcript-extraction.13r.1" } as const;

function local(text: string, language: "en" | "zh" = "en"): Extract<VoiceAnalysis, { kind: "ANALYSED" }> {
  const result = analyseTranscript(text, language, { medicines: DIRECTORY, glucoseEntryUnit: "MMOL_PER_L" });
  if (result.kind !== "ANALYSED") throw new Error(result.kind);
  return result;
}
/** The code-point span of `phrase` inside `text`. */
function at(text: string, phrase: string) {
  const index = text.indexOf(phrase);
  const start = codePointLength(text.slice(0, index));
  return { span: { start, end: start + codePointLength(phrase) }, sourcePhrase: phrase };
}
const merge = (text: string, remote: unknown[], language: "en" | "zh" = "en") => mergeRemoteCandidates({ local: local(text, language), remote, transcript: text, language, directory: DIRECTORY });

describe("remote extraction merge (local analysis is the floor)", () => {
  it("adds a remote fact over text the local extractor did not understand", () => {
    const text = "My sugar was 6.8 mmol, had laksa";
    expect(local(text).candidates.map((candidate) => candidate.kind)).toEqual(["GLUCOSE_READING", "UNSUPPORTED_SPAN"]);
    const merged = merge(text, [{ kind: "MEAL_NOTE", ...REMOTE, ...at(text, "had laksa"), slot: "UNSTATED", itemText: "laksa", state: "UNDERSTOOD", ambiguity: [] }]);
    expect(merged.kind).toBe("MERGED");
    if (merged.kind === "MERGED") expect(merged.analysis.candidates.map((candidate) => [candidate.kind, candidate.source])).toEqual([["GLUCOSE_READING", "DETERMINISTIC"], ["MEAL_NOTE", "REMOTE_EXTRACTION"]]);
  });

  it("never weakens a local fact: an overlapping remote reading without the local negation leaves the local one (still negated)", () => {
    const text = "My sugar was not 6.8 mmol";
    const merged = merge(text, [{ kind: "GLUCOSE_READING", ...REMOTE, ...at(text, "sugar was not 6.8 mmol"), valueText: "6.8", unit: "MMOL_PER_L", unitSource: "SPOKEN", state: "UNDERSTOOD", ambiguity: [] }]);
    expect(merged.kind).toBe("MERGED");
    if (merged.kind === "MERGED") expect(merged.analysis.candidates).toEqual(local(text).candidates);
  });

  it("takes the stricter set: a remote uncertainty on an overlapping reading is added; an app default then returns to unstated", () => {
    const text = "blood sugar 9.2";
    expect(local(text).candidates[0]).toMatchObject({ unitSource: "APP_DEFAULT", state: "UNDERSTOOD" });
    const merged = merge(text, [{ kind: "GLUCOSE_READING", ...REMOTE, ...at(text, "blood sugar 9.2"), valueText: "9.2", unit: "UNSTATED", unitSource: null, state: "AMBIGUOUS", ambiguity: ["UNIT_UNSTATED", "UNCERTAINTY"] }]);
    expect(merged).toMatchObject({ kind: "MERGED", analysis: { candidates: [{ source: "DETERMINISTIC", unit: "UNSTATED", unitSource: null, state: "AMBIGUOUS", ambiguity: ["UNIT_UNSTATED", "UNCERTAINTY"] }] } });
  });

  it("re-resolves remote medicines locally: a remote MAPPED claim is never trusted", () => {
    const text = "Sugar 6.8 mmol, I did my Lantus";
    expect(local(text).candidates.map((candidate) => candidate.kind)).toEqual(["GLUCOSE_READING", "UNSUPPORTED_SPAN"]);
    const remote = { kind: "MEDICATION_OCCURRENCE", ...REMOTE, ...at(text, "I did my Lantus"), status: "TAKEN", medicineRef: { kind: "MAPPED", phrase: "Lantus", medication: { ...DARK, recordId: "1b2c3d4e-5f60-4a1b-8c2d-3e4f5a6b7c8d" }, via: "EXACT_NAME" }, reportedAmount: null, state: "UNDERSTOOD", ambiguity: [] };
    const remembered = mergeRemoteCandidates({ local: local(text), remote: [remote], transcript: text, language: "en", directory: { terms: [{ phrase: "lantus", medication: DARK }], names: [] } });
    expect(remembered).toMatchObject({ kind: "MERGED", analysis: { candidates: [{ kind: "GLUCOSE_READING" }, { kind: "MEDICATION_OCCURRENCE", medicineRef: { kind: "MAPPED", medication: DARK, via: "TERMINOLOGY" }, state: "UNDERSTOOD" }] } });
    const unknown = mergeRemoteCandidates({ local: local(text), remote: [remote], transcript: text, language: "en", directory: { terms: [], names: [] } });
    expect(unknown).toMatchObject({ kind: "MERGED", analysis: { candidates: [{ kind: "GLUCOSE_READING" }, { kind: "MEDICATION_OCCURRENCE", medicineRef: { kind: "UNRESOLVED", phrase: "Lantus" }, state: "AMBIGUOUS", ambiguity: ["MEDICINE_UNRESOLVED"] }] } });
  });

  it("carries transcript-wide local flags (another person, correction) onto added remote facts", () => {
    const text = "my wife's sugar was 9.1 mmol, had laksa";
    const merged = merge(text, [{ kind: "MEAL_NOTE", ...REMOTE, ...at(text, "had laksa"), slot: "UNSTATED", itemText: "laksa", state: "UNDERSTOOD", ambiguity: [] }]);
    if (merged.kind !== "MERGED") throw new Error("expected a merge");
    expect(merged.analysis.candidates.find((candidate) => candidate.kind === "MEAL_NOTE")).toMatchObject({ state: "AMBIGUOUS", ambiguity: ["OTHER_PERSON"] });
  });

  it("a remote unit is SPOKEN only when an mmol unit is in its own phrase", () => {
    for (const [text, phrase, expected] of [
      ["My meter showed 7.1", "My meter showed 7.1", { unit: "UNSTATED", unitSource: null, state: "AMBIGUOUS", ambiguity: ["UNIT_UNSTATED"] }],
      ["My meter showed 7.1 mmol", "My meter showed 7.1 mmol", { unit: "MMOL_PER_L", unitSource: "SPOKEN", state: "UNDERSTOOD", ambiguity: [] }],
    ] as const) {
      expect(local(text).candidates.map((candidate) => candidate.kind), text).toEqual(["UNSUPPORTED_SPAN"]);
      const merged = merge(text, [{ kind: "GLUCOSE_READING", ...REMOTE, ...at(text, phrase), valueText: "7.1", unit: "MMOL_PER_L", unitSource: "SPOKEN", state: "UNDERSTOOD", ambiguity: [] }]);
      expect(merged, text).toMatchObject({ kind: "MERGED", analysis: { candidates: [{ kind: "GLUCOSE_READING", source: "REMOTE_EXTRACTION", ...expected }] } });
    }
  });

  it("falls back to local on anything invalid: wrong source, span mismatch, extra fields, non-arrays", () => {
    const text = "My sugar was 6.8 mmol, had laksa";
    const good = { kind: "MEAL_NOTE", ...REMOTE, ...at(text, "had laksa"), slot: "UNSTATED", itemText: "laksa", state: "UNDERSTOOD", ambiguity: [] };
    for (const bad of [{ ...good, source: "DETERMINISTIC", producerVersion: "voice-vocabulary.13s.3" }, { ...good, span: { start: 0, end: 9 } }, { ...good, advice: "eat less" }, { kind: "DOSE", amount: 10 }]) {
      expect(merge(text, [good, bad]), JSON.stringify(bad).slice(0, 60)).toEqual({ kind: "LOCAL_KEPT" });
    }
  });

  it("terminology review #2: a remote medicine phrase outside its own span is dropped; the text stays not understood", () => {
    const text = "Sugar 6.8 mmol, I did my Lantus";
    const outside = { kind: "MEDICATION_OCCURRENCE", ...REMOTE, ...at(text, "I did my Lantus"), status: "TAKEN", medicineRef: { kind: "UNRESOLVED", phrase: "10 units at night" }, reportedAmount: null, state: "AMBIGUOUS", ambiguity: ["MEDICINE_UNRESOLVED"] };
    const merged = merge(text, [outside]);
    expect(merged.kind).toBe("MERGED");
    if (merged.kind === "MERGED") expect(merged.analysis.candidates.map((candidate) => candidate.kind)).toEqual(["GLUCOSE_READING", "UNSUPPORTED_SPAN"]);
    const inside = merge(text, [{ ...outside, medicineRef: { kind: "UNRESOLVED", phrase: "Lantus" } }]);
    if (inside.kind !== "MERGED") throw new Error("expected a merge");
    expect(inside.analysis.candidates.map((candidate) => candidate.kind)).toEqual(["GLUCOSE_READING", "MEDICATION_OCCURRENCE"]);
  });
});
