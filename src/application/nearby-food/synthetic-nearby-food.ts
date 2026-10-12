import {
  applyNearbyFilters,
  distanceBetweenMetres,
  MAX_NEARBY_RESULTS,
  NO_FOOD_FILTERS,
  sortPlacesByDistance,
  type Coordinates,
  type CuisineGroup,
  type LocationResolution,
  type NearbyFoodDiscoveryPort,
  type NearbyFoodFilters,
  type NearbyFoodPlace,
  type NearbyFoodResult,
  type NearbyFoodSearchRequest,
  type VenueType,
} from "./nearby-food-contracts";

/**
 * Deterministic synthetic nearby-food adapter: the offline/test fallback.
 * Every place is invented (owner decision 2026-10-12: names carry no "(demo)" suffix), carries no governed attribute and
 * is labelled as a synthetic fixture. It never masquerades as live data.
 */

export const SYNTHETIC_FIXTURE_VERSION = "synthetic-nearby-food.1";

/** Fictional demo origin; not a real person's location. */
export const SYNTHETIC_ORIGIN: Coordinates = Object.freeze({ latitude: 1.3, longitude: 103.85 });

const METRES_PER_DEGREE_LATITUDE = 111_195;

type FixtureVenue = {
  id: string;
  name: string;
  cuisine: string;
  cuisineGroups: readonly CuisineGroup[];
  venueType: VenueType;
  distanceMetres: number;
  address: string;
};

const FIXTURES: readonly FixtureVenue[] = Object.freeze([
  { id: "venue-001", name: "Kampong Jelutong Food Centre", cuisine: "Chinese & Malay stalls", cuisineGroups: ["CHINESE", "MALAY"], venueType: "HAWKER_CENTRE", distanceMetres: 180, address: "Blk 18, Jelutong Estate (synthetic)" },
  { id: "venue-002", name: "Blk 412 Coffee Shop", cuisine: "Chinese", cuisineGroups: ["CHINESE"], venueType: "COFFEE_SHOP", distanceMetres: 350, address: "Blk 412 Jalan Seroja (synthetic)" },
  { id: "venue-003", name: "Tanjong Seroja Market", cuisine: "Malay & Indian", cuisineGroups: ["MALAY", "INDIAN"], venueType: "MARKET", distanceMetres: 620, address: "Tanjong Seroja (synthetic)" },
  { id: "venue-004", name: "Seroja Lane Eating House", cuisine: "Indian", cuisineGroups: ["INDIAN"], venueType: "COFFEE_SHOP", distanceMetres: 760, address: "8 Seroja Lane (synthetic)" },
  { id: "venue-005", name: "Jelutong Garden Food Court", cuisine: "Chinese & Western", cuisineGroups: ["CHINESE", "WESTERN"], venueType: "FOOD_COURT", distanceMetres: 1200, address: "Jelutong Garden (synthetic)" },
]);

/** Fixture places placed due north of the synthetic origin at their fixture distance. */
export const SYNTHETIC_PLACES: readonly NearbyFoodPlace[] = Object.freeze(
  FIXTURES.map((venue) =>
    Object.freeze({
      id: venue.id,
      name: venue.name,
      address: venue.address,
      coordinates: Object.freeze({
        latitude: SYNTHETIC_ORIGIN.latitude + venue.distanceMetres / METRES_PER_DEGREE_LATITUDE,
        longitude: SYNTHETIC_ORIGIN.longitude,
      }),
      distanceMetres: venue.distanceMetres,
      cuisineLabels: Object.freeze([venue.cuisine]) as string[],
      cuisineGroups: Object.freeze([...venue.cuisineGroups]) as CuisineGroup[],
      venueType: venue.venueType,
      venueSource: Object.freeze({ kind: "SYNTHETIC_FIXTURE" as const, fixtureVersion: SYNTHETIC_FIXTURE_VERSION }),
      governedAttributes: Object.freeze([]) as never[],
      evidenceSource: null,
    }) as NearbyFoodPlace,
  ),
);

/** The demo snapshot date shown for the synthetic offline state. */
export const SYNTHETIC_SNAPSHOT_DATE = "2026-09-15";

const SYNTHETIC_AREAS: readonly string[] = Object.freeze(["jelutong", "seroja", "kampong", "tanjong"]);

export function resolveSyntheticLocation(query: string): LocationResolution {
  const trimmed = query.trim();
  if (trimmed.length === 0) return { kind: "NOT_FOUND" };
  if (trimmed.length < 3) {
    return {
      kind: "AMBIGUOUS",
      candidates: [
        { label: "Jelutong Estate", coordinates: SYNTHETIC_ORIGIN },
        { label: "Seroja", coordinates: SYNTHETIC_ORIGIN },
      ],
    };
  }
  const lower = trimmed.toLowerCase();
  if (/^\d{6}$/.test(lower) || SYNTHETIC_AREAS.some((area) => lower.includes(area))) {
    return { kind: "RESOLVED", location: { label: trimmed, coordinates: SYNTHETIC_ORIGIN } };
  }
  return { kind: "NOT_FOUND" };
}

export function findSyntheticNearby(request: Pick<NearbyFoodSearchRequest, "origin" | "radiusMetres"> & { filters: NearbyFoodFilters }): NearbyFoodResult {
  const positioned = SYNTHETIC_PLACES.map((place) => ({ ...place, distanceMetres: distanceBetweenMetres(request.origin, place.coordinates) }));
  const within = positioned.filter((place) => place.distanceMetres <= request.radiusMetres);
  return {
    kind: "RESULTS",
    places: sortPlacesByDistance(applyNearbyFilters(within, request.filters)).slice(0, MAX_NEARBY_RESULTS),
    directory: { kind: "SYNTHETIC" },
  };
}

/** Synthetic-only profile: static demo map, synthetic geocoder and directory, no GPS. */
export function createSyntheticNearbyFood(options: { online?: () => boolean } = {}): NearbyFoodDiscoveryPort {
  return Object.freeze({
    profile: Object.freeze({ geocoder: "SYNTHETIC" as const, map: Object.freeze({ kind: "STATIC_DEMO" as const }), directory: "SYNTHETIC" as const }),
    async resolveManualLocation(query: string) {
      return resolveSyntheticLocation(query);
    },
    async acquireCurrentLocation() {
      // The synthetic profile never touches the browser location API.
      return { kind: "LOCATED" as const, coordinates: SYNTHETIC_ORIGIN };
    },
    async findNearby(request: NearbyFoodSearchRequest) {
      return findSyntheticNearby(request);
    },
    async findSyntheticFallback(filters: NearbyFoodFilters = NO_FOOD_FILTERS) {
      return findSyntheticNearby({ origin: SYNTHETIC_ORIGIN, radiusMetres: 2000, filters });
    },
    isOnline: options.online ?? (() => true),
  });
}
