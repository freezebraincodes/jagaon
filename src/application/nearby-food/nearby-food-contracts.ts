import { z } from "zod";

/**
 * Provider-neutral nearby-food contracts (Packet 9A; provider-neutral
 * nearby-food design Sections 3–5). Screen 07 consumes only these normalised
 * shapes. Provider payloads, credentials and identifiers stay inside adapters.
 *
 * Nothing here accepts a health, medication, symptom, adherence or patient
 * field: the search request is strict and closed (LRJ-004).
 */

// --- Coordinates and distance ----------------------------------------------------------------

export const coordinatesSchema = z.strictObject({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
});

export type Coordinates = z.infer<typeof coordinatesSchema>;

/** Inclusive Singapore bounding box used to reject out-of-area provider results. */
export const SINGAPORE_BOUNDS = Object.freeze({ south: 1.13, north: 1.48, west: 103.59, east: 104.1 });

export function isWithinSingapore(point: Coordinates): boolean {
  return (
    point.latitude >= SINGAPORE_BOUNDS.south &&
    point.latitude <= SINGAPORE_BOUNDS.north &&
    point.longitude >= SINGAPORE_BOUNDS.west &&
    point.longitude <= SINGAPORE_BOUNDS.east
  );
}

const EARTH_RADIUS_METRES = 6_371_008.8;
const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

/** Great-circle (haversine) distance in whole metres; symmetric and antimeridian-safe. */
export function distanceBetweenMetres(a: Coordinates, b: Coordinates): number {
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(a.latitude)) * Math.cos(toRadians(b.latitude)) * Math.sin(dLon / 2) ** 2;
  const metres = 2 * EARTH_RADIUS_METRES * Math.asin(Math.min(1, Math.sqrt(h)));
  return Number.isFinite(metres) ? Math.round(metres) : Number.MAX_SAFE_INTEGER;
}

// --- User filters -----------------------------------------------------------------------------

export const VENUE_TYPES = Object.freeze(["HAWKER_CENTRE", "COFFEE_SHOP", "MARKET", "FOOD_COURT"] as const);
export type VenueType = (typeof VENUE_TYPES)[number];

export const CUISINE_GROUPS = Object.freeze(["CHINESE", "MALAY", "INDIAN", "WESTERN"] as const);
export type CuisineGroup = (typeof CUISINE_GROUPS)[number];

/** The three approved, filterable governed attributes (copy-matrix labels). */
export const FILTERABLE_FOOD_ATTRIBUTES = Object.freeze(["HIGHER_IN_WHOLEGRAINS", "LOWER_IN_SUGAR", "LOWER_IN_CALORIES"] as const);
export type FilterableFoodAttribute = (typeof FILTERABLE_FOOD_ATTRIBUTES)[number];

export const DISTANCE_FILTERS = Object.freeze([500, 1000, 2000] as const);

export const nearbyFoodFiltersSchema = z.strictObject({
  maxDistanceMetres: z.union([z.literal(500), z.literal(1000), z.literal(2000)]).nullable(),
  cuisine: z.enum(CUISINE_GROUPS).nullable(),
  venueType: z.enum(VENUE_TYPES).nullable(),
  attribute: z.enum(FILTERABLE_FOOD_ATTRIBUTES).nullable(),
});

export type NearbyFoodFilters = z.infer<typeof nearbyFoodFiltersSchema>;

export const NO_FOOD_FILTERS: NearbyFoodFilters = Object.freeze({ maxDistanceMetres: null, cuisine: null, venueType: null, attribute: null });

/** Largest radius any search may use; the widest user filter. */
export const MAX_SEARCH_RADIUS_METRES = 2000;
/** Bounded result count for one search. */
export const MAX_NEARBY_RESULTS = 40;

export const nearbyFoodSearchRequestSchema = z.strictObject({
  origin: coordinatesSchema,
  radiusMetres: z.number().int().positive().max(MAX_SEARCH_RADIUS_METRES),
  filters: nearbyFoodFiltersSchema,
});

export type NearbyFoodSearchRequest = z.infer<typeof nearbyFoodSearchRequestSchema>;

// --- Governed attribute vocabulary ------------------------------------------------------------

/**
 * The exact HPB Healthier Dining "Menu Item Endorsement Criteria" strings
 * (dataset d_c475b9170c08f90580f4041bffd51639). Displayed verbatim as HPB
 * wording; none is, or may become, a lower-GI claim.
 */
export const HPB_MENU_CRITERIA = Object.freeze([
  "Higher in wholegrains",
  "Higher in wholegrains and lower in calories",
  "Lower in sugar",
  "Lower in sugar and source of dietary fibre",
  "Lower in calories",
  "Lower in calories and sodium",
  "No added sugar",
  "Healthier children's meal",
  "Lower in sodium",
] as const);

export type HpbMenuCriterion = (typeof HPB_MENU_CRITERIA)[number];

/**
 * Closed filter mapping: a criterion matches an approved filter only when its
 * exact wording contains that filter's phrase. Other criteria are shown
 * verbatim but are not filterable.
 */
export const HPB_CRITERION_FILTERS: Readonly<Record<HpbMenuCriterion, readonly FilterableFoodAttribute[]>> = Object.freeze({
  "Higher in wholegrains": Object.freeze(["HIGHER_IN_WHOLEGRAINS"] as const),
  "Higher in wholegrains and lower in calories": Object.freeze(["HIGHER_IN_WHOLEGRAINS", "LOWER_IN_CALORIES"] as const),
  "Lower in sugar": Object.freeze(["LOWER_IN_SUGAR"] as const),
  "Lower in sugar and source of dietary fibre": Object.freeze(["LOWER_IN_SUGAR"] as const),
  "Lower in calories": Object.freeze(["LOWER_IN_CALORIES"] as const),
  "Lower in calories and sodium": Object.freeze(["LOWER_IN_CALORIES"] as const),
  "No added sugar": Object.freeze([] as const),
  "Healthier children's meal": Object.freeze([] as const),
  "Lower in sodium": Object.freeze([] as const),
});

export const supportedFoodAttributeSchema = z.strictObject({
  vocabulary: z.literal("HPB_HEALTHIER_DINING_MENU_CRITERIA"),
  criterion: z.enum(HPB_MENU_CRITERIA),
});

export type SupportedFoodAttribute = z.infer<typeof supportedFoodAttributeSchema>;

export function filterAttributesOf(attributes: readonly SupportedFoodAttribute[]): FilterableFoodAttribute[] {
  const found = new Set<FilterableFoodAttribute>();
  for (const attribute of attributes) for (const filter of HPB_CRITERION_FILTERS[attribute.criterion]) found.add(filter);
  return FILTERABLE_FOOD_ATTRIBUTES.filter((filter) => found.has(filter));
}

// --- Sources ----------------------------------------------------------------------------------

export const HPB_FNB_PARTNERS_DATASET_ID = "d_c475b9170c08f90580f4041bffd51639";
export const HPB_HEALTHIER_EATERIES_DATASET_ID = "d_2925c2ccf75d1c135c2d469e0de3cee6";

export const sourceReferenceSchema = z.discriminatedUnion("kind", [
  /** Venue facts from the bundled governed geospatial dataset. */
  z.strictObject({ kind: z.literal("GOVERNED_DATASET"), datasetId: z.string().min(1), snapshotVersion: z.string().min(1) }),
  /** Clearly labelled invented demonstration venue. */
  z.strictObject({ kind: z.literal("SYNTHETIC_FIXTURE"), fixtureVersion: z.string().min(1) }),
]);

export type SourceReference = z.infer<typeof sourceReferenceSchema>;

// --- Place ------------------------------------------------------------------------------------

export const nearbyFoodPlaceSchema = z
  .strictObject({
    id: z.string().min(1).max(80),
    name: z.string().min(1).max(200),
    address: z.string().min(1).max(300),
    coordinates: coordinatesSchema,
    distanceMetres: z.number().int().nonnegative(),
    /** Exact directory wording, shown as data. */
    cuisineLabels: z.array(z.string().min(1).max(80)).max(4),
    /** Groups used only by the person's cuisine filter. */
    cuisineGroups: z.array(z.enum(CUISINE_GROUPS)).max(CUISINE_GROUPS.length),
    venueType: z.enum(VENUE_TYPES).nullable(),
    venueSource: sourceReferenceSchema,
    governedAttributes: z.array(supportedFoodAttributeSchema).max(HPB_MENU_CRITERIA.length),
    evidenceSource: sourceReferenceSchema.nullable(),
  })
  .superRefine((place, ctx) => {
    const issue = (message: string, path: string[]) => ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
    if (new Set(place.governedAttributes.map((attribute) => attribute.criterion)).size !== place.governedAttributes.length) {
      issue("DUPLICATE_GOVERNED_ATTRIBUTE", ["governedAttributes"]);
    }
    if (new Set(place.cuisineGroups).size !== place.cuisineGroups.length) issue("DUPLICATE_CUISINE_GROUP", ["cuisineGroups"]);
    if (place.governedAttributes.length > 0 && place.evidenceSource?.kind !== "GOVERNED_DATASET") {
      issue("GOVERNED_ATTRIBUTE_REQUIRES_GOVERNED_EVIDENCE", ["evidenceSource"]);
    }
    if (place.venueSource.kind === "SYNTHETIC_FIXTURE" && (place.governedAttributes.length > 0 || place.evidenceSource !== null)) {
      issue("SYNTHETIC_PLACE_CANNOT_CARRY_EVIDENCE", ["governedAttributes"]);
    }
    if (place.governedAttributes.length === 0 && place.evidenceSource !== null) issue("EVIDENCE_SOURCE_WITHOUT_ATTRIBUTE", ["evidenceSource"]);
  });

export type NearbyFoodPlace = z.infer<typeof nearbyFoodPlaceSchema>;

/** Distance first, then name, then id: a total, deterministic order. */
export function sortPlacesByDistance<T extends Pick<NearbyFoodPlace, "distanceMetres" | "name" | "id">>(places: readonly T[]): T[] {
  return [...places].sort(
    (a, b) => a.distanceMetres - b.distanceMetres || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** Applies only the person's explicit filter choices. */
export function applyNearbyFilters<T extends NearbyFoodPlace>(places: readonly T[], filters: NearbyFoodFilters): T[] {
  return places.filter(
    (place) =>
      (filters.maxDistanceMetres === null || place.distanceMetres <= filters.maxDistanceMetres) &&
      (filters.cuisine === null || place.cuisineGroups.includes(filters.cuisine)) &&
      (filters.venueType === null || place.venueType === filters.venueType) &&
      (filters.attribute === null || filterAttributesOf(place.governedAttributes).includes(filters.attribute)),
  );
}

// --- Ports ------------------------------------------------------------------------------------

export type ResolvedLocation = { label: string; coordinates: Coordinates };

export type LocationResolution =
  | { kind: "RESOLVED"; location: ResolvedLocation }
  | { kind: "AMBIGUOUS"; candidates: ResolvedLocation[] }
  | { kind: "NOT_FOUND" }
  | { kind: "UNAVAILABLE"; reason: "NOT_CONFIGURED" | "OFFLINE" | "REJECTED" | "RATE_LIMITED" | "UPSTREAM_ERROR" | "TIMEOUT" };

export type GeocoderPort = {
  readonly providerId: "ONEMAP" | "SNAPSHOT_POSTAL" | "SNAPSHOT_TEXT" | "SYNTHETIC";
  resolve(query: string, signal?: AbortSignal): Promise<LocationResolution>;
};

export type CurrentLocationOutcome =
  | { kind: "LOCATED"; coordinates: Coordinates }
  | { kind: "DENIED" }
  | { kind: "TIMEOUT" }
  | { kind: "UNAVAILABLE" }
  | { kind: "CANCELLED" };

export type LocationAcquisitionPort = {
  /** Called only after an explicit person action; never persisted. */
  acquireOnce(signal?: AbortSignal): Promise<CurrentLocationOutcome>;
};

export type MapProviderDescriptor =
  | {
      kind: "ONEMAP_TILES";
      tileUrlTemplate: "https://www.onemap.gov.sg/maps/tiles/Default/{z}/{x}/{y}.png";
      minZoom: number;
      maxZoom: number;
      privacyUrl: string;
      termsUrl: string;
    }
  | { kind: "STATIC_DEMO" };

export type GovernedDatasetDescriptor = {
  kind: "HPB_SNAPSHOT";
  snapshotVersion: string;
  /** Source-published date of the endorsement-criteria dataset. */
  criteriaDatasetDate: string;
  /** Source date of the geospatial coordinates. */
  coordinatesDatasetDate: string;
  licenceUrl: string;
};

export type DirectoryDescriptor = GovernedDatasetDescriptor | { kind: "SYNTHETIC" };

export type NearbyFoodResult =
  | { kind: "RESULTS"; places: NearbyFoodPlace[]; directory: DirectoryDescriptor }
  | { kind: "UNAVAILABLE"; reason: "SNAPSHOT_UNAVAILABLE" | "SNAPSHOT_INVALID" };

export type VenueDirectoryPort = {
  readonly descriptor: DirectoryDescriptor;
  findNearby(request: NearbyFoodSearchRequest, signal?: AbortSignal): Promise<NearbyFoodResult>;
};

/** The cuisine and venue-type choices a directory can answer (owner decision 2026-10-12); filters with no data are not offered. */
export type NearbyFoodFilterOptions = Readonly<{ cuisineGroups: readonly CuisineGroup[]; venueTypes: readonly VenueType[] }>;

export type NearbyFoodProfile = {
  geocoder: "ONEMAP_WITH_SNAPSHOT_POSTAL" | "SNAPSHOT_POSTAL" | "SYNTHETIC";
  map: MapProviderDescriptor;
  directory: "HPB_SNAPSHOT" | "SYNTHETIC";
  /** Absent: every cuisine and venue type is offered. */
  filterOptions?: NearbyFoodFilterOptions;
};

/** The one facade Screen 07 uses. */
export type NearbyFoodDiscoveryPort = {
  readonly profile: NearbyFoodProfile;
  resolveManualLocation(query: string, signal?: AbortSignal): Promise<LocationResolution>;
  acquireCurrentLocation(signal?: AbortSignal): Promise<CurrentLocationOutcome>;
  findNearby(request: NearbyFoodSearchRequest, signal?: AbortSignal): Promise<NearbyFoodResult>;
  /** Clearly labelled synthetic places used only after an explicit fallback. */
  findSyntheticFallback(filters: NearbyFoodFilters): Promise<NearbyFoodResult>;
  isOnline(): boolean;
};
