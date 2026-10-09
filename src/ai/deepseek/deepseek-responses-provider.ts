import type { AiProviderPort, AiShellProviderPort } from "@/application/ai/ai-provider-port";
import { shellCallUpperBound } from "@/application/ai/ai-shell-route-contract";
import { createResponsesProvider, createShellResponsesProvider, type ResponsesProviderConfig, type ResponsesProviderProfile } from "@/ai/kie/kie-responses-provider";
import { deepSeekCostMicroUsd, DEEPSEEK_RESPONSES_URL } from "./deepseek-catalogue";

/**
 * Direct DeepSeek Responses provider (owner instruction 2026-10-06; first used by the evaluation runners). Server-only. Since Packet 11C
 * Addendum B (D2) the hybrid shell variant below also serves the server-only value-blind route `POST /api/ai/shell`, which stays
 * deterministic-only while the shipped activation manifest is (nothing is activated); the legacy full-prose variant stays
 * evaluation-only. It uses the one
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
  // Packet 11C Addendum C (C5): the shared pre-send upper bound of one shell call with this exact body (the evaluation tracer's
  // estimateMaxUsd, moved into ai-shell-route-contract.ts), counted when a transmitted call's usage is missing or unreadable.
  upperBound: (bodyByteCount, task) => {
    const { inputTokens, outputTokens, costMicroUsd } = shellCallUpperBound(bodyByteCount, task);
    return { inputTokens, outputTokens, costMicroUsd };
  },
});

export function createDeepSeekResponsesProvider(config: ResponsesProviderConfig): AiProviderPort {
  return createResponsesProvider(DEEPSEEK_RESPONSES_PROFILE, config);
}

/**
 * The hybrid shell variant: identical request and response rules, value-blind slot-shell contract. Used by the evaluation runners and,
 * since Packet 11C Addendum B (D2), by the server-only `/api/ai/shell` route (refused before any credential read while not activated).
 */
export function createDeepSeekShellResponsesProvider(config: ResponsesProviderConfig): AiShellProviderPort {
  return createShellResponsesProvider(DEEPSEEK_RESPONSES_PROFILE, config);
}
