// @vitest-environment node
import { describe, expect, it } from "vitest";
import { analyseTranscript } from "@/domain/voice/voice-candidate-extractor";
import { gateRemoteTranscriptExtraction } from "@/domain/voice/voice-remote-extraction-gate";
import { TRANSCRIPT_EXTRACTION_CONTRACT_VERSION, type ExtractionOutput, type ExtractionRequest } from "@/domain/transcript-extraction/transcript-extraction-contract";
import { validateExtraction } from "@/domain/transcript-extraction/transcript-extraction-validator";
import { mergeRemoteCandidates } from "@/components/jagaon/voice/voice-remote-merge";
import { createTranscriptExtractionClient } from "./transcript-extraction-client";
import { mapToVoiceCandidates } from "./transcript-extraction-mapper";
import { transcriptRedirect } from "./transcript-extraction-redirect";

/**
 * Packet 13 (P13X): the independent review's fixes, pinned. CRITICAL 1 (a negated utterance never comes back TAKEN, also end to end
 * through the voice merge), CRITICAL 2 (the EN and ZH gate and redirect apply together, whatever the locale), IMPORTANT 2 (the client
 * refuses redirects and caps the response read) and the canonical value. Fake fetchers only; synthetic text only.
 */
const usage = { inputTokens: 1, outputTokens: 1, costMicroUsd: 3, basis: "REPORTED" };
const DARK_PEN = { recordType: "MEDICATION", recordId: "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f", revisionId: "7a1c2d3e-4a5b-4c6d-9e7f-0a1b2c3d4e5f" } as const;
const DIRECTORY = { terms: [{ phrase: "dark pen", medication: DARK_PEN }, { phrase: "黑色的笔", medication: DARK_PEN }], names: [] };
const span = (transcript: string, text: string) => {
  const start = [...transcript.slice(0, transcript.indexOf(text))].length;
  return { start, end: start + [...text].length, text };
};
function client(answer: unknown, sink: { init?: RequestInit; calls: number } = { calls: 0 }, raw?: string) {
  return createTranscriptExtractionClient({
    disclosure: { decide: async () => "ACCEPTED" },
    passcode: () => "synthetic-pass-01",
    fetcher: async (_url, init) => {
      sink.calls += 1;
      sink.init = init;
      return new Response(raw ?? JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
}
const extract = (c: ReturnType<typeof client>, transcript: string, locale: "en-SG" | "zh-SG" = "en-SG") =>
  c.extract({ transcript, locale, allowedFactKinds: ["GLUCOSE_READING", "MEAL_OR_FOOD_NOTE", "MEDICINE_OCCURRENCE"], signal: new AbortController().signal });

describe("P13X review CRITICAL 1: a negated utterance never comes back TAKEN", () => {
  it("'Grey pen. Hadn't taken' end to end: the server's TAKEN is rejected locally, and the merged review holds no TAKEN", async () => {
    const transcript = "Grey pen. Hadn't taken";
    expect(gateRemoteTranscriptExtraction(transcript, "en")).toMatchObject({ kind: "PERMIT" });
    const output: ExtractionOutput = {
      facts: [{ kind: "MEDICINE_OCCURRENCE", sourceSpan: span(transcript, transcript), value: null, unit: null, status: "TAKEN", negated: false, uncertain: false, unresolvedPhrase: "Grey pen" }],
      unsupportedSpans: [],
    };
    const sink = { calls: 0 };
    const result = await extract(client({ kind: "EXTRACTED", output, retention: "CONFIRMED_NOT_STORED", usage }, sink), transcript);
    expect(result).toEqual({ kind: "FALLBACK", reason: "REJECTED_LOCALLY", detail: "TAKEN_WITH_NEGATION", sent: true });
    expect(sink.calls).toBe(1);
    // The local analysis (what the screen keeps on a fallback) and any merge with a (defensively mapped) remote fact hold no TAKEN.
    const local = analyseTranscript(transcript, "en");
    expect(local.kind).toBe("ANALYSED");
    if (local.kind !== "ANALYSED") return;
    const mapped = mapToVoiceCandidates({ ...output, facts: [{ ...output.facts[0]!, negated: true }] }, transcript, "en-SG");
    expect(mapped).toMatchObject({ kind: "MAPPED", candidates: [{ kind: "MEDICATION_OCCURRENCE", status: "UNKNOWN" }] });
    if (mapped.kind !== "MAPPED") return;
    const merged = mergeRemoteCandidates({ local, remote: mapped.candidates, transcript, language: "en", directory: { terms: [], names: [] } });
    const analysis = merged.kind === "MERGED" ? merged.analysis : local;
    expect(analysis.candidates.filter((candidate) => candidate.kind === "MEDICATION_OCCURRENCE" && candidate.status === "TAKEN")).toEqual([]);
    expect(local.candidates.filter((candidate) => candidate.kind === "MEDICATION_OCCURRENCE" && candidate.status === "TAKEN")).toEqual([]);
  });

  it("the mapper never emits TAKEN for a negated span (curly apostrophe included), EN and ZH", () => {
    for (const [transcript, locale] of [["I haven’t used the grey pen", "en-SG"], ["I hadn't injected the grey pen", "en-SG"], ["I shouldn't have taken the grey pen", "en-SG"], ["灰色的笔还没打过", "zh-SG"]] as const) {
      const mapped = mapToVoiceCandidates({ facts: [{ kind: "MEDICINE_OCCURRENCE", sourceSpan: span(transcript, transcript), value: null, unit: null, status: "TAKEN", negated: false, uncertain: false, unresolvedPhrase: null }], unsupportedSpans: [] }, transcript, locale);
      expect(mapped, transcript).toMatchObject({ kind: "MAPPED", candidates: [{ status: "UNKNOWN" }] });
      if (mapped.kind === "MAPPED") expect(mapped.candidates[0]!.kind === "MEDICATION_OCCURRENCE" && mapped.candidates[0]!.ambiguity.includes("NEGATION"), transcript).toBe(true);
    }
  });
});

describe("P13X review CRITICAL 2: the EN and ZH gate and redirect apply together, whatever the locale", () => {
  const CODE_SWITCHED: [string, "en-SG" | "zh-SG"][] = [
    ["Sugar 15 要不要加 insulin", "en-SG"],
    ["Sugar 15 要不要加 insulin", "zh-SG"],
    ["我应该打几个单位", "en-SG"],
    ["血糖十五 should I take more insulin", "zh-SG"],
    ["血糖十五 should I take more insulin", "en-SG"],
    ["How many units should I inject", "zh-SG"],
    ["I wonder whether to inject more", "en-SG"],
    ["need to see doctor or not", "en-SG"],
    ["我想知道要不要多打", "zh-SG"],
  ];
  it("the voice gate withholds every code-switched or indirect question in both locales; the client sends nothing", async () => {
    for (const [transcript, locale] of CODE_SWITCHED) {
      for (const language of ["en", "zh"] as const) expect(gateRemoteTranscriptExtraction(transcript, language), `${transcript} ${language}`).toEqual({ kind: "WITHHOLD", reason: "REDIRECT_CONTENT" });
      const sink = { calls: 0 };
      expect(await extract(client({}, sink), transcript, locale), transcript).toEqual({ kind: "WITHHELD", reason: "REDIRECT_CONTENT" });
      expect(sink.calls, transcript).toBe(0);
    }
  });

  it("the extraction redirect (route check and validator r4) is the union of both classifiers for either locale", () => {
    for (const text of ["Sugar 15 要不要加 insulin", "我应该打几个单位", "血糖十五 should I take more insulin", "How many units should I inject"]) {
      for (const locale of ["en-SG", "zh-SG"] as const) expect(transcriptRedirect(locale)(text), `${text} ${locale}`).toBe(true);
    }
    for (const text of ["Sugar 6.5 before breakfast", "早餐前血糖六点五毫摩尔"]) for (const locale of ["en-SG", "zh-SG"] as const) expect(transcriptRedirect(locale)(text)).toBe(false);
  });
});

describe("P13X review IMPORTANT 2 and minors", () => {
  it("the client refuses redirects and caps the response read at 65,536 characters", async () => {
    const sink: { init?: RequestInit; calls: number } = { calls: 0 };
    const transcript = "Sugar 6.5 before breakfast";
    await extract(client({ kind: "REFUSED", reason: "EXTRACTION_DISABLED", notSentToProvider: true }, sink), transcript);
    expect(sink.init?.redirect).toBe("error");
    const huge = `{"kind":"REFUSED","reason":"EXTRACTION_DISABLED","notSentToProvider":true,"pad":"${"x".repeat(70_000)}"}`;
    expect(await extract(client(null, { calls: 0 }, huge), transcript)).toEqual({ kind: "FALLBACK", reason: "RESPONSE_INVALID", detail: null, sent: true });
    // Strict JSON: a duplicate key is not a valid response.
    expect(await extract(client(null, { calls: 0 }, '{"kind":"REFUSED","kind":"REFUSED","reason":"EXTRACTION_DISABLED","notSentToProvider":true}'), transcript)).toEqual({ kind: "FALLBACK", reason: "RESPONSE_INVALID", detail: null, sent: true });
  });

  it("the mapper emits the canonical value, never the raw '06.8'", () => {
    const transcript = "Sugar 06.8 mmol";
    const mapped = mapToVoiceCandidates({ facts: [{ kind: "GLUCOSE_READING", sourceSpan: span(transcript, transcript), value: "06.8", unit: "MMOL_PER_L", status: null, negated: false, uncertain: false, unresolvedPhrase: null }], unsupportedSpans: [] }, transcript, "en-SG");
    expect(mapped).toMatchObject({ kind: "MAPPED", candidates: [{ kind: "GLUCOSE_READING", valueText: "6.8" }] });
  });

  it("CR-11 (R-6): the mapper uses the voice slice's new-entry format: two decimals are never shortened; no ceiling at 99", () => {
    const map = (transcript: string, value: string) =>
      mapToVoiceCandidates({ facts: [{ kind: "GLUCOSE_READING", sourceSpan: span(transcript, transcript), value, unit: "MMOL_PER_L", status: null, negated: false, uncertain: false, unresolvedPhrase: null }], unsupportedSpans: [] }, transcript, "en-SG");
    for (const [transcript, value] of [["Sugar 06.80 mmol", "06.80"], ["Sugar 9.25 mmol", "9.25"], ["Sugar 60.00 mmol", "60.00"]] as const) {
      expect(map(transcript, value), value).toMatchObject({ kind: "MAPPED", candidates: [{ kind: "UNSUPPORTED_SPAN" }], downgraded: 1 });
    }
    for (const [transcript, value] of [["Sugar 60 mmol", "60"], ["Sugar 120 mmol", "120"], ["Sugar 1234.5 mmol", "1234.5"]] as const) {
      expect(map(transcript, value), value).toMatchObject({ kind: "MAPPED", candidates: [{ kind: "GLUCOSE_READING", valueText: value }] });
    }
  });
});

describe("Recheck 6: counterfactuals, Chinese and Singlish indirect questions, code-switched dose questions", () => {
  const COUNTERFACTUAL: [string, "en-SG" | "zh-SG"][] = [
    ["I'd have taken my dark pen", "en-SG"],
    ["I’d have taken my dark pen", "en-SG"],
    ["I would have taken my dark pen", "en-SG"],
    ["I would've taken my dark pen", "en-SG"],
    ["I would’ve taken my dark pen", "en-SG"],
    ["I could have taken my dark pen", "en-SG"],
    ["I could’ve taken my dark pen", "en-SG"],
    ["I might've taken my dark pen", "en-SG"],
    ["I might’ve taken my dark pen", "en-SG"],
    ["I must have taken my dark pen", "en-SG"],
    ["我本来会打黑色的笔", "zh-SG"],
    ["我本该吃了黑色的笔", "zh-SG"],
    ["要是记得就打了黑色的笔", "zh-SG"],
  ];
  it("CRITICAL A: a counterfactual TAKEN is rejected by the validator, never mapped TAKEN, and never a one-tap TAKEN locally", async () => {
    for (const [transcript, locale] of COUNTERFACTUAL) {
      const fact = { kind: "MEDICINE_OCCURRENCE", sourceSpan: span(transcript, transcript), value: null, unit: null, status: "TAKEN", negated: false, uncertain: true, unresolvedPhrase: null } as const;
      const request: ExtractionRequest = { taskType: "EXTRACT_VOICE_FACTS", contractVersion: TRANSCRIPT_EXTRACTION_CONTRACT_VERSION, locale, transcript, allowedFactKinds: ["MEDICINE_OCCURRENCE"] };
      const verdict = validateExtraction(request, { facts: [fact], unsupportedSpans: [] }, { isRedirect: transcriptRedirect(locale) });
      expect(verdict, transcript).toMatchObject({ kind: "REJECTED", reason: transcript.startsWith("要是") ? expect.stringMatching(/^TAKEN_WITH_(PLANNED|COUNTERFACTUAL)$/) : "TAKEN_WITH_COUNTERFACTUAL" });
      // End to end: the client falls back (sent once) and keeps nothing remote.
      const sink = { calls: 0 };
      const result = await extract(client({ kind: "EXTRACTED", output: { facts: [fact], unsupportedSpans: [] }, retention: "CONFIRMED_NOT_STORED", usage }, sink), transcript, locale);
      expect(result, transcript).toMatchObject({ kind: "FALLBACK", reason: "REJECTED_LOCALLY" });
      // Defence in depth: the mapper turns a forged TAKEN into UNKNOWN.
      const mapped = mapToVoiceCandidates({ facts: [fact], unsupportedSpans: [] }, transcript, locale);
      expect(mapped, transcript).toMatchObject({ kind: "MAPPED", candidates: [{ status: "UNKNOWN" }] });
      // Locally (with the dark pen remembered) the occurrence is never TAKEN and always needs an edit (UNCERTAINTY).
      const local = analyseTranscript(transcript, locale === "zh-SG" ? "zh" : "en", { medicines: DIRECTORY });
      expect(local.kind, transcript).toBe("ANALYSED");
      for (const candidate of local.candidates) {
        if (candidate.kind !== "MEDICATION_OCCURRENCE") continue;
        expect(candidate.status, transcript).not.toBe("TAKEN");
      }
    }
    // A plain report is still TAKEN.
    const plain = "I took my dark pen";
    const plainFact = { kind: "MEDICINE_OCCURRENCE", sourceSpan: span(plain, plain), value: null, unit: null, status: "TAKEN", negated: false, uncertain: false, unresolvedPhrase: null } as const;
    const request: ExtractionRequest = { taskType: "EXTRACT_VOICE_FACTS", contractVersion: TRANSCRIPT_EXTRACTION_CONTRACT_VERSION, locale: "en-SG", transcript: plain, allowedFactKinds: ["MEDICINE_OCCURRENCE"] };
    expect(validateExtraction(request, { facts: [plainFact], unsupportedSpans: [] }, { isRedirect: transcriptRedirect("en-SG") })).toMatchObject({ kind: "VALID" });
  });

  const QUESTIONS: [string, "DOSE_TREATMENT" | "HEALTH_QUESTION"][] = [
    ["我想问 sugar 15 normal anot", "HEALTH_QUESTION"],
    ["请问血糖七点二", "HEALTH_QUESTION"],
    ["问一下 sugar 7.2 ok anot", "HEALTH_QUESTION"],
    ["sugar 15 normal or not ah", "HEALTH_QUESTION"],
    ["sugar 15 can or not", "HEALTH_QUESTION"],
    ["sugar 15 can makan durian or not", "HEALTH_QUESTION"],
    ["Sugar 15 我要不要吃多一点", "HEALTH_QUESTION"],
    ["Sugar 15 我要不要打多一点", "DOSE_TREATMENT"],
    ["Sugar 15, 打多少 units ah", "DOSE_TREATMENT"],
  ];
  it("CRITICAL B and must-fix: the gate withholds, the extraction redirect catches, and the voice review shows the redirect, in both locales", () => {
    for (const [transcript, category] of QUESTIONS) {
      for (const language of ["en", "zh"] as const) {
        expect(gateRemoteTranscriptExtraction(transcript, language), `${transcript} ${language}`).toEqual({ kind: "WITHHOLD", reason: "REDIRECT_CONTENT" });
        expect(transcriptRedirect(language === "zh" ? "zh-SG" : "en-SG")(transcript), `${transcript} ${language}`).toBe(true);
        const analysis = analyseTranscript(transcript, language, { medicines: DIRECTORY });
        const shown = analysis.kind === "REDIRECT" ? analysis.category : analysis.kind === "ANALYSED" ? analysis.redirect?.category : undefined;
        expect(shown, `${transcript} ${language}`).toBe(category);
      }
    }
    // A bare Singlish tag beside a reading is withheld but stays a reading for review (no assessment word, no treatment).
    expect(gateRemoteTranscriptExtraction("sugar 6.8 anot", "en")).toEqual({ kind: "WITHHOLD", reason: "REDIRECT_CONTENT" });
    expect(transcriptRedirect("en-SG")("sugar 6.8 anot")).toBe(false);
  });

  it("optional: the gate withholds spoken counts without an amount unit, but not 'half an hour'", () => {
    for (const transcript of ["I took half a tablet", "I took two white ones", "I injected half a pen", "我吃了两个白色的", "我吃了半片药"]) {
      for (const language of ["en", "zh"] as const) expect(gateRemoteTranscriptExtraction(transcript, language), `${transcript} ${language}`).toEqual({ kind: "WITHHOLD", reason: "REDIRECT_CONTENT" });
    }
    expect(gateRemoteTranscriptExtraction("sugar 7.2 half an hour after lunch", "en")).toMatchObject({ kind: "PERMIT" });
  });
});
