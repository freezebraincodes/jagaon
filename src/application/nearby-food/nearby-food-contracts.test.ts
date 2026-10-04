import { describe, expect, it } from "vitest";
import {
  HPB_MENU_CRITERIA,
  HPB_CRITERION_FILTERS,
  coordinatesSchema,
  distanceBetweenMetres,
  filterAttributesOf,
  isWithinSingapore,
  nearbyFoodPlaceSchema,
  nearbyFoodSearchRequestSchema,
  sortPlacesByDistance,
  type NearbyFoodPlace,
} from "./nearby-food-contracts";
import { createSyntheticNearbyFood, SYNTHETIC_ORIGIN, SYNTHETIC_PLACES } from "./synthetic-nearby-food";

const place = (overrides: Partial<NearbyFoodPlace> = {}): NearbyFoodPlace => ({
  id: "p-1",
  name: "Place",
  address: "1 Road Singapore 123456",
  coordinates: { latitude: 1.3, longitude: 103.8 },
  distanceMetres: 10,
  cuisineLabels: [],
  cuisineGroups: [],
  venueType: null,
  venueSource: { kind: "SYNTHETIC_FIXTURE", fixtureVersion: "synthetic-nearby-food.1" },
  governedAttributes: [],
  evidenceSource: null,
  ...overrides,
});

describe("provider-neutral nearby-food contracts", () => {
  it("accepts only finite, in-range coordinates and knows Singapore's bounds", () => {
    expect(coordinatesSchema.safeParse({ latitude: 1.3, longitude: 103.8 }).success).toBe(true);
    for (const bad of [
      { latitude: 91, longitude: 0 },
      { latitude: 0, longitude: 181 },
      { latitude: Number.NaN, longitude: 103.8 },
      { latitude: 1.3, longitude: Number.POSITIVE_INFINITY },
      { latitude: 1.3, longitude: 103.8, accuracy: 5 },
    ]) {
      expect(coordinatesSchema.safeParse(bad).success).toBe(false);
    }
    expect(isWithinSingapore({ latitude: 1.3521, longitude: 103.8198 })).toBe(true);
    expect(isWithinSingapore({ latitude: 51.5, longitude: -0.12 })).toBe(false);
  });

  it("keeps the search request strict: an origin, a radius and user filters only", () => {
    const request = { origin: { latitude: 1.3, longitude: 103.8 }, radiusMetres: 2000, filters: { maxDistanceMetres: null, cuisine: null, venueType: null, attribute: null } };
    expect(nearbyFoodSearchRequestSchema.safeParse(request).success).toBe(true);
    // No health, medication, symptom, adherence or patient field can ride along.
    for (const extra of [{ glucose: "7.2" }, { medication: "x" }, { patientId: "p" }, { symptoms: [] }]) {
      expect(nearbyFoodSearchRequestSchema.safeParse({ ...request, ...extra }).success).toBe(false);
    }
    expect(nearbyFoodSearchRequestSchema.safeParse({ ...request, radiusMetres: 50_000 }).success).toBe(false);
  });

  it("closes the governed vocabulary over the nine exact HPB criteria and never widens them", () => {
    expect(HPB_MENU_CRITERIA).toEqual([
      "Higher in wholegrains",
      "Higher in wholegrains and lower in calories",
      "Lower in sugar",
      "Lower in sugar and source of dietary fibre",
      "Lower in calories",
      "Lower in calories and sodium",
      "No added sugar",
      "Healthier children's meal",
      "Lower in sodium",
    ]);
    expect(filterAttributesOf([{ vocabulary: "HPB_HEALTHIER_DINING_MENU_CRITERIA", criterion: "Higher in wholegrains and lower in calories" }])).toEqual([
      "HIGHER_IN_WHOLEGRAINS",
      "LOWER_IN_CALORIES",
    ]);
    expect(HPB_CRITERION_FILTERS["No added sugar"]).toEqual([]);
    expect(HPB_CRITERION_FILTERS["Lower in sodium"]).toEqual([]);
    for (const criterion of HPB_MENU_CRITERIA) expect(criterion.toLowerCase()).not.toMatch(/\bgi\b|glyc/);
    expect(
      nearbyFoodPlaceSchema.safeParse(
        place({ governedAttributes: [{ vocabulary: "HPB_HEALTHIER_DINING_MENU_CRITERIA", criterion: "Lower GI" as never }] }),
      ).success,
    ).toBe(false);
  });

  it("keeps provider facts and governed evidence as distinct sources", () => {
    // A governed attribute requires a governed-dataset evidence source.
    const badged = place({ governedAttributes: [{ vocabulary: "HPB_HEALTHIER_DINING_MENU_CRITERIA", criterion: "Lower in sugar" }] });
    expect(nearbyFoodPlaceSchema.safeParse(badged).success).toBe(false);
    // A synthetic fixture can never carry a governed attribute.
    expect(
      nearbyFoodPlaceSchema.safeParse({
        ...badged,
        evidenceSource: { kind: "GOVERNED_DATASET", datasetId: "d_c475b9170c08f90580f4041bffd51639", snapshotVersion: "hpb-nearby-food.1" },
      }).success,
    ).toBe(false);
    expect(nearbyFoodPlaceSchema.safeParse(place()).success).toBe(true);
  });

  it("measures distance deterministically and sorts ties by name then id without NaN", () => {
    const origin = { latitude: 1.3, longitude: 103.8 };
    expect(distanceBetweenMetres(origin, origin)).toBe(0);
    const d = distanceBetweenMetres(origin, { latitude: 1.31, longitude: 103.8 });
    expect(d).toBeGreaterThan(1100);
    expect(d).toBeLessThan(1120);
    // Antimeridian-safe and symmetric.
    expect(distanceBetweenMetres({ latitude: 0, longitude: 179.9 }, { latitude: 0, longitude: -179.9 })).toBeLessThan(25_000);
    const sorted = sortPlacesByDistance([
      place({ id: "b", name: "B", distanceMetres: 100 }),
      place({ id: "a2", name: "A", distanceMetres: 100 }),
      place({ id: "a1", name: "A", distanceMetres: 100 }),
      place({ id: "z", name: "Z", distanceMetres: 5 }),
    ]);
    expect(sorted.map((entry) => entry.id)).toEqual(["z", "a1", "a2", "b"]);
  });
});

describe("synthetic adapter on the shared contract", () => {
  it("returns the five fixture places as clearly labelled, unbadged synthetic results", async () => {
    const synthetic = createSyntheticNearbyFood();
    expect(synthetic.profile).toEqual({ geocoder: "SYNTHETIC", map: { kind: "STATIC_DEMO" }, directory: "SYNTHETIC" });
    const resolved = await synthetic.resolveManualLocation("238823");
    expect(resolved).toEqual({ kind: "RESOLVED", location: { label: "238823", coordinates: SYNTHETIC_ORIGIN } });
    const result = await synthetic.findNearby({ origin: SYNTHETIC_ORIGIN, radiusMetres: 2000, filters: { maxDistanceMetres: null, cuisine: null, venueType: null, attribute: null } });
    if (result.kind !== "RESULTS") throw new Error("expected results");
    expect(result.places.map((entry) => entry.name)).toEqual(SYNTHETIC_PLACES.map((entry) => entry.name));
    for (const entry of result.places) {
      expect(nearbyFoodPlaceSchema.safeParse(entry).success).toBe(true);
      expect(entry.venueSource.kind).toBe("SYNTHETIC_FIXTURE");
      expect(entry.governedAttributes).toEqual([]);
      expect(entry.name).toMatch(/\(demo\)$/);
    }
    expect(result.directory).toEqual({ kind: "SYNTHETIC" });
    expect(await synthetic.resolveManualLocation("ab")).toMatchObject({ kind: "AMBIGUOUS" });
  });
});
