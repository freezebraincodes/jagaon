// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createFakeVoiceTranscriber, type FakeVoiceTranscriberScript } from "./fake-voice-transcriber";
import { voiceDisclosureReducer, VOICE_DISCLOSURE_INITIAL_STATE, type VoiceDisclosureGrant } from "./voice-cloud-disclosure";
import { createVoiceSessionController, type VoiceSessionSnapshot, type VoiceTimers } from "./voice-session-controller";

/** A manual timer: tests fire timeouts explicitly. */
function manualTimers() {
  const pending = new Map<number, { callback: () => void; ms: number }>();
  let next = 1;
  const timers: VoiceTimers = {
    setTimeout: (callback, ms) => {
      pending.set(next, { callback, ms });
      return next++;
    },
    clearTimeout: (handle) => {
      pending.delete(handle as number);
    },
  };
  return {
    timers,
    pendingDelays: () => [...pending.values()].map((entry) => entry.ms),
    fire(ms: number) {
      for (const [handle, entry] of [...pending]) {
        if (entry.ms === ms) {
          pending.delete(handle);
          entry.callback();
        }
      }
    },
  };
}

function grant(language: "en" | "zh" = "en"): VoiceDisclosureGrant {
  const shown = voiceDisclosureReducer(VOICE_DISCLOSURE_INITIAL_STATE, { type: "REQUEST_START", language });
  const accepted = voiceDisclosureReducer(shown, { type: "ACCEPT" });
  if (accepted.kind !== "GRANTED") throw new Error("no grant");
  return accepted.grant;
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function setup(script: FakeVoiceTranscriberScript = {}, maxSessionSeconds = 90) {
  const fake = createFakeVoiceTranscriber(script);
  const clock = manualTimers();
  const states: string[] = [];
  const snapshots: VoiceSessionSnapshot[] = [];
  const controller = createVoiceSessionController({
    transcriber: fake,
    timers: clock.timers,
    startTimeoutMs: 15_000,
    maxSessionSeconds,
    onChange: (snapshot) => {
      snapshots.push(snapshot);
      if (states[states.length - 1] !== snapshot.state) states.push(snapshot.state);
    },
  });
  return { fake, clock, controller, states, snapshots };
}

describe("voice session controller", () => {
  it("start → interim → final → stop: COMPLETED after release; the transcript is taken once and cleared", async () => {
    const { fake, controller, states, clock } = setup({}, 120);
    expect(await controller.start({ language: "en", grant: grant() })).toEqual({ kind: "RAN" });
    expect(controller.snapshot().state).toBe("LISTENING");
    // The session limit is the smaller of the client bound and the server's maximum (fake: 60 s).
    expect(clock.pendingDelays()).toEqual([60_000]);
    fake.emit({ kind: "INTERIM", segmentId: "s1", text: "my sugar" });
    expect(controller.snapshot().liveText).toBe("my sugar");
    fake.emit({ kind: "FINAL", segmentId: "s1", text: "My sugar was 6.8 mmol" });
    fake.emit({ kind: "INTERIM", segmentId: "s2", text: "and" });
    expect(controller.snapshot().liveText).toBe("My sugar was 6.8 mmol and");
    const done = await controller.stop();
    expect(done.state).toBe("COMPLETED");
    expect(done.microphoneReleased).toBe(true);
    expect(done.liveText).toBe("");
    expect(fake.calls).toEqual(["start:en", "stop", "release"]);
    expect(states).toEqual(["STARTING", "LISTENING", "STOPPING", "COMPLETED"]);
    // Interim text is display-only: never in the sealed transcript.
    expect(controller.takeTranscript()).toBe("My sugar was 6.8 mmol");
    expect(controller.takeTranscript()).toBeNull();
    expect(clock.pendingDelays()).toEqual([]);
  });

  it("joins Chinese finals without spaces and lets a later FINAL replace the same segment", async () => {
    const { fake, controller } = setup();
    await controller.start({ language: "zh", grant: grant("zh") });
    fake.emit({ kind: "FINAL", segmentId: "a", text: "我今天早上的血糖" });
    fake.emit({ kind: "FINAL", segmentId: "b", text: "是六点" });
    fake.emit({ kind: "FINAL", segmentId: "b", text: "是六点八。" });
    await controller.stop();
    expect(controller.takeTranscript()).toBe("我今天早上的血糖是六点八。");
  });

  it("accepts finals that arrive while stopping and seals the transcript when the release resolves", async () => {
    const { fake, controller, snapshots } = setup({ release: "MANUAL" });
    await controller.start({ language: "en", grant: grant() });
    fake.emit({ kind: "FINAL", segmentId: "s1", text: "Sugar reading" });
    const stopping = controller.stop();
    await flush();
    expect(controller.snapshot().state).toBe("STOPPING");
    fake.emit({ kind: "FINAL", segmentId: "s2", text: "9.2" });
    // The terminal state never precedes the release.
    expect(snapshots.some((snapshot) => snapshot.state === "COMPLETED")).toBe(false);
    fake.completeRelease();
    expect((await stopping).state).toBe("COMPLETED");
    fake.emit({ kind: "FINAL", segmentId: "s3", text: "late" });
    expect(controller.takeTranscript()).toBe("Sugar reading 9.2");
  });

  it("cancel mid-utterance clears the transcript at once and drops late finals", async () => {
    const { fake, controller } = setup({ release: "MANUAL" });
    await controller.start({ language: "en", grant: grant() });
    fake.emit({ kind: "INTERIM", segmentId: "s1", text: "how many tab" });
    const cancelling = controller.cancel();
    await flush();
    expect(controller.snapshot()).toMatchObject({ state: "STOPPING", liveText: "" });
    fake.emit({ kind: "FINAL", segmentId: "s1", text: "how many tablets should I take?" });
    expect(controller.snapshot().liveText).toBe("");
    fake.completeRelease();
    expect(await cancelling).toMatchObject({ state: "CANCELLED", microphoneReleased: true, liveText: "" });
    expect(fake.calls).toEqual(["start:en", "cancel", "release"]);
    expect(controller.takeTranscript()).toBeNull();
  });

  it("a cancel during a stop wins: nothing is kept", async () => {
    const { fake, controller } = setup({ release: "MANUAL" });
    await controller.start({ language: "en", grant: grant() });
    fake.emit({ kind: "FINAL", segmentId: "s1", text: "Sugar 7" });
    const stopping = controller.stop();
    const cancelling = controller.cancel();
    fake.completeRelease();
    expect((await stopping).state).toBe("CANCELLED");
    expect((await cancelling).state).toBe("CANCELLED");
    expect(controller.takeTranscript()).toBeNull();
  });

  it("the session limit times out: release, no transcript, TIMED_OUT", async () => {
    const { fake, controller, clock, states } = setup();
    await controller.start({ language: "en", grant: grant() });
    fake.emit({ kind: "FINAL", segmentId: "s1", text: "Sugar 7" });
    clock.fire(60_000);
    await flush();
    expect(controller.snapshot()).toMatchObject({ state: "TIMED_OUT", microphoneReleased: true, liveText: "" });
    expect(fake.calls).toEqual(["start:en", "cancel", "release"]);
    expect(states).toEqual(["STARTING", "LISTENING", "STOPPING", "TIMED_OUT"]);
    fake.emit({ kind: "FINAL", segmentId: "s2", text: "late" });
    expect(controller.takeTranscript()).toBeNull();
  });

  it("the start timeout aborts the start; a late STARTED is cancelled and released before FAILED", async () => {
    const { fake, controller, clock, snapshots } = setup({ start: { kind: "MANUAL" }, release: "MANUAL" });
    const starting = controller.start({ language: "en", grant: grant() });
    await flush();
    clock.fire(15_000);
    expect(fake.lastSignal()?.aborted).toBe(true);
    fake.completeStart({ kind: "STARTED" });
    await flush();
    expect(snapshots.some((snapshot) => snapshot.state === "FAILED")).toBe(false);
    fake.completeRelease();
    await starting;
    expect(controller.snapshot()).toMatchObject({ state: "FAILED", failureReason: "START_TIMEOUT", microphoneReleased: true });
    expect(fake.calls).toEqual(["start:en", "abort", "cancel", "release"]);
  });

  it("cancel while starting ends CANCELLED and never listens", async () => {
    const { fake, controller, states } = setup({ start: { kind: "MANUAL" } });
    const starting = controller.start({ language: "en", grant: grant() });
    await flush();
    const cancelling = controller.cancel();
    fake.completeStart({ kind: "FAILED", reason: "PROVIDER_FAILURE" });
    await starting;
    expect((await cancelling).state).toBe("CANCELLED");
    expect(states).not.toContain("LISTENING");
  });

  it("permission denied and provider failures end FAILED with the closed reason", async () => {
    for (const reason of ["PERMISSION_DENIED", "UNSUPPORTED_BROWSER", "CONCURRENCY_LIMIT", "NETWORK_FAILURE", "PROVIDER_FAILURE"] as const) {
      const { controller, fake } = setup({ start: { kind: "FAILED", reason } });
      await controller.start({ language: "en", grant: grant() });
      expect(controller.snapshot(), reason).toMatchObject({ state: "FAILED", failureReason: reason, microphoneReleased: true });
      expect(fake.calls).toEqual(["start:en"]);
    }
    const refused = setup({ start: { kind: "FAILED", reason: "CREDENTIAL_REFUSED", credentialRefusal: "ACCESS_DENIED" } });
    await refused.controller.start({ language: "en", grant: grant() });
    expect(refused.controller.snapshot()).toMatchObject({ state: "FAILED", failureReason: "CREDENTIAL_REFUSED", credentialRefusal: "ACCESS_DENIED" });
  });

  it("a provider failure while listening releases first, then FAILED; the transcript is dropped", async () => {
    const { fake, controller } = setup({ release: "MANUAL" });
    await controller.start({ language: "en", grant: grant() });
    fake.emit({ kind: "FINAL", segmentId: "s1", text: "Sugar 7" });
    fake.fail("NETWORK_FAILURE");
    await flush();
    expect(controller.snapshot().state).toBe("STOPPING");
    fake.completeRelease();
    await flush();
    expect(controller.snapshot()).toMatchObject({ state: "FAILED", failureReason: "NETWORK_FAILURE", microphoneReleased: true });
    expect(controller.takeTranscript()).toBeNull();
  });

  it("drops events from an older session", async () => {
    const { fake, controller } = setup();
    await controller.start({ language: "en", grant: grant() });
    await controller.cancel();
    await controller.start({ language: "en", grant: grant() });
    fake.emitTo(0, { kind: "FINAL", segmentId: "old", text: "Sugar 12" });
    fake.emitTo(1, { kind: "FINAL", segmentId: "new", text: "Sugar 6" });
    expect(controller.snapshot().liveText).toBe("Sugar 6");
    expect(controller.snapshot().sessionToken).toBe(2);
  });

  it("double stop and double cancel are idempotent", async () => {
    const { fake, controller } = setup();
    await controller.start({ language: "en", grant: grant() });
    const [first, second] = await Promise.all([controller.stop(), controller.stop()]);
    expect(first).toEqual(second);
    expect(await controller.stop()).toMatchObject({ state: "COMPLETED" });
    expect(await controller.cancel()).toMatchObject({ state: "COMPLETED" });
    expect(fake.calls.filter((call) => call === "release")).toHaveLength(1);
    const again = setup();
    await again.controller.start({ language: "en", grant: grant() });
    await Promise.all([again.controller.cancel(), again.controller.cancel()]);
    // The controller hands the release to the adapter once; the second cancel joins it.
    expect(again.fake.calls).toEqual(["start:en", "cancel", "release"]);
  });

  it("refuses without an unconsumed grant (no start, no microphone)", async () => {
    const { fake, controller } = setup();
    expect(await controller.start({ language: "en", grant: undefined as unknown as VoiceDisclosureGrant })).toEqual({ kind: "REFUSED", reason: "DISCLOSURE_REQUIRED" });
    expect(await controller.start({ language: "en", grant: Object.freeze({ language: "en" }) as unknown as VoiceDisclosureGrant })).toEqual({ kind: "REFUSED", reason: "DISCLOSURE_REQUIRED" });
    expect(await controller.start({ language: "zh", grant: grant("en") })).toEqual({ kind: "REFUSED", reason: "DISCLOSURE_REQUIRED" });
    const once = grant();
    expect(await controller.start({ language: "en", grant: once })).toEqual({ kind: "RAN" });
    await controller.stop();
    expect(await controller.start({ language: "en", grant: once })).toEqual({ kind: "REFUSED", reason: "DISCLOSURE_REQUIRED" });
    expect(fake.calls.filter((call) => call.startsWith("start"))).toHaveLength(1);
  });

  it("refuses a second start while a session is active", async () => {
    const { controller } = setup();
    await controller.start({ language: "en", grant: grant() });
    expect(await controller.start({ language: "en", grant: grant() })).toEqual({ kind: "REFUSED", reason: "SESSION_ACTIVE" });
  });

  it("never reaches a terminal state before the release report, on every path", async () => {
    for (const path of ["stop", "cancel", "timeout", "failure"] as const) {
      const { fake, controller, clock, snapshots } = setup({ release: "MANUAL" });
      await controller.start({ language: "en", grant: grant() });
      if (path === "stop") void controller.stop();
      if (path === "cancel") void controller.cancel();
      if (path === "timeout") clock.fire(60_000);
      if (path === "failure") fake.fail("PROVIDER_FAILURE");
      await flush();
      expect(snapshots.filter((snapshot) => ["COMPLETED", "CANCELLED", "TIMED_OUT", "FAILED"].includes(snapshot.state)), path).toEqual([]);
      fake.completeRelease();
      await flush();
      expect(["COMPLETED", "CANCELLED", "TIMED_OUT", "FAILED"], path).toContain(controller.snapshot().state);
    }
  });

  it("reports a failed release honestly and still ends", async () => {
    const { controller } = setup({ microphoneReleased: false });
    await controller.start({ language: "en", grant: grant() });
    expect(await controller.cancel()).toMatchObject({ state: "CANCELLED", microphoneReleased: false });
  });

  it("review M6: an explicit discard drops the sealed transcript", async () => {
    const { fake, controller } = setup();
    await controller.start({ language: "en", grant: grant() });
    fake.emit({ kind: "FINAL", segmentId: "s1", text: "Sugar 7" });
    await controller.stop();
    controller.discardTranscript();
    expect(controller.takeTranscript()).toBeNull();
    controller.discardTranscript();
  });

  it("persists nothing and logs nothing", async () => {
    const log = vi.spyOn(console, "log");
    const error = vi.spyOn(console, "error");
    const warn = vi.spyOn(console, "warn");
    const { fake, controller } = setup();
    await controller.start({ language: "en", grant: grant() });
    fake.emit({ kind: "FINAL", segmentId: "s1", text: "Sugar 7" });
    await controller.stop();
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    const source = readFileSync(join(process.cwd(), "src/application/voice/voice-session-controller.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB|dexie|console\.|\bfetch\b|Date\.now|new Date/);
  });
});
