import { z } from "zod";
import { createTypedRevisionRefSchema } from "../shared/typed-revision-ref";
import type { TypedRevisionRef } from "../shared/typed-revision-ref";
import { timePointSchema } from "../shared/temporal";
import type { TimePoint } from "../shared/temporal";
import { DeletionPolicy } from "../shared/record-catalogue";
import { patientAuthoredNoteSchema } from "../health-records/patient-authored-note";
import type { PatientAuthoredNote } from "../health-records/patient-authored-note";
import {
  prescriptionDoseInstructionSchema,
} from "./prescription-version";
import type { PrescriptionDoseInstruction } from "./prescription-version";
import { prescriptionScheduleSchema } from "./prescription-schedule";
import type { PrescriptionSchedule } from "./prescription-schedule";

// --- Section 6.6 / 6.9: Shared boundaries ---

export const PRESCRIPTION_CHANGE_CANDIDATE_DELETION_POLICY =
  DeletionPolicy.PATIENT_DELETABLE;

export const PRESCRIPTION_CHANGE_CANDIDATE_REVISION_ACTIONS = [
  "CREATE",
  "CORRECT",
] as const;

// --- Section 6.6: Typed revision references ---

const medicationRefSchema = createTypedRevisionRefSchema(
  z.literal("MEDICATION"),
);

const prescriptionVersionRefSchema = createTypedRevisionRefSchema(
  z.literal("PRESCRIPTION_VERSION"),
);

const prescriptionChangeCandidateRefSchema = createTypedRevisionRefSchema(
  z.literal("PRESCRIPTION_CHANGE_CANDIDATE"),
);

// --- Section 6.6: PrescriptionChangeKind ---

export type PrescriptionChangeKind =
  | "STARTED"
  | "STOPPED"
  | "DOSE_CHANGED"
  | "TIMING_CHANGED"
  | "FREQUENCY_CHANGED"
  | "MEDICATION_CHANGED"
  | "OTHER";

export const prescriptionChangeKindSchema = z.enum([
  "STARTED",
  "STOPPED",
  "DOSE_CHANGED",
  "TIMING_CHANGED",
  "FREQUENCY_CHANGED",
  "MEDICATION_CHANGED",
  "OTHER",
]);

// --- Section 6.6: PrescriptionInstructionCandidate ---

export type PrescriptionInstructionCandidate = {
  doseInstruction?: PrescriptionDoseInstruction;
  schedule?: PrescriptionSchedule;
};

export const prescriptionInstructionCandidateSchema = z.strictObject({
  doseInstruction: prescriptionDoseInstructionSchema.optional(),
  schedule: prescriptionScheduleSchema.optional(),
});

// --- Section 6.6: PrescriptionChangeReconciliation ---

export type PrescriptionChangeReconciliation =
  | { state: "PENDING_RECONCILIATION" }
  | {
      state: "RECONCILED_WITH_VERIFIED_SOURCE";
      verifiedPrescription: TypedRevisionRef<"PRESCRIPTION_VERSION">;
    }
  | {
      state: "CONFLICTING_SOURCE";
      conflictingPrescription: TypedRevisionRef<"PRESCRIPTION_VERSION">;
    }
  | { state: "DISMISSED"; reason?: PatientAuthoredNote }
  | {
      state: "SUPERSEDED";
      successor: TypedRevisionRef<"PRESCRIPTION_CHANGE_CANDIDATE">;
    };

export const prescriptionChangeReconciliationSchema = z.discriminatedUnion(
  "state",
  [
    z.strictObject({
      state: z.literal("PENDING_RECONCILIATION"),
    }),
    z.strictObject({
      state: z.literal("RECONCILED_WITH_VERIFIED_SOURCE"),
      verifiedPrescription: prescriptionVersionRefSchema,
    }),
    z.strictObject({
      state: z.literal("CONFLICTING_SOURCE"),
      conflictingPrescription: prescriptionVersionRefSchema,
    }),
    z.strictObject({
      state: z.literal("DISMISSED"),
      reason: patientAuthoredNoteSchema.optional(),
    }),
    z.strictObject({
      state: z.literal("SUPERSEDED"),
      successor: prescriptionChangeCandidateRefSchema,
    }),
  ],
);

// --- Section 6.6: PrescriptionChangeCandidatePayload ---

export type PrescriptionChangeCandidatePayload = {
  medication: TypedRevisionRef<"MEDICATION">;
  changeKinds: [PrescriptionChangeKind, ...PrescriptionChangeKind[]];
  reportedNewInstructionText: PatientAuthoredNote;
  reportedEffectiveFrom?: TimePoint;
  structuredCandidate?: PrescriptionInstructionCandidate;
  comparedWith?: TypedRevisionRef<"PRESCRIPTION_VERSION">;
  reconciliation: PrescriptionChangeReconciliation;
  patientNote?: PatientAuthoredNote;
};

export const prescriptionChangeCandidatePayloadSchema = z.strictObject({
  medication: medicationRefSchema,
  changeKinds: z
    .tuple([prescriptionChangeKindSchema])
    .rest(prescriptionChangeKindSchema),
  reportedNewInstructionText: patientAuthoredNoteSchema,
  reportedEffectiveFrom: timePointSchema.optional(),
  structuredCandidate: prescriptionInstructionCandidateSchema.optional(),
  comparedWith: prescriptionVersionRefSchema.optional(),
  reconciliation: prescriptionChangeReconciliationSchema,
  patientNote: patientAuthoredNoteSchema.optional(),
});
