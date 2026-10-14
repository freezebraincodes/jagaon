// @vitest-environment node
import { describe, expect, it } from "vitest";
import { analyseTranscript } from "./voice-candidate-extractor";
import { candidateMatchesTranscript, voiceAnalysisSchema, type VoiceAnalysis } from "./voice-contracts";
import { gateRemoteTranscriptExtraction } from "./voice-remote-extraction-gate";

/**
 * Owner decision 2026-10-14 (Tell JagaOn understands more, design §2–§4; voice-contract.13s.6): the deterministic feeling and activity
 * recognition, its priority against the distress gate and the health redirect, and its false-positive boundaries. Summary notation as
 * in the pinned corpus, plus F(cue+cue) for a feeling and A(CATEGORY minutes|-) for an activity.
 */
function summarise(result: VoiceAnalysis): string {
  if (result.kind === "REDIRECT") return `REDIRECT:${result.category === "HEALTH_QUESTION" ? "HEALTH" : "DOSE"}`;
  if (result.kind !== "ANALYSED") return result.kind;
  return (
    (result.redirect ? `R:${result.redirect.category === "HEALTH_QUESTION" ? "HEALTH" : "DOSE"}+ ` : "") +
    result.candidates
      .map((c) => {
        if (c.kind === "GLUCOSE_READING") return `G(${c.valueText} ${c.unitSource ?? "-"} ${c.ambiguity.join("+") || "OK"})`;
        if (c.kind === "MEAL_NOTE") return `M(${c.slot} ${JSON.stringify(c.itemText)})`;
        if (c.kind === "MEDICATION_OCCURRENCE") return `D(${c.status})`;
        if (c.kind === "FEELING_NOTE") return `F(${c.cueKeys.join("+")})`;
        if (c.kind === "ACTIVITY_NOTE") return `A(${c.category} ${c.durationMinutes ?? "-"})`;
        return `U(${JSON.stringify(c.sourcePhrase)})`;
      })
      .join(" ")
  );
}
function analyse(text: string): VoiceAnalysis {
  const result = analyseTranscript(text, "en", { glucoseEntryUnit: "MMOL_PER_L" });
  expect(voiceAnalysisSchema.safeParse(result).success, text).toBe(true);
  for (const candidate of result.candidates) expect(candidateMatchesTranscript(candidate, text), candidate.sourcePhrase).toBe(true);
  return result;
}
const summary = (text: string) => summarise(analyse(text));

describe("feeling recognition (voice-feeling-cues.1)", () => {

  const POSITIVE: Array<[string, string]> = [
    ["Feeling tired and a bit worried today.", "F(tired+worried)"],
    ["Feeling tired and a bit worried today", "F(tired+worried)"],
    ["I feel exhausted", "F(exhausted)"],
    ["I felt so low this morning", "F(low)"],
    ["I'm so tired", "F(tired)"],
    ["I’m stressed out", "F(stressed)"],
    ["I am a bit worried", "F(worried)"],
    ["I was really upset", "F(upset)"],
    ["I've been feeling down lately", "F(down)"],
    ["a bit anxious", "F(anxious)"],
    ["Very overwhelmed", "F(overwhelmed)"],
    ["Tired today", "F(tired)"],
    ["Happy today", "F(happy)"],
    ["I'm fine", "F(fine)"],
    ["I feel ok", "F(okay)"],
    ["I'm under pressure at work", "F(under-pressure)"],
    ["Totally worn out", "F(worn-out)"],
    ["Tired today but feeling better", "F(tired+better)"],
    ["I'm a bit anxious and stressed out", "F(anxious+stressed)"],
    ["Feeling tired. I'm also lonely.", "F(tired+lonely)"],
    ["I'm not feeling good today", "F(not-good)"],
    // voice-feeling-cues.2 (owner request 2026-10-15): good moments and a few more feelings.
    ["I feel pretty happy that my sugar level has been within the control", "F(happy)"],
    ["I feel proud that I walked every morning this week", "F(proud)"],
    ["I'm excited about my holiday", "F(excited)"],
    ["I feel grateful for my family", "F(grateful)"],
    ["I'm scared", "F(scared)"],
    // voice-feeling-cues.3 (owner request 2026-10-15): doubt and confusion.
    ["I feel skeptical about what Dr Lim has told me", "F(skeptical)"],
    ["I feel confused", "F(confused)"],
    // Owner report 2026-10-15: unpunctuated speech, a request before the feeling.
    ["can you give me some motivation I feel very down", "U(\"can you give me some motivation\") F(down)"],
    ["my sugar was 8 I feel tired", "G(8 - UNIT_UNSTATED+UNCERTAINTY) F(tired)"],
    ["I'm not tired but worried", "F(not-tired+worried)"],
    ["I'm worried about my sugar", "F(worried)"],
    ["I feel hopeless", "F(hopeless)"],
  ];
  for (const [text, expected] of POSITIVE) it(`statement: ${JSON.stringify(text)} → ${expected}`, () => expect(summary(text)).toBe(expected));

  it("keeps her own words as the note text (the sentence with its closing mark) and a span inside the transcript", () => {
    const result = analyse("Feeling tired and a bit worried today.");
    expect(result.candidates).toEqual([
      expect.objectContaining({ kind: "FEELING_NOTE", cueKeys: ["tired", "worried"], text: "Feeling tired and a bit worried today.", sourcePhrase: "Feeling tired and a bit worried today", source: "DETERMINISTIC" }),
    ]);
    const merged = analyse("Feeling tired. Sugar 6.8 mmol. I'm also lonely.");
    const feelings = merged.candidates.filter((candidate) => candidate.kind === "FEELING_NOTE");
    expect(feelings).toHaveLength(1);
    expect(feelings[0]).toMatchObject({ cueKeys: ["tired", "lonely"] });
  });

  const NEGATIVE: string[] = [
    "Good morning",
    "Good night",
    "My sugar is good",
    "My sugar was low",
    "I'm fine with rice",
    "I'm happy to eat",
    "She is feeling tired",
    "My husband feels low",
    "The food was very good",
    "very good",
    "So good",
    "I was down at the market",
    "Fine",
    "Tired",
    "I'm going to be fine",
    "Lunch was good",
    // Owner report 2026-10-15: questions about a feeling stay questions (never a Feeling card).
    "why do I feel so tired",
    "when I feel tired I walk",
    "I feel worried what should I do",
  ];
  for (const text of NEGATIVE) {
    it(`not a feeling: ${JSON.stringify(text)}`, () => {
      const result = analyse(text);
      expect(result.candidates.some((candidate) => candidate.kind === "FEELING_NOTE"), summarise(result)).toBe(false);
    });
  }

});

describe("activity recognition (voice-activity-cues.1)", () => {

  const POSITIVE: Array<[string, string]> = [
    ["Walked 30 minutes after dinner", "A(WALKING 30)"],
    ["I went for a walk this morning", "A(WALKING -)"],
    ["Went for a 30-minute walk", "A(WALKING 30)"],
    ["I had a brisk walk for half an hour", "A(WALKING 30)"],
    ["Walk 30 mins after lunch", "A(WALKING 30)"],
    ["Jogged for an hour", "A(AEROBIC 60)"],
    ["Went jogging", "A(AEROBIC -)"],
    ["Ran for 20 minutes", "A(AEROBIC 20)"],
    ["Swam for 1 hour 15 minutes", "A(AEROBIC 75)"],
    ["Cycled an hour and a half", "A(AEROBIC 90)"],
    ["I exercised for forty five minutes", "A(OTHER 45)"],
    ["Did some exercise", "A(OTHER -)"],
    ["Did a workout", "A(OTHER -)"],
    ["I worked out this morning", "A(OTHER -)"],
    ["Did 20 minutes of yoga", "A(FLEXIBILITY_OR_MOBILITY 20)"],
    ["Stretching for ten minutes", "A(FLEXIBILITY_OR_MOBILITY 10)"],
    ["Tai chi in the park for one and a half hours", "A(FLEXIBILITY_OR_MOBILITY 90)"],
    ["Taiji this morning", "A(FLEXIBILITY_OR_MOBILITY -)"],
    ["Gardening this morning for half an hour", "A(HOUSEHOLD_ACTIVITY 30)"],
    // "Did the housework" (no "I") reads as a clause-initial auxiliary question ("Did the …"), so it is never a fact.
    ["I did the housework", "A(HOUSEHOLD_ACTIVITY -)"],
    ["Cleaned the house", "A(HOUSEHOLD_ACTIVITY -)"],
    ["Walked ninety minutes", "A(WALKING 90)"],
    ["We walked a hundred and twenty minutes", "A(WALKING 120)"],
  ];
  for (const [text, expected] of POSITIVE) it(`statement: ${JSON.stringify(text)} → ${expected}`, () => expect(summary(text)).toBe(expected));

  it("keeps her words as the label", () => {
    expect(analyse("Walked 30 minutes after dinner").candidates).toEqual([
      expect.objectContaining({ kind: "ACTIVITY_NOTE", category: "WALKING", label: "Walked 30 minutes after dinner", durationMinutes: 30, source: "DETERMINISTIC" }),
    ]);
  });

  const NEGATIVE: string[] = [
    "I didn't walk today",
    "No exercise today",
    "I will walk later",
    "I need to exercise more",
    "Going to swim tomorrow",
    "I walk every day",
    "I usually swim",
    "My husband walked 30 minutes",
    "The walk to the clinic was long",
    "I run a shop",
    "I ran out of insulin",
    "Ran 5 km",
    "my cycle",
    "After my walk",
    "Before walking",
  ];
  for (const text of NEGATIVE) {
    it(`not an activity: ${JSON.stringify(text)}`, () => {
      const result = analyse(text);
      expect(result.candidates.some((candidate) => candidate.kind === "ACTIVITY_NOTE"), summarise(result)).toBe(false);
    });
  }

});

describe("priority: distress first, a question keeps the redirect, a statement becomes a card", () => {
  it("the distress gate still runs first", () => {
    for (const text of ["I feel so tired I want to die", "Feeling hopeless, I want to end my life", "Walked 30 minutes, I want to die"]) {
      expect(analyse(text)).toMatchObject({ kind: "DISTRESS", candidates: [] });
      expect(gateRemoteTranscriptExtraction(text, "en")).toEqual({ kind: "WITHHOLD", reason: "REDIRECT_CONTENT" });
    }
  });

  it("a health question keeps the existing redirect; a statement with the same words is a feeling or an activity", () => {
    expect(summary("Should I be worried about my sugar?")).toBe("REDIRECT:HEALTH");
    expect(summary("Should I exercise after meals?")).toBe("REDIRECT:HEALTH");
    expect(summary("Can I exercise today?")).toBe("REDIRECT:HEALTH");
    expect(summary("I'm worried about my sugar")).toBe("F(worried)");
    expect(summary("I exercised after my meal")).toBe("A(OTHER -)");
  });

  it("a separable statement beside a question is kept, with the redirect notice", () => {
    expect(summary("I'm worried. Should I see a doctor?")).toBe("R:HEALTH+ F(worried)");
    expect(summary("I walked 30 minutes. Should I exercise more?")).toBe("R:HEALTH+ A(WALKING 30)");
  });

  it("\"After my walk my sugar was 6.1\" stays one glucose reading (pinned corpus outcome)", () => {
    expect(summary("After my walk my sugar was 6.1")).toBe("G(6.1 APP_DEFAULT OK)");
    expect(summary("Sugar 7.2 after my walk")).toBe("G(7.2 APP_DEFAULT OK)");
  });

  it("facts beside a feeling or activity: each is its own card; a reading keeps the round-4 C1 backstop (edit-only)", () => {
    expect(summary("Walked 30 minutes, sugar 6.1")).toBe("A(WALKING 30) G(6.1 - UNIT_UNSTATED+UNCERTAINTY)");
    expect(summary("Feeling tired. Sugar 6.8")).toBe("F(tired) G(6.8 - UNIT_UNSTATED+UNCERTAINTY)");
    expect(summary("I had chicken rice for lunch, feeling happy")).toBe('M(LUNCH "chicken rice") F(happy)');
    expect(summary("Walked 30 minutes and feeling good")).toBe("A(WALKING 30) F(good)");
    expect(summary("Feeling stressed, I walked 45 mins")).toBe("F(stressed) A(WALKING 45)");
  });

  it("Chinese sessions are unchanged (English cues only in this scope)", () => {
    const result = analyseTranscript("我今天很累，散步了三十分钟", "zh");
    expect(result.candidates.some((candidate) => candidate.kind === "FEELING_NOTE" || candidate.kind === "ACTIVITY_NOTE")).toBe(false);
  });

  it("a transcript with a feeling or an activity may still be offered for remote extraction (the gate is unchanged)", () => {
    expect(gateRemoteTranscriptExtraction("Feeling tired and a bit worried today", "en").kind).toBe("PERMIT");
    expect(gateRemoteTranscriptExtraction("Walked 30 minutes after dinner", "en").kind).toBe("PERMIT");
  });
});
