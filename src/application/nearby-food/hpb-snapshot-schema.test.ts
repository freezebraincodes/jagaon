import { describe, expect, it } from "vitest";
import { HPB_MENU_CRITERIA, nearbyFoodPlaceSchema } from "./nearby-food-contracts";
import { hpbNearbyFoodSnapshotSchema, hpbSnapshotManifestSchema, placesFromSnapshot } from "./hpb-snapshot-schema";
// The transform is a plain Node ESM script so it can run outside the app build.
import { HPB_CRITERIA_V1, parseCsv, transformHpbSources } from "../../../scripts/transform-hpb-nearby-food.mjs";

const HEADER = "Company_Name,Brand_Name,FnB_Setting,Dining_Concept,Category,Name_of_Outlet,Outlet_Address,Regions,Menu_Item_Endorsement_Criteria";
const row = (outlet: string, address: string, criteria: string, setting = "Café", category = "Western") =>
  `Co,Brand,${setting},Non-Halal,${category},${outlet},${address},Central,"${criteria}"`;

const feature = (id: number, postal: string, floor: string | null, unit: string | null, name: string, lon = 103.85, lat = 1.3) => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: [lon, lat] },
  properties: {
    OBJECTID: id,
    ADDRESSBLOCKHOUSENUMBER: "1",
    ADDRESSBUILDINGNAME: "Demo Mall",
    ADDRESSPOSTALCODE: postal,
    ADDRESSSTREETNAME: "Demo Road",
    NAME: name,
    ADDRESSFLOORNUMBER: floor,
    ADDRESSUNITNUMBER: unit,
  },
});

const META = {
  criteria: { lastUpdatedAt: "2026-10-02T19:01:41+08:00", retrievedAt: "2026-10-03T15:58:09Z" },
  coordinates: { lastUpdatedAt: "2026-01-04T10:06:47+08:00", retrievedAt: "2026-10-03T15:58:30Z" },
};

function fixture() {
  const csv = [
    HEADER,
    // Accepted: exact postal + floor + unit, combined and multi criteria.
    row("Cafe One - Demo Mall", "1 Demo Road #01-05 Demo Mall Singapore 111111", "No added sugar,  Higher in wholegrains and lower in calories"),
    // Ambiguous: two F&B rows share one postal + unit key.
    row("Stall A", "2 Demo Road #02-01 Singapore 222222", "Lower in sugar", "Hawker", "Hawker Food"),
    row("Stall B", "2 Demo Road #02-01 Singapore 222222", "Lower in calories", "Hawker", "Hawker Food"),
    // Unmatched: postal absent from the geospatial file.
    row("Far Cafe", "9 Far Road #01-01 Singapore 999999", "Lower in sugar"),
    // Rejected: no postal code.
    row("No Postal", "Blk 730 Ang Mo Kio Ave 6", "Lower in sugar"),
    // Ambiguous: two geo points at the same postal + unit.
    row("Twin", "3 Demo Road #01-01 Singapore 333333", "Lower in calories", "Hawker", "Chinese"),
    // Accepted without a unit: one geo point and one F&B row at the postal code.
    row("Kiosk Solo", "4 Demo Road Singapore 444444", "Lower in sodium", "Kiosk", "Drinks"),
  ].join("\n");
  const geo = {
    type: "FeatureCollection",
    features: [
      feature(30, "111111", "1", "5", "Cafe One - Demo Mall"),
      feature(31, "222222", "2", "1", "Stall Unknown"),
      feature(32, "333333", "1", "1", "Twin East"),
      feature(33, "333333", "01", "001", "Twin West"),
      feature(34, "444444", null, null, "Kiosk Solo"),
      feature(35, "555555", "1", "1", "Geo Only Eatery"),
      feature(36, "666666", "1", "1", "Out of Area", -0.12, 51.5),
    ],
  };
  return { csv, geo: JSON.stringify(geo) };
}

describe("HPB snapshot transform", () => {
  it("pins the transform vocabulary to the contract's exact HPB criteria", () => {
    expect(HPB_CRITERIA_V1).toEqual([...HPB_MENU_CRITERIA]);
  });

  it("parses quoted CSV fields, including commas and doubled quotes", () => {
    expect(parseCsv('a,b\n"x, y","say ""hi"""\n')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
    ]);
  });

  it("accepts only exact 1:1 postal+floor+unit matches and leaves every uncertain row unbadged", () => {
    const { csv, geo } = fixture();
    const result = transformHpbSources({ fnbCsvText: csv, geoJsonText: geo, metadata: META });
    type Venue = { name: string; criteria: string[]; cuisineLabels: string[] };
    const byName: Record<string, Venue> = Object.fromEntries(result.snapshot.venues.map((venue: Venue) => [venue.name, venue]));

    expect(byName["Cafe One - Demo Mall"].criteria).toEqual(["Higher in wholegrains and lower in calories", "No added sugar"]);
    expect(byName["Cafe One - Demo Mall"].cuisineLabels).toEqual(["Western"]);
    expect(byName["Kiosk Solo"].criteria).toEqual(["Lower in sodium"]);
    // Ambiguous and geo-only venues remain plain venues without a badge.
    expect(byName["Stall Unknown"].criteria).toEqual([]);
    expect(byName["Twin East"].criteria).toEqual([]);
    expect(byName["Twin West"].criteria).toEqual([]);
    expect(byName["Geo Only Eatery"].criteria).toEqual([]);
    // Out-of-Singapore coordinates are rejected outright.
    expect(byName["Out of Area"]).toBeUndefined();

    expect(result.counts).toEqual({
      criteriaInputRows: 7,
      criteriaAccepted: 2,
      criteriaRejected: 1,
      criteriaUnmatched: 1,
      criteriaAmbiguous: 3,
      coordinateInputFeatures: 7,
      coordinateAccepted: 6,
      coordinateRejected: 1,
      venuesWithGovernedCriteria: 2,
      venuesWithoutGovernedCriteria: 4,
    });
    expect(result.review.ambiguous.map((entry: { outlet: string }) => entry.outlet).sort()).toEqual(["Stall A", "Stall B", "Twin"]);
  });

  it("produces byte-identical, id-ordered output on every run", () => {
    const { csv, geo } = fixture();
    const first = transformHpbSources({ fnbCsvText: csv, geoJsonText: geo, metadata: META });
    const second = transformHpbSources({ fnbCsvText: csv, geoJsonText: geo, metadata: META });
    expect(first.snapshotText).toBe(second.snapshotText);
    expect(first.snapshotText.endsWith("\n")).toBe(true);
    const ids = first.snapshot.venues.map((venue: { id: string }) => venue.id);
    expect(ids).toEqual(["hpb-30", "hpb-31", "hpb-32", "hpb-33", "hpb-34", "hpb-35"]);
  });

  it("fails closed on an unknown endorsement criterion rather than inventing vocabulary", () => {
    const { geo } = fixture();
    const csv = [HEADER, row("X", "1 Demo Road #01-05 Singapore 111111", "Lower GI")].join("\n");
    expect(() => transformHpbSources({ fnbCsvText: csv, geoJsonText: geo, metadata: META })).toThrow(/UNKNOWN_CRITERION/);
  });
});

describe("runtime snapshot schema", () => {
  it("validates the generated snapshot and turns it into contract-valid places", () => {
    const { csv, geo } = fixture();
    const { snapshot } = transformHpbSources({ fnbCsvText: csv, geoJsonText: geo, metadata: META });
    const parsed = hpbNearbyFoodSnapshotSchema.parse(snapshot);
    const places = placesFromSnapshot(parsed, { latitude: 1.3, longitude: 103.85 });
    for (const place of places) expect(nearbyFoodPlaceSchema.safeParse(place).success).toBe(true);
    const badged = places.filter((place) => place.governedAttributes.length > 0);
    expect(badged.map((place) => place.evidenceSource)).toEqual([
      { kind: "GOVERNED_DATASET", datasetId: "d_c475b9170c08f90580f4041bffd51639", snapshotVersion: "hpb-nearby-food.1" },
      { kind: "GOVERNED_DATASET", datasetId: "d_c475b9170c08f90580f4041bffd51639", snapshotVersion: "hpb-nearby-food.1" },
    ]);
    expect(places.every((place) => place.venueSource.kind === "GOVERNED_DATASET")).toBe(true);
  });

  it("rejects a tampered snapshot with unknown wording or extra fields", () => {
    const { csv, geo } = fixture();
    const { snapshot } = transformHpbSources({ fnbCsvText: csv, geoJsonText: geo, metadata: META });
    const tampered = structuredClone(snapshot);
    tampered.venues[0].criteria = ["Lower GI"];
    expect(hpbNearbyFoodSnapshotSchema.safeParse(tampered).success).toBe(false);
    expect(hpbNearbyFoodSnapshotSchema.safeParse({ ...snapshot, userLocation: [1, 2] }).success).toBe(false);
  });

  it("describes sources, licence, checksums and counts in the manifest", () => {
    const manifest = {
      schemaVersion: 1,
      snapshotVersion: "hpb-nearby-food.1",
      transformVersion: "transform-hpb-nearby-food.1",
      sources: [
        { role: "CRITERIA", datasetId: "d_c475b9170c08f90580f4041bffd51639", name: "Healthier Dining Partners - F&B Partners", publisher: "Health Promotion Board", sourceUrl: "https://data.gov.sg/datasets/d_c475b9170c08f90580f4041bffd51639/view", format: "CSV", sourcePublishedAt: "2026-10-02T19:01:41+08:00", retrievedAt: "2026-10-03T15:58:09Z", sha256: "a".repeat(64), byteLength: 1 },
        { role: "COORDINATES", datasetId: "d_2925c2ccf75d1c135c2d469e0de3cee6", name: "Healthier Eateries", publisher: "Health Promotion Board", sourceUrl: "https://data.gov.sg/datasets/d_2925c2ccf75d1c135c2d469e0de3cee6/view", format: "GEOJSON", sourcePublishedAt: "2026-01-04T10:06:47+08:00", retrievedAt: "2026-10-03T15:58:30Z", sha256: "b".repeat(64), byteLength: 1 },
      ],
      licence: { name: "Singapore Open Data Licence version 1.0", url: "https://data.gov.sg/open-data-licence" },
      snapshot: { path: "data/hpb-nearby-food-v1.json", sha256: "c".repeat(64), byteLength: 1 },
      counts: { criteriaInputRows: 1, criteriaAccepted: 1, criteriaRejected: 0, criteriaUnmatched: 0, criteriaAmbiguous: 0, coordinateInputFeatures: 1, coordinateAccepted: 1, coordinateRejected: 0, venuesWithGovernedCriteria: 1, venuesWithoutGovernedCriteria: 0 },
      matchingRules: ["R1_SINGLE_POSTAL", "R2_SINGLE_UNIT", "R3_UNIQUE_POSTAL_FLOOR_UNIT", "R3B_SINGLE_POSTAL_NO_UNIT", "R4_OTHERWISE_UNBADGED"],
    };
    expect(hpbSnapshotManifestSchema.safeParse(manifest).success).toBe(true);
    expect(hpbSnapshotManifestSchema.safeParse({ ...manifest, sources: [manifest.sources[0]] }).success).toBe(false);
  });
});
