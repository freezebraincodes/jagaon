import {
  VOICE_AMBIGUITY_REASONS,
  VOICE_EXTRACTOR_VERSION,
  VOICE_MAX_CANDIDATES,
  VOICE_REDIRECT_TRANSCRIBED_NOTE_KEY,
  VOICE_SOURCE_PHRASE_MAX_CODE_POINTS,
  VOICE_TRANSCRIPT_MAX_CODE_POINTS,
  codePointLength,
  glucoseValueInRange,
  voiceRedirectMessageKey,
  type VoiceRedirectCategory,
  type VoiceReportedAmount,
  type VoiceAmbiguityReason,
  type VoiceAnalysis,
  type VoiceCandidate,
  type VoiceLanguage,
  type VoiceMealSlot,
  type VoiceMedicationRef,
  type VoiceMedicineRef,
  type VoiceOccurrenceStatus,
} from "./voice-contracts";
import { classifyVoiceAdviceRedirect, voiceWordMatcher } from "./voice-advice-redirect";
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
 * 1. the neutral dose/treatment redirect FIRST; a REDIRECT yields zero candidates (the redirect is never hidden behind a fact);
 * 2. a transcript over VOICE_TRANSCRIPT_MAX_CODE_POINTS code points is TRANSCRIPT_TOO_LONG (no candidates);
 * 3. otherwise at most VOICE_MAX_CANDIDATES candidates, ordered by position (`truncated` beyond).
 *
 * Glucose readings (review C1, C2, I1, I2):
 * - a number is a reading only when it follows a glucose cue within the window in the same sentence, with no other measurement named
 *   in between (weight, cholesterol, ketones, insulin ...). A unit or a number alone never makes a reading;
 * - numbers: one or two digits (no leading zero) with at most two decimals, English zero–twenty with "point" and digit words,
 *   Chinese 零–二十 with 点 and digit characters, and digits with 点 ("6点8"). A number next to a split or partial decimal or a
 *   magnitude word (". 2", ".8", "point eight", "dot", 点儿, hundred, 百 ...) is unsupported: no value, still counted;
 * - unit MMOL_PER_L only when spoken (never "mmol/mol"); else UNSTATED;
 * - negation, uncertainty (comparatives, targets, past times), corrections and other people are flagged from the WHOLE transcript,
 *   except the clauses that produced a meal or medicine fact (their words belong to that fact); several numbers after one cue are
 *   all MULTIPLE_NUMBERS.
 * Meals: a clause with an eating verb, or a meal word with "had/was/is", gives one MEAL_NOTE: the standard slot when said and the exact
 * food words when said. Medicines: a clause naming a medicine (a remembered term, an exact canonical name, or a generic medicine noun
 * with its 1–2 spoken describing words) gives one MEDICATION_OCCURRENCE with the occurrence status said (PLANNED, TAKEN, SKIPPED;
 * UNKNOWN when unclear, forgotten or unsure). A description is never matched loosely: only an exact remembered term or an exact
 * canonical name maps it; otherwise it stays UNRESOLVED for the clarification question.
 * Anything else with words or numbers is an UNSUPPORTED_SPAN (shown as not understood; never dropped, never interpreted).
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
 * - I2/#2: the app-default unit only inside VOICE_GLUCOSE_MMOL_PER_L_RANGE (0 < value ≤ 50); a spoken mg/dL is never reinterpreted.
 * - I3: a planned meal adds UNCERTAINTY; 吃 with a count, colour or pill classifier and no food is not a meal.
 * - M2: lost, bought, broken, left, ran out, relayed instructions (doctor said, 医生说) are not occurrences.
 * - #4/M4: a REPORTED amount ("I injected 10 units", 十个单位) is kept exactly as spoken in `reportedAmount`; any other number said in
 *   a medicine clause adds UNCERTAINTY instead of being dropped; meal items never carry the slot or time words.
 * - #3: the redirect carries its category (DOSE_TREATMENT or HEALTH_QUESTION) and the matching fixed copy key.
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
}>;
/** Internal: clauses already shown as a redirected question (no fact from them, no medicine occurrence beside them). */
type InternalScope = Readonly<{ exclude: readonly Range[]; withoutMedication: boolean }>;
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
      otherPerson: new RegExp(`(?<![A-Za-z])(?:${englishAlternation(vocabulary.otherPersonCues.filter((cue) => !cue.startsWith("'")))})(?![A-Za-z])|${EN_TIME_POSSESSIVE}['’]s\\s+(?:sugar|blood|glucose|reading|insulin|medicine|pill|pen|lunch|breakfast|dinner)`, "i"),
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
    token: new RegExp(`[${DIGITS}]{1,2}点[${DIGITS}]{1,2}(?![${DIGITS}])|[${DIGITS}]+(?:[.,:．：][${DIGITS}]+)*|[${ZH_INTEGER_CHARS}]+(?:点[${ZH_INTEGER_CHARS}]*)?`, "g"),
    unit: new RegExp(`^\\s*(?:${plainAlternation(vocabulary.mmolUnits)})(?!\\s*\\/\\s*mol)`, "i"),
    notReading: new RegExp(`^\\s*(?:${plainAlternation(vocabulary.notReadingFollowers)})`, "i"),
    otherMeasure: words(vocabulary.otherMeasureCues, ""),
    negation: words(vocabulary.negationCues, ""),
    uncertainty: words(vocabulary.uncertaintyCues, ""),
    correction: words(vocabulary.correctionCues, ""),
    otherPerson: words(vocabulary.otherPersonCues, ""),
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

// ---------------------------------------------------------------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------------------------------------------------------------
type NumberToken = Readonly<{ start: number; end: number; valueText: string | null; unitEnd: number | null }>;

const toAsciiDigits = (text: string) => text.replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0)).replace(/．/g, ".");
const STRICT_DIGITS = /^(?:0|[1-9]\d?)(?:\.\d{1,2})?$/;
/** Review C1: split or partial decimals and magnitude words around a number make it unsupported. */
const EN_SPLIT_BEFORE = /(?:[.．]|[0-9０-９]\s*[.．]\s*|(?<![A-Za-z])(?:point|dot|hundred(?:\s+and)?|thousand)\s+)$/i;
const EN_SPLIT_AFTER = /^\s*(?:[.．]\s*[0-9０-９]|(?:point|dot|hundred|thousand)(?![A-Za-z]))/i;
const ZH_SPLIT_BEFORE = /(?:点儿?|[.．]|[百千万]|[0-9０-９]\s*[.．]\s*)\s*$/;
const ZH_SPLIT_AFTER = /^\s*(?:儿?点|[.．]\s*[0-9０-９零〇一二两三四五六七八九]|[百千万])/;

function follower(text: string, end: number, patterns: Patterns): { kind: "UNIT"; unitEnd: number } | { kind: "NOT_READING" } | { kind: "NONE" } {
  const rest = text.slice(end, end + 32);
  if (patterns.notReading.test(rest)) return { kind: "NOT_READING" };
  const unit = patterns.unit.exec(rest);
  if (unit) return { kind: "UNIT", unitEnd: end + unit[0].length };
  return { kind: "NONE" };
}

function digitToken(raw: string): { kind: "TIME" } | { kind: "VALUE"; valueText: string } | { kind: "UNSUPPORTED" } {
  if (/[:：]/.test(raw)) return { kind: "TIME" };
  const ascii = toAsciiDigits(raw);
  return STRICT_DIGITS.test(ascii) ? { kind: "VALUE", valueText: ascii } : { kind: "UNSUPPORTED" };
}

function englishNumbers(text: string, patterns: Patterns, vocabulary: VoiceVocabulary): NumberToken[] {
  const tokens = [...text.matchAll(patterns.token)].map((match) => ({ start: match.index, end: match.index + match[0].length, raw: match[0], lower: match[0].toLowerCase() }));
  const isDigits = (raw: string) => /^[0-9０-９]/.test(raw);
  const numeric = (lower: string, raw: string) => isDigits(raw) || vocabulary.integerWords.includes(lower) || vocabulary.digitWords.includes(lower) || lower === vocabulary.decimalMarker;
  const numbers: NumberToken[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const first = tokens[index]!;
    if (!isDigits(first.raw) && !vocabulary.integerWords.includes(first.lower)) continue;
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
    const split = EN_SPLIT_BEFORE.test(text.slice(Math.max(0, start - 24), start)) || EN_SPLIT_AFTER.test(text.slice(end, end + 24));
    if (run.length === 1 && isDigits(run[0]!.raw)) {
      // Cr2: a digit touching a letter is part of a word ("HbA1c", "7ish"), never a number, unless a unit follows ("6.8mmol").
      if (/[A-Za-z]/.test(text[start - 1] ?? "") || (/[A-Za-z]/.test(text[end] ?? "") && next.kind !== "UNIT")) continue;
      const parsed = digitToken(run[0]!.raw);
      if (parsed.kind === "TIME") continue;
      valueText = parsed.kind === "VALUE" ? parsed.valueText : null;
    } else if (vocabulary.integerWords.includes(run[0]!.lower)) {
      const integer = vocabulary.integerWords.indexOf(run[0]!.lower);
      const decimals = run.slice(2).map((token) => vocabulary.digitWords.indexOf(token.lower));
      if (run.length === 1) valueText = String(integer);
      else if (run[1]!.lower === vocabulary.decimalMarker && decimals.length >= 1 && decimals.length <= 2 && decimals.every((digit) => digit >= 0)) valueText = `${integer}.${decimals.join("")}`;
    }
    numbers.push({ start, end, valueText: split ? null : valueText, unitEnd: next.kind === "UNIT" ? next.unitEnd : null });
  }
  return numbers;
}

const ZH_INTEGER = /^(二十|十[一二三四五六七八九]?|[零〇一二两三四五六七八九])$/;
const ZH_DECIMALS = /^[零〇一二三四五六七八九]{1,2}$/;
const ZH_DIGIT_VALUE: Readonly<Record<string, number>> = Object.freeze({ 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 });
const HAN = /\p{Script=Han}/u;

function chineseInteger(word: string): number {
  if (word === "二十") return 20;
  if (word.startsWith("十")) return 10 + (word.length > 1 ? ZH_DIGIT_VALUE[word[1]!]! : 0);
  return ZH_DIGIT_VALUE[word]!;
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
    if (next.kind === "NONE" && nextChar !== undefined && HAN.test(nextChar) && !ZH_READING_PARTICLES.includes(nextChar) && !ZH_SPLIT_AFTER.test(text.slice(end))) continue;
    const split = ZH_SPLIT_BEFORE.test(text.slice(Math.max(0, start - 8), start)) || ZH_SPLIT_AFTER.test(text.slice(end, end + 8));
    let valueText: string | null = null;
    if (/^[0-9０-９]/.test(raw)) {
      // Cr2: digits touching a Latin letter belong to a word ("A1c"), unless a unit follows.
      if (/[A-Za-z]/.test(text[start - 1] ?? "") || (/[A-Za-z]/.test(text[end] ?? "") && next.kind !== "UNIT")) continue;
      if (raw.includes("点")) {
        const [integer, decimals] = toAsciiDigits(raw).split("点") as [string, string];
        valueText = /^(?:0|[1-9]\d?)$/.test(integer) && /^\d{1,2}$/.test(decimals) ? `${integer}.${decimals}` : null;
      } else {
        const parsed = digitToken(raw);
        if (parsed.kind === "TIME") continue;
        valueText = parsed.kind === "VALUE" ? parsed.valueText : null;
      }
    } else {
      const [integer, decimals] = raw.split("点") as [string, string | undefined];
      // 八点, 一点, 八点十分: a time or "a little", never a reading.
      if (decimals !== undefined && !ZH_DECIMALS.test(decimals)) continue;
      if (ZH_INTEGER.test(integer)) valueText = decimals === undefined ? String(chineseInteger(integer)) : `${chineseInteger(integer)}.${[...decimals].map((digit) => ZH_DIGIT_VALUE[digit]).join("")}`;
    }
    numbers.push({ start, end, valueText: split ? null : valueText, unitEnd: next.kind === "UNIT" ? next.unitEnd : null });
  }
  return numbers;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Sentences and clauses
// ---------------------------------------------------------------------------------------------------------------------------------
const isDigitChar = (char: string | undefined) => char !== undefined && /[0-9０-９]/.test(char);

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

function clauses(text: string, language: VoiceLanguage, boundaries: number[]): Range[] {
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
  return ranges.flatMap((range) => splitAtGlucoseCue(text, range, language));
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
  const single = new Set([...allowed, ...qualifierPhrases(vocabulary), ...vocabulary.integerWords, ...vocabulary.digitWords, vocabulary.decimalMarker].filter((word) => !word.includes(" ")));
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
function reportedAmount(clause: string, language: VoiceLanguage, patterns: Patterns, vocabulary: VoiceVocabulary): VoiceReportedAmount | null {
  const match = patterns.amount.exec(clause);
  if (!match) return null;
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
      if (found.ref.kind === "UNRESOLVED") reasons.add("MEDICINE_UNRESOLVED");
      if (status === "UNKNOWN") reasons.add("STATUS_UNCLEAR");
      // Owner #4: an amount the person reported for this occurrence, exactly as spoken (never advice).
      const amount = reportedAmount(clause, language, patterns, vocabulary);
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
  const cues: Cue[] = [...text.matchAll(patterns.cue)].map((match) => ({ start: match.index, end: match.index + match[0].length }));
  const numbers = language === "en" ? englishNumbers(text, patterns, vocabulary) : chineseNumbers(text, patterns);
  const clauseAt = (offset: number) => allClauses.find((range) => range.start <= offset && offset < range.end) ?? null;
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
    const end = number.unitEnd ?? number.end;
    const start = Math.min(...windowCues.map((cue) => cue.start));
    const glucoseScope = qualifierScope.slice(0, start) + text.slice(start, end) + qualifierScope.slice(end);
    const reasons = new Set<VoiceAmbiguityReason>();
    if (number.unitEnd === null) reasons.add("UNIT_UNSTATED");
    if (patterns.negation.test(glucoseScope)) reasons.add("NEGATION");
    if (patterns.uncertainty.test(glucoseScope)) reasons.add("UNCERTAINTY");
    if (wholeCorrection) reasons.add("CORRECTION");
    // Explicit kinship, title or pronoun cues anywhere: OTHER_PERSON (never saved for this profile, not even from an edit).
    if (wholeOtherPerson) reasons.add("OTHER_PERSON");
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

  // Everything else with words is not understood (never dropped).
  const covered = [...candidates.map(({ candidate }) => candidate.span), ...glucoseDrafts.map((draft) => base(draft.start, draft.end).span)];
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
    if (unsupported.length > 0) reasons.add("UNCERTAINTY");
    // Owner default-unit boundary (#2): the app's entry unit only for an otherwise unambiguous reading inside the plausible mmol/L range
    // (review I2: "sugar 72" stays UNIT_UNSTATED); it never clears another reason.
    const appDefault = !draft.spoken && reasons.size === 1 && reasons.has("UNIT_UNSTATED") && unsupported.length === 0 && options.glucoseEntryUnit === "MMOL_PER_L" && glucoseValueInRange(draft.valueText);
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

/** The analysis entry point: the redirect first, then the length limit, then the bounded extraction. */
export function analyseTranscript(transcript: string, language: VoiceLanguage, options: VoiceAnalysisOptions = {}): VoiceAnalysis {
  if (language !== "en" && language !== "zh") throw new TypeError("VOICE_LANGUAGE_INVALID");
  const text = typeof transcript === "string" ? transcript : "";
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
    const extraction = extractVoiceCandidates(text, language, options);
    return Object.freeze({ kind: "ANALYSED", language, candidates: [...extraction.candidates], truncated: extraction.truncated, redirect: null, extractorVersion: VOICE_EXTRACTOR_VERSION });
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
