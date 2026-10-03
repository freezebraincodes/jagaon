// Test-only fixtures for the Packet 7A Pattern domain contracts. Imported by
// tests only; never reachable from the application entrypoint.

export function testUuid(n: number, part: number): string {
  const head = n.toString(16).padStart(8, "0");
  const tail = (part * 1000 + n).toString(16).padStart(12, "0");
  return `${head}-0000-4000-8000-${tail}`;
}

export function testRef(recordType: string, n: number) {
  return { recordType, recordId: testUuid(n, 1), revisionId: testUuid(n, 2) };
}

export const OBSERVATION_RECORD = testUuid(900, 1);

export const BREAKFAST_SLOT = {
  kind: "PATIENT_SELECTED_SLOT",
  slot: "BEFORE_BREAKFAST",
} as const;

const glucoseSubject = { kind: "GLUCOSE_VALUE", slot: BREAKFAST_SLOT } as const;

const learnedBaseline = {
  kind: "LEARNED_KNOWLEDGE",
  baseline: testRef("LEARNED_KNOWLEDGE", 50),
} as const;

const supportedBaseline = {
  kind: "SUPPORTED_PATTERN",
  observation: testRef("PATTERN_OBSERVATION", 51),
  evidenceSnapshot: testRef("PATTERN_EVIDENCE_SNAPSHOT", 52),
} as const;

export const familiarIntakeItem = {
  kind: "INTAKE_ITEM",
  familiarItemKey: "fik-kaya-toast",
  label: { text: "Kaya toast", language: "und" },
  itemKind: "FOOD",
  intakeContext: { kind: "ANY_RECORDED_INTAKE" },
} as const;

const glucoseSummary = (median: string, lower: string, upper: string, count: number) => ({
  kind: "GLUCOSE_DISTRIBUTION",
  canonicalUnit: "MMOL_L",
  median,
  lowerTypicalBound: lower,
  upperTypicalBound: upper,
  distinctOccasionCount: count,
});

const timeSummary = {
  kind: "LOCAL_TIME_WINDOW",
  start: "07:00",
  end: "07:30",
  crossesMidnight: false,
  timeZoneId: "Asia/Singapore",
  distinctOccasionCount: 6,
};

const barrierIdentity = { kind: "CATEGORISED", barrierKey: "bk-forget", category: "REMEMBERING" } as const;
const barrierTask = { kind: "MEDICATION", activity: "RECORDING" } as const;

const prescribedSubject = {
  medication: testRef("MEDICATION", 60),
  prescriptionVersion: testRef("PRESCRIPTION_VERSION", 61),
  scheduleKey: "evening",
};

/** One valid claim per family (cross-variable has no reviewed definition). */
export const CLAIMS = {
  ROUTINE_SHIFT: {
    family: "ROUTINE_SHIFT",
    subject: {
      kind: "ROUTINE_TIMING",
      subject: { kind: "MEASUREMENT_TIMING", measurementKind: "GLUCOSE" },
      dimension: "LOCAL_TIME_WINDOW",
    },
    baseline: learnedBaseline,
    observedChange: { kind: "LOCAL_TIME_WINDOW", direction: "LATER", spread: "SIMILAR" },
  },
  FAMILIAR_OR_FREQUENT_ITEM: {
    family: "FAMILIAR_OR_FREQUENT_ITEM",
    item: familiarIntakeItem,
    scope: { kind: "ORDINARY" },
    claim: { kind: "RECURRING_IN_RECORDED_OCCASIONS" },
  },
  RECURRING_BARRIER: {
    family: "RECURRING_BARRIER",
    barrier: barrierIdentity,
    affectedTask: barrierTask,
    scope: { kind: "ORDINARY" },
    claim: { kind: "REPEATED_EXPLICIT_PATIENT_REPORTS" },
  },
  COMPARABLE_SLOT_TREND: {
    family: "COMPARABLE_SLOT_TREND",
    slot: BREAKFAST_SLOT,
    observedChange: { typicalValue: "HIGHER", variability: "NO_MATERIAL_CHANGE" },
  },
  PRESCRIBED_TIMING_ALIGNMENT: {
    family: "PRESCRIBED_TIMING_ALIGNMENT",
    subject: prescribedSubject,
    claim: { kind: "RECORDED_OFFSET_CLUSTER", direction: "POSITIVE_OFFSET" },
  },
  CONTEXT_BOUNDED_DEVIATION: {
    family: "CONTEXT_BOUNDED_DEVIATION",
    subject: glucoseSubject,
    baseline: supportedBaseline,
    context: testRef("CONTEXT_WINDOW", 53),
    observedChange: { kind: "GLUCOSE_DISTRIBUTION", direction: "HIGHER" },
  },
  RETURN_TOWARD_BASELINE: {
    family: "RETURN_TOWARD_BASELINE",
    subject: glucoseSubject,
    baseline: supportedBaseline,
    deviation: {
      observation: testRef("PATTERN_OBSERVATION", 54),
      evidenceSnapshot: testRef("PATTERN_EVIDENCE_SNAPSHOT", 55),
    },
    returnState: "MOVING_CLOSER",
  },
  CROSS_VARIABLE_ASSOCIATION: {
    family: "CROSS_VARIABLE_ASSOCIATION",
    definition: { definitionKey: "walk-vs-breakfast", definitionVersion: "1" },
    exposure: {
      kind: "ACTIVITY_OCCURRENCE",
      activity: {
        kind: "ACTIVITY",
        familiarItemKey: "fik-walk",
        label: { text: "Evening walk", language: "und" },
        activityCategory: "WALKING",
      },
    },
    outcome: { kind: "COMPARABLE_GLUCOSE", slot: BREAKFAST_SLOT },
    finding: { kind: "RECORDED_COOCCURRENCE" },
  },
} as const;

const readingAssignment = (n: number) => ({
  reading: testRef("GLUCOSE_READING", n),
  measurementMethod: "FINGERSTICK_METER",
  slotAssignment: { kind: "PATIENT_SELECTED_SLOT" },
});

export const COMPARABLE_REFERENCE_READINGS = [1, 2, 3, 4, 5, 6, 7, 8];
export const COMPARABLE_RECENT_READINGS = [11, 12, 13, 14, 15, 16];

/** One valid evidence-facts value per family. */
export const FACTS = {
  ROUTINE_SHIFT: {
    family: "ROUTINE_SHIFT",
    subject: CLAIMS.ROUTINE_SHIFT.subject,
    baselineSummary: timeSummary,
    recentSummary: { ...timeSummary, start: "07:45", end: "08:15" },
    difference: { kind: "LOCAL_TIME_WINDOW", typicalShiftMinutes: 45, widthChangeMinutes: 0, overlapRatio: "0" },
  },
  FAMILIAR_OR_FREQUENT_ITEM: {
    family: "FAMILIAR_OR_FREQUENT_ITEM",
    claimKind: "RECURRING_IN_RECORDED_OCCASIONS",
    familiarItemKey: "fik-kaya-toast",
    occurrenceMatches: [20, 21, 22, 23].map((n) => ({
      kind: "INTAKE_ITEM",
      source: testRef("INTAKE_EVENT", n),
      matchedItems: [{ itemIndex: 0, matchBasis: { kind: "EXACT_AUTHORED_LABEL" } }],
    })),
  },
  RECURRING_BARRIER: {
    family: "RECURRING_BARRIER",
    barrierKey: "bk-forget",
    affectedTask: barrierTask,
    scope: { kind: "ORDINARY" },
    occurrences: [
      {
        occurrenceKey: "occ-1",
        statements: [
          {
            source: { kind: "MEDICATION_EVENT_REASON", event: testRef("MEDICATION_EVENT", 30), field: "patientStatedReason" },
            attributionBasis: { kind: "STRUCTURED_PATIENT_SELECTION" },
          },
        ],
        relatedRecords: [],
      },
    ],
    distinctOccurrenceCount: 1,
  },
  COMPARABLE_SLOT_TREND: {
    family: "COMPARABLE_SLOT_TREND",
    slot: BREAKFAST_SLOT,
    reference: {
      window: { start: "2026-08-22T16:00:00.000Z", end: "2026-09-19T16:00:00.000Z" },
      assignments: COMPARABLE_REFERENCE_READINGS.map(readingAssignment),
      summary: {
        ...glucoseSummary("6.1", "5.8", "6.4", 8),
        distinctDayCount: 8,
        dispersion: { metric: "IQR", valueMmolL: "0.6" },
      },
    },
    recent: {
      window: { start: "2026-09-19T16:00:00.000Z", end: "2026-10-03T16:00:00.000Z" },
      assignments: COMPARABLE_RECENT_READINGS.map(readingAssignment),
      summary: {
        ...glucoseSummary("7.4", "7.1", "7.8", 6),
        distinctDayCount: 6,
        dispersion: { metric: "IQR", valueMmolL: "0.7" },
      },
    },
    difference: { medianDifferenceMmolL: "1.3", dispersionDifferenceMmolL: "0.1", overlapRatio: "0" },
    measurementMethodComparison: { kind: "SAME_METHOD", method: "FINGERSTICK_METER" },
  },
  PRESCRIBED_TIMING_ALIGNMENT: {
    family: "PRESCRIBED_TIMING_ALIGNMENT",
    claimKind: "RECORDED_OFFSET_CLUSTER",
    subject: prescribedSubject,
    occurrences: [
      {
        medicationEvent: testRef("MEDICATION_EVENT", 40),
        prescriptionVersion: prescribedSubject.prescriptionVersion,
        scheduleKey: "evening",
        timingBasis: { kind: "POINT_TARGET", targetAt: "2026-09-30T13:00:00.000Z" },
        comparison: { kind: "POINT_WITHOUT_WINDOW", signedOffsetMinutes: 35 },
      },
    ],
    summary: {
      recordedOccasionCount: 1,
      medianOffsetMinutes: 35,
      lowerTypicalOffsetMinutes: 35,
      upperTypicalOffsetMinutes: 35,
      dispersionMinutes: 0,
    },
  },
  CONTEXT_BOUNDED_DEVIATION: {
    family: "CONTEXT_BOUNDED_DEVIATION",
    subject: glucoseSubject,
    baselineSummary: glucoseSummary("6.1", "5.8", "6.4", 8),
    insideContextSummary: glucoseSummary("7.4", "7.1", "7.8", 6),
    difference: { kind: "GLUCOSE_DISTRIBUTION", medianDifferenceMmolL: "1.3", overlapRatio: "0" },
    context: testRef("CONTEXT_WINDOW", 53),
    contextBoundary: "KNOWN_START_END_UNKNOWN",
    overlappingContexts: [],
  },
  RETURN_TOWARD_BASELINE: {
    family: "RETURN_TOWARD_BASELINE",
    subject: glucoseSubject,
    baselineSummary: glucoseSummary("6.1", "5.8", "6.4", 8),
    deviationSummary: glucoseSummary("7.4", "7.1", "7.8", 6),
    recentSummary: glucoseSummary("6.6", "6.2", "6.9", 6),
    deviationDistanceFromBaseline: { kind: "GLUCOSE_MEDIAN_MMOL_L", absoluteValue: "1.3" },
    recentDistanceFromBaseline: { kind: "GLUCOSE_MEDIAN_MMOL_L", absoluteValue: "0.5" },
  },
  CROSS_VARIABLE_ASSOCIATION: {
    family: "CROSS_VARIABLE_ASSOCIATION",
    findingKind: "RECORDED_COOCCURRENCE",
    definition: CLAIMS.CROSS_VARIABLE_ASSOCIATION.definition,
    exposure: CLAIMS.CROSS_VARIABLE_ASSOCIATION.exposure,
    outcome: CLAIMS.CROSS_VARIABLE_ASSOCIATION.outcome,
    pairs: [
      {
        occasionKey: "occ-1",
        exposure: {
          kind: "ACTIVITY_OCCURRENCE",
          source: testRef("ACTIVITY_EVENT", 70),
          familiarItemKey: "fik-walk",
          matchBasis: { kind: "EXACT_AUTHORED_LABEL" },
        },
        outcome: readingAssignment(71),
        relationship: { kind: "EXPOSURE_PRECEDES_OUTCOME", signedOffsetMinutes: 600 },
        overlappingRecordedFactors: [],
      },
    ],
    distinctPairCount: 1,
  },
} as const;

const dimensionResult = (dimension: string, outcome: string, reasonCodes: string[]) => ({
  dimension,
  outcome,
  reasonCodes,
});

/** A complete supported comparable-slot snapshot payload. */
export function comparableSnapshotPayload(): Record<string, unknown> {
  return {
    family: "COMPARABLE_SLOT_TREND",
    evaluatedAt: "2026-10-03T16:00:00.000Z",
    observationWindow: { start: "2026-08-22T16:00:00.000Z", end: "2026-10-03T16:00:00.000Z" },
    ruleVersions: {
      familyRuleVersion: "comparable-slot-trend.v1",
      evidenceGateVersion: "comparable-slot-gate.v1",
      missingnessRuleVersion: "missingness.v1",
      metricRuleVersion: "metric-utilities.v1",
    },
    evidenceGroups: [
      { role: "BASELINE", revisions: COMPARABLE_REFERENCE_READINGS.map((n) => testRef("GLUCOSE_READING", n)) },
      { role: "RECENT", revisions: COMPARABLE_RECENT_READINGS.map((n) => testRef("GLUCOSE_READING", n)) },
    ],
    consideredButExcluded: [{ revision: testRef("GLUCOSE_READING", 99), reason: "CORRECTED_AWAY" }],
    coverage: {
      kind: "OBSERVATION_SPAN",
      distinctOccasionCount: 14,
      distinctDayCount: 14,
      spanDays: 42,
      outcome: "ADEQUATE",
    },
    gate: {
      dimensions: [
        dimensionResult("SUPPORT", "PASS", ["SUPPORT_MINIMUM_MET"]),
        dimensionResult("COVERAGE", "PASS", ["COVERAGE_DATES_AND_WEEKS_MET"]),
        dimensionResult("COMPARISON", "PASS", ["SAME_SLOT_AND_METHOD"]),
        dimensionResult("MISSINGNESS", "PASS", ["MISSING_READINGS_REMAIN_UNKNOWN"]),
        dimensionResult("RECENCY", "PASS", ["RECENT_SEGMENT_HAS_READINGS"]),
        dimensionResult("CONSISTENCY", "PASS", ["SPLIT_HALVES_AGREE"]),
        dimensionResult("CONTRADICTION", "NOT_APPLICABLE", ["CONTRADICTION_ASSESSED_BY_SPLIT_HALVES"]),
        dimensionResult("CONTEXT", "PASS", ["NO_RECORDED_CONTEXT_OR_CARE_BOUNDARY"]),
        dimensionResult("STABILITY", "PASS", ["STABILITY_NOT_REQUIRED_FOR_DIRECTION"]),
        dimensionResult("MAGNITUDE_OR_USEFULNESS", "PASS", ["MEDIAN_DIFFERENCE_MATERIAL"]),
        dimensionResult("PRIOR_PATIENT_DISPOSITION", "PASS", ["NO_PRIOR_PATIENT_DISPOSITION"]),
      ],
      overall: "SUPPORTED",
    },
    facts: FACTS.COMPARABLE_SLOT_TREND,
    limitations: ["UNKNOWN_NEGATIVE_STATUS"],
  };
}

/** A complete supported familiar-item snapshot payload. */
export function familiarSnapshotPayload(): Record<string, unknown> {
  return {
    family: "FAMILIAR_OR_FREQUENT_ITEM",
    evaluatedAt: "2026-10-03T16:00:00.000Z",
    observationWindow: { start: "2026-08-04T16:00:00.000Z", end: "2026-10-03T16:00:00.000Z" },
    ruleVersions: {
      familyRuleVersion: "familiar-or-frequent-item.v1",
      evidenceGateVersion: "familiar-item-gate.v1",
      missingnessRuleVersion: "missingness.v1",
      metricRuleVersion: "metric-utilities.v1",
    },
    evidenceGroups: [{ role: "SUPPORTING", revisions: [20, 21, 22, 23].map((n) => testRef("INTAKE_EVENT", n)) }],
    consideredButExcluded: [],
    coverage: {
      kind: "OBSERVATION_SPAN",
      distinctOccasionCount: 4,
      distinctDayCount: 4,
      spanDays: 6,
      outcome: "ADEQUATE",
    },
    gate: {
      dimensions: [
        dimensionResult("SUPPORT", "PASS", ["OCCURRENCE_MINIMUM_MET"]),
        dimensionResult("COVERAGE", "PASS", ["DISTINCT_DAYS_WITHIN_SEVEN_DAYS_MET"]),
        dimensionResult("COMPARISON", "NOT_APPLICABLE", ["RECURRENCE_CLAIM_HAS_NO_COMPARATOR"]),
        dimensionResult("MISSINGNESS", "PASS", ["UNLOGGED_OCCASIONS_REMAIN_UNKNOWN"]),
        dimensionResult("RECENCY", "PASS", ["LATEST_OCCURRENCE_WITHIN_THIRTY_DAYS"]),
        dimensionResult("CONSISTENCY", "PASS", ["EXACT_OR_NORMALISED_IDENTITY"]),
        dimensionResult("CONTRADICTION", "PASS", ["NO_PATIENT_CONTRADICTION_RECORDED"]),
        dimensionResult("CONTEXT", "PASS", ["NO_RECORDED_CONTEXT_BOUNDARY"]),
        dimensionResult("STABILITY", "NOT_APPLICABLE", ["STABILITY_NOT_APPLICABLE_TO_RECURRENCE"]),
        dimensionResult("MAGNITUDE_OR_USEFULNESS", "NOT_APPLICABLE", ["MAGNITUDE_NOT_APPLICABLE_TO_RECURRENCE"]),
        dimensionResult("PRIOR_PATIENT_DISPOSITION", "PASS", ["NO_PRIOR_PATIENT_DISPOSITION"]),
      ],
      overall: "SUPPORTED",
    },
    facts: FACTS.FAMILIAR_OR_FREQUENT_ITEM,
    limitations: ["UNKNOWN_NEGATIVE_STATUS"],
  };
}

export function observationPayload(family: keyof typeof CLAIMS, lifecycle: unknown = { state: "SUPPORTED" }) {
  return {
    family,
    claim: CLAIMS[family],
    lifecycle,
    evidenceSnapshot: testRef("PATTERN_EVIDENCE_SNAPSHOT", 80),
    patientDisposition: { kind: "NONE" },
  };
}
