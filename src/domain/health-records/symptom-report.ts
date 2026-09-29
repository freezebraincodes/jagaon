import { z } from "zod";
import { createBoundedTextSchema } from "../shared/text";
import { patientAuthoredNoteSchema } from "./patient-authored-note";
import type { PatientAuthoredNote } from "./patient-authored-note";
import { createTypedRevisionRefSchema } from "../shared/typed-revision-ref";
import type { TypedRevisionRef } from "../shared/typed-revision-ref";
import { DeletionPolicy } from "../shared/record-catalogue";

// --- Section 5.4 / 5.8: Shared boundaries ---

export const SYMPTOM_REPORT_DELETION_POLICY = DeletionPolicy.PATIENT_DELETABLE;

export const SYMPTOM_REPORT_REVISION_ACTIONS = [
  "CREATE",
  "CORRECT",
  "CONFIRM",
] as const;

// --- Section 5.4: Typed revision reference to SAFETY_EVENT ---

const safetyEventRefSchema = createTypedRevisionRefSchema(
  z.literal("SAFETY_EVENT"),
);

// --- Section 5.4: SymptomCode ---

export const symptomCodeSchema = z.enum([
  "COLD_OR_CHILLY",
  "SHAKY",
  "SWEATY",
  "DIZZY",
  "WEAK",
  "SUDDEN_HUNGER",
  "CONFUSION",
  "SEVERE_DROWSINESS",
  "LOSS_OF_CONSCIOUSNESS",
  "SEIZURE",
  "UNABLE_TO_SWALLOW_OR_SELF_TREAT",
  "BREATHING_DIFFICULTY",
  "NAUSEA",
  "VOMITING",
  "ABDOMINAL_PAIN",
  "FRUITY_SMELLING_BREATH",
  "GENERALLY_UNWELL",
  "OTHER",
]);

export type SymptomCode = z.infer<typeof symptomCodeSchema>;

// --- Section 5.4: SymptomEntry ---

export const symptomEntrySchema = z
  .strictObject({
    code: symptomCodeSchema,
    severity: z.enum(["MILD", "MODERATE", "SEVERE", "UNSURE"]),
    patientLabel: createBoundedTextSchema(1, 1000).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.code === "OTHER" && !val.patientLabel) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["patientLabel"],
        message: "patientLabel is required when symptom code is OTHER",
      });
    }
  });

export type SymptomEntry = z.infer<typeof symptomEntrySchema>;

// --- Section 5.4: CapabilityState ---

export const capabilityStateSchema = z.enum([
  "YES",
  "NO",
  "UNSURE",
  "NOT_ASSESSED",
]);

export type CapabilityState = z.infer<typeof capabilityStateSchema>;

// --- Section 5.4: SafetyCapabilitySnapshot ---

export const safetyCapabilitySnapshotSchema = z.strictObject({
  canCheckGlucoseNow: capabilityStateSchema,
  canSwallow: capabilityStateSchema,
  canActIndependently: capabilityStateSchema,
});

export type SafetyCapabilitySnapshot = z.infer<
  typeof safetyCapabilitySnapshotSchema
>;

// --- Section 5.4: SymptomReportPayload ---

export type SymptomReportPayload =
  | {
      reportKind: "PRESENT";
      symptoms: [SymptomEntry, ...SymptomEntry[]];
      capabilities?: SafetyCapabilitySnapshot;
      relatedSafetyEvent?: TypedRevisionRef<"SAFETY_EVENT">;
      patientNote?: PatientAuthoredNote;
    }
  | {
      reportKind: "EXPLICIT_NONE";
      relatedSafetyEvent?: TypedRevisionRef<"SAFETY_EVENT">;
      patientNote?: PatientAuthoredNote;
    }
  | {
      reportKind: "UNSURE";
      relatedSafetyEvent?: TypedRevisionRef<"SAFETY_EVENT">;
      patientNote?: PatientAuthoredNote;
    };

export const symptomReportPayloadSchema = z.discriminatedUnion("reportKind", [
  z.strictObject({
    reportKind: z.literal("PRESENT"),
    symptoms: z.tuple([symptomEntrySchema]).rest(symptomEntrySchema),
    capabilities: safetyCapabilitySnapshotSchema.optional(),
    relatedSafetyEvent: safetyEventRefSchema.optional(),
    patientNote: patientAuthoredNoteSchema.optional(),
  }),
  z.strictObject({
    reportKind: z.literal("EXPLICIT_NONE"),
    relatedSafetyEvent: safetyEventRefSchema.optional(),
    patientNote: patientAuthoredNoteSchema.optional(),
  }),
  z.strictObject({
    reportKind: z.literal("UNSURE"),
    relatedSafetyEvent: safetyEventRefSchema.optional(),
    patientNote: patientAuthoredNoteSchema.optional(),
  }),
]);