/**
 * Owner decision 2026-10-14 (Tell JagaOn understands more, design §4): the deterministic activity recognition, cue list
 * `voice-activity-cues.1` (English only). Pure: no clock, no storage, no network.
 *
 * A clause states an activity when an activity word appears with nothing before it but the speaker's own forms, fillers, time words,
 * "went/did/had", articles and a duration ("Walked 30 minutes after dinner", "I went for a walk this morning", "Did 20 minutes of
 * yoga", "Cleaned the house"). Category mapping:
 * - WALKING: walked, walking, a walk, went for a walk;
 * - AEROBIC: jogged / jog / jogging, ran / run / running, swam / swim / swimming, cycled / cycling;
 * - FLEXIBILITY_OR_MOBILITY: yoga, stretching / stretched, taiji / tai chi, qigong;
 * - HOUSEHOLD_ACTIVITY: gardening / gardened, housework, cleaned the house;
 * - OTHER: exercised / exercise / exercising, workout / worked out (no clearer category was said).
 * The duration is optional: "30 minutes", "30 mins", "30-minute", "half an hour", "an hour", "1 hour 15 minutes", "an hour and a
 * half", "ninety minutes" (digits, or number words up to 120). A duration outside 1–1440 minutes is not kept (null), never clipped.
 *
 * Not an activity (stays "not understood"), on purpose:
 * - another subject ("My husband walked", "The walk to the clinic was long"), a question, a negation ("I didn't walk today", "no
 *   exercise"), a plan, wish or habit ("I will walk later", "need to exercise", "I walk every day", "usually swim");
 * - a time reference to an activity ("after my walk", "before walking"): "After my walk my sugar was 6.1" stays ONE glucose reading;
 * - a bare present verb without a duration or an article ("I run a shop", "my cycle"); "ran out", "run out", "ran into".
 */
export const VOICE_ACTIVITY_CUES_VERSION = "voice-activity-cues.1";

export const VOICE_ACTIVITY_CATEGORIES = ["WALKING", "FLEXIBILITY_OR_MOBILITY", "STRENGTH", "AEROBIC", "HOUSEHOLD_ACTIVITY", "OTHER"] as const;
export type VoiceActivityCategory = (typeof VOICE_ACTIVITY_CATEGORIES)[number];
export const VOICE_ACTIVITY_MAX_MINUTES = 1440;

/**
 * Form: PAST and NOUN always count; ING counts after went/go/been/was/did/some or with a duration; BARE (present verb) counts only after
 * an article or "for" ("a walk", "for a run") or with a duration ("Walk 30 minutes"); DURATION_ONLY counts only with a duration.
 */
type Form = "PAST" | "NOUN" | "ING" | "BARE" | "DURATION_ONLY";
type ActivityCue = Readonly<{ words: string; category: VoiceActivityCategory; form: Form }>;
const c = (words: string, category: VoiceActivityCategory, form: Form): ActivityCue => Object.freeze({ words, category, form });

export const VOICE_ACTIVITY_CUES: Readonly<{ version: typeof VOICE_ACTIVITY_CUES_VERSION; cues: readonly ActivityCue[] }> = Object.freeze({
  version: VOICE_ACTIVITY_CUES_VERSION,
  cues: Object.freeze([
    c("walked", "WALKING", "PAST"),
    c("walking", "WALKING", "ING"),
    c("walk", "WALKING", "BARE"),
    c("walks", "WALKING", "BARE"),
    c("jogged", "AEROBIC", "PAST"),
    c("jogging", "AEROBIC", "ING"),
    c("jog", "AEROBIC", "BARE"),
    c("ran", "AEROBIC", "DURATION_ONLY"),
    c("running", "AEROBIC", "ING"),
    c("run", "AEROBIC", "BARE"),
    c("swam", "AEROBIC", "PAST"),
    c("swimming", "AEROBIC", "ING"),
    c("swim", "AEROBIC", "BARE"),
    c("cycled", "AEROBIC", "PAST"),
    c("cycling", "AEROBIC", "ING"),
    c("cycle", "AEROBIC", "DURATION_ONLY"),
    c("exercised", "OTHER", "PAST"),
    c("exercising", "OTHER", "ING"),
    c("exercise", "OTHER", "BARE"),
    c("worked out", "OTHER", "PAST"),
    c("workout", "OTHER", "NOUN"),
    c("work out", "OTHER", "DURATION_ONLY"),
    c("yoga", "FLEXIBILITY_OR_MOBILITY", "NOUN"),
    c("stretching", "FLEXIBILITY_OR_MOBILITY", "NOUN"),
    c("stretched", "FLEXIBILITY_OR_MOBILITY", "PAST"),
    c("stretches", "FLEXIBILITY_OR_MOBILITY", "NOUN"),
    c("taiji", "FLEXIBILITY_OR_MOBILITY", "NOUN"),
    c("tai chi", "FLEXIBILITY_OR_MOBILITY", "NOUN"),
    c("qigong", "FLEXIBILITY_OR_MOBILITY", "NOUN"),
    c("gardening", "HOUSEHOLD_ACTIVITY", "NOUN"),
    c("gardened", "HOUSEHOLD_ACTIVITY", "PAST"),
    c("housework", "HOUSEHOLD_ACTIVITY", "NOUN"),
    c("cleaned the house", "HOUSEHOLD_ACTIVITY", "PAST"),
    c("cleaning the house", "HOUSEHOLD_ACTIVITY", "ING"),
  ]),
});

type Token = Readonly<{ word: string; start: number; end: number }>;
const tokenise = (text: string): Token[] =>
  [...text.toLowerCase().replace(/[’]/g, "'").replace(/tai-chi/g, "tai chi").replace(/work-out/g, "workout").matchAll(/[a-z]+(?:'[a-z]+)?|\d+(?:\.\d+)?/g)].map((match) => ({ word: match[0], start: match.index, end: match.index + match[0].length }));

const NUMBER_WORDS: Readonly<Record<string, number>> = Object.freeze({
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
});
const MINUTE_UNITS = new Set(["minute", "minutes", "min", "mins"]);
const HOUR_UNITS = new Set(["hour", "hours", "hr", "hrs"]);
const NUMBERISH = (word: string) => /^\d/.test(word) || word in NUMBER_WORDS || ["a", "an", "and", "half", "hundred", "quarter", "of"].includes(word);

/** A spoken number (digits, or words up to 120), or null. */
function numberValue(words: readonly string[]): number | null {
  if (words.length === 1 && /^\d{1,4}(?:\.\d+)?$/.test(words[0]!)) return Number(words[0]);
  let total = 0;
  let seen = false;
  for (const word of words) {
    if (word === "and") continue;
    if (word === "a" || word === "an") {
      total += 1;
      seen = true;
    } else if (word === "hundred") total = (total === 0 ? 1 : total) * 100;
    else if (word in NUMBER_WORDS) {
      total += NUMBER_WORDS[word]!;
      seen = true;
    } else return null;
  }
  return seen && total <= 120 ? total : null;
}

/** The amount before a unit at `unitIndex`, in units of that unit ("half an" hour → 0.5; "one and a half" hours → 1.5), or null. */
function amountBefore(tokens: readonly Token[], unitIndex: number): number | null {
  let from = unitIndex;
  while (from > 0 && NUMBERISH(tokens[from - 1]!.word)) from -= 1;
  // Leading "a"/"an"/"of"/"and" that belong to the sentence, not the number ("for a 30 minute walk").
  while (from < unitIndex && ["and", "of"].includes(tokens[from]!.word)) from += 1;
  const words = tokens.slice(from, unitIndex).map((token) => token.word);
  if (words.length === 0) return null;
  const joined = words.join(" ");
  if (/^(?:a |an )?quarter of an?$/.test(joined)) return 0.25;
  if (/^(?:a |an )?half(?: an?)?$/.test(joined)) return 0.5;
  const half = /^(.*) and a half$/.exec(joined);
  if (half) {
    const whole = numberValue(half[1]!.split(" "));
    return whole === null ? null : whole + 0.5;
  }
  // "for a 30 minute walk": a leading article before a number is not part of it.
  const trimmed = words.length > 1 && (words[0] === "a" || words[0] === "an") && words[1] !== "hundred" ? words.slice(1) : words;
  return numberValue(trimmed);
}

/** The first duration said in the clause, in whole minutes (1–1440), or null; "not said" and "out of range" are both null. */
export function voiceActivityDuration(clause: string): number | null {
  const tokens = tokenise(clause);
  for (let index = 0; index < tokens.length; index += 1) {
    const word = tokens[index]!.word;
    const hours = HOUR_UNITS.has(word);
    if (!hours && !MINUTE_UNITS.has(word)) continue;
    const amount = amountBefore(tokens, index);
    if (amount === null) continue;
    let minutes = hours ? amount * 60 : amount;
    if (hours) {
      let next = index + 1;
      if (tokens[next]?.word === "and" && tokens[next + 1]?.word === "a" && tokens[next + 2]?.word === "half") minutes += 30;
      else {
        if (tokens[next]?.word === "and") next += 1;
        let unit = next;
        while (unit < tokens.length && NUMBERISH(tokens[unit]!.word) && tokens[unit]!.word !== "and") unit += 1;
        if (unit > next && MINUTE_UNITS.has(tokens[unit]?.word ?? "")) {
          const extra = amountBefore(tokens, unit);
          if (extra !== null) minutes += extra;
        }
      }
    }
    return Number.isInteger(minutes) && minutes >= 1 && minutes <= VOICE_ACTIVITY_MAX_MINUTES ? minutes : null;
  }
  return null;
}

const PREFIX_WORDS = new Set([
  "i", "we", "i've", "ive", "we've", "i'd", "have", "had", "just", "today", "tonight", "yesterday", "this", "morning", "afternoon", "evening",
  "then", "also", "so", "and", "already", "finally", "went", "go", "did", "done", "do", "some", "a", "an", "my", "our", "for", "quick",
  "short", "long", "brisk", "slow", "little", "bit", "of", "nice", "good", "light", "gentle", "um", "uh", "oh", "well", "ok", "okay",
  "yeah", "yes", "in", "the", "early", "minutes", "minute", "mins", "min", "hour", "hours", "hr", "hrs", "half", "around", "about",
  "almost", "nearly", "over", "more", "than", "less", "like", "at", "least", "was", "were", "been", "out", "got", "managed", "to",
  "quarter", "hundred", "morning's", "today's", "evening's", "took", "enjoyed", "finished", "spent", "completed", "i'm", "im", "am",
]);
const PREFIX_ALLOWED = (word: string) => PREFIX_WORDS.has(word) || /^\d/.test(word) || word in NUMBER_WORDS;
/** A time reference to an activity, not a report of one ("after my walk", "before walking", "since my run"). */
const TIME_REFERENCE = new Set(["after", "before", "since", "until", "from", "during"]);
const NEGATION = /(?<![a-z])(?:not|never|no|n't|didnt|dont|cannot|cant|skipped|missed|without|couldnt|wasnt|havent|hasnt)(?![a-z])|n't/;
const PLANNED = /(?<![a-z])(?:will|going to|gonna|plan|plans|planning|planned to|want|wants|wanna|need|needs|have to|has to|should|must|hope|hoping|tomorrow|later|might|may|maybe|if|would|could|usually|normally|often|always|sometimes|every|try|trying|tried to|supposed)(?![a-z])/;
const ING_LEADS = new Set(["went", "go", "been", "was", "were", "did", "some", "done", "had", "enjoyed", "finished", "of", "a", "bit", "spent", "i'm", "im", "am"]);
const BARE_LEADS = new Set(["a", "an", "for", "my", "our", "some", "did", "had", "of", "quick", "short", "long", "brisk", "slow", "little", "nice", "good", "light", "gentle", "morning", "evening"]);

export type VoiceActivityMatch = Readonly<{ category: VoiceActivityCategory; durationMinutes: number | null }>;

/** The activity stated in `clause` (one clause of the transcript, already known not to be a question), or null. */
export function matchVoiceActivity(clause: string): VoiceActivityMatch | null {
  const lower = clause.toLowerCase().replace(/[’]/g, "'");
  if (NEGATION.test(lower) || PLANNED.test(lower)) return null;
  const tokens = tokenise(clause);
  for (let index = 0; index < tokens.length; index += 1) {
    const hit = VOICE_ACTIVITY_CUES.cues
      .filter((entry) => entry.words.split(" ").every((part, offset) => tokens[index + offset]?.word === part))
      .sort((left, right) => right.words.length - left.words.length)[0];
    if (!hit) {
      if (!PREFIX_ALLOWED(tokens[index]!.word)) return null;
      continue;
    }
    const before = tokens.slice(0, index).map((token) => token.word);
    if (before.some((word) => TIME_REFERENCE.has(word))) return null;
    const after = tokens[index + hit.words.split(" ").length]?.word;
    if ((hit.words === "ran" || hit.words === "run" || hit.words === "running") && (after === "out" || after === "into")) return null;
    const duration = voiceActivityDuration(clause);
    const previous = before[before.length - 1];
    const counts =
      hit.form === "PAST" ||
      hit.form === "NOUN" ||
      (hit.form === "ING" && ((previous !== undefined && ING_LEADS.has(previous)) || duration !== null)) ||
      (hit.form === "BARE" && ((previous !== undefined && BARE_LEADS.has(previous)) || duration !== null)) ||
      (hit.form === "DURATION_ONLY" && duration !== null);
    if (!counts) return null;
    return Object.freeze({ category: hit.category, durationMinutes: duration });
  }
  return null;
}

/** A time phrase in the activity's own words, for the card summary ("after dinner", "this morning"), or null. */
export function voiceActivityTimePhrase(label: string): string | null {
  const match = /(?<![A-Za-z])(?:(?:after|before)\s+(?:my\s+|the\s+)?(?:breakfast|lunch|dinner|supper|work|meals?)|this\s+(?:morning|afternoon|evening)|tonight|in\s+the\s+(?:morning|afternoon|evening))(?![A-Za-z])/i.exec(label);
  return match ? match[0].replace(/\s+/g, " ") : null;
}
