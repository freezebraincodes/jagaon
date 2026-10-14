import { voiceFeelingGroupOf, type VoiceFeelingGroup } from "../voice/voice-feeling-cues";

/**
 * Owner decision 2026-10-14 (design §3.4, owner-approved wording): the reviewed kind sentences of the "Save as a note" path, chosen by
 * the feeling cues she said. Fixed English text from the reviewed bank, never written by AI; stored as the note's
 * JAGAON_KIND_SENTENCE turn (source REVIEWED_BANK) and shown to her after saving.
 *
 * Choice: the first matching cue group in this priority: sad or low > stressed > worried > tired > happy or good > other. A negated or
 * unknown cue ("not-good") has no group, so a note with only such cues gets the neutral "other" sentence. Distress never reaches here
 * (the distress gate runs first and nothing is saved).
 *
 * Local to the voice "Save as a note" path; the feelings-chat bank (`kindSentenceFor`, a separate track) is to be reconciled with it.
 */
export const NOTE_KIND_SENTENCES_VERSION = "note-kind-sentences.1";

export const NOTE_KIND_SENTENCES: Readonly<Record<VoiceFeelingGroup | "OTHER", string>> = Object.freeze({
  TIRED: "That sounds like a tiring day. Thank you for telling me.",
  WORRIED: "It sounds like something has been on your mind. Thank you for sharing it.",
  STRESSED: "That sounds like a lot to carry. Thank you for telling me.",
  SAD_LOW: "I'm sorry today feels hard. Thank you for sharing how you feel.",
  HAPPY_GOOD: "It's good to hear that. Thank you for sharing it.",
  OTHER: "Thank you for telling me how you feel.",
});

const PRIORITY: readonly VoiceFeelingGroup[] = Object.freeze(["SAD_LOW", "STRESSED", "WORRIED", "TIRED", "HAPPY_GOOD"]);

/** The reviewed kind sentence for these cue keys (see the priority above). */
export function noteKindSentenceFor(cueKeys: readonly string[]): string {
  const groups = new Set(cueKeys.map(voiceFeelingGroupOf));
  const group = PRIORITY.find((candidate) => groups.has(candidate));
  return NOTE_KIND_SENTENCES[group ?? "OTHER"];
}
