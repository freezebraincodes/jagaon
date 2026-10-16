import { z } from "zod";
import { NOTE_THEME_KEYS } from "@/domain/notes/note-themes";

/**
 * Tell JagaOn understands more (design §3.6, owner-approved 2026-10-14): the AI contract of one feelings-chat turn. Pure and
 * browser-safe; the server route, the browser client and the validator share it.
 *
 * Turn model (the design's "on turn 3 return WRAP_UP", within the request bounds of at most 3 turns and 6 messages):
 * - turn 1: her first words → JagaOn's first question;
 * - turn 2: her first words, question 1, her answer → question 2;
 * - turn 3 (= maxTurns): the chat so far → the WRAP_UP (summary, optional doctor question, themes). A QUESTION at turn 3 is rejected
 *   by the validator (TURN_LIMIT), so the chat never runs past three turns. "End chat" asks for turn 3 early with the chat so far.
 * The messages always start and end with her words and alternate; a question she skipped is not sent (her history keeps alternating),
 * so the count is at most 2 × turn − 1 (never more than 5, inside the 6-entry bound).
 *
 * The request carries ONLY her words in this chat and JagaOn's questions: never readings, medicines from her records, her name, dates
 * or record IDs (the strict schema refuses any other field).
 */
export const FEELINGS_CHAT_TASK = "FEELINGS_CHAT_TURN" as const;
export const FEELINGS_CHAT_CONTRACT_VERSION = "feelings-chat-contract.1";
export const FEELINGS_CHAT_MAX_TURNS = 3 as const;
export const FEELINGS_CHAT_MAX_MESSAGES = 6;
export const FEELINGS_CHAT_MESSAGE_MAX_CHARS = 600;
export const FEELINGS_CHAT_SUMMARY_MAX_CHARS = 160;
export const FEELINGS_CHAT_DOCTOR_QUESTION_MAX_CHARS = 200;
/** A generous parse cap for the model's question (the validator then applies the 3–25 word rule). */
export const FEELINGS_CHAT_QUESTION_MAX_CHARS = 300;

export const FEELINGS_CHAT_MESSAGE_ROLES = Object.freeze(["patient", "jagaon_question"] as const);
export type FeelingsChatMessageRole = (typeof FEELINGS_CHAT_MESSAGE_ROLES)[number];

export const feelingsChatMessageSchema = z.strictObject({
  role: z.enum(FEELINGS_CHAT_MESSAGE_ROLES),
  text: z
    .string()
    .min(1)
    .max(FEELINGS_CHAT_MESSAGE_MAX_CHARS)
    .refine((text) => text.trim().length > 0, "BLANK_TEXT"),
});
export type FeelingsChatMessage = z.infer<typeof feelingsChatMessageSchema>;

export const feelingsChatRequestSchema = z
  .strictObject({
    task: z.literal(FEELINGS_CHAT_TASK),
    turn: z.number().int().min(1).max(FEELINGS_CHAT_MAX_TURNS),
    maxTurns: z.literal(FEELINGS_CHAT_MAX_TURNS),
    messages: z.array(feelingsChatMessageSchema).min(1).max(FEELINGS_CHAT_MAX_MESSAGES),
  })
  .superRefine((request, context) => {
    const issue = (message: string) => context.addIssue({ code: z.ZodIssueCode.custom, message, path: ["messages"] });
    if (request.messages[0]?.role !== "patient") issue("MUST_START_WITH_PATIENT");
    for (let index = 1; index < request.messages.length; index += 1) {
      if (request.messages[index]!.role === request.messages[index - 1]!.role) {
        issue("MUST_ALTERNATE");
        break;
      }
    }
    if (request.messages[request.messages.length - 1]?.role !== "patient") issue("MUST_END_WITH_PATIENT");
    if (request.messages.length > 2 * request.turn - 1) issue("TOO_MANY_MESSAGES_FOR_TURN");
  });
export type FeelingsChatRequest = z.infer<typeof feelingsChatRequestSchema>;

export const FEELINGS_CHAT_REPLY_KINDS = Object.freeze(["QUESTION", "WRAP_UP"] as const);
export type FeelingsChatReplyKind = (typeof FEELINGS_CHAT_REPLY_KINDS)[number];

/**
 * The strict reply. Kind rules:
 * - QUESTION: `question` non-null; `summary` and `doctorQuestion` null; `end` false.
 * - WRAP_UP: `question` null and `summary` non-null (a neutral one-line summary; `doctorQuestion` optional).
 * - The safety stop (design §3.7, the second net): WRAP_UP with `end: true` and every text null. The app then shows the helplines and
 *   saves nothing. It is the one WRAP_UP allowed without a summary.
 */
export const feelingsChatReplySchema = z
  .strictObject({
    kind: z.enum(FEELINGS_CHAT_REPLY_KINDS),
    question: z.string().min(1).max(FEELINGS_CHAT_QUESTION_MAX_CHARS).nullable(),
    // The length rules (160 and 200 characters) are validator rules 7 and 8 with their own reasons; the parse cap is generous.
    summary: z.string().min(1).max(FEELINGS_CHAT_QUESTION_MAX_CHARS * 2).nullable(),
    doctorQuestion: z.string().min(1).max(FEELINGS_CHAT_QUESTION_MAX_CHARS * 2).nullable(),
    themes: z.array(z.string().min(1).max(32)).max(NOTE_THEME_KEYS.length * 2),
    end: z.boolean(),
  })
  .superRefine((reply, context) => {
    const issue = (message: string) => context.addIssue({ code: z.ZodIssueCode.custom, message });
    if (reply.kind === "QUESTION") {
      if (reply.question === null) issue("QUESTION_REQUIRED");
      if (reply.summary !== null || reply.doctorQuestion !== null) issue("QUESTION_CARRIES_WRAP_UP");
      if (reply.end) issue("QUESTION_ENDS_CHAT");
      return;
    }
    if (reply.question !== null) issue("WRAP_UP_CARRIES_QUESTION");
    if (reply.summary === null && !isSafetyStopShape(reply)) issue("SUMMARY_REQUIRED");
  });
export type FeelingsChatReply = Readonly<{
  kind: FeelingsChatReplyKind;
  question: string | null;
  summary: string | null;
  doctorQuestion: string | null;
  themes: readonly string[];
  end: boolean;
}>;

function isSafetyStopShape(reply: { kind: string; question: string | null; summary: string | null; doctorQuestion: string | null; end: boolean }): boolean {
  return reply.kind === "WRAP_UP" && reply.end && reply.question === null && reply.summary === null && reply.doctorQuestion === null;
}

/** True for the model's second-net safety stop: the app shows the helplines, closes the chat and saves nothing. */
export function isFeelingsChatSafetyStop(reply: FeelingsChatReply): boolean {
  return isSafetyStopShape(reply);
}

/** The strict JSON Schema handed to the provider (`text.format`), mirroring `feelingsChatReplySchema` (kind rules are the validator's). */
export function feelingsChatReplyJsonSchema(): Record<string, unknown> {
  const nullableText = { type: ["string", "null"] };
  return {
    type: "object",
    additionalProperties: false,
    required: ["kind", "question", "summary", "doctorQuestion", "themes", "end"],
    properties: {
      kind: { type: "string", enum: [...FEELINGS_CHAT_REPLY_KINDS] },
      question: nullableText,
      summary: nullableText,
      doctorQuestion: nullableText,
      themes: { type: "array", maxItems: NOTE_THEME_KEYS.length, items: { type: "string", enum: [...NOTE_THEME_KEYS] } },
      end: { type: "boolean" },
    },
  };
}
