import { describe, expect, it, vi } from "vitest";
import { NO_FOOD_FILTERS, type GeocoderPort, type LocationResolution, type VenueDirectoryPort } from "./nearby-food-contracts";
import { createNearbyFoodDiscoveryService } from "./nearby-food-discovery-service";
import { ONEMAP_TILE_DESCRIPTOR } from "./browser-map-descriptor";
import { HPB_SNAPSHOT_DESCRIPTOR } from "./hpb-venue-directory";

const ORIGIN = { latitude: 1.3, longitude: 103.85 };
const geocoder = (providerId: GeocoderPort["providerId"], answer: LocationResolution): GeocoderPort & { resolve: ReturnType<typeof vi.fn> } => ({
  providerId,
  resolve: vi.fn(async () => answer),
});
const directory = (): VenueDirectoryPort & { findNearby: ReturnType<typeof vi.fn> } => ({
  descriptor: HPB_SNAPSHOT_DESCRIPTOR,
  findNearby: vi.fn(async () => ({ kind: "RESULTS" as const, places: [], directory: HPB_SNAPSHOT_DESCRIPTOR })),
});

function service(overrides: { oneMap?: GeocoderPort; postal?: GeocoderPort; online?: boolean; dir?: VenueDirectoryPort } = {}) {
  return createNearbyFoodDiscoveryService({
    oneMapGeocoder: overrides.oneMap ?? geocoder("ONEMAP", { kind: "UNAVAILABLE", reason: "NOT_CONFIGURED" }),
    snapshotGeocoder: overrides.postal ?? geocoder("SNAPSHOT_POSTAL", { kind: "NOT_FOUND" }),
    location: { acquireOnce: vi.fn(async () => ({ kind: "DENIED" as const })) },
    directory: overrides.dir ?? directory(),
    map: ONEMAP_TILE_DESCRIPTOR,
    online: () => overrides.online ?? true,
  });
}

describe("hybrid nearby-food discovery service", () => {
  it("describes the hybrid profile without exposing provider payloads", () => {
    expect(service().profile).toEqual({ geocoder: "ONEMAP_WITH_SNAPSHOT_POSTAL", map: ONEMAP_TILE_DESCRIPTOR, directory: "HPB_SNAPSHOT" });
  });

  it("resolves a postal code from the bundled snapshot before any network call", async () => {
    const oneMap = geocoder("ONEMAP", { kind: "NOT_FOUND" });
    const postal = geocoder("SNAPSHOT_POSTAL", { kind: "RESOLVED", location: { label: "238859", coordinates: ORIGIN } });
    expect(await service({ oneMap, postal }).resolveManualLocation(" 238859 ")).toMatchObject({ kind: "RESOLVED" });
    expect(oneMap.resolve).not.toHaveBeenCalled();
  });

  it("uses OneMap for other text and reports a missing token honestly instead of guessing", async () => {
    const result = await service().resolveManualLocation("Toa Payoh");
    expect(result).toEqual({ kind: "UNAVAILABLE", reason: "NOT_CONFIGURED" });
    const live = geocoder("ONEMAP", { kind: "AMBIGUOUS", candidates: [{ label: "A", coordinates: ORIGIN }, { label: "B", coordinates: ORIGIN }] });
    expect((await service({ oneMap: live }).resolveManualLocation("Toa Payoh")).kind).toBe("AMBIGUOUS");
  });

  it("falls through to OneMap for a postal code missing from the snapshot, and stays offline-honest", async () => {
    const oneMap = geocoder("ONEMAP", { kind: "RESOLVED", location: { label: "1 X ROAD SINGAPORE 200640", coordinates: ORIGIN } });
    expect((await service({ oneMap }).resolveManualLocation("200640")).kind).toBe("RESOLVED");
    const offline = service({ oneMap, online: false });
    expect(await offline.resolveManualLocation("Toa Payoh")).toEqual({ kind: "UNAVAILABLE", reason: "OFFLINE" });
    expect(await offline.resolveManualLocation("200640")).toEqual({ kind: "UNAVAILABLE", reason: "OFFLINE" });
    expect(await offline.resolveManualLocation("")).toEqual({ kind: "NOT_FOUND" });
  });

  it("passes only the strict request to the directory and rejects health-shaped fields", async () => {
    const dir = directory();
    const port = service({ dir });
    await port.findNearby({ origin: ORIGIN, radiusMetres: 2000, filters: NO_FOOD_FILTERS });
    expect(dir.findNearby).toHaveBeenCalledWith({ origin: ORIGIN, radiusMetres: 2000, filters: NO_FOOD_FILTERS }, undefined);
    await expect(port.findNearby({ origin: ORIGIN, radiusMetres: 2000, filters: NO_FOOD_FILTERS, glucose: "7.0" } as never)).rejects.toThrow();
  });

  it("keeps a clearly labelled synthetic fallback separate from live results", async () => {
    const fallback = await service().findSyntheticFallback(NO_FOOD_FILTERS);
    if (fallback.kind !== "RESULTS") throw new Error("expected results");
    expect(fallback.directory).toEqual({ kind: "SYNTHETIC" });
    expect(fallback.places.every((place) => place.venueSource.kind === "SYNTHETIC_FIXTURE" && place.governedAttributes.length === 0)).toBe(true);
  });

  it("asks for the current location only through the injected port", async () => {
    const acquireOnce = vi.fn(async () => ({ kind: "TIMEOUT" as const }));
    const port = createNearbyFoodDiscoveryService({
      oneMapGeocoder: geocoder("ONEMAP", { kind: "NOT_FOUND" }),
      snapshotGeocoder: geocoder("SNAPSHOT_POSTAL", { kind: "NOT_FOUND" }),
      location: { acquireOnce },
      directory: directory(),
      map: ONEMAP_TILE_DESCRIPTOR,
      online: () => true,
    });
    expect(acquireOnce).not.toHaveBeenCalled();
    expect(await port.acquireCurrentLocation()).toEqual({ kind: "TIMEOUT" });
    expect(acquireOnce).toHaveBeenCalledTimes(1);
  });
});
