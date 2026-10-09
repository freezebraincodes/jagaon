import { createHash } from "node:crypto";
import { canonicalizeJson } from "@/application/contracts/canonical-json";
import { DEEPSEEK_DOCUMENTED_MODELS, DEEPSEEK_FLASH_PEAK_USD_PER_MILLION } from "@/ai/deepseek/deepseek-catalogue";
import type { KieModelSnapshot } from "@/ai/kie/kie-model-catalogue";
import { minimumReasoningEffort } from "@/ai/kie/kie-route-config";
import { TRANSCRIPT_EXTRACTION_CONTRACT_VERSION, extractionOutputJsonSchema, type ExtractionRequest } from "@/domain/transcript-extraction/transcript-extraction-contract";
import { TRANSCRIPT_EXTRACTION_LEXICON_VERSION } from "@/domain/transcript-extraction/transcript-extraction-lexicon";
import { TRANSCRIPT_EXTRACTION_VALIDATOR_VERSION } from "@/domain/transcript-extraction/transcript-extraction-validator";
import { TRANSCRIPT_EXTRACTION_PROMPT, TRANSCRIPT_EXTRACTION_PROMPT_VERSION } from "./transcript-extraction-prompt";

/**
 * Packet 13 (P13X): the model-facing request of EXTRACT_VOICE_FACTS (request profile transcript-extraction-request.13.1). Server-only.
 * Same shape rules as the frozen 11C shell body (Direct DeepSeek Responses, `instructions` layout, stream and store off, minimum
 * reasoning effort, strict `text.format`), with this task's own prompt, schema, sampling and cap:
 * - the user message is exactly {locale, allowedFactKinds, transcript} (the minimum approved transcript and context);
 * - temperature 0 (extraction, not wording); max_output_tokens 1,536 (8 facts + 8 unsupported spans of up to 200 code points);
 * - nothing in the body comes from configuration, environment or the caller except the schema-parsed request.
 * The contract digest binds every model-facing element plus the validator and lexicon versions; the qualification record names it.
 */
export const TRANSCRIPT_EXTRACTION_REQUEST_PROFILE = "transcript-extraction-request.13.1";
export const TRANSCRIPT_EXTRACTION_SCHEMA_NAME = "transcript_extraction_13_1";
export const TRANSCRIPT_EXTRACTION_TEMPERATURE = 0;
export const TRANSCRIPT_EXTRACTION_MAX_OUTPUT_TOKENS = 1_536;
export const TRANSCRIPT_EXTRACTION_MODEL_ID = "deepseek-flash";
/** Input tokens added to every bound for message framing (same margin as the 11C shell bound). */
export const TRANSCRIPT_EXTRACTION_INPUT_MARGIN_TOKENS = 256;

/** The route's fixed model snapshot, from the documented deepseek-flash entry (as the 11C shell route builds it). */
export function transcriptExtractionModel(): KieModelSnapshot | null {
  const documented = DEEPSEEK_DOCUMENTED_MODELS.find((model) => model.requestModelId === TRANSCRIPT_EXTRACTION_MODEL_ID);
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

/** The exact model-facing body for one schema-parsed request. Key order is part of the frozen contract. */
export function buildTranscriptExtractionBody(request: ExtractionRequest, model: KieModelSnapshot): Readonly<{ body: Record<string, unknown>; bodyText: string }> | null {
  const effort = minimumReasoningEffort(model);
  if (effort === null) return null;
  const message = JSON.stringify({ locale: request.locale, allowedFactKinds: request.allowedFactKinds, transcript: request.transcript });
  const body = {
    model: model.requestModelId,
    stream: false,
    store: false,
    instructions: TRANSCRIPT_EXTRACTION_PROMPT,
    input: [{ role: "user", content: [{ type: "input_text", text: message }] }],
    reasoning: { effort },
    text: { format: { type: "json_schema", name: TRANSCRIPT_EXTRACTION_SCHEMA_NAME, schema: extractionOutputJsonSchema(), strict: true } },
    temperature: TRANSCRIPT_EXTRACTION_TEMPERATURE,
    max_output_tokens: TRANSCRIPT_EXTRACTION_MAX_OUTPUT_TOKENS,
  };
  return Object.freeze({ body, bodyText: JSON.stringify(body) });
}

/** Pre-send upper bound of one call with a body of `bodyByteCount` UTF-8 bytes: every byte one input token, the full cap, peak prices. */
export function transcriptExtractionCallUpperBound(bodyByteCount: number): Readonly<{ inputTokens: number; outputTokens: number; costMicroUsd: number; basis: "UPPER_BOUND" }> {
  if (!Number.isSafeInteger(bodyByteCount) || bodyByteCount < 0) throw new Error("INVALID_BODY_BYTE_COUNT");
  const inputTokens = bodyByteCount + TRANSCRIPT_EXTRACTION_INPUT_MARGIN_TOKENS;
  const outputTokens = TRANSCRIPT_EXTRACTION_MAX_OUTPUT_TOKENS;
  const costMicroUsd = Math.ceil(inputTokens * DEEPSEEK_FLASH_PEAK_USD_PER_MILLION.inputCacheMiss + outputTokens * DEEPSEEK_FLASH_PEAK_USD_PER_MILLION.output);
  return Object.freeze({ inputTokens, outputTokens, costMicroUsd, basis: "UPPER_BOUND" as const });
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** The contract digest the qualification record must name: every model-facing element and the acceptance rules' versions. */
export function transcriptExtractionContractDigest(): string {
  return sha256(
    canonicalizeJson({
      contractVersion: TRANSCRIPT_EXTRACTION_CONTRACT_VERSION,
      promptVersion: TRANSCRIPT_EXTRACTION_PROMPT_VERSION,
      promptSha256: sha256(TRANSCRIPT_EXTRACTION_PROMPT),
      requestProfile: TRANSCRIPT_EXTRACTION_REQUEST_PROFILE,
      schemaName: TRANSCRIPT_EXTRACTION_SCHEMA_NAME,
      schema: extractionOutputJsonSchema(),
      model: TRANSCRIPT_EXTRACTION_MODEL_ID,
      temperature: TRANSCRIPT_EXTRACTION_TEMPERATURE,
      maxOutputTokens: TRANSCRIPT_EXTRACTION_MAX_OUTPUT_TOKENS,
      validatorVersion: TRANSCRIPT_EXTRACTION_VALIDATOR_VERSION,
      lexiconVersion: TRANSCRIPT_EXTRACTION_LEXICON_VERSION,
    }),
  );
}
