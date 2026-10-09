import type { ExtractionUnit, MedicineOccurrenceStatus } from "./transcript-extraction-contract";

/**
 * Packet 13 (P13X): the closed cue lexicon the extraction validator uses to tie each model field to the words (lexicon
 * transcript-extraction-lexicon.13.3). English cues match whole words, case-insensitively; Chinese cues match as substrings. Pure.
 * The lists are deliberately conservative: a missing cue makes the validator reject (deterministic fallback), never accept.
 */
export const TRANSCRIPT_EXTRACTION_LEXICON_VERSION = "transcript-extraction-lexicon.13.3";

type Cues = Readonly<{ en: readonly string[]; zh: readonly string[] }>;

/**
 * 13.3 (recheck 6 CRITICAL A): counterfactual wording ("I'd have taken my dark pen", "I would've injected", 我本来会打, 要是…就). A
 * TAKEN beside it is rejected (TAKEN_WITH_COUNTERFACTUAL), and it is also an uncertainty cue. Matched after apostrophe normalisation,
 * so the straight and curly apostrophe are the same; "i'd have" also matches "id have".
 */
export const COUNTERFACTUAL_CUES: Cues = Object.freeze({
  en: [
    "would", "would have", "would've", "wouldve", "i'd have", "id have", "we'd have", "you'd have", "he'd have", "she'd have", "they'd have",
    "could have", "could've", "couldve", "might have", "might've", "mightve", "must have", "must've", "should have", "should've", "shouldve",
  ],
  zh: ["本来会", "本来要", "本来", "本该", "本应", "要是", "就会"],
});
/** Uncertainty phrases. Removed before the negation scan, so "not sure" / "不确定" is uncertainty, not negation. */
export const UNCERTAINTY_CUES: Cues = Object.freeze({
  en: ["not sure", "i think", "i guess", "maybe", "about", "around", "probably", "perhaps", "or so", "roughly", "approximately", "something like", ...COUNTERFACTUAL_CUES.en],
  zh: ["不太确定", "不确定", "大概", "可能", "好像", "左右", "差不多", "应该是", "也许", ...COUNTERFACTUAL_CUES.zh],
});
/**
 * 13.2 (review CRITICAL 1): every English contracted negation, with or without the apostrophe, plus "nah" and "nope". The curly
 * apostrophe (U+2019) is normalised to ' before any cue is matched (see `normaliseApostrophes`).
 */
export const NEGATION_CUES: Cues = Object.freeze({
  en: [
    "not", "no", "nah", "nope", "never", "without", "none", "cannot",
    "didn't", "didnt", "don't", "dont", "doesn't", "doesnt", "haven't", "havent", "hasn't", "hasnt", "hadn't", "hadnt",
    "wasn't", "wasnt", "isn't", "isnt", "aren't", "arent", "weren't", "werent", "won't", "wont", "wouldn't", "wouldnt",
    "shouldn't", "shouldnt", "couldn't", "couldnt", "can't", "cant", "mustn't", "mustnt", "needn't", "neednt", "ain't", "aint",
  ],
  zh: ["没", "不", "未", "别", "无"],
});
/** U+2019 (right single quotation mark, as speech-to-text often writes "didn’t") → ASCII apostrophe, before every cue match. */
export const normaliseApostrophes = (text: string): string => text.replace(/[’‘ʼ]/g, "'");
const STATUS_CUES: Readonly<Record<Exclude<MedicineOccurrenceStatus, "UNKNOWN">, Cues>> = Object.freeze({
  TAKEN: { en: ["took", "taken", "had", "injected", "gave myself", "used", "did my", "done my", "jabbed"], zh: ["打了", "吃了", "注射了", "服了", "用了", "已经打", "已经吃", "打过", "吃过"] },
  PLANNED: { en: ["will", "going to", "gonna", "later", "plan", "planning", "need to", "have to", "about to", "tonight", "after dinner", "before bed"], zh: ["要", "待会", "等下", "等一下", "打算", "准备", "晚点", "一会", "等会"] },
  SKIPPED: { en: ["skip", "skipped", "forgot", "forgotten", "missed"], zh: ["跳过", "忘了", "忘记", "没打", "没吃", "没有打", "没有吃"] },
});
const UNIT_CUES: Readonly<Record<ExtractionUnit, Cues>> = Object.freeze({
  MMOL_PER_L: { en: ["mmol", "mmol/l", "millimol", "millimoles", "millimole"], zh: ["毫摩尔"] },
  MG_PER_DL: { en: ["mg/dl", "mg per dl", "milligrams per decilitre", "milligrams per deciliter"], zh: ["毫克每分升"] },
  UNITS: { en: ["unit", "units", "iu"], zh: ["单位"] },
  MG: { en: ["mg", "milligram", "milligrams"], zh: ["毫克"] },
  TABLET: { en: ["tablet", "tablets", "pill", "pills"], zh: ["粒", "片"] },
  ML: { en: ["ml", "millilitre", "milliliter", "millilitres", "milliliters"], zh: ["毫升"] },
});

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
function enPattern(words: readonly string[]): RegExp {
  const alternatives = [...words].sort((a, b) => b.length - a.length).map((word) => escape(word).replace(/ /g, "\\s+"));
  return new RegExp(`(?<![A-Za-z'])(?:${alternatives.join("|")})(?![A-Za-z'])`, "i");
}
function has(raw: string, cues: Cues): boolean {
  const text = normaliseApostrophes(raw);
  return enPattern(cues.en).test(text) || cues.zh.some((cue) => text.includes(cue));
}
function strip(raw: string, cues: Cues): string {
  let out = normaliseApostrophes(raw);
  for (const cue of [...cues.zh].sort((a, b) => b.length - a.length)) out = out.split(cue).join(" ");
  return out.replace(new RegExp(enPattern(cues.en).source, "gi"), " ");
}

export const hasUncertaintyCue = (text: string): boolean => has(text, UNCERTAINTY_CUES);
export const hasCounterfactualCue = (text: string): boolean => has(text, COUNTERFACTUAL_CUES);
export const hasNegationCue = (text: string): boolean => has(strip(text, UNCERTAINTY_CUES), NEGATION_CUES);
export const hasStatusCue = (text: string, status: Exclude<MedicineOccurrenceStatus, "UNKNOWN">): boolean => has(text, STATUS_CUES[status]);
export const hasUnitCue = (text: string, unit: ExtractionUnit): boolean => has(text, UNIT_CUES[unit]);

// ---- Numbers as spoken: digits (ASCII or full-width) and English / Chinese number words -----------------------------------------

const FULL_WIDTH = /[０-９．]/g;
const toAscii = (text: string) => text.replace(FULL_WIDTH, (ch) => (ch === "．" ? "." : String.fromCharCode(ch.charCodeAt(0) - 0xfee0)));
const EN_UNITS: Readonly<Record<string, number>> = Object.freeze({
  zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
});
const EN_TENS: Readonly<Record<string, number>> = Object.freeze({ twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 });
const ZH_DIGITS: Readonly<Record<string, number>> = Object.freeze({ 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 });

function canonical(integer: number, decimals: string): string {
  return decimals.length > 0 ? `${integer}.${decimals}` : String(integer);
}

function englishNumbers(text: string): string[] {
  const out: string[] = [];
  const tokens = text.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i += 1) {
    if (!(tokens[i]! in EN_UNITS || tokens[i]! in EN_TENS)) continue;
    let value = 0;
    let j = i;
    let current = 0;
    for (; j < tokens.length; j += 1) {
      const token = tokens[j]!;
      if (token in EN_TENS) current += EN_TENS[token]!;
      else if (token in EN_UNITS) current += EN_UNITS[token]!;
      else if (token === "hundred" && current > 0) current *= 100;
      else if (token === "and" && current >= 100) continue;
      else break;
    }
    value = current;
    let decimals = "";
    if (tokens[j] === "point") {
      let k = j + 1;
      while (k < tokens.length && tokens[k]! in EN_UNITS && EN_UNITS[tokens[k]!]! <= 9 && decimals.length < 2) {
        decimals += String(EN_UNITS[tokens[k]!]);
        k += 1;
      }
      j = k;
    }
    out.push(canonical(value, decimals));
    i = j - 1;
  }
  return out;
}

function chineseNumbers(text: string): string[] {
  const out: string[] = [];
  const runs = text.match(/[零〇一二两三四五六七八九十百]+(?:点[零〇一二两三四五六七八九]+)?/g) ?? [];
  for (const run of runs) {
    const [whole, fraction = ""] = run.split("点");
    let total = 0;
    let digit = 0;
    let valid = true;
    for (const ch of whole!) {
      if (ch in ZH_DIGITS) digit = ZH_DIGITS[ch]!;
      else if (ch === "十") {
        total += (digit === 0 ? 1 : digit) * 10;
        digit = 0;
      } else if (ch === "百") {
        total += digit * 100;
        digit = 0;
      } else valid = false;
    }
    total += digit;
    if (!valid) continue;
    const decimals = [...fraction].map((ch) => String(ZH_DIGITS[ch] ?? "")).join("").slice(0, 2);
    out.push(canonical(total, decimals));
  }
  return out;
}

/** Every number the words state, as canonical decimals ("6.5", "10", "120"). */
export function spokenNumbers(text: string): string[] {
  const ascii = toAscii(text);
  const digits = (ascii.match(/\d+(?:\.\d+)?/g) ?? []).map((match) => {
    const [whole, fraction = ""] = match.split(".");
    return canonical(Number(whole), fraction.replace(/0+$/, ""));
  });
  return [...digits, ...englishNumbers(ascii), ...chineseNumbers(ascii)];
}

/** True when `value` (a canonical decimal) is a number the span's words state. */
export function valueStatedIn(text: string, value: string): boolean {
  const [whole, fraction = ""] = value.split(".");
  const normalised = canonical(Number(whole), fraction.replace(/0+$/, ""));
  return spokenNumbers(text).includes(normalised);
}

/** True when the text holds any digit or number word (used for the "no number left unaccounted" rule). */
export const hasSpokenNumber = (text: string): boolean => spokenNumbers(text).length > 0;
