import { z } from "zod";
import { extractionOutputSchema } from "@/domain/transcript-extraction/transcript-extraction-contract";
import { EXTRACTION_REJECTION_REASONS } from "@/domain/transcript-extraction/transcript-extraction-validator";

/**
 * Packet 13 (P13X): the response contract of POST /api/ai/transcript (EXTRACT_VOICE_FACTS). Browser-safe: no credential, prompt,
 * provider, endpoint or network code; the route and the browser client share it.
 *
 * The request body is exactly one `extractionRequestSchema` object (the transcript, locale and allowed kinds). The response is one of:
 * - EXTRACTED: the strictly parsed output that passed the server's r-rules, with the closed retention code and the call's usage. The
 *   browser validates it again against its own transcript before any use.
 * - REJECTED: the server's r-rules rejected the model output (closed reason; the output never leaves the server). The browser then uses
 *   the deterministic local extractor. The route never retries or repairs.
 * - FAILED: a closed reason. Decided before any provider call it carries `notSentToProvider: true` and no usage; after the call may have
 *   started it carries usage (reported, else the call's upper bound) and no marker.
 * - REFUSED (HTTP 403): a closed refusal before any credential read or provider call, always `notSentToProvider: true`, never usage.
 * No transcript text, provider detail, model output, model identity or credential is ever part of a FAILED, REFUSED or REJECTED body.
 */
export const TRANSCRIPT_EXTRACTION_ROUTE_PATH = "/api/ai/transcript";
/** 1,200 code points of Chinese (3 bytes each) plus the JSON envelope stay well below it. */
export const TRANSCRIPT_EXTRACTION_MAX_BODY_BYTES = 8_192;

/** Refusals in route order (all before the credential read). */
export const TRANSCRIPT_EXTRACTION_REFUSAL_REASONS = Object.freeze([
  "REDIRECT_REQUIRED",
  "REMOTE_AI_DISABLED",
  "EXTRACTION_DISABLED",
  "ORIGIN_REJECTED",
  "ACCESS_DENIED",
  "TASK_NOT_ACTIVATED",
  "EXTRACTION_NOT_QUALIFIED",
  "SPEND_NOT_CONFIGURED",
  "SPEND_CEILING_REACHED",
  "SPEND_LEDGER_UNAVAILABLE",
] as const);
export type TranscriptExtractionRefusalReason = (typeof TRANSCRIPT_EXTRACTION_REFUSAL_REASONS)[number];

export const TRANSCRIPT_EXTRACTION_FAILURE_REASONS = Object.freeze([
  "PAYLOAD_INVALID",
  "BUDGET_EXCEEDED",
  "MISSING_CONFIGURATION",
  "TRANSPORT_FAILED",
  "PROVIDER_TIMEOUT",
  "PROVIDER_REJECTED",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_FAILED",
  "OPERATIONAL_SPEND_LOCKED",
  "REQUEST_CANCELLED",
] as const);
export type TranscriptExtractionFailureReason = (typeof TRANSCRIPT_EXTRACTION_FAILURE_REASONS)[number];
/** The failures that can follow a provider call (and so may carry usage). */
const POST_CALL = new Set<string>(["TRANSPORT_FAILED", "PROVIDER_TIMEOUT", "PROVIDER_REJECTED", "PROVIDER_RATE_LIMITED", "PROVIDER_FAILED", "OPERATIONAL_SPEND_LOCKED", "REQUEST_CANCELLED", "MISSING_CONFIGURATION"]);

const count = z.number().int().min(0).max(10_000_000).nullable();
const reportedUsage = z.strictObject({ inputTokens: count, outputTokens: count, costMicroUsd: count, basis: z.literal("REPORTED") });
const failedUsage = z.strictObject({ inputTokens: count, outputTokens: count, costMicroUsd: count, basis: z.enum(["REPORTED", "UPPER_BOUND"]) });
const retention = z.literal("CONFIRMED_NOT_STORED");

export const transcriptExtractionResponseSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("EXTRACTED"), output: extractionOutputSchema, retention, usage: reportedUsage }),
    z.strictObject({ kind: z.literal("REJECTED"), reason: z.enum(EXTRACTION_REJECTION_REASONS), retention, usage: reportedUsage }),
    z.strictObject({ kind: z.literal("FAILED"), reason: z.enum(TRANSCRIPT_EXTRACTION_FAILURE_REASONS), usage: failedUsage.optional(), notSentToProvider: z.literal(true).optional() }),
    z.strictObject({ kind: z.literal("REFUSED"), reason: z.enum(TRANSCRIPT_EXTRACTION_REFUSAL_REASONS), notSentToProvider: z.literal(true) }),
  ])
  .superRefine((body, ctx) => {
    if (body.kind !== "FAILED") return;
    if (body.usage !== undefined && body.notSentToProvider !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "USAGE_ON_UNSENT_FAILURE" });
    if (body.usage !== undefined && !POST_CALL.has(body.reason)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "USAGE_ON_PRE_CALL_FAILURE" });
    if (body.usage === undefined && body.notSentToProvider === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "FAILED_WITHOUT_USAGE_OR_MARKER" });
  });
export type TranscriptExtractionResponse = z.infer<typeof transcriptExtractionResponseSchema>;
