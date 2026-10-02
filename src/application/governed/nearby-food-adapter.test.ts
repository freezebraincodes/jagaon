import { describe, it, expect } from "vitest";
import {
  createNearbyFoodAdapter,
  DEMO_FOOD_VENUES,
  DEMO_OFFLINE_SNAPSHOT_DATE,
  type NearbyFoodState,
} from "./nearby-food-adapter";

describe("nearby-food-adapter", () => {
  it("starts in IDLE state", () => {
    const adapter = createNearbyFoodAdapter();
    expect(adapter.getState().kind).toBe("IDLE");
  });

  // --- State 1: IDLE ---
  it("state 1 IDLE: no venues, no query", () => {
    const adapter = createNearbyFoodAdapter();
    const state = adapter.getState();
    expect(state.kind).toBe("IDLE");
  });

  // --- State 2: PRE_PERMISSION ---
  it("state 2 PRE_PERMISSION: after REQUEST_GPS", () => {
    const adapter = createNearbyFoodAdapter();
    adapter.dispatch({ kind: "REQUEST_GPS" });
    expect(adapter.getState().kind).toBe("PRE_PERMISSION");
  });

  // --- State 3: LOCATING ---
  it("state 3 LOCATING: after GRANT_GPS (transient)", () => {
    const adapter = createNearbyFoodAdapter();
    const states: string[] = [];
    adapter.subscribe((s) => states.push(s.kind));
    adapter.dispatch({ kind: "REQUEST_GPS" });
    adapter.dispatch({ kind: "GRANT_GPS" });
    expect(states).toContain("LOCATING");
    expect(states).toContain("RESULTS_MAP");
  });

  // --- State 4: RESULTS_MAP ---
  it("state 4 RESULTS_MAP: after GPS grant, shows venues on map", () => {
    const adapter = createNearbyFoodAdapter();
    adapter.dispatch({ kind: "REQUEST_GPS" });
    adapter.dispatch({ kind: "GRANT_GPS" });
    const state = adapter.getState();
    expect(state.kind).toBe("RESULTS_MAP");
    if (state.kind !== "RESULTS_MAP") return;
    expect(state.venues.length).toBeGreaterThan(0);
  });

  // --- State 5: RESULTS_LIST ---
  it("state 5 RESULTS_LIST: after SWITCH_TO_LIST", () => {
    const adapter = createNearbyFoodAdapter();
    adapter.dispatch({ kind: "REQUEST_GPS" });
    adapter.dispatch({ kind: "GRANT_GPS" });
    adapter.dispatch({ kind: "SWITCH_TO_LIST" });
    expect(adapter.getState().kind).toBe("RESULTS_LIST");
  });

  // --- State 6: PERMISSION_DENIED ---
  it("state 6 PERMISSION_DENIED: after DENY_GPS", () => {
    const adapter = createNearbyFoodAdapter();
    adapter.dispatch({ kind: "REQUEST_GPS" });
    adapter.dispatch({ kind: "DENY_GPS" });
    expect(adapter.getState().kind).toBe("PERMISSION_DENIED");
  });

  // --- State 7: AMBIGUOUS ---
  it("state 7 AMBIGUOUS: for very short query (<3 chars)", () => {
    const adapter = createNearbyFoodAdapter();
    adapter.dispatch({ kind: "SEARCH_BY_TEXT", query: "Bu" });
    expect(adapter.getState().kind).toBe("AMBIGUOUS");
  });

  // --- State 8: NO_RESULTS ---
  it("state 8 NO_RESULTS: for query matching nothing", () => {
    const adapter = createNearbyFoodAdapter();
    adapter.dispatch({ kind: "SEARCH_BY_TEXT", query: "zzzz" });
    expect(adapter.getState().kind).toBe("NO_RESULTS");
  });

  it("state 8 NO_RESULTS: for empty query", () => {
    const adapter = createNearbyFoodAdapter();
    adapter.dispatch({ kind: "SEARCH_BY_TEXT", query: "" });
    expect(adapter.getState().kind).toBe("NO_RESULTS");
  });

  // --- State 9: MAP_UNAVAILABLE ---
  // This state is reachable when the map fails but list is still available.
  // The adapter doesn't directly enter it, but we can test that the state
  // type exists and the UI can render it.
  it("state 9 MAP_UNAVAILABLE: type is valid", () => {
    const state: NearbyFoodState = {
      kind: "MAP_UNAVAILABLE",
      venues: [...DEMO_FOOD_VENUES],
      query: "test",
    };
    expect(state.kind).toBe("MAP_UNAVAILABLE");
    expect(state.venues.length).toBeGreaterThan(0);
  });

  it("state 9 MAP_UNAVAILABLE: after SIMULATE_MAP_UNAVAILABLE the list stays available", () => {
    const adapter = createNearbyFoodAdapter();
    adapter.dispatch({ kind: "REQUEST_GPS" });
    adapter.dispatch({ kind: "GRANT_GPS" });
    adapter.dispatch({ kind: "SIMULATE_MAP_UNAVAILABLE" });
    const state = adapter.getState();
    expect(state.kind).toBe("MAP_UNAVAILABLE");
    if (state.kind !== "MAP_UNAVAILABLE") return;
    expect(state.venues).toHaveLength(DEMO_FOOD_VENUES.length);
  });

  // --- Filters: user choices only, re-applied to the current results ---
  it("filters by distance, cuisine and venue type and keeps distance order", () => {
    const adapter = createNearbyFoodAdapter();
    adapter.dispatch({ kind: "REQUEST_GPS" });
    adapter.dispatch({ kind: "GRANT_GPS" });
    adapter.dispatch({
      kind: "SET_FILTERS",
      filters: { maxDistanceMetres: 1000, cuisine: "CHINESE", venueType: null, attribute: null },
    });
    let state = adapter.getState();
    expect(state.kind).toBe("RESULTS_MAP");
    if (state.kind !== "RESULTS_MAP") return;
    expect(state.venues.map((v) => v.id)).toEqual(["venue-001", "venue-002"]);

    adapter.dispatch({
      kind: "SET_FILTERS",
      filters: { maxDistanceMetres: null, cuisine: null, venueType: "MARKET", attribute: null },
    });
    state = adapter.getState();
    if (state.kind !== "RESULTS_MAP") throw new Error(state.kind);
    expect(state.venues.map((v) => v.id)).toEqual(["venue-003"]);
    const distances = DEMO_FOOD_VENUES.map((v) => v.distanceMetres);
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
  });

  it("matches a governed attribute filter only with a governed record", () => {
    const adapter = createNearbyFoodAdapter();
    adapter.dispatch({ kind: "REQUEST_GPS" });
    adapter.dispatch({ kind: "GRANT_GPS" });
    adapter.dispatch({
      kind: "SET_FILTERS",
      filters: { maxDistanceMetres: null, cuisine: null, venueType: null, attribute: "LOWER_IN_SUGAR" },
    });
    // No default fixture venue carries governed evidence, so nothing matches.
    expect(adapter.getState().kind).toBe("NO_RESULTS");
    adapter.dispatch({
      kind: "SET_FILTERS",
      filters: { maxDistanceMetres: null, cuisine: null, venueType: null, attribute: null },
    });
    expect(adapter.getState().kind).toBe("RESULTS_MAP");
    for (const venue of DEMO_FOOD_VENUES) expect(venue.governedAttributes).toEqual([]);
  });

  // --- State 10: DIRECTORY_UNAVAILABLE ---
  it("state 10 DIRECTORY_UNAVAILABLE: after SIMULATE_DIRECTORY_UNAVAILABLE", () => {
    const adapter = createNearbyFoodAdapter();
    adapter.dispatch({ kind: "SIMULATE_DIRECTORY_UNAVAILABLE" });
    expect(adapter.getState().kind).toBe("DIRECTORY_UNAVAILABLE");
  });

  // --- State 11: OFFLINE ---
  it("state 11 OFFLINE: after SIMULATE_OFFLINE, shows snapshot date", () => {
    const adapter = createNearbyFoodAdapter();
    adapter.dispatch({ kind: "SIMULATE_OFFLINE" });
    const state = adapter.getState();
    expect(state.kind).toBe("OFFLINE");
    if (state.kind !== "OFFLINE") return;
    expect(state.snapshotDate).toBe(DEMO_OFFLINE_SNAPSHOT_DATE);
    expect(state.venues.length).toBeGreaterThan(0);
  });

  // --- State 12: VENUE_DETAILS ---
  it("state 12 VENUE_DETAILS: after SELECT_VENUE, shows venue with no directions", () => {
    const adapter = createNearbyFoodAdapter();
    adapter.dispatch({ kind: "REQUEST_GPS" });
    adapter.dispatch({ kind: "GRANT_GPS" });
    adapter.dispatch({ kind: "SELECT_VENUE", venueId: DEMO_FOOD_VENUES[0]!.id });
    const state = adapter.getState();
    expect(state.kind).toBe("VENUE_DETAILS");
    if (state.kind !== "VENUE_DETAILS") return;
    expect(state.venue.id).toBe(DEMO_FOOD_VENUES[0]!.id);
    expect(state.venue.directionsUrl).toBeNull();
  });

  // --- Compliance: no badge without governed evidence ---
  it("no venue has an HPB / lower-GI / healthier badge by default", () => {
    for (const venue of DEMO_FOOD_VENUES) {
      expect(venue.badge).toBeNull();
    }
  });

  // --- Compliance: GPS only after explicit press ---
  it("GPS is not requested until REQUEST_GPS event", () => {
    const adapter = createNearbyFoodAdapter();
    // IDLE — no GPS
    expect(adapter.getState().kind).toBe("IDLE");
    // After search by text — no GPS
    adapter.dispatch({ kind: "SEARCH_BY_TEXT", query: "Jelutong" });
    expect(adapter.getState().kind).not.toBe("PRE_PERMISSION");
    // Only after REQUEST_GPS
    adapter.dispatch({ kind: "REQUEST_GPS" });
    expect(adapter.getState().kind).toBe("PRE_PERMISSION");
  });

  // --- Compliance: CANCEL_GPS returns to IDLE ---
  it("CANCEL_GPS returns to IDLE", () => {
    const adapter = createNearbyFoodAdapter();
    adapter.dispatch({ kind: "REQUEST_GPS" });
    adapter.dispatch({ kind: "CANCEL_GPS" });
    expect(adapter.getState().kind).toBe("IDLE");
  });

  // --- Subscription ---
  it("subscribe receives state updates", () => {
    const adapter = createNearbyFoodAdapter();
    const states: string[] = [];
    const unsubscribe = adapter.subscribe((s) => states.push(s.kind));
    adapter.dispatch({ kind: "REQUEST_GPS" });
    adapter.dispatch({ kind: "DENY_GPS" });
    expect(states).toEqual(["PRE_PERMISSION", "PERMISSION_DENIED"]);
    unsubscribe();
    adapter.dispatch({ kind: "RESET" });
    expect(states).toEqual(["PRE_PERMISSION", "PERMISSION_DENIED"]);
  });
});
