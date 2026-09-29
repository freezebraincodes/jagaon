import { z } from "zod";
import { createMeasurementValueSchema } from "./measurement";
import type { MeasurementValue } from "./measurement";
import { patientAuthoredNoteSchema } from "./patient-authored-note";
import type { PatientAuthoredNote } from "./patient-authored-note";
import { createTypedRevisionRefSchema } from "../shared/typed-revision-ref";
import type { TypedRevisionRef } from "../shared/typed-revision-ref";
import { DeletionPolicy } from "../shared/record-catalogue";

// --- Section 4.3 / 4.7: Shared reading boundaries ---

export const DEFAULT_GLUCOSE_ENTRY_UNIT = "MMOL_L" as const;

export const GLUCOSE_READING_DELETION_POLICY = DeletionPolicy.PATIENT_DELETABLE;

export const GLUCOSE_READING_REVISION_ACTIONS = [
  "CREATE",
  "CORRECT",
  "CONFIRM",
  "SYSTEM_DERIVE",
] as const;

// --- Section 4.3: Glucose measurement methods ---

export const glucoseMeasurementMethodSchema = z.enum([
  "FINGERSTICK_METER",
  "CGM",
  "FLASH_SENSOR",
  "LAB",
  "OTHER",
  "UNKNOWN",
]);

export type GlucoseMeasurementMethod = z.infer<
  typeof glucoseMeasurementMethodSchema
>;

// --- Section 4.2: Typed revision references for contexts ---

const safetyEventRefSchema = createTypedRevisionRefSchema(
  z.literal("SAFETY_EVENT"),
);

const prescriptionVersionRefSchema = createTypedRevisionRefSchema(
  z.literal("PRESCRIPTION_VERSION"),
);

const intakeOrMedicationEventRefSchema = z.union([
  createTypedRevisionRefSchema(z.literal("INTAKE_EVENT")),
  createTypedRevisionRefSchema(z.literal("MEDICATION_EVENT")),
]);

// --- Section 4.4: Glucose measurement context ---

const patientSelectedSlotSchema = z.enum([
  "FASTING",
  "BEFORE_BREAKFAST",
  "AFTER_BREAKFAST",
  "BEFORE_LUNCH",
  "AFTER_LUNCH",
  "BEFORE_DINNER",
  "AFTER_DINNER",
  "BEDTIME",
  "OVERNIGHT",
  "OTHER",
]);

export const glucoseMeasurementContextSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("UNSPECIFIED"),
  }),
  z.strictObject({
    kind: z.literal("PATIENT_SELECTED_SLOT"),
    slot: patientSelectedSlotSchema,
  }),
  z.strictObject({
    kind: z.literal("PRESCRIBED_SLOT"),
    slotKey: z.string().min(1),
    prescriptionVersion: prescriptionVersionRefSchema,
  }),
  z.strictObject({
    kind: z.literal("EVENT_RELATIVE"),
    relation: z.enum(["BEFORE", "AFTER"]),
    relatedEvent: intakeOrMedicationEventRefSchema,
    assignment: z.literal("PATIENT_CONFIRMED"),
  }),
]);

export type GlucoseMeasurementContext = z.infer<
  typeof glucoseMeasurementContextSchema
>;

// --- Section 4.3: Glucose reading payload ---

const glucoseMeasurementSchema = createMeasurementValueSchema(
  z.enum(["MMOL_L", "MG_DL"]),
  z.enum(["MMOL_L"]),
);

export type GlucoseReadingPayload = {
  measurement: MeasurementValue<"MMOL_L" | "MG_DL", "MMOL_L">;
  measurementMethod: GlucoseMeasurementMethod;
  context: GlucoseMeasurementContext;
  recheckFor?: TypedRevisionRef<"SAFETY_EVENT">;
  patientNote?: PatientAuthoredNote;
};

export const glucoseReadingPayloadSchema = z.strictObject({
  measurement: glucoseMeasurementSchema,
  measurementMethod: glucoseMeasurementMethodSchema,
  context: glucoseMeasurementContextSchema,
  recheckFor: safetyEventRefSchema.optional(),
  patientNote: patientAuthoredNoteSchema.optional(),
});