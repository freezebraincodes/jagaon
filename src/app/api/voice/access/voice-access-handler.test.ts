// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { voiceAccessResponseSchema } from "@/voice/trtc/trtc-usersig-contract";
import { VOICE_PROVIDERS_ENV, VOICE_USERSIG_ENV } from "../usersig/voice-usersig-config";
import { TEST_VOICE_ENVIRONMENT, TEST_VOICE_PASSCODE, testVoiceHeaders } from "../usersig/voice-usersig-test-support";
import { createVoiceAccessHandler, type VoiceAccessHandlerOptions } from "./voice-access-handler";

/**
 * Web Speech (owner-approved scope 2026-10-11, W-3): POST /api/voice/access, the passcode-only check. Synthetic TEST-ONLY values; no
 * provider, no credential. Web Speech alone: no TRTC value is configured or read.
 */
const URL_ = "http://localhost/api/voice/access";
const NOW = new Date("2026-10-11T10:00:00.000Z");
const TRTC_NAMES = [VOICE_USERSIG_ENV.userSigTtlSeconds, VOICE_USERSIG_ENV.dailyMinutesLimit, VOICE_USERSIG_ENV.sdkAppId, VOICE_USERSIG_ENV.secretKey] as string[];
const WEB_ONLY: Record<string, string | undefined> = { ...Object.fromEntries(Object.entries(TEST_VOICE_ENVIRONMENT).filter(([key]) => !TRTC_NAMES.includes(key))), [VOICE_PROVIDERS_ENV]: "webspeech" };

function harness(env: Record<string, string | undefined> = WEB_ONLY, overrides: Partial<VoiceAccessHandlerOptions> = {}) {
  const reads: string[] = [];
  const environment = new Proxy({ ...env }, { get: (target, name) => (typeof name === "string" && reads.push(name), typeof name === "string" ? target[name] : undefined) });
  let clock = NOW.getTime();
  const handle = createVoiceAccessHandler({ environment, now: () => new Date(clock), ...overrides });
  return { handle, reads, advance: (ms: number) => (clock += ms) };
}
const post = (init: RequestInit & { headers?: Record<string, string> } = {}) => new Request(URL_, { method: "POST", body: "{}", ...init, headers: init.headers ?? testVoiceHeaders() });
const answer = async (response: Response) => ({ status: response.status, body: voiceAccessResponseSchema.parse(JSON.parse(await response.text())) });

let consoleSpies: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => {
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method));
});
afterEach(() => {
  for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

describe("POST /api/voice/access (Web Speech passcode check; no credential)", () => {
  it("grants with the server's maximum session only; no TRTC value is read; no-store, nosniff", async () => {
    const { handle, reads } = harness();
    const response = await handle(post());
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const text = await response.clone().text();
    expect(await answer(response)).toEqual({ status: 200, body: { kind: "GRANTED", maxSessionSeconds: 90 } });
    expect(text).not.toContain(TEST_VOICE_PASSCODE);
    expect(text).not.toMatch(/userSig|sdkAppId|roomId|userId/);
    for (const name of TRTC_NAMES) expect(reads, name).not.toContain(name);
  });

  it("refuses malformed requests first (405 / 415 / 413 / 400)", async () => {
    const { handle } = harness();
    const cases: Array<[Request, number]> = [
      [new Request(URL_, { method: "GET", headers: testVoiceHeaders() }), 405],
      [post({ headers: { ...testVoiceHeaders(), "content-type": "text/plain" } }), 415],
      [post({ headers: { ...testVoiceHeaders(), "content-length": "300" } }), 413],
      [post({ body: JSON.stringify({ pad: "x".repeat(300) }) }), 413],
      [post({ body: "{" }), 400],
      [post({ body: '{"provider":"TRTC"}' }), 400],
    ];
    for (const [request, status] of cases) expect(await answer(await handle(request))).toEqual({ status, body: { kind: "FAILED", reason: "PAYLOAD_INVALID" } });
  });

  it("refuses VOICE_DISABLED when voice is off, misconfigured, or Web Speech is not an enabled provider", async () => {
    for (const env of <Array<Record<string, string | undefined>>>[
      { ...WEB_ONLY, [VOICE_USERSIG_ENV.voiceCloud]: "off" },
      { ...WEB_ONLY, [VOICE_USERSIG_ENV.demoPasscode]: undefined },
      { ...WEB_ONLY, [VOICE_PROVIDERS_ENV]: "bogus" },
      { ...TEST_VOICE_ENVIRONMENT },
      { ...TEST_VOICE_ENVIRONMENT, [VOICE_PROVIDERS_ENV]: "trtc" },
    ]) {
      expect(await answer(await harness(env).handle(post())), JSON.stringify(env[VOICE_PROVIDERS_ENV] ?? null)).toEqual({ status: 403, body: { kind: "REFUSED", reason: "VOICE_DISABLED" } });
    }
    expect(await answer(await harness({ ...TEST_VOICE_ENVIRONMENT, [VOICE_PROVIDERS_ENV]: "trtc,webspeech" }).handle(post()))).toEqual({ status: 200, body: { kind: "GRANTED", maxSessionSeconds: 90 } });
  });

  it("origin rule: the configured origin AND Sec-Fetch-Site same-origin", async () => {
    const { handle } = harness();
    expect(await answer(await handle(post({ headers: { ...testVoiceHeaders(), Origin: "http://evil.example" } })))).toEqual({ status: 403, body: { kind: "REFUSED", reason: "ORIGIN_REJECTED" } });
    expect(await answer(await handle(post({ headers: { ...testVoiceHeaders(), "Sec-Fetch-Site": "cross-site" } })))).toEqual({ status: 403, body: { kind: "REFUSED", reason: "ORIGIN_REJECTED" } });
  });

  it("passcode: wrong or missing → ACCESS_DENIED; 5 failures in 15 minutes lock out (RATE_LIMITED, even the right passcode) until the window passes", async () => {
    const { handle, advance } = harness();
    expect((await answer(await handle(post({ headers: testVoiceHeaders(null) })))).body).toEqual({ kind: "REFUSED", reason: "ACCESS_DENIED" });
    for (let attempt = 0; attempt < 4; attempt += 1) expect((await answer(await handle(post({ headers: testVoiceHeaders("TEST-ONLY-wrong-passcode") })))).body).toEqual({ kind: "REFUSED", reason: "ACCESS_DENIED" });
    expect(await answer(await handle(post()))).toEqual({ status: 429, body: { kind: "REFUSED", reason: "RATE_LIMITED" } });
    advance(15 * 60_000 + 1);
    expect(await answer(await handle(post()))).toEqual({ status: 200, body: { kind: "GRANTED", maxSessionSeconds: 90 } });
  });

  it("per-instance request rate: RATE_LIMITED after the window's maximum", async () => {
    const { handle } = harness(WEB_ONLY, { rateLimit: { maxRequests: 2, windowMs: 60_000 } });
    expect((await handle(post())).status).toBe(200);
    expect((await handle(post())).status).toBe(200);
    expect(await answer(await handle(post()))).toEqual({ status: 429, body: { kind: "REFUSED", reason: "RATE_LIMITED" } });
  });

  it("the route is minimal: force-dynamic, POST only, one environment read, no signer, no TRTC SDK, no network", () => {
    const strip = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const route = strip(readFileSync(join(process.cwd(), "src/app/api/voice/access/route.ts"), "utf8"));
    expect([...route.matchAll(/export\s+(?:const|async function|function)\s+(\w+)/g)].map((match) => match[1])).toEqual(["dynamic", "POST"]);
    expect(route.match(/process\.env/g)).toHaveLength(1);
    const handler = strip(readFileSync(join(process.cwd(), "src/app/api/voice/access/voice-access-handler.ts"), "utf8"));
    expect(handler).not.toMatch(/process\.env|console\.|\bfetch\b|tls-sig-api-v2|trtc-sdk-v5|signer|readTrtcSecretKey|reserve|runtime\s*=/);
  });

  it("Tencent build-time exclusion: the Web Speech access check still works when run-time settings also (mistakenly) enable TRTC", async () => {
    const env = { ...TEST_VOICE_ENVIRONMENT, [VOICE_PROVIDERS_ENV]: "trtc,webspeech", [VOICE_USERSIG_ENV.secretKey]: undefined };
    expect(await answer(await harness(env, { build: { trtcExcludedAtBuild: true } }).handle(post()))).toEqual({ status: 200, body: { kind: "GRANTED", maxSessionSeconds: 90 } });
  });
});
