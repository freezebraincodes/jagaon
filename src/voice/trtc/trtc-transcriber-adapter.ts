import type { VoiceLanguage } from "@/domain/voice/voice-contracts";
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
 * `start()` only (the SDK is a browser-only UMD bundle). The loader, the credential request, the timers, the storage, the clock and the
 * Web Locks manager are injectable; tests use a fake SDK object. No live call is made by any test.
 *
 * Start: the provider-task guard (below) → `TRTC.isSupported()` (unsupported: nothing created, no credential requested) → the
 * same-origin credential → `setLogLevel(4, false)` (log upload OFF) BEFORE `TRTC.create({ plugins: [RealtimeTranscriber] })` →
 * listeners → `enterRoom({ sdkAppId, userId, userSig, strRoomId, scene: "rtc" })` → `startLocalAudio()` → the write-ahead marker →
 * `startPlugin("RealtimeTranscriber", { sourceLanguage, userIdsToTranscribe: [userId] })`. An abort or any failure releases what was
 * acquired before `start` resolves; a FAILED result carries the release's `providerStop`.
 *
 * Provider-task guard (write-ahead marker; owner decision, I-1 addendum). JagaOn's own `localStorage["jagaon.voice.
 * unconfirmedProviderTasks"]` holds `{ markerId, state, robotId, taskId, recordedAt }` markers (minimal identifiers only):
 * - START_REQUESTED is written immediately BEFORE `startPlugin` is called (the moment a provider task might be created), STARTED once
 *   the robot id (and the plugin's task id) are known, STOP_UNCONFIRMED when the release could not confirm the shutdown.
 * - A marker is removed ONLY on CONFIRMED shutdown or a definitive NOT_STARTED. It survives reloads, so it also covers a page closed or
 *   reloaded mid-session. It is per browser profile and origin, not account-wide.
 * - `start` refuses (FAILED PROVIDER_FAILURE, no new copy; nothing loaded, no credential requested) while any marker exists, while the
 *   marker value is unreadable, or when storage is unavailable (no write-ahead record is possible). Only
 *   `clearUnconfirmedProviderTasks(evidence)` clears markers (owner decisions I-2/I-3; reachable from DevTools as
 *   `window.jagaonVoiceRecovery`, no UI): the owner's recorded DescribeAITranscription response for a stored task id, or NEVER_SENT
 *   for a START_PENDING claim. Id-less START_REQUESTED / STARTED / STOP_UNCONFIRMED markers and an unreadable value stay blocked;
 *   clearing without evidence is not supported, and elapsed time is never evidence.
 * - Invariant behind NEVER_SENT: START_PENDING is written only by the fallback claim, before START_REQUESTED; START_REQUESTED is
 *   written and verified by a re-read before `startPlugin` is called, and a failed write refuses the start. So no path calls
 *   `startPlugin` while the marker is START_PENDING.
 * - Two same-origin tabs: the check-and-claim runs inside a Web Locks critical section (`navigator.locks`, lock
 *   "jagaon.voice.provider-start", `ifAvailable`: a busy lock refuses) held from the check until the start ends, so no second tab can
 *   pass the check before the marker exists. Without Web Locks the claim is a START_PENDING marker written at once and re-read: if
 *   another marker appears or ours was overwritten, this start backs off (best-effort; localStorage has no atomic compare-and-set).
 *   A START_PENDING marker left by a page closed before `startPlugin` also blocks until cleared (conservative). Residual windows: a
 *   lock grant reaching another tab before this tab's localStorage write is visible there, and an earlier session's late handler in
 *   another tab writing its marker after this tab's check (markers are appended, never merged across ids).
 * - A marker's identifiers are never downgraded: a later write with a null robot or task id keeps the recorded one.
 *
 * Release (stop, cancel, failure; once; cancel shuts the provider down exactly as stop does): `stopLocalAudio` FIRST (the microphone
 * is released whatever the provider does, never waiting for an in-flight start or a shutdown confirmation) → the provider phase →
 * `exitRoom` → `destroy` → the listeners are removed. Each step runs on its own (a throwing or hanging step, bounded by the step
 * timeout, never skips the next). `microphoneReleased` is false only when `stopLocalAudio` failed.
 *
 * Provider phase (one budget, default 10 000 ms, from the end of the microphone step): when `startPlugin` was never called →
 * NOT_STARTED. When it is still in flight (a cancel, a start timeout or an abort during the start), the release waits for it within the
 * budget: a robot id → the stop below with the remaining budget; a definitive rejection → NOT_STARTED; any other rejection, an invalid
 * result, or no settlement by the budget end → UNCONFIRMED START_UNRESOLVED (`robotId: null`, the plugin's task id if it wrote one).
 * Definitive rejections (no signalling request was sent; pinned 5.20.1): 5000 INVALID_PARAMETER (start-option validation, `Al`, trtc.esm.js
 * offset 451328, via the `Dl("start")` decorator at offset 454465, before `plugin.start`); 5200 ENV_NOT_SUPPORTED (`Dl` "plugin is not
 * supported", extraCode 5210; and `plugin.start` without `room.sendSignalMessage`, realtime-transcriber.esm.js offset 11537); 5100
 * INVALID_OPERATION (`room.sendSignalMessage` rejects "not join" without a signal channel, trtc.esm.js offset 993096, converted by
 * `RtcError.convertFrom` at offset 404804). Everything else is NOT definitive: 5400 SERVER_ERROR (the server answered
 * `start_cloud_transcription` with an error, or without a task id), 5500 (a signalling timeout, API_CALL_TIMEOUT), 5998 (API_CALL_ABORTED,
 * which shares the code with "plugin not found"), our own abort, and any unknown error.
 * - Stop: the state listener, attached at create and kept active until after the room exit, is the robot-left observer: it is in place
 *   before `stopPlugin` is sent. Only `{ state: "stopped", transcriberRobotId: <our robot> }` counts (the core emits it on the server's
 *   `asr-robot-peer-leave` push); another robot, another state, a malformed event or any event before our robot id was known never
 *   counts. A matching event earlier in the session counts too (during the session it is still reported as PROVIDER_FAILURE).
 *   `stopPlugin` resolving is NOT evidence (the pinned plugin resolves without sending when it has no task, and on codes 2002/4003).
 * - CONFIRMED: the matching robot-left event was observed. The plugin's `TRTC_RT_<userId>` entry and our marker are removed.
 * - UNCONFIRMED (STOP_THREW, STOP_TIMED_OUT, NO_ROBOT_LEFT_EVENT, START_UNRESOLVED; none means the provider rejected the stop): the
 *   plugin's entry is kept (its own `stop` clears it in a `finally`, so a missing entry is written back as `{ [robotId]: { taskId } }`
 *   only), our marker becomes STOP_UNCONFIRMED with the ids, the report carries `{ robotId, taskId }`, and exactly one `console.warn`
 *   names the reason and the ids. Only the robot id is masked (the plugin's default robot id embeds the room and user ids); the task id
 *   is printed exactly. Never a credential, audio or text.
 * - NOT_STARTED: no stop is sent, the plugin's entry and our marker are removed, nothing is logged.
 *
 * Late handler (after the bounded release): when the start was still in flight at the budget end, a continuation stays on it. If it
 * later yields a robot id, the marker is updated with the robot id and the plugin's task id, one masked line is logged, and, while the
 * client was not destroyed (a failed room exit), a best-effort `stopPlugin` is sent; the marker is never removed by this path (only a
 * definitive rejection removes it). The late handler lives only while the page is open: closing or reloading the page cancels it, so
 * recovery after a close relies solely on the persisted marker plus the owner's provider-side check (DescribeAITranscription /
 * StopAITranscription by task id).
 *
 * Bounds (injectable timers; defaults): each step ≤ 5 000 ms; the provider phase ≤ 10 000 ms (in-flight start wait + the ≤ 5 s stop
 * step + robot-left observation, all inside one budget; a robot id arriving late leaves a shorter observation, and the honest outcome
 * may be UNCONFIRMED). The pinned SDK stop may take far longer than one step (each signalling attempt waits up to 5 s, `retries: 3`;
 * code 3000 is retried twice with 1 s delays; offline, the signalling waits for reconnection), so the stop step may time out at 5 s
 * (STOP_TIMED_OUT) while observation continues to the budget end. Worst case: stopLocalAudio 5 s + provider phase 10 s + exitRoom 5 s
 * + destroy 5 s = 25 s (the listener removals are synchronous steps). The budget starts after the microphone step, not at the release
 * start, so a hanging microphone release does not shorten the provider phase.
 *
 * Events: only our robot's messages about our own user are forwarded; `isCompleted` maps to FINAL; only `sourceText` is used. After a
 * cancel nothing more is forwarded; after a stop, finals still arrive until the release ends. No SDK message, error or object crosses
 * the port: errors map to closed reasons (NotAllowedError / 5300+5302 → PERMISSION_DENIED; 5400+5001 → CONCURRENCY_LIMIT; 5200 →
 * UNSUPPORTED_BROWSER; 5400 / 5500 → NETWORK_FAILURE; anything else → PROVIDER_FAILURE). Nothing is logged except the unconfirmed
 * provider-stop line and the late-start line above.
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
export type TrtcAdapterStorage = Readonly<{ getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }>;

export type TrtcTranscriberAdapterOptions = Readonly<{
  requestCredential: TrtcCredentialRequest;
  loadSdk?: () => Promise<TrtcSdkModules>;
  storage?: () => TrtcAdapterStorage | null;
  timers?: TrtcAdapterTimers;
  /** The bound on each release step (default 5 s). */
  stepTimeoutMs?: number;
  /** The provider-phase budget of a release: in-flight start wait + stop + robot-left observation (default 10 s; see the header). */
  providerPhaseBudgetMs?: number;
  /** The Web Locks manager for the cross-tab start guard (default `navigator.locks`; null → the re-read fallback). */
  locks?: () => TrtcAdapterLocks | null;
  /** Wall-clock milliseconds for the markers' `recordedAt` (default `Date.now`). */
  now?: () => number;
}>;

/** The subset of the Web Locks API the start guard uses (`navigator.locks`). */
export type TrtcAdapterLocks = Readonly<{
  request(name: string, options: Readonly<{ ifAvailable: boolean }>, callback: (lock: unknown) => Promise<unknown>): Promise<unknown>;
}>;

export const JAGAON_PROVIDER_TASK_MARKERS_KEY = "jagaon.voice.unconfirmedProviderTasks";
export const JAGAON_PROVIDER_TASK_CLEARANCES_KEY = "jagaon.voice.providerTaskClearances";
export const JAGAON_PROVIDER_START_LOCK = "jagaon.voice.provider-start";
const MAX_CLEARANCES = 20;
const MARKER_STATES = ["START_PENDING", "START_REQUESTED", "STARTED", "STOP_UNCONFIRMED"] as const;
export type ProviderTaskMarkerState = (typeof MARKER_STATES)[number];
export type ProviderTaskMarker = Readonly<{ markerId: string; state: ProviderTaskMarkerState; robotId: string | null; taskId: string | null; recordedAt: number }>;
export type ProviderTaskMarkersRead = Readonly<{ kind: "OK"; markers: readonly ProviderTaskMarker[] }> | Readonly<{ kind: "UNREADABLE" }> | Readonly<{ kind: "UNAVAILABLE" }>;
/**
 * The evidence required to clear a marker (owner decisions I-2/I-3). Either the owner's recorded DescribeAITranscription response for a
 * stored, non-empty task id, or NEVER_SENT for one START_PENDING claim. NEVER_SENT records app-local state only: this app never
 * requested a transcription start (`startPlugin` / `start_cloud_transcription`) for that claim. It does not mean nothing reached
 * Tencent: room entry and audio publishing may already have happened, and it says nothing about other tabs or devices.
 */
export type ProviderTaskClearEvidence =
  | Readonly<{ kind: "PROVIDER_STATUS_STOPPED" | "PROVIDER_TASK_NOT_FOUND"; taskId: string; checkedAt: number; method: "DescribeAITranscription" }>
  | Readonly<{ kind: "NEVER_SENT"; markerId: string }>;
export const PROVIDER_TASK_CLEAR_REJECTIONS = ["EVIDENCE_REQUIRED", "NO_MATCHING_MARKER", "NOT_NEVER_SENT", "START_IN_PROGRESS", "STORAGE_UNAVAILABLE"] as const;
export type ProviderTaskClearRejection = (typeof PROVIDER_TASK_CLEAR_REJECTIONS)[number];
export type ProviderTaskClearResult = Readonly<{ kind: "CLEARED"; removed: number }> | Readonly<{ kind: "REJECTED"; reason: ProviderTaskClearRejection }>;
/** One stored clearance record (minimal identifiers only; `providerVerified` is always false: the app never saw a provider response). */
export type ProviderTaskClearance = Readonly<{
  markerId: string;
  taskId: string | null;
  markerState: ProviderTaskMarkerState;
  evidenceKind: ProviderTaskClearEvidence["kind"];
  evidenceSource: "OWNER_RECORDED_PROVIDER_RESPONSE" | "APP_LOCAL_STATE";
  providerVerified: false;
  method: "DescribeAITranscription" | null;
  checkedAt: number | null;
  clearedAt: number;
}>;

const DEFAULT_STEP_TIMEOUT_MS = 5_000;
const DEFAULT_PROVIDER_PHASE_BUDGET_MS = 10_000;
const CONFIRMED: VoiceProviderStop = Object.freeze({ kind: "CONFIRMED" });
const NOT_STARTED: VoiceProviderStop = Object.freeze({ kind: "NOT_STARTED" });
type StepOutcome = "DONE" | "THREW" | "TIMED_OUT";
type UnconfirmedStop = Extract<VoiceProviderStop, { kind: "UNCONFIRMED" }>;
/** How the plugin start settled; never rejects. */
type StartSettled = Readonly<{ kind: "ROBOT"; robotId: string }> | Readonly<{ kind: "NO_ROBOT"; definitive: boolean; error: unknown }>;
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

function defaultLocks(): TrtcAdapterLocks | null {
  try {
    const locks = (globalThis.navigator as { locks?: Partial<TrtcAdapterLocks> } | undefined)?.locks;
    return locks && typeof locks.request === "function" ? (locks as TrtcAdapterLocks) : null;
  } catch {
    return null;
  }
}

function openStorage(storage: () => TrtcAdapterStorage | null): TrtcAdapterStorage | null {
  try {
    return storage();
  } catch {
    return null;
  }
}

const isMarker = (value: unknown): value is ProviderTaskMarker =>
  isRecord(value) &&
  typeof value.markerId === "string" &&
  value.markerId.length > 0 &&
  MARKER_STATES.some((state) => state === value.state) &&
  (value.robotId === null || typeof value.robotId === "string") &&
  (value.taskId === null || typeof value.taskId === "string") &&
  typeof value.recordedAt === "number" &&
  Number.isFinite(value.recordedAt);

function readMarkersFrom(store: TrtcAdapterStorage | null): ProviderTaskMarkersRead {
  if (!store) return Object.freeze({ kind: "UNAVAILABLE" });
  let raw: string | null;
  try {
    raw = store.getItem(JAGAON_PROVIDER_TASK_MARKERS_KEY);
  } catch {
    return Object.freeze({ kind: "UNAVAILABLE" });
  }
  if (raw === null) return Object.freeze({ kind: "OK", markers: [] });
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every(isMarker)) return Object.freeze({ kind: "OK", markers: parsed });
  } catch {
    // Unreadable: treated as a marker that blocks (see the header).
  }
  return Object.freeze({ kind: "UNREADABLE" });
}

function writeMarkersTo(store: TrtcAdapterStorage, markers: readonly ProviderTaskMarker[]): boolean {
  try {
    if (markers.length === 0) store.removeItem(JAGAON_PROVIDER_TASK_MARKERS_KEY);
    else store.setItem(JAGAON_PROVIDER_TASK_MARKERS_KEY, JSON.stringify(markers));
    return true;
  } catch {
    return false;
  }
}

/** For the owner's inspection (devtools / pilot procedure): the current provider-task markers. */
export function readUnconfirmedProviderTasks(storage: () => TrtcAdapterStorage | null = defaultStorage): ProviderTaskMarkersRead {
  return readMarkersFrom(openStorage(storage));
}

const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

const validEvidence = (evidence: unknown): evidence is ProviderTaskClearEvidence =>
  isRecord(evidence) &&
  ((evidence.kind === "NEVER_SENT" && nonEmptyString(evidence.markerId)) ||
    ((evidence.kind === "PROVIDER_STATUS_STOPPED" || evidence.kind === "PROVIDER_TASK_NOT_FOUND") &&
      evidence.method === "DescribeAITranscription" &&
      typeof evidence.checkedAt === "number" &&
      Number.isFinite(evidence.checkedAt) &&
      evidence.checkedAt > 0 &&
      nonEmptyString(evidence.taskId)));

const isClearance = (value: unknown): value is ProviderTaskClearance =>
  isRecord(value) &&
  nonEmptyString(value.markerId) &&
  (value.taskId === null || typeof value.taskId === "string") &&
  MARKER_STATES.some((state) => state === value.markerState) &&
  (value.evidenceKind === "NEVER_SENT" || value.evidenceKind === "PROVIDER_STATUS_STOPPED" || value.evidenceKind === "PROVIDER_TASK_NOT_FOUND") &&
  (value.evidenceSource === "OWNER_RECORDED_PROVIDER_RESPONSE" || value.evidenceSource === "APP_LOCAL_STATE") &&
  value.providerVerified === false &&
  (value.method === null || value.method === "DescribeAITranscription") &&
  (value.checkedAt === null || (typeof value.checkedAt === "number" && Number.isFinite(value.checkedAt))) &&
  typeof value.clearedAt === "number" &&
  Number.isFinite(value.clearedAt);

/** The stored clearance history, keeping only well-formed records projected to their known fields. */
function readClearancesFrom(store: TrtcAdapterStorage | null): ProviderTaskClearance[] {
  try {
    const parsed: unknown = JSON.parse(store?.getItem(JAGAON_PROVIDER_TASK_CLEARANCES_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isClearance).map(({ markerId, taskId, markerState, evidenceKind, evidenceSource, providerVerified, method, checkedAt, clearedAt }) => ({ markerId, taskId, markerState, evidenceKind, evidenceSource, providerVerified, method, checkedAt, clearedAt }));
  } catch {
    return [];
  }
}

const rejected = (reason: ProviderTaskClearRejection): ProviderTaskClearResult => Object.freeze({ kind: "REJECTED", reason });

/** Removes the given markers and appends their clearance records; the history is written first, so no clear goes unrecorded. */
function commitClearance(store: TrtcAdapterStorage, remaining: readonly ProviderTaskMarker[], records: readonly ProviderTaskClearance[]): ProviderTaskClearResult {
  try {
    store.setItem(JAGAON_PROVIDER_TASK_CLEARANCES_KEY, JSON.stringify([...readClearancesFrom(store), ...records].slice(-MAX_CLEARANCES)));
  } catch {
    return rejected("STORAGE_UNAVAILABLE");
  }
  if (!writeMarkersTo(store, remaining)) return rejected("STORAGE_UNAVAILABLE");
  return Object.freeze({ kind: "CLEARED", removed: records.length });
}

export type ProviderTaskClearOptions = Readonly<{ storage?: () => TrtcAdapterStorage | null; now?: () => number; locks?: () => TrtcAdapterLocks | null }>;

/**
 * The only way to clear provider-task markers, for an explicit owner/dev action (no UI; see `jagaonVoiceRecovery` below). Clearing
 * without evidence is not supported, and elapsed time is never evidence (no age threshold).
 * - DescribeAITranscription (`PROVIDER_STATUS_STOPPED` / `PROVIDER_TASK_NOT_FOUND`): requires a non-empty `taskId` equal to a stored
 *   marker's task id; removes only the markers with that task id. Recorded as `evidenceSource: "OWNER_RECORDED_PROVIDER_RESPONSE"`,
 *   `providerVerified: false` (the owner ran the call in API Explorer; the app never saw the response).
 * - NEVER_SENT: only for that exact, readable marker in state START_PENDING, which is written only before START_REQUESTED, and
 *   START_REQUESTED is written and verified before `startPlugin` (a failed write refuses the start), so this app never called
 *   `startPlugin` (no `start_cloud_transcription`) for it; room entry and audio publishing may still have reached Tencent. START_PENDING
 *   exists only in the no-Web-Locks fallback (best-effort, see the header). When Web Locks is available the start
 *   lock is taken for the check (busy: START_IN_PROGRESS). Recorded as `evidenceSource: "APP_LOCAL_STATE"`, `providerVerified: false`.
 * - Id-less START_REQUESTED / STARTED / STOP_UNCONFIRMED markers and an unreadable value have NO clearing path: they stay blocked.
 * Records `{ markerId, taskId, markerState, evidenceKind, evidenceSource, providerVerified, method, checkedAt, clearedAt }` in
 * `jagaon.voice.providerTaskClearances` (last 20). Rejections: EVIDENCE_REQUIRED, NO_MATCHING_MARKER (absent, or the value is
 * unreadable), NOT_NEVER_SENT, START_IN_PROGRESS, STORAGE_UNAVAILABLE.
 */
export async function clearUnconfirmedProviderTasks(evidence: ProviderTaskClearEvidence, options: ProviderTaskClearOptions = {}): Promise<ProviderTaskClearResult> {
  if (!validEvidence(evidence)) return rejected("EVIDENCE_REQUIRED");
  const now = options.now ?? Date.now;
  const store = openStorage(options.storage ?? defaultStorage);
  if (!store || readMarkersFrom(store).kind === "UNAVAILABLE") return rejected("STORAGE_UNAVAILABLE");

  if (evidence.kind !== "NEVER_SENT") {
    const read = readMarkersFrom(store);
    if (read.kind !== "OK") return rejected("NO_MATCHING_MARKER");
    const matches = read.markers.filter((marker) => marker.taskId === evidence.taskId);
    if (matches.length === 0) return rejected("NO_MATCHING_MARKER");
    const clearedAt = now();
    return commitClearance(
      store,
      read.markers.filter((marker) => marker.taskId !== evidence.taskId),
      matches.map((marker) => ({ markerId: marker.markerId, taskId: evidence.taskId, markerState: marker.state, evidenceKind: evidence.kind, evidenceSource: "OWNER_RECORDED_PROVIDER_RESPONSE", providerVerified: false, method: evidence.method, checkedAt: evidence.checkedAt, clearedAt })),
    );
  }

  const manager = (() => {
    try {
      return (options.locks ?? defaultLocks)();
    } catch {
      return null;
    }
  })();
  const lock = manager ? await acquireStartLock(manager) : "FAILED";
  if (lock === "BUSY") return rejected("START_IN_PROGRESS");
  try {
    const read = readMarkersFrom(store);
    if (read.kind !== "OK") return rejected("NO_MATCHING_MARKER");
    const marker = read.markers.find((entry) => entry.markerId === evidence.markerId);
    if (!marker) return rejected("NO_MATCHING_MARKER");
    if (marker.state !== "START_PENDING") return rejected("NOT_NEVER_SENT");
    return commitClearance(
      store,
      read.markers.filter((entry) => entry.markerId !== evidence.markerId),
      [{ markerId: marker.markerId, taskId: marker.taskId, markerState: marker.state, evidenceKind: "NEVER_SENT", evidenceSource: "APP_LOCAL_STATE", providerVerified: false, method: null, checkedAt: null, clearedAt: now() }],
    );
  } finally {
    if (typeof lock === "function") lock();
  }
}

export const VOICE_RECOVERY_GLOBAL = "jagaonVoiceRecovery";
export type VoiceRecoveryMarkerView = Readonly<{ markerId: string; state: ProviderTaskMarkerState; robotId: string | null; taskId: string | null; recordedAt: string; neverSent: boolean }>;
export type VoiceRecoveryView = Readonly<{ guard: ProviderTaskMarkersRead["kind"]; blocksStart: boolean; markers: readonly VoiceRecoveryMarkerView[]; clearances: readonly ProviderTaskClearance[] }>;
export type VoiceRecoveryHelper = Readonly<{ read(): VoiceRecoveryView; clear(evidence: ProviderTaskClearEvidence): Promise<ProviderTaskClearResult> }>;

const isoOf = (ms: number): string => {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? "INVALID_DATE" : date.toISOString();
};

/**
 * Owner decision I-2: the DevTools recovery helper, `window.jagaonVoiceRecovery = { read(), clear(evidence) }`, for the pilot procedure
 * only (no UI, nothing logged). `read()` returns a frozen, plain-JSON view: the guard state, whether it blocks a start, the markers
 * (`recordedAt` as an ISO string; `neverSent` only for START_PENDING) and the stored clearance history; never a credential, an
 * sdkAppId/userSig/userId/roomId field, audio or text (the robot id stays as stored). `clear(evidence)` delegates to
 * `clearUnconfirmedProviderTasks`. Freezing is NOT a security boundary (any page script can still edit localStorage), and nothing in
 * this helper is proof that the provider shut a task down.
 */
export function createVoiceRecoveryHelper(options: ProviderTaskClearOptions = {}): VoiceRecoveryHelper {
  const storage = options.storage ?? defaultStorage;
  const read = (): VoiceRecoveryView => {
    const store = openStorage(storage);
    const markers = readMarkersFrom(store);
    const view = {
      guard: markers.kind,
      blocksStart: markers.kind !== "OK" || markers.markers.length > 0,
      markers: (markers.kind === "OK" ? markers.markers : []).map((marker) =>
        Object.freeze({ markerId: marker.markerId, state: marker.state, robotId: marker.robotId, taskId: marker.taskId, recordedAt: isoOf(marker.recordedAt), neverSent: marker.state === "START_PENDING" }),
      ),
      clearances: readClearancesFrom(store).map((record) => Object.freeze(record)),
    };
    return Object.freeze({ ...view, markers: Object.freeze(view.markers), clearances: Object.freeze(view.clearances) });
  };
  return Object.freeze({ read, clear: (evidence: ProviderTaskClearEvidence) => clearUnconfirmedProviderTasks(evidence, options) });
}

/**
 * Installs the helper once on the given browser global (non-writable, non-configurable, non-enumerable); a repeat install is a no-op.
 * Returns true when it installed. Called only where the TRTC cloud transcriber is composed, in the browser.
 */
export function installVoiceRecoveryHelper(target: object, options: ProviderTaskClearOptions = {}): boolean {
  if (Object.prototype.hasOwnProperty.call(target, VOICE_RECOVERY_GLOBAL)) return false;
  try {
    Object.defineProperty(target, VOICE_RECOVERY_GLOBAL, { value: createVoiceRecoveryHelper(options), writable: false, configurable: false, enumerable: false });
    return true;
  } catch {
    return false;
  }
}

/** Asks for the start lock without waiting: a release function, "BUSY" (another tab holds it) or "FAILED" (the API failed). */
function acquireStartLock(locks: TrtcAdapterLocks): Promise<(() => void) | "BUSY" | "FAILED"> {
  return new Promise((resolve) => {
    try {
      const requested = locks.request(JAGAON_PROVIDER_START_LOCK, { ifAvailable: true }, (lock) => {
        if (lock === null || lock === undefined) {
          resolve("BUSY");
          return Promise.resolve();
        }
        return new Promise<void>((release) => resolve(() => release()));
      });
      Promise.resolve(requested).catch(() => resolve("FAILED"));
    } catch {
      resolve("FAILED");
    }
  });
}

/**
 * Definitive evidence that no provider task was created: the start was rejected before any signalling request (see the header for
 * the SDK locations). Everything else (server errors, signalling timeouts and aborts, our abort, unknown errors) is not definitive.
 */
export function isDefinitiveStartRejection(error: unknown): boolean {
  const { code } = errorFields(error);
  return code === 5000 || code === 5100 || code === 5200;
}

const DEFAULT_TIMERS: TrtcAdapterTimers = Object.freeze({
  setTimeout: (callback: () => void, ms: number) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
});

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Parses the plugin's `{ [robotId]: { taskId, options } }` entry; anything else is treated as empty. */
function parseEntries(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function taskIdOf(entry: unknown): string | null {
  return isRecord(entry) && typeof entry.taskId === "string" && entry.taskId.length > 0 ? entry.taskId : null;
}

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
  const providerBudgetMs = options.providerPhaseBudgetMs ?? DEFAULT_PROVIDER_PHASE_BUDGET_MS;
  const locks = options.locks ?? defaultLocks;
  const now = options.now ?? Date.now;

  /** Runs one release step, bounded by the step timeout, and says how it ended. Never throws. */
  async function stepOutcome(action: () => Promise<unknown> | unknown): Promise<StepOutcome> {
    let handle: unknown = null;
    try {
      const timeout = new Promise<"TIMED_OUT">((resolve) => {
        handle = timers.setTimeout(() => resolve("TIMED_OUT"), stepTimeoutMs);
      });
      return await Promise.race([Promise.resolve().then(action).then(() => "DONE" as const), timeout]);
    } catch {
      return "THREW";
    } finally {
      if (handle !== null) timers.clearTimeout(handle);
    }
  }
  /** True when the step completed. */
  const step = async (action: () => Promise<unknown> | unknown): Promise<boolean> => (await stepOutcome(action)) === "DONE";

  function newMarkerId(): string {
    try {
      const id = globalThis.crypto?.randomUUID?.();
      if (typeof id === "string" && id.length > 0) return id;
    } catch {
      // Fall through to a local id.
    }
    return `m-${now()}-${Math.random().toString(36).slice(2)}`;
  }

  /**
   * Writes (or updates) this start's marker and re-reads it; false when it could not be recorded. Identifiers are never downgraded:
   * a null `robotId` or `taskId` keeps the value already recorded for this marker (re-review I-1: the late handler may record the ids
   * while the release is still exiting the room, before the release writes its own outcome).
   */
  function setMarker(markerId: string, state: ProviderTaskMarkerState, robotId: string | null, taskId: string | null): boolean {
    const store = openStorage(storage);
    const read = readMarkersFrom(store);
    if (!store || read.kind !== "OK") return false;
    const existing = read.markers.find((entry) => entry.markerId === markerId);
    const marker: ProviderTaskMarker = { markerId, state, robotId: robotId ?? existing?.robotId ?? null, taskId: taskId ?? existing?.taskId ?? null, recordedAt: now() };
    if (!writeMarkersTo(store, [...read.markers.filter((entry) => entry.markerId !== markerId), marker])) return false;
    const check = readMarkersFrom(store);
    return check.kind === "OK" && check.markers.some((entry) => entry.markerId === markerId && entry.state === state);
  }

  /** Removes only this start's marker (CONFIRMED or a definitive NOT_STARTED). */
  function dropMarker(markerId: string): void {
    const store = openStorage(storage);
    const read = readMarkersFrom(store);
    if (!store || read.kind !== "OK" || !read.markers.some((entry) => entry.markerId === markerId)) return;
    writeMarkersTo(store, read.markers.filter((entry) => entry.markerId !== markerId));
  }

  /**
   * The cross-tab check-and-claim (see the header): resolves the lock release when this start may proceed, null when it must refuse.
   * With Web Locks the marker is written later, just before `startPlugin`, while the lock is held; without, a START_PENDING claim is
   * written now and verified by a re-read.
   */
  async function claimStart(markerId: string): Promise<Readonly<{ release: () => void }> | null> {
    const manager = (() => {
      try {
        return locks();
      } catch {
        return null;
      }
    })();
    const lock = manager ? await acquireStartLock(manager) : "FAILED";
    if (lock === "BUSY") return null;
    const releaseLock = typeof lock === "function" ? lock : () => undefined;
    const store = openStorage(storage);
    const read = readMarkersFrom(store);
    if (!store || read.kind !== "OK" || read.markers.length > 0) {
      releaseLock();
      return null;
    }
    if (typeof lock === "function") return Object.freeze({ release: releaseLock });
    if (!setMarker(markerId, "START_PENDING", null, null)) {
      dropMarker(markerId);
      return null;
    }
    const verify = readMarkersFrom(store);
    if (verify.kind !== "OK" || verify.markers.length !== 1 || verify.markers[0].markerId !== markerId) {
      dropMarker(markerId);
      return null;
    }
    return Object.freeze({ release: releaseLock });
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
    const failedWith = (providerStop: VoiceProviderStop | undefined, reason: VoiceStartFailureReason, credentialRefusal?: VoiceCredentialRefusal): VoiceStartResult =>
      Object.freeze({ kind: "FAILED", reason, ...(credentialRefusal ? { credentialRefusal } : {}), ...(providerStop ? { providerStop } : {}) });
    if (signal.aborted) return failedWith(undefined, "PROVIDER_FAILURE");

    const markerId = newMarkerId();
    const claim = await claimStart(markerId);
    // A marker from an earlier, unconfirmed task (or another tab's start) blocks this start: nothing is loaded or requested.
    if (!claim) return failedWith(NOT_STARTED, "PROVIDER_FAILURE");
    try {
      return await startClaimed(request, untilAborted, failedWith, markerId);
    } finally {
      claim.release();
    }
  }

  async function startClaimed(
    request: VoiceStartRequest,
    untilAborted: <T>(work: Promise<T>) => Promise<T>,
    failedWith: (providerStop: VoiceProviderStop | undefined, reason: VoiceStartFailureReason, credentialRefusal?: VoiceCredentialRefusal) => VoiceStartResult,
    markerId: string,
  ): Promise<VoiceStartResult> {
    const { signal } = request;
    /** Before any client exists: definitively nothing started; the claim is dropped. */
    const notStarted = (reason: VoiceStartFailureReason, credentialRefusal?: VoiceCredentialRefusal): VoiceStartResult => {
      dropMarker(markerId);
      return failedWith(NOT_STARTED, reason, credentialRefusal);
    };
    if (signal.aborted) return notStarted("PROVIDER_FAILURE");

    let sdk: TrtcSdkModules;
    try {
      sdk = await untilAborted(loadSdk());
    } catch {
      return notStarted("PROVIDER_FAILURE");
    }
    if (signal.aborted) return notStarted("PROVIDER_FAILURE");
    try {
      const support = (await untilAborted(sdk.TRTC.isSupported())) as { result?: unknown } | null;
      if (support?.result !== true) return notStarted("UNSUPPORTED_BROWSER");
    } catch {
      return notStarted(signal.aborted ? "PROVIDER_FAILURE" : "UNSUPPORTED_BROWSER");
    }
    if (signal.aborted) return notStarted("PROVIDER_FAILURE");

    let credential: TrtcCredential;
    try {
      const answer = await untilAborted(options.requestCredential(signal));
      if (answer?.kind === "REFUSED") return notStarted("CREDENTIAL_REFUSED", answer.reason);
      if (answer?.kind !== "ISSUED" || !Number.isSafeInteger(answer.credential?.maxSessionSeconds) || answer.credential.maxSessionSeconds <= 0) return notStarted("NETWORK_FAILURE");
      credential = answer.credential;
    } catch {
      return notStarted("NETWORK_FAILURE");
    }
    if (signal.aborted) return notStarted("PROVIDER_FAILURE");

    // Session state, owned by this start.
    let trtc: TrtcClientSurface | null = null;
    let enterAttempted = false;
    let audioAttempted = false;
    /** The in-flight (or settled) plugin start; null while `startPlugin` was never called. */
    let pluginStart: Promise<StartSettled> | null = null;
    let robotId: string | null = null;
    let forwarding = true;
    let listening = false;
    let destroyCalled = false;
    let releasing: Promise<VoiceReleaseReport> | null = null;
    /** Robot-left evidence: a matching "stopped" event seen after our robot id was known (in the session or during the release). */
    let robotLeft = false;
    let onRobotLeft: (() => void) | null = null;
    const storageKey = `${TRTC_TRANSCRIBER_STORAGE_PREFIX}${credential.userId}`;

    const onMessage = (event: TrtcEventMap["realtime-transcriber-message"]) => {
      if (!forwarding || robotId === null || typeof event !== "object" || event === null) return;
      if (event.robotId !== robotId || event.speakerUserId !== credential.userId) return;
      if (typeof event.sourceText !== "string" || (typeof event.segmentId !== "string" && typeof event.segmentId !== "number")) return;
      request.onSegment(Object.freeze({ kind: event.isCompleted === true ? "FINAL" : "INTERIM", segmentId: String(event.segmentId), text: event.sourceText }));
    };
    const onState = (event: TrtcEventMap["realtime-transcriber-state-changed"]) => {
      if (robotId === null || typeof event !== "object" || event === null || event.transcriberRobotId !== robotId || event.state !== "stopped") return;
      robotLeft = true;
      onRobotLeft?.();
      if (listening && releasing === null) request.onFailure("PROVIDER_FAILURE");
    };
    const onError = (error: TrtcEventMap["error"]) => {
      if (listening && releasing === null) request.onFailure(sessionFailureReason(error));
    };

    function pluginEntries(): Record<string, unknown> {
      try {
        return parseEntries(openStorage(storage)?.getItem(storageKey));
      } catch {
        return {};
      }
    }
    /** This robot's task id from the plugin's entry, read before the stop (the plugin clears it); null when unavailable. */
    const readTaskId = (robot: string): string | null => taskIdOf(pluginEntries()[robot]);
    /** Any task id the plugin recorded for this user (the robot id is unknown while the start is unresolved). */
    const anyTaskId = (): string | null => Object.values(pluginEntries()).map(taskIdOf).find((taskId) => taskId !== null) ?? null;

    /** UNCONFIRMED: keeps the plugin's entry, writing back only `{ taskId }` for our robot when its own stop already removed it. */
    function keepRecoveryEntry(robot: string | null, taskId: string | null): void {
      if (robot === null || taskId === null) return;
      try {
        const store = openStorage(storage);
        if (!store) return;
        const entries = parseEntries(store.getItem(storageKey));
        if (taskIdOf(entries[robot]) === taskId) return;
        store.setItem(storageKey, JSON.stringify({ ...entries, [robot]: { taskId } }));
      } catch {
        // Storage may be unavailable (private mode); the report and the marker still carry the identifiers.
      }
    }

    /** Masks only the robot id (the plugin's default embeds the room and user ids); a task id is printed exactly. */
    function maskRobot(robot: string | null): string {
      if (robot === null) return "unknown";
      const masks: Array<[string, string]> = [
        [credential.userSig, "<sig>"],
        [credential.roomId, "<room>"],
        [credential.userId, "<user>"],
        [String(credential.sdkAppId), "<app>"],
      ];
      return masks.reduce((text, [secret, label]) => (secret.length > 0 ? text.split(secret).join(label) : text), robot);
    }

    /** Sends the stop with the robot-left observer already active, and observes until the event or the budget end (see the header). */
    async function stopProvider(client: TrtcClientSurface, transcriberRobotId: string, budgetEnded: Promise<"BUDGET_ENDED">): Promise<VoiceProviderStop> {
      const taskId = readTaskId(transcriberRobotId);
      const left = new Promise<"ROBOT_LEFT">((resolve) => {
        onRobotLeft = () => resolve("ROBOT_LEFT");
        if (robotLeft) resolve("ROBOT_LEFT");
      });
      try {
        const stopped = await Promise.race([stepOutcome(() => client.stopPlugin(TRTC_TRANSCRIBER_PLUGIN, { transcriberRobotId })), left, budgetEnded]);
        if (stopped !== "ROBOT_LEFT" && stopped !== "BUDGET_ENDED" && !robotLeft) await Promise.race([left, budgetEnded]);
        if (robotLeft) return CONFIRMED;
        const reason = stopped === "THREW" ? "STOP_THREW" : stopped === "DONE" ? "NO_ROBOT_LEFT_EVENT" : "STOP_TIMED_OUT";
        return Object.freeze({ kind: "UNCONFIRMED", reason, robotId: transcriberRobotId, taskId });
      } finally {
        onRobotLeft = null;
      }
    }

    const startUnresolved = (): VoiceProviderStop => Object.freeze({ kind: "UNCONFIRMED", reason: "START_UNRESOLVED", robotId: null, taskId: anyTaskId() });

    /** After the bounded release: a start still in flight is followed until it settles (only while the page is open; see the header). */
    function followLateStart(client: TrtcClientSurface, settling: Promise<StartSettled>): void {
      void settling.then((settled) => {
        if (settled.kind === "NO_ROBOT") {
          if (settled.definitive) dropMarker(markerId);
          return;
        }
        const taskId = readTaskId(settled.robotId);
        setMarker(markerId, "STOP_UNCONFIRMED", settled.robotId, taskId);
        console.warn(`[voice] provider start resolved after cleanup; robotId=${maskRobot(settled.robotId)}; taskId=${taskId ?? "unknown"}`);
        if (!destroyCalled) {
          const transcriberRobotId = settled.robotId;
          void Promise.resolve()
            .then(() => client.stopPlugin(TRTC_TRANSCRIBER_PLUGIN, { transcriberRobotId }))
            .catch(() => undefined);
        }
      });
    }

    /** The provider phase: one budget for the in-flight start wait, the stop and the robot-left observation. */
    async function providerPhase(client: TrtcClientSurface): Promise<VoiceProviderStop> {
      const settling = pluginStart;
      if (settling === null) return NOT_STARTED;
      let budgetHandle: unknown = null;
      const budgetEnded = new Promise<"BUDGET_ENDED">((resolve) => {
        budgetHandle = timers.setTimeout(() => resolve("BUDGET_ENDED"), providerBudgetMs);
      });
      try {
        const settled = await Promise.race([settling, budgetEnded]);
        if (settled === "BUDGET_ENDED") {
          followLateStart(client, settling);
          return startUnresolved();
        }
        if (settled.kind === "NO_ROBOT") return settled.definitive ? NOT_STARTED : startUnresolved();
        robotId = settled.robotId;
        return await stopProvider(client, settled.robotId, budgetEnded);
      } finally {
        if (budgetHandle !== null) timers.clearTimeout(budgetHandle);
      }
    }

    async function releaseAll(): Promise<VoiceReleaseReport> {
      listening = false;
      const client = trtc;
      let microphoneReleased = true;
      let providerStop = NOT_STARTED;
      if (client) {
        // The microphone first: it is released whatever happens with the provider, never waiting for an in-flight start.
        if (audioAttempted) microphoneReleased = await step(() => client.stopLocalAudio());
        providerStop = await providerPhase(client);
        // Review M7: destroy only after the room exit finished (a hanging or failed exit leaves the client to the SDK's own cleanup).
        const exited = enterAttempted ? await step(() => client.exitRoom()) : true;
        if (exited) {
          destroyCalled = true;
          await step(() => client.destroy());
        }
        await step(() => client.off(TRTC_EVENT_NAMES.message, onMessage));
        await step(() => client.off(TRTC_EVENT_NAMES.stateChanged, onState));
        await step(() => client.off(TRTC_EVENT_NAMES.error, onError));
      }
      forwarding = false;
      if (providerStop.kind === "UNCONFIRMED") {
        keepRecoveryEntry(providerStop.robotId, providerStop.taskId);
        setMarker(markerId, "STOP_UNCONFIRMED", providerStop.robotId, providerStop.taskId);
        warnUnconfirmed(providerStop);
      } else {
        try {
          openStorage(storage)?.removeItem(storageKey);
        } catch {
          // Storage may be unavailable (private mode); nothing else to clean.
        }
        dropMarker(markerId);
      }
      return Object.freeze({ microphoneReleased, providerStop });
    }
    function warnUnconfirmed(stop: UnconfirmedStop): void {
      console.warn(`[voice] provider stop unconfirmed (${stop.reason}); robotId=${maskRobot(stop.robotId)}; taskId=${stop.taskId ?? "unknown"}`);
    }
    const release = (cancel: boolean): Promise<VoiceReleaseReport> => {
      if (cancel) forwarding = false;
      return (releasing ??= releaseAll());
    };
    const failedAfterRelease = async (reason: VoiceStartFailureReason): Promise<VoiceStartResult> => failedWith((await release(true)).providerStop, reason);

    try {
      sdk.TRTC.setLogLevel(TRTC_LOG_LEVEL_ERROR, false);
      const client = sdk.TRTC.create({ plugins: [sdk.RealtimeTranscriber] });
      trtc = client;
      client.on(TRTC_EVENT_NAMES.message, onMessage);
      client.on(TRTC_EVENT_NAMES.stateChanged, onState);
      client.on(TRTC_EVENT_NAMES.error, onError);
      enterAttempted = true;
      await untilAborted(client.enterRoom({ sdkAppId: credential.sdkAppId, userId: credential.userId, userSig: credential.userSig, strRoomId: credential.roomId, scene: TRTC_SCENE_RTC }));
      if (signal.aborted) return await failedAfterRelease("PROVIDER_FAILURE");
      audioAttempted = true;
      await untilAborted(client.startLocalAudio());
      if (signal.aborted) return await failedAfterRelease("PROVIDER_FAILURE");
      // Write-ahead: the marker is recorded BEFORE the provider task might be created; no record, no start.
      if (!setMarker(markerId, "START_REQUESTED", null, null)) return await failedAfterRelease("PROVIDER_FAILURE");
      let call: Promise<unknown>;
      try {
        call = Promise.resolve(client.startPlugin(TRTC_TRANSCRIBER_PLUGIN, { sourceLanguage: SOURCE_LANGUAGE[request.language], userIdsToTranscribe: [credential.userId] }));
      } catch (error) {
        call = Promise.reject(error);
      }
      const settling: Promise<StartSettled> = call.then(
        (robot) => Object.freeze(typeof robot === "string" && robot.length > 0 ? { kind: "ROBOT", robotId: robot } : { kind: "NO_ROBOT", definitive: false, error: undefined }),
        (error: unknown) => Object.freeze({ kind: "NO_ROBOT", definitive: isDefinitiveStartRejection(error), error }),
      );
      pluginStart = settling;
      const settled = await untilAborted(settling);
      if (settled.kind === "NO_ROBOT") return await failedAfterRelease(settled.error === undefined ? "PROVIDER_FAILURE" : startFailureReason(settled.error));
      robotId = settled.robotId;
      setMarker(markerId, "STARTED", robotId, readTaskId(robotId));
      if (signal.aborted) return await failedAfterRelease("PROVIDER_FAILURE");
    } catch (error) {
      return await failedAfterRelease(startFailureReason(error));
    }

    listening = true;
    const session = Object.freeze({ stop: () => release(false), cancel: () => release(true) });
    return Object.freeze({ kind: "STARTED", session, maxSessionSeconds: credential.maxSessionSeconds });
  }

  return Object.freeze({ start });
}
