// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFakeVoiceTranscriber } from "./fake-voice-transcriber";
import { voiceDisclosureReducer, VOICE_DISCLOSURE_INITIAL_STATE, type VoiceDisclosureGrant } from "./voice-cloud-disclosure";
import type { VoiceSegment } from "./voice-transcriber-port";

const grant = (): VoiceDisclosureGrant => {
  const accepted = voiceDisclosureReducer(voiceDisclosureReducer(VOICE_DISCLOSURE_INITIAL_STATE, { type: "REQUEST_START", language: "en" }), { type: "ACCEPT" });
  if (accepted.kind !== "GRANTED") throw new Error("no grant");
  return accepted.grant;
};

describe("fake voice transcriber (tests and harness only)", () => {
  it("plays scripted segments, records the release order and releases once", async () => {
    const segments: VoiceSegment[] = [];
    const fake = createFakeVoiceTranscriber({ segmentsOnStart: [{ kind: "FINAL", segmentId: "1", text: "Sugar 7" }] });
    const result = await fake.start({ language: "en", grant: grant(), onSegment: (segment) => segments.push(segment), onFailure: () => undefined, signal: new AbortController().signal });
    expect(result.kind).toBe("STARTED");
    await Promise.resolve();
    expect(segments).toEqual([{ kind: "FINAL", segmentId: "1", text: "Sugar 7" }]);
    if (result.kind !== "STARTED") return;
    const report = await result.session.stop();
    expect(report).toEqual({ microphoneReleased: true, providerStop: { kind: "CONFIRMED" } });
    expect(await result.session.cancel()).toBe(report);
    expect(fake.calls).toEqual(["start:en", "stop", "release", "cancel"]);
  });

  it("scripts failures, manual starts and the abort signal", async () => {
    const failing = createFakeVoiceTranscriber({ start: { kind: "FAILED", reason: "PERMISSION_DENIED" } });
    expect(await failing.start({ language: "zh", grant: grant(), onSegment: () => undefined, onFailure: () => undefined, signal: new AbortController().signal })).toEqual({ kind: "FAILED", reason: "PERMISSION_DENIED" });
    const manual = createFakeVoiceTranscriber({ start: { kind: "MANUAL" } });
    const abort = new AbortController();
    const pending = manual.start({ language: "en", grant: grant(), onSegment: () => undefined, onFailure: () => undefined, signal: abort.signal });
    abort.abort();
    manual.completeStart({ kind: "FAILED", reason: "START_TIMEOUT" });
    expect(await pending).toEqual({ kind: "FAILED", reason: "START_TIMEOUT" });
    expect(manual.calls).toEqual(["start:en", "abort"]);
  });

  it("can be scripted to an unconfirmed provider stop", async () => {
    const providerStop = { kind: "UNCONFIRMED", reason: "STOP_TIMED_OUT", robotId: "robot-1", taskId: null } as const;
    const fake = createFakeVoiceTranscriber({ providerStop, microphoneReleased: false });
    const result = await fake.start({ language: "en", grant: grant(), onSegment: () => undefined, onFailure: () => undefined, signal: new AbortController().signal });
    if (result.kind !== "STARTED") throw new Error("expected STARTED");
    expect(await result.session.cancel()).toEqual({ microphoneReleased: false, providerStop });
    const failing = createFakeVoiceTranscriber({ start: { kind: "FAILED", reason: "PROVIDER_FAILURE", providerStop: { kind: "UNCONFIRMED", reason: "START_UNRESOLVED", robotId: null, taskId: null } } });
    expect(await failing.start({ language: "en", grant: grant(), onSegment: () => undefined, onFailure: () => undefined, signal: new AbortController().signal })).toEqual({ kind: "FAILED", reason: "PROVIDER_FAILURE", providerStop: { kind: "UNCONFIRMED", reason: "START_UNRESOLVED", robotId: null, taskId: null } });
  });

  it("Web Speech: reports a provider end (method and script option) and can release with NOT_APPLICABLE", async () => {
    const ended: string[] = [];
    const fake = createFakeVoiceTranscriber({ providerStop: { kind: "NOT_APPLICABLE" }, providerEndsAfterSegments: true, segmentsOnStart: [{ kind: "FINAL", segmentId: "1", text: "Sugar 7" }] });
    const result = await fake.start({ language: "en", grant: grant(), onSegment: (segment) => ended.push(`segment:${segment.text}`), onFailure: () => undefined, onProviderEnded: () => ended.push("ended"), signal: new AbortController().signal });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ended).toEqual(["segment:Sugar 7", "ended"]);
    fake.providerEnd();
    expect(ended).toEqual(["segment:Sugar 7", "ended", "ended"]);
    if (result.kind !== "STARTED") throw new Error("expected STARTED");
    expect(await result.session.stop()).toEqual({ microphoneReleased: true, providerStop: { kind: "NOT_APPLICABLE" } });
  });

  it("has no microphone, network, provider or storage access", () => {
    const source = readFileSync(join(process.cwd(), "src/application/voice/fake-voice-transcriber.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(source).not.toMatch(/navigator|getUserMedia|\bfetch\b|trtc|localStorage|indexedDB|console\./i);
  });
});
