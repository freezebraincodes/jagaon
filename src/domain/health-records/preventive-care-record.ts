import { z } from "zod";
import { createRecordRevisionSchema, type RecordRevision } from "../shared/revision";
import { provenanceCoreSchema, type ProvenanceCore } from "../shared/provenance";
import { temporalMeaningSchema, type TimePoint } from "../shared/temporal";
import { DeletionPolicy } from "../shared/record-catalogue";
import { createTypedRevisionRefSchema } from "../shared/typed-revision-ref";
import { patientAuthoredNoteSchema } from "./patient-authored-note";
import { preventiveCareIdentitySchema } from "../care-plan/preventive-care";

/**
 * `PREVENTIVE_CARE_RECORD` contract (domain Section 7.3).
 *
 * What the patient reports actually happened. Absence of a record means only
 * that no completion was recorded. No clinical result, verification,
 * follow-up need or next interval is stored or inferred.
 */

export const PREVENTIVE_CARE_RECORD_DELETION_POLICY = DeletionPolicy.PATIENT_DELETABLE;

export const PREVENTIVE_CARE_RECORD_REVISION_ACTIONS = Object.freeze(["CREATE", "CORRECT"] as const);

export const preventiveCareRecordPayloadSchema = z.strictObject({
  careReference: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("PLANNED_ITEM"), item: createTypedRevisionRefSchema(z.literal("PREVENTIVE_CARE_ITEM")) }),
    z.strictObject({ kind: z.literal("UNPLANNED"), identity: preventiveCareIdentitySchema }),
  ]),
  completionReport: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("PATIENT_REPORTED_COMPLETED") }),
    z.strictObject({ kind: z.literal("PATIENT_UNSURE") }),
  ]),
  patientNote: patientAuthoredNoteSchema.optional(),
});

export type PreventiveCareRecordPayload = z.infer<typeof preventiveCareRecordPayloadSchema>;

const pointTemporalSchema = temporalMeaningSchema.refine((value) => value.kind === "POINT", "PREVENTIVE_RECORD_TEMPORAL_IS_POINT");

export type PreventiveCareRecordTemporal = { kind: "POINT"; occurrence: TimePoint };

export type PreventiveCareRecordRevision = RecordRevision<"PREVENTIVE_CARE_RECORD", PreventiveCareRecordPayload, PreventiveCareRecordTemporal, ProvenanceCore>;

export const preventiveCareRecordRevisionSchema = createRecordRevisionSchema(
  z.literal("PREVENTIVE_CARE_RECORD"),
  preventiveCareRecordPayloadSchema,
  pointTemporalSchema,
  provenanceCoreSchema,
).superRefine((revision, ctx) => {
  const issue = (message: string, path: string[]) => ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
  if (!(PREVENTIVE_CARE_RECORD_REVISION_ACTIONS as readonly string[]).includes(revision.action)) issue("UNSUPPORTED_REVISION_ACTION", ["action"]);
  // A reminder or appointment never creates an occurrence; only the patient reports one.
  if (revision.provenance.initiator !== "PATIENT") issue("PREVENTIVE_RECORD_REQUIRES_PATIENT", ["provenance"]);
  if (revision.provenance.assistance !== "NONE") issue("AI_ASSISTANCE_NOT_PERMITTED", ["provenance"]);
}) as unknown as z.ZodType<PreventiveCareRecordRevision, z.ZodTypeDef, unknown>;
