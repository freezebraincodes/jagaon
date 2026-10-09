import { z } from "zod";
import { instantSchema, recordIdSchema, recordTypeSchema, revisionIdSchema } from "@/domain/shared";
import { AI_LOCALES, AI_REASON_CODES, aiTaskTypeSchema, runtimeBundleKeySchema, type AiTaskType } from "./ai-task-contracts";

/**
 * The minimal local AI invocation audit row (storage-backup-spec 2.7, 4.6 and
 * 6.6; Packet 11A). It records which exact runtime versions ran, the closed
 * terminal outcome and bounded technical measurements. It has no free-text
 * slot: every string is an identifier, a version or a closed code, so it cannot
 * hold a prompt, provider payload, raw response, rendered output, credential,
 * fingerprint or copied health value. Local source revisions and a downstream
 * reference stay inside this audit boundary and are reconciled by permanent
 * deletion and restore.
 *
 * Packet 11C Addendum C, Task C5 (owner decision C5-a: explicit, truthful outcome codes with a versioned audit and backup compatibility).
 * Two schema versions validate:
 * - ai-invocation-audit.11a.1 (LEGACY): every row written before C5, exactly as Packet 11A–11C CP5 wrote it. It carries no version
 *   field and its outcome is closed to ACCEPTED plus the 22 matrix reason codes; such rows keep validating, backing up and restoring
 *   byte-identically, and a legacy-shaped row can never carry a newer code or field.
 * - ai-invocation-audit.11c.2 (CURRENT): every new row. It names its version (`auditSchemaVersion`), may carry the audit-only outcome
 *   codes below, and records the basis of its usage measurements (`usageBasis`): NONE (nothing was sent), REPORTED (only
 *   provider-reported usage was counted) or UPPER_BOUND (at least one potentially billed call without readable usage was counted at
 *   its pre-send upper bound, never as zero).
 * The audit-only codes are a separate list: never a matrix reason code, a provider failure reason, a route body or any model-facing
 * contract. There is no backup payload, Dexie or index change (the row is self-describing inside the version 1 backup payload).
 */

export const AI_INVOCATION_AUDIT_LEGACY_SCHEMA_VERSION = "ai-invocation-audit.11a.1" as const;
export const AI_INVOCATION_AUDIT_SCHEMA_VERSION = "ai-invocation-audit.11c.2" as const;

/** The legacy (11a.1) outcome vocabulary: ACCEPTED plus the 22 matrix reason codes. */
export const AI_INVOCATION_OUTCOME_CODES_11A = Object.freeze(["ACCEPTED", ...AI_REASON_CODES] as const);

/**
 * Audit-only outcomes of an explicit AI request (11c.2 rows only):
 * - REMOTE_USE_DECLINED: the patient cancelled the remote-use disclosure (Cancel or Escape); nothing was sent.
 * - DISCLOSURE_CLOSED_MOOT: the disclosure closed without a decision because the request became moot (locale, period or view change,
 *   or the screen closed); nothing was sent.
 * - NOT_ELIGIBLE: the request could not be formed for its source (care preview not eligible, comparison no longer explainable).
 * - SOURCE_UNAVAILABLE: the local source could not be read for the request.
 * - REQUEST_CLASS_NOT_QUALIFIED (C1): the request's shape class is not qualified for remote wording.
 * - SPEND_CEILING_REACHED, SPEND_NOT_CONFIGURED, SPEND_LEDGER_UNAVAILABLE (C6): the server-side spend enforcement refused the call.
 * - ORIGIN_REJECTED, ACCESS_DENIED (C6): the request origin or access check refused the call.
 */
export const AI_AUDIT_ONLY_OUTCOME_CODES = Object.freeze([
  "REMOTE_USE_DECLINED",
  "DISCLOSURE_CLOSED_MOOT",
  "NOT_ELIGIBLE",
  "SOURCE_UNAVAILABLE",
  "REQUEST_CLASS_NOT_QUALIFIED",
  "SPEND_CEILING_REACHED",
  "SPEND_NOT_CONFIGURED",
  "SPEND_LEDGER_UNAVAILABLE",
  "ORIGIN_REJECTED",
  "ACCESS_DENIED",
] as const);
export type AiAuditOnlyOutcomeCode = (typeof AI_AUDIT_ONLY_OUTCOME_CODES)[number];
/** Audit-only outcomes decided before anything is sent: such a row never records an attempt. */
export const AI_AUDIT_UNSENT_OUTCOME_CODES = Object.freeze(["REMOTE_USE_DECLINED", "DISCLOSURE_CLOSED_MOOT", "NOT_ELIGIBLE", "SOURCE_UNAVAILABLE"] as const satisfies readonly AiAuditOnlyOutcomeCode[]);

/** The current (11c.2) outcome vocabulary: the legacy codes plus the audit-only codes. */
export const AI_INVOCATION_OUTCOME_CODES = Object.freeze([...AI_INVOCATION_OUTCOME_CODES_11A, ...AI_AUDIT_ONLY_OUTCOME_CODES] as const);
export type AiInvocationOutcomeCode = (typeof AI_INVOCATION_OUTCOME_CODES)[number];

export const AI_AUDIT_USAGE_BASES = Object.freeze(["NONE", "REPORTED", "UPPER_BOUND"] as const);
export type AiAuditUsageBasis = (typeof AI_AUDIT_USAGE_BASES)[number];

/** The only record an accepted task may name downstream (domain-schema-spec 11.7 and Inquiry presentation). */
export const AI_AUDIT_DOWNSTREAM_RECORD_TYPES = Object.freeze({
  DRAFT_CARE_PREPARATION_SUMMARY: "CARE_SUMMARY_SNAPSHOT",
  DRAFT_NEUTRAL_INQUIRY: "INQUIRY",
} as const satisfies Partial<Record<AiTaskType, string>>);

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSION = /^\d{1,3}[a-z]?\.\d{1,3}(?:-absent)?$/;
const kebab = (taskType: string) => taskType.toLowerCase().replaceAll("_", "-");

const componentSchema = z.strictObject({ id: z.string().regex(/^ai-[a-z]+\.[a-z0-9-]+(?:\.(?:en|zh)-sg)?$/).max(96), version: z.string().regex(VERSION) });
const COMPONENT_PREFIXES = Object.freeze({
  capabilityProfile: "ai-capability",
  promptTemplate: "ai-prompt",
  inputSchema: "ai-input",
  outputSchema: "ai-output",
  validatorProfile: "ai-validator",
  localePack: "ai-locale",
  fallbackProfile: "ai-fallback",
  fixtureSet: "ai-fixtures",
} as const);
const componentsSchema = z.strictObject(Object.fromEntries(Object.keys(COMPONENT_PREFIXES).map((key) => [key, componentSchema])) as Record<keyof typeof COMPONENT_PREFIXES, typeof componentSchema>);

const localRevisionSchema = z.strictObject({ recordType: recordTypeSchema, recordId: recordIdSchema, revisionId: revisionIdSchema });
const boundedCount = (max: number) => z.number().int().min(0).max(max).nullable();

/** The 11A row fields, in their original order, with the outcome vocabulary of the version. */
const rowFields = <T extends readonly [string, ...string[]]>(outcomeCodes: T) => ({
  requestId: z.string().regex(UUID_V4),
  taskType: aiTaskTypeSchema,
  locale: z.enum(AI_LOCALES),
  requestedAt: instantSchema,
  completedAt: instantSchema,
  outcomeCode: z.enum(outcomeCodes),
  routeProfileKey: z.string().regex(/^[a-z][a-z0-9-]{0,47}\.\d{1,3}[a-z]?\.\d{1,3}$/),
  runtimeBundleKey: runtimeBundleKeySchema,
  activationManifestVersion: z.string().regex(/^ai-activation\.\d{1,3}[a-z]?\.\d{1,3}$/),
  components: componentsSchema,
  logicalTier: z.enum(["LIGHT", "BALANCED", "STRONG"]),
  providerModel: z.strictObject({ providerKey: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/), modelSnapshot: z.string().regex(/^[a-z0-9][a-z0-9._:/-]{0,95}$/i) }).nullable(),
  attempts: z.strictObject({ count: z.number().int().min(0).max(2), structuralRepairUsed: z.boolean(), timedOut: z.boolean() }),
  measurements: z.strictObject({ inputTokens: boundedCount(100_000), outputTokens: boundedCount(100_000), latencyMs: boundedCount(600_000), costMicroUsd: boundedCount(10_000_000) }),
  sourceRevisions: z.array(localRevisionSchema).max(1024),
  downstream: localRevisionSchema.nullable(),
});

/** ai-invocation-audit.11a.1: the legacy row, unchanged (no version field; the 11A outcome vocabulary). */
const legacyRowSchema = z.strictObject(rowFields(AI_INVOCATION_OUTCOME_CODES_11A));
/** ai-invocation-audit.11c.2: the current row (explicit version, the full outcome vocabulary, the usage basis). */
const currentRowSchema = z.strictObject({
  auditSchemaVersion: z.literal(AI_INVOCATION_AUDIT_SCHEMA_VERSION),
  ...rowFields(AI_INVOCATION_OUTCOME_CODES),
  usageBasis: z.enum(AI_AUDIT_USAGE_BASES),
});

export const aiInvocationAuditRowSchema = z
  .union([currentRowSchema, legacyRowSchema])
  .superRefine((row, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    if (Date.parse(row.completedAt) < Date.parse(row.requestedAt)) issue("COMPLETED_BEFORE_REQUESTED");

    // Every pinned component belongs to this row's task, and the locale pack to its locale.
    const name = kebab(row.taskType);
    if (!row.runtimeBundleKey.startsWith(`ai.${name}@`)) issue("BUNDLE_TASK_MISMATCH");
    for (const [key, prefix] of Object.entries(COMPONENT_PREFIXES)) {
      const expected = key === "localePack" ? `${prefix}.${name}.${row.locale.toLowerCase()}` : `${prefix}.${name}`;
      if (row.components[key as keyof typeof COMPONENT_PREFIXES].id !== expected) issue("COMPONENT_MISMATCH");
    }

    // Nothing transmitted: no provider, attempt, provider measurement or patient reference.
    if (row.attempts.count === 0) {
      const { inputTokens, outputTokens, costMicroUsd } = row.measurements;
      if (row.providerModel || row.attempts.structuralRepairUsed || row.attempts.timedOut || inputTokens !== null || outputTokens !== null || costMicroUsd !== null || row.sourceRevisions.length > 0 || row.downstream) {
        issue("UNTRANSMITTED_ROW_CARRIES_PROVIDER_DATA");
      }
    } else if (!row.providerModel) issue("ATTEMPT_WITHOUT_PROVIDER");
    if (row.attempts.structuralRepairUsed && row.attempts.count < 2) issue("REPAIR_WITHOUT_SECOND_ATTEMPT");

    const revisions = row.sourceRevisions.map((source) => source.revisionId);
    if (new Set(revisions).size !== revisions.length) issue("DUPLICATE_SOURCE_REVISION");

    if (row.downstream) {
      const owner = (AI_AUDIT_DOWNSTREAM_RECORD_TYPES as Partial<Record<AiTaskType, string>>)[row.taskType];
      if (row.outcomeCode !== "ACCEPTED" || row.downstream.recordType !== owner) issue("DOWNSTREAM_NOT_OWNED");
    }

    // 11c.2: the usage basis is NONE exactly when nothing was sent, and an outcome decided before sending never has an attempt.
    if ("auditSchemaVersion" in row) {
      if ((row.usageBasis === "NONE") !== (row.attempts.count === 0)) issue("USAGE_BASIS_MISMATCH");
      if ((AI_AUDIT_UNSENT_OUTCOME_CODES as readonly string[]).includes(row.outcomeCode) && row.attempts.count !== 0) issue("UNSENT_OUTCOME_WITH_ATTEMPT");
    }
  });

/** A row of either version (what storage, backup and restore hold). */
export type AiInvocationAuditRow = z.infer<typeof aiInvocationAuditRowSchema>;
/** A row of the current version (what the services write). */
export type CurrentAiInvocationAuditRow = z.infer<typeof currentRowSchema>;
export type LegacyAiInvocationAuditRow = z.infer<typeof legacyRowSchema>;

export function aiInvocationAuditSchemaVersionOf(row: AiInvocationAuditRow): typeof AI_INVOCATION_AUDIT_SCHEMA_VERSION | typeof AI_INVOCATION_AUDIT_LEGACY_SCHEMA_VERSION {
  return "auditSchemaVersion" in row ? row.auditSchemaVersion : AI_INVOCATION_AUDIT_LEGACY_SCHEMA_VERSION;
}
