// @vitest-environment node
import { describe, expect, it } from "vitest";
import { VOICE_PROVIDERS_ENV, VOICE_USERSIG_ENV, parseVoiceProviders, parseVoiceUserSigConfig, readTrtcSecretKey, voiceAccessGranted, voiceOriginAllowed } from "./voice-usersig-config";
import { TEST_VOICE_ENVIRONMENT, TEST_VOICE_PASSCODE, TEST_VOICE_SECRET, testVoiceHeaders } from "./voice-usersig-test-support";

const without = (name: string) => Object.fromEntries(Object.entries(TEST_VOICE_ENVIRONMENT).filter(([key]) => key !== name));

describe("voice UserSig deployment configuration", () => {
  it("pins the separate voice env names (no AI wording names)", () => {
    expect(VOICE_USERSIG_ENV).toEqual({
      voiceCloud: "JAGAON_VOICE_CLOUD",
      allowedOrigins: "JAGAON_VOICE_ALLOWED_ORIGINS",
      demoPasscode: "JAGAON_VOICE_DEMO_PASSCODE",
      userSigTtlSeconds: "JAGAON_VOICE_USERSIG_TTL_SECONDS",
      maxSessionSeconds: "JAGAON_VOICE_MAX_SESSION_SECONDS",
      dailyMinutesLimit: "JAGAON_VOICE_DAILY_MINUTES_LIMIT",
      sdkAppId: "TRTC_SDK_APP_ID",
      secretKey: "TRTC_SDK_SECRET_KEY",
      trustVercelClientIp: "JAGAON_TRUST_VERCEL_CLIENT_IP",
    });
    expect(Object.isFrozen(VOICE_USERSIG_ENV)).toBe(true);
  });

  it("parses a complete configuration into one frozen object without reading the secret", () => {
    const reads: string[] = [];
    const environment = new Proxy({ ...TEST_VOICE_ENVIRONMENT }, { get: (target, name) => (reads.push(String(name)), target[name as string]) });
    const config = parseVoiceUserSigConfig(environment);
    expect(config).toMatchObject({ voiceEnabled: true, allowedOrigins: ["http://localhost"], userSigTtlSeconds: 300, maxSessionSeconds: 90, dailyMinutesLimit: 10, sdkAppId: 1400000001, trustVercelClientIp: false });
    expect(Object.isFrozen(config)).toBe(true);
    expect(reads).not.toContain(VOICE_USERSIG_ENV.secretKey);
    expect(JSON.stringify(config)).not.toContain(TEST_VOICE_PASSCODE);
  });

  it("missing any value means voice off", () => {
    // The client-address trust flag is optional (off when missing); every other value is required.
    for (const name of Object.values(VOICE_USERSIG_ENV).filter((name) => name !== VOICE_USERSIG_ENV.secretKey && name !== VOICE_USERSIG_ENV.trustVercelClientIp)) {
      expect(parseVoiceUserSigConfig(without(name)), name).toEqual({ voiceEnabled: false });
    }
    expect(parseVoiceUserSigConfig({})).toEqual({ voiceEnabled: false });
  });

  it("an invalid value for each env name means voice off", () => {
    const invalid: Record<string, string[]> = {
      [VOICE_USERSIG_ENV.voiceCloud]: ["ON", "true", "1", " on", ""],
      [VOICE_USERSIG_ENV.allowedOrigins]: ["*", "https://*.example.com", "https://example.com/path", "ftp://example.com", "http://localhost,", "not a url"],
      [VOICE_USERSIG_ENV.demoPasscode]: ["short", "has space inside", "x".repeat(129), "pässcode-unicode"],
      [VOICE_USERSIG_ENV.userSigTtlSeconds]: ["59", "3601", "300.5", "0300", "-300", "3e2", ""],
      [VOICE_USERSIG_ENV.maxSessionSeconds]: ["9", "901", "1.5", "abc"],
      [VOICE_USERSIG_ENV.dailyMinutesLimit]: ["0", "10001", "1e3"],
      [VOICE_USERSIG_ENV.sdkAppId]: ["0", "01400000001", "12345678901", "-1", "1400000001.0", "abc"],
    };
    for (const [name, values] of Object.entries(invalid)) {
      for (const value of values) expect(parseVoiceUserSigConfig({ ...TEST_VOICE_ENVIRONMENT, [name]: value }), `${name}=${value}`).toEqual({ voiceEnabled: false });
    }
    // A throwing environment read is a missing value.
    expect(parseVoiceUserSigConfig(new Proxy({}, { get: () => { throw new Error("boom"); } }))).toEqual({ voiceEnabled: false });
  });

  it("reads the secret only through readTrtcSecretKey, and refuses an invalid one", () => {
    expect(readTrtcSecretKey(TEST_VOICE_ENVIRONMENT)).toBe(TEST_VOICE_SECRET);
    for (const value of [undefined, "", "short", "has a space in the middle of it", "x".repeat(257)]) {
      expect(readTrtcSecretKey({ ...TEST_VOICE_ENVIRONMENT, [VOICE_USERSIG_ENV.secretKey]: value })).toBeNull();
    }
  });

  // Web Speech (owner-approved scope 2026-10-11): JAGAON_VOICE_PROVIDERS.
  it("parses the provider list: unset → TRTC; trtc, webspeech or both in order; anything else → voice off", () => {
    expect(VOICE_PROVIDERS_ENV).toBe("JAGAON_VOICE_PROVIDERS");
    expect(parseVoiceProviders(undefined)).toEqual(["TRTC"]);
    expect(parseVoiceProviders("trtc")).toEqual(["TRTC"]);
    expect(parseVoiceProviders("webspeech")).toEqual(["WEB_SPEECH"]);
    expect(parseVoiceProviders("webspeech,trtc")).toEqual(["WEB_SPEECH", "TRTC"]);
    expect(parseVoiceProviders(" trtc , webspeech ")).toEqual(["TRTC", "WEB_SPEECH"]);
    expect(parseVoiceProviders("trtc,trtc")).toEqual(["TRTC"]);
    for (const value of ["", " ", ",", "trtc,", "TRTC", "WebSpeech", "web-speech", "google", "trtc,fake", "simulated"]) expect(parseVoiceProviders(value), value).toBeNull();
    expect(parseVoiceUserSigConfig(TEST_VOICE_ENVIRONMENT)).toMatchObject({ voiceEnabled: true, providers: ["TRTC"], trtcEnabled: true });
    for (const value of ["", "TRTC", "trtc,google"]) expect(parseVoiceUserSigConfig({ ...TEST_VOICE_ENVIRONMENT, [VOICE_PROVIDERS_ENV]: value }), value).toEqual({ voiceEnabled: false });
    // The master switch still rules every provider.
    expect(parseVoiceUserSigConfig({ ...TEST_VOICE_ENVIRONMENT, [VOICE_PROVIDERS_ENV]: "webspeech", [VOICE_USERSIG_ENV.voiceCloud]: "off" })).toEqual({ voiceEnabled: false });
  });

  it("Web Speech alone needs no TRTC value (none is read); TRTC enabled still requires all of them", () => {
    const trtcNames = [VOICE_USERSIG_ENV.userSigTtlSeconds, VOICE_USERSIG_ENV.dailyMinutesLimit, VOICE_USERSIG_ENV.sdkAppId, VOICE_USERSIG_ENV.secretKey];
    const webOnly: Record<string, string | undefined> = { ...Object.fromEntries(Object.entries(TEST_VOICE_ENVIRONMENT).filter(([key]) => !trtcNames.includes(key as never))), [VOICE_PROVIDERS_ENV]: "webspeech" };
    const reads: string[] = [];
    const config = parseVoiceUserSigConfig(new Proxy(webOnly, { get: (target, name) => (reads.push(String(name)), target[name as string]) }));
    expect(config).toMatchObject({ voiceEnabled: true, providers: ["WEB_SPEECH"], trtcEnabled: false, maxSessionSeconds: 90, allowedOrigins: ["http://localhost"] });
    expect(config).not.toHaveProperty("sdkAppId");
    for (const name of trtcNames) expect(reads, name).not.toContain(name);
    // Invalid TRTC values are irrelevant with Web Speech alone.
    expect(parseVoiceUserSigConfig({ ...webOnly, [VOICE_USERSIG_ENV.sdkAppId]: "abc" })).toMatchObject({ voiceEnabled: true, trtcEnabled: false });
    // The shared values stay required.
    for (const name of [VOICE_USERSIG_ENV.allowedOrigins, VOICE_USERSIG_ENV.demoPasscode, VOICE_USERSIG_ENV.maxSessionSeconds]) {
      expect(parseVoiceUserSigConfig(Object.fromEntries(Object.entries(webOnly).filter(([key]) => key !== name))), name).toEqual({ voiceEnabled: false });
    }
    // Both enabled: a missing TRTC value means voice off for every provider (misconfiguration).
    for (const name of [VOICE_USERSIG_ENV.userSigTtlSeconds, VOICE_USERSIG_ENV.dailyMinutesLimit, VOICE_USERSIG_ENV.sdkAppId]) {
      expect(parseVoiceUserSigConfig({ ...without(name), [VOICE_PROVIDERS_ENV]: "webspeech,trtc" }), name).toEqual({ voiceEnabled: false });
    }
    expect(parseVoiceUserSigConfig({ ...TEST_VOICE_ENVIRONMENT, [VOICE_PROVIDERS_ENV]: "webspeech,trtc" })).toMatchObject({ voiceEnabled: true, providers: ["WEB_SPEECH", "TRTC"], trtcEnabled: true, sdkAppId: 1400000001 });
  });

  it("checks origin (with Sec-Fetch-Site) and the passcode", () => {
    const config = parseVoiceUserSigConfig(TEST_VOICE_ENVIRONMENT);
    expect(voiceOriginAllowed(config, new Headers(testVoiceHeaders()))).toBe(true);
    expect(voiceOriginAllowed(config, new Headers({ ...testVoiceHeaders(), Origin: "http://evil.example" }))).toBe(false);
    expect(voiceOriginAllowed(config, new Headers({ ...testVoiceHeaders(), "Sec-Fetch-Site": "cross-site" }))).toBe(false);
    expect(voiceAccessGranted(config, new Headers(testVoiceHeaders()))).toBe(true);
    expect(voiceAccessGranted(config, new Headers(testVoiceHeaders("TEST-ONLY-wrong-passcode")))).toBe(false);
    expect(voiceAccessGranted(config, new Headers(testVoiceHeaders(null)))).toBe(false);
    expect(voiceAccessGranted(config, new Headers(testVoiceHeaders("x".repeat(1025))))).toBe(false);
    expect(voiceAccessGranted({ voiceEnabled: false }, new Headers(testVoiceHeaders()))).toBe(false);
  });

  // Owner-approved Tencent build-time exclusion (2026-10-11).
  it("an excluded build (JAGAON_BUILD_EXCLUDE_TRTC=1) never enables TRTC, whatever the run-time list says; no TRTC value is read", () => {
    const excluded = { trtcExcludedAtBuild: true } as const;
    const reads: string[] = [];
    const both = new Proxy({ ...TEST_VOICE_ENVIRONMENT, [VOICE_PROVIDERS_ENV]: "trtc,webspeech" } as Record<string, string | undefined>, { get: (target, name) => (reads.push(String(name)), target[name as string]) });
    expect(parseVoiceUserSigConfig(both, excluded)).toMatchObject({ voiceEnabled: true, providers: ["WEB_SPEECH"], trtcEnabled: false });
    for (const name of [VOICE_USERSIG_ENV.userSigTtlSeconds, VOICE_USERSIG_ENV.dailyMinutesLimit, VOICE_USERSIG_ENV.sdkAppId, VOICE_USERSIG_ENV.secretKey]) expect(reads, name).not.toContain(name);
    // Only TRTC listed, or unset (= TRTC): nothing remains, so voice is off.
    expect(parseVoiceUserSigConfig({ ...TEST_VOICE_ENVIRONMENT, [VOICE_PROVIDERS_ENV]: "trtc" }, excluded)).toEqual({ voiceEnabled: false });
    expect(parseVoiceUserSigConfig(TEST_VOICE_ENVIRONMENT, excluded)).toEqual({ voiceEnabled: false });
    expect(parseVoiceUserSigConfig({ ...TEST_VOICE_ENVIRONMENT, [VOICE_PROVIDERS_ENV]: "webspeech" }, excluded)).toMatchObject({ providers: ["WEB_SPEECH"], trtcEnabled: false });
    // A normal build is unchanged (the default, and an explicit false).
    expect(parseVoiceUserSigConfig({ ...TEST_VOICE_ENVIRONMENT, [VOICE_PROVIDERS_ENV]: "trtc,webspeech" })).toMatchObject({ providers: ["TRTC", "WEB_SPEECH"], trtcEnabled: true });
    expect(parseVoiceUserSigConfig({ ...TEST_VOICE_ENVIRONMENT, [VOICE_PROVIDERS_ENV]: "trtc,webspeech" }, { trtcExcludedAtBuild: false })).toMatchObject({ providers: ["TRTC", "WEB_SPEECH"], trtcEnabled: true });
  });
});
