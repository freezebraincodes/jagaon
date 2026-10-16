// @vitest-environment node
import { describe, expect, it } from "vitest";
import { KIND_SENTENCES, kindSentenceFor } from "../feelings-chat/feelings-chat-bank";
import { VOICE_FEELING_CUES } from "../voice/voice-feeling-cues";
import { NOTE_KIND_SENTENCES, NOTE_KIND_SENTENCES_VERSION, noteKindSentenceFor } from "./note-kind-sentences";

/** Owner decision 2026-10-14 (design §3.4): the owner-approved kind sentences, verbatim, and the cue-group priority. */
describe("reviewed kind sentences for Save as a note", () => {
  it("are the owner-approved wording, verbatim", () => {
    expect(NOTE_KIND_SENTENCES).toEqual({
      TIRED: "That sounds like a tiring day. Thank you for telling me.",
      WORRIED: "It sounds like something has been on your mind. Thank you for sharing it.",
      STRESSED: "That sounds like a lot to carry. Thank you for telling me.",
      SAD_LOW: "I'm sorry today feels hard. Thank you for sharing how you feel.",
      HAPPY_GOOD: "That's wonderful to hear. Well done for keeping it up.",
      OTHER: "Thank you for telling me how you feel.",
    });
  });

  it("is one table with the feelings-chat bank: the same strings, version and choice for every recognised cue", () => {
    expect(NOTE_KIND_SENTENCES_VERSION).toBe("feelings-chat-bank.2");
    expect(new Set(Object.values(NOTE_KIND_SENTENCES))).toEqual(new Set(Object.values(KIND_SENTENCES)));
    for (const cue of VOICE_FEELING_CUES.cues) {
      expect(noteKindSentenceFor([cue.key]), cue.key).toBe(kindSentenceFor([cue.key]).text);
      // voice-feeling-cues.3: doubt and confusion (the OTHER group) take the neutral sentence on purpose.
      if (cue.group === "OTHER") expect(noteKindSentenceFor([cue.key]), cue.key).toBe(NOTE_KIND_SENTENCES.OTHER);
      else expect(noteKindSentenceFor([cue.key]), cue.key).not.toBe(NOTE_KIND_SENTENCES.OTHER);
    }
  });

  it("chooses by the first matching group: sad/low > stressed > tired > worried > happy/good > other", () => {
    expect(noteKindSentenceFor(["tired"])).toBe(NOTE_KIND_SENTENCES.TIRED);
    // The design's own example (§3.1 step 5): "Feeling tired and a bit worried today" gets the tiring-day sentence.
    expect(noteKindSentenceFor(["tired", "worried"])).toBe(NOTE_KIND_SENTENCES.TIRED);
    expect(noteKindSentenceFor(["worried", "tired"])).toBe(NOTE_KIND_SENTENCES.TIRED);
    expect(noteKindSentenceFor(["worried", "overwhelmed"])).toBe(NOTE_KIND_SENTENCES.STRESSED);
    expect(noteKindSentenceFor(["happy", "stressed", "lonely"])).toBe(NOTE_KIND_SENTENCES.SAD_LOW);
    expect(noteKindSentenceFor(["better", "exhausted"])).toBe(NOTE_KIND_SENTENCES.TIRED);
    expect(noteKindSentenceFor(["worried", "calm"])).toBe(NOTE_KIND_SENTENCES.WORRIED);
    expect(noteKindSentenceFor(["okay"])).toBe(NOTE_KIND_SENTENCES.HAPPY_GOOD);
    // A negated cue has no group: "not good" never gets "That's wonderful to hear".
    expect(noteKindSentenceFor(["not-good"])).toBe(NOTE_KIND_SENTENCES.OTHER);
    expect(noteKindSentenceFor(["not-good", "tired"])).toBe(NOTE_KIND_SENTENCES.TIRED);
    expect(noteKindSentenceFor([])).toBe(NOTE_KIND_SENTENCES.OTHER);
  });
});
