import {
  coordinatesSchema,
  type CurrentLocationOutcome,
  type LocationAcquisitionPort,
  type NearbyFoodDiscoveryPort,
} from "./nearby-food-contracts";
import { ONEMAP_TILE_DESCRIPTOR } from "./browser-map-descriptor";
import { HPB_SNAPSHOT_PATH, createHpbVenueDirectory, createSnapshotPostalGeocoder } from "./hpb-venue-directory";
import { createNearbyFoodDiscoveryService } from "./nearby-food-discovery-service";
import { createOneMapGeocoder } from "./onemap-geocoder";

/**
 * Browser composition root for nearby-food discovery (Packet 9A). It receives
 * only fetch, geolocation and online-state ports: no database, journal or
 * health dependency can reach a provider request. Coordinates live only in
 * memory for the active search.
 */

type GeolocationLike = Pick<Geolocation, "getCurrentPosition">;
type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

const GPS_OPTIONS: PositionOptions = Object.freeze({ enableHighAccuracy: false, maximumAge: 0, timeout: 15_000 });

/** One-time browser location, requested only when called after a person's action. */
export function createBrowserGpsAdapter(geolocation: () => GeolocationLike | undefined): LocationAcquisitionPort {
  return Object.freeze({
    acquireOnce(signal?: AbortSignal): Promise<CurrentLocationOutcome> {
      const api = geolocation();
      if (!api) return Promise.resolve({ kind: "UNAVAILABLE" });
      if (signal?.aborted) return Promise.resolve({ kind: "CANCELLED" });
      return new Promise<CurrentLocationOutcome>((resolve) => {
        let settled = false;
        const settle = (outcome: CurrentLocationOutcome) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          resolve(outcome);
        };
        const onAbort = () => settle({ kind: "CANCELLED" });
        signal?.addEventListener("abort", onAbort, { once: true });
        api.getCurrentPosition(
          (position) => {
            const parsed = coordinatesSchema.safeParse({ latitude: position.coords.latitude, longitude: position.coords.longitude });
            settle(parsed.success ? { kind: "LOCATED", coordinates: parsed.data } : { kind: "UNAVAILABLE" });
          },
          (error) => settle(error.code === 1 ? { kind: "DENIED" } : error.code === 3 ? { kind: "TIMEOUT" } : { kind: "UNAVAILABLE" }),
          GPS_OPTIONS,
        );
      });
    },
  });
}

export function createBrowserNearbyFood(
  options: {
    fetcher?: Fetcher;
    geolocation?: () => GeolocationLike | undefined;
    online?: () => boolean;
  } = {},
): NearbyFoodDiscoveryPort {
  const fetcher: Fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
  // One shared request for the directory and the offline postal lookup.
  let snapshotText: Promise<string> | null = null;
  const loadSnapshot = () =>
    (snapshotText ??= fetcher(HPB_SNAPSHOT_PATH, { method: "GET", cache: "force-cache" })
      .then((response) => {
        if (!response.ok) throw new Error("SNAPSHOT_UNAVAILABLE");
        return response.text();
      })
      .catch((error: unknown) => {
        snapshotText = null;
        throw error;
      }));
  return createNearbyFoodDiscoveryService({
    oneMapGeocoder: createOneMapGeocoder((input, init) => fetcher(input, init), "/api/onemap/search"),
    snapshotGeocoder: createSnapshotPostalGeocoder(loadSnapshot),
    location: createBrowserGpsAdapter(options.geolocation ?? (() => (typeof navigator === "undefined" ? undefined : navigator.geolocation))),
    directory: createHpbVenueDirectory(loadSnapshot),
    map: ONEMAP_TILE_DESCRIPTOR,
    online: options.online ?? (() => (typeof navigator === "undefined" ? true : navigator.onLine)),
  });
}
