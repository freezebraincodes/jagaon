import { deepFreeze } from "@/application/deep-freeze";
import { AI_ABSTENTION_REASONS, MAX_SLOTS, SHELL_OUTPUT_VERSIONS, SLOT_PLAN_VERSION, type AiLocale, type ShellTask } from "@/domain/ai";

/**
 * Provider-facing strict JSON schema for shells (Packet 11B.6). One closed root object with every property
 * required; no reference property exists. The domain shell schema and the shell validator still enforce every
 * rule after parsing. kie-schema.11b.3 (full prose) is unchanged evidence.
 * kie-schema.11b.5 (Packet 11B.7): the two 11b.7 echo fields — slotPlanVersion as an exact one-value enum and
 * tokenInventory as an array of slot-id patterns — in parity with the domain shell schema; moves with prompt 11b.13.
 * kie-schema.11b.6 (observation ownership, owner instruction 2026-10-07, offline): the EXPLAIN shells object is the closed
 * { headline, evidence } (the application composes the observation), in parity with ai-shell.explain-pattern@11b.8; care unchanged.
 */
export const SHELL_PROVIDER_SCHEMA_VERSION = "kie-schema.11b.6";
/**
 * Shell request profile ai-shell-request.11b.11 (rules r7): strict text.format + per-task max_output_tokens
 * (SHELL_MAX_OUTPUT_TOKENS: EXPLAIN 512, care 1024), chosen by the schema-parsed task in the shared builder's
 * SLOT_SHELL_CONTRACT, + the fixed temperature SHELL_TEMPERATURE (0.2) (ai-shell-request.11b.10 had no temperature;
 * ai-shell-request.11b.9 had one cap, 512). The literal lives in the domain
 * module so the application layer can record it without importing the provider adapters.
 */
export { SHELL_PROVIDER_REQUEST_VERSION } from "@/domain/ai";
type JsonSchema = Record<string, unknown>;
const text = (maxLength: number): JsonSchema => ({ type: "string", minLength: 1, maxLength });
const closed = (properties: Record<string, JsonSchema>): JsonSchema => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const PAYLOADS: Record<ShellTask, JsonSchema> = {
  EXPLAIN_PATTERN: closed({ headline: text(400), evidence: text(400) }),
  DRAFT_CARE_PREPARATION_SUMMARY: closed({
    sections: { type: "array", minItems: 1, maxItems: 8, items: closed({ sectionSlot: { type: "string", pattern: "^C[1-8]$" }, intro: text(400), bullets: { type: "array", minItems: 1, maxItems: 32, items: text(400) } }) },
  }),
};
const CACHE = new Map<string, JsonSchema>();
export function shellOutputJsonSchema(task: ShellTask, locale: AiLocale): JsonSchema {
  const key = `${task}|${locale}`;
  if (!CACHE.has(key)) {
    CACHE.set(key, deepFreeze(closed({
      schemaVersion: { type: "string", enum: [SHELL_OUTPUT_VERSIONS[task]] },
      slotPlanVersion: { type: "string", enum: [SLOT_PLAN_VERSION] },
      tokenInventory: { type: "array", minItems: 1, maxItems: MAX_SLOTS, items: { type: "string", pattern: "^S([1-9]|[12][0-9]|3[0-2])$" } },
      taskType: { type: "string", enum: [task] },
      outcome: { type: "string", enum: ["SUCCESS", "ABSTAIN"] },
      locale: { type: "string", enum: [locale] },
      abstentionReason: { anyOf: [{ type: "string", enum: [...AI_ABSTENTION_REASONS] }, { type: "null" }] },
      shells: { anyOf: [PAYLOADS[task], { type: "null" }] },
    })));
  }
  return CACHE.get(key)!;
}
export const shellOutputSchemaName = (task: ShellTask, locale: AiLocale) => `${task.toLowerCase()}_shell_${locale.toLowerCase().replace("-", "_")}`;
