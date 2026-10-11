import type {
  VoiceCredentialRefusal,
  VoiceProviderStop,
  VoiceReleaseReport,
  VoiceSessionFailureReason,
  VoiceStartFailureReason,
  VoiceStartRequest,
  VoiceStartResult,
  VoiceTranscriberPort,
} from "@/application/voice/voice-transcriber-port";
import { detectWebSpeechRecognition, type WebSpeechRecognitionConstructor, type WebSpeechRecognitionLike } from "./web-speech-support";

export type { WebSpeechRecognitionConstructor, WebSpeechRecognitionLike, WebSpeechResultEventLike, WebSpeechErrorEventLike } from "./web-speech-support";

/**
 * Web Speech (owner-approved scope 2026-10-11; design v2 §2; draft, pending owner review): the browser's own speech recognition
 * (`SpeechRecognition` / `webkitSpeechRecognition`) behind the provider-neutral port. Client-only; English (`en-SG`) only.
 *
 * NOT local or offline: in Chrome the browser sends the audio to its vendor's speech service (Google). JagaOn receives only text; this
 * adapter stores nothing (no storage of any kind: it never reads, writes or clears the TRTC provider-task markers or clearances, and no
 * Tencent task exists, so every release reports `providerStop: { kind: "NOT_APPLICABLE" }`).
 *
 * Start: language `en` only (anything else: UNSUPPORTED_BROWSER) → feature detection (none: UNSUPPORTED_BROWSER; nothing created, no
 * request) → one recognizer at a time in this page (a second concurrent start: PROVIDER_FAILURE) → the demo-passcode access check
 * (`requestAccess`, POST /api/voice/access: no credential; REFUSED → CREDENTIAL_REFUSED with its reason; FAILED → NETWORK_FAILURE) →
 * ONE recognizer (`lang: "en-SG"`, `continuous: true`, `interimResults: true`, `maxAlternatives: 1`) → `start()` → STARTED on `onstart`
 * with the server's maximum session length from the access check. An error, an end or an abort before `onstart` releases the recognizer
 * (bounded wait for `onend`) and resolves FAILED.
 *
 * Segments: each `onresult` result from `resultIndex` on is forwarded as INTERIM or FINAL (`isFinal`) with a stable id per result index
 * (`ws<session>-<index>`), the first alternative's text only.
 *
 * Stop: `stop()`; results keep being forwarded until `onend` (the browser flushes its last finals before it), and the release resolves
 * on `onend`. Cancel: forwarding stops at once, then `abort()`; the release resolves on `onend`. Both are idempotent (one shared report).
 * If `onend` does not arrive within the release bound, `abort()` is tried, forwarding stops and the report says
 * `microphoneReleased: false` (honest: the browser did not confirm the end).
 *
 * Errors after STARTED: `network` → onFailure NETWORK_FAILURE; `no-speech` → nothing (the browser's following `onend` is the
 * provider-ended path); `aborted` after our own stop/cancel → nothing; anything else → onFailure PROVIDER_FAILURE. Before STARTED:
 * `not-allowed` / `service-not-allowed` → PERMISSION_DENIED; `network` → NETWORK_FAILURE; anything else (`audio-capture`,
 * `language-not-supported`, `no-speech`, …) → PROVIDER_FAILURE.
 *
 * Browser-initiated end (`onend` after STARTED without our stop/cancel and without a reported failure): `onProviderEnded`. The adapter
 * NEVER restarts recognition. After `onend` every handler is detached, so late events are ignored. Nothing is logged.
 */
export type WebSpeechAccessResult =
  | Readonly<{ kind: "GRANTED"; maxSessionSeconds: number }>
  | Readonly<{ kind: "REFUSED"; reason: VoiceCredentialRefusal }>
  | Readonly<{ kind: "FAILED"; reason: "NETWORK_FAILURE" }>;

export type WebSpeechAdapterTimers = Readonly<{ setTimeout(callback: () => void, ms: number): unknown; clearTimeout(handle: unknown): void }>;

export type WebSpeechTranscriberAdapterOptions = Readonly<{
  requestAccess: (signal: AbortSignal) => Promise<WebSpeechAccessResult>;
  /** The recognizer constructor (default: feature detection on `globalThis`). */
  recognition?: () => WebSpeechRecognitionConstructor | null;
  timers?: WebSpeechAdapterTimers;
  /** The bound on waiting for `onend` after stop, cancel or a failed start (default 5 s). */
  releaseTimeoutMs?: number;
}>;

export const WEB_SPEECH_LANGUAGE_TAG = "en-SG";
const NOT_APPLICABLE: VoiceProviderStop = Object.freeze({ kind: "NOT_APPLICABLE" });
const DEFAULT_RELEASE_TIMEOUT_MS = 5_000;
const DEFAULT_TIMERS: WebSpeechAdapterTimers = Object.freeze({
  setTimeout: (callback: () => void, ms: number) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
});

export function webSpeechStartFailureReason(error: unknown): VoiceStartFailureReason {
  if (error === "not-allowed" || error === "service-not-allowed") return "PERMISSION_DENIED";
  if (error === "network") return "NETWORK_FAILURE";
  return "PROVIDER_FAILURE";
}

const sessionFailureReason = (error: unknown): VoiceSessionFailureReason => (error === "network" ? "NETWORK_FAILURE" : "PROVIDER_FAILURE");

const integer = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null);

/** One recognizer at a time in this page (across adapter instances). */
let recognizerActive = false;
let sessionCounter = 0;

export function createWebSpeechTranscriberAdapter(options: WebSpeechTranscriberAdapterOptions): VoiceTranscriberPort {
  const timers = options.timers ?? DEFAULT_TIMERS;
  const releaseTimeoutMs = options.releaseTimeoutMs ?? DEFAULT_RELEASE_TIMEOUT_MS;
  const detect = options.recognition ?? (() => detectWebSpeechRecognition());

  async function start(request: VoiceStartRequest): Promise<VoiceStartResult> {
    const failed = (reason: VoiceStartFailureReason, credentialRefusal?: VoiceCredentialRefusal): VoiceStartResult =>
      Object.freeze({ kind: "FAILED", reason, ...(credentialRefusal ? { credentialRefusal } : {}), providerStop: NOT_APPLICABLE });
    if (request.language !== "en") return failed("UNSUPPORTED_BROWSER");
    let Recognition: WebSpeechRecognitionConstructor | null;
    try {
      Recognition = detect();
    } catch {
      Recognition = null;
    }
    if (Recognition === null) return failed("UNSUPPORTED_BROWSER");
    if (recognizerActive) return failed("PROVIDER_FAILURE");
    recognizerActive = true;
    let claimed = true;
    const unclaim = () => {
      if (claimed) recognizerActive = false;
      claimed = false;
    };

    // The demo-passcode access check (no credential).
    if (request.signal.aborted) {
      unclaim();
      return failed("PROVIDER_FAILURE");
    }
    let access: WebSpeechAccessResult;
    try {
      access = await options.requestAccess(request.signal);
    } catch {
      access = { kind: "FAILED", reason: "NETWORK_FAILURE" };
    }
    if (request.signal.aborted) {
      unclaim();
      return failed("PROVIDER_FAILURE");
    }
    if (access?.kind === "REFUSED") {
      unclaim();
      return failed("CREDENTIAL_REFUSED", access.reason);
    }
    if (access?.kind !== "GRANTED" || integer(access.maxSessionSeconds) === null) {
      unclaim();
      return failed("NETWORK_FAILURE");
    }
    const maxSessionSeconds = access.maxSessionSeconds;

    // One recognizer for this session.
    let recognition: WebSpeechRecognitionLike;
    try {
      recognition = new Recognition();
      recognition.lang = WEB_SPEECH_LANGUAGE_TAG;
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;
    } catch {
      unclaim();
      return failed("PROVIDER_FAILURE");
    }
    const session = ++sessionCounter;
    let started = false;
    let ended = false;
    let forwarding = true;
    let userEnding = false;
    let failureReported = false;
    let startError: unknown = undefined;
    let settleStart: ((result: VoiceStartResult) => void) | null = null;
    let endWaiters: Array<() => void> = [];

    const detach = () => {
      recognition.onstart = null;
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
    };
    /** Resolves true on `onend`, false when the bound passed first. */
    const waitForEnd = (): Promise<boolean> =>
      ended
        ? Promise.resolve(true)
        : new Promise<boolean>((resolve) => {
            let done = false;
            const timer = timers.setTimeout(() => {
              if (done) return;
              done = true;
              resolve(false);
            }, releaseTimeoutMs);
            endWaiters.push(() => {
              if (done) return;
              done = true;
              timers.clearTimeout(timer);
              resolve(true);
            });
          });
    const markEnded = () => {
      if (ended) return;
      ended = true;
      forwarding = false;
      detach();
      unclaim();
      const waiters = endWaiters;
      endWaiters = [];
      for (const waiter of waiters) waiter();
    };
    const tryCall = (action: () => void) => {
      try {
        action();
      } catch {
        // A throwing stop/abort is handled by the bounded wait.
      }
    };
    /** A start that did not reach STARTED: release (abort, bounded wait for onend), then FAILED. */
    const failStart = async (reason: VoiceStartFailureReason) => {
      const settle = settleStart;
      settleStart = null;
      if (!settle) return;
      forwarding = false;
      if (!ended) tryCall(() => recognition.abort());
      const released = await waitForEnd();
      if (!released) markEnded();
      settle(failed(reason));
    };

    recognition.onstart = () => {
      if (ended || started || !settleStart) return;
      started = true;
      const settle = settleStart;
      settleStart = null;
      settle(Object.freeze({ kind: "STARTED", session: handle, maxSessionSeconds }));
    };
    recognition.onresult = (event) => {
      if (!forwarding || !started) return;
      const results = event?.results;
      const from = integer(event?.resultIndex) ?? 0;
      const length = integer(results?.length) ?? 0;
      for (let index = from; index < length; index += 1) {
        const result = results?.[index];
        const text = result?.[0]?.transcript;
        if (typeof text !== "string") continue;
        request.onSegment(Object.freeze({ kind: result?.isFinal === true ? "FINAL" : "INTERIM", segmentId: `ws${session}-${index}`, text }));
        if (!forwarding) return;
      }
    };
    recognition.onerror = (event) => {
      const error = event?.error;
      if (!started) {
        startError = error;
        void failStart(webSpeechStartFailureReason(error));
        return;
      }
      if (ended || userEnding || failureReported) return;
      // no-speech: the browser ends on its own; its onend is the provider-ended path.
      if (error === "no-speech" || error === "aborted") return;
      failureReported = true;
      forwarding = false;
      request.onFailure(sessionFailureReason(error));
    };
    recognition.onend = () => {
      const wasStarted = started;
      const reportEnd = wasStarted && !userEnding && !failureReported;
      markEnded();
      if (!wasStarted) {
        void failStart(startError === undefined ? "PROVIDER_FAILURE" : webSpeechStartFailureReason(startError));
        return;
      }
      // Browser-initiated end: report it once; never restart.
      if (reportEnd) request.onProviderEnded?.();
    };

    let released: Promise<VoiceReleaseReport> | null = null;
    const release = (kind: "stop" | "cancel"): Promise<VoiceReleaseReport> => {
      userEnding = true;
      if (kind === "cancel") forwarding = false;
      if (released) {
        if (kind === "cancel" && !ended) tryCall(() => recognition.abort());
        return released;
      }
      if (!ended) tryCall(() => (kind === "stop" ? recognition.stop() : recognition.abort()));
      released = waitForEnd().then((confirmed) => {
        if (!confirmed) {
          tryCall(() => recognition.abort());
          markEnded();
        }
        return Object.freeze({ microphoneReleased: confirmed, providerStop: NOT_APPLICABLE });
      });
      return released;
    };
    const handle = Object.freeze({ stop: () => release("stop"), cancel: () => release("cancel") });

    const pending = new Promise<VoiceStartResult>((resolve) => {
      settleStart = resolve;
    });
    const onAbort = () => void failStart("PROVIDER_FAILURE");
    request.signal.addEventListener("abort", onAbort, { once: true });
    try {
      recognition.start();
    } catch {
      // Nothing started: no onend will come.
      markEnded();
      void failStart("PROVIDER_FAILURE");
    }
    const result = await pending;
    request.signal.removeEventListener("abort", onAbort);
    return result;
  }

  return Object.freeze({ start });
}
