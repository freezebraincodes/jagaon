import { z } from "zod";
import { createBoundedTextSchema } from "../shared/text";
import { patientAuthoredNoteSchema } from "./patient-authored-note";
import type { PatientAuthoredNote } from "./patient-authored-note";
import { DeletionPolicy } from "../shared/record-catalogue";

// --- Section 5.6 / 5.8: Shared boundaries ---

export const ACTIVITY_EVENT_DELETION_POLICY = DeletionPolicy.PATIENT_DELETABLE;

export const ACTIVITY_EVENT_REVISION_ACTIONS = [
  "CREATE",
  "CORRECT",
  "CONFIRM",
] as const;

// --- Section 5.6: ActivityEventPayload ---

export const activityCategorySchema = z.enum([
  "WALKING",
  "FLEXIBILITY_OR_MOBILITY",
  "STRENGTH",
  "AEROBIC",
  "HOUSEHOLD_ACTIVITY",
  "OTHER",
]);

export type ActivityCategory = z.infer<typeof activityCategorySchema>;

export const activityReportedIntensitySchema = z.enum([
  "LIGHT",
  "MODERATE",
  "VIGOROUS",
  "UNSURE",
]);

export type ActivityReportedIntensity = z.infer<
  typeof activityReportedIntensitySchema
>;

// Duration must be a positive safe integer when present. Does not invent or
// own an entry-tolerance comparison value — the later reviewed rule owns that.
export const reportedDurationMinutesSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

export type ActivityEventPayload = {
  activityCategory: ActivityCategory;
  patientLabel: string;
  patientReportedIntensity?: ActivityReportedIntensity;
  reportedDurationMinutes?: number;
  patientNote?: PatientAuthoredNote;
};

export const activityEventPayloadSchema = z.strictObject({
  activityCategory: activityCategorySchema,
  patientLabel: createBoundedTextSchema(1, 1000),
  patientReportedIntensity: activityReportedIntensitySchema.optional(),
  reportedDurationMinutes: reportedDurationMinutesSchema.optional(),
  patientNote: patientAuthoredNoteSchema.optional(),
});