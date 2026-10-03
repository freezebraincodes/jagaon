import { z } from "zod";
import {
  activityFamiliarItemIdentitySchema,
  barrierAffectedTaskSchema,
  familiarItemIdentitySchema,
  intakeFamiliarItemIdentitySchema,
  learnedBarrierIdentitySchema,
  uniqueRefTupleSchema,
} from "../learning";
import { patientAuthoredNoteSchema } from "../health-records/patient-authored-note";
import { symptomCodeSchema } from "../health-records/symptom-report";
import {
  baselineComparableChangeSchema,
  comparableDimensionOf,
  comparableGlucoseSlotSchema,
  comparableIntakeIdentitySchema,
  contextWindowRefSchema,
  learnedBaselineReferenceSchema,
  medicationRefSchema,
  patternBaselineReferenceSchema,
  patternComparableSubjectSchema,
  patternEvidenceSnapshotRefSchema,
  patternObservationRefSchema,
  prescriptionVersionRefSchema,
} from "./pattern-comparable";

// --- Shared scope ---------------------------------------------------------

export const patternScopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("ORDINARY") }),
  z.strictObject({ kind: z.literal("CONTEXT_BOUND"), contexts: uniqueRefTupleSchema(contextWindowRefSchema) }),
]);

function changeMatchesSubject(
  subject: z.infer<typeof patternComparableSubjectSchema>,
  change: z.infer<typeof baselineComparableChangeSchema>,
): boolean {
  return comparableDimensionOf(subject) === change.kind;
}

// --- Section 8.11: baseline-change claims ---------------------------------

const routineShiftClaimSchema = z
  .strictObject({
    family: z.literal("ROUTINE_SHIFT"),
    subject: patternComparableSubjectSchema,
    baseline: learnedBaselineReferenceSchema,
    observedChange: baselineComparableChangeSchema,
  })
  .superRefine((claim, ctx) => {
    if (claim.subject.kind === "GLUCOSE_VALUE") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "ROUTINE_SHIFT_SUBJECT_CANNOT_BE_GLUCOSE", path: ["subject"] });
    } else if (!changeMatchesSubject(claim.subject, claim.observedChange)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "CHANGE_DIMENSION_MISMATCH", path: ["observedChange"] });
    }
  });

const contextBoundedDeviationClaimSchema = z
  .strictObject({
    family: z.literal("CONTEXT_BOUNDED_DEVIATION"),
    subject: patternComparableSubjectSchema,
    baseline: patternBaselineReferenceSchema,
    context: contextWindowRefSchema,
    observedChange: baselineComparableChangeSchema,
  })
  .superRefine((claim, ctx) => {
    if (!changeMatchesSubject(claim.subject, claim.observedChange)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "CHANGE_DIMENSION_MISMATCH", path: ["observedChange"] });
    }
  });

const returnTowardBaselineClaimSchema = z.strictObject({
  family: z.literal("RETURN_TOWARD_BASELINE"),
  subject: patternComparableSubjectSchema,
  baseline: patternBaselineReferenceSchema,
  deviation: z.strictObject({
    observation: patternObservationRefSchema,
    evidenceSnapshot: patternEvidenceSnapshotRefSchema,
  }),
  returnState: z.enum(["MOVING_CLOSER", "RESEMBLES_EARLIER_BASELINE"]),
});

// --- Section 8.12: familiar or frequent item ------------------------------

const familiarRecurrenceClaimSchema = z.strictObject({
  family: z.literal("FAMILIAR_OR_FREQUENT_ITEM"),
  item: familiarItemIdentitySchema,
  scope: patternScopeSchema,
  claim: z.strictObject({ kind: z.literal("RECURRING_IN_RECORDED_OCCASIONS") }),
});

const familiarShareClaimSchema = z.strictObject({
  family: z.literal("FAMILIAR_OR_FREQUENT_ITEM"),
  item: intakeFamiliarItemIdentitySchema,
  scope: patternScopeSchema,
  claim: z.strictObject({ kind: z.literal("RECORDED_SHARE_WITHIN_INTAKE_CONTEXT") }),
});

// --- Section 8.13: recurring barrier ---------------------------------------

const recurringBarrierClaimSchema = z.strictObject({
  family: z.literal("RECURRING_BARRIER"),
  barrier: learnedBarrierIdentitySchema,
  affectedTask: barrierAffectedTaskSchema,
  scope: patternScopeSchema,
  claim: z.strictObject({ kind: z.literal("REPEATED_EXPLICIT_PATIENT_REPORTS") }),
});

// --- Section 8.14: comparable-slot trend -----------------------------------

const comparableSlotTrendClaimSchema = z
  .strictObject({
    family: z.literal("COMPARABLE_SLOT_TREND"),
    slot: comparableGlucoseSlotSchema,
    observedChange: z.strictObject({
      typicalValue: z.enum(["HIGHER", "LOWER", "NO_MATERIAL_DIRECTION"]),
      variability: z.enum(["MORE_VARIABLE", "LESS_VARIABLE", "NO_MATERIAL_CHANGE"]),
    }),
  })
  .refine(
    (claim) =>
      claim.observedChange.typicalValue !== "NO_MATERIAL_DIRECTION" ||
      claim.observedChange.variability !== "NO_MATERIAL_CHANGE",
    "COMPARABLE_SLOT_CLAIM_REQUIRES_MATERIAL_CHANGE",
  );

// --- Section 8.15: prescribed-timing alignment -----------------------------

export const prescribedTimingSubjectSchema = z.strictObject({
  medication: medicationRefSchema,
  prescriptionVersion: prescriptionVersionRefSchema,
  scheduleKey: z.string().min(1).max(128),
});

const prescribedOffsetClaimSchema = z.strictObject({
  family: z.literal("PRESCRIBED_TIMING_ALIGNMENT"),
  subject: prescribedTimingSubjectSchema,
  claim: z.strictObject({
    kind: z.literal("RECORDED_OFFSET_CLUSTER"),
    direction: z.enum(["NEGATIVE_OFFSET", "NO_MATERIAL_OFFSET", "POSITIVE_OFFSET", "MIXED_OFFSETS"]),
  }),
});

const prescribedWindowClaimSchema = z.strictObject({
  family: z.literal("PRESCRIBED_TIMING_ALIGNMENT"),
  subject: prescribedTimingSubjectSchema,
  claim: z.strictObject({
    kind: z.literal("RECORDED_EXPLICIT_WINDOW_RELATIONSHIP"),
    predominantPosition: z.enum(["WITHIN_RECORDED_WINDOW", "BEFORE_RECORDED_WINDOW", "AFTER_RECORDED_WINDOW", "MIXED"]),
  }),
});

// --- Section 8.16: dormant cross-variable association ----------------------

/**
 * Closed reviewed definition catalogue. It is intentionally empty: no
 * cross-variable definition is approved, so every claim and fact fails.
 */
export const CROSS_VARIABLE_ASSOCIATION_DEFINITIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({});

export const crossVariableDefinitionRefSchema = z
  .strictObject({ definitionKey: z.string().min(1).max(128), definitionVersion: z.string().min(1).max(64) })
  .refine(
    (ref) => CROSS_VARIABLE_ASSOCIATION_DEFINITIONS[ref.definitionKey]?.includes(ref.definitionVersion) === true,
    "UNKNOWN_CROSS_VARIABLE_DEFINITION",
  );

export const contextWindowIdentitySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("STAYING_AWAY_FROM_HOME") }),
  z.strictObject({ kind: z.literal("TRAVEL") }),
  z.strictObject({ kind: z.literal("TEMPORARY_SCHEDULE_CHANGE") }),
  z.strictObject({ kind: z.literal("FESTIVE_OR_HOLIDAY_PERIOD") }),
  z.strictObject({ kind: z.literal("FEELING_UNWELL") }),
  z.strictObject({ kind: z.literal("APPETITE_CHANGE"), direction: z.enum(["LESS", "MORE", "DIFFERENT", "UNSPECIFIED"]) }),
  z.strictObject({ kind: z.literal("OTHER"), label: patientAuthoredNoteSchema }),
]);

export const crossVariableExposureSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("INTAKE_OCCURRENCE"), intake: comparableIntakeIdentitySchema }),
  z.strictObject({ kind: z.literal("FAMILIAR_INTAKE_ITEM"), item: intakeFamiliarItemIdentitySchema }),
  z.strictObject({ kind: z.literal("ACTIVITY_OCCURRENCE"), activity: activityFamiliarItemIdentitySchema }),
  z.strictObject({ kind: z.literal("PATIENT_RECORDED_SYMPTOM"), symptomCode: symptomCodeSchema }),
  z.strictObject({ kind: z.literal("TEMPORARY_CONTEXT"), context: contextWindowIdentitySchema }),
]);

export const crossVariableOutcomeSchema = z.strictObject({
  kind: z.literal("COMPARABLE_GLUCOSE"),
  slot: comparableGlucoseSlotSchema,
});

const crossVariableClaimSchema = z.strictObject({
  family: z.literal("CROSS_VARIABLE_ASSOCIATION"),
  definition: crossVariableDefinitionRefSchema,
  exposure: crossVariableExposureSchema,
  outcome: crossVariableOutcomeSchema,
  finding: z.union([
    z
      .strictObject({
        kind: z.literal("EXPOSED_VS_COMPARATOR"),
        typicalValue: z.enum(["HIGHER", "LOWER", "NO_MATERIAL_DIRECTION"]),
        variability: z.enum(["MORE_VARIABLE", "LESS_VARIABLE", "NO_MATERIAL_CHANGE"]),
      })
      .refine(
        (finding) => finding.typicalValue !== "NO_MATERIAL_DIRECTION" || finding.variability !== "NO_MATERIAL_CHANGE",
        "CROSS_VARIABLE_FINDING_REQUIRES_MATERIAL_CHANGE",
      ),
    z.strictObject({ kind: z.literal("RECORDED_COOCCURRENCE") }),
  ]),
});

// --- Completed closed claim union -------------------------------------------

export const patternClaimSchema = z.union([
  routineShiftClaimSchema,
  contextBoundedDeviationClaimSchema,
  returnTowardBaselineClaimSchema,
  familiarRecurrenceClaimSchema,
  familiarShareClaimSchema,
  recurringBarrierClaimSchema,
  comparableSlotTrendClaimSchema,
  prescribedOffsetClaimSchema,
  prescribedWindowClaimSchema,
  crossVariableClaimSchema,
]);

export type PatternClaim = z.infer<typeof patternClaimSchema>;
export type ComparableSlotTrendClaim = z.infer<typeof comparableSlotTrendClaimSchema>;
export type FamiliarOrFrequentItemClaim =
  | z.infer<typeof familiarRecurrenceClaimSchema>
  | z.infer<typeof familiarShareClaimSchema>;
