// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { voiceDisclosureReducer, VOICE_DISCLOSURE_INITIAL_STATE, type VoiceDisclosureGrant } from "@/application/voice/voice-cloud-disclosure";
import type { VoiceSegment, VoiceSessionFailureReason, VoiceStartResult } from "@/application/voice/voice-transcriber-port";
import type { TrtcClientSurface, TrtcEventMap, TrtcPluginSurface, TrtcSdkModules } from "./trtc-sdk-surface";
import { createTrtcTranscriberAdapter, type TrtcCredentialRequest } from "./trtc-transcriber-adapter";

const USER = "jv_user-1";
const ROBOT = "robot-1";
const CREDENTIAL = Object.freeze({ sdkAppId: 1400000001, userId: USER, userSig: "TEST-ONLY-usersig", roomId: "jr_room-1", maxSessionSeconds: 90 });

type FakeOptions = Partial<Record<"enterRoom" | "startLocalAudio" | "startPlugin" | "stopPlugin" | "stopLocalAudio" | "exitRoom" | "destroy", unknown>> & { supported?: boolean; hang?: "stopPlugin" | "startLocalAudio" };

function fakeSdk(options: FakeOptions = {}) {
  const calls: string[] = [];
  const handlers = new Map<string, Set<(event: never) => void>>();
  const recorded: { enter?: unknown; start?: unknown; stop?: unknown } = {};
  const step = (name: keyof FakeOptions, result?: unknown) => {
    calls.push(name);
    if (options[name] !== undefined) return Promise.reject(options[name]);
    return Promise.resolve(result);
  };
  const client: TrtcClientSurface = {
    enterRoom: (params) => ((recorded.enter = params), step("enterRoom")) as Promise<void>,
    startLocalAudio: () => (options.hang === "startLocalAudio" ? (calls.push("startLocalAudio"), new Promise<void>(() => undefined)) : (step("startLocalAudio") as Promise<void>)),
    stopLocalAudio: () => step("stopLocalAudio") as Promise<void>,
    exitRoom: () => step("exitRoom") as Promise<void>,
    destroy: () => {
      calls.push("destroy");
      if (options.destroy !== undefined) throw options.destroy;
    },
    startPlugin: (plugin, startOptions) => ((recorded.start = { plugin, ...startOptions }), step("startPlugin", ROBOT)),
    stopPlugin: (plugin, stopOptions) => {
      recorded.stop = { plugin, ...stopOptions };
      if (options.hang === "stopPlugin") {
        calls.push("stopPlugin");
        return new Promise(() => undefined);
      }
      return step("stopPlugin");
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
  const emit = <K extends keyof TrtcEventMap>(event: K, payload: TrtcEventMap[K]) => {
    for (const handler of handlers.get(event) ?? []) (handler as (value: TrtcEventMap[K]) => void)(payload);
  };
  const listeners = () => [...handlers.values()].reduce((total, set) => total + set.size, 0);
  return { modules, calls, recorded, emit, listeners };
}

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return { removed: [] as string[], items, removeItem(key: string) { this.removed.push(key); items.delete(key); } };
}

const grant = (): VoiceDisclosureGrant => {
  const accepted = voiceDisclosureReducer(voiceDisclosureReducer(VOICE_DISCLOSURE_INITIAL_STATE, { type: "REQUEST_START", language: "en" }), { type: "ACCEPT" });
  if (accepted.kind !== "GRANTED") throw new Error("no grant");
  return accepted.grant;
};

function setup(options: FakeOptions = {}, credential: TrtcCredentialRequest = async () => ({ kind: "ISSUED", credential: CREDENTIAL })) {
  const sdk = fakeSdk(options);
  const storage = memoryStorage({ [`TRTC_RT_${USER}`]: '{"robot":{"taskId":"t"}}', unrelated: "keep" });
  const requestCredential = vi.fn(credential);
  const adapter = createTrtcTranscriberAdapter({ requestCredential, loadSdk: async () => sdk.modules, storage: () => storage, timers: { setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) }, stepTimeoutMs: 50 });
  const segments: VoiceSegment[] = [];
  const failures: VoiceSessionFailureReason[] = [];
  const abort = new AbortController();
  const start = (language: "en" | "zh" = "en") => adapter.start({ language, grant: grant(), onSegment: (segment) => segments.push(segment), onFailure: (reason) => failures.push(reason), signal: abort.signal });
  return { sdk, storage, requestCredential, adapter, segments, failures, abort, start };
}

const message = (overrides: Partial<TrtcEventMap["realtime-transcriber-message"]> = {}) => ({ segmentId: "s1", speakerUserId: USER, sourceText: "Sugar 6.8 mmol", isCompleted: true, robotId: ROBOT, translationTexts: [{ language: "zh", text: "translated" }], timestamp: 1, ...overrides });

let consoleSpies: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => {
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method));
});
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

  it("stops in order (stopPlugin → stopLocalAudio → exitRoom → destroy), removes listeners and the plugin's storage key", async () => {
    const { sdk, start, storage } = setup();
    const result = started(await start());
    sdk.calls.length = 0;
    expect(await result.session.stop()).toEqual({ microphoneReleased: true });
    expect(sdk.calls).toEqual(["stopPlugin", "stopLocalAudio", "exitRoom", "destroy", "off:realtime-transcriber-message", "off:realtime-transcriber-state-changed", "off:error"]);
    expect(sdk.recorded.stop).toEqual({ plugin: "RealtimeTranscriber", transcriberRobotId: ROBOT });
    expect(sdk.listeners()).toBe(0);
    expect(storage.removed).toEqual([`TRTC_RT_${USER}`]);
    expect([...storage.items.keys()]).toEqual(["unrelated"]);
    // Idempotent: a later cancel or stop does not release again.
    expect(await result.session.cancel()).toEqual({ microphoneReleased: true });
    expect(sdk.calls.filter((call) => call === "stopLocalAudio")).toHaveLength(1);
  });

  it("a throwing stopPlugin still releases the microphone and the room", async () => {
    const { sdk, start } = setup({ stopPlugin: Object.assign(new Error("TEST-ONLY provider detail"), { code: 5400 }) });
    const result = started(await start());
    expect(await result.session.cancel()).toEqual({ microphoneReleased: true });
    expect(sdk.calls.slice(-7)).toEqual(["stopPlugin", "stopLocalAudio", "exitRoom", "destroy", "off:realtime-transcriber-message", "off:realtime-transcriber-state-changed", "off:error"]);
  });

  it("a hanging stopPlugin is bounded by the step timeout and the microphone is still released", async () => {
    const { sdk, start } = setup({ hang: "stopPlugin" });
    const result = started(await start());
    expect(await result.session.stop()).toEqual({ microphoneReleased: true });
    expect(sdk.calls).toContain("stopLocalAudio");
  });

  it("reports honestly when stopLocalAudio fails, and still exits and destroys", async () => {
    const { sdk, start } = setup({ stopLocalAudio: new Error("TEST-ONLY") });
    const result = started(await start());
    expect(await result.session.stop()).toEqual({ microphoneReleased: false });
    expect(sdk.calls).toEqual(expect.arrayContaining(["exitRoom", "destroy"]));
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
    expect(await result.session.stop()).toEqual({ microphoneReleased: true });
    expect(sdk.calls).toContain("exitRoom");
    expect(sdk.calls).not.toContain("destroy");
  });

  it("an unsupported browser creates nothing and requests no credential", async () => {
    const { sdk, start, requestCredential } = setup({ supported: false });
    expect(await start()).toEqual({ kind: "FAILED", reason: "UNSUPPORTED_BROWSER" });
    expect(sdk.calls).toEqual(["isSupported"]);
    expect(requestCredential).not.toHaveBeenCalled();
  });

  it("a refused or failed credential creates nothing", async () => {
    const refused = setup({}, async () => ({ kind: "REFUSED", reason: "ACCESS_DENIED" }));
    expect(await refused.start()).toEqual({ kind: "FAILED", reason: "CREDENTIAL_REFUSED", credentialRefusal: "ACCESS_DENIED" });
    expect(refused.sdk.calls).toEqual(["isSupported"]);
    const failed = setup({}, async () => ({ kind: "FAILED", reason: "NETWORK_FAILURE" }));
    expect(await failed.start()).toEqual({ kind: "FAILED", reason: "NETWORK_FAILURE" });
    const thrown = setup({}, async () => {
      throw new Error("TEST-ONLY");
    });
    expect(await thrown.start()).toEqual({ kind: "FAILED", reason: "NETWORK_FAILURE" });
  });

  it("permission denied runs the full release and returns only the closed reason", async () => {
    for (const error of [Object.assign(new Error("NotAllowedError, TEST-ONLY detail"), { name: "RtcError", code: 5300, extraCode: 5302 }), Object.assign(new Error("TEST-ONLY"), { name: "NotAllowedError" })]) {
      const { sdk, start, storage } = setup({ startLocalAudio: error });
      const result = await start();
      expect(result).toEqual({ kind: "FAILED", reason: "PERMISSION_DENIED" });
      expect(JSON.stringify(result)).not.toContain("TEST-ONLY");
      expect(sdk.calls.slice(sdk.calls.indexOf("startLocalAudio") + 1)).toEqual(["stopLocalAudio", "exitRoom", "destroy", "off:realtime-transcriber-message", "off:realtime-transcriber-state-changed", "off:error"]);
      expect(sdk.listeners()).toBe(0);
      expect(storage.removed).toEqual([`TRTC_RT_${USER}`]);
    }
  });

  it("maps the concurrency limit (5400/5001), environment and other errors to closed reasons", async () => {
    const cases: Array<[FakeOptions, string]> = [
      [{ startPlugin: Object.assign(new Error("TEST-ONLY"), { code: 5400, extraCode: 5001 }) }, "CONCURRENCY_LIMIT"],
      [{ enterRoom: Object.assign(new Error("TEST-ONLY"), { code: 5200 }) }, "UNSUPPORTED_BROWSER"],
      [{ enterRoom: Object.assign(new Error("TEST-ONLY"), { code: 5400, extraCode: -1 }) }, "NETWORK_FAILURE"],
      [{ startPlugin: Object.assign(new Error("TEST-ONLY"), { code: 5100 }) }, "PROVIDER_FAILURE"],
      [{ startPlugin: "not an error" }, "PROVIDER_FAILURE"],
    ];
    for (const [options, reason] of cases) {
      const { sdk, start } = setup(options);
      expect(await start(), reason).toEqual({ kind: "FAILED", reason });
      expect(sdk.calls, reason).toContain("destroy");
      expect(sdk.calls, reason).not.toContain("stopPlugin");
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
    await releasing;
    cancelled.sdk.emit("realtime-transcriber-message", message({ segmentId: "later" }));
    expect(cancelled.segments).toEqual([]);

    const stopped = setup({ hang: "stopPlugin" });
    const stopSession = started(await stopped.start()).session;
    const stopping = stopSession.stop();
    stopped.sdk.emit("realtime-transcriber-message", message({ segmentId: "final-during-stop" }));
    await stopping;
    expect(stopped.segments.map((segment) => segment.segmentId)).toEqual(["final-during-stop"]);
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
    const adapter = createTrtcTranscriberAdapter({ requestCredential: async () => ({ kind: "ISSUED", credential: CREDENTIAL }), loadSdk: async () => modules, storage: () => null, timers: { setTimeout, clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) }, stepTimeoutMs: 50 });
    const result = await adapter.start({ language: "en", grant: grant(), onSegment: () => undefined, onFailure: () => undefined, signal: abort.signal });
    expect(result.kind).toBe("FAILED");
    expect(sdk.calls).not.toContain("startLocalAudio");
    expect(sdk.calls.slice(-3)).toEqual(["off:realtime-transcriber-message", "off:realtime-transcriber-state-changed", "off:error"]);
    expect(sdk.calls).toEqual(expect.arrayContaining(["exitRoom", "destroy"]));
  });

  it("a failing SDK load is a closed failure", async () => {
    const adapter = createTrtcTranscriberAdapter({ requestCredential: async () => ({ kind: "ISSUED", credential: CREDENTIAL }), loadSdk: async () => { throw new Error("TEST-ONLY chunk"); }, storage: () => null });
    expect(await adapter.start({ language: "en", grant: grant(), onSegment: () => undefined, onFailure: () => undefined, signal: new AbortController().signal })).toEqual({ kind: "FAILED", reason: "PROVIDER_FAILURE" });
  });

  it("loads the SDK only by dynamic import inside start (named plugin export), never statically", () => {
    const source = readFileSync(join(process.cwd(), "src/voice/trtc/trtc-transcriber-adapter.ts"), "utf8");
    expect(source).not.toMatch(/^import\s+(?!type\b)[^;]*["']trtc-sdk-v5/m);
    expect(source).toMatch(/await import\("trtc-sdk-v5"\)/);
    expect(source).toMatch(/const \{ RealtimeTranscriber \} = await import\("trtc-sdk-v5\/plugins\/realtime-transcriber"\)/);
    expect(source).not.toMatch(/tls-sig-api-v2|console\.|translationLanguages:|enableCloudRecording:|enableSpeakerDiarization:/);
  });
});
