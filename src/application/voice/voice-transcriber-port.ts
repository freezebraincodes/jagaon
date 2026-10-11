import type { VoiceLanguage } from "@/domain/voice/voice-contracts";
import type { VoiceDisclosureGrant } from "./voice-cloud-disclosure";

/**
 * Packet 13 slice (P13S, S3): the provider-neutral voice transcriber port. No provider object, message, error, credential or room
 * concept crosses it: only closed reasons, segment text and a release report (whose UNCONFIRMED provider stop carries the task
 * identifiers needed for recovery, see below).
 *
 * Contract for every adapter:
 * - `start` resolves STARTED (with a session handle and the server's maximum session length) or FAILED with a closed reason. A FAILED
 *   start has released everything it acquired (microphone, room, listeners) BEFORE it resolves, and carries that release's
 *   `providerStop` when the adapter knows it (absent: unknown to the caller).
 * - When `signal` aborts before `start` resolves, the adapter stops starting, releases what it acquired and resolves (FAILED, or
 *   STARTED, which the caller then cancels).
 * - `onSegment` delivers INTERIM (display-only) and FINAL segments; `onFailure` reports a provider or network failure after STARTED.
 * - The handle's `stop()` ends transcription and releases the microphone; `cancel()` does the same for an abandoned session (the same
 *   provider shutdown). Both are idempotent and resolve with `{ microphoneReleased, providerStop }` only after the release ran (never
 *   reject; a second call returns the same report).
 * - `providerStop` is CONFIRMED only on the provider's own evidence that the transcription robot left (never on a stop call merely
 *   resolving). UNCONFIRMED (a closed reason, never "rejected") carries only the identifiers needed to recover the unresolved task:
 *   `robotId` (not opaque: the TRTC default embeds the session's room and user ids) and `taskId` or null; START_UNRESOLVED means a
 *   provider start request was sent but its outcome is unknown (`robotId: null`). NOT_STARTED means only that no provider start
 *   request was sent, or that it definitively failed (rejected before any request reached the provider).
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

export const VOICE_PROVIDER_STOP_UNCONFIRMED_REASONS = ["STOP_THREW", "STOP_TIMED_OUT", "NO_ROBOT_LEFT_EVENT", "START_UNRESOLVED"] as const;
export type VoiceProviderStopUnconfirmedReason = (typeof VOICE_PROVIDER_STOP_UNCONFIRMED_REASONS)[number];

export type VoiceProviderStop =
  | Readonly<{ kind: "CONFIRMED" }>
  | Readonly<{ kind: "UNCONFIRMED"; reason: Exclude<VoiceProviderStopUnconfirmedReason, "START_UNRESOLVED">; robotId: string; taskId: string | null }>
  | Readonly<{ kind: "UNCONFIRMED"; reason: "START_UNRESOLVED"; robotId: null; taskId: string | null }>
  | Readonly<{ kind: "NOT_STARTED" }>;

export type VoiceReleaseReport = Readonly<{ microphoneReleased: boolean; providerStop: VoiceProviderStop }>;

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
  | Readonly<{ kind: "FAILED"; reason: VoiceStartFailureReason; credentialRefusal?: VoiceCredentialRefusal; providerStop?: VoiceProviderStop }>;

export type VoiceTranscriberPort = Readonly<{
  start(request: VoiceStartRequest): Promise<VoiceStartResult>;
}>;
