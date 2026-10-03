import { z } from "zod";
import { createRecordRevisionSchema, type RecordRevision } from "../shared/revision";
import { provenanceCoreSchema, type ProvenanceCore } from "../shared/provenance";
import { instantSchema, instantAfter, type Instant } from "../shared/time";
import { DeletionPolicy, type RecordType } from "../shared/record-catalogue";
import { createTypedRevisionRefSchema, type TypedRevisionRef } from "../shared/typed-revision-ref";
import {
  anyTypedRevisionRefSchema,
  uniqueRefListSchema,
  uniqueRefTupleSchema,
  versionIdentifierSchema,
} from "../learning/learning-primitives";
import { atemporalSchema, type AtemporalMeaning } from "../learning/learned-knowledge";
import {
  INQUIRY_ANSWER_OPTION_KEYS,
  INQUIRY_DECISION_REASON_CODES,
  INQUIRY_PRESENTATION_CLASSES,
  INQUIRY_PRESENTATION_SURFACES,
  INQUIRY_PURPOSES,
  INQUIRY_SENSITIVITIES,
  INQUIRY_TEMPLATES,
  findInquiryDefinition,
  isEnabledDefinition,
  type InquiryAnswerOptionKeyValue,
  type InquiryDecisionReasonCodeValue,
} from "./inquiry-registry";

/**
 * `INQUIRY` record contract (domain Sections 9.2–9.7).
 *
 * The record owns why JagaOn may ask, the exact basis revisions, the closed
 * answer shape, deterministic eligibility/queue evidence, the exact
 * presentation snapshot and the question lifecycle. It never stores the
 * patient's answer; answered states reference the `INQUIRY_RESPONSE`.
 */

type Brand<T, B extends string> = T & { readonly __brand: B };

export type InquiryDefinitionKey = Brand<string, "InquiryDefinitionKey">;
export type InquiryAnswerOptionKey = Brand<InquiryAnswerOptionKeyValue, "InquiryAnswerOptionKey">;
export type InquiryDeduplicationKey = Brand<string, "InquiryDeduplicationKey">;
export type InquiryPresentationKey = Brand<string, "InquiryPresentationKey">;
export type InquiryTemplateKey = Brand<string, "InquiryTemplateKey">;
export type InquiryDecisionReasonCode = Brand<InquiryDecisionReasonCodeValue, "InquiryDecisionReasonCode">;

export const INQUIRY_DELETION_POLICY = DeletionPolicy.PATIENT_DELETABLE;

/** System decisions derive; patient interactions update; expiry expires. */
export const INQUIRY_REVISION_ACTIONS = Object.freeze(["CREATE", "SYSTEM_DERIVE", "UPDATE", "EXPIRE"] as const);

const opaqueToken = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9._:-]+$/, "OPAQUE_KEY_FORMAT");

export const inquiryDefinitionKeySchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]*_V\d+$/, "DEFINITION_KEY_FORMAT")
  .transform((value) => value as InquiryDefinitionKey);

export const inquiryAnswerOptionKeySchema = z
  .enum(INQUIRY_ANSWER_OPTION_KEYS)
  .transform((value) => value as InquiryAnswerOptionKey);

export const inquiryDeduplicationKeySchema = opaqueToken(200).transform((value) => value as InquiryDeduplicationKey);

export const inquiryPresentationKeySchema = opaqueToken(128).transform((value) => value as InquiryPresentationKey);

export const inquiryTemplateKeySchema = z
  .string()
  .refine((value) => Object.prototype.hasOwnProperty.call(INQUIRY_TEMPLATES, value), "UNKNOWN_TEMPLATE_KEY")
  .transform((value) => value as InquiryTemplateKey);

export const inquiryDecisionReasonCodeSchema = z
  .enum(INQUIRY_DECISION_REASON_CODES)
  .transform((value) => value as InquiryDecisionReasonCode);

export const inquiryPurposeSchema = z.enum(INQUIRY_PURPOSES);
export const inquirySensitivitySchema = z.enum(INQUIRY_SENSITIVITIES);
export const inquiryPresentationClassSchema = z.enum(INQUIRY_PRESENTATION_CLASSES);
export const inquiryPresentationSurfaceSchema = z.enum(INQUIRY_PRESENTATION_SURFACES);

// --- Section 9.2: definition reference and basis -------------------------------------

export const inquiryDefinitionRefSchema = z.strictObject({
  definitionKey: inquiryDefinitionKeySchema,
  definitionVersion: versionIdentifierSchema,
});

export type InquiryDefinitionRef = z.infer<typeof inquiryDefinitionRefSchema>;

const nonEmptyAnyRefs = uniqueRefTupleSchema(anyTypedRevisionRefSchema);

export const inquiryBasisSchema = z.discriminatedUnion("purpose", [
  z.strictObject({
    purpose: z.literal("PATTERN_CONTEXT"),
    observation: createTypedRevisionRefSchema(z.literal("PATTERN_OBSERVATION")),
    evidenceSnapshot: createTypedRevisionRefSchema(z.literal("PATTERN_EVIDENCE_SNAPSHOT")),
  }),
  z.strictObject({ purpose: z.literal("RECONCILIATION"), records: nonEmptyAnyRefs }),
  z.strictObject({ purpose: z.literal("RECORD_CLARIFICATION"), records: nonEmptyAnyRefs }),
  z.strictObject({
    purpose: z.literal("PROGRESSIVE_LEARNING"),
    operationalNeed: opaqueToken(128),
    relatedRecords: uniqueRefListSchema(anyTypedRevisionRefSchema),
  }),
  z.strictObject({
    purpose: z.literal("CARE_PREPARATION"),
    basis: nonEmptyAnyRefs,
    relatedCareQuestion: createTypedRevisionRefSchema(z.literal("CARE_QUESTION")).optional(),
  }),
]);

export type InquiryBasis = z.infer<typeof inquiryBasisSchema>;

// --- Section 9.3: answer contract ------------------------------------------------------

/** The shared patient-authored-text limit (domain Section 3.5). */
export const PATIENT_AUTHORED_TEXT_LIMIT = 1000;

const uniqueOptionKeysSchema = z
  .array(inquiryAnswerOptionKeySchema)
  .min(1)
  .refine((keys) => new Set(keys).size === keys.length, "DUPLICATE_OPTION_KEY");

export const inquiryAnswerContractSchema = z.union([
  z.strictObject({ kind: z.literal("CONFIRMATION_WITH_CORRECTION"), allowNotSure: z.boolean() }),
  z.strictObject({
    kind: z.literal("BOUNDED_CHOICE"),
    optionKeys: uniqueOptionKeysSchema,
    allowSomethingElse: z.boolean(),
    allowNotSure: z.boolean(),
    allowPreferNotToSay: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("STATUS_RECONCILIATION"),
    optionKeys: uniqueOptionKeysSchema,
    allowNotSure: z.boolean(),
    allowPreferNotToSay: z.boolean(),
  }),
  z
    .strictObject({
      kind: z.literal("DATE_OR_RANGE"),
      allowSingleDate: z.boolean(),
      allowRange: z.boolean(),
      allowNotSure: z.boolean(),
      allowPreferNotToSay: z.boolean(),
    })
    .refine((contract) => contract.allowSingleDate || contract.allowRange, "DATE_OR_RANGE_REQUIRES_ONE_FORM"),
  z.strictObject({
    kind: z.literal("OPTIONAL_SHORT_TEXT"),
    maximumCodePoints: z.number().int().positive().max(PATIENT_AUTHORED_TEXT_LIMIT),
    allowNotSure: z.boolean(),
    allowPreferNotToSay: z.boolean(),
  }),
  z.strictObject({ kind: z.literal("CARE_QUESTION_BUILDER"), allowShortText: z.boolean() }),
]);

export type InquiryAnswerContract = z.infer<typeof inquiryAnswerContractSchema>;

// --- Section 9.4: eligibility and priority evidence --------------------------------------

export const INQUIRY_ELIGIBILITY_DIMENSIONS = Object.freeze([
  "APPROVED_PURPOSE",
  "IDENTIFIABLE_BASIS",
  "PERMITTED_CONSEQUENCE",
  "CURRENT_ANSWER_ABSENT",
  "NEUTRAL_AND_SAFE",
  "ANSWERABLE",
  "PREVIOUS_DISPOSITION",
  "USEFUL_NOW",
  "UNCERTAINTY_PATH",
  "DEFINED_DESTINATION",
] as const);

export type InquiryEligibilityDimension = (typeof INQUIRY_ELIGIBILITY_DIMENSIONS)[number];

export const INQUIRY_PRIORITY_FACTORS = Object.freeze([
  "EXPECTED_INFORMATION_VALUE",
  "TIME_RELEVANCE",
  "EVIDENCE_MATURITY",
  "PERMITTED_CONSEQUENCE",
  "ANSWERABILITY",
  "BURDEN_AND_SENSITIVITY",
  "PREVIOUS_DISPOSITION",
  "COMPETITION",
] as const);

export type InquiryPriorityFactor = (typeof INQUIRY_PRIORITY_FACTORS)[number];

const reasonCodesSchema = z.array(inquiryDecisionReasonCodeSchema);

export const inquiryEligibilityResultSchema = z.strictObject({
  dimension: z.enum(INQUIRY_ELIGIBILITY_DIMENSIONS),
  outcome: z.enum(["PASS", "FAIL", "INDETERMINATE"]),
  reasonCodes: reasonCodesSchema,
});

export type InquiryEligibilityResult = z.infer<typeof inquiryEligibilityResultSchema>;

export const inquiryEligibilityAssessmentSchema = z
  .strictObject({
    evaluatedAt: instantSchema,
    ruleVersion: versionIdentifierSchema,
    dimensions: z.array(inquiryEligibilityResultSchema).min(1),
    outcome: z.enum(["ELIGIBLE", "INELIGIBLE"]),
  })
  .superRefine((assessment, ctx) => {
    const names = assessment.dimensions.map((result) => result.dimension);
    const complete =
      names.length === INQUIRY_ELIGIBILITY_DIMENSIONS.length &&
      INQUIRY_ELIGIBILITY_DIMENSIONS.every((dimension) => names.includes(dimension));
    if (!complete) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "EVERY_DIMENSION_EXACTLY_ONCE" });
    const allPass = assessment.dimensions.every((result) => result.outcome === "PASS");
    if ((assessment.outcome === "ELIGIBLE") !== allPass) {
      // An indeterminate hard dimension can never be treated as permission to ask.
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "OUTCOME_DISAGREES_WITH_DIMENSIONS" });
    }
  });

export type InquiryEligibilityAssessment = z.infer<typeof inquiryEligibilityAssessmentSchema>;

export const inquiryPriorityFactorResultSchema = z.strictObject({
  factor: z.enum(INQUIRY_PRIORITY_FACTORS),
  effect: z.enum(["INCREASE_PRIORITY", "DECREASE_PRIORITY", "NO_CHANGE", "BLOCK"]),
  reasonCodes: reasonCodesSchema,
});

export type InquiryPriorityFactorResult = z.infer<typeof inquiryPriorityFactorResultSchema>;

export const inquiryQueueDecisionSchema = z
  .strictObject({
    evaluatedAt: instantSchema,
    priorityRuleVersion: versionIdentifierSchema,
    interruptionBudgetVersion: versionIdentifierSchema,
    factors: z.array(inquiryPriorityFactorResultSchema).min(1),
    outcome: z.enum(["QUEUED", "NOT_SELECTED", "BLOCKED"]),
  })
  .superRefine((decision, ctx) => {
    const names = decision.factors.map((result) => result.factor);
    const complete =
      names.length === INQUIRY_PRIORITY_FACTORS.length && INQUIRY_PRIORITY_FACTORS.every((factor) => names.includes(factor));
    if (!complete) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "EVERY_FACTOR_EXACTLY_ONCE" });
    if (decision.outcome === "QUEUED" && decision.factors.some((result) => result.effect === "BLOCK")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "QUEUED_WITH_BLOCKING_FACTOR" });
    }
  });

export type InquiryQueueDecision = z.infer<typeof inquiryQueueDecisionSchema>;

// --- Section 9.5: presentation ---------------------------------------------------------

/** Reviewed presentation length limits, in code points. */
export const PRESENTATION_TEXT_LIMITS = Object.freeze({ leadIn: 400, question: 200, optionLabel: 80 });

const boundedPresentationText = (max: number) =>
  z
    .string()
    .min(1)
    .refine((value) => Array.from(value).length <= max, "PRESENTATION_TEXT_TOO_LONG")
    .refine((value) => value === value.trim(), "PRESENTATION_TEXT_NOT_TRIMMED");

export const inquiryPresentationSchema = z
  .strictObject({
    presentationKey: inquiryPresentationKeySchema,
    presentedAt: instantSchema,
    presentationClass: inquiryPresentationClassSchema,
    surface: inquiryPresentationSurfaceSchema,
    locale: z.enum(["en-SG", "zh-SG"]),
    content: z.strictObject({
      leadIn: boundedPresentationText(PRESENTATION_TEXT_LIMITS.leadIn).optional(),
      question: boundedPresentationText(PRESENTATION_TEXT_LIMITS.question),
      options: z.array(
        z.strictObject({
          optionKey: inquiryAnswerOptionKeySchema,
          label: boundedPresentationText(PRESENTATION_TEXT_LIMITS.optionLabel),
        }),
      ),
    }),
    wordingSource: z.discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("DETERMINISTIC_TEMPLATE"),
        templateKey: inquiryTemplateKeySchema,
        templateVersion: versionIdentifierSchema,
      }),
      z.strictObject({
        kind: z.literal("VALIDATED_AI_ASSISTED"),
        fallbackTemplateKey: inquiryTemplateKeySchema,
        fallbackTemplateVersion: versionIdentifierSchema,
        aiInvocation: opaqueToken(128),
        meaningValidatorVersion: versionIdentifierSchema,
      }),
    ]),
    revalidation: z.strictObject({
      evaluatedAt: instantSchema,
      ruleVersion: versionIdentifierSchema,
      outcome: z.literal("VALID_FOR_PRESENTATION"),
      basisRevisions: uniqueRefListSchema(anyTypedRevisionRefSchema),
    }),
  })
  .superRefine((presentation, ctx) => {
    const keys = presentation.content.options.map((option) => option.optionKey);
    if (new Set(keys).size !== keys.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "DUPLICATE_PRESENTED_OPTION" });
    if (presentation.wordingSource.kind === "DETERMINISTIC_TEMPLATE") {
      const template = INQUIRY_TEMPLATES[presentation.wordingSource.templateKey as keyof typeof INQUIRY_TEMPLATES];
      if (!template?.versions.includes(presentation.wordingSource.templateVersion)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "UNKNOWN_TEMPLATE_VERSION" });
      }
    }
    if (presentation.surface === "CONVERSATIONAL_MESSAGE") {
      // The future conversational surface is disabled in the MVP surface registry.
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "SURFACE_DISABLED_IN_MVP" });
    }
  });

export type InquiryPresentation = z.infer<typeof inquiryPresentationSchema>;

// --- Section 9.6: lifecycle and payload ---------------------------------------------------

const inquiryRefSchema = createTypedRevisionRefSchema(z.literal("INQUIRY"));
const inquiryResponseRefSchema = createTypedRevisionRefSchema(z.literal("INQUIRY_RESPONSE"));

export const inquiryLifecycleSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("CANDIDATE") }),
  z.strictObject({ state: z.literal("ELIGIBLE"), assessment: inquiryEligibilityAssessmentSchema }),
  z.strictObject({
    state: z.literal("QUEUED"),
    eligibility: inquiryEligibilityAssessmentSchema,
    decision: inquiryQueueDecisionSchema,
  }),
  z.strictObject({ state: z.literal("PRESENTED"), presentation: inquiryPresentationSchema }),
  z.strictObject({ state: z.literal("ANSWERED"), response: inquiryResponseRefSchema }),
  z.strictObject({ state: z.literal("NOT_SURE"), response: inquiryResponseRefSchema }),
  z.strictObject({ state: z.literal("DECLINED"), response: inquiryResponseRefSchema }),
  z.strictObject({
    state: z.literal("SNOOZED"),
    presentedRevision: inquiryRefSchema,
    presentationKey: inquiryPresentationKeySchema,
    snoozedAt: instantSchema,
    eligibleAgainAt: instantSchema,
  }),
  z.strictObject({
    state: z.literal("DISMISSED"),
    presentedRevision: inquiryRefSchema,
    presentationKey: inquiryPresentationKeySchema,
    dismissedAt: instantSchema,
  }),
  z.strictObject({
    state: z.literal("EXPIRED"),
    expiredAt: instantSchema,
    reason: z.enum(["TIME_RELEVANCE_ENDED", "ANSWERABILITY_ENDED", "DEFINITION_WITHDRAWN"]),
  }),
  z.strictObject({ state: z.literal("SUPERSEDED"), replacement: inquiryRefSchema }),
  z.strictObject({
    state: z.literal("WITHDRAWN"),
    withdrawnAt: instantSchema,
    reason: z.enum([
      "EVIDENCE_CHANGED",
      "ELIGIBILITY_CHANGED",
      "CURRENT_ANSWER_AVAILABLE",
      "DUPLICATE",
      "SAFETY_PRECEDENCE",
      "PATIENT_PREFERENCE",
      "NO_PERMITTED_CONSEQUENCE",
    ]),
  }),
]);

export type InquiryLifecycle = z.infer<typeof inquiryLifecycleSchema>;
export type InquiryLifecycleState = InquiryLifecycle["state"];

export const TERMINAL_RESPONSE_STATES = Object.freeze(["ANSWERED", "NOT_SURE", "DECLINED"] as const);

export const inquiryPayloadSchema = z
  .strictObject({
    definition: inquiryDefinitionRefSchema,
    basis: inquiryBasisSchema,
    answerContract: inquiryAnswerContractSchema,
    deduplicationKey: inquiryDeduplicationKeySchema,
    sensitivity: inquirySensitivitySchema,
    expiresAt: instantSchema.optional(),
    lifecycle: inquiryLifecycleSchema,
  })
  .superRefine((payload, ctx) => {
    const issue = (message: string, path: (string | number)[] = []) => ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
    const definition = findInquiryDefinition(payload.definition.definitionKey, payload.definition.definitionVersion);
    if (!definition) return issue("UNKNOWN_DEFINITION", ["definition"]);
    if (definition.purpose !== payload.basis.purpose) issue("PURPOSE_DISAGREES_WITH_DEFINITION", ["basis", "purpose"]);
    if (!isEnabledDefinition(definition)) return;
    if (JSON.stringify(definition.answerContract) !== JSON.stringify(payload.answerContract)) {
      issue("ANSWER_CONTRACT_DISAGREES_WITH_DEFINITION", ["answerContract"]);
    }
    if (definition.sensitivity !== payload.sensitivity) issue("SENSITIVITY_DISAGREES_WITH_DEFINITION", ["sensitivity"]);
    const basisRecords = payload.basis.purpose === "RECORD_CLARIFICATION" || payload.basis.purpose === "RECONCILIATION" ? payload.basis.records : [];
    if (basisRecords.some((ref) => !(definition.basisRecordTypes as readonly RecordType[]).includes(ref.recordType))) {
      issue("BASIS_RECORD_TYPE_NOT_PERMITTED", ["basis"]);
    }
    if (payload.lifecycle.state === "PRESENTED") {
      const presentation = payload.lifecycle.presentation;
      const contractKeys = definition.answerContract.optionKeys;
      const presented = presentation.content.options.map((option) => option.optionKey as string);
      if (presented.length !== contractKeys.length || presented.some((key, index) => key !== contractKeys[index])) {
        issue("PRESENTED_OPTIONS_DISAGREE_WITH_DEFINITION", ["lifecycle", "presentation", "content", "options"]);
      }
      if (presentation.presentationClass !== definition.presentationClass) issue("PRESENTATION_CLASS_NOT_PERMITTED", ["lifecycle"]);
      if (!definition.surfaces.includes(presentation.surface)) issue("SURFACE_NOT_PERMITTED", ["lifecycle"]);
      if (
        presentation.wordingSource.kind !== "DETERMINISTIC_TEMPLATE" ||
        presentation.wordingSource.templateKey !== definition.template.templateKey ||
        presentation.wordingSource.templateVersion !== definition.template.templateVersion
      ) {
        issue("WORDING_SOURCE_NOT_PERMITTED", ["lifecycle"]);
      }
      if (payload.expiresAt && !instantAfter(payload.expiresAt, presentation.presentedAt)) {
        issue("PRESENTED_AT_OR_AFTER_EXPIRY", ["lifecycle"]);
      }
    }
    if (payload.lifecycle.state === "SNOOZED" && !instantAfter(payload.lifecycle.eligibleAgainAt, payload.lifecycle.snoozedAt)) {
      issue("SNOOZE_MUST_END_AFTER_IT_STARTS", ["lifecycle"]);
    }
  });

export type InquiryPayload = z.infer<typeof inquiryPayloadSchema>;

export type InquiryRevision = RecordRevision<"INQUIRY", InquiryPayload, AtemporalMeaning, ProvenanceCore>;

const SYSTEM_STATES: readonly InquiryLifecycleState[] = ["ELIGIBLE", "QUEUED", "PRESENTED", "SUPERSEDED", "WITHDRAWN"];
const PATIENT_STATES: readonly InquiryLifecycleState[] = ["ANSWERED", "NOT_SURE", "DECLINED", "SNOOZED", "DISMISSED"];

/** The action and provenance a revision must carry for its lifecycle state. */
export function expectedInquiryRevisionShape(state: InquiryLifecycleState): {
  action: (typeof INQUIRY_REVISION_ACTIONS)[number];
  initiator: "PATIENT" | "JAGAON_SYSTEM";
} {
  if (state === "CANDIDATE") return { action: "CREATE", initiator: "JAGAON_SYSTEM" };
  if (state === "EXPIRED") return { action: "EXPIRE", initiator: "JAGAON_SYSTEM" };
  if (SYSTEM_STATES.includes(state)) return { action: "SYSTEM_DERIVE", initiator: "JAGAON_SYSTEM" };
  if (PATIENT_STATES.includes(state)) return { action: "UPDATE", initiator: "PATIENT" };
  return { action: "SYSTEM_DERIVE", initiator: "JAGAON_SYSTEM" };
}

export const inquiryRevisionSchema = createRecordRevisionSchema(
  z.literal("INQUIRY"),
  inquiryPayloadSchema,
  atemporalSchema,
  provenanceCoreSchema,
).superRefine((revision, ctx) => {
  const expected = expectedInquiryRevisionShape(revision.payload.lifecycle.state);
  if (revision.action !== expected.action) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "ACTION_DISAGREES_WITH_LIFECYCLE", path: ["action"] });
  }
  if (revision.provenance.initiator !== expected.initiator) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "INITIATOR_DISAGREES_WITH_LIFECYCLE", path: ["provenance"] });
  }
  if (revision.provenance.assistance !== "NONE") {
    // Packet 8 uses reviewed deterministic templates only.
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "AI_ASSISTANCE_NOT_PERMITTED", path: ["provenance"] });
  }
  if (revision.payload.expiresAt && !instantAfter(revision.payload.expiresAt, revision.recordedAt)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "EXPIRY_MUST_FOLLOW_CREATION", path: ["payload", "expiresAt"] });
  }
}) as unknown as z.ZodType<InquiryRevision, z.ZodTypeDef, unknown>;

// --- Lifecycle transitions ----------------------------------------------------------------

const ALLOWED_TRANSITIONS: Readonly<Record<InquiryLifecycleState, readonly InquiryLifecycleState[]>> = Object.freeze({
  CANDIDATE: ["ELIGIBLE", "WITHDRAWN", "EXPIRED", "SUPERSEDED"],
  ELIGIBLE: ["ELIGIBLE", "QUEUED", "WITHDRAWN", "EXPIRED", "SUPERSEDED"],
  QUEUED: ["PRESENTED", "ELIGIBLE", "WITHDRAWN", "EXPIRED", "SUPERSEDED"],
  PRESENTED: ["PRESENTED", "ANSWERED", "NOT_SURE", "DECLINED", "SNOOZED", "DISMISSED", "EXPIRED", "WITHDRAWN", "SUPERSEDED"],
  SNOOZED: ["ELIGIBLE", "WITHDRAWN", "EXPIRED", "SUPERSEDED"],
  // A patient correction re-points the terminal state at the corrected response.
  ANSWERED: ["ANSWERED", "NOT_SURE", "DECLINED"],
  NOT_SURE: ["ANSWERED", "NOT_SURE", "DECLINED"],
  DECLINED: ["ANSWERED", "NOT_SURE", "DECLINED"],
  DISMISSED: [],
  EXPIRED: [],
  SUPERSEDED: [],
  WITHDRAWN: [],
});

export type InquiryTransitionIssue =
  | "TRANSITION_NOT_ALLOWED"
  | "CHAIN_IDENTITY_CHANGED"
  | "PRESENTATION_KEY_REUSED"
  | "SNOOZE_DOES_NOT_REFERENCE_PRESENTATION"
  | "SNOOZE_NOT_ELAPSED";

/**
 * Validates one lifecycle step against the previous revision and the full
 * set of presentation keys already used in the chain. Definition, basis,
 * answer contract and deduplication key are fixed within one chain.
 */
export function validateInquiryTransition(
  previous: InquiryRevision,
  next: InquiryRevision,
  usedPresentationKeys: ReadonlySet<string>,
): InquiryTransitionIssue | null {
  const from = previous.payload.lifecycle;
  const to = next.payload.lifecycle;
  if (!ALLOWED_TRANSITIONS[from.state].includes(to.state)) return "TRANSITION_NOT_ALLOWED";
  const fixed = (payload: InquiryPayload) =>
    JSON.stringify([payload.definition, payload.basis, payload.answerContract, payload.deduplicationKey, payload.sensitivity, payload.expiresAt ?? null]);
  if (fixed(previous.payload) !== fixed(next.payload)) return "CHAIN_IDENTITY_CHANGED";
  if (to.state === "PRESENTED" && usedPresentationKeys.has(to.presentation.presentationKey)) return "PRESENTATION_KEY_REUSED";
  if ((to.state === "SNOOZED" || to.state === "DISMISSED") && from.state === "PRESENTED") {
    if (to.presentationKey !== from.presentation.presentationKey || to.presentedRevision.revisionId !== previous.revisionId) {
      return "SNOOZE_DOES_NOT_REFERENCE_PRESENTATION";
    }
  }
  if (from.state === "SNOOZED" && to.state === "ELIGIBLE" && instantAfter(from.eligibleAgainAt, to.assessment.evaluatedAt)) {
    return "SNOOZE_NOT_ELAPSED";
  }
  return null;
}

export type { TypedRevisionRef, Instant };
