import { describe, expect, it, vi } from "vitest";
import { MEDICINE_INFO_DIRECTIONS_SENTENCE } from "@/domain/medicine-info/medicine-info-validator";
import { MEDICINE_INFO_CACHE_KEY, MEDICINE_INFO_NOTICE_KEY, createMedicineInfoClient } from "./medicine-info-client";

/**
 * HSA preview (owner decision 2026-10-14): the browser client of /api/ai/medicine-info with a fake fetcher and an in-memory storage (no
 * network, no live call). Synthetic names and text only.
 */

const USED_FOR = "Metformin is a medicine used to help control blood sugar in people with type 2 diabetes.";
const HOW_TAKEN = `It is generally taken by mouth with or after meals. ${MEDICINE_INFO_DIRECTIONS_SENTENCE}`;
const INFO = { name: "Metformin", genericName: null, usedFor: USED_FOR, howGenerallyTaken: HOW_TAKEN };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const AT = new Date("2026-10-14T03:00:00.000Z");

function memoryStorage() {
  const map = new Map<string, string>();
  return { map, getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => void map.set(key, value) };
}

function client(respond: (input: string, init: RequestInit) => Response | Promise<Response>, options: { storage?: ReturnType<typeof memoryStorage> | null; timeoutMs?: number } = {}) {
  const calls: { input: string; init: RequestInit }[] = [];
  const storage = options.storage === undefined ? memoryStorage() : options.storage;
  const instance = createMedicineInfoClient({ fetcher: async (input, init) => (calls.push({ input, init }), respond(input, init)), storage, now: () => AT, timeoutMs: options.timeoutMs });
  return { instance, calls, storage };
}

describe("medicine-info client", () => {
  it("OK: posts once to the same-origin route with only { task, medicineName }, validates again, caches with fetchedAt", async () => {
    const { instance, calls, storage } = client(() => json({ kind: "OK", info: INFO }));
    expect(await instance.get("  Metformin ")).toEqual({ kind: "OK", info: INFO, fetchedAt: AT.toISOString(), source: "AI" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toBe("/api/ai/medicine-info");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ task: "MEDICINE_GENERAL_INFO", medicineName: "Metformin" });
    expect(JSON.parse(storage!.map.get(MEDICINE_INFO_CACHE_KEY)!)).toEqual({ metformin: { info: INFO, fetchedAt: AT.toISOString() } });
  });

  it("cache hit: a second get (any case or spacing) sends nothing and returns the cached entry", async () => {
    const { instance, calls } = client(() => json({ kind: "OK", info: INFO }));
    await instance.get("Metformin");
    expect(await instance.get("metformin")).toMatchObject({ kind: "OK", source: "CACHE" });
    expect(instance.cached("Metformin")).toMatchObject({ kind: "OK", info: INFO, fetchedAt: AT.toISOString(), source: "CACHE" });
    expect(calls).toHaveLength(1);
  });

  it("refresh bypasses the cache and replaces the entry", async () => {
    const fresher = { ...INFO, usedFor: "Metformin is a medicine used to help control blood sugar in adults with type 2 diabetes." };
    const replies = [() => json({ kind: "OK", info: INFO }), () => json({ kind: "OK", info: fresher })];
    let index = 0;
    const { instance, calls } = client(() => replies[index++]!());
    await instance.get("Metformin");
    expect(await instance.get("Metformin", { refresh: true })).toMatchObject({ kind: "OK", source: "AI", info: fresher });
    expect(calls).toHaveLength(2);
    expect(instance.cached("Metformin")?.info).toEqual(fresher);
  });

  it("fallback: an unavailable refresh keeps showing the cached entry and says the refresh failed", async () => {
    const replies = [() => json({ kind: "OK", info: INFO }), () => Promise.reject(new TypeError("Failed to fetch"))];
    let index = 0;
    const { instance } = client(() => replies[index++]!());
    await instance.get("Metformin");
    expect(await instance.get("Metformin", { refresh: true })).toEqual({ kind: "OK", info: INFO, fetchedAt: AT.toISOString(), source: "CACHE", refreshFailed: "OFFLINE" });
  });

  it("a refresh that finds no reliable information forgets the earlier entry", async () => {
    const replies = [() => json({ kind: "OK", info: INFO }), () => json({ kind: "NOT_FOUND" })];
    let index = 0;
    const { instance } = client(() => replies[index++]!());
    await instance.get("Metformin");
    expect(await instance.get("Metformin", { refresh: true })).toEqual({ kind: "NO_RELIABLE_INFO", reason: "NOT_FOUND" });
    expect(instance.cached("Metformin")).toBeNull();
  });

  it.each<[string, () => Response | Promise<Response>, unknown]>([
    ["NOT_FOUND", () => json({ kind: "NOT_FOUND" }), { kind: "NO_RELIABLE_INFO", reason: "NOT_FOUND" }],
    ["the server's validator rejecting", () => json({ kind: "REJECTED", reasons: ["DOSE_AMOUNT"] }), { kind: "NO_RELIABLE_INFO", reason: "REJECTED_BY_SERVER" }],
    ["an OK answer the device's rules reject", () => json({ kind: "OK", info: { ...INFO, usedFor: "Metformin cures diabetes in most adults who take it." } }), { kind: "NO_RELIABLE_INFO", reason: "REJECTED_ON_DEVICE" }],
    ["an OK answer for another name", () => json({ kind: "OK", info: { ...INFO, name: "Lantus" } }), { kind: "NO_RELIABLE_INFO", reason: "REJECTED_ON_DEVICE" }],
    ["the network failing (offline)", () => Promise.reject(new TypeError("Failed to fetch")), { kind: "UNAVAILABLE", reason: "OFFLINE" }],
    ["the AI switched off", () => json({ kind: "UNAVAILABLE", reason: "DISABLED" }, 403), { kind: "UNAVAILABLE", reason: "DISABLED" }],
    ["the daily spend limit used up", () => json({ kind: "UNAVAILABLE", reason: "SPEND_CEILING_REACHED" }, 403), { kind: "UNAVAILABLE", reason: "SPEND_CEILING_REACHED" }],
    ["a non-JSON body", () => new Response("<html>oops</html>", { status: 502 }), { kind: "UNAVAILABLE", reason: "RESPONSE_INVALID" }],
    ["an unexpected shape", () => json({ kind: "OK", info: { ...INFO, extra: true } }), { kind: "UNAVAILABLE", reason: "RESPONSE_INVALID" }],
  ])("%s → %j, nothing cached", async (_name, respond, expected) => {
    const { instance, storage } = client(respond);
    expect(await instance.get("Metformin")).toEqual(expected);
    expect(JSON.parse(storage!.map.get(MEDICINE_INFO_CACHE_KEY) ?? "{}")).toEqual({});
  });

  it("an invalid name is never sent", async () => {
    const { instance, calls } = client(() => json({ kind: "OK", info: INFO }));
    expect(await instance.get("Metformin/Glucophage")).toEqual({ kind: "UNAVAILABLE", reason: "REQUEST_INVALID" });
    expect(await instance.get("")).toEqual({ kind: "UNAVAILABLE", reason: "REQUEST_INVALID" });
    expect(calls).toHaveLength(0);
  });

  it("times out on its own (TIMEOUT); a cancelled lookup is CANCELLED", async () => {
    const hanging = (_input: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    const { instance } = client(hanging, { timeoutMs: 10 });
    expect(await instance.get("Metformin")).toEqual({ kind: "UNAVAILABLE", reason: "TIMEOUT" });
    const { instance: other } = client(hanging);
    const controller = new AbortController();
    const pending = other.get("Metformin", { signal: controller.signal });
    controller.abort();
    expect(await pending).toEqual({ kind: "UNAVAILABLE", reason: "CANCELLED" });
  });

  it("re-validates a cached entry: a tampered or malformed entry is ignored and the route is asked", async () => {
    const storage = memoryStorage();
    storage.map.set(MEDICINE_INFO_CACHE_KEY, JSON.stringify({ metformin: { info: { ...INFO, usedFor: "Take 500 mg twice a day with food." }, fetchedAt: AT.toISOString() } }));
    const { instance, calls } = client(() => json({ kind: "OK", info: INFO }), { storage });
    expect(instance.cached("Metformin")).toBeNull();
    expect(await instance.get("Metformin")).toMatchObject({ kind: "OK", source: "AI" });
    expect(calls).toHaveLength(1);
    storage.map.set(MEDICINE_INFO_CACHE_KEY, "{not json");
    expect(instance.cached("Metformin")).toBeNull();
  });

  it("remembers the one-time notice per normalised medicine name", () => {
    const { instance, storage } = client(() => json({ kind: "NOT_FOUND" }));
    expect(instance.noticeAccepted("Metformin")).toBe(false);
    instance.acceptNotice(" Metformin ");
    instance.acceptNotice("metformin");
    expect(instance.noticeAccepted("METFORMIN")).toBe(true);
    expect(instance.noticeAccepted("Lantus")).toBe(false);
    expect(JSON.parse(storage!.map.get(MEDICINE_INFO_NOTICE_KEY)!)).toEqual(["metformin"]);
  });

  it("works without storage, and with storage that throws (no cache, still answers)", async () => {
    const { instance, calls } = client(() => json({ kind: "OK", info: INFO }), { storage: null });
    expect(await instance.get("Metformin")).toMatchObject({ kind: "OK", source: "AI" });
    expect(await instance.get("Metformin")).toMatchObject({ kind: "OK", source: "AI" });
    expect(calls).toHaveLength(2);
    const throwing = { map: new Map<string, string>(), getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    const broken = client(() => json({ kind: "OK", info: INFO }), { storage: throwing });
    expect(await broken.instance.get("Metformin")).toMatchObject({ kind: "OK" });
    broken.instance.acceptNotice("Metformin");
    expect(broken.instance.noticeAccepted("Metformin")).toBe(false);
  });

  it("falls back to globalThis.localStorage, guarded", async () => {
    vi.stubGlobal("localStorage", undefined);
    const instance = createMedicineInfoClient({ fetcher: async () => json({ kind: "OK", info: INFO }) });
    expect(await instance.get("Metformin")).toMatchObject({ kind: "OK", source: "AI" });
    vi.unstubAllGlobals();
  });

  it("never logs", async () => {
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn")];
    const { instance } = client(() => json({ kind: "OK", info: { ...INFO, usedFor: "Metformin cures diabetes in most adults." } }));
    await instance.get("Metformin");
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
