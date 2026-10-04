import { z } from "zod";
import { localDateSchema } from "@/domain/shared/time";
import { sha256DigestSchema } from "@/application/contracts/canonical-json";
import {
  CUISINE_GROUPS,
  HPB_FNB_PARTNERS_DATASET_ID,
  HPB_HEALTHIER_EATERIES_DATASET_ID,
  HPB_MENU_CRITERIA,
  VENUE_TYPES,
  coordinatesSchema,
  distanceBetweenMetres,
  isWithinSingapore,
  type Coordinates,
  type NearbyFoodPlace,
} from "./nearby-food-contracts";

/**
 * Strict schemas for the bundled, versioned HPB/data.gov.sg snapshot and its
 * manifest (Packet 9A Task 2). A snapshot that fails validation is never
 * shown: the directory reports itself unavailable instead.
 */

export const HPB_SNAPSHOT_VERSION = "hpb-nearby-food.1";

const hpbVenueSchema = z
  .strictObject({
    id: z.string().regex(/^hpb-\d+$/),
    name: z.string().min(1).max(200),
    address: z.string().min(1).max(300),
    latitude: z.number().finite(),
    longitude: z.number().finite(),
    cuisineLabels: z.array(z.string().min(1).max(80)).max(1),
    cuisineGroups: z.array(z.enum(CUISINE_GROUPS)).max(1),
    venueType: z.enum(VENUE_TYPES).nullable(),
    criteria: z.array(z.enum(HPB_MENU_CRITERIA)).max(HPB_MENU_CRITERIA.length),
  })
  .superRefine((venue, ctx) => {
    if (!isWithinSingapore({ latitude: venue.latitude, longitude: venue.longitude })) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "VENUE_OUTSIDE_SINGAPORE", path: ["latitude"] });
    }
    if (new Set(venue.criteria).size !== venue.criteria.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "DUPLICATE_CRITERION", path: ["criteria"] });
    }
  });

export const hpbNearbyFoodSnapshotSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    snapshotVersion: z.literal(HPB_SNAPSHOT_VERSION),
    criteriaDatasetDate: localDateSchema,
    coordinatesDatasetDate: localDateSchema,
    venues: z.array(hpbVenueSchema).max(5000),
  })
  .superRefine((snapshot, ctx) => {
    const ids = snapshot.venues.map((venue) => venue.id);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "DUPLICATE_VENUE_ID", path: ["venues"] });
  });

export type HpbNearbyFoodSnapshotV1 = z.infer<typeof hpbNearbyFoodSnapshotSchema>;

const countSchema = z.number().int().nonnegative();

const sourceSchema = z.strictObject({
  role: z.enum(["CRITERIA", "COORDINATES"]),
  datasetId: z.enum([HPB_FNB_PARTNERS_DATASET_ID, HPB_HEALTHIER_EATERIES_DATASET_ID]),
  name: z.string().min(1),
  publisher: z.literal("Health Promotion Board"),
  sourceUrl: z.string().url(),
  format: z.enum(["CSV", "GEOJSON"]),
  sourcePublishedAt: z.string().min(10),
  retrievedAt: z.string().min(10),
  sha256: sha256DigestSchema,
  byteLength: z.number().int().positive(),
});

export const hpbSnapshotManifestSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    snapshotVersion: z.literal(HPB_SNAPSHOT_VERSION),
    transformVersion: z.literal("transform-hpb-nearby-food.1"),
    sources: z.tuple([sourceSchema, sourceSchema]),
    licence: z.strictObject({ name: z.string().min(1), url: z.string().url() }),
    snapshot: z.strictObject({ path: z.literal("data/hpb-nearby-food-v1.json"), sha256: sha256DigestSchema, byteLength: z.number().int().positive() }),
    counts: z.strictObject({
      criteriaInputRows: countSchema,
      criteriaAccepted: countSchema,
      criteriaRejected: countSchema,
      criteriaUnmatched: countSchema,
      criteriaAmbiguous: countSchema,
      coordinateInputFeatures: countSchema,
      coordinateAccepted: countSchema,
      coordinateRejected: countSchema,
      venuesWithGovernedCriteria: countSchema,
      venuesWithoutGovernedCriteria: countSchema,
    }),
    matchingRules: z.tuple([
      z.literal("R1_SINGLE_POSTAL"),
      z.literal("R2_SINGLE_UNIT"),
      z.literal("R3_UNIQUE_POSTAL_FLOOR_UNIT"),
      z.literal("R3B_SINGLE_POSTAL_NO_UNIT"),
      z.literal("R4_OTHERWISE_UNBADGED"),
    ]),
  })
  .superRefine((manifest, ctx) => {
    const [criteria, coordinates] = manifest.sources;
    if (criteria.role !== "CRITERIA" || criteria.datasetId !== HPB_FNB_PARTNERS_DATASET_ID || coordinates.role !== "COORDINATES" || coordinates.datasetId !== HPB_HEALTHIER_EATERIES_DATASET_ID) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "SOURCE_ROLES_INVALID", path: ["sources"] });
    }
    const c = manifest.counts;
    if (c.criteriaAccepted + c.criteriaRejected + c.criteriaUnmatched + c.criteriaAmbiguous !== c.criteriaInputRows) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "CRITERIA_COUNTS_DO_NOT_RECONCILE", path: ["counts"] });
    }
    if (c.coordinateAccepted + c.coordinateRejected !== c.coordinateInputFeatures || c.venuesWithGovernedCriteria + c.venuesWithoutGovernedCriteria !== c.coordinateAccepted) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "COORDINATE_COUNTS_DO_NOT_RECONCILE", path: ["counts"] });
    }
  });

export type HpbSnapshotManifestV1 = z.infer<typeof hpbSnapshotManifestSchema>;

/** Converts validated snapshot venues into provider-neutral places measured from one origin. */
export function placesFromSnapshot(snapshot: HpbNearbyFoodSnapshotV1, origin: Coordinates): NearbyFoodPlace[] {
  coordinatesSchema.parse(origin);
  return snapshot.venues.map((venue) => {
    const coordinates = { latitude: venue.latitude, longitude: venue.longitude };
    const governed = venue.criteria.length > 0;
    return {
      id: venue.id,
      name: venue.name,
      address: venue.address,
      coordinates,
      distanceMetres: distanceBetweenMetres(origin, coordinates),
      cuisineLabels: [...venue.cuisineLabels],
      cuisineGroups: [...venue.cuisineGroups],
      venueType: venue.venueType,
      venueSource: { kind: "GOVERNED_DATASET", datasetId: HPB_HEALTHIER_EATERIES_DATASET_ID, snapshotVersion: snapshot.snapshotVersion },
      governedAttributes: venue.criteria.map((criterion) => ({ vocabulary: "HPB_HEALTHIER_DINING_MENU_CRITERIA" as const, criterion })),
      evidenceSource: governed ? { kind: "GOVERNED_DATASET", datasetId: HPB_FNB_PARTNERS_DATASET_ID, snapshotVersion: snapshot.snapshotVersion } : null,
    };
  });
}
