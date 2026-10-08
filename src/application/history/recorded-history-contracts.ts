import { z } from "zod";
import { localDateSchema } from "@/domain/shared/time";
import { decimalStringSchema } from "@/domain/health-records/measurement";
import { patternFamilySchema, type PatternFamily } from "@/domain/patterns";
import {
  glucoseReadingRefSchema,
  patternEvidenceSnapshotRefSchema,
  patternObservationRefSchema,
} from "@/domain/patterns/pattern-comparable";

/**
 * Packet 7A Recorded-history view model (design Sections 5.3 and 8; copy
 * matrix 07a). The port returns only validated descriptive data: counts,
 * recorded ranges, explicit display positions, booklet completion, provenance,
 * supported comparisons and repeated recorded labels. It never carries a
 * clinical label, cause, target or prediction. LOADING is UI-only.
 */

export const HISTORY_PERIODS = Object.freeze(["THIS_WEEK", "LAST_WEEK", "THIRTY_DAYS"] as const);
export type HistoryPeriod = (typeof HISTORY_PERIODS)[number];

export const HISTORY_LABELLED_SLOTS = Object.freeze(["BEFORE_BREAKFAST", "BEFORE_LUNCH", "BEFORE_DINNER", "BEDTIME"] as const);
export type HistorySlot = (typeof HISTORY_LABELLED_SLOTS)[number];

export const HISTORY_DISPLAY_POSITIONS = Object.freeze(["MORNING", "EVENING"] as const);
export type HistoryDisplayPosition = (typeof HISTORY_DISPLAY_POSITIONS)[number];

const periodSchema = z.enum(HISTORY_PERIODS);
const slotSchema = z.enum(HISTORY_LABELLED_SLOTS);
const positionSchema = z.enum(HISTORY_DISPLAY_POSITIONS);
const dateRangeSchema = z
  .strictObject({ startDate: localDateSchema, endDate: localDateSchema })
  .refine((range) => range.startDate <= range.endDate, "RANGE_INVERTED");
const count = z.number().int().nonnegative().safe();
const factIdSchema = z.string().regex(/^[A-Z_]+(:[A-Za-z0-9._-]+)?$/);

const chartPositionSchema = z.discriminatedUnion("state", [
  z.strictObject({
    date: localDateSchema,
    position: positionSchema,
    state: z.literal("RECORDED"),
    valueMmolL: decimalStringSchema,
    readingCount: z.number().int().positive().safe(),
  }),
  // A missing position has no value: it is never drawn as zero.
  z.strictObject({ date: localDateSchema, position: positionSchema, state: z.literal("NOT_RECORDED") }),
]);

export type HistoryChartPosition = z.infer<typeof chartPositionSchema>;

const projectionSchema = z.strictObject({
  period: periodSchema,
  range: dateRangeSchema,
  unit: z.literal("MMOL_L"),
  readingCount: count,
  valueRange: z.strictObject({ minimum: decimalStringSchema, maximum: decimalStringSchema }).nullable(),
  slotCounts: z.array(z.strictObject({ slot: slotSchema, count: z.number().int().positive().safe() })),
  chart: z.array(chartPositionSchema),
  notRecordedPositions: z.array(z.strictObject({ date: localDateSchema, position: positionSchema })),
  stamps: z.array(
    z.strictObject({ date: localDateSchema, recordedPositions: z.number().int().min(0).max(2), complete: z.boolean() }),
  ),
  source: z.literal("PATIENT_ENTERED"),
  correctedRecordCount: count,
  repeated: z.array(
    z.strictObject({
      factId: factIdSchema,
      kind: z.enum(["ITEM", "CONTEXT"]),
      label: z.string().min(1).max(1000),
      count: z.number().int().positive().safe(),
      days: z.number().int().positive().safe(),
    }),
  ),
  selectableFactIds: z.array(factIdSchema).refine((ids) => new Set(ids).size === ids.length, "DUPLICATE_FACT_ID"),
});

export type HistoryProjection = z.infer<typeof projectionSchema>;

const comparisonSchema = z.strictObject({
  factId: factIdSchema,
  slot: slotSchema,
  kind: z.enum(["HIGHER", "LOWER", "VARIABILITY", "NO_MATERIAL"]),
  /** Recent median (or spread for VARIABILITY); absent for NO_MATERIAL. */
  recent: decimalStringSchema.nullable(),
  reference: decimalStringSchema.nullable(),
  recentWindow: dateRangeSchema,
  referenceWindow: dateRangeSchema,
  correctionUpdated: z.boolean(),
});

export type HistoryComparison = z.infer<typeof comparisonSchema>;

const unavailableFamiliesSchema = z.array(patternFamilySchema);

export const recordedHistoryViewSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("READY"),
    projection: projectionSchema,
    comparisons: z.array(comparisonSchema).min(1),
    unavailableFamilies: unavailableFamiliesSchema,
  }),
  z.strictObject({
    status: z.literal("INSUFFICIENT_EVIDENCE"),
    projection: projectionSchema,
    comparisons: z.array(comparisonSchema).length(0),
    unavailableFamilies: unavailableFamiliesSchema,
  }),
  z.strictObject({ status: z.literal("EMPTY"), period: periodSchema, range: dateRangeSchema, unavailableFamilies: unavailableFamiliesSchema }),
  z.strictObject({ status: z.literal("UNAVAILABLE"), code: z.enum(["STORAGE_UNAVAILABLE", "INTEGRITY_FAILURE"]) }),
]);

export type RecordedHistoryView = z.infer<typeof recordedHistoryViewSchema>;

/**
 * Packet 11C Addendum A1 source projection. Built only from a stored
 * SUPPORTED COMPARABLE_SLOT_TREND observation and its evidence snapshot,
 * reconciled against the current journal revisions. It carries both periods,
 * their exact counts, the role-labelled summary value (a median, or the
 * interquartile range for VARIABILITY; never a reading) and every supporting
 * reading, never truncated. It stays local: readings, dates and source links
 * never enter an AI request.
 */
export const EXPLAINABLE_PERIOD_ROLES = Object.freeze(["EARLIER", "RECENT"] as const);
export const EXPLAINABLE_SUMMARY_KINDS = Object.freeze(["MEDIAN", "IQR"] as const);
export const EXPLAINABLE_PATTERN_KINDS = Object.freeze(["HIGHER", "LOWER", "VARIABILITY"] as const);
export const EXPLAINABLE_INELIGIBLE_REASONS = Object.freeze([
  "NOT_FOUND",
  "NOT_SUPPORTED",
  "NO_MATERIAL",
  "FAMILY_UNAVAILABLE",
  "STALE_SOURCE",
  "COUNT_MISMATCH",
  "METHOD_MISMATCH",
  "MISSING_READING",
  "UNSUPPORTED_SUMMARY",
  "UNAVAILABLE",
] as const);

const supportingReadingSchema = z.strictObject({
  ref: glucoseReadingRefSchema,
  localDate: localDateSchema,
  localTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  enteredValue: decimalStringSchema,
  enteredUnit: z.enum(["MMOL_L", "MG_DL"]),
  method: z.string().min(1).max(64),
});

export type SupportingReading = z.infer<typeof supportingReadingSchema>;

const explainablePeriodSchema = z
  .strictObject({
    role: z.enum(EXPLAINABLE_PERIOD_ROLES),
    window: dateRangeSchema,
    count: z.number().int().positive().safe(),
    summary: z.strictObject({ kind: z.enum(EXPLAINABLE_SUMMARY_KINDS), valueMmolL: decimalStringSchema }),
    /** Every supporting reading, sorted by instant; no cap and no truncation. */
    readings: z.array(supportingReadingSchema).min(1),
  })
  .refine((period) => period.readings.length === period.count, "READING_COUNT_DISAGREES");

export type ExplainablePeriod = z.infer<typeof explainablePeriodSchema>;

export const explainablePatternViewSchema = z
  .strictObject({
    factId: factIdSchema,
    slot: slotSchema,
    kind: z.enum(EXPLAINABLE_PATTERN_KINDS),
    periods: z.tuple([explainablePeriodSchema, explainablePeriodSchema]),
    totalCount: z.number().int().positive().safe(),
    observationRef: patternObservationRefSchema,
    snapshotRef: patternEvidenceSnapshotRefSchema,
  })
  .superRefine((view, ctx) => {
    const [earlier, recent] = view.periods;
    const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    if (view.factId !== `COMPARISON:${view.slot}`) fail("FACT_ID_DISAGREES_WITH_SLOT");
    if (earlier.role !== "EARLIER" || recent.role !== "RECENT") fail("PERIOD_ORDER");
    if (earlier.window.endDate > recent.window.startDate) fail("PERIODS_OUT_OF_ORDER");
    if (view.totalCount !== earlier.count + recent.count) fail("TOTAL_DISAGREES");
    const summaryKind = view.kind === "VARIABILITY" ? "IQR" : "MEDIAN";
    if (earlier.summary.kind !== summaryKind || recent.summary.kind !== summaryKind) fail("SUMMARY_KIND_DISAGREES");
    const keys = [...earlier.readings, ...recent.readings].map((reading) => `${reading.ref.recordId}:${reading.ref.revisionId}`);
    if (new Set(keys).size !== keys.length) fail("DUPLICATE_READING");
  });

export type ExplainablePatternView = z.infer<typeof explainablePatternViewSchema>;

export const explainablePatternResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("EXPLAINABLE"), view: explainablePatternViewSchema }),
  z.strictObject({ kind: z.literal("INELIGIBLE"), reason: z.enum(EXPLAINABLE_INELIGIBLE_REASONS) }),
]);

export type ExplainablePatternResult = z.infer<typeof explainablePatternResultSchema>;

export type ExplainablePatternRequest = { factId: string };

export type RecordedHistoryRequest = {
  period: HistoryPeriod;
  /** Families the screen wants to describe; disabled ones come back as unavailable. */
  families?: readonly PatternFamily[];
};

/** The narrow port React depends on: no Dexie, evaluator or evidence internals. */
export type RecordedHistoryQueryPort = {
  load(request: RecordedHistoryRequest): Promise<RecordedHistoryView>;
  /** Packet 11C A1: the source projection of one READY comparison, or why it cannot be explained. */
  loadExplainablePattern(request: ExplainablePatternRequest): Promise<ExplainablePatternResult>;
};
