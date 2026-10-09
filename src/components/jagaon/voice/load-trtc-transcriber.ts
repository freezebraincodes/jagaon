import type { VoiceTranscriberPort } from "@/application/voice/voice-transcriber-port";

/**
 * Packet 13 (P13S): the production transcriber loader for the Tell JagaOn screen. It is called only AFTER the voice-cloud disclosure
 * was accepted, and loads the TRTC adapter and the same-origin credential client by dynamic import (so neither, nor the SDK they
 * load later, is in the base page chunk). The demo passcode is read from the screen's memory on each request and never stored.
 */
/**
 * Review I-5: the production availability probe, called when the Tell JagaOn screen opens (before the disclosure). It loads only the
 * same-origin credential client by dynamic import (no TRTC SDK, no adapter) and fails closed (false) on any error.
 */
export async function checkTrtcVoiceAvailability(): Promise<boolean> {
  try {
    const { fetchVoiceAvailability } = await import("@/voice/trtc/trtc-credential-client");
    return await fetchVoiceAvailability();
  } catch {
    return false;
  }
}

export async function loadTrtcTranscriber(accessPasscode: () => string | null): Promise<VoiceTranscriberPort> {
  const [{ createTrtcTranscriberAdapter }, { createTrtcCredentialClient }] = await Promise.all([import("@/voice/trtc/trtc-transcriber-adapter"), import("@/voice/trtc/trtc-credential-client")]);
  return createTrtcTranscriberAdapter({ requestCredential: createTrtcCredentialClient({ accessPasscode }) });
}
