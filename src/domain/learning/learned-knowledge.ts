import { z } from "zod";
import { createRecordRevisionSchema, type RecordRevision } from "../shared/revision";
import { provenanceCoreSchema, type ProvenanceCore } from "../shared/provenance";
import { DeletionPolicy, type RecordType } from "../shared/record-catalogue";
import { createTypedRevisionRefSchema, type TypedRevisionRef } from "../shared/typed-revision-ref";
import { intakeSlotSchema } from "../health-records/intake-event";
import { patientAuthoredNoteSchema } from "../health-records/patient-authored-note";
import {
  anyTypedRevisionRefSchema,
  createOpaqueKeySchema,
  hasDuplicateRefs,
  localTimeWindowFields,
  localTimeWindowIssue,
  revisionRefKey,
  uniqueDaySetSchema,
  uniqueRefListSchema,
  uniqueRefTupleSchema,
  versionIdentifierSchema,
} from "./learning-primitives";

// --- Section 8.1–8.3: closed Learning registry and lifecycle -------------

export const LEARNING_FAMILIES = Object.freeze([
  "ROUTINE",
  "BEHAVIOUR",
  "PREFERENCE",
  "CONTEXT",
  "BARRIER",
  "FAMILIAR_ITEM",
] as const);

export type LearningFamily = (typeof LEARNING_FAMILIES)[number];

export const learningFamilySchema = z.enum(LEARNING_FAMILIES);

export const LEARNED_KNOWLEDGE_LIFECYCLE_STATES = Object.freeze([
  "EMERGING",
  "CANDIDATE",
  "ACTIVE",
  "WEAKENING",
  "STALE",
  "REJECTED",
  "ADOPTED",
] as const);

export const LEARNED_KNOWLEDGE_DELETION_POLICY = DeletionPolicy.PATIENT_DELETABLE;

export const LEARNED_KNOWLEDGE_REVISION_ACTIONS = Object.freeze([
  "CREATE",
  "UPDATE",
  "CONFIRM",
  "REJECT",
  "SUPERSEDE",
] as const);

const learnedKnowledgeRefSchema = createTypedRevisionRefSchema(z.literal("LEARNED_KNOWLEDGE"));
const contextWindowRefSchema = createTypedRevisionRefSchema(z.literal("CONTEXT_WINDOW"));
const inquiryResponseRefSchema = createTypedRevisionRefSchema(z.literal("INQUIRY_RESPONSE"));
const prescriptionVersionRefSchema = createTypedRevisionRefSchema(z.literal("PRESCRIPTION_VERSION"));
const medicationRefSchema = createTypedRevisionRefSchema(z.literal("MEDICATION"));

const nonEmptyKeySchema = z.string().min(1).max(128);

// --- Shared scope -----------------------------------------------------------

const contextBoundContextsSchema = uniqueRefTupleSchema(contextWindowRefSchema);

export const learnedScopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("ORDINARY") }),
  z.strictObject({ kind: z.literal("CONTEXT_BOUND"), contexts: contextBoundContextsSchema }),
]);

const singleContextScopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("ORDINARY") }),
  z.strictObject({ kind: z.literal("CONTEXT_BOUND"), context: contextWindowRefSchema }),
]);

// --- Section 8.4: routine -------------------------------------------------

const activityCategoryWithoutOther = z.enum([
  "WALKING",
  "FLEXIBILITY_OR_MOBILITY",
  "STRENGTH",
  "AEROBIC",
  "HOUSEHOLD_ACTIVITY",
]);

export const learnedRoutineSubjectSchema = z.union([
  z.strictObject({ kind: z.literal("INTAKE_SLOT_TIMING"), intakeSlot: intakeSlotSchema }),
  z.strictObject({
    kind: z.literal("ACTIVITY_TIMING"),
    activityCategory: activityCategoryWithoutOther,
    patientLabel: z.string().min(1).max(1000).optional(),
  }),
  z.strictObject({
    kind: z.literal("ACTIVITY_TIMING"),
    activityCategory: z.literal("OTHER"),
    patientLabel: z.string().min(1).max(1000),
  }),
  z.strictObject({
    kind: z.literal("MEASUREMENT_TIMING"),
    measurementKind: z.enum(["GLUCOSE", "KETONE", "WEIGHT", "HEIGHT"]),
  }),
]);

const localTimeWindowPatternSchema = z
  .strictObject({ kind: z.literal("LOCAL_TIME_WINDOW"), ...localTimeWindowFields })
  .superRefine((window, ctx) => {
    const issue = localTimeWindowIssue(window);
    if (issue) ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue });
  });

export const learnedRoutinePatternSchema = z.union([
  localTimeWindowPatternSchema,
  z.strictObject({ kind: z.literal("DAYS_OF_WEEK"), days: uniqueDaySetSchema }),
]);

const routineContentSchema = z.strictObject({
  kind: z.literal("ROUTINE"),
  subject: learnedRoutineSubjectSchema,
  pattern: learnedRoutinePatternSchema,
  scope: singleContextScopeSchema,
});

// --- Section 8.5: behaviour -----------------------------------------------

const recordedLocalWindowSchema = z
  .strictObject({ kind: z.literal("RECORDED_LOCAL_TIME_WINDOW"), ...localTimeWindowFields })
  .superRefine((window, ctx) => {
    const issue = localTimeWindowIssue(window);
    if (issue) ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue });
  });

const recordedOffsetWindowSchema = z
  .strictObject({
    kind: z.literal("RECORDED_OFFSET_WINDOW"),
    minimumMinutes: z.number().int().safe(),
    maximumMinutes: z.number().int().safe(),
  })
  .refine((window) => window.minimumMinutes <= window.maximumMinutes, "OFFSET_WINDOW_INVERTED");

const behaviourContentSchema = z.strictObject({
  kind: z.literal("BEHAVIOUR"),
  subject: z.strictObject({
    kind: z.literal("MEDICATION_EVENT_TIMING"),
    prescriptionVersion: prescriptionVersionRefSchema,
    scheduleKey: nonEmptyKeySchema.optional(),
  }),
  tendency: z.union([recordedLocalWindowSchema, recordedOffsetWindowSchema]),
  scope: singleContextScopeSchema,
});

// --- Section 8.6: preference ----------------------------------------------

const preferenceContentSchema = z.strictObject({
  kind: z.literal("PREFERENCE"),
  preference: z.strictObject({
    kind: z.literal("QUICK_ENTRY_ITEM"),
    familiarItem: learnedKnowledgeRefSchema,
    disposition: z.enum(["OFFER", "HIDE"]),
  }),
});

// --- Section 8.7: context -------------------------------------------------

export const patientDefinedContextKeySchema = createOpaqueKeySchema<"PatientDefinedContextKey">();

const contextContentSchema = z.strictObject({
  kind: z.literal("CONTEXT"),
  context: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("RECURRING_STANDARD_CONTEXT"),
      contextKind: z.enum([
        "STAYING_AWAY_FROM_HOME",
        "TRAVEL",
        "TEMPORARY_SCHEDULE_CHANGE",
        "FESTIVE_OR_HOLIDAY_PERIOD",
      ]),
    }),
    z.strictObject({
      kind: z.literal("RECURRING_PATIENT_DEFINED_CONTEXT"),
      contextKey: patientDefinedContextKeySchema,
      label: patientAuthoredNoteSchema,
    }),
  ]),
  recurrence: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("REPEATED_UNSCHEDULED") }),
    z.strictObject({ kind: z.literal("DAYS_OF_WEEK"), days: uniqueDaySetSchema }),
  ]),
});

// --- Section 8.8: barrier -------------------------------------------------

export const patientBarrierKeySchema = createOpaqueKeySchema<"PatientBarrierKey">();

export const learnedBarrierIdentitySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("CATEGORISED"),
    barrierKey: patientBarrierKeySchema,
    category: z.enum([
      "REMEMBERING",
      "SCHEDULE_OR_ROUTINE_DISRUPTION",
      "AWAY_FROM_HOME",
      "ACCESS_OR_SUPPLY_DIFFICULTY",
      "PHYSICAL_DIFFICULTY",
      "EMOTIONAL_BURDEN",
      "UNCERTAINTY_ABOUT_WHAT_TO_DO",
    ]),
    patientLabel: patientAuthoredNoteSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("PATIENT_DEFINED"),
    barrierKey: patientBarrierKeySchema,
    label: patientAuthoredNoteSchema,
  }),
]);

export const barrierAffectedTaskSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("MEDICATION"),
    activity: z.enum(["TAKING_OR_ADMINISTERING", "RECORDING"]),
    medication: medicationRefSchema.optional(),
    occasion: z
      .strictObject({ prescriptionVersion: prescriptionVersionRefSchema, scheduleKey: nonEmptyKeySchema })
      .optional(),
  }),
  z.strictObject({
    kind: z.literal("MEASUREMENT"),
    activity: z.enum(["TAKING_MEASUREMENT", "RECORDING_RESULT"]),
    measurementKind: z.enum(["GLUCOSE", "KETONE"]),
  }),
  z.strictObject({ kind: z.literal("INTAKE_RECORDING") }),
  z.strictObject({ kind: z.literal("ACTIVITY_RECORDING") }),
  z.strictObject({
    kind: z.literal("APPOINTMENT"),
    activity: z.enum(["ARRANGING", "ATTENDING", "RECORDING_OUTCOME"]),
  }),
  z.strictObject({
    kind: z.literal("PREVENTIVE_CARE"),
    activity: z.enum(["ARRANGING", "COMPLETING", "RECORDING"]),
  }),
  z.strictObject({ kind: z.literal("JAGAON_USE") }),
]);

const barrierContentSchema = z.strictObject({
  kind: z.literal("BARRIER"),
  barrier: learnedBarrierIdentitySchema,
  affectedTask: barrierAffectedTaskSchema,
  scope: learnedScopeSchema,
});

// --- Section 8.9: familiar item -------------------------------------------

export const familiarItemKeySchema = createOpaqueKeySchema<"FamiliarItemKey">();

export const intakeFamiliarItemIdentitySchema = z
  .strictObject({
    kind: z.literal("INTAKE_ITEM"),
    familiarItemKey: familiarItemKeySchema,
    label: patientAuthoredNoteSchema,
    itemKind: z.enum(["FOOD", "DRINK", "OTHER"]),
    intakeContext: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("ANY_RECORDED_INTAKE") }),
      z.strictObject({
        kind: z.literal("SPECIFIC_INTAKE_KIND"),
        intakeKind: z.enum(["MEAL", "SNACK", "TEA", "DESSERT", "DRINK", "OTHER"]),
        intakeSlot: intakeSlotSchema.optional(),
      }),
    ]),
  })
  .superRefine((item, ctx) => {
    const context = item.intakeContext;
    if (
      context.kind === "SPECIFIC_INTAKE_KIND" &&
      context.intakeSlot?.kind === "STANDARD_MEAL" &&
      context.intakeKind !== "MEAL"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "STANDARD_MEAL_SLOT_REQUIRES_MEAL",
        path: ["intakeContext", "intakeSlot"],
      });
    }
  });

export const activityFamiliarItemIdentitySchema = z.strictObject({
  kind: z.literal("ACTIVITY"),
  familiarItemKey: familiarItemKeySchema,
  label: patientAuthoredNoteSchema,
  activityCategory: z.enum([
    "WALKING",
    "FLEXIBILITY_OR_MOBILITY",
    "STRENGTH",
    "AEROBIC",
    "HOUSEHOLD_ACTIVITY",
    "OTHER",
  ]),
});

export const familiarItemIdentitySchema = z.union([
  intakeFamiliarItemIdentitySchema,
  activityFamiliarItemIdentitySchema,
]);

export type FamiliarItemIdentity = z.infer<typeof familiarItemIdentitySchema>;
export type FamiliarItemKey = z.infer<typeof familiarItemKeySchema>;

const familiarItemContentSchema = z.strictObject({
  kind: z.literal("FAMILIAR_ITEM"),
  item: familiarItemIdentitySchema,
  scope: learnedScopeSchema,
});

export const learnedKnowledgeContentSchema = z.union([
  routineContentSchema,
  behaviourContentSchema,
  preferenceContentSchema,
  contextContentSchema,
  barrierContentSchema,
  familiarItemContentSchema,
]);

export type LearnedKnowledgeContent = z.infer<typeof learnedKnowledgeContentSchema>;

// --- Section 8.2/8.3: activation, lifecycle, evidence ----------------------

export const learnedKnowledgeActivationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("PATIENT_STATED") }),
  z.strictObject({ kind: z.literal("PATIENT_CONFIRMED") }),
  z.strictObject({ kind: z.literal("LOW_CONSEQUENCE_POLICY"), policyVersion: versionIdentifierSchema }),
]);

export type LearnedKnowledgeActivation = z.infer<typeof learnedKnowledgeActivationSchema>;

export const learnedKnowledgeLifecycleSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("EMERGING") }),
  z.strictObject({ state: z.literal("CANDIDATE") }),
  z.strictObject({ state: z.literal("ACTIVE"), activation: learnedKnowledgeActivationSchema }),
  z.strictObject({ state: z.literal("WEAKENING"), previousActivation: learnedKnowledgeActivationSchema }),
  z.strictObject({ state: z.literal("STALE") }),
  z.strictObject({ state: z.literal("REJECTED") }),
  z.strictObject({ state: z.literal("ADOPTED"), adoptedAs: learnedKnowledgeRefSchema }),
]);

export type LearnedKnowledgeLifecycle = z.infer<typeof learnedKnowledgeLifecycleSchema>;

export const learnedKnowledgeEvidenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("DIRECT_PATIENT_STATEMENT"),
    sourceResponse: inquiryResponseRefSchema.optional(),
    relatedRevisions: uniqueRefListSchema(anyTypedRevisionRefSchema),
    contradictingRevisions: uniqueRefListSchema(anyTypedRevisionRefSchema),
    assessmentPolicyVersion: versionIdentifierSchema,
    evaluationRuleVersion: versionIdentifierSchema,
  }),
  z.strictObject({
    kind: z.literal("OBSERVATION_SET"),
    supportingRevisions: uniqueRefTupleSchema(anyTypedRevisionRefSchema),
    contradictingRevisions: uniqueRefListSchema(anyTypedRevisionRefSchema),
    distinctOccasionCount: z.number().int().positive().safe(),
    assessmentPolicyVersion: versionIdentifierSchema,
    evaluationRuleVersion: versionIdentifierSchema,
  }),
]);

export type LearnedKnowledgeEvidence = z.infer<typeof learnedKnowledgeEvidenceSchema>;

function activationOf(lifecycle: LearnedKnowledgeLifecycle): LearnedKnowledgeActivation | null {
  if (lifecycle.state === "ACTIVE") return lifecycle.activation;
  if (lifecycle.state === "WEAKENING") return lifecycle.previousActivation;
  return null;
}

export const learnedKnowledgePayloadSchema = z
  .strictObject({
    content: learnedKnowledgeContentSchema,
    relationship: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("PRIMARY") }),
      z.strictObject({ kind: z.literal("PROPOSED_REPLACEMENT"), replaces: learnedKnowledgeRefSchema }),
    ]),
    lifecycle: learnedKnowledgeLifecycleSchema,
    evidence: learnedKnowledgeEvidenceSchema,
  })
  .superRefine((payload, ctx) => {
    const issue = (message: string, path: (string | number)[] = []) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });

    const evidence = payload.evidence;
    if (evidence.kind === "OBSERVATION_SET") {
      // Several records from one occasion must not inflate the count.
      if (evidence.distinctOccasionCount > evidence.supportingRevisions.length) {
        issue("DISTINCT_OCCASIONS_EXCEED_SUPPORT", ["evidence", "distinctOccasionCount"]);
      }
      const supporting = new Set(evidence.supportingRevisions.map(revisionRefKey));
      if (evidence.contradictingRevisions.some((ref) => supporting.has(revisionRefKey(ref)))) {
        issue("REVISION_BOTH_SUPPORTING_AND_CONTRADICTING", ["evidence", "contradictingRevisions"]);
      }
    } else if (
      hasDuplicateRefs([...evidence.relatedRevisions, ...evidence.contradictingRevisions] as TypedRevisionRef<RecordType>[])
    ) {
      issue("REVISION_BOTH_RELATED_AND_CONTRADICTING", ["evidence"]);
    }

    const activation = activationOf(payload.lifecycle);
    if (activation?.kind === "LOW_CONSEQUENCE_POLICY") {
      const kind = payload.content.kind;
      if (kind === "BEHAVIOUR" || kind === "BARRIER") {
        issue("LOW_CONSEQUENCE_ACTIVATION_FORBIDDEN_FOR_FAMILY", ["lifecycle"]);
      }
      if (
        payload.content.kind === "CONTEXT" &&
        payload.content.context.kind === "RECURRING_PATIENT_DEFINED_CONTEXT"
      ) {
        issue("PATIENT_DEFINED_CONTEXT_REQUIRES_PATIENT_ACTIVATION", ["lifecycle"]);
      }
      if (payload.content.kind === "PREFERENCE" && payload.content.preference.disposition === "HIDE") {
        issue("HIDE_REQUIRES_PATIENT_ACTIVATION", ["lifecycle"]);
      }
      if (evidence.kind !== "OBSERVATION_SET") {
        issue("LOW_CONSEQUENCE_ACTIVATION_REQUIRES_OBSERVATIONS", ["evidence"]);
      }
    }
  });

export type LearnedKnowledgePayload = z.infer<typeof learnedKnowledgePayloadSchema>;

// --- Record revision ------------------------------------------------------

/** All derived intelligence records use ATEMPORAL temporal meaning. */
export const atemporalSchema = z.strictObject({ kind: z.literal("ATEMPORAL") });

export type AtemporalMeaning = z.infer<typeof atemporalSchema>;

export type LearnedKnowledgeRevision = RecordRevision<
  "LEARNED_KNOWLEDGE",
  LearnedKnowledgePayload,
  AtemporalMeaning,
  ProvenanceCore
>;

export const learnedKnowledgeRevisionSchema = createRecordRevisionSchema(
  z.literal("LEARNED_KNOWLEDGE"),
  learnedKnowledgePayloadSchema,
  atemporalSchema,
  provenanceCoreSchema,
).superRefine((revision, ctx) => {
  if (!(LEARNED_KNOWLEDGE_REVISION_ACTIONS as readonly string[]).includes(revision.action)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "UNSUPPORTED_REVISION_ACTION", path: ["action"] });
  }
}) as unknown as z.ZodType<LearnedKnowledgeRevision, z.ZodTypeDef, unknown>;
