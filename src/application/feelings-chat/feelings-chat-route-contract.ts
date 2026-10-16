import { z } from "zod";
import { FEELINGS_CHAT_REPLY_KINDS } from "@/domain/feelings-chat/feelings-chat-contract";
import { FEELINGS_CHAT_REJECTION_REASONS } from "@/domain/feelings-chat/feelings-chat-validator";
import { NOTE_THEME_KEYS } from "@/domain/notes/note-themes";

/**
 * Tell JagaOn understands more (design §3.8): the response contract of POST /api/ai/feelings. Browser-safe: no credential, prompt,
 * provider, endpoint or network code; the route and the browser client share it.
 *
 * The request body is exactly one `feelingsChatRequestSchema` object. The response is one of:
 * - OK: the reply that passed the server's validator (feelings-chat-validator.2). The browser validates it AGAIN before showing it.
 *   Owner decision 2026-10-14: when the validator dropped only the AI's doctor question from a wrap-up, `doctorQuestionDropped` carries
 *   its closed reasons (the dropped text never leaves the server); absent otherwise.
 * - REJECTED: the validator rejected the model's reply; closed reason codes only, the reply never leaves the server.
 * - UNAVAILABLE: a closed reason; the browser then uses the reviewed bank. Reasons mirror the existing routes' vocabularies:
 *   DISABLED (either switch off), NOT_CONFIGURED (no spend limit, no provider credential or no model), ORIGIN_REJECTED and
 *   ACCESS_DENIED (the shared C6 origin and demo-passcode checks), BAD_REQUEST, SPEND_CEILING_REACHED (this route's own daily limit) and
 *   OPERATIONAL_SPEND_LOCKED (the provider's account balance, HTTP 402) — the two "AI credit used up" reasons the app maps to the
 *   credit-limit dialog — SPEND_LEDGER_UNAVAILABLE, RATE_LIMITED, UPSTREAM_ERROR, TIMEOUT and CANCELLED. OFFLINE is never sent by the
 *   route; the browser client uses it when the request could not reach the route.
 * No chat text, provider detail, model output, model identity or credential is ever part of a REJECTED or UNAVAILABLE body.
 */
export const FEELINGS_CHAT_ROUTE_PATH = "/api/ai/feelings";
/** Six messages of at most 600 characters (up to 4 UTF-8 bytes each) plus the JSON envelope stay below it. */
export const FEELINGS_CHAT_MAX_BODY_BYTES = 16_384;

export const FEELINGS_CHAT_UNAVAILABLE_REASONS = Object.freeze([
  "NOT_CONFIGURED",
  "DISABLED",
  "ORIGIN_REJECTED",
  "ACCESS_DENIED",
  "BAD_REQUEST",
  "SPEND_CEILING_REACHED",
  "OPERATIONAL_SPEND_LOCKED",
  "SPEND_LEDGER_UNAVAILABLE",
  "RATE_LIMITED",
  "UPSTREAM_ERROR",
  "TIMEOUT",
  "CANCELLED",
  "OFFLINE",
] as const);
export type FeelingsChatUnavailableReason = (typeof FEELINGS_CHAT_UNAVAILABLE_REASONS)[number];

/** The reasons that mean the demo's AI credit is used up (the app's existing credit-limit dialog). */
export const FEELINGS_CHAT_CREDIT_LIMIT_REASONS: ReadonlySet<FeelingsChatUnavailableReason> = new Set(["SPEND_CEILING_REACHED", "OPERATIONAL_SPEND_LOCKED"]);
export const isFeelingsChatCreditLimit = (reason: string | null | undefined): boolean => typeof reason === "string" && FEELINGS_CHAT_CREDIT_LIMIT_REASONS.has(reason as FeelingsChatUnavailableReason);

const text = z.string().min(1).max(600).nullable();
export const feelingsChatValidatedReplySchema = z.strictObject({
  kind: z.enum(FEELINGS_CHAT_REPLY_KINDS),
  question: text,
  summary: text,
  doctorQuestion: text,
  themes: z.array(z.enum(NOTE_THEME_KEYS)).max(NOTE_THEME_KEYS.length),
  end: z.boolean(),
});

export const feelingsChatRouteResponseSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("OK"),
    reply: feelingsChatValidatedReplySchema,
    doctorQuestionDropped: z.array(z.enum(FEELINGS_CHAT_REJECTION_REASONS)).min(1).max(FEELINGS_CHAT_REJECTION_REASONS.length).optional(),
  }),
  z.strictObject({ kind: z.literal("REJECTED"), reasons: z.array(z.enum(FEELINGS_CHAT_REJECTION_REASONS)).min(1).max(FEELINGS_CHAT_REJECTION_REASONS.length) }),
  z.strictObject({ kind: z.literal("UNAVAILABLE"), reason: z.enum(FEELINGS_CHAT_UNAVAILABLE_REASONS) }),
]);
export type FeelingsChatRouteResponse = z.infer<typeof feelingsChatRouteResponseSchema>;
