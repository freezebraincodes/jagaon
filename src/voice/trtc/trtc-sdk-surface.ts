import type TRTC from "trtc-sdk-v5";
import type { EnterRoomConfig, LOG_LEVEL, RealtimeTranscriberMessageEvent, RealtimeTranscriberStateEvent, Scene, StartRealtimeTranscriberOption, StopRealtimeTranscriberOption, TRTCEvent } from "trtc-sdk-v5";
import type { RealtimeTranscriber } from "trtc-sdk-v5/plugins/realtime-transcriber";

/**
 * Packet 13 slice (P13S, S5): the minimal structural surface of `trtc-sdk-v5@5.20.1` that the adapter uses. Type-only: this module
 * imports no SDK value (the adapter loads the SDK by dynamic import inside `start()`, client-only, after the disclosure).
 *
 * Facts confirmed offline from the installed `index.d.ts` and `plugins/realtime-transcriber/realtime-transcriber.esm.d.ts`, and pinned
 * by the compile-time checks at the end of this file:
 * - the root module's default export is the `TRTC` class (`export default TRTC`), with the statics `isSupported()`,
 *   `setLogLevel(level, enableUploadLog?)`, `create(options?)` and `EVENT`;
 * - the plugin module has ONLY the named export `RealtimeTranscriber` (no default in the `.d.ts`);
 * - `EVENT.REALTIME_TRANSCRIBER_MESSAGE` is 'realtime-transcriber-message', `EVENT.REALTIME_TRANSCRIBER_STATE_CHANGED` is
 *   'realtime-transcriber-state-changed', `EVENT.ERROR` is 'error'; `LOG_LEVEL.ERROR` is 4; `Scene.RTC` is 'rtc';
 * - `startPlugin('RealtimeTranscriber', StartRealtimeTranscriberOption)` resolves the robot id (`Promise<any>` in the root `.d.ts`,
 *   `Promise<string>` in the plugin `.d.ts`); `stopPlugin('RealtimeTranscriber', { transcriberRobotId })`.
 * The adapter never passes `translationLanguages`, `enableCloudRecording` or `enableSpeakerDiarization`; this surface has no field
 * for them.
 */
export const TRTC_EVENT_NAMES = Object.freeze({
  message: "realtime-transcriber-message",
  stateChanged: "realtime-transcriber-state-changed",
  error: "error",
} as const);
export const TRTC_LOG_LEVEL_ERROR = 4;
export const TRTC_SCENE_RTC = "rtc";
export const TRTC_TRANSCRIBER_PLUGIN = "RealtimeTranscriber";
/** The plugin's per-user local-storage key prefix (read in the installed plugin bundle). */
export const TRTC_TRANSCRIBER_STORAGE_PREFIX = "TRTC_RT_";

export type TrtcTranscriberMessage = Readonly<{ segmentId: string; speakerUserId: string; sourceText: string; isCompleted: boolean; robotId: string }>;
export type TrtcTranscriberStateChange = Readonly<{ state: "started" | "stopped"; transcriberRobotId: string; error?: number }>;
export type TrtcErrorLike = Readonly<{ name?: unknown; code?: unknown; extraCode?: unknown }>;

export type TrtcEventMap = {
  "realtime-transcriber-message": TrtcTranscriberMessage;
  "realtime-transcriber-state-changed": TrtcTranscriberStateChange;
  error: TrtcErrorLike;
};

export type TrtcEnterRoomParams = Readonly<{ sdkAppId: number; userId: string; userSig: string; strRoomId: string; scene: typeof TRTC_SCENE_RTC }>;
export type TrtcStartTranscriberOptions = Readonly<{ sourceLanguage: string; userIdsToTranscribe: string[] }>;
export type TrtcStopTranscriberOptions = Readonly<{ transcriberRobotId: string }>;

export type TrtcClientSurface = {
  enterRoom(params: TrtcEnterRoomParams): Promise<void>;
  startLocalAudio(): Promise<void>;
  stopLocalAudio(): Promise<void>;
  exitRoom(): Promise<void>;
  destroy(): void;
  startPlugin(plugin: typeof TRTC_TRANSCRIBER_PLUGIN, options: TrtcStartTranscriberOptions): Promise<unknown>;
  stopPlugin(plugin: typeof TRTC_TRANSCRIBER_PLUGIN, options: TrtcStopTranscriberOptions): Promise<unknown>;
  on<K extends keyof TrtcEventMap>(event: K, handler: (event: TrtcEventMap[K]) => void): unknown;
  off<K extends keyof TrtcEventMap>(event: K, handler: (event: TrtcEventMap[K]) => void): unknown;
};

/** The transcriber plugin class, passed to `create` only (opaque to the adapter). */
export type TrtcPluginSurface = typeof RealtimeTranscriber;

export type TrtcStaticSurface = {
  isSupported(): Promise<unknown>;
  setLogLevel(level: typeof TRTC_LOG_LEVEL_ERROR, enableUploadLog: false): void;
  create(options: { plugins: TrtcPluginSurface[] }): TrtcClientSurface;
};

export type TrtcSdkModules = Readonly<{ TRTC: TrtcStaticSurface; RealtimeTranscriber: TrtcPluginSurface }>;

// ---------------------------------------------------------------------------------------------------------------------------------
// Compile-time checks against the installed SDK types (a mismatch fails `tsc`).
// ---------------------------------------------------------------------------------------------------------------------------------
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assignable<From, To> = [From] extends [To] ? true : false;
type Expect<T extends true> = T;

/** Exported only so the checks are not unused; never used at runtime. */
export type TrtcSurfaceChecks = [
  // Event names, log level and scene values.
  Expect<Equal<(typeof TRTCEvent)["REALTIME_TRANSCRIBER_MESSAGE"], typeof TRTC_EVENT_NAMES.message>>,
  Expect<Equal<(typeof TRTCEvent)["REALTIME_TRANSCRIBER_STATE_CHANGED"], typeof TRTC_EVENT_NAMES.stateChanged>>,
  Expect<Equal<(typeof TRTCEvent)["ERROR"], typeof TRTC_EVENT_NAMES.error>>,
  Expect<Equal<`${LOG_LEVEL.ERROR}`, `${typeof TRTC_LOG_LEVEL_ERROR}`>>,
  Expect<Equal<`${Scene.RTC}`, typeof TRTC_SCENE_RTC>>,
  // What the SDK delivers is readable as our event types.
  Expect<Assignable<RealtimeTranscriberMessageEvent, TrtcTranscriberMessage>>,
  Expect<Assignable<RealtimeTranscriberStateEvent, TrtcTranscriberStateChange>>,
  // What we pass is accepted by the SDK.
  Expect<Assignable<TrtcStartTranscriberOptions, StartRealtimeTranscriberOption>>,
  Expect<Assignable<TrtcStopTranscriberOptions, StopRealtimeTranscriberOption>>,
  Expect<Assignable<Omit<TrtcEnterRoomParams, "scene">, Omit<EnterRoomConfig, "scene">>>,
  // The instance and static members we call exist with compatible shapes.
  Expect<Assignable<ReturnType<TRTC["startLocalAudio"]>, Promise<void>>>,
  Expect<Assignable<ReturnType<TRTC["stopLocalAudio"]>, Promise<void>>>,
  Expect<Assignable<ReturnType<TRTC["exitRoom"]>, Promise<void>>>,
  Expect<Assignable<ReturnType<TRTC["destroy"]>, void>>,
  Expect<Assignable<ReturnType<TRTC["enterRoom"]>, Promise<void>>>,
  Expect<Assignable<ReturnType<(typeof TRTC)["create"]>, TRTC>>,
  Expect<Assignable<ReturnType<(typeof TRTC)["isSupported"]>, Promise<unknown>>>,
  Expect<Assignable<Parameters<(typeof TRTC)["setLogLevel"]>[1], boolean | undefined>>,
  Expect<Assignable<typeof TRTC_LOG_LEVEL_ERROR, Parameters<(typeof TRTC)["setLogLevel"]>[0]>>,
  Expect<Assignable<[TrtcPluginSurface], NonNullable<Parameters<(typeof TRTC)["create"]>[0]>["plugins"]>>,
  Expect<Assignable<"start" | "stop", keyof RealtimeTranscriber>>,
];
