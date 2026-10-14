// @vitest-environment node
import { describe, expect, it } from "vitest";
import { VOICE_ACTIVITY_CUES_VERSION, matchVoiceActivity, voiceActivityDuration, voiceActivityTimePhrase } from "./voice-activity-cues";
import { VOICE_FEELING_CUES, VOICE_FEELING_CUES_VERSION, matchVoiceFeeling, voiceFeelingGroupOf } from "./voice-feeling-cues";

/** Owner decision 2026-10-14 (Tell JagaOn understands more): the fixed cue lists on their own (the extractor wiring is tested in voice-feeling-activity.test.ts). */
describe("feeling cues (voice-feeling-cues.1)", () => {
  it("is versioned and lists the owner's five cue groups with lowercase keys", () => {
    expect(VOICE_FEELING_CUES_VERSION).toBe("voice-feeling-cues.1");
    expect(VOICE_FEELING_CUES.cues.map((cue) => cue.key)).toEqual([
      "tired", "exhausted", "sleepy", "drained", "worn-out",
      "worried", "anxious", "nervous", "uneasy",
      "stressed", "overwhelmed", "under-pressure", "frustrated", "irritated", "angry",
      "sad", "low", "down", "lonely", "upset", "hopeless", "miserable", "depressed",
      "happy", "good", "great", "fine", "okay", "better", "relieved", "calm",
    ]);
    for (const cue of VOICE_FEELING_CUES.cues) expect(cue.key).toMatch(/^[a-z]+(?:[-_][a-z]+)*$/);
    expect(["tired", "worried", "stressed", "low", "okay", "not-good", "unknown"].map(voiceFeelingGroupOf)).toEqual(["TIRED", "WORRIED", "STRESSED", "SAD_LOW", "HAPPY_GOOD", null, null]);
  });

  it("matches only at the start of a segment and returns the cue keys in order", () => {
    expect(matchVoiceFeeling("and feeling good")).toEqual({ cueKeys: ["good"], start: 4, end: 16 });
    expect(matchVoiceFeeling("walked and feeling good")).toBeNull();
    expect(matchVoiceFeeling("I'm sad, lonely and very tired")).toMatchObject({ cueKeys: ["sad", "lonely", "tired"] });
  });
});

describe("activity cues (voice-activity-cues.1)", () => {
  it("is versioned", () => expect(VOICE_ACTIVITY_CUES_VERSION).toBe("voice-activity-cues.1"));

  it("parses durations in digits and words up to 120 and refuses anything outside 1–1440 minutes", () => {
    const cases: Array<[string, number | null]> = [
      ["30 minutes", 30], ["30 mins", 30], ["30-minute", 30], ["45 min", 45], ["half an hour", 30], ["half hour", 30], ["an hour", 60],
      ["one hour", 60], ["2 hours", 120], ["1 hour 15 minutes", 75], ["1 hour and 15 minutes", 75], ["an hour and a half", 90],
      ["one and a half hours", 90], ["1.5 hours", 90], ["ninety minutes", 90], ["twenty five minutes", 25], ["twenty-five minutes", 25],
      ["a hundred and twenty minutes", 120], ["a quarter of an hour", 15], ["24 hours", 1440], ["25 hours", null], ["0 minutes", null],
      ["for hours", null], ["a while", null], ["5 km", null],
    ];
    for (const [text, minutes] of cases) expect(voiceActivityDuration(`walked ${text}`), text).toBe(minutes);
  });

  it("finds a time phrase in her words for the card summary", () => {
    expect(voiceActivityTimePhrase("Walked 30 minutes after dinner")).toBe("after dinner");
    expect(voiceActivityTimePhrase("I went for a walk this morning")).toBe("this morning");
    expect(voiceActivityTimePhrase("Walked 30 minutes")).toBeNull();
    expect(matchVoiceActivity("walked after my lunch")).toEqual({ category: "WALKING", durationMinutes: null });
  });
});
