import { z } from "zod";
import { aiReasonCodeSchema, shellOutputSchema } from "@/domain/ai";
import { SHELL_STRUCTURAL_REJECTION_REASONS } from "./ai-provider-port";

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
 *   carries that call's bounded usage, so the browser service counts the spend. No other FAILED carries usage.
 * No provider detail, raw provider text, model identity, diagnostic or credential is ever part of a response. Only a response the
 * provider explicitly reported as not stored carries a candidate or a rejection (`retention` is always CONFIRMED_NOT_STORED).
 */
export const AI_SHELL_ROUTE_PATH = "/api/ai/shell";
/** The request body cap in UTF-8 bytes. The largest approved shell request (32 slots, 8 sections) stays well below it. */
export const AI_SHELL_MAX_BODY_BYTES = 16_384;

const usageSchema = z.strictObject({
  inputTokens: z.number().int().min(0).max(100_000).nullable(),
  outputTokens: z.number().int().min(0).max(100_000).nullable(),
  costMicroUsd: z.number().int().min(0).max(10_000_000).nullable(),
});
const retentionSchema = z.literal("CONFIRMED_NOT_STORED");

export const aiShellRouteResponseSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("CANDIDATE"), candidate: z.union([shellOutputSchema("EXPLAIN_PATTERN"), shellOutputSchema("DRAFT_CARE_PREPARATION_SUMMARY")]), retention: retentionSchema, usage: usageSchema }),
  z.strictObject({ kind: z.literal("STRUCTURALLY_REJECTED"), reason: z.enum(SHELL_STRUCTURAL_REJECTION_REASONS), repairable: z.boolean(), retention: retentionSchema, usage: usageSchema }),
  z.strictObject({ kind: z.literal("FAILED"), reason: aiReasonCodeSchema, usage: usageSchema.optional() }),
]);
export type AiShellRouteResponse = z.infer<typeof aiShellRouteResponseSchema>;
