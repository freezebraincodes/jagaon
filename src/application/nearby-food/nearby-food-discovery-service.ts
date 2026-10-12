import {
  nearbyFoodSearchRequestSchema,
  type GeocoderPort,
  type LocationAcquisitionPort,
  type LocationResolution,
  type MapProviderDescriptor,
  type NearbyFoodFilterOptions,
  type NearbyFoodDiscoveryPort,
  type NearbyFoodFilters,
  type NearbyFoodSearchRequest,
  type VenueDirectoryPort,
} from "./nearby-food-contracts";
import { SYNTHETIC_ORIGIN, findSyntheticNearby } from "./synthetic-nearby-food";

/**
 * Hybrid nearby-food discovery (Packet 9A Task 4): snapshot postal lookup
 * first (works offline), OneMap search through the same-origin route for
 * other text, the bundled HPB directory for venues, and an explicit,
 * clearly labelled synthetic fallback. No journal, storage or health
 * dependency exists here (LRJ-004).
 */
export function createNearbyFoodDiscoveryService(dependencies: {
  oneMapGeocoder: GeocoderPort;
  snapshotGeocoder: GeocoderPort;
  /** Owner decision 2026-10-12: offline name and address search over the snapshot, after OneMap. */
  snapshotTextGeocoder?: GeocoderPort;
  filterOptions?: NearbyFoodFilterOptions;
  location: LocationAcquisitionPort;
  directory: VenueDirectoryPort;
  map: MapProviderDescriptor;
  online: () => boolean;
}): NearbyFoodDiscoveryPort {
  return Object.freeze({
    profile: Object.freeze({
      geocoder: "ONEMAP_WITH_SNAPSHOT_POSTAL" as const,
      map: dependencies.map,
      directory: "HPB_SNAPSHOT" as const,
      ...(dependencies.filterOptions ? { filterOptions: dependencies.filterOptions } : {}),
    }),

    async resolveManualLocation(query: string, signal?: AbortSignal): Promise<LocationResolution> {
      const trimmed = query.trim();
      if (trimmed.length === 0) return { kind: "NOT_FOUND" };
      if (/^\d{6}$/.test(trimmed)) {
        const local = await dependencies.snapshotGeocoder.resolve(trimmed, signal);
        if (local.kind === "RESOLVED") return local;
      }
      const remote: LocationResolution = dependencies.online() ? await dependencies.oneMapGeocoder.resolve(trimmed, signal) : { kind: "UNAVAILABLE", reason: "OFFLINE" };
      if (remote.kind === "RESOLVED" || remote.kind === "AMBIGUOUS" || !dependencies.snapshotTextGeocoder || signal?.aborted) return remote;
      // OneMap not configured, unavailable or with no match: the bundled places' names and addresses, offline.
      const local = await dependencies.snapshotTextGeocoder.resolve(trimmed, signal);
      return local.kind === "RESOLVED" || local.kind === "AMBIGUOUS" ? local : remote;
    },

    acquireCurrentLocation(signal?: AbortSignal) {
      return dependencies.location.acquireOnce(signal);
    },

    async findNearby(request: NearbyFoodSearchRequest, signal?: AbortSignal) {
      // Strict parse: no health, medication, symptom or patient field can pass.
      return dependencies.directory.findNearby(nearbyFoodSearchRequestSchema.parse(request), signal);
    },

    async findSyntheticFallback(filters: NearbyFoodFilters) {
      return findSyntheticNearby({ origin: SYNTHETIC_ORIGIN, radiusMetres: 2000, filters });
    },

    isOnline: () => dependencies.online(),
  });
}
