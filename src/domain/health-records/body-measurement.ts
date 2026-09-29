import { z } from "zod";
import { createMeasurementValueSchema } from "./measurement";
import { timePointSchema } from "../shared/temporal";
import { DeletionPolicy } from "../shared/record-catalogue";

// --- Section 3.7: Body-measurement deletion policy ---

export const BODY_MEASUREMENT_DELETION_POLICY = DeletionPolicy.PATIENT_DELETABLE;

// --- Section 3.7: BodyMeasurementPayload ---

export type BodyMeasurementPayload =
  | {
      kind: "WEIGHT";
      measurement: MeasurementValue<"KG" | "LB", "KG">;
    }
  | {
      kind: "HEIGHT";
      measurement: MeasurementValue<"CM" | "IN", "CM">;
    };

// Import the type for the union above.
import type { MeasurementValue } from "./measurement";

const weightMeasurementSchema = createMeasurementValueSchema(
  z.enum(["KG", "LB"]),
  z.enum(["KG"]),
);

const heightMeasurementSchema = createMeasurementValueSchema(
  z.enum(["CM", "IN"]),
  z.enum(["CM"]),
);

export const bodyMeasurementPayloadSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("WEIGHT"),
    measurement: weightMeasurementSchema,
  }),
  z.strictObject({
    kind: z.literal("HEIGHT"),
    measurement: heightMeasurementSchema,
  }),
]);

// --- Section 3.7: BodyMeasurementTemporal ---

// Reuses Packet 2A's timePointSchema for timestamp, local-date, timezone,
// and UTC-offset validation. Only allows POINT with EXACT, APPROXIMATE, or
// DATE_ONLY occurrence — rejects UNKNOWN occurrence, INTERVAL, and ATEMPORAL.
export const bodyMeasurementTemporalSchema = z
  .strictObject({
    kind: z.literal("POINT"),
    occurrence: timePointSchema.refine(
      (tp) => tp.kind !== "UNKNOWN",
      "Body-measurement occurrence must be EXACT, APPROXIMATE, or DATE_ONLY",
    ),
  });

export type BodyMeasurementTemporal = z.infer<typeof bodyMeasurementTemporalSchema>;