import { describe, expect, it, vi } from "vitest";
import { createBrowserGpsAdapter, createBrowserNearbyFood } from "./browser-nearby-food";

type Success = (position: { coords: { latitude: number; longitude: number } }) => void;
type Failure = (error: { code: number }) => void;

function geolocation() {
  const calls: Array<{ success: Success; failure: Failure; options: PositionOptions }> = [];
  return {
    calls,
    api: {
      getCurrentPosition: vi.fn((success: Success, failure: Failure, options: PositionOptions) => calls.push({ success, failure, options })),
    },
  };
}

describe("browser one-time GPS adapter", () => {
  it("asks the browser once, without caching, only when called", async () => {
    const geo = geolocation();
    const adapter = createBrowserGpsAdapter(() => geo.api);
    expect(geo.api.getCurrentPosition).not.toHaveBeenCalled();
    const pending = adapter.acquireOnce();
    expect(geo.calls[0]!.options).toEqual({ enableHighAccuracy: false, maximumAge: 0, timeout: 15000 });
    geo.calls[0]!.success({ coords: { latitude: 1.3, longitude: 103.85 } });
    expect(await pending).toEqual({ kind: "LOCATED", coordinates: { latitude: 1.3, longitude: 103.85 } });
  });

  it("maps denial, timeout and unavailability, and an absent API, to explicit outcomes", async () => {
    for (const [code, kind] of [
      [1, "DENIED"],
      [3, "TIMEOUT"],
      [2, "UNAVAILABLE"],
    ] as const) {
      const geo = geolocation();
      const pending = createBrowserGpsAdapter(() => geo.api).acquireOnce();
      geo.calls[0]!.failure({ code });
      expect(await pending).toEqual({ kind });
    }
    expect(await createBrowserGpsAdapter(() => undefined).acquireOnce()).toEqual({ kind: "UNAVAILABLE" });
  });

  it("stops listening on abort and ignores a late browser answer", async () => {
    const geo = geolocation();
    const controller = new AbortController();
    const pending = createBrowserGpsAdapter(() => geo.api).acquireOnce(controller.signal);
    controller.abort();
    expect(await pending).toEqual({ kind: "CANCELLED" });
    geo.calls[0]!.success({ coords: { latitude: 1.3, longitude: 103.85 } });
  });

  it("rejects an invalid browser coordinate as unavailable", async () => {
    const geo = geolocation();
    const pending = createBrowserGpsAdapter(() => geo.api).acquireOnce();
    geo.calls[0]!.success({ coords: { latitude: Number.NaN, longitude: 103.85 } });
    expect(await pending).toEqual({ kind: "UNAVAILABLE" });
  });
});

describe("browser composition root", () => {
  it("fetches only the same-origin snapshot and search route", async () => {
    const fetcher = vi.fn(async (input: string) => (input.startsWith("/api/") ? new Response(JSON.stringify({ kind: "UNAVAILABLE", reason: "NOT_CONFIGURED" }), { status: 503 }) : new Response("not json")));
    const port = createBrowserNearbyFood({ fetcher, geolocation: () => undefined, online: () => true });
    expect(port.profile.directory).toBe("HPB_SNAPSHOT");
    expect(await port.resolveManualLocation("Toa Payoh")).toEqual({ kind: "UNAVAILABLE", reason: "NOT_CONFIGURED" });
    expect(await port.resolveManualLocation("238859")).toEqual({ kind: "UNAVAILABLE", reason: "NOT_CONFIGURED" });
    for (const [url] of fetcher.mock.calls) expect(url).toMatch(/^\/(api\/onemap\/search\?q=|data\/hpb-nearby-food-v1\.json$)/);
  });
});
