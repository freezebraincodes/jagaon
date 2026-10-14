// @vitest-environment node
import { describe, expect, it } from "vitest";
import { NOTE_KIND_SENTENCES, NOTE_KIND_SENTENCES_VERSION, noteKindSentenceFor } from "./note-kind-sentences";

/** Owner decision 2026-10-14 (design §3.4): the owner-approved kind sentences, verbatim, and the cue-group priority. */
describe("reviewed kind sentences for Save as a note", () => {
  it("are the owner-approved wording, verbatim", () => {
    expect(NOTE_KIND_SENTENCES_VERSION).toBe("note-kind-sentences.1");
    expect(NOTE_KIND_SENTENCES).toEqual({
      TIRED: "That sounds like a tiring day. Thank you for telling me.",
      WORRIED: "It sounds like something has been on your mind. Thank you for sharing it.",
      STRESSED: "That sounds like a lot to carry. Thank you for telling me.",
      SAD_LOW: "I'm sorry today feels hard. Thank you for sharing how you feel.",
      HAPPY_GOOD: "It's good to hear that. Thank you for sharing it.",
      OTHER: "Thank you for telling me how you feel.",
    });
  });

  it("chooses by the first matching group: sad/low > stressed > worried > tired > happy/good > other", () => {
    expect(noteKindSentenceFor(["tired"])).toBe(NOTE_KIND_SENTENCES.TIRED);
    expect(noteKindSentenceFor(["tired", "worried"])).toBe(NOTE_KIND_SENTENCES.WORRIED);
    expect(noteKindSentenceFor(["worried", "overwhelmed"])).toBe(NOTE_KIND_SENTENCES.STRESSED);
    expect(noteKindSentenceFor(["happy", "stressed", "lonely"])).toBe(NOTE_KIND_SENTENCES.SAD_LOW);
    expect(noteKindSentenceFor(["better", "exhausted"])).toBe(NOTE_KIND_SENTENCES.TIRED);
    expect(noteKindSentenceFor(["okay"])).toBe(NOTE_KIND_SENTENCES.HAPPY_GOOD);
    // A negated cue has no group: "not good" never gets "It's good to hear that".
    expect(noteKindSentenceFor(["not-good"])).toBe(NOTE_KIND_SENTENCES.OTHER);
    expect(noteKindSentenceFor(["not-good", "tired"])).toBe(NOTE_KIND_SENTENCES.TIRED);
    expect(noteKindSentenceFor([])).toBe(NOTE_KIND_SENTENCES.OTHER);
  });
});
