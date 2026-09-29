import { z } from "zod";
import { instantSchema, localDateSchema, isValidIanaTimeZoneId } from "./time";
import { instantBefore, type Instant } from "./time";

// Shared schema for the optional IANA timezone identifier. null is always
// valid (timezone may be unknown); a non-null value must be a recognised
// IANA timezone identifier.
const timeZoneIdSchema = z
  .string()
  .nullable()
  .refine(
    (val) => val === null || isValidIanaTimeZoneId(val),
    "Must be a valid IANA timezone identifier or null",
  );

// --- TimePoint (Section 1.7) ---

export const timePointSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("EXACT"),
    instantUtc: instantSchema,
    timeZoneId: timeZoneIdSchema,
    utcOffsetMinutes: z.number().int(),
  }),
  z.strictObject({
    kind: z.literal("APPROXIMATE"),
    approximateInstantUtc: instantSchema,
    uncertaintyMinutes: z.number().int().positive(),
    timeZoneId: timeZoneIdSchema,
    utcOffsetMinutes: z.number().int(),
  }),
  z.strictObject({
    kind: z.literal("DATE_ONLY"),
    localDate: localDateSchema,
    timeZoneId: timeZoneIdSchema,
  }),
  z.strictObject({
    kind: z.literal("UNKNOWN"),
  }),
]);

export type TimePoint = z.infer<typeof timePointSchema>;

// --- IntervalEnd (Section 1.7) ---

export const intervalEndSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("KNOWN"),
    point: timePointSchema,
  }),
  z.strictObject({ kind: z.literal("OPEN") }),
  z.strictObject({ kind: z.literal("ENDED_TIME_UNKNOWN") }),
  z.strictObject({ kind: z.literal("UNKNOWN") }),
]);

export type IntervalEnd = z.infer<typeof intervalEndSchema>;

// --- TemporalMeaning (Section 1.7) ---

export const temporalMeaningSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("POINT"),
      occurrence: timePointSchema,
    }),
    z.strictObject({
      kind: z.literal("INTERVAL"),
      start: timePointSchema,
      end: intervalEndSchema,
    }),
    z.strictObject({ kind: z.literal("ATEMPORAL") }),
  ])
  .superRefine((val, ctx) => {
    if (val.kind !== "INTERVAL") return;
    // Half-open [start, end) semantics: known end must be later than known start.
    const startInstant = resolveInstant(val.start);
    const endInstant =
      val.end.kind === "KNOWN" ? resolveInstant(val.end.point) : null;
    if (startInstant !== null && endInstant !== null) {
      if (!instantBefore(startInstant, endInstant)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "INVALID_TEMPORAL_RANGE: known end must be later than start",
        });
      }
    }
  });

export type TemporalMeaning = z.infer<typeof temporalMeaningSchema>;

// Helper: extract a comparable instant from a TimePoint, if available.
function resolveInstant(tp: TimePoint): Instant | null {
  switch (tp.kind) {
    case "EXACT":
      return tp.instantUtc;
    case "APPROXIMATE":
      return tp.approximateInstantUtc;
    case "DATE_ONLY":
    case "UNKNOWN":
      return null;
  }
}