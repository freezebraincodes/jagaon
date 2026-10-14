import { DEEPSEEK_DOCUMENTED_MODELS, DEEPSEEK_FLASH_PEAK_USD_PER_MILLION } from "@/ai/deepseek/deepseek-catalogue";
import type { KieModelSnapshot } from "@/ai/kie/kie-model-catalogue";
import { minimumReasoningEffort } from "@/ai/kie/kie-route-config";
import { medicineInfoReplyJsonSchema, type MedicineInfoRequest } from "@/domain/medicine-info/medicine-info-contract";
import { buildMedicineInfoPromptMessages } from "@/domain/medicine-info/medicine-info-prompt";

/**
 * HSA preview (owner decision 2026-10-14, "Get general information with AI"): the model-facing request of one medicine-information
 * lookup (request profile medicine-info-request.1). Server-only. Same shape rules as the feelings-chat and transcript-extraction bodies
 * (Direct DeepSeek Responses, `instructions` layout, stream and store off, minimum reasoning effort, strict `text.format`), with this
 * task's own prompt, schema, sampling and cap:
 * - `instructions` is the versioned system prompt (medicine-info-prompt.1, few-shot examples included);
 * - the ONE user message is exactly {"medicineName": ...} from the schema-parsed request: never her directions, readings, name, dates or
 *   record IDs;
 * - nothing in the body comes from configuration, environment or the caller except the schema-parsed request.
 */
export const MEDICINE_INFO_REQUEST_PROFILE = "medicine-info-request.1";
export const MEDICINE_INFO_SCHEMA_NAME = "medicine_info_1";
/** General facts, not variety: the lowest temperature. */
export const MEDICINE_INFO_TEMPERATURE = 0;
/** Two texts of at most 300 characters, two names and the JSON framing stay well below it. */
export const MEDICINE_INFO_MAX_OUTPUT_TOKENS = 512;
/** The fixed model: the same documented deepseek-flash entry the other routes use. */
export const MEDICINE_INFO_MODEL_ID = "deepseek-flash";
/** Input tokens added to every bound for message framing (same margin as the other routes). */
export const MEDICINE_INFO_INPUT_MARGIN_TOKENS = 256;

/** The route's fixed model snapshot, from the documented deepseek-flash entry (as the other routes build it). */
export function medicineInfoModel(): KieModelSnapshot | null {
  const documented = DEEPSEEK_DOCUMENTED_MODELS.find((model) => model.requestModelId === MEDICINE_INFO_MODEL_ID);
  if (!documented) return null;
  return Object.freeze({
    requestModelId: documented.requestModelId,
    responseModelSnapshot: documented.responseModelSnapshot,
    provenance: documented.provenance,
    endpoint: documented.endpoint,
    contextWindow: null,
    defaultReasoningLevel: null,
    supportedReasoningLevels: documented.supportedReasoningLevels,
    retrievedAt: documented.documentedAt,
    documentationUrl: documented.documentationUrl,
  });
}

/** The exact model-facing body for one schema-parsed request. Key order is part of the contract. */
export function buildMedicineInfoBody(request: MedicineInfoRequest, model: KieModelSnapshot): Readonly<{ body: Record<string, unknown>; bodyText: string }> | null {
  const effort = minimumReasoningEffort(model);
  if (effort === null) return null;
  const [system, user] = buildMedicineInfoPromptMessages(request);
  if (!system || !user) return null;
  const body = {
    model: model.requestModelId,
    stream: false,
    store: false,
    instructions: system.text,
    input: [{ role: "user", content: [{ type: "input_text", text: user.text }] }],
    reasoning: { effort },
    text: { format: { type: "json_schema", name: MEDICINE_INFO_SCHEMA_NAME, schema: medicineInfoReplyJsonSchema(), strict: true } },
    temperature: MEDICINE_INFO_TEMPERATURE,
    max_output_tokens: MEDICINE_INFO_MAX_OUTPUT_TOKENS,
  };
  return Object.freeze({ body, bodyText: JSON.stringify(body) });
}

/** Pre-send upper bound of one call with a body of `bodyByteCount` UTF-8 bytes: every byte one input token, the full cap, peak prices. */
export function medicineInfoCallUpperBound(bodyByteCount: number): Readonly<{ inputTokens: number; outputTokens: number; costMicroUsd: number; basis: "UPPER_BOUND" }> {
  if (!Number.isSafeInteger(bodyByteCount) || bodyByteCount < 0) throw new Error("INVALID_BODY_BYTE_COUNT");
  const inputTokens = bodyByteCount + MEDICINE_INFO_INPUT_MARGIN_TOKENS;
  const outputTokens = MEDICINE_INFO_MAX_OUTPUT_TOKENS;
  const costMicroUsd = Math.ceil(inputTokens * DEEPSEEK_FLASH_PEAK_USD_PER_MILLION.inputCacheMiss + outputTokens * DEEPSEEK_FLASH_PEAK_USD_PER_MILLION.output);
  return Object.freeze({ inputTokens, outputTokens, costMicroUsd, basis: "UPPER_BOUND" as const });
}
