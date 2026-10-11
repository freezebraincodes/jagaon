// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { voiceDisclosureReducer, VOICE_DISCLOSURE_INITIAL_STATE, type VoiceDisclosureGrant } from "@/application/voice/voice-cloud-disclosure";
import { createVoiceSessionController, type VoiceTimers } from "@/application/voice/voice-session-controller";
import type { VoiceSegment, VoiceSessionFailureReason, VoiceStartRequest, VoiceStartResult } from "@/application/voice/voice-transcriber-port";
import { createWebSpeechTranscriberAdapter, webSpeechStartFailureReason, WEB_SPEECH_LANGUAGE_TAG, type WebSpeechAccessResult } from "./web-speech-transcriber-adapter";
import { detectWebSpeechRecognition, isWebSpeechSupported, type WebSpeechRecognitionLike } from "./web-speech-support";

/**
 * Web Speech adapter (offline): a MOCK recognizer class stands in for the browser's speech recognition. No microphone, no browser
 * speech service, no network: the access check is an injected function.
 */
class MockRecognition implements WebSpeechRecognitionLike {
  static instances: MockRecognition[] = [];
  lang = "";
  continuous = false;
  interimResults = false;
  maxAlternatives = 0;
  onstart: WebSpeechRecognitionLike["onstart"] = null;
  onresult: WebSpeechRecognitionLike["onresult"] = null;
  onerror: WebSpeechRecognitionLike["onerror"] = null;
  onend: WebSpeechRecognitionLike["onend"] = null;
  calls: string[] = [];
  constructor() {
    MockRecognition.instances.push(this);
  }
  start() {
    this.calls.push("start");
  }
  stop() {
    this.calls.push("stop");
  }
  abort() {
    this.calls.push("abort");
  }
  // Browser-side events (what Chrome would fire).
  fireStart() {
    this.onstart?.({});
  }
  fireResults(resultIndex: number, results: Array<{ text: string; final: boolean }>) {
    const list: Record<number, unknown> & { length: number } = { length: results.length };
    results.forEach((result, index) => (list[index] = { isFinal: result.final, length: 1, 0: { transcript: result.text } }));
    this.onresult?.({ resultIndex, results: list as never });
  }
  fireError(error: string) {
    this.onerror?.({ error });
  }
  fireEnd() {
    this.onend?.({});
  }
}

function manualTimers() {
  const pending = new Map<number, { callback: () => void; ms: number }>();
  let next = 1;
  const timers: VoiceTimers = {
    setTimeout: (callback, ms) => {
      pending.set(next, { callback, ms });
      return next++;
    },
    clearTimeout: (handle) => void pending.delete(handle as number),
  };
  return {
    timers,
    fire(ms: number) {
      for (const [handle, entry] of [...pending]) if (entry.ms === ms) (pending.delete(handle), entry.callback());
    },
    count: () => pending.size,
  };
}

function grant(): VoiceDisclosureGrant {
  const accepted = voiceDisclosureReducer(voiceDisclosureReducer(VOICE_DISCLOSURE_INITIAL_STATE, { type: "REQUEST_START", language: "en" }), { type: "ACCEPT" });
  if (accepted.kind !== "GRANTED") throw new Error("no grant");
  return accepted.grant;
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const GRANTED: WebSpeechAccessResult = { kind: "GRANTED", maxSessionSeconds: 45 };

function setup(access: WebSpeechAccessResult | (() => Promise<WebSpeechAccessResult>) = GRANTED, recognition: () => unknown = () => MockRecognition) {
  const clock = manualTimers();
  const requestAccess = vi.fn(async () => (typeof access === "function" ? access() : access));
  const adapter = createWebSpeechTranscriberAdapter({ requestAccess, recognition: recognition as never, timers: clock.timers, releaseTimeoutMs: 5_000 });
  const segments: VoiceSegment[] = [];
  const failures: VoiceSessionFailureReason[] = [];
  const ended: number[] = [];
  const abort = new AbortController();
  const request = (overrides: Partial<VoiceStartRequest> = {}): VoiceStartRequest => ({
    language: "en",
    grant: grant(),
    onSegment: (segment) => segments.push(segment),
    onFailure: (reason) => failures.push(reason),
    onProviderEnded: () => ended.push(1),
    signal: abort.signal,
    ...overrides,
  });
  return { adapter, requestAccess, clock, segments, failures, ended, abort, request };
}

/** Starts and fires onstart; returns the started handle and the mock recognizer. */
async function started(context: ReturnType<typeof setup>) {
  const pending = context.adapter.start(context.request());
  await flush();
  const recognizer = MockRecognition.instances.at(-1)!;
  recognizer.fireStart();
  const result = await pending;
  if (result.kind !== "STARTED") throw new Error(`expected STARTED, got ${JSON.stringify(result)}`);
  return { result, recognizer };
}

afterEach(() => {
  // Every test ends its recognizers so the page-wide one-recognizer guard is free for the next.
  for (const recognizer of MockRecognition.instances) recognizer.fireEnd();
  MockRecognition.instances = [];
});

describe("Web Speech transcriber adapter (mock recognizer; no microphone, no speech service)", () => {
  it("feature detection: standard or prefixed constructor, never throwing", () => {
    expect(detectWebSpeechRecognition({ webkitSpeechRecognition: MockRecognition })).toBe(MockRecognition);
    expect(detectWebSpeechRecognition({ SpeechRecognition: MockRecognition })).toBe(MockRecognition);
    expect(detectWebSpeechRecognition({})).toBeNull();
    expect(detectWebSpeechRecognition(null)).toBeNull();
    expect(detectWebSpeechRecognition(new Proxy({}, { get: () => { throw new Error("boom"); } }))).toBeNull();
    expect(isWebSpeechSupported({ webkitSpeechRecognition: "not a function" })).toBe(false);
  });

  it("start: access check, ONE recognizer configured en-SG continuous with interim results, STARTED only on onstart with the server's maximum", async () => {
    const context = setup();
    let settled: VoiceStartResult | null = null;
    const pending = context.adapter.start(context.request()).then((result) => (settled = result));
    await flush();
    expect(context.requestAccess).toHaveBeenCalledTimes(1);
    expect(MockRecognition.instances).toHaveLength(1);
    const [recognizer] = MockRecognition.instances;
    expect(recognizer).toMatchObject({ lang: WEB_SPEECH_LANGUAGE_TAG, continuous: true, interimResults: true, maxAlternatives: 1, calls: ["start"] });
    expect(WEB_SPEECH_LANGUAGE_TAG).toBe("en-SG");
    expect(settled).toBeNull();
    recognizer!.fireStart();
    await pending;
    expect(settled).toMatchObject({ kind: "STARTED", maxSessionSeconds: 45 });
  });

  it("interim and final segments carry stable per-result ids; only the first alternative's text", async () => {
    const context = setup();
    const { recognizer } = await started(context);
    recognizer.fireResults(0, [{ text: "my sugar", final: false }]);
    recognizer.fireResults(0, [{ text: "my sugar was 6.8", final: true }]);
    recognizer.fireResults(1, [{ text: "my sugar was 6.8", final: true }, { text: "mmol", final: false }]);
    expect(context.segments.map((segment) => [segment.kind, segment.text])).toEqual([
      ["INTERIM", "my sugar"],
      ["FINAL", "my sugar was 6.8"],
      ["INTERIM", "mmol"],
    ]);
    const ids = context.segments.map((segment) => segment.segmentId);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);
  });

  it("Stop: stop() is called, finals flushed before onend still count, the release resolves only on onend; NOT_APPLICABLE", async () => {
    const context = setup();
    const { result, recognizer } = await started(context);
    let report: unknown = null;
    const stopping = result.session.stop().then((value) => (report = value));
    expect(recognizer.calls).toEqual(["start", "stop"]);
    await flush();
    expect(report).toBeNull();
    recognizer.fireResults(0, [{ text: "last words", final: true }]);
    recognizer.fireEnd();
    await stopping;
    expect(context.segments).toEqual([expect.objectContaining({ kind: "FINAL", text: "last words" })]);
    expect(report).toEqual({ microphoneReleased: true, providerStop: { kind: "NOT_APPLICABLE" } });
    // A user stop is never reported as a provider end; a second call returns the same report.
    expect(context.ended).toEqual([]);
    expect(await result.session.cancel()).toBe(report);
  });

  it("Cancel: abort() and nothing more is forwarded (pending finals dropped)", async () => {
    const context = setup();
    const { result, recognizer } = await started(context);
    const cancelling = result.session.cancel();
    expect(recognizer.calls).toEqual(["start", "abort"]);
    recognizer.fireResults(0, [{ text: "should be dropped", final: true }]);
    recognizer.fireError("aborted");
    recognizer.fireEnd();
    expect(await cancelling).toEqual({ microphoneReleased: true, providerStop: { kind: "NOT_APPLICABLE" } });
    expect(context.segments).toEqual([]);
    expect(context.failures).toEqual([]);
    expect(context.ended).toEqual([]);
  });

  it("maps every start error (before onstart) and releases before resolving FAILED with NOT_APPLICABLE", async () => {
    expect(webSpeechStartFailureReason("not-allowed")).toBe("PERMISSION_DENIED");
    expect(webSpeechStartFailureReason("service-not-allowed")).toBe("PERMISSION_DENIED");
    expect(webSpeechStartFailureReason("network")).toBe("NETWORK_FAILURE");
    for (const error of ["audio-capture", "language-not-supported", "no-speech", "bad-grammar", "something-new"]) expect(webSpeechStartFailureReason(error), error).toBe("PROVIDER_FAILURE");
    for (const [error, reason] of [["not-allowed", "PERMISSION_DENIED"], ["service-not-allowed", "PERMISSION_DENIED"], ["network", "NETWORK_FAILURE"], ["audio-capture", "PROVIDER_FAILURE"], ["language-not-supported", "PROVIDER_FAILURE"]] as const) {
      const context = setup();
      let settled: VoiceStartResult | null = null;
      const pending = context.adapter.start(context.request()).then((result) => (settled = result));
      await flush();
      const recognizer = MockRecognition.instances.at(-1)!;
      recognizer.fireError(error);
      await flush();
      expect(settled, `${error}: waits for onend`).toBeNull();
      expect(recognizer.calls).toContain("abort");
      recognizer.fireEnd();
      await pending;
      expect(settled, error).toEqual({ kind: "FAILED", reason, providerStop: { kind: "NOT_APPLICABLE" } });
      expect(context.ended).toEqual([]);
    }
  });

  it("errors after STARTED: network → NETWORK_FAILURE, other errors → PROVIDER_FAILURE, once; the following onend is not a provider end", async () => {
    for (const [error, reason] of [["network", "NETWORK_FAILURE"], ["audio-capture", "PROVIDER_FAILURE"], ["not-allowed", "PROVIDER_FAILURE"]] as const) {
      const context = setup();
      const { recognizer } = await started(context);
      recognizer.fireError(error);
      recognizer.fireError(error);
      recognizer.fireEnd();
      expect(context.failures, error).toEqual([reason]);
      expect(context.ended, error).toEqual([]);
    }
  });

  it("browser-initiated end (and no-speech) → onProviderEnded once; NEVER restarts; later results ignored", async () => {
    for (const withNoSpeech of [false, true]) {
      const context = setup();
      const { result, recognizer } = await started(context);
      recognizer.fireResults(0, [{ text: "six point eight", final: true }]);
      if (withNoSpeech) recognizer.fireError("no-speech");
      recognizer.fireEnd();
      expect(context.ended).toEqual([1]);
      expect(context.failures).toEqual([]);
      expect(recognizer.calls).toEqual(["start"]);
      expect(MockRecognition.instances).toHaveLength(1);
      // Late events after the end: ignored (handlers detached).
      recognizer.fireResults(1, [{ text: "x", final: true }, { text: "late", final: true }]);
      recognizer.fireEnd();
      expect(context.segments.map((segment) => segment.text)).toEqual(["six point eight"]);
      expect(context.ended).toEqual([1]);
      // The release after a provider end resolves at once; nothing is called on the recognizer.
      expect(await result.session.stop()).toEqual({ microphoneReleased: true, providerStop: { kind: "NOT_APPLICABLE" } });
      expect(recognizer.calls).toEqual(["start"]);
      MockRecognition.instances = [];
    }
  });

  it("late events after release are ignored; a missing onend is bounded (abort, microphoneReleased false)", async () => {
    const context = setup();
    const { result, recognizer } = await started(context);
    const stopping = result.session.stop();
    context.clock.fire(5_000);
    expect(await stopping).toEqual({ microphoneReleased: false, providerStop: { kind: "NOT_APPLICABLE" } });
    expect(recognizer.calls).toEqual(["start", "stop", "abort"]);
    recognizer.fireResults(0, [{ text: "too late", final: true }]);
    recognizer.fireEnd();
    expect(context.segments).toEqual([]);
    expect(context.ended).toEqual([]);
  });

  it("one recognizer at a time: a concurrent start is refused without creating a second recognizer", async () => {
    const first = setup();
    const { result } = await started(first);
    const second = setup();
    expect(await second.adapter.start(second.request())).toEqual({ kind: "FAILED", reason: "PROVIDER_FAILURE", providerStop: { kind: "NOT_APPLICABLE" } });
    expect(MockRecognition.instances).toHaveLength(1);
    expect(second.requestAccess).not.toHaveBeenCalled();
    const stopping = result.session.stop();
    MockRecognition.instances[0]!.fireEnd();
    await stopping;
    // Free again after the release.
    const third = setup();
    await started(third);
    expect(MockRecognition.instances).toHaveLength(2);
  });

  it("unsupported browser, Chinese, refused or failed access: FAILED before any recognizer; nothing else contacted", async () => {
    const none = setup(GRANTED, () => null);
    expect(await none.adapter.start(none.request())).toEqual({ kind: "FAILED", reason: "UNSUPPORTED_BROWSER", providerStop: { kind: "NOT_APPLICABLE" } });
    expect(none.requestAccess).not.toHaveBeenCalled();
    const zh = setup();
    expect(await zh.adapter.start(zh.request({ language: "zh" }))).toMatchObject({ kind: "FAILED", reason: "UNSUPPORTED_BROWSER" });
    expect(zh.requestAccess).not.toHaveBeenCalled();
    const refused = setup({ kind: "REFUSED", reason: "ACCESS_DENIED" });
    expect(await refused.adapter.start(refused.request())).toEqual({ kind: "FAILED", reason: "CREDENTIAL_REFUSED", credentialRefusal: "ACCESS_DENIED", providerStop: { kind: "NOT_APPLICABLE" } });
    const offline = setup({ kind: "FAILED", reason: "NETWORK_FAILURE" });
    expect(await offline.adapter.start(offline.request())).toMatchObject({ kind: "FAILED", reason: "NETWORK_FAILURE" });
    const throwing = setup(() => Promise.reject(new Error("boom")));
    expect(await throwing.adapter.start(throwing.request())).toMatchObject({ kind: "FAILED", reason: "NETWORK_FAILURE" });
    expect(MockRecognition.instances).toEqual([]);
  });

  it("an abort while starting releases the recognizer before resolving FAILED", async () => {
    const context = setup();
    let settled: VoiceStartResult | null = null;
    const pending = context.adapter.start(context.request()).then((result) => (settled = result));
    await flush();
    const recognizer = MockRecognition.instances[0]!;
    context.abort.abort();
    await flush();
    expect(recognizer.calls).toEqual(["start", "abort"]);
    expect(settled).toBeNull();
    recognizer.fireEnd();
    await pending;
    expect(settled).toEqual({ kind: "FAILED", reason: "PROVIDER_FAILURE", providerStop: { kind: "NOT_APPLICABLE" } });
    // A late onstart after the failure does nothing.
    recognizer.fireStart();
    expect(context.ended).toEqual([]);
  });

  it("through the session controller: Stop keeps a final that arrives before onend; a provider end completes with endedBy PROVIDER and no restart", async () => {
    const context = setup();
    const clock = manualTimers();
    const controller = createVoiceSessionController({ transcriber: context.adapter, timers: clock.timers, startTimeoutMs: 15_000, maxSessionSeconds: 120 });
    const starting = controller.start({ language: "en", grant: grant() });
    await flush();
    MockRecognition.instances[0]!.fireStart();
    await starting;
    expect(controller.snapshot().state).toBe("LISTENING");
    MockRecognition.instances[0]!.fireResults(0, [{ text: "My sugar was 6.8 mmol", final: false }]);
    const stopping = controller.stop();
    MockRecognition.instances[0]!.fireResults(0, [{ text: "My sugar was 6.8 mmol", final: true }]);
    MockRecognition.instances[0]!.fireEnd();
    expect(await stopping).toMatchObject({ state: "COMPLETED", endedBy: null, providerStop: { kind: "NOT_APPLICABLE" } });
    expect(controller.takeTranscript()).toBe("My sugar was 6.8 mmol");

    const again = controller.start({ language: "en", grant: grant() });
    await flush();
    MockRecognition.instances[1]!.fireStart();
    await again;
    MockRecognition.instances[1]!.fireResults(0, [{ text: "chicken rice for lunch", final: true }]);
    MockRecognition.instances[1]!.fireEnd();
    await flush();
    expect(controller.snapshot()).toMatchObject({ state: "COMPLETED", endedBy: "PROVIDER", microphoneReleased: true, providerStop: { kind: "NOT_APPLICABLE" } });
    expect(controller.takeTranscript()).toBe("chicken rice for lunch");
    expect(MockRecognition.instances).toHaveLength(2);
    expect(MockRecognition.instances[1]!.calls).toEqual(["start"]);
  });

  it("W-6a through the controller: the listening limit calls stop() (not abort), a final flushed before onend is kept, interim dropped, endedBy LIMIT", async () => {
    const context = setup();
    const clock = manualTimers();
    const controller = createVoiceSessionController({ transcriber: context.adapter, timers: clock.timers, startTimeoutMs: 15_000, maxSessionSeconds: 60 });
    const starting = controller.start({ language: "en", grant: grant() });
    await flush();
    const recognizer = MockRecognition.instances[0]!;
    recognizer.fireStart();
    await starting;
    recognizer.fireResults(0, [{ text: "My sugar was 6.8 mmol", final: false }]);
    // The server granted 45 s (smaller than 60): that limit fires.
    clock.fire(45_000);
    expect(recognizer.calls).toEqual(["start", "stop"]);
    expect(controller.snapshot().state).toBe("STOPPING");
    recognizer.fireResults(0, [{ text: "My sugar was 6.8 mmol", final: true }, { text: "and I", final: false }]);
    recognizer.fireEnd();
    await flush();
    expect(controller.snapshot()).toMatchObject({ state: "COMPLETED", endedBy: "LIMIT", microphoneReleased: true, providerStop: { kind: "NOT_APPLICABLE" } });
    expect(controller.takeTranscript()).toBe("My sugar was 6.8 mmol");
    expect(context.ended).toEqual([]);
    expect(MockRecognition.instances).toHaveLength(1);
  });

  it("stores and logs nothing, and never names the TRTC marker or clearance keys (source scan)", () => {
    for (const file of ["src/voice/web-speech/web-speech-transcriber-adapter.ts", "src/voice/web-speech/web-speech-support.ts", "src/components/jagaon/voice/load-web-speech-transcriber.ts"]) {
      const source = readFileSync(join(process.cwd(), file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(source, file).not.toMatch(/Storage|indexedDB|unconfirmedProviderTasks|providerTaskClearances|installVoiceRecoveryHelper|jagaonVoiceRecovery|console\.|getUserMedia|\.restart|trtc-transcriber-adapter/);
    }
  });
});
