import { describe, expect, it } from "vitest";
import { reviewVoiceCandidates } from "@/application/voice/voice-review-contract";
import { analyseTranscript, type VoiceMedicineDirectory } from "./voice-candidate-extractor";
import { voiceAnalysisSchema, voiceCandidateSchema, type VoiceAnalysis } from "./voice-contracts";
import { VOICE_MEDICINE_INFO_CUES_VERSION, matchVoiceMedicineInfoRequest } from "./voice-medicine-info-cues";
import { gateRemoteTranscriptExtraction } from "./voice-remote-extraction-gate";

/**
 * HSA preview (owner decision 2026-10-14, "Tell me about my medicine"; voice-contract.13s.7, voice-medicine-info-cues.1): the
 * deterministic MEDICINE_INFO_REQUEST. Synthetic transcripts only.
 */

const ON = { medicineInformationRequests: true } as const;
const MED = { recordType: "MEDICATION", recordId: "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f", revisionId: "7a1c2d3e-4a5b-4c6d-9e7f-0a1b2c3d4e5f" } as const;
const DIRECTORY: VoiceMedicineDirectory = { terms: [{ phrase: "white pill", medication: MED }], names: [{ name: "Glucotab", medication: MED }] };
const request = (analysis: VoiceAnalysis) => analysis.candidates.filter((candidate) => candidate.kind === "MEDICINE_INFO_REQUEST");

describe("voice-medicine-info-cues.1", () => {
  it("is versioned", () => {
    expect(VOICE_MEDICINE_INFO_CUES_VERSION).toBe("voice-medicine-info-cues.1");
  });

  it.each<[string, string]>([
    ["Tell me about my Metformin", "Metformin"],
    ["Tell me about my Metformin.", "Metformin"],
    ["What is metformin?", "metformin"],
    ["Tell me about Lantus", "Lantus"],
    ["What's metformin for?", "metformin"],
    ["What’s Lantus used for", "Lantus"],
    ["What is metformin used for?", "metformin"],
    ["Can you tell me about my Apidra please", "Apidra"],
    ["Information about insulin glargine", "insulin glargine"],
    ["I'd like some info on my Januvia", "Januvia"],
  ])("recognises %j → %j", (sentence, name) => {
    expect(matchVoiceMedicineInfoRequest(sentence, [])).toBe(name);
  });

  it.each(["Tell me about my day", "What is my sugar", "Tell me about my insulin", "What is chicken rice", "Tell me about Panadolx", "I took metformin", "Tell me about metformin and my sugar"])("does not recognise %j", (sentence) => {
    expect(matchVoiceMedicineInfoRequest(sentence, [])).toBeNull();
  });

  it("recognises her own medicine names and remembered terms exactly", () => {
    expect(matchVoiceMedicineInfoRequest("Tell me about my Glucotab", ["Glucotab"])).toBe("Glucotab");
    expect(matchVoiceMedicineInfoRequest("Tell me about my Glucotab", [])).toBeNull();
  });
});

describe("analyseTranscript with medicine-information requests (13s.7)", () => {
  it.each([
    ["Tell me about my Metformin", "Metformin"],
    ["What is metformin?", "metformin"],
    ["Tell me about Lantus", "Lantus"],
  ])("%j → one MEDICINE_INFO_REQUEST, nothing else", (text, name) => {
    const analysis = analyseTranscript(text, "en", ON);
    expect(voiceAnalysisSchema.safeParse(analysis).success).toBe(true);
    expect(analysis).toMatchObject({ kind: "ANALYSED", redirect: null, extractorVersion: "voice-extractor.13s.7" });
    expect(analysis.candidates).toEqual([{ kind: "MEDICINE_INFO_REQUEST", span: { start: 0, end: [...text.replace(/[?]$/, "")].length }, sourcePhrase: text.replace(/[?]$/, ""), source: "DETERMINISTIC", producerVersion: "voice-vocabulary.13s.4", name }]);
  });

  it("without the option (HSA-bounded mode on) nothing changes: the sentence stays not understood", () => {
    for (const text of ["Tell me about my Metformin", "What is metformin?", "Tell me about Lantus"]) {
      const analysis = analyseTranscript(text, "en");
      expect(analysis.candidates.map((candidate) => candidate.kind), text).toEqual(["UNSUPPORTED_SPAN"]);
      expect(analyseTranscript(text, "en", { medicineInformationRequests: false })).toEqual(analysis);
    }
  });

  it("the dose/treatment redirect still wins: 'How much metformin should I take' stays a redirect", () => {
    expect(analyseTranscript("How much metformin should I take?", "en", ON)).toMatchObject({ kind: "REDIRECT", category: "DOSE_TREATMENT", candidates: [] });
    // A request beside a dose question: the redirect, never the card.
    const mixed = analyseTranscript("Tell me about my Metformin. Should I take more metformin?", "en", ON);
    expect(mixed.kind === "REDIRECT" || (mixed.kind === "ANALYSED" && mixed.redirect !== null)).toBe(true);
    expect(request(mixed)).toEqual([]);
  });

  it("the distress gate still runs first", () => {
    expect(analyseTranscript("Tell me about my Metformin. I want to die.", "en", ON)).toMatchObject({ kind: "DISTRESS", candidates: [] });
  });

  it("keeps the other facts and the C1 backstop: a reading beside a request is never one tap", () => {
    const analysis = analyseTranscript("My sugar was 6.8. Tell me about my Metformin.", "en", { ...ON, glucoseEntryUnit: "MMOL_PER_L" });
    expect(analysis.candidates.map((candidate) => candidate.kind)).toEqual(["GLUCOSE_READING", "MEDICINE_INFO_REQUEST"]);
    const reading = analysis.candidates[0]!;
    expect(reading).toMatchObject({ kind: "GLUCOSE_READING", valueText: "6.8", unitSource: null, ambiguity: ["UNIT_UNSTATED", "UNCERTAINTY"] });
    // Exactly as before the option, when the request was not understood.
    expect(analyseTranscript("My sugar was 6.8. Tell me about my Metformin.", "en", { glucoseEntryUnit: "MMOL_PER_L" }).candidates[0]).toEqual(reading);
  });

  it("uses her directory names, and is English only", () => {
    expect(request(analyseTranscript("Tell me about my Glucotab", "en", { ...ON, medicines: DIRECTORY }))).toHaveLength(1);
    expect(request(analyseTranscript("Tell me about my Glucotab", "en", ON))).toHaveLength(0);
    expect(request(analyseTranscript("告诉我关于二甲双胍", "zh", ON))).toHaveLength(0);
  });
});

describe("a request is never a fact and never leaves the device", () => {
  const analysis = analyseTranscript("Tell me about my Metformin", "en", ON);
  const session = { sessionToken: 1, state: "COMPLETED" as const };

  it("the review contract refuses to save it (NOT_A_FACT)", () => {
    expect(reviewVoiceCandidates({ analysis, reviewedSessionToken: 1, currentSession: session, knownMedications: [MED], decisions: [{ candidateIndex: 0, action: "SAVE" }] })).toEqual({
      kind: "NO_INTENT",
      reason: "NO_CONFIRMATION",
      rejected: [{ candidateIndex: 0, reason: "NOT_A_FACT" }],
    });
  });

  it("a remote candidate of this kind is invalid (deterministic only)", () => {
    const local = analysis as Extract<VoiceAnalysis, { kind: "ANALYSED" }>;
    expect(voiceCandidateSchema.safeParse({ ...local.candidates[0]!, source: "REMOTE_EXTRACTION", producerVersion: "transcript-extraction.1" }).success).toBe(false);
  });

  it("question forms are withheld by the remote gate as before", () => {
    expect(gateRemoteTranscriptExtraction("What is metformin?", "en")).toEqual({ kind: "WITHHOLD", reason: "REDIRECT_CONTENT" });
  });
});
