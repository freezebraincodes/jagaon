import { z } from "zod";
import { createRecordRevisionSchema, type RecordRevision } from "../shared/revision";
import { provenanceCoreSchema, type ProvenanceCore } from "../shared/provenance";
import { localDateSchema } from "../shared/time";
import { DeletionPolicy } from "../shared/record-catalogue";
import { createTypedRevisionRefSchema } from "../shared/typed-revision-ref";
import { createBoundedTextSchema } from "../shared/text";
import { patientAuthoredNoteSchema } from "../health-records/patient-authored-note";
import { versionIdentifierSchema } from "../learning/learning-primitives";
import { atemporalSchema, type AtemporalMeaning } from "../learning/learned-knowledge";

/**
 * `PREVENTIVE_CARE_ITEM` record contract (domain Sections 7.1–7.4).
 *
 * An item is what the patient wants JagaOn to organise. It never carries an
 * eligibility, due, overdue, completion or recommended-interval value; a date
 * is only the date the patient entered.
 */

export const PREVENTIVE_CARE_ITEM_DELETION_POLICY = DeletionPolicy.PATIENT_DELETABLE;

/** Mistakes correct; a genuinely new plan or tracking change supersedes. */
export const PREVENTIVE_CARE_ITEM_REVISION_ACTIONS = Object.freeze(["CREATE", "CORRECT", "SUPERSEDE"] as const);

/**
 * Reviewed, versioned local catalogue of preventive-care labels. Labels come
 * from the approved Packet 9 copy matrix; no clinical interval is attached.
 */
export const PREVENTIVE_CARE_CATALOGUE = Object.freeze({
  version: "preventive-care-catalogue.1",
  entries: Object.freeze([
    Object.freeze({ key: "EYE_SCREENING", labels: Object.freeze({ "en-SG": "Eye screening", "zh-SG": "眼睛检查" }) }),
    Object.freeze({ key: "BLOOD_TEST", labels: Object.freeze({ "en-SG": "Blood test", "zh-SG": "血液检验" }) }),
    Object.freeze({ key: "FOOT_CHECK", labels: Object.freeze({ "en-SG": "Foot check", "zh-SG": "足部检查" }) }),
    Object.freeze({ key: "FLU_VACCINE", labels: Object.freeze({ "en-SG": "Flu vaccine", "zh-SG": "流感疫苗" }) }),
  ] as const),
});

export type PreventiveCareCatalogueKey = (typeof PREVENTIVE_CARE_CATALOGUE.entries)[number]["key"];

export function findPreventiveCareCatalogueEntry(key: string, version: string) {
  if (version !== PREVENTIVE_CARE_CATALOGUE.version) return null;
  return PREVENTIVE_CARE_CATALOGUE.entries.find((entry) => entry.key === key) ?? null;
}

const labelSchema = createBoundedTextSchema(1, 120);

export const preventiveCareIdentitySchema = z.union([
  z
    .strictObject({
      kind: z.literal("REVIEWED_CATALOGUE_MATCH"),
      catalogueEntryKey: z.string().min(1).max(64),
      catalogueVersion: versionIdentifierSchema,
      label: labelSchema,
    })
    .superRefine((identity, ctx) => {
      const entry = findPreventiveCareCatalogueEntry(identity.catalogueEntryKey, identity.catalogueVersion);
      if (!entry) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "UNKNOWN_CATALOGUE_ENTRY" });
      else if (!(Object.values(entry.labels) as string[]).includes(identity.label)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "LABEL_NOT_REVIEWED_FOR_ENTRY" });
      }
    }),
  z.strictObject({ kind: z.literal("PATIENT_DEFINED"), label: labelSchema }),
]);

export type PreventiveCareIdentity = z.infer<typeof preventiveCareIdentitySchema>;

export const preventiveCareScheduleSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("UNSCHEDULED") }),
  z.strictObject({ kind: z.literal("TARGET_DATE"), targetDate: localDateSchema }),
  z.strictObject({
    kind: z.literal("RECURRING_REPORTED_PLAN"),
    intervalCount: z.number().int().positive().safe(),
    intervalUnit: z.enum(["WEEK", "MONTH", "YEAR"]),
    nextTargetDate: localDateSchema.optional(),
  }),
]);

export type PreventiveCareSchedule = z.infer<typeof preventiveCareScheduleSchema>;

export const PREVENTIVE_CARE_TRACKING_STATES = Object.freeze(["ACTIVE", "PAUSED", "ENDED"] as const);

export const preventiveCareItemPayloadSchema = z.strictObject({
  identity: preventiveCareIdentitySchema,
  trackingState: z.enum(PREVENTIVE_CARE_TRACKING_STATES),
  schedule: preventiveCareScheduleSchema,
  patientReportedPlanText: patientAuthoredNoteSchema.optional(),
  patientNote: patientAuthoredNoteSchema.optional(),
});

export type PreventiveCareItemPayload = z.infer<typeof preventiveCareItemPayloadSchema>;

export type PreventiveCareItemRevision = RecordRevision<"PREVENTIVE_CARE_ITEM", PreventiveCareItemPayload, AtemporalMeaning, ProvenanceCore>;

export const preventiveCareItemRevisionSchema = createRecordRevisionSchema(
  z.literal("PREVENTIVE_CARE_ITEM"),
  preventiveCareItemPayloadSchema,
  atemporalSchema,
  provenanceCoreSchema,
).superRefine((revision, ctx) => {
  const issue = (message: string, path: string[]) => ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
  if (!(PREVENTIVE_CARE_ITEM_REVISION_ACTIONS as readonly string[]).includes(revision.action)) issue("UNSUPPORTED_REVISION_ACTION", ["action"]);
  // Only the patient maintains their plan; JagaOn never derives or rewrites one.
  if (revision.provenance.initiator !== "PATIENT") issue("PREVENTIVE_ITEM_CHANGE_REQUIRES_PATIENT", ["provenance"]);
  if (revision.provenance.assistance !== "NONE") issue("AI_ASSISTANCE_NOT_PERMITTED", ["provenance"]);
}) as unknown as z.ZodType<PreventiveCareItemRevision, z.ZodTypeDef, unknown>;

export const preventiveCareItemRefSchema = createTypedRevisionRefSchema(z.literal("PREVENTIVE_CARE_ITEM"));
