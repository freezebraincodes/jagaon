import { z } from "zod";
import { aiReasonCodeSchema, shellMaxOutputTokens, shellOutputSchema, type AiReasonCode, type ShellTask, type ShellTaskRequest } from "@/domain/ai";
import { PROVIDER_FAILURE_REASONS, SHELL_STRUCTURAL_REJECTION_REASONS } from "./ai-provider-port";

/**
 * Packet 11C Addendum B, Task B2a: the response contract of the value-blind shell route `POST /api/ai/shell` (B-boundary). Browser-safe
 * (no credential, environment, endpoint or network code), so the server route and the B2b browser shell client share one definition.
 *
 * The request body is exactly one approved `ShellTaskRequest` (`shellTaskRequestSchema` + `isApprovedShellTaskRequest`, re-checked on the
 * server with the planner's fixed per-kind budgets). The response body is exactly one of:
 * - `CANDIDATE`: the strictly parsed shell output that passed the server's value-blind shell gates (S1–S7b), with the closed retention
 *   code and the bounded usage of the call. The browser validates it again with its full local gates before any use.
 * - `STRUCTURALLY_REJECTED` (D6): the server's shell gates rejected the candidate; the closed shell-gate reason, whether it is
 *   structurally repairable, the retention code and the usage. The candidate itself never leaves the server. The single structural
 *   repair is made by the browser hybrid service, within the bundle's maxAttempts; the route never retries.
 * - `FAILED`: a closed reason only (refused request, not activated, missing configuration, provider failure, timeout, cancellation).
 *   Packet 11C B2b (B2a review follow-up): when a completed, billed provider response is refused for retention, the FAILED body also
 *   carries that call's bounded usage, so the browser service counts the spend. (Widened in Addendum C, C5: see below.)
 * No provider detail, raw provider text, model identity, diagnostic or credential is ever part of a response. Only a response the
 * provider explicitly reported as not stored carries a candidate or a rejection (`retention` is always CONFIRMED_NOT_STORED).
 *
 * Packet 11C Addendum C, Task C5 (owner decision: count potentially billed calls conservatively when usage is missing; do not treat them
 * as zero spend). The route answers every FAILED that follows a provider call it made, i.e. a potentially billed call, with that call's
 * usage: the provider-reported usage when the provider reported it (a stored, truncated, other-model or retention-refused response, a
 * candidate that fails re-parsing), otherwise the call's pre-send upper bound (an HTTP error, an unreadable response, a transport
 * failure, the route's timeout or a cancellation after the call started), each marked with its `basis`. A FAILED decided before any
 * provider call (a refused request, not activated, missing configuration, the rate limit) carries no usage, and the schema refuses usage
 * on any FAILED whose reason cannot follow a provider call. CANDIDATE and STRUCTURALLY_REJECTED carry the reported usage (basis REPORTED,
 * which may be left implicit). The usage basis never reaches the provider: request bodies are unchanged.
 */
export const AI_SHELL_ROUTE_PATH = "/api/ai/shell";
/** The request body cap in UTF-8 bytes. The largest approved shell request (32 slots, 8 sections) stays well below it. */
export const AI_SHELL_MAX_BODY_BYTES = 16_384;

// ---- Pre-send upper bound of one provider call (Packet 11C Addendum C, C5; the C6 spend ledger reserves with the same helpers) ------

/**
 * Peak-hour USD prices per 1M tokens of the route's fixed provider model (D2: Direct DeepSeek deepseek-flash; the DeepSeek catalogue's
 * DEEPSEEK_FLASH_PEAK_USD_PER_MILLION, pinned equal in shell-call-upper-bound.test.ts). Browser-safe copy: the catalogue is server-only.
 */
export const AI_SHELL_ROUTE_PEAK_USD_PER_MILLION = Object.freeze({ inputCacheMiss: 0.3, output: 1.2 });
/** Input tokens added to every bound for message framing (the evaluation tracer's INPUT_FRAMING_MARGIN_TOKENS, pinned equal). */
export const AI_SHELL_INPUT_FRAMING_MARGIN_TOKENS = 256;
/**
 * The largest number of UTF-8 bytes a model-facing shell body adds around the request JSON it carries (prompt, output schema, model
 * settings and envelope), over every shell task and locale: the measured maximum (5,626 bytes under prompt 11b.18 and kie-schema.11c.1)
 * rounded up to 8 KiB. Pinned in shell-call-upper-bound.test.ts against the bodies the real shared Responses adapter builds (the test
 * fails if any body needs more), so a bound computed from it never needs the server-only prompt.
 */
export const AI_SHELL_PROVIDER_BODY_OVERHEAD_MAX_BYTES = 8_192;

/**
 * The pre-send upper bound of one call whose model-facing body has `bodyByteCount` UTF-8 bytes: every body byte as one input token plus
 * the framing margin, the task's fixed output cap, both at the peak cache-miss prices (rounded up to a whole micro-USD). Exactly the
 * evaluation tracer's `estimateMaxUsd` (which now uses it). Basis UPPER_BOUND.
 */
export function shellCallUpperBound(bodyByteCount: number, task: ShellTask): Readonly<{ inputTokens: number; outputTokens: number; costMicroUsd: number; basis: "UPPER_BOUND" }> {
  if (!Number.isSafeInteger(bodyByteCount) || bodyByteCount < 0) throw new Error("INVALID_BODY_BYTE_COUNT");
  const inputTokens = bodyByteCount + AI_SHELL_INPUT_FRAMING_MARGIN_TOKENS;
  const outputTokens = shellMaxOutputTokens(task);
  const costMicroUsd = Math.ceil(inputTokens * AI_SHELL_ROUTE_PEAK_USD_PER_MILLION.inputCacheMiss + outputTokens * AI_SHELL_ROUTE_PEAK_USD_PER_MILLION.output);
  return Object.freeze({ inputTokens, outputTokens, costMicroUsd, basis: "UPPER_BOUND" as const });
}

/**
 * The pre-send upper bound of one route call for an approved shell request, computed without the model-facing body (so in the browser
 * too): the body is at most the fixed overhead plus the request JSON embedded as a JSON string, which at most doubles each byte (only a
 * quote or backslash gains one escape byte; the request JSON holds no raw control character). Never below `shellCallUpperBound` of the
 * exact body (pinned for every evaluated class).
 */
export function shellRouteCallUpperBound(request: ShellTaskRequest): Readonly<{ inputTokens: number; outputTokens: number; costMicroUsd: number; basis: "UPPER_BOUND" }> {
  const requestBytes = new TextEncoder().encode(JSON.stringify(request)).byteLength;
  return shellCallUpperBound(AI_SHELL_PROVIDER_BODY_OVERHEAD_MAX_BYTES + 2 * requestBytes, request.taskType);
}

/** The FAILED reasons that can follow a provider call the route made (and so may carry usage): the provider failures and cancellation. */
export const AI_SHELL_ROUTE_POST_CALL_FAILURE_REASONS = Object.freeze([...PROVIDER_FAILURE_REASONS, "REQUEST_CANCELLED"] as const satisfies readonly AiReasonCode[]);

const counts = {
  inputTokens: z.number().int().min(0).max(100_000).nullable(),
  outputTokens: z.number().int().min(0).max(100_000).nullable(),
  costMicroUsd: z.number().int().min(0).max(10_000_000).nullable(),
};
/** A completed call's reported usage (CANDIDATE, STRUCTURALLY_REJECTED); its basis may be left implicit. */
const reportedUsageSchema = z.strictObject({ ...counts, basis: z.literal("REPORTED").optional() });
/** A potentially billed FAILED call's usage: reported, or the call's pre-send upper bound; the basis is explicit. */
const failedUsageSchema = z.strictObject({ ...counts, basis: z.enum(["REPORTED", "UPPER_BOUND"]) });
const retentionSchema = z.literal("CONFIRMED_NOT_STORED");

export const aiShellRouteResponseSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("CANDIDATE"), candidate: z.union([shellOutputSchema("EXPLAIN_PATTERN"), shellOutputSchema("DRAFT_CARE_PREPARATION_SUMMARY")]), retention: retentionSchema, usage: reportedUsageSchema }),
    z.strictObject({ kind: z.literal("STRUCTURALLY_REJECTED"), reason: z.enum(SHELL_STRUCTURAL_REJECTION_REASONS), repairable: z.boolean(), retention: retentionSchema, usage: reportedUsageSchema }),
    z.strictObject({ kind: z.literal("FAILED"), reason: aiReasonCodeSchema, usage: failedUsageSchema.optional() }),
  ])
  .superRefine((body, ctx) => {
    if (body.kind === "FAILED" && body.usage !== undefined && !(AI_SHELL_ROUTE_POST_CALL_FAILURE_REASONS as readonly string[]).includes(body.reason)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "USAGE_ON_PRE_CALL_FAILURE" });
    }
  });
export type AiShellRouteResponse = z.infer<typeof aiShellRouteResponseSchema>;
