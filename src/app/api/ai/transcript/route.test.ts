// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { AI_ACTIVATION_MANIFEST, type AiActivationManifest } from "@/application/ai/ai-activation-manifest";
import { TRANSCRIPT_EXTRACTION_QUALIFICATION_RECORDS, transcriptExtractionGate } from "@/application/transcript-extraction/transcript-extraction-qualification";
import { transcriptRedirect } from "@/application/transcript-extraction/transcript-extraction-redirect";
import { transcriptExtractionResponseSchema } from "@/application/transcript-extraction/transcript-extraction-route-contract";
import { transcriptExtractionContractDigest } from "@/ai/transcript-extraction/transcript-extraction-request";
import type { SpendLedger } from "../shell/ai-spend-ledger";
import { TRANSCRIPT_EXTRACTION_ENV, createTranscriptExtractionHandler, transcriptExtractionDailySpendLimitMicroUsd, type TranscriptExtractionHandlerOptions } from "./transcript-extraction-handler";

/**
 * Packet 13 (P13X): POST /api/ai/transcript with fake transport, test-only activation and test-only qualification. No live call.
 * Synthetic transcripts and synthetic configuration values only.
 */

const ORIGIN = "http://localhost:3000";
const PASSCODE = "synthetic-pass-01";
const TOKEN = "synthetic-token-not-a-key-77a";
// No dose term: the voice slice's redirect classifier redirects "units" next to a medicine noun ("pen") before any call.
const TRANSCRIPT = "Sugar 6.5 before breakfast, took the grey pen";
const ENV = {
  JAGAON_REMOTE_AI: "on",
  JAGAON_AI_TRANSCRIPT_EXTRACTION: "on",
  JAGAON_AI_ALLOWED_ORIGINS: ORIGIN,
  JAGAON_AI_DEMO_PASSCODE: PASSCODE,
  JAGAON_AI_TRANSCRIPT_DAILY_SPEND_LIMIT_USD: "1",
  DEEPSEEK_API_KEY: TOKEN,
};
const ACTIVE: AiActivationManifest = { ...AI_ACTIVATION_MANIFEST, tasks: { ...AI_ACTIVATION_MANIFEST.tasks, EXTRACT_VOICE_FACTS: "SYNTHETIC_REMOTE_ENABLED" } as AiActivationManifest["tasks"] };
const TEST_ONLY_QUALIFIED = transcriptExtractionGate([{ taskType: "EXTRACT_VOICE_FACTS", contractDigest: transcriptExtractionContractDigest(), status: "QUALIFIED", evidenceRef: "test-only", signedOffBy: "test-only", signedOffAt: "2026-10-09T00:00:00.000Z" }]);

const GOOD_OUTPUT = {
  facts: [
    { kind: "GLUCOSE_READING", sourceSpan: { start: 0, end: 26, text: "Sugar 6.5 before breakfast" }, value: "6.5", unit: null, status: null, negated: false, uncertain: false, unresolvedPhrase: null },
    { kind: "MEDICINE_OCCURRENCE", sourceSpan: { start: 28, end: 45, text: "took the grey pen" }, value: null, unit: null, status: "TAKEN", negated: false, uncertain: false, unresolvedPhrase: "grey pen" },
  ],
  unsupportedSpans: [],
};

function envelope(output: unknown) {
  return { status: "completed", model: "deepseek-flash", store: false, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(output) }] }], usage: { input_tokens: 3_000, output_tokens: 200 } };
}

function spyLedger(): SpendLedger & { events: string[] } {
  const events: string[] = [];
  const token = Object.freeze({}) as never;
  return {
    events,
    reserve: async (amount: number) => (events.push(`reserve:${amount > 0}`), { kind: "RESERVED", token }),
    commit: async (_token, billed, basis) => void events.push(`commit:${basis}:${billed > 0}`),
    release: async () => void events.push("release"),
  };
}

type Setup = Partial<TranscriptExtractionHandlerOptions> & { respond?: () => Promise<Response> | Response };
function setup(overrides: Setup = {}) {
  const reads: string[] = [];
  const environment = new Proxy({ ...ENV, ...(overrides.environment ?? {}) }, { get: (target, name: string) => (reads.push(name), (target as Record<string, string>)[name]) });
  const calls: string[] = [];
  const ledger = spyLedger();
  const handle = createTranscriptExtractionHandler({
    activationManifest: ACTIVE,
    gate: TEST_ONLY_QUALIFIED,
    spendLedger: ledger,
    fetcher: async (url) => (calls.push(url), overrides.respond ? overrides.respond() : new Response(JSON.stringify(envelope(GOOD_OUTPUT)), { status: 200 })),
    ...overrides,
    environment,
  });
  return { handle, reads, calls, ledger };
}

function post(body: unknown, headers: Record<string, string> = {}, init: RequestInit = {}) {
  return new Request(`${ORIGIN}/api/ai/transcript`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, "sec-fetch-site": "same-origin", "x-jagaon-demo-passcode": PASSCODE, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init,
  });
}
const request = (transcript = TRANSCRIPT, extra: Record<string, unknown> = {}) => ({ taskType: "EXTRACT_VOICE_FACTS", contractVersion: "transcript-extraction.13.1", locale: "en-SG", transcript, allowedFactKinds: ["GLUCOSE_READING", "MEAL_OR_FOOD_NOTE", "MEDICINE_OCCURRENCE"], ...extra });
async function read(response: Response) {
  const body = await response.json();
  expect(transcriptExtractionResponseSchema.safeParse(body).success, JSON.stringify(body)).toBe(true);
  return { status: response.status, body };
}

afterEach(() => vi.restoreAllMocks());

describe("Packet 13 /api/ai/transcript: shipped state", () => {
  it("the shipped handler (shipped manifest and gate) refuses before any credential read or provider call", async () => {
    const { handle, reads, calls } = setup({ activationManifest: undefined, gate: undefined });
    expect(await read(await handle(post(request())))).toEqual({ status: 403, body: { kind: "REFUSED", reason: "TASK_NOT_ACTIVATED", notSentToProvider: true } });
    expect(reads).not.toContain("DEEPSEEK_API_KEY");
    expect(calls).toHaveLength(0);
  });

  it("with the task activated but the shipped PENDING record, it refuses EXTRACTION_NOT_QUALIFIED; the record names the current contract digest", async () => {
    const { handle, calls } = setup({ gate: undefined });
    expect((await read(await handle(post(request())))).body).toEqual({ kind: "REFUSED", reason: "EXTRACTION_NOT_QUALIFIED", notSentToProvider: true });
    expect(calls).toHaveLength(0);
    expect(TRANSCRIPT_EXTRACTION_QUALIFICATION_RECORDS).toEqual([{ taskType: "EXTRACT_VOICE_FACTS", contractDigest: transcriptExtractionContractDigest(), status: "PENDING", evidenceRef: null, signedOffBy: null, signedOffAt: null }]);
  });
});

describe("Packet 13 /api/ai/transcript: check order, all before the credential read", () => {
  const cases: [string, Setup, Record<string, string>, string][] = [
    ["remote AI switch off", { environment: { JAGAON_REMOTE_AI: "off" } }, {}, "REMOTE_AI_DISABLED"],
    ["extraction switch off", { environment: { JAGAON_AI_TRANSCRIPT_EXTRACTION: "" } }, {}, "EXTRACTION_DISABLED"],
    ["origin", {}, { origin: "https://elsewhere.example" }, "ORIGIN_REJECTED"],
    ["cross-site fetch", {}, { "sec-fetch-site": "cross-site" }, "ORIGIN_REJECTED"],
    ["passcode", {}, { "x-jagaon-demo-passcode": "wrong-passcode" }, "ACCESS_DENIED"],
    ["not activated", { activationManifest: AI_ACTIVATION_MANIFEST }, {}, "TASK_NOT_ACTIVATED"],
    ["registered DETERMINISTIC_ONLY (the queued Q13X-1 state)", { activationManifest: { ...AI_ACTIVATION_MANIFEST, separateTasks: { EXTRACT_VOICE_FACTS: "DETERMINISTIC_ONLY" } } as AiActivationManifest }, {}, "TASK_NOT_ACTIVATED"],
    ["other profile", { releaseProfile: "PATIENT_RELEASE" }, {}, "TASK_NOT_ACTIVATED"],
    ["not qualified", { gate: transcriptExtractionGate([]) }, {}, "EXTRACTION_NOT_QUALIFIED"],
    ["spend not configured", { environment: { JAGAON_AI_TRANSCRIPT_DAILY_SPEND_LIMIT_USD: "" } }, {}, "SPEND_NOT_CONFIGURED"],
    ["spend malformed", { environment: { JAGAON_AI_TRANSCRIPT_DAILY_SPEND_LIMIT_USD: "1.0000001" } }, {}, "SPEND_NOT_CONFIGURED"],
    ["spend zero", { environment: { JAGAON_AI_TRANSCRIPT_DAILY_SPEND_LIMIT_USD: "0" } }, {}, "SPEND_NOT_CONFIGURED"],
    // Owner #5: the shell's limit never configures this route; the two counters are separate.
    ["only the shell's spend limit set", { environment: { JAGAON_AI_TRANSCRIPT_DAILY_SPEND_LIMIT_USD: undefined, JAGAON_AI_DAILY_SPEND_LIMIT_USD: "5" } }, {}, "SPEND_NOT_CONFIGURED"],
  ];
  for (const [name, overrides, headers, reason] of cases) {
    it(`${name} → REFUSED ${reason}, not sent, credential unread`, async () => {
      const { handle, reads, calls } = setup(overrides);
      expect(await read(await handle(post(request(), headers)))).toEqual({ status: 403, body: { kind: "REFUSED", reason, notSentToProvider: true } });
      expect(reads).not.toContain("DEEPSEEK_API_KEY");
      expect(calls).toHaveLength(0);
    });
  }

  it("refuses the spend ceiling with the real per-instance ledger", async () => {
    const { handle, calls } = setup({ spendLedger: undefined, environment: { JAGAON_AI_TRANSCRIPT_DAILY_SPEND_LIMIT_USD: "0.000001" } });
    expect((await read(await handle(post(request())))).body).toEqual({ kind: "REFUSED", reason: "SPEND_CEILING_REACHED", notSentToProvider: true });
    expect(calls).toHaveLength(0);
  });

  it("owner #5: this route's own limit is used even when the shell's limit is tiny (two counters, not one cap)", async () => {
    const { handle, calls } = setup({ spendLedger: undefined, environment: { JAGAON_AI_DAILY_SPEND_LIMIT_USD: "0.000001" } });
    expect((await read(await handle(post(request())))).body).toMatchObject({ kind: "EXTRACTED" });
    expect(calls).toHaveLength(1);
    expect(TRANSCRIPT_EXTRACTION_ENV.dailySpendLimitUsd).toBe("JAGAON_AI_TRANSCRIPT_DAILY_SPEND_LIMIT_USD");
    expect(["1", "0.5", "999999.999999"].map((value) => transcriptExtractionDailySpendLimitMicroUsd({ JAGAON_AI_TRANSCRIPT_DAILY_SPEND_LIMIT_USD: value }))).toEqual([1_000_000, 500_000, 999_999_999_999]);
    expect(["", "0", "-1", "1e3", "1.0000001", " 1", "abc"].map((value) => transcriptExtractionDailySpendLimitMicroUsd({ JAGAON_AI_TRANSCRIPT_DAILY_SPEND_LIMIT_USD: value }))).toEqual([null, null, null, null, null, null, null]);
    expect(transcriptExtractionDailySpendLimitMicroUsd({ JAGAON_AI_DAILY_SPEND_LIMIT_USD: "1" })).toBeNull();
  });

  it("a dose or treatment question is redirected before anything else, even with every switch off; nothing is read or sent", async () => {
    const question = "How many units of insulin should I take?";
    expect(transcriptRedirect("en-SG")(question)).toBe(true);
    expect(transcriptRedirect("zh-SG")("我应该打几个单位的胰岛素？")).toBe(true);
    const { handle, reads, calls } = setup({ environment: { JAGAON_REMOTE_AI: "off" } });
    expect(await read(await handle(post(request(question))))).toEqual({ status: 403, body: { kind: "REFUSED", reason: "REDIRECT_REQUIRED", notSentToProvider: true } });
    expect(reads).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("review CRITICAL 2: code-switched treatment questions are redirected in either locale, before anything is read or sent", async () => {
    const cases: [string, "en-SG" | "zh-SG"][] = [
      ["Sugar 15 要不要加 insulin", "en-SG"],
      ["我应该打几个单位", "en-SG"],
      ["血糖十五 should I take more insulin", "zh-SG"],
      ["How many units should I inject", "zh-SG"],
      ["I wonder whether to inject more", "en-SG"],
      ["need to see doctor or not", "en-SG"],
    ];
    for (const [transcript, locale] of cases) {
      const { handle, reads, calls } = setup({ environment: { JAGAON_REMOTE_AI: "off" } });
      expect(await read(await handle(post(request(transcript, { locale })))), transcript).toEqual({ status: 403, body: { kind: "REFUSED", reason: "REDIRECT_REQUIRED", notSentToProvider: true } });
      expect([reads, calls.length], transcript).toEqual([[], 0]);
    }
  });

  it("the voice slice's gate withholds the whole transcript route-side too: zero calls, nothing read", async () => {
    const { handle, reads, calls } = setup();
    for (const transcript of ["My sugar is 15, is that dangerous?", "血糖十五要不要加量？"]) {
      const locale = /[㐀-鿿]/.test(transcript) ? "zh-SG" : "en-SG";
      expect(await read(await handle(post(request(transcript, { locale }))))).toEqual({ status: 403, body: { kind: "REFUSED", reason: "REDIRECT_REQUIRED", notSentToProvider: true } });
    }
    expect(reads).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("request checks: method, content type, size, strict schema (no journal, medicine or profile data)", async () => {
    const { handle, calls } = setup();
    expect((await handle(new Request(`${ORIGIN}/api/ai/transcript`, { method: "GET" }))).status).toBe(405);
    expect((await handle(post(request(), { "content-type": "text/plain" }))).status).toBe(415);
    expect((await handle(post({ ...request(), transcript: "x".repeat(9_000) }))).status).toBe(413);
    for (const extra of [{ medicines: ["metformin"] }, { recordIds: ["r1"] }, { profile: "HACKATHON_DEMO" }]) {
      expect(await read(await handle(post(request(TRANSCRIPT, extra))))).toEqual({ status: 400, body: { kind: "FAILED", reason: "PAYLOAD_INVALID", notSentToProvider: true } });
    }
    expect(calls).toHaveLength(0);
  });
});

describe("Packet 13 /api/ai/transcript: one bounded call (test-only activation and qualification, fake transport)", () => {
  it("returns the validated facts and commits the reported cost", async () => {
    const { handle, calls, ledger } = setup();
    const { status, body } = await read(await handle(post(request())));
    expect(status).toBe(200);
    expect(body).toMatchObject({ kind: "EXTRACTED", retention: "CONFIRMED_NOT_STORED", usage: { basis: "REPORTED", inputTokens: 3_000, outputTokens: 200 } });
    expect(body.output).toEqual(GOOD_OUTPUT);
    expect(calls).toEqual(["https://api.deepseek.com/responses"]);
    expect(ledger.events).toEqual(["reserve:true", "commit:REPORTED:true"]);
  });

  it("a model output that breaks an r-rule is REJECTED with its closed reason and never returned", async () => {
    const bad = { ...GOOD_OUTPUT, facts: [{ ...GOOD_OUTPUT.facts[1], value: "12" }], unsupportedSpans: [{ start: 0, end: 26, text: "Sugar 6.5 before breakfast" }] };
    const { handle } = setup({ respond: () => new Response(JSON.stringify(envelope(bad)), { status: 200 }) });
    const { body } = await read(await handle(post(request())));
    expect(body).toMatchObject({ kind: "REJECTED", reason: "VALUE_NOT_IN_SPAN", usage: { basis: "REPORTED" } });
    expect(JSON.stringify(body)).not.toContain("grey pen");
  });

  it("missing credential: FAILED not sent, reservation released; provider 429: FAILED with the upper bound committed", async () => {
    const missing = setup({ environment: { DEEPSEEK_API_KEY: "" } });
    expect((await read(await missing.handle(post(request())))).body).toEqual({ kind: "FAILED", reason: "MISSING_CONFIGURATION", notSentToProvider: true });
    expect(missing.calls).toHaveLength(0);
    expect(missing.ledger.events).toEqual(["reserve:true", "release"]);

    const limited = setup({ respond: () => new Response("{}", { status: 429 }) });
    expect((await read(await limited.handle(post(request())))).body).toMatchObject({ kind: "FAILED", reason: "PROVIDER_RATE_LIMITED", usage: { basis: "UPPER_BOUND" } });
    expect(limited.ledger.events).toEqual(["reserve:true", "commit:UPPER_BOUND:true"]);
  });

  it("times out one call at its ceiling and counts it at the upper bound; the route rate limit refuses the eleventh call unsent", async () => {
    const slow = setup({ timeoutMs: 20, respond: () => new Promise<Response>(() => undefined) });
    expect((await read(await slow.handle(post(request())))).body).toMatchObject({ kind: "FAILED", reason: "PROVIDER_TIMEOUT", usage: { basis: "UPPER_BOUND" } });
    const limited = setup({ rateLimit: { maxRequests: 1, windowMs: 60_000 } });
    await limited.handle(post(request()));
    expect((await read(await limited.handle(post(request())))).body).toEqual({ kind: "FAILED", reason: "PROVIDER_RATE_LIMITED", notSentToProvider: true });
    expect(limited.calls).toHaveLength(1);
  });

  it("the transcript stays in memory: never logged, and absent from every non-EXTRACTED response", async () => {
    const logs = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
    const planted = TRANSCRIPT;
    const runs: Setup[] = [
      { environment: { JAGAON_REMOTE_AI: "off" } },
      { gate: transcriptExtractionGate([]) },
      { respond: () => new Response("{}", { status: 500 }) },
      { respond: () => new Response(JSON.stringify(envelope({ facts: [], unsupportedSpans: [] })), { status: 200 }) },
      { respond: () => Promise.reject(new Error(planted)) },
    ];
    for (const overrides of runs) {
      const { handle } = setup(overrides);
      const text = await (await handle(post(request(planted)))).text();
      expect(text).not.toContain("grey pen");
      expect(text).not.toContain(TOKEN);
    }
    for (const spy of logs) expect(spy).not.toHaveBeenCalled();
  });
});
