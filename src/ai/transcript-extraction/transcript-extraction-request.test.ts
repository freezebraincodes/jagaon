// @vitest-environment node
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ExtractionRequest } from "@/domain/transcript-extraction/transcript-extraction-contract";
import { TRANSCRIPT_EXTRACTION_PROMPT, TRANSCRIPT_EXTRACTION_PROMPT_VERSION } from "./transcript-extraction-prompt";
import { invokeTranscriptExtraction } from "./transcript-extraction-provider";
import {
  TRANSCRIPT_EXTRACTION_MAX_OUTPUT_TOKENS,
  TRANSCRIPT_EXTRACTION_REQUEST_PROFILE,
  TRANSCRIPT_EXTRACTION_TEMPERATURE,
  buildTranscriptExtractionBody,
  transcriptExtractionCallUpperBound,
  transcriptExtractionContractDigest,
  transcriptExtractionModel,
} from "./transcript-extraction-request";

/** Packet 13 (P13X): the frozen model-facing body, the pre-send bound and the transport, with a fake fetch only. Synthetic text. */

const REQUEST: ExtractionRequest = { taskType: "EXTRACT_VOICE_FACTS", contractVersion: "transcript-extraction.13.1", locale: "en-SG", transcript: "Sugar six point five before breakfast, took the grey pen", allowedFactKinds: ["GLUCOSE_READING", "MEDICINE_OCCURRENCE"] };
const SYNTHETIC_TOKEN = "synthetic-token-not-a-key-41f";
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const model = () => transcriptExtractionModel()!;

describe("frozen EXTRACT_VOICE_FACTS body (transcript-extraction-request.13.1)", () => {
  it("has the exact key order, the store/stream literals, its own prompt, schema, temperature and cap, and only the minimum user message", () => {
    const { body, bodyText } = buildTranscriptExtractionBody(REQUEST, model())!;
    expect(Object.keys(body)).toEqual(["model", "stream", "store", "instructions", "input", "reasoning", "text", "temperature", "max_output_tokens"]);
    expect(body).toMatchObject({ model: "deepseek-flash", stream: false, store: false, instructions: TRANSCRIPT_EXTRACTION_PROMPT, reasoning: { effort: "none" }, temperature: 0, max_output_tokens: 1536 });
    const message = JSON.parse((body.input as { content: { text: string }[] }[])[0]!.content[0]!.text);
    expect(Object.keys(message)).toEqual(["locale", "allowedFactKinds", "transcript"]);
    expect(message.transcript).toBe(REQUEST.transcript);
    expect(bodyText).not.toMatch(/recordId|profile|medicine[A-Z]|history|HACKATHON_DEMO/);
    expect(TRANSCRIPT_EXTRACTION_TEMPERATURE).toBe(0);
    expect(TRANSCRIPT_EXTRACTION_REQUEST_PROFILE).toBe("transcript-extraction-request.13.1");
    expect(TRANSCRIPT_EXTRACTION_PROMPT_VERSION).toBe("transcript-extraction-prompt.13.1");
  });

  it("pins the prompt, the body bytes and the contract digest (any change needs a new version and a new qualification record)", () => {
    expect(sha(TRANSCRIPT_EXTRACTION_PROMPT)).toBe("e61156da83487030ce9f5ff6fbf2a078af25041fb5c95f7e1c4b25dd96f0592f");
    expect(sha(buildTranscriptExtractionBody(REQUEST, model())!.bodyText)).toBe("87bf4c8ec4b0db7041c121d6b9dfa413b80f808fe8fa32e0b85987abaad4524b");
    // Recheck 6 (validator 13.3, lexicon 13.3: counterfactual cues): the digest changes; prompt and body bytes are unchanged.
    expect(transcriptExtractionContractDigest()).toBe("c42e1ec3f560be914d59d4050228f0f1e192ba0ac54b4cb8a42e8c705bda0d79");
  });
});

describe("pre-send upper bound", () => {
  it("counts every body byte as an input token plus the margin and the full output cap at peak prices", () => {
    expect(transcriptExtractionCallUpperBound(10_000)).toEqual({ inputTokens: 10_256, outputTokens: 1_536, costMicroUsd: 4_920, basis: "UPPER_BOUND" });
  });

  it("the largest request (1,200 Chinese code points, every kind) stays below 6,000 micro-USD per call", () => {
    const largest: ExtractionRequest = { ...REQUEST, locale: "zh-SG", transcript: "血".repeat(1_200), allowedFactKinds: ["GLUCOSE_READING", "MEAL_OR_FOOD_NOTE", "MEDICINE_OCCURRENCE"] };
    const bytes = new TextEncoder().encode(buildTranscriptExtractionBody(largest, model())!.bodyText).byteLength;
    const bound = transcriptExtractionCallUpperBound(bytes);
    expect(bound.costMicroUsd).toBeLessThan(6_000);
    expect(bound.outputTokens).toBe(TRANSCRIPT_EXTRACTION_MAX_OUTPUT_TOKENS);
  });
});

function envelope(text: string, patch: Record<string, unknown> = {}) {
  return { id: "resp_x", status: "completed", model: "deepseek-flash", store: false, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }], usage: { input_tokens: 2_000, output_tokens: 120 }, ...patch };
}
function fakeFetch(respond: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  return { calls, fetcher: async (url: string, init: RequestInit) => (calls.push({ url, init }), respond()) };
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const invoke = (fetcher: (url: string, init: RequestInit) => Promise<Response>, m = model()) => invokeTranscriptExtraction({ request: REQUEST, token: SYNTHETIC_TOKEN, model: m, signal: new AbortController().signal, fetcher });

describe("transport (fake fetch)", () => {
  it("sends one POST with the bearer credential to the documented endpoint and returns the strictly parsed candidate", async () => {
    const fake = fakeFetch(() => json(envelope('{"facts":[],"unsupportedSpans":[]}')));
    const result = await invoke(fake.fetcher);
    expect(result).toEqual({ kind: "COMPLETED", candidate: { facts: [], unsupportedSpans: [] }, usage: { inputTokens: 2_000, outputTokens: 120, costMicroUsd: 744, credits: null, basis: "REPORTED" }, retention: "CONFIRMED_NOT_STORED" });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.url).toBe("https://api.deepseek.com/responses");
    expect((fake.calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${SYNTHETIC_TOKEN}`);
  });

  it("refuses stored, truncated, other-model, multi-output and non-completed responses, each with the reported usage", async () => {
    const cases = [
      envelope("{}", { store: true }),
      envelope("{}", { usage: { input_tokens: 10, output_tokens: 1_536 } }),
      envelope("{}", { incomplete_details: { reason: "max_output_tokens" } }),
      envelope("{}", { model: "deepseek-pro" }),
      envelope("{}", { status: "incomplete" }),
      { ...envelope("{}"), output: [] },
    ];
    for (const body of cases) {
      const result = await invoke(fakeFetch(() => json(body)).fetcher);
      expect(result.kind).toBe("FAILED");
      expect(result.kind === "FAILED" && result.usage?.basis).toBe("REPORTED");
    }
  });

  it("an HTTP error, unreadable JSON or a transport failure counts the body's upper bound, never zero", async () => {
    for (const fetcher of [fakeFetch(() => json({ error: "x" }, 429)).fetcher, fakeFetch(() => new Response("not json", { status: 200 })).fetcher, async () => Promise.reject(new Error("socket"))]) {
      const result = await invoke(fetcher);
      expect(result.kind).toBe("FAILED");
      expect(result.kind === "FAILED" && result.usage?.basis).toBe("UPPER_BOUND");
      expect(result.kind === "FAILED" && (result.usage?.costMicroUsd ?? 0)).toBeGreaterThan(0);
    }
  });

  it("never sends when the model's endpoint is not the documented one (no usage), and malformed output text goes to the validator unparsed", async () => {
    const fake = fakeFetch(() => json(envelope("{}")));
    expect(await invoke(fake.fetcher, { ...model(), endpoint: "https://elsewhere.example/responses" })).toEqual({ kind: "FAILED", reason: "MISSING_CONFIGURATION" });
    expect(fake.calls).toHaveLength(0);
    const malformed = await invoke(fakeFetch(() => json(envelope('{"facts":[],"facts":[]}'))).fetcher);
    expect(malformed).toMatchObject({ kind: "COMPLETED", candidate: '{"facts":[],"facts":[]}' });
  });
});
