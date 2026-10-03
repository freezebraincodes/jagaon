import { z } from "zod";
import { createRecordRevisionSchema, type RecordRevision } from "../shared/revision";
import { provenanceCoreSchema, type ProvenanceCore } from "../shared/provenance";
import { instantAfter, instantBefore, instantEqual, instantSchema, localDateSchema } from "../shared/time";
import { DeletionPolicy } from "../shared/record-catalogue";
import { createTypedRevisionRefSchema } from "../shared/typed-revision-ref";
import { countCodePoints } from "../shared/text";
import { anyTypedRevisionRefSchema, uniqueRefTupleSchema, versionIdentifierSchema } from "../learning/learning-primitives";
import { atemporalSchema, type AtemporalMeaning } from "../learning/learned-knowledge";
import { patientAuthoredNoteSchema } from "../health-records/patient-authored-note";
import { INQUIRY_SEMANTIC_VALUE_KEYS } from "./inquiry-registry";
import {
  inquiryAnswerOptionKeySchema,
  inquiryPresentationKeySchema,
  inquiryPresentationSurfaceSchema,
  type InquiryAnswerContract,
  type InquiryPresentation,
} from "./inquiry";

/**
 * `INQUIRY_RESPONSE` record contract (domain Sections 9.8–9.16).
 *
 * The record preserves exactly what the patient supplied for one exact
 * presented inquiry revision and presentation key, kept apart from any
 * structured interpretation and downstream record. The Safety disposition is
 * capability-discriminated: an ordinary-journal Inquiry capability set
 * records `NOT_APPLICABLE`, which states that Safety is structurally absent
 * and is not a Safety evaluation or a `NO_SAFETY_ROUTE` outcome.
 */

type Brand<T, B extends string> = T & { readonly __brand: B };

export type InquirySemanticValueKey = Brand<string, "InquirySemanticValueKey">;

export const INQUIRY_RESPONSE_DELETION_POLICY = DeletionPolicy.PATIENT_DELETABLE;

export const INQUIRY_RESPONSE_REVISION_ACTIONS = Object.freeze(["CREATE", "CORRECT", "SYSTEM_DERIVE"] as const);

const inquiryRefSchema = createTypedRevisionRefSchema(z.literal("INQUIRY"));
const safetyEventRefSchema = createTypedRevisionRefSchema(z.literal("SAFETY_EVENT"));

export const inquiryPresentationAnswerRefSchema = z.strictObject({
  inquiry: inquiryRefSchema,
  presentationKey: inquiryPresentationKeySchema,
});

export type InquiryPresentationAnswerRef = z.infer<typeof inquiryPresentationAnswerRefSchema>;

// --- Section 9.9: raw answer -----------------------------------------------------------

export const INQUIRY_RESPONSE_KINDS = Object.freeze([
  "CONFIRMATION",
  "CORRECTION",
  "STATUS_CHANGE",
  "CONTEXT",
  "FREE_TEXT",
  "CARE_PREPARATION",
  "NOT_SURE",
  "PREFER_NOT_TO_SAY",
] as const);

export type InquiryResponseKind = (typeof INQUIRY_RESPONSE_KINDS)[number];

export const inquiryCorrectionValueSchema = z.union([
  z.strictObject({ kind: z.literal("REVIEWED_OPTION"), optionKey: inquiryAnswerOptionKeySchema }),
  z.strictObject({ kind: z.literal("DATE"), localDate: localDateSchema }),
  z
    .strictObject({ kind: z.literal("DATE_RANGE"), startLocalDate: localDateSchema, endLocalDate: localDateSchema })
    .refine((range) => range.startLocalDate <= range.endLocalDate, "RANGE_END_BEFORE_START"),
  z.strictObject({ kind: z.literal("SHORT_TEXT"), text: patientAuthoredNoteSchema }),
]);

export const inquiryRawAnswerSchema = z.union([
  z.strictObject({ kind: z.literal("CONFIRMATION"), value: z.literal("CONFIRMED") }),
  z.strictObject({
    kind: z.literal("CORRECTION"),
    correction: z.union([
      z.strictObject({ kind: z.literal("RECORDED_INFORMATION_IS_NOT_CORRECT") }),
      z.strictObject({ kind: z.literal("REPLACEMENT_VALUE"), value: inquiryCorrectionValueSchema }),
    ]),
  }),
  z.strictObject({ kind: z.literal("BOUNDED_CHOICE"), optionKey: inquiryAnswerOptionKeySchema }),
  z.strictObject({ kind: z.literal("SOMETHING_ELSE"), text: patientAuthoredNoteSchema }),
  z.strictObject({ kind: z.literal("DATE"), localDate: localDateSchema }),
  z
    .strictObject({ kind: z.literal("DATE_RANGE"), startLocalDate: localDateSchema, endLocalDate: localDateSchema })
    .refine((range) => range.startLocalDate <= range.endLocalDate, "RANGE_END_BEFORE_START"),
  z.strictObject({ kind: z.literal("SHORT_TEXT"), text: patientAuthoredNoteSchema }),
  z.strictObject({ kind: z.literal("CARE_QUESTION_TEXT"), text: patientAuthoredNoteSchema }),
  z.strictObject({ kind: z.literal("NOT_SURE") }),
  z.strictObject({ kind: z.literal("PREFER_NOT_TO_SAY") }),
]);

export type InquiryRawAnswer = z.infer<typeof inquiryRawAnswerSchema>;

// --- Section 9.10: interpretation ---------------------------------------------------------

export const inquirySemanticValueKeySchema = z
  .enum(INQUIRY_SEMANTIC_VALUE_KEYS)
  .transform((value) => value as unknown as InquirySemanticValueKey);

export const inquiryStructuredMeaningSchema = z.union([
  z.strictObject({ kind: z.literal("CONFIRMED") }),
  z.strictObject({ kind: z.literal("RECORDED_INFORMATION_IS_NOT_CORRECT") }),
  z.strictObject({ kind: z.literal("REVIEWED_SEMANTIC_VALUE"), semanticValueKey: inquirySemanticValueKeySchema }),
  z.strictObject({ kind: z.literal("DATE_PROVIDED"), localDate: localDateSchema }),
  z
    .strictObject({ kind: z.literal("DATE_RANGE_PROVIDED"), startLocalDate: localDateSchema, endLocalDate: localDateSchema })
    .refine((range) => range.startLocalDate <= range.endLocalDate, "RANGE_END_BEFORE_START"),
  z.strictObject({
    kind: z.literal("PATIENT_TEXT_RETAINED"),
    rawAnswerKind: z.enum(["SOMETHING_ELSE", "SHORT_TEXT", "CARE_QUESTION_TEXT"]),
  }),
]);

export const inquiryResponseInterpretationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("NONE"),
    reason: z.enum(["NOT_SURE", "PREFER_NOT_TO_SAY", "RAW_TEXT_ONLY", "NO_SAFE_MAPPING"]),
  }),
  z.strictObject({ kind: z.literal("DIRECT"), meaning: inquiryStructuredMeaningSchema }),
  z.strictObject({
    kind: z.literal("DETERMINISTIC_MAPPING"),
    mappingVersion: versionIdentifierSchema,
    meaning: inquiryStructuredMeaningSchema,
  }),
  z.strictObject({
    kind: z.literal("AI_ASSISTED_CANDIDATE"),
    aiInvocation: z.string().min(1).max(128),
    candidateMeaningKey: inquirySemanticValueKeySchema,
    state: z.literal("UNCONFIRMED"),
  }),
]);

export type InquiryResponseInterpretation = z.infer<typeof inquiryResponseInterpretationSchema>;

// --- Section 9.11: capability-bound Safety disposition ----------------------------------------

export const inquiryResponseSafetyScreeningSchema = z.strictObject({
  evaluatedAt: instantSchema,
  policyPackVersion: versionIdentifierSchema,
  outcome: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("NO_SAFETY_ROUTE") }),
    z.strictObject({ kind: z.literal("ROUTED"), safetyEvent: safetyEventRefSchema }),
    z.strictObject({
      kind: z.literal("CONSERVATIVE_FALLBACK"),
      safetyEvent: safetyEventRefSchema,
      reason: z.enum(["UNSTRUCTURED_CURRENT_CONCERN", "INSUFFICIENT_SAFE_CLASSIFICATION"]),
    }),
  ]),
});

export type InquiryResponseSafetyScreening = z.infer<typeof inquiryResponseSafetyScreeningSchema>;

export const inquiryResponseSafetyDispositionSchema = z.discriminatedUnion("applicability", [
  z.strictObject({
    applicability: z.literal("NOT_APPLICABLE"),
    determinedAt: instantSchema,
    capabilityManifestVersion: versionIdentifierSchema,
    reason: z.literal("INQUIRY_SAFETY_CAPABILITY_ABSENT"),
  }),
  z.strictObject({ applicability: z.literal("SCREENED"), screening: inquiryResponseSafetyScreeningSchema }),
]);

export type InquiryResponseSafetyDisposition = z.infer<typeof inquiryResponseSafetyDispositionSchema>;

// --- Section 9.12: processing -------------------------------------------------------------------

export const inquiryResponseProcessingSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("RECORDED") }),
  z.strictObject({ state: z.literal("SAFETY_ROUTED"), safetyEvent: safetyEventRefSchema }),
  z.strictObject({
    state: z.literal("NO_DOMAIN_EFFECT"),
    reason: z.enum(["NOT_SURE", "PREFER_NOT_TO_SAY", "PATIENT_TEXT_RETAINED_ONLY"]),
  }),
  z.strictObject({ state: z.literal("AWAITING_PATIENT_CONFIRMATION"), confirmationInquiry: inquiryRefSchema }),
  z.strictObject({ state: z.literal("APPLIED"), resultingRecords: uniqueRefTupleSchema(anyTypedRevisionRefSchema) }),
  z.strictObject({
    state: z.literal("REJECTED"),
    reason: z.enum(["DESTINATION_VALIDATION_FAILED", "INTERPRETATION_REJECTED"]),
  }),
]);

export type InquiryResponseProcessing = z.infer<typeof inquiryResponseProcessingSchema>;

// --- Section 9.13: complete payload ---------------------------------------------------------------

const KIND_AGREEMENT: Readonly<Record<InquiryResponseKind, readonly InquiryRawAnswer["kind"][]>> = Object.freeze({
  CONFIRMATION: ["CONFIRMATION"],
  CORRECTION: ["CORRECTION"],
  NOT_SURE: ["NOT_SURE"],
  PREFER_NOT_TO_SAY: ["PREFER_NOT_TO_SAY"],
  STATUS_CHANGE: ["BOUNDED_CHOICE", "DATE", "DATE_RANGE", "CORRECTION", "SHORT_TEXT"],
  CONTEXT: ["BOUNDED_CHOICE", "DATE", "DATE_RANGE", "CORRECTION", "SHORT_TEXT"],
  FREE_TEXT: ["SOMETHING_ELSE", "SHORT_TEXT"],
  CARE_PREPARATION: ["BOUNDED_CHOICE", "CARE_QUESTION_TEXT"],
});

export const inquiryResponsePayloadSchema = z
  .strictObject({
    inquiryPresentation: inquiryPresentationAnswerRefSchema,
    answeredAt: instantSchema,
    submittedThrough: inquiryPresentationSurfaceSchema,
    responseKind: z.enum(INQUIRY_RESPONSE_KINDS),
    rawAnswer: inquiryRawAnswerSchema,
    interpretation: inquiryResponseInterpretationSchema,
    safetyDisposition: inquiryResponseSafetyDispositionSchema,
    processing: inquiryResponseProcessingSchema,
  })
  .superRefine((payload, ctx) => {
    const issue = (message: string, path: string[]) => ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
    if (!KIND_AGREEMENT[payload.responseKind].includes(payload.rawAnswer.kind)) {
      issue("RESPONSE_KIND_DISAGREES_WITH_RAW_ANSWER", ["responseKind"]);
    }
    const raw = payload.rawAnswer.kind;
    const interpretation = payload.interpretation;
    if (raw === "NOT_SURE" && !(interpretation.kind === "NONE" && interpretation.reason === "NOT_SURE")) {
      issue("NOT_SURE_CREATES_NO_MEANING", ["interpretation"]);
    }
    if (raw === "PREFER_NOT_TO_SAY" && !(interpretation.kind === "NONE" && interpretation.reason === "PREFER_NOT_TO_SAY")) {
      issue("PREFER_NOT_TO_SAY_CREATES_NO_MEANING", ["interpretation"]);
    }
    if (interpretation.kind === "NONE" && (interpretation.reason === "NOT_SURE" || interpretation.reason === "PREFER_NOT_TO_SAY")) {
      if (interpretation.reason !== raw) issue("INTERPRETATION_REASON_DISAGREES_WITH_RAW_ANSWER", ["interpretation"]);
    }
    if (payload.processing.state === "NO_DOMAIN_EFFECT") {
      const expected =
        raw === "NOT_SURE" ? "NOT_SURE" : raw === "PREFER_NOT_TO_SAY" ? "PREFER_NOT_TO_SAY" : "PATIENT_TEXT_RETAINED_ONLY";
      if (payload.processing.reason !== expected) issue("PROCESSING_REASON_DISAGREES_WITH_RAW_ANSWER", ["processing"]);
    }
    const disposition = payload.safetyDisposition;
    const safetyProcessing = payload.processing.state === "SAFETY_ROUTED";
    if (disposition.applicability === "NOT_APPLICABLE" && safetyProcessing) {
      // A NOT_APPLICABLE response commits no Safety record or effect.
      issue("NOT_APPLICABLE_CANNOT_ROUTE_TO_SAFETY", ["processing"]);
    }
    // Applicability is resolved for an answer that already exists. A later
    // CORRECT revision keeps the first answeredAt and re-resolves at its own
    // time, so only "before the answer" is invalid here; the exact instant is
    // bound per revision action below.
    if (disposition.applicability === "NOT_APPLICABLE" && instantBefore(disposition.determinedAt, payload.answeredAt)) {
      issue("DISPOSITION_DETERMINED_BEFORE_ANSWER", ["safetyDisposition"]);
    }
  });

export type InquiryResponsePayload = z.infer<typeof inquiryResponsePayloadSchema>;

export type InquiryResponseRevision = RecordRevision<"INQUIRY_RESPONSE", InquiryResponsePayload, AtemporalMeaning, ProvenanceCore>;

export const inquiryResponseRevisionSchema = createRecordRevisionSchema(
  z.literal("INQUIRY_RESPONSE"),
  inquiryResponsePayloadSchema,
  atemporalSchema,
  provenanceCoreSchema,
).superRefine((revision, ctx) => {
  const issue = (message: string, path: string[]) => ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
  if (!(INQUIRY_RESPONSE_REVISION_ACTIONS as readonly string[]).includes(revision.action)) issue("UNSUPPORTED_REVISION_ACTION", ["action"]);
  if (revision.action === "CREATE" || revision.action === "CORRECT") {
    const provenance = revision.provenance;
    if (provenance.sourceKind !== "PATIENT_RESPONSE" || provenance.captureMethod !== "INQUIRY" || provenance.initiator !== "PATIENT") {
      issue("RESPONSE_MUST_BE_PATIENT_INITIATED_THROUGH_INQUIRY", ["provenance"]);
    }
  }
  if (revision.provenance.assistance !== "NONE") issue("AI_ASSISTANCE_NOT_PERMITTED", ["provenance"]);

  // Section 9.15: capability applicability is resolved by the transaction that
  // creates each patient revision. CREATE resolves it at submission; CORRECT
  // re-resolves it at the correction while answeredAt stays the original
  // submission time; SYSTEM_DERIVE carries an earlier determination forward.
  const disposition = revision.payload.safetyDisposition;
  if (disposition.applicability === "NOT_APPLICABLE") {
    // Lossless Instant comparison: fractional seconds beyond milliseconds are significant.
    const { determinedAt } = disposition;
    const createdAt = revision.revisionCreatedAt;
    if (revision.action === "CREATE" && !(instantEqual(determinedAt, revision.payload.answeredAt) && instantEqual(determinedAt, createdAt))) {
      issue("DISPOSITION_NOT_RESOLVED_AT_SUBMISSION", ["payload", "safetyDisposition"]);
    }
    if (revision.action === "CORRECT" && !instantEqual(determinedAt, createdAt)) {
      issue("DISPOSITION_NOT_RE_RESOLVED_AT_CORRECTION", ["payload", "safetyDisposition"]);
    }
    if (revision.action === "SYSTEM_DERIVE" && instantAfter(determinedAt, createdAt)) {
      issue("DISPOSITION_DETERMINED_AFTER_REVISION", ["payload", "safetyDisposition"]);
    }
  }
}) as unknown as z.ZodType<InquiryResponseRevision, z.ZodTypeDef, unknown>;

// --- Answer-contract binding ------------------------------------------------------------------------

export type RawAnswerIssue =
  | "RAW_ANSWER_NOT_PERMITTED_BY_CONTRACT"
  | "OPTION_NOT_PRESENTED"
  | "TEXT_EXCEEDS_CONTRACT_LIMIT";

/**
 * A raw answer is accepted only by its matching answer contract and only for
 * options that were visible in the exact presentation. Unoffered uncertainty
 * or refusal paths and unknown options are rejected before record creation.
 */
export function validateRawAnswerAgainstPresentation(
  contract: InquiryAnswerContract,
  presentation: InquiryPresentation,
  raw: InquiryRawAnswer,
  somethingElseMaximumCodePoints: number,
): RawAnswerIssue | null {
  const presented = new Set(presentation.content.options.map((option) => option.optionKey as string));
  switch (raw.kind) {
    case "NOT_SURE":
      return "allowNotSure" in contract && contract.allowNotSure ? null : "RAW_ANSWER_NOT_PERMITTED_BY_CONTRACT";
    case "PREFER_NOT_TO_SAY":
      return "allowPreferNotToSay" in contract && contract.allowPreferNotToSay ? null : "RAW_ANSWER_NOT_PERMITTED_BY_CONTRACT";
    case "BOUNDED_CHOICE":
      if (contract.kind !== "BOUNDED_CHOICE" && contract.kind !== "STATUS_RECONCILIATION") return "RAW_ANSWER_NOT_PERMITTED_BY_CONTRACT";
      if (!(contract.optionKeys as string[]).includes(raw.optionKey)) return "RAW_ANSWER_NOT_PERMITTED_BY_CONTRACT";
      return presented.has(raw.optionKey) ? null : "OPTION_NOT_PRESENTED";
    case "SOMETHING_ELSE":
      if (contract.kind !== "BOUNDED_CHOICE" || !contract.allowSomethingElse) return "RAW_ANSWER_NOT_PERMITTED_BY_CONTRACT";
      return countCodePoints(raw.text.text) <= somethingElseMaximumCodePoints ? null : "TEXT_EXCEEDS_CONTRACT_LIMIT";
    case "CONFIRMATION":
    case "CORRECTION":
      return contract.kind === "CONFIRMATION_WITH_CORRECTION" ? null : "RAW_ANSWER_NOT_PERMITTED_BY_CONTRACT";
    case "DATE":
      return contract.kind === "DATE_OR_RANGE" && contract.allowSingleDate ? null : "RAW_ANSWER_NOT_PERMITTED_BY_CONTRACT";
    case "DATE_RANGE":
      return contract.kind === "DATE_OR_RANGE" && contract.allowRange ? null : "RAW_ANSWER_NOT_PERMITTED_BY_CONTRACT";
    case "SHORT_TEXT":
      if (contract.kind !== "OPTIONAL_SHORT_TEXT") return "RAW_ANSWER_NOT_PERMITTED_BY_CONTRACT";
      return countCodePoints(raw.text.text) <= contract.maximumCodePoints ? null : "TEXT_EXCEEDS_CONTRACT_LIMIT";
    case "CARE_QUESTION_TEXT":
      return contract.kind === "CARE_QUESTION_BUILDER" && contract.allowShortText ? null : "RAW_ANSWER_NOT_PERMITTED_BY_CONTRACT";
  }
}

/** Terminal Inquiry state agreed with the response (domain Section 9.14). */
export function terminalStateForRawAnswer(raw: InquiryRawAnswer): "ANSWERED" | "NOT_SURE" | "DECLINED" {
  if (raw.kind === "NOT_SURE") return "NOT_SURE";
  if (raw.kind === "PREFER_NOT_TO_SAY") return "DECLINED";
  return "ANSWERED";
}
