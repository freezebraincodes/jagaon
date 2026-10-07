import { z } from "zod";
import { AI_TASK_RUNTIME_BUNDLES } from "@/application/ai/ai-runtime-bundles";
import { deepFreeze } from "@/application/deep-freeze";
import { AI_ABSTENTION_REASONS, type AiLocale } from "@/domain/ai";
import type { Packet11RemoteTask } from "@/ai/prompts/packet-11-prompts";

/**
 * Kie Responses contracts (Packet 11B Task 2), checked against
 * docs.kie.ai/market/deepseek-v4-1-flash.md on 2026-10-04/05:
 * `POST /openai/v1/responses` with `model`, `input`, `instructions`,
 * `stream`, `reasoning.effort` (`none`/`minimal` disable reasoning) and
 * `text.format` `{ type: "json_schema", name, schema, strict }`.
 * `max_output_tokens`, `temperature` and `top_p` are documented as unsupported;
 * the legacy full-prose request never sends any of them. The hybrid shell
 * request (ai-shell-request.11b.11, rules r7) alone sends
 * `max_output_tokens`, per task: EXPLAIN 512, care 1024, and
 * `temperature` 0.2. Responses report
 * `usage` and `credits_consumed`.
 */

/**
 * Provider-facing schema contract version. kie-schema.11b.2 (Packet 11B
 * corrective pass) supersedes the unversioned 11b.1 schema: reference-bearing
 * fields carry explicit descriptions, and arrays the 11A contract already
 * requires to be unique carry uniqueItems. Kie documents no keyword-level
 * enforcement, so the 11A validator still enforces every rule after parsing.
 *
 * kie-schema.11b.3 (Packet 11B.5 Option B, owner approval 2026-10-05)
 * supersedes 11b.2: the EXPLAIN_PATTERN payload has no `limitations` property
 * (the application renders limitation copy from the approved registry) and
 * its schemaVersion enum is the runtime bundle's output version
 * (`ai-output.explain-pattern@11b.1`). The care-summary schema is unchanged.
 */
export const KIE_PROVIDER_SCHEMA_VERSION = "kie-schema.11b.3";

/** Response bodies above this many bytes are refused unread (application limit, not a provider cap). */
export const KIE_MAX_RESPONSE_BYTES = 262_144;

// --- Strict provider output schema ------------------------------------------------------------
// One closed root object (strict JSON Schema requires an object root with every property
// required); SUCCESS/ABSTAIN alternatives are explicit nulls the adapter strips before the
// 11A validator sees the candidate. Limits mirror the 11A output contracts exactly.

type JsonSchema = Record<string, unknown>;
const text = (maxLength: number): JsonSchema => ({ type: "string", minLength: 1, maxLength });
const ref = (prefix: string, description?: string): JsonSchema => ({ type: "string", pattern: `^${prefix}-[1-9][0-9]{0,2}$`, ...(description ? { description } : {}) });
/** Reference arrays are unique in the 11A contract, so they always carry uniqueItems. */
const refs = (prefix: string, minItems: number, maxItems: number, description: string): JsonSchema => ({ type: "array", description, items: ref(prefix), minItems, maxItems, uniqueItems: true });
const CLAIM_REFS = "The supplied claim reference this sentence restates. Use only the claim reference given in the input.";
const FACT_REFS = "Supplied fact references this item states, each once. Use only facts the input assigns to this claim or section.";
const closed = (properties: Record<string, JsonSchema>): JsonSchema => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });

const PAYLOADS: Record<Packet11RemoteTask, JsonSchema> = {
  EXPLAIN_PATTERN: closed({
    headline: closed({ text: text(160), claimRefs: refs("claim", 1, 4, CLAIM_REFS) }),
    observation: closed({ text: text(600), claimRefs: refs("claim", 1, 4, CLAIM_REFS) }),
    evidence: closed({ text: text(600), factRefs: refs("fact", 1, 12, FACT_REFS) }),
  }),
  DRAFT_CARE_PREPARATION_SUMMARY: closed({
    sections: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      uniqueItems: true,
      items: closed({
        sectionRef: ref("section", "The supplied section reference this group belongs to. Use only sections given in the input."),
        bullets: { type: "array", minItems: 1, maxItems: 32, items: closed({ text: text(400), factRefs: refs("fact", 1, 32, FACT_REFS) }) },
      }),
    },
  }),
};


function envelope(task: Packet11RemoteTask, locale: AiLocale): JsonSchema {
  return deepFreeze(
    closed({
      // The exact output version the 11A validator requires for this task's runtime bundle.
      schemaVersion: { type: "string", enum: [`${AI_TASK_RUNTIME_BUNDLES[task].outputSchema.id}@${AI_TASK_RUNTIME_BUNDLES[task].outputSchema.version}`] },
      taskType: { type: "string", enum: [task] },
      outcome: { type: "string", enum: ["SUCCESS", "ABSTAIN"] },
      locale: { type: "string", enum: [locale] },
      inputRefsUsed: {
        type: "array",
        description: "Every reference identifier used anywhere in this output, each exactly once, and no other. Only claim, fact, limitation or section references supplied in the input; never a new identifier.",
        items: { type: "string", pattern: "^(fact|claim|option|record|section|limitation)-[1-9][0-9]{0,2}$" },
        maxItems: 64,
        uniqueItems: true,
      },
      abstentionReason: { anyOf: [{ type: "string", enum: [...AI_ABSTENTION_REASONS] }, { type: "null" }] },
      payload: { anyOf: [PAYLOADS[task], { type: "null" }] },
    }),
  );
}

const SCHEMAS = new Map<string, JsonSchema>();
/** The immutable strict JSON Schema sent for one task and locale. */
export function providerOutputJsonSchema(task: Packet11RemoteTask, locale: AiLocale): JsonSchema {
  const key = `${task}|${locale}`;
  if (!SCHEMAS.has(key)) SCHEMAS.set(key, envelope(task, locale));
  return SCHEMAS.get(key)!;
}

export const providerOutputSchemaName = (task: Packet11RemoteTask, locale: AiLocale) => `${task.toLowerCase()}_${locale.toLowerCase().replace("-", "_")}`;

/** Drops only the explicit-null alternative of the SUCCESS/ABSTAIN envelope; everything else stays for the validator. */
export function normaliseProviderEnvelope(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const copy: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const key of ["abstentionReason", "payload"]) if (copy[key] === null) delete copy[key];
  return copy;
}

// --- Response parsing ----------------------------------------------------------------------

const count = z.number().int().min(0).max(10_000_000);
export const kieResponseSchema = z
  .object({
    status: z.string(),
    model: z.string().optional(),
    output: z.array(z.object({ type: z.string() }).passthrough()).max(16),
    usage: z.object({ input_tokens: count, output_tokens: count }).passthrough(),
    credits_consumed: z.number().finite().min(0).optional(),
  })
  .passthrough();

const messageSchema = z
  .object({
    type: z.literal("message"),
    role: z.literal("assistant").optional(),
    content: z.array(z.object({ type: z.string() }).passthrough()).max(16),
  })
  .passthrough();
const outputTextSchema = z.object({ type: z.literal("output_text"), text: z.string() }).passthrough();

/** Exactly one assistant message with exactly one `output_text` part; reasoning summaries are ignored, anything else fails. */
export function singleOutputText(output: ReadonlyArray<{ type: string }>): string | null {
  if (output.some((item) => item.type !== "message" && item.type !== "reasoning")) return null;
  const messages = output.filter((item) => item.type === "message");
  if (messages.length !== 1) return null;
  const message = messageSchema.safeParse(messages[0]);
  if (!message.success || message.data.content.length !== 1) return null;
  const part = outputTextSchema.safeParse(message.data.content[0]);
  return part.success ? part.data.text : null;
}

/**
 * Care-summary contract reconciliation (Packet 11B corrective pass). Every
 * rule the 11A care-summary contract enforces is either represented in the
 * provider-facing schema or expressible only after parsing; either way the
 * local validator enforces it. Provider enforcement of every keyword stays
 * UNDOCUMENTED (docs.kie.ai/market/deepseek-v4-1-flash, retrieved 2026-10-05).
 */
export const CARE_CONTRACT_RECONCILIATION = Object.freeze(
  [
    { rule: "required_fields", providerSchema: "REPRESENTED", localValidator: "ENFORCED", providerEnforcement: "UNDOCUMENTED", detail: "every object lists every property in required" },
    { rule: "additional_properties", providerSchema: "REPRESENTED", localValidator: "ENFORCED", providerEnforcement: "UNDOCUMENTED", detail: "additionalProperties false at every object level; zod strict objects" },
    { rule: "enums", providerSchema: "REPRESENTED", localValidator: "ENFORCED", providerEnforcement: "UNDOCUMENTED", detail: "schemaVersion, taskType, locale, outcome, abstentionReason" },
    { rule: "array_cardinality", providerSchema: "REPRESENTED", localValidator: "ENFORCED", providerEnforcement: "UNDOCUMENTED", detail: "sections 1-8; bullets 1-32; factRefs 1-32; inputRefsUsed <= 64" },
    { rule: "uniqueness", providerSchema: "REPRESENTED", localValidator: "ENFORCED", providerEnforcement: "UNDOCUMENTED", detail: "uniqueItems on sections, factRefs and inputRefsUsed (kie-schema.11b.2); bullets not unique in the contract" },
    { rule: "patterns", providerSchema: "REPRESENTED", localValidator: "ENFORCED", providerEnforcement: "UNDOCUMENTED", detail: "section-N, fact-N and request-local reference patterns" },
    { rule: "string_lengths", providerSchema: "REPRESENTED", localValidator: "ENFORCED", providerEnforcement: "UNDOCUMENTED", detail: "bullet text 1-400 characters" },
    { rule: "reference_closure", providerSchema: "NOT_EXPRESSIBLE", localValidator: "ENFORCED", providerEnforcement: "UNDOCUMENTED", detail: "only supplied sections/facts; every cited reference listed in inputRefsUsed (described, not constrained)" },
    { rule: "section_scope", providerSchema: "NOT_EXPRESSIBLE", localValidator: "ENFORCED", providerEnforcement: "UNDOCUMENTED", detail: "each bullet cites only its own section's facts" },
    { rule: "coverage_and_fidelity", providerSchema: "NOT_EXPRESSIBLE", localValidator: "ENFORCED", providerEnforcement: "UNDOCUMENTED", detail: "every supplied section and fact kept; numbers, units and dates unchanged" },
    { rule: "meaning_locale_budget", providerSchema: "NOT_EXPRESSIBLE", localValidator: "ENFORCED", providerEnforcement: "UNDOCUMENTED", detail: "forbidden meaning, authority, output locale and generated-text budget" },
  ].map((entry) => Object.freeze(entry)),
);
