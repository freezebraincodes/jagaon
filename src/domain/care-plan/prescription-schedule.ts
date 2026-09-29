import { z } from "zod";
import { createBoundedTextSchema } from "../shared/text";

// --- Section 6.5: LocalClockTime (branded string) ---

// Uses the project's established structural-brand transform so the runtime
// schema and the exported LocalClockTime type agree.
type Brand<T, B extends string> = T & { readonly __brand: B };

export type LocalClockTime = Brand<string, "LocalClockTime">;

// Validates exact zero-padded HH:mm from 00:00 through 23:59.
const localClockTimeRegex = /^([01]\d|2[0-3]):[0-5]\d$/;

export const localClockTimeSchema = z
  .string()
  .regex(localClockTimeRegex, "Must be HH:mm from 00:00 through 23:59")
  .transform((val) => val as LocalClockTime);

// --- Section 6.5: PrescriptionTimingAllowance ---

// Safe-integer helper: signed integer within the safe-integer range.
const safeInt = z
  .number()
  .int()
  .min(Number.MIN_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER);

export type PrescriptionTimingAllowance = {
  minimumMinutesFromTarget: number;
  maximumMinutesFromTarget: number;
};

export const prescriptionTimingAllowanceSchema = z
  .strictObject({
    minimumMinutesFromTarget: safeInt,
    maximumMinutesFromTarget: safeInt,
  })
  .superRefine((val, ctx) => {
    if (val.minimumMinutesFromTarget > val.maximumMinutesFromTarget) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Timing allowance minimum cannot exceed maximum",
      });
    }
  });

// --- Section 6.5: FixedLocalTimeScheduleEntry ---

export type FixedLocalTimeScheduleEntry = {
  scheduleKey: string;
  time: LocalClockTime;
  explicitTimingAllowance?: PrescriptionTimingAllowance;
};

const fixedLocalTimeScheduleEntrySchema = z.strictObject({
  scheduleKey: createBoundedTextSchema(1, 1000),
  time: localClockTimeSchema,
  explicitTimingAllowance: prescriptionTimingAllowanceSchema.optional(),
});

// --- Section 6.5: EventRelativeMedicationTiming ---

const eventRelativeIntervalSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("UNSPECIFIED") }),
  z.strictObject({
    kind: z.literal("TARGET_MINUTES"),
    minutes: safeInt,
  }),
  z.strictObject({
    kind: z.literal("WINDOW_MINUTES"),
    minimumMinutes: safeInt,
    maximumMinutes: safeInt,
  }),
]);

export type EventRelativeMedicationTiming = {
  scheduleKey: string;
  relation: "BEFORE" | "WITH" | "AFTER";
  anchor: "BREAKFAST" | "LUNCH" | "DINNER" | "MEAL" | "BEDTIME" | "OTHER";
  interval:
    | { kind: "UNSPECIFIED" }
    | { kind: "TARGET_MINUTES"; minutes: number }
    | { kind: "WINDOW_MINUTES"; minimumMinutes: number; maximumMinutes: number };
  explicitTimingAllowance?: PrescriptionTimingAllowance;
};

export const eventRelativeMedicationTimingSchema = z
  .strictObject({
    scheduleKey: createBoundedTextSchema(1, 1000),
    relation: z.enum(["BEFORE", "WITH", "AFTER"]),
    anchor: z.enum(["BREAKFAST", "LUNCH", "DINNER", "MEAL", "BEDTIME", "OTHER"]),
    interval: eventRelativeIntervalSchema,
    explicitTimingAllowance: prescriptionTimingAllowanceSchema.optional(),
  })
  .superRefine((val, ctx) => {
    // Allowance is forbidden for UNSPECIFIED and WINDOW_MINUTES.
    if (
      val.explicitTimingAllowance !== undefined &&
      (val.interval.kind === "UNSPECIFIED" ||
        val.interval.kind === "WINDOW_MINUTES")
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["explicitTimingAllowance"],
        message:
          "Timing allowance is only for fixed local times and event-relative TARGET_MINUTES",
      });
    }
    // Non-negative for TARGET_MINUTES.
    if (val.interval.kind === "TARGET_MINUTES" && val.interval.minutes < 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["interval", "minutes"],
        message: "Event-relative target minutes must be non-negative",
      });
    }
    // Non-negative for WINDOW_MINUTES values.
    if (val.interval.kind === "WINDOW_MINUTES") {
      if (val.interval.minimumMinutes < 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["interval", "minimumMinutes"],
          message: "Window minimum minutes must be non-negative",
        });
      }
      if (val.interval.maximumMinutes < 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["interval", "maximumMinutes"],
          message: "Window maximum minutes must be non-negative",
        });
      }
      if (val.interval.minimumMinutes > val.interval.maximumMinutes) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["interval"],
          message: "Window minimum cannot exceed maximum",
        });
      }
    }
  });

// --- Section 6.5: PrescriptionSchedule ---

const frequencyPeriodSchema = z.enum(["DAY", "WEEK"]);

export type PrescriptionSchedule =
  | {
      kind: "FIXED_LOCAL_TIMES";
      entries: [
        FixedLocalTimeScheduleEntry,
        ...FixedLocalTimeScheduleEntry[],
      ];
    }
  | {
      kind: "EVENT_RELATIVE";
      timings: [
        EventRelativeMedicationTiming,
        ...EventRelativeMedicationTiming[],
      ];
    }
  | {
      kind: "FREQUENCY";
      occurrences: number;
      period: "DAY" | "WEEK";
    }
  | { kind: "AS_NEEDED" }
  | { kind: "CONTINUOUS" }
  | { kind: "UNSTRUCTURED" };

const safePositiveInt = safeInt.positive().max(Number.MAX_SAFE_INTEGER);

export const prescriptionScheduleSchema = z
  .discriminatedUnion("kind", [
    // FIXED_LOCAL_TIMES
    z.strictObject({
      kind: z.literal("FIXED_LOCAL_TIMES"),
      entries: z.tuple([fixedLocalTimeScheduleEntrySchema]).rest(
        fixedLocalTimeScheduleEntrySchema,
      ),
    }),

    // EVENT_RELATIVE
    z.strictObject({
      kind: z.literal("EVENT_RELATIVE"),
      timings: z.tuple([eventRelativeMedicationTimingSchema]).rest(
        eventRelativeMedicationTimingSchema,
      ),
    }),

    // FREQUENCY
    z.strictObject({
      kind: z.literal("FREQUENCY"),
      occurrences: safePositiveInt,
      period: frequencyPeriodSchema,
    }),

    // AS_NEEDED
    z.strictObject({ kind: z.literal("AS_NEEDED") }),

    // CONTINUOUS
    z.strictObject({ kind: z.literal("CONTINUOUS") }),

    // UNSTRUCTURED
    z.strictObject({ kind: z.literal("UNSTRUCTURED") }),
  ])
  .superRefine((val, ctx) => {
    if (val.kind === "FIXED_LOCAL_TIMES" || val.kind === "EVENT_RELATIVE") {
      const entries =
        val.kind === "FIXED_LOCAL_TIMES" ? val.entries : val.timings;
      const seen = new Set<string>();
      for (const entry of entries) {
        if (seen.has(entry.scheduleKey)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [val.kind === "FIXED_LOCAL_TIMES" ? "entries" : "timings"],
            message: "Duplicate scheduleKey within prescription version",
          });
        }
        seen.add(entry.scheduleKey);
      }
    }
  });