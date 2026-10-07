import type { AiProviderPort, AiShellProviderPort } from "@/application/ai/ai-provider-port";
import { createResponsesProvider, createShellResponsesProvider, type ResponsesProviderConfig, type ResponsesProviderProfile } from "@/ai/kie/kie-responses-provider";
import { deepSeekCostMicroUsd, DEEPSEEK_RESPONSES_URL } from "./deepseek-catalogue";

/**
 * Evaluation-only direct DeepSeek Responses provider (owner instruction 2026-10-06). Server-only. It uses the one
 * shared Responses request builder and parser, so the request mapping (static prompt in `instructions`, the
 * synthetic projection as the only input message, stream and store disabled, effort from the model, strict
 * `text.format`) and every response rule (HTTP 200, status completed, exact model identity, boolean `store: false`,
 * one output text) are exactly the ones already enforced. Only the provider key, the single allowlisted endpoint
 * and the spend measure differ. DeepSeek reports no credits, so spend is an upper-bound USD estimate at the
 * documented peak cache-miss rates, carried as `costMicroUsd`; `credits` stays null.
 */
export const DEEPSEEK_RESPONSES_PROFILE: ResponsesProviderProfile = Object.freeze({
  providerKey: "deepseek",
  endpointLayouts: Object.freeze({ [DEEPSEEK_RESPONSES_URL]: "INSTRUCTIONS_FIELD" as const }),
  spend: (usage) => ({ credits: null, costMicroUsd: deepSeekCostMicroUsd(usage.inputTokens, usage.outputTokens) }),
});

export function createDeepSeekResponsesProvider(config: ResponsesProviderConfig): AiProviderPort {
  return createResponsesProvider(DEEPSEEK_RESPONSES_PROFILE, config);
}

/** Evaluation-only hybrid shell variant: identical request and response rules, value-blind slot-shell contract. */
export function createDeepSeekShellResponsesProvider(config: ResponsesProviderConfig): AiShellProviderPort {
  return createShellResponsesProvider(DEEPSEEK_RESPONSES_PROFILE, config);
}
