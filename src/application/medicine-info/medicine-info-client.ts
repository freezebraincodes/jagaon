import { parseStrictJson, toPlainData } from "@/backup/strict-json";
import { MEDICINE_INFO_TASK, medicineInfoRequestSchema, normaliseMedicineInfoName, toMedicineInfoName, type MedicineGeneralInfo } from "@/domain/medicine-info/medicine-info-contract";
import { validateMedicineGeneralInfo } from "@/domain/medicine-info/medicine-info-validator";
import { MEDICINE_INFO_ROUTE_PATH, medicineInfoRouteResponseSchema, type MedicineInfoUnavailableReason } from "./medicine-info-route-contract";

/**
 * HSA preview (owner decision 2026-10-14, "Get general information with AI"): the browser client of POST /api/ai/medicine-info, with a
 * small per-device cache. Browser-safe; no credential, prompt or provider code.
 *
 * `get(name, { refresh })`:
 *   1. the name is put in its request form (trimmed, inner spaces collapsed) and checked with the strict request schema; a name that
 *      fails is never sent (REQUEST_INVALID);
 *   2. without `refresh`, a cached entry for the normalised name (lower case, trimmed) that passes the validator AGAIN is returned
 *      (`source: "CACHE"`), and nothing is sent;
 *   3. otherwise ONE same-origin POST of exactly { task, medicineName } (no retry); the response schema; an OK answer is validated again
 *      on the device (medicine-info-validator.1) and cached with `fetchedAt`;
 *   4. NOT_FOUND and REJECTED (by the server or the device) are "no reliable information" and are never cached (a refresh that ends
 *      there forgets the earlier entry); an UNAVAILABLE refresh falls back to the cached entry when one is valid (`refreshFailed`).
 * Only the medicine name is ever sent. The cache and the "notice seen" list live in localStorage (every access guarded; unavailable
 * storage only means no cache). Nothing is logged.
 */
type Fetcher = (input: string, init: RequestInit) => Promise<Response>;
type KeyValueStorage = Pick<Storage, "getItem" | "setItem">;

export const MEDICINE_INFO_CACHE_KEY = "jagaon.medicineInfo.cache.v1";
export const MEDICINE_INFO_NOTICE_KEY = "jagaon.medicineInfo.noticeSeen.v1";

/**
 * Owner decision 2026-10-14: "Delete all data on this device" also clears the cached AI medicine information and the notice list.
 * Returns true when both keys are gone (or storage is absent).
 */
export function clearMedicineInfoLocalState(storage: Pick<Storage, "removeItem"> | undefined = globalThis.localStorage): boolean {
  if (!storage) return true;
  try {
    storage.removeItem(MEDICINE_INFO_CACHE_KEY);
    storage.removeItem(MEDICINE_INFO_NOTICE_KEY);
    return true;
  } catch {
    return false;
  }
}
export const MEDICINE_INFO_CACHE_MAX_ENTRIES = 50;
export const MEDICINE_INFO_CLIENT_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_CHARS = 8_192;

export type MedicineInfoClientFailure = MedicineInfoUnavailableReason | "REQUEST_INVALID" | "RESPONSE_INVALID";
export type MedicineInfoResult =
  | Readonly<{ kind: "OK"; info: MedicineGeneralInfo; fetchedAt: string; source: "CACHE" | "AI"; refreshFailed?: MedicineInfoClientFailure }>
  | Readonly<{ kind: "NO_RELIABLE_INFO"; reason: "NOT_FOUND" | "REJECTED_BY_SERVER" | "REJECTED_ON_DEVICE" }>
  | Readonly<{ kind: "UNAVAILABLE"; reason: MedicineInfoClientFailure }>;

export type MedicineInfoClient = Readonly<{
  get: (name: string, options?: Readonly<{ refresh?: boolean; signal?: AbortSignal }>) => Promise<MedicineInfoResult>;
  /** The valid cached entry for this name, or null (never sends anything). */
  cached: (name: string) => Extract<MedicineInfoResult, { kind: "OK" }> | null;
  /** Whether she has already accepted the one-time notice for this medicine on this device. */
  noticeAccepted: (name: string) => boolean;
  acceptNotice: (name: string) => void;
}>;

export type MedicineInfoClientOptions = Readonly<{
  /** Defaults to the global fetch (same-origin POST to the relative route path only). */
  fetcher?: Fetcher;
  /** Defaults to `globalThis.localStorage` (read inside a guard); null disables the cache and the notice list. */
  storage?: KeyValueStorage | null;
  now?: () => Date;
  timeoutMs?: number;
}>;

type CacheEntry = Readonly<{ info: MedicineGeneralInfo; fetchedAt: string }>;

function defaultStorage(): KeyValueStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function createMedicineInfoClient(options: MedicineInfoClientOptions = {}): MedicineInfoClient {
  const fetcher: Fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? MEDICINE_INFO_CLIENT_TIMEOUT_MS;
  const storage = () => (options.storage === undefined ? defaultStorage() : options.storage);

  function readJson(key: string): unknown {
    try {
      const text = storage()?.getItem(key);
      return typeof text === "string" ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  }
  function writeJson(key: string, value: unknown): void {
    try {
      storage()?.setItem(key, JSON.stringify(value));
    } catch {
      // Storage unavailable or full: nothing is cached; the answer is still shown.
    }
  }
  function readCache(): Record<string, unknown> {
    const value = readJson(MEDICINE_INFO_CACHE_KEY);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  }
  function cachedEntry(medicineName: string): CacheEntry | null {
    const raw = readCache()[normaliseMedicineInfoName(medicineName)];
    if (raw === null || typeof raw !== "object") return null;
    const { info, fetchedAt } = raw as { info?: unknown; fetchedAt?: unknown };
    if (typeof fetchedAt !== "string" || !Number.isFinite(Date.parse(fetchedAt))) return null;
    // A cached entry is shown only when it still passes every rule, for the name it is shown under.
    const validation = validateMedicineGeneralInfo(info, medicineName);
    return validation.ok && validation.value.kind === "OK" ? { info: validation.value.info, fetchedAt } : null;
  }
  function store(medicineName: string, entry: CacheEntry | null): void {
    const cache = readCache();
    const key = normaliseMedicineInfoName(medicineName);
    delete cache[key];
    if (entry) cache[key] = entry;
    const keys = Object.keys(cache);
    for (const old of keys.slice(0, Math.max(0, keys.length - MEDICINE_INFO_CACHE_MAX_ENTRIES))) delete cache[old];
    writeJson(MEDICINE_INFO_CACHE_KEY, cache);
  }
  const fromCache = (entry: CacheEntry, refreshFailed?: MedicineInfoClientFailure): Extract<MedicineInfoResult, { kind: "OK" }> =>
    Object.freeze({ kind: "OK" as const, info: entry.info, fetchedAt: entry.fetchedAt, source: "CACHE" as const, ...(refreshFailed ? { refreshFailed } : {}) });

  async function call(medicineName: string, signal: AbortSignal | undefined): Promise<MedicineInfoResult> {
    const unavailable = (reason: MedicineInfoClientFailure): MedicineInfoResult => Object.freeze({ kind: "UNAVAILABLE" as const, reason });
    const parsed = medicineInfoRequestSchema.safeParse({ task: MEDICINE_INFO_TASK, medicineName });
    if (!parsed.success) return unavailable("REQUEST_INVALID");
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort);
    try {
      if (signal?.aborted) return unavailable("CANCELLED");
      let response: Response;
      try {
        response = await fetcher(MEDICINE_INFO_ROUTE_PATH, {
          method: "POST",
          cache: "no-store",
          credentials: "same-origin",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(parsed.data),
          signal: controller.signal,
        });
      } catch {
        return unavailable(timedOut ? "TIMEOUT" : signal?.aborted ? "CANCELLED" : "OFFLINE");
      }
      let body: unknown;
      try {
        const text = await response.text();
        if (text.length > MAX_RESPONSE_CHARS) return unavailable("RESPONSE_INVALID");
        body = toPlainData(parseStrictJson(text, { maxDepth: 4, maxLength: MAX_RESPONSE_CHARS }));
      } catch {
        return unavailable(timedOut ? "TIMEOUT" : signal?.aborted ? "CANCELLED" : "RESPONSE_INVALID");
      }
      const route = medicineInfoRouteResponseSchema.safeParse(body);
      if (!route.success) return unavailable("RESPONSE_INVALID");
      if (route.data.kind === "UNAVAILABLE") return unavailable(route.data.reason);
      if (route.data.kind === "NOT_FOUND") return Object.freeze({ kind: "NO_RELIABLE_INFO" as const, reason: "NOT_FOUND" as const });
      if (route.data.kind === "REJECTED") return Object.freeze({ kind: "NO_RELIABLE_INFO" as const, reason: "REJECTED_BY_SERVER" as const });
      // The device validates the server-accepted information again before anything is shown or cached.
      const validation = validateMedicineGeneralInfo(route.data.info, medicineName);
      if (!validation.ok || validation.value.kind !== "OK") return Object.freeze({ kind: "NO_RELIABLE_INFO" as const, reason: "REJECTED_ON_DEVICE" as const });
      return Object.freeze({ kind: "OK" as const, info: validation.value.info, fetchedAt: now().toISOString(), source: "AI" as const });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  function noticeList(): string[] {
    const value = readJson(MEDICINE_INFO_NOTICE_KEY);
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  }

  return Object.freeze({
    async get(name, getOptions = {}) {
      const medicineName = toMedicineInfoName(name);
      if (medicineName === null) return Object.freeze({ kind: "UNAVAILABLE" as const, reason: "REQUEST_INVALID" as const });
      const entry = cachedEntry(medicineName);
      if (entry && !getOptions.refresh) return fromCache(entry);
      const result = await call(medicineName, getOptions.signal);
      if (result.kind === "OK") store(medicineName, { info: result.info, fetchedAt: result.fetchedAt });
      else if (result.kind === "NO_RELIABLE_INFO") store(medicineName, null);
      else if (entry) return fromCache(entry, result.reason);
      return result;
    },
    cached(name) {
      const medicineName = toMedicineInfoName(name);
      const entry = medicineName === null ? null : cachedEntry(medicineName);
      return entry ? fromCache(entry) : null;
    },
    noticeAccepted(name) {
      return noticeList().includes(normaliseMedicineInfoName(name));
    },
    acceptNotice(name) {
      const key = normaliseMedicineInfoName(name);
      const list = noticeList();
      if (!list.includes(key)) writeJson(MEDICINE_INFO_NOTICE_KEY, [...list, key].slice(-MEDICINE_INFO_CACHE_MAX_ENTRIES));
    },
  } satisfies MedicineInfoClient);
}
