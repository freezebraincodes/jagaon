import { sha256Hex } from "@/application/intelligence/metrics";
import {
  MAX_NEARBY_RESULTS,
  applyNearbyFilters,
  distanceBetweenMetres,
  nearbyFoodSearchRequestSchema,
  sortPlacesByDistance,
  type Coordinates,
  type GeocoderPort,
  type GovernedDatasetDescriptor,
  type LocationResolution,
  type NearbyFoodFilterOptions,
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

/**
 * Owner decision 2026-10-12: the cuisine and venue-type filters the bundled HPB directory can actually answer. The snapshot carries
 * no venue type, and Malay and Indian appear on fewer than ten places, so only cuisines with real data are offered (pinned by a
 * test against the snapshot file).
 */
export const HPB_FILTER_OPTIONS: NearbyFoodFilterOptions = Object.freeze({
  cuisineGroups: Object.freeze(["CHINESE", "WESTERN"] as const),
  venueTypes: Object.freeze([] as const),
});

/** Places whose matches lie within this distance of their centre are one area, searched from that centre. */
export const AREA_RADIUS_METRES = 1500;
/** A spread-out area is searched from its densest part: the matches within this distance of its busiest place. */
const CLUSTER_RADIUS_METRES = 1000;
/** Separate choices offered for a spread-out name match are at least this far apart. */
const CANDIDATE_SEPARATION_METRES = 1000;
const MAX_CANDIDATES = 5;
const MIN_QUERY_LENGTH = 3;

const normalise = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
/** Common Singapore address abbreviations, read the same way in the query and the data ("Jln" and "Jalan" both match). */
const ABBREVIATIONS: Readonly<Record<string, string>> = Object.freeze({
  jln: "jalan",
  ave: "avenue",
  st: "street",
  rd: "road",
  dr: "drive",
  cres: "crescent",
  ctrl: "central",
  lor: "lorong",
  upp: "upper",
  bt: "bukit",
  blk: "block",
  nth: "north",
  sth: "south",
  amk: "ang mo kio",
});
const words = (text: string) =>
  normalise(text)
    .split(" ")
    .flatMap((word) => (ABBREVIATIONS[word] ?? word).split(" "))
    .filter(Boolean);
/** Every query word starts a word of the text ("toa payoh" matches "Toa Payoh Lorong 8"). */
const matchesAll = (queryWords: readonly string[], textWords: readonly string[]) =>
  queryWords.every((queryWord) => textWords.some((word) => word.startsWith(queryWord)));
/** The address without its unit and postal code, for matching; and without its unit, for a label. */
const UNIT = /#[^\s,]+(\s*,\s*\d+)*,?/g;
const addressForMatching = (address: string) => address.replace(UNIT, " ").replace(/Singapore \d{6}$/, " ");
const addressLabel = (address: string) => address.replace(UNIT, " ").replace(/\s+,/g, ",").replace(/\s{2,}/g, " ").trim();

/**
 * Owner decision 2026-10-12: offline name and address search over the same verified snapshot, used when OneMap is not configured,
 * unavailable or finds nothing. A query matches the venues whose address (or, failing that, name or address) contains every query
 * word. Matches at one postal code resolve to that place; matches within AREA_RADIUS_METRES of their centre resolve to that centre
 * as an area; a more spread-out area or street resolves to its densest part, and a name found in many separate places (a chain)
 * offers up to five of them to choose from. Nothing is sent anywhere.
 */
export function createSnapshotTextGeocoder(loadText: () => Promise<string>): GeocoderPort {
  const load = createSnapshotSource(loadText);
  let index: { venue: HpbNearbyFoodSnapshotV1["venues"][number]; address: string[]; nameAndAddress: string[] }[] | null = null;
  return Object.freeze({
    providerId: "SNAPSHOT_TEXT" as const,
    async resolve(query: string): Promise<LocationResolution> {
      const queryWords = words(query);
      if (queryWords.join(" ").length < MIN_QUERY_LENGTH) return { kind: "NOT_FOUND" };
      const loaded = await load();
      if (loaded.kind !== "READY") return { kind: "NOT_FOUND" };
      index ??= loaded.snapshot.venues.map((venue) => {
        const address = words(addressForMatching(venue.address));
        return { venue, address, nameAndAddress: [...words(venue.name), ...address] };
      });
      let matched = index.filter((entry) => matchesAll(queryWords, entry.address));
      const byAddress = matched.length > 0;
      if (!byAddress) matched = index.filter((entry) => matchesAll(queryWords, entry.nameAndAddress));
      if (matched.length === 0) return { kind: "NOT_FOUND" };

      // One group per postal code (or per point, for an address without one), in dataset order.
      const groups = new Map<string, { label: string; coordinates: Coordinates; count: number }>();
      for (const { venue } of matched) {
        const key = /Singapore (\d{6})$/.exec(venue.address)?.[1] ?? `${venue.latitude},${venue.longitude}`;
        const group = groups.get(key);
        if (group) group.count += 1;
        else groups.set(key, { label: addressLabel(venue.address), coordinates: { latitude: venue.latitude, longitude: venue.longitude }, count: 1 });
      }
      const all = [...groups.values()];
      if (all.length === 1) return { kind: "RESOLVED", location: { label: all[0]!.label, coordinates: all[0]!.coordinates } };

      const centre: Coordinates = {
        latitude: matched.reduce((sum, entry) => sum + entry.venue.latitude, 0) / matched.length,
        longitude: matched.reduce((sum, entry) => sum + entry.venue.longitude, 0) / matched.length,
      };
      const areaLabel = query.trim().replace(/\s+/g, " ");
      if (all.every((group) => distanceBetweenMetres(centre, group.coordinates) <= AREA_RADIUS_METRES)) {
        return { kind: "RESOLVED", location: { label: areaLabel, coordinates: centre } };
      }
      // Owner decision 2026-10-12: an area or street (an address match) goes straight to results, searched from where most of its
      // places are: the place with the most matches within CLUSTER_RADIUS_METRES, and the centre of those matches.
      if (byAddress) {
        const near = (group: (typeof all)[number]) => all.filter((other) => distanceBetweenMetres(group.coordinates, other.coordinates) <= CLUSTER_RADIUS_METRES);
        const weight = (groups: typeof all) => groups.reduce((sum, group) => sum + group.count, 0);
        let densest = all[0]!;
        for (const group of all) if (weight(near(group)) > weight(near(densest))) densest = group;
        const cluster = near(densest);
        const total = weight(cluster);
        const clusterCentre: Coordinates = {
          latitude: cluster.reduce((sum, group) => sum + group.coordinates.latitude * group.count, 0) / total,
          longitude: cluster.reduce((sum, group) => sum + group.coordinates.longitude * group.count, 0) / total,
        };
        return { kind: "RESOLVED", location: { label: areaLabel, coordinates: clusterCentre } };
      }
      // A name found in many separate places (a chain such as "Subway"): offer up to five of them to choose from.
      const chosen: typeof all = [];
      for (const group of [...all].sort((a, b) => b.count - a.count)) {
        if (chosen.length === MAX_CANDIDATES) break;
        if (chosen.every((other) => distanceBetweenMetres(other.coordinates, group.coordinates) >= CANDIDATE_SEPARATION_METRES)) chosen.push(group);
      }
      return { kind: "AMBIGUOUS", candidates: chosen.map((group) => ({ label: group.label, coordinates: group.coordinates })) };
    },
  });
}
