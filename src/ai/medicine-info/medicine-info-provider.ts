import type { ProviderFailureReason, ProviderRetentionResult, ProviderUsage } from "@/application/ai/ai-provider-port";
import { parseStrictJson, toPlainData } from "@/backup/strict-json";
import { deepSeekCostMicroUsd, DEEPSEEK_RESPONSES_URL } from "@/ai/deepseek/deepseek-catalogue";
import type { KieModelSnapshot } from "@/ai/kie/kie-model-catalogue";
import { KIE_MAX_RESPONSE_BYTES, kieResponseSchema, singleOutputText } from "@/ai/kie/kie-responses-contracts";
import { classifyKieRetention, readLimitedUtf8 } from "@/ai/kie/kie-responses-provider";
import type { MedicineInfoRequest } from "@/domain/medicine-info/medicine-info-contract";
import { buildMedicineInfoBody, medicineInfoCallUpperBound, MEDICINE_INFO_MAX_OUTPUT_TOKENS } from "./medicine-info-request";

/**
 * HSA preview (owner decision 2026-10-14, "Get general information with AI"): the one bounded Direct DeepSeek Responses call of a
 * medicine-information lookup. Server-only. It mirrors the feelings-chat transport exactly (the shared adapter's exported response
 * schema, single-output-text rule, retention classifier and bounded body reader): HTTP 200, status completed, not truncated, exact model
 * identity, `store` reported false, exactly one output text. Every failure is a closed reason; no token, name, provider message or body
 * is returned or logged. A failure after the request may have been transmitted carries usage (reported, else this body's upper bound),
 * never zero; a failure before sending carries none. The output text is parsed as strict JSON; malformed JSON is passed on unparsed and
 * fails the validator's schema rule.
 */
export type MedicineInfoProviderResult =
  | Readonly<{ kind: "COMPLETED"; candidate: unknown; usage: ProviderUsage; retention: ProviderRetentionResult }>
  | Readonly<{ kind: "FAILED"; reason: ProviderFailureReason; usage?: ProviderUsage }>;

type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

function statusReason(status: number): ProviderFailureReason {
  if (status === 401 || status === 403) return "MISSING_CONFIGURATION";
  if (status === 402) return "OPERATIONAL_SPEND_LOCKED";
  if (status === 408 || status === 504) return "PROVIDER_TIMEOUT";
  if (status === 429) return "PROVIDER_RATE_LIMITED";
  if (status >= 500) return "PROVIDER_FAILED";
  return "PROVIDER_REJECTED";
}

export async function invokeMedicineInfo(input: { request: MedicineInfoRequest; token: string; model: KieModelSnapshot; signal: AbortSignal; fetcher?: Fetcher }): Promise<MedicineInfoProviderResult> {
  const built = buildMedicineInfoBody(input.request, input.model);
  // Only the documented endpoint ever receives the credential.
  if (!built || input.model.endpoint !== DEEPSEEK_RESPONSES_URL) return { kind: "FAILED", reason: "MISSING_CONFIGURATION" };
  const bound = medicineInfoCallUpperBound(new TextEncoder().encode(built.bodyText).byteLength);
  const upperBound: ProviderUsage = { inputTokens: bound.inputTokens, outputTokens: bound.outputTokens, costMicroUsd: bound.costMicroUsd, credits: null, basis: "UPPER_BOUND" };
  let reported: ProviderUsage | null = null;
  const failedAfterSend = (reason: ProviderFailureReason): MedicineInfoProviderResult => ({ kind: "FAILED", reason, usage: reported ?? upperBound });

  let response: Response;
  try {
    response = await (input.fetcher ?? fetch)(DEEPSEEK_RESPONSES_URL, {
      method: "POST",
      cache: "no-store",
      headers: { authorization: `Bearer ${input.token}`, "content-type": "application/json", accept: "application/json" },
      body: built.bodyText,
      signal: input.signal,
    });
  } catch {
    return failedAfterSend(input.signal.aborted ? "PROVIDER_TIMEOUT" : "TRANSPORT_FAILED");
  }
  if (!response.ok) return failedAfterSend(statusReason(response.status));
  let text: string | null;
  try {
    text = await readLimitedUtf8(response.body, KIE_MAX_RESPONSE_BYTES);
  } catch {
    return failedAfterSend("TRANSPORT_FAILED");
  }
  if (text === null) return failedAfterSend("PROVIDER_FAILED");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return failedAfterSend("PROVIDER_FAILED");
  }
  const parsed = kieResponseSchema.safeParse(json);
  if (!parsed.success) return failedAfterSend("PROVIDER_FAILED");
  const usage = parsed.data.usage;
  reported = { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, costMicroUsd: deepSeekCostMicroUsd(usage.input_tokens, usage.output_tokens), credits: null, basis: "REPORTED" };
  const envelope = json as Record<string, unknown>;
  const incomplete = Object.hasOwn(envelope, "incomplete_details") && envelope.incomplete_details !== null;
  if (parsed.data.status !== "completed" || incomplete || usage.output_tokens >= MEDICINE_INFO_MAX_OUTPUT_TOKENS) return failedAfterSend("PROVIDER_FAILED");
  const retention = classifyKieRetention(envelope.store);
  if (retention === "PROVIDER_REPORTED_STORED") return failedAfterSend("PROVIDER_FAILED");
  if (parsed.data.model !== input.model.responseModelSnapshot) return failedAfterSend("PROVIDER_FAILED");
  const output = singleOutputText(parsed.data.output);
  if (output === null) return failedAfterSend("PROVIDER_FAILED");
  let candidate: unknown;
  try {
    candidate = toPlainData(parseStrictJson(output, { maxDepth: 4, maxLength: 16_384 }));
  } catch {
    candidate = output;
  }
  return { kind: "COMPLETED", candidate, usage: reported, retention };
}
