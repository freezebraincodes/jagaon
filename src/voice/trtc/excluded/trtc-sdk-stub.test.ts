// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { voiceDisclosureReducer, VOICE_DISCLOSURE_INITIAL_STATE } from "@/application/voice/voice-cloud-disclosure";
import { createTrtcTranscriberAdapter } from "../trtc-transcriber-adapter";
import TRTC_STUB from "./trtc-sdk-stub";
import { RealtimeTranscriber } from "./realtime-transcriber-stub";

/**
 * Owner-approved Tencent build-time exclusion (2026-10-11): the stubs the excluded build aliases the TRTC SDK packages to. They hold no
 * Tencent code, and if the TRTC adapter ever loaded them it ends cleanly "unsupported" before any credential request (never a crash).
 */
describe("TRTC SDK stubs for an excluded build", () => {
  it("make the real TRTC adapter end UNSUPPORTED_BROWSER before any credential request", async () => {
    const accepted = voiceDisclosureReducer(voiceDisclosureReducer(VOICE_DISCLOSURE_INITIAL_STATE, { type: "REQUEST_START", language: "en" }), { type: "ACCEPT" });
    if (accepted.kind !== "GRANTED") throw new Error("no grant");
    const store = new Map<string, string>();
    const requestCredential = vi.fn();
    const adapter = createTrtcTranscriberAdapter({
      requestCredential,
      loadSdk: async () => ({ TRTC: TRTC_STUB as never, RealtimeTranscriber: RealtimeTranscriber as never }),
      storage: () => ({ getItem: (key) => store.get(key) ?? null, setItem: (key, value) => void store.set(key, value), removeItem: (key) => void store.delete(key) }),
      locks: () => null,
    });
    const result = await adapter.start({ language: "en", grant: accepted.grant, onSegment: () => undefined, onFailure: () => undefined, signal: new AbortController().signal });
    expect(result).toMatchObject({ kind: "FAILED", reason: "UNSUPPORTED_BROWSER" });
    expect(requestCredential).not.toHaveBeenCalled();
    expect(await TRTC_STUB.isSupported()).toMatchObject({ result: false });
  });

  it("contain no Tencent code or package reference", () => {
    for (const file of ["src/voice/trtc/excluded/trtc-sdk-stub.ts", "src/voice/trtc/excluded/realtime-transcriber-stub.ts"]) {
      const code = readFileSync(join(process.cwd(), file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(code, file).not.toMatch(/trtc-sdk-v5|tencent|rtc-web|qcloud|import\s|require\(|fetch|navigator/i);
    }
  });
});
