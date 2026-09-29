import { z } from "zod";
import { createMeasurementValueSchema } from "./measurement";
import type { MeasurementValue } from "./measurement";
import { patientAuthoredNoteSchema } from "./patient-authored-note";
import type { PatientAuthoredNote } from "./patient-authored-note";
import { createTypedRevisionRefSchema } from "../shared/typed-revision-ref";
import type { TypedRevisionRef } from "../shared/typed-revision-ref";
import { DeletionPolicy } from "../shared/record-catalogue";

// --- Section 4.5 / 4.7: Shared reading boundaries ---

export const KETONE_READING_DELETION_POLICY = DeletionPolicy.PATIENT_DELETABLE;

export const KETONE_READING_REVISION_ACTIONS = [
  "CREATE",
  "CORRECT",
  "CONFIRM",
  "SYSTEM_DERIVE",
] as const;

// --- Section 4.5: Blood ketone measurement methods ---

export const bloodKetoneMeasurementMethodSchema = z.enum([
  "BLOOD_KETONE_METER",
  "LAB",
  "OTHER",
  "UNKNOWN",
]);

export type BloodKetoneMeasurementMethod = z.infer<
  typeof bloodKetoneMeasurementMethodSchema
>;

// --- Section 4.5: Urine ketone measurement methods ---

export const urineKetoneMeasurementMethodSchema = z.enum([
  "URINE_TEST_STRIP",
  "LAB",
  "OTHER",
  "UNKNOWN",
]);

export type UrineKetoneMeasurementMethod = z.infer<
  typeof urineKetoneMeasurementMethodSchema
>;

// --- Section 4.2: SAFETY_EVENT revision reference ---

const safetyEventRefSchema = createTypedRevisionRefSchema(
  z.literal("SAFETY_EVENT"),
);

// --- Section 4.5: Urine ketone result ---

const supportedScaleResultSchema = z.strictObject({
  mapping: z.literal("SUPPORTED_SCALE"),
  scaleId: z.string().min(1),
  scaleVersion: z.string().min(1),
  resultCode: z.string().min(1),
  enteredLabel: z.string().min(1),
});

const unmappedResultSchema = z.strictObject({
  mapping: z.literal("UNMAPPED"),
  enteredLabel: z.string().min(1),
});

export const urineKetoneResultSchema = z.discriminatedUnion("mapping", [
  supportedScaleResultSchema,
  unmappedResultSchema,
]);

export type UrineKetoneResult = z.infer<typeof urineKetoneResultSchema>;

// --- Section 4.5: Ketone reading payload ---

const bloodMeasurementSchema = createMeasurementValueSchema(
  z.enum(["MMOL_L"]),
  z.enum(["MMOL_L"]),
);

export type KetoneReadingPayload =
  | {
      kind: "BLOOD_QUANTITATIVE";
      measurement: MeasurementValue<"MMOL_L", "MMOL_L">;
      measurementMethod: BloodKetoneMeasurementMethod;
      recheckFor?: TypedRevisionRef<"SAFETY_EVENT">;
      patientNote?: PatientAuthoredNote;
    }
  | {
      kind: "URINE_QUALITATIVE";
      result: UrineKetoneResult;
      measurementMethod: UrineKetoneMeasurementMethod;
      recheckFor?: TypedRevisionRef<"SAFETY_EVENT">;
      patientNote?: PatientAuthoredNote;
    };

export const ketoneReadingPayloadSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("BLOOD_QUANTITATIVE"),
    measurement: bloodMeasurementSchema,
    measurementMethod: bloodKetoneMeasurementMethodSchema,
    recheckFor: safetyEventRefSchema.optional(),
    patientNote: patientAuthoredNoteSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("URINE_QUALITATIVE"),
    result: urineKetoneResultSchema,
    measurementMethod: urineKetoneMeasurementMethodSchema,
    recheckFor: safetyEventRefSchema.optional(),
    patientNote: patientAuthoredNoteSchema.optional(),
  }),
]);