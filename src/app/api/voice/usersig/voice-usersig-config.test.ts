// @vitest-environment node
import { describe, expect, it } from "vitest";
import { VOICE_USERSIG_ENV, parseVoiceUserSigConfig, readTrtcSecretKey, voiceAccessGranted, voiceOriginAllowed } from "./voice-usersig-config";
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
});
