import { z } from "zod";
import { createRecordRevisionSchema, type RecordRevision } from "../shared/revision";
import { provenanceCoreSchema, type ProvenanceCore } from "../shared/provenance";
import { temporalMeaningSchema, type IntervalEnd, type TimePoint } from "../shared/temporal";
import { DeletionPolicy } from "../shared/record-catalogue";
import { patientAuthoredNoteSchema } from "./patient-authored-note";

/**
 * `CONTEXT_WINDOW` contract (domain Sections 7.15–7.17).
 *
 * A temporary circumstance the patient states or confirms during a period.
 * It never records a cause, diagnosis, recovery or treatment meaning, and an
 * unknown start or end is never replaced with the entry time.
 */

export const CONTEXT_WINDOW_DELETION_POLICY = DeletionPolicy.PATIENT_DELETABLE;

/** Mistakes correct; a genuine lifecycle change (such as ending) supersedes. */
export const CONTEXT_WINDOW_REVISION_ACTIONS = Object.freeze(["CREATE", "CORRECT", "SUPERSEDE"] as const);

export const contextWindowIdentitySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("STAYING_AWAY_FROM_HOME") }),
  z.strictObject({ kind: z.literal("TRAVEL") }),
  z.strictObject({ kind: z.literal("TEMPORARY_SCHEDULE_CHANGE") }),
  z.strictObject({ kind: z.literal("FESTIVE_OR_HOLIDAY_PERIOD") }),
  z.strictObject({ kind: z.literal("FEELING_UNWELL") }),
  z.strictObject({ kind: z.literal("APPETITE_CHANGE"), direction: z.enum(["LESS", "MORE", "DIFFERENT", "UNSPECIFIED"]) }),
  z.strictObject({ kind: z.literal("OTHER"), label: patientAuthoredNoteSchema }),
]);

export const CONTEXT_WINDOW_STATES = Object.freeze(["PLANNED", "PATIENT_REPORTED_ACTIVE", "PATIENT_REPORTED_ENDED", "PATIENT_UNSURE"] as const);

export const contextWindowPayloadSchema = z.strictObject({
  context: contextWindowIdentitySchema,
  state: z.enum(CONTEXT_WINDOW_STATES),
  patientDescription: patientAuthoredNoteSchema.optional(),
});

export type ContextWindowPayload = z.infer<typeof contextWindowPayloadSchema>;

const intervalTemporalSchema = temporalMeaningSchema.refine((value) => value.kind === "INTERVAL", "CONTEXT_WINDOW_TEMPORAL_IS_INTERVAL");

export type ContextWindowTemporal = { kind: "INTERVAL"; start: TimePoint; end: IntervalEnd };

export type ContextWindowRevision = RecordRevision<"CONTEXT_WINDOW", ContextWindowPayload, ContextWindowTemporal, ProvenanceCore>;

export const contextWindowRevisionSchema = createRecordRevisionSchema(
  z.literal("CONTEXT_WINDOW"),
  contextWindowPayloadSchema,
  intervalTemporalSchema,
  provenanceCoreSchema,
).superRefine((revision, ctx) => {
  const issue = (message: string, path: string[]) => ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
  if (!(CONTEXT_WINDOW_REVISION_ACTIONS as readonly string[]).includes(revision.action)) issue("UNSUPPORTED_REVISION_ACTION", ["action"]);
  const temporal = revision.temporal as ContextWindowTemporal;
  if (temporal.kind === "INTERVAL") {
    const state = revision.payload.state;
    if (state === "PATIENT_REPORTED_ACTIVE" && temporal.end.kind === "ENDED_TIME_UNKNOWN") issue("ACTIVE_CONTEXT_CANNOT_HAVE_ENDED_TIME_UNKNOWN", ["temporal"]);
    if (state === "PATIENT_REPORTED_ENDED" && temporal.end.kind !== "KNOWN" && temporal.end.kind !== "ENDED_TIME_UNKNOWN") {
      issue("ENDED_CONTEXT_REQUIRES_KNOWN_OR_ENDED_TIME_UNKNOWN", ["temporal"]);
    }
  }
  // The circumstance is the patient's statement; neither JagaOn nor AI may author it.
  if (revision.provenance.initiator !== "PATIENT") issue("CONTEXT_REQUIRES_PATIENT_AUTHORITY", ["provenance"]);
  if (revision.provenance.assistance !== "NONE") issue("AI_ASSISTANCE_NOT_PERMITTED", ["provenance"]);
}) as unknown as z.ZodType<ContextWindowRevision, z.ZodTypeDef, unknown>;
