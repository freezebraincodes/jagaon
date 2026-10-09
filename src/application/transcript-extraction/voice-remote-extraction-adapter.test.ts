// @vitest-environment node
import { describe, expect, it } from "vitest";
import { AI_ACTIVATION_MANIFEST, type AiActivationManifest } from "@/application/ai/ai-activation-manifest";
import type { ExtractionOutput } from "@/domain/transcript-extraction/transcript-extraction-contract";
import { isTranscriptExtractionActivated } from "./transcript-extraction-qualification";
import { createVoiceRemoteExtraction } from "./voice-remote-extraction-adapter";

/**
 * Packet 13 (P13X): the voice review's remote-extraction adapter over the transcript-extraction client, with a fake fetch only (no
 * network, no credential). Synthetic text only.
 */

const TRANSCRIPT = "Maybe 7.2 after lunch, took the dark pen";
const OUTPUT: ExtractionOutput = {
  facts: [
    { kind: "GLUCOSE_READING", sourceSpan: { start: 0, end: 21, text: "Maybe 7.2 after lunch" }, value: "7.2", unit: null, status: null, negated: false, uncertain: true, unresolvedPhrase: null },
    { kind: "MEDICINE_OCCURRENCE", sourceSpan: { start: 23, end: 40, text: "took the dark pen" }, value: null, unit: null, status: "TAKEN", negated: false, uncertain: false, unresolvedPhrase: "dark pen" },
  ],
  unsupportedSpans: [],
};
const EXTRACTED = { kind: "EXTRACTED", output: OUTPUT, retention: "CONFIRMED_NOT_STORED", usage: { inputTokens: 1, outputTokens: 1, costMicroUsd: 3, basis: "REPORTED" } };

function setup(answer: unknown = EXTRACTED, passcode: string | null = "synthetic-pass-01", fail?: "THROW" | "HANG") {
  const posts: { url: string; init: RequestInit }[] = [];
  const extract = createVoiceRemoteExtraction({
    passcode: () => passcode,
    fetcher: (url, init) => {
      posts.push({ url, init });
      if (fail === "THROW") return Promise.reject(new TypeError("network"));
      if (fail === "HANG") return new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
      return Promise.resolve(new Response(JSON.stringify(answer), { status: 200 }));
    },
  });
  return { extract, posts };
}

describe("Packet 13 voice remote-extraction adapter", () => {
  it("EXTRACTED → CANDIDATES (the validated, mapped voice candidates), with exactly one same-origin POST per call", async () => {
    const { extract, posts } = setup();
    const result = await extract(TRANSCRIPT, "en", new AbortController().signal);
    expect(result.kind).toBe("CANDIDATES");
    if (result.kind === "CANDIDATES") expect(result.candidates.map((candidate) => [candidate.kind, candidate.source])).toEqual([["GLUCOSE_READING", "REMOTE_EXTRACTION"], ["MEDICATION_OCCURRENCE", "REMOTE_EXTRACTION"]]);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe("/api/ai/transcript");
    expect(posts[0]!.init.method).toBe("POST");
    expect((posts[0]!.init.headers as Record<string, string>)["x-jagaon-demo-passcode"]).toBe("synthetic-pass-01");
    expect(JSON.parse(String(posts[0]!.init.body))).toMatchObject({ locale: "en-SG", transcript: TRANSCRIPT, allowedFactKinds: ["GLUCOSE_READING", "MEAL_OR_FOOD_NOTE", "MEDICINE_OCCURRENCE"] });
    // A second call is a second request (the screen asked again): one more POST, never a retry.
    await extract(TRANSCRIPT, "en", new AbortController().signal);
    expect(posts).toHaveLength(2);
  });

  it("zh maps to the zh-SG locale", async () => {
    const z = "血糖六点八";
    const { extract, posts } = setup({ ...EXTRACTED, output: { facts: [{ ...OUTPUT.facts[0]!, sourceSpan: { start: 0, end: 5, text: z }, value: "6.8", uncertain: false }], unsupportedSpans: [] } });
    expect(await extract(z, "zh", new AbortController().signal)).toMatchObject({ kind: "CANDIDATES", candidates: [{ kind: "GLUCOSE_READING", valueText: "6.8" }] });
    expect(JSON.parse(String(posts[0]!.init.body))).toMatchObject({ locale: "zh-SG" });
  });

  it("WITHHELD by the voice gate → WITHHELD, and no POST", async () => {
    const { extract, posts } = setup();
    for (const [text, language] of [["Should I take my insulin", "en"], ["I injected 10 units of my dark pen", "en"], ["我应该打几个单位？", "zh"], ["   ", "en"]] as const) {
      expect(await extract(text, language, new AbortController().signal), text).toEqual({ kind: "WITHHELD" });
    }
    expect(posts).toHaveLength(0);
  });

  it("every FALLBACK → UNAVAILABLE (the screen keeps its local result)", async () => {
    const cases: [string, ReturnType<typeof setup>, number][] = [
      ["refused by the route", setup({ kind: "REFUSED", reason: "EXTRACTION_NOT_QUALIFIED", notSentToProvider: true }), 1],
      ["failed", setup({ kind: "FAILED", reason: "PROVIDER_TIMEOUT", usage: { inputTokens: null, outputTokens: null, costMicroUsd: 10, basis: "UPPER_BOUND" } }), 1],
      ["invalid response", setup({ kind: "SOMETHING" }), 1],
      ["output that fails the r-rules locally", setup({ ...EXTRACTED, output: { facts: [{ ...OUTPUT.facts[0]!, value: "9.9" }], unsupportedSpans: [] } }), 1],
      ["network failure", setup(EXTRACTED, "synthetic-pass-01", "THROW"), 1],
      ["no passcode held", setup(EXTRACTED, null), 0],
    ];
    for (const [name, { extract, posts }, expectedPosts] of cases) {
      expect(await extract(TRANSCRIPT, "en", new AbortController().signal), name).toEqual({ kind: "UNAVAILABLE" });
      expect(posts, name).toHaveLength(expectedPosts);
    }
  });

  it("abort: an already aborted signal sends nothing; an abort during the POST ends it as UNAVAILABLE", async () => {
    const before = setup();
    const aborted = new AbortController();
    aborted.abort();
    expect(await before.extract(TRANSCRIPT, "en", aborted.signal)).toEqual({ kind: "UNAVAILABLE" });
    expect(before.posts).toHaveLength(0);

    const during = setup(EXTRACTED, "synthetic-pass-01", "HANG");
    const controller = new AbortController();
    const pending = during.extract(TRANSCRIPT, "en", controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(during.posts).toHaveLength(1);
    expect(during.posts[0]!.init.signal?.aborted).toBe(false);
    controller.abort();
    expect(await pending).toEqual({ kind: "UNAVAILABLE" });
    expect(during.posts).toHaveLength(1);
  });
});

describe("isTranscriptExtractionActivated", () => {
  it("is false for the shipped manifest; true only when the task is SYNTHETIC_REMOTE_ENABLED for HACKATHON_DEMO", () => {
    expect(isTranscriptExtractionActivated()).toBe(false);
    expect(isTranscriptExtractionActivated(AI_ACTIVATION_MANIFEST)).toBe(false);
    const withTask = (state: string, profile = AI_ACTIVATION_MANIFEST.profile) => ({ ...AI_ACTIVATION_MANIFEST, profile, separateTasks: { EXTRACT_VOICE_FACTS: state } }) as unknown as AiActivationManifest;
    expect(isTranscriptExtractionActivated(withTask("SYNTHETIC_REMOTE_ENABLED"))).toBe(true);
    expect(isTranscriptExtractionActivated(withTask("DETERMINISTIC_ONLY"))).toBe(false);
    expect(isTranscriptExtractionActivated(withTask("REGISTERED_DISABLED"))).toBe(false);
    expect(isTranscriptExtractionActivated(withTask("SYNTHETIC_REMOTE_ENABLED", "PATIENT_RELEASE" as never))).toBe(false);
  });
});
