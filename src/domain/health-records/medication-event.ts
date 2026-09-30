import { z } from "zod";
import { createTypedRevisionRefSchema } from "../shared/typed-revision-ref";
import type { TypedRevisionRef } from "../shared/typed-revision-ref";
import {
  temporalMeaningSchema,
  timePointSchema,
  type TimePoint,
} from "../shared/temporal";
import { DeletionPolicy } from "../shared/record-catalogue";
import { patientAuthoredNoteSchema } from "./patient-authored-note";
import type { PatientAuthoredNote } from "./patient-authored-note";
import { doseAmountSchema } from "../care-plan/dose";
import type { DoseAmount } from "../care-plan/dose";
import { createBoundedTextSchema } from "../shared/text";

// --- Section 6.7 / 6.9: Shared boundaries ---

export const MEDICATION_EVENT_DELETION_POLICY = DeletionPolicy.PATIENT_DELETABLE;

export const MEDICATION_EVENT_REVISION_ACTIONS = [
  "CREATE",
  "CORRECT",
] as const;

// --- Section 6.7: Typed revision references ---

const medicationRefSchema = createTypedRevisionRefSchema(
  z.literal("MEDICATION"),
);

const prescriptionVersionRefSchema = createTypedRevisionRefSchema(
  z.literal("PRESCRIPTION_VERSION"),
);

const medicationEventRefSchema = createTypedRevisionRefSchema(
  z.literal("MEDICATION_EVENT"),
);

// --- Section 6.7: MedicationSafetyConcern ---

export type MedicationSafetyConcern =
  | "POSSIBLE_EXTRA_DOSE"
  | "POSSIBLE_DOUBLE_DOSE"
  | "POSSIBLE_WRONG_MEDICATION"
  | "POSSIBLE_WRONG_AMOUNT"
  | "DEVICE_OR_DELIVERY_ISSUE";

export const medicationSafetyConcernSchema = z.enum([
  "POSSIBLE_EXTRA_DOSE",
  "POSSIBLE_DOUBLE_DOSE",
  "POSSIBLE_WRONG_MEDICATION",
  "POSSIBLE_WRONG_AMOUNT",
  "DEVICE_OR_DELIVERY_ISSUE",
]);

const reportedSafetyConcernsSchema = z
  .tuple([medicationSafetyConcernSchema])
  .rest(medicationSafetyConcernSchema);

// --- Section 6.7: RecordedMedicationAmount ---

export type RecordedMedicationAmount =
  | { kind: "KNOWN"; amount: DoseAmount }
  | { kind: "NOT_RECORDED" }
  | { kind: "UNSURE" };

export const recordedMedicationAmountSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("KNOWN"),
    amount: doseAmountSchema,
  }),
  z.strictObject({ kind: z.literal("NOT_RECORDED") }),
  z.strictObject({ kind: z.literal("UNSURE") }),
]);

// --- Section 6.7: MedicationOccasion ---

export type MedicationOccasion = {
  expectedAt: TimePoint;
  prescriptionVersion?: TypedRevisionRef<"PRESCRIPTION_VERSION">;
  scheduleKey?: string;
};

export const medicationOccasionSchema = z.strictObject({
  expectedAt: timePointSchema,
  prescriptionVersion: prescriptionVersionRefSchema.optional(),
  scheduleKey: createBoundedTextSchema(1, 1000).optional(),
});

// --- Section 6.7: Medication event temporal ---

// POINT only, reusing the existing shared temporal validation. Permits
// EXACT, APPROXIMATE, DATE_ONLY, or UNKNOWN occurrence time. Rejects
// INTERVAL and ATEMPORAL. Does not substitute entry time for unknown
// occurrence time.
export const medicationEventTemporalSchema = temporalMeaningSchema.refine(
  (val) => val.kind === "POINT",
  "Medication event temporal must be POINT",
);

export type MedicationEventTemporal = z.infer<typeof medicationEventTemporalSchema>;

// --- Section 6.7: MedicationEventPayload ---

export type MedicationEventBase = {
  medication: TypedRevisionRef<"MEDICATION">;
  prescriptionVersion?: TypedRevisionRef<"PRESCRIPTION_VERSION">;
  intendedOccasion?: MedicationOccasion;
  patientStatedReason?: PatientAuthoredNote;
  reportedSafetyConcerns?: [
    MedicationSafetyConcern,
    ...MedicationSafetyConcern[],
  ];
  patientNote?: PatientAuthoredNote;
};

export type MedicationEventPayload =
  | (MedicationEventBase & {
      state: "TAKEN";
      amountTaken: RecordedMedicationAmount;
      resolvesDelayedEvent?: TypedRevisionRef<"MEDICATION_EVENT">;
    })
  | (MedicationEventBase & {
      state: "MISSED";
      intendedOccasion: MedicationOccasion;
    })
  | (MedicationEventBase & {
      state: "DELAYED";
      intendedOccasion: MedicationOccasion;
    })
  | (MedicationEventBase & {
      state: "UNSURE";
      intendedOccasion: MedicationOccasion;
    })
  | (MedicationEventBase & {
      state: "DECLINED_TO_RECORD";
      intendedOccasion: MedicationOccasion;
    });

// Shared base fields used by all variants.
const medicationEventBaseSchema = z.strictObject({
  medication: medicationRefSchema,
  prescriptionVersion: prescriptionVersionRefSchema.optional(),
  intendedOccasion: medicationOccasionSchema.optional(),
  patientStatedReason: patientAuthoredNoteSchema.optional(),
  reportedSafetyConcerns: reportedSafetyConcernsSchema.optional(),
  patientNote: patientAuthoredNoteSchema.optional(),
});

export const medicationEventPayloadSchema = z.discriminatedUnion("state", [
  // TAKEN
  medicationEventBaseSchema.extend({
      state: z.literal("TAKEN"),
      amountTaken: recordedMedicationAmountSchema,
      resolvesDelayedEvent: medicationEventRefSchema.optional(),
    }),

  // MISSED
  medicationEventBaseSchema.extend({
      state: z.literal("MISSED"),
      intendedOccasion: medicationOccasionSchema,
    }),

  // DELAYED
  medicationEventBaseSchema.extend({
      state: z.literal("DELAYED"),
      intendedOccasion: medicationOccasionSchema,
    }),

  // UNSURE
  medicationEventBaseSchema.extend({
      state: z.literal("UNSURE"),
      intendedOccasion: medicationOccasionSchema,
    }),

  // DECLINED_TO_RECORD
  medicationEventBaseSchema.extend({
      state: z.literal("DECLINED_TO_RECORD"),
      intendedOccasion: medicationOccasionSchema,
    }),
]);
