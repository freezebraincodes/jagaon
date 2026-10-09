import type { VoiceSessionFailureReason, VoiceReleaseReport, VoiceSegment, VoiceStartRequest, VoiceStartResult, VoiceTranscriberPort } from "./voice-transcriber-port";

/**
 * Packet 13 slice (P13S, S3): a scripted fake transcriber, for tests and an offline harness ONLY. It never touches a microphone, a
 * network or a provider, and it never pretends to be a working voice service in the product: the voice-off state shows "unavailable"
 * and manual entry, never this fake (owner decision "Voice entry", 2026-10-09).
 *
 * It records the call order (`start:<language>`, `abort`, `stop`, `cancel`, `release`) so tests can prove the release order, and lets a
 * test emit segments to any session (including an old or cancelled one) to prove that late and stale events are discarded.
 */
export type FakeVoiceTranscriberScript = Readonly<{
  /** How `start` resolves: at once (STARTED or FAILED), or only when the test calls `completeStart` (MANUAL). */
  start?: VoiceStartResultScript | Readonly<{ kind: "MANUAL" }>;
  /** Whether `stop`/`cancel` release at once (AUTO) or only when the test calls `completeRelease` (MANUAL). */
  release?: "AUTO" | "MANUAL";
  /** The release report (default: released). */
  microphoneReleased?: boolean;
  /** Segments emitted right after a STARTED start. */
  segmentsOnStart?: readonly VoiceSegment[];
}>;

type VoiceStartResultScript =
  | Readonly<{ kind: "STARTED"; maxSessionSeconds?: number }>
  | Readonly<{ kind: "FAILED"; reason: Extract<VoiceStartResult, { kind: "FAILED" }>["reason"]; credentialRefusal?: Extract<VoiceStartResult, { kind: "FAILED" }>["credentialRefusal"] }>;

export type FakeVoiceTranscriber = VoiceTranscriberPort &
  Readonly<{
    calls: readonly string[];
    /** Emits to the latest session (also after it was cancelled, to prove the caller drops it). */
    emit(segment: VoiceSegment): void;
    /** Emits to the session started by the given call (0-based), to prove stale sessions are dropped. */
    emitTo(sessionIndex: number, segment: VoiceSegment): void;
    fail(reason: VoiceSessionFailureReason): void;
    completeStart(result?: VoiceStartResultScript): void;
    completeRelease(): void;
    lastSignal(): AbortSignal | null;
  }>;

const DEFAULT_MAX_SESSION_SECONDS = 60;

export function createFakeVoiceTranscriber(script: FakeVoiceTranscriberScript = {}): FakeVoiceTranscriber {
  const calls: string[] = [];
  const sessions: VoiceStartRequest[] = [];
  let pendingStart: ((result: VoiceStartResultScript) => void) | null = null;
  let pendingRelease: (() => void) | null = null;

  function handleFor() {
    let released: Promise<VoiceReleaseReport> | null = null;
    const release = (call: "stop" | "cancel"): Promise<VoiceReleaseReport> => {
      calls.push(call);
      if (released) return released;
      const report = Object.freeze({ microphoneReleased: script.microphoneReleased ?? true });
      released =
        script.release === "MANUAL"
          ? new Promise((resolve) => {
              pendingRelease = () => {
                calls.push("release");
                resolve(report);
              };
            })
          : Promise.resolve().then(() => {
              calls.push("release");
              return report;
            });
      return released;
    };
    return Object.freeze({ stop: () => release("stop"), cancel: () => release("cancel") });
  }

  function resolveWith(request: VoiceStartRequest, result: VoiceStartResultScript): VoiceStartResult {
    if (result.kind === "FAILED") return Object.freeze({ kind: "FAILED", reason: result.reason, ...(result.credentialRefusal ? { credentialRefusal: result.credentialRefusal } : {}) });
    const started = Object.freeze({ kind: "STARTED" as const, session: handleFor(), maxSessionSeconds: result.maxSessionSeconds ?? DEFAULT_MAX_SESSION_SECONDS });
    queueMicrotask(() => {
      for (const segment of script.segmentsOnStart ?? []) request.onSegment(segment);
    });
    return started;
  }

  return Object.freeze({
    calls,
    async start(request: VoiceStartRequest): Promise<VoiceStartResult> {
      calls.push(`start:${request.language}`);
      sessions.push(request);
      request.signal.addEventListener("abort", () => calls.push("abort"), { once: true });
      const plan = script.start ?? { kind: "STARTED" };
      if (plan.kind !== "MANUAL") return resolveWith(request, plan);
      const result = await new Promise<VoiceStartResultScript>((resolve) => {
        pendingStart = resolve;
      });
      return resolveWith(request, result);
    },
    emit(segment: VoiceSegment) {
      sessions[sessions.length - 1]?.onSegment(segment);
    },
    emitTo(sessionIndex: number, segment: VoiceSegment) {
      sessions[sessionIndex]?.onSegment(segment);
    },
    fail(reason: VoiceSessionFailureReason) {
      sessions[sessions.length - 1]?.onFailure(reason);
    },
    completeStart(result: VoiceStartResultScript = { kind: "STARTED" }) {
      const resolve = pendingStart;
      pendingStart = null;
      resolve?.(result);
    },
    completeRelease() {
      const release = pendingRelease;
      pendingRelease = null;
      release?.();
    },
    lastSignal() {
      return sessions[sessions.length - 1]?.signal ?? null;
    },
  });
}
