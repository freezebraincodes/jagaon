import { FEELINGS_CHAT_MAX_TURNS, FEELINGS_CHAT_SUMMARY_MAX_CHARS, type FeelingsChatRequest } from "./feelings-chat-contract";
import type { ValidatedFeelingsChatReply } from "./feelings-chat-validator";

/**
 * Tell JagaOn understands more (design §3.4; wording approved by the owner on 2026-10-14): the reviewed bank. The kind sentences are
 * never written by AI; the fallback questions are used whenever the AI is off, unavailable or its reply is rejected. English only (the
 * hackathon scope); the dialog shows these exact strings.
 */
export const FEELINGS_CHAT_BANK_VERSION = "feelings-chat-bank.1";

export const KIND_SENTENCE_KEYS = Object.freeze(["SAD_OR_LOW", "STRESSED", "TIRED", "WORRIED", "HAPPY_OR_GOOD", "OTHER"] as const);
export type KindSentenceKey = (typeof KIND_SENTENCE_KEYS)[number];

/** The owner-approved kind sentences, exact. */
export const KIND_SENTENCES: Readonly<Record<KindSentenceKey, string>> = Object.freeze({
  TIRED: "That sounds like a tiring day. Thank you for telling me.",
  WORRIED: "It sounds like something has been on your mind. Thank you for sharing it.",
  STRESSED: "That sounds like a lot to carry. Thank you for telling me.",
  SAD_OR_LOW: "I'm sorry today feels hard. Thank you for sharing how you feel.",
  HAPPY_OR_GOOD: "It's good to hear that. Thank you for sharing it.",
  OTHER: "Thank you for telling me how you feel.",
});

/** The owner-approved fallback questions by turn, exact. */
export const FALLBACK_QUESTIONS: readonly string[] = Object.freeze([
  "What has been on your mind?",
  "How has this been affecting your day?",
  "Is there anything you'd like to remember to tell your doctor?",
]);

/**
 * Feeling-cue keys (lowercase words from the deterministic feeling recogniser, e.g. "tired", "worried") mapped to a kind-sentence key.
 * An unknown cue maps to nothing; no recognised cue gives OTHER.
 */
const CUE_TO_KEY: Readonly<Record<string, KindSentenceKey>> = Object.freeze({
  tired: "TIRED",
  exhausted: "TIRED",
  sleepy: "TIRED",
  drained: "TIRED",
  "worn-out": "TIRED",
  worn_out: "TIRED",
  fatigued: "TIRED",
  weary: "TIRED",
  worried: "WORRIED",
  worry: "WORRIED",
  anxious: "WORRIED",
  nervous: "WORRIED",
  scared: "WORRIED",
  afraid: "WORRIED",
  concerned: "WORRIED",
  uneasy: "WORRIED",
  stressed: "STRESSED",
  stress: "STRESSED",
  overwhelmed: "STRESSED",
  pressured: "STRESSED",
  tense: "STRESSED",
  frustrated: "STRESSED",
  sad: "SAD_OR_LOW",
  low: "SAD_OR_LOW",
  down: "SAD_OR_LOW",
  upset: "SAD_OR_LOW",
  unhappy: "SAD_OR_LOW",
  lonely: "SAD_OR_LOW",
  blue: "SAD_OR_LOW",
  miserable: "SAD_OR_LOW",
  happy: "HAPPY_OR_GOOD",
  good: "HAPPY_OR_GOOD",
  great: "HAPPY_OR_GOOD",
  better: "HAPPY_OR_GOOD",
  glad: "HAPPY_OR_GOOD",
  calm: "HAPPY_OR_GOOD",
  relieved: "HAPPY_OR_GOOD",
  cheerful: "HAPPY_OR_GOOD",
});

/**
 * Deterministic priority when several cues match: the heavier feelings first (sad or low, then stressed), then tired before worried
 * (the design's own example, "Feeling tired and a bit worried today", gets the tiring-day sentence), then happy or good; else OTHER.
 * The order of the cues themselves never matters.
 */
export function kindSentenceFor(cueKeys: readonly string[]): Readonly<{ key: KindSentenceKey; text: string }> {
  const matched = new Set(cueKeys.map((cue) => CUE_TO_KEY[cue.trim().toLowerCase()]).filter((key): key is KindSentenceKey => key !== undefined));
  const key = KIND_SENTENCE_KEYS.find((candidate) => matched.has(candidate)) ?? "OTHER";
  return Object.freeze({ key, text: KIND_SENTENCES[key] });
}

/** The reviewed fallback question for turn 1–3 (out-of-range turns are clamped). */
export function fallbackQuestion(turn: number): string {
  const index = Math.min(Math.max(Math.trunc(Number.isFinite(turn) ? turn : 1), 1), FEELINGS_CHAT_MAX_TURNS) - 1;
  return FALLBACK_QUESTIONS[index]!;
}

/**
 * The reviewed-bank reply for one turn, used whenever the AI is off, unavailable or rejected. Pure; never written by AI.
 * - turns 1 and 2: the bank's question for that turn;
 * - turn 3 (the wrap-up): a local wrap-up — the summary is her first message (whitespace collapsed, at most 160 characters, cut with
 *   "…"), no doctor question and no theme. The chat dialog then offers the bank's turn-3 question as the prompt for a doctor question
 *   she writes herself. No theme is claimed without the AI's validated tags, so My notes counts are never inflated by a fallback.
 */
export function feelingsChatBankReply(request: Pick<FeelingsChatRequest, "turn" | "maxTurns" | "messages">): ValidatedFeelingsChatReply {
  if (request.turn < request.maxTurns) {
    return Object.freeze({ kind: "QUESTION" as const, question: fallbackQuestion(request.turn), summary: null, doctorQuestion: null, themes: Object.freeze([]), end: false });
  }
  const first = request.messages.find((message) => message.role === "patient")?.text.replace(/\s+/g, " ").trim() ?? "";
  const points = Array.from(first);
  const summary = points.length <= FEELINGS_CHAT_SUMMARY_MAX_CHARS ? first : `${points.slice(0, FEELINGS_CHAT_SUMMARY_MAX_CHARS - 1).join("").trimEnd()}…`;
  return Object.freeze({ kind: "WRAP_UP" as const, question: null, summary, doctorQuestion: null, themes: Object.freeze([]), end: true });
}
