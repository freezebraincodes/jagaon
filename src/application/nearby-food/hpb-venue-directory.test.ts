import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { NO_FOOD_FILTERS, nearbyFoodPlaceSchema } from "./nearby-food-contracts";
import { HPB_SNAPSHOT_DESCRIPTOR, HPB_SNAPSHOT_SHA256, createHpbVenueDirectory, createSnapshotPostalGeocoder } from "./hpb-venue-directory";

const SNAPSHOT_TEXT = readFileSync(join(process.cwd(), "public/data/hpb-nearby-food-v1.json"), "utf8");
const MANIFEST = JSON.parse(readFileSync(join(process.cwd(), "public/data/hpb-nearby-food-v1.manifest.json"), "utf8"));

// Paragon, Orchard Road: an accepted, badged venue in the snapshot.
const ORCHARD = { latitude: 1.3039, longitude: 103.8357 };

describe("bundled HPB snapshot directory", () => {
  it("pins the exact snapshot checksum recorded in the manifest", () => {
    expect(HPB_SNAPSHOT_SHA256).toBe(MANIFEST.snapshot.sha256);
    expect(HPB_SNAPSHOT_DESCRIPTOR).toEqual({
      kind: "HPB_SNAPSHOT",
      snapshotVersion: "hpb-nearby-food.1",
      criteriaDatasetDate: "2026-10-02",
      coordinatesDatasetDate: "2026-01-04",
      licenceUrl: "https://data.gov.sg/open-data-licence",
    });
  });

  it("returns bounded, distance-sorted places within the radius with exact HPB wording and dataset dates", async () => {
    const directory = createHpbVenueDirectory(async () => SNAPSHOT_TEXT);
    const result = await directory.findNearby({ origin: ORCHARD, radiusMetres: 1000, filters: NO_FOOD_FILTERS });
    if (result.kind !== "RESULTS") throw new Error("expected results");
    expect(result.directory).toEqual(HPB_SNAPSHOT_DESCRIPTOR);
    expect(result.places.length).toBeGreaterThan(5);
    expect(result.places.length).toBeLessThanOrEqual(40);
    const distances = result.places.map((place) => place.distanceMetres);
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
    expect(distances.every((distance) => Number.isFinite(distance) && distance <= 1000)).toBe(true);
    for (const place of result.places) expect(nearbyFoodPlaceSchema.safeParse(place).success).toBe(true);
    // Unmatched and ambiguous venues remain listed without a badge.
    expect(result.places.some((place) => place.governedAttributes.length === 0 && place.evidenceSource === null)).toBe(true);
    expect(result.places.some((place) => place.governedAttributes.length > 0)).toBe(true);
  });

  it("filters only by the person's explicit choices", async () => {
    const directory = createHpbVenueDirectory(async () => SNAPSHOT_TEXT);
    const all = await directory.findNearby({ origin: ORCHARD, radiusMetres: 2000, filters: NO_FOOD_FILTERS });
    const sugar = await directory.findNearby({ origin: ORCHARD, radiusMetres: 2000, filters: { ...NO_FOOD_FILTERS, attribute: "LOWER_IN_SUGAR" } });
    const near = await directory.findNearby({ origin: ORCHARD, radiusMetres: 2000, filters: { ...NO_FOOD_FILTERS, maxDistanceMetres: 500 } });
    if (all.kind !== "RESULTS" || sugar.kind !== "RESULTS" || near.kind !== "RESULTS") throw new Error("expected results");
    expect(sugar.places.length).toBeGreaterThan(0);
    for (const place of sugar.places) {
      expect(place.governedAttributes.some((attribute) => attribute.criterion.startsWith("Lower in sugar"))).toBe(true);
    }
    expect(near.places.every((place) => place.distanceMetres <= 500)).toBe(true);
  });

  it("reports the snapshot unavailable or invalid rather than inventing venues", async () => {
    const failing = createHpbVenueDirectory(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await failing.findNearby({ origin: ORCHARD, radiusMetres: 1000, filters: NO_FOOD_FILTERS })).toEqual({ kind: "UNAVAILABLE", reason: "SNAPSHOT_UNAVAILABLE" });
    const tampered = createHpbVenueDirectory(async () => SNAPSHOT_TEXT.replace("Lower in sugar", "Lower in sugar!"));
    expect(await tampered.findNearby({ origin: ORCHARD, radiusMetres: 1000, filters: NO_FOOD_FILTERS })).toEqual({ kind: "UNAVAILABLE", reason: "SNAPSHOT_INVALID" });
  });

  it("loads the snapshot once and reuses it", async () => {
    const load = vi.fn(async () => SNAPSHOT_TEXT);
    const directory = createHpbVenueDirectory(load);
    await directory.findNearby({ origin: ORCHARD, radiusMetres: 500, filters: NO_FOOD_FILTERS });
    await directory.findNearby({ origin: ORCHARD, radiusMetres: 500, filters: NO_FOOD_FILTERS });
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe("snapshot postal-code geocoder (no network)", () => {
  it("resolves a postal code that appears in the governed snapshot and nothing else", async () => {
    const geocoder = createSnapshotPostalGeocoder(async () => SNAPSHOT_TEXT);
    expect(geocoder.providerId).toBe("SNAPSHOT_POSTAL");
    const paragon = await geocoder.resolve("238859");
    expect(paragon).toMatchObject({ kind: "RESOLVED", location: { label: "238859" } });
    expect(await geocoder.resolve("000001")).toEqual({ kind: "NOT_FOUND" });
    expect(await geocoder.resolve("Orchard Road")).toEqual({ kind: "NOT_FOUND" });
  });
});
