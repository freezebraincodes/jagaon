/**
 * Provider-neutral nearby-food adapter.
 *
 * Implements a synthetic venue directory and a 12-state state machine
 * for the Nearby Food screen. Key compliance boundaries:
 *
 * - GPS is requested only after an explicit user press.
 * - No location history is stored.
 * - No HPB / lower-GI / healthier badge is shown without exact governed
 *   evidence. Default fixtures authorize no such badge or attribute.
 * - Filters use only user choices and directory facts, never health records.
 * - All venue data is synthetic for this hackathon demo.
 */

import type { LocalDateText } from "@/i18n/types";

// ---------------------------------------------------------------------------
// Value types
// ---------------------------------------------------------------------------

export type VenueType = "HAWKER_CENTRE" | "COFFEE_SHOP" | "MARKET" | "FOOD_COURT";

export type CuisineGroup = "CHINESE" | "MALAY" | "INDIAN" | "WESTERN";

/** Governed attribute codes; a venue carries one only with a governed record. */
export type GovernedFoodAttribute = "HIGHER_IN_WHOLEGRAINS" | "LOWER_IN_SUGAR" | "LOWER_IN_CALORIES";

export type FoodVenue = {
  id: string;
  name: string;
  /** Directory cuisine description, shown as data. */
  cuisine: string;
  /** Cuisine groups used only by the user's cuisine filter. */
  cuisineGroups: readonly CuisineGroup[];
  venueType: VenueType;
  distanceMetres: number;
  /** Badge text if governed evidence exists, otherwise null. */
  badge: string | null;
  /** Attributes backed by a governed evidence record (none by default). */
  governedAttributes: readonly GovernedFoodAttribute[];
  /** Synthetic street address for display. */
  address: string;
};

export type FoodVenueWithDirections = FoodVenue & {
  /** Directions URL — always unavailable in the synthetic demo. */
  directionsUrl: string | null;
};

export type NearbyFoodFilters = {
  maxDistanceMetres: 500 | 1000 | 2000 | null;
  cuisine: CuisineGroup | null;
  venueType: VenueType | null;
  attribute: GovernedFoodAttribute | null;
};

export const NO_FOOD_FILTERS: NearbyFoodFilters = Object.freeze({
  maxDistanceMetres: null,
  cuisine: null,
  venueType: null,
  attribute: null,
});

// ---------------------------------------------------------------------------
// Nearby-food state machine — all 12 states
// ---------------------------------------------------------------------------

export type NearbyFoodState =
  /** 1: Initial idle state before any search. */
  | { kind: "IDLE" }
  /** 2: Pre-permission prompt before requesting GPS. */
  | { kind: "PRE_PERMISSION" }
  /** 3: Locating via GPS. */
  | { kind: "LOCATING" }
  /** 4: Results loaded, map view. */
  | { kind: "RESULTS_MAP"; venues: FoodVenue[]; query: string }
  /** 5: Results loaded, list view. */
  | { kind: "RESULTS_LIST"; venues: FoodVenue[]; query: string }
  /** 6: GPS permission denied. */
  | { kind: "PERMISSION_DENIED" }
  /** 7: Ambiguous location query. */
  | { kind: "AMBIGUOUS"; query: string }
  /** 8: No matching results. */
  | { kind: "NO_RESULTS"; query: string }
  /** 9: Map unavailable, list still available. */
  | { kind: "MAP_UNAVAILABLE"; venues: FoodVenue[]; query: string }
  /** 10: Directory unavailable entirely. */
  | { kind: "DIRECTORY_UNAVAILABLE" }
  /** 11: Offline, showing cached snapshot. */
  | { kind: "OFFLINE"; venues: FoodVenue[]; snapshotDate: LocalDateText }
  /** 12: Venue details. */
  | { kind: "VENUE_DETAILS"; venue: FoodVenueWithDirections };

// ---------------------------------------------------------------------------
// Events that drive state transitions
// ---------------------------------------------------------------------------

export type NearbyFoodEvent =
  | { kind: "SEARCH_BY_TEXT"; query: string }
  | { kind: "REQUEST_GPS" }
  | { kind: "GRANT_GPS" }
  | { kind: "DENY_GPS" }
  | { kind: "CANCEL_GPS" }
  | { kind: "USE_POSTAL_CODE"; query: string }
  | { kind: "SWITCH_TO_MAP" }
  | { kind: "SWITCH_TO_LIST" }
  | { kind: "SET_FILTERS"; filters: NearbyFoodFilters }
  | { kind: "SELECT_VENUE"; venueId: string }
  | { kind: "BACK_FROM_DETAILS" }
  | { kind: "SIMULATE_MAP_UNAVAILABLE" }
  | { kind: "SIMULATE_OFFLINE" }
  | { kind: "SIMULATE_DIRECTORY_UNAVAILABLE" }
  | { kind: "RESET" };

// ---------------------------------------------------------------------------
// Adapter interface
// ---------------------------------------------------------------------------

export type NearbyFoodAdapter = {
  /** Current state of the nearby-food state machine. */
  getState(): NearbyFoodState;
  /** Filters the person chose; applied to every result set. */
  getFilters(): NearbyFoodFilters;
  /** Dispatch an event to transition the state machine. */
  dispatch(event: NearbyFoodEvent): void;
  /** Subscribe to state changes. */
  subscribe(listener: (state: NearbyFoodState) => void): () => void;
};

// ---------------------------------------------------------------------------
// Synthetic venue fixtures
// ---------------------------------------------------------------------------

// Fictional venues only: names and addresses are invented for the demo and
// are labelled as such so no real business is implied.
const SYNTHETIC_VENUES: readonly FoodVenue[] = Object.freeze([
  Object.freeze({
    id: "venue-001",
    name: "Kampong Jelutong Food Centre (demo)",
    cuisine: "Chinese & Malay stalls",
    cuisineGroups: Object.freeze(["CHINESE", "MALAY"] as const),
    venueType: "HAWKER_CENTRE" as const,
    distanceMetres: 180,
    badge: null,
    governedAttributes: Object.freeze([]),
    address: "Blk 18, Jelutong Estate (synthetic)",
  }),
  Object.freeze({
    id: "venue-002",
    name: "Blk 412 Coffee Shop (demo)",
    cuisine: "Chinese",
    cuisineGroups: Object.freeze(["CHINESE"] as const),
    venueType: "COFFEE_SHOP" as const,
    distanceMetres: 350,
    badge: null,
    governedAttributes: Object.freeze([]),
    address: "Blk 412 Jalan Seroja (synthetic)",
  }),
  Object.freeze({
    id: "venue-003",
    name: "Tanjong Seroja Market (demo)",
    cuisine: "Malay & Indian",
    cuisineGroups: Object.freeze(["MALAY", "INDIAN"] as const),
    venueType: "MARKET" as const,
    distanceMetres: 620,
    badge: null,
    governedAttributes: Object.freeze([]),
    address: "Tanjong Seroja (synthetic)",
  }),
  Object.freeze({
    id: "venue-004",
    name: "Seroja Lane Eating House (demo)",
    cuisine: "Indian",
    cuisineGroups: Object.freeze(["INDIAN"] as const),
    venueType: "COFFEE_SHOP" as const,
    distanceMetres: 760,
    badge: null,
    governedAttributes: Object.freeze([]),
    address: "8 Seroja Lane (synthetic)",
  }),
  Object.freeze({
    id: "venue-005",
    name: "Jelutong Garden Food Court (demo)",
    cuisine: "Chinese & Western",
    cuisineGroups: Object.freeze(["CHINESE", "WESTERN"] as const),
    venueType: "FOOD_COURT" as const,
    distanceMetres: 1200,
    badge: null,
    governedAttributes: Object.freeze([]),
    address: "Jelutong Garden (synthetic)",
  }),
]);

const OFFLINE_SNAPSHOT_DATE: LocalDateText = "2026-09-15";

/** Applies only the person's filter choices, then sorts by distance. */
export function applyFoodFilters(
  venues: readonly FoodVenue[],
  filters: NearbyFoodFilters,
): FoodVenue[] {
  return venues
    .filter(
      (v) =>
        (filters.maxDistanceMetres === null || v.distanceMetres <= filters.maxDistanceMetres) &&
        (filters.cuisine === null || v.cuisineGroups.includes(filters.cuisine)) &&
        (filters.venueType === null || v.venueType === filters.venueType) &&
        (filters.attribute === null || v.governedAttributes.includes(filters.attribute)),
    )
    .sort((a, b) => a.distanceMetres - b.distanceMetres);
}

// ---------------------------------------------------------------------------
// State machine implementation
// ---------------------------------------------------------------------------

export function createNearbyFoodAdapter(
  initialVenues: readonly FoodVenue[] = SYNTHETIC_VENUES,
  offlineSnapshotDate: LocalDateText = OFFLINE_SNAPSHOT_DATE,
): NearbyFoodAdapter {
  let state: NearbyFoodState = { kind: "IDLE" };
  let filters: NearbyFoodFilters = NO_FOOD_FILTERS;
  /** Unfiltered result set of the current search, so filters can change. */
  let base: { venues: readonly FoodVenue[]; query: string; view: "map" | "list" } | null = null;
  const listeners = new Set<(state: NearbyFoodState) => void>();

  function notify() {
    for (const listener of listeners) {
      listener(state);
    }
  }

  function showResults(venues: readonly FoodVenue[], query: string, view: "map" | "list") {
    base = { venues, query, view };
    const shown = applyFoodFilters(venues, filters);
    state =
      shown.length === 0
        ? { kind: "NO_RESULTS", query }
        : view === "map"
          ? { kind: "RESULTS_MAP", venues: shown, query }
          : { kind: "RESULTS_LIST", venues: shown, query };
  }

  function searchByQuery(query: string): void {
    if (query.trim().length === 0) {
      base = null;
      state = { kind: "NO_RESULTS", query };
      notify();
      return;
    }
    // Simulate ambiguous results for very short queries
    if (query.trim().length < 3) {
      base = null;
      state = { kind: "AMBIGUOUS", query };
      notify();
      return;
    }
    // A 6-digit postal code is treated as a manual location: the synthetic
    // directory returns every fixture venue near it. Other text matches
    // venues by name or cuisine (case-insensitive).
    const lower = query.trim().toLowerCase();
    const matched = /^\d{6}$/.test(lower)
      ? [...initialVenues]
      : initialVenues.filter(
          (v) =>
            v.name.toLowerCase().includes(lower) ||
            v.cuisine.toLowerCase().includes(lower),
        );
    if (matched.length === 0) {
      base = null;
      state = { kind: "NO_RESULTS", query };
    } else {
      showResults(matched, query, "list");
    }
    notify();
  }

  function dispatch(event: NearbyFoodEvent): void {
    switch (event.kind) {
      case "SEARCH_BY_TEXT":
        searchByQuery(event.query);
        return;

      case "REQUEST_GPS":
        state = { kind: "PRE_PERMISSION" };
        notify();
        return;

      case "GRANT_GPS":
        state = { kind: "LOCATING" };
        notify();
        // Simulate async location result with all venues
        showResults([...initialVenues], "", "map");
        notify();
        return;

      case "DENY_GPS":
        state = { kind: "PERMISSION_DENIED" };
        notify();
        return;

      case "CANCEL_GPS":
        state = { kind: "IDLE" };
        notify();
        return;

      case "USE_POSTAL_CODE":
        searchByQuery(event.query);
        return;

      case "SWITCH_TO_MAP": {
        if (state.kind === "RESULTS_LIST") {
          if (base) base = { ...base, view: "map" };
          state = { kind: "RESULTS_MAP", venues: state.venues, query: state.query };
          notify();
        }
        return;
      }

      case "SWITCH_TO_LIST": {
        if (state.kind === "RESULTS_MAP") {
          if (base) base = { ...base, view: "list" };
          state = { kind: "RESULTS_LIST", venues: state.venues, query: state.query };
          notify();
        }
        return;
      }

      case "SET_FILTERS": {
        filters = Object.freeze({ ...event.filters });
        if (
          base &&
          (state.kind === "RESULTS_MAP" ||
            state.kind === "RESULTS_LIST" ||
            state.kind === "NO_RESULTS")
        ) {
          showResults(base.venues, base.query, base.view);
        }
        notify();
        return;
      }

      case "SELECT_VENUE": {
        const allVenues =
          state.kind === "RESULTS_MAP" || state.kind === "RESULTS_LIST"
            ? state.venues
            : state.kind === "MAP_UNAVAILABLE"
              ? state.venues
              : state.kind === "OFFLINE"
                ? state.venues
                : [];
        const venue = allVenues.find((v) => v.id === event.venueId);
        if (venue) {
          state = {
            kind: "VENUE_DETAILS",
            venue: { ...venue, directionsUrl: null },
          };
          notify();
        }
        return;
      }

      case "BACK_FROM_DETAILS": {
        // Return to the list of the current search (or every venue).
        showResults(base?.venues ?? [...initialVenues], base?.query ?? "", "list");
        notify();
        return;
      }

      case "SIMULATE_MAP_UNAVAILABLE": {
        const venues = applyFoodFilters(base?.venues ?? initialVenues, filters);
        state = { kind: "MAP_UNAVAILABLE", venues, query: base?.query ?? "" };
        notify();
        return;
      }

      case "SIMULATE_OFFLINE":
        state = {
          kind: "OFFLINE",
          venues: applyFoodFilters(initialVenues, filters),
          snapshotDate: offlineSnapshotDate,
        };
        notify();
        return;

      case "SIMULATE_DIRECTORY_UNAVAILABLE":
        state = { kind: "DIRECTORY_UNAVAILABLE" };
        notify();
        return;

      case "RESET":
        base = null;
        filters = NO_FOOD_FILTERS;
        state = { kind: "IDLE" };
        notify();
        return;
    }
  }

  return Object.freeze({
    getState: () => state,
    getFilters: () => filters,
    dispatch,
    subscribe(listener: (state: NearbyFoodState) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Test-exported constants
// ---------------------------------------------------------------------------

export const DEMO_FOOD_VENUES = SYNTHETIC_VENUES;
export const DEMO_OFFLINE_SNAPSHOT_DATE = OFFLINE_SNAPSHOT_DATE;

// Re-export types for convenience
export type { LocalDateText };
