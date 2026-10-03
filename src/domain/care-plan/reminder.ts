import { z } from "zod";
import { createRecordRevisionSchema, type RecordRevision } from "../shared/revision";
import { provenanceCoreSchema, type ProvenanceCore } from "../shared/provenance";
import { timePointSchema } from "../shared/temporal";
import { DeletionPolicy } from "../shared/record-catalogue";
import { createTypedRevisionRefSchema } from "../shared/typed-revision-ref";
import { createBoundedTextSchema } from "../shared/text";
import { patientAuthoredNoteSchema } from "../health-records/patient-authored-note";
import { dayOfWeekSchema, ianaTimeZoneIdSchema, versionIdentifierSchema } from "../learning/learning-primitives";
import { atemporalSchema, type AtemporalMeaning } from "../learning/learned-knowledge";
import { localClockTimeSchema } from "./prescription-schedule";

/**
 * `REMINDER` record contract (domain Sections 7.12–7.14).
 *
 * A reminder is a patient-controlled organisational cue. Its delivery,
 * opening, snoozing or dismissal never proves that an action happened, and a
 * medication reminder never selects, calculates or invents a dose or time.
 */

export const REMINDER_DELETION_POLICY = DeletionPolicy.PATIENT_DELETABLE;

/** Mistakes correct; intentional lifecycle or schedule changes supersede; source changes are system-derived. */
export const REMINDER_REVISION_ACTIONS = Object.freeze(["CREATE", "CORRECT", "SUPERSEDE", "SYSTEM_DERIVE"] as const);

export const REMINDER_STATES = Object.freeze(["ACTIVE", "PAUSED", "REVIEW_REQUIRED", "ENDED"] as const);

export type ReminderState = (typeof REMINDER_STATES)[number];

export const REMINDER_DELIVERY_PREFERENCES = Object.freeze(["IN_APP_ONLY", "SYSTEM_NOTIFICATION_WHEN_AVAILABLE"] as const);

export const reminderLabelSchema = z.strictObject({
  text: createBoundedTextSchema(1, 120),
  language: z.enum(["en-SG", "zh-SG", "und"]),
});

export const reminderSubjectSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("MEDICATION"), target: createTypedRevisionRefSchema(z.literal("PRESCRIPTION_VERSION")) }),
  z.strictObject({ kind: z.literal("APPOINTMENT"), target: createTypedRevisionRefSchema(z.literal("APPOINTMENT")) }),
  z.strictObject({ kind: z.literal("PREVENTIVE_CARE"), target: createTypedRevisionRefSchema(z.literal("PREVENTIVE_CARE_ITEM")) }),
  z.strictObject({ kind: z.literal("CARE_QUESTION"), target: createTypedRevisionRefSchema(z.literal("CARE_QUESTION")) }),
  z.strictObject({
    kind: z.literal("MEASUREMENT"),
    measurementKind: z.enum(["GLUCOSE", "KETONE", "BODY_MEASUREMENT"]),
    relatedCondition: createTypedRevisionRefSchema(z.literal("CONDITION")).optional(),
  }),
  z.strictObject({ kind: z.literal("CUSTOM") }),
]);

export type ReminderSubject = z.infer<typeof reminderSubjectSchema>;

const uniqueNonEmpty = <T extends z.ZodTypeAny>(item: T, message: string) =>
  z
    .array(item)
    .min(1)
    .refine((values) => new Set(values as unknown[]).size === values.length, message);

export const reminderScheduleSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("ONE_TIME"),
    at: timePointSchema.refine((point) => point.kind === "EXACT", "ONE_TIME_REQUIRES_EXACT_INSTANT"),
  }),
  z.strictObject({
    kind: z.literal("WEEKLY_LOCAL"),
    daysOfWeek: uniqueNonEmpty(dayOfWeekSchema, "DUPLICATE_DAY_OF_WEEK"),
    times: uniqueNonEmpty(localClockTimeSchema, "DUPLICATE_LOCAL_TIME"),
    timeZoneId: ianaTimeZoneIdSchema,
  }),
  z.strictObject({
    kind: z.literal("RELATIVE_TO_APPOINTMENT"),
    appointment: createTypedRevisionRefSchema(z.literal("APPOINTMENT")),
    minutesBefore: z.number().int().nonnegative().safe(),
    derivationRuleVersion: versionIdentifierSchema,
  }),
]);

export type ReminderSchedule = z.infer<typeof reminderScheduleSchema>;

export const reminderPayloadSchema = z.strictObject({
  label: reminderLabelSchema,
  subject: reminderSubjectSchema,
  schedule: reminderScheduleSchema,
  state: z.enum(REMINDER_STATES),
  deliveryPreference: z.enum(REMINDER_DELIVERY_PREFERENCES),
  patientNote: patientAuthoredNoteSchema.optional(),
});

export type ReminderPayload = z.infer<typeof reminderPayloadSchema>;

export type ReminderRevision = RecordRevision<"REMINDER", ReminderPayload, AtemporalMeaning, ProvenanceCore>;

export const reminderRevisionSchema = createRecordRevisionSchema(
  z.literal("REMINDER"),
  reminderPayloadSchema,
  atemporalSchema,
  provenanceCoreSchema,
).superRefine((revision, ctx) => {
  const issue = (message: string, path: string[]) => ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
  if (!(REMINDER_REVISION_ACTIONS as readonly string[]).includes(revision.action)) issue("UNSUPPORTED_REVISION_ACTION", ["action"]);
  if (revision.action === "SYSTEM_DERIVE") {
    // The system may only suspend a reminder for review; it cannot activate,
    // reschedule or end one on the patient's behalf.
    if (revision.payload.state !== "REVIEW_REQUIRED") issue("SYSTEM_MAY_ONLY_REQUIRE_REVIEW", ["payload", "state"]);
    if (revision.provenance.initiator !== "JAGAON_SYSTEM") issue("SYSTEM_DERIVE_REQUIRES_SYSTEM_INITIATOR", ["provenance"]);
  } else if (revision.provenance.initiator !== "PATIENT") {
    // Creation, activation and material changes require patient confirmation.
    issue("REMINDER_CHANGE_REQUIRES_PATIENT", ["provenance"]);
  }
  if (revision.action === "CREATE" && revision.payload.state === "REVIEW_REQUIRED") {
    issue("NEW_REMINDER_CANNOT_START_IN_REVIEW", ["payload", "state"]);
  }
  if (revision.provenance.assistance !== "NONE") issue("AI_ASSISTANCE_NOT_PERMITTED", ["provenance"]);
}) as unknown as z.ZodType<ReminderRevision, z.ZodTypeDef, unknown>;
