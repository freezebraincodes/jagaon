// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createVoiceProviderAnswerCheck, createVoiceProviderLoaders, createVoiceProvidersCheck, refuseExcludedTrtc } from "./voice-provider-wiring";
import { loadTrtcTranscriber } from "./load-trtc-transcriber";
import { loadWebSpeechTranscriber } from "./load-web-speech-transcriber";

/** Owner-approved Tencent build-time exclusion (2026-10-11): the client side never offers or loads TRTC in an excluded build. */
describe("voice provider wiring and the Tencent build-time exclusion", () => {
  it("an excluded build drops TRTC from the probe's answer (the panel then says it is not enabled by this deployment)", async () => {
    expect(await createVoiceProvidersCheck(async () => ["TRTC", "WEB_SPEECH"], true)()).toEqual(["WEB_SPEECH"]);
    expect(await createVoiceProvidersCheck(async () => ["TRTC"], true)()).toEqual([]);
    expect(await createVoiceProvidersCheck(async () => ["TRTC", "WEB_SPEECH"], false)()).toEqual(["TRTC", "WEB_SPEECH"]);
    expect(await createVoiceProvidersCheck(async () => Promise.reject(new Error("offline")), false)()).toEqual([]);
  });

  it("an excluded build's TRTC loader refuses (the screen's unavailable path) and never calls the TRTC loader; a normal build is unchanged", async () => {
    const excluded = createVoiceProviderLoaders(true);
    expect(excluded.TRTC).toBe(refuseExcludedTrtc);
    await expect(excluded.TRTC(() => "x")).rejects.toThrow("TRTC_EXCLUDED_AT_BUILD");
    expect(excluded.WEB_SPEECH).toBe(loadWebSpeechTranscriber);
    const normal = createVoiceProviderLoaders(false);
    expect(normal.TRTC).toBe(loadTrtcTranscriber);
    expect(normal.WEB_SPEECH).toBe(loadWebSpeechTranscriber);
    // Outside a Next build the inlined constant is absent: not excluded.
    expect(createVoiceProviderLoaders().TRTC).toBe(loadTrtcTranscriber);
  });

  it("round 6: the answer check tells a failed check apart, filters TRTC in an excluded build, and lists TRTC as known not enabled there", async () => {
    expect(await createVoiceProviderAnswerCheck(async () => ({ kind: "ANSWERED", providers: ["TRTC", "WEB_SPEECH"] }), false)()).toEqual({ kind: "ANSWERED", providers: ["TRTC", "WEB_SPEECH"] });
    expect(await createVoiceProviderAnswerCheck(async () => ({ kind: "ANSWERED", providers: ["TRTC", "WEB_SPEECH"] }), true)()).toEqual({ kind: "ANSWERED", providers: ["WEB_SPEECH"] });
    expect(await createVoiceProviderAnswerCheck(async () => ({ kind: "FAILED" }), false)()).toEqual({ kind: "FAILED", notEnabled: [] });
    expect(await createVoiceProviderAnswerCheck(async () => ({ kind: "FAILED" }), true)()).toEqual({ kind: "FAILED", notEnabled: ["TRTC"] });
    expect(await createVoiceProviderAnswerCheck(async () => Promise.reject(new Error("offline")), false)()).toEqual({ kind: "FAILED", notEnabled: [] });
  });

  // Owner decision 2026-10-12 (optional passcodes).
  it("the answer check passes on the probe's passcodeRequired flag (also in an excluded build); the loaders take the access mode", async () => {
    expect(await createVoiceProviderAnswerCheck(async () => ({ kind: "ANSWERED", providers: ["TRTC"], passcodeRequired: false }), false)()).toEqual({ kind: "ANSWERED", providers: ["TRTC"], passcodeRequired: false });
    expect(await createVoiceProviderAnswerCheck(async () => ({ kind: "ANSWERED", providers: ["TRTC", "WEB_SPEECH"], passcodeRequired: true }), true)()).toEqual({ kind: "ANSWERED", providers: ["WEB_SPEECH"], passcodeRequired: true });
    await expect(createVoiceProviderLoaders(true).TRTC(() => null, { passcodeRequired: false })).rejects.toThrow("TRTC_EXCLUDED_AT_BUILD");
  });
});

