// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VOICE_DISTRESS_CUES, VOICE_DISTRESS_CUE_KEYS, detectVoiceDistress, normaliseForDistress } from "./voice-distress-gate";

/** Owner decision 2026-10-14: every cue, in a sentence, with its contraction and apostrophe variants. */
const MATCHES: ReadonlyArray<readonly [string, string]> = [
  ["I want to die", "WANT_TO_DIE"],
  ["i wanna die", "WANT_TO_DIE"],
  ["Sometimes I just want to die.", "WANT_TO_DIE"],
  ["I want to be dead", "WANT_TO_BE_DEAD"],
  ["I wanna be dead", "WANT_TO_BE_DEAD"],
  ["I wish I was dead", "WISH_DEAD"],
  ["I wish I were dead", "WISH_DEAD"],
  ["I'm going to kill myself", "KILL_MYSELF"],
  ["I am thinking of killing myself", "KILL_MYSELF"],
  ["I could kill my self", "KILL_MYSELF"],
  ["I want to end my life", "END_MY_LIFE"],
  ["I keep thinking about ending my life", "END_MY_LIFE"],
  ["I just want to end it all", "END_IT_ALL"],
  ["ending it all would be easier", "END_IT_ALL"],
  ["I might take my own life", "TAKE_MY_OWN_LIFE"],
  ["I want to hurt myself", "HURT_MYSELF"],
  ["I keep hurting myself", "HURT_MYSELF"],
  ["I want to harm myself", "HARM_MYSELF"],
  ["I have been thinking about self harm", "HARM_MYSELF"],
  ["self-harm", "HARM_MYSELF"],
  ["Self‐Harm again", "HARM_MYSELF"],
  ["I cut myself last night", "CUT_MYSELF"],
  ["There is no reason to live", "NO_REASON_TO_LIVE"],
  ["I have nothing to live for", "NOTHING_TO_LIVE_FOR"],
  ["I don't want to live anymore", "NOT_WANT_TO_LIVE"],
  ["I don’t want to live anymore", "NOT_WANT_TO_LIVE"],
  ["I dont want to live", "NOT_WANT_TO_LIVE"],
  ["I do not want to live", "NOT_WANT_TO_LIVE"],
  ["I DON'T WANT TO LIVE", "NOT_WANT_TO_LIVE"],
  ["I don't want to be alive", "NOT_WANT_TO_BE_ALIVE"],
  ["I don’t want to be here anymore", "NOT_WANT_TO_BE_HERE"],
  ["I dont want to be here any more", "NOT_WANT_TO_BE_HERE"],
  ["I can't go on", "CANNOT_GO_ON"],
  ["I can’t go on like this", "CANNOT_GO_ON"],
  ["I cant go on", "CANNOT_GO_ON"],
  ["I cannot go on", "CANNOT_GO_ON"],
  ["I can not go on", "CANNOT_GO_ON"],
  ["Everyone would be better off dead", "BETTER_OFF_DEAD"],
  ["I'd be better off dead", "BETTER_OFF_DEAD"],
  ["My family would be better off without me", "BETTER_OFF_WITHOUT_ME"],
  ["I have thought about suicide", "SUICIDE"],
  ["I'm suicidal", "SUICIDE"],
  ["Im feeling suicidal today", "SUICIDE"],
  ["Sugar 7.2 mmol, I want to die.", "WANT_TO_DIE"],
  ["血糖七点二，I want to die", "WANT_TO_DIE"],
];

/** Ordinary phrases that must stay ordinary (owner list and near misses). */
const NEAR_MISSES: readonly string[] = [
  "this traffic is killing me",
  "I'm dying to eat chicken rice",
  "my legs hurt",
  "I cut the cake",
  "I can go on a walk",
  "end of the day",
  "my sugar went up",
  "my sugar was 7.2 at the end of the day",
  "I hurt my knee",
  "the cut on my finger is healing",
  "I want to diet",
  "I live alone",
  "I want to live healthier",
  "I can go on",
  "I ended my lunch early",
  "it all ended well",
  "I take my own medicine",
  "I took my life insurance papers to the clinic",
  "harmless",
  "better off with rice",
  "Lunch was chicken rice and I injected my dark pen",
  "我午饭吃了鸡饭",
  "",
  "   ",
];

describe("voice distress gate (voice-distress-cues.1; owner decision 2026-10-14)", () => {
  it("is versioned and frozen, with one entry per cue key", () => {
    expect(VOICE_DISTRESS_CUES.version).toBe("voice-distress-cues.1");
    expect(Object.isFrozen(VOICE_DISTRESS_CUES)).toBe(true);
    expect(Object.isFrozen(VOICE_DISTRESS_CUES.cues)).toBe(true);
    for (const entry of VOICE_DISTRESS_CUES.cues) expect(Object.isFrozen(entry.phrases), entry.key).toBe(true);
    expect(VOICE_DISTRESS_CUES.cues.map((entry) => entry.key)).toEqual([...VOICE_DISTRESS_CUE_KEYS]);
  });

  it("matches every cue phrase on its own", () => {
    for (const entry of VOICE_DISTRESS_CUES.cues) {
      for (const phrase of entry.phrases) expect(detectVoiceDistress(phrase), phrase).toEqual({ kind: "DISTRESS", cueKey: entry.key });
    }
  });

  it("matches every cue in a sentence, with contraction, apostrophe, case and hyphen variants", () => {
    for (const [text, cueKey] of MATCHES) expect(detectVoiceDistress(text), text).toEqual({ kind: "DISTRESS", cueKey });
  });

  it("does not match ordinary phrases", () => {
    for (const text of NEAR_MISSES) expect(detectVoiceDistress(text), text).toEqual({ kind: "NONE" });
  });

  it("accepts the safety-first false positive: 'I don't want to die' shows the helplines", () => {
    expect(detectVoiceDistress("I don't want to die")).toEqual({ kind: "DISTRESS", cueKey: "WANT_TO_DIE" });
  });

  it("normalises apostrophes, contractions and whitespace the same way for cues and transcripts", () => {
    expect(normaliseForDistress("  I’m  NOT ok, I can’t   go on — I dont   know  ")).toBe("i am not ok i can not go on i do not know");
    expect(normaliseForDistress("I wanna stop; any more")).toBe("i want to stop anymore");
  });

  it("is pure: no clock, randomness, storage, network or import", () => {
    const source = readFileSync(join(process.cwd(), "src/domain/voice/voice-distress-gate.ts"), "utf8");
    expect(source).not.toMatch(/Date\.|Math\.random|crypto|localStorage|sessionStorage|indexedDB|\bfetch\b|process\.env|^import /m);
  });

  it("treats non-string input as nothing to read", () => {
    expect(detectVoiceDistress(42 as unknown as string)).toEqual({ kind: "NONE" });
    expect(detectVoiceDistress(undefined as unknown as string)).toEqual({ kind: "NONE" });
  });
});
