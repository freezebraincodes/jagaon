import type { VoiceLanguage } from "@/domain/voice/voice-contracts";
import type { VoiceDisclosureGrant } from "./voice-cloud-disclosure";

/**
 * Packet 13 slice (P13S, S3): the provider-neutral voice transcriber port. No provider object, message, error, credential or room
 * concept crosses it: only closed reasons, segment text and a release report.
 *
 * Contract for every adapter:
 * - `start` resolves STARTED (with a session handle and the server's maximum session length) or FAILED with a closed reason. A FAILED
 *   start has released everything it acquired (microphone, room, listeners) BEFORE it resolves.
 * - When `signal` aborts before `start` resolves, the adapter stops starting, releases what it acquired and resolves (FAILED, or
 *   STARTED, which the caller then cancels).
 * - `onSegment` delivers INTERIM (display-only) and FINAL segments; `onFailure` reports a provider or network failure after STARTED.
 * - The handle's `stop()` ends transcription and releases the microphone; `cancel()` does the same for an abandoned session. Both are
 *   idempotent and resolve with `{ microphoneReleased }` only after the release ran (never reject).
 */
export const VOICE_START_FAILURE_REASONS = [
  "PERMISSION_DENIED",
  "UNSUPPORTED_BROWSER",
  "CREDENTIAL_REFUSED",
  "CONCURRENCY_LIMIT",
  "NETWORK_FAILURE",
  "PROVIDER_FAILURE",
  "START_TIMEOUT",
] as const;
export type VoiceStartFailureReason = (typeof VOICE_START_FAILURE_REASONS)[number];

/** Why the same-origin credential route refused (our own closed codes; lets the screen say "unavailable" or "check the passcode"). */
export const VOICE_CREDENTIAL_REFUSALS = ["VOICE_DISABLED", "ORIGIN_REJECTED", "ACCESS_DENIED", "RATE_LIMITED", "MINUTES_EXHAUSTED", "PAYLOAD_INVALID"] as const;
export type VoiceCredentialRefusal = (typeof VOICE_CREDENTIAL_REFUSALS)[number];

export const VOICE_SESSION_FAILURE_REASONS = ["NETWORK_FAILURE", "PROVIDER_FAILURE"] as const;
export type VoiceSessionFailureReason = (typeof VOICE_SESSION_FAILURE_REASONS)[number];

export type VoiceSegment = Readonly<{ kind: "INTERIM" | "FINAL"; segmentId: string; text: string }>;

export type VoiceReleaseReport = Readonly<{ microphoneReleased: boolean }>;

export type VoiceSessionHandle = Readonly<{
  stop(): Promise<VoiceReleaseReport>;
  cancel(): Promise<VoiceReleaseReport>;
}>;

export type VoiceStartRequest = Readonly<{
  language: VoiceLanguage;
  grant: VoiceDisclosureGrant;
  onSegment: (segment: VoiceSegment) => void;
  onFailure: (reason: VoiceSessionFailureReason) => void;
  signal: AbortSignal;
}>;

export type VoiceStartResult =
  | Readonly<{ kind: "STARTED"; session: VoiceSessionHandle; maxSessionSeconds: number }>
  | Readonly<{ kind: "FAILED"; reason: VoiceStartFailureReason; credentialRefusal?: VoiceCredentialRefusal }>;

export type VoiceTranscriberPort = Readonly<{
  start(request: VoiceStartRequest): Promise<VoiceStartResult>;
}>;
