import { APPOINTMENT_NOTE_SELECTION_KEY } from "@/application/history/appointment-note-selection";
import {
  parseDemoOnboardingState,
  type DemoOnboardingStateV1,
} from "./demo-onboarding-contracts";

/**
 * Persists the Packet 6A presentation state under one versioned key. This
 * local-storage use is permitted only because the active release is an
 * explicit synthetic demonstration. No other key is ever read, written or
 * removed, and importing this module touches no browser global.
 */

export const DEMO_ONBOARDING_STORAGE_KEY = "jagaon:demo-onboarding:v1";

export interface DemoOnboardingStoragePort {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type DemoOnboardingWriteFailure = "INVALID_STATE" | "STORAGE_UNAVAILABLE";

export type DemoOnboardingSaveResult =
  | { ok: true; state: DemoOnboardingStateV1 }
  | { ok: false; reason: DemoOnboardingWriteFailure };

export type DemoOnboardingClearResult = { ok: true } | { ok: false; reason: "STORAGE_UNAVAILABLE" };

export interface DemoOnboardingRepository {
  load(): DemoOnboardingStateV1 | null;
  save(state: DemoOnboardingStateV1): DemoOnboardingSaveResult;
  clear(): DemoOnboardingClearResult;
}

export function createDemoOnboardingRepository(
  storage: DemoOnboardingStoragePort,
): DemoOnboardingRepository {
  function clear(): DemoOnboardingClearResult {
    try {
      storage.removeItem(DEMO_ONBOARDING_STORAGE_KEY);
      // Corrective Pass C: success means the key is confirmed absent.
      if (storage.getItem(DEMO_ONBOARDING_STORAGE_KEY) !== null) return { ok: false, reason: "STORAGE_UNAVAILABLE" };
      return { ok: true };
    } catch {
      return { ok: false, reason: "STORAGE_UNAVAILABLE" };
    }
  }

  return Object.freeze({
    load(): DemoOnboardingStateV1 | null {
      let raw: string | null;
      try {
        raw = storage.getItem(DEMO_ONBOARDING_STORAGE_KEY);
      } catch {
        return null;
      }
      if (raw === null) return null;
      let decoded: unknown;
      try {
        decoded = JSON.parse(raw);
      } catch {
        decoded = undefined;
      }
      const parsed = parseDemoOnboardingState(decoded);
      if (parsed.ok) return parsed.state;
      // Malformed or unknown-version state is removed so startup can fall
      // back to Welcome; only this key is touched.
      clear();
      return null;
    },

    save(state: DemoOnboardingStateV1): DemoOnboardingSaveResult {
      const parsed = parseDemoOnboardingState(state);
      if (!parsed.ok) return { ok: false, reason: "INVALID_STATE" };
      try {
        storage.setItem(DEMO_ONBOARDING_STORAGE_KEY, JSON.stringify(parsed.state));
        return { ok: true, state: parsed.state };
      } catch {
        return { ok: false, reason: "STORAGE_UNAVAILABLE" };
      }
    },

    clear,
  });
}

/** Browser localStorage port, resolved lazily so server imports stay inert. */
export function createBrowserOnboardingStorage(): DemoOnboardingStoragePort {
  const storage = () => window.localStorage;
  return Object.freeze({
    getItem: (key: string) => storage().getItem(key),
    setItem: (key: string, value: string) => storage().setItem(key, value),
    removeItem: (key: string) => storage().removeItem(key),
  });
}

/** In-memory port for tests and non-browser rendering. */
export function createMemoryOnboardingStorage(
  initial: Record<string, string> = {},
): DemoOnboardingStoragePort {
  const store = new Map(Object.entries(initial));
  return Object.freeze({
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
}

/**
 * Packet 10A: every JagaOn key in browser local storage. Whole-dataset
 * deletion removes them with the IndexedDB database (storage-backup-spec 6.8).
 */
export const JAGAON_LOCAL_STATE_KEYS = Object.freeze([DEMO_ONBOARDING_STORAGE_KEY, APPOINTMENT_NOTE_SELECTION_KEY] as const);

export function clearJagaOnLocalState(storage: Pick<DemoOnboardingStoragePort, "removeItem">): void {
  for (const key of JAGAON_LOCAL_STATE_KEYS) storage.removeItem(key);
}
