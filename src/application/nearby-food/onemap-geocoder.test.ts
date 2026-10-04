import { describe, expect, it, vi } from "vitest";
import { createOneMapGeocoder } from "./onemap-geocoder";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("OneMap geocoder adapter (same-origin route)", () => {
  it("sends only the query to the same-origin route and validates the normalised answer", async () => {
    const fetcher = vi.fn(async () => json({ kind: "RESOLVED", location: { label: "640 ROWELL ROAD SINGAPORE 200640", coordinates: { latitude: 1.307435, longitude: 103.854714 } } }));
    const geocoder = createOneMapGeocoder(fetcher, "/api/onemap/search");
    expect(geocoder.providerId).toBe("ONEMAP");
    expect(await geocoder.resolve("200640")).toMatchObject({ kind: "RESOLVED" });
    expect(fetcher).toHaveBeenCalledWith("/api/onemap/search?q=200640", expect.objectContaining({ method: "GET", cache: "no-store" }));
  });

  it("passes NOT_CONFIGURED through and treats an unreadable answer as unavailable", async () => {
    expect(await createOneMapGeocoder(async () => json({ kind: "UNAVAILABLE", reason: "NOT_CONFIGURED" }), "/x").resolve("a b c")).toEqual({
      kind: "UNAVAILABLE",
      reason: "NOT_CONFIGURED",
    });
    expect(await createOneMapGeocoder(async () => json({ kind: "RESOLVED", location: { label: "x", coordinates: { latitude: 99, longitude: 0 } } }), "/x").resolve("abc")).toEqual({
      kind: "UNAVAILABLE",
      reason: "UPSTREAM_ERROR",
    });
    expect(await createOneMapGeocoder(async () => Promise.reject(new TypeError("Failed to fetch")), "/x").resolve("abc")).toEqual({
      kind: "UNAVAILABLE",
      reason: "OFFLINE",
    });
  });

  it("propagates a caller abort instead of reporting a result", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      return json({ kind: "NOT_FOUND" });
    });
    await expect(createOneMapGeocoder(fetcher, "/x").resolve("abc", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
