import {
  MAX_SEARCH_RADIUS_METRES,
  NO_FOOD_FILTERS,
  type Coordinates,
  type DirectoryDescriptor,
  type NearbyFoodDiscoveryPort,
  type NearbyFoodFilters,
  type NearbyFoodPlace,
  type ResolvedLocation,
} from "@/application/nearby-food/nearby-food-contracts";

/**
 * Screen 07 interaction controller (Packet 9A Task 5). It turns explicit
 * person actions into calls on the provider-neutral discovery port and keeps
 * the approved twelve states. Coordinates and queries live only in this
 * in-memory object for the active interaction; nothing is persisted, logged
 * or derived from health information.
 */

export type ResultSet = {
  places: NearbyFoodPlace[];
  directory: DirectoryDescriptor;
  origin: Coordinates;
  /** LIVE uses the configured profile; SYNTHETIC_FALLBACK is the labelled demo fallback. */
  source: "LIVE" | "SYNTHETIC_FALLBACK";
};

export type NearbyFoodScreenState =
  | { kind: "IDLE" }
  | { kind: "PRE_PERMISSION" }
  | { kind: "LOCATING"; via: "GPS" | "MANUAL" }
  | { kind: "RESULTS"; view: "map" | "list"; results: ResultSet; mapFailed: boolean; offline: boolean }
  | { kind: "LOCATION_PROBLEM"; reason: "DENIED" | "TIMEOUT" | "UNAVAILABLE" }
  | { kind: "AMBIGUOUS"; query: string; candidates: ResolvedLocation[] }
  | { kind: "NO_RESULTS"; results: ResultSet }
  | { kind: "LOCATION_NOT_FOUND"; query: string }
  /** Owner decision 2026-10-12: no synthetic places are ever shown; the screen says what to try instead. */
  | { kind: "GEOCODER_UNAVAILABLE" }
  | { kind: "DIRECTORY_UNAVAILABLE" }
  | { kind: "VENUE_DETAILS"; place: NearbyFoodPlace; results: ResultSet; returnTo: Extract<NearbyFoodScreenState, { kind: "RESULTS" }> };

export type NearbyFoodController = {
  getState(): NearbyFoodScreenState;
  getFilters(): NearbyFoodFilters;
  subscribe(listener: () => void): () => void;
  searchManual(query: string): void;
  requestGps(): void;
  grantGps(): void;
  declineGps(): void;
  cancelGps(): void;
  chooseCandidate(location: ResolvedLocation): void;
  setFilters(filters: NearbyFoodFilters): void;
  switchView(view: "map" | "list"): void;
  selectPlace(placeId: string): void;
  backFromDetails(): void;
  reportMapUnavailable(): void;
  /** Cancels the in-flight request (screen closed); the controller stays usable. */
  abortActive(): void;
};

const isAbort = (error: unknown) => error instanceof Error && error.name === "AbortError";

export function createNearbyFoodController(port: NearbyFoodDiscoveryPort): NearbyFoodController {
  let state: NearbyFoodScreenState = { kind: "IDLE" };
  let filters: NearbyFoodFilters = NO_FOOD_FILTERS;
  /** Current search scope, so a filter change can re-run it. */
  let scope: { kind: "ORIGIN"; origin: Coordinates; view: "map" | "list" } | null = null;
  let active: AbortController | null = null;
  const listeners = new Set<() => void>();

  const set = (next: NearbyFoodScreenState) => {
    state = next;
    for (const listener of listeners) listener();
  };

  /** Starts a new interaction, cancelling any earlier one. */
  function begin(): AbortSignal {
    active?.abort();
    active = new AbortController();
    return active.signal;
  }

  async function runSearch(origin: Coordinates, view: "map" | "list", signal: AbortSignal) {
    scope = { kind: "ORIGIN", origin, view };
    try {
      const result = await port.findNearby({ origin, radiusMetres: MAX_SEARCH_RADIUS_METRES, filters }, signal);
      if (signal.aborted) return;
      if (result.kind === "UNAVAILABLE") {
        set({ kind: "DIRECTORY_UNAVAILABLE" });
        return;
      }
      const results: ResultSet = { places: result.places, directory: result.directory, origin, source: "LIVE" };
      set(
        result.places.length === 0
          ? { kind: "NO_RESULTS", results }
          : { kind: "RESULTS", view, results, mapFailed: false, offline: !port.isOnline() },
      );
    } catch (error) {
      if (isAbort(error) || signal.aborted) return;
      set({ kind: "DIRECTORY_UNAVAILABLE" });
    }
  }

  return Object.freeze({
    getState: () => state,
    getFilters: () => filters,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    searchManual(query: string) {
      const signal = begin();
      set({ kind: "LOCATING", via: "MANUAL" });
      void (async () => {
        try {
          const resolution = await port.resolveManualLocation(query, signal);
          if (signal.aborted) return;
          switch (resolution.kind) {
            case "RESOLVED":
              await runSearch(resolution.location.coordinates, "list", signal);
              return;
            case "AMBIGUOUS":
              set({ kind: "AMBIGUOUS", query, candidates: resolution.candidates });
              return;
            case "NOT_FOUND":
              scope = null;
              set({ kind: "LOCATION_NOT_FOUND", query });
              return;
            case "UNAVAILABLE":
              scope = null;
              set({ kind: "GEOCODER_UNAVAILABLE" });
              return;
          }
        } catch (error) {
          if (isAbort(error) || signal.aborted) return;
          set({ kind: "GEOCODER_UNAVAILABLE" });
        }
      })();
    },

    requestGps() {
      active?.abort();
      set({ kind: "PRE_PERMISSION" });
    },

    grantGps() {
      const signal = begin();
      set({ kind: "LOCATING", via: "GPS" });
      void (async () => {
        const outcome = await port.acquireCurrentLocation(signal);
        if (signal.aborted) return;
        if (outcome.kind === "LOCATED") await runSearch(outcome.coordinates, "map", signal);
        else if (outcome.kind !== "CANCELLED") set({ kind: "LOCATION_PROBLEM", reason: outcome.kind });
      })();
    },

    declineGps() {
      active?.abort();
      set({ kind: "LOCATION_PROBLEM", reason: "DENIED" });
    },

    cancelGps() {
      active?.abort();
      set({ kind: "IDLE" });
    },

    chooseCandidate(location: ResolvedLocation) {
      const signal = begin();
      set({ kind: "LOCATING", via: "MANUAL" });
      void runSearch(location.coordinates, "list", signal);
    },

    setFilters(next: NearbyFoodFilters) {
      filters = Object.freeze({ ...next });
      const current = scope;
      if (!current) {
        for (const listener of listeners) listener();
        return;
      }
      const signal = begin();
      const view = state.kind === "RESULTS" ? state.view : current.view;
      void runSearch(current.origin, view, signal);
    },

    switchView(view: "map" | "list") {
      if (state.kind !== "RESULTS") return;
      if (scope?.kind === "ORIGIN") scope = { ...scope, view };
      set({ ...state, view });
    },

    selectPlace(placeId: string) {
      const from = state;
      const results = from.kind === "RESULTS" ? from.results : null;
      const place = results?.places.find((entry) => entry.id === placeId);
      if (!results || !place) return;
      const returnTo: Extract<NearbyFoodScreenState, { kind: "RESULTS" }> =
        from.kind === "RESULTS" ? from : { kind: "RESULTS", view: "list", results, mapFailed: false, offline: !port.isOnline() };
      set({ kind: "VENUE_DETAILS", place, results, returnTo });
    },

    backFromDetails() {
      if (state.kind === "VENUE_DETAILS") set({ ...state.returnTo, view: "list" });
    },

    reportMapUnavailable() {
      if (state.kind === "RESULTS" && !state.mapFailed) set({ ...state, mapFailed: true, view: "list" });
    },

    abortActive() {
      active?.abort();
      active = null;
    },
  });
}
