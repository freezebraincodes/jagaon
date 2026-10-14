import {
  VOICE_AMBIGUITY_REASONS,
  VOICE_EXTRACTOR_VERSION,
  VOICE_MAX_CANDIDATES,
  VOICE_REDIRECT_TRANSCRIBED_NOTE_KEY,
  VOICE_SOURCE_PHRASE_MAX_CODE_POINTS,
  VOICE_TRANSCRIPT_MAX_CODE_POINTS,
  codePointLength,
  glucoseHedgeMarked,
  glucoseValueInAppDefaultWindow,
  isMmolEntryValue,
  voiceRedirectMessageKey,
  VOICE_FEELING_MAX_CUES,
  VOICE_FEELING_TEXT_MAX_CODE_POINTS,
  type VoiceRedirectCategory,
  type VoiceReportedAmount,
  type VoiceAmbiguityReason,
  type VoiceAnalysis,
  type VoiceCandidate,
  type VoiceLanguage,
  type VoiceMealSlot,
  type VoiceMedicineInfoRequestCandidate,
  type VoiceMedicationRef,
  type VoiceMedicineRef,
  type VoiceOccurrenceStatus,
} from "./voice-contracts";
import { classifyVoiceAdviceRedirect, voiceWordMatcher } from "./voice-advice-redirect";
import { matchVoiceActivity } from "./voice-activity-cues";
import { VOICE_DISTRESS_CUES_VERSION, detectVoiceDistress } from "./voice-distress-gate";
import { matchVoiceFeeling } from "./voice-feeling-cues";
import { matchVoiceMedicineInfoRequest } from "./voice-medicine-info-cues";
import {
  EN_MEDICINE_PHRASE_STOPWORDS,
  EN_PRONOUN_ONE_PREFIXES,
  VOICE_COUNTERFACTUAL_CUES,
  VOICE_VOCABULARY_VERSION,
  ZH_MEDICINE_PHRASE_STOPS,
  ZH_NOT_READING_PREFIXES,
  ZH_READING_PARTICLES,
  voiceVocabulary,
  type VoiceVocabulary,
} from "./voice-vocabulary";

/**
 * Packet 13 (P13S): deterministic, bounded multi-fact extraction from a temporary transcript. Pure: no clock, no randomness, no
 * storage, no network and no provider. The patient's remembered terminology and the canonical medicine names arrive as DATA
 * (`VoiceMedicineDirectory`); nothing is learned here.
 *
 * `analyseTranscript(transcript, language, options)`:
 * 0. the distress gate FIRST (owner decision 2026-10-14, `voice-distress-gate`): any distress cue, in any session language and at any
 *    length, yields DISTRESS with zero candidates; nothing else (redirect, length check, extraction) runs;
 * 1. the neutral dose/treatment redirect next; a REDIRECT yields zero candidates (the redirect is never hidden behind a fact);
 * 2. a transcript over VOICE_TRANSCRIPT_MAX_CODE_POINTS code points is TRANSCRIPT_TOO_LONG (no candidates);
 * 3. otherwise at most VOICE_MAX_CANDIDATES candidates, ordered by position (`truncated` beyond).
 *
 * Glucose readings (review C1, C2, I1, I2):
 * - a number is a reading only when it follows a glucose cue within the window in the same sentence, with no other measurement named
 *   in between (weight, cholesterol, ketones, insulin ...). A unit or a number alone never makes a reading;
 * - numbers (13s.4): one to four digits (no leading zero) with at most one decimal, English zero–twenty and the tens 21–99 with
 *   "point" and one digit word, Chinese 零–九十九 with 点 and one digit character, and digits with 点 ("6点8"). A number next to a split or partial decimal or a
 *   magnitude word (". 2", ".8", "point eight", "dot", 点儿, hundred, 百 ...) is unsupported: no value, still counted;
 * - unit MMOL_PER_L only when spoken (never "mmol/mol"); else UNSTATED;
 * - negation, uncertainty (comparatives, targets, past times), corrections and other people are flagged from the WHOLE transcript,
 *   except the clauses that produced a meal or medicine fact (their words belong to that fact); several numbers after one cue are
 *   all MULTIPLE_NUMBERS. Owner decision 2026-10-12 (second person): English "you"/"your" count only in the fact's own clause.
 * Meals: a clause with an eating verb, or a meal word with "had/was/is", gives one MEAL_NOTE: the standard slot when said and the exact
 * food words when said. Medicines: a clause naming a medicine (a remembered term, an exact canonical name, or a generic medicine noun
 * with its 1–2 spoken describing words) gives one MEDICATION_OCCURRENCE with the occurrence status said (PLANNED, TAKEN, SKIPPED;
 * UNKNOWN when unclear, forgotten or unsure). A description is never matched loosely: only an exact remembered term or an exact
 * canonical name maps it; otherwise it stays UNRESOLVED for the clarification question.
 * Feelings and activities (13s.6, owner decision 2026-10-14; English only): a clause no other fact took, that no glucose reading
 * touches and that is not a question or a redirected clause may state an activity (`voice-activity-cues.1`: ACTIVITY_NOTE) and/or a
 * feeling (`voice-feeling-cues.1`: one FEELING_NOTE per transcript with every cue said). Priority: the distress gate first (unchanged);
 * a dose/treatment/health QUESTION keeps the redirect ("Should I be worried about my sugar?", "Should I exercise after meals?"); a
 * STATEMENT is never redirected for "worried" or "exercise" (the redirect needs a question form), so it becomes a feeling or activity
 * card. "After my walk my sugar was 6.1" stays one glucose reading (a time reference, and the reading's clause).
 * Anything else with words or numbers is an UNSUPPORTED_SPAN (shown as not understood; never dropped, never interpreted).
 * Medicine-information requests (13s.7, owner decision 2026-10-14, HSA preview; English only; only with
 * `medicineInformationRequests: true`): a whole sentence that asks for general information about one medicine she or JagaOn knows
 * by name (`voice-medicine-info-cues.1`: "Tell me about my Metformin", "What is metformin?", "What's Lantus for?") becomes one
 * MEDICINE_INFO_REQUEST and no other candidate. Priority: the distress gate first, then the dose/treatment redirect (any redirect in
 * the transcript means no request is offered: "How much metformin should I take" stays a redirect), then the length limit. Such a
 * sentence still counts as other words for the C1 backstop below, exactly as when it was not understood. Without the option (the
 * default; HSA-bounded mode on) nothing changes: these sentences stay not understood.
 *
 * 13s.3 (safety re-review Cr1–Cr4, I1–I3, M2, M4; owner decisions #2–#4):
 * - Cr1: only first person, fillers, times or qualifier words may precede the glucose cue in its clause; anything else (kid, auntie,
 *   your, 孩子, 病人, 你 ...) adds OTHER_PERSON. Kinship and pronoun cues are extended.
 * - Cr2: a digit touching a letter (HbA1c, 7ish) is never a number; another measurement or substance anywhere in the clause (urine,
 *   tea, lipids, 尿, 茶 ...) or a word outside the between-allow-list makes the clause not a reading.
 * - Cr3: targets, conditions, future, approximate, habitual and past values (keep at, if, when it hits, will be, tomorrow, approx,
 *   usually, average, last week, on Monday, 控制在, 大约, 约 ...) add UNCERTAINTY, so they are never UNDERSTOOD or APP_DEFAULT.
 * - I1: more negations (hardly, nope, I doubt it, false); a clause holding a meal or medicine and then a glucose cue is split at the
 *   cue, and a meal or medicine takes its qualifiers from its sentence without the glucose clauses.
 * - I2/#2: the app-default unit only inside the app-default window (0 < value ≤ 50; 13s.4: VOICE_GLUCOSE_APP_DEFAULT_WINDOW); a spoken
 *   mg/dL is never reinterpreted.
 * - I3: a planned meal adds UNCERTAINTY; 吃 with a count, colour or pill classifier and no food is not a meal.
 * - M2: lost, bought, broken, left, ran out, relayed instructions (doctor said, 医生说) are not occurrences.
 * - #4/M4: a REPORTED amount ("I injected 10 units", 十个单位) is kept exactly as spoken in `reportedAmount`; any other number said in
 *   a medicine clause adds UNCERTAINTY instead of being dropped; meal items never carry the slot or time words.
 * - #3: the redirect carries its category (DOSE_TREATMENT or HEALTH_QUESTION) and the matching fixed copy key.
 *
 * 13s.4 (CR-11, owner decisions R-1, R-5, 2026-10-11; design v3.1 §3):
 * - digits: the shared new-entry format (1–4 integer digits, no leading zero except "0", at most ONE decimal digit); "60.00", "9.25",
 *   "060" and "12345" are unsupported (no value, still counted), never rounded or truncated;
 * - spoken tens 21–99, never partial: English "sixty", "sixty five", "sixty-five", "sixty point five"; Chinese 六十, 六十五, 六十点五.
 *   Hundreds ("one hundred twenty", "a hundred and twenty", 一百二十), approximations ("sixty something", "-odd", "-ish", 六十多,
 *   六十几, 六十来), digit by digit ("six zero", 六零) and more than one spoken decimal ("six point two five", 六点二五) give no value;
 * - the app-default unit only inside the app-default window (0 < value ≤ 50); a value outside it keeps UNIT_UNSTATED, so the person
 *   must confirm the unit explicitly ("Yes, mmol/L"). 50 is never a save limit.
 *
 * 13s.3 round 4 (third re-review; interface and exports unchanged):
 * - C1 structural backstop (owner requirement 5): when ANY part of the transcript is not understood (an UNSUPPORTED_SPAN), every
 *   glucose reading gets UNCERTAINTY (edit-only) and never the app-default unit ("Ah Ma, sugar 7.2", "John, sugar 6.8"); Singapore
 *   kinship terms and titles (Ah Ma, Ah Gong, Mdm, Mr, 阿嬷, 阿公 ...) are explicit other-person cues.
 * - Pre-cue allow-list from the start of the SENTENCE (meal and medicine clauses and redirected questions blank). DECISION (I4): a
 *   miss adds UNCERTAINTY (the person may edit and save; never one tap), not OTHER_PERSON (which no edit can clear); explicit
 *   kinship, title or pronoun cues keep OTHER_PERSON. Demo phrasings were added to the allow-lists (刚, 今早, 睡觉前, 运动后, 我自己,
 *   post-meal, after my walk, glucometer), and time possessives (today's, this morning's) are not another person's.
 * - I1: "is"/"was" left the pre-cue list; a clause-initial auxiliary before my/the/your + cue ("Is my sugar 7.2") is a question:
 *   UNCERTAINTY, and the gate withholds it.
 * - I2: doubt cues (right, correct, sure, 对吗, 对不对, 是吗, 没错吧); the redirected question clauses are scanned for negation,
 *   uncertainty and correction cues (without their numbers).
 * - I3: UNCERTAINTY applies to a medicine occurrence whatever its status (a plan or habit is never a one-tap TAKEN).
 * - I5: the English cue–number window is 54 characters.
 * - Minors: inject(ed|ing|s) is an occurrence verb; a skip with an amount adds UNCERTAINTY; "half"/半 are unreported numbers.
 */
export type VoiceMedicineDirectory = Readonly<{
  /** The patient's remembered terms for this language (exact phrase → canonical medicine). */
  terms: ReadonlyArray<Readonly<{ phrase: string; medication: VoiceMedicationRef }>>;
  /** The canonical medicine names (exact match only). */
  names: ReadonlyArray<Readonly<{ name: string; medication: VoiceMedicationRef }>>;
}>;
export type VoiceAnalysisOptions = Readonly<{
  medicines?: VoiceMedicineDirectory;
  /**
   * The app's effective glucose ENTRY unit (never a display preference), or null/absent for no default. When MMOL_PER_L, an otherwise
   * unambiguous, positively stated reading with no spoken unit is proposed in mmol/L with `unitSource: "APP_DEFAULT"`.
   */
  glucoseEntryUnit?: "MMOL_PER_L" | null;
  /**
   * 13s.7 (HSA preview): recognise requests for general information about a named medicine (MEDICINE_INFO_REQUEST). The app passes
   * true only while HSA-bounded mode is off; absent or false keeps the earlier behaviour exactly.
   */
  medicineInformationRequests?: boolean;
}>;
/** Internal: clauses already shown as a redirected question (no fact from them, no medicine occurrence beside them). */
/** 13s.7: `otherWords` marks excluded medicine-information sentences, which still count as other words for the C1 backstop. */
type InternalScope = Readonly<{ exclude: readonly Range[]; withoutMedication: boolean; otherWords?: boolean }>;
const NO_SCOPE: InternalScope = Object.freeze({ exclude: [], withoutMedication: false });

const EMPTY_DIRECTORY: VoiceMedicineDirectory = Object.freeze({ terms: [], names: [] });
const DIGITS = "0-9０-９";
const ZH_INTEGER_CHARS = "零〇一二两三四五六七八九十";
// Round 4 (I5): the English window is wider (the between-allow-list guards what may sit between the cue and the number).
const WINDOW: Readonly<Record<VoiceLanguage, number>> = Object.freeze({ en: 54, zh: 12 });
/** Round 4 (I1): a clause-initial auxiliary before a possessive or article is a question ("Is my sugar 7.2", "Was the sugar 7.2"). */
const EN_AUX_QUESTION_START = /^\s*(?:is|was|are|were|has|have|did|does|do|can|could|will|would)\s+(?:my|the|your|our|his|her|their)(?![A-Za-z])/i;
/** Round 5: words a reading's clause tail may also hold (clock markers; Chinese sentence particles). */
const TAIL_EXTRA_WORDS: Readonly<Record<VoiceLanguage, readonly string[]>> = Object.freeze({
  en: Object.freeze(["am", "pm", "o'clock", "oclock", "woke", "got", "up", "had", "ate", "eating", "walk", "exercise", "sleep", "bed", "bedtime"]),
  zh: Object.freeze([...ZH_READING_PARTICLES, "啊", "呀", "哦", "嘛"]),
});
/** Round 4 (I4): time possessives ("today's sugar", "this morning's reading") are not another person's. */
const EN_TIME_POSSESSIVE = "(?<!(?:today|tonight|yesterday|morning|afternoon|evening|night|week|month|year|day|lunch|dinner|breakfast|supper))";
/**
 * Owner decision 2026-10-12 (second person): English "you"/"your" (often a question to the listener: "Do you think…?", "Can you
 * remind me?") mark a fact OTHER_PERSON only inside that fact's own clause, never from another clause. Every other other-person cue
 * stays transcript-wide; Chinese 你/您 too (Chinese is unchanged). The vocabulary list is unchanged (the between-allow-list still
 * accepts them).
 */
const EN_SECOND_PERSON_CUES: readonly string[] = Object.freeze(["you", "your"]);
/**
 * Owner decision 2026-10-12 (second person), fix round 1 (safety review Critical; controller ruling): an implied subject is part of
 * the fact's own clause, so a clause without a subject of its own ("took the dark pen", "then ate noodles", "sugar 6.8 mmol") keeps a
 * "you"/"your" said earlier in the same sentence. Fix round 2 (controller ruling): only a SUBJECT-form first person exempts it: I, I'm,
 * I've, I'd, I'll (the apostrophe, straight or curly, required: "ill", "id", "ive", "im" are other words) and inclusive "we". "my",
 * "me", "mine", "myself" and "our" never do ("you had lunch then took my dark pen"), except "my" before a reading's cue (below).
 */
const EN_FIRST_PERSON_SUBJECT = /(?<![A-Za-z'’])(?:i['’](?:m|ve|d|ll)|i|we)(?![A-Za-z'’])/i;
/** Fix round 2: a reading's own "my" before its cue ("…and then my sugar was 6.8") exempts it; anywhere else it never does. */
const EN_POSSESSIVE_BEFORE_CUE = /(?<![A-Za-z'’])my(?![A-Za-z'’])/i;
/**
 * Fix round 3 (controller ruling): the first person counts only BEFORE the fact's first verb or cue in its own clause ("took the dark
 * pen I gave", "ate the noodles I cooked", "sugar was 6.8 mmol after I woke up" are not the speaker's). A medicine's verb: a status
 * word or one of these (or its medicine phrase, if earlier); a meal's: an eat verb or one of EN_MEAL_LINK_VERBS; a reading's: its cue.
 */
const EN_MEDICINE_VERBS = /(?<![A-Za-z])(?:take|takes|taking|took|taken|inject(?:ed|ing|s)?|use|uses|using|used)(?![A-Za-z])/i;
const EN_MEAL_LINK_VERBS = /(?<![A-Za-z])(?:had|have|has|having|was|is|were)(?![A-Za-z])/i;

const escape = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function englishAlternation(words: readonly string[]): string {
  return [...words]
    .sort((left, right) => right.length - left.length)
    .map((word) => escape(word).replace(/ /g, "\\s+").replace(/\//g, "\\s*\\/\\s*").replace(/'/g, "['’]?"))
    .join("|");
}
function plainAlternation(words: readonly string[]): string {
  return [...words].sort((left, right) => right.length - left.length).map((word) => escape(word).replace(/\//g, "\\s*\\/\\s*")).join("|");
}

/** The normal form of a spoken or remembered phrase: English lower-case with single spaces; Chinese without spaces. */
export function normaliseVoicePhrase(phrase: string, language: VoiceLanguage): string {
  const trimmed = phrase.normalize("NFC").trim();
  return language === "zh" ? trimmed.replace(/\s+/g, "") : trimmed.toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, " ");
}

type Patterns = Readonly<{
  cue: RegExp;
  token: RegExp;
  unit: RegExp;
  notReading: RegExp;
  otherMeasure: RegExp;
  negation: RegExp;
  uncertainty: RegExp;
  correction: RegExp;
  otherPerson: RegExp;
  /** Owner decision 2026-10-12 (second person): tested on the fact's own clause only; null for Chinese (你/您 stay in `otherPerson`). */
  secondPerson: RegExp | null;
  /** Fix round 2: the fact's own subject-form first person, and a reading's "my" before its cue; null for Chinese. */
  firstPersonSubject: RegExp | null;
  possessiveBeforeCue: RegExp | null;
  eat: RegExp;
  slot: RegExp;
  noun: RegExp;
  statusUnknown: RegExp;
  statusSkipped: RegExp;
  statusPlanned: RegExp;
  statusTaken: RegExp;
  notOccurrence: RegExp;
  pillLike: RegExp;
  amount: RegExp;
}>;

/** Owner #4: a reported amount: a number directly followed by an amount unit (EN digits or 0–20 words; ZH digits or numerals). */
function amountPattern(language: VoiceLanguage, vocabulary: VoiceVocabulary): RegExp {
  if (language === "en") {
    return new RegExp(`(?<![A-Za-z0-9.])(\\d{1,4}(?:\\.\\d{1,2})?|${englishAlternation(vocabulary.integerWords)})\\s*(${englishAlternation(vocabulary.amountUnits)})(?![A-Za-z])`, "i");
  }
  return new RegExp(`([0-9]{1,4}(?:\\.[0-9]{1,2})?|[零〇一二两三四五六七八九十百]+)\\s*(${plainAlternation(vocabulary.amountUnits)})`);
}

function compile(language: VoiceLanguage, vocabulary: VoiceVocabulary): Patterns {
  const words = (list: readonly string[], flags = "i") => voiceWordMatcher(list, language, flags);
  const slotWords = Object.values(vocabulary.mealSlots).flat();
  if (language === "en") {
    return Object.freeze({
      cue: new RegExp(`(?<![A-Za-z])(?:${englishAlternation(vocabulary.glucoseCues)})s?(?![A-Za-z-])`, "gi"),
      token: new RegExp(`[${DIGITS}]+(?:[.,:．：][${DIGITS}]+)*|[A-Za-z]+(?:['’][A-Za-z]+)?`, "g"),
      unit: new RegExp(`^\\s*(?:${englishAlternation(vocabulary.mmolUnits)})(?![A-Za-z])(?!\\s*\\/\\s*mol)`, "i"),
      notReading: new RegExp(`^\\s*(?:${englishAlternation(vocabulary.notReadingFollowers)})(?![A-Za-z])`, "i"),
      otherMeasure: words(vocabulary.otherMeasureCues),
      negation: new RegExp(`(?<![A-Za-z])(?:${englishAlternation(vocabulary.negationCues.filter((cue) => cue !== "n't"))})(?![A-Za-z])|n['’]t(?![A-Za-z])`, "i"),
      uncertainty: words(vocabulary.uncertaintyCues),
      correction: words(vocabulary.correctionCues),
      otherPerson: new RegExp(`(?<![A-Za-z])(?:${englishAlternation(vocabulary.otherPersonCues.filter((cue) => !cue.startsWith("'") && !EN_SECOND_PERSON_CUES.includes(cue)))})(?![A-Za-z])|${EN_TIME_POSSESSIVE}['’]s\\s+(?:sugar|blood|glucose|reading|insulin|medicine|pill|pen|lunch|breakfast|dinner)`, "i"),
      secondPerson: new RegExp(`(?<![A-Za-z])(?:${englishAlternation(EN_SECOND_PERSON_CUES)})(?![A-Za-z])`, "i"),
      firstPersonSubject: EN_FIRST_PERSON_SUBJECT,
      possessiveBeforeCue: EN_POSSESSIVE_BEFORE_CUE,
      eat: words(vocabulary.eatVerbs),
      slot: words(slotWords),
      noun: words(vocabulary.medicineNouns),
      statusUnknown: words(vocabulary.statusUnknown),
      statusSkipped: words(vocabulary.statusSkipped),
      statusPlanned: words([...vocabulary.statusPlanned, "i'll", "we'll", "i will"]),
      statusTaken: words(vocabulary.statusTaken),
      notOccurrence: words(vocabulary.notOccurrenceCues),
      pillLike: words(vocabulary.pillLikeMealWords),
      amount: amountPattern(language, vocabulary),
    });
  }
  return Object.freeze({
    cue: new RegExp(plainAlternation(vocabulary.glucoseCues), "g"),
    token: new RegExp(`(?<![${DIGITS}])[${DIGITS}]+点[${DIGITS}]+(?![${DIGITS}])|[${DIGITS}]+(?:[.,:．：][${DIGITS}]+)*|[${ZH_INTEGER_CHARS}]+(?:点[${ZH_INTEGER_CHARS}]*)?`, "g"),
    unit: new RegExp(`^\\s*(?:${plainAlternation(vocabulary.mmolUnits)})(?!\\s*\\/\\s*mol)`, "i"),
    notReading: new RegExp(`^\\s*(?:${plainAlternation(vocabulary.notReadingFollowers)})`, "i"),
    otherMeasure: words(vocabulary.otherMeasureCues, ""),
    negation: words(vocabulary.negationCues, ""),
    uncertainty: words(vocabulary.uncertaintyCues, ""),
    correction: words(vocabulary.correctionCues, ""),
    otherPerson: words(vocabulary.otherPersonCues, ""),
    secondPerson: null,
    firstPersonSubject: null,
    possessiveBeforeCue: null,
    eat: words(vocabulary.eatVerbs, ""),
    slot: words(slotWords, ""),
    noun: words(vocabulary.medicineNouns, ""),
    statusUnknown: words(vocabulary.statusUnknown, ""),
    statusSkipped: words(vocabulary.statusSkipped, ""),
    statusPlanned: words(vocabulary.statusPlanned, ""),
    statusTaken: words(vocabulary.statusTaken, ""),
    notOccurrence: words(vocabulary.notOccurrenceCues, ""),
    pillLike: words(vocabulary.pillLikeMealWords, ""),
    amount: amountPattern(language, vocabulary),
  });
}

const PATTERNS: Readonly<Record<VoiceLanguage, Patterns>> = Object.freeze({ en: compile("en", voiceVocabulary("en")), zh: compile("zh", voiceVocabulary("zh")) });
/** Fix round 3: the planned-status words alone, without the subject forms "i'll", "we'll", "i will" (a subject before "take" counts). */
const PLANNED_STATUS_WORDS: Readonly<Record<VoiceLanguage, RegExp>> = Object.freeze({ en: voiceWordMatcher(voiceVocabulary("en").statusPlanned, "en"), zh: voiceWordMatcher(voiceVocabulary("zh").statusPlanned, "zh", "") });

// ---------------------------------------------------------------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------------------------------------------------------------
type NumberToken = Readonly<{ start: number; end: number; valueText: string | null; unitEnd: number | null }>;

const toAsciiDigits = (text: string) => text.replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0)).replace(/．/g, ".");
/**
 * Review C1: split or partial decimals and magnitude words around a number make it unsupported. 13s.4 (CR-11, owner R-7): so does a
 * sign directly before it ("-5", "minus five", 负五, 零下五): a negative value is never read as positive. Fix round 1 (m-1): the minus
 * sign (−), en dash (–), em dash (—), non-breaking hyphen (‑) and figure dash (‒) count as the same sign.
 */
const EN_SPLIT_BEFORE = /(?:[.．]|[0-9０-９]\s*[.．]\s*|(?<![A-Za-z])(?:point|dot|hundred(?:\s+and)?|thousand)\s+|(?<![A-Za-z])(?:minus|negative)\s+)$/i;
const EN_SPLIT_AFTER = /^\s*(?:[.．]\s*[0-9０-９]|(?:point|dot|hundred|thousand)(?![A-Za-z]))/i;
const ZH_SPLIT_BEFORE = /(?:点儿?|[.．]|[百千万]|[0-9０-９]\s*[.．]\s*|负|零下)\s*$/;
const ZH_SPLIT_AFTER = /^\s*(?:儿?点|[.．]\s*[0-9０-９零〇一二两三四五六七八九]|[百千万])/;

function follower(text: string, end: number, patterns: Patterns): { kind: "UNIT"; unitEnd: number } | { kind: "NOT_READING" } | { kind: "NONE" } {
  const rest = text.slice(end, end + 32);
  if (patterns.notReading.test(rest)) return { kind: "NOT_READING" };
  const unit = patterns.unit.exec(rest);
  if (unit) return { kind: "UNIT", unitEnd: end + unit[0].length };
  return { kind: "NONE" };
}

/**
 * CR-11 fix round 3 (owner ruling 4, 2026-10-11; extended in rounds 3b, 4 and 5): a sign before the number gives no value, never the
 * number without its sign. Round 5 (owner-approved 2026-10-11): a sign is any dash punctuation (Unicode \p{Pd}) or a minus/plus math
 * form (+ ＋ ﹢ ⁺ − ∓ ± ⊖ ⊕ ➖ ➕ ⁻ ˗ ﹣ －, with an optional emoji selector or keycap mark) directly before the number, attached
 * ("-5", "+6") or separated only by spaces, opening brackets or quotes ( ( （ [ ［ { 「 " ' “ ‘ ) and invisible joiners (soft hyphen,
 * zero-width space, ZWNJ, ZWJ, word joiner): "sugar was - 5", "sugar -(5)", 血糖-（5）. It is a range, unchanged, when a number comes right
 * before the sign ("7 - 8", "七–八"). The approximation symbols ~ ≈ ～ ∼ are not signs. Accepted consequence:
 * a pause dash right before the number ("sugar - 6.8") also gives no value.
 */
/** Round 6 (A2): invisible characters as a class: format characters (\p{Cf}: soft hyphen, ZWSP, ZWNJ, ZWJ, LRM, RLM, word joiner, U+2061–U+2064, U+180E ...) plus CGJ (U+034F). */
const INVISIBLE = "\\p{Cf}\\u00AD\\u034F\\u180E\\u200B-\\u200F\\u2060-\\u2064";
/** Round 6 (A2): opening brackets and quotes as classes (\p{Ps}, \p{Pi}) plus the quotes Unicode files elsewhere (" ' ‚ „ « ‹). */
const OPENERS = "\\p{Ps}\\p{Pi}\"'‚„«‹";
/** Round 6 (A4): closing brackets and quotes (\p{Pe}, \p{Pf}, " ') stripped before the range test ("(7)-(8)", "7.8]-[8"). */
const CLOSERS = "\\p{Pe}\\p{Pf}\"'";
/**
 * Round 6: the sign characters. Dash punctuation (\p{Pd}, which includes the wave dashes 〜 and 〰) and the minus/plus math forms
 * (round 6 A3: ₋ ⁒), plus the owner's rejected input marks (owner decisions 2026-10-11, "Do not accept these signs/symbols on input"):
 * full-width and look-alike equals or approximation marks ＝ ﹦ ≒ ≃ ≅ ∽ ⁓ ≑ ∾ and dash look-alikes ー ｰ ─ ━ ⎯ ﹍ Ⲻ; round 8 (owner decision
 * 2026-10-11): the plain "=" too, consistent with "＝" (no longer a hedge). Before a number each
 * gives no value (never a value, never a hedge); a number right before it is still a range.
 */
const MINUS_PLUS_CHARS = "\\p{Pd}+＋﹢⁺−∓±⊖⊕➖➕⁻˗﹣－₋⁒ーｰ─━⎯﹍Ⲻ";
/** Round 8: the rejected equals/approximation marks (glucose only; a medicine amount is checked for minus/plus signs only). */
const REJECTED_MARK_CHARS = "=＝﹦≒≃≅∽⁓≑∾";
const SIGN_CHARS = `${MINUS_PLUS_CHARS}${REJECTED_MARK_CHARS}`;
/**
 * Round 5 (owner decision 2026-10-11, revised B): hedges dropped so only the number is extracted, then ALWAYS confirmed (see
 * `glucoseHedgeMarked`): EN about / around / approximately / roughly and the symbols ~ ≈ ～ ∼ directly before the number; ZH 大约 / 大概 /
 * 差不多 and the symbols before it, 左右 after it. Any other hedge (maybe, I think, nearly, 可能 ...) keeps its uncertainty. Round 8 (owner
 * decision 2026-10-11): "=" is no longer a hedge; it is a rejected mark (see SIGN_CHARS), consistent with "＝".
 */
const HEDGE_BEFORE: Readonly<Record<VoiceLanguage, RegExp>> = Object.freeze({
  en: /(?:(?<![A-Za-z])(?:about|around|approximately|roughly)\s*(?:[~≈～∼]\s*)?|[~≈～∼]\s*)$/i,
  zh: /(?:(?:大约|大概|差不多)\s*(?:[~≈～∼]\s*)?|[~≈～∼]\s*)$/,
});
const ZH_HEDGE_AFTER = /^\s*左右/;
const SIGN_BEFORE = new RegExp(`[${SIGN_CHARS}][\\uFE0F\\u20E3]*[\\s${INVISIBLE}${OPENERS}]*$`, "u");
const MINUS_PLUS_BEFORE = new RegExp(`[${MINUS_PLUS_CHARS}][\\uFE0F\\u20E3]*[\\s${INVISIBLE}${OPENERS}]*$`, "u");
/**
 * Round 7 (D1): how far before a number the sign check looks (code units, both languages). Wide enough that padding (spaces, invisible
 * characters, brackets, repeated hedges) cannot push a sign out of view, and capped so the scan stays bounded.
 */
const SIGN_LOOKBACK = 64;
const TRAILING_FILLER = new RegExp(`[\\s${INVISIBLE}${OPENERS}]+$`, "u");
const TRAILING_CLOSERS = new RegExp(`[\\s${INVISIBLE}${CLOSERS}]+$`, "u");
/** Round 9 (A2): the rejected equals marks, stripped only to SEE a sign before a medicine amount ("-=2 units", 负=2个单位). */
const TRAILING_EQUALS = new RegExp(`[\\s${REJECTED_MARK_CHARS}]+$`, "u");
/** Round 9 (A1): the sign words, tested on the stripped text (medicine; a glucose reading has its own split rule for them). */
const SIGN_WORD_END: Readonly<Record<VoiceLanguage, RegExp>> = Object.freeze({ en: /(?<![A-Za-z])(?:minus|negative)$/i, zh: /(?:负|零下)$/ });
/**
 * Round 9 (D): the raw text the sign check reads before a number. It is bounded (twice the transcript limit in code units) and
 * collapsed first, so padding can never push a sign out of the capped SIGN_LOOKBACK view.
 */
const RAW_LOOKBACK = VOICE_TRANSCRIPT_MAX_CODE_POINTS * 2;
const PADDING_CHARS = `\\s${INVISIBLE}${OPENERS}${CLOSERS}~≈～∼`;
const HEDGE_WORDS: Readonly<Record<VoiceLanguage, string>> = Object.freeze({ en: "(?<![A-Za-z])(?:about|around|approximately|roughly)(?![A-Za-z])", zh: "大约|大概|差不多" });
/**
 * Round 9 addendum (owner decisions 2026-10-11, final): punctuation and filler words between a sign and the number never hide the sign
 * ("sugar -, 7", "I took - like 2 units", 血糖-嗯7). Punctuation: , ; : . … ， ； ： 。 、. Fillers: EN um, uh, er, erm, ah, like, well,
 * maybe; ZH 嗯, 呃, 啊, 那个, 就是.
 */
const SIGN_PUNCTUATION = ",;:.…，；：。、";
const FILLER_WORDS: Readonly<Record<VoiceLanguage, string>> = Object.freeze({ en: "(?<![A-Za-z])(?:um|uh|erm|er|ah|like|well|maybe)(?![A-Za-z])", zh: "嗯|呃|啊|那个|就是" });
const TRAILING_PUNCTUATION_FILLER: Readonly<Record<VoiceLanguage, RegExp>> = Object.freeze({
  en: new RegExp(`(?:[\\s${INVISIBLE}${SIGN_PUNCTUATION}]|${FILLER_WORDS.en})+$`, "iu"),
  zh: new RegExp(`(?:[\\s${INVISIBLE}${SIGN_PUNCTUATION}]|${FILLER_WORDS.zh})+$`, "u"),
});
/** Runs of only spaces, invisible characters and brackets collapse to a space; a run holding anything else (a hedge, punctuation, a filler, an equals mark) collapses to "," so it can never join a range ("7, -8" stays signed). */
// Round 10 (F1): openers are not plain padding here, so "7 (-8" never reads as the range "7 -8" (a run holding an opener collapses to ",").
const PLAIN_PADDING = new RegExp(`^[\\s${INVISIBLE}${CLOSERS}]+$`, "u");
const paddingRun = (language: VoiceLanguage, equals: boolean) => new RegExp(`(?:[${PADDING_CHARS}${SIGN_PUNCTUATION}${equals ? REJECTED_MARK_CHARS : ""}]|${HEDGE_WORDS[language]}|${FILLER_WORDS[language]})+`, "giu");
const PADDING_RUN: Readonly<Record<VoiceLanguage, Readonly<{ plain: RegExp; equals: RegExp }>>> = Object.freeze({
  en: Object.freeze({ plain: paddingRun("en", false), equals: paddingRun("en", true) }),
  zh: Object.freeze({ plain: paddingRun("zh", false), equals: paddingRun("zh", true) }),
});

/**
 * Round 9: what the sign check considers. A glucose reading: every sign character including the rejected equals marks (they are
 * signs there). A medicine amount: minus/plus signs only, the equals marks stripped to see a sign behind them (A2), the sign words on
 * the stripped text (A1), and a range only when its lower bound is not itself signed (A3).
 */
type SignCheck = Readonly<{ sign: RegExp; equals: boolean; words: boolean; lowerBound: boolean }>;
const GLUCOSE_SIGN: SignCheck = Object.freeze({ sign: SIGN_BEFORE, equals: false, words: false, lowerBound: false });
// Round 9 addendum (owner, final): an equals mark directly before a medicine amount is not accepted either, so the medicine check now uses
// the full sign class (the equals marks included) instead of stripping them.
const MEDICINE_SIGN: SignCheck = Object.freeze({ sign: SIGN_BEFORE, equals: false, words: true, lowerBound: true });

/** The start of the number that ends `prior` (a digit run, a Chinese numeral run or an English number word), or -1. */
function trailingNumberStart(prior: string, language: VoiceLanguage, vocabulary: VoiceVocabulary): number {
  const digits = /[0-9０-９]+(?:[.．][0-9０-９]+)?$/.exec(prior);
  if (digits) return digits.index;
  if (language === "zh") return /[零〇一二两三四五六七八九十百千万]+$/.exec(prior)?.index ?? -1;
  const word = /([A-Za-z]+)$/.exec(prior);
  const lower = word?.[1]?.toLowerCase();
  return word && lower !== undefined && (vocabulary.integerWords.includes(lower) || vocabulary.tensWords.includes(lower) || vocabulary.digitWords.includes(lower)) ? word.index : -1;
}

function signedNumber(before: string, language: VoiceLanguage, vocabulary: VoiceVocabulary, check: SignCheck = GLUCOSE_SIGN, depth = 0): boolean {
  // Round 9 (D): padding runs (spaces, invisible characters, brackets, quotes, hedges and, for a medicine amount, the equals marks) are
  // collapsed to one space first, so the capped view always reaches the sign.
  const collapsed = before.slice(Math.max(0, before.length - RAW_LOOKBACK)).replace(check.equals ? PADDING_RUN[language].equals : PADDING_RUN[language].plain, (run) => (PLAIN_PADDING.test(run) ? " " : ","));
  // Round 6 (A1): a hedge between the sign and the number ("sugar -~7", "- about 7", "-(about 7)", 血糖-大约7) never hides the sign:
  // trailing hedges, hedge symbols, spaces, opening brackets, quotes and invisible characters are stripped, repeatedly, first.
  let rest = collapsed.slice(Math.max(0, collapsed.length - SIGN_LOOKBACK));
  for (let previous = ""; previous !== rest; ) {
    previous = rest;
    rest = rest.replace(TRAILING_FILLER, "").replace(HEDGE_BEFORE[language], "").replace(TRAILING_PUNCTUATION_FILLER[language], "");
    if (check.equals) rest = rest.replace(TRAILING_EQUALS, "");
  }
  if (check.words && SIGN_WORD_END[language].test(rest)) return true;
  const sign = check.sign.exec(rest);
  if (!sign) return false;
  const prior = rest.slice(0, sign.index).replace(TRAILING_CLOSERS, "");
  const lower = trailingNumberStart(prior, language, vocabulary);
  if (lower < 0) return true;
  // A number right before the sign makes a range ("8 - 10 units", "七–八"); round 9 (A3): for a medicine amount only when that lower
  // bound is not itself signed ("-2-3 units" is never "3 units").
  return check.lowerBound && depth < 3 && signedNumber(prior.slice(0, lower), language, vocabulary, check, depth + 1);
}

/**
 * Round 8: a sign before a medicine amount, with the sign words (minus, negative, 负, 零下). Round 9: the sign words are tested on the
 * stripped text (A1); round 9 addendum (owner, final): the equals marks count too ("I took = 2 units" keeps no amount).
 */
function negativeBefore(before: string, language: VoiceLanguage, vocabulary: VoiceVocabulary): boolean {
  return signedNumber(before, language, vocabulary, MEDICINE_SIGN);
}

/** 13s.4 (R-5): an approximation word right after a spoken number ("sixty something", "sixty-odd", "60 ish"): the number has no value. */
function approximate(after: string, vocabulary: VoiceVocabulary): boolean {
  if (vocabulary.approximationFollowers.length === 0) return false;
  return new RegExp(`^[\\s-]*(?:${vocabulary.approximationFollowers.map(escape).join("|")})(?![A-Za-z])`, "i").test(after);
}

/**
 * 13s.4 (R-5): an English number-word run as a value, or null: zero–twenty; a tens word (twenty … ninety) alone or with one of one–nine
 * (21–99); each optionally followed by "point" and exactly ONE digit word. Anything else (digit by digit, "six point two five",
 * "sixty five five") is null: never partial.
 */
function englishWordValue(words: readonly string[], vocabulary: VoiceVocabulary): string | null {
  let integer: number;
  let next = 1;
  const tens = vocabulary.tensWords.indexOf(words[0]!);
  if (tens >= 0) {
    integer = (tens + 2) * 10;
    const ones = words.length > 1 ? vocabulary.integerWords.indexOf(words[1]!) : -1;
    if (ones >= 1 && ones <= 9) {
      integer += ones;
      next = 2;
    }
  } else {
    integer = vocabulary.integerWords.indexOf(words[0]!);
    if (integer < 0) return null;
  }
  if (words.length === next) return String(integer);
  if (words.length !== next + 2 || words[next] !== vocabulary.decimalMarker) return null;
  const decimal = vocabulary.digitWords.indexOf(words[next + 1]!);
  return decimal >= 0 ? `${integer}.${decimal}` : null;
}

function digitToken(raw: string): { kind: "TIME" } | { kind: "VALUE"; valueText: string } | { kind: "UNSUPPORTED" } {
  if (/[:：]/.test(raw)) return { kind: "TIME" };
  const ascii = toAsciiDigits(raw);
  return isMmolEntryValue(ascii) ? { kind: "VALUE", valueText: ascii } : { kind: "UNSUPPORTED" };
}

function englishNumbers(text: string, patterns: Patterns, vocabulary: VoiceVocabulary): NumberToken[] {
  const tokens = [...text.matchAll(patterns.token)].map((match) => ({ start: match.index, end: match.index + match[0].length, raw: match[0], lower: match[0].toLowerCase() }));
  const isDigits = (raw: string) => /^[0-9０-９]/.test(raw);
  const isNumberWord = (lower: string) => vocabulary.integerWords.includes(lower) || vocabulary.tensWords.includes(lower);
  const numeric = (lower: string, raw: string) => isDigits(raw) || isNumberWord(lower) || vocabulary.digitWords.includes(lower) || lower === vocabulary.decimalMarker;
  const numbers: NumberToken[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const first = tokens[index]!;
    if (!isDigits(first.raw) && !isNumberWord(first.lower)) continue;
    const previous = tokens[index - 1];
    if (first.lower === "one" && previous && /^\s+$/.test(text.slice(previous.end, first.start)) && EN_PRONOUN_ONE_PREFIXES.includes(previous.lower)) continue;
    let last = index;
    while (last + 1 < tokens.length && numeric(tokens[last + 1]!.lower, tokens[last + 1]!.raw) && /^[\s-]*$/.test(text.slice(tokens[last]!.end, tokens[last + 1]!.start))) last += 1;
    const run = tokens.slice(index, last + 1);
    index = last;
    const start = run[0]!.start;
    const end = run[run.length - 1]!.end;
    const next = follower(text, end, patterns);
    if (next.kind === "NOT_READING") continue;
    let valueText: string | null = null;
    const split = EN_SPLIT_BEFORE.test(text.slice(Math.max(0, start - 24), start)) || EN_SPLIT_AFTER.test(text.slice(end, end + 24)) || approximate(text.slice(end, end + 24), vocabulary) || signedNumber(text.slice(Math.max(0, start - RAW_LOOKBACK), start), "en", vocabulary);
    if (run.length === 1 && isDigits(run[0]!.raw)) {
      // Cr2: a digit touching a letter is part of a word ("HbA1c", "7ish"), never a number, unless a unit follows ("6.8mmol").
      if (/[A-Za-z]/.test(text[start - 1] ?? "") || (/[A-Za-z]/.test(text[end] ?? "") && next.kind !== "UNIT")) continue;
      const parsed = digitToken(run[0]!.raw);
      if (parsed.kind === "TIME") continue;
      valueText = parsed.kind === "VALUE" ? parsed.valueText : null;
    } else if (isNumberWord(run[0]!.lower)) {
      valueText = englishWordValue(run.map((token) => token.lower), vocabulary);
    }
    numbers.push({ start, end, valueText: split ? null : valueText, unitEnd: next.kind === "UNIT" ? next.unitEnd : null });
  }
  return numbers;
}

/** 13s.4 (R-5): 零–九, 十–十九, and X十 / X十Y for X 二–九 and Y 一–九 (二十 … 九十九). Never 百, 千 or 万. */
const ZH_INTEGER = /^(?:[二三四五六七八九]十[一二三四五六七八九]?|十[一二三四五六七八九]?|[零〇一二两三四五六七八九])$/;
/** Spoken decimal digits after 点 (a time such as 八点十分 holds 十 and is never a reading); only ONE digit gives a value (13s.4). */
const ZH_DECIMAL_DIGITS = /^[零〇一二三四五六七八九]+$/;
const ZH_DIGIT_VALUE: Readonly<Record<string, number>> = Object.freeze({ 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 });
const HAN = /\p{Script=Han}/u;

function chineseInteger(word: string): number {
  const tens = word.indexOf("十");
  if (tens < 0) return ZH_DIGIT_VALUE[word]!;
  const multiplier = tens === 0 ? 1 : ZH_DIGIT_VALUE[word[0]!]!;
  return multiplier * 10 + (word.length > tens + 1 ? ZH_DIGIT_VALUE[word[tens + 1]!]! : 0);
}

function chineseNumbers(text: string, patterns: Patterns): NumberToken[] {
  const numbers: NumberToken[] = [];
  for (const match of text.matchAll(patterns.token)) {
    const raw = match[0];
    const start = match.index;
    const end = start + raw.length;
    if (start > 0 && ZH_NOT_READING_PREFIXES.includes(text[start - 1]!)) continue;
    const nextChar = text[end];
    const next = follower(text, end, patterns);
    if (next.kind === "NOT_READING") continue;
    // Round 5 (revised B): 左右 right after the number is a hedge the reading drops ("七点八左右" → 7.8), not another word.
    if (next.kind === "NONE" && nextChar !== undefined && HAN.test(nextChar) && !ZH_READING_PARTICLES.includes(nextChar) && !ZH_SPLIT_AFTER.test(text.slice(end)) && !ZH_HEDGE_AFTER.test(text.slice(end))) continue;
    const split = ZH_SPLIT_BEFORE.test(text.slice(Math.max(0, start - 8), start)) || ZH_SPLIT_AFTER.test(text.slice(end, end + 8)) || signedNumber(text.slice(Math.max(0, start - RAW_LOOKBACK), start), "zh", voiceVocabulary("zh"));
    let valueText: string | null = null;
    if (/^[0-9０-９]/.test(raw)) {
      // Cr2: digits touching a Latin letter belong to a word ("A1c"), unless a unit follows.
      if (/[A-Za-z]/.test(text[start - 1] ?? "") || (/[A-Za-z]/.test(text[end] ?? "") && next.kind !== "UNIT")) continue;
      if (raw.includes("点")) {
        const [integer, decimals] = toAsciiDigits(raw).split("点") as [string, string];
        const joined = `${integer}.${decimals}`;
        valueText = isMmolEntryValue(joined) ? joined : null;
      } else {
        const parsed = digitToken(raw);
        if (parsed.kind === "TIME") continue;
        valueText = parsed.kind === "VALUE" ? parsed.valueText : null;
      }
    } else {
      const [integer, decimals] = raw.split("点") as [string, string | undefined];
      // 八点, 一点, 八点十分: a time or "a little", never a reading.
      if (decimals !== undefined && !ZH_DECIMAL_DIGITS.test(decimals)) continue;
      // 13s.4: more than one spoken decimal digit (六点二五) gives no value (never rounded); the number is still counted.
      if (ZH_INTEGER.test(integer) && (decimals === undefined || [...decimals].length === 1)) valueText = decimals === undefined ? String(chineseInteger(integer)) : `${chineseInteger(integer)}.${ZH_DIGIT_VALUE[decimals]}`;
    }
    numbers.push({ start, end, valueText: split ? null : valueText, unitEnd: next.kind === "UNIT" ? next.unitEnd : null });
  }
  return numbers;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Sentences and clauses
// ---------------------------------------------------------------------------------------------------------------------------------
const isDigitChar = (char: string | undefined) => char !== undefined && /[0-9０-９]/.test(char);

/** Owner clarification: bracketed glucose numbers are not readings. Preserve offsets and all original words for provenance and qualifiers. */
function bracketedRanges(text: string): Range[] {
  const ranges: Range[] = [];
  let depth = 0;
  let start = 0;
  let offset = 0;
  for (const char of text) {
    if (/\p{Ps}/u.test(char)) {
      if (depth === 0) start = offset;
      depth += 1;
    } else if (/\p{Pe}/u.test(char) && depth > 0) {
      depth -= 1;
      if (depth === 0) ranges.push({ start, end: offset + char.length });
    }
    offset += char.length;
  }
  // An unfinished bracket must not expose its number as a plain reading.
  if (depth > 0) ranges.push({ start, end: text.length });
  return ranges;
}

/** Sentence boundaries: ! ? ; their full-width forms, line breaks, and a period not followed (after spaces) by a digit. */
function sentenceBoundaries(text: string): number[] {
  const boundaries: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if ("!?;。！？；\n".includes(char)) boundaries.push(index);
    else if ((char === "." || char === "．") && !isDigitChar(text.slice(index + 1).trimStart()[0]) && !(/[零〇一二两三四五六七八九十]/.test(text[index - 1] ?? "") && /[零〇一二两三四五六七八九十]/.test(text[index + 1] ?? ""))) boundaries.push(index);
  }
  return boundaries;
}

export type VoiceTextRange = Readonly<{ start: number; end: number }>;
type Range = VoiceTextRange;
const QUESTION: Readonly<Record<VoiceLanguage, RegExp>> = Object.freeze({
  en: /[?？]|(?<![A-Za-z])(?:what|how|why|when|should i|can i|could i|do i|did i|is it|is that|is this|am i|can you|could you|would you)(?![A-Za-z])|^\s*(?:is|was|are|were|has|have|did|does|do|can|could|will|would)\s+(?:my|the|your|our|his|her|their)(?![A-Za-z])/i,
  // 13s.3 (I3): 多少, 几 and the A-not-A form (疼不疼, 打不打) are questions too.
  zh: /[?？吗]|怎么|什么|为什么|要不要|该不该|能不能|可不可以|多少|几|是否|(\p{Script=Han})不\1/u,
});
const EN_CLAUSE_CUT = /[,，、]|\s+(?:and|but)\s+(?=(?:i|then|my|took|had|ate|injected|did|used|also|afterwards|after|before|later)\b)|\s+(?:then|but)\s+/gi;
const ZH_CLAUSE_CUT = /[,，、]|然后|但是|可是|不过/g;

function trimRange(text: string, start: number, end: number): Range | null {
  while (start < end && /\s/.test(text[start]!)) start += 1;
  while (end > start && /[\s.．。!！?？;；]/.test(text[end - 1]!) && !(text[end - 1] === "." && isDigitChar(text[end]))) end -= 1;
  return end > start ? { start, end } : null;
}

function clauses(text: string, language: VoiceLanguage, boundaries: number[], splitAtCue = true): Range[] {
  const cuts: Array<[number, number]> = boundaries.map((index) => [index, index + 1]);
  for (const match of text.matchAll(language === "zh" ? ZH_CLAUSE_CUT : EN_CLAUSE_CUT)) cuts.push([match.index, match.index + match[0].length]);
  cuts.sort((left, right) => left[0] - right[0]);
  const ranges: Range[] = [];
  let cursor = 0;
  for (const [start, end] of cuts) {
    if (start < cursor) continue;
    const range = trimRange(text, cursor, start);
    if (range) ranges.push(range);
    cursor = end;
  }
  const last = trimRange(text, cursor, text.length);
  if (last) ranges.push(last);
  return splitAtCue ? ranges.flatMap((range) => splitAtGlucoseCue(text, range, language)) : ranges;
}

/**
 * 13s.3 (I1, M4): a clause that holds a meal or medicine fact and then a glucose cue ("I had chicken rice and sugar 6.8",
 * "我午饭吃了鸡饭血糖六点八") is split at the cue, so neither fact is blanked or dropped by the other.
 */
function splitAtGlucoseCue(text: string, range: Range, language: VoiceLanguage): Range[] {
  const patterns = PATTERNS[language];
  const clause = text.slice(range.start, range.end);
  const cue = new RegExp(patterns.cue.source, patterns.cue.flags.replace("g", "")).exec(clause);
  if (!cue || cue.index === 0) return [range];
  const before = clause.slice(0, cue.index);
  if (!(patterns.eat.test(before) || patterns.noun.test(before) || patterns.statusTaken.test(before) || patterns.statusSkipped.test(before) || (language === "en" && /(?<![A-Za-z])(?:inject(?:ed|ing|s)?|had|have)(?![A-Za-z])/i.test(before)))) return [range];
  let leftEnd = range.start + cue.index;
  const tail = /(?:[\s,，、]+(?:and|but|then|so))?[\s,，、]*$|(?:然后|还有|和)$/i.exec(text.slice(range.start, leftEnd));
  if (tail) leftEnd -= tail[0].length;
  const left = trimRange(text, range.start, leftEnd);
  const right = trimRange(text, range.start + cue.index, range.end);
  return [left, right].filter((part): part is Range => part !== null);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Medicines and meals
// ---------------------------------------------------------------------------------------------------------------------------------
type Found = Readonly<{ start: number; end: number; ref: VoiceMedicineRef }>;

function phraseRegex(phrase: string, language: VoiceLanguage): RegExp | null {
  const normal = normaliseVoicePhrase(phrase, language);
  if (normal.length === 0) return null;
  if (language === "zh") return new RegExp([...normal].map(escape).join("\\s*"));
  return new RegExp(`(?<![A-Za-z])${normal.split(" ").map((word) => escape(word).replace(/'/g, "['’]")).join("\\s+")}(?![A-Za-z])`, "i");
}

function lookup(phrase: string, language: VoiceLanguage, directory: VoiceMedicineDirectory): VoiceMedicineRef {
  const normal = normaliseVoicePhrase(phrase, language);
  const term = directory.terms.find((entry) => normaliseVoicePhrase(entry.phrase, language) === normal);
  if (term) return { kind: "MAPPED", phrase, medication: term.medication, via: "TERMINOLOGY" };
  const name = directory.names.find((entry) => normaliseVoicePhrase(entry.name, language) === normal);
  if (name) return { kind: "MAPPED", phrase, medication: name.medication, via: "EXACT_NAME" };
  return { kind: "UNRESOLVED", phrase };
}

function findMedicine(text: string, range: Range, language: VoiceLanguage, patterns: Patterns, directory: VoiceMedicineDirectory): Found | null {
  const clause = text.slice(range.start, range.end);
  const exact = (entries: ReadonlyArray<{ text: string; medication: VoiceMedicationRef; via: "TERMINOLOGY" | "EXACT_NAME" }>): Found | null => {
    for (const entry of [...entries].sort((left, right) => right.text.length - left.text.length)) {
      const match = phraseRegex(entry.text, language)?.exec(clause);
      if (match) return { start: range.start + match.index, end: range.start + match.index + match[0].length, ref: { kind: "MAPPED", phrase: match[0], medication: entry.medication, via: entry.via } };
    }
    return null;
  };
  const remembered = exact(directory.terms.map((entry) => ({ text: entry.phrase, medication: entry.medication, via: "TERMINOLOGY" as const })));
  if (remembered) return remembered;
  const named = exact(directory.names.map((entry) => ({ text: entry.name, medication: entry.medication, via: "EXACT_NAME" as const })));
  if (named) return named;
  const noun = patterns.noun.exec(clause) ?? (language === "en" ? /(?<![A-Za-z])inject(?:ed|ing|s)?(?![A-Za-z])/i.exec(clause) : null);
  if (!noun) return null;
  const nounStart = range.start + noun.index;
  const nounEnd = nounStart + noun[0].length;
  let phraseStart = nounStart;
  if (language === "en") {
    const before = [...text.slice(range.start, nounStart).matchAll(/[A-Za-z][A-Za-z'’-]*/g)];
    for (let index = before.length - 1, taken = 0; index >= 0 && taken < 2; index -= 1, taken += 1) {
      const word = before[index]!;
      const wordStart = range.start + word.index;
      // A number word ("two tablets", "ten units of") is an amount, never part of the description.
      if (!/^\s*$/.test(text.slice(wordStart + word[0].length, phraseStart)) || EN_MEDICINE_PHRASE_STOPWORDS.includes(word[0].toLowerCase()) || voiceVocabulary("en").integerWords.includes(word[0].toLowerCase())) break;
      phraseStart = wordStart;
    }
  } else {
    const before = text.slice(Math.max(range.start, nounStart - 6), nounStart);
    let cut = 0;
    for (let index = 0; index < before.length; index += 1) if (ZH_MEDICINE_PHRASE_STOPS.includes(before[index]!) || !HAN.test(before[index]!)) cut = index + 1;
    phraseStart = nounStart - (before.length - cut);
    while (phraseStart < nounStart && text[phraseStart] === "的") phraseStart += 1;
  }
  const phrase = text.slice(phraseStart, nounEnd);
  return { start: phraseStart, end: nounEnd, ref: lookup(phrase, language, directory) };
}

function occurrenceStatus(clause: string, sentence: string, patterns: Patterns): VoiceOccurrenceStatus {
  if (patterns.statusUnknown.test(sentence)) return "UNKNOWN";
  if (patterns.statusSkipped.test(clause)) return "SKIPPED";
  if (patterns.statusPlanned.test(clause)) return "PLANNED";
  if (patterns.statusTaken.test(clause)) return "TAKEN";
  return "UNKNOWN";
}

const MEAL_SLOT_ORDER = ["BREAKFAST", "LUNCH", "DINNER", "SUPPER"] as const;
function mealSlot(clause: string, vocabulary: VoiceVocabulary, language: VoiceLanguage): VoiceMealSlot {
  let best: { slot: VoiceMealSlot; index: number } | null = null;
  for (const slot of MEAL_SLOT_ORDER) {
    const match = voiceWordMatcher(vocabulary.mealSlots[slot], language, language === "zh" ? "" : "i").exec(clause);
    if (match && (best === null || match.index < best.index)) best = { slot, index: match.index };
  }
  return best?.slot ?? "UNSTATED";
}

/** The exact spoken food words of a meal clause (a trimmed slice of it), or null when only the meal itself was named. */
function mealItems(text: string, range: Range, language: VoiceLanguage, patterns: Patterns): string | null {
  const clause = text.slice(range.start, range.end);
  let itemStart: number;
  if (language === "en") {
    const verb = /(?<![A-Za-z])(?:ate|eaten|eat|eating|had|was|is|were)\s+/gi;
    let last: RegExpExecArray | null = null;
    for (let match = verb.exec(clause); match; match = verb.exec(clause)) last = match;
    if (!last) return null;
    itemStart = last.index + last[0].length;
  } else {
    const verb = /吃了|吃过|吃|是/g;
    let last: RegExpExecArray | null = null;
    for (let match = verb.exec(clause); match; match = verb.exec(clause)) last = match;
    if (!last) return null;
    itemStart = last.index + last[0].length;
  }
  let items = clause.slice(itemStart);
  if (language === "en") {
    items = items.replace(/\s+(?:for|at|during|with)\s+(?:my\s+|the\s+)?(?:breakfast|lunch|dinner|supper)\b.*$/i, "");
    const lead = /^(?:a|an|some|my|the)\s+/i.exec(items);
    if (lead) {
      itemStart += lead[0].length;
      items = items.slice(lead[0].length);
    }
  } else {
    items = items.replace(/[了的]+$/, "");
  }
  items = items.replace(/[\s.。!！?？,，]+$/, "");
  items = items.trim();
  // M4: the slot word and trailing time words never leak into the food words ("breakfast today", "lunch at 1" → no food named).
  if (language === "en") {
    items = items.replace(/^(?:breakfast|lunch|dinner|supper)(?![A-Za-z])\s*/i, "");
    for (let previous = ""; previous !== items; ) {
      previous = items;
      items = items.replace(/\s*(?<![A-Za-z])(?:today|tonight|yesterday|this\s+(?:morning|afternoon|evening)|now|later|at\s+[0-9A-Za-z:]+(?:\s*(?:am|pm))?)$/i, "").trim();
    }
  } else {
    items = items.replace(/^(?:早餐|早饭|午餐|午饭|中饭|晚餐|晚饭|夜宵|宵夜)/, "").replace(/^(?:今天|现在|刚才)/, "").trim();
  }
  if (items.length === 0 || patterns.slot.test(items) && normaliseVoicePhrase(items.replace(patterns.slot, ""), language).length === 0) return null;
  if (/^(?:it|that|this|something|anything|nothing)$/i.test(items)) return null;
  return items;
}

/** The words that are qualifier cues anyway (they flag the fact), so the allow-lists accept them. */
function qualifierPhrases(vocabulary: VoiceVocabulary): string[] {
  return [...vocabulary.negationCues, ...vocabulary.uncertaintyCues, ...vocabulary.correctionCues, ...vocabulary.glucoseCues, ...vocabulary.mmolUnits];
}

/**
 * Cr1/Cr2 allow-lists. `preCue`: the text before a glucose cue in its clause may hold only first person, fillers, times and qualifier
 * words (anything else, e.g. "kid", "auntie", "孩子", "病人", means the reading may be someone else's). `between`: the text between the
 * cue and its number may hold only the listed words, qualifier words and other numbers (anything else, e.g. "lipid", "in my tea",
 * "HbA1c", means it is not this reading). Other-person words are accepted between (they already flag OTHER_PERSON).
 */
function onlyAllowedWords(segment: string, language: VoiceLanguage, vocabulary: VoiceVocabulary, list: "preCue" | "between" | "tail"): boolean {
  const allowed =
    list === "preCue"
      ? vocabulary.preCueWords
      : list === "between"
        ? [...vocabulary.betweenWords, ...vocabulary.otherPersonCues]
        : // Round 5 (Critical 1): the reading's clause tail may hold only time, first-person and filler words (and qualifier cues).
          [...vocabulary.preCueWords, ...vocabulary.betweenWords, ...TAIL_EXTRA_WORDS[language]];
  if (language === "zh") {
    let rest = segment;
    for (const phrase of [...allowed, ...qualifierPhrases(vocabulary)].sort((left, right) => right.length - left.length)) rest = rest.split(phrase).join(" ");
    rest = rest.replace(/[零〇一二两三四五六七八九十百点0-9０-９.．,，、\s'’:：]/g, "");
    return !/[\p{Script=Han}A-Za-z]/u.test(rest);
  }
  let rest = segment.toLowerCase().replace(/[’]/g, "'");
  const phrases = [...qualifierPhrases(vocabulary), ...allowed].filter((phrase) => phrase.includes(" ")).sort((left, right) => right.length - left.length);
  for (const phrase of phrases) rest = rest.replace(new RegExp(`(?<![a-z])${escape(phrase).replace(/ /g, "\\s+")}(?![a-z])`, "g"), " ");
  const single = new Set([...allowed, ...qualifierPhrases(vocabulary), ...vocabulary.integerWords, ...vocabulary.tensWords, ...vocabulary.digitWords, vocabulary.decimalMarker].filter((word) => !word.includes(" ")));
  // A contracted negation ("wasn't", "cannot") is a qualifier word too (it flags NEGATION).
  const accepted = (word: string) => single.has(word) || single.has(word.replace(/'s$/, "")) || single.has(word.replace(/'/g, "")) || /n't$/.test(word);
  return (rest.match(/[a-z][a-z']*/g) ?? []).every(accepted);
}

const ZH_NUMERAL: Readonly<Record<string, number>> = Object.freeze({ 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 });
function chineseAmount(raw: string): string | null {
  let total = 0;
  let digit = 0;
  for (const char of raw) {
    if (char in ZH_NUMERAL) digit = ZH_NUMERAL[char]!;
    else if (char === "十") {
      total += (digit === 0 ? 1 : digit) * 10;
      digit = 0;
    } else if (char === "百") {
      total += digit * 100;
      digit = 0;
    } else return null;
  }
  total += digit;
  return total > 0 && total <= 9999 ? String(total) : null;
}

/** Owner #4: the amount the person reported in this occurrence clause, exactly as spoken (decimal value, spoken unit words), or null. */
function reportedAmount(clause: string, language: VoiceLanguage, patterns: Patterns, vocabulary: VoiceVocabulary, textBefore = ""): VoiceReportedAmount | null {
  const match = patterns.amount.exec(clause);
  if (!match) return null;
  // CR-11 round 8 (owner decision 2026-10-11): a signed amount ("I took -2 units", 我打了负二个单位, "about -2 units", "-(2) units") is never
  // a positive reported amount: the same sign detection as a glucose reading (sign class, spaces, brackets, quotes, invisible characters,
  // repeated hedge stripping, the capped look-back; a number right before the sign is a range) plus the sign words. No amount is kept;
  // the number then counts as an unreported number (the occurrence needs the person's edit, as for any other number said).
  // Round 9 addendum: the look-back reads the transcript before the clause too ("I took -; 2 units": the sign is in the previous clause).
  if (negativeBefore((textBefore + clause.slice(0, match.index)).slice(-RAW_LOOKBACK), language, vocabulary)) return null;
  const raw = match[1]!;
  let valueText: string | null;
  if (/^[0-9]/.test(raw)) valueText = /^\d{1,4}(?:\.\d{1,2})?$/.test(raw) ? raw : null;
  else if (language === "en") {
    const index = vocabulary.integerWords.indexOf(raw.toLowerCase());
    valueText = index > 0 ? String(index) : null;
  } else valueText = chineseAmount(raw);
  return valueText === null ? null : Object.freeze({ valueText, unitText: match[2]! });
}

/** M4: a spoken count or number in a medicine clause (EN digits or two..twenty; ZH digits or a numeral with a classifier). */
function unreportedNumber(text: string, language: VoiceLanguage, vocabulary: VoiceVocabulary): boolean {
  // Round 4 (minor): "half" and 半 are spoken amounts too ("I took half a tablet").
  if (language === "zh") return /[0-9０-９]|半|[一两二三四五六七八九十]+(?:个|片|粒|颗|次|单位|毫克|毫升)/.test(text);
  const words = [...vocabulary.integerWords.filter((word) => word !== "zero" && word !== "one"), "half"];
  return new RegExp(`(?<![A-Za-z0-9])(?:\\d+(?:\\.\\d+)?|${words.join("|")})(?![A-Za-z])`, "i").test(text);
}

/** I3: an "eaten" thing named only by a count, colour or pill classifier is not a meal (it may be a pill: not understood). */
function pillLikeMeal(clause: string, itemText: string | null, language: VoiceLanguage, vocabulary: VoiceVocabulary): boolean {
  if (itemText === null) return false;
  if (language === "zh") {
    if (!/[颗粒片]|色/.test(clause)) return false;
    return itemText.replace(/[零〇一二两三四五六七八九十0-9]|[颗粒片个]|[白黑红黄蓝绿灰紫粉橙棕]色?|色|的|那|这/g, "").trim().length === 0;
  }
  const words = itemText.toLowerCase().split(/\s+/).filter(Boolean);
  const filler = ["the", "a", "an", "small", "big", "little", "of", "them", "those", "these"];
  return words.some((word) => vocabulary.pillLikeMealWords.includes(word)) && words.every((word) => vocabulary.pillLikeMealWords.includes(word) || vocabulary.integerWords.includes(word) || /^\d+$/.test(word) || filler.includes(word));
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------------------------------------------------------------
type Cue = Readonly<{ start: number; end: number }>;
export type VoiceExtraction = Readonly<{ candidates: readonly VoiceCandidate[]; truncated: boolean }>;

/** The extraction step alone (no redirect, no length check); `analyseTranscript` is the entry point. */
export function extractVoiceCandidates(text: string, language: VoiceLanguage, options: VoiceAnalysisOptions = {}, scopeOptions: InternalScope = NO_SCOPE): VoiceExtraction {
  const vocabulary = voiceVocabulary(language);
  const patterns = PATTERNS[language];
  const directory = options.medicines ?? EMPTY_DIRECTORY;
  const boundaries = sentenceBoundaries(text);
  const sentenceIndex = (offset: number) => boundaries.filter((boundary) => boundary < offset).length;
  const toCodePoints = (offset: number) => codePointLength(text.slice(0, offset));
  const base = (start: number, end: number) => {
    let clippedEnd = end;
    while (codePointLength(text.slice(start, clippedEnd)) > VOICE_SOURCE_PHRASE_MAX_CODE_POINTS) clippedEnd -= 1;
    const sourcePhrase = text.slice(start, clippedEnd);
    const codePointStart = toCodePoints(start);
    return { span: Object.freeze({ start: codePointStart, end: codePointStart + codePointLength(sourcePhrase) }), sourcePhrase, source: "DETERMINISTIC" as const, producerVersion: VOICE_VOCABULARY_VERSION };
  };
  const ordered = (reasons: Set<VoiceAmbiguityReason>) => VOICE_AMBIGUITY_REASONS.filter((reason) => reasons.has(reason));
  const wholeCorrection = patterns.correction.test(text);
  const wholeOtherPerson = patterns.otherPerson.test(text);
  // Owner decision 2026-10-12 (second person): "you"/"your" count only inside the fact's own clause (`text.slice(from, to)`).
  const secondPersonIn = (from: number, to: number) => patterns.secondPerson?.test(text.slice(from, to)) ?? false;
  // Fix rounds 1–3 (controller rulings): ... or earlier in the same sentence (an implied subject: "you had rice and took the dark pen",
  // "… then took my dark pen") unless the fact's clause has its own subject-form first person BEFORE its first verb or cue (`pivot`;
  // for a reading also "my" there). Such a cancelled "you" still leaves UNCERTAINTY (edit-only, never one tap: round 3, rule 2).
  // Another sentence, or a "you" later than the clause, never counts.
  const secondPersonReason = (from: number, to: number, pivot: number, withPossessive = false): "OTHER_PERSON" | "UNCERTAINTY" | null => {
    if (secondPersonIn(from, to)) return "OTHER_PERSON";
    const index = sentenceIndex(from);
    const sentenceStart = index === 0 ? 0 : boundaries[index - 1]! + 1;
    const lead = text.slice(from, Math.max(from, pivot));
    const ownSubject = (patterns.firstPersonSubject?.test(lead) ?? false) || (withPossessive && (patterns.possessiveBeforeCue?.test(lead) ?? false));
    if (secondPersonIn(sentenceStart, from)) return ownSubject ? "UNCERTAINTY" : "OTHER_PERSON";
    // Fix rounds 4–5 (controller rulings): a subjectless fact after a sentence holding "you"/"your" ("You took metformin. Took the dark
    // pen.") is edit-only: UNCERTAINTY, never OTHER_PERSON. The walk back skips sentences with neither "you"/"your" nor a subject-form
    // first person ("my" is not one here) and stops at the nearest one with either: "you" there (even "I told you") gives UNCERTAINTY;
    // a first person alone gives nothing ("You had breakfast. I had lunch. Took the dark pen.").
    if (ownSubject || patterns.secondPerson === null) return null;
    let previousEnd = sentenceStart - 1;
    for (let previous = index - 1; previous >= 0; previous -= 1) {
      const previousStart = previous === 0 ? 0 : boundaries[previous - 1]! + 1;
      if (secondPersonIn(previousStart, previousEnd)) return "UNCERTAINTY";
      if (patterns.firstPersonSubject?.test(text.slice(previousStart, previousEnd))) return null;
      previousEnd = previousStart - 1;
    }
    return null;
  };
  /** Round 3: the offset of the first match of any of `verbs` in the clause (the clause end when none). */
  const firstVerbAt = (range: Range, verbs: ReadonlyArray<RegExp>) => range.start + Math.min(range.end - range.start, ...verbs.map((verb) => verb.exec(text.slice(range.start, range.end))?.index ?? Infinity));
  const cueInClause = new RegExp(patterns.cue.source, patterns.cue.flags.replace("g", ""));

  const candidates: Array<{ start: number; candidate: VoiceCandidate }> = [];
  const factRanges: Range[] = [];

  // Meals and medicines, one per clause.
  const overlapsExcluded = (start: number, end: number) => scopeOptions.exclude.some((range) => range.start < end && range.end > start);
  const allClauses = clauses(text, language, boundaries);
  const clauseRanges = allClauses.filter((range) => !overlapsExcluded(range.start, range.end));
  const glucoseClauses = allClauses.filter((range) => cueInClause.test(text.slice(range.start, range.end)));
  // I1: a meal or medicine fact takes its qualifiers from its sentence WITHOUT the glucose clauses (their words belong to the reading).
  const factSentence = (range: Range) => {
    const index = sentenceIndex(range.start);
    const sentenceStart = index === 0 ? 0 : boundaries[index - 1]! + 1;
    const sentenceEnd = boundaries[index] ?? text.length;
    let sentence = text.slice(sentenceStart, sentenceEnd);
    for (const glucose of glucoseClauses) {
      if (glucose.start < sentenceStart || glucose.end > sentenceEnd || (glucose.start <= range.start && glucose.end >= range.end)) continue;
      sentence = sentence.slice(0, glucose.start - sentenceStart) + " ".repeat(glucose.end - glucose.start) + sentence.slice(glucose.end - sentenceStart);
    }
    return sentence;
  };
  for (const range of clauseRanges) {
    const clause = text.slice(range.start, range.end);
    const sentence = factSentence(range);
    // A question is never a fact (it stays not understood; a dose, treatment or health question was already redirected).
    if (QUESTION[language].test(clause) || QUESTION[language].test(text.slice(range.end, range.end + 2))) continue;
    // M2: a clause about the medicine object (lost, bought, broken, left) or a relayed instruction is not an occurrence (not understood).
    const notOccurrence = patterns.notOccurrence.test(clause);
    const found = scopeOptions.withoutMedication || notOccurrence ? null : findMedicine(text, range, language, patterns, directory);
    if (notOccurrence && findMedicine(text, range, language, patterns, directory)) continue;
    if (found) {
      const said = occurrenceStatus(clause, sentence, patterns);
      const reasons = new Set<VoiceAmbiguityReason>();
      const statusWords = new RegExp(`${patterns.statusSkipped.source}|${patterns.statusPlanned.source}|${patterns.statusUnknown.source}`, "gi");
      if (said === "TAKEN" && patterns.negation.test(sentence.replace(statusWords, " "))) reasons.add("NEGATION");
      // P13X review CRITICAL 1: a negated "taken" ("I hadn't injected", "I wouldn't have taken") is never TAKEN: the status is unclear.
      // Recheck 6 (CRITICAL A): nor is a counterfactual one ("I'd have taken my dark pen", 我本来会打黑色的笔).
      const counterfactual = voiceWordMatcher(VOICE_COUNTERFACTUAL_CUES[language], language).test(sentence);
      const status = said === "TAKEN" && (reasons.has("NEGATION") || counterfactual) ? "UNKNOWN" : said;
      // Round 4 (I3): also when the status is unclear, so a plan or habit ("Tomorrow I inject", 我平时打) is never a one-tap TAKEN.
      if (patterns.uncertainty.test(sentence.replace(statusWords, " "))) reasons.add("UNCERTAINTY");
      if (wholeCorrection) reasons.add("CORRECTION");
      if (wholeOtherPerson) reasons.add("OTHER_PERSON");
      const medicinePivot = Math.min(found.start, firstVerbAt(range, [patterns.statusTaken, patterns.statusSkipped, PLANNED_STATUS_WORDS[language], patterns.statusUnknown, EN_MEDICINE_VERBS]));
      const medicineSecond = secondPersonReason(range.start, range.end, medicinePivot);
      if (medicineSecond) reasons.add(medicineSecond);
      if (found.ref.kind === "UNRESOLVED") reasons.add("MEDICINE_UNRESOLVED");
      if (status === "UNKNOWN") reasons.add("STATUS_UNCLEAR");
      // Owner #4: an amount the person reported for this occurrence, exactly as spoken (never advice).
      const amount = reportedAmount(clause, language, patterns, vocabulary, text.slice(Math.max(0, range.start - RAW_LOOKBACK), range.start));
      // M4: a number said in the clause that is not the reported amount ("I took 2 metformin") is never silently ignored: the fact
      // then needs the person's explicit edit.
      const amountMatch = amount ? patterns.amount.exec(clause) : null;
      const rest = amountMatch ? clause.slice(0, amountMatch.index) + " " + clause.slice(amountMatch.index + amountMatch[0].length) : clause;
      if (unreportedNumber(rest, language, vocabulary)) reasons.add("UNCERTAINTY");
      // Round 4 (minor): a skip that carries an amount ("I didn't inject 10 units") may be a different amount, not a skip.
      if (status === "SKIPPED" && amount) reasons.add("UNCERTAINTY");
      const spanRange = codePointLength(clause) <= VOICE_SOURCE_PHRASE_MAX_CODE_POINTS ? range : { start: found.start, end: found.end };
      const ambiguity = ordered(reasons);
      candidates.push({ start: spanRange.start, candidate: Object.freeze({ kind: "MEDICATION_OCCURRENCE", ...base(spanRange.start, spanRange.end), status, medicineRef: found.ref, reportedAmount: amount, state: ambiguity.length === 0 ? "UNDERSTOOD" : "AMBIGUOUS", ambiguity }) });
      factRanges.push(range);
      continue;
    }
    const isMeal = patterns.eat.test(clause) || (patterns.slot.test(clause) && (language === "zh" ? /是/.test(clause) : /(?<![A-Za-z])(?:had|was|is|were)(?![A-Za-z])/i.test(clause)));
    if (isMeal && !cueInClause.test(clause)) {
      const itemText = mealItems(text, range, language, patterns);
      // I3: 吃 with a count, colour or pill classifier and no food (吃了两颗白色的, "ate two white ones") is never a meal.
      if (pillLikeMeal(clause, itemText, language, vocabulary)) continue;
      const reasons = new Set<VoiceAmbiguityReason>();
      if (patterns.negation.test(sentence)) reasons.add("NEGATION");
      // I3: a planned meal (will, plan to, later, 待会, 打算, 要) is not a record of what was eaten.
      if (patterns.uncertainty.test(sentence) || patterns.statusPlanned.test(clause)) reasons.add("UNCERTAINTY");
      if (wholeCorrection) reasons.add("CORRECTION");
      if (wholeOtherPerson) reasons.add("OTHER_PERSON");
      const mealSecond = secondPersonReason(range.start, range.end, firstVerbAt(range, [patterns.eat, EN_MEAL_LINK_VERBS]));
      if (mealSecond) reasons.add(mealSecond);
      const ambiguity = ordered(reasons);
      candidates.push({ start: range.start, candidate: Object.freeze({ kind: "MEAL_NOTE", ...base(range.start, range.end), slot: mealSlot(clause, vocabulary, language), itemText, state: ambiguity.length === 0 ? "UNDERSTOOD" : "AMBIGUOUS", ambiguity }) });
      factRanges.push(range);
    }
  }

  // Glucose readings: qualifiers from the whole transcript except the meal and medicine clauses. Round 4 (I2): the excluded
  // (redirected) question clauses ARE scanned for negation, uncertainty and correction cues ("Sugar 6.8, is that right?"), without
  // their numbers; the pre-cue allow-list runs over `scope`, where they and the fact clauses are blank.
  let scope = text;
  for (const range of [...factRanges, ...scopeOptions.exclude]) scope = scope.slice(0, range.start) + " ".repeat(range.end - range.start) + scope.slice(range.end);
  let qualifierScope = text;
  for (const range of factRanges) qualifierScope = qualifierScope.slice(0, range.start) + " ".repeat(range.end - range.start) + qualifierScope.slice(range.end);
  for (const range of scopeOptions.exclude) qualifierScope = qualifierScope.slice(0, range.start) + qualifierScope.slice(range.start, range.end).replace(/[0-9０-９]/g, " ") + qualifierScope.slice(range.end);
  const bracketed = bracketedRanges(text);
  // Mask only the glucose parser's view, not the transcript or its qualifiers. Commas preserve offsets and prevent
  // token joining, cues, and range lower bounds inside brackets from creating an outside positive reading.
  let glucoseText = text;
  for (const range of bracketed) glucoseText = glucoseText.slice(0, range.start) + ",".repeat(range.end - range.start) + glucoseText.slice(range.end);
  const cues: Cue[] = [...glucoseText.matchAll(patterns.cue)].map((match) => ({ start: match.index, end: match.index + match[0].length }));
  const numbers = language === "en" ? englishNumbers(glucoseText, patterns, vocabulary) : chineseNumbers(glucoseText, patterns);
  const clauseAt = (offset: number) => allClauses.find((range) => range.start <= offset && offset < range.end) ?? null;
  // Owner decision 2026-10-12 (second person): a reading's own clause starts at the clause of its first cue BEFORE the I1 split at the
  // cue, so a possessive right before the cue ("I had rice and your sugar 6.8") stays with the reading (conservative).
  const unsplitClauses = clauses(text, language, boundaries, false);
  const readingClauseStart = (offset: number) => unsplitClauses.find((range) => range.start <= offset && offset < range.end)?.start ?? clauseAt(offset)?.start ?? offset;
  const readings = numbers
    .map((number) => {
      const windowCues = cues.filter((cue) => cue.end <= number.start && number.start - cue.end <= WINDOW[language] && sentenceIndex(cue.end) === sentenceIndex(number.start) && !patterns.otherMeasure.test(text.slice(cue.end, number.start)));
      const anchor = windowCues.length > 0 ? windowCues.reduce((nearest, cue) => (cue.end > nearest.end ? cue : nearest)) : null;
      if (anchor === null) return { number, windowCues, anchor: null };
      // Cr2: another measurement or substance anywhere in the cue's and the number's clauses, or anything outside the allow-list
      // between the cue and the number, means this is not a glucose reading.
      const from = clauseAt(Math.min(...windowCues.map((cue) => cue.start)))?.start ?? anchor.start;
      const to = clauseAt(number.start)?.end ?? number.end;
      if (patterns.otherMeasure.test(text.slice(from, to)) || !onlyAllowedWords(text.slice(anchor.end, number.start), language, vocabulary, "between")) return { number, windowCues, anchor: null };
      return { number, windowCues, anchor };
    })
    .filter((reading): reading is { number: NumberToken; windowCues: Cue[]; anchor: Cue } => reading.anchor !== null && !overlapsExcluded(reading.number.start, reading.number.end));
  // Several numbers after one cue (also beyond the window, review: "which I measured at nine, was 6.8"): all MULTIPLE_NUMBERS.
  const sameCueCount = (anchor: Cue) =>
    numbers.filter((number) => number.start >= anchor.end && sentenceIndex(number.start) === sentenceIndex(anchor.end) && !cues.some((cue) => cue.start >= anchor.end && cue.end <= number.start) && !patterns.otherMeasure.test(text.slice(anchor.end, number.start))).length;
  type GlucoseDraft = { start: number; end: number; valueText: string; spoken: boolean; reasons: Set<VoiceAmbiguityReason> };
  const glucoseDrafts: GlucoseDraft[] = [];
  for (const { number, windowCues, anchor } of readings) {
    if (number.valueText === null) continue;
    const start = Math.min(...windowCues.map((cue) => cue.start));
    // Round 5 (revised B): a hedge directly before (or 左右 directly after) the number is dropped from the qualifiers; the reading keeps
    // it in its phrase so the review always confirms it.
    const hedgeAfter = language === "zh" ? ZH_HEDGE_AFTER.exec(text.slice(number.unitEnd ?? number.end)) : null;
    const end = (number.unitEnd ?? number.end) + (hedgeAfter ? hedgeAfter[0].length : 0);
    const hedgeBefore = HEDGE_BEFORE[language].exec(text.slice(Math.max(start, number.start - 24), number.start));
    let glucoseScope = qualifierScope.slice(0, start) + text.slice(start, end) + qualifierScope.slice(end);
    const blank = (from: number, to: number) => (glucoseScope = glucoseScope.slice(0, from) + " ".repeat(to - from) + glucoseScope.slice(to));
    if (hedgeBefore) blank(number.start - hedgeBefore[0].length, number.start);
    if (hedgeAfter) blank(end - hedgeAfter[0].length, end);
    const reasons = new Set<VoiceAmbiguityReason>();
    if (number.unitEnd === null) reasons.add("UNIT_UNSTATED");
    if (patterns.negation.test(glucoseScope)) reasons.add("NEGATION");
    if (patterns.uncertainty.test(glucoseScope)) reasons.add("UNCERTAINTY");
    if (wholeCorrection) reasons.add("CORRECTION");
    // Explicit kinship, title or pronoun cues anywhere: OTHER_PERSON (never saved for this profile, not even from an edit). Owner
    // decision 2026-10-12 (second person): "you"/"your" only in the reading's own clause(s), from its first cue's clause to the end of
    // the clause holding its number and unit ("Your sugar is 6.8", "My sugar is 6.8 for you"), never from another clause.
    // Fix rounds 1–3: and an earlier "you" of the sentence unless a subject-form first person or "my" comes before the reading's first
    // cue in its clause ("You had lunch then sugar 6.8", "… 6.8 mmol for me", "… 6.8 mmol after I woke up"); then UNCERTAINTY ("… and
    // then my sugar was 6.8": the speaker's, but edit-only).
    if (wholeOtherPerson) reasons.add("OTHER_PERSON");
    const readingSecond = secondPersonReason(readingClauseStart(start), clauseAt(end - 1)?.end ?? end, start, true);
    if (readingSecond) reasons.add(readingSecond);
    // Cr1 + round 4 (C1, I4 decision): the allow-list now runs from the start of the SENTENCE (the meal and medicine clauses and the
    // redirected questions blank). A miss is NOT an explicit other-person cue, so it adds UNCERTAINTY (edit-only: the person may
    // correct and save it, never one tap) instead of OTHER_PERSON, which no edit can clear. Explicit cues still give OTHER_PERSON.
    const sentenceStart = (() => {
      const index = sentenceIndex(start);
      return index === 0 ? 0 : boundaries[index - 1]! + 1;
    })();
    if (!reasons.has("OTHER_PERSON") && !onlyAllowedWords(scope.slice(sentenceStart, start), language, vocabulary, "preCue")) reasons.add("UNCERTAINTY");
    // Round 4 (I1): "Is my sugar 7.2", "Was my sugar 7.2" (no "?") are questions, never a stated reading.
    if (language === "en" && EN_AUX_QUESTION_START.test(text.slice(sentenceStart, start))) reasons.add("UNCERTAINTY");
    // Round 5 (Critical 1): the rest of the reading's own clause after the number ("Sugar 7.2 for Mei Ling", "My sugar was 7.2 I
    // believe", 血糖七点二给美玲) may hold only the post-cue allow-list; anything else adds UNCERTAINTY (edit-only, never APP_DEFAULT).
    if (!reasons.has("OTHER_PERSON") && !onlyAllowedWords(scope.slice(end, clauseAt(end - 1)?.end ?? text.length), language, vocabulary, "tail")) reasons.add("UNCERTAINTY");
    if (sameCueCount(anchor) > 1) reasons.add("MULTIPLE_NUMBERS");
    glucoseDrafts.push({ start, end, valueText: number.valueText, spoken: number.unitEnd !== null, reasons });
  }

  // 13s.6 (owner decision 2026-10-14, design §2–§4): activities and feelings, English only, from the clauses no other fact took and no
  // glucose reading touches (their words describe that fact: "after my walk my sugar was 6.1", "lunch was good"), never from a question
  // or a redirected clause. A clause may hold an activity and, after "and/but/so", a feeling ("Walked 30 minutes and feeling good").
  // The transcript yields at most ONE feeling: every feeling clause's cues, merged in order, over one span from the first to the last.
  // These clauses are understood (not UNSUPPORTED), but for glucose readings they still count as other words in the transcript: the
  // round-4 C1 backstop applies to them unchanged (every reading gets UNCERTAINTY and never the app-default unit), so this feature never
  // makes a reading easier to save than before.
  const noteRanges: Range[] = [];
  if (language === "en") {
    const feelingParts: Array<{ start: number; end: number; cueKeys: readonly string[] }> = [];
    let previousFeeling: Range | null = null;
    for (const range of clauseRanges) {
      // A cue alone continues a feeling stated in the clause just before it, in the same sentence ("I'm not tired, but worried").
      const continuation = previousFeeling !== null && sentenceIndex(previousFeeling.start) === sentenceIndex(range.start) && /^[\s,，、]*(?:(?:and|but|then)\s*)?$/i.test(text.slice(previousFeeling.end, range.start));
      previousFeeling = null;
      if (factRanges.includes(range) || glucoseDrafts.some((draft) => draft.start < range.end && draft.end > range.start)) continue;
      const clause = text.slice(range.start, range.end);
      if (QUESTION.en.test(clause) || QUESTION.en.test(text.slice(range.end, range.end + 2))) continue;
      const activity = matchVoiceActivity(clause);
      if (activity) {
        const origin = base(range.start, range.end);
        candidates.push({ start: range.start, candidate: Object.freeze({ kind: "ACTIVITY_NOTE", ...origin, category: activity.category, label: origin.sourcePhrase.trim(), durationMinutes: activity.durationMinutes }) });
        noteRanges.push(range);
      }
      const starts = [0, ...[...clause.matchAll(/(?<![A-Za-z])(?:and|but|so|because|though|although)(?![A-Za-z])/gi)].map((match) => match.index)];
      for (const offset of starts) {
        const feeling = matchVoiceFeeling(clause.slice(offset), continuation && offset === 0);
        if (!feeling) continue;
        feelingParts.push({ start: range.start + offset + feeling.start, end: range.end, cueKeys: feeling.cueKeys });
        if (!noteRanges.includes(range)) noteRanges.push(range);
        previousFeeling = range;
        break;
      }
    }
    if (feelingParts.length > 0) {
      const start = Math.min(...feelingParts.map((part) => part.start));
      const end = Math.max(...feelingParts.map((part) => part.end));
      const cueKeys = [...new Set(feelingParts.flatMap((part) => part.cueKeys))].slice(0, VOICE_FEELING_MAX_CUES);
      // Her own words: the feeling's span, with the sentence's closing "." or "!" kept; at most 1000 code points.
      const closing = /^[.!]/.test(text.slice(end, end + 1)) ? 1 : 0;
      const words = [...text.slice(start, end + closing).trim()].slice(0, VOICE_FEELING_TEXT_MAX_CODE_POINTS).join("").trim();
      candidates.push({ start, candidate: Object.freeze({ kind: "FEELING_NOTE", ...base(start, end), cueKeys, text: words }) });
    }
  }

  // Everything else with words is not understood (never dropped).
  const covered = [
    ...candidates.filter(({ candidate }) => candidate.kind !== "FEELING_NOTE" && candidate.kind !== "ACTIVITY_NOTE").map(({ candidate }) => candidate.span),
    ...glucoseDrafts.map((draft) => base(draft.start, draft.end).span),
    ...noteRanges.map((range) => base(range.start, range.end).span),
  ];
  const unsupported: Array<{ start: number; candidate: VoiceCandidate }> = [];
  for (const range of clauseRanges) {
    const clause = text.slice(range.start, range.end);
    if (!/[\p{L}\p{N}]/u.test(clause)) continue;
    const startPoint = toCodePoints(range.start);
    const endPoint = toCodePoints(range.end);
    if (covered.some((span) => span.start < endPoint && span.end > startPoint)) continue;
    unsupported.push({ start: range.start, candidate: Object.freeze({ kind: "UNSUPPORTED_SPAN", ...base(range.start, range.end) }) });
  }

  // Round 4 (C1) structural backstop, owner requirement 5 (default-unit boundary): when anything in the transcript was not understood
  // ("Ah Ma, sugar 7.2", "John, sugar 6.8", "Sugar 7.2, for Ah Ma"), it may say whose or which reading this is, so every reading
  // gets UNCERTAINTY (not resolvable by an answer; the person must edit) and never the app-default unit.
  for (const draft of glucoseDrafts) {
    const { reasons } = draft;
    // 13s.6: a feeling or activity clause counts here exactly as before, when it was not understood.
    // 13s.7: so does a medicine-information request (it was not understood before).
    const otherWords = unsupported.length > 0 || noteRanges.length > 0 || scopeOptions.otherWords === true;
    if (otherWords) reasons.add("UNCERTAINTY");
    // Owner default-unit boundary (#2): the app's entry unit only for an otherwise unambiguous reading inside the app-default window
    // (review I2: "sugar 72" stays UNIT_UNSTATED; 13s.4: the person then confirms the unit explicitly); it never clears another reason.
    // Round 5 (revised B): a hedged reading never gets the app-default unit; the person confirms the unit ("Yes, mmol/L").
    const appDefault = !draft.spoken && !glucoseHedgeMarked(text.slice(draft.start, draft.end)) && reasons.size === 1 && reasons.has("UNIT_UNSTATED") && !otherWords && options.glucoseEntryUnit === "MMOL_PER_L" && glucoseValueInAppDefaultWindow(draft.valueText);
    if (appDefault) reasons.delete("UNIT_UNSTATED");
    const ambiguity = ordered(reasons);
    const unit = draft.spoken || appDefault ? "MMOL_PER_L" : "UNSTATED";
    const unitSource = draft.spoken ? "SPOKEN" : appDefault ? "APP_DEFAULT" : null;
    candidates.push({ start: draft.start, candidate: Object.freeze({ kind: "GLUCOSE_READING", ...base(draft.start, draft.end), valueText: draft.valueText, unit, unitSource, state: ambiguity.length === 0 ? "UNDERSTOOD" : "AMBIGUOUS", ambiguity }) });
  }
  candidates.push(...unsupported);

  candidates.sort((left, right) => left.start - right.start);
  return Object.freeze({
    candidates: Object.freeze(candidates.slice(0, VOICE_MAX_CANDIDATES).map(({ candidate }) => candidate)),
    truncated: candidates.length > VOICE_MAX_CANDIDATES,
  });
}

/** The analysis entry point: the distress gate first, then the redirect, then the length limit, then the bounded extraction. */
export function analyseTranscript(transcript: string, language: VoiceLanguage, options: VoiceAnalysisOptions = {}): VoiceAnalysis {
  if (language !== "en" && language !== "zh") throw new TypeError("VOICE_LANGUAGE_INVALID");
  const text = typeof transcript === "string" ? transcript : "";
  // Owner decision 2026-10-14: distress beats every other result (a dose or health question, an over-long transcript, any fact).
  const distress = detectVoiceDistress(text);
  if (distress.kind === "DISTRESS") return Object.freeze({ kind: "DISTRESS", language, candidates: [], cueKey: distress.cueKey, cuesVersion: VOICE_DISTRESS_CUES_VERSION, extractorVersion: VOICE_EXTRACTOR_VERSION });
  // P13X review CRITICAL 2: code-switched speech ("Sugar 15 要不要加 insulin") is redirected by EITHER language's classifier.
  const own = classifyVoiceAdviceRedirect(text, language);
  const redirect = own.kind === "REDIRECT" ? own : classifyVoiceAdviceRedirect(text, language === "en" ? "zh" : "en");
  // Owner #3: the category picks the fixed wording (dose/treatment vs health assessment).
  const category: VoiceRedirectCategory = redirect.kind === "REDIRECT" ? redirect.category : "DOSE_TREATMENT";
  const redirected = () =>
    Object.freeze({ kind: "REDIRECT" as const, language, candidates: [], category, messageKey: voiceRedirectMessageKey(category), transcribedNoteKey: VOICE_REDIRECT_TRANSCRIBED_NOTE_KEY, extractorVersion: VOICE_EXTRACTOR_VERSION });
  if (redirect.kind === "REDIRECT" && codePointLength(text) > VOICE_TRANSCRIPT_MAX_CODE_POINTS) return redirected();
  if (codePointLength(text) > VOICE_TRANSCRIPT_MAX_CODE_POINTS) return Object.freeze({ kind: "TRANSCRIPT_TOO_LONG", language, candidates: [], extractorVersion: VOICE_EXTRACTOR_VERSION });
  if (redirect.kind === "NONE") {
    // 13s.7 (HSA preview): whole sentences asking about a named medicine, only when the caller asks for them.
    const requests = options.medicineInformationRequests === true ? medicineInfoRequests(text, language, options.medicines ?? EMPTY_DIRECTORY) : [];
    if (requests.length === 0) {
      const extraction = extractVoiceCandidates(text, language, options);
      return Object.freeze({ kind: "ANALYSED", language, candidates: [...extraction.candidates], truncated: extraction.truncated, redirect: null, extractorVersion: VOICE_EXTRACTOR_VERSION });
    }
    const extraction = extractVoiceCandidates(text, language, options, { exclude: requests.map((request) => request.range), withoutMedication: false, otherWords: true });
    const candidates = [...extraction.candidates, ...requests.map((request) => request.candidate)].sort((left, right) => left.span.start - right.span.start);
    return Object.freeze({
      kind: "ANALYSED",
      language,
      candidates: candidates.slice(0, VOICE_MAX_CANDIDATES),
      truncated: extraction.truncated || candidates.length > VOICE_MAX_CANDIDATES,
      redirect: null,
      extractorVersion: VOICE_EXTRACTOR_VERSION,
    });
  }
  // Mixed safety content (owner requirement 6): the question clauses are shown as the redirect; the facts of the OTHER clauses are
  // offered separately, never a medicine occurrence. When no clause can be separated as the question, or nothing factual remains,
  // the whole utterance is the redirect (manual handling).
  const questionRanges = questionClauses(text, language);
  if (questionRanges.length === 0) return redirected();
  const extraction = extractVoiceCandidates(text, language, options, { exclude: questionRanges, withoutMedication: true });
  if (!extraction.candidates.some((candidate) => candidate.kind !== "UNSUPPORTED_SPAN")) return redirected();
  return Object.freeze({
    kind: "ANALYSED",
    language,
    candidates: [...extraction.candidates],
    truncated: extraction.truncated,
    redirect: Object.freeze({ category, messageKey: voiceRedirectMessageKey(category), transcribedNoteKey: VOICE_REDIRECT_TRANSCRIBED_NOTE_KEY }),
    extractorVersion: VOICE_EXTRACTOR_VERSION,
  });
}

/**
 * 13s.7 (HSA preview): the sentences that are, as a whole, a request for general information about one named medicine (English only),
 * with the candidate each one gives. Known names: `voice-medicine-info-cues.1` plus her own medicine names and remembered terms.
 */
function medicineInfoRequests(text: string, language: VoiceLanguage, directory: VoiceMedicineDirectory): Array<{ range: Range; candidate: VoiceMedicineInfoRequestCandidate }> {
  if (language !== "en") return [];
  const known = [...directory.names.map((entry) => entry.name), ...directory.terms.map((entry) => entry.phrase)];
  const found: Array<{ range: Range; candidate: VoiceMedicineInfoRequestCandidate }> = [];
  let cursor = 0;
  for (const boundary of [...sentenceBoundaries(text), text.length]) {
    const range = trimRange(text, cursor, boundary);
    cursor = boundary + 1;
    if (!range) continue;
    const sentence = text.slice(range.start, range.end);
    const name = matchVoiceMedicineInfoRequest(sentence, known);
    if (name === null || codePointLength(sentence) > VOICE_SOURCE_PHRASE_MAX_CODE_POINTS) continue;
    const start = codePointLength(text.slice(0, range.start));
    found.push({
      range,
      candidate: Object.freeze({ kind: "MEDICINE_INFO_REQUEST", span: Object.freeze({ start, end: start + codePointLength(sentence) }), sourcePhrase: sentence, source: "DETERMINISTIC", producerVersion: VOICE_VOCABULARY_VERSION, name }),
    });
  }
  return found;
}

/**
 * The clauses that carry a dose, treatment or health question (or name a medicine) in a redirected transcript: a clause that is a
 * redirect on its own, a question, or one holding a dose/treatment term or a medicine noun. Exported for the remote-extraction gate.
 */
export function questionClauses(text: string, language: VoiceLanguage): VoiceTextRange[] {
  const vocabulary = voiceVocabulary(language);
  const term = voiceWordMatcher(vocabulary.doseTreatmentTerms, language, language === "zh" ? "" : "i");
  const patterns = PATTERNS[language];
  return clauses(text, language, sentenceBoundaries(text)).filter((range) => {
    const clause = text.slice(range.start, range.end);
    return classifyVoiceAdviceRedirect(clause, language).kind === "REDIRECT" || QUESTION[language].test(clause) || term.test(clause) || patterns.noun.test(clause);
  });
}
