// @vitest-environment node
import { createHmac } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import { Api } from "tls-sig-api-v2";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signTrtcUserSig } from "./voice-usersig-signer";

/**
 * Reference vectors with SYNTHETIC secrets and a frozen clock. The expected values are recomputed INDEPENDENTLY with node:crypto and
 * node:zlib from the documented algorithm (trtc.io/document/34385): HMAC-SHA256 over
 * "TLS.identifier:<id>\nTLS.sdkappid:<n>\nTLS.time:<t>\nTLS.expire:<e>\n", a JSON document with TLS.ver "2.0", deflate, base64, then
 * `+`→`*`, `/`→`-`, `=`→`_`. The installed package ships sample inputs but no expected output, so no official vector was available
 * offline. Generated values are compared, never printed.
 */
const FROZEN = new Date("2026-10-09T05:35:00.000Z");
const FROZEN_SECONDS = Math.floor(FROZEN.getTime() / 1000);
const SECRET = "TEST-ONLY-synthetic-signing-secret-0001";

const CASES = [
  { userId: "a", sdkAppId: 1400000001, expireSeconds: 300 },
  { userId: "jv_abc-12", sdkAppId: 1400000002, expireSeconds: 900 },
  { userId: "jv_ABCDEFGHIJKLMNOPQRSTUVWXYZ_-0", sdkAppId: 2000000003, expireSeconds: 3600 },
] as const;

function decode(userSig: string): Record<string, unknown> {
  const base64 = userSig.replace(/\*/g, "+").replace(/-/g, "/").replace(/_/g, "=");
  return JSON.parse(inflateSync(Buffer.from(base64, "base64")).toString("utf8")) as Record<string, unknown>;
}

function independentSig(userId: string, sdkAppId: number, time: number, expire: number, key: string): string {
  return createHmac("sha256", key).update(`TLS.identifier:${userId}\nTLS.sdkappid:${sdkAppId}\nTLS.time:${time}\nTLS.expire:${expire}\n`).digest("base64");
}

function independentUserSig(userId: string, sdkAppId: number, time: number, expire: number, key: string): string {
  const document = { "TLS.ver": "2.0", "TLS.identifier": userId, "TLS.sdkappid": sdkAppId, "TLS.time": time, "TLS.expire": expire, "TLS.sig": independentSig(userId, sdkAppId, time, expire, key) };
  return deflateSync(Buffer.from(JSON.stringify(document))).toString("base64").replace(/\+/g, "*").replace(/\//g, "-").replace(/=/g, "_");
}

let consoleSpies: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FROZEN);
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method));
});
afterEach(() => {
  for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("TRTC UserSig signer (tls-sig-api-v2@1.0.2)", () => {
  it("uses the named Api export of the CommonJS package", () => {
    expect(typeof Api).toBe("function");
    expect(typeof new Api(1400000001, SECRET).genSig).toBe("function");
  });

  for (const { userId, sdkAppId, expireSeconds } of CASES) {
    it(`matches the independent recomputation (id of ${userId.length} characters, expire ${expireSeconds})`, () => {
      const userSig = signTrtcUserSig({ sdkAppId, secretKey: SECRET, userId, expireSeconds });
      const document = decode(userSig);
      expect(document).toEqual({
        "TLS.ver": "2.0",
        "TLS.identifier": userId,
        "TLS.sdkappid": sdkAppId,
        "TLS.time": FROZEN_SECONDS,
        "TLS.expire": expireSeconds,
        "TLS.sig": independentSig(userId, sdkAppId, FROZEN_SECONDS, expireSeconds, SECRET),
      });
      expect(userSig === independentUserSig(userId, sdkAppId, FROZEN_SECONDS, expireSeconds, SECRET)).toBe(true);
      expect(userSig).toMatch(/^[A-Za-z0-9*_-]+$/);
      expect(userSig.includes(SECRET)).toBe(false);
    });
  }

  it("a different secret gives a different signature (the key is used)", () => {
    const first = decode(signTrtcUserSig({ sdkAppId: 1400000001, secretKey: SECRET, userId: "a", expireSeconds: 300 }));
    const second = decode(signTrtcUserSig({ sdkAppId: 1400000001, secretKey: `${SECRET}-other`, userId: "a", expireSeconds: 300 }));
    expect(first["TLS.sig"] === second["TLS.sig"]).toBe(false);
  });

  it("validates every input before signing, and never puts the secret in an error", () => {
    const valid = { sdkAppId: 1400000001, secretKey: SECRET, userId: "jv_user", expireSeconds: 300 };
    const invalid = [
      { userId: "" },
      { userId: "x".repeat(33) },
      { userId: "has space" },
      { userId: "患者" },
      { expireSeconds: 59 },
      { expireSeconds: 3601 },
      { expireSeconds: 300.5 },
      { sdkAppId: 0 },
      { sdkAppId: 1.5 },
      { sdkAppId: 12345678901 },
      { secretKey: "" },
    ];
    for (const override of invalid) {
      let message = "";
      try {
        signTrtcUserSig({ ...valid, ...override });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message, JSON.stringify(override)).toBe("VOICE_SIGNER_INPUT_INVALID");
    }
  });
});
