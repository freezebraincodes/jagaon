// @vitest-environment node
import { describe, expect, it } from "vitest";
import { VOICE_ACTIVITY_CUES_VERSION, matchVoiceActivity, voiceActivityDuration, voiceActivityTimePhrase } from "./voice-activity-cues";
import { VOICE_FEELING_CUES, VOICE_FEELING_CUES_VERSION, matchVoiceFeeling, voiceFeelingGroupOf } from "./voice-feeling-cues";

/** Owner decision 2026-10-14 (Tell JagaOn understands more): the fixed cue lists on their own (the extractor wiring is tested in voice-feeling-activity.test.ts). */
describe("feeling cues (voice-feeling-cues.2)", () => {
  it("is versioned and lists the owner's five cue groups with lowercase keys", () => {
    expect(VOICE_FEELING_CUES_VERSION).toBe("voice-feeling-cues.2");
    expect(VOICE_FEELING_CUES.cues.map((cue) => cue.key)).toEqual([
      "tired", "exhausted", "sleepy", "drained", "worn-out",
      "worried", "anxious", "nervous", "uneasy",
      "stressed", "overwhelmed", "under-pressure", "frustrated", "irritated", "angry",
      "sad", "low", "down", "lonely", "upset", "hopeless", "miserable", "depressed",
      "happy", "good", "great", "fine", "okay", "better", "relieved", "calm",
      "proud", "excited", "grateful", "thankful", "glad", "hopeful", "motivated", "confident", "content", "cheerful", "peaceful",
      "scared", "afraid", "frightened",
    ]);
    for (const cue of VOICE_FEELING_CUES.cues) expect(cue.key).toMatch(/^[a-z]+(?:[-_][a-z]+)*$/);
    expect(["tired", "worried", "stressed", "low", "okay", "not-good", "unknown"].map(voiceFeelingGroupOf)).toEqual(["TIRED", "WORRIED", "STRESSED", "SAD_LOW", "HAPPY_GOOD", null, null]);
  });

  it("matches only at the start of a segment and returns the cue keys in order", () => {
    expect(matchVoiceFeeling("and feeling good")).toEqual({ cueKeys: ["good"], start: 4, end: 16 });
    expect(matchVoiceFeeling("walked and feeling good")).toBeNull();
    expect(matchVoiceFeeling("I'm sad, lonely and very tired")).toMatchObject({ cueKeys: ["sad", "lonely", "tired"] });
  });

  it("voice-feeling-cues.2: good moments and a few more feelings, whatever follows the new words", () => {
    const cases: Array<[string, string[]]> = [
      ["feeling proud of myself this week", ["proud"]],
      ["I feel proud that I walked every morning", ["proud"]],
      ["I'm excited about my holiday", ["excited"]],
      ["I feel grateful for my family", ["grateful"]],
      ["I am glad my daughter visited", ["glad"]],
      ["I'm thankful", ["thankful"]],
      ["I feel hopeful and a bit nervous", ["hopeful", "nervous"]],
      ["I've been feeling motivated lately", ["motivated"]],
      ["I feel confident, calm and peaceful", ["confident", "calm", "peaceful"]],
      ["I'm content", ["content"]],
      ["feeling cheerful today", ["cheerful"]],
      ["I'm scared", ["scared"]],
      ["I feel afraid and frightened", ["afraid", "frightened"]],
    ];
    for (const [text, keys] of cases) expect(matchVoiceFeeling(text), text).toMatchObject({ cueKeys: keys });
    expect(["proud", "excited", "grateful", "scared", "afraid"].map(voiceFeelingGroupOf)).toEqual(["HAPPY_GOOD", "HAPPY_GOOD", "HAPPY_GOOD", "WORRIED", "WORRIED"]);
  });

  it("voice-feeling-cues.2: \"that\" after an everyday good word is a feeling only after her own \"I feel\" or \"I'm\"", () => {
    expect(matchVoiceFeeling("I feel pretty happy that my sugar level has been within the control")).toMatchObject({ cueKeys: ["happy"] });
    expect(matchVoiceFeeling("I'm relieved that the test is over")).toMatchObject({ cueKeys: ["relieved"] });
    expect(matchVoiceFeeling("I am happy that it worked")).toMatchObject({ cueKeys: ["happy"] });
    // Still not feelings: no "I feel"/"I'm", another follower, another subject, or a noun.
    for (const text of ["happy that you came", "I'm happy to help", "I'm fine with rice", "good for you", "my son is proud of his results", "the content of the leaflet"]) {
      expect(matchVoiceFeeling(text), text).toBeNull();
    }
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
