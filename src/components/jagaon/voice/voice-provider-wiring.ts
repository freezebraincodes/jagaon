import type { VoiceAccessCheck, VoiceAccessMode, VoiceProviderId, VoiceProviderProbeAnswer } from "@/application/voice/voice-provider-selection";
import type { VoiceTranscriberPort } from "@/application/voice/voice-transcriber-port";
import { TRTC_EXCLUDED_AT_BUILD } from "@/config/build-exclusions";
import { isWebSpeechSupported } from "@/voice/web-speech/web-speech-support";
import { loadTrtcTranscriber } from "./load-trtc-transcriber";
import { loadWebSpeechTranscriber } from "./load-web-speech-transcriber";

/**
 * Web Speech (owner-approved scope 2026-10-11; draft): the production pieces the app composes into the provider choice.
 * - `checkVoiceProviders`: the deployment-enabled providers from the credential-free probe (dynamic import of the same-origin client
 *   only; fails closed to none).
 * - `browserWebSpeechSupported`: feature detection only (nothing is created, no microphone).
 * - `VOICE_PROVIDER_LOADERS`: one loader per provider, each called only after that provider's own disclosure was accepted. The TRTC
 *   loader installs the TRTC recovery helper as before; the Web Speech loader does not.
 * - Tencent build-time exclusion (owner-approved 2026-10-11): in an excluded build TRTC is dropped from the probe's answer here too
 *   (so the panel shows it as not enabled by this deployment), and the TRTC loader refuses (the screen's unavailable path); the TRTC
 *   loader module is never called.
 * - Round 6: `checkVoiceProviderAnswer` tells a failed or rate-limited check apart from an answer, so the panel can say the deployment
 *   could not be checked instead of "not enabled" (in an excluded build TRTC is known not enabled either way).
 * - Owner decision 2026-10-12 (optional passcodes): the answer check passes on the probe's `passcodeRequired`, `checkVoiceAccess` gives
 *   the Tell JagaOn resolver the providers and that flag from ONE probe call (a failed check: none, required), and each loader takes
 *   the session's `VoiceAccessMode`.
 */
export function createVoiceProvidersCheck(fetchProviders: () => Promise<readonly VoiceProviderId[]>, trtcExcluded: boolean = TRTC_EXCLUDED_AT_BUILD): () => Promise<readonly VoiceProviderId[]> {
  return async () => {
    try {
      const providers = await fetchProviders();
      return trtcExcluded ? providers.filter((provider) => provider !== "TRTC") : providers;
    } catch {
      return [];
    }
  };
}

export function createVoiceProviderAnswerCheck(
  fetchAnswer: () => Promise<Readonly<{ kind: "ANSWERED"; providers: readonly VoiceProviderId[]; passcodeRequired?: boolean }> | Readonly<{ kind: "FAILED" }>>,
  trtcExcluded: boolean = TRTC_EXCLUDED_AT_BUILD,
): () => Promise<VoiceProviderProbeAnswer> {
  const notEnabled: readonly VoiceProviderId[] = Object.freeze(trtcExcluded ? ["TRTC"] : []);
  const failed: VoiceProviderProbeAnswer = Object.freeze({ kind: "FAILED", notEnabled });
  return async () => {
    try {
      const answer = await fetchAnswer();
      if (answer?.kind !== "ANSWERED" || !Array.isArray(answer.providers)) return failed;
      const providers = Object.freeze(answer.providers.filter((provider) => !notEnabled.includes(provider)));
      return Object.freeze(typeof answer.passcodeRequired === "boolean" ? { kind: "ANSWERED" as const, providers, passcodeRequired: answer.passcodeRequired } : { kind: "ANSWERED" as const, providers });
    } catch {
      return failed;
    }
  };
}

export const checkVoiceProviderAnswer = createVoiceProviderAnswerCheck(async () => {
  const { fetchVoiceProvidersAnswer } = await import("@/voice/trtc/trtc-credential-client");
  return fetchVoiceProvidersAnswer();
});

/**
 * The enabled providers for the screen's resolver: none when the check failed (fail closed, as before). Owner decision 2026-10-12
 * (optional passcodes): with whether the passcode is required (required unless the answer says false; a failed check is required).
 */
export const checkVoiceAccess = async (): Promise<VoiceAccessCheck> => {
  const answer = await checkVoiceProviderAnswer();
  return answer.kind === "ANSWERED" ? Object.freeze({ providers: answer.providers, passcodeRequired: answer.passcodeRequired !== false }) : Object.freeze({ providers: [], passcodeRequired: true });
};

export const browserWebSpeechSupported = (): boolean => isWebSpeechSupported(typeof window === "undefined" ? null : window);

export type VoiceTranscriberLoader = (accessPasscode: () => string | null, access?: VoiceAccessMode) => Promise<VoiceTranscriberPort>;

/** Tencent build-time exclusion: the TRTC loader refuses in an excluded build (never loads the adapter or the SDK stub). */
export const refuseExcludedTrtc: VoiceTranscriberLoader = () => Promise.reject(new Error("TRTC_EXCLUDED_AT_BUILD"));

export function createVoiceProviderLoaders(trtcExcluded: boolean = TRTC_EXCLUDED_AT_BUILD): Readonly<Record<VoiceProviderId, VoiceTranscriberLoader>> {
  return Object.freeze({ TRTC: trtcExcluded ? refuseExcludedTrtc : loadTrtcTranscriber, WEB_SPEECH: loadWebSpeechTranscriber });
}

export const VOICE_PROVIDER_LOADERS: Readonly<Record<VoiceProviderId, VoiceTranscriberLoader>> = createVoiceProviderLoaders();
