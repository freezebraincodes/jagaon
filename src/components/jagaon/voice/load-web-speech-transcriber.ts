import type { VoiceAccessMode } from "@/application/voice/voice-provider-selection";
import type { VoiceTranscriberPort } from "@/application/voice/voice-transcriber-port";

/**
 * Web Speech (owner-approved scope 2026-10-11; draft, pending owner review): the production loader for the browser's speech
 * recognition. Called only AFTER the Web Speech disclosure was accepted; it loads the adapter and the same-origin access client by
 * dynamic import. It installs NO TRTC recovery helper (that stays with the TRTC loader: Web Speech creates no Tencent task) and touches
 * no TRTC marker. The demo passcode is read from the screen's memory on each request and never stored.
 * Owner decision 2026-10-12 (optional passcodes): `access.passcodeRequired === false` makes the access client send no passcode header
 * (absent: required, as before).
 */
export async function loadWebSpeechTranscriber(accessPasscode: () => string | null, access?: VoiceAccessMode): Promise<VoiceTranscriberPort> {
  const [{ createWebSpeechTranscriberAdapter }, { createVoiceAccessClient }] = await Promise.all([import("@/voice/web-speech/web-speech-transcriber-adapter"), import("@/voice/trtc/trtc-credential-client")]);
  return createWebSpeechTranscriberAdapter({ requestAccess: createVoiceAccessClient({ accessPasscode, passcodeRequired: access?.passcodeRequired !== false }) });
}
