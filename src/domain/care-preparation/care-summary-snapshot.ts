import { z } from "zod";
import { createRecordRevisionSchema, type RecordRevision } from "../shared/revision";
import { provenanceCoreSchema, type ProvenanceCore } from "../shared/provenance";
import { instantSchema, type Instant } from "../shared/time";
import { recordIdSchema, revisionIdSchema } from "../shared/identifiers";
import { recordTypeSchema, DeletionPolicy, type RecordType } from "../shared/record-catalogue";
import { createTypedRevisionRefSchema, type TypedRevisionRef } from "../shared/typed-revision-ref";
import { intervalEndSchema, timePointSchema } from "../shared/temporal";
import { decimalStringSchema } from "../health-records/measurement";
import { patientAuthoredNoteSchema } from "../health-records/patient-authored-note";
import { atemporalSchema, type AtemporalMeaning } from "../learning/learned-knowledge";

/**
 * `CARE_SUMMARY_SNAPSHOT` record contract (domain Sections 11.1–11.7, 11.10).
 *
 * A snapshot freezes one patient-selected, source-closed summary in one
 * locale. It is a preparation aid: never a clinical record, diagnosis,
 * proof of delivery or proof of review. Content is immutable after
 * `PREPARED`; later revisions record only preview, exact-hash approval,
 * invalidation or supersession.
 */

export const CARE_SUMMARY_SNAPSHOT_DELETION_POLICY = DeletionPolicy.PATIENT_DELETABLE;

/** Ordinary selected period (domain 11.2). */
export const CARE_SUMMARY_MAX_PERIOD_DAYS = 180;
/** At most 32 included facts and patient questions (domain 11.3). */
export const CARE_SUMMARY_MAX_SELECTIONS = 32;
/** Technical bound on the exact source closure of one snapshot. */
export const CARE_SUMMARY_MAX_SOURCE_REVISIONS = 1000;

export const CARE_SUMMARY_SNAPSHOT_REVISION_ACTIONS = Object.freeze(["CREATE", "UPDATE", "SYSTEM_DERIVE"] as const);

export const CARE_SUMMARY_STATUSES = Object.freeze(["PREPARED", "PREVIEWED", "APPROVED", "INVALIDATED", "SUPERSEDED"] as const);
export type CareSummarySnapshotStatus = (typeof CARE_SUMMARY_STATUSES)[number];

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "SHA256_DIGEST_INVALID");
const anyRefSchema = z.strictObject({ recordType: recordTypeSchema, recordId: recordIdSchema, revisionId: revisionIdSchema });
const appointmentRefSchema = createTypedRevisionRefSchema(z.literal("APPOINTMENT"));
const conditionRefSchema = createTypedRevisionRefSchema(z.literal("CONDITION"));
const questionRefSchema = createTypedRevisionRefSchema(z.literal("CARE_QUESTION"));
const blockIdSchema = z.string().regex(/^[a-z0-9][a-z0-9.-]{0,63}$/, "BLOCK_ID_INVALID");
const bindingKeySchema = z.string().regex(/^[a-z0-9][a-z0-9.-]{0,63}$/, "BINDING_KEY_INVALID");
const assetIdSchema = z.string().regex(/^[a-z0-9][a-zA-Z0-9.-]{0,95}$/, "LOCALE_ASSET_ID_INVALID");
const renderedTextSchema = z.string().min(1).max(20_000);

// --- 11.2 Purpose, period, approval, invalidation -----------------------------------------

export const careSummaryPurposeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("UPCOMING_APPOINTMENT"), appointment: appointmentRefSchema }),
  z.strictObject({ kind: z.literal("ROUTINE_REVIEW") }),
  z.strictObject({ kind: z.literal("MEDICATION_REVIEW") }),
  z.strictObject({ kind: z.literal("SYMPTOM_OR_EVENT_DISCUSSION") }),
  z.strictObject({ kind: z.literal("PATIENT_DEFINED"), patientPurposeText: patientAuthoredNoteSchema }),
]);
export type CareSummaryPurpose = z.infer<typeof careSummaryPurposeSchema>;

export const careSummarySelectedPeriodSchema = z
  .strictObject({ startAt: instantSchema, endAtExclusive: instantSchema })
  .superRefine((period, ctx) => {
    const start = Date.parse(period.startAt);
    const end = Date.parse(period.endAtExclusive);
    if (!(start < end)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "SUMMARY_PERIOD_INVALID" });
    else if (end - start > CARE_SUMMARY_MAX_PERIOD_DAYS * 86_400_000) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "SUMMARY_PERIOD_TOO_LONG" });
  });
export type CareSummarySelectedPeriod = { startAt: Instant; endAtExclusive: Instant };

export const careSummaryPatientApprovalSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("NOT_APPROVED") }),
  z.strictObject({ state: z.literal("APPROVED"), approvedAt: instantSchema, approvedContentHash: sha256Schema }),
]);

export const CARE_SUMMARY_INVALIDATION_REASONS = Object.freeze([
  "SOURCE_CORRECTED",
  "SOURCE_SUPERSEDED",
  "SOURCE_DELETED",
  "PATIENT_CHANGED_SELECTION",
  "PATIENT_CHANGED_PURPOSE",
  "PATIENT_CHANGED_PERIOD",
  "PATIENT_CHANGED_LOCALE",
  "RENDERING_OR_VALIDATION_DEFECT",
] as const);
export type CareSummaryInvalidationReason = (typeof CARE_SUMMARY_INVALIDATION_REASONS)[number];

export const careSummaryInvalidationSchema = z.strictObject({ invalidatedAt: instantSchema, reason: z.enum(CARE_SUMMARY_INVALIDATION_REASONS) });

// --- 11.3 Selection --------------------------------------------------------------------

export const CARE_SUMMARY_EXCLUSION_REASONS = Object.freeze(["PATIENT_EXCLUDED", "PRIVATE_BY_DEFAULT", "UNRELATED_TO_PURPOSE", "INVALID_OR_SUPERSEDED", "NOT_SELECTED"] as const);

export const careSummarySelectionSchema = z.strictObject({
  includedSourceRevisions: z.array(anyRefSchema).max(CARE_SUMMARY_MAX_SOURCE_REVISIONS),
  excludedCandidates: z.array(z.strictObject({ source: anyRefSchema, reason: z.enum(CARE_SUMMARY_EXCLUSION_REASONS) })).max(CARE_SUMMARY_MAX_SOURCE_REVISIONS),
});

// --- 11.4 Sections ---------------------------------------------------------------------

/** Versioned renderer order; the MVP does not permit arbitrary reordering. */
export const CARE_SUMMARY_SECTION_ORDER = Object.freeze([
  "SUMMARY_SCOPE",
  "CURRENT_CARE_PLAN",
  "CARE_ORGANISATION",
  "MEASUREMENTS",
  "MEDICATION_RECORDS",
  "SYMPTOMS_AND_CONTEXT",
  "INTAKE_AND_ACTIVITY",
  "PATTERNS",
  "SAFETY_HISTORY",
  "QUESTIONS_FOR_CARE_TEAM",
  "DATA_LIMITATIONS",
] as const);
export type CareSummarySectionId = (typeof CARE_SUMMARY_SECTION_ORDER)[number];

export const CARE_SUMMARY_TEMPORAL_ROLES = Object.freeze(["CURRENT", "HISTORICAL", "DURING_SELECTED_PERIOD", "NOT_APPLICABLE"] as const);

// --- 11.5 Bindings ---------------------------------------------------------------------

export const CARE_SUMMARY_SOURCE_FIELD_KEYS = Object.freeze([
  "CONDITION_LABEL",
  "MEASUREMENT_VALUE",
  "MEASUREMENT_METHOD",
  "KETONE_RESULT",
  "OCCURRENCE_TIME",
  "EFFECTIVE_INTERVAL",
  "RECORDED_STATUS",
  "MEDICATION_NAME",
  "PRESCRIPTION_INSTRUCTION",
  "DOSE_AMOUNT",
  "MEDICATION_EVENT_STATE",
  "INTAKE_KIND",
  "INTAKE_LABEL",
  "INTAKE_REASON",
  "SYMPTOM_CODE",
  "SYMPTOM_SEVERITY",
  "CAPABILITY_STATE",
  "ACTIVITY_LABEL",
  "ACTIVITY_DURATION",
  "ACTIVITY_INTENSITY",
  "APPOINTMENT_SERVICE",
  "APPOINTMENT_TIME",
  "CARE_ITEM_LABEL",
  "CARE_ITEM_STATUS",
  "QUESTION_TEXT",
  "QUESTION_PURPOSE",
  "PATTERN_CLAIM",
  "PATTERN_MATURITY",
  "PATTERN_LIMITATION",
  "EVIDENCE_COUNT",
  "SAFETY_TOPIC",
  "SAFETY_URGENCY",
  "SAFETY_STATUS",
  "SAFETY_ACTION_RECORDED",
  "PROVENANCE_CLASS",
  "UNCERTAINTY",
  "PATIENT_AUTHORED_TEXT",
] as const);
export type CareSummarySourceFieldKey = (typeof CARE_SUMMARY_SOURCE_FIELD_KEYS)[number];

const sourceFieldSchema = z.enum(CARE_SUMMARY_SOURCE_FIELD_KEYS);

export const careSummaryUnitSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("STANDARD"),
    code: z.enum(["MMOL_L", "MG_DL", "MCG", "MG", "G", "ML", "UNIT", "TABLET", "CAPSULE", "PUFF", "DROP", "PATCH", "KG", "LB", "CM", "IN", "MINUTE"]),
  }),
  z.strictObject({ kind: z.literal("OTHER"), exactUnitText: z.string().min(1).max(1000) }),
]);

const bindingBase = { bindingKey: bindingKeySchema, source: anyRefSchema, sourceField: sourceFieldSchema };

export const careSummaryFactBindingSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("DECIMAL_VALUE"), ...bindingBase, value: decimalStringSchema, unit: careSummaryUnitSchema }),
  z.strictObject({ kind: z.literal("WHOLE_COUNT"), ...bindingBase, value: z.number().int().nonnegative().safe() }),
  z.strictObject({ kind: z.literal("CODED_VALUE"), ...bindingBase, code: z.string().min(1).max(64), vocabularyVersion: z.string().min(1).max(96) }),
  z.strictObject({ kind: z.literal("TIME_POINT"), ...bindingBase, value: timePointSchema }),
  z.strictObject({ kind: z.literal("INTERVAL"), ...bindingBase, start: timePointSchema, end: intervalEndSchema }),
  z.strictObject({ kind: z.literal("PATIENT_TEXT"), ...bindingBase, text: z.string().min(1).max(1000), language: z.enum(["en-SG", "zh-SG", "und"]) }),
]);
export type CareSummaryFactBinding = z.infer<typeof careSummaryFactBindingSchema>;

// --- 11.6 Blocks and limitations ----------------------------------------------------------

export const CARE_SUMMARY_LIMITATION_CODES = Object.freeze([
  "SELECTED_RECORDS_ONLY",
  "MISSING_OR_UNRECORDED_DATA",
  "MATERIAL_TIME_UNCERTAINTY",
  "PATIENT_REPORTED_NOT_EXTERNALLY_VERIFIED",
  "PATTERN_DOES_NOT_ESTABLISH_CAUSE",
  "PATTERN_EVIDENCE_LIMITED",
  "CURRENT_STATE_MAY_HAVE_CHANGED",
] as const);
export type CareSummaryLimitationCode = (typeof CARE_SUMMARY_LIMITATION_CODES)[number];

const nonEmpty = <T extends z.ZodTypeAny>(schema: T) => z.array(schema).min(1);

export const careSummaryBlockSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("SUMMARY_SCOPE"),
    blockId: blockIdSchema,
    temporalRole: z.literal("NOT_APPLICABLE"),
    purpose: careSummaryPurposeSchema,
    conditionScope: z.array(conditionRefSchema),
    selectedPeriod: careSummarySelectedPeriodSchema,
    asOf: instantSchema,
    localeAssetId: assetIdSchema,
    renderedText: renderedTextSchema,
  }),
  z.strictObject({
    kind: z.literal("RECORDED_FACT"),
    blockId: blockIdSchema,
    temporalRole: z.enum(CARE_SUMMARY_TEMPORAL_ROLES),
    sourceRevisions: nonEmpty(anyRefSchema),
    factBindings: nonEmpty(careSummaryFactBindingSchema),
    renderedText: renderedTextSchema,
  }),
  z.strictObject({
    kind: z.literal("PATTERN_OBSERVATION"),
    blockId: blockIdSchema,
    temporalRole: z.enum(["CURRENT", "HISTORICAL"]),
    observation: createTypedRevisionRefSchema(z.literal("PATTERN_OBSERVATION")),
    evidenceSnapshot: createTypedRevisionRefSchema(z.literal("PATTERN_EVIDENCE_SNAPSHOT")),
    factBindings: nonEmpty(careSummaryFactBindingSchema),
    renderedText: renderedTextSchema,
    limitationBlockIds: nonEmpty(blockIdSchema),
  }),
  z.strictObject({
    kind: z.literal("PATIENT_QUESTION"),
    blockId: blockIdSchema,
    temporalRole: z.literal("CURRENT"),
    question: questionRefSchema,
    originalPatientText: z.strictObject({ text: z.string().min(1).max(1000), language: z.enum(["en-SG", "zh-SG", "und"]) }),
  }),
  z.strictObject({
    kind: z.literal("SUMMARY_LIMITATION"),
    blockId: blockIdSchema,
    temporalRole: z.literal("NOT_APPLICABLE"),
    limitationCode: z.enum(CARE_SUMMARY_LIMITATION_CODES),
    relatedSources: z.array(anyRefSchema),
    localeAssetId: assetIdSchema,
    renderedText: renderedTextSchema,
  }),
]);
export type CareSummaryBlock = z.infer<typeof careSummaryBlockSchema>;

export const careSummarySectionSchema = z.strictObject({
  sectionId: z.enum(CARE_SUMMARY_SECTION_ORDER),
  titleLocaleAssetId: assetIdSchema,
  displayOrder: z.number().int().nonnegative(),
  blocks: nonEmpty(careSummaryBlockSchema),
});
export type CareSummarySection = z.infer<typeof careSummarySectionSchema>;

export const careSummaryLimitationSchema = z.strictObject({ code: z.enum(CARE_SUMMARY_LIMITATION_CODES), relatedSources: z.array(anyRefSchema), blockId: blockIdSchema });

// --- 11.7 Composition, rendering and payload ------------------------------------------------

/** Hackathon profile: deterministic composition only; no AI path exists. */
export const careSummaryCompositionSchema = z.strictObject({ method: z.literal("DETERMINISTIC"), templateVersion: z.string().min(1).max(96) });

export const careSummaryRenderingSchema = z.strictObject({
  rendererVersion: z.string().min(1).max(96),
  localePackVersion: z.string().min(1).max(96),
  contentHash: sha256Schema,
});

const sameRef = (a: TypedRevisionRef<RecordType>, b: TypedRevisionRef<RecordType>) => a.recordType === b.recordType && a.recordId === b.recordId && a.revisionId === b.revisionId;
const refKey = (ref: TypedRevisionRef<RecordType>) => `${ref.recordType}|${ref.recordId}|${ref.revisionId}`;

/** Which blocks a section may hold (domain 11.4, 11.6). */
const SECTION_BLOCK_KINDS: Readonly<Record<CareSummarySectionId, readonly CareSummaryBlock["kind"][]>> = Object.freeze({
  SUMMARY_SCOPE: ["SUMMARY_SCOPE"],
  CURRENT_CARE_PLAN: ["RECORDED_FACT"],
  CARE_ORGANISATION: ["RECORDED_FACT"],
  MEASUREMENTS: ["RECORDED_FACT"],
  MEDICATION_RECORDS: ["RECORDED_FACT"],
  SYMPTOMS_AND_CONTEXT: ["RECORDED_FACT"],
  INTAKE_AND_ACTIVITY: ["RECORDED_FACT"],
  PATTERNS: ["PATTERN_OBSERVATION"],
  SAFETY_HISTORY: ["RECORDED_FACT"],
  QUESTIONS_FOR_CARE_TEAM: ["PATIENT_QUESTION"],
  DATA_LIMITATIONS: ["SUMMARY_LIMITATION"],
});

/** Structural rules every snapshot payload must satisfy, reported as stable codes. */
export function careSummaryPayloadIssues(payload: z.infer<typeof careSummarySnapshotPayloadShape>): string[] {
  const issues = new Set<string>();
  const { selection, sections, limitations } = payload;

  // Selection: non-empty, duplicate-free, disjoint.
  const included = selection.includedSourceRevisions;
  if (included.length === 0) issues.add("SUMMARY_SELECTION_EMPTY");
  const includedKeys = new Set(included.map(refKey));
  const excludedKeys = selection.excludedCandidates.map((candidate) => refKey(candidate.source));
  if (includedKeys.size !== included.length || new Set(excludedKeys).size !== excludedKeys.length || excludedKeys.some((key) => includedKeys.has(key))) {
    issues.add("SUMMARY_SELECTION_OVERLAP");
  }

  // Sections: closed order, mandatory scope and limitations, no empty or misplaced blocks.
  const ids = sections.map((section) => section.sectionId);
  const orderIndex = ids.map((id) => CARE_SUMMARY_SECTION_ORDER.indexOf(id));
  if (orderIndex.some((value, index) => index > 0 && value <= orderIndex[index - 1]!)) issues.add("SUMMARY_SECTION_INVALID");
  if (sections.some((section, index) => section.displayOrder !== index)) issues.add("SUMMARY_SECTION_INVALID");
  if (ids[0] !== "SUMMARY_SCOPE" || ids[ids.length - 1] !== "DATA_LIMITATIONS") issues.add("SUMMARY_SECTION_INVALID");
  for (const section of sections) {
    if (section.blocks.some((block) => !SECTION_BLOCK_KINDS[section.sectionId].includes(block.kind))) issues.add("SUMMARY_SECTION_INVALID");
  }
  const blocks = sections.flatMap((section) => section.blocks);
  if (new Set(blocks.map((block) => block.blockId)).size !== blocks.length) issues.add("SUMMARY_SECTION_INVALID");

  // Exactly one scope block, equal to the snapshot metadata.
  const scopes = blocks.filter((block) => block.kind === "SUMMARY_SCOPE");
  const scope = scopes[0];
  if (
    scopes.length !== 1 ||
    !scope ||
    scope.kind !== "SUMMARY_SCOPE" ||
    JSON.stringify(scope.purpose) !== JSON.stringify(payload.purpose) ||
    JSON.stringify(scope.conditionScope) !== JSON.stringify(payload.conditionScope) ||
    scope.selectedPeriod.startAt !== payload.selectedPeriod.startAt ||
    scope.selectedPeriod.endAtExclusive !== payload.selectedPeriod.endAtExclusive ||
    scope.asOf !== payload.asOf
  ) {
    issues.add("SUMMARY_SECTION_INVALID");
  }

  // 1–32 selected facts and patient questions.
  const selections = blocks.filter((block) => block.kind === "RECORDED_FACT" || block.kind === "PATTERN_OBSERVATION" || block.kind === "PATIENT_QUESTION").length;
  if (selections === 0) issues.add("SUMMARY_SELECTION_EMPTY");
  if (selections > CARE_SUMMARY_MAX_SELECTIONS) issues.add("SUMMARY_SELECTION_TOO_LARGE");

  // Source closure: every named source is selected; bindings name their block's sources.
  const bindingKeys: string[] = [];
  const named: TypedRevisionRef<RecordType>[] = [];
  if (payload.purpose.kind === "UPCOMING_APPOINTMENT") named.push(payload.purpose.appointment);
  for (const block of blocks) {
    if (block.kind === "RECORDED_FACT") {
      named.push(...block.sourceRevisions);
      for (const binding of block.factBindings) {
        bindingKeys.push(binding.bindingKey);
        if (!block.sourceRevisions.some((ref) => sameRef(ref, binding.source))) issues.add("SUMMARY_BINDING_MISMATCH");
      }
    } else if (block.kind === "PATTERN_OBSERVATION") {
      named.push(block.observation, block.evidenceSnapshot);
      for (const binding of block.factBindings) {
        bindingKeys.push(binding.bindingKey);
        named.push(binding.source);
      }
    } else if (block.kind === "PATIENT_QUESTION") {
      named.push(block.question);
    } else if (block.kind === "SUMMARY_LIMITATION") {
      named.push(...block.relatedSources);
    }
  }
  if (new Set(bindingKeys).size !== bindingKeys.length) issues.add("SUMMARY_BINDING_MISMATCH");
  if (named.some((ref) => !includedKeys.has(refKey(ref)))) issues.add("SUMMARY_SOURCE_NOT_SELECTED");

  // Limitations: SELECTED_RECORDS_ONLY always; DATA_LIMITATIONS holds exactly the named blocks.
  if (!limitations.some((limitation) => limitation.code === "SELECTED_RECORDS_ONLY")) issues.add("SUMMARY_REQUIRED_LIMITATION_MISSING");
  const limitationKeys = limitations.map((limitation) => `${limitation.code}|${limitation.relatedSources.map(refKey).sort().join(",")}`);
  if (new Set(limitationKeys).size !== limitationKeys.length) issues.add("SUMMARY_REQUIRED_LIMITATION_MISSING");
  const limitationSection = sections.find((section) => section.sectionId === "DATA_LIMITATIONS");
  const limitationBlocks = limitationSection?.blocks ?? [];
  const namedLimitationIds = limitations.map((limitation) => limitation.blockId);
  if (limitationBlocks.length !== namedLimitationIds.length || limitationBlocks.some((block) => !namedLimitationIds.includes(block.blockId))) issues.add("SUMMARY_REQUIRED_LIMITATION_MISSING");
  for (const limitation of limitations) {
    const block = limitationBlocks.find((candidate) => candidate.blockId === limitation.blockId);
    if (!block || block.kind !== "SUMMARY_LIMITATION" || block.limitationCode !== limitation.code || JSON.stringify(block.relatedSources) !== JSON.stringify(limitation.relatedSources)) {
      issues.add("SUMMARY_REQUIRED_LIMITATION_MISSING");
    }
  }
  for (const block of blocks) {
    if (block.kind === "PATTERN_OBSERVATION" && block.limitationBlockIds.some((id) => !namedLimitationIds.includes(id))) issues.add("SUMMARY_REQUIRED_LIMITATION_MISSING");
  }

  // Lifecycle and approval coherence (domain 11.7).
  const approval = payload.patientApproval;
  if ((payload.status === "PREPARED" || payload.status === "PREVIEWED") && approval.state !== "NOT_APPROVED") issues.add("SUMMARY_NOT_APPROVED");
  if (payload.status === "APPROVED" && (approval.state !== "APPROVED" || approval.approvedContentHash !== payload.rendering.contentHash)) issues.add("SUMMARY_CONTENT_HASH_MISMATCH");
  if (approval.state === "APPROVED" && approval.approvedContentHash !== payload.rendering.contentHash) issues.add("SUMMARY_CONTENT_HASH_MISMATCH");
  if ((payload.status === "INVALIDATED") !== (payload.invalidation !== undefined)) issues.add("SUMMARY_INVALIDATED_FOR_EXPORT");

  return [...issues].sort();
}

const careSummarySnapshotPayloadShape = z.strictObject({
  status: z.enum(CARE_SUMMARY_STATUSES),
  purpose: careSummaryPurposeSchema,
  conditionScope: z.array(conditionRefSchema),
  selectedPeriod: careSummarySelectedPeriodSchema,
  asOf: instantSchema,
  locale: z.enum(["en-SG", "zh-SG"], { errorMap: () => ({ message: "SUMMARY_LOCALE_INVALID" }) }),
  selection: careSummarySelectionSchema,
  sections: nonEmpty(careSummarySectionSchema),
  limitations: nonEmpty(careSummaryLimitationSchema),
  composition: careSummaryCompositionSchema,
  rendering: careSummaryRenderingSchema,
  patientApproval: careSummaryPatientApprovalSchema,
  replacesSnapshot: createTypedRevisionRefSchema(z.literal("CARE_SUMMARY_SNAPSHOT")).optional(),
  invalidation: careSummaryInvalidationSchema.optional(),
});

export const careSummarySnapshotPayloadSchema = careSummarySnapshotPayloadShape.superRefine((payload, ctx) => {
  for (const message of careSummaryPayloadIssues(payload)) ctx.addIssue({ code: z.ZodIssueCode.custom, message });
});

export type CareSummarySnapshotPayload = z.infer<typeof careSummarySnapshotPayloadShape>;

export type CareSummarySnapshotRevision = RecordRevision<"CARE_SUMMARY_SNAPSHOT", CareSummarySnapshotPayload, AtemporalMeaning, ProvenanceCore>;

/**
 * The first revision is a system derivation at patient request; later
 * revisions are lifecycle updates (preview, approval, patient-driven
 * invalidation or supersession) or system-derived source invalidation.
 */
export const careSummarySnapshotRevisionSchema = createRecordRevisionSchema(
  z.literal("CARE_SUMMARY_SNAPSHOT"),
  careSummarySnapshotPayloadSchema,
  atemporalSchema,
  provenanceCoreSchema,
).superRefine((revision, ctx) => {
  const issue = (message: string, path: string[]) => ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
  if (!(CARE_SUMMARY_SNAPSHOT_REVISION_ACTIONS as readonly string[]).includes(revision.action)) issue("UNSUPPORTED_REVISION_ACTION", ["action"]);
  if (revision.provenance.sourceKind !== "SYSTEM_DERIVATION" || revision.provenance.captureMethod !== "RULE_ENGINE") issue("SUMMARY_REQUIRES_SYSTEM_DERIVATION", ["provenance"]);
  if (revision.provenance.assistance !== "NONE") issue("SUMMARY_AI_VALIDATION_MISSING", ["provenance"]);
  if ((revision.action === "CREATE") !== (revision.revisionNumber === 1)) issue("INVALID_REVISION_LINEAGE", ["action"]);
  if (revision.action === "CREATE" && revision.payload.status !== "PREPARED") issue("SUMMARY_MUST_BEGIN_PREPARED", ["payload", "status"]);
}) as unknown as z.ZodType<CareSummarySnapshotRevision, z.ZodTypeDef, unknown>;

export const careSummarySnapshotRefSchema = createTypedRevisionRefSchema(z.literal("CARE_SUMMARY_SNAPSHOT"));

/** Content fields that may never change after `PREPARED` (domain 11.10). */
export function careSummaryContentOf(payload: CareSummarySnapshotPayload) {
  return {
    purpose: payload.purpose,
    conditionScope: payload.conditionScope,
    selectedPeriod: payload.selectedPeriod,
    asOf: payload.asOf,
    locale: payload.locale,
    selection: payload.selection,
    sections: payload.sections,
    limitations: payload.limitations,
    composition: payload.composition,
    rendering: payload.rendering,
    replacesSnapshot: payload.replacesSnapshot ?? null,
  };
}

/**
 * The canonical approved export projection whose SHA-256 is the content
 * hash (domain 11.7): purpose, scope, period, asOf, locale, ordered sections
 * with exact blocks and bindings, visible limitations, renderer and locale
 * versions. Local exclusion metadata is deliberately absent.
 */
export function careSummaryExportProjection(input: {
  purpose: CareSummaryPurpose;
  conditionScope: TypedRevisionRef<"CONDITION">[];
  selectedPeriod: CareSummarySelectedPeriod;
  asOf: Instant;
  locale: "en-SG" | "zh-SG";
  sections: CareSummarySection[];
  limitations: z.infer<typeof careSummaryLimitationSchema>[];
  rendererVersion: string;
  localePackVersion: string;
}) {
  return {
    purpose: input.purpose,
    conditionScope: input.conditionScope,
    selectedPeriod: input.selectedPeriod,
    asOf: input.asOf,
    locale: input.locale,
    sections: input.sections,
    limitations: input.limitations,
    rendererVersion: input.rendererVersion,
    localePackVersion: input.localePackVersion,
  };
}
