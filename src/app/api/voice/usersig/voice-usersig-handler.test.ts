// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { voiceUserSigResponseSchema } from "@/voice/trtc/trtc-usersig-contract";
import { VOICE_PROVIDERS_ENV, VOICE_USERSIG_ENV, parseVoiceUserSigConfig } from "./voice-usersig-config";
import { createVoiceUserSigHandler, type VoiceUserSigHandlerOptions, type VoiceUserSigSigner } from "./voice-usersig-handler";
import { InMemoryDailyMinuteLedger, type VoiceMinuteLedger } from "./voice-minute-ledger";
import { TEST_VOICE_ENVIRONMENT, TEST_VOICE_PASSCODE, TEST_VOICE_SECRET, testVoiceHeaders } from "./voice-usersig-test-support";

const NOW = new Date("2026-10-09T10:00:00.000Z");
const URL_ = "http://localhost/api/voice/usersig";
const SYNTHETIC_SIG = "TEST-ONLY-usersig_value";

function harness(overrides: Partial<VoiceUserSigHandlerOptions> & { env?: Record<string, string | undefined> } = {}) {
  const events: string[] = [];
  const environment = new Proxy({ ...TEST_VOICE_ENVIRONMENT, ...overrides.env } as Record<string, string | undefined>, {
    get: (target, name) => {
      if (typeof name === "string" && name in target) events.push(`env:${name}`);
      return typeof name === "string" ? target[name] : undefined;
    },
  });
  const real = new InMemoryDailyMinuteLedger({ dailyMinutesLimit: Number(TEST_VOICE_ENVIRONMENT[VOICE_USERSIG_ENV.dailyMinutesLimit]) });
  const ledger: VoiceMinuteLedger = {
    reserve: async (minutes, now) => (events.push(`reserve:${minutes}`), real.reserve(minutes, now)),
    release: async (token) => (events.push("release"), real.release(token)),
  };
  const signer = vi.fn<VoiceUserSigSigner>(() => (events.push("sign"), SYNTHETIC_SIG));
  let counter = 0;
  const handle = createVoiceUserSigHandler({
    environment,
    signer,
    now: () => NOW,
    random: (length) => new Uint8Array(length).fill(++counter),
    ledger,
    ...overrides,
  });
  return { handle, events, signer, real };
}

const post = (init: RequestInit & { headers?: Record<string, string> } = {}) => new Request(URL_, { method: "POST", body: "{}", ...init, headers: init.headers ?? testVoiceHeaders() });
const body = async (response: Response) => voiceUserSigResponseSchema.parse(JSON.parse(await response.text()));

let consoleSpies: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => {
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method));
});
afterEach(() => {
  for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

describe("POST /api/voice/usersig handler", () => {
  it("issues one credential after every check, reading the secret only after the reservation", async () => {
    const { handle, events, signer } = harness();
    const response = await handle(post());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const issued = await body(response);
    expect(issued).toMatchObject({ kind: "ISSUED", sdkAppId: 1400000001, userSig: SYNTHETIC_SIG, expiresAt: "2026-10-09T10:05:00.000Z", maxSessionSeconds: 90 });
    if (issued.kind !== "ISSUED") throw new Error("not issued");
    expect(issued.userId).toMatch(/^jv_[A-Za-z0-9_-]{22}$/);
    expect(issued.roomId).toMatch(/^jr_[A-Za-z0-9_-]{32}$/);
    expect(signer).toHaveBeenCalledWith({ sdkAppId: 1400000001, secretKey: TEST_VOICE_SECRET, userId: issued.userId, expireSeconds: 300 });
    const secretRead = events.indexOf(`env:${VOICE_USERSIG_ENV.secretKey}`);
    expect(secretRead).toBeGreaterThan(events.indexOf("reserve:2"));
    expect(events.indexOf("sign")).toBeGreaterThan(secretRead);
    expect(events.filter((event) => event === `env:${VOICE_USERSIG_ENV.secretKey}`)).toHaveLength(1);
  });

  it("refuses malformed requests first (405 / 415 / 413 / 400), before any configuration read", async () => {
    const cases: Array<[Request, number]> = [
      [new Request(URL_, { method: "PUT", headers: testVoiceHeaders() }), 405],
      [post({ headers: { ...testVoiceHeaders(), "content-type": "text/plain" } }), 415],
      [post({ headers: { ...testVoiceHeaders(), "content-length": "300" } }), 413],
      [post({ body: JSON.stringify({ pad: "x".repeat(300) }) }), 413],
      [post({ body: "{" }), 400],
      [post({ body: '{"userId":"patient"}' }), 400],
      [post({ body: "[]" }), 400],
      [post({ body: "" }), 400],
    ];
    for (const [request, status] of cases) {
      const { handle, events, signer } = harness();
      const response = await handle(request);
      expect(response.status, `${request.method} ${status}`).toBe(status);
      expect(await body(response)).toEqual({ kind: "FAILED", reason: "PAYLOAD_INVALID" });
      expect(events).toEqual([]);
      expect(signer).not.toHaveBeenCalled();
    }
  });

  it("refuses in order: switch/config, origin, passcode, rate, minutes; none reads the secret", async () => {
    const refusal = async (h: ReturnType<typeof harness>, request: Request, status: number, reason: string) => {
      const response = await h.handle(request);
      expect(response.status, reason).toBe(status);
      expect(await body(response), reason).toEqual({ kind: "REFUSED", reason });
      expect(h.events, reason).not.toContain(`env:${VOICE_USERSIG_ENV.secretKey}`);
      expect(h.signer, reason).not.toHaveBeenCalled();
    };
    await refusal(harness({ env: { [VOICE_USERSIG_ENV.voiceCloud]: "off" } }), post(), 403, "VOICE_DISABLED");
    await refusal(harness({ env: { [VOICE_USERSIG_ENV.userSigTtlSeconds]: "5" } }), post(), 403, "VOICE_DISABLED");
    // Bad origin AND bad passcode: the origin refusal comes first.
    await refusal(harness(), post({ headers: { ...testVoiceHeaders("TEST-ONLY-wrong"), Origin: "http://evil.example" } }), 403, "ORIGIN_REJECTED");
    await refusal(harness(), post({ headers: { ...testVoiceHeaders(), "Sec-Fetch-Site": "same-site" } }), 403, "ORIGIN_REJECTED");
    await refusal(harness(), post({ headers: testVoiceHeaders("TEST-ONLY-wrong") }), 403, "ACCESS_DENIED");
    await refusal(harness(), post({ headers: testVoiceHeaders(null) }), 403, "ACCESS_DENIED");

    const rated = harness({ rateLimit: { maxRequests: 2, windowMs: 60_000 } });
    expect((await rated.handle(post())).status).toBe(200);
    expect((await rated.handle(post())).status).toBe(200);
    rated.events.length = 0;
    rated.signer.mockClear();
    await refusal(rated, post(), 429, "RATE_LIMITED");
    expect(rated.events).not.toContain("reserve:2");

    // 10 daily minutes, 90 s sessions reserve 2 minutes each: the sixth issuance is refused.
    const metered = harness();
    for (let index = 0; index < 5; index += 1) expect((await metered.handle(post())).status).toBe(200);
    metered.events.length = 0;
    metered.signer.mockClear();
    await refusal(metered, post(), 429, "MINUTES_EXHAUSTED");
  });

  it("a missing secret or a failed signature releases the reservation and issues nothing", async () => {
    const missing = harness({ env: { [VOICE_USERSIG_ENV.secretKey]: undefined } });
    const first = await missing.handle(post());
    expect(first.status).toBe(503);
    expect(await body(first)).toEqual({ kind: "REFUSED", reason: "VOICE_DISABLED" });
    expect(missing.events.slice(-2)).toEqual([`env:${VOICE_USERSIG_ENV.secretKey}`, "release"]);
    expect(missing.real.snapshot(NOW).usedMinutes).toBe(0);

    for (const signer of [() => { throw new Error(`boom ${TEST_VOICE_SECRET}`); }, () => "not a usersig+/=", () => ""]) {
      const failing = harness({ signer: signer as VoiceUserSigSigner });
      const response = await failing.handle(post());
      expect(response.status).toBe(503);
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({ kind: "REFUSED", reason: "VOICE_DISABLED" });
      expect(text).not.toContain(TEST_VOICE_SECRET);
      expect(failing.real.snapshot(NOW).usedMinutes).toBe(0);
    }
  });

  it("fails closed when the ledger throws or answers nonsense", async () => {
    for (const ledger of [{ reserve: async () => { throw new Error("x"); }, release: async () => undefined }, { reserve: async () => ({ kind: "MAYBE" }), release: async () => undefined }]) {
      const h = harness({ ledger: ledger as unknown as VoiceMinuteLedger });
      const response = await h.handle(post());
      expect(response.status).toBe(503);
      expect(await body(response)).toEqual({ kind: "REFUSED", reason: "VOICE_DISABLED" });
      expect(h.events).not.toContain(`env:${VOICE_USERSIG_ENV.secretKey}`);
    }
  });

  it("never returns the secret or the passcode, on any path", async () => {
    const requests = [post(), post({ headers: testVoiceHeaders("TEST-ONLY-wrong") }), post({ body: "{" })];
    for (const request of requests) {
      const text = await (await harness().handle(request)).text();
      expect(text).not.toContain(TEST_VOICE_SECRET);
      expect(text).not.toContain(TEST_VOICE_PASSCODE);
    }
  });

  describe("failed-passcode throttle (owner decision #1: 5 failures per 15 minutes, keyed by client address)", () => {
    const wrong = (ip?: string) => post({ headers: { ...testVoiceHeaders("TEST-ONLY-wrong"), ...(ip ? { "x-real-ip": ip } : {}) } });
    const right = (ip?: string) => post({ headers: { ...testVoiceHeaders(), ...(ip ? { "x-real-ip": ip } : {}) } });
    const trusted = { [VOICE_USERSIG_ENV.trustVercelClientIp]: "on" };

    it("refuses the sixth attempt after five failures, before any passcode check, minute reservation or secret read", async () => {
      let clock = NOW.getTime();
      const h = harness({ now: () => new Date(clock), rateLimit: { maxRequests: 1000, windowMs: 60_000 } });
      for (let attempt = 0; attempt < 5; attempt += 1) expect((await h.handle(wrong())).status, String(attempt)).toBe(403);
      h.events.length = 0;
      const blocked = await h.handle(right());
      expect(blocked.status).toBe(429);
      expect(await body(blocked)).toEqual({ kind: "REFUSED", reason: "RATE_LIMITED" });
      expect(h.events).not.toContain(`env:${VOICE_USERSIG_ENV.secretKey}`);
      expect(h.events.some((event) => event.startsWith("reserve"))).toBe(false);
      expect(h.signer).not.toHaveBeenCalled();
      // The window ends after 15 minutes; a correct passcode then works.
      clock += 15 * 60_000 + 1;
      expect((await h.handle(right())).status).toBe(200);
    });

    it("successful requests are not counted as failures", async () => {
      const h = harness({ rateLimit: { maxRequests: 1000, windowMs: 60_000 } });
      for (let attempt = 0; attempt < 4; attempt += 1) await h.handle(wrong());
      expect((await h.handle(right())).status).toBe(200);
      expect((await h.handle(wrong())).status).toBe(403);
      expect((await h.handle(right())).status).toBe(429);
    });

    it("trust is off by default: forwarded addresses are ignored and every client shares one bucket", async () => {
      const h = harness({ rateLimit: { maxRequests: 1000, windowMs: 60_000 } });
      for (let attempt = 0; attempt < 5; attempt += 1) await h.handle(wrong(`203.0.113.${attempt + 1}`));
      expect((await h.handle(right("198.51.100.7"))).status).toBe(429);
    });

    it("with JAGAON_TRUST_VERCEL_CLIENT_IP=on, a valid platform client address gets its own bucket; an invalid one shares the fallback bucket", async () => {
      const h = harness({ env: trusted, rateLimit: { maxRequests: 1000, windowMs: 60_000 } });
      for (let attempt = 0; attempt < 5; attempt += 1) await h.handle(wrong("203.0.113.9"));
      expect((await h.handle(right("203.0.113.9"))).status).toBe(429);
      expect((await h.handle(right("2001:db8::1"))).status).toBe(200);
      for (const invalid of ["not-an-ip", "203.0.113.9, 198.51.100.1", "", "999.1.1.1"]) await h.handle(wrong(invalid));
      await h.handle(wrong());
      expect((await h.handle(right("not-an-ip"))).status).toBe(429);
      expect((await h.handle(right())).status).toBe(429);
      expect((await h.handle(right("198.51.100.20"))).status).toBe(200);
      // Any other value of the flag is off.
      for (const value of ["true", "ON", "1"]) expect(parseVoiceUserSigConfig({ ...TEST_VOICE_ENVIRONMENT, [VOICE_USERSIG_ENV.trustVercelClientIp]: value })).toMatchObject({ voiceEnabled: true, trustVercelClientIp: false });
    });

    it("keeps the bucket map bounded (oldest bucket evicted)", async () => {
      const h = harness({ env: trusted, rateLimit: { maxRequests: 1000, windowMs: 60_000 }, passcodeThrottle: { maxFailures: 1, windowMs: 15 * 60_000, maxBuckets: 2 } });
      await h.handle(wrong("203.0.113.1"));
      await h.handle(wrong("203.0.113.2"));
      await h.handle(wrong("203.0.113.3"));
      // 203.0.113.1 was evicted (best effort); 203.0.113.3 is still throttled.
      expect((await h.handle(right("203.0.113.1"))).status).toBe(200);
      expect((await h.handle(right("203.0.113.3"))).status).toBe(429);
    });
  });

  it("uses no process environment, logging or provider call in the handler source", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(join(process.cwd(), "src/app/api/voice/usersig/voice-usersig-handler.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(source).not.toMatch(/process\.env|console\.|\bfetch\b|tls-sig-api-v2|trtc-sdk-v5|runtime\s*=/);
  });

  it("review I-5: GET answers { available } only — true only when the switch is on and the configuration valid; no passcode, secret, reservation or signature", async () => {
    const probe = (headers: Record<string, string> = { "Sec-Fetch-Site": "same-origin" }) => new Request(URL_, { method: "GET", headers });
    const answer = async (h: ReturnType<typeof harness>, request: Request) => {
      const response = await h.handle(request);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      return { status: response.status, body: JSON.parse(await response.text()) as unknown };
    };
    const on = harness();
    // Web Speech (deliberate change, 2026-10-11): an available answer also lists the enabled providers (unset → TRTC only).
    // Owner decision 2026-10-12 (optional passcodes; deliberate change): and whether a demo passcode is required (never its value).
    expect(await answer(on, probe())).toEqual({ status: 200, body: { available: true, providers: ["TRTC"], passcodeRequired: true } });
    expect(await answer(on, probe({}))).toEqual({ status: 200, body: { available: true, providers: ["TRTC"], passcodeRequired: true } });
    expect(on.events.filter((event) => event === `env:${VOICE_USERSIG_ENV.secretKey}` || event.startsWith("reserve") || event === "sign")).toEqual([]);
    expect(on.events).not.toContain(`env:${VOICE_USERSIG_ENV.demoPasscode}x`);
    expect(on.signer).not.toHaveBeenCalled();
    // Cross-site, switch off, or an invalid configuration: false, and nothing else is said.
    expect(await answer(harness(), probe({ "Sec-Fetch-Site": "cross-site" }))).toEqual({ status: 200, body: { available: false } });
    expect(await answer(harness({ env: { [VOICE_USERSIG_ENV.voiceCloud]: "off" } }), probe())).toEqual({ status: 200, body: { available: false } });
    expect(await answer(harness({ env: { [VOICE_USERSIG_ENV.userSigTtlSeconds]: "5" } }), probe())).toEqual({ status: 200, body: { available: false } });
    // Rate-limited like the credential request (its own per-instance window).
    const rated = harness({ rateLimit: { maxRequests: 2, windowMs: 60_000 } });
    expect((await answer(rated, probe())).status).toBe(200);
    expect((await answer(rated, probe())).status).toBe(200);
    expect(await answer(rated, probe())).toEqual({ status: 429, body: { available: false } });
    // The probe does not use the credential window: a POST is still issued.
    expect((await rated.handle(post())).status).toBe(200);
  });

  // Web Speech (owner-approved scope 2026-10-11).
  it("Web Speech: the probe lists only the enabled providers in order (no credential); the TRTC POST refuses VOICE_DISABLED without TRTC values", async () => {
    const probe = new Request(URL_, { method: "GET", headers: { "Sec-Fetch-Site": "same-origin" } });
    const json = async (response: Response) => JSON.parse(await response.text()) as unknown;
    expect(await json(await harness({ env: { [VOICE_PROVIDERS_ENV]: "webspeech,trtc" } }).handle(probe.clone()))).toEqual({ available: true, providers: ["WEB_SPEECH", "TRTC"], passcodeRequired: true });
    expect(await json(await harness({ env: { [VOICE_PROVIDERS_ENV]: "trtc,webspeech" } }).handle(probe.clone()))).toEqual({ available: true, providers: ["TRTC", "WEB_SPEECH"], passcodeRequired: true });
    expect(await json(await harness({ env: { [VOICE_PROVIDERS_ENV]: "bogus" } }).handle(probe.clone()))).toEqual({ available: false });
    expect(await json(await harness({ env: { [VOICE_PROVIDERS_ENV]: "webspeech", [VOICE_USERSIG_ENV.voiceCloud]: "off" } }).handle(probe.clone()))).toEqual({ available: false });

    // Web Speech alone: no TTL, minutes, app id or secret configured, the probe is available, the credential POST refuses.
    const webOnly = { [VOICE_PROVIDERS_ENV]: "webspeech", [VOICE_USERSIG_ENV.userSigTtlSeconds]: undefined, [VOICE_USERSIG_ENV.dailyMinutesLimit]: undefined, [VOICE_USERSIG_ENV.sdkAppId]: undefined, [VOICE_USERSIG_ENV.secretKey]: undefined };
    const web = harness({ env: webOnly });
    const probeBody = await json(await web.handle(probe.clone()));
    expect(probeBody).toEqual({ available: true, providers: ["WEB_SPEECH"], passcodeRequired: true });
    // Owner decision 2026-10-12 (optional passcodes): the `passcodeRequired` flag is the only passcode-related field; never a value.
    expect(JSON.stringify(probeBody)).not.toMatch(/sdkAppId|userSig|secret|1400000001/i);
    expect(JSON.stringify(probeBody)).not.toContain(TEST_VOICE_PASSCODE);
    expect(Object.keys(probeBody as object).sort()).toEqual(["available", "passcodeRequired", "providers"]);
    const refusedPost = await web.handle(post());
    expect(refusedPost.status).toBe(403);
    expect(await body(refusedPost)).toEqual({ kind: "REFUSED", reason: "VOICE_DISABLED" });
    expect(web.events.filter((event) => event.startsWith("reserve") || event === "sign" || event === `env:${VOICE_USERSIG_ENV.secretKey}`)).toEqual([]);
    expect(web.signer).not.toHaveBeenCalled();
    // Even with every TRTC value present, Web Speech alone issues no Tencent credential.
    const webWithTrtcValues = harness({ env: { [VOICE_PROVIDERS_ENV]: "webspeech" } });
    expect(await body(await webWithTrtcValues.handle(post()))).toEqual({ kind: "REFUSED", reason: "VOICE_DISABLED" });
    expect(webWithTrtcValues.signer).not.toHaveBeenCalled();
    // Both enabled: the credential is issued exactly as before.
    const both = harness({ env: { [VOICE_PROVIDERS_ENV]: "webspeech,trtc" } });
    expect(await body(await both.handle(post()))).toMatchObject({ kind: "ISSUED" });
  });

  // Owner-approved Tencent build-time exclusion (2026-10-11).
  it("an excluded build: the probe never lists TRTC and the credential POST refuses VOICE_DISABLED, even when run-time settings enable TRTC", async () => {
    const probe = () => new Request(URL_, { method: "GET", headers: { "Sec-Fetch-Site": "same-origin" } });
    const json = async (response: Response) => JSON.parse(await response.text()) as unknown;
    const excluded = harness({ env: { [VOICE_PROVIDERS_ENV]: "trtc,webspeech" }, build: { trtcExcludedAtBuild: true } });
    expect(await json(await excluded.handle(probe()))).toEqual({ available: true, providers: ["WEB_SPEECH"], passcodeRequired: true });
    const refusedPost = await excluded.handle(post());
    expect(refusedPost.status).toBe(403);
    expect(await body(refusedPost)).toEqual({ kind: "REFUSED", reason: "VOICE_DISABLED" });
    expect(excluded.events.filter((event) => event.startsWith("reserve") || event === "sign" || event === `env:${VOICE_USERSIG_ENV.secretKey}`)).toEqual([]);
    expect(excluded.signer).not.toHaveBeenCalled();
    // Only TRTC enabled at run time: nothing is available in an excluded build.
    const trtcOnly = harness({ env: { [VOICE_PROVIDERS_ENV]: "trtc" }, build: { trtcExcludedAtBuild: true } });
    expect(await json(await trtcOnly.handle(probe()))).toEqual({ available: false });
    expect(await body(await trtcOnly.handle(post()))).toEqual({ kind: "REFUSED", reason: "VOICE_DISABLED" });
    // A normal build is unchanged.
    expect(await body(await harness({ env: { [VOICE_PROVIDERS_ENV]: "trtc,webspeech" } }).handle(post()))).toMatchObject({ kind: "ISSUED" });
  });
});

// Owner decision 2026-10-12 (optional passcodes): with no JAGAON_VOICE_DEMO_PASSCODE (missing, empty or whitespace-only) the probe says
// no passcode is required and the credential is issued without one; origin, rate, minutes, the secret-read order and the "never echoed"
// guarantees are unchanged. A configured passcode keeps today's behaviour.
describe("optional voice passcode (Owner decision 2026-10-12, optional passcodes)", () => {
  const probe = () => new Request(URL_, { method: "GET", headers: { "Sec-Fetch-Site": "same-origin" } });
  const json = async (response: Response) => JSON.parse(await response.text()) as unknown;

  it("the probe reports passcodeRequired false when none is configured, true when one is (never the value)", async () => {
    for (const value of [undefined, "", "   "]) {
      expect(await json(await harness({ env: { [VOICE_USERSIG_ENV.demoPasscode]: value } }).handle(probe())), JSON.stringify(value)).toEqual({ available: true, providers: ["TRTC"], passcodeRequired: false });
    }
    const configured = await json(await harness().handle(probe()));
    expect(configured).toEqual({ available: true, providers: ["TRTC"], passcodeRequired: true });
    expect(JSON.stringify(configured)).not.toContain(TEST_VOICE_PASSCODE);
    // A present but invalid passcode: voice is off, nothing else is said.
    expect(await json(await harness({ env: { [VOICE_USERSIG_ENV.demoPasscode]: "short" } }).handle(probe()))).toEqual({ available: false });
  });

  it("no passcode configured: issues the credential without a passcode header, in the same order (secret read last)", async () => {
    const { handle, events, signer } = harness({ env: { [VOICE_USERSIG_ENV.demoPasscode]: "" } });
    const response = await handle(post({ headers: testVoiceHeaders(null) }));
    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({ kind: "ISSUED", sdkAppId: 1400000001, userSig: SYNTHETIC_SIG });
    const secretRead = events.indexOf(`env:${VOICE_USERSIG_ENV.secretKey}`);
    expect(secretRead).toBeGreaterThan(events.indexOf("reserve:2"));
    expect(events.indexOf("sign")).toBeGreaterThan(secretRead);
    expect(signer).toHaveBeenCalledTimes(1);
    // A stray presented value is neither needed nor echoed.
    const stray = await harness({ env: { [VOICE_USERSIG_ENV.demoPasscode]: "" } }).handle(post({ headers: testVoiceHeaders("TEST-ONLY-stray-value") }));
    const text = await stray.text();
    expect(stray.status).toBe(200);
    expect(text).not.toContain("TEST-ONLY-stray-value");
  });

  it("no passcode configured: origin, the switch, the request rate and the daily minutes still refuse, before any secret read", async () => {
    const env = { [VOICE_USERSIG_ENV.demoPasscode]: undefined };
    const origin = harness({ env });
    expect(await body(await origin.handle(post({ headers: { ...testVoiceHeaders(null), Origin: "http://evil.example" } })))).toEqual({ kind: "REFUSED", reason: "ORIGIN_REJECTED" });
    expect(await body(await origin.handle(post({ headers: { ...testVoiceHeaders(null), "Sec-Fetch-Site": "cross-site" } })))).toEqual({ kind: "REFUSED", reason: "ORIGIN_REJECTED" });
    expect(await body(await harness({ env: { ...env, [VOICE_USERSIG_ENV.voiceCloud]: "off" } }).handle(post({ headers: testVoiceHeaders(null) })))).toEqual({ kind: "REFUSED", reason: "VOICE_DISABLED" });
    const rated = harness({ env, rateLimit: { maxRequests: 1, windowMs: 60_000 } });
    expect((await rated.handle(post({ headers: testVoiceHeaders(null) }))).status).toBe(200);
    const limited = await rated.handle(post({ headers: testVoiceHeaders(null) }));
    expect(limited.status).toBe(429);
    expect(await body(limited)).toEqual({ kind: "REFUSED", reason: "RATE_LIMITED" });
    for (const h of [origin]) expect(h.events.filter((event) => event === `env:${VOICE_USERSIG_ENV.secretKey}` || event.startsWith("reserve") || event === "sign")).toEqual([]);
    // The daily minutes (10 minutes, 2 per 90-second session): the sixth session is refused before the secret read.
    const minutes = harness({ env });
    for (let i = 0; i < 5; i += 1) expect((await minutes.handle(post({ headers: testVoiceHeaders(null) }))).status).toBe(200);
    const exhausted = await minutes.handle(post({ headers: testVoiceHeaders(null) }));
    expect(await body(exhausted)).toEqual({ kind: "REFUSED", reason: "MINUTES_EXHAUSTED" });
    expect(minutes.events.filter((event) => event === `env:${VOICE_USERSIG_ENV.secretKey}`)).toHaveLength(5);
  });

  it("a configured passcode is still required (missing or wrong: ACCESS_DENIED, nothing reserved or read)", async () => {
    const { handle, events, signer } = harness();
    expect(await body(await handle(post({ headers: testVoiceHeaders(null) })))).toEqual({ kind: "REFUSED", reason: "ACCESS_DENIED" });
    expect(await body(await handle(post({ headers: testVoiceHeaders("TEST-ONLY-wrong-passcode") })))).toEqual({ kind: "REFUSED", reason: "ACCESS_DENIED" });
    expect(events.filter((event) => event === `env:${VOICE_USERSIG_ENV.secretKey}` || event.startsWith("reserve") || event === "sign")).toEqual([]);
    expect(signer).not.toHaveBeenCalled();
  });
});
