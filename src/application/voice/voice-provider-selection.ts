import type { VoiceLanguage } from "@/domain/voice/voice-contracts";

/**
 * Web Speech (owner-approved scope 2026-10-11; draft, pending owner review): which voice provider a session uses.
 *
 * - The deployment enables providers (server `JAGAON_VOICE_PROVIDERS`, reported by the credential-free probe in its configured order).
 * - A provider is AVAILABLE only when it is enabled AND usable here: Web Speech needs the browser's speech recognition (feature
 *   detection) and is offered for English only (the Chinese UI never offers it); TRTC is checked by its own adapter at start, as before.
 * - The effective provider is the stored developer choice when the developer settings are on and that choice is AVAILABLE; otherwise
 *   the first AVAILABLE provider in the deployment's order. A stored choice that is not AVAILABLE is ignored (never rewritten here).
 * - No fallback: the effective provider is computed once, at idle, before the disclosure; a session never switches provider, and a
 *   failed session never starts another one.
 *
 * Pure: no storage, network or browser access (the caller injects the stored value and the support check).
 */
export const VOICE_PROVIDER_IDS = ["TRTC", "WEB_SPEECH"] as const;
export type VoiceProviderId = (typeof VOICE_PROVIDER_IDS)[number];

/** The browser storage key of the developer's per-browser provider choice (non-sensitive; only a provider id is stored). */
export const VOICE_PROVIDER_PREFERENCE_KEY = "jagaon.dev.voiceProvider";

export type VoiceProviderStatus = "AVAILABLE" | "NOT_ENABLED" | "NOT_SUPPORTED" | "NOT_IN_LANGUAGE";

/**
 * Round 6: the probe's answer as the System settings panel needs it. ANSWERED: the deployment-enabled providers. FAILED: the deployment
 * could not be checked (network error, rate limit, invalid answer); `notEnabled` lists providers known not to be enabled regardless
 * (TRTC in a Tencent-excluded build).
 */
export type VoiceProviderProbeAnswer =
  | Readonly<{
      kind: "ANSWERED";
      providers: readonly VoiceProviderId[];
      /** Owner decision 2026-10-12 (optional passcodes): false only when the deployment requires no demo passcode; absent = required. */
      passcodeRequired?: boolean;
    }>
  | Readonly<{ kind: "FAILED"; notEnabled: readonly VoiceProviderId[] }>;

/**
 * Owner decision 2026-10-12 (optional passcodes): what the Tell JagaOn resolver needs from the probe: the enabled providers and whether
 * the demo passcode is required (a failed check: none enabled, required).
 */
export type VoiceAccessCheck = Readonly<{ providers: readonly VoiceProviderId[]; passcodeRequired: boolean }>;

/** Owner decision 2026-10-12 (optional passcodes): what a transcriber loader is told about the session's access (no value). */
export type VoiceAccessMode = Readonly<{ passcodeRequired: boolean }>;

export type VoiceProviderEnvironment = Readonly<{
  /** The deployment-enabled providers, in the deployment's order (from the probe). */
  enabled: readonly VoiceProviderId[];
  /** Feature detection for the browser's speech recognition. */
  webSpeechSupported: boolean;
  language: VoiceLanguage;
}>;

export const isVoiceProviderId = (value: unknown): value is VoiceProviderId => value === "TRTC" || value === "WEB_SPEECH";

export function voiceProviderStatus(provider: VoiceProviderId, environment: VoiceProviderEnvironment): VoiceProviderStatus {
  if (!environment.enabled.includes(provider)) return "NOT_ENABLED";
  if (provider === "WEB_SPEECH") {
    if (environment.language !== "en") return "NOT_IN_LANGUAGE";
    if (!environment.webSpeechSupported) return "NOT_SUPPORTED";
  }
  return "AVAILABLE";
}

/** Every known provider with its status: the enabled ones in the deployment's order, then the others. */
export function voiceProviderStatuses(environment: VoiceProviderEnvironment): ReadonlyArray<Readonly<{ provider: VoiceProviderId; status: VoiceProviderStatus }>> {
  const order = [...environment.enabled.filter(isVoiceProviderId), ...VOICE_PROVIDER_IDS.filter((id) => !environment.enabled.includes(id))];
  return [...new Set(order)].map((provider) => Object.freeze({ provider, status: voiceProviderStatus(provider, environment) }));
}

export type VoiceProviderResolution =
  /**
   * Owner decision 2026-10-12 (optional passcodes): `passcodeRequired: false` (from the probe, added by the app) skips the screen's
   * passcode step; absent or true keeps it (fail safe).
   */
  | Readonly<{ kind: "AVAILABLE"; provider: VoiceProviderId; passcodeRequired?: boolean }>
  /** Enabled providers exist, but none can run in this browser (the existing "not available in this browser" path). */
  | Readonly<{ kind: "UNSUPPORTED" }>
  /** Voice is off, nothing is enabled, or only a provider not offered in this language is enabled (the existing "unavailable" path). */
  | Readonly<{ kind: "UNAVAILABLE" }>;

export function resolveVoiceProvider(environment: VoiceProviderEnvironment, choice: Readonly<{ devSettingsEnabled: boolean; stored: unknown }>): VoiceProviderResolution {
  const statuses = voiceProviderStatuses(environment);
  const stored = choice.devSettingsEnabled && isVoiceProviderId(choice.stored) ? choice.stored : null;
  if (stored !== null && voiceProviderStatus(stored, environment) === "AVAILABLE") return Object.freeze({ kind: "AVAILABLE", provider: stored });
  const first = statuses.find((entry) => entry.status === "AVAILABLE");
  if (first) return Object.freeze({ kind: "AVAILABLE", provider: first.provider });
  if (statuses.some((entry) => entry.status === "NOT_IN_LANGUAGE")) return Object.freeze({ kind: "UNAVAILABLE" });
  if (statuses.some((entry) => entry.status === "NOT_SUPPORTED")) return Object.freeze({ kind: "UNSUPPORTED" });
  return Object.freeze({ kind: "UNAVAILABLE" });
}

export type VoicePreferenceStorage = Readonly<{ getItem(key: string): string | null; setItem(key: string, value: string): void }>;

/** The stored choice, or null (missing, unknown or unreadable storage). Never throws. */
export function readVoiceProviderPreference(storage: () => VoicePreferenceStorage | null): VoiceProviderId | null {
  try {
    const value = storage()?.getItem(VOICE_PROVIDER_PREFERENCE_KEY) ?? null;
    return isVoiceProviderId(value) ? value : null;
  } catch {
    return null;
  }
}

/** Stores the choice; false when storage is unavailable or throws. Never throws. */
export function writeVoiceProviderPreference(storage: () => VoicePreferenceStorage | null, provider: VoiceProviderId): boolean {
  if (!isVoiceProviderId(provider)) return false;
  try {
    const target = storage();
    if (!target) return false;
    target.setItem(VOICE_PROVIDER_PREFERENCE_KEY, provider);
    return true;
  } catch {
    return false;
  }
}
