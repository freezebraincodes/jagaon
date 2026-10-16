import { DEEPSEEK_DOCUMENTED_MODELS, DEEPSEEK_FLASH_PEAK_USD_PER_MILLION } from "@/ai/deepseek/deepseek-catalogue";
import type { KieModelSnapshot } from "@/ai/kie/kie-model-catalogue";
import { minimumReasoningEffort } from "@/ai/kie/kie-route-config";
import { feelingsChatReplyJsonSchema, type FeelingsChatRequest } from "@/domain/feelings-chat/feelings-chat-contract";
import { buildFeelingsChatPromptMessages } from "@/domain/feelings-chat/feelings-chat-prompt";

/**
 * Tell JagaOn understands more (design §3.8): the model-facing request of one feelings-chat turn (request profile
 * feelings-chat-request.1). Server-only. Same shape rules as the transcript-extraction body (Direct DeepSeek Responses, `instructions`
 * layout, stream and store off, minimum reasoning effort, strict `text.format`), with this task's own prompt, schema, sampling and cap:
 * - `instructions` is the versioned system prompt (feelings-chat-prompt.1, few-shot examples included);
 * - the ONE user message is exactly {turn, maxTurns, messages} from the schema-parsed request: her words in this chat and JagaOn's
 *   questions, never readings, medicines from her records, her name, dates or record IDs;
 * - nothing in the body comes from configuration, environment or the caller except the schema-parsed request.
 */
export const FEELINGS_CHAT_REQUEST_PROFILE = "feelings-chat-request.1";
export const FEELINGS_CHAT_SCHEMA_NAME = "feelings_chat_1";
/** A little variation for natural questions; the validator, not the sampling, keeps them safe. */
export const FEELINGS_CHAT_TEMPERATURE = 0.3;
/** One question or one wrap-up (summary ≤ 160 and doctor question ≤ 200 characters) with JSON framing stays well below it. */
export const FEELINGS_CHAT_MAX_OUTPUT_TOKENS = 512;
/** The fixed model: the same documented deepseek-flash entry the existing routes use. */
export const FEELINGS_CHAT_MODEL_ID = "deepseek-flash";
/** Input tokens added to every bound for message framing (same margin as the other routes). */
export const FEELINGS_CHAT_INPUT_MARGIN_TOKENS = 256;

/** The route's fixed model snapshot, from the documented deepseek-flash entry (as the transcript route builds it). */
export function feelingsChatModel(): KieModelSnapshot | null {
  const documented = DEEPSEEK_DOCUMENTED_MODELS.find((model) => model.requestModelId === FEELINGS_CHAT_MODEL_ID);
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
export function buildFeelingsChatBody(request: FeelingsChatRequest, model: KieModelSnapshot): Readonly<{ body: Record<string, unknown>; bodyText: string }> | null {
  const effort = minimumReasoningEffort(model);
  if (effort === null) return null;
  const [system, user] = buildFeelingsChatPromptMessages(request);
  if (!system || !user) return null;
  const body = {
    model: model.requestModelId,
    stream: false,
    store: false,
    instructions: system.text,
    input: [{ role: "user", content: [{ type: "input_text", text: user.text }] }],
    reasoning: { effort },
    text: { format: { type: "json_schema", name: FEELINGS_CHAT_SCHEMA_NAME, schema: feelingsChatReplyJsonSchema(), strict: true } },
    temperature: FEELINGS_CHAT_TEMPERATURE,
    max_output_tokens: FEELINGS_CHAT_MAX_OUTPUT_TOKENS,
  };
  return Object.freeze({ body, bodyText: JSON.stringify(body) });
}

/** Pre-send upper bound of one call with a body of `bodyByteCount` UTF-8 bytes: every byte one input token, the full cap, peak prices. */
export function feelingsChatCallUpperBound(bodyByteCount: number): Readonly<{ inputTokens: number; outputTokens: number; costMicroUsd: number; basis: "UPPER_BOUND" }> {
  if (!Number.isSafeInteger(bodyByteCount) || bodyByteCount < 0) throw new Error("INVALID_BODY_BYTE_COUNT");
  const inputTokens = bodyByteCount + FEELINGS_CHAT_INPUT_MARGIN_TOKENS;
  const outputTokens = FEELINGS_CHAT_MAX_OUTPUT_TOKENS;
  const costMicroUsd = Math.ceil(inputTokens * DEEPSEEK_FLASH_PEAK_USD_PER_MILLION.inputCacheMiss + outputTokens * DEEPSEEK_FLASH_PEAK_USD_PER_MILLION.output);
  return Object.freeze({ inputTokens, outputTokens, costMicroUsd, basis: "UPPER_BOUND" as const });
}
