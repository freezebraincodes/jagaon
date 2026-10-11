// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  readVoiceProviderPreference,
  resolveVoiceProvider,
  VOICE_PROVIDER_PREFERENCE_KEY,
  voiceProviderStatuses,
  writeVoiceProviderPreference,
  type VoiceProviderEnvironment,
  type VoiceProviderId,
} from "./voice-provider-selection";

const env = (enabled: VoiceProviderId[], webSpeechSupported = true, language: "en" | "zh" = "en"): VoiceProviderEnvironment => ({ enabled, webSpeechSupported, language });
const OFF = { devSettingsEnabled: false, stored: null };

describe("Web Speech: voice provider selection (pure)", () => {
  it("default: the first enabled AND usable provider in the deployment's order", () => {
    expect(resolveVoiceProvider(env(["TRTC"]), OFF)).toEqual({ kind: "AVAILABLE", provider: "TRTC" });
    expect(resolveVoiceProvider(env(["WEB_SPEECH"]), OFF)).toEqual({ kind: "AVAILABLE", provider: "WEB_SPEECH" });
    expect(resolveVoiceProvider(env(["WEB_SPEECH", "TRTC"]), OFF)).toEqual({ kind: "AVAILABLE", provider: "WEB_SPEECH" });
    expect(resolveVoiceProvider(env(["TRTC", "WEB_SPEECH"]), OFF)).toEqual({ kind: "AVAILABLE", provider: "TRTC" });
    // Web Speech first but unsupported here: the next usable one (a default, not a session fallback).
    expect(resolveVoiceProvider(env(["WEB_SPEECH", "TRTC"], false), OFF)).toEqual({ kind: "AVAILABLE", provider: "TRTC" });
  });

  it("nothing usable: unsupported browser vs unavailable (voice off, nothing enabled, or a Chinese UI with Web Speech only)", () => {
    expect(resolveVoiceProvider(env([]), OFF)).toEqual({ kind: "UNAVAILABLE" });
    expect(resolveVoiceProvider(env(["WEB_SPEECH"], false), OFF)).toEqual({ kind: "UNSUPPORTED" });
    expect(resolveVoiceProvider(env(["WEB_SPEECH"], true, "zh"), OFF)).toEqual({ kind: "UNAVAILABLE" });
    expect(resolveVoiceProvider(env(["WEB_SPEECH"], false, "zh"), OFF)).toEqual({ kind: "UNAVAILABLE" });
  });

  it("the Chinese UI never offers Web Speech; TRTC is unchanged in either language", () => {
    expect(resolveVoiceProvider(env(["WEB_SPEECH", "TRTC"], true, "zh"), OFF)).toEqual({ kind: "AVAILABLE", provider: "TRTC" });
    expect(resolveVoiceProvider(env(["WEB_SPEECH", "TRTC"], true, "zh"), { devSettingsEnabled: true, stored: "WEB_SPEECH" })).toEqual({ kind: "AVAILABLE", provider: "TRTC" });
    expect(voiceProviderStatuses(env(["WEB_SPEECH", "TRTC"], true, "zh"))).toEqual([
      { provider: "WEB_SPEECH", status: "NOT_IN_LANGUAGE" },
      { provider: "TRTC", status: "AVAILABLE" },
    ]);
  });

  it("the stored choice applies only with the developer settings on, and only while it is enabled AND usable (else ignored)", () => {
    const both = env(["TRTC", "WEB_SPEECH"]);
    expect(resolveVoiceProvider(both, { devSettingsEnabled: true, stored: "WEB_SPEECH" })).toEqual({ kind: "AVAILABLE", provider: "WEB_SPEECH" });
    expect(resolveVoiceProvider(both, { devSettingsEnabled: false, stored: "WEB_SPEECH" })).toEqual({ kind: "AVAILABLE", provider: "TRTC" });
    expect(resolveVoiceProvider(env(["TRTC"]), { devSettingsEnabled: true, stored: "WEB_SPEECH" })).toEqual({ kind: "AVAILABLE", provider: "TRTC" });
    expect(resolveVoiceProvider(env(["TRTC", "WEB_SPEECH"], false), { devSettingsEnabled: true, stored: "WEB_SPEECH" })).toEqual({ kind: "AVAILABLE", provider: "TRTC" });
    expect(resolveVoiceProvider(env(["WEB_SPEECH"], false), { devSettingsEnabled: true, stored: "WEB_SPEECH" })).toEqual({ kind: "UNSUPPORTED" });
    for (const stored of ["trtc", "webspeech", "", 1, null, { provider: "TRTC" }]) expect(resolveVoiceProvider(both, { devSettingsEnabled: true, stored }), String(stored)).toEqual({ kind: "AVAILABLE", provider: "TRTC" });
  });

  it("lists every provider with its status: enabled ones in order, then the others (not enabled / not supported)", () => {
    expect(voiceProviderStatuses(env(["WEB_SPEECH"], false))).toEqual([
      { provider: "WEB_SPEECH", status: "NOT_SUPPORTED" },
      { provider: "TRTC", status: "NOT_ENABLED" },
    ]);
    expect(voiceProviderStatuses(env([]))).toEqual([
      { provider: "TRTC", status: "NOT_ENABLED" },
      { provider: "WEB_SPEECH", status: "NOT_ENABLED" },
    ]);
  });

  it("reads and writes only its own key, never throwing", () => {
    const store = new Map<string, string>();
    const storage = () => ({ getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) });
    expect(VOICE_PROVIDER_PREFERENCE_KEY).toBe("jagaon.dev.voiceProvider");
    expect(readVoiceProviderPreference(storage)).toBeNull();
    expect(writeVoiceProviderPreference(storage, "WEB_SPEECH")).toBe(true);
    expect([...store.keys()]).toEqual(["jagaon.dev.voiceProvider"]);
    expect(readVoiceProviderPreference(storage)).toBe("WEB_SPEECH");
    store.set(VOICE_PROVIDER_PREFERENCE_KEY, "SIMULATED");
    expect(readVoiceProviderPreference(storage)).toBeNull();
    const throwing = () => ({ getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    expect(readVoiceProviderPreference(throwing)).toBeNull();
    expect(writeVoiceProviderPreference(throwing, "TRTC")).toBe(false);
    expect(readVoiceProviderPreference(() => { throw new Error("no storage"); })).toBeNull();
    expect(writeVoiceProviderPreference(() => null, "TRTC")).toBe(false);
  });
});
