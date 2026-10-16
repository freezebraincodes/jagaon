// @vitest-environment jsdom
// jsdom is deliberate: the real app shell over the real runtime (fake IndexedDB), like the existing app voice tests. Synthetic data only;
// every provider loader is a test spy returning the scripted fake (no microphone, no speech service, no Tencent call).
import Dexie from "dexie";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserJournalRuntime, type BrowserJournalRuntimeOptions } from "@/application/journal/browser-journal-runtime";
import { createDemoOnboardingRepository, createMemoryOnboardingStorage, DEMO_ONBOARDING_STORAGE_KEY } from "@/application/onboarding/demo-onboarding-repository";
import { createPreparedOnboardingState } from "@/application/onboarding/prepared-onboarding-fixture";
import { createPopulatedDataset, installFakeIndexedDb, PACKET10_NOW } from "@/application/storage/packet10-test-support";
import { createFakeVoiceTranscriber, type FakeVoiceTranscriber, type FakeVoiceTranscriberScript } from "@/application/voice/fake-voice-transcriber";
import { VOICE_PROVIDER_PREFERENCE_KEY, type VoiceProviderId } from "@/application/voice/voice-provider-selection";
import { getMessages } from "@/i18n/get-messages";
import { JagaOnApp } from "../JagaOnApp";
import { VOICE_PROVIDER_SETTINGS_COPY } from "./voice-provider-settings-copy";
import { VOICE_SCREEN_PENDING_COPY, VOICE_WEB_SPEECH_COPY } from "./voice-screen-copy";

installFakeIndexedDb();
const TIMEOUT = 240_000;
const m = getMessages("en-SG");
const settingsCopy = VOICE_PROVIDER_SETTINGS_COPY["en-SG"];
const web = VOICE_WEB_SPEECH_COPY["en-SG"];
const names: string[] = [];
afterEach(async () => {
  cleanup();
  for (const name of names.splice(0)) await Dexie.delete(name);
});

/** `passcodeRequired` (Owner decision 2026-10-12, optional passcodes): when given, the probe answers `{ providers, passcodeRequired }`. */
type Options = { devSettings: boolean; enabled: VoiceProviderId[]; supported?: boolean; stored?: string; script?: FakeVoiceTranscriberScript; passcodeRequired?: boolean };

async function mountApp({ devSettings, enabled, supported = true, stored, script = { providerStop: { kind: "NOT_APPLICABLE" } }, passcodeRequired }: Options) {
  const { name, runtime } = await createPopulatedDataset();
  names.push(name);
  runtime.close();
  const memory = createMemoryOnboardingStorage(stored === undefined ? {} : { [VOICE_PROVIDER_PREFERENCE_KEY]: stored });
  const reads = vi.fn((key: string) => memory.getItem(key));
  const preference = { getItem: reads, setItem: memory.setItem, removeItem: memory.removeItem };
  const fakes: FakeVoiceTranscriber[] = [];
  const control = { enabled, script };
  const load = (provider: VoiceProviderId) =>
    vi.fn(async () => {
      void provider;
      const fake = createFakeVoiceTranscriber(control.script);
      fakes.push(fake);
      return fake;
    });
  const loaders = { TRTC: load("TRTC"), WEB_SPEECH: load("WEB_SPEECH") };
  const probe = vi.fn(async () => (passcodeRequired === undefined ? control.enabled : { providers: control.enabled, passcodeRequired }));
  render(
    <JagaOnApp
      runtimeFactory={(_name?: string, options?: BrowserJournalRuntimeOptions) => createBrowserJournalRuntime(name, { ...options, now: () => PACKET10_NOW })}
      onboardingRepositoryFactory={() => createDemoOnboardingRepository(createMemoryOnboardingStorage({ [DEMO_ONBOARDING_STORAGE_KEY]: JSON.stringify(createPreparedOnboardingState("en-SG", PACKET10_NOW)) }))}
      appointmentNoteStorageFactory={() => createMemoryOnboardingStorage({})}
      voiceProvidersProbe={probe}
      voiceProviderLoaders={loaders}
      webSpeechSupported={() => supported}
      devSettingsEnabled={devSettings}
      voicePreferenceStorageFactory={() => preference}
    />,
  );
  await screen.findByRole("button", { name: m.voice.entry }, { timeout: 30_000 });
  return { preference, reads, loaders, probe, fakes, control };
}

const openMore = async () => {
  for (let step = 0; step < 4 && screen.queryByRole("navigation") === null; step += 1) {
    fireEvent.click(document.querySelector(".screen-back-button") as HTMLButtonElement);
    await act(async () => Promise.resolve());
  }
  fireEvent.click(within(screen.getByRole("navigation")).getByRole("button", { name: m.shared.navMore }));
  await screen.findByRole("heading", { name: m.more.title });
};
const openToday = async () => {
  for (let step = 0; step < 4 && screen.queryByRole("navigation") === null; step += 1) {
    fireEvent.click(document.querySelector(".screen-back-button") as HTMLButtonElement);
    await act(async () => Promise.resolve());
  }
  fireEvent.click(within(screen.getByRole("navigation")).getByRole("button", { name: m.shared.navToday }));
  return screen.findByRole("button", { name: m.voice.entry }, { timeout: 30_000 });
};
const openVoice = async () => {
  const entry = await openToday();
  await waitFor(() => expect(entry).not.toBeDisabled(), { timeout: 30_000 });
  fireEvent.click(entry);
};
const radio = (provider: VoiceProviderId) => screen.getByRole("radio", { name: settingsCopy.providers[provider] }) as HTMLInputElement;

describe("Web Speech provider choice in the app (developer settings; draft copy pending owner approval)", () => {
  it(
    "owner decision 2026-10-15: Tencent speech's daily limit used up: the dialog switches to the browser's speech, which stays chosen for the day",
    async () => {
      const limit = VOICE_SCREEN_PENDING_COPY["en-SG"].dailyLimit;
      const app = await mountApp({ devSettings: false, enabled: ["TRTC", "WEB_SPEECH"], passcodeRequired: false, script: { start: { kind: "FAILED", reason: "CREDENTIAL_REFUSED", credentialRefusal: "MINUTES_EXHAUSTED" } } });
      await openVoice();
      fireEvent.click(await screen.findByRole("button", { name: m.voice.disclosure.accept }));
      const dialog = await screen.findByRole("dialog", { name: limit.title });
      await waitFor(() => expect(app.loaders.TRTC).toHaveBeenCalledTimes(1));
      app.control.script = { providerStop: { kind: "NOT_APPLICABLE" } };
      fireEvent.click(within(dialog).getByRole("button", { name: limit.useBrowser }));
      expect(await screen.findByText(web.consentTitle)).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: m.voice.disclosure.accept }));
      await waitFor(() => expect(app.loaders.WEB_SPEECH).toHaveBeenCalledTimes(1));
      // Leaving and coming back the same day: the browser's speech is still the one offered.
      await openVoice();
      expect(await screen.findByText(web.consentTitle)).toBeInTheDocument();
      expect(app.loaders.TRTC).toHaveBeenCalledTimes(1);
    },
    TIMEOUT,
  );

  it(
    "flag off: no System settings section; the stored choice is not even read; the first enabled, supported provider is used",
    async () => {
      const app = await mountApp({ devSettings: false, enabled: ["WEB_SPEECH", "TRTC"], stored: "TRTC" });
      await openMore();
      expect(screen.queryByText(settingsCopy.heading)).toBeNull();
      expect(screen.queryByRole("radio", { name: settingsCopy.providers.TRTC })).toBeNull();
      await openVoice();
      expect(await screen.findByText(web.consentTitle)).toBeInTheDocument();
      expect(app.reads).not.toHaveBeenCalled();
      expect(app.loaders.TRTC).not.toHaveBeenCalled();
      expect(app.loaders.WEB_SPEECH).not.toHaveBeenCalled();
    },
    TIMEOUT,
  );

  it(
    "flag on: only enabled AND supported providers are selectable (others: one-line reason); a change only remembers the choice; the next session uses it",
    async () => {
      const app = await mountApp({ devSettings: true, enabled: ["WEB_SPEECH", "TRTC"] });
      await openMore();
      expect(screen.getByText(settingsCopy.heading)).toBeInTheDocument();
      await waitFor(() => expect(radio("WEB_SPEECH").checked).toBe(true));
      expect(radio("TRTC").disabled).toBe(false);
      const section = radio("TRTC").closest("fieldset") as HTMLElement;
      expect(section.textContent).not.toMatch(/passcode|secret|key|usersig|sdkappid|spend|activat|transcript/i);
      fireEvent.click(radio("TRTC"));
      await waitFor(() => expect(radio("TRTC").checked).toBe(true));
      expect(app.preference.getItem(VOICE_PROVIDER_PREFERENCE_KEY)).toBe("TRTC");
      // Changing the setting starts nothing.
      await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
      expect(app.loaders.TRTC).not.toHaveBeenCalled();
      expect(app.loaders.WEB_SPEECH).not.toHaveBeenCalled();
      expect(app.fakes).toEqual([]);
      await openVoice();
      expect(await screen.findByText(m.voice.disclosure.title)).toBeInTheDocument();
      expect(screen.queryByText(web.consentTitle)).toBeNull();
      fireEvent.change(screen.getByLabelText(m.aiAccess.passcodeLabel), { target: { value: "TEST-ONLY-voice-passcode" } });
      fireEvent.click(screen.getByRole("button", { name: m.voice.disclosure.accept }));
      await waitFor(() => expect(app.loaders.TRTC).toHaveBeenCalledTimes(1));
      expect(app.loaders.WEB_SPEECH).not.toHaveBeenCalled();

      // Unsupported browser: Web Speech shows "Not supported by this browser." and cannot be chosen.
      cleanup();
      await mountApp({ devSettings: true, enabled: ["WEB_SPEECH", "TRTC"], supported: false });
      await openMore();
      await waitFor(() => expect(radio("TRTC").checked).toBe(true));
      expect(radio("WEB_SPEECH").disabled).toBe(true);
      expect(screen.getByText(settingsCopy.reasons.NOT_SUPPORTED)).toBeInTheDocument();
    },
    TIMEOUT,
  );

  it(
    "a stored choice that is no longer enabled is ignored (not rewritten); voice off (no provider enabled) is unavailable at once",
    async () => {
      const app = await mountApp({ devSettings: true, enabled: ["TRTC"], stored: "WEB_SPEECH" });
      await openMore();
      await waitFor(() => expect(radio("TRTC").checked).toBe(true));
      expect(radio("WEB_SPEECH").disabled).toBe(true);
      expect(screen.getByText(settingsCopy.reasons.NOT_ENABLED)).toBeInTheDocument();
      expect(app.preference.getItem(VOICE_PROVIDER_PREFERENCE_KEY)).toBe("WEB_SPEECH");
      await openVoice();
      expect(await screen.findByText(m.voice.disclosure.title)).toBeInTheDocument();

      // JAGAON_VOICE_CLOUD off: the probe enables nothing; voice is unavailable whatever is stored.
      cleanup();
      const off = await mountApp({ devSettings: true, enabled: [], stored: "WEB_SPEECH" });
      await openVoice();
      expect(await screen.findByText(m.voice.state.unavailable)).toBeInTheDocument();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(off.loaders.TRTC).not.toHaveBeenCalled();
      expect(off.loaders.WEB_SPEECH).not.toHaveBeenCalled();
      await openMore();
      await waitFor(() => expect(radio("TRTC").disabled).toBe(true));
      expect(radio("WEB_SPEECH").disabled).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "no fallback: when the chosen provider fails to load or to start, the other provider is never loaded or started",
    async () => {
      const app = await mountApp({ devSettings: true, enabled: ["WEB_SPEECH", "TRTC"], script: { start: { kind: "FAILED", reason: "PROVIDER_FAILURE", providerStop: { kind: "NOT_APPLICABLE" } } } });
      await openVoice();
      fireEvent.change(await screen.findByLabelText(m.aiAccess.passcodeLabel), { target: { value: "TEST-ONLY-voice-passcode" } });
      fireEvent.click(screen.getByRole("button", { name: m.voice.disclosure.accept }));
      expect(await screen.findByText(m.voice.state.unavailable)).toBeInTheDocument();
      expect(app.loaders.WEB_SPEECH).toHaveBeenCalledTimes(1);
      expect(app.loaders.TRTC).not.toHaveBeenCalled();
      // A loader that cannot load: the same unavailable path, and still never the other provider.
      app.loaders.WEB_SPEECH.mockImplementationOnce(() => Promise.reject(new Error("TEST-ONLY")));
      await openVoice();
      fireEvent.change(await screen.findByLabelText(m.aiAccess.passcodeLabel), { target: { value: "TEST-ONLY-voice-passcode" } });
      fireEvent.click(screen.getByRole("button", { name: m.voice.disclosure.accept }));
      await waitFor(() => expect(app.loaders.WEB_SPEECH).toHaveBeenCalledTimes(2));
      expect(await screen.findByText(m.voice.state.unavailable)).toBeInTheDocument();
      await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
      expect(app.loaders.TRTC).not.toHaveBeenCalled();
      expect(app.fakes).toHaveLength(1);
    },
    TIMEOUT,
  );

  it(
    "the selector is disabled while a session is active (also during the cancel after leaving the screen), and enabled once it released",
    async () => {
      const app = await mountApp({ devSettings: true, enabled: ["WEB_SPEECH", "TRTC"], script: { providerStop: { kind: "NOT_APPLICABLE" }, release: "MANUAL" } });
      await openVoice();
      fireEvent.change(await screen.findByLabelText(m.aiAccess.passcodeLabel), { target: { value: "TEST-ONLY-voice-passcode" } });
      fireEvent.click(screen.getByRole("button", { name: m.voice.disclosure.accept }));
      await waitFor(() => expect(screen.getByRole("button", { name: m.voice.state.stop })).not.toBeDisabled(), { timeout: 30_000 });
      // Leaving the screen cancels the session; its release is still pending.
      await openMore();
      const fieldset = radio("TRTC").closest("fieldset") as HTMLFieldSetElement;
      expect(fieldset.disabled).toBe(true);
      fireEvent.click(radio("TRTC"));
      expect(app.preference.getItem(VOICE_PROVIDER_PREFERENCE_KEY)).toBeNull();
      expect(app.fakes[0]!.calls).toEqual(["start:en", "cancel"]);
      await act(async () => {
        app.fakes[0]!.completeRelease();
        await Promise.resolve();
      });
      await waitFor(() => expect(fieldset.disabled).toBe(false));
      // Still the same single session: nothing restarted, no other provider loaded.
      expect(app.loaders.WEB_SPEECH).toHaveBeenCalledTimes(1);
      expect(app.loaders.TRTC).not.toHaveBeenCalled();
      expect(app.fakes).toHaveLength(1);
    },
    TIMEOUT,
  );
});

// Owner decision 2026-10-12 (optional passcodes): the app passes the probe's `passcodeRequired` to the screen (consent → microphone)
// and to the provider's loader; the System settings panel still lists the providers from the same probe.
describe("optional voice passcode in the app (Owner decision 2026-10-12, optional passcodes)", () => {
  it(
    "no passcode required: the consent has no passcode field, Accept starts the session, the loader is told; the panel still lists the providers",
    async () => {
      const app = await mountApp({ devSettings: true, enabled: ["WEB_SPEECH", "TRTC"], passcodeRequired: false });
      await openMore();
      await waitFor(() => expect(radio("WEB_SPEECH").checked).toBe(true));
      expect(radio("TRTC").disabled).toBe(false);
      await openVoice();
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByText(web.consentTitle)).toBeInTheDocument();
      expect(within(dialog).queryByLabelText(m.aiAccess.passcodeLabel)).toBeNull();
      fireEvent.click(within(dialog).getByRole("button", { name: m.voice.disclosure.accept }));
      await waitFor(() => expect(app.loaders.WEB_SPEECH).toHaveBeenCalledTimes(1));
      expect(app.loaders.WEB_SPEECH).toHaveBeenCalledWith(expect.any(Function), { passcodeRequired: false });
      expect((app.loaders.WEB_SPEECH.mock.calls[0] as unknown as [() => string | null])[0]()).toBeNull();
      expect(app.loaders.TRTC).not.toHaveBeenCalled();
    },
    TIMEOUT,
  );

  it(
    "passcode required (or a bare provider list): the passcode field is shown and the loader is told it is required",
    async () => {
      for (const passcodeRequired of [true, undefined]) {
        const app = await mountApp({ devSettings: false, enabled: ["TRTC"], passcodeRequired });
        await openVoice();
        const dialog = await screen.findByRole("dialog");
        expect(within(dialog).getByRole("button", { name: m.voice.disclosure.accept })).toBeDisabled();
        fireEvent.change(within(dialog).getByLabelText(m.aiAccess.passcodeLabel), { target: { value: "TEST-ONLY-voice-passcode" } });
        fireEvent.click(within(dialog).getByRole("button", { name: m.voice.disclosure.accept }));
        await waitFor(() => expect(app.loaders.TRTC).toHaveBeenCalledTimes(1));
        expect(app.loaders.TRTC).toHaveBeenCalledWith(expect.any(Function), { passcodeRequired: true });
        expect((app.loaders.TRTC.mock.calls[0] as unknown as [() => string | null])[0]()).toBe("TEST-ONLY-voice-passcode");
        cleanup();
      }
    },
    TIMEOUT,
  );
});
