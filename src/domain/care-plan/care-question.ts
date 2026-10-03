import { z } from "zod";
import { createRecordRevisionSchema, type RecordRevision } from "../shared/revision";
import { provenanceCoreSchema, type ProvenanceCore } from "../shared/provenance";
import { DeletionPolicy, type RecordType } from "../shared/record-catalogue";
import { createTypedRevisionRefSchema } from "../shared/typed-revision-ref";
import { createBoundedTextSchema } from "../shared/text";
import { patientAuthoredNoteSchema } from "../health-records/patient-authored-note";
import { anyTypedRevisionRefSchema, uniqueRefTupleSchema, versionIdentifierSchema } from "../learning/learning-primitives";
import { atemporalSchema, type AtemporalMeaning } from "../learning/learned-knowledge";

/**
 * `CARE_QUESTION` record contract (domain Sections 7.9–7.11).
 *
 * A care question organises something the patient may wish to ask. It is not
 * JagaOn's answer, a clinical instruction, or evidence that anyone received,
 * read or answered it.
 */

export const CARE_QUESTION_DELETION_POLICY = DeletionPolicy.PATIENT_DELETABLE;

export const CARE_QUESTION_REVISION_ACTIONS = Object.freeze(["CREATE", "CORRECT", "SUPERSEDE"] as const);

export const CARE_QUESTION_PURPOSES = Object.freeze([
  "CLARIFY_REPORTED_PRESCRIPTION",
  "DISCUSS_RECORDED_PATTERN",
  "DISCUSS_RECURRING_BARRIER",
  "REVIEW_PREVENTIVE_CARE",
  "GENERAL",
] as const);

export type CareQuestionPurpose = (typeof CARE_QUESTION_PURPOSES)[number];

/** Versioned deterministic basis-policy allowlist (domain Section 7.10). */
export const CARE_QUESTION_BASIS_POLICY = Object.freeze({
  version: "care-question-basis.1",
  permitted: Object.freeze({
    CLARIFY_REPORTED_PRESCRIPTION: Object.freeze(["MEDICATION", "PRESCRIPTION_VERSION", "PRESCRIPTION_CHANGE_CANDIDATE"]),
    DISCUSS_RECORDED_PATTERN: Object.freeze(["PATTERN_OBSERVATION", "PATTERN_EVIDENCE_SNAPSHOT"]),
    DISCUSS_RECURRING_BARRIER: Object.freeze(["LEARNED_KNOWLEDGE", "INQUIRY_RESPONSE"]),
    REVIEW_PREVENTIVE_CARE: Object.freeze(["PREVENTIVE_CARE_ITEM", "PREVENTIVE_CARE_RECORD", "APPOINTMENT"]),
    GENERAL: Object.freeze([]),
  }) as Readonly<Record<CareQuestionPurpose, readonly RecordType[]>>,
});

export const careQuestionTextSchema = z.strictObject({
  text: createBoundedTextSchema(1, 500),
  language: z.enum(["en-SG", "zh-SG", "und"]),
});

export const careQuestionOriginSchema = z.union([
  z.strictObject({ kind: z.literal("PATIENT_AUTHORED") }),
  z
    .strictObject({
      kind: z.literal("JAGAON_PREPARED"),
      purpose: z.enum(CARE_QUESTION_PURPOSES),
      basis: uniqueRefTupleSchema(anyTypedRevisionRefSchema),
      basisPolicyVersion: versionIdentifierSchema,
      preparationRuleVersion: versionIdentifierSchema,
    })
    .superRefine((origin, ctx) => {
      if (origin.basisPolicyVersion !== CARE_QUESTION_BASIS_POLICY.version) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "UNKNOWN_BASIS_POLICY_VERSION" });
      }
      const permitted = CARE_QUESTION_BASIS_POLICY.permitted[origin.purpose];
      if (origin.basis.some((ref) => !permitted.includes(ref.recordType))) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "BASIS_TYPE_UNRELATED_TO_PURPOSE" });
      }
    }),
]);

export const careQuestionPayloadSchema = z.strictObject({
  questionText: careQuestionTextSchema,
  origin: careQuestionOriginSchema,
  intendedRecipient: z.enum(["DOCTOR", "NURSE", "CARE_EDUCATOR", "PHARMACIST", "CARE_TEAM", "OTHER", "UNSPECIFIED"]),
  relatedConditions: uniqueRefTupleSchema(createTypedRevisionRefSchema(z.literal("CONDITION"))).optional(),
  state: z.enum(["DRAFT", "READY_TO_ASK", "PATIENT_REPORTED_ASKED", "DISMISSED"]),
  relatedAppointment: createTypedRevisionRefSchema(z.literal("APPOINTMENT")).optional(),
  patientNote: patientAuthoredNoteSchema.optional(),
});

export type CareQuestionPayload = z.infer<typeof careQuestionPayloadSchema>;

export type CareQuestionRevision = RecordRevision<"CARE_QUESTION", CareQuestionPayload, AtemporalMeaning, ProvenanceCore>;

export const careQuestionRevisionSchema = createRecordRevisionSchema(
  z.literal("CARE_QUESTION"),
  careQuestionPayloadSchema,
  atemporalSchema,
  provenanceCoreSchema,
).superRefine((revision, ctx) => {
  const issue = (message: string, path: string[]) => ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
  if (!(CARE_QUESTION_REVISION_ACTIONS as readonly string[]).includes(revision.action)) issue("UNSUPPORTED_REVISION_ACTION", ["action"]);
  if (revision.action === "CREATE" && revision.payload.origin.kind === "JAGAON_PREPARED" && revision.payload.state !== "DRAFT") {
    // A prepared question stays a draft until the patient confirms it.
    issue("PREPARED_QUESTION_STARTS_AS_DRAFT", ["payload", "state"]);
  }
  if (revision.payload.state !== "DRAFT" && revision.provenance.initiator !== "PATIENT") {
    issue("ONLY_THE_PATIENT_CAN_CONFIRM_A_QUESTION", ["provenance"]);
  }
  if (revision.provenance.assistance !== "NONE") issue("AI_ASSISTANCE_NOT_PERMITTED", ["provenance"]);
}) as unknown as z.ZodType<CareQuestionRevision, z.ZodTypeDef, unknown>;

export const careQuestionRefSchema = createTypedRevisionRefSchema(z.literal("CARE_QUESTION"));
