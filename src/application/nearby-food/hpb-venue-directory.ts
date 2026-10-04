import { sha256Hex } from "@/application/intelligence/metrics";
import {
  MAX_NEARBY_RESULTS,
  applyNearbyFilters,
  nearbyFoodSearchRequestSchema,
  sortPlacesByDistance,
  type GeocoderPort,
  type GovernedDatasetDescriptor,
  type LocationResolution,
  type NearbyFoodResult,
  type NearbyFoodSearchRequest,
  type VenueDirectoryPort,
} from "./nearby-food-contracts";
import { HPB_SNAPSHOT_VERSION, hpbNearbyFoodSnapshotSchema, placesFromSnapshot, type HpbNearbyFoodSnapshotV1 } from "./hpb-snapshot-schema";

/**
 * Bundled HPB/data.gov.sg venue directory (Packet 9A Task 4). The snapshot is
 * accepted only when its bytes match the pinned manifest checksum and it
 * passes the strict schema; otherwise the directory is unavailable and no
 * venue is invented.
 */

/** SHA-256 of `public/data/hpb-nearby-food-v1.json`, from its manifest. */
export const HPB_SNAPSHOT_SHA256 = "773138dd584a62f47197d9ef8861c803232847da680947bbccce12533e9e333f";

export const HPB_SNAPSHOT_PATH = "/data/hpb-nearby-food-v1.json";

export const HPB_SNAPSHOT_DESCRIPTOR: GovernedDatasetDescriptor = Object.freeze({
  kind: "HPB_SNAPSHOT",
  snapshotVersion: HPB_SNAPSHOT_VERSION,
  criteriaDatasetDate: "2026-10-02",
  coordinatesDatasetDate: "2026-01-04",
  licenceUrl: "https://data.gov.sg/open-data-licence",
});

type SnapshotLoad = { kind: "READY"; snapshot: HpbNearbyFoodSnapshotV1 } | { kind: "UNAVAILABLE" } | { kind: "INVALID" };

/** Loads, verifies and caches the snapshot once per loader. */
function createSnapshotSource(loadText: () => Promise<string>) {
  let pending: Promise<SnapshotLoad> | null = null;
  return function load(): Promise<SnapshotLoad> {
    pending ??= (async (): Promise<SnapshotLoad> => {
      let text: string;
      try {
        text = await loadText();
      } catch {
        return { kind: "UNAVAILABLE" };
      }
      if (sha256Hex(text) !== HPB_SNAPSHOT_SHA256) return { kind: "INVALID" };
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return { kind: "INVALID" };
      }
      const parsed = hpbNearbyFoodSnapshotSchema.safeParse(json);
      if (!parsed.success) return { kind: "INVALID" };
      const snapshot = parsed.data;
      if (snapshot.criteriaDatasetDate !== HPB_SNAPSHOT_DESCRIPTOR.criteriaDatasetDate || snapshot.coordinatesDatasetDate !== HPB_SNAPSHOT_DESCRIPTOR.coordinatesDatasetDate) {
        return { kind: "INVALID" };
      }
      return { kind: "READY", snapshot };
    })().then((result) => {
      // A transient load failure may be retried by a later search.
      if (result.kind === "UNAVAILABLE") pending = null;
      return result;
    });
    return pending;
  };
}

export function createHpbVenueDirectory(loadText: () => Promise<string>): VenueDirectoryPort {
  const load = createSnapshotSource(loadText);
  return Object.freeze({
    descriptor: HPB_SNAPSHOT_DESCRIPTOR,
    async findNearby(request: NearbyFoodSearchRequest): Promise<NearbyFoodResult> {
      const valid = nearbyFoodSearchRequestSchema.parse(request);
      const loaded = await load();
      if (loaded.kind === "UNAVAILABLE") return { kind: "UNAVAILABLE", reason: "SNAPSHOT_UNAVAILABLE" };
      if (loaded.kind === "INVALID") return { kind: "UNAVAILABLE", reason: "SNAPSHOT_INVALID" };
      const within = placesFromSnapshot(loaded.snapshot, valid.origin).filter((place) => place.distanceMetres <= valid.radiusMetres);
      return {
        kind: "RESULTS",
        places: sortPlacesByDistance(applyNearbyFilters(within, valid.filters)).slice(0, MAX_NEARBY_RESULTS),
        directory: HPB_SNAPSHOT_DESCRIPTOR,
      };
    },
  });
}

/**
 * Offline postal-code geocoder backed by the same verified snapshot: a
 * 6-digit code resolves only when a governed venue lists it.
 */
export function createSnapshotPostalGeocoder(loadText: () => Promise<string>): GeocoderPort {
  const load = createSnapshotSource(loadText);
  let index: Map<string, { latitude: number; longitude: number }> | null = null;
  return Object.freeze({
    providerId: "SNAPSHOT_POSTAL" as const,
    async resolve(query: string): Promise<LocationResolution> {
      const postal = query.trim();
      if (!/^\d{6}$/.test(postal)) return { kind: "NOT_FOUND" };
      const loaded = await load();
      if (loaded.kind !== "READY") return { kind: "NOT_FOUND" };
      if (!index) {
        index = new Map();
        for (const venue of loaded.snapshot.venues) {
          const match = /Singapore (\d{6})$/.exec(venue.address);
          // The first venue (lowest dataset id) at a postal code is its point.
          if (match && !index.has(match[1]!)) index.set(match[1]!, { latitude: venue.latitude, longitude: venue.longitude });
        }
      }
      const coordinates = index.get(postal);
      return coordinates ? { kind: "RESOLVED", location: { label: postal, coordinates } } : { kind: "NOT_FOUND" };
    },
  });
}
