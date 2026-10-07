import type { KieDocumentedModel } from "@/ai/kie/kie-model-catalogue";

/**
 * Direct DeepSeek Responses API (evaluation only; owner instruction 2026-10-06). Server-only.
 *
 * Documentation (api-docs.deepseek.com, retrieved 2026-10-06): guides/responses_api and api/create-response.
 * `POST https://api.deepseek.com/responses` with Bearer authentication; model `deepseek-flash`
 * (DeepSeek-V4.1-Flash); `instructions` is inserted as the first system message; `reasoning.effort` is
 * none | low | high | max (none disables thinking); `text.format` `{ type: "json_schema", name, schema }`;
 * `store` is not supported and "the response always carries store: false"; the response carries `model`,
 * `status`, `output`, `usage` and no credits field. Pricing is in USD per 1M tokens (quick_start/pricing).
 * A model or retention value is accepted only when observed in a response, never inferred.
 */

export const DEEPSEEK_RESPONSES_URL = "https://api.deepseek.com/responses";

export const DEEPSEEK_DOCUMENTED_MODELS: readonly KieDocumentedModel[] = Object.freeze([
  Object.freeze({
    requestModelId: "deepseek-flash",
    // The documented response example returns this exact identifier; any other value is rejected.
    responseModelSnapshot: "deepseek-flash",
    provenance: "DOCUMENTED_UNLISTED_EVALUATION_ONLY",
    endpoint: DEEPSEEK_RESPONSES_URL,
    documentationUrl: "https://api-docs.deepseek.com/api/create-response",
    documentedAt: "2026-10-06",
    supportedReasoningLevels: Object.freeze(["none", "low", "high", "max"]),
    structuredOutput: "TEXT_FORMAT_JSON_SCHEMA_STRICT",
    unsupportedParameters: Object.freeze([]),
  } as const),
]);

/**
 * Peak-hour USD prices per 1M tokens for deepseek-flash (quick_start/pricing, retrieved 2026-10-06). Peak
 * cache-miss rates are the highest documented, so an estimate from them is an upper bound on spend.
 */
export const DEEPSEEK_FLASH_PEAK_USD_PER_MILLION = Object.freeze({ inputCacheMiss: 0.3, output: 1.2 });

/** Upper-bound spend in micro-USD: every input token at the cache-miss rate, every output token (reasoning included). */
export function deepSeekCostMicroUsd(inputTokens: number, outputTokens: number): number {
  return Math.ceil(inputTokens * DEEPSEEK_FLASH_PEAK_USD_PER_MILLION.inputCacheMiss + outputTokens * DEEPSEEK_FLASH_PEAK_USD_PER_MILLION.output);
}

export type DeepSeekTokenConfiguration = { kind: "CONFIGURED"; token: string } | { kind: "MISSING_CONFIGURATION" };

/** `DEEPSEEK_API_KEY` is the only credential name; a `NEXT_PUBLIC_*` copy or another provider's key is never read. */
export function readDeepSeekToken(environment: Readonly<Record<string, string | undefined>>): DeepSeekTokenConfiguration {
  const token = environment.DEEPSEEK_API_KEY?.trim();
  return token ? { kind: "CONFIGURED", token } : { kind: "MISSING_CONFIGURATION" };
}
