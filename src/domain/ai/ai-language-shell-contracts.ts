import { z } from "zod";
import { AI_ABSTENTION_REASONS, AI_LOCALES, EXPLAINABLE_PATTERN_FAMILIES, runtimeBundleKeySchema, type AiLocale } from "./ai-task-contracts";

/**
 * Packet 11B.6 hybrid fact-slot language layer: value-blind provider input and shell output (spec
 * 2026-10-06 Sections 6.1–6.4). The provider sees slot identifiers, atom kinds, approved glosses and field
 * budgets only; never a value, date, unit, patient text or reference. Every object is strict.
 * Contract set 11b.7 (Packet 11B.7 hardening, owner decision 4): the request names the exact shell output
 * version, the slot plan version and the token inventory (every required slot id in plan field order); the
 * shell output echoes the slot plan version and the token inventory.
 * Observation ownership (owner instruction 2026-10-07, offline): every plan field names its owner. REMOTE fields are written by the
 * model; LOCAL fields by the application (today only the EXPLAIN_PATTERN observation, composed deterministically from approved copy).
 * The plan keeps every field and slot (ai-slot-plan.11b.8); the shell request, the shell output and the token inventory carry the
 * REMOTE fields only, so the EXPLAIN shell contracts are { headline, evidence } (ai-shell-input/ai-shell.explain-pattern@11b.8, slot
 * ids keep the plan numbering with gaps). Care stays @11b.7 and byte-identical in structure.
 */
export const SHELL_TASKS = Object.freeze(["EXPLAIN_PATTERN", "DRAFT_CARE_PREPARATION_SUMMARY"] as const);
export type ShellTask = (typeof SHELL_TASKS)[number];
/**
 * Packet 11C (2026-10-08): `PERIOD_SUMMARY` is an application-only atom kind. It is planned only into the LOCAL EXPLAIN observation of a
 * source-backed request and has no approved gloss, so the projector can never send it (a request carrying it is never approved).
 */
export const ATOM_KINDS = Object.freeze(["MEANING", "DECIMAL", "DECIMAL_LIST", "COUNT", "DATE", "DATE_RANGE", "TIME", "LABEL", "QUOTED_TEXT", "PERIOD_SUMMARY"] as const);
export type AtomKind = (typeof ATOM_KINDS)[number];
export const GLOSS_KEYS = Object.freeze(["MEANING_CLAUSE", "RECORDED_VALUES", "RECORDED_VALUE", "EVIDENCE_COUNT", "RECORDED_DATE", "RECORDED_DATE_RANGE", "RECORDED_TIME", "RECORDED_ITEM", "APPOINTMENT_SERVICE", "PATIENT_QUESTION"] as const);
export type GlossKey = (typeof GLOSS_KEYS)[number];
export const MAX_SLOTS = 32;
export const MAX_SHELL_SECTIONS = 8;
export const MAX_BULLETS_PER_SECTION = 32;
export const SHELL_TEXT_MAX = 400;
/**
 * Packet 11B.10 (owner instruction 2026-10-06): the fixed per-task output cap every hybrid shell request carries as
 * `max_output_tokens` (EXPLAIN 512; care 1024, above the documented worst-case care output of about 744 tokens),
 * recorded on each hybrid bundle as `shellMaxOutputTokens`. The planning budget `executionBudget.outputTokenCeiling`
 * is unchanged. Single source of truth; not configurable. (11B.9 had one cap of 512 for both tasks.)
 */
export const SHELL_MAX_OUTPUT_TOKENS = Object.freeze({ EXPLAIN_PATTERN: 512, DRAFT_CARE_PREPARATION_SUMMARY: 1024 } as const);
export type ShellMaxOutputTokens = (typeof SHELL_MAX_OUTPUT_TOKENS)[ShellTask];
/** The cap of one shell task; any other value (including inherited object keys) throws UNKNOWN_SHELL_TASK. */
export function shellMaxOutputTokens(task: ShellTask): ShellMaxOutputTokens {
  if (typeof task !== "string" || !Object.hasOwn(SHELL_MAX_OUTPUT_TOKENS, task)) throw new Error("UNKNOWN_SHELL_TASK");
  return SHELL_MAX_OUTPUT_TOKENS[task];
}
/**
 * Rules r7 (owner instruction 2026-10-06): the fixed sampling temperature of every hybrid shell request (both shell
 * providers, both layouts). Single source of truth; not configurable. The legacy full-prose request sends none.
 */
export const SHELL_TEMPERATURE = 0.2;
/**
 * The hybrid shell request profile. Owned here so the application layer can record it without importing the
 * provider adapters; re-exported by src/ai/kie/kie-shell-contracts.ts. ai-shell-request.11b.11 (rules r7): strict
 * `text.format` + per-task `max_output_tokens` (EXPLAIN 512 / care 1024) + `temperature` SHELL_TEMPERATURE (0.2).
 * ai-shell-request.11b.10 had no temperature; ai-shell-request.11b.9 had one cap (512).
 */
export const SHELL_PROVIDER_REQUEST_VERSION = "ai-shell-request.11b.11";

export type SlotId = `S${number}`;
export type SectionSlot = `C${number}`;
const SLOT_NUMBER = "(?:[1-9]|[12][0-9]|3[0-2])";
export const slotIdSchema = z.string().regex(new RegExp(`^S${SLOT_NUMBER}$`)) as unknown as z.ZodType<SlotId>;
export const sectionSlotSchema = z.string().regex(/^C[1-8]$/) as unknown as z.ZodType<SectionSlot>;
/** A fresh global matcher per call, so no lastIndex state is ever shared. */
export const slotTokenMatcher = (): RegExp => new RegExp(`\\{\\{(S${SLOT_NUMBER})\\}\\}`, "g");
export const slotToken = (slotId: SlotId): string => `{{${slotId}}}`;
export const BARE_SLOT_ID = Object.freeze(new RegExp(`\\bS${SLOT_NUMBER}\\b`));

export type ShellFieldPath = "headline" | "observation" | "evidence" | `sections[${number}].intro` | `sections[${number}].bullets[${number}]`;
export const shellFieldPathSchema = z.string().regex(/^(?:headline|observation|evidence|sections\[[0-7]\]\.intro|sections\[[0-7]\]\.bullets\[(?:[0-9]|[12][0-9]|3[01])\])$/) as unknown as z.ZodType<ShellFieldPath>;
export const sectionIntroPath = (section: number): ShellFieldPath => `sections[${section}].intro`;
export const sectionBulletPath = (section: number, bullet: number): ShellFieldPath => `sections[${section}].bullets[${bullet}]`;

/** Who writes a field's language: the remote model (REMOTE) or the application's deterministic composer (LOCAL). */
export type FieldOwner = "REMOTE" | "LOCAL";
export type ShellFieldSpec = Readonly<{ path: ShellFieldPath; requiredSlots: readonly SlotId[]; maxCodePoints: number; maxSentences: 1 | 2; mayBeAtomOnly: boolean; owner: FieldOwner }>;
export type SlotDefinition = Readonly<{ slotId: SlotId; atomKind: AtomKind; homeField: ShellFieldPath; boundRefs: readonly string[]; orderGroup: string | null; glossKey: GlossKey }>;
/** heading is null only for a section that has no approved heading (it is never invented); such a plan is remote-ineligible. */
export type PlannedSection = Readonly<{ sectionSlot: SectionSlot; sectionRef: string; sectionId: string; heading: string | null; introPath: ShellFieldPath; bulletPaths: readonly ShellFieldPath[] }>;
/**
 * ai-slot-plan.11b.9 (Packet 11C phase 2, owner decision option (a), 2026-10-08, offline): the planner's remote-eligibility accounting
 * reserves a LOCAL field at its final composed wording (slot-planner.ts). Fields, slots, budgets and the request/response shapes are
 * unchanged; the model-facing body differs from 11b.8 only in this version (the shell input's `slotPlanVersion` and the output echo).
 */
export const SLOT_PLAN_VERSION = "ai-slot-plan.11b.9";
/** Why a PLANNED slot plan may not be sent to a remote model; it is then composed deterministically. */
export type RemoteIneligibleReason = "BUDGET_EXCEEDED" | "PAYLOAD_INVALID";
export type RemoteEligibility = Readonly<{ eligible: true }> | Readonly<{ eligible: false; reason: RemoteIneligibleReason }>;
export type SlotPlan = Readonly<{
  planVersion: typeof SLOT_PLAN_VERSION;
  taskType: ShellTask;
  locale: AiLocale;
  runtimeBundleKey: string;
  claimFamily: (typeof EXPLAINABLE_PATTERN_FAMILIES)[number] | null;
  fields: readonly ShellFieldSpec[];
  slots: readonly SlotDefinition[];
  sections: readonly PlannedSection[];
  remote: RemoteEligibility;
}>;
/** The model-owned fields of a plan, in plan order. */
export const remoteFields = (plan: Pick<SlotPlan, "fields">): readonly ShellFieldSpec[] => plan.fields.filter((field) => field.owner === "REMOTE");
/** The application-owned fields of a plan, in plan order. */
export const localFields = (plan: Pick<SlotPlan, "fields">): readonly ShellFieldSpec[] => plan.fields.filter((field) => field.owner === "LOCAL");
/** The token inventory the model sees and echoes: the REMOTE fields' required slots in plan field order. */
export const remoteTokenInventory = (plan: Pick<SlotPlan, "fields">): SlotId[] => remoteFields(plan).flatMap((field) => field.requiredSlots);
export type AtomEntry = Readonly<{ text: string; boundRefs: readonly string[] }>;
export type AtomTable = Readonly<Partial<Record<SlotId, AtomEntry>>>;

export const SHELL_INPUT_VERSIONS = Object.freeze({ EXPLAIN_PATTERN: "ai-shell-input.explain-pattern@11b.8", DRAFT_CARE_PREPARATION_SUMMARY: "ai-shell-input.draft-care-preparation-summary@11b.7" } as const);
export const SHELL_OUTPUT_VERSIONS = Object.freeze({ EXPLAIN_PATTERN: "ai-shell.explain-pattern@11b.8", DRAFT_CARE_PREPARATION_SUMMARY: "ai-shell.draft-care-preparation-summary@11b.7" } as const);
const tokenInventorySchema = z.array(slotIdSchema).min(1).max(MAX_SLOTS);

const fieldSpecSchema = z.strictObject({
  path: shellFieldPathSchema,
  requiredSlots: z.array(slotIdSchema).max(MAX_SLOTS),
  maxCodePoints: z.number().int().min(1).max(SHELL_TEXT_MAX),
  maxSentences: z.union([z.literal(1), z.literal(2)]),
  mayBeAtomOnly: z.boolean(),
});
/** The EXPLAIN remote layout (@11b.8): the observation is application-owned and never part of the shell request or output. */
const EXPLAIN_FIELD_ORDER = Object.freeze(["headline", "evidence"]);

function closeShellRequest(value: { taskType: ShellTask; shellInputVersion: string; shellSchemaVersion: string; tokenInventory: string[]; claimFamily: string | null; fields: Array<{ path: string; requiredSlots: string[] }>; slots: Array<{ slotId: string }>; sections: Array<{ sectionSlot: string; introPath: string; bulletPaths: string[] }> }, ctx: z.RefinementCtx) {
  const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  if (value.shellInputVersion !== SHELL_INPUT_VERSIONS[value.taskType]) issue("SHELL_INPUT_VERSION_MISMATCH");
  if (value.shellSchemaVersion !== SHELL_OUTPUT_VERSIONS[value.taskType]) issue("SHELL_SCHEMA_VERSION_MISMATCH");
  const defined = value.slots.map((slot) => slot.slotId);
  if (new Set(defined).size !== defined.length) issue("DUPLICATE_SLOT");
  const required = value.fields.flatMap((field) => field.requiredSlots);
  if (new Set(required).size !== required.length) issue("SLOT_REQUIRED_TWICE");
  if (required.some((slotId) => !defined.includes(slotId))) issue("UNDEFINED_SLOT");
  if (defined.some((slotId) => !required.includes(slotId))) issue("UNBOUND_SLOT");
  // The inventory is exactly the required slots in plan field order: nothing missing, extra, repeated or reordered. Slot ids
  // keep the plan numbering, so a remote request may skip the ids of application-owned fields (no contiguity is assumed).
  if (value.tokenInventory.join("|") !== required.join("|")) issue("TOKEN_INVENTORY_MISMATCH");
  const paths = value.fields.map((field) => field.path);
  if (value.taskType === "EXPLAIN_PATTERN") {
    if (paths.join("|") !== EXPLAIN_FIELD_ORDER.join("|") || value.sections.length > 0 || value.claimFamily === null) issue("FIELD_LAYOUT_INVALID");
  } else {
    const expected = value.sections.flatMap((section, index) => [section.introPath, ...section.bulletPaths].map((path, position) => (position === 0 ? (path === `sections[${index}].intro` ? path : "!") : path === `sections[${index}].bullets[${position - 1}]` ? path : "!")));
    const slotsInOrder = value.sections.every((section, index) => section.sectionSlot === `C${index + 1}`);
    if (value.claimFamily !== null || value.sections.length === 0 || !slotsInOrder || expected.includes("!") || expected.join("|") !== paths.join("|")) issue("FIELD_LAYOUT_INVALID");
  }
}

export const shellTaskRequestSchema = z
  .strictObject({
    shellInputVersion: z.string().min(1).max(64),
    shellSchemaVersion: z.string().min(1).max(64),
    slotPlanVersion: z.literal(SLOT_PLAN_VERSION),
    taskType: z.enum(SHELL_TASKS),
    locale: z.enum(AI_LOCALES),
    runtimeBundleKey: runtimeBundleKeySchema,
    claimFamily: z.enum(EXPLAINABLE_PATTERN_FAMILIES).nullable(),
    tokenInventory: tokenInventorySchema,
    fields: z.array(fieldSpecSchema).min(2).max(MAX_SHELL_SECTIONS + MAX_SLOTS),
    slots: z.array(z.strictObject({ slotId: slotIdSchema, atomKind: z.enum(ATOM_KINDS), gloss: z.string().min(1).max(160) })).min(1).max(MAX_SLOTS),
    sections: z.array(z.strictObject({ sectionSlot: sectionSlotSchema, heading: z.string().min(1).max(80), introPath: shellFieldPathSchema, bulletPaths: z.array(shellFieldPathSchema).min(1).max(MAX_BULLETS_PER_SECTION) })).max(MAX_SHELL_SECTIONS),
  })
  .superRefine((value, ctx) => closeShellRequest(value as never, ctx)) as unknown as z.ZodType<ShellTaskRequest>;

export type ShellTaskRequest = Readonly<{
  shellInputVersion: string;
  shellSchemaVersion: string;
  slotPlanVersion: typeof SLOT_PLAN_VERSION;
  taskType: ShellTask;
  locale: AiLocale;
  runtimeBundleKey: string;
  claimFamily: (typeof EXPLAINABLE_PATTERN_FAMILIES)[number] | null;
  tokenInventory: ReadonlyArray<SlotId>;
  fields: ReadonlyArray<{ path: ShellFieldPath; requiredSlots: SlotId[]; maxCodePoints: number; maxSentences: 1 | 2; mayBeAtomOnly: boolean }>;
  slots: ReadonlyArray<{ slotId: SlotId; atomKind: AtomKind; gloss: string }>;
  sections: ReadonlyArray<{ sectionSlot: SectionSlot; heading: string; introPath: ShellFieldPath; bulletPaths: ShellFieldPath[] }>;
}>;

const shellText = z.string().min(1).max(SHELL_TEXT_MAX);
/** @11b.8: the model writes the EXPLAIN headline and evidence only; an observation key is unknown (strict) and rejected. */
export const explainShellsSchema = z.strictObject({ headline: shellText, evidence: shellText });
export const careShellsSchema = z.strictObject({
  sections: z.array(z.strictObject({ sectionSlot: sectionSlotSchema, intro: shellText, bullets: z.array(shellText).min(1).max(MAX_BULLETS_PER_SECTION) })).min(1).max(MAX_SHELL_SECTIONS),
});
export type ExplainShells = z.infer<typeof explainShellsSchema>;
export type CareShells = z.infer<typeof careShellsSchema>;

export function shellOutputSchema(task: ShellTask) {
  const shells = task === "EXPLAIN_PATTERN" ? explainShellsSchema : careShellsSchema;
  const common = { schemaVersion: z.literal(SHELL_OUTPUT_VERSIONS[task]), slotPlanVersion: z.literal(SLOT_PLAN_VERSION), tokenInventory: tokenInventorySchema, taskType: z.literal(task), locale: z.enum(AI_LOCALES) };
  return z.union([
    z.strictObject({ ...common, outcome: z.literal("SUCCESS"), abstentionReason: z.null(), shells }),
    z.strictObject({ ...common, outcome: z.literal("ABSTAIN"), abstentionReason: z.enum(AI_ABSTENTION_REASONS), shells: z.null() }),
  ]);
}

/** Shell text by field path in plan order, produced by gate S2. */
export type ShellTexts = ReadonlyMap<ShellFieldPath, string>;
