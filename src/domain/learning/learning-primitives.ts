import { z } from "zod";
import { isValidIanaTimeZoneId } from "../shared/time";
import { recordTypeSchema } from "../shared/record-catalogue";
import { recordIdSchema, revisionIdSchema } from "../shared/identifiers";
import { localClockTimeSchema } from "../care-plan/prescription-schedule";
import type { TypedRevisionRef } from "../shared/typed-revision-ref";
import type { RecordType } from "../shared/record-catalogue";

// --- Shared Packet 7A intelligence primitives (domain Sections 8.4–8.16) ---

type Brand<T, B extends string> = T & { readonly __brand: B };

export const DAYS_OF_WEEK = Object.freeze([
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
] as const);

export type DayOfWeek = (typeof DAYS_OF_WEEK)[number];

export const dayOfWeekSchema = z.enum(DAYS_OF_WEEK);

/** A non-empty, duplicate-free day set. It never claims every listed day occurs. */
export const uniqueDaySetSchema = z
  .array(dayOfWeekSchema)
  .min(1)
  .refine((days) => new Set(days).size === days.length, "DUPLICATE_DAY_OF_WEEK");

/**
 * Opaque patient-local identity. It is a stable local key, never a catalogue
 * identifier or display text, so it accepts only a bounded token alphabet.
 */
export function createOpaqueKeySchema<B extends string>() {
  return z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9._:-]+$/, "OPAQUE_KEY_FORMAT")
    .transform((value) => value as Brand<string, B>);
}

/** A valid IANA timezone identifier (never null in a learned or pattern window). */
export const ianaTimeZoneIdSchema = z
  .string()
  .min(1)
  .refine((value) => isValidIanaTimeZoneId(value), "INVALID_TIME_ZONE");

/**
 * Local time window. `crossesMidnight` must agree with the ordering of the two
 * different times, for example 23:00–01:00 crosses midnight and 07:15–07:45
 * does not.
 */
export const localTimeWindowFields = {
  start: localClockTimeSchema,
  end: localClockTimeSchema,
  crossesMidnight: z.boolean(),
  timeZoneId: ianaTimeZoneIdSchema,
};

export function localTimeWindowIssue(window: {
  start: string;
  end: string;
  crossesMidnight: boolean;
}): string | null {
  if (window.start === window.end) return "LOCAL_TIME_WINDOW_REQUIRES_DIFFERENT_TIMES";
  if (window.crossesMidnight !== window.start > window.end) {
    return "CROSSES_MIDNIGHT_DISAGREES_WITH_ORDER";
  }
  return null;
}

/** Exact reference to a revision of any approved record type. */
export const anyTypedRevisionRefSchema = z.strictObject({
  recordType: recordTypeSchema,
  recordId: recordIdSchema,
  revisionId: revisionIdSchema,
});

export function revisionRefKey(ref: TypedRevisionRef<RecordType>): string {
  return `${ref.recordType}|${ref.recordId}|${ref.revisionId}`;
}

export function hasDuplicateRefs(refs: readonly TypedRevisionRef<RecordType>[]): boolean {
  return new Set(refs.map(revisionRefKey)).size !== refs.length;
}

/** Non-empty, duplicate-free list of exact references created by `itemSchema`. */
export function uniqueRefTupleSchema<T extends z.ZodTypeAny>(itemSchema: T) {
  return z
    .array(itemSchema)
    .min(1)
    .refine(
      (refs) => !hasDuplicateRefs(refs as TypedRevisionRef<RecordType>[]),
      "DUPLICATE_REVISION_REFERENCE",
    );
}

/** Possibly empty, duplicate-free list of exact references. */
export function uniqueRefListSchema<T extends z.ZodTypeAny>(itemSchema: T) {
  return z
    .array(itemSchema)
    .refine(
      (refs) => !hasDuplicateRefs(refs as TypedRevisionRef<RecordType>[]),
      "DUPLICATE_REVISION_REFERENCE",
    );
}

/** Non-empty opaque version identifier for rules, policies and evaluators. */
export const versionIdentifierSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[A-Za-z0-9._-]+$/, "VERSION_IDENTIFIER_FORMAT");
