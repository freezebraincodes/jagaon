import { z } from "zod";
import { createTypedRevisionRefSchema } from "../shared/typed-revision-ref";
import type { TypedRevisionRef } from "../shared/typed-revision-ref";
import {
  timePointSchema,
  intervalEndSchema,
  temporalMeaningSchema,
} from "../shared/temporal";
import { DeletionPolicy } from "../shared/record-catalogue";
import { patientAuthoredNoteSchema } from "../health-records/patient-authored-note";
import type { PatientAuthoredNote } from "../health-records/patient-authored-note";
import {
  doseAmountSchema,
  prescriptionInstructionTextSchema,
} from "./dose";
import type { DoseAmount, PrescriptionInstructionText } from "./dose";
import { prescriptionScheduleSchema } from "./prescription-schedule";
import type { PrescriptionSchedule } from "./prescription-schedule";

// --- Section 6.4 / 6.9: Shared boundaries ---

export const PRESCRIPTION_VERSION_DELETION_POLICY =
  DeletionPolicy.PATIENT_DELETABLE;

export const PRESCRIPTION_VERSION_REVISION_ACTIONS = [
  "CREATE",
  "CORRECT",
  "CONFIRM",
] as const;

// --- Section 6.4: Typed revision references ---

const medicationRefSchema = createTypedRevisionRefSchema(
  z.literal("MEDICATION"),
);

const prescriptionVersionRefSchema = createTypedRevisionRefSchema(
  z.literal("PRESCRIPTION_VERSION"),
);

const prescriptionChangeCandidateRefSchema = createTypedRevisionRefSchema(
  z.literal("PRESCRIPTION_CHANGE_CANDIDATE"),
);

// --- Section 6.4: PrescriptionDoseInstruction ---

export type PrescriptionDoseInstruction =
  | { kind: "FIXED"; amount: DoseAmount }
  | {
      kind: "VARIABLE_PER_REPORTED_PLAN";
      reportedAmounts: [DoseAmount, ...DoseAmount[]];
      decisionInstructionText: PrescriptionInstructionText;
    }
  | { kind: "UNSTRUCTURED" };

export const prescriptionDoseInstructionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("FIXED"),
    amount: doseAmountSchema,
  }),
  z.strictObject({
    kind: z.literal("VARIABLE_PER_REPORTED_PLAN"),
    reportedAmounts: z.tuple([doseAmountSchema]).rest(doseAmountSchema),
    decisionInstructionText: prescriptionInstructionTextSchema,
  }),
  z.strictObject({
    kind: z.literal("UNSTRUCTURED"),
  }),
]);

// --- Section 6.4: PrescriptionEffectivePeriod ---

export type PrescriptionEffectivePeriod = {
  start: z.infer<typeof timePointSchema>;
  end: z.infer<typeof intervalEndSchema>;
};

// Reuse Packet 2's temporalMeaningSchema INTERVAL validation so a comparable
// known end cannot equal or precede its start. The public input/output shape
// remains { start, end }; we wrap into the INTERVAL variant for validation
// and unwrap back.
export const prescriptionEffectivePeriodSchema = z
  .strictObject({
    start: timePointSchema,
    end: intervalEndSchema,
  })
  .superRefine((val, ctx) => {
    const result = temporalMeaningSchema.safeParse({
      kind: "INTERVAL",
      start: val.start,
      end: val.end,
    });
    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: issue.message,
        });
      }
    }
  });

// --- Section 6.4: PrescriptionVersionPayload ---

export type PrescriptionVersionPayload = {
  medication: TypedRevisionRef<"MEDICATION">;
  sourceInstructionText: PrescriptionInstructionText;
  doseInstruction: PrescriptionDoseInstruction;
  schedule: PrescriptionSchedule;
  effectivePeriod: PrescriptionEffectivePeriod;
  supersedes?: TypedRevisionRef<"PRESCRIPTION_VERSION">;
  basisChangeCandidate?: TypedRevisionRef<"PRESCRIPTION_CHANGE_CANDIDATE">;
  patientNote?: PatientAuthoredNote;
};

export const prescriptionVersionPayloadSchema = z.strictObject({
  medication: medicationRefSchema,
  sourceInstructionText: prescriptionInstructionTextSchema,
  doseInstruction: prescriptionDoseInstructionSchema,
  schedule: prescriptionScheduleSchema,
  effectivePeriod: prescriptionEffectivePeriodSchema,
  supersedes: prescriptionVersionRefSchema.optional(),
  basisChangeCandidate: prescriptionChangeCandidateRefSchema.optional(),
  patientNote: patientAuthoredNoteSchema.optional(),
});