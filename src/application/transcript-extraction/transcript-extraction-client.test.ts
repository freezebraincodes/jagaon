// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiRemoteUseDecision } from "@/application/ai/ai-provider-port";
import { candidateMatchesTranscript, voiceCandidateSchema } from "@/domain/voice/voice-contracts";
import type { ExtractionOutput } from "@/domain/transcript-extraction/transcript-extraction-contract";
import { createTranscriptExtractionClient } from "./transcript-extraction-client";
import { mapToVoiceCandidates } from "./transcript-extraction-mapper";

/**
 * Packet 13 (P13X): the browser client and the mapper to the frozen voice union (voice-contract.13s.3), with a fake fetch and a fake
 * per-request disclosure. Synthetic text only.
 */

const TRANSCRIPT = "Maybe 7.2 after lunch, took the dark pen";
const OUTPUT: ExtractionOutput = {
  facts: [
    { kind: "GLUCOSE_READING", sourceSpan: { start: 0, end: 21, text: "Maybe 7.2 after lunch" }, value: "7.2", unit: null, status: null, negated: false, uncertain: true, unresolvedPhrase: null },
    { kind: "MEDICINE_OCCURRENCE", sourceSpan: { start: 23, end: 40, text: "took the dark pen" }, value: null, unit: null, status: "TAKEN", negated: false, uncertain: false, unresolvedPhrase: "dark pen" },
  ],
  unsupportedSpans: [],
};
const usage = { inputTokens: 1, outputTokens: 1, costMicroUsd: 3, basis: "REPORTED" };

function harness(answer: unknown, decision: AiRemoteUseDecision = "ACCEPTED", passcode: string | null = "synthetic-pass-01") {
  const calls: { url: string; init: RequestInit }[] = [];
  const decided: number[] = [];
  const client = createTranscriptExtractionClient({
    disclosure: { decide: async () => (decided.push(1), decision) },
    passcode: () => passcode,
    fetcher: async (url, init) => (calls.push({ url, init }), new Response(JSON.stringify(answer), { status: 200 })),
  });
  const run = (transcript = TRANSCRIPT, locale: "en-SG" | "zh-SG" = "en-SG") => client.extract({ transcript, locale, allowedFactKinds: ["GLUCOSE_READING", "MEDICINE_OCCURRENCE"], signal: new AbortController().signal });
  return { run, calls, decided };
}

afterEach(() => vi.restoreAllMocks());

describe("Packet 13 transcript-extraction client", () => {
  it("sends one same-origin POST with only the request and the passcode header, re-validates and maps to VoiceCandidate", async () => {
    const h = harness({ kind: "EXTRACTED", output: OUTPUT, retention: "CONFIRMED_NOT_STORED", usage });
    const result = await h.run();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.url).toBe("/api/ai/transcript");
    expect(JSON.parse(String(h.calls[0]!.init.body))).toEqual({ taskType: "EXTRACT_VOICE_FACTS", contractVersion: "transcript-extraction.13.1", locale: "en-SG", transcript: TRANSCRIPT, allowedFactKinds: ["GLUCOSE_READING", "MEDICINE_OCCURRENCE"] });
    expect((h.calls[0]!.init.headers as Record<string, string>)["x-jagaon-demo-passcode"]).toBe("synthetic-pass-01");
    expect(result.kind).toBe("EXTRACTED");
    if (result.kind !== "EXTRACTED") return;
    for (const candidate of result.candidates) {
      expect(voiceCandidateSchema.safeParse(candidate).success).toBe(true);
      expect(candidateMatchesTranscript(candidate, TRANSCRIPT)).toBe(true);
    }
    expect(result.candidates).toEqual([
      { kind: "GLUCOSE_READING", span: { start: 0, end: 21 }, sourcePhrase: "Maybe 7.2 after lunch", source: "REMOTE_EXTRACTION", producerVersion: "transcript-extraction.13.1", state: "AMBIGUOUS", ambiguity: ["UNIT_UNSTATED", "UNCERTAINTY"], valueText: "7.2", unit: "UNSTATED", unitSource: null },
      { kind: "MEDICATION_OCCURRENCE", span: { start: 23, end: 40 }, sourcePhrase: "took the dark pen", source: "REMOTE_EXTRACTION", producerVersion: "transcript-extraction.13.1", state: "AMBIGUOUS", ambiguity: ["MEDICINE_UNRESOLVED"], status: "TAKEN", medicineRef: { kind: "UNRESOLVED", phrase: "dark pen" }, reportedAmount: null },
    ]);
  });

  it("a gate WITHHOLD (dose question, empty, too long) makes zero network calls and asks no disclosure", async () => {
    const h = harness({});
    expect(await h.run("How many units should I take tonight?")).toEqual({ kind: "WITHHELD", reason: "REDIRECT_CONTENT" });
    expect(await h.run("我应该打几个单位？", "zh-SG")).toEqual({ kind: "WITHHELD", reason: "REDIRECT_CONTENT" });
    expect(await h.run("   ")).toEqual({ kind: "WITHHELD", reason: "EMPTY" });
    expect(await h.run("血".repeat(1_201), "zh-SG")).toEqual({ kind: "WITHHELD", reason: "TOO_LONG" });
    expect(h.decided).toHaveLength(0);
    expect(h.calls).toHaveLength(0);
  });

  it("declined disclosure, a missing passcode or a request this task refuses send nothing", async () => {
    for (const decision of ["DECLINED", "NOT_ACCEPTED"] as const) {
      const h = harness({}, decision);
      expect(await h.run()).toEqual({ kind: "FALLBACK", reason: "REMOTE_USE_DECLINED", detail: null, sent: false });
      expect(h.calls).toHaveLength(0);
    }
    const noPass = harness({}, "ACCEPTED", null);
    expect(await noPass.run()).toMatchObject({ kind: "FALLBACK", reason: "PASSCODE_MISSING", sent: false });
    expect(noPass.calls).toHaveLength(0);
    const control = harness({});
    expect(await control.run("Sugar 6.5\u0007")).toMatchObject({ kind: "FALLBACK", reason: "REQUEST_INVALID", sent: false });
    expect(control.decided).toHaveLength(0);
    expect(control.calls).toHaveLength(0);
  });

  it("maps every server answer to a fallback with its closed reason; a tampered EXTRACTED output is rejected locally", async () => {
    expect(await harness({ kind: "REFUSED", reason: "EXTRACTION_NOT_QUALIFIED", notSentToProvider: true }).run()).toEqual({ kind: "FALLBACK", reason: "REFUSED", detail: "EXTRACTION_NOT_QUALIFIED", sent: false });
    expect(await harness({ kind: "FAILED", reason: "PROVIDER_TIMEOUT", usage: { ...usage, basis: "UPPER_BOUND" } }).run()).toEqual({ kind: "FALLBACK", reason: "FAILED", detail: "PROVIDER_TIMEOUT", sent: true });
    expect(await harness({ kind: "REJECTED", reason: "VALUE_NOT_IN_SPAN", retention: "CONFIRMED_NOT_STORED", usage }).run()).toEqual({ kind: "FALLBACK", reason: "REJECTED_BY_SERVER", detail: "VALUE_NOT_IN_SPAN", sent: true });
    expect(await harness({ kind: "SOMETHING" }).run()).toMatchObject({ kind: "FALLBACK", reason: "RESPONSE_INVALID" });
    const tampered = { ...OUTPUT, facts: [{ ...OUTPUT.facts[0], value: "9.9" }, OUTPUT.facts[1]] };
    expect(await harness({ kind: "EXTRACTED", output: tampered, retention: "CONFIRMED_NOT_STORED", usage }).run()).toEqual({ kind: "FALLBACK", reason: "REJECTED_LOCALLY", detail: "VALUE_NOT_IN_SPAN", sent: true });
  });

  it("never logs the transcript", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
    await harness({ kind: "EXTRACTED", output: OUTPUT, retention: "CONFIRMED_NOT_STORED", usage }).run();
    await harness({ nope: true }).run();
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe("Packet 13 mapper to VoiceCandidate (voice-contract.13s.3)", () => {
  const span = (transcript: string, text: string) => {
    const points = Array.from(transcript);
    const target = Array.from(text);
    for (let i = 0; i + target.length <= points.length; i += 1) if (points.slice(i, i + target.length).join("") === text) return { start: i, end: i + target.length, text };
    throw new Error("not found");
  };
  const fact = (transcript: string, text: string, patch: Partial<ExtractionOutput["facts"][number]>): ExtractionOutput["facts"][number] => ({ kind: "GLUCOSE_READING", sourceSpan: span(transcript, text), value: null, unit: null, status: null, negated: false, uncertain: false, unresolvedPhrase: null, ...patch });
  const mapped = (transcript: string, output: ExtractionOutput, locale: "en-SG" | "zh-SG" = "en-SG") => {
    const result = mapToVoiceCandidates(output, transcript, locale);
    if (result.kind === "MAPPED") for (const candidate of result.candidates) expect(candidateMatchesTranscript(candidate, transcript)).toBe(true);
    return result;
  };

  it("a spoken mmol unit is SPOKEN and UNDERSTOOD; never APP_DEFAULT", () => {
    const t = "My sugar was 6.5 mmol before breakfast";
    const result = mapped(t, { facts: [fact(t, t, { value: "6.5", unit: "MMOL_PER_L" })], unsupportedSpans: [] });
    expect(result).toMatchObject({ kind: "MAPPED", candidates: [{ kind: "GLUCOSE_READING", valueText: "6.5", unit: "MMOL_PER_L", unitSource: "SPOKEN", state: "UNDERSTOOD", ambiguity: [] }] });
    expect(JSON.stringify(result)).not.toContain("APP_DEFAULT");
  });

  it("adds the voice slice's caution the contract does not model: other person, correction, several numbers", () => {
    const wife = "My wife's sugar was 9";
    expect(mapped(wife, { facts: [fact(wife, wife, { value: "9" })], unsupportedSpans: [] })).toMatchObject({ kind: "MAPPED", candidates: [{ state: "AMBIGUOUS", ambiguity: ["UNIT_UNSTATED", "OTHER_PERSON"] }] });
    const fix = "Sugar 7.2, sorry I mean 7.4";
    expect(mapped(fix, { facts: [fact(fix, fix, { value: "7.4" })], unsupportedSpans: [] })).toMatchObject({ kind: "MAPPED", candidates: [{ ambiguity: ["UNIT_UNSTATED", "CORRECTION", "MULTIPLE_NUMBERS"] }] });
    const zh = "我老公的血糖是八";
    expect(mapped(zh, { facts: [fact(zh, zh, { value: "8" })], unsupportedSpans: [] }, "zh-SG")).toMatchObject({ kind: "MAPPED", candidates: [{ ambiguity: ["UNIT_UNSTATED", "OTHER_PERSON"] }] });
  });

  it("medicine refs are always UNRESOLVED; a 'forgot' status becomes UNKNOWN (STATUS_UNCLEAR); negation is kept", () => {
    const t = "I forgot the grey pen";
    expect(mapped(t, { facts: [fact(t, t, { kind: "MEDICINE_OCCURRENCE", status: "SKIPPED", unresolvedPhrase: "grey pen" })], unsupportedSpans: [] })).toMatchObject({
      kind: "MAPPED",
      candidates: [{ kind: "MEDICATION_OCCURRENCE", status: "UNKNOWN", medicineRef: { kind: "UNRESOLVED", phrase: "grey pen" }, ambiguity: ["MEDICINE_UNRESOLVED", "STATUS_UNCLEAR"] }],
    });
    const z = "晚上的药我没吃";
    expect(mapped(z, { facts: [fact(z, z, { kind: "MEDICINE_OCCURRENCE", status: "SKIPPED", negated: true, unresolvedPhrase: "晚上的药" })], unsupportedSpans: [] }, "zh-SG")).toMatchObject({
      kind: "MAPPED",
      candidates: [{ status: "SKIPPED", ambiguity: ["NEGATION", "MEDICINE_UNRESOLVED"] }],
    });
  });

  it("meal slot only when said; mg/dL readings and amounts without spoken unit words become UNSUPPORTED_SPAN (never silently dropped)", () => {
    const meal = "Had chicken rice for lunch";
    expect(mapped(meal, { facts: [fact(meal, meal, { kind: "MEAL_OR_FOOD_NOTE" })], unsupportedSpans: [] })).toMatchObject({ kind: "MAPPED", candidates: [{ kind: "MEAL_NOTE", slot: "LUNCH", itemText: null, state: "UNDERSTOOD" }] });
    const mgdl = "Reading 120 mg/dL";
    expect(mapped(mgdl, { facts: [fact(mgdl, mgdl, { value: "120", unit: "MG_PER_DL" })], unsupportedSpans: [] })).toEqual({
      kind: "MAPPED",
      downgraded: 1,
      candidates: [{ kind: "UNSUPPORTED_SPAN", span: { start: 0, end: 17 }, sourcePhrase: mgdl, source: "REMOTE_EXTRACTION", producerVersion: "transcript-extraction.13.1" }],
    });
    // 13s.3 (owner #4): a reported amount with its spoken unit words is kept verbatim on the occurrence, never as an instruction.
    const amount = "Took 2 tablets";
    expect(mapped(amount, { facts: [fact(amount, amount, { kind: "MEDICINE_OCCURRENCE", status: "TAKEN", value: "2", unit: "TABLET" })], unsupportedSpans: [] })).toMatchObject({
      kind: "MAPPED",
      downgraded: 0,
      candidates: [{ kind: "MEDICATION_OCCURRENCE", status: "TAKEN", reportedAmount: { valueText: "2", unitText: "tablets" } }],
    });
    const zhAmount = "打了胰岛素十个单位";
    expect(mapped(zhAmount, { facts: [fact(zhAmount, zhAmount, { kind: "MEDICINE_OCCURRENCE", status: "TAKEN", value: "10", unit: "UNITS", unresolvedPhrase: "胰岛素" })], unsupportedSpans: [] }, "zh-SG")).toMatchObject({
      kind: "MAPPED",
      downgraded: 0,
      candidates: [{ kind: "MEDICATION_OCCURRENCE", status: "TAKEN", reportedAmount: { valueText: "10", unitText: "个单位" } }],
    });
    // A number with no spoken unit words is shown as not understood rather than guessed.
    const bare = "Took 2 of the grey pen";
    expect(mapped(bare, { facts: [fact(bare, bare, { kind: "MEDICINE_OCCURRENCE", status: "TAKEN", value: "2", unresolvedPhrase: "grey pen" })], unsupportedSpans: [] })).toMatchObject({ kind: "MAPPED", downgraded: 1, candidates: [{ kind: "UNSUPPORTED_SPAN" }] });
  });

  it("is UNMAPPABLE when the voice union cannot hold the output (phrase over 160 code points, more than 12 candidates)", () => {
    const long = `Sugar 6.5 ${"and then ".repeat(20)}`.trim();
    expect(mapToVoiceCandidates({ facts: [fact(long, long, { value: "6.5" })], unsupportedSpans: [] }, long, "en-SG")).toEqual({ kind: "UNMAPPABLE", reason: "PHRASE_TOO_LONG" });
    const many = "a b c d e f g h i j k l m";
    const spans = many.split(" ").map((letter) => span(many, letter));
    expect(mapToVoiceCandidates({ facts: [], unsupportedSpans: spans.slice(0, 8) }, many, "en-SG").kind).toBe("MAPPED");
    expect(mapToVoiceCandidates({ facts: spans.slice(8, 13).map((s) => ({ kind: "MEAL_OR_FOOD_NOTE", sourceSpan: s, value: null, unit: null, status: null, negated: false, uncertain: false, unresolvedPhrase: null })), unsupportedSpans: spans.slice(0, 8) }, many, "en-SG")).toEqual({ kind: "UNMAPPABLE", reason: "TOO_MANY_CANDIDATES" });
  });
});
