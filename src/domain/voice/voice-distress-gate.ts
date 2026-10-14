/**
 * Owner decision 2026-10-14 (distress safety): the deterministic distress gate. It runs FIRST on every Tell JagaOn transcript, before
 * the advice redirect, the length limit and any extraction. On a match the app shows ONLY a calm safety message with helplines: no
 * fact card, no "not captured" list, no redirect, no remote AI extraction offer, and nothing is saved (owner chose "no save").
 *
 * Pure and local: no clock, no storage, no network, no provider. It returns which cue matched, never the transcript.
 *
 * Matching: the transcript is normalised (lowercase; curly and straight apostrophes unified; punctuation and hyphens become spaces;
 * whitespace collapsed; "dont"/"don't" → "do not", "cant"/"can't"/"cannot" → "can not", "wanna" → "want to", "im"/"i'm" → "i am",
 * "any more" → "anymore", "my self" → "myself"), and every cue phrase is normalised the same way and matched as a WHOLE phrase on word
 * boundaries ("this traffic is killing me", "I'm dying to eat chicken rice", "I cut the cake", "I can go on a walk" do not match).
 * English cues apply to every transcript whatever the session language (harmless on Chinese text; Chinese cues are not in scope yet).
 *
 * Safety first: a false positive is the accepted direction. "I don't want to die", "I hurt myself when I fell", "I cut myself
 * shaving" or "I cannot go on a walk today" show the helplines; that is acceptable, a missed cry for help is not.
 */
export const VOICE_DISTRESS_CUES_VERSION = "voice-distress-cues.1";

export const VOICE_DISTRESS_CUE_KEYS = [
  "WANT_TO_DIE",
  "WANT_TO_BE_DEAD",
  "WISH_DEAD",
  "KILL_MYSELF",
  "END_MY_LIFE",
  "END_IT_ALL",
  "TAKE_MY_OWN_LIFE",
  "HURT_MYSELF",
  "HARM_MYSELF",
  "CUT_MYSELF",
  "NO_REASON_TO_LIVE",
  "NOTHING_TO_LIVE_FOR",
  "NOT_WANT_TO_LIVE",
  "NOT_WANT_TO_BE_ALIVE",
  "NOT_WANT_TO_BE_HERE",
  "CANNOT_GO_ON",
  "BETTER_OFF_DEAD",
  "BETTER_OFF_WITHOUT_ME",
  "SUICIDE",
] as const;
export type VoiceDistressCueKey = (typeof VOICE_DISTRESS_CUE_KEYS)[number];

export type VoiceDistressCue = Readonly<{ key: VoiceDistressCueKey; phrases: readonly string[] }>;

const cue = (key: VoiceDistressCueKey, ...phrases: string[]): VoiceDistressCue => Object.freeze({ key, phrases: Object.freeze(phrases) });

/** The versioned English cue list (owner decision 2026-10-14). Phrases are written naturally; they are normalised before matching. */
export const VOICE_DISTRESS_CUES: Readonly<{ version: typeof VOICE_DISTRESS_CUES_VERSION; cues: readonly VoiceDistressCue[] }> = Object.freeze({
  version: VOICE_DISTRESS_CUES_VERSION,
  cues: Object.freeze([
    cue("WANT_TO_DIE", "want to die"),
    cue("WANT_TO_BE_DEAD", "want to be dead"),
    cue("WISH_DEAD", "wish i was dead", "wish i were dead"),
    cue("KILL_MYSELF", "kill myself", "killing myself"),
    cue("END_MY_LIFE", "end my life", "ending my life"),
    cue("END_IT_ALL", "end it all", "ending it all"),
    cue("TAKE_MY_OWN_LIFE", "take my own life"),
    cue("HURT_MYSELF", "hurt myself", "hurting myself"),
    cue("HARM_MYSELF", "harm myself", "self harm", "self-harm"),
    cue("CUT_MYSELF", "cut myself"),
    cue("NO_REASON_TO_LIVE", "no reason to live"),
    cue("NOTHING_TO_LIVE_FOR", "nothing to live for"),
    cue("NOT_WANT_TO_LIVE", "don't want to live"),
    cue("NOT_WANT_TO_BE_ALIVE", "don't want to be alive"),
    cue("NOT_WANT_TO_BE_HERE", "don't want to be here anymore"),
    cue("CANNOT_GO_ON", "can't go on"),
    cue("BETTER_OFF_DEAD", "better off dead"),
    cue("BETTER_OFF_WITHOUT_ME", "better off without me"),
    cue("SUICIDE", "suicide", "suicidal"),
  ]),
});

export type VoiceDistressDecision = Readonly<{ kind: "DISTRESS"; cueKey: VoiceDistressCueKey }> | Readonly<{ kind: "NONE" }>;

/** Word boundaries for the normalised text: letters, digits and apostrophes are word characters. */
const word = (pattern: string) => new RegExp(`(?<![\\p{L}\\p{N}'])(?:${pattern})(?![\\p{L}\\p{N}'])`, "gu");
const EQUIVALENTS: ReadonlyArray<readonly [RegExp, string]> = Object.freeze([
  [word("don't|dont"), "do not"],
  [word("can't|cant|cannot"), "can not"],
  [word("wanna"), "want to"],
  [word("i'm|im"), "i am"],
  [word("any more"), "anymore"],
  [word("my self"), "myself"],
] as const);

/** Exported for tests: the normalisation applied to transcripts and cue phrases alike. */
export function normaliseForDistress(text: string): string {
  let normal = text
    .toLowerCase()
    .replace(/[‘’ʼʹ′`´]/g, "'")
    // Punctuation, symbols and hyphens separate words; the apostrophe stays (contractions).
    .replace(/[^\p{L}\p{N}'\s]|_/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  for (const [pattern, replacement] of EQUIVALENTS) normal = normal.replace(pattern, replacement);
  return normal.replace(/\s+/g, " ");
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const MATCHERS: ReadonlyArray<readonly [VoiceDistressCueKey, RegExp]> = Object.freeze(
  VOICE_DISTRESS_CUES.cues.map((entry) => {
    const phrases = [...new Set(entry.phrases.map(normaliseForDistress))].map(escape);
    return Object.freeze([entry.key, new RegExp(`(?<![\\p{L}\\p{N}'])(?:${phrases.join("|")})(?![\\p{L}\\p{N}'])`, "u")] as const);
  }),
);

/** DISTRESS with the first matching cue (in list order), else NONE. Any non-string input is NONE (nothing to read). */
export function detectVoiceDistress(transcript: string): VoiceDistressDecision {
  if (typeof transcript !== "string" || transcript.trim().length === 0) return Object.freeze({ kind: "NONE" });
  const normal = normaliseForDistress(transcript);
  for (const [cueKey, matcher] of MATCHERS) if (matcher.test(normal)) return Object.freeze({ kind: "DISTRESS", cueKey });
  return Object.freeze({ kind: "NONE" });
}
