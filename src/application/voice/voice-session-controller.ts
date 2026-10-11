import type { VoiceLanguage } from "@/domain/voice/voice-contracts";
import { consumeVoiceDisclosureGrant, isVoiceDisclosureGrantUsable, type VoiceDisclosureGrant } from "./voice-cloud-disclosure";
import {
  VOICE_PROVIDER_STOP_UNCONFIRMED_REASONS,
  VOICE_SESSION_FAILURE_REASONS,
  type VoiceCredentialRefusal,
  type VoiceProviderStop,
  type VoiceReleaseReport,
  type VoiceSegment,
  type VoiceSessionFailureReason,
  type VoiceSessionHandle,
  type VoiceStartFailureReason,
  type VoiceStartResult,
  type VoiceTranscriberPort,
} from "./voice-transcriber-port";

/**
 * Packet 13 slice (P13S, S3): the voice session lifecycle over the provider-neutral port.
 *
 * States: IDLE → STARTING → LISTENING → STOPPING → COMPLETED | CANCELLED | TIMED_OUT | FAILED.
 * - A start needs an unconsumed disclosure grant for the same language (voice-cloud-disclosure.ts); it is refused, with nothing started
 *   and no microphone touched, without one. Each grant admits one start.
 * - The start timeout and the session limit (the smaller of `maxSessionSeconds` and the server's maximum) run on injected timers.
 * - INTERIM text is display-only (`liveText`); only FINAL segments form the transcript.
 * - Stop: segments arriving until the release resolves still count; the transcript is sealed when it does. Cancel, timeout and failure
 *   clear the text at once and discard every later segment. A session token drops events of an older session.
 * - The terminal state is set only AFTER the handle reported its release (also on start-timeout, cancel and failure paths).
 * - `takeTranscript()` returns the sealed final text of a COMPLETED session once, then clears it. Nothing is persisted or logged.
 * - `providerStop` carries the adapter's provider-stop outcome (validated; null before a release, or when no readable outcome was
 *   reported). A FAILED start carries its own release's outcome when the adapter reports it, else null (unknown, never NOT_STARTED by
 *   assumption). It changes no state, text or timer.
 * - Web Speech (draft, pending owner approval): `onProviderEnded` from the adapter while LISTENING ends the session like a Stop (the
 *   finals are kept, the release is awaited) and the COMPLETED snapshot says `endedBy: "PROVIDER"`, so the screen can say the browser
 *   stopped listening. Nothing restarts. `endedBy` is null for every other ending. NOT_APPLICABLE is a readable provider stop.
 * - W-6a (owner decision 2026-10-11): reaching the session limit (the smaller of `maxSessionSeconds` and the server's maximum) stops
 *   capture exactly like the person's Stop: the adapter's bounded final flush runs, finals arriving until the release resolves count,
 *   the unfinished interim text is dropped, and the session ends COMPLETED with `endedBy: "LIMIT"` so the transcript goes to the normal
 *   review. Nothing is saved automatically. The limit path no longer produces TIMED_OUT (the state stays in the type for callers); the
 *   start timeout, Cancel and failure paths are unchanged.
 */
export type VoiceSessionState = "IDLE" | "STARTING" | "LISTENING" | "STOPPING" | "COMPLETED" | "CANCELLED" | "TIMED_OUT" | "FAILED";
type TerminalState = "COMPLETED" | "CANCELLED" | "TIMED_OUT" | "FAILED";

export type VoiceSessionSnapshot = Readonly<{
  state: VoiceSessionState;
  sessionToken: number;
  language: VoiceLanguage | null;
  /** Display-only live text (finals plus the current interim); empty after any terminal state. */
  liveText: string;
  failureReason: VoiceStartFailureReason | VoiceSessionFailureReason | null;
  credentialRefusal: VoiceCredentialRefusal | null;
  /** The adapter's release report for the last session (null while none ended). */
  microphoneReleased: boolean | null;
  /** The adapter's provider-stop outcome for the last session (null while none ended, or when the report was unreadable). */
  providerStop: VoiceProviderStop | null;
  /** "PROVIDER" when the last session was COMPLETED because the provider ended it by itself; null otherwise. */
  endedBy: "PROVIDER" | "LIMIT" | null;
  /** The effective session limit in seconds (the smaller of the client and server limits) once LISTENING; null before. */
  limitSeconds: number | null;
}>;

export type VoiceTimers = Readonly<{
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}>;

export type VoiceStartOutcome = Readonly<{ kind: "RAN" }> | Readonly<{ kind: "REFUSED"; reason: "DISCLOSURE_REQUIRED" | "SESSION_ACTIVE" }>;

export type VoiceSessionController = Readonly<{
  start(request: Readonly<{ language: VoiceLanguage; grant: VoiceDisclosureGrant }>): Promise<VoiceStartOutcome>;
  stop(): Promise<VoiceSessionSnapshot>;
  cancel(): Promise<VoiceSessionSnapshot>;
  snapshot(): VoiceSessionSnapshot;
  takeTranscript(): string | null;
  /** Review M6: drops a sealed transcript that was not taken (Discard, unmount). Idempotent. */
  discardTranscript(): void;
}>;

export type VoiceSessionControllerOptions = Readonly<{
  transcriber: VoiceTranscriberPort;
  timers: VoiceTimers;
  startTimeoutMs: number;
  /** The client's own upper bound; the server's maximum (from the credential) may only lower it. */
  maxSessionSeconds: number;
  onChange?: (snapshot: VoiceSessionSnapshot) => void;
}>;

const MAX_SEGMENT_ID_CHARS = 128;
const MAX_SEGMENT_TEXT_CHARS = 2_000;
const positiveInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

function validSegment(segment: unknown): segment is VoiceSegment {
  if (typeof segment !== "object" || segment === null) return false;
  const { kind, segmentId, text } = segment as Record<string, unknown>;
  return (kind === "INTERIM" || kind === "FINAL") && typeof segmentId === "string" && segmentId.length > 0 && segmentId.length <= MAX_SEGMENT_ID_CHARS && typeof text === "string" && text.length <= MAX_SEGMENT_TEXT_CHARS;
}

type ReleaseOutcome = Readonly<{ microphoneReleased: boolean; providerStop: VoiceProviderStop | null }>;

function providerStopOf(value: unknown): VoiceProviderStop | null {
  if (typeof value !== "object" || value === null) return null;
  const { kind, reason, robotId, taskId } = value as Record<string, unknown>;
  if (kind === "CONFIRMED" || kind === "NOT_STARTED" || kind === "NOT_APPLICABLE") return Object.freeze({ kind });
  if (kind !== "UNCONFIRMED" || (taskId !== null && typeof taskId !== "string")) return null;
  if (reason === "START_UNRESOLVED") return robotId === null ? Object.freeze({ kind, reason, robotId, taskId }) : null;
  const known = VOICE_PROVIDER_STOP_UNCONFIRMED_REASONS.find((candidate) => candidate === reason);
  if (known === undefined || known === "START_UNRESOLVED" || typeof robotId !== "string") return null;
  return Object.freeze({ kind, reason: known, robotId, taskId });
}

/** A start that handed over no session: the microphone was released by the adapter; the provider outcome is what it reported. */
const noSessionRelease = (result: VoiceStartResult | undefined): ReleaseOutcome =>
  Object.freeze({ microphoneReleased: true, providerStop: result?.kind === "FAILED" ? providerStopOf(result.providerStop) : null });

async function release(action: () => Promise<VoiceReleaseReport>): Promise<ReleaseOutcome> {
  try {
    const report = await action();
    return { microphoneReleased: report?.microphoneReleased === true, providerStop: providerStopOf(report?.providerStop) };
  } catch {
    return { microphoneReleased: false, providerStop: null };
  }
}

export function createVoiceSessionController(options: VoiceSessionControllerOptions): VoiceSessionController {
  if (!positiveInteger(options.startTimeoutMs) || !positiveInteger(options.maxSessionSeconds)) throw new TypeError("VOICE_CONTROLLER_MISCONFIGURED");
  const { transcriber, timers } = options;

  let state: VoiceSessionState = "IDLE";
  let token = 0;
  let language: VoiceLanguage | null = null;
  const finals = new Map<string, string>();
  const interims = new Map<string, string>();
  let sealed: string | null = null;
  let failureReason: VoiceSessionSnapshot["failureReason"] = null;
  let credentialRefusal: VoiceCredentialRefusal | null = null;
  let microphoneReleased: boolean | null = null;
  let providerStop: VoiceProviderStop | null = null;
  let endedBy: "PROVIDER" | "LIMIT" | null = null;
  let endReason: "PROVIDER" | "LIMIT" | null = null;
  let limitSeconds: number | null = null;
  let accepting = false;
  let handle: VoiceSessionHandle | null = null;
  let abort: AbortController | null = null;
  let startTimer: unknown = null;
  let sessionTimer: unknown = null;
  let endKind: TerminalState | null = null;
  let ending: { promise: Promise<VoiceSessionSnapshot>; resolve: (snapshot: VoiceSessionSnapshot) => void } | null = null;

  const separator = () => (language === "zh" ? "" : " ");
  const join = (parts: Iterable<string>) => [...parts].map((part) => part.trim()).filter((part) => part.length > 0).join(separator());

  function snapshot(): VoiceSessionSnapshot {
    return Object.freeze({ state, sessionToken: token, language, liveText: join([...finals.values(), ...interims.values()]), failureReason, credentialRefusal, microphoneReleased, providerStop, endedBy, limitSeconds });
  }

  function emit(): void {
    try {
      options.onChange?.(snapshot());
    } catch {
      // A listener error never changes the session.
    }
  }

  function clearTimers(): void {
    if (startTimer !== null) timers.clearTimeout(startTimer);
    if (sessionTimer !== null) timers.clearTimeout(sessionTimer);
    startTimer = null;
    sessionTimer = null;
  }

  function clearText(): void {
    finals.clear();
    interims.clear();
  }

  function finish(session: number, report: ReleaseOutcome): void {
    if (session !== token || endKind === null) return;
    clearTimers();
    accepting = false;
    interims.clear();
    sealed = endKind === "COMPLETED" ? join(finals.values()) : null;
    finals.clear();
    microphoneReleased = report.microphoneReleased;
    providerStop = report.providerStop;
    endedBy = endKind === "COMPLETED" ? endReason : null;
    state = endKind;
    handle = null;
    abort = null;
    emit();
    const pending = ending;
    ending = null;
    pending?.resolve(snapshot());
  }

  function requestEnd(session: number, kind: TerminalState, reason?: VoiceSessionSnapshot["failureReason"]): Promise<VoiceSessionSnapshot> {
    if (session !== token || (state !== "STARTING" && state !== "LISTENING" && state !== "STOPPING")) return Promise.resolve(snapshot());
    if (ending) {
      // A cancel during a stop wins: the text is cleared and nothing is kept.
      if (kind === "CANCELLED" && endKind === "COMPLETED") {
        endKind = "CANCELLED";
        accepting = false;
        clearText();
        emit();
      }
      return ending.promise;
    }
    let resolve!: (snapshot: VoiceSessionSnapshot) => void;
    ending = { promise: new Promise<VoiceSessionSnapshot>((done) => (resolve = done)), resolve: (value) => resolve(value) };
    const promise = ending.promise;
    endKind = kind;
    if (kind === "FAILED") failureReason = reason ?? "PROVIDER_FAILURE";
    if (kind !== "COMPLETED") {
      accepting = false;
      clearText();
    }
    clearTimers();
    const previous = state;
    state = "STOPPING";
    emit();
    if (previous === "STARTING") {
      // The pending start settles after the abort; its continuation releases and finishes.
      abort?.abort();
    } else if (handle) {
      const current = handle;
      void release(() => (kind === "COMPLETED" ? current.stop() : current.cancel())).then((report) => finish(session, report));
    }
    return promise;
  }

  function onSegment(session: number, segment: VoiceSegment): void {
    if (session !== token || !accepting || !validSegment(segment)) return;
    if (segment.kind === "FINAL") {
      finals.set(segment.segmentId, segment.text);
      interims.delete(segment.segmentId);
    } else {
      interims.set(segment.segmentId, segment.text);
    }
    emit();
  }

  function onFailure(session: number, reason: VoiceSessionFailureReason): void {
    if (session !== token || state !== "LISTENING") return;
    void requestEnd(session, "FAILED", VOICE_SESSION_FAILURE_REASONS.includes(reason) ? reason : "PROVIDER_FAILURE");
  }

  function onProviderEnded(session: number): void {
    if (session !== token || state !== "LISTENING") return;
    endReason = "PROVIDER";
    void requestEnd(session, "COMPLETED");
  }

  async function start(request: Readonly<{ language: VoiceLanguage; grant: VoiceDisclosureGrant }>): Promise<VoiceStartOutcome> {
    if (state === "STARTING" || state === "LISTENING" || state === "STOPPING") return { kind: "REFUSED", reason: "SESSION_ACTIVE" };
    const grant = request?.grant;
    if (!isVoiceDisclosureGrantUsable(grant) || (request.language !== "en" && request.language !== "zh") || grant.language !== request.language || !consumeVoiceDisclosureGrant(grant)) {
      return { kind: "REFUSED", reason: "DISCLOSURE_REQUIRED" };
    }
    token += 1;
    const session = token;
    language = request.language;
    clearText();
    sealed = null;
    failureReason = null;
    credentialRefusal = null;
    microphoneReleased = null;
    providerStop = null;
    endedBy = null;
    endReason = null;
    limitSeconds = null;
    endKind = null;
    ending = null;
    accepting = true;
    state = "STARTING";
    const controller = new AbortController();
    abort = controller;
    startTimer = timers.setTimeout(() => {
      if (session === token && state === "STARTING") void requestEnd(session, "FAILED", "START_TIMEOUT");
    }, options.startTimeoutMs);
    emit();

    let result: VoiceStartResult;
    try {
      result = await transcriber.start({ language: request.language, grant, onSegment: (segment) => onSegment(session, segment), onFailure: (reason) => onFailure(session, reason), onProviderEnded: () => onProviderEnded(session), signal: controller.signal });
    } catch {
      result = { kind: "FAILED", reason: "PROVIDER_FAILURE" };
    }
    const started = result?.kind === "STARTED" && typeof result.session?.stop === "function" && typeof result.session?.cancel === "function" ? result : null;

    if (session !== token || endKind !== null) {
      // Cancelled or timed out while starting (or superseded): release a late session, then finish. A FAILED start released itself.
      const report = started ? await release(() => started.session.cancel()) : noSessionRelease(result);
      finish(session, report);
      return { kind: "RAN" };
    }
    if (!started || !positiveInteger(started.maxSessionSeconds)) {
      const report = started ? await release(() => started.session.cancel()) : noSessionRelease(result);
      endKind = "FAILED";
      failureReason = !started && result?.kind === "FAILED" ? result.reason : "PROVIDER_FAILURE";
      credentialRefusal = !started && result?.kind === "FAILED" && failureReason === "CREDENTIAL_REFUSED" ? (result.credentialRefusal ?? null) : null;
      finish(session, report);
      return { kind: "RAN" };
    }
    if (startTimer !== null) timers.clearTimeout(startTimer);
    startTimer = null;
    handle = started.session;
    state = "LISTENING";
    limitSeconds = Math.min(options.maxSessionSeconds, started.maxSessionSeconds);
    sessionTimer = timers.setTimeout(() => {
      // W-6a: the limit stops like the person's Stop (bounded final flush, finals kept for review, never saved automatically).
      if (session !== token || state !== "LISTENING") return;
      endReason = "LIMIT";
      void requestEnd(session, "COMPLETED");
    }, limitSeconds * 1_000);
    emit();
    return { kind: "RAN" };
  }

  return Object.freeze({
    start,
    // A stop before LISTENING has no transcript to keep: it is a cancel.
    stop: () => requestEnd(token, state === "STARTING" ? "CANCELLED" : "COMPLETED"),
    cancel: () => requestEnd(token, "CANCELLED"),
    snapshot,
    takeTranscript(): string | null {
      if (state !== "COMPLETED" || sealed === null) return null;
      const text = sealed;
      sealed = null;
      return text;
    },
    discardTranscript(): void {
      sealed = null;
      finals.clear();
      interims.clear();
    },
  });
}
