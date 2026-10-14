import { describe, expect, it } from "vitest";
import { ENCOURAGEMENT_LINES, FALLBACK_QUESTIONS, FEELINGS_CHAT_BANK_VERSION, GOOD_FEELING_CLOSING_LINE, KIND_SENTENCES, asksForEncouragement, encouragementLineFor, fallbackQuestion, feelingsChatBankReply, kindSentenceFor } from "./feelings-chat-bank";

/** Tell JagaOn understands more (design §3.4): the reviewed bank, with the owner-approved wording (2026-10-14) pinned exactly. */

describe("feelings-chat reviewed bank (feelings-chat-bank.2)", () => {
  it("holds the owner-approved kind sentences and fallback questions, exactly", () => {
    expect(FEELINGS_CHAT_BANK_VERSION).toBe("feelings-chat-bank.2");
    expect(KIND_SENTENCES).toEqual({
      TIRED: "That sounds like a tiring day. Thank you for telling me.",
      WORRIED: "It sounds like something has been on your mind. Thank you for sharing it.",
      STRESSED: "That sounds like a lot to carry. Thank you for telling me.",
      SAD_OR_LOW: "I'm sorry today feels hard. Thank you for sharing how you feel.",
      HAPPY_OR_GOOD: "That's wonderful to hear. Well done for keeping it up.",
      OTHER: "Thank you for telling me how you feel.",
    });
    expect(FALLBACK_QUESTIONS).toEqual(["What has been on your mind?", "How has this been affecting your day?", "Is there anything you'd like to remember to tell your doctor?"]);
  });

  it.each<[string[], string]>([
    [["tired"], "TIRED"],
    [["worried"], "WORRIED"],
    [["stressed"], "STRESSED"],
    [["sad"], "SAD_OR_LOW"],
    [["low"], "SAD_OR_LOW"],
    [["happy"], "HAPPY_OR_GOOD"],
    [["good"], "HAPPY_OR_GOOD"],
    [[], "OTHER"],
    [["confused"], "OTHER"],
    // The design's own example: "Feeling tired and a bit worried today" gets the tiring-day sentence, whatever the cue order.
    [["tired", "worried"], "TIRED"],
    [["worried", "tired"], "TIRED"],
    [["happy", "sad"], "SAD_OR_LOW"],
    [["tired", "stressed"], "STRESSED"],
    [[" Tired "], "TIRED"],
    // The cue → feeling mapping is the recogniser's cue list (voice-feeling-cues.1), the single source.
    [["worn-out"], "TIRED"],
    [["under-pressure"], "STRESSED"],
    [["okay"], "HAPPY_OR_GOOD"],
    [["not-good"], "OTHER"],
  ])("picks the kind sentence for %j deterministically", (cues, key) => {
    expect(kindSentenceFor(cues)).toEqual({ key, text: KIND_SENTENCES[key as keyof typeof KIND_SENTENCES] });
  });

  it("gives the fallback question per turn, clamped to 1–3", () => {
    expect([1, 2, 3].map(fallbackQuestion)).toEqual(FALLBACK_QUESTIONS);
    expect(fallbackQuestion(0)).toBe(FALLBACK_QUESTIONS[0]);
    expect(fallbackQuestion(9)).toBe(FALLBACK_QUESTIONS[2]);
    expect(fallbackQuestion(Number.NaN)).toBe(FALLBACK_QUESTIONS[0]);
  });

  it("the bank reply: the turn's question before the last turn, a local wrap-up from her first words at the last turn", () => {
    const messages = [{ role: "patient" as const, text: "  Feeling   tired today.  " }];
    expect(feelingsChatBankReply({ turn: 1, maxTurns: 3, messages })).toEqual({ kind: "QUESTION", question: FALLBACK_QUESTIONS[0], summary: null, doctorQuestion: null, themes: [], end: false });
    expect(feelingsChatBankReply({ turn: 2, maxTurns: 3, messages })).toMatchObject({ kind: "QUESTION", question: FALLBACK_QUESTIONS[1] });
    expect(feelingsChatBankReply({ turn: 3, maxTurns: 3, messages })).toEqual({ kind: "WRAP_UP", question: null, summary: "Feeling tired today.", doctorQuestion: null, themes: [], end: true });
    const long = feelingsChatBankReply({ turn: 3, maxTurns: 3, messages: [{ role: "patient", text: "word ".repeat(60) }] });
    expect(Array.from(long.summary!).length).toBeLessThanOrEqual(160);
    expect(long.summary!.endsWith("…")).toBe(true);
  });

  it("feelings-chat-bank.2: the owner-approved encouragement and closing lines, exact", () => {
    expect(ENCOURAGEMENT_LINES).toEqual({
      GOOD: "You've been showing up for yourself, and that's worth being proud of.",
      HARD: "Things feel hard right now, and it still took courage to talk about it.",
    });
    expect(GOOD_FEELING_CLOSING_LINE).toBe("Well done. Noticing what's going well matters.");
    expect(encouragementLineFor("HAPPY_OR_GOOD")).toBe(ENCOURAGEMENT_LINES.GOOD);
    for (const key of ["SAD_OR_LOW", "STRESSED", "TIRED", "WORRIED", "OTHER"] as const) expect(encouragementLineFor(key)).toBe(ENCOURAGEMENT_LINES.HARD);
  });

  it("recognises a request for encouragement or motivation, and not a statement of feeling motivated", () => {
    for (const text of ["can you give me some encouragement", "Motivate me please", "I need some motivation", "cheer me up", "say something nice", "any kind words?", "encourage me"]) {
      expect(asksForEncouragement(text), text).toBe(true);
    }
    for (const text of ["I feel motivated", "my family is encouraging", "I walked every morning", "nice weather"]) expect(asksForEncouragement(text), text).toBe(false);
  });
});
