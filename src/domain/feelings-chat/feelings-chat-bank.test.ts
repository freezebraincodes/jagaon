import { describe, expect, it } from "vitest";
import { FALLBACK_QUESTIONS, FEELINGS_CHAT_BANK_VERSION, KIND_SENTENCES, fallbackQuestion, feelingsChatBankReply, kindSentenceFor } from "./feelings-chat-bank";

/** Tell JagaOn understands more (design §3.4): the reviewed bank, with the owner-approved wording (2026-10-14) pinned exactly. */

describe("feelings-chat reviewed bank (feelings-chat-bank.1)", () => {
  it("holds the owner-approved kind sentences and fallback questions, exactly", () => {
    expect(FEELINGS_CHAT_BANK_VERSION).toBe("feelings-chat-bank.1");
    expect(KIND_SENTENCES).toEqual({
      TIRED: "That sounds like a tiring day. Thank you for telling me.",
      WORRIED: "It sounds like something has been on your mind. Thank you for sharing it.",
      STRESSED: "That sounds like a lot to carry. Thank you for telling me.",
      SAD_OR_LOW: "I'm sorry today feels hard. Thank you for sharing how you feel.",
      HAPPY_OR_GOOD: "It's good to hear that. Thank you for sharing it.",
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
});
