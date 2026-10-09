// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTrtcCredentialClient, fetchVoiceAvailability, type VoiceCredentialFetcher } from "./trtc-credential-client";

const PASSCODE = "TEST-ONLY-voice-passcode";
const ISSUED = { kind: "ISSUED", sdkAppId: 1400000001, userId: "jv_user", userSig: "TEST-ONLY-usersig", roomId: "jr_room", expiresAt: "2026-10-09T10:05:00.000Z", maxSessionSeconds: 90 };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let consoleSpies: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => {
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method));
});
afterEach(() => {
  for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

describe("TRTC credential client", () => {
  it("sends one same-origin POST of {} with the passcode header, no-store, no redirects, and the caller's signal", async () => {
    const fetcher = vi.fn<VoiceCredentialFetcher>(async () => json(ISSUED));
    const signal = new AbortController().signal;
    const result = await createTrtcCredentialClient({ accessPasscode: () => PASSCODE, fetcher })(signal);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith("/api/voice/usersig", { method: "POST", headers: { "content-type": "application/json", "x-jagaon-demo-passcode": PASSCODE }, body: "{}", signal, cache: "no-store", redirect: "error" });
    expect(result).toEqual({ kind: "ISSUED", credential: { sdkAppId: 1400000001, userId: "jv_user", userSig: "TEST-ONLY-usersig", roomId: "jr_room", maxSessionSeconds: 90 } });
  });

  it("maps every closed refusal, whatever its status", async () => {
    for (const [reason, status] of [["VOICE_DISABLED", 403], ["ORIGIN_REJECTED", 403], ["ACCESS_DENIED", 403], ["RATE_LIMITED", 429], ["MINUTES_EXHAUSTED", 429], ["VOICE_DISABLED", 503]] as const) {
      const client = createTrtcCredentialClient({ accessPasscode: () => PASSCODE, fetcher: async () => json({ kind: "REFUSED", reason }, status) });
      expect(await client(new AbortController().signal), reason).toEqual({ kind: "REFUSED", reason });
    }
    const invalid = createTrtcCredentialClient({ accessPasscode: () => PASSCODE, fetcher: async () => json({ kind: "FAILED", reason: "PAYLOAD_INVALID" }, 400) });
    expect(await invalid(new AbortController().signal)).toEqual({ kind: "REFUSED", reason: "PAYLOAD_INVALID" });
  });

  it("treats a network error, an abort, a non-conforming or oversized body, or ISSUED with a non-200 status as a network failure", async () => {
    const bodies: Array<() => Promise<Response>> = [
      async () => {
        throw new TypeError("TEST-ONLY network");
      },
      async () => {
        throw new DOMException("aborted", "AbortError");
      },
      async () => new Response("not json", { status: 200 }),
      async () => json({ ...ISSUED, secretKey: "x" }),
      async () => json({ ...ISSUED, userSig: "a+b/c=" }),
      async () => json({ kind: "REFUSED", reason: "SOMETHING_ELSE" }, 403),
      async () => json(ISSUED, 201),
      async () => new Response(`{"kind":"ISSUED","pad":"${"x".repeat(10_000)}"}`, { status: 200 }),
    ];
    for (const [index, fetcher] of bodies.entries()) {
      const client = createTrtcCredentialClient({ accessPasscode: () => PASSCODE, fetcher });
      expect(await client(new AbortController().signal), String(index)).toEqual({ kind: "FAILED", reason: "NETWORK_FAILURE" });
    }
  });

  it("sends nothing without a passcode and reads the passcode from memory on each request", async () => {
    const fetcher = vi.fn<VoiceCredentialFetcher>(async () => json(ISSUED));
    let passcode: string | null = null;
    const client = createTrtcCredentialClient({ accessPasscode: () => passcode, fetcher });
    expect(await client(new AbortController().signal)).toEqual({ kind: "REFUSED", reason: "ACCESS_DENIED" });
    passcode = "";
    expect(await client(new AbortController().signal)).toEqual({ kind: "REFUSED", reason: "ACCESS_DENIED" });
    expect(fetcher).not.toHaveBeenCalled();
    passcode = "TEST-ONLY-second";
    await client(new AbortController().signal);
    expect((fetcher.mock.calls[0]![1].headers as Record<string, string>)["x-jagaon-demo-passcode"]).toBe("TEST-ONLY-second");
  });

  it("does not send when the signal is already aborted", async () => {
    const fetcher = vi.fn<VoiceCredentialFetcher>(async () => json(ISSUED));
    const abort = new AbortController();
    abort.abort();
    expect(await createTrtcCredentialClient({ accessPasscode: () => PASSCODE, fetcher })(abort.signal)).toEqual({ kind: "FAILED", reason: "NETWORK_FAILURE" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("review I-5: the availability probe is one same-origin GET with no passcode; only a 200 { available: true } is true (fail closed)", async () => {
    const fetcher = vi.fn<VoiceCredentialFetcher>(async () => json({ available: true }));
    expect(await fetchVoiceAvailability({ fetcher })).toBe(true);
    expect(fetcher).toHaveBeenCalledWith("/api/voice/usersig", { method: "GET", cache: "no-store", redirect: "error" });
    const answers: Array<() => Promise<Response>> = [
      async () => json({ available: false }),
      async () => json({ available: true }, 429),
      async () => json({ available: true, extra: 1 }),
      async () => json({ available: "yes" }),
      async () => new Response("not json"),
      async () => new Response("x".repeat(9_000)),
      async () => {
        throw new TypeError("TEST-ONLY network");
      },
    ];
    for (const answer of answers) expect(await fetchVoiceAvailability({ fetcher: answer })).toBe(false);
  });
});
