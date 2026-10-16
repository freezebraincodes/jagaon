/**
 * Owner decision 2026-10-14 (Tell JagaOn understands more, design §2 and §3.1 steps 1–3): the deterministic feeling recognition,
 * cue list `voice-feeling-cues.1` (English only; Chinese cues come after the hackathon). Pure: no clock, no storage, no network.
 *
 * A clause states a feeling when one of the cue words below appears in a FEELING PATTERN with nothing before it but fillers, time
 * words, the speaker's own "I" forms, a feel verb, intensifiers and negations:
 * - a feel verb: "feeling X", "feel X", "I feel X", "I felt X", "I've been feeling X";
 * - the speaker's own state: "I'm X", "I am X", "I was X", "I've been X";
 * - an intensifier at the clause start: "a bit X", "very X", "so X", "quite X", "really X";
 * - the cue at the clause start followed by a time word: "X today", "X this morning", "X lately".
 * Further cues joined to the first ("tired and a bit worried", "stressed, not happy") are collected too; the transcript yields ONE
 * feeling with every cue it said (deduplicated, in order).
 *
 * False-positive trade-offs (documented, deliberate):
 * - another subject ("She is tired", "My husband feels low", "The food was very good") never matches: only the speaker's own forms;
 * - the happy/good words need a feel verb, an "I" form or a time word ("So good" alone, "very good" alone and "good morning" do not
 *   match); "fine/okay/good/great/happy/better" followed by "with/to/for/about/if/that" ("I'm fine with rice", "happy to help") are not
 *   feelings; "down/low" followed by a place or amount word ("I was down at the market", "I'm low on insulin") are not feelings;
 * - a negated cue is kept as her words said it, with a "not-" key ("I'm not feeling good" → "not-good"), never flipped into a
 *   different feeling; the kind sentence for it is the neutral "other" one;
 * - the extractor never looks for a feeling in a question, in a clause that is a glucose, meal or medicine fact, or in a clause
 *   that was redirected; the distress gate always runs first and a distress transcript never reaches this module.
 * - Missed on purpose (stays "not understood"): "I don't feel well" ("well" is not a cue), "tired" alone with nothing else.
 *
 * voice-feeling-cues.2 (owner request 2026-10-15, good moments and a few more feelings): proud, excited, grateful, thankful, glad,
 * hopeful, motivated, confident, content, cheerful and peaceful (HAPPY_GOOD); scared, afraid and frightened (WORRIED). The new words
 * are feelings whatever follows ("excited about my holiday", "grateful for my family"); only the ambiguous everyday words (happy, good,
 * great, fine, okay, better, relieved, calm) keep the follower rule. "That" after one of those is a feeling when she said "I feel" or
 * "I'm" first ("I feel happy that my sugar has been in control"); "happy that you came" without them stays not a feeling.
 *
 * voice-feeling-cues.3 (owner request 2026-10-15, doubt and confusion): skeptical/sceptical, unsure, uncertain, doubtful, confused,
 * disappointed, embarrassed, ashamed, guilty, bored and hurt, in the OTHER group (the neutral kind sentence). Deliberately NOT a
 * catch-all "I feel <any word>": "I feel dizzy" or "shaky" can be a symptom (for example of low blood sugar) and must never become a
 * feelings chat, so symptom words stay out of this list.
 */
export const VOICE_FEELING_CUES_VERSION = "voice-feeling-cues.3";

export const VOICE_FEELING_GROUPS = ["TIRED", "WORRIED", "STRESSED", "SAD_LOW", "HAPPY_GOOD", "OTHER"] as const;
export type VoiceFeelingGroup = (typeof VOICE_FEELING_GROUPS)[number];

type FeelingCue = Readonly<{ key: string; group: VoiceFeelingGroup; words: readonly string[] }>;
const cue = (key: string, group: VoiceFeelingGroup, ...words: string[]): FeelingCue => Object.freeze({ key, group, words: Object.freeze(words.length > 0 ? words : [key]) });

/** The versioned English cue list. `key` is the stored cue key (lowercase; spaces become hyphens; "ok" is "okay"). */
export const VOICE_FEELING_CUES: Readonly<{ version: typeof VOICE_FEELING_CUES_VERSION; cues: readonly FeelingCue[] }> = Object.freeze({
  version: VOICE_FEELING_CUES_VERSION,
  cues: Object.freeze([
    cue("tired", "TIRED"),
    cue("exhausted", "TIRED"),
    cue("sleepy", "TIRED"),
    cue("drained", "TIRED"),
    cue("worn-out", "TIRED", "worn out"),
    cue("worried", "WORRIED"),
    cue("anxious", "WORRIED"),
    cue("nervous", "WORRIED"),
    cue("uneasy", "WORRIED"),
    cue("stressed", "STRESSED", "stressed", "stressed out"),
    cue("overwhelmed", "STRESSED"),
    cue("under-pressure", "STRESSED", "under pressure"),
    cue("frustrated", "STRESSED"),
    cue("irritated", "STRESSED"),
    cue("angry", "STRESSED"),
    cue("sad", "SAD_LOW"),
    cue("low", "SAD_LOW"),
    cue("down", "SAD_LOW"),
    cue("lonely", "SAD_LOW"),
    cue("upset", "SAD_LOW"),
    cue("hopeless", "SAD_LOW"),
    cue("miserable", "SAD_LOW"),
    cue("depressed", "SAD_LOW"),
    cue("happy", "HAPPY_GOOD"),
    cue("good", "HAPPY_GOOD"),
    cue("great", "HAPPY_GOOD"),
    cue("fine", "HAPPY_GOOD"),
    cue("okay", "HAPPY_GOOD", "okay", "ok"),
    cue("better", "HAPPY_GOOD"),
    cue("relieved", "HAPPY_GOOD"),
    cue("calm", "HAPPY_GOOD"),
    // voice-feeling-cues.2
    cue("proud", "HAPPY_GOOD"),
    cue("excited", "HAPPY_GOOD"),
    cue("grateful", "HAPPY_GOOD"),
    cue("thankful", "HAPPY_GOOD"),
    cue("glad", "HAPPY_GOOD"),
    cue("hopeful", "HAPPY_GOOD"),
    cue("motivated", "HAPPY_GOOD"),
    cue("confident", "HAPPY_GOOD"),
    cue("content", "HAPPY_GOOD"),
    cue("cheerful", "HAPPY_GOOD"),
    cue("peaceful", "HAPPY_GOOD"),
    cue("scared", "WORRIED"),
    cue("afraid", "WORRIED"),
    cue("frightened", "WORRIED"),
    // voice-feeling-cues.3
    cue("skeptical", "OTHER", "skeptical", "sceptical"),
    cue("unsure", "OTHER"),
    cue("uncertain", "OTHER"),
    cue("doubtful", "OTHER"),
    cue("confused", "OTHER"),
    cue("disappointed", "OTHER"),
    cue("embarrassed", "OTHER"),
    cue("ashamed", "OTHER"),
    cue("guilty", "OTHER"),
    cue("bored", "OTHER"),
    cue("hurt", "OTHER"),
  ]),
});

/** The group of a stored cue key ("tired" → TIRED); a negated key ("not-good") or an unknown key has no group (the neutral "other"). */
export function voiceFeelingGroupOf(cueKey: string): VoiceFeelingGroup | null {
  return VOICE_FEELING_CUES.cues.find((entry) => entry.key === cueKey)?.group ?? null;
}

type Token = Readonly<{ word: string; start: number; end: number }>;
const tokenise = (text: string): Token[] =>
  [...text.toLowerCase().replace(/[’]/g, "'").matchAll(/[a-z]+(?:'[a-z]+)?|\d+(?:\.\d+)?/g)].map((match) => ({ word: match[0], start: match.index, end: match.index + match[0].length }));

const LEADS = new Set(["because", "though", "although", "um", "uh", "er", "erm", "oh", "ah", "well", "so", "and", "but", "just", "also", "still", "really", "honestly", "today", "tonight", "now", "lately", "recently", "this", "morning", "afternoon", "evening", "yeah", "yes", "hi", "hello", "then", "actually"]);
const JOINERS = new Set(["and", "but", "so", "because", "though", "although", "then", "also", "um", "uh", "er", "erm", "oh", "ah", "well", "yeah", "yes"]);
const SUBJECT_CONTRACTED = new Set(["i'm", "im"]);
const SUBJECT = new Set(["i", "i've", "ive", ...SUBJECT_CONTRACTED]);
const AUX = new Set(["am", "was", "have", "been", "getting", "get", "got", "do", "did", "kept", "keep", "always"]);
const FEEL = new Set(["feeling", "feel", "felt", "feels"]);
const INTENSIFIERS = new Set(["a", "bit", "abit", "little", "very", "so", "quite", "really", "rather", "pretty", "kind", "of", "kinda", "somewhat", "extremely", "too", "slightly", "super", "more", "totally", "completely", "all", "most", "such", "terribly", "awfully"]);
const NEGATIONS = new Set(["not", "never", "don't", "dont", "didn't", "didnt", "isn't", "wasn't", "ain't", "haven't", "havent", "hasn't", "won't"]);
/** The connectors allowed between two cues of one feeling ("tired and a bit worried", "stressed, not happy"). */
const CONNECTORS = new Set(["and", "or", "but", "also", "plus", ...INTENSIFIERS, ...FEEL, ...SUBJECT, "am", "been", "still", "now"]);
const TIME_WORDS: readonly (readonly string[])[] = Object.freeze([
  ["today"], ["tonight"], ["now"], ["lately"], ["recently"], ["right", "now"], ["this", "morning"], ["this", "afternoon"], ["this", "evening"], ["this", "week"], ["all", "day"], ["these", "days"], ["at", "the", "moment"],
]);
const HAPPY_NOT_FEELING_FOLLOWERS = new Set(["with", "to", "for", "about", "if", "that", "by"]);
/** voice-feeling-cues.2: the everyday words the follower rule applies to ("happy to help", "fine with rice", "good for you"). */
const AMBIGUOUS_GOOD_WORDS = new Set(["happy", "good", "great", "fine", "okay", "better", "relieved", "calm"]);
const LOW_NOT_FEELING_FOLLOWERS = new Set(["to", "on", "at", "in", "from", "by", "the", "there", "here", "for", "under", "below", "than", "stairs", "town"]);

type CueHit = Readonly<{ cue: FeelingCue; start: number; end: number; nextIndex: number }>;
function cueAt(tokens: readonly Token[], index: number): CueHit | null {
  let best: CueHit | null = null;
  for (const entry of VOICE_FEELING_CUES.cues) {
    for (const words of entry.words) {
      const parts = words.split(" ");
      if (parts.every((part, offset) => tokens[index + offset]?.word === part) && (best === null || parts.length > best.nextIndex - index)) {
        best = { cue: entry, start: tokens[index]!.start, end: tokens[index + parts.length - 1]!.end, nextIndex: index + parts.length };
      }
    }
  }
  return best;
}
const timeWordAt = (tokens: readonly Token[], index: number) => TIME_WORDS.some((words) => words.every((word, offset) => tokens[index + offset]?.word === word));

/**
 * A cue followed by a word that makes it something other than a feeling ("fine with rice", "down at the market"). `ownFeeling`: she
 * said "I feel" or "I'm" before it, so "that" introduces what the feeling is about ("I feel happy that …").
 */
function notAFeeling(hit: CueHit, tokens: readonly Token[], ownFeeling = false): boolean {
  const next = tokens[hit.nextIndex]?.word;
  if (next === undefined) return false;
  if (AMBIGUOUS_GOOD_WORDS.has(hit.cue.key) && HAPPY_NOT_FEELING_FOLLOWERS.has(next) && !(next === "that" && ownFeeling)) return true;
  if ((hit.cue.key === "down" || hit.cue.key === "low") && LOW_NOT_FEELING_FOLLOWERS.has(next)) return true;
  return false;
}

export type VoiceFeelingMatch = Readonly<{ cueKeys: readonly string[]; start: number; end: number }>;

/**
 * The feeling stated at the START of `segment` (offsets relative to it), or null. The caller passes each clause and each part of a
 * clause after "and/but/so/because", so "Walked 30 minutes and feeling good" finds "feeling good". `continuation`: the previous clause
 * of the same sentence stated a feeling, so a cue alone continues it ("I'm not tired, but worried": the clause "worried").
 */
export function matchVoiceFeeling(segment: string, continuation = false): VoiceFeelingMatch | null {
  const tokens = tokenise(segment);
  let subject = false;
  let contracted = false;
  let aux = false;
  let feel = false;
  let intensifier = false;
  let negated = false;
  let index = 0;
  let first: CueHit | null = null;
  for (; index < tokens.length; index += 1) {
    const hit = cueAt(tokens, index);
    if (hit) {
      first = hit;
      break;
    }
    const word = tokens[index]!.word;
    if (NEGATIONS.has(word)) negated = true;
    else if (SUBJECT.has(word)) {
      subject = true;
      if (SUBJECT_CONTRACTED.has(word)) contracted = true;
    } else if (FEEL.has(word)) feel = true;
    else if (AUX.has(word)) aux = true;
    else if (INTENSIFIERS.has(word)) intensifier = true;
    else if (!LEADS.has(word)) return null;
  }
  if (first === null || notAFeeling(first, tokens, feel || contracted || (subject && aux))) return null;
  const timeAfter = timeWordAt(tokens, first.nextIndex);
  const stated = continuation || feel || (subject && (aux || contracted)) || timeAfter || (!subject && intensifier && first.cue.group !== "HAPPY_GOOD");
  if (!stated) return null;
  const keys: string[] = [negated ? `not-${first.cue.key}` : first.cue.key];
  let end = first.end;
  let gapNegated = false;
  for (let next = first.nextIndex; next < tokens.length; ) {
    const hit = cueAt(tokens, next);
    if (hit) {
      if (notAFeeling(hit, tokens, true)) break;
      keys.push(gapNegated ? `not-${hit.cue.key}` : hit.cue.key);
      end = hit.end;
      gapNegated = false;
      next = hit.nextIndex;
      continue;
    }
    const word = tokens[next]!.word;
    if (NEGATIONS.has(word)) gapNegated = true;
    else if (!CONNECTORS.has(word) && !timeWordAt(tokens, next) && !TIME_WORDS.some((words) => words.includes(word))) break;
    next += 1;
  }
  // The feeling starts at its first word that is not a joining word or filler ("and feeling good" starts at "feeling").
  const first0 = tokens.find((token) => !JOINERS.has(token.word)) ?? tokens[0]!;
  return Object.freeze({ cueKeys: Object.freeze([...new Set(keys)]), start: first0.start, end });
}
