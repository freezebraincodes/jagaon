import { z } from "zod";
import { instantSchema, instantBefore } from "../shared/time";
import { familiarItemKeySchema, patientBarrierKeySchema, barrierAffectedTaskSchema, uniqueRefListSchema, anyTypedRevisionRefSchema, revisionRefKey } from "../learning";
import { createOpaqueKeySchema } from "../learning/learning-primitives";
import { symptomCodeSchema } from "../health-records/symptom-report";
import { createTypedRevisionRefSchema } from "../shared/typed-revision-ref";
import {
  activityEventRefSchema,
  canonicalDecimalSchema,
  canonicalNonNegativeDecimalSchema,
  canonicalUnitRatioSchema,
  comparableDimensionOf,
  comparableGlucoseSlotSchema,
  contextWindowRefSchema,
  DISTANCE_KIND_BY_DIMENSION,
  glucoseDistributionSummaryFields,
  glucoseReadingRefSchema,
  glucoseSummaryOrderIssue,
  inquiryResponseRefSchema,
  intakeEventRefSchema,
  medicationEventRefSchema,
  patternBaselineReferenceSchema,
  patternComparableDifferenceSchema,
  patternComparableDistanceSchema,
  patternComparableSubjectSchema,
  patternComparableSummarySchema,
  prescriptionVersionRefSchema,
  SUMMARY_KIND_BY_DIMENSION,
  type PatternComparableSubject,
} from "./pattern-comparable";
import {
  crossVariableDefinitionRefSchema,
  crossVariableExposureSchema,
  crossVariableOutcomeSchema,
  patternScopeSchema,
  prescribedTimingSubjectSchema,
} from "./pattern-claims";
import { formatRatioHalfUp } from "./pattern-decimal";

const positiveCount = z.number().int().positive().safe();
const nonNegativeCount = z.number().int().nonnegative().safe();
const wholeMinutes = z.number().int().safe();
const instantWindowSchema = z
  .strictObject({ start: instantSchema, end: instantSchema })
  .refine((w) => instantBefore(w.start, w.end), "WINDOW_END_MUST_FOLLOW_START");

type Ctx = z.RefinementCtx;
const issue = (ctx: Ctx, message: string, path: (string | number)[] = []) =>
  ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });

function checkDimension(
  ctx: Ctx,
  subject: PatternComparableSubject,
  summaries: { kind: string }[],
  difference?: { kind: string },
  distances: { kind: string }[] = [],
): void {
  const dimension = comparableDimensionOf(subject);
  if (summaries.some((summary) => summary.kind !== SUMMARY_KIND_BY_DIMENSION[dimension])) {
    issue(ctx, "SUMMARY_DIMENSION_MISMATCH");
  }
  const differenceKind = dimension === "RECORDED_PRESCRIBED_OFFSET" ? "RECORDED_PRESCRIBED_OFFSET" : dimension;
  if (difference && difference.kind !== differenceKind) issue(ctx, "DIFFERENCE_DIMENSION_MISMATCH");
  if (distances.some((distance) => distance.kind !== DISTANCE_KIND_BY_DIMENSION[dimension])) {
    issue(ctx, "DISTANCE_DIMENSION_MISMATCH");
  }
}

// --- Section 8.11: baseline-change facts -------------------------------------

const routineShiftFactsSchema = z
  .strictObject({
    family: z.literal("ROUTINE_SHIFT"),
    subject: patternComparableSubjectSchema,
    baselineSummary: patternComparableSummarySchema,
    recentSummary: patternComparableSummarySchema,
    difference: patternComparableDifferenceSchema,
  })
  .superRefine((facts, ctx) => {
    if (facts.subject.kind === "GLUCOSE_VALUE") issue(ctx, "ROUTINE_SHIFT_SUBJECT_CANNOT_BE_GLUCOSE");
    checkDimension(ctx, facts.subject, [facts.baselineSummary, facts.recentSummary], facts.difference);
  });

const contextBoundedDeviationFactsSchema = z
  .strictObject({
    family: z.literal("CONTEXT_BOUNDED_DEVIATION"),
    subject: patternComparableSubjectSchema,
    baselineSummary: patternComparableSummarySchema,
    insideContextSummary: patternComparableSummarySchema,
    difference: patternComparableDifferenceSchema,
    context: contextWindowRefSchema,
    contextBoundary: z.enum(["KNOWN_START_AND_END", "KNOWN_START_END_UNKNOWN"]),
    overlappingContexts: uniqueRefListSchema(contextWindowRefSchema),
  })
  .superRefine((facts, ctx) => {
    checkDimension(ctx, facts.subject, [facts.baselineSummary, facts.insideContextSummary], facts.difference);
    if (facts.overlappingContexts.some((ref) => revisionRefKey(ref) === revisionRefKey(facts.context))) {
      issue(ctx, "OVERLAPPING_CONTEXTS_INCLUDE_PRIMARY", ["overlappingContexts"]);
    }
  });

const returnTowardBaselineFactsSchema = z
  .strictObject({
    family: z.literal("RETURN_TOWARD_BASELINE"),
    subject: patternComparableSubjectSchema,
    baselineSummary: patternComparableSummarySchema,
    deviationSummary: patternComparableSummarySchema,
    recentSummary: patternComparableSummarySchema,
    deviationDistanceFromBaseline: patternComparableDistanceSchema,
    recentDistanceFromBaseline: patternComparableDistanceSchema,
  })
  .superRefine((facts, ctx) => {
    checkDimension(
      ctx,
      facts.subject,
      [facts.baselineSummary, facts.deviationSummary, facts.recentSummary],
      undefined,
      [facts.deviationDistanceFromBaseline, facts.recentDistanceFromBaseline],
    );
  });

// --- Section 8.12: familiar or frequent item ---------------------------------

const familiarMatchBasisSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("EXACT_AUTHORED_LABEL") }),
  z.strictObject({ kind: z.literal("DETERMINISTIC_NORMALISATION") }),
  z.strictObject({ kind: z.literal("PATIENT_CONFIRMED_ALIAS"), response: inquiryResponseRefSchema }),
]);

const familiarIntakeItemMatchSchema = z.strictObject({
  itemIndex: z.number().int().nonnegative().safe(),
  matchBasis: familiarMatchBasisSchema,
});

const matchedItemsSchema = z
  .array(familiarIntakeItemMatchSchema)
  .min(1)
  .refine(
    (items) => items.every((item, index) => index === 0 || items[index - 1]!.itemIndex < item.itemIndex),
    "ITEM_INDEXES_MUST_BE_UNIQUE_AND_ORDERED",
  );

const intakeEvidenceMatchSchema = z.strictObject({
  kind: z.literal("INTAKE_ITEM"),
  source: intakeEventRefSchema,
  matchedItems: matchedItemsSchema,
});

const familiarEvidenceMatchSchema = z.discriminatedUnion("kind", [
  intakeEvidenceMatchSchema,
  z.strictObject({ kind: z.literal("ACTIVITY"), source: activityEventRefSchema, matchBasis: familiarMatchBasisSchema }),
]);

function uniqueSources(matches: { source: { recordType: string; recordId: string; revisionId: string } }[]): boolean {
  const keys = matches.map((match) => revisionRefKey(match.source as never));
  return new Set(keys).size === keys.length;
}

/** One logical event per record: different revisions of one event never count twice. */
function uniqueLogicalEvents(matches: { source: { recordId: string } }[]): boolean {
  const ids = matches.map((match) => match.source.recordId);
  return new Set(ids).size === ids.length;
}

const familiarRecurrenceFactsSchema = z
  .strictObject({
    family: z.literal("FAMILIAR_OR_FREQUENT_ITEM"),
    claimKind: z.literal("RECURRING_IN_RECORDED_OCCASIONS"),
    familiarItemKey: familiarItemKeySchema,
    occurrenceMatches: z.array(familiarEvidenceMatchSchema).min(1),
  })
  .superRefine((facts, ctx) => {
    if (!uniqueSources(facts.occurrenceMatches) || !uniqueLogicalEvents(facts.occurrenceMatches)) {
      issue(ctx, "DUPLICATE_OCCURRENCE_SOURCE", ["occurrenceMatches"]);
    }
  });

const familiarShareFactsSchema = z
  .strictObject({
    family: z.literal("FAMILIAR_OR_FREQUENT_ITEM"),
    claimKind: z.literal("RECORDED_SHARE_WITHIN_INTAKE_CONTEXT"),
    familiarItemKey: familiarItemKeySchema,
    occurrenceMatches: z.array(intakeEvidenceMatchSchema).min(1),
    eligibleLoggedIntakeCount: positiveCount,
    matchedLoggedIntakeCount: positiveCount,
    recordedShare: canonicalUnitRatioSchema,
  })
  .superRefine((facts, ctx) => {
    if (!uniqueSources(facts.occurrenceMatches) || !uniqueLogicalEvents(facts.occurrenceMatches)) {
      issue(ctx, "DUPLICATE_OCCURRENCE_SOURCE", ["occurrenceMatches"]);
    }
    if (facts.matchedLoggedIntakeCount !== facts.occurrenceMatches.length) {
      issue(ctx, "MATCHED_COUNT_DISAGREES_WITH_MATCHES", ["matchedLoggedIntakeCount"]);
    }
    if (facts.matchedLoggedIntakeCount > facts.eligibleLoggedIntakeCount) {
      issue(ctx, "MATCHED_EXCEEDS_ELIGIBLE", ["matchedLoggedIntakeCount"]);
      return;
    }
    const expected = formatRatioHalfUp(BigInt(facts.matchedLoggedIntakeCount), BigInt(facts.eligibleLoggedIntakeCount));
    if (facts.recordedShare !== expected) issue(ctx, "RECORDED_SHARE_DISAGREES_WITH_COUNTS", ["recordedShare"]);
  });

// --- Section 8.13: recurring barrier ---------------------------------------

export const barrierOccurrenceKeySchema = createOpaqueKeySchema<"BarrierOccurrenceKey">();

const barrierStatementSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("MEDICATION_EVENT_REASON"),
    event: medicationEventRefSchema,
    field: z.literal("patientStatedReason"),
  }),
  z.strictObject({
    kind: z.literal("INQUIRY_RESPONSE"),
    inquiry: createTypedRevisionRefSchema(z.literal("INQUIRY")),
    response: inquiryResponseRefSchema,
  }),
]);

const barrierStatementEvidenceSchema = z.strictObject({
  source: barrierStatementSourceSchema,
  attributionBasis: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("STRUCTURED_PATIENT_SELECTION") }),
    z.strictObject({ kind: z.literal("EXACT_CONFIRMED_LABEL") }),
    z.strictObject({ kind: z.literal("DETERMINISTIC_LABEL_NORMALISATION") }),
    z.strictObject({ kind: z.literal("PATIENT_CONFIRMED_INTERPRETATION"), response: inquiryResponseRefSchema }),
  ]),
});

function statementSourceKey(source: z.infer<typeof barrierStatementSourceSchema>): string {
  return source.kind === "MEDICATION_EVENT_REASON"
    ? `MEDICATION_EVENT_REASON|${revisionRefKey(source.event)}`
    : `INQUIRY_RESPONSE|${revisionRefKey(source.response)}`;
}

const recurringBarrierFactsSchema = z
  .strictObject({
    family: z.literal("RECURRING_BARRIER"),
    barrierKey: patientBarrierKeySchema,
    affectedTask: barrierAffectedTaskSchema,
    scope: patternScopeSchema,
    occurrences: z
      .array(
        z.strictObject({
          occurrenceKey: barrierOccurrenceKeySchema,
          statements: z.array(barrierStatementEvidenceSchema).min(1),
          relatedRecords: uniqueRefListSchema(anyTypedRevisionRefSchema),
        }),
      )
      .min(1),
    distinctOccurrenceCount: positiveCount,
  })
  .superRefine((facts, ctx) => {
    const keys = facts.occurrences.map((occurrence) => occurrence.occurrenceKey);
    if (new Set(keys).size !== keys.length) issue(ctx, "DUPLICATE_OCCURRENCE_KEY", ["occurrences"]);
    if (facts.distinctOccurrenceCount !== new Set(keys).size) {
      issue(ctx, "OCCURRENCE_COUNT_DISAGREES_WITH_KEYS", ["distinctOccurrenceCount"]);
    }
    const seen = new Set<string>();
    for (const occurrence of facts.occurrences) {
      for (const statement of occurrence.statements) {
        const key = statementSourceKey(statement.source);
        if (seen.has(key)) issue(ctx, "STATEMENT_SOURCE_REUSED", ["occurrences"]);
        seen.add(key);
      }
    }
  });

// --- Section 8.14: comparable-slot trend --------------------------------------

const comparableMethodSchema = z.enum(["FINGERSTICK_METER", "CGM", "FLASH_SENSOR", "LAB"]);

const readingAssignmentSchema = z.strictObject({
  reading: glucoseReadingRefSchema,
  measurementMethod: comparableMethodSchema,
  slotAssignment: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("PATIENT_SELECTED_SLOT") }),
    z.strictObject({ kind: z.literal("PRESCRIBED_SLOT") }),
    z.strictObject({
      kind: z.literal("EVENT_RELATIVE_INTAKE"),
      relatedEvent: intakeEventRefSchema,
      signedOffsetMinutes: wholeMinutes,
      identityBasis: z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("EXACT_STRUCTURED_AND_ITEM_MATCH") }),
        z.strictObject({ kind: z.literal("PATIENT_CONFIRMED_EQUIVALENCE"), response: inquiryResponseRefSchema }),
      ]),
    }),
    z.strictObject({
      kind: z.literal("EVENT_RELATIVE_MEDICATION"),
      relatedEvent: medicationEventRefSchema,
      signedOffsetMinutes: wholeMinutes,
    }),
  ]),
});

export type ComparableGlucoseReadingAssignment = z.infer<typeof readingAssignmentSchema>;

const comparableSummarySchema = z
  .strictObject({
    ...glucoseDistributionSummaryFields,
    distinctDayCount: positiveCount,
    dispersion: z.strictObject({ metric: z.enum(["IQR", "MAD"]), valueMmolL: canonicalNonNegativeDecimalSchema }),
  })
  .superRefine((summary, ctx) => {
    const order = glucoseSummaryOrderIssue(summary);
    if (order) issue(ctx, order);
    if (summary.distinctDayCount > summary.distinctOccasionCount) issue(ctx, "DAYS_EXCEED_OCCASIONS");
  });

const comparableSegmentSchema = z.strictObject({
  window: instantWindowSchema,
  assignments: z.array(readingAssignmentSchema).min(1),
  summary: comparableSummarySchema,
});

const methodComparisonSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("SAME_METHOD"), method: comparableMethodSchema }),
  z.strictObject({
    kind: z.literal("REVIEWED_HARMONISATION"),
    referenceMethods: z.array(comparableMethodSchema).min(1).refine((m) => new Set(m).size === m.length, "DUPLICATE_METHOD"),
    recentMethods: z.array(comparableMethodSchema).min(1).refine((m) => new Set(m).size === m.length, "DUPLICATE_METHOD"),
    harmonisationRuleVersion: z.string().min(1).max(96),
  }),
]);

const SLOT_ASSIGNMENT_KIND: Record<string, string> = {
  PATIENT_SELECTED_SLOT: "PATIENT_SELECTED_SLOT",
  PRESCRIBED_SLOT: "PRESCRIBED_SLOT",
  EVENT_RELATIVE_INTAKE: "EVENT_RELATIVE_INTAKE",
  EVENT_RELATIVE_MEDICATION: "EVENT_RELATIVE_MEDICATION",
};

const comparableSlotFactsSchema = z
  .strictObject({
    family: z.literal("COMPARABLE_SLOT_TREND"),
    slot: comparableGlucoseSlotSchema,
    reference: comparableSegmentSchema,
    recent: comparableSegmentSchema,
    difference: z.strictObject({
      medianDifferenceMmolL: canonicalDecimalSchema,
      dispersionDifferenceMmolL: canonicalDecimalSchema,
      overlapRatio: canonicalUnitRatioSchema,
    }),
    measurementMethodComparison: methodComparisonSchema,
  })
  .superRefine((facts, ctx) => {
    if (instantBefore(facts.recent.window.start, facts.reference.window.end)) {
      issue(ctx, "REFERENCE_MUST_END_BEFORE_RECENT_BEGINS", ["recent", "window"]);
    }
    const all = [...facts.reference.assignments, ...facts.recent.assignments];
    const keys = all.map((assignment) => revisionRefKey(assignment.reading));
    if (new Set(keys).size !== keys.length) issue(ctx, "DUPLICATE_READING_ASSIGNMENT");
    for (const segment of [facts.reference, facts.recent]) {
      if (segment.summary.distinctOccasionCount !== segment.assignments.length) {
        issue(ctx, "SUMMARY_COUNT_DISAGREES_WITH_ASSIGNMENTS");
      }
    }
    if (facts.reference.summary.dispersion.metric !== facts.recent.summary.dispersion.metric) {
      issue(ctx, "DISPERSION_METHOD_MUST_MATCH");
    }
    if (all.some((assignment) => assignment.slotAssignment.kind !== SLOT_ASSIGNMENT_KIND[facts.slot.kind])) {
      issue(ctx, "ASSIGNMENT_KIND_DISAGREES_WITH_SLOT");
    }
    const comparison = facts.measurementMethodComparison;
    if (comparison.kind === "SAME_METHOD" && all.some((assignment) => assignment.measurementMethod !== comparison.method)) {
      issue(ctx, "SAME_METHOD_VIOLATED", ["measurementMethodComparison"]);
    }
  });

// --- Section 8.15: prescribed-timing alignment ---------------------------------

const windowPositionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("BEFORE"), distanceMinutes: z.number().int().nonnegative().safe() }),
  z.strictObject({ kind: z.literal("WITHIN") }),
  z.strictObject({ kind: z.literal("AFTER"), distanceMinutes: z.number().int().nonnegative().safe() }),
]);

const timingBasisSchema = z.union([
  z.strictObject({
    kind: z.literal("POINT_TARGET"),
    targetAt: instantSchema,
    explicitWindow: z
      .strictObject({ startAt: instantSchema, endAt: instantSchema })
      .refine((w) => instantBefore(w.startAt, w.endAt), "WINDOW_END_MUST_FOLLOW_START")
      .optional(),
  }),
  z
    .strictObject({ kind: z.literal("EXPLICIT_WINDOW"), startAt: instantSchema, endAt: instantSchema })
    .refine((w) => instantBefore(w.startAt, w.endAt), "WINDOW_END_MUST_FOLLOW_START"),
]);

const timingComparisonSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("POINT_WITHOUT_WINDOW"), signedOffsetMinutes: wholeMinutes }),
  z.strictObject({
    kind: z.literal("POINT_WITH_EXPLICIT_WINDOW"),
    signedOffsetMinutes: wholeMinutes,
    windowPosition: windowPositionSchema,
  }),
  z.strictObject({ kind: z.literal("EXPLICIT_WINDOW"), windowPosition: windowPositionSchema }),
]);

const timingOccurrenceSchema = z
  .strictObject({
    medicationEvent: medicationEventRefSchema,
    prescriptionVersion: prescriptionVersionRefSchema,
    scheduleKey: z.string().min(1).max(128),
    timingBasis: timingBasisSchema,
    comparison: timingComparisonSchema,
  })
  .superRefine((occurrence, ctx) => {
    const basis = occurrence.timingBasis;
    const expected =
      basis.kind === "EXPLICIT_WINDOW"
        ? "EXPLICIT_WINDOW"
        : basis.explicitWindow
          ? "POINT_WITH_EXPLICIT_WINDOW"
          : "POINT_WITHOUT_WINDOW";
    if (occurrence.comparison.kind !== expected) issue(ctx, "COMPARISON_DISAGREES_WITH_BASIS", ["comparison"]);
  });

function timingSubjectIssue(
  facts: { subject: z.infer<typeof prescribedTimingSubjectSchema>; occurrences: z.infer<typeof timingOccurrenceSchema>[] },
  ctx: Ctx,
) {
  const keys = facts.occurrences.map((o) => revisionRefKey(o.medicationEvent));
  if (new Set(keys).size !== keys.length) issue(ctx, "DUPLICATE_MEDICATION_EVENT", ["occurrences"]);
  for (const occurrence of facts.occurrences) {
    if (
      occurrence.scheduleKey !== facts.subject.scheduleKey ||
      revisionRefKey(occurrence.prescriptionVersion) !== revisionRefKey(facts.subject.prescriptionVersion)
    ) {
      issue(ctx, "OCCURRENCE_OUTSIDE_SUBJECT", ["occurrences"]);
    }
  }
}

const prescribedOffsetFactsSchema = z
  .strictObject({
    family: z.literal("PRESCRIBED_TIMING_ALIGNMENT"),
    claimKind: z.literal("RECORDED_OFFSET_CLUSTER"),
    subject: prescribedTimingSubjectSchema,
    occurrences: z.array(timingOccurrenceSchema).min(1),
    summary: z.strictObject({
      recordedOccasionCount: positiveCount,
      medianOffsetMinutes: wholeMinutes,
      lowerTypicalOffsetMinutes: wholeMinutes,
      upperTypicalOffsetMinutes: wholeMinutes,
      dispersionMinutes: z.number().int().nonnegative().safe(),
    }),
  })
  .superRefine((facts, ctx) => {
    timingSubjectIssue(facts, ctx);
    if (facts.summary.recordedOccasionCount !== facts.occurrences.length) issue(ctx, "OCCASION_COUNT_MISMATCH");
    if (facts.summary.lowerTypicalOffsetMinutes > facts.summary.upperTypicalOffsetMinutes) issue(ctx, "TYPICAL_RANGE_INVERTED");
  });

const prescribedWindowFactsSchema = z
  .strictObject({
    family: z.literal("PRESCRIBED_TIMING_ALIGNMENT"),
    claimKind: z.literal("RECORDED_EXPLICIT_WINDOW_RELATIONSHIP"),
    subject: prescribedTimingSubjectSchema,
    occurrences: z.array(timingOccurrenceSchema).min(1),
    summary: z.strictObject({
      recordedOccasionCount: positiveCount,
      beforeWindowCount: nonNegativeCount,
      withinWindowCount: nonNegativeCount,
      afterWindowCount: nonNegativeCount,
    }),
  })
  .superRefine((facts, ctx) => {
    timingSubjectIssue(facts, ctx);
    const s = facts.summary;
    if (s.recordedOccasionCount !== facts.occurrences.length) issue(ctx, "OCCASION_COUNT_MISMATCH");
    if (s.beforeWindowCount + s.withinWindowCount + s.afterWindowCount !== s.recordedOccasionCount) {
      issue(ctx, "WINDOW_COUNTS_DO_NOT_SUM");
    }
    if (facts.occurrences.some((o) => o.comparison.kind === "POINT_WITHOUT_WINDOW")) {
      issue(ctx, "WINDOW_RELATIONSHIP_REQUIRES_EXPLICIT_WINDOW");
    }
  });

// --- Section 8.16: dormant cross-variable association ---------------------------

export const crossVariableOccasionKeySchema = createOpaqueKeySchema<"CrossVariableAssociationOccasionKey">();

const crossVariablePairSchema = z.strictObject({
  occasionKey: crossVariableOccasionKeySchema,
  exposure: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("INTAKE_OCCURRENCE"),
      source: intakeEventRefSchema,
      identityBasis: z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("EXACT_STRUCTURED_AND_ITEM_MATCH") }),
        z.strictObject({ kind: z.literal("PATIENT_CONFIRMED_EQUIVALENCE"), response: inquiryResponseRefSchema }),
      ]),
    }),
    z.strictObject({
      kind: z.literal("FAMILIAR_INTAKE_ITEM"),
      source: intakeEventRefSchema,
      familiarItemKey: familiarItemKeySchema,
      matchedItems: matchedItemsSchema,
    }),
    z.strictObject({
      kind: z.literal("ACTIVITY_OCCURRENCE"),
      source: activityEventRefSchema,
      familiarItemKey: familiarItemKeySchema,
      matchBasis: familiarMatchBasisSchema,
    }),
    z.strictObject({
      kind: z.literal("PATIENT_RECORDED_SYMPTOM"),
      source: createTypedRevisionRefSchema(z.literal("SYMPTOM_REPORT")),
      symptomEntryIndex: z.number().int().nonnegative().safe(),
      symptomCode: symptomCodeSchema,
    }),
    z.strictObject({ kind: z.literal("TEMPORARY_CONTEXT"), source: contextWindowRefSchema }),
  ]),
  outcome: readingAssignmentSchema,
  relationship: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("EXPOSURE_PRECEDES_OUTCOME"), signedOffsetMinutes: wholeMinutes }),
    z.strictObject({ kind: z.literal("APPROVED_NEARBY_WINDOW"), signedOffsetMinutes: wholeMinutes }),
    z.strictObject({ kind: z.literal("OUTCOME_WITHIN_CONTEXT") }),
  ]),
  overlappingRecordedFactors: uniqueRefListSchema(anyTypedRevisionRefSchema),
});

const crossVariableSummarySchema = comparableSummarySchema;

const crossVariableFactsSchema = z.union([
  z.strictObject({
    family: z.literal("CROSS_VARIABLE_ASSOCIATION"),
    findingKind: z.literal("EXPOSED_VS_COMPARATOR"),
    definition: crossVariableDefinitionRefSchema,
    exposure: crossVariableExposureSchema,
    outcome: crossVariableOutcomeSchema,
    exposedPairs: z.array(crossVariablePairSchema).min(1),
    comparisonGroup: z.discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("EXPLICIT_NON_EXPOSURE"),
        occasions: z
          .array(
            z.strictObject({
              occasionKey: crossVariableOccasionKeySchema,
              outcome: readingAssignmentSchema,
              explicitNonExposureConfirmation: inquiryResponseRefSchema,
              overlappingRecordedFactors: uniqueRefListSchema(anyTypedRevisionRefSchema),
            }),
          )
          .min(1),
      }),
      z.strictObject({
        kind: z.literal("ESTABLISHED_COMPARABLE_BASELINE"),
        baseline: patternBaselineReferenceSchema,
        outcomes: z.array(readingAssignmentSchema).min(1),
      }),
    ]),
    exposedSummary: crossVariableSummarySchema,
    comparatorSummary: crossVariableSummarySchema,
    difference: z.strictObject({
      medianDifferenceMmolL: canonicalDecimalSchema,
      dispersionDifferenceMmolL: canonicalDecimalSchema,
      overlapRatio: canonicalUnitRatioSchema,
    }),
    outcomePredicateVersion: z.string().min(1).max(96).optional(),
  }),
  z
    .strictObject({
      family: z.literal("CROSS_VARIABLE_ASSOCIATION"),
      findingKind: z.literal("RECORDED_COOCCURRENCE"),
      definition: crossVariableDefinitionRefSchema,
      exposure: crossVariableExposureSchema,
      outcome: crossVariableOutcomeSchema,
      pairs: z.array(crossVariablePairSchema).min(1),
      distinctPairCount: positiveCount,
      outcomePredicateVersion: z.string().min(1).max(96).optional(),
    })
    .refine((facts) => new Set(facts.pairs.map((p) => p.occasionKey)).size === facts.distinctPairCount, "PAIR_COUNT_MISMATCH"),
]);

// --- Completed closed evidence-facts union --------------------------------------

export const patternFamilyEvidenceFactsSchema = z.union([
  routineShiftFactsSchema,
  contextBoundedDeviationFactsSchema,
  returnTowardBaselineFactsSchema,
  familiarRecurrenceFactsSchema,
  familiarShareFactsSchema,
  recurringBarrierFactsSchema,
  comparableSlotFactsSchema,
  prescribedOffsetFactsSchema,
  prescribedWindowFactsSchema,
  crossVariableFactsSchema,
]);

export type PatternFamilyEvidenceFacts = z.infer<typeof patternFamilyEvidenceFactsSchema>;
export type ComparableSlotTrendEvidenceFacts = z.infer<typeof comparableSlotFactsSchema>;
export type FamiliarOrFrequentItemEvidenceFacts =
  | z.infer<typeof familiarRecurrenceFactsSchema>
  | z.infer<typeof familiarShareFactsSchema>;
export type FamiliarItemEvidenceMatch = z.infer<typeof familiarEvidenceMatchSchema>;
