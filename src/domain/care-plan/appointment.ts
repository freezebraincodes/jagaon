import { z } from "zod";
import { createRecordRevisionSchema, type RecordRevision } from "../shared/revision";
import { provenanceCoreSchema, type ProvenanceCore } from "../shared/provenance";
import { temporalMeaningSchema, type TimePoint } from "../shared/temporal";
import { DeletionPolicy } from "../shared/record-catalogue";
import { createTypedRevisionRefSchema } from "../shared/typed-revision-ref";
import { createBoundedTextSchema } from "../shared/text";
import { patientAuthoredNoteSchema } from "../health-records/patient-authored-note";
import { uniqueRefTupleSchema, versionIdentifierSchema } from "../learning/learning-primitives";

/**
 * `APPOINTMENT` record contract (domain Sections 7.5–7.8).
 *
 * A patient-recorded appointment with at least a known date. A passed time
 * stays unknown until the patient updates it; JagaOn never marks it missed,
 * attended, confirmed or cancelled on anyone's behalf.
 */

export const APPOINTMENT_DELETION_POLICY = DeletionPolicy.PATIENT_DELETABLE;

/** Typos correct; reschedule, cancellation and reported outcome supersede. */
export const APPOINTMENT_REVISION_ACTIONS = Object.freeze(["CREATE", "CORRECT", "SUPERSEDE"] as const);

export const APPOINTMENT_SERVICE_GROUPS = Object.freeze([
  "PRIMARY_CARE",
  "CONDITION_REVIEW",
  "EYE_CARE",
  "FOOT_CARE",
  "DENTAL_CARE",
  "LAB_OR_SCREENING",
  "PHARMACY",
  "OTHER",
] as const);

export type AppointmentServiceGroup = (typeof APPOINTMENT_SERVICE_GROUPS)[number];

/** Reviewed local service catalogue; labels reuse the approved bilingual matrix labels. */
export const APPOINTMENT_SERVICE_CATALOGUE = Object.freeze({
  version: "appointment-service-catalogue.1",
  entries: Object.freeze([
    Object.freeze({ key: "EYE_SCREENING", serviceGroup: "EYE_CARE" as const, labels: Object.freeze({ "en-SG": "Eye screening", "zh-SG": "眼睛检查" }), status: "ACTIVE" as const }),
    Object.freeze({ key: "BLOOD_TEST", serviceGroup: "LAB_OR_SCREENING" as const, labels: Object.freeze({ "en-SG": "Blood test", "zh-SG": "血液检验" }), status: "ACTIVE" as const }),
    Object.freeze({ key: "FOOT_CHECK", serviceGroup: "FOOT_CARE" as const, labels: Object.freeze({ "en-SG": "Foot check", "zh-SG": "足部检查" }), status: "ACTIVE" as const }),
  ]),
});

const labelSchema = createBoundedTextSchema(1, 120);

export const appointmentServiceIdentitySchema = z.union([
  z
    .strictObject({
      kind: z.literal("REVIEWED_CATALOGUE_MATCH"),
      catalogueEntryKey: z.string().min(1).max(64),
      catalogueVersion: versionIdentifierSchema,
      serviceGroup: z.enum(APPOINTMENT_SERVICE_GROUPS),
      label: labelSchema,
    })
    .superRefine((identity, ctx) => {
      // Retired entries stay resolvable for history; only the version must match.
      const entry =
        identity.catalogueVersion === APPOINTMENT_SERVICE_CATALOGUE.version
          ? APPOINTMENT_SERVICE_CATALOGUE.entries.find((candidate) => candidate.key === identity.catalogueEntryKey)
          : undefined;
      if (!entry) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "UNKNOWN_CATALOGUE_ENTRY" });
      else if (entry.serviceGroup !== identity.serviceGroup) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "SERVICE_GROUP_DISAGREES_WITH_CATALOGUE" });
      else if (!(Object.values(entry.labels) as string[]).includes(identity.label)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "LABEL_NOT_REVIEWED_FOR_ENTRY" });
    }),
  z.strictObject({ kind: z.literal("PATIENT_DEFINED"), serviceGroup: z.enum(APPOINTMENT_SERVICE_GROUPS), label: labelSchema }),
  z.strictObject({ kind: z.literal("UNKNOWN") }),
]);

export type AppointmentServiceIdentity = z.infer<typeof appointmentServiceIdentitySchema>;

export const APPOINTMENT_STATUSES = Object.freeze(["SCHEDULED", "PATIENT_REPORTED_ATTENDED", "PATIENT_REPORTED_MISSED", "CANCELLED", "UNSURE"] as const);

export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

export const appointmentPayloadSchema = z.strictObject({
  appointmentLabel: labelSchema,
  service: appointmentServiceIdentitySchema,
  mode: z.enum(["IN_PERSON", "PHONE", "VIDEO", "OTHER", "UNKNOWN"]),
  status: z.enum(APPOINTMENT_STATUSES),
  relatedConditions: uniqueRefTupleSchema(createTypedRevisionRefSchema(z.literal("CONDITION"))).optional(),
  relatedPreventiveCareItems: uniqueRefTupleSchema(createTypedRevisionRefSchema(z.literal("PREVENTIVE_CARE_ITEM"))).optional(),
  careContactLabel: labelSchema.optional(),
  locationLabel: labelSchema.optional(),
  patientNote: patientAuthoredNoteSchema.optional(),
});

export type AppointmentPayload = z.infer<typeof appointmentPayloadSchema>;

const appointmentTemporalSchema = temporalMeaningSchema.refine((value) => value.kind === "POINT", "APPOINTMENT_TEMPORAL_IS_POINT");

export type AppointmentTemporal = { kind: "POINT"; occurrence: TimePoint };

export type AppointmentRevision = RecordRevision<"APPOINTMENT", AppointmentPayload, AppointmentTemporal, ProvenanceCore>;

export const appointmentRevisionSchema = createRecordRevisionSchema(
  z.literal("APPOINTMENT"),
  appointmentPayloadSchema,
  appointmentTemporalSchema,
  provenanceCoreSchema,
).superRefine((revision, ctx) => {
  const issue = (message: string, path: string[]) => ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
  if (!(APPOINTMENT_REVISION_ACTIONS as readonly string[]).includes(revision.action)) issue("UNSUPPORTED_REVISION_ACTION", ["action"]);
  const temporal = revision.temporal as AppointmentTemporal;
  // A need to arrange care without a known date is not an appointment.
  if (temporal.kind === "POINT" && temporal.occurrence.kind === "UNKNOWN") issue("APPOINTMENT_REQUIRES_SCHEDULED_DATE", ["temporal"]);
  if (revision.provenance.initiator !== "PATIENT") issue("APPOINTMENT_CHANGE_REQUIRES_PATIENT", ["provenance"]);
  if (revision.provenance.assistance !== "NONE") issue("AI_ASSISTANCE_NOT_PERMITTED", ["provenance"]);
}) as unknown as z.ZodType<AppointmentRevision, z.ZodTypeDef, unknown>;

export const appointmentRefSchema = createTypedRevisionRefSchema(z.literal("APPOINTMENT"));
