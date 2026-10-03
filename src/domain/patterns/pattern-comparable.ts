import { z } from "zod";
import { createTypedRevisionRefSchema } from "../shared/typed-revision-ref";
import { intakeSlotSchema } from "../health-records/intake-event";
import { decimalStringSchema } from "../health-records/measurement";
import {
  createOpaqueKeySchema,
  ianaTimeZoneIdSchema,
  localTimeWindowFields,
  localTimeWindowIssue,
} from "../learning/learning-primitives";
import { dayOfWeekSchema, uniqueDaySetSchema, learnedRoutineSubjectSchema } from "../learning";
import { localClockTimeSchema } from "../care-plan/prescription-schedule";
import { compareDecimalStrings, isCanonicalDecimal, isCanonicalNonNegativeDecimal, isCanonicalUnitRatio } from "./pattern-decimal";

// --- Typed references -----------------------------------------------------

export const prescriptionVersionRefSchema = createTypedRevisionRefSchema(z.literal("PRESCRIPTION_VERSION"));
export const medicationRefSchema = createTypedRevisionRefSchema(z.literal("MEDICATION"));
export const learnedKnowledgeRefSchema = createTypedRevisionRefSchema(z.literal("LEARNED_KNOWLEDGE"));
export const patternObservationRefSchema = createTypedRevisionRefSchema(z.literal("PATTERN_OBSERVATION"));
export const patternEvidenceSnapshotRefSchema = createTypedRevisionRefSchema(z.literal("PATTERN_EVIDENCE_SNAPSHOT"));
export const contextWindowRefSchema = createTypedRevisionRefSchema(z.literal("CONTEXT_WINDOW"));
export const inquiryResponseRefSchema = createTypedRevisionRefSchema(z.literal("INQUIRY_RESPONSE"));
export const glucoseReadingRefSchema = createTypedRevisionRefSchema(z.literal("GLUCOSE_READING"));
export const intakeEventRefSchema = createTypedRevisionRefSchema(z.literal("INTAKE_EVENT"));
export const activityEventRefSchema = createTypedRevisionRefSchema(z.literal("ACTIVITY_EVENT"));
export const medicationEventRefSchema = createTypedRevisionRefSchema(z.literal("MEDICATION_EVENT"));

const nonEmptyKeySchema = z.string().min(1).max(128);
const wholeMinutes = z.number().int().safe();
const positiveCount = z.number().int().positive().safe();

/** Canonical signed decimal string. */
export const canonicalDecimalSchema = decimalStringSchema.refine(isCanonicalDecimal, "NON_CANONICAL_DECIMAL");
/** Canonical non-negative decimal string. */
export const canonicalNonNegativeDecimalSchema = decimalStringSchema.refine(
  isCanonicalNonNegativeDecimal,
  "NON_CANONICAL_NON_NEGATIVE_DECIMAL",
);
/** Canonical decimal ratio in the inclusive range zero to one. */
export const canonicalUnitRatioSchema = decimalStringSchema.refine(isCanonicalUnitRatio, "RATIO_OUT_OF_RANGE");

// --- Section 8.14: comparable glucose slot ---------------------------------

export const adHocIntakeComparisonKeySchema = createOpaqueKeySchema<"AdHocIntakeComparisonKey">();

export const comparableIntakeIdentitySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("MEAL_SLOT"), intakeSlot: intakeSlotSchema }),
  z.strictObject({
    kind: z.literal("AD_HOC_INTAKE"),
    comparisonKey: adHocIntakeComparisonKeySchema,
    intakeKind: z.enum(["SNACK", "TEA", "DESSERT", "DRINK", "OTHER"]),
    foodIncluded: z.enum(["YES", "NO"]),
    drinkIncluded: z.enum(["YES", "NO"]),
  }),
]);

const offsetWindowSchema = z
  .strictObject({ minimumMinutesInclusive: wholeMinutes, maximumMinutesExclusive: wholeMinutes })
  .refine((w) => w.minimumMinutesInclusive < w.maximumMinutesExclusive, "OFFSET_WINDOW_EMPTY");

function relationIssue(relation: "BEFORE" | "AFTER", window: { minimumMinutesInclusive: number; maximumMinutesExclusive: number }) {
  if (relation === "BEFORE" && window.maximumMinutesExclusive > 0) return "BEFORE_WINDOW_MUST_END_AT_OR_BEFORE_ZERO";
  if (relation === "AFTER" && window.minimumMinutesInclusive < 0) return "AFTER_WINDOW_MUST_START_AT_OR_AFTER_ZERO";
  return null;
}

export const ELIGIBLE_PATIENT_SELECTED_SLOTS = Object.freeze([
  "FASTING",
  "BEFORE_BREAKFAST",
  "BEFORE_LUNCH",
  "BEFORE_DINNER",
  "BEDTIME",
  "OVERNIGHT",
] as const);

export type EligiblePatientSelectedSlot = (typeof ELIGIBLE_PATIENT_SELECTED_SLOTS)[number];

export const comparableGlucoseSlotSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("PATIENT_SELECTED_SLOT"), slot: z.enum(ELIGIBLE_PATIENT_SELECTED_SLOTS) }),
    z.strictObject({
      kind: z.literal("PRESCRIBED_SLOT"),
      slotKey: nonEmptyKeySchema,
      prescriptionVersion: prescriptionVersionRefSchema,
    }),
    z.strictObject({
      kind: z.literal("EVENT_RELATIVE_INTAKE"),
      relation: z.enum(["BEFORE", "AFTER"]),
      intake: comparableIntakeIdentitySchema,
      offsetWindow: offsetWindowSchema,
    }),
    z.strictObject({
      kind: z.literal("EVENT_RELATIVE_MEDICATION"),
      relation: z.enum(["BEFORE", "AFTER"]),
      medication: medicationRefSchema,
      prescriptionVersion: prescriptionVersionRefSchema,
      scheduleKey: nonEmptyKeySchema.optional(),
      offsetWindow: offsetWindowSchema,
    }),
  ])
  .superRefine((slot, ctx) => {
    if (slot.kind === "EVENT_RELATIVE_INTAKE" || slot.kind === "EVENT_RELATIVE_MEDICATION") {
      const issue = relationIssue(slot.relation, slot.offsetWindow);
      if (issue) ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue, path: ["offsetWindow"] });
    }
  });

export type ComparableGlucoseSlot = z.infer<typeof comparableGlucoseSlotSchema>;

// --- Section 8.11: comparable subjects, baselines, summaries -----------------

export const patternComparableSubjectSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("ROUTINE_TIMING"),
    subject: learnedRoutineSubjectSchema,
    dimension: z.enum(["LOCAL_TIME_WINDOW", "DAYS_OF_WEEK"]),
  }),
  z.strictObject({
    kind: z.literal("RECORDED_MEDICATION_TIMING"),
    prescriptionVersion: prescriptionVersionRefSchema,
    scheduleKey: nonEmptyKeySchema.optional(),
    dimension: z.enum(["RECORDED_LOCAL_TIME", "RECORDED_PRESCRIBED_OFFSET"]),
  }),
  z.strictObject({ kind: z.literal("GLUCOSE_VALUE"), slot: comparableGlucoseSlotSchema }),
]);

export type PatternComparableSubject = z.infer<typeof patternComparableSubjectSchema>;

export type ComparableDimensionKind =
  | "LOCAL_TIME_WINDOW"
  | "DAYS_OF_WEEK"
  | "RECORDED_PRESCRIBED_OFFSET"
  | "GLUCOSE_DISTRIBUTION";

/** The comparison dimension a subject is analysed in. */
export function comparableDimensionOf(subject: PatternComparableSubject): ComparableDimensionKind {
  if (subject.kind === "GLUCOSE_VALUE") return "GLUCOSE_DISTRIBUTION";
  if (subject.kind === "ROUTINE_TIMING") return subject.dimension;
  return subject.dimension === "RECORDED_LOCAL_TIME" ? "LOCAL_TIME_WINDOW" : "RECORDED_PRESCRIBED_OFFSET";
}

export const learnedBaselineReferenceSchema = z.strictObject({
  kind: z.literal("LEARNED_KNOWLEDGE"),
  baseline: learnedKnowledgeRefSchema,
});

export const patternBaselineReferenceSchema = z.discriminatedUnion("kind", [
  learnedBaselineReferenceSchema,
  z.strictObject({
    kind: z.literal("SUPPORTED_PATTERN"),
    observation: patternObservationRefSchema,
    evidenceSnapshot: patternEvidenceSnapshotRefSchema,
  }),
]);

export const baselineComparableChangeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("LOCAL_TIME_WINDOW"),
    direction: z.enum(["EARLIER", "LATER", "DIFFERENT_OR_MIXED"]),
    spread: z.enum(["NARROWER", "SIMILAR", "WIDER", "NOT_ASSESSED"]),
  }),
  z.strictObject({
    kind: z.literal("DAYS_OF_WEEK"),
    difference: z.enum(["ADDED_RECORDED_DAYS", "REMOVED_RECORDED_DAYS", "DIFFERENT_RECORDED_DAYS"]),
  }),
  z.strictObject({
    kind: z.literal("RECORDED_PRESCRIBED_OFFSET"),
    direction: z.enum(["MORE_NEGATIVE", "MORE_POSITIVE", "DIFFERENT_OR_MIXED"]),
  }),
  z.strictObject({
    kind: z.literal("GLUCOSE_DISTRIBUTION"),
    direction: z.enum(["HIGHER", "LOWER", "DIFFERENT_OR_MIXED"]),
  }),
]);

const localTimeSummarySchema = z
  .strictObject({ kind: z.literal("LOCAL_TIME_WINDOW"), ...localTimeWindowFields, distinctOccasionCount: positiveCount })
  .superRefine((window, ctx) => {
    const issue = localTimeWindowIssue(window);
    if (issue) ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue });
  });

export const glucoseDistributionSummaryFields = {
  kind: z.literal("GLUCOSE_DISTRIBUTION"),
  canonicalUnit: z.literal("MMOL_L"),
  median: canonicalNonNegativeDecimalSchema,
  lowerTypicalBound: canonicalNonNegativeDecimalSchema,
  upperTypicalBound: canonicalNonNegativeDecimalSchema,
  distinctOccasionCount: positiveCount,
};

export function glucoseSummaryOrderIssue(summary: {
  median: string;
  lowerTypicalBound: string;
  upperTypicalBound: string;
}): string | null {
  if (compareDecimalStrings(summary.lowerTypicalBound, summary.median) === 1) return "LOWER_BOUND_ABOVE_MEDIAN";
  if (compareDecimalStrings(summary.median, summary.upperTypicalBound) === 1) return "MEDIAN_ABOVE_UPPER_BOUND";
  return null;
}

const glucoseSummarySchema = z.strictObject(glucoseDistributionSummaryFields).superRefine((summary, ctx) => {
  const issue = glucoseSummaryOrderIssue(summary);
  if (issue) ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue });
});

export const patternComparableSummarySchema = z.union([
  localTimeSummarySchema,
  z.strictObject({ kind: z.literal("DAYS_OF_WEEK"), days: uniqueDaySetSchema, distinctOccasionCount: positiveCount }),
  z
    .strictObject({
      kind: z.literal("RECORDED_PRESCRIBED_OFFSET_WINDOW"),
      minimumMinutes: wholeMinutes,
      maximumMinutes: wholeMinutes,
      distinctOccasionCount: positiveCount,
    })
    .refine((s) => s.minimumMinutes <= s.maximumMinutes, "OFFSET_WINDOW_INVERTED"),
  glucoseSummarySchema,
]);

export type PatternComparableSummary = z.infer<typeof patternComparableSummarySchema>;

export const patternComparableDifferenceSchema = z.union([
  z.strictObject({
    kind: z.literal("LOCAL_TIME_WINDOW"),
    typicalShiftMinutes: wholeMinutes,
    widthChangeMinutes: wholeMinutes,
    overlapRatio: canonicalUnitRatioSchema,
  }),
  z
    .strictObject({
      kind: z.literal("DAYS_OF_WEEK"),
      addedDays: z.array(dayOfWeekSchema),
      removedDays: z.array(dayOfWeekSchema),
      overlapRatio: canonicalUnitRatioSchema,
    })
    .refine((d) => {
      const all = [...d.addedDays, ...d.removedDays];
      return new Set(all).size === all.length;
    }, "DAY_LISTS_MUST_BE_UNIQUE_AND_DISJOINT"),
  z.strictObject({
    kind: z.literal("RECORDED_PRESCRIBED_OFFSET"),
    typicalShiftMinutes: wholeMinutes,
    overlapRatio: canonicalUnitRatioSchema,
  }),
  z.strictObject({
    kind: z.literal("GLUCOSE_DISTRIBUTION"),
    medianDifferenceMmolL: canonicalDecimalSchema,
    overlapRatio: canonicalUnitRatioSchema,
  }),
]);

export const patternComparableDistanceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("TYPICAL_CLOCK_MINUTES"), absoluteMinutes: z.number().int().nonnegative().safe() }),
  z.strictObject({ kind: z.literal("DAY_SET_DISTANCE"), value: canonicalUnitRatioSchema }),
  z.strictObject({
    kind: z.literal("TYPICAL_PRESCRIBED_OFFSET_MINUTES"),
    absoluteMinutes: z.number().int().nonnegative().safe(),
  }),
  z.strictObject({ kind: z.literal("GLUCOSE_MEDIAN_MMOL_L"), absoluteValue: canonicalNonNegativeDecimalSchema }),
]);

export const SUMMARY_KIND_BY_DIMENSION: Readonly<Record<ComparableDimensionKind, string>> = Object.freeze({
  LOCAL_TIME_WINDOW: "LOCAL_TIME_WINDOW",
  DAYS_OF_WEEK: "DAYS_OF_WEEK",
  RECORDED_PRESCRIBED_OFFSET: "RECORDED_PRESCRIBED_OFFSET_WINDOW",
  GLUCOSE_DISTRIBUTION: "GLUCOSE_DISTRIBUTION",
});

export const DISTANCE_KIND_BY_DIMENSION: Readonly<Record<ComparableDimensionKind, string>> = Object.freeze({
  LOCAL_TIME_WINDOW: "TYPICAL_CLOCK_MINUTES",
  DAYS_OF_WEEK: "DAY_SET_DISTANCE",
  RECORDED_PRESCRIBED_OFFSET: "TYPICAL_PRESCRIBED_OFFSET_MINUTES",
  GLUCOSE_DISTRIBUTION: "GLUCOSE_MEDIAN_MMOL_L",
});

export { localClockTimeSchema, ianaTimeZoneIdSchema };
