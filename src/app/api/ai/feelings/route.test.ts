// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { feelingsChatRouteResponseSchema } from "@/application/feelings-chat/feelings-chat-route-contract";
import { FEELINGS_CHAT_SYSTEM_PROMPT } from "@/domain/feelings-chat/feelings-chat-prompt";
import type { SpendLedger } from "../shell/ai-spend-ledger";
import { FEELINGS_CHAT_ENV, createFeelingsChatHandler, feelingsChatDailySpendLimitMicroUsd, type FeelingsChatHandlerOptions } from "./feelings-chat-handler";

/**
 * Tell JagaOn understands more (design §3.8): POST /api/ai/feelings with a fake transport. No live call. Synthetic chat text and
 * synthetic configuration values only.
 */

const ORIGIN = "http://localhost:3000";
const PASSCODE = "synthetic-pass-01";
const TOKEN = "synthetic-token-not-a-key-77a";
const ENV = {
  JAGAON_REMOTE_AI: "on",
  JAGAON_AI_FEELINGS_CHAT: "on",
  JAGAON_AI_ALLOWED_ORIGINS: ORIGIN,
  JAGAON_AI_DEMO_PASSCODE: PASSCODE,
  JAGAON_AI_FEELINGS_DAILY_SPEND_LIMIT_USD: "1",
  DEEPSEEK_API_KEY: TOKEN,
};
const QUESTION = { kind: "QUESTION", question: "What has been making you feel tired lately?", summary: null, doctorQuestion: null, themes: [], end: false };
const MESSAGES = [{ role: "patient", text: "Feeling tired and a bit worried today." }];
const chat = (extra: Record<string, unknown> = {}) => ({ task: "FEELINGS_CHAT_TURN", turn: 1, maxTurns: 3, messages: MESSAGES, ...extra });

function envelope(output: unknown, overrides: Record<string, unknown> = {}) {
  const text = typeof output === "string" ? output : JSON.stringify(output);
  return { status: "completed", model: "deepseek-flash", store: false, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }], usage: { input_tokens: 2_000, output_tokens: 60 }, ...overrides };
}

function spyLedger(refuse?: "SPEND_CEILING_REACHED" | "SPEND_LEDGER_UNAVAILABLE"): SpendLedger & { events: string[] } {
  const events: string[] = [];
  const token = Object.freeze({}) as never;
  return {
    events,
    reserve: async (amount: number) => (events.push(`reserve:${amount > 0}`), refuse ? { kind: "REFUSED", reason: refuse } : { kind: "RESERVED", token }),
    commit: async (_token, billed, basis) => void events.push(`commit:${basis}:${billed > 0}`),
    release: async () => void events.push("release"),
  };
}

type Setup = Partial<FeelingsChatHandlerOptions> & { respond?: () => Promise<Response> | Response; refuse?: "SPEND_CEILING_REACHED" | "SPEND_LEDGER_UNAVAILABLE" };
function setup(overrides: Setup = {}) {
  const reads: string[] = [];
  const environment = new Proxy({ ...ENV, ...(overrides.environment ?? {}) }, { get: (target, name: string) => (reads.push(name), (target as Record<string, string>)[name]) });
  const calls: { url: string; init: RequestInit }[] = [];
  const ledger = spyLedger(overrides.refuse);
  const handle = createFeelingsChatHandler({
    spendLedger: ledger,
    fetcher: async (url, init) => (calls.push({ url, init }), overrides.respond ? overrides.respond() : new Response(JSON.stringify(envelope(QUESTION)), { status: 200 })),
    ...overrides,
    environment,
  });
  return { handle, reads, calls, ledger };
}

function post(body: unknown, headers: Record<string, string> = {}, init: RequestInit = {}) {
  return new Request(`${ORIGIN}/api/ai/feelings`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, "sec-fetch-site": "same-origin", "x-jagaon-demo-passcode": PASSCODE, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init,
  });
}
async function read(response: Response) {
  const body = await response.json();
  expect(feelingsChatRouteResponseSchema.safeParse(body).success, JSON.stringify(body)).toBe(true);
  return { status: response.status, body };
}

afterEach(() => vi.restoreAllMocks());

describe("/api/ai/feelings: happy path", () => {
  it("answers OK with the validated reply after one call, commits the reported cost, and reads the credential only then", async () => {
    const { handle, reads, calls, ledger } = setup();
    expect(await read(await handle(post(chat())))).toEqual({ status: 200, body: { kind: "OK", reply: QUESTION } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.deepseek.com/responses");
    expect(reads.filter((name) => name === "DEEPSEEK_API_KEY")).toHaveLength(1);
    expect(ledger.events).toEqual(["reserve:true", "commit:REPORTED:true"]);
  });

  it("sends the provider only the system prompt and the chat messages: no readings, medicines, name, dates or IDs", async () => {
    const { handle, calls } = setup();
    await handle(post(chat()));
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown> & { input: { role: string; content: { type: string; text: string }[] }[] };
    expect(Object.keys(body)).toEqual(["model", "stream", "store", "instructions", "input", "reasoning", "text", "temperature", "max_output_tokens"]);
    expect(body.model).toBe("deepseek-flash");
    expect(body.store).toBe(false);
    expect(body.instructions).toBe(FEELINGS_CHAT_SYSTEM_PROMPT);
    expect(body.input).toHaveLength(1);
    expect(body.input[0]!.role).toBe("user");
    expect(body.input[0]!.content).toHaveLength(1);
    expect(JSON.parse(body.input[0]!.content[0]!.text)).toEqual({ turn: 1, maxTurns: 3, messages: MESSAGES });
    // The only app data in the body is the user message above (the fixed system prompt is pinned separately).
    expect(body.input[0]!.content[0]!.text).not.toMatch(/reading|mmol|Lantus|Apidra|recordId|displayName|20\d\d-/i);
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("passes a wrap-up with a doctor question and themes through", async () => {
    const wrapUp = { kind: "WRAP_UP", question: null, summary: "Feeling tired and worried.", doctorQuestion: "I feel tired every day. Is that worth checking?", themes: ["MOOD"], end: true };
    const { handle } = setup({ respond: () => new Response(JSON.stringify(envelope(wrapUp))) });
    expect((await read(await handle(post(chat({ turn: 3 }))))).body).toEqual({ kind: "OK", reply: wrapUp });
  });

  it("owner decision 2026-10-14: a wrap-up whose doctor question alone fails → OK with the summary, no doctor question, closed reasons only", async () => {
    const wrapUp = { kind: "WRAP_UP", question: null, summary: "Feeling tired and worried.", doctorQuestion: "Should I reduce my insulin before bed?", themes: ["MOOD"], end: true };
    const { handle, ledger } = setup({ respond: () => new Response(JSON.stringify(envelope(wrapUp))) });
    const { status, body } = await read(await handle(post(chat({ turn: 3 }))));
    expect(status).toBe(200);
    expect(body).toEqual({ kind: "OK", reply: { ...wrapUp, doctorQuestion: null }, doctorQuestionDropped: ["MEDICINE_ACTION", "DOCTOR_QUESTION_NOT_OWN_WORDS"] });
    expect(JSON.stringify(body)).not.toMatch(/insulin|before bed/);
    expect(ledger.events).toEqual(["reserve:true", "commit:REPORTED:true"]);
  });

  it("a wrap-up whose summary fails is still REJECTED as a whole", async () => {
    const wrapUp = { kind: "WRAP_UP", question: null, summary: "Feeling tired; signs of depression.", doctorQuestion: "Should I reduce my insulin before bed?", themes: [], end: true };
    const { handle } = setup({ respond: () => new Response(JSON.stringify(envelope(wrapUp))) });
    expect((await read(await handle(post(chat({ turn: 3 }))))).body).toEqual({ kind: "REJECTED", reasons: ["MEDICINE_ACTION", "DIAGNOSIS", "DOCTOR_QUESTION_NOT_OWN_WORDS"] });
  });
});

describe("/api/ai/feelings: switches, access and spend, all before the credential read", () => {
  const cases: [string, Setup, Record<string, string>, string][] = [
    ["remote AI switch off", { environment: { JAGAON_REMOTE_AI: "off" } }, {}, "DISABLED"],
    ["remote AI switch missing", { environment: { JAGAON_REMOTE_AI: undefined } }, {}, "DISABLED"],
    ["feelings switch off", { environment: { JAGAON_AI_FEELINGS_CHAT: "off" } }, {}, "DISABLED"],
    ["feelings switch not exactly on", { environment: { JAGAON_AI_FEELINGS_CHAT: "ON" } }, {}, "DISABLED"],
    ["origin", {}, { origin: "https://elsewhere.example" }, "ORIGIN_REJECTED"],
    ["cross-site fetch", {}, { "sec-fetch-site": "cross-site" }, "ORIGIN_REJECTED"],
    ["passcode", {}, { "x-jagaon-demo-passcode": "wrong-passcode" }, "ACCESS_DENIED"],
    ["spend limit missing", { environment: { JAGAON_AI_FEELINGS_DAILY_SPEND_LIMIT_USD: undefined } }, {}, "NOT_CONFIGURED"],
    ["spend limit malformed", { environment: { JAGAON_AI_FEELINGS_DAILY_SPEND_LIMIT_USD: "1.0000001" } }, {}, "NOT_CONFIGURED"],
    ["spend limit zero", { environment: { JAGAON_AI_FEELINGS_DAILY_SPEND_LIMIT_USD: "0" } }, {}, "NOT_CONFIGURED"],
    // Its own counter: another route's limit never configures this route.
    ["only the transcript route's limit set", { environment: { JAGAON_AI_FEELINGS_DAILY_SPEND_LIMIT_USD: undefined, JAGAON_AI_TRANSCRIPT_DAILY_SPEND_LIMIT_USD: "5", JAGAON_AI_DAILY_SPEND_LIMIT_USD: "5" } }, {}, "NOT_CONFIGURED"],
    ["daily spend ceiling reached", { refuse: "SPEND_CEILING_REACHED" }, {}, "SPEND_CEILING_REACHED"],
    ["spend ledger unavailable", { refuse: "SPEND_LEDGER_UNAVAILABLE" }, {}, "SPEND_LEDGER_UNAVAILABLE"],
  ];
  it.each(cases)("%s: 403 UNAVAILABLE, no credential read, no provider call", async (_name, overrides, headers, reason) => {
    const { handle, reads, calls } = setup(overrides);
    expect(await read(await handle(post(chat(), headers)))).toEqual({ status: 403, body: { kind: "UNAVAILABLE", reason } });
    expect(reads).not.toContain("DEEPSEEK_API_KEY");
    expect(calls).toHaveLength(0);
  });

  it("parses its own spend limit with the shared USD format", () => {
    expect(FEELINGS_CHAT_ENV).toEqual({ switch: "JAGAON_AI_FEELINGS_CHAT", dailySpendLimitUsd: "JAGAON_AI_FEELINGS_DAILY_SPEND_LIMIT_USD" });
    expect(feelingsChatDailySpendLimitMicroUsd({ JAGAON_AI_FEELINGS_DAILY_SPEND_LIMIT_USD: "1.00" })).toBe(1_000_000);
    expect(feelingsChatDailySpendLimitMicroUsd({ JAGAON_AI_FEELINGS_DAILY_SPEND_LIMIT_USD: "abc" })).toBeNull();
    expect(feelingsChatDailySpendLimitMicroUsd({})).toBeNull();
  });

  it("no credential: NOT_CONFIGURED after the checks, nothing sent, the reservation released", async () => {
    const { handle, calls, ledger } = setup({ environment: { DEEPSEEK_API_KEY: undefined } });
    expect((await read(await handle(post(chat())))).body).toEqual({ kind: "UNAVAILABLE", reason: "NOT_CONFIGURED" });
    expect(calls).toHaveLength(0);
    expect(ledger.events).toEqual(["reserve:true", "release"]);
  });

  it("with no passcode configured, access is granted without one (the shared optional-passcode rule)", async () => {
    const { handle } = setup({ environment: { JAGAON_AI_DEMO_PASSCODE: undefined } });
    expect((await read(await handle(post(chat(), { "x-jagaon-demo-passcode": "" })))).body.kind).toBe("OK");
  });
});

describe("/api/ai/feelings: bad requests never reach the provider", () => {
  it.each<[string, () => Request, number]>([
    ["GET", () => new Request(`${ORIGIN}/api/ai/feelings`, { method: "GET" }), 405],
    ["a non-JSON content type", () => post(chat(), { "content-type": "text/plain" }), 415],
    ["a declared oversize body", () => post(chat(), { "content-length": "999999" }), 413],
    ["an actual oversize body", () => post(JSON.stringify(chat()).replace("Feeling", "x".repeat(17_000))), 413],
    ["malformed JSON", () => post("{not json"), 400],
    ["duplicate keys", () => post('{"task":"FEELINGS_CHAT_TURN","task":"FEELINGS_CHAT_TURN","turn":1,"maxTurns":3,"messages":[]}'), 400],
    ["an unknown field (readings)", () => post(chat({ readings: [7.2] })), 400],
    ["an unknown message field (name)", () => post(chat({ messages: [{ role: "patient", text: "Tired.", name: "Mdm Tan" }] })), 400],
    ["a message over 600 characters", () => post(chat({ messages: [{ role: "patient", text: "a".repeat(601) }] })), 400],
    ["turn 4", () => post(chat({ turn: 4 })), 400],
  ])("%s → BAD_REQUEST", async (_name, make, status) => {
    const { handle, calls, reads } = setup();
    expect(await read(await handle(make()))).toEqual({ status, body: { kind: "UNAVAILABLE", reason: "BAD_REQUEST" } });
    expect(calls).toHaveLength(0);
    expect(reads).not.toContain("DEEPSEEK_API_KEY");
  });
});

describe("/api/ai/feelings: the model's output and the provider's failures", () => {
  it.each<[string, unknown, string[]]>([
    ["advice", { ...QUESTION, question: "You should take less insulin tonight?" }, ["ADVICE", "MEDICINE_ACTION"]],
    ["a diagnosis", { ...QUESTION, question: "Do you think you might have insomnia?" }, ["DIAGNOSIS"]],
    ["glucose causality", { ...QUESTION, question: "Is your sugar high because you are stressed?" }, ["GLUCOSE_CAUSALITY"]],
    ["invalid JSON", "{ this is not json", ["SCHEMA"]],
    ["an extra field", { ...QUESTION, tip: "rest more" }, ["SCHEMA"]],
    ["an off-list theme", { ...QUESTION, themes: ["DEPRESSION"] }, ["THEMES"]],
  ])("%s → REJECTED with closed reasons only; the reported cost is committed", async (_name, output, reasons) => {
    const { handle, ledger } = setup({ respond: () => new Response(JSON.stringify(envelope(output))) });
    const { status, body } = await read(await handle(post(chat())));
    expect(status).toBe(200);
    expect(body).toEqual({ kind: "REJECTED", reasons });
    expect(JSON.stringify(body)).not.toMatch(/insulin|insomnia|sugar|rest more/);
    expect(ledger.events).toEqual(["reserve:true", "commit:REPORTED:true"]);
  });

  it("a question at the last turn → REJECTED TURN_LIMIT", async () => {
    const { handle } = setup();
    const messages = [{ role: "patient", text: "Tired." }, { role: "jagaon_question", text: "What has been on your mind?" }, { role: "patient", text: "Work." }];
    expect((await read(await handle(post(chat({ turn: 3, messages }))))).body).toEqual({ kind: "REJECTED", reasons: ["TURN_LIMIT"] });
  });

  it.each<[string, () => Response | Promise<Response>, string, string]>([
    ["HTTP 500", () => new Response("{}", { status: 500 }), "UPSTREAM_ERROR", "commit:UPPER_BOUND:true"],
    ["HTTP 429", () => new Response("{}", { status: 429 }), "RATE_LIMITED", "commit:UPPER_BOUND:true"],
    ["HTTP 402 (the provider's credit is used up)", () => new Response("{}", { status: 402 }), "OPERATIONAL_SPEND_LOCKED", "commit:UPPER_BOUND:true"],
    ["HTTP 504", () => new Response("{}", { status: 504 }), "TIMEOUT", "commit:UPPER_BOUND:true"],
    ["HTTP 401", () => new Response("{}", { status: 401 }), "NOT_CONFIGURED", "commit:UPPER_BOUND:true"],
    ["a thrown transport", () => Promise.reject(new Error("socket")), "UPSTREAM_ERROR", "commit:UPPER_BOUND:true"],
    ["a non-JSON envelope", () => new Response("<html>"), "UPSTREAM_ERROR", "commit:UPPER_BOUND:true"],
    ["a stored response", () => new Response(JSON.stringify(envelope(QUESTION, { store: true }))), "UPSTREAM_ERROR", "commit:REPORTED:true"],
    ["another model", () => new Response(JSON.stringify(envelope(QUESTION, { model: "other-model" }))), "UPSTREAM_ERROR", "commit:REPORTED:true"],
    ["a truncated response", () => new Response(JSON.stringify(envelope(QUESTION, { status: "incomplete" }))), "UPSTREAM_ERROR", "commit:REPORTED:true"],
  ])("%s → UNAVAILABLE %s; the call is counted, never as zero", async (_name, respond, reason, settlement) => {
    const { handle, ledger } = setup({ respond });
    expect((await read(await handle(post(chat())))).body).toEqual({ kind: "UNAVAILABLE", reason });
    expect(ledger.events).toEqual(["reserve:true", settlement]);
  });

  it("a provider that never answers → UNAVAILABLE TIMEOUT at the route's own timeout", async () => {
    const { handle } = setup({ timeoutMs: 20, respond: () => new Promise<Response>(() => undefined) });
    expect((await read(await handle(post(chat())))).body).toEqual({ kind: "UNAVAILABLE", reason: "TIMEOUT" });
  });

  it("rate limit: the eleventh call in a minute is RATE_LIMITED without a provider call, and the reservation is released", async () => {
    const at = new Date("2026-10-14T09:00:00.000Z");
    const { handle, calls, ledger } = setup({ now: () => at });
    for (let index = 0; index < 10; index += 1) expect((await read(await handle(post(chat())))).body.kind).toBe("OK");
    expect((await read(await handle(post(chat())))).body).toEqual({ kind: "UNAVAILABLE", reason: "RATE_LIMITED" });
    expect(calls).toHaveLength(10);
    expect(ledger.events.at(-1)).toBe("release");
  });

  it("never logs chat text or the credential", async () => {
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "info")];
    const { handle } = setup({ respond: () => new Response(JSON.stringify(envelope({ ...QUESTION, question: "You should rest?" }))) });
    await handle(post(chat()));
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
