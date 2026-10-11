// @vitest-environment jsdom
// The jsdom environment is deliberate: a React component test like the existing screen tests. Synthetic data only. No microphone and
// no speech service: the browser recognizer is a MOCK class, the access route a stubbed fetch, and the TRTC SDK is never loaded.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeVoiceTranscriber, type FakeVoiceTranscriberScript } from "@/application/voice/fake-voice-transcriber";
import { resolveVoiceProvider, type VoiceProviderId, type VoiceProviderResolution } from "@/application/voice/voice-provider-selection";
import type { VoiceSaveIntent } from "@/application/voice/voice-review-contract";
import type { VoiceTranscriberPort } from "@/application/voice/voice-transcriber-port";
import type { VoiceMedicationRef } from "@/domain/voice/voice-contracts";
import { getMessages } from "@/i18n/get-messages";
import type { SupportedLocale } from "@/i18n/types";
import { createTrtcTranscriberAdapter, JAGAON_PROVIDER_TASK_CLEARANCES_KEY, JAGAON_PROVIDER_TASK_MARKERS_KEY, VOICE_RECOVERY_GLOBAL } from "@/voice/trtc/trtc-transcriber-adapter";
import type { WebSpeechRecognitionLike } from "@/voice/web-speech/web-speech-support";
import { TellJagaOnScreen, type TellJagaOnScreenProps, type VoiceTerminologyPort } from "./TellJagaOnScreen";
import { loadWebSpeechTranscriber } from "./load-web-speech-transcriber";
import { VOICE_SCREEN_PENDING_COPY, VOICE_WEB_SPEECH_COPY } from "./voice-screen-copy";

const PASSCODE = "TEST-ONLY-voice-passcode";
const DARK: VoiceMedicationRef = { recordType: "MEDICATION", recordId: "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f", revisionId: "7a1c2d3e-4a5b-4c6d-9e7f-0a1b2c3d4e5f" };
const web = VOICE_WEB_SPEECH_COPY["en-SG"];

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
    queueMicrotask(() => this.onstart?.({}));
  }
  stop() {
    this.calls.push("stop");
  }
  abort() {
    this.calls.push("abort");
    queueMicrotask(() => this.onend?.({}));
  }
  say(index: number, text: string, final: boolean) {
    const results: Record<number, unknown> & { length: number } = { length: index + 1 };
    for (let at = 0; at <= index; at += 1) results[at] = { isFinal: at < index ? true : final, length: 1, 0: { transcript: at === index ? text : "" } };
    this.onresult?.({ resultIndex: index, results: results as never });
  }
  end() {
    this.onend?.({});
  }
}

function terminology(): VoiceTerminologyPort {
  return {
    directory: async () => ({ terms: [], names: [{ name: "Nocturin pen (demo)", medication: DARK }] }),
    activeMedicines: async () => [{ medication: DARK, names: ["Nocturin pen (demo)"] }],
    remember: async () => ({ kind: "COMMITTED" }),
  };
}

type Setup = Partial<TellJagaOnScreenProps> & { locale?: SupportedLocale; provider?: VoiceProviderId; script?: FakeVoiceTranscriberScript; transcriber?: () => Promise<VoiceTranscriberPort> };

function setup({ locale = "en-SG", provider = "WEB_SPEECH", script, transcriber, ...overrides }: Setup = {}) {
  const fake = createFakeVoiceTranscriber(script ?? { providerStop: { kind: "NOT_APPLICABLE" } });
  const loadTranscriber = vi.fn(async (passcode: () => string | null, chosen: VoiceProviderId) => {
    expect(passcode()).toBe(PASSCODE);
    void chosen;
    return transcriber ? transcriber() : fake;
  });
  const resolveProvider = vi.fn(async (): Promise<VoiceProviderResolution> => ({ kind: "AVAILABLE", provider }));
  const onSaveFacts = vi.fn(async (intent: VoiceSaveIntent) => (void intent, { kind: "SAVED" as const }));
  const activity: boolean[] = [];
  const props: TellJagaOnScreenProps = {
    messages: getMessages(locale),
    locale,
    resolveProvider,
    loadTranscriber,
    terminology: terminology(),
    glucoseEntryUnit: null,
    onSaveFacts,
    onManualEntry: vi.fn(),
    onClose: vi.fn(),
    onSessionActivity: (active) => activity.push(active),
    ...overrides,
  };
  const view = render(<TellJagaOnScreen {...props} />);
  return { fake, loadTranscriber, resolveProvider, onSaveFacts, activity, view, messages: getMessages(locale), pending: VOICE_SCREEN_PENDING_COPY[locale] };
}

async function accept(context: ReturnType<typeof setup>) {
  const dialog = await screen.findByRole("dialog");
  fireEvent.change(within(dialog).getByLabelText(context.messages.aiAccess.passcodeLabel), { target: { value: PASSCODE } });
  fireEvent.click(within(dialog).getByRole("button", { name: context.messages.voice.disclosure.accept }));
}

async function listening(context: ReturnType<typeof setup>) {
  await waitFor(() => expect(screen.getByRole("button", { name: context.messages.voice.state.stop })).not.toBeDisabled());
  await act(async () => Promise.resolve());
}

/** Manual timers: tests fire the session limit explicitly. */
function manualClock() {
  const pending = new Map<number, { callback: () => void; ms: number }>();
  let next = 1;
  return {
    timers: {
      setTimeout: (callback: () => void, ms: number) => (pending.set(next, { callback, ms }), next++),
      clearTimeout: (handle: unknown) => void pending.delete(handle as number),
    },
    delays: () => [...pending.values()].map((entry) => entry.ms),
    fire(ms: number) {
      for (const [handle, entry] of [...pending]) if (entry.ms === ms) (pending.delete(handle), entry.callback());
    },
  };
}

afterEach(() => {
  cleanup();
  for (const recognizer of MockRecognition.instances) recognizer.end();
  MockRecognition.instances = [];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A recording browser-storage stand-in (this jsdom has no usable storage): every access is logged with its key. */
function recordingStorage(initial: Record<string, string>) {
  const store = new Map(Object.entries(initial));
  const touched: string[] = [];
  const storage = {
    getItem: (key: string) => (touched.push(`getItem:${key}`), store.get(key) ?? null),
    setItem: (key: string, value: string) => void (touched.push(`setItem:${key}`), store.set(key, value)),
    removeItem: (key: string) => void (touched.push(`removeItem:${key}`), store.delete(key)),
    key: (index: number) => (touched.push(`key:${index}`), [...store.keys()][index] ?? null),
    clear: () => void (touched.push("clear"), store.clear()),
    get length() {
      touched.push("length");
      return store.size;
    },
  };
  return { storage, touched, store };
}

describe("Tell JagaOn with Web Speech (draft copy pending owner approval)", () => {
  it("shows the Web Speech consent before EVERY start (never the Tencent text); the passcode is still required; buttons reuse the existing labels", async () => {
    const context = setup({ script: { providerStop: { kind: "NOT_APPLICABLE" }, segmentsOnStart: [{ kind: "FINAL", segmentId: "s1", text: "My sugar was 6.8 mmol" }] } });
    for (let round = 0; round < 2; round += 1) {
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByText(web.consentTitle)).toBeInTheDocument();
      for (const paragraph of web.consentBody) expect(within(dialog).getByText(paragraph)).toBeInTheDocument();
      expect(dialog.textContent).not.toContain("Tencent");
      expect(within(dialog).getByRole("button", { name: context.messages.voice.disclosure.accept })).toBeDisabled();
      expect(within(dialog).getByRole("button", { name: context.messages.voice.disclosure.decline })).toBeInTheDocument();
      expect(context.loadTranscriber).toHaveBeenCalledTimes(round);
      await accept(context);
      await listening(context);
      expect(context.loadTranscriber).toHaveBeenLastCalledWith(expect.any(Function), "WEB_SPEECH");
      fireEvent.click(screen.getByRole("button", { name: context.messages.voice.state.stop }));
      await screen.findByRole("button", { name: context.pending.card.save });
      fireEvent.click(screen.getByRole("button", { name: context.messages.voice.review.discard }));
      fireEvent.click(await screen.findByRole("button", { name: context.messages.voice.entry }));
    }
    expect(context.resolveProvider).toHaveBeenCalledTimes(3);
  });

  it("TRTC keeps its existing consent text unchanged", async () => {
    const context = setup({ provider: "TRTC" });
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(context.messages.voice.disclosure.title)).toBeInTheDocument();
    expect(within(dialog).getByText(context.messages.voice.disclosure.body)).toBeInTheDocument();
    expect(within(dialog).queryByText(web.consentTitle)).toBeNull();
    await accept(context);
    await listening(context);
    expect(context.loadTranscriber).toHaveBeenCalledWith(expect.any(Function), "TRTC");
  });

  it("a browser-initiated end shows the early-end notice over what was captured; nothing restarts; the notice goes once something is saved", async () => {
    const context = setup({ script: { providerStop: { kind: "NOT_APPLICABLE" }, segmentsOnStart: [{ kind: "FINAL", segmentId: "s1", text: "My sugar was 6.8 mmol" }], providerEndsAfterSegments: true } });
    await accept(context);
    const save = await screen.findByRole("button", { name: context.pending.card.save });
    expect(screen.getByText(web.earlyEnd)).toBeInTheDocument();
    expect(screen.getByText("My sugar was 6.8 mmol")).toBeInTheDocument();
    expect(context.fake.calls.filter((call) => call.startsWith("start"))).toEqual(["start:en"]);
    expect(context.loadTranscriber).toHaveBeenCalledTimes(1);
    expect(context.onSaveFacts).not.toHaveBeenCalled();
    fireEvent.click(save);
    await waitFor(() => expect(screen.getByText(context.pending.card.saved)).toBeInTheDocument());
    expect(screen.queryByText(web.earlyEnd)).toBeNull();
    expect(context.onSaveFacts).toHaveBeenCalledTimes(1);
  });

  it("an early end before anything was captured shows the approved empty variant with the manual-entry path; the person's own Stop never shows it", async () => {
    const early = setup({ script: { providerStop: { kind: "NOT_APPLICABLE" }, providerEndsAfterSegments: true } });
    await accept(early);
    await waitFor(() => expect(screen.getByText(early.messages.voice.review.nothingFound)).toBeInTheDocument());
    expect(screen.getByText(web.earlyEndEmpty)).toBeInTheDocument();
    expect(screen.queryByText(web.earlyEnd)).toBeNull();
    cleanup();
    const stopped = setup({ script: { providerStop: { kind: "NOT_APPLICABLE" }, segmentsOnStart: [{ kind: "FINAL", segmentId: "s1", text: "My sugar was 6.8 mmol" }] } });
    await accept(stopped);
    await listening(stopped);
    fireEvent.click(screen.getByRole("button", { name: stopped.messages.voice.state.stop }));
    await screen.findByRole("button", { name: stopped.pending.card.save });
    expect(screen.queryByText(web.earlyEnd)).toBeNull();
  });

  it("no fallback: a failed or unloadable Web Speech session shows its own failure path and never loads another provider", async () => {
    const failing = setup({ script: { start: { kind: "FAILED", reason: "PROVIDER_FAILURE", providerStop: { kind: "NOT_APPLICABLE" } } } });
    await accept(failing);
    await waitFor(() => expect(screen.getByText(failing.messages.voice.state.unavailable)).toBeInTheDocument());
    expect(failing.loadTranscriber.mock.calls.map((call) => call[1])).toEqual(["WEB_SPEECH"]);
    expect(failing.resolveProvider).toHaveBeenCalledTimes(1);
    cleanup();
    const denied = setup({ script: { start: { kind: "FAILED", reason: "PERMISSION_DENIED" } } });
    await accept(denied);
    await waitFor(() => expect(screen.getByText(denied.messages.voice.state.permissionDenied)).toBeInTheDocument());
    expect(denied.loadTranscriber.mock.calls.map((call) => call[1])).toEqual(["WEB_SPEECH"]);
    cleanup();
    const unloadable = setup({ transcriber: () => Promise.reject(new Error("TEST-ONLY")) });
    await accept(unloadable);
    await waitFor(() => expect(screen.getByText(unloadable.messages.voice.state.unavailable)).toBeInTheDocument());
    expect(unloadable.loadTranscriber.mock.calls.map((call) => call[1])).toEqual(["WEB_SPEECH"]);
  });

  it("unsupported browser or the Chinese UI: the existing unsupported/unavailable path at once (no disclosure, no loader)", async () => {
    const loadTranscriber = vi.fn();
    const unsupported = setup({ resolveProvider: async () => resolveVoiceProvider({ enabled: ["WEB_SPEECH"], webSpeechSupported: false, language: "en" }, { devSettingsEnabled: false, stored: null }), loadTranscriber });
    await waitFor(() => expect(screen.getByText(unsupported.messages.voice.state.unsupported)).toBeInTheDocument());
    expect(screen.queryByRole("dialog")).toBeNull();
    cleanup();
    const zh = setup({ locale: "zh-SG", resolveProvider: async () => resolveVoiceProvider({ enabled: ["WEB_SPEECH"], webSpeechSupported: true, language: "zh" }, { devSettingsEnabled: true, stored: "WEB_SPEECH" }), loadTranscriber });
    await waitFor(() => expect(screen.getByText(zh.messages.voice.state.unavailable)).toBeInTheDocument());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText(web.consentTitle)).toBeNull();
    expect(loadTranscriber).not.toHaveBeenCalled();
  });

  it("reports session activity while starting, listening and stopping, and after an unmount until the cancel released", async () => {
    const context = setup({ script: { providerStop: { kind: "NOT_APPLICABLE" }, release: "MANUAL" } });
    await accept(context);
    await listening(context);
    expect(context.activity.at(-1)).toBe(true);
    context.view.unmount();
    expect(context.activity.at(-1)).toBe(true);
    await act(async () => {
      context.fake.completeRelease();
      await Promise.resolve();
    });
    await waitFor(() => expect(context.activity.at(-1)).toBe(false));
  });

  it("duplicate prevention: a double Accept/Stop starts one session and stops it once; a reviewed fact saves once", async () => {
    const context = setup({ script: { providerStop: { kind: "NOT_APPLICABLE" }, segmentsOnStart: [{ kind: "FINAL", segmentId: "s1", text: "My sugar was 6.8 mmol" }] } });
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(context.messages.aiAccess.passcodeLabel), { target: { value: PASSCODE } });
    const acceptButton = within(dialog).getByRole("button", { name: context.messages.voice.disclosure.accept });
    fireEvent.click(acceptButton);
    fireEvent.click(acceptButton);
    await listening(context);
    const stop = screen.getByRole("button", { name: context.messages.voice.state.stop });
    fireEvent.click(stop);
    fireEvent.click(stop);
    const save = await screen.findByRole("button", { name: context.pending.card.save });
    fireEvent.click(save);
    fireEvent.click(save);
    await waitFor(() => expect(screen.getByText(context.pending.card.saved)).toBeInTheDocument());
    fireEvent.click(save);
    expect(context.loadTranscriber).toHaveBeenCalledTimes(1);
    expect(context.fake.calls.filter((call) => call.startsWith("start"))).toEqual(["start:en"]);
    expect(context.fake.calls.filter((call) => call === "release")).toEqual(["release"]);
    expect(context.onSaveFacts).toHaveBeenCalledTimes(1);
    expect(context.onSaveFacts).toHaveBeenCalledWith({ kind: "GLUCOSE", valueText: "6.8", unit: "MMOL_PER_L", unitSource: "SPOKEN" });
  });
});

describe("Web Speech redirect note (round 2) and the W-6a listening limit (round 3)", () => {
  it("redirect: a dose or health question in a Web Speech session shows the browser-speech note, never the Tencent note; TRTC keeps its note", async () => {
    for (const question of ["How many tablets should I take?", "Is a sugar of 15 dangerous?"]) {
      const context = setup({ script: { providerStop: { kind: "NOT_APPLICABLE" }, segmentsOnStart: [{ kind: "FINAL", segmentId: "s1", text: question }] } });
      await accept(context);
      await listening(context);
      fireEvent.click(screen.getByRole("button", { name: context.messages.voice.state.stop }));
      expect(await screen.findByText(web.transcribedNote)).toBeInTheDocument();
      expect(screen.queryByText(context.messages.voice.redirect.transcribedNote)).toBeNull();
      expect(document.body.textContent).not.toContain("Tencent");
      expect(screen.queryByRole("article")).toBeNull();
      expect(context.onSaveFacts).not.toHaveBeenCalled();
      cleanup();
    }
    const trtc = setup({ provider: "TRTC", script: { segmentsOnStart: [{ kind: "FINAL", segmentId: "s1", text: "How many tablets should I take?" }] } });
    await accept(trtc);
    await listening(trtc);
    fireEvent.click(screen.getByRole("button", { name: trtc.messages.voice.state.stop }));
    expect(await screen.findByText(trtc.messages.voice.redirect.transcribedNote)).toBeInTheDocument();
    expect(screen.queryByText(web.transcribedNote)).toBeNull();
  });

  it("W-6a ceiling pin: the limit is min(client default 60 s, server maximum); at the limit what was completed goes to review (the 60-second notice only when the limit was 60 s); nothing is saved until Save", async () => {
    // No `maxSessionSeconds` prop: the client default is under test.
    for (const [serverSeconds, expectedMs] of [[300, 60_000], [900, 60_000], [60, 60_000], [45, 45_000]] as const) {
      const clock = manualClock();
      const context = setup({ timers: clock.timers, script: { start: { kind: "STARTED", maxSessionSeconds: serverSeconds }, providerStop: { kind: "NOT_APPLICABLE" }, segmentsOnStart: [{ kind: "FINAL", segmentId: "s1", text: "My sugar was 6.8 mmol" }] } });
      await accept(context);
      await listening(context);
      expect(clock.delays(), `server ${serverSeconds} s`).toEqual([expectedMs]);
      await act(async () => {
        clock.fire(expectedMs);
        await Promise.resolve();
      });
      const save = await screen.findByRole("button", { name: context.pending.card.save });
      // Round 4: the "60-second" wording is true only for a 60 s limit; a lower server limit takes the plain stop path (no notice).
      if (expectedMs === 60_000) expect(screen.getByText(context.pending.limit.captured)).toBeInTheDocument();
      else expect(screen.queryByText(context.pending.limit.captured)).toBeNull();
      expect(screen.queryByText(context.pending.limit.empty)).toBeNull();
      expect(screen.queryByText(context.messages.voice.state.timedOut)).toBeNull();
      expect(screen.queryByText(web.earlyEnd)).toBeNull();
      expect(screen.getByText("My sugar was 6.8 mmol")).toBeInTheDocument();
      // Stopped like Stop (not cancelled); never saved automatically.
      expect(context.fake.calls).toEqual(["start:en", "stop", "release"]);
      expect(context.onSaveFacts).not.toHaveBeenCalled();
      // The person's explicit Save, once; the "nothing has been saved" notice then goes.
      fireEvent.click(save);
      await waitFor(() => expect(screen.getByText(context.pending.card.saved)).toBeInTheDocument());
      expect(context.onSaveFacts).toHaveBeenCalledTimes(1);
      expect(screen.queryByText(context.pending.limit.captured)).toBeNull();
      cleanup();
    }
  });

  it("W-6a at the limit: a late final during the flush counts, the unfinished interim is dropped; nothing captured shows the empty variant", async () => {
    const clock = manualClock();
    const context = setup({ timers: clock.timers, script: { start: { kind: "STARTED", maxSessionSeconds: 900 }, providerStop: { kind: "NOT_APPLICABLE" }, release: "MANUAL" } });
    await accept(context);
    await listening(context);
    act(() => {
      context.fake.emit({ kind: "FINAL", segmentId: "s1", text: "My sugar was 6.8 mmol" });
      context.fake.emit({ kind: "INTERIM", segmentId: "s2", text: "and I had" });
    });
    await act(async () => {
      clock.fire(60_000);
      await Promise.resolve();
    });
    act(() => {
      context.fake.emit({ kind: "FINAL", segmentId: "s2", text: "and I had chicken rice for lunch" });
      context.fake.emit({ kind: "INTERIM", segmentId: "s3", text: "and then I injected" });
    });
    await act(async () => {
      context.fake.completeRelease();
      await Promise.resolve();
    });
    await screen.findAllByRole("article");
    expect(screen.getByText("My sugar was 6.8 mmol and I had chicken rice for lunch")).toBeInTheDocument();
    expect(screen.queryByText(/then I injected/)).toBeNull();
    expect(screen.getByText(context.pending.limit.captured)).toBeInTheDocument();
    expect(context.onSaveFacts).not.toHaveBeenCalled();
    cleanup();

    const emptyClock = manualClock();
    const empty = setup({ timers: emptyClock.timers, script: { start: { kind: "STARTED", maxSessionSeconds: 900 }, providerStop: { kind: "NOT_APPLICABLE" } } });
    await accept(empty);
    await listening(empty);
    act(() => empty.fake.emit({ kind: "INTERIM", segmentId: "s1", text: "unfinished words" }));
    await act(async () => {
      emptyClock.fire(60_000);
      await Promise.resolve();
    });
    expect(await screen.findByText(empty.pending.limit.empty)).toBeInTheDocument();
    expect(screen.queryByText(empty.pending.limit.captured)).toBeNull();
    expect(screen.queryByText(/unfinished words/)).toBeNull();
    expect(screen.queryByRole("article")).toBeNull();
    expect(empty.onSaveFacts).not.toHaveBeenCalled();
  });

  it("W-6a: TRTC uses the same limit behaviour and notice (EN), and the ZH limit notice for TRTC", async () => {
    for (const locale of ["en-SG", "zh-SG"] as const) {
      const clock = manualClock();
      const text = locale === "en-SG" ? "My sugar was 6.8 mmol" : "血糖六点八毫摩尔";
      const context = setup({ locale, provider: "TRTC", timers: clock.timers, script: { start: { kind: "STARTED", maxSessionSeconds: 900 }, segmentsOnStart: [{ kind: "FINAL", segmentId: "s1", text }] } });
      await accept(context);
      await listening(context);
      expect(clock.delays()).toEqual([60_000]);
      await act(async () => {
        clock.fire(60_000);
        await Promise.resolve();
      });
      await screen.findByRole("button", { name: context.pending.card.save });
      expect(screen.getByText(context.pending.limit.captured)).toBeInTheDocument();
      expect(context.fake.calls).toEqual(["start:" + (locale === "en-SG" ? "en" : "zh"), "stop", "release"]);
      expect(context.onSaveFacts).not.toHaveBeenCalled();
      cleanup();
    }
  });
});

/**
 * Round 4 (owner requirement): every end notice and the health/dose note checked against the state it actually appears in. The
 * notices say "Nothing has been saved", so they are hidden once something is saved; the "captured" wording needs the transcript to be
 * shown below; the health/dose note appears only on the redirect-only screen (nothing saveable there).
 */
describe("Round 4: notice wording is true in every state it appears in", () => {
  const earlyEnd = (text: string) => ({ script: { providerStop: { kind: "NOT_APPLICABLE" as const }, segmentsOnStart: [{ kind: "FINAL" as const, segmentId: "s1", text }], providerEndsAfterSegments: true } });
  async function atLimit(text: string) {
    const clock = manualClock();
    const context = setup({ timers: clock.timers, script: { start: { kind: "STARTED", maxSessionSeconds: 900 }, providerStop: { kind: "NOT_APPLICABLE" }, segmentsOnStart: [{ kind: "FINAL", segmentId: "s1", text }] } });
    await accept(context);
    await listening(context);
    await act(async () => {
      clock.fire(60_000);
      await Promise.resolve();
    });
    return context;
  }
  const visibleText = () => document.body.textContent ?? "";

  it("mixed session (a reading plus a dose question), browser end: the captured notice until the reading is saved; the redirect stays true; the health note is not shown; nothing claims the session was unsaved after the save", async () => {
    const context = setup(earlyEnd("sugar 15 mmol, how many units now"));
    await accept(context);
    const save = await screen.findByRole("button", { name: context.pending.card.save });
    expect(screen.getByText(web.earlyEnd)).toBeInTheDocument();
    expect(screen.getByText(context.messages.voice.redirect.body)).toBeInTheDocument();
    expect(screen.queryByText(web.transcribedNote)).toBeNull();
    expect(screen.queryByText(context.messages.voice.redirect.transcribedNote)).toBeNull();
    fireEvent.click(save);
    await waitFor(() => expect(screen.getByText(context.pending.card.saved)).toBeInTheDocument());
    expect(context.onSaveFacts).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(web.earlyEnd)).toBeNull();
    expect(screen.getByText(context.messages.voice.redirect.body)).toBeInTheDocument();
    expect(screen.queryByText(web.transcribedNote)).toBeNull();
    expect(visibleText()).not.toMatch(/Nothing has been saved|nothing was saved/i);
  });

  it("mixed session at the 60 s limit: the same, with the limit notice", async () => {
    const context = await atLimit("sugar 15 mmol, how many units now");
    const save = await screen.findByRole("button", { name: context.pending.card.save });
    expect(screen.getByText(context.pending.limit.captured)).toBeInTheDocument();
    expect(screen.queryByText(web.transcribedNote)).toBeNull();
    fireEvent.click(save);
    await waitFor(() => expect(screen.getByText(context.pending.card.saved)).toBeInTheDocument());
    expect(screen.queryByText(context.pending.limit.captured)).toBeNull();
    expect(visibleText()).not.toMatch(/Nothing has been saved|nothing was saved/i);
  });

  it("redirect-only (health question), browser end: the captured notice over the shown transcript and the approved health note; nothing saveable", async () => {
    const context = setup(earlyEnd("Is a sugar of 15 dangerous?"));
    await accept(context);
    expect(await screen.findByText(web.transcribedNote)).toBeInTheDocument();
    expect(screen.getByText(web.earlyEnd)).toBeInTheDocument();
    expect(screen.getByText("Is a sugar of 15 dangerous?")).toBeInTheDocument();
    expect(screen.queryByRole("article")).toBeNull();
    expect(screen.queryByRole("button", { name: context.pending.card.save })).toBeNull();
    expect(context.onSaveFacts).not.toHaveBeenCalled();
  });

  it("text captured but no cards (only words JagaOn cannot use), at the limit: the transcript and the 'Not captured' words are shown below, so the captured wording is true", async () => {
    const context = await atLimit("hello there");
    expect(await screen.findByText(context.pending.review.notUnderstoodHeading)).toBeInTheDocument();
    expect(screen.getAllByText(/hello there/).length).toBeGreaterThan(0);
    expect(screen.getByText(context.pending.limit.captured)).toBeInTheDocument();
    expect(screen.queryByRole("article")).toBeNull();
    expect(context.onSaveFacts).not.toHaveBeenCalled();
  });

  it("round 6: text captured but nothing understood and no transcript shown (no words, or too long): the approved 'not shown' wording, never the captured or empty wording", async () => {
    const tooLong = "and so on ".repeat(130).trim();
    for (const text of ["...", tooLong]) {
      const early = setup(earlyEnd(text));
      await accept(early);
      await waitFor(() => expect(screen.getByText(early.messages.voice.review.nothingFound)).toBeInTheDocument());
      expect(screen.getByText(web.earlyEndNotShown)).toBeInTheDocument();
      for (const other of [web.earlyEnd, web.earlyEndEmpty, early.pending.limit.captured, early.pending.limit.empty, early.pending.limit.notShown]) expect(screen.queryByText(other)).toBeNull();
      // No transcript is displayed in this state (which is why the "captured below" wording would be untrue).
      expect(screen.queryByText(early.messages.voice.review.transcriptLabel)).toBeNull();
      cleanup();
      const limit = await atLimit(text);
      await waitFor(() => expect(screen.getByText(limit.messages.voice.review.nothingFound)).toBeInTheDocument());
      expect(screen.getByText(limit.pending.limit.notShown)).toBeInTheDocument();
      for (const other of [web.earlyEnd, web.earlyEndEmpty, web.earlyEndNotShown, limit.pending.limit.captured, limit.pending.limit.empty]) expect(screen.queryByText(other)).toBeNull();
      expect(limit.onSaveFacts).not.toHaveBeenCalled();
      cleanup();
    }
  });

  it("round 6: a limit below 60 s still shows no limit notice in the not-shown state (the '60-second' wording would be untrue)", async () => {
    const clock = manualClock();
    const context = setup({ timers: clock.timers, script: { start: { kind: "STARTED", maxSessionSeconds: 45 }, providerStop: { kind: "NOT_APPLICABLE" }, segmentsOnStart: [{ kind: "FINAL", segmentId: "s1", text: "..." }] } });
    await accept(context);
    await listening(context);
    await act(async () => {
      clock.fire(45_000);
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByText(context.messages.voice.review.nothingFound)).toBeInTheDocument());
    for (const other of [context.pending.limit.captured, context.pending.limit.empty, context.pending.limit.notShown]) expect(screen.queryByText(other)).toBeNull();
  });
});

/**
 * Round 7 (final review a1): a save in an earlier session must not hide the next session's end notice. Repro: save in session 1 →
 * Discard → Tell JagaOn again → session 2 is ended by the browser or the 60 s limit and lands in redirect-only or nothing-understood.
 */
describe("Round 7: an earlier session's save never hides the next session's end notice", () => {
  async function savedThenDiscarded(scripts: FakeVoiceTranscriberScript[], timers?: ReturnType<typeof manualClock>["timers"]) {
    const fakes = scripts.map((script) => createFakeVoiceTranscriber(script));
    let next = 0;
    const context = setup({ ...(timers ? { timers } : {}), transcriber: async () => fakes[next++]! });
    await accept(context);
    await listening(context);
    fireEvent.click(screen.getByRole("button", { name: context.messages.voice.state.stop }));
    const save = await screen.findByRole("button", { name: context.pending.card.save });
    fireEvent.click(save);
    await waitFor(() => expect(screen.getByText(context.pending.card.saved)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: context.messages.voice.review.discard }));
    await waitFor(() => expect(screen.getByText(context.pending.state.doneSaved)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: context.messages.voice.entry }));
    await accept(context);
    return context;
  }
  const saved: FakeVoiceTranscriberScript = { providerStop: { kind: "NOT_APPLICABLE" }, segmentsOnStart: [{ kind: "FINAL", segmentId: "s1", text: "My sugar was 6.8 mmol" }] };

  it("browser end in session 2: redirect-only shows the captured notice; nothing-understood shows the empty notice", async () => {
    const redirect = await savedThenDiscarded([saved, { providerStop: { kind: "NOT_APPLICABLE" }, segmentsOnStart: [{ kind: "FINAL", segmentId: "s1", text: "Is a sugar of 15 dangerous?" }], providerEndsAfterSegments: true }]);
    expect(await screen.findByText(web.transcribedNote)).toBeInTheDocument();
    expect(screen.getByText(web.earlyEnd)).toBeInTheDocument();
    expect(redirect.onSaveFacts).toHaveBeenCalledTimes(1);
    cleanup();
    await savedThenDiscarded([saved, { providerStop: { kind: "NOT_APPLICABLE" }, providerEndsAfterSegments: true }]);
    expect(await screen.findByText(web.earlyEndEmpty)).toBeInTheDocument();
  });

  it("60 s limit in session 2: redirect-only shows the captured limit notice; nothing-understood shows the empty limit notice", async () => {
    for (const [text, notice] of [["How many tablets should I take?", "captured"], [null, "empty"]] as const) {
      const clock = manualClock();
      const second: FakeVoiceTranscriberScript = { start: { kind: "STARTED", maxSessionSeconds: 900 }, providerStop: { kind: "NOT_APPLICABLE" }, segmentsOnStart: text === null ? [] : [{ kind: "FINAL", segmentId: "s1", text }] };
      const context = await savedThenDiscarded([{ ...saved, start: { kind: "STARTED", maxSessionSeconds: 900 } }, second], clock.timers);
      await listening(context);
      await act(async () => {
        clock.fire(60_000);
        await Promise.resolve();
      });
      expect(await screen.findByText(context.pending.limit[notice])).toBeInTheDocument();
      cleanup();
    }
  });

  it("unchanged within one session: the notice still goes once something is saved in that session", async () => {
    const context = setup({ script: { ...saved, providerEndsAfterSegments: true } });
    await accept(context);
    const save = await screen.findByRole("button", { name: context.pending.card.save });
    expect(screen.getByText(web.earlyEnd)).toBeInTheDocument();
    fireEvent.click(save);
    await waitFor(() => expect(screen.getByText(context.pending.card.saved)).toBeInTheDocument());
    expect(screen.queryByText(web.earlyEnd)).toBeNull();
  });
});

describe("Web Speech with the real adapter and loader (mock recognizer, stubbed access route): TRTC safeguards untouched", () => {
  it("never reads, writes or clears the TRTC marker or clearance keys; an existing TRTC marker does not block Web Speech; no recovery helper", async () => {
    vi.stubGlobal("webkitSpeechRecognition", MockRecognition);
    const fetcher = vi.fn(async (input: string) => {
      expect(input).toBe("/api/voice/access");
      return new Response(JSON.stringify({ kind: "GRANTED", maxSessionSeconds: 45 }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetcher);
    const marker = JSON.stringify([{ markerId: "m1", state: "STOP_UNCONFIRMED", robotId: "robot-1", taskId: "task-1", recordedAt: 1 }]);
    const { storage, touched, store } = recordingStorage({ [JAGAON_PROVIDER_TASK_MARKERS_KEY]: marker });
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("sessionStorage", storage);
    const context = setup({ transcriber: () => loadWebSpeechTranscriber(() => PASSCODE) });
    await accept(context);
    await waitFor(() => expect(MockRecognition.instances).toHaveLength(1));
    await listening(context);
    const recognizer = MockRecognition.instances[0]!;
    expect(recognizer.lang).toBe("en-SG");
    act(() => recognizer.say(0, "my sugar", false));
    expect(screen.getByText("my sugar")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: context.messages.voice.state.stop }));
    // The last final arrives after Stop, before the browser's end: it is kept.
    act(() => recognizer.say(0, "My sugar was 6.8 mmol", true));
    act(() => recognizer.end());
    await screen.findByRole("button", { name: context.pending.card.save });
    expect(screen.getByText("My sugar was 6.8 mmol")).toBeInTheDocument();
    expect(recognizer.calls).toEqual(["start", "stop"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(touched.filter((entry) => entry.includes(JAGAON_PROVIDER_TASK_MARKERS_KEY) || entry.includes(JAGAON_PROVIDER_TASK_CLEARANCES_KEY))).toEqual([]);
    expect(touched).toEqual([]);
    expect(store.get(JAGAON_PROVIDER_TASK_MARKERS_KEY)).toBe(marker);
    expect(store.has(JAGAON_PROVIDER_TASK_CLEARANCES_KEY)).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(window, VOICE_RECOVERY_GLOBAL)).toBe(false);
  });

  it("the same existing TRTC marker still blocks a TRTC start (nothing loaded, no credential requested)", async () => {
    const marker = JSON.stringify([{ markerId: "m1", state: "STOP_UNCONFIRMED", robotId: "robot-1", taskId: "task-1", recordedAt: 1 }]);
    const { storage, store } = recordingStorage({ [JAGAON_PROVIDER_TASK_MARKERS_KEY]: marker });
    const requestCredential = vi.fn();
    const loadSdk = vi.fn();
    const adapter = createTrtcTranscriberAdapter({ requestCredential, loadSdk, storage: () => storage, locks: () => null });
    const grant = await import("@/application/voice/voice-cloud-disclosure").then(({ voiceDisclosureReducer, VOICE_DISCLOSURE_INITIAL_STATE }) => {
      const accepted = voiceDisclosureReducer(voiceDisclosureReducer(VOICE_DISCLOSURE_INITIAL_STATE, { type: "REQUEST_START", language: "en" }), { type: "ACCEPT" });
      if (accepted.kind !== "GRANTED") throw new Error("no grant");
      return accepted.grant;
    });
    const result = await adapter.start({ language: "en", grant, onSegment: () => undefined, onFailure: () => undefined, signal: new AbortController().signal });
    expect(result).toMatchObject({ kind: "FAILED", reason: "PROVIDER_FAILURE" });
    expect(requestCredential).not.toHaveBeenCalled();
    expect(loadSdk).not.toHaveBeenCalled();
    expect(store.get(JAGAON_PROVIDER_TASK_MARKERS_KEY)).toBe(marker);
  });
});
