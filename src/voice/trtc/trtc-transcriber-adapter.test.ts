// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { voiceDisclosureReducer, VOICE_DISCLOSURE_INITIAL_STATE, type VoiceDisclosureGrant } from "@/application/voice/voice-cloud-disclosure";
import { createVoiceSessionController } from "@/application/voice/voice-session-controller";
import { loadTrtcTranscriber } from "@/components/jagaon/voice/load-trtc-transcriber";
import type { VoiceSegment, VoiceSessionFailureReason, VoiceStartResult } from "@/application/voice/voice-transcriber-port";
import type { TrtcClientSurface, TrtcEventMap, TrtcPluginSurface, TrtcSdkModules } from "./trtc-sdk-surface";
import {
  clearUnconfirmedProviderTasks,
  createTrtcTranscriberAdapter,
  createVoiceRecoveryHelper,
  installVoiceRecoveryHelper,
  isDefinitiveStartRejection,
  JAGAON_PROVIDER_START_LOCK,
  JAGAON_PROVIDER_TASK_CLEARANCES_KEY,
  JAGAON_PROVIDER_TASK_MARKERS_KEY,
  readUnconfirmedProviderTasks,
  VOICE_RECOVERY_GLOBAL,
  type ProviderTaskMarker,
  type TrtcAdapterLocks,
  type TrtcAdapterStorage,
  type TrtcAdapterTimers,
  type TrtcCredentialRequest,
} from "./trtc-transcriber-adapter";

const USER = "jv_user-1";
const ROBOT = "robot-1";
const TASK = "task-1";
const STORAGE_KEY = `TRTC_RT_${USER}`;
const MARKERS_KEY = JAGAON_PROVIDER_TASK_MARKERS_KEY;
const EPOCH = 1_760_000_000_000;
const CREDENTIAL = Object.freeze({ sdkAppId: 1400000001, userId: USER, userSig: "TEST-ONLY-usersig", roomId: "jr_room-1", maxSessionSeconds: 90 });

type Hangable = "stopPlugin" | "startLocalAudio" | "stopLocalAudio" | "exitRoom";
type Emit = <K extends keyof TrtcEventMap>(event: K, payload: TrtcEventMap[K]) => void;
type FakeOptions = Partial<Record<"enterRoom" | "startLocalAudio" | "startPlugin" | "stopPlugin" | "stopLocalAudio" | "exitRoom" | "destroy", unknown>> & {
  supported?: boolean;
  hang?: Hangable | readonly Hangable[];
  /** The robot id `startPlugin` resolves (default ROBOT). */
  robot?: string;
  /** Like the server: push the robot-left event after a stop resolves (default true). */
  robotLeftOnStop?: boolean;
  /** Runs synchronously inside the call, before it settles. */
  during?: Partial<Record<"startPlugin" | "stopPlugin", (emit: Emit) => void>>;
  /** `startPlugin` stays in flight until the test settles it through `startControl`. */
  deferStart?: boolean;
  /** `exitRoom` stays in flight until the test settles it through `exitControl`. */
  deferExit?: boolean;
  /** Runs when `startPlugin` delivers its robot id (after the plugin wrote its entry). */
  afterStartResolved?: () => void;
};

/** Like the pinned plugin: `startPlugin` writes `{ [robotId]: { taskId, options } }`; `stopPlugin` clears the entry in its `finally`. */
type PluginStorage = { items: Map<string, string> };

function fakeSdk(options: FakeOptions = {}, pluginStorage?: PluginStorage) {
  const calls: string[] = [];
  const handlers = new Map<string, Set<(event: never) => void>>();
  const recorded: { enter?: unknown; start?: unknown; stop?: unknown; stateListenersAtStop?: number; markersAtStartPlugin?: string | null } = {};
  const startControl: { resolve: (robot?: string) => void; reject: (error: unknown) => void } = { resolve: () => undefined, reject: () => undefined };
  const exitControl: { resolve: () => void } = { resolve: () => undefined };
  const hangs = new Set<string>([options.hang ?? []].flat());
  const robot = options.robot ?? ROBOT;
  const step = (name: keyof FakeOptions, result?: unknown) => {
    calls.push(name);
    if (hangs.has(name)) return new Promise<never>(() => undefined);
    if (options[name] !== undefined) return Promise.reject(options[name]);
    return Promise.resolve(result);
  };
  const emit: Emit = (event, payload) => {
    for (const handler of [...(handlers.get(event) ?? [])]) (handler as (value: typeof payload) => void)(payload);
  };
  const client: TrtcClientSurface = {
    enterRoom: (params) => ((recorded.enter = params), step("enterRoom")) as Promise<void>,
    startLocalAudio: () => step("startLocalAudio") as Promise<void>,
    stopLocalAudio: () => step("stopLocalAudio") as Promise<void>,
    exitRoom: () => {
      if (!options.deferExit) return step("exitRoom") as Promise<void>;
      calls.push("exitRoom");
      return new Promise<void>((resolve) => (exitControl.resolve = resolve));
    },
    destroy: () => {
      calls.push("destroy");
      if (options.destroy !== undefined) throw options.destroy;
    },
    startPlugin: (plugin, startOptions) => {
      recorded.start = { plugin, ...startOptions };
      recorded.markersAtStartPlugin = pluginStorage?.items.get(MARKERS_KEY) ?? null;
      let started: Promise<unknown>;
      if (options.deferStart) {
        calls.push("startPlugin");
        started = new Promise((resolve, reject) => {
          startControl.resolve = (value = robot) => resolve(value);
          startControl.reject = reject;
        });
      } else {
        started = step("startPlugin", robot);
      }
      options.during?.startPlugin?.(emit);
      return started.then((value) => {
        if (typeof value === "string" && value.length > 0) pluginStorage?.items.set(STORAGE_KEY, JSON.stringify({ [value]: { taskId: TASK, options: startOptions } }));
        options.afterStartResolved?.();
        return value;
      });
    },
    stopPlugin: (plugin, stopOptions) => {
      recorded.stop = { plugin, ...stopOptions };
      recorded.stateListenersAtStop = handlers.get("realtime-transcriber-state-changed")?.size ?? 0;
      const stopping = step("stopPlugin");
      options.during?.stopPlugin?.(emit);
      const cleared = stopping.finally(() => pluginStorage?.items.delete(STORAGE_KEY));
      if (options.robotLeftOnStop !== false) void cleared.then(() => emit("realtime-transcriber-state-changed", { state: "stopped", transcriberRobotId: stopOptions.transcriberRobotId }), () => undefined);
      return cleared;
    },
    on: (event, handler) => {
      calls.push(`on:${event}`);
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler as (event: never) => void);
    },
    off: (event, handler) => {
      calls.push(`off:${event}`);
      handlers.get(event)?.delete(handler as (event: never) => void);
    },
  };
  const plugin = class FakeRealtimeTranscriber {} as unknown as TrtcPluginSurface;
  const modules: TrtcSdkModules = {
    TRTC: {
      isSupported: async () => (calls.push("isSupported"), { result: options.supported ?? true }),
      setLogLevel: (level, upload) => void calls.push(`setLogLevel:${level}:${upload}`),
      create: (createOptions) => {
        calls.push(`create:${createOptions.plugins.length}:${createOptions.plugins[0] === plugin}`);
        return client;
      },
    },
    RealtimeTranscriber: plugin,
  };
  const listeners = () => [...handlers.values()].reduce((total, set) => total + set.size, 0);
  return { modules, calls, recorded, emit, listeners, startControl, exitControl };
}

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    removed: [] as string[],
    written: [] as string[],
    items,
    getItem(key: string) {
      return items.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      this.written.push(key);
      items.set(key, value);
    },
    removeItem(key: string) {
      this.removed.push(key);
      items.delete(key);
    },
  };
}

/** A manual clock for the adapter's injected timers: no real waiting; `advance` fires due timers in order. */
function manualClock() {
  let now = 0;
  let next = 1;
  const pending = new Map<number, { at: number; callback: () => void }>();
  const timers: TrtcAdapterTimers = {
    setTimeout: (callback, ms) => (pending.set(next, { at: now + ms, callback }), next++),
    clearTimeout: (handle) => void pending.delete(handle as number),
  };
  const flush = async () => {
    for (let round = 0; round < 3; round++) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return {
    timers,
    flush,
    now: () => now,
    async advance(ms: number) {
      const end = now + ms;
      await flush();
      for (;;) {
        const due = [...pending].filter(([, entry]) => entry.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].callback();
        await flush();
      }
      now = end;
      await flush();
    },
  };
}

const grant = (): VoiceDisclosureGrant => {
  const accepted = voiceDisclosureReducer(voiceDisclosureReducer(VOICE_DISCLOSURE_INITIAL_STATE, { type: "REQUEST_START", language: "en" }), { type: "ACCEPT" });
  if (accepted.kind !== "GRANTED") throw new Error("no grant");
  return accepted.grant;
};

/** A same-origin Web Locks stand-in shared by simulated tabs (`ifAvailable`: a held lock answers null). */
function fakeLocks() {
  const held = new Set<string>();
  const locks: TrtcAdapterLocks = {
    request: (name, _options, callback) => {
      if (held.has(name)) return Promise.resolve(callback(null));
      held.add(name);
      return Promise.resolve(callback({ name })).finally(() => held.delete(name));
    },
  };
  return { locks, held };
}

type MemoryStorage = ReturnType<typeof memoryStorage>;
type SetupExtras = { storage?: MemoryStorage; storageFactory?: () => TrtcAdapterStorage | null; locks?: TrtcAdapterLocks | null; clock?: ReturnType<typeof manualClock> };

/** The adapter runs on the manual clock with its real defaults (5 s steps, 10 s provider phase), Web Locks by default. */
function setup(options: FakeOptions = {}, credential: TrtcCredentialRequest = async () => ({ kind: "ISSUED", credential: CREDENTIAL }), extras: SetupExtras = {}) {
  const storage = extras.storage ?? memoryStorage({ unrelated: "keep" });
  const sdk = fakeSdk(options, storage);
  const clock = extras.clock ?? manualClock();
  const requestCredential = vi.fn(credential);
  const locks = extras.locks === undefined ? fakeLocks().locks : extras.locks;
  const adapter = createTrtcTranscriberAdapter({ requestCredential, loadSdk: async () => sdk.modules, storage: extras.storageFactory ?? (() => storage), timers: clock.timers, locks: () => locks, now: () => EPOCH + clock.now() });
  const segments: VoiceSegment[] = [];
  const failures: VoiceSessionFailureReason[] = [];
  const abort = new AbortController();
  const start = (language: "en" | "zh" = "en") => adapter.start({ language, grant: grant(), onSegment: (segment) => segments.push(segment), onFailure: (reason) => failures.push(reason), signal: abort.signal });
  return { sdk, storage, clock, requestCredential, adapter, segments, failures, abort, start };
}

/** The JagaOn provider-task markers in a memory storage. */
function markersIn(storage: MemoryStorage): ProviderTaskMarker[] {
  const raw = storage.items.get(MARKERS_KEY);
  return raw === undefined ? [] : (JSON.parse(raw) as ProviderTaskMarker[]);
}
const markerShape = (marker: ProviderTaskMarker) => ({ state: marker.state, robotId: marker.robotId, taskId: marker.taskId });

/** Settles a release on the manual clock, recording when (clock ms) it resolved. */
async function settle<T>(clock: ReturnType<typeof manualClock>, pending: Promise<T>, budgetMs = 60_000): Promise<{ value: T; at: number }> {
  let done: { value: T; at: number } | null = null;
  void pending.then((value) => (done = { value, at: clock.now() }));
  await clock.flush();
  for (let elapsed = 0; done === null && elapsed < budgetMs; elapsed += 1_000) await clock.advance(1_000);
  if (done === null) throw new Error("release did not settle");
  return done;
}

const message = (overrides: Partial<TrtcEventMap["realtime-transcriber-message"]> = {}) => ({ segmentId: "s1", speakerUserId: USER, sourceText: "Sugar 6.8 mmol", isCompleted: true, robotId: ROBOT, translationTexts: [{ language: "zh", text: "translated" }], timestamp: 1, ...overrides });

let consoleSpies: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => {
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
});
/** Returns the console.warn lines so far and clears them (the afterEach check proves nothing else was logged). */
function takeWarnings(): string[] {
  const warn = consoleSpies[2];
  const lines = warn.mock.calls.map((args) => args.join(" "));
  warn.mockClear();
  return lines;
}
afterEach(() => {
  for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

const started = (result: VoiceStartResult) => {
  if (result.kind !== "STARTED") throw new Error(`expected STARTED, got ${JSON.stringify(result)}`);
  return result;
};

describe("TRTC transcriber adapter (fake SDK)", () => {
  it("starts in order: support check, credential, log level (upload off) BEFORE create, enter, microphone, plugin", async () => {
    const { sdk, start, requestCredential } = setup();
    const result = started(await start("zh"));
    expect(result.maxSessionSeconds).toBe(90);
    expect(requestCredential).toHaveBeenCalledTimes(1);
    expect(sdk.calls).toEqual([
      "isSupported",
      "setLogLevel:4:false",
      "create:1:true",
      "on:realtime-transcriber-message",
      "on:realtime-transcriber-state-changed",
      "on:error",
      "enterRoom",
      "startLocalAudio",
      "startPlugin",
    ]);
    expect(sdk.recorded.enter).toEqual({ sdkAppId: 1400000001, userId: USER, userSig: "TEST-ONLY-usersig", strRoomId: "jr_room-1", scene: "rtc" });
    // Audio only, one language, our own user only; never translation, cloud recording or diarization.
    expect(sdk.recorded.start).toEqual({ plugin: "RealtimeTranscriber", sourceLanguage: "zh", userIdsToTranscribe: [USER] });
    expect(Object.keys(sdk.recorded.start as object)).not.toEqual(expect.arrayContaining(["translationLanguages"]));
    for (const forbidden of ["translationLanguages", "enableCloudRecording", "enableSpeakerDiarization"]) expect(sdk.recorded.start, forbidden).not.toHaveProperty(forbidden);
  });

  it("stops in order (stopLocalAudio → stopPlugin → exitRoom → destroy), confirms on the robot-left event, removes listeners and the plugin's storage key", async () => {
    const { sdk, start, storage } = setup();
    const result = started(await start());
    expect(JSON.parse(storage.items.get(STORAGE_KEY)!)).toMatchObject({ [ROBOT]: { taskId: TASK } });
    expect(markersIn(storage).map(markerShape)).toEqual([{ state: "STARTED", robotId: ROBOT, taskId: TASK }]);
    sdk.calls.length = 0;
    const report = await result.session.stop();
    expect(report).toEqual({ microphoneReleased: true, providerStop: { kind: "CONFIRMED" } });
    // The microphone is released first, before any provider stop.
    expect(sdk.calls).toEqual(["stopLocalAudio", "stopPlugin", "exitRoom", "destroy", "off:realtime-transcriber-message", "off:realtime-transcriber-state-changed", "off:error"]);
    // The robot-left observer (the state listener, attached at create) was active when the stop was sent.
    expect(sdk.recorded.stateListenersAtStop).toBe(1);
    expect(sdk.recorded.stop).toEqual({ plugin: "RealtimeTranscriber", transcriberRobotId: ROBOT });
    expect(sdk.listeners()).toBe(0);
    // CONFIRMED: the plugin's entry and our marker are removed.
    expect(storage.removed).toEqual([STORAGE_KEY, MARKERS_KEY]);
    expect([...storage.items.keys()]).toEqual(["unrelated"]);
    // Idempotent: a later cancel or stop returns the same report and does not release or stop again.
    expect(await result.session.cancel()).toBe(report);
    expect(await result.session.stop()).toBe(report);
    expect(sdk.calls.filter((call) => call === "stopLocalAudio")).toHaveLength(1);
    expect(sdk.calls.filter((call) => call === "stopPlugin")).toHaveLength(1);
  });

  it("a throwing stopPlugin still releases the microphone and the room (UNCONFIRMED STOP_THREW, never \"rejected\")", async () => {
    const { sdk, start, clock } = setup({ stopPlugin: Object.assign(new Error("TEST-ONLY provider detail"), { code: 5400 }) });
    const result = started(await start());
    const { value, at } = await settle(clock, result.session.cancel());
    expect(value).toEqual({ microphoneReleased: true, providerStop: { kind: "UNCONFIRMED", reason: "STOP_THREW", robotId: ROBOT, taskId: TASK } });
    expect(at).toBe(10_000);
    expect(sdk.calls.slice(-7)).toEqual(["stopLocalAudio", "stopPlugin", "exitRoom", "destroy", "off:realtime-transcriber-message", "off:realtime-transcriber-state-changed", "off:error"]);
    expect(takeWarnings()).toEqual([`[voice] provider stop unconfirmed (STOP_THREW); robotId=${ROBOT}; taskId=${TASK}`]);
  });

  it("a hanging stopPlugin is bounded by the step timeout and the microphone is still released", async () => {
    const { sdk, start, clock } = setup({ hang: "stopPlugin" });
    const result = started(await start());
    const { value } = await settle(clock, result.session.stop());
    expect(value).toEqual({ microphoneReleased: true, providerStop: { kind: "UNCONFIRMED", reason: "STOP_TIMED_OUT", robotId: ROBOT, taskId: TASK } });
    expect(sdk.calls.indexOf("stopLocalAudio")).toBeLessThan(sdk.calls.indexOf("stopPlugin"));
    expect(takeWarnings()).toHaveLength(1);
  });

  it("reports honestly when stopLocalAudio fails, and still stops the provider, exits and destroys", async () => {
    const { sdk, start } = setup({ stopLocalAudio: new Error("TEST-ONLY") });
    const result = started(await start());
    expect(await result.session.stop()).toEqual({ microphoneReleased: false, providerStop: { kind: "CONFIRMED" } });
    expect(sdk.calls.slice(-7)).toEqual(["stopLocalAudio", "stopPlugin", "exitRoom", "destroy", "off:realtime-transcriber-message", "off:realtime-transcriber-state-changed", "off:error"]);
  });

  it("review M1: an abort while a start step hangs (an open permission prompt) resolves at once and releases the microphone", async () => {
    const { sdk, start, abort } = setup({ hang: "startLocalAudio" });
    const pending = start();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(sdk.calls).toContain("startLocalAudio");
    abort.abort();
    expect((await pending).kind).toBe("FAILED");
    expect(sdk.calls.slice(sdk.calls.indexOf("startLocalAudio") + 1)).toEqual(["stopLocalAudio", "exitRoom", "destroy", "off:realtime-transcriber-message", "off:realtime-transcriber-state-changed", "off:error"]);
    expect(sdk.calls).not.toContain("startPlugin");
  });

  it("review M7: destroy only after the room exit finished", async () => {
    const { sdk, start } = setup({ exitRoom: new Error("TEST-ONLY exit failed") });
    const result = started(await start());
    expect(await result.session.stop()).toEqual({ microphoneReleased: true, providerStop: { kind: "CONFIRMED" } });
    expect(sdk.calls).toContain("exitRoom");
    expect(sdk.calls).not.toContain("destroy");
  });

  it("an unsupported browser creates nothing and requests no credential", async () => {
    const { sdk, start, requestCredential } = setup({ supported: false });
    expect(await start()).toEqual({ kind: "FAILED", reason: "UNSUPPORTED_BROWSER", providerStop: { kind: "NOT_STARTED" } });
    expect(sdk.calls).toEqual(["isSupported"]);
    expect(requestCredential).not.toHaveBeenCalled();
  });

  it("a refused or failed credential creates nothing", async () => {
    const refused = setup({}, async () => ({ kind: "REFUSED", reason: "ACCESS_DENIED" }));
    expect(await refused.start()).toEqual({ kind: "FAILED", reason: "CREDENTIAL_REFUSED", credentialRefusal: "ACCESS_DENIED", providerStop: { kind: "NOT_STARTED" } });
    expect(refused.sdk.calls).toEqual(["isSupported"]);
    const failed = setup({}, async () => ({ kind: "FAILED", reason: "NETWORK_FAILURE" }));
    expect(await failed.start()).toEqual({ kind: "FAILED", reason: "NETWORK_FAILURE", providerStop: { kind: "NOT_STARTED" } });
    const thrown = setup({}, async () => {
      throw new Error("TEST-ONLY");
    });
    expect(await thrown.start()).toEqual({ kind: "FAILED", reason: "NETWORK_FAILURE", providerStop: { kind: "NOT_STARTED" } });
  });

  it("permission denied runs the full release and returns only the closed reason", async () => {
    for (const error of [Object.assign(new Error("NotAllowedError, TEST-ONLY detail"), { name: "RtcError", code: 5300, extraCode: 5302 }), Object.assign(new Error("TEST-ONLY"), { name: "NotAllowedError" })]) {
      const { sdk, start, storage } = setup({ startLocalAudio: error });
      const result = await start();
      expect(result).toEqual({ kind: "FAILED", reason: "PERMISSION_DENIED", providerStop: { kind: "NOT_STARTED" } });
      expect(JSON.stringify(result)).not.toContain("TEST-ONLY");
      expect(sdk.calls.slice(sdk.calls.indexOf("startLocalAudio") + 1)).toEqual(["stopLocalAudio", "exitRoom", "destroy", "off:realtime-transcriber-message", "off:realtime-transcriber-state-changed", "off:error"]);
      expect(sdk.listeners()).toBe(0);
      expect(storage.removed).toEqual([STORAGE_KEY]);
    }
  });

  it("maps the concurrency limit (5400/5001), environment and other errors to closed reasons; only a pre-send start rejection is NOT_STARTED", async () => {
    const unresolved = { kind: "UNCONFIRMED", reason: "START_UNRESOLVED", robotId: null, taskId: null };
    const cases: Array<[FakeOptions, string, object]> = [
      // The server answered start_cloud_transcription with an error: not definitive evidence that no task exists.
      [{ startPlugin: Object.assign(new Error("TEST-ONLY"), { code: 5400, extraCode: 5001 }) }, "CONCURRENCY_LIMIT", unresolved],
      [{ enterRoom: Object.assign(new Error("TEST-ONLY"), { code: 5200 }) }, "UNSUPPORTED_BROWSER", { kind: "NOT_STARTED" }],
      [{ enterRoom: Object.assign(new Error("TEST-ONLY"), { code: 5400, extraCode: -1 }) }, "NETWORK_FAILURE", { kind: "NOT_STARTED" }],
      // 5100 "not join": rejected before any signalling request.
      [{ startPlugin: Object.assign(new Error("TEST-ONLY"), { code: 5100 }) }, "PROVIDER_FAILURE", { kind: "NOT_STARTED" }],
      [{ startPlugin: "not an error" }, "PROVIDER_FAILURE", unresolved],
    ];
    for (const [options, reason, providerStop] of cases) {
      const { sdk, start } = setup(options);
      expect(await start(), reason).toEqual({ kind: "FAILED", reason, providerStop });
      expect(sdk.calls, reason).toContain("destroy");
      expect(sdk.calls, reason).not.toContain("stopPlugin");
      expect(takeWarnings(), reason).toEqual(providerStop === unresolved ? ["[voice] provider stop unconfirmed (START_UNRESOLVED); robotId=unknown; taskId=unknown"] : []);
    }
  });

  it("forwards only our robot's messages about our own speaker, FINAL on isCompleted, sourceText only", async () => {
    const { sdk, start, segments } = setup();
    started(await start());
    sdk.emit("realtime-transcriber-message", message({ isCompleted: false, sourceText: "Sugar" }));
    sdk.emit("realtime-transcriber-message", message());
    sdk.emit("realtime-transcriber-message", message({ robotId: "other-robot" }));
    sdk.emit("realtime-transcriber-message", message({ speakerUserId: "someone-else" }));
    sdk.emit("realtime-transcriber-message", { ...message(), sourceText: 42 } as never);
    expect(segments).toEqual([
      { kind: "INTERIM", segmentId: "s1", text: "Sugar" },
      { kind: "FINAL", segmentId: "s1", text: "Sugar 6.8 mmol" },
    ]);
  });

  it("drops late events after cancel; keeps finals during a stop until the release ends", async () => {
    const cancelled = setup({ hang: "stopPlugin" });
    const session = started(await cancelled.start()).session;
    const releasing = session.cancel();
    cancelled.sdk.emit("realtime-transcriber-message", message({ segmentId: "late" }));
    await settle(cancelled.clock, releasing);
    cancelled.sdk.emit("realtime-transcriber-message", message({ segmentId: "later" }));
    expect(cancelled.segments).toEqual([]);

    const stopped = setup({ hang: "stopPlugin" });
    const stopSession = started(await stopped.start()).session;
    const stopping = stopSession.stop();
    stopped.sdk.emit("realtime-transcriber-message", message({ segmentId: "final-during-stop" }));
    await settle(stopped.clock, stopping);
    expect(stopped.segments.map((segment) => segment.segmentId)).toEqual(["final-during-stop"]);
    expect(takeWarnings()).toHaveLength(2);
  });

  it("reports an unexpected robot stop or an SDK error while listening as a closed failure", async () => {
    const robot = setup();
    started(await robot.start());
    robot.sdk.emit("realtime-transcriber-state-changed", { state: "stopped", transcriberRobotId: "other-robot" });
    expect(robot.failures).toEqual([]);
    robot.sdk.emit("realtime-transcriber-state-changed", { state: "stopped", transcriberRobotId: ROBOT, error: 1 });
    expect(robot.failures).toEqual(["PROVIDER_FAILURE"]);
    const errored = setup();
    started(await errored.start());
    errored.sdk.emit("error", { name: "RtcError", code: 5500 });
    expect(errored.failures).toEqual(["NETWORK_FAILURE"]);
  });

  it("an abort while starting releases what was acquired and does not start the plugin", async () => {
    const { sdk, abort, adapter } = setup();
    const result = adapter.start({
      language: "en",
      grant: grant(),
      onSegment: () => undefined,
      onFailure: () => undefined,
      signal: abort.signal,
    });
    abort.abort();
    expect((await result).kind).toBe("FAILED");
    expect(sdk.calls).not.toContain("startPlugin");
  });

  it("an abort after enterRoom releases the room before resolving", async () => {
    const sdk = fakeSdk();
    const abort = new AbortController();
    const client = sdk.modules.TRTC.create;
    const modules: TrtcSdkModules = {
      ...sdk.modules,
      TRTC: {
        ...sdk.modules.TRTC,
        create: (options) => {
          const instance = client(options);
          const enter = instance.enterRoom.bind(instance);
          return { ...instance, enterRoom: async (params) => (await enter(params), abort.abort()) };
        },
      },
    };
    const storage = memoryStorage();
    const adapter = createTrtcTranscriberAdapter({ requestCredential: async () => ({ kind: "ISSUED", credential: CREDENTIAL }), loadSdk: async () => modules, storage: () => storage, locks: () => null, timers: { setTimeout, clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) }, stepTimeoutMs: 50 });
    const result = await adapter.start({ language: "en", grant: grant(), onSegment: () => undefined, onFailure: () => undefined, signal: abort.signal });
    expect(result.kind).toBe("FAILED");
    expect(sdk.calls).not.toContain("startLocalAudio");
    expect(sdk.calls.slice(-3)).toEqual(["off:realtime-transcriber-message", "off:realtime-transcriber-state-changed", "off:error"]);
    expect(sdk.calls).toEqual(expect.arrayContaining(["exitRoom", "destroy"]));
    // Without Web Locks the START_PENDING claim was written at once; nothing reached startPlugin, so it is dropped.
    expect(storage.items.has(MARKERS_KEY)).toBe(false);
  });

  it("a failing SDK load is a closed failure", async () => {
    const storage = memoryStorage();
    const adapter = createTrtcTranscriberAdapter({ requestCredential: async () => ({ kind: "ISSUED", credential: CREDENTIAL }), loadSdk: async () => { throw new Error("TEST-ONLY chunk"); }, storage: () => storage, locks: () => null });
    expect(await adapter.start({ language: "en", grant: grant(), onSegment: () => undefined, onFailure: () => undefined, signal: new AbortController().signal })).toEqual({ kind: "FAILED", reason: "PROVIDER_FAILURE", providerStop: { kind: "NOT_STARTED" } });
    expect(storage.items.has(MARKERS_KEY)).toBe(false);
  });

  it("loads the SDK only by dynamic import inside start (named plugin export), never statically", () => {
    const source = readFileSync(join(process.cwd(), "src/voice/trtc/trtc-transcriber-adapter.ts"), "utf8");
    expect(source).not.toMatch(/^import\s+(?!type\b)[^;]*["']trtc-sdk-v5/m);
    expect(source).toMatch(/await import\("trtc-sdk-v5"\)/);
    expect(source).toMatch(/const \{ RealtimeTranscriber \} = await import\("trtc-sdk-v5\/plugins\/realtime-transcriber"\)/);
    expect(source).not.toMatch(/tls-sig-api-v2|translationLanguages:|enableCloudRecording:|enableSpeakerDiarization:/);
    // Exactly two log calls in the code (comments aside): the unconfirmed provider-stop line and the late-start line.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code.match(/console\.[a-z]+/g)).toEqual(["console.warn", "console.warn"]);
    expect(source).toMatch(/console\.warn\(`\[voice\] provider stop unconfirmed \(\$\{stop\.reason\}\); robotId=\$\{maskRobot\(stop\.robotId\)\}; taskId=\$\{stop\.taskId \?\? "unknown"\}`\)/);
    expect(source).toMatch(/console\.warn\(`\[voice\] provider start resolved after cleanup; robotId=\$\{maskRobot\(settled\.robotId\)\}; taskId=\$\{taskId \?\? "unknown"\}`\)/);
  });
});

describe("TRTC transcriber adapter: provider-stop evidence (fake SDK, manual clock)", () => {
  const OFFS = ["off:realtime-transcriber-message", "off:realtime-transcriber-state-changed", "off:error"];
  const unconfirmed = (reason: string, taskId: string | null = TASK, robotId = ROBOT) => ({ kind: "UNCONFIRMED", reason, robotId, taskId });
  const stoppedEvent = (overrides: Partial<TrtcEventMap["realtime-transcriber-state-changed"]> = {}) => ({ state: "stopped" as const, transcriberRobotId: ROBOT, ...overrides });

  it("a robot-left event arriving during the stopPlugin call (before it resolves) confirms at once, without waiting for the budget", async () => {
    const { sdk, start, clock, storage } = setup({ hang: "stopPlugin", robotLeftOnStop: false, during: { stopPlugin: (emit) => emit("realtime-transcriber-state-changed", stoppedEvent()) } });
    const result = started(await start());
    const { value, at } = await settle(clock, result.session.stop());
    expect(value).toEqual({ microphoneReleased: true, providerStop: { kind: "CONFIRMED" } });
    expect(at).toBe(0);
    expect(sdk.calls.slice(-7)).toEqual(["stopLocalAudio", "stopPlugin", "exitRoom", "destroy", ...OFFS]);
    expect(storage.items.has(STORAGE_KEY)).toBe(false);
  });

  it("no robot-left event within 10 s: UNCONFIRMED NO_ROBOT_LEFT_EVENT, the room is exited only at the budget end, the entry is kept and one line is logged", async () => {
    const { sdk, start, clock, storage } = setup({ robotLeftOnStop: false });
    const result = started(await start());
    let report: unknown = null;
    void result.session.stop().then((value) => (report = value));
    await clock.advance(9_999);
    expect(report).toBeNull();
    expect(sdk.calls).toContain("stopPlugin");
    expect(sdk.calls).not.toContain("exitRoom");
    await clock.advance(1);
    expect(report).toEqual({ microphoneReleased: true, providerStop: unconfirmed("NO_ROBOT_LEFT_EVENT") });
    expect(sdk.calls.slice(-5)).toEqual(["exitRoom", "destroy", ...OFFS]);
    // The plugin's own stop cleared the entry in its `finally`; the adapter wrote back only this robot's task id.
    expect(storage.removed).toEqual([]);
    expect(JSON.parse(storage.items.get(STORAGE_KEY)!)).toEqual({ [ROBOT]: { taskId: TASK } });
    // The write-ahead marker stays, now STOP_UNCONFIRMED with the ids.
    expect(markersIn(storage).map(markerShape)).toEqual([{ state: "STOP_UNCONFIRMED", robotId: ROBOT, taskId: TASK }]);
    expect(takeWarnings()).toEqual([`[voice] provider stop unconfirmed (NO_ROBOT_LEFT_EVENT); robotId=${ROBOT}; taskId=${TASK}`]);
  });

  it("an entry still present (the stop never settled) is kept unchanged", async () => {
    const { start, clock, storage } = setup({ hang: "stopPlugin" });
    const result = started(await start());
    const before = storage.items.get(STORAGE_KEY);
    await settle(clock, result.session.stop());
    expect(storage.items.get(STORAGE_KEY)).toBe(before);
    expect(storage.written.filter((key) => key === STORAGE_KEY)).toEqual([]);
    expect(storage.removed).toEqual([]);
    takeWarnings();
  });

  it("events for another robot, with another state, or malformed are ignored and never count as evidence", async () => {
    const { start, clock, failures } = setup({
      robotLeftOnStop: false,
      during: {
        stopPlugin: (emit) => {
          emit("realtime-transcriber-state-changed", stoppedEvent({ transcriberRobotId: "other-robot" }));
          emit("realtime-transcriber-state-changed", stoppedEvent({ state: "started" }));
          for (const malformed of [null, undefined, "stopped", 42, {}, { state: "stopped" }, { transcriberRobotId: ROBOT }, { state: "STOPPED", transcriberRobotId: ROBOT }]) {
            emit("realtime-transcriber-state-changed", malformed as never);
          }
        },
      },
    });
    const result = started(await start());
    const { value, at } = await settle(clock, result.session.stop());
    expect(value).toEqual({ microphoneReleased: true, providerStop: unconfirmed("NO_ROBOT_LEFT_EVENT") });
    expect(at).toBe(10_000);
    expect(failures).toEqual([]);
    expect(takeWarnings()).toHaveLength(1);
  });

  it("a stale stopped event from before our robot started is ignored", async () => {
    const { start, clock, failures } = setup({ robotLeftOnStop: false, during: { startPlugin: (emit) => emit("realtime-transcriber-state-changed", stoppedEvent()) } });
    const result = started(await start());
    expect(failures).toEqual([]);
    const { value } = await settle(clock, result.session.stop());
    expect(value).toEqual({ microphoneReleased: true, providerStop: unconfirmed("NO_ROBOT_LEFT_EVENT") });
    expect(takeWarnings()).toHaveLength(1);
  });

  it("a matching robot-left event earlier in this session is still a session failure, and counts as evidence at release", async () => {
    const { sdk, start, clock, failures, storage } = setup({ robotLeftOnStop: false });
    const result = started(await start());
    sdk.emit("realtime-transcriber-state-changed", stoppedEvent());
    expect(failures).toEqual(["PROVIDER_FAILURE"]);
    const { value, at } = await settle(clock, result.session.cancel());
    expect(value).toEqual({ microphoneReleased: true, providerStop: { kind: "CONFIRMED" } });
    expect(at).toBe(0);
    // The stop is still sent (the plugin clears its own task), after the microphone.
    expect(sdk.calls.slice(-7)).toEqual(["stopLocalAudio", "stopPlugin", "exitRoom", "destroy", ...OFFS]);
    expect(storage.items.has(STORAGE_KEY)).toBe(false);
  });

  it("a throwing stopPlugin is CONFIRMED when the matching event still arrives within the budget", async () => {
    const { sdk, start, clock } = setup({ stopPlugin: Object.assign(new Error("TEST-ONLY"), { code: 5400 }) });
    const result = started(await start());
    let report: unknown = null;
    void result.session.stop().then((value) => (report = value));
    await clock.advance(3_000);
    expect(report).toBeNull();
    sdk.emit("realtime-transcriber-state-changed", stoppedEvent());
    await clock.flush();
    expect(report).toEqual({ microphoneReleased: true, providerStop: { kind: "CONFIRMED" } });
    expect(clock.now()).toBe(3_000);
  });

  it("a stopPlugin hanging past the 5 s step: STOP_TIMED_OUT, but observation continues to 10 s and an event at 7 s confirms", async () => {
    const late = setup({ hang: "stopPlugin" });
    const lateResult = started(await late.start());
    let lateReport: unknown = null;
    void lateResult.session.stop().then((value) => (lateReport = value));
    await late.clock.advance(5_000);
    // The stop step timed out at 5 s; the room is not exited while the observation continues.
    expect(late.sdk.calls).not.toContain("exitRoom");
    await late.clock.advance(2_000);
    late.sdk.emit("realtime-transcriber-state-changed", stoppedEvent());
    await late.clock.flush();
    expect(lateReport).toEqual({ microphoneReleased: true, providerStop: { kind: "CONFIRMED" } });
    expect(late.sdk.calls.slice(-5)).toEqual(["exitRoom", "destroy", ...OFFS]);

    const never = setup({ hang: "stopPlugin" });
    const neverResult = started(await never.start());
    const { value, at } = await settle(never.clock, neverResult.session.stop());
    expect(value).toEqual({ microphoneReleased: true, providerStop: unconfirmed("STOP_TIMED_OUT") });
    expect(at).toBe(10_000);
    expect(takeWarnings()).toEqual([`[voice] provider stop unconfirmed (STOP_TIMED_OUT); robotId=${ROBOT}; taskId=${TASK}`]);
  });

  it("total release stays bounded when every step hangs: 5 s microphone + 10 s observation + 5 s exit (no destroy after a failed exit)", async () => {
    const { sdk, start, clock } = setup({ hang: ["stopLocalAudio", "stopPlugin", "exitRoom"] });
    const result = started(await start());
    const { value, at } = await settle(clock, result.session.stop());
    expect(value).toEqual({ microphoneReleased: false, providerStop: unconfirmed("STOP_TIMED_OUT") });
    expect(at).toBe(20_000);
    expect(sdk.calls).not.toContain("destroy");
    expect(sdk.listeners()).toBe(0);
    takeWarnings();
  });

  it("stopLocalAudio failing: microphoneReleased false, and the provider stop still runs and is reported", async () => {
    const { start, clock } = setup({ stopLocalAudio: new Error("TEST-ONLY"), robotLeftOnStop: false });
    const result = started(await start());
    const { value } = await settle(clock, result.session.stop());
    expect(value).toEqual({ microphoneReleased: false, providerStop: unconfirmed("NO_ROBOT_LEFT_EVENT") });
    takeWarnings();
  });

  it("NOT_STARTED only when startPlugin was never called or rejected before sending: no stop, no line, entry and marker removed", async () => {
    for (const options of [{ startPlugin: Object.assign(new Error("TEST-ONLY"), { code: 5100 }) }, { startPlugin: Object.assign(new Error("TEST-ONLY"), { code: 5000, extraCode: 5001 }) }, { startLocalAudio: new Error("TEST-ONLY") }] as FakeOptions[]) {
      const { sdk, start, storage } = setup(options);
      expect(await start()).toMatchObject({ kind: "FAILED", providerStop: { kind: "NOT_STARTED" } });
      expect(sdk.calls).not.toContain("stopPlugin");
      expect(sdk.calls.slice(-6)).toEqual(["stopLocalAudio", "exitRoom", "destroy", ...OFFS]);
      expect(storage.items.has(STORAGE_KEY)).toBe(false);
      expect(storage.items.has(MARKERS_KEY)).toBe(false);
    }
  });

  it("an invalid startPlugin result is not proof of no task: START_UNRESOLVED, the marker is kept", async () => {
    const { start, storage } = setup({ robot: "" });
    expect(await start()).toEqual({ kind: "FAILED", reason: "PROVIDER_FAILURE", providerStop: { kind: "UNCONFIRMED", reason: "START_UNRESOLVED", robotId: null, taskId: null } });
    expect(markersIn(storage).map(markerShape)).toEqual([{ state: "STOP_UNCONFIRMED", robotId: null, taskId: null }]);
    expect(takeWarnings()).toEqual(["[voice] provider stop unconfirmed (START_UNRESOLVED); robotId=unknown; taskId=unknown"]);
  });

  it("the plugin's entry throwing or malformed: taskId null, no throw, the line says taskId=unknown", async () => {
    /** Our marker key works; the plugin's key throws (or holds a malformed value the fake plugin never overwrites). */
    const pluginKeyThrows = (): TrtcAdapterStorage => {
      const inner = memoryStorage();
      const guard = (key: string) => {
        if (key.startsWith("TRTC_RT_")) throw new Error("TEST-ONLY denied");
      };
      return { getItem: (key) => (guard(key), inner.getItem(key)), setItem: (key, value) => (guard(key), inner.setItem(key, value)), removeItem: (key) => (guard(key), inner.removeItem(key)) };
    };
    const malformed = (raw: string) => {
      const inner = memoryStorage({ [STORAGE_KEY]: raw });
      return (): TrtcAdapterStorage => ({ getItem: (key) => inner.getItem(key), setItem: (key, value) => (key === STORAGE_KEY ? undefined : inner.setItem(key, value)), removeItem: (key) => inner.removeItem(key) });
    };
    const throwing = pluginKeyThrows();
    const cases: Array<() => TrtcAdapterStorage | null> = [
      () => throwing,
      malformed("{not json"),
      malformed("[]"),
      malformed(JSON.stringify({ [ROBOT]: "task" })),
      malformed(JSON.stringify({ [ROBOT]: { taskId: 7 } })),
      malformed(JSON.stringify({ "other-robot": { taskId: TASK } })),
    ];
    for (const storageFactory of cases) {
      const { start, clock } = setup({ robotLeftOnStop: false }, undefined, { storageFactory });
      const result = started(await start());
      const { value } = await settle(clock, result.session.stop());
      expect(value).toEqual({ microphoneReleased: true, providerStop: unconfirmed("NO_ROBOT_LEFT_EVENT", null) });
      expect(takeWarnings()).toEqual([`[voice] provider stop unconfirmed (NO_ROBOT_LEFT_EVENT); robotId=${ROBOT}; taskId=unknown`]);
    }
  });

  it("the line never contains the userSig, sdkAppId, userId, room id or transcript text (the default robot id embeds room and user)", async () => {
    const robot = `transcriber_${CREDENTIAL.roomId}_robot_${USER}`;
    const { sdk, start, clock, storage } = setup({ robot, robotLeftOnStop: false });
    const result = started(await start());
    sdk.emit("realtime-transcriber-message", message({ robotId: robot }));
    const { value } = await settle(clock, result.session.stop());
    // The report and the kept entry keep the real ids (needed for recovery); only the log line is masked.
    expect(value).toEqual({ microphoneReleased: true, providerStop: unconfirmed("NO_ROBOT_LEFT_EVENT", TASK, robot) });
    expect(JSON.parse(storage.items.get(STORAGE_KEY)!)).toEqual({ [robot]: { taskId: TASK } });
    const lines = takeWarnings();
    expect(lines).toEqual([`[voice] provider stop unconfirmed (NO_ROBOT_LEFT_EVENT); robotId=transcriber_<room>_robot_<user>; taskId=${TASK}`]);
    for (const secret of [CREDENTIAL.userSig, String(CREDENTIAL.sdkAppId), USER, CREDENTIAL.roomId, "Sugar 6.8 mmol", "translated"]) expect(lines[0]).not.toContain(secret);
  });

  it("cancel shuts the provider down exactly as stop does", async () => {
    for (const options of [{}, { robotLeftOnStop: false }] as FakeOptions[]) {
      const viaStop = setup(options);
      const viaCancel = setup(options);
      const stopResult = started(await viaStop.start());
      const cancelResult = started(await viaCancel.start());
      viaStop.sdk.calls.length = 0;
      viaCancel.sdk.calls.length = 0;
      const stopped = await settle(viaStop.clock, stopResult.session.stop());
      const cancelled = await settle(viaCancel.clock, cancelResult.session.cancel());
      expect(cancelled).toEqual(stopped);
      expect(viaCancel.sdk.calls).toEqual(viaStop.sdk.calls);
      expect(viaCancel.storage.items.get(STORAGE_KEY)).toEqual(viaStop.storage.items.get(STORAGE_KEY));
      expect(markersIn(viaCancel.storage).map(markerShape)).toEqual(markersIn(viaStop.storage).map(markerShape));
      takeWarnings();
    }
  });

  it("idempotent when unconfirmed: a second stop or cancel returns the same report, sends nothing and logs nothing more", async () => {
    const { sdk, start, clock } = setup({ robotLeftOnStop: false });
    const result = started(await start());
    const first = result.session.stop();
    const concurrent = result.session.cancel();
    const { value } = await settle(clock, first);
    expect(await concurrent).toBe(value);
    expect(await result.session.stop()).toBe(value);
    expect(await result.session.cancel()).toBe(value);
    expect(sdk.calls.filter((call) => call === "stopPlugin")).toHaveLength(1);
    expect(sdk.calls.filter((call) => call === "exitRoom")).toHaveLength(1);
    expect(takeWarnings()).toHaveLength(1);
  });
});

describe("TRTC transcriber adapter: in-flight start, write-ahead marker and start guard (fake SDK, manual clock)", () => {
  const OFFS = ["off:realtime-transcriber-message", "off:realtime-transcriber-state-changed", "off:error"];
  const UNRESOLVED = { kind: "UNCONFIRMED", reason: "START_UNRESOLVED", robotId: null, taskId: null } as const;
  const UNRESOLVED_LINE = "[voice] provider stop unconfirmed (START_UNRESOLVED); robotId=unknown; taskId=unknown";
  const evidence = (taskId: string = TASK) => ({ kind: "PROVIDER_STATUS_STOPPED", taskId, checkedAt: EPOCH + 60_000, method: "DescribeAITranscription" }) as const;

  /** Starts with `startPlugin` in flight; resolves (wrapped, so it is not awaited) once the plugin start was sent. */
  async function startInFlight(context: ReturnType<typeof setup>): Promise<{ pending: Promise<VoiceStartResult> }> {
    const pending = context.start();
    await context.clock.flush();
    expect(context.sdk.calls).toContain("startPlugin");
    return { pending };
  }

  it("writes the START_REQUESTED marker before startPlugin, STARTED with the ids after, and removes it on CONFIRMED", async () => {
    const { sdk, start, storage } = setup();
    const result = started(await start());
    expect(JSON.parse(sdk.recorded.markersAtStartPlugin!).map(markerShape)).toEqual([{ state: "START_REQUESTED", robotId: null, taskId: null }]);
    const [marker] = markersIn(storage);
    expect(marker).toEqual({ markerId: expect.any(String), state: "STARTED", robotId: ROBOT, taskId: TASK, recordedAt: EPOCH });
    await result.session.stop();
    expect(storage.items.has(MARKERS_KEY)).toBe(false);
  });

  it("no record, no start: when the marker cannot be written, startPlugin is never called (NOT_STARTED)", async () => {
    const inner = memoryStorage();
    const storageFactory = (): TrtcAdapterStorage => ({
      getItem: (key) => inner.getItem(key),
      setItem: (key, value) => {
        if (key === MARKERS_KEY) throw new Error("TEST-ONLY quota");
        inner.setItem(key, value);
      },
      removeItem: (key) => inner.removeItem(key),
    });
    const { sdk, start } = setup({}, undefined, { storageFactory });
    expect(await start()).toEqual({ kind: "FAILED", reason: "PROVIDER_FAILURE", providerStop: { kind: "NOT_STARTED" } });
    expect(sdk.calls).not.toContain("startPlugin");
    expect(sdk.calls.slice(-6)).toEqual(["stopLocalAudio", "exitRoom", "destroy", ...OFFS]);
  });

  it("cancellation during startup: the microphone is released at once; a robot id within the budget is stopped and CONFIRMED", async () => {
    const context = setup({ deferStart: true });
    const { pending: pending } = await startInFlight(context);
    context.abort.abort();
    await context.clock.flush();
    // The microphone is released without waiting for the in-flight start.
    expect(context.sdk.calls.slice(-1)).toEqual(["stopLocalAudio"]);
    await context.clock.advance(3_000);
    context.sdk.startControl.resolve();
    const { value, at } = await settle(context.clock, pending);
    expect(value).toEqual({ kind: "FAILED", reason: "PROVIDER_FAILURE", providerStop: { kind: "CONFIRMED" } });
    expect(at).toBe(3_000);
    expect(context.sdk.calls.slice(-7)).toEqual(["stopLocalAudio", "stopPlugin", "exitRoom", "destroy", ...OFFS]);
    expect(context.storage.items.has(MARKERS_KEY)).toBe(false);
  });

  it("cancellation during startup: a robot id within the budget but no robot-left event is UNCONFIRMED by the same 10 s budget", async () => {
    const context = setup({ deferStart: true, robotLeftOnStop: false });
    const { pending: pending } = await startInFlight(context);
    context.abort.abort();
    await context.clock.advance(4_000);
    context.sdk.startControl.resolve();
    const { value, at } = await settle(context.clock, pending);
    expect(value).toEqual({ kind: "FAILED", reason: "PROVIDER_FAILURE", providerStop: { kind: "UNCONFIRMED", reason: "NO_ROBOT_LEFT_EVENT", robotId: ROBOT, taskId: TASK } });
    // One budget covers the start wait, the stop and the observation: 10 s from the provider phase, not 4 + 10.
    expect(at).toBe(10_000);
    expect(markersIn(context.storage).map(markerShape)).toEqual([{ state: "STOP_UNCONFIRMED", robotId: ROBOT, taskId: TASK }]);
    expect(takeWarnings()).toEqual([`[voice] provider stop unconfirmed (NO_ROBOT_LEFT_EVENT); robotId=${ROBOT}; taskId=${TASK}`]);
  });

  it("a never-settling start: START_UNRESOLVED (never NOT_STARTED) at the budget end; release bounded; the marker is kept", async () => {
    const context = setup({ deferStart: true });
    const { pending: pending } = await startInFlight(context);
    context.abort.abort();
    const { value, at } = await settle(context.clock, pending);
    expect(value).toEqual({ kind: "FAILED", reason: "PROVIDER_FAILURE", providerStop: UNRESOLVED });
    expect(at).toBe(10_000);
    expect(context.sdk.calls).not.toContain("stopPlugin");
    expect(context.sdk.calls.slice(-5)).toEqual(["exitRoom", "destroy", ...OFFS]);
    expect(markersIn(context.storage).map(markerShape)).toEqual([{ state: "STOP_UNCONFIRMED", robotId: null, taskId: null }]);
    expect(takeWarnings()).toEqual([UNRESOLVED_LINE]);
  });

  it("start success AFTER the budget: the late handler records the ids (no loss) and logs one masked line; no stop on a destroyed client", async () => {
    const robot = `transcriber_${CREDENTIAL.roomId}_robot_${USER}`;
    const context = setup({ deferStart: true, robot });
    const { pending: pending } = await startInFlight(context);
    context.abort.abort();
    await settle(context.clock, pending);
    expect(takeWarnings()).toEqual([UNRESOLVED_LINE]);
    await context.clock.advance(2_000);
    context.sdk.startControl.resolve();
    await context.clock.flush();
    expect(markersIn(context.storage).map(markerShape)).toEqual([{ state: "STOP_UNCONFIRMED", robotId: robot, taskId: TASK }]);
    expect(takeWarnings()).toEqual([`[voice] provider start resolved after cleanup; robotId=transcriber_<room>_robot_<user>; taskId=${TASK}`]);
    expect(context.sdk.calls.filter((call) => call === "stopPlugin")).toEqual([]);
  });

  it("re-review I-1: a late start resolving during exitRoom keeps its robotId and taskId in the marker after the release ends", async () => {
    const context = setup({ deferStart: true, deferExit: true });
    const { pending } = await startInFlight(context);
    context.abort.abort();
    await context.clock.advance(10_000);
    // The budget ended: START_UNRESOLVED was decided and the room exit is in flight.
    expect(context.sdk.calls.slice(-1)).toEqual(["exitRoom"]);
    context.sdk.startControl.resolve();
    await context.clock.flush();
    expect(markersIn(context.storage).map(markerShape)).toEqual([{ state: "STOP_UNCONFIRMED", robotId: ROBOT, taskId: TASK }]);
    context.sdk.exitControl.resolve();
    expect(await pending).toEqual({ kind: "FAILED", reason: "PROVIDER_FAILURE", providerStop: UNRESOLVED });
    // The release's own (id-less) outcome never downgrades the ids the late handler recorded.
    expect(markersIn(context.storage).map(markerShape)).toEqual([{ state: "STOP_UNCONFIRMED", robotId: ROBOT, taskId: TASK }]);
    expect(takeWarnings()).toEqual([`[voice] provider start resolved after cleanup; robotId=${ROBOT}; taskId=${TASK}`, UNRESOLVED_LINE]);
  });

  it("late rejections after the budget: a definitive one removes the marker; an ambiguous one keeps it and logs nothing more", async () => {
    const definitive = setup({ deferStart: true });
    const { pending: definitivePending } = await startInFlight(definitive);
    definitive.abort.abort();
    await settle(definitive.clock, definitivePending);
    expect(takeWarnings()).toEqual([UNRESOLVED_LINE]);
    expect(markersIn(definitive.storage).map(markerShape)).toEqual([{ state: "STOP_UNCONFIRMED", robotId: null, taskId: null }]);
    definitive.sdk.startControl.reject(Object.assign(new Error("TEST-ONLY invalid parameter"), { code: 5000 }));
    await definitive.clock.flush();
    expect(definitive.storage.items.has(MARKERS_KEY)).toBe(false);

    const ambiguous = setup({ deferStart: true });
    const { pending: ambiguousPending } = await startInFlight(ambiguous);
    ambiguous.abort.abort();
    await settle(ambiguous.clock, ambiguousPending);
    expect(takeWarnings()).toEqual([UNRESOLVED_LINE]);
    ambiguous.sdk.startControl.reject(Object.assign(new Error("TEST-ONLY signalling timeout"), { code: 5500 }));
    await ambiguous.clock.flush();
    expect(markersIn(ambiguous.storage).map(markerShape)).toEqual([{ state: "STOP_UNCONFIRMED", robotId: null, taskId: null }]);
    expect(takeWarnings()).toEqual([]);
  });

  it("start success after the cleanup deadline while the client was not destroyed (failed exit): a best-effort stop is sent", async () => {
    const context = setup({ deferStart: true, exitRoom: new Error("TEST-ONLY exit failed") });
    const { pending: pending } = await startInFlight(context);
    context.abort.abort();
    await settle(context.clock, pending);
    takeWarnings();
    expect(context.sdk.calls).not.toContain("destroy");
    context.sdk.startControl.resolve();
    await context.clock.flush();
    expect(context.sdk.calls.slice(-1)).toEqual(["stopPlugin"]);
    expect(context.sdk.recorded.stop).toEqual({ plugin: "RealtimeTranscriber", transcriberRobotId: ROBOT });
    // The late path never removes the marker on its own.
    expect(markersIn(context.storage).map(markerShape)).toEqual([{ state: "STOP_UNCONFIRMED", robotId: ROBOT, taskId: TASK }]);
    expect(takeWarnings()).toHaveLength(1);
  });

  it("network failure during startup is not definitive (START_UNRESOLVED); a pre-send validation error is (NOT_STARTED, marker removed)", async () => {
    const network = setup({ deferStart: true });
    const { pending: networkPending } = await startInFlight(network);
    network.sdk.startControl.reject(Object.assign(new Error("TEST-ONLY signalling timeout"), { code: 5500 }));
    expect(await networkPending).toEqual({ kind: "FAILED", reason: "NETWORK_FAILURE", providerStop: UNRESOLVED });
    expect(markersIn(network.storage).map(markerShape)).toEqual([{ state: "STOP_UNCONFIRMED", robotId: null, taskId: null }]);
    expect(takeWarnings()).toEqual([UNRESOLVED_LINE]);

    const validation = setup({ deferStart: true });
    const { pending: validationPending } = await startInFlight(validation);
    validation.sdk.startControl.reject(Object.assign(new Error("TEST-ONLY invalid parameter"), { code: 5000, extraCode: 5001 }));
    expect(await validationPending).toEqual({ kind: "FAILED", reason: "PROVIDER_FAILURE", providerStop: { kind: "NOT_STARTED" } });
    expect(validation.storage.items.has(MARKERS_KEY)).toBe(false);

    // The classification itself (pinned 5.20.1, see the adapter header).
    for (const code of [5000, 5100, 5200]) expect(isDefinitiveStartRejection({ code }), String(code)).toBe(true);
    for (const error of [{ code: 5400, extraCode: 5001 }, { code: 5400 }, { code: 5500 }, { code: 5998 }, { code: 5999 }, new Error("x"), "x", null]) expect(isDefinitiveStartRejection(error), JSON.stringify(error)).toBe(false);
  });

  it("an abort as the robot id is returned still stops it; the FAILED result carries the real outcome", async () => {
    const context = setup({ afterStartResolved: () => context.abort.abort() });
    const { value } = await settle(context.clock, context.start());
    expect(value).toEqual({ kind: "FAILED", reason: "PROVIDER_FAILURE", providerStop: { kind: "CONFIRMED" } });
    expect(context.sdk.calls.slice(-7)).toEqual(["stopLocalAudio", "stopPlugin", "exitRoom", "destroy", ...OFFS]);
    expect(context.storage.items.has(MARKERS_KEY)).toBe(false);
  });

  it("start timeout during startup (controller + adapter on one clock): FAILED START_TIMEOUT with START_UNRESOLVED", async () => {
    const context = setup({ deferStart: true });
    const controller = createVoiceSessionController({ transcriber: context.adapter, timers: context.clock.timers, startTimeoutMs: 15_000, maxSessionSeconds: 90 });
    const starting = controller.start({ language: "en", grant: grant() });
    await context.clock.flush();
    expect(context.sdk.calls).toContain("startPlugin");
    await context.clock.advance(15_000);
    expect(controller.snapshot().state).toBe("STOPPING");
    expect(context.sdk.calls.slice(-1)).toEqual(["stopLocalAudio"]);
    await context.clock.advance(10_000);
    await starting;
    expect(controller.snapshot()).toMatchObject({ state: "FAILED", failureReason: "START_TIMEOUT", microphoneReleased: true, providerStop: UNRESOLVED });
    expect(takeWarnings()).toEqual([UNRESOLVED_LINE]);
  });

  it("a hanging stopLocalAudio on its own: microphoneReleased false, the stop is still sent after the 5 s step and CONFIRMED", async () => {
    const { sdk, start, clock } = setup({ hang: "stopLocalAudio" });
    const result = started(await start());
    const { value, at } = await settle(clock, result.session.stop());
    expect(value).toEqual({ microphoneReleased: false, providerStop: { kind: "CONFIRMED" } });
    expect(at).toBe(5_000);
    expect(sdk.calls.slice(-7)).toEqual(["stopLocalAudio", "stopPlugin", "exitRoom", "destroy", ...OFFS]);
  });

  it("a hanging exitRoom on its own: bounded by its 5 s step, no destroy, listeners removed, CONFIRMED", async () => {
    const { sdk, start, clock } = setup({ hang: "exitRoom" });
    const result = started(await start());
    const { value, at } = await settle(clock, result.session.stop());
    expect(value).toEqual({ microphoneReleased: true, providerStop: { kind: "CONFIRMED" } });
    expect(at).toBe(5_000);
    expect(sdk.calls).not.toContain("destroy");
    expect(sdk.listeners()).toBe(0);
  });

  it("refuses a new start while a marker exists (also after a simulated reload), and allows it after an evidence-backed clear", async () => {
    const storage = memoryStorage();
    const first = setup({ robotLeftOnStop: false }, undefined, { storage });
    const result = started(await first.start());
    await settle(first.clock, result.session.stop());
    takeWarnings();
    first.sdk.calls.length = 0;
    // Same tab: refused before anything is loaded or requested.
    expect(await first.start()).toEqual({ kind: "FAILED", reason: "PROVIDER_FAILURE", providerStop: { kind: "NOT_STARTED" } });
    expect(first.sdk.calls).toEqual([]);
    expect(first.requestCredential).toHaveBeenCalledTimes(1);
    // A reload: a new adapter instance over the same storage.
    const reloaded = setup({}, undefined, { storage });
    expect(await reloaded.start()).toMatchObject({ kind: "FAILED", reason: "PROVIDER_FAILURE" });
    expect(reloaded.sdk.calls).toEqual([]);
    expect(reloaded.requestCredential).not.toHaveBeenCalled();
    // The owner's DescribeAITranscription check, then the clear.
    expect(await clearUnconfirmedProviderTasks(evidence(TASK), { storage: () => storage, now: () => EPOCH + 90_000 })).toEqual({ kind: "CLEARED", removed: 1 });
    started(await reloaded.start());
  });

  it("an unreadable marker value blocks a start; storage unavailable blocks a start (no write-ahead record possible)", async () => {
    const corrupt = setup({}, undefined, { storage: memoryStorage({ [MARKERS_KEY]: "{not json" }) });
    expect(await corrupt.start()).toMatchObject({ kind: "FAILED", reason: "PROVIDER_FAILURE", providerStop: { kind: "NOT_STARTED" } });
    expect(corrupt.sdk.calls).toEqual([]);
    for (const storageFactory of [() => null, () => { throw new Error("TEST-ONLY no storage"); }] as Array<() => TrtcAdapterStorage | null>) {
      const unavailable = setup({}, undefined, { storageFactory });
      expect(await unavailable.start()).toMatchObject({ kind: "FAILED", reason: "PROVIDER_FAILURE" });
      expect(unavailable.sdk.calls).toEqual([]);
      expect(unavailable.requestCredential).not.toHaveBeenCalled();
    }
  });

  it("two tabs (two controllers, one storage, one Web Locks manager): the second start is refused while the first starts and after", async () => {
    const storage = memoryStorage();
    const { locks, held } = fakeLocks();
    const clock = manualClock();
    const tabA = setup({ deferStart: true }, undefined, { storage, locks, clock });
    const tabB = setup({}, undefined, { storage, locks, clock });
    const controllerA = createVoiceSessionController({ transcriber: tabA.adapter, timers: clock.timers, startTimeoutMs: 15_000, maxSessionSeconds: 90 });
    const controllerB = createVoiceSessionController({ transcriber: tabB.adapter, timers: clock.timers, startTimeoutMs: 15_000, maxSessionSeconds: 90 });
    const startingA = controllerA.start({ language: "en", grant: grant() });
    await clock.flush();
    expect(held.size).toBe(1);
    // While A's start is in flight, B finds the lock busy.
    await controllerB.start({ language: "en", grant: grant() });
    expect(controllerB.snapshot()).toMatchObject({ state: "FAILED", failureReason: "PROVIDER_FAILURE", providerStop: { kind: "NOT_STARTED" } });
    expect(tabB.sdk.calls).toEqual([]);
    tabA.sdk.startControl.resolve();
    await startingA;
    expect(controllerA.snapshot().state).toBe("LISTENING");
    expect(held.size).toBe(0);
    // A is listening: its STARTED marker refuses B.
    await controllerB.start({ language: "en", grant: grant() });
    expect(controllerB.snapshot()).toMatchObject({ state: "FAILED", failureReason: "PROVIDER_FAILURE" });
    expect(tabB.sdk.calls).toEqual([]);
    // A stops CONFIRMED: the marker is removed and B may start.
    await controllerA.stop();
    expect(controllerA.snapshot()).toMatchObject({ state: "COMPLETED", providerStop: { kind: "CONFIRMED" } });
    await controllerB.start({ language: "en", grant: grant() });
    expect(controllerB.snapshot().state).toBe("LISTENING");
  });

  it("two tabs, Web Locks: tab B is refused by the busy lock alone while tab A holds it before any marker exists", async () => {
    const storage = memoryStorage();
    const { locks, held } = fakeLocks();
    const clock = manualClock();
    // Tab A waits at the microphone step (a permission prompt left open): it holds the lock, and no marker exists yet.
    const tabA = setup({ hang: "startLocalAudio" }, undefined, { storage, locks, clock });
    const tabB = setup({}, undefined, { storage, locks, clock });
    const pendingA = tabA.start();
    await clock.flush();
    expect(tabA.sdk.calls).toContain("startLocalAudio");
    expect(held.size).toBe(1);
    expect(storage.items.has(MARKERS_KEY)).toBe(false);
    expect(await tabB.start()).toEqual({ kind: "FAILED", reason: "PROVIDER_FAILURE", providerStop: { kind: "NOT_STARTED" } });
    expect(tabB.sdk.calls).toEqual([]);
    expect(tabB.requestCredential).not.toHaveBeenCalled();
    // A gives up (cancel): definitively nothing started, the lock is released and B may start.
    tabA.abort.abort();
    expect(await pendingA).toMatchObject({ kind: "FAILED", providerStop: { kind: "NOT_STARTED" } });
    expect(held.size).toBe(0);
    started(await tabB.start());
  });

  it("without Web Locks: a START_PENDING claim with re-read verification refuses a concurrent start and backs off from a lost race", async () => {
    const storage = memoryStorage();
    const clock = manualClock();
    const tabA = setup({ deferStart: true }, undefined, { storage, locks: null, clock });
    const tabB = setup({}, undefined, { storage, locks: null, clock });
    const pendingA = tabA.start();
    // A's claim is written at once, before anything is loaded.
    expect(markersIn(storage).map(markerShape)).toEqual([{ state: "START_PENDING", robotId: null, taskId: null }]);
    expect(await tabB.start()).toMatchObject({ kind: "FAILED", reason: "PROVIDER_FAILURE", providerStop: { kind: "NOT_STARTED" } });
    expect(tabB.sdk.calls).toEqual([]);
    await clock.flush();
    tabA.sdk.startControl.resolve();
    started(await pendingA);

    // A lost race: another tab's write lands between this tab's claim and its re-read, replacing ours or landing beside it.
    const other: ProviderTaskMarker = { markerId: "other-tab", state: "START_PENDING", robotId: null, taskId: null, recordedAt: EPOCH };
    for (const race of ["REPLACES", "APPENDS"] as const) {
      const raced = memoryStorage();
      const storageFactory = (): TrtcAdapterStorage => ({
        getItem: (key) => raced.getItem(key),
        setItem: (key, value) => {
          raced.setItem(key, value);
          if (key === MARKERS_KEY && !value.includes("other-tab")) raced.items.set(MARKERS_KEY, JSON.stringify(race === "REPLACES" ? [other] : [...(JSON.parse(value) as ProviderTaskMarker[]), other]));
        },
        removeItem: (key) => raced.removeItem(key),
      });
      const loser = setup({}, undefined, { storageFactory, locks: null });
      expect(await loser.start(), race).toMatchObject({ kind: "FAILED", reason: "PROVIDER_FAILURE" });
      expect(loser.sdk.calls, race).toEqual([]);
      // It backs off and never removes the other tab's marker.
      expect(markersIn(raced), race).toEqual([other]);
    }
  });

  it("clearing requires DescribeAITranscription evidence, removes only matching markers and records the evidence", async () => {
    const marker = (markerId: string, taskId: string | null): ProviderTaskMarker => ({ markerId, state: "STOP_UNCONFIRMED", robotId: taskId === null ? null : ROBOT, taskId, recordedAt: EPOCH });
    const storage = memoryStorage({ [MARKERS_KEY]: JSON.stringify([marker("a", TASK), marker("b", null)]) });
    const options = { storage: () => storage, now: () => EPOCH + 120_000 };
    for (const bad of [undefined, null, {}, { ...evidence(), method: "Guess" }, { ...evidence(), kind: "LOOKS_FINE" }, { ...evidence(), checkedAt: Number.NaN }, { ...evidence(), taskId: "" }]) {
        expect(await clearUnconfirmedProviderTasks(bad as never, options), JSON.stringify(bad)).toEqual({ kind: "REJECTED", reason: "EVIDENCE_REQUIRED" });
    }
    expect(markersIn(storage).map((entry) => entry.markerId)).toEqual(["a", "b"]);
    expect(await clearUnconfirmedProviderTasks(evidence("task-other"), options)).toEqual({ kind: "REJECTED", reason: "NO_MATCHING_MARKER" });
    expect(await clearUnconfirmedProviderTasks(evidence(TASK), options)).toEqual({ kind: "CLEARED", removed: 1 });
    // The id-less marker has no DescribeAITranscription path: it stays.
    expect(markersIn(storage).map((entry) => entry.markerId)).toEqual(["b"]);
    expect(await clearUnconfirmedProviderTasks({ kind: "PROVIDER_TASK_NOT_FOUND", taskId: null, checkedAt: EPOCH + 100_000, method: "DescribeAITranscription" } as never, options)).toEqual({ kind: "REJECTED", reason: "EVIDENCE_REQUIRED" });
    expect(markersIn(storage).map((entry) => entry.markerId)).toEqual(["b"]);
    expect(JSON.parse(storage.items.get(JAGAON_PROVIDER_TASK_CLEARANCES_KEY)!)).toEqual([
      { markerId: "a", taskId: TASK, markerState: "STOP_UNCONFIRMED", evidenceKind: "PROVIDER_STATUS_STOPPED", evidenceSource: "OWNER_RECORDED_PROVIDER_RESPONSE", providerVerified: false, method: "DescribeAITranscription", checkedAt: EPOCH + 60_000, clearedAt: EPOCH + 120_000 },
    ]);
    expect(readUnconfirmedProviderTasks(() => storage)).toMatchObject({ kind: "OK", markers: [{ markerId: "b" }] });
    expect(await clearUnconfirmedProviderTasks(evidence(), { storage: () => null })).toEqual({ kind: "REJECTED", reason: "STORAGE_UNAVAILABLE" });
  });

  it("the masked line keeps the exact taskId (only the robot id is masked)", async () => {
    const taskId = `task-${CREDENTIAL.sdkAppId}-x`;
    const storage = memoryStorage();
    const { start, clock } = setup({ robotLeftOnStop: false, hang: "stopPlugin", afterStartResolved: () => storage.items.set(STORAGE_KEY, JSON.stringify({ [ROBOT]: { taskId } })) }, undefined, { storage });
    const result = started(await start());
    const { value } = await settle(clock, result.session.stop());
    expect(value).toEqual({ microphoneReleased: true, providerStop: { kind: "UNCONFIRMED", reason: "STOP_TIMED_OUT", robotId: ROBOT, taskId } });
    expect(takeWarnings()).toEqual([`[voice] provider stop unconfirmed (STOP_TIMED_OUT); robotId=${ROBOT}; taskId=${taskId}`]);
    expect(markersIn(storage).map(markerShape)).toEqual([{ state: "STOP_UNCONFIRMED", robotId: ROBOT, taskId }]);
  });
});

describe("TRTC provider-task recovery: evidence-checked clearing and the DevTools helper (owner decisions I-2, I-3)", () => {
  const marker = (markerId: string, state: ProviderTaskMarker["state"], taskId: string | null, robotId: string | null = taskId === null ? null : ROBOT): ProviderTaskMarker => ({ markerId, state, robotId, taskId, recordedAt: EPOCH });
  const describeEvidence = (taskId: unknown, kind = "PROVIDER_STATUS_STOPPED") => ({ kind, taskId, checkedAt: Date.parse("2026-10-11T08:00:00.000Z"), method: "DescribeAITranscription" }) as never;
  const neverSent = (markerId: string) => ({ kind: "NEVER_SENT", markerId }) as const;
  const withMarkers = (markers: ProviderTaskMarker[]) => memoryStorage({ [MARKERS_KEY]: JSON.stringify(markers) });
  const clearOptions = (storage: MemoryStorage, locks: TrtcAdapterLocks | null = null) => ({ storage: () => storage, now: () => EPOCH + 300_000, locks: () => locks });

  it("DescribeAITranscription evidence: a null or empty taskId is rejected; a matching taskId clears only that marker; id-less markers stay", async () => {
    const storage = withMarkers([marker("a", "STOP_UNCONFIRMED", TASK), marker("b", "STOP_UNCONFIRMED", null), marker("c", "START_REQUESTED", null), marker("d", "STARTED", "task-2"), marker("e", "STARTED", null)]);
    const options = clearOptions(storage);
    for (const taskId of [null, "", undefined, 7]) {
      for (const kind of ["PROVIDER_STATUS_STOPPED", "PROVIDER_TASK_NOT_FOUND"]) {
        expect(await clearUnconfirmedProviderTasks(describeEvidence(taskId, kind), options), `${kind} ${String(taskId)}`).toEqual({ kind: "REJECTED", reason: "EVIDENCE_REQUIRED" });
      }
    }
    expect(await clearUnconfirmedProviderTasks(describeEvidence("task-unknown"), options)).toEqual({ kind: "REJECTED", reason: "NO_MATCHING_MARKER" });
    expect(await clearUnconfirmedProviderTasks(describeEvidence("task-2", "PROVIDER_TASK_NOT_FOUND"), options)).toEqual({ kind: "CLEARED", removed: 1 });
    expect(markersIn(storage).map((entry) => entry.markerId)).toEqual(["a", "b", "c", "e"]);
    // Id-less START_REQUESTED / STARTED / STOP_UNCONFIRMED markers have no clearing path at all.
    for (const markerId of ["b", "c", "e"]) expect(await clearUnconfirmedProviderTasks(neverSent(markerId), options), markerId).toEqual({ kind: "REJECTED", reason: "NOT_NEVER_SENT" });
    expect(markersIn(storage).map((entry) => entry.markerId)).toEqual(["a", "b", "c", "e"]);
    expect(JSON.parse(storage.items.get(JAGAON_PROVIDER_TASK_CLEARANCES_KEY)!)).toEqual([
      { markerId: "d", taskId: "task-2", markerState: "STARTED", evidenceKind: "PROVIDER_TASK_NOT_FOUND", evidenceSource: "OWNER_RECORDED_PROVIDER_RESPONSE", providerVerified: false, method: "DescribeAITranscription", checkedAt: Date.parse("2026-10-11T08:00:00.000Z"), clearedAt: EPOCH + 300_000 },
    ]);
  });

  it("NEVER_SENT clears only that exact START_PENDING marker; rejected for other states, unknown ids and an unreadable value", async () => {
    const storage = withMarkers([marker("p", "START_PENDING", null), marker("r", "START_REQUESTED", null), marker("s", "STARTED", TASK), marker("u", "STOP_UNCONFIRMED", TASK)]);
    const options = clearOptions(storage);
    for (const markerId of ["r", "s", "u"]) expect(await clearUnconfirmedProviderTasks(neverSent(markerId), options), markerId).toEqual({ kind: "REJECTED", reason: "NOT_NEVER_SENT" });
    expect(await clearUnconfirmedProviderTasks(neverSent("unknown"), options)).toEqual({ kind: "REJECTED", reason: "NO_MATCHING_MARKER" });
    for (const bad of [{ kind: "NEVER_SENT" }, { kind: "NEVER_SENT", markerId: "" }, { kind: "NEVER_SENT", markerId: 1 }]) expect(await clearUnconfirmedProviderTasks(bad as never, options)).toEqual({ kind: "REJECTED", reason: "EVIDENCE_REQUIRED" });
    expect(await clearUnconfirmedProviderTasks(neverSent("p"), options)).toEqual({ kind: "CLEARED", removed: 1 });
    expect(markersIn(storage).map((entry) => entry.markerId)).toEqual(["r", "s", "u"]);
    expect(JSON.parse(storage.items.get(JAGAON_PROVIDER_TASK_CLEARANCES_KEY)!)).toEqual([
      { markerId: "p", taskId: null, markerState: "START_PENDING", evidenceKind: "NEVER_SENT", evidenceSource: "APP_LOCAL_STATE", providerVerified: false, method: null, checkedAt: null, clearedAt: EPOCH + 300_000 },
    ]);
    // An unreadable value stays blocked: no evidence kind clears it.
    const unreadable = memoryStorage({ [MARKERS_KEY]: "{not json" });
    expect(await clearUnconfirmedProviderTasks(neverSent("p"), clearOptions(unreadable))).toEqual({ kind: "REJECTED", reason: "NO_MATCHING_MARKER" });
    expect(await clearUnconfirmedProviderTasks(describeEvidence(TASK), clearOptions(unreadable))).toEqual({ kind: "REJECTED", reason: "NO_MATCHING_MARKER" });
    expect(unreadable.items.get(MARKERS_KEY)).toBe("{not json");
    expect(unreadable.items.has(JAGAON_PROVIDER_TASK_CLEARANCES_KEY)).toBe(false);
  });

  it("NEVER_SENT with Web Locks: a busy start lock is START_IN_PROGRESS (nothing cleared); a free lock is taken and released", async () => {
    const storage = withMarkers([marker("p", "START_PENDING", null)]);
    const { locks, held } = fakeLocks();
    let releaseHeld: () => void = () => undefined;
    void locks.request(JAGAON_PROVIDER_START_LOCK, { ifAvailable: true }, () => new Promise<void>((resolve) => (releaseHeld = resolve)));
    expect(held.size).toBe(1);
    expect(await clearUnconfirmedProviderTasks(neverSent("p"), clearOptions(storage, locks))).toEqual({ kind: "REJECTED", reason: "START_IN_PROGRESS" });
    expect(markersIn(storage).map((entry) => entry.markerId)).toEqual(["p"]);
    releaseHeld();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(held.size).toBe(0);
    expect(await clearUnconfirmedProviderTasks(neverSent("p"), clearOptions(storage, locks))).toEqual({ kind: "CLEARED", removed: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(held.size).toBe(0);
  });

  it("invariant: startPlugin is never called while the marker is START_PENDING, and a failed START_REQUESTED write refuses the start", async () => {
    // Fallback path (no Web Locks): the START_PENDING claim is upgraded and verified before startPlugin.
    const storage = memoryStorage();
    const fallback = setup({}, undefined, { storage, locks: null });
    started(await fallback.start());
    expect(JSON.parse(fallback.sdk.recorded.markersAtStartPlugin!).map(markerShape)).toEqual([{ state: "START_REQUESTED", robotId: null, taskId: null }]);
    // A START_REQUESTED write that does not land: startPlugin is never called, the START_PENDING claim is dropped (NOT_STARTED).
    const inner = memoryStorage();
    const storageFactory = (): TrtcAdapterStorage => ({
      getItem: (key) => inner.getItem(key),
      setItem: (key, value) => (key === MARKERS_KEY && value.includes("START_REQUESTED") ? undefined : inner.setItem(key, value)),
      removeItem: (key) => inner.removeItem(key),
    });
    const refused = setup({}, undefined, { storageFactory, locks: null });
    const claimed: string[] = [];
    const pending = refused.start();
    claimed.push(...markersIn(inner).map((entry) => entry.state));
    expect(await pending).toEqual({ kind: "FAILED", reason: "PROVIDER_FAILURE", providerStop: { kind: "NOT_STARTED" } });
    expect(claimed).toEqual(["START_PENDING"]);
    expect(refused.sdk.calls).not.toContain("startPlugin");
    expect(inner.items.has(MARKERS_KEY)).toBe(false);
  });

  it("a page closed after the fallback claim: the reload is refused, read() flags neverSent, NEVER_SENT clears it and voice starts again", async () => {
    const storage = memoryStorage();
    const closed = setup({ hang: "startLocalAudio" }, undefined, { storage, locks: null });
    void closed.start();
    await closed.clock.flush();
    // The page is gone: nothing more runs for it. A reload over the same storage:
    const reloaded = setup({}, undefined, { storage, locks: null });
    expect(await reloaded.start()).toMatchObject({ kind: "FAILED", reason: "PROVIDER_FAILURE" });
    const helper = createVoiceRecoveryHelper({ storage: () => storage, locks: () => null, now: () => EPOCH });
    const view = helper.read();
    expect(view).toMatchObject({ guard: "OK", blocksStart: true, markers: [{ state: "START_PENDING", robotId: null, taskId: null, neverSent: true }] });
    expect(await helper.clear({ kind: "NEVER_SENT", markerId: view.markers[0].markerId })).toEqual({ kind: "CLEARED", removed: 1 });
    expect(helper.read()).toMatchObject({ guard: "OK", blocksStart: false, markers: [], clearances: [{ evidenceKind: "NEVER_SENT", evidenceSource: "APP_LOCAL_STATE", providerVerified: false }] });
    started(await reloaded.start());
  });

  it("read(): a frozen plain-JSON view with only the listed fields, for OK, UNREADABLE and UNAVAILABLE; never a credential", async () => {
    const SENTINEL = Object.freeze({ sdkAppId: 1987654321, userId: USER, userSig: "SENTINEL-USERSIG-DO-NOT-LEAK", roomId: "jr_room-1", maxSessionSeconds: 90 });
    const storage = memoryStorage();
    const session = setup({ robotLeftOnStop: false }, async () => ({ kind: "ISSUED", credential: SENTINEL }), { storage });
    const result = started(await session.start());
    await settle(session.clock, result.session.stop());
    takeWarnings();
    // A tampered marker and clearance record carrying extra (credential-like) fields: the view projects known fields only.
    const tampered = [...markersIn(storage), { ...marker("p", "START_PENDING", null), userSig: SENTINEL.userSig, sdkAppId: SENTINEL.sdkAppId, userId: USER, roomId: SENTINEL.roomId }];
    storage.items.set(MARKERS_KEY, JSON.stringify(tampered));
    storage.items.set(JAGAON_PROVIDER_TASK_CLEARANCES_KEY, JSON.stringify([{ markerId: "old", taskId: "task-0", markerState: "STARTED", evidenceKind: "PROVIDER_STATUS_STOPPED", evidenceSource: "OWNER_RECORDED_PROVIDER_RESPONSE", providerVerified: false, method: "DescribeAITranscription", checkedAt: EPOCH, clearedAt: EPOCH, userSig: SENTINEL.userSig }, { junk: true }]));
    const view = createVoiceRecoveryHelper({ storage: () => storage }).read();
    expect(Object.keys(view).sort()).toEqual(["blocksStart", "clearances", "guard", "markers"]);
    expect(view.guard).toBe("OK");
    expect(view.blocksStart).toBe(true);
    for (const entry of view.markers) expect(Object.keys(entry).sort()).toEqual(["markerId", "neverSent", "recordedAt", "robotId", "state", "taskId"]);
    expect(view.markers.map(({ state, robotId, taskId, neverSent: flag, recordedAt }) => ({ state, robotId, taskId, flag, recordedAt }))).toEqual([
      { state: "STOP_UNCONFIRMED", robotId: ROBOT, taskId: TASK, flag: false, recordedAt: new Date(EPOCH + 10_000).toISOString() },
      { state: "START_PENDING", robotId: null, taskId: null, flag: true, recordedAt: new Date(EPOCH).toISOString() },
    ]);
    expect(view.clearances).toEqual([{ markerId: "old", taskId: "task-0", markerState: "STARTED", evidenceKind: "PROVIDER_STATUS_STOPPED", evidenceSource: "OWNER_RECORDED_PROVIDER_RESPONSE", providerVerified: false, method: "DescribeAITranscription", checkedAt: EPOCH, clearedAt: EPOCH }]);
    const json = JSON.stringify(view);
    expect(JSON.parse(json)).toEqual(view);
    for (const secret of [SENTINEL.userSig, String(SENTINEL.sdkAppId), "userSig", "sdkAppId", "userId", "roomId", "Sugar"]) expect(json, secret).not.toContain(secret);
    expect(Object.isFrozen(view) && Object.isFrozen(view.markers) && Object.isFrozen(view.clearances) && view.markers.every(Object.isFrozen) && view.clearances.every(Object.isFrozen)).toBe(true);

    expect(createVoiceRecoveryHelper({ storage: () => memoryStorage({ [MARKERS_KEY]: "{not json" }) }).read()).toEqual({ guard: "UNREADABLE", blocksStart: true, markers: [], clearances: [] });
    expect(createVoiceRecoveryHelper({ storage: () => null }).read()).toEqual({ guard: "UNAVAILABLE", blocksStart: true, markers: [], clearances: [] });
    expect(createVoiceRecoveryHelper({ storage: () => memoryStorage() }).read()).toEqual({ guard: "OK", blocksStart: false, markers: [], clearances: [] });
  });

  it("install: once, non-writable, non-configurable, non-enumerable; a frozen object with exactly read and clear", () => {
    const target: Record<string, unknown> = {};
    expect(installVoiceRecoveryHelper(target, { storage: () => memoryStorage() })).toBe(true);
    const descriptor = Object.getOwnPropertyDescriptor(target, VOICE_RECOVERY_GLOBAL)!;
    expect(descriptor).toMatchObject({ writable: false, configurable: false, enumerable: false });
    const helper = descriptor.value as Record<string, unknown>;
    expect(Object.isFrozen(helper)).toBe(true);
    expect(Object.keys(helper).sort()).toEqual(["clear", "read"]);
    expect(Object.keys(target)).toEqual([]);
    expect(installVoiceRecoveryHelper(target)).toBe(false);
    expect(target[VOICE_RECOVERY_GLOBAL]).toBe(helper);
    expect(() => {
      target[VOICE_RECOVERY_GLOBAL] = {};
    }).toThrow(TypeError);
    expect(() => delete target[VOICE_RECOVERY_GLOBAL]).toThrow(TypeError);
    expect(() => {
      (helper as { read: unknown }).read = () => null;
    }).toThrow(TypeError);
  });

  it("the production loader installs window.jagaonVoiceRecovery once, locked, where cloud voice is composed; nothing fetched or logged", async () => {
    // A stand-in browser `window` and Storage (this file runs in node); `fetch` would fail loudly if anything were requested.
    const items = new Map<string, string>();
    const browserWindow: Record<string, unknown> = {};
    const fetchSpy = vi.fn(() => Promise.reject(new Error("TEST-ONLY: no network")));
    vi.stubGlobal("window", browserWindow);
    vi.stubGlobal("localStorage", { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => void items.set(key, value), removeItem: (key: string) => void items.delete(key) });
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const transcriber = await loadTrtcTranscriber(() => null);
      expect(typeof transcriber.start).toBe("function");
      const descriptor = Object.getOwnPropertyDescriptor(browserWindow, VOICE_RECOVERY_GLOBAL)!;
      expect(descriptor).toMatchObject({ writable: false, configurable: false, enumerable: false });
      const helper = descriptor.value as { read(): unknown; clear(evidence: unknown): Promise<unknown> };
      expect(Object.isFrozen(helper)).toBe(true);
      expect(Object.keys(helper).sort()).toEqual(["clear", "read"]);
      expect(helper.read()).toEqual({ guard: "OK", blocksStart: false, markers: [], clearances: [] });
      expect(await helper.clear({})).toEqual({ kind: "REJECTED", reason: "EVIDENCE_REQUIRED" });
      // A second composition is a no-op: the same helper stays.
      await loadTrtcTranscriber(() => null);
      expect(browserWindow[VOICE_RECOVERY_GLOBAL]).toBe(helper);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("elapsed time is never evidence: markers 31 minutes and 30 days old still block a start and every non-matching clear", async () => {
    // The adapter's clock reads EPOCH; the markers were recorded long before it.
    const aged = (markerId: string, state: ProviderTaskMarker["state"], ageMs: number, taskId: string | null = null): ProviderTaskMarker => ({ markerId, state, robotId: taskId === null ? null : ROBOT, taskId, recordedAt: EPOCH - ageMs });
    const MINUTES_31 = 31 * 60_000;
    const DAYS_30 = 30 * 86_400_000;
    for (const ageMs of [MINUTES_31, DAYS_30]) {
      for (const locks of [fakeLocks().locks, null]) {
        const storage = withMarkers([aged("r", "START_REQUESTED", ageMs), aged("u", "STOP_UNCONFIRMED", ageMs, TASK), aged("s", "STARTED", ageMs)]);
        const blocked = setup({}, undefined, { storage, locks });
        expect(await blocked.start(), String(ageMs)).toEqual({ kind: "FAILED", reason: "PROVIDER_FAILURE", providerStop: { kind: "NOT_STARTED" } });
        expect(blocked.requestCredential).not.toHaveBeenCalled();
        expect(blocked.sdk.calls).toEqual([]);
        const options = { storage: () => storage, now: () => EPOCH, locks: () => locks };
        for (const markerId of ["r", "u", "s"]) expect(await clearUnconfirmedProviderTasks(neverSent(markerId), options), `${ageMs} ${markerId}`).toEqual({ kind: "REJECTED", reason: "NOT_NEVER_SENT" });
        expect(await clearUnconfirmedProviderTasks(describeEvidence("task-other"), options)).toEqual({ kind: "REJECTED", reason: "NO_MATCHING_MARKER" });
        expect(markersIn(storage).map((entry) => entry.markerId)).toEqual(["r", "u", "s"]);
        expect(createVoiceRecoveryHelper(options).read().blocksStart).toBe(true);
      }
    }
  });

  it("read(): an id-less START_REQUESTED marker is not neverSent (only START_PENDING is)", () => {
    const storage = withMarkers([marker("r", "START_REQUESTED", null), marker("u", "STOP_UNCONFIRMED", null), marker("p", "START_PENDING", null)]);
    expect(createVoiceRecoveryHelper({ storage: () => storage }).read().markers.map(({ markerId, robotId, taskId, neverSent: flag }) => ({ markerId, robotId, taskId, flag }))).toEqual([
      { markerId: "r", robotId: null, taskId: null, flag: false },
      { markerId: "u", robotId: null, taskId: null, flag: false },
      { markerId: "p", robotId: null, taskId: null, flag: true },
    ]);
  });

  it("markerId scoping: a foreign marker with ids placed after the claim is never merged into this start's marker, before or after a late resolve", async () => {
    const foreign: ProviderTaskMarker = { markerId: "foreign", state: "STOP_UNCONFIRMED", robotId: "old-robot", taskId: "old-task", recordedAt: 1 };
    const storage = memoryStorage();
    // Another writer appends its marker (last in the list) while this start's startPlugin is in flight.
    const context = setup({ deferStart: true, during: { startPlugin: () => storage.items.set(MARKERS_KEY, JSON.stringify([...markersIn(storage), foreign])) } }, undefined, { storage });
    const UNRESOLVED = { kind: "UNCONFIRMED", reason: "START_UNRESOLVED", robotId: null, taskId: null } as const;
    const UNRESOLVED_LINE = "[voice] provider stop unconfirmed (START_UNRESOLVED); robotId=unknown; taskId=unknown";
    const pending = context.start();
    await context.clock.flush();
    expect(context.sdk.calls).toContain("startPlugin");
    context.abort.abort();
    expect((await settle(context.clock, pending)).value).toEqual({ kind: "FAILED", reason: "PROVIDER_FAILURE", providerStop: UNRESOLVED });
    const afterRelease = markersIn(storage);
    expect(afterRelease.find((entry) => entry.markerId === "foreign")).toEqual(foreign);
    expect(afterRelease.filter((entry) => entry.markerId !== "foreign").map(markerShape)).toEqual([{ state: "STOP_UNCONFIRMED", robotId: null, taskId: null }]);
    context.sdk.startControl.resolve();
    await context.clock.flush();
    const afterLate = markersIn(storage);
    expect(afterLate.find((entry) => entry.markerId === "foreign")).toEqual(foreign);
    expect(afterLate.filter((entry) => entry.markerId !== "foreign").map(markerShape)).toEqual([{ state: "STOP_UNCONFIRMED", robotId: ROBOT, taskId: TASK }]);
    expect(takeWarnings()).toEqual([UNRESOLVED_LINE, `[voice] provider start resolved after cleanup; robotId=${ROBOT}; taskId=${TASK}`]);
  });

  it("every 5400 outcome stays non-definitive (UNCONFIRMED START_UNRESOLVED, marker kept)", async () => {
    for (const error of [{ code: 5400, extraCode: 5001 }, { code: 5400, extraCode: 1234 }, { code: 5400 }]) {
      expect(isDefinitiveStartRejection(error), JSON.stringify(error)).toBe(false);
      const { start, storage } = setup({ startPlugin: Object.assign(new Error("TEST-ONLY"), error) });
      expect(await start(), JSON.stringify(error)).toMatchObject({ kind: "FAILED", providerStop: { kind: "UNCONFIRMED", reason: "START_UNRESOLVED", robotId: null } });
      expect(markersIn(storage).map(markerShape)).toEqual([{ state: "STOP_UNCONFIRMED", robotId: null, taskId: null }]);
      takeWarnings();
    }
  });
});
