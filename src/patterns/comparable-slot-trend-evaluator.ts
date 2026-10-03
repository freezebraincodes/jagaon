import {
  COMPARABLE_SLOT_TREND_CONFIG_V1,
  INTELLIGENCE_ACTIVATION_MANIFEST,
  type EnabledPatternDisposition,
} from "@/application/intelligence/activation-manifest";
import {
  addDays,
  canonicalDecimal,
  compareRational,
  decimal,
  fingerprint,
  formatRatio6,
  instantMs,
  intervalOverlapRatio,
  localDateOf,
  median,
  rationalAbs,
  rationalDivide,
  rationalSign,
  rationalSubtract,
  sortByInstantThenRevision,
  sortRevisionRefs,
  tukeyHinges,
  weekBlockIndex,
  type Rational,
} from "@/application/intelligence/metrics";
import type { Instant } from "@/domain/shared/time";
import type { TypedRevisionRef } from "@/domain/shared/typed-revision-ref";
import type {
  ComparableGlucoseReadingAssignment,
  ComparableGlucoseSlot,
  PatternClaim,
  PatternEvidenceSnapshotPayload,
  PatternExclusionReason,
  PatternGateDimension,
  PatternGateOutcome,
  PatternLifecycle,
  PatternLimitationCode,
} from "@/domain/patterns";
import { aggregatePatternGate } from "@/domain/patterns";
import type {
  PatternEvaluation,
  PatternEvaluationResult,
  PatternSourceRole,
  PreviousPatternChain,
  ResolvedGlucoseReading,
  SupersededRevision,
} from "./pattern-evaluator-contracts";
import {
  downgradePrevious,
  finaliseProposal,
  inputFingerprintOf,
  isTerminalForEvaluator,
} from "./pattern-evaluator-support";

/**
 * Comparable-slot glucose trend evaluator ("comparable-slot-trend.v1").
 *
 * Deterministic-engine Section 10.1 and domain Section 8.14: a fixed 28-day
 * reference segment `[T - 42d, T - 14d)` against a fixed 14-day recent
 * segment `[T - 14d, T)` within one patient-selected slot, same measurement
 * method and MMOL_L values. Medians, Tukey hinges, overlap and split-half
 * agreement use exact arithmetic. Higher and lower describe recorded values
 * only; nothing here classifies, explains or predicts.
 */

const FAMILY = "COMPARABLE_SLOT_TREND" as const;
const DISPOSITION = INTELLIGENCE_ACTIVATION_MANIFEST.pattern.COMPARABLE_SLOT_TREND as EnabledPatternDisposition;
const CONFIG = COMPARABLE_SLOT_TREND_CONFIG_V1;
const GATE_VERSION = DISPOSITION.ruleVersions.evidenceGateVersion;
const ELIGIBLE_METHODS = new Set(["FINGERSTICK_METER", "CGM", "FLASH_SENSOR", "LAB"]);
const ELIGIBLE_PROVENANCE = new Set(["PATIENT_ENTRY", "PATIENT_RESPONSE", "IMPORT"]);

export type ComparableSlotEvaluationInput = {
  evaluatedAt: Instant;
  inputSequenceCutoff: number;
  slot: ComparableGlucoseSlot;
  /** Latest revisions of glucose readings whose occurrence may fall in the 42-day window. */
  readings: readonly ResolvedGlucoseReading[];
  /** Earlier revisions of those same records. */
  superseded: readonly SupersededRevision[];
  previous: PreviousPatternChain | null;
};

type EligibleReading = {
  source: ResolvedGlucoseReading;
  instant: string;
  revisionId: string;
  offset: number;
  value: Rational;
  method: string;
};

export function comparableSlotCandidateKey(slot: ComparableGlucoseSlot): string {
  if (slot.kind === "PATIENT_SELECTED_SLOT") return `${FAMILY}:PATIENT_SELECTED_SLOT:${slot.slot}`;
  return `${FAMILY}:${slot.kind}:${fingerprint(slot).slice(0, 24)}`;
}

function canonicalValue(reading: ResolvedGlucoseReading): Rational | null {
  const { measurement } = reading.payload;
  if (measurement.normalization) {
    return measurement.normalization.canonicalUnit === "MMOL_L" ? decimal(measurement.normalization.canonicalValue) : null;
  }
  // An MMOL_L entry is already canonical; mg/dL needs an approved recorded normalisation.
  return measurement.enteredUnit === "MMOL_L" ? decimal(measurement.enteredValue) : null;
}

function exclusionFor(reading: ResolvedGlucoseReading): PatternExclusionReason | null {
  if (!ELIGIBLE_PROVENANCE.has(reading.provenance.sourceKind)) return "INELIGIBLE_PROVENANCE";
  const temporal = reading.temporal;
  if (temporal.kind !== "POINT" || temporal.occurrence.kind !== "EXACT" || temporal.occurrence.timeZoneId === null) {
    return "INSUFFICIENT_TEMPORAL_PRECISION";
  }
  if (!ELIGIBLE_METHODS.has(reading.payload.measurementMethod)) return "FAMILY_POLICY_EXCLUSION";
  if (canonicalValue(reading) === null) return "FAMILY_POLICY_EXCLUSION";
  return null;
}

function occursInSlot(reading: ResolvedGlucoseReading, slot: string): boolean {
  const context = reading.payload.context;
  return context.kind === "PATIENT_SELECTED_SLOT" && context.slot === slot;
}

function readingInstant(reading: ResolvedGlucoseReading): string | null {
  const occurrence = reading.temporal.kind === "POINT" ? reading.temporal.occurrence : null;
  if (!occurrence) return null;
  if (occurrence.kind === "EXACT") return occurrence.instantUtc;
  if (occurrence.kind === "APPROXIMATE") return occurrence.approximateInstantUtc;
  return null;
}

function halves<T>(ordered: readonly T[]): [T[], T[]] {
  const size = Math.floor(ordered.length / 2);
  return [ordered.slice(0, size), ordered.slice(ordered.length - size)];
}

function assignment(reading: EligibleReading): ComparableGlucoseReadingAssignment {
  return {
    reading: reading.source.ref as TypedRevisionRef<"GLUCOSE_READING">,
    measurementMethod: reading.method as ComparableGlucoseReadingAssignment["measurementMethod"],
    slotAssignment: { kind: "PATIENT_SELECTED_SLOT" },
  };
}

type Coverage = "NONE" | "SIGNAL" | "EMERGING" | "SUPPORTED";

export function evaluateComparableSlotTrend(input: ComparableSlotEvaluationInput): PatternEvaluation {
  const candidateKey = comparableSlotCandidateKey(input.slot);
  const T = input.evaluatedAt;
  const recentStart = addDays(T, -CONFIG.recentWindowDays);
  const referenceStart = addDays(T, -CONFIG.referenceWindowStartDays);
  const sources = sortRevisionRefs(input.readings.map((reading) => reading.ref));
  const superseded = sortRevisionRefs(input.superseded.map((entry) => entry.ref));

  const envelope = (result: PatternEvaluationResult, considered: TypedRevisionRef<never>[]): PatternEvaluation => ({
    evaluatorKey: DISPOSITION.evaluatorKey,
    evaluatorVersion: DISPOSITION.evaluatorVersion,
    configurationVersion: DISPOSITION.configurationVersion,
    evaluatedAt: T,
    inputSequenceCutoff: input.inputSequenceCutoff,
    candidateKey,
    consideredRevisions: sortRevisionRefs(considered),
    inputFingerprint: inputFingerprintOf({
      evaluatorKey: DISPOSITION.evaluatorKey,
      evaluatorVersion: DISPOSITION.evaluatorVersion,
      configurationVersion: DISPOSITION.configurationVersion,
      evaluatedAt: T,
      inputSequenceCutoff: input.inputSequenceCutoff,
      candidateKey,
      sources,
      superseded,
      previous: input.previous,
    }),
    resultFingerprint: fingerprint(result),
    result,
  });

  if (input.previous && isTerminalForEvaluator(input.previous.observation.payload.lifecycle)) {
    return envelope({ kind: "NO_CHANGE", family: FAMILY, candidateKey }, []);
  }
  if (input.slot.kind !== "PATIENT_SELECTED_SLOT" || !(CONFIG.eligibleSlots as readonly string[]).includes(input.slot.slot)) {
    return envelope(
      { kind: "INSUFFICIENT_EVIDENCE", family: FAMILY, candidateKey, reasonCodes: ["UNSUPPORTED_SLOT_VARIANT"], counts: {} },
      [],
    );
  }
  const slot = input.slot.slot;

  // Bounded family query: only this slot inside [T - 42d, T).
  const considered = input.readings.filter((reading) => {
    if (!occursInSlot(reading, slot)) return false;
    const instant = readingInstant(reading);
    return instant !== null && instantMs(instant) >= instantMs(referenceStart) && instantMs(instant) < instantMs(T);
  });
  const consideredRecordIds = new Set(considered.map((reading) => reading.ref.recordId));

  const exclusions: { revision: TypedRevisionRef<never>; reason: PatternExclusionReason }[] = [];
  const eligible: EligibleReading[] = [];
  for (const reading of considered) {
    const reason = exclusionFor(reading);
    if (reason) {
      exclusions.push({ revision: reading.ref as never, reason });
      continue;
    }
    const occurrence = reading.temporal.kind === "POINT" && reading.temporal.occurrence.kind === "EXACT" ? reading.temporal.occurrence : null;
    if (!occurrence) continue;
    eligible.push({
      source: reading,
      instant: occurrence.instantUtc,
      revisionId: reading.ref.revisionId,
      offset: occurrence.utcOffsetMinutes,
      value: canonicalValue(reading)!,
      method: reading.payload.measurementMethod,
    });
  }

  // One logical occasion per instant within the slot.
  const ordered = sortByInstantThenRevision(eligible);
  const seenInstants = new Set<number>();
  const occasions: EligibleReading[] = [];
  for (const reading of ordered) {
    const key = instantMs(reading.instant);
    if (seenInstants.has(key)) {
      exclusions.push({ revision: reading.source.ref as never, reason: "DUPLICATE_LOGICAL_OCCASION" });
    } else {
      seenInstants.add(key);
      occasions.push(reading);
    }
  }
  for (const entry of input.superseded) {
    if (consideredRecordIds.has(entry.ref.recordId)) exclusions.push({ revision: entry.ref as never, reason: "CORRECTED_AWAY" });
  }

  const reference = occasions.filter((reading) => instantMs(reading.instant) < instantMs(recentStart));
  const recent = occasions.filter((reading) => instantMs(reading.instant) >= instantMs(recentStart));
  const dates = (set: EligibleReading[]) => new Set(set.map((r) => localDateOf(r.instant, r.offset))).size;
  const weeks = (set: EligibleReading[]) => new Set(set.map((r) => weekBlockIndex(r.instant, T))).size;
  const counts = {
    reference: reference.length,
    recent: recent.length,
    referenceDates: dates(reference),
    recentDates: dates(recent),
    referenceWeeks: weeks(reference),
    recentWeeks: weeks(recent),
  };
  const consideredRefs = [
    ...considered.map((reading) => reading.ref as never),
    ...exclusions.filter((entry) => entry.reason === "CORRECTED_AWAY").map((entry) => entry.revision),
  ];

  const minima = CONFIG.lifecycleMinima;
  const meets = (m: { reference: number; recent: number; referenceDates: number; recentDates: number }) =>
    counts.reference >= m.reference &&
    counts.recent >= m.recent &&
    counts.referenceDates >= m.referenceDates &&
    counts.recentDates >= m.recentDates;
  const supportedCoverage =
    meets(minima.SUPPORTED) &&
    counts.referenceWeeks >= minima.SUPPORTED.referenceWeeks &&
    counts.recentWeeks >= minima.SUPPORTED.recentWeeks;
  const coverage: Coverage = supportedCoverage
    ? "SUPPORTED"
    : meets(minima.EMERGING)
      ? "EMERGING"
      : meets(minima.SIGNAL)
        ? "SIGNAL"
        : "NONE";

  const latestEligible = occasions.at(-1)?.instant ?? null;
  const staleNow = latestEligible === null || instantMs(latestEligible) < instantMs(addDays(T, -CONFIG.stalenessDays));
  const insufficient = (reasonCodes: string[]): PatternEvaluation =>
    envelope(
      input.previous
        ? downgradePrevious(FAMILY, candidateKey, input.previous, staleNow)
        : { kind: "INSUFFICIENT_EVIDENCE", family: FAMILY, candidateKey, reasonCodes, counts },
      consideredRefs,
    );

  if (new Set(occasions.map((reading) => reading.method)).size > 1) return insufficient(["MIXED_MEASUREMENT_METHODS"]);
  if (coverage === "NONE") return insufficient(["BELOW_SIGNAL_MINIMUM"]);

  // Robust summaries (exact).
  const values = (set: EligibleReading[]) => set.map((reading) => reading.value);
  const referenceMedian = median(values(reference));
  const recentMedian = median(values(recent));
  const referenceHinges = tukeyHinges(values(reference));
  const recentHinges = tukeyHinges(values(recent));
  const medianDifference = rationalSubtract(recentMedian, referenceMedian);
  const dispersionDifference = rationalSubtract(recentHinges.iqr, referenceHinges.iqr);
  const overlap = intervalOverlapRatio([referenceHinges.q1, referenceHinges.q3], [recentHinges.q1, recentHinges.q3]);

  // Typical value: magnitude, overlap and split-half agreement in each segment.
  const direction = rationalSign(medianDifference);
  const magnitudeMet =
    compareRational(rationalAbs(medianDifference), decimal(CONFIG.materialMedianDifferenceMmolL)) >= 0 &&
    compareRational(overlap, decimal(CONFIG.maximumMaterialOverlapRatio)) <= 0;
  const [recentA, recentB] = halves(recent);
  const [referenceA, referenceB] = halves(reference);
  const halvesAgree =
    direction !== 0 &&
    [recentA, recentB].every((half) => half.length > 0 && rationalSign(rationalSubtract(median(values(half)), referenceMedian)) === direction) &&
    [referenceA, referenceB].every((half) => half.length > 0 && rationalSign(rationalSubtract(recentMedian, median(values(half)))) === direction);
  const typicalMaterial = magnitudeMet && halvesAgree;

  // Variability: absolute IQR difference and IQR ratio.
  const dispersionMagnitude = compareRational(rationalAbs(dispersionDifference), decimal(CONFIG.materialDispersionDifferenceMmolL)) >= 0;
  let ratioMet: boolean;
  if (rationalSign(referenceHinges.iqr) === 0) {
    ratioMet = rationalSign(recentHinges.iqr) > 0;
  } else {
    const ratio = rationalDivide(recentHinges.iqr, referenceHinges.iqr);
    ratioMet =
      compareRational(ratio, decimal(CONFIG.materialDispersionRatioHigh)) >= 0 ||
      compareRational(ratio, decimal(CONFIG.materialDispersionRatioLow)) <= 0;
  }
  const variabilityMaterial = dispersionMagnitude && ratioMet && rationalSign(dispersionDifference) !== 0;

  if (!typicalMaterial && !variabilityMaterial) {
    return envelope(
      input.previous
        ? downgradePrevious(FAMILY, candidateKey, input.previous, staleNow)
        : { kind: "NO_MATERIAL_DIFFERENCE", family: FAMILY, candidateKey, coverage, counts },
      consideredRefs,
    );
  }

  const claim: PatternClaim = {
    family: FAMILY,
    slot: { kind: "PATIENT_SELECTED_SLOT", slot },
    observedChange: {
      typicalValue: typicalMaterial ? (direction > 0 ? "HIGHER" : "LOWER") : "NO_MATERIAL_DIRECTION",
      variability: variabilityMaterial
        ? rationalSign(dispersionDifference) > 0
          ? "MORE_VARIABLE"
          : "LESS_VARIABLE"
        : "NO_MATERIAL_CHANGE",
    },
  } as PatternClaim;

  // Variability-only support needs a successive evaluation with new readings.
  let stability: { outcome: PatternGateOutcome; code: string };
  if (typicalMaterial) {
    stability = { outcome: "PASS", code: "STABILITY_NOT_REQUIRED_FOR_DIRECTION" };
  } else {
    const previousClaim = input.previous?.observation.payload.claim;
    const sameVariability =
      previousClaim?.family === FAMILY &&
      claim.family === FAMILY &&
      previousClaim.observedChange.variability === claim.observedChange.variability;
    const previousRecent = new Set<string>(
      input.previous?.snapshot.payload.evidenceGroups.find((group) => group.role === "RECENT")?.revisions.map((ref) => ref.revisionId) ?? [],
    );
    const hasNewReading = recent.some((reading) => !previousRecent.has(reading.revisionId));
    stability =
      sameVariability && hasNewReading
        ? { outcome: "PASS", code: "VARIABILITY_CONFIRMED_ON_SUCCESSIVE_EVALUATION" }
        : { outcome: "INDETERMINATE", code: "VARIABILITY_AWAITING_SUCCESSIVE_EVALUATION" };
  }

  const supportMet = counts.reference >= minima.SUPPORTED.reference && counts.recent >= minima.SUPPORTED.recent;
  const dimensions: { dimension: PatternGateDimension; outcome: PatternGateOutcome; reasonCodes: string[] }[] = [
    {
      dimension: "SUPPORT",
      outcome: supportMet ? "PASS" : "INDETERMINATE",
      reasonCodes: [supportMet ? "SUPPORT_MINIMUM_MET" : "SUPPORT_BELOW_SUPPORTED_MINIMUM"],
    },
    {
      dimension: "COVERAGE",
      outcome: supportedCoverage ? "PASS" : "INDETERMINATE",
      reasonCodes: [supportedCoverage ? "COVERAGE_DATES_AND_WEEKS_MET" : "COVERAGE_BELOW_SUPPORTED_DATES_OR_WEEKS"],
    },
    { dimension: "COMPARISON", outcome: "PASS", reasonCodes: ["SAME_SLOT_AND_METHOD"] },
    { dimension: "MISSINGNESS", outcome: "PASS", reasonCodes: ["MISSING_READINGS_REMAIN_UNKNOWN"] },
    { dimension: "RECENCY", outcome: "PASS", reasonCodes: ["RECENT_SEGMENT_HAS_READINGS"] },
    {
      dimension: "CONSISTENCY",
      outcome: typicalMaterial ? "PASS" : magnitudeMet ? "INDETERMINATE" : "PASS",
      reasonCodes: [typicalMaterial ? "SPLIT_HALVES_AGREE" : magnitudeMet ? "SPLIT_HALVES_DISAGREE" : "SPLIT_HALVES_NOT_ASSESSED"],
    },
    { dimension: "CONTRADICTION", outcome: "NOT_APPLICABLE", reasonCodes: ["CONTRADICTION_ASSESSED_BY_SPLIT_HALVES"] },
    { dimension: "CONTEXT", outcome: "PASS", reasonCodes: ["NO_RECORDED_CONTEXT_OR_CARE_BOUNDARY"] },
    { dimension: "STABILITY", outcome: stability.outcome, reasonCodes: [stability.code] },
    {
      dimension: "MAGNITUDE_OR_USEFULNESS",
      outcome: "PASS",
      reasonCodes: [
        ...(typicalMaterial ? ["MEDIAN_DIFFERENCE_MATERIAL"] : []),
        ...(variabilityMaterial ? ["VARIABILITY_DIFFERENCE_MATERIAL"] : []),
      ],
    },
    { dimension: "PRIOR_PATIENT_DISPOSITION", outcome: "PASS", reasonCodes: ["NO_PRIOR_PATIENT_DISPOSITION"] },
  ];
  const overall = aggregatePatternGate(GATE_VERSION, dimensions);
  const lifecycle: PatternLifecycle =
    overall === "SUPPORTED"
      ? { state: "SUPPORTED" }
      : coverage === "SUPPORTED"
        ? { state: "WATCHING" }
        : coverage === "EMERGING"
          ? { state: "EMERGING" }
          : { state: "SIGNAL" };

  const limitations: PatternLimitationCode[] = ["UNKNOWN_NEGATIVE_STATUS"];
  if (coverage !== "SUPPORTED") limitations.unshift("SPARSE_RECORDING");

  const firstDate = localDateOf(occasions[0]!.instant, occasions[0]!.offset);
  const lastDate = localDateOf(occasions.at(-1)!.instant, occasions.at(-1)!.offset);
  const spanDays = Math.round((Date.parse(lastDate) - Date.parse(firstDate)) / 86_400_000) + 1;
  const summary = (set: EligibleReading[], medianValue: Rational, hinges: ReturnType<typeof tukeyHinges>) => ({
    kind: "GLUCOSE_DISTRIBUTION" as const,
    canonicalUnit: "MMOL_L" as const,
    median: canonicalDecimal(medianValue),
    lowerTypicalBound: canonicalDecimal(hinges.q1),
    upperTypicalBound: canonicalDecimal(hinges.q3),
    distinctOccasionCount: set.length,
    distinctDayCount: dates(set),
    dispersion: { metric: "IQR" as const, valueMmolL: canonicalDecimal(hinges.iqr) },
  });

  const snapshotPayload = {
    family: FAMILY,
    evaluatedAt: T,
    observationWindow: { start: referenceStart, end: T },
    ruleVersions: DISPOSITION.ruleVersions,
    evidenceGroups: [
      { role: "BASELINE", revisions: reference.map((reading) => reading.source.ref) },
      { role: "RECENT", revisions: recent.map((reading) => reading.source.ref) },
    ],
    consideredButExcluded: exclusions,
    coverage: {
      kind: "OBSERVATION_SPAN",
      distinctOccasionCount: occasions.length,
      distinctDayCount: counts.referenceDates + counts.recentDates,
      spanDays,
      outcome: coverage === "SUPPORTED" ? "ADEQUATE" : "LIMITED",
    },
    gate: { dimensions, overall },
    facts: {
      family: FAMILY,
      slot: { kind: "PATIENT_SELECTED_SLOT", slot },
      reference: {
        window: { start: referenceStart, end: recentStart },
        assignments: reference.map(assignment),
        summary: summary(reference, referenceMedian, referenceHinges),
      },
      recent: {
        window: { start: recentStart, end: T },
        assignments: recent.map(assignment),
        summary: summary(recent, recentMedian, recentHinges),
      },
      difference: {
        medianDifferenceMmolL: canonicalDecimal(medianDifference),
        dispersionDifferenceMmolL: canonicalDecimal(dispersionDifference),
        overlapRatio: formatRatio6(overlap),
      },
      measurementMethodComparison: { kind: "SAME_METHOD", method: occasions[0]!.method },
    },
    limitations,
  } as unknown as PatternEvidenceSnapshotPayload;

  const sourceRoles: PatternSourceRole[] = [
    ...reference.map((reading) => ({ ref: reading.source.ref, role: "BASELINE_EVIDENCE" as const })),
    ...recent.map((reading) => ({ ref: reading.source.ref, role: "RECENT_EVIDENCE" as const })),
    ...exclusions.map((entry) => ({ ref: entry.revision, role: "CONSIDERED_EXCLUDED" as const })),
  ];

  return envelope(
    finaliseProposal(
      {
        kind: "PROPOSAL",
        family: FAMILY,
        candidateKey,
        claim,
        lifecycle,
        snapshot: { kind: "NEW", payload: snapshotPayload },
        reasonCode: "PATTERN_OBSERVATION_CREATED",
        sourceRoles,
        limitationCodes: limitations,
      },
      input.previous,
    ),
    consideredRefs,
  );
}
