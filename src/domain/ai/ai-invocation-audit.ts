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
 */

export const AI_INVOCATION_OUTCOME_CODES = Object.freeze(["ACCEPTED", ...AI_REASON_CODES] as const);
export type AiInvocationOutcomeCode = (typeof AI_INVOCATION_OUTCOME_CODES)[number];

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

export const aiInvocationAuditRowSchema = z
  .strictObject({
    requestId: z.string().regex(UUID_V4),
    taskType: aiTaskTypeSchema,
    locale: z.enum(AI_LOCALES),
    requestedAt: instantSchema,
    completedAt: instantSchema,
    outcomeCode: z.enum(AI_INVOCATION_OUTCOME_CODES),
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
  })
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
  });

export type AiInvocationAuditRow = z.infer<typeof aiInvocationAuditRowSchema>;
