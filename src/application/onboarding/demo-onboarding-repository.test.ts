import { describe, expect, it } from "vitest";
import {
  DEMO_ONBOARDING_STORAGE_KEY,
  createDemoOnboardingRepository,
  createMemoryOnboardingStorage,
  type DemoOnboardingStoragePort,
} from "./demo-onboarding-repository";
import type { DemoOnboardingStateV1 } from "./demo-onboarding-contracts";

const state: DemoOnboardingStateV1 = {
  schemaVersion: 1,
  status: "IN_PROGRESS",
  lastCompletedStep: "PROFILE",
  locale: "zh-SG",
  preferredName: "陈女士（示例）",
  medicines: [],
  updatedAt: "2026-10-02T08:00:00.000Z",
};

/** Storage double that records every key touched. */
function spyStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const touched: string[] = [];
  const port: DemoOnboardingStoragePort = {
    getItem: (key) => (touched.push(`get:${key}`), store.get(key) ?? null),
    setItem: (key, value) => (touched.push(`set:${key}`), void store.set(key, value)),
    removeItem: (key) => (touched.push(`remove:${key}`), void store.delete(key)),
  };
  return { port, store, touched };
}

describe("demo onboarding repository", () => {
  it("uses exactly the versioned onboarding key", () => {
    expect(DEMO_ONBOARDING_STORAGE_KEY).toBe("jagaon:demo-onboarding:v1");
  });

  it("returns null when nothing is saved", () => {
    const { port } = spyStorage();
    expect(createDemoOnboardingRepository(port).load()).toBeNull();
  });

  it("round-trips a valid state and keeps entered values verbatim", () => {
    const { port, touched } = spyStorage();
    const repository = createDemoOnboardingRepository(port);
    expect(repository.save(state)).toEqual({ ok: true, state });
    expect(repository.load()).toEqual(state);
    expect(new Set(touched.map((entry) => entry.split(":").slice(1).join(":")))).toEqual(
      new Set([DEMO_ONBOARDING_STORAGE_KEY]),
    );
  });

  it.each([
    ["malformed JSON", "{not json"],
    ["unknown version", JSON.stringify({ ...state, schemaVersion: 2 })],
    ["unknown key", JSON.stringify({ ...state, nric: "S0000000A" })],
    ["invalid locale", JSON.stringify({ ...state, locale: "fr-FR" })],
  ])("clears only the onboarding key when the payload is %s", (_label, payload) => {
    const { port, store } = spyStorage({
      [DEMO_ONBOARDING_STORAGE_KEY]: payload,
      "unrelated:key": "keep me",
    });
    expect(createDemoOnboardingRepository(port).load()).toBeNull();
    expect(store.has(DEMO_ONBOARDING_STORAGE_KEY)).toBe(false);
    expect(store.get("unrelated:key")).toBe("keep me");
  });

  it("validates before writing and never writes an invalid state", () => {
    const { port, store } = spyStorage();
    const result = createDemoOnboardingRepository(port).save({ ...state, preferredName: "  " });
    expect(result).toEqual({ ok: false, reason: "INVALID_STATE" });
    expect(store.size).toBe(0);
  });

  it("returns a typed failure when storage rejects the write", () => {
    const port: DemoOnboardingStoragePort = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException("quota", "QuotaExceededError");
      },
      removeItem: () => undefined,
    };
    expect(createDemoOnboardingRepository(port).save(state)).toEqual({
      ok: false,
      reason: "STORAGE_UNAVAILABLE",
    });
  });

  it("treats unreadable storage as no saved state", () => {
    const port: DemoOnboardingStoragePort = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    expect(createDemoOnboardingRepository(port).load()).toBeNull();
  });

  it("clears only the onboarding key and reports clear failures", () => {
    const { port, store } = spyStorage({
      [DEMO_ONBOARDING_STORAGE_KEY]: JSON.stringify(state),
      "jagaon:other": "x",
    });
    expect(createDemoOnboardingRepository(port).clear()).toEqual({ ok: true });
    expect([...store.keys()]).toEqual(["jagaon:other"]);
    const failing: DemoOnboardingStoragePort = {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(createDemoOnboardingRepository(failing).clear()).toEqual({
      ok: false,
      reason: "STORAGE_UNAVAILABLE",
    });
  });

  it("provides an in-memory port for tests and server rendering", () => {
    const memory = createMemoryOnboardingStorage();
    const repository = createDemoOnboardingRepository(memory);
    repository.save(state);
    expect(repository.load()).toEqual(state);
  });
});
