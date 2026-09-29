import { z } from "zod";
import { createBoundedTextSchema } from "../shared/text";
import { patientAuthoredNoteSchema } from "../health-records/patient-authored-note";
import type { PatientAuthoredNote } from "../health-records/patient-authored-note";
import { DeletionPolicy } from "../shared/record-catalogue";

// --- Section 6.2 / 6.9: Shared boundaries ---

export const MEDICATION_DELETION_POLICY = DeletionPolicy.PATIENT_DELETABLE;

export const MEDICATION_REVISION_ACTIONS = [
  "CREATE",
  "CORRECT",
  "CONFIRM",
] as const;

// --- Section 6.2: MedicationDoseForm ---

export const medicationDoseFormSchema = z.enum([
  "TABLET",
  "CAPSULE",
  "ORAL_LIQUID",
  "INJECTION_SOLUTION",
  "INHALATION_PREPARATION",
  "TOPICAL_PREPARATION",
  "PATCH",
  "OTHER",
  "UNKNOWN",
]);

export type MedicationDoseForm = z.infer<typeof medicationDoseFormSchema>;

// --- Section 6.2: MedicationRoute ---

export const medicationRouteSchema = z.enum([
  "ORAL",
  "SUBCUTANEOUS",
  "INTRAMUSCULAR",
  "INTRAVENOUS",
  "INHALED",
  "TOPICAL",
  "TRANSDERMAL",
  "OTHER",
  "UNKNOWN",
]);

export type MedicationRoute = z.infer<typeof medicationRouteSchema>;

// --- Section 6.2: MedicationDeliveryDevice ---

export const medicationDeliveryDeviceSchema = z.enum([
  "NONE",
  "INSULIN_PEN",
  "SYRINGE",
  "INSULIN_PUMP",
  "INHALER",
  "OTHER",
  "UNKNOWN",
]);

export type MedicationDeliveryDevice = z.infer<
  typeof medicationDeliveryDeviceSchema
>;

// --- Section 6.2: MedicationIdentity ---

const medicationIdentityReviewedSchema = z.strictObject({
  kind: z.literal("REVIEWED_CATALOGUE_MATCH"),
  patientEnteredName: createBoundedTextSchema(1, 1000),
  catalogueEntryKey: createBoundedTextSchema(1, 1000),
  catalogueVersion: createBoundedTextSchema(1, 1000),
  matchedLabel: createBoundedTextSchema(1, 1000),
  matchMethod: z.enum(["STRUCTURED_PATIENT_SELECTION", "DETERMINISTIC_ALIAS"]),
});

const medicationIdentityUnmappedSchema = z.strictObject({
  kind: z.literal("UNMAPPED"),
  patientEnteredName: createBoundedTextSchema(1, 1000),
});

export const medicationIdentitySchema = z.discriminatedUnion("kind", [
  medicationIdentityReviewedSchema,
  medicationIdentityUnmappedSchema,
]);

export type MedicationIdentity = z.infer<typeof medicationIdentitySchema>;

// --- Section 6.2: MedicationPayload ---

export type MedicationPayload = {
  identity: MedicationIdentity;
  doseForm: MedicationDoseForm;
  route: MedicationRoute;
  deliveryDevice: MedicationDeliveryDevice;
  patientNote?: PatientAuthoredNote;
};

export const medicationPayloadSchema = z.strictObject({
  identity: medicationIdentitySchema,
  doseForm: medicationDoseFormSchema,
  route: medicationRouteSchema,
  deliveryDevice: medicationDeliveryDeviceSchema,
  patientNote: patientAuthoredNoteSchema.optional(),
});