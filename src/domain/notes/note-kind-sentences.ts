import { FEELINGS_CHAT_BANK_VERSION, KIND_SENTENCES, kindSentenceFor } from "../feelings-chat/feelings-chat-bank";
import type { VoiceFeelingGroup } from "../voice/voice-feeling-cues";

/**
 * Owner decision 2026-10-14 (design §3.4, owner-approved wording): the reviewed kind sentence of the voice "Save as a note" path, chosen
 * by the feeling cues she said. Fixed English text from the reviewed bank, never written by AI; stored as the note's
 * JAGAON_KIND_SENTENCE turn (source REVIEWED_BANK) and shown to her after saving.
 *
 * Reconciled with the feelings chat (2026-10-14): there is ONE table and ONE choice, the reviewed bank's `KIND_SENTENCES` and
 * `kindSentenceFor` (feelings-chat-bank.1). This module only re-exposes them under the recogniser's group names, so the note saved from
 * a Feeling card and the note saved from the chat carry the same sentence for the same cues. Priority (the bank's): sad or low >
 * stressed > tired > worried > happy or good > other. A negated or unknown cue ("not-good") has no group, so a note with only such cues
 * gets the neutral "other" sentence. Distress never reaches here (the distress gate runs first and nothing is saved).
 */
export const NOTE_KIND_SENTENCES_VERSION = FEELINGS_CHAT_BANK_VERSION;

/** The bank's sentences keyed by the recogniser's group names (a view of `KIND_SENTENCES`, not a second table). */
export const NOTE_KIND_SENTENCES: Readonly<Record<VoiceFeelingGroup | "OTHER", string>> = Object.freeze({
  TIRED: KIND_SENTENCES.TIRED,
  WORRIED: KIND_SENTENCES.WORRIED,
  STRESSED: KIND_SENTENCES.STRESSED,
  SAD_LOW: KIND_SENTENCES.SAD_OR_LOW,
  HAPPY_GOOD: KIND_SENTENCES.HAPPY_OR_GOOD,
  OTHER: KIND_SENTENCES.OTHER,
});

/** The reviewed kind sentence for these cue keys: delegates to the bank's `kindSentenceFor`. */
export function noteKindSentenceFor(cueKeys: readonly string[]): string {
  return kindSentenceFor(cueKeys).text;
}
