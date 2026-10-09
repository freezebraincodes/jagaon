import type { VoiceLanguage } from "@/domain/voice/voice-contracts";
import type {
  VoiceCredentialRefusal,
  VoiceReleaseReport,
  VoiceSessionFailureReason,
  VoiceStartFailureReason,
  VoiceStartRequest,
  VoiceStartResult,
  VoiceTranscriberPort,
} from "@/application/voice/voice-transcriber-port";
import {
  TRTC_EVENT_NAMES,
  TRTC_LOG_LEVEL_ERROR,
  TRTC_SCENE_RTC,
  TRTC_TRANSCRIBER_PLUGIN,
  TRTC_TRANSCRIBER_STORAGE_PREFIX,
  type TrtcClientSurface,
  type TrtcErrorLike,
  type TrtcEventMap,
  type TrtcSdkModules,
  type TrtcStaticSurface,
} from "./trtc-sdk-surface";

/**
 * Packet 13 slice (P13S, S5): the real TRTC Web RealtimeTranscriber adapter behind the provider-neutral port. Client-only. Audio only,
 * one language, our own user only: no translation, no cloud recording, no speaker diarization, no Conversational AI.
 *
 * The SDK is NOT statically imported: the default loader runs `await import("trtc-sdk-v5")` and the named plugin import inside
 * `start()` only (the SDK is a browser-only UMD bundle). The loader, the credential request, the timers and the storage are injectable;
 * tests use a fake SDK object. No live call is made by any test.
 *
 * Start: `TRTC.isSupported()` (unsupported: nothing created, no credential requested) → the same-origin credential → `setLogLevel(4,
 * false)` (log upload OFF) BEFORE `TRTC.create({ plugins: [RealtimeTranscriber] })` → listeners → `enterRoom({ sdkAppId, userId,
 * userSig, strRoomId, scene: "rtc" })` → `startLocalAudio()` → `startPlugin("RealtimeTranscriber", { sourceLanguage,
 * userIdsToTranscribe: [userId] })`. An abort or any failure releases what was acquired before `start` resolves.
 *
 * Release (stop, cancel, failure; once): `stopPlugin` → `stopLocalAudio` → `exitRoom` → `destroy`, each step on its own (a throwing or
 * hanging step, bounded by the step timeout, never skips the next), then the listeners are removed and the plugin's
 * `localStorage["TRTC_RT_" + userId]` entry is removed if present. `microphoneReleased` is false only when `stopLocalAudio` failed.
 *
 * Events: only our robot's messages about our own user are forwarded; `isCompleted` maps to FINAL; only `sourceText` is used. After a
 * cancel nothing more is forwarded; after a stop, finals still arrive until the release ends. No SDK message, error or object crosses
 * the port: errors map to closed reasons (NotAllowedError / 5300+5302 → PERMISSION_DENIED; 5400+5001 → CONCURRENCY_LIMIT; 5200 →
 * UNSUPPORTED_BROWSER; 5400 / 5500 → NETWORK_FAILURE; anything else → PROVIDER_FAILURE). Nothing is logged.
 *
 * Residual SDK telemetry (statistics beacons) is not controlled by `setLogLevel` (preflight 1.5); `setLogLevel(4, …)` still prints SDK
 * ERROR-level logs to the browser console (level 5 would silence them; owner choice).
 */
export type TrtcCredential = Readonly<{ sdkAppId: number; userId: string; userSig: string; roomId: string; maxSessionSeconds: number }>;
export type TrtcCredentialResult =
  | Readonly<{ kind: "ISSUED"; credential: TrtcCredential }>
  | Readonly<{ kind: "REFUSED"; reason: VoiceCredentialRefusal }>
  | Readonly<{ kind: "FAILED"; reason: "NETWORK_FAILURE" }>;
export type TrtcCredentialRequest = (signal: AbortSignal) => Promise<TrtcCredentialResult>;

export type TrtcAdapterTimers = Readonly<{ setTimeout(callback: () => void, ms: number): unknown; clearTimeout(handle: unknown): void }>;
export type TrtcAdapterStorage = Readonly<{ removeItem(key: string): void }>;

export type TrtcTranscriberAdapterOptions = Readonly<{
  requestCredential: TrtcCredentialRequest;
  loadSdk?: () => Promise<TrtcSdkModules>;
  storage?: () => TrtcAdapterStorage | null;
  timers?: TrtcAdapterTimers;
  /** The bound on each release step (default 5 s). */
  stepTimeoutMs?: number;
}>;

const DEFAULT_STEP_TIMEOUT_MS = 5_000;
const ABORTED = Symbol("VOICE_START_ABORTED");
const SOURCE_LANGUAGE: Readonly<Record<VoiceLanguage, string>> = Object.freeze({ en: "en", zh: "zh" });

/** The default loader: dynamic imports only, client-side, after the disclosure (see the header). */
async function loadTrtcSdk(): Promise<TrtcSdkModules> {
  const root = await import("trtc-sdk-v5");
  const { RealtimeTranscriber } = await import("trtc-sdk-v5/plugins/realtime-transcriber");
  // The installed `.d.ts` types the SDK's statics with const enums (LOG_LEVEL, Scene); trtc-sdk-surface.ts pins that our narrower
  // surface matches them at compile time, so this one cast is checked rather than blind.
  return { TRTC: root.default as unknown as TrtcStaticSurface, RealtimeTranscriber };
}

function defaultStorage(): TrtcAdapterStorage | null {
  try {
    return typeof globalThis.localStorage === "undefined" ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

const DEFAULT_TIMERS: TrtcAdapterTimers = Object.freeze({
  setTimeout: (callback: () => void, ms: number) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
});

function errorFields(error: unknown): { name: unknown; code: unknown; extraCode: unknown } {
  if (typeof error !== "object" || error === null) return { name: undefined, code: undefined, extraCode: undefined };
  const fields = error as TrtcErrorLike;
  return { name: fields.name, code: fields.code, extraCode: fields.extraCode };
}

export function startFailureReason(error: unknown): VoiceStartFailureReason {
  const { name, code, extraCode } = errorFields(error);
  if (name === "NotAllowedError" || extraCode === 5302) return "PERMISSION_DENIED";
  if (code === 5400 && extraCode === 5001) return "CONCURRENCY_LIMIT";
  if (code === 5200) return "UNSUPPORTED_BROWSER";
  if (code === 5400 || code === 5500) return "NETWORK_FAILURE";
  return "PROVIDER_FAILURE";
}

function sessionFailureReason(error: unknown): VoiceSessionFailureReason {
  const { code } = errorFields(error);
  return code === 5400 || code === 5500 ? "NETWORK_FAILURE" : "PROVIDER_FAILURE";
}

export function createTrtcTranscriberAdapter(options: TrtcTranscriberAdapterOptions): VoiceTranscriberPort {
  const loadSdk = options.loadSdk ?? loadTrtcSdk;
  const storage = options.storage ?? defaultStorage;
  const timers = options.timers ?? DEFAULT_TIMERS;
  const stepTimeoutMs = options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;

  /** Runs one release step, bounded by the step timeout; true when it completed. Never throws. */
  async function step(action: () => Promise<unknown> | unknown): Promise<boolean> {
    let handle: unknown = null;
    try {
      const timeout = new Promise<false>((resolve) => {
        handle = timers.setTimeout(() => resolve(false), stepTimeoutMs);
      });
      return await Promise.race([Promise.resolve().then(action).then(() => true as const), timeout]);
    } catch {
      return false;
    } finally {
      if (handle !== null) timers.clearTimeout(handle);
    }
  }

  async function start(request: VoiceStartRequest): Promise<VoiceStartResult> {
    const { signal } = request;
    // Review M1: every start step races the abort signal, so a hanging step (a permission prompt left open) never blocks a cancel or
    // a start timeout; what was acquired is released below.
    const aborted = new Promise<never>((_, reject) => {
      if (signal.aborted) reject(ABORTED);
      else signal.addEventListener("abort", () => reject(ABORTED), { once: true });
    });
    aborted.catch(() => undefined);
    const untilAborted = <T>(work: Promise<T>): Promise<T> => Promise.race([work, aborted]);
    const failed = (reason: VoiceStartFailureReason, credentialRefusal?: VoiceCredentialRefusal): VoiceStartResult =>
      Object.freeze(credentialRefusal ? { kind: "FAILED", reason, credentialRefusal } : { kind: "FAILED", reason });
    if (signal.aborted) return failed("PROVIDER_FAILURE");

    let sdk: TrtcSdkModules;
    try {
      sdk = await untilAborted(loadSdk());
    } catch {
      return failed("PROVIDER_FAILURE");
    }
    if (signal.aborted) return failed("PROVIDER_FAILURE");
    try {
      const support = (await untilAborted(sdk.TRTC.isSupported())) as { result?: unknown } | null;
      if (support?.result !== true) return failed("UNSUPPORTED_BROWSER");
    } catch {
      return failed(signal.aborted ? "PROVIDER_FAILURE" : "UNSUPPORTED_BROWSER");
    }
    if (signal.aborted) return failed("PROVIDER_FAILURE");

    let credential: TrtcCredential;
    try {
      const answer = await untilAborted(options.requestCredential(signal));
      if (answer?.kind === "REFUSED") return failed("CREDENTIAL_REFUSED", answer.reason);
      if (answer?.kind !== "ISSUED" || !Number.isSafeInteger(answer.credential?.maxSessionSeconds) || answer.credential.maxSessionSeconds <= 0) return failed("NETWORK_FAILURE");
      credential = answer.credential;
    } catch {
      return failed("NETWORK_FAILURE");
    }
    if (signal.aborted) return failed("PROVIDER_FAILURE");

    // Session state, owned by this start.
    let trtc: TrtcClientSurface | null = null;
    let enterAttempted = false;
    let audioAttempted = false;
    let robotId: string | null = null;
    let forwarding = true;
    let listening = false;
    let releasing: Promise<VoiceReleaseReport> | null = null;

    const onMessage = (event: TrtcEventMap["realtime-transcriber-message"]) => {
      if (!forwarding || robotId === null || typeof event !== "object" || event === null) return;
      if (event.robotId !== robotId || event.speakerUserId !== credential.userId) return;
      if (typeof event.sourceText !== "string" || (typeof event.segmentId !== "string" && typeof event.segmentId !== "number")) return;
      request.onSegment(Object.freeze({ kind: event.isCompleted === true ? "FINAL" : "INTERIM", segmentId: String(event.segmentId), text: event.sourceText }));
    };
    const onState = (event: TrtcEventMap["realtime-transcriber-state-changed"]) => {
      if (!listening || releasing !== null || robotId === null || event?.transcriberRobotId !== robotId) return;
      if (event.state === "stopped") request.onFailure("PROVIDER_FAILURE");
    };
    const onError = (error: TrtcEventMap["error"]) => {
      if (listening && releasing === null) request.onFailure(sessionFailureReason(error));
    };

    async function releaseAll(): Promise<VoiceReleaseReport> {
      listening = false;
      const client = trtc;
      let microphoneReleased = true;
      if (client) {
        if (robotId !== null) {
          const transcriberRobotId = robotId;
          await step(() => client.stopPlugin(TRTC_TRANSCRIBER_PLUGIN, { transcriberRobotId }));
        }
        if (audioAttempted) microphoneReleased = await step(() => client.stopLocalAudio());
        // Review M7: destroy only after the room exit finished (a hanging or failed exit leaves the client to the SDK's own cleanup).
        const exited = enterAttempted ? await step(() => client.exitRoom()) : true;
        if (exited) await step(() => client.destroy());
        await step(() => client.off(TRTC_EVENT_NAMES.message, onMessage));
        await step(() => client.off(TRTC_EVENT_NAMES.stateChanged, onState));
        await step(() => client.off(TRTC_EVENT_NAMES.error, onError));
      }
      forwarding = false;
      try {
        storage()?.removeItem(`${TRTC_TRANSCRIBER_STORAGE_PREFIX}${credential.userId}`);
      } catch {
        // Storage may be unavailable (private mode); nothing else to clean.
      }
      return Object.freeze({ microphoneReleased });
    }
    const release = (cancel: boolean): Promise<VoiceReleaseReport> => {
      if (cancel) forwarding = false;
      return (releasing ??= releaseAll());
    };

    try {
      sdk.TRTC.setLogLevel(TRTC_LOG_LEVEL_ERROR, false);
      const client = sdk.TRTC.create({ plugins: [sdk.RealtimeTranscriber] });
      trtc = client;
      client.on(TRTC_EVENT_NAMES.message, onMessage);
      client.on(TRTC_EVENT_NAMES.stateChanged, onState);
      client.on(TRTC_EVENT_NAMES.error, onError);
      enterAttempted = true;
      await untilAborted(client.enterRoom({ sdkAppId: credential.sdkAppId, userId: credential.userId, userSig: credential.userSig, strRoomId: credential.roomId, scene: TRTC_SCENE_RTC }));
      if (signal.aborted) {
        await release(true);
        return failed("PROVIDER_FAILURE");
      }
      audioAttempted = true;
      await untilAborted(client.startLocalAudio());
      if (signal.aborted) {
        await release(true);
        return failed("PROVIDER_FAILURE");
      }
      const robot = await untilAborted(client.startPlugin(TRTC_TRANSCRIBER_PLUGIN, { sourceLanguage: SOURCE_LANGUAGE[request.language], userIdsToTranscribe: [credential.userId] }));
      robotId = typeof robot === "string" && robot.length > 0 ? robot : null;
      if (robotId === null || signal.aborted) {
        await release(true);
        return failed("PROVIDER_FAILURE");
      }
    } catch (error) {
      await release(true);
      return failed(startFailureReason(error));
    }

    listening = true;
    const session = Object.freeze({ stop: () => release(false), cancel: () => release(true) });
    return Object.freeze({ kind: "STARTED", session, maxSessionSeconds: credential.maxSessionSeconds });
  }

  return Object.freeze({ start });
}
