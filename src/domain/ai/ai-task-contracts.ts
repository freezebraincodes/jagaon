import { z } from "zod";
import { CARE_SUMMARY_SECTION_ORDER, CARE_SUMMARY_SOURCE_FIELD_KEYS } from "@/domain/care-preparation/care-summary-snapshot";
import { decimalStringSchema } from "@/domain/health-records/measurement";
import { PATTERN_LIMITATION_CODES } from "@/domain/patterns/pattern-registry";
import { instantSchema, localDateSchema, recordIdSchema, recordTypeSchema, revisionIdSchema, knowledgeClassSchema } from "@/domain/shared";

/**
 * Packet 11A closed AI task contracts (ai-system-spec Sections 3, 7, 7.1 and
 * 8). The internal `AiTaskRequest` may carry local provenance; the detached
 * `ProviderTaskRequest` carries only invocation-local references (`fact-N`,
 * `claim-N`, `option-N`, `record-N`, `section-N`, `limitation-N`) and never a
 * request, patient, record, revision or audit identifier. Every object is
 * strict: unknown tasks, fields, locales, profiles and references fail.
 */

export const AI_TASK_TYPES = Object.freeze([
  "EXTRACT_CANDIDATE_FACTS",
  "EXPLAIN_PATTERN",
  "DRAFT_NEUTRAL_INQUIRY",
  "ANSWER_BOUNDED_RECORD_QUERY",
  "DRAFT_CARE_PREPARATION_SUMMARY",
  "PHRASE_NON_CLINICAL_RESPONSE",
] as const);
export type AiTaskType = (typeof AI_TASK_TYPES)[number];
export const aiTaskTypeSchema = z.enum(AI_TASK_TYPES);

export const AI_LOCALES = Object.freeze(["en-SG", "zh-SG"] as const);
export type AiLocale = (typeof AI_LOCALES)[number];
const localeSchema = z.enum(AI_LOCALES);

export const AI_ABSTENTION_REASONS = Object.freeze(["INSUFFICIENT_CONTEXT", "AMBIGUOUS_INPUT", "CANNOT_PRESERVE_MEANING"] as const);
export type AiAbstentionReason = (typeof AI_ABSTENTION_REASONS)[number];

// --- Invocation-local references -----------------------------------------------------------

const refSchema = (prefix: string) => z.string().regex(new RegExp(`^${prefix}-[1-9]\\d{0,2}$`), "INVALID_LOCAL_REFERENCE");
export const factRefSchema = refSchema("fact");
export const claimRefSchema = refSchema("claim");
export const optionRefSchema = refSchema("option");
export const recordRefSchema = refSchema("record");
export const sectionRefSchema = refSchema("section");
export const limitationRefSchema = refSchema("limitation");
export const anyLocalRefSchema = z.string().regex(/^(fact|claim|option|record|section|limitation)-[1-9]\d{0,2}$/, "INVALID_LOCAL_REFERENCE");

const unique = <T extends z.ZodTypeAny>(schema: T, max: number, min = 0) =>
  z
    .array(schema)
    .min(min)
    .max(max)
    .refine((values) => new Set(values.map((value) => JSON.stringify(value))).size === values.length, "DUPLICATE_ENTRY");

// --- Facts -----------------------------------------------------------------------------------

export const AI_FACT_UNITS = Object.freeze(["MMOL_L", "MG_DL", "MCG", "MG", "G", "ML", "UNIT", "TABLET", "CAPSULE", "PUFF", "DROP", "PATCH", "KG", "LB", "CM", "IN", "MINUTE"] as const);
const codeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/, "INVALID_CODE");

export const aiFactValueSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("DECIMAL"), value: decimalStringSchema, unit: z.enum(AI_FACT_UNITS) }),
  z.strictObject({ kind: z.literal("COUNT"), value: z.number().int().nonnegative().safe() }),
  z.strictObject({ kind: z.literal("CODE"), code: codeSchema, vocabularyVersion: z.string().min(1).max(96) }),
  z.strictObject({ kind: z.literal("TEXT"), text: z.string().min(1).max(2000), language: z.enum(["en-SG", "zh-SG", "und"]) }),
  z.strictObject({ kind: z.literal("DATE"), localDate: localDateSchema }),
  z.strictObject({ kind: z.literal("DATE_RANGE"), startDate: localDateSchema, endDate: localDateSchema }),
  z.strictObject({ kind: z.literal("LOCAL_TIME"), localTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/) }),
]).refine((value) => value.kind !== "DATE_RANGE" || value.startDate <= value.endDate, "DATE_RANGE_REVERSED");
export type AiFactValue = z.infer<typeof aiFactValueSchema>;

const providerFactShape = {
  ref: factRefSchema,
  field: z.enum(CARE_SUMMARY_SOURCE_FIELD_KEYS),
  value: aiFactValueSchema,
  knowledgeClass: knowledgeClassSchema.optional(),
};
/** A fact exactly as it may cross the provider boundary. */
export const providerFactSchema = z.strictObject(providerFactShape);
export type ProviderFact = z.infer<typeof providerFactSchema>;

const localSourceSchema = z.strictObject({ recordType: recordTypeSchema, recordId: recordIdSchema, revisionId: revisionIdSchema });
/** An internal fact: the provider fact plus local provenance that never leaves JagaOn. */
export const aiRequestFactSchema = z.strictObject({ ...providerFactShape, sources: z.array(localSourceSchema).max(32) });
export type AiRequestFact = z.infer<typeof aiRequestFactSchema>;

// --- Task payloads (Section 3 permissions; request-local references only) -----------------

export const EXTRACTION_CANDIDATE_FIELDS = Object.freeze(["INTAKE_ITEM_LABEL", "INTAKE_KIND", "ACTIVITY_LABEL", "ACTIVITY_CATEGORY", "CONTEXT_KIND"] as const);
/** Only the two Packet 7A enabled families can be explained; AI never reaches a disabled family. */
export const EXPLAINABLE_PATTERN_FAMILIES = Object.freeze(["FAMILIAR_OR_FREQUENT_ITEM", "COMPARABLE_SLOT_TREND"] as const);
export const EXPLANATION_LIMITATION_CODES = Object.freeze([...PATTERN_LIMITATION_CODES, "DOES_NOT_ESTABLISH_CAUSE"] as const);
export const INQUIRY_PURPOSES = Object.freeze(["PATTERN_CONTEXT", "RECONCILIATION", "RECORD_CLARIFICATION", "PROGRESSIVE_LEARNING", "CARE_PREPARATION"] as const);
export const RECORD_QUERY_KINDS = Object.freeze(["RECORDS_IN_PERIOD", "LATEST_RECORDS", "RECORDS_OF_TYPE"] as const);
/** Scope, limitations and Safety history stay deterministic; AI organises only these sections. */
export const AI_ORGANISABLE_SECTIONS = Object.freeze(CARE_SUMMARY_SECTION_ORDER.filter((id) => id !== "SUMMARY_SCOPE" && id !== "DATA_LIMITATIONS" && id !== "SAFETY_HISTORY"));
export const NON_CLINICAL_INTENTS = Object.freeze(["RECORD_SAVED_ACKNOWLEDGEMENT", "PREFERENCE_UPDATED_ACKNOWLEDGEMENT", "WELCOME_BACK_GREETING"] as const);

export const taskPayloadSchemas = {
  EXTRACT_CANDIDATE_FACTS: z.strictObject({ excerptRef: factRefSchema, targetFields: unique(z.enum(EXTRACTION_CANDIDATE_FIELDS), 5, 1) }),
  EXPLAIN_PATTERN: z.strictObject({
    claim: z.strictObject({ ref: claimRefSchema, family: z.enum(EXPLAINABLE_PATTERN_FAMILIES), factRefs: unique(factRefSchema, 12, 1) }),
    limitations: unique(z.strictObject({ ref: limitationRefSchema, code: z.enum(EXPLANATION_LIMITATION_CODES) }), 12, 1),
  }),
  DRAFT_NEUTRAL_INQUIRY: z.strictObject({
    purpose: z.enum(INQUIRY_PURPOSES),
    questionIntentCode: codeSchema,
    options: unique(z.strictObject({ ref: optionRefSchema, meaningCode: codeSchema }), 8, 1),
    supportingFactRefs: unique(factRefSchema, 6),
  }),
  ANSWER_BOUNDED_RECORD_QUERY: z.strictObject({
    queryKind: z.enum(RECORD_QUERY_KINDS),
    records: unique(z.strictObject({ ref: recordRefSchema, factRefs: unique(factRefSchema, 8, 1) }), 24, 1),
  }),
  DRAFT_CARE_PREPARATION_SUMMARY: z.strictObject({
    sections: unique(z.strictObject({ ref: sectionRefSchema, sectionId: z.enum(AI_ORGANISABLE_SECTIONS as unknown as [string, ...string[]]), factRefs: unique(factRefSchema, 32, 1) }), 8, 1),
  }),
  PHRASE_NON_CLINICAL_RESPONSE: z.strictObject({ intentCode: z.enum(NON_CLINICAL_INTENTS), factRefs: unique(factRefSchema, 4) }),
} as const satisfies Record<AiTaskType, z.ZodTypeAny>;

export type AiTaskPayloadFor<T extends AiTaskType> = z.infer<(typeof taskPayloadSchemas)[T]>;
export type AiTaskPayload = { [T in AiTaskType]: AiTaskPayloadFor<T> }[AiTaskType];

/**
 * Detached provider payloads. Identical to the internal payloads except
 * EXPLAIN_PATTERN (Packet 11B.5 Option B, ai-input.explain-pattern@11b.1):
 * the claim carries the application's approved meaning for the request locale,
 * and limitation codes never cross the provider boundary — the application
 * renders limitation copy itself. The meaning text is set only by the local
 * projector from the approved-meaning registry; this schema only bounds it.
 */
export const providerTaskPayloadSchemas = {
  ...taskPayloadSchemas,
  EXPLAIN_PATTERN: z.strictObject({
    claim: z.strictObject({ ref: claimRefSchema, family: z.enum(EXPLAINABLE_PATTERN_FAMILIES), approvedMeaning: z.string().min(1).max(400), factRefs: unique(factRefSchema, 12, 1) }),
  }),
} as const satisfies Record<AiTaskType, z.ZodTypeAny>;

export type ProviderTaskPayloadFor<T extends AiTaskType> = z.infer<(typeof providerTaskPayloadSchemas)[T]>;

/** Every invocation-local reference a payload declares or uses, by kind. */
export function payloadReferences(taskType: AiTaskType, payload: unknown): { declared: string[]; usedFacts: string[] } {
  const p = payload as unknown;
  switch (taskType) {
    case "EXTRACT_CANDIDATE_FACTS":
      return { declared: [], usedFacts: [(p as AiTaskPayloadFor<"EXTRACT_CANDIDATE_FACTS">).excerptRef] };
    case "EXPLAIN_PATTERN": {
      // The provider payload carries no limitations (Option B); the internal payload does.
      const value = p as { claim: { ref: string; factRefs: string[] }; limitations?: Array<{ ref: string }> };
      return { declared: [value.claim.ref, ...(value.limitations ?? []).map((entry) => entry.ref)], usedFacts: value.claim.factRefs };
    }
    case "DRAFT_NEUTRAL_INQUIRY": {
      const value = p as AiTaskPayloadFor<"DRAFT_NEUTRAL_INQUIRY">;
      return { declared: value.options.map((entry) => entry.ref), usedFacts: value.supportingFactRefs };
    }
    case "ANSWER_BOUNDED_RECORD_QUERY": {
      const value = p as AiTaskPayloadFor<"ANSWER_BOUNDED_RECORD_QUERY">;
      return { declared: value.records.map((entry) => entry.ref), usedFacts: value.records.flatMap((entry) => entry.factRefs) };
    }
    case "DRAFT_CARE_PREPARATION_SUMMARY": {
      const value = p as AiTaskPayloadFor<"DRAFT_CARE_PREPARATION_SUMMARY">;
      return { declared: value.sections.map((entry) => entry.ref), usedFacts: value.sections.flatMap((entry) => entry.factRefs) };
    }
    case "PHRASE_NON_CLINICAL_RESPONSE":
      return { declared: [], usedFacts: (p as AiTaskPayloadFor<"PHRASE_NON_CLINICAL_RESPONSE">).factRefs };
  }
}

// --- Request envelopes ------------------------------------------------------------------------

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const runtimeBundleKeySchema = z.string().regex(/^ai\.[a-z0-9-]+@\d{1,3}[a-z]?\.\d{1,3}$/, "INVALID_RUNTIME_BUNDLE_KEY");

function closeReferences(value: { taskType: AiTaskType; facts: Array<{ ref: string }>; taskPayload: unknown }, ctx: z.RefinementCtx) {
  const facts = value.facts.map((fact) => fact.ref);
  if (new Set(facts).size !== facts.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "DUPLICATE_FACT_REFERENCE", path: ["facts"] });
  const { declared, usedFacts } = payloadReferences(value.taskType, value.taskPayload);
  if (new Set(declared).size !== declared.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "DUPLICATE_DECLARED_REFERENCE", path: ["taskPayload"] });
  const known = new Set(facts);
  if (usedFacts.some((ref) => !known.has(ref))) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "UNRESOLVED_FACT_REFERENCE", path: ["taskPayload"] });
}

function requestVariants(provider: boolean) {
  return AI_TASK_TYPES.map((taskType) =>
    z.strictObject({
      ...(provider ? {} : { requestId: z.string().regex(UUID_V4, "INVALID_REQUEST_ID"), requestedAt: instantSchema, releaseProfile: z.literal("HACKATHON_DEMO") }),
      taskType: z.literal(taskType),
      locale: localeSchema,
      runtimeBundleKey: runtimeBundleKeySchema,
      facts: z.array(provider ? providerFactSchema : aiRequestFactSchema).max(32),
      taskPayload: (provider ? providerTaskPayloadSchemas : taskPayloadSchemas)[taskType],
    }),
  ) as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]];
}

type RequestFor<T extends AiTaskType, TFact, TPayload> = {
  taskType: T;
  locale: AiLocale;
  runtimeBundleKey: string;
  facts: TFact[];
  taskPayload: TPayload;
};

export type AiTaskRequestFor<T extends AiTaskType> = RequestFor<T, AiRequestFact, AiTaskPayloadFor<T>> & { requestId: string; requestedAt: z.infer<typeof instantSchema>; releaseProfile: "HACKATHON_DEMO" };
export type AiTaskRequest = { [T in AiTaskType]: AiTaskRequestFor<T> }[AiTaskType];
export type ProviderTaskRequestFor<T extends AiTaskType> = RequestFor<T, ProviderFact, ProviderTaskPayloadFor<T>>;
export type ProviderTaskRequest = { [T in AiTaskType]: ProviderTaskRequestFor<T> }[AiTaskType];

export const aiTaskRequestSchema = z
  .discriminatedUnion("taskType", requestVariants(false) as never)
  .superRefine((value, ctx) => closeReferences(value as never, ctx)) as unknown as z.ZodType<AiTaskRequest>;
export const providerTaskRequestSchema = z
  .discriminatedUnion("taskType", requestVariants(true) as never)
  .superRefine((value, ctx) => closeReferences(value as never, ctx)) as unknown as z.ZodType<ProviderTaskRequest>;

// --- Output envelopes (Section 8) ------------------------------------------------------------

const generatedText = (max: number) => z.string().min(1).max(max);

export const outputPayloadSchemas = {
  EXTRACT_CANDIDATE_FACTS: z.strictObject({
    candidates: z
      .array(
        z
          .strictObject({
            field: z.enum(EXTRACTION_CANDIDATE_FIELDS),
            sourceRef: factRefSchema,
            start: z.number().int().nonnegative().safe(),
            end: z.number().int().positive().safe(),
            quotation: generatedText(1200),
            normalisedCode: codeSchema.optional(),
          })
          .refine((candidate) => candidate.end > candidate.start, "EMPTY_SOURCE_SPAN"),
      )
      .max(8),
  }),
  EXPLAIN_PATTERN: z.strictObject({
    headline: z.strictObject({ text: generatedText(160), claimRefs: unique(claimRefSchema, 4, 1) }),
    observation: z.strictObject({ text: generatedText(600), claimRefs: unique(claimRefSchema, 4, 1) }),
    evidence: z.strictObject({ text: generatedText(600), factRefs: unique(factRefSchema, 12, 1) }),
    // Option B (ai-output.explain-pattern@11b.1): no model-written limitations; the application renders them.
  }),
  DRAFT_NEUTRAL_INQUIRY: z.strictObject({
    observation: z.strictObject({ text: generatedText(400), factRefs: unique(factRefSchema, 6, 1) }).optional(),
    question: z.strictObject({ text: generatedText(240) }),
    optionLabels: unique(z.strictObject({ optionRef: optionRefSchema, label: generatedText(120) }), 8, 1),
  }),
  ANSWER_BOUNDED_RECORD_QUERY: z.strictObject({
    segments: z.array(z.strictObject({ text: generatedText(600), recordRefs: unique(recordRefSchema, 24, 1) })).min(1).max(12),
  }),
  DRAFT_CARE_PREPARATION_SUMMARY: z.strictObject({
    sections: unique(
      z.strictObject({
        sectionRef: sectionRefSchema,
        bullets: z.array(z.strictObject({ text: generatedText(400), factRefs: unique(factRefSchema, 32, 1) })).min(1).max(32),
      }),
      8,
      1,
    ),
  }),
  PHRASE_NON_CLINICAL_RESPONSE: z.strictObject({ message: z.strictObject({ text: generatedText(280), factRefs: unique(factRefSchema, 4) }) }),
} as const satisfies Record<AiTaskType, z.ZodTypeAny>;

export type AiTaskOutputPayloadFor<T extends AiTaskType> = z.infer<(typeof outputPayloadSchemas)[T]>;
export type AiTaskOutputPayload = { [T in AiTaskType]: AiTaskOutputPayloadFor<T> }[AiTaskType];

export const aiOutputSchemaVersionSchema = z.string().regex(/^ai-output\.[a-z0-9-]+@\d{1,3}[a-z]?\.\d{1,3}$/, "INVALID_SCHEMA_VERSION");

const OUTPUT_VARIANTS = new Map<string, z.ZodTypeAny>();
const outputVariants = AI_TASK_TYPES.flatMap((taskType) => {
  const common = { schemaVersion: aiOutputSchemaVersionSchema, taskType: z.literal(taskType), locale: localeSchema, inputRefsUsed: unique(anyLocalRefSchema, 64) };
  const success = z.strictObject({ ...common, outcome: z.literal("SUCCESS"), payload: outputPayloadSchemas[taskType] });
  const abstain = z.strictObject({ ...common, outcome: z.literal("ABSTAIN"), abstentionReason: z.enum(AI_ABSTENTION_REASONS) });
  OUTPUT_VARIANTS.set(`${taskType}|SUCCESS`, success);
  OUTPUT_VARIANTS.set(`${taskType}|ABSTAIN`, abstain);
  return [success, abstain];
}) as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]];

/** The exact variant object inside the output union (read-only access for evaluation diagnostics). */
export function aiTaskOutputVariantSchema(taskType: AiTaskType, outcome: "SUCCESS" | "ABSTAIN"): z.ZodTypeAny {
  const variant = OUTPUT_VARIANTS.get(`${taskType}|${outcome}`);
  if (!variant) throw new Error("UNKNOWN_AI_TASK");
  return variant;
}

type OutputFor<T extends AiTaskType> =
  | { schemaVersion: string; taskType: T; outcome: "SUCCESS"; locale: AiLocale; inputRefsUsed: string[]; payload: AiTaskOutputPayloadFor<T> }
  | { schemaVersion: string; taskType: T; outcome: "ABSTAIN"; locale: AiLocale; inputRefsUsed: string[]; abstentionReason: AiAbstentionReason };
export type AiTaskOutputFor<T extends AiTaskType> = OutputFor<T>;
export type AiTaskOutput = { [T in AiTaskType]: OutputFor<T> }[AiTaskType];
/** The untrusted structured candidate a provider must return; identical shape, validated again locally. */
export type ProviderTaskOutput = AiTaskOutput;

export const aiTaskOutputSchema = z.union(outputVariants) as unknown as z.ZodType<AiTaskOutput>;
export const providerTaskOutputSchema = aiTaskOutputSchema as z.ZodType<ProviderTaskOutput>;

/** Non-patient-facing reason codes: Packet 11 bilingual matrix Section 5. Never rendered directly. */
export const AI_REASON_CODES = Object.freeze([
  "TASK_DISABLED",
  "PROFILE_NOT_PERMITTED",
  "MISSING_CONFIGURATION",
  "PRIVACY_REJECTED",
  "PAYLOAD_INVALID",
  "BUDGET_EXCEEDED",
  "TRANSPORT_FAILED",
  "PROVIDER_TIMEOUT",
  "PROVIDER_REJECTED",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_FAILED",
  "MODEL_ABSTAINED",
  "SCHEMA_INVALID",
  "REFERENCE_MISMATCH",
  "FACT_FIDELITY_FAILED",
  "AUTHORITY_BOUNDARY_VIOLATION",
  "CLINICAL_MEANING_VIOLATION",
  "LOCALE_INVALID",
  "OUTPUT_BUDGET_EXCEEDED",
  "OPERATIONAL_SPEND_LOCKED",
  "REQUEST_CANCELLED",
  "SOURCE_CHANGED",
] as const);
export type AiReasonCode = (typeof AI_REASON_CODES)[number];
export const aiReasonCodeSchema = z.enum(AI_REASON_CODES);
