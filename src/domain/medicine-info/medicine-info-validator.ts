import { ADVICE_PATTERNS, DOSE_PATTERNS, MEDICINE_NOUNS, normaliseFeelingsText } from "@/domain/feelings-chat/feelings-chat-validator";
import {
  isMedicineInfoName,
  medicineGeneralInfoSchema,
  medicineInfoReplySchema,
  normaliseMedicineInfoName,
  type MedicineGeneralInfo,
  type MedicineInfoRequest,
} from "./medicine-info-contract";

/**
 * HSA preview (owner decision 2026-10-14, "Get general information with AI"): the deterministic validator that guards EVERY AI answer
 * about a medicine, `medicine-info-validator.1`. Pure; the server route runs it before answering and the browser client runs it again
 * (on the route's answer and on every cached entry) before anything is shown. An answer is rejected when any rule fails:
 *   1. SCHEMA: strict JSON matching the contract with its kind rules; `name` and `genericName` follow the request's name rule;
 *   2. TEXT_FORMAT: each of `usedFor` and `howGenerallyTaken` is 20–300 characters, one line, 1–3 sentences ending in ".", no question,
 *      list or link;
 *   3. DIRECTIONS_SENTENCE: `howGenerallyTaken` ends with "Follow your doctor's or pharmacist's directions.";
 *   4. DOSE_AMOUNT: a number with an amount unit (mg, mcg, g, ml, units, IU, tablet(s), capsule(s), puff(s) ...), or a dose word
 *      (dose, dosage, dosing, units, double, skip your ...; the feelings-chat dose lexicon);
 *   5. FREQUENCY: a counted frequency ("2 times a day", "3x daily", "twice a day", "once daily", "every 8 hours");
 *   6. ADVICE: advice or an instruction (the feelings-chat advice lexicon, plus "try", "do not", "never", "avoid", "please", "remember
 *      to" and an imperative opening a sentence such as "Take ...", "Stop ...", "Inject ..."; the fixed closing "Follow ..." is allowed);
 *   7. MEDICINE_INSTRUCTION: an instruction verb (stop, start, change, increase, reduce, double, skip, adjust, switch, quit ...) followed
 *      within four words by a medicine noun (the feelings-chat medicine nouns, dose and treatment words, the requested name and the
 *      generic name), or such a noun followed by a passive form ("metformin should not be stopped");
 *   8. DIAGNOSIS: "you have", "you may have", "diagnos-", "disorder", "syndrome", "symptoms of", "your condition" ...;
 *   9. CURE_CLAIM: "cure" in any form, or "reverses diabetes".
 * Rules 4–9 apply to both texts (rule 4 also to the generic name). The reasons are closed codes, never text. The lexicons are reviewed and
 * versioned; a change is a new version. The feelings-chat lexicons are read, never changed.
 */
export const MEDICINE_INFO_VALIDATOR_VERSION = "medicine-info-validator.1";

export const MEDICINE_INFO_REJECTION_REASONS = Object.freeze([
  "SCHEMA",
  "TEXT_FORMAT",
  "DIRECTIONS_SENTENCE",
  "DOSE_AMOUNT",
  "FREQUENCY",
  "ADVICE",
  "MEDICINE_INSTRUCTION",
  "DIAGNOSIS",
  "CURE_CLAIM",
] as const);
export type MedicineInfoRejectionReason = (typeof MEDICINE_INFO_REJECTION_REASONS)[number];

export type MedicineInfoValidated = Readonly<{ kind: "OK"; info: MedicineGeneralInfo }> | Readonly<{ kind: "NOT_FOUND" }>;
export type MedicineInfoValidation = Readonly<{ ok: true; value: MedicineInfoValidated }> | Readonly<{ ok: false; reasons: readonly MedicineInfoRejectionReason[] }>;

export const MEDICINE_INFO_TEXT_MIN_CHARS = 20;
export const MEDICINE_INFO_TEXT_MAX_CHARS = 300;
export const MEDICINE_INFO_MAX_SENTENCES = 3;
/** The fixed closing sentence of `howGenerallyTaken` (owner decision 2026-10-14). */
export const MEDICINE_INFO_DIRECTIONS_SENTENCE = "Follow your doctor's or pharmacist's directions.";

// ---------------------------------------------------------------------------------------------------------------------------------
// Reviewed lexicons (medicine-info-validator.1). Every pattern runs on the normalised text: lower case, curly quotes made straight,
// whitespace collapsed.
// ---------------------------------------------------------------------------------------------------------------------------------

const NUMBER = "(?:\\d+(?:[.,]\\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|half|a half|a quarter)";
const AMOUNT_UNIT =
  "(?:mg|mcg|µg|ug|micrograms?|milligrams?|g|grams?|ml|millilit(?:re|er)s?|l|units?|iu|tablets?|tabs?|capsules?|caps?|puffs?|pills?|drops?|sachets?|injections?|doses?|sprays?|patch(?:es)?)";

/** Rule 4: amounts and dose words (the feelings-chat dose lexicon, read-only, plus a number with an amount unit). */
export const AMOUNT_PATTERNS: readonly RegExp[] = Object.freeze([new RegExp(`(?<![\\w.])${NUMBER}\\s*-?\\s*${AMOUNT_UNIT}(?![a-z])`), ...DOSE_PATTERNS]);

/** Rule 5: counted frequencies. */
export const FREQUENCY_PATTERNS: readonly RegExp[] = Object.freeze([
  /\b(?:\d+|one|two|three|four|five|six)\s*(?:x|times?)\s*(?:a|per|each|every)?\s*(?:day|daily|week|weekly|night|month|monthly)\b/,
  /\b(?:once|twice|thrice)\s+(?:(?:a|per|each|every)\s+)?(?:day|daily|week|weekly|night|nightly|month|monthly|morning|evening)\b/,
  /\bevery\s+(?:\d+|one|two|three|four|six|eight|twelve|twenty-four)\s*(?:hours?|hrs?|days?)\b/,
  /\b\d+\s*(?:hours?|hrs?)\s+apart\b/,
]);

/** Rule 6: advice and instructions (the feelings-chat advice lexicon, read-only, plus these). */
export const INSTRUCTION_PATTERNS: readonly RegExp[] = Object.freeze([
  ...ADVICE_PATTERNS,
  /\btry\b/,
  /\b(?:do not|don't|never)\b/,
  /\bavoid(?:s|ed|ing)?\b/,
  /\bplease\b/,
  /\bremember to\b/,
  /\bi (?:would )?(?:recommend|suggest|advise)\b/,
  /(?:^|[.!?]\s+)(?:take|use|inject|swallow|stop|start|keep|store|check|eat|drink|tell|ask|see|call|continue|skip|increase|reduce|adjust|double|switch|change|do|make|remember|be sure|always)\b/,
]);

/** Rule 7: instruction verbs about a medicine. */
const INSTRUCTION_VERBS =
  /\b(?:stop(?:s|ped|ping)?|start(?:s|ed|ing)?|chang(?:e|es|ed|ing)|increas(?:e|es|ed|ing)|reduc(?:e|es|ed|ing)|doubl(?:e|es|ed|ing)|skip(?:s|ped|ping)?|adjust(?:s|ed|ing)?|switch(?:es|ed|ing)?|quit(?:s|ting)?|cut(?:ting)? (?:down|back)|(?:come|coming|came) off|(?:take|taking|took|use|using) (?:more|less|extra|fewer))\b/g;
const PASSIVE_INSTRUCTION = /\b(?:be|been|is|are|being)\s+(?:stopped|started|changed|increased|reduced|doubled|skipped|adjusted|switched)\b/;
const DOSE_NOUNS = /\b(?:doses?|dosage|treatment|therapy|regimen)\b/g;
export const MEDICINE_INSTRUCTION_WINDOW = 4;

/** Rule 8: diagnosis and personal-condition wording. */
export const DIAGNOSIS_PATTERNS: readonly RegExp[] = Object.freeze([
  /\byou (?:have|had|may have|might have|could have|probably have|likely have)\b/,
  /\byou(?:'ve| have) got\b/,
  /\byou(?:'re| are) (?:diabetic|sick|ill)\b/,
  /\bdiagnos\w*/,
  /\bdisorders?\b/,
  /\bsyndrome\b/,
  /\bsounds like\b/,
  /\bsymptoms? of\b/,
  /\byour (?:condition|illness|disease|kidneys?|liver|heart)\b/,
]);

/** Rule 9: cure claims. */
export const CURE_PATTERNS: readonly RegExp[] = Object.freeze([/\bcur(?:e|es|ed|ing|ative)\b/, /\brevers(?:e|es|ed|ing)\s+(?:your\s+|the\s+)?diabetes\b/]);

// ---------------------------------------------------------------------------------------------------------------------------------

const LINE_BREAK = new RegExp(`[\\r\\n${String.fromCharCode(0x2028, 0x2029)}]`);
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const LIST_MARKER = /[•●]|(?:^|\s)\d+[.)]\s|(?:^|\s)[-*]\s/;
const LINK = /https?:|www\.|\.(?:com|sg|org|net|gov)\b/i;

const sentencesOf = (text: string): string[] => text.split(/(?<=[.!?])\s+/).filter((sentence) => sentence.trim().length > 0);
const wordIndexAt = (sentence: string, charIndex: number): number => (sentence.slice(0, charIndex).match(/\S+/g) ?? []).length;
const escape = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Rule 2: one line, 20–300 characters, 1–3 sentences ending in ".", no question, list or link. */
export function medicineInfoTextFormatOk(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < MEDICINE_INFO_TEXT_MIN_CHARS || trimmed.length > MEDICINE_INFO_TEXT_MAX_CHARS) return false;
  if (LINE_BREAK.test(text) || CONTROL.test(text) || LIST_MARKER.test(trimmed) || LINK.test(trimmed) || trimmed.includes("?")) return false;
  if (!trimmed.endsWith(".")) return false;
  const count = sentencesOf(trimmed).length;
  return count >= 1 && count <= MEDICINE_INFO_MAX_SENTENCES;
}

/** The medicine nouns for rule 7: the shared nouns, dose and treatment words, and the words of the requested and generic names. */
function medicineNounPattern(names: readonly string[]): RegExp {
  const words = names.flatMap((name) => normaliseFeelingsText(name).split(/[\s()]+/)).filter((word) => /[a-z]{3,}/.test(word));
  const own = words.length > 0 ? `|\\b(?:${words.map(escape).join("|")})\\b` : "";
  return new RegExp(`${MEDICINE_NOUNS.source}|${DOSE_NOUNS.source}${own}`, "g");
}

function instructionIn(sentence: string, nouns: RegExp): boolean {
  const nounAt = [...sentence.matchAll(nouns)].map((match) => wordIndexAt(sentence, match.index ?? 0));
  if (nounAt.length === 0) return false;
  const verbs = [...sentence.matchAll(INSTRUCTION_VERBS)].map((match) => wordIndexAt(sentence, match.index ?? 0));
  if (verbs.some((verb) => nounAt.some((noun) => noun > verb && noun - verb <= MEDICINE_INSTRUCTION_WINDOW))) return true;
  // "metformin should not be stopped": a medicine noun followed by a passive instruction verb in the same sentence.
  const passive = PASSIVE_INSTRUCTION.exec(sentence);
  return passive !== null && nounAt.some((noun) => noun < wordIndexAt(sentence, passive.index));
}

/** Rules 4–9 over one text: the closed reasons it fails (empty when clean). */
export function medicineInfoContentReasons(text: string, names: readonly string[]): MedicineInfoRejectionReason[] {
  const normalised = normaliseFeelingsText(text);
  const reasons: MedicineInfoRejectionReason[] = [];
  if (AMOUNT_PATTERNS.some((pattern) => pattern.test(normalised))) reasons.push("DOSE_AMOUNT");
  if (FREQUENCY_PATTERNS.some((pattern) => pattern.test(normalised))) reasons.push("FREQUENCY");
  // The fixed closing sentence is the one allowed imperative; it is removed before the advice and instruction checks.
  const withoutClosing = normalised.replace(normaliseFeelingsText(MEDICINE_INFO_DIRECTIONS_SENTENCE), " ").trim();
  if (INSTRUCTION_PATTERNS.some((pattern) => pattern.test(withoutClosing))) reasons.push("ADVICE");
  const nouns = medicineNounPattern(names);
  if (sentencesOf(withoutClosing).some((sentence) => instructionIn(sentence, nouns))) reasons.push("MEDICINE_INSTRUCTION");
  if (DIAGNOSIS_PATTERNS.some((pattern) => pattern.test(normalised))) reasons.push("DIAGNOSIS");
  if (CURE_PATTERNS.some((pattern) => pattern.test(normalised))) reasons.push("CURE_CLAIM");
  return reasons;
}

const endsWithDirections = (text: string) => normaliseFeelingsText(text).endsWith(normaliseFeelingsText(MEDICINE_INFO_DIRECTIONS_SENTENCE));

const reject = (reasons: ReadonlySet<MedicineInfoRejectionReason>): MedicineInfoValidation =>
  Object.freeze({ ok: false as const, reasons: Object.freeze(MEDICINE_INFO_REJECTION_REASONS.filter((reason) => reasons.has(reason))) });

/**
 * Validates one model reply for the request it answers (the request supplies the requested name, which the shown information always
 * carries, and the medicine words of rule 7). Never throws.
 */
export function validateMedicineInfoReply(candidate: unknown, request: Pick<MedicineInfoRequest, "medicineName">): MedicineInfoValidation {
  const parsed = medicineInfoReplySchema.safeParse(candidate);
  if (!parsed.success || !isMedicineInfoName(request?.medicineName)) return reject(new Set(["SCHEMA"]));
  const reply = parsed.data;
  if (reply.kind === "NOT_FOUND") return Object.freeze({ ok: true as const, value: Object.freeze({ kind: "NOT_FOUND" as const }) });
  const name = reply.name?.trim() ?? "";
  const genericName = reply.genericName === null ? null : reply.genericName.trim().replace(/\s+/g, " ");
  if (!isMedicineInfoName(name) || (genericName !== null && !isMedicineInfoName(genericName))) return reject(new Set(["SCHEMA"]));
  const usedFor = reply.usedFor!.trim();
  const howGenerallyTaken = reply.howGenerallyTaken!.trim();

  const reasons = new Set<MedicineInfoRejectionReason>();
  if (!medicineInfoTextFormatOk(reply.usedFor!) || !medicineInfoTextFormatOk(reply.howGenerallyTaken!)) reasons.add("TEXT_FORMAT");
  if (!endsWithDirections(howGenerallyTaken)) reasons.add("DIRECTIONS_SENTENCE");
  const names = [request.medicineName, name, ...(genericName ? [genericName] : [])];
  for (const text of [usedFor, howGenerallyTaken]) for (const reason of medicineInfoContentReasons(text, names)) reasons.add(reason);
  if (genericName !== null && AMOUNT_PATTERNS.some((pattern) => pattern.test(normaliseFeelingsText(genericName)))) reasons.add("DOSE_AMOUNT");
  if (reasons.size > 0) return reject(reasons);

  const info: MedicineGeneralInfo = Object.freeze({
    name: request.medicineName,
    // A generic name that only repeats the requested name adds nothing.
    genericName: genericName !== null && normaliseMedicineInfoName(genericName) !== normaliseMedicineInfoName(request.medicineName) ? genericName : null,
    usedFor,
    howGenerallyTaken,
  });
  return Object.freeze({ ok: true as const, value: Object.freeze({ kind: "OK" as const, info }) });
}

/**
 * The device's check of information it is about to show (a route answer or a cached entry): the shape, the requested name, and every
 * rule of `validateMedicineInfoReply`. Never throws.
 */
export function validateMedicineGeneralInfo(info: unknown, medicineName: string): MedicineInfoValidation {
  const parsed = medicineGeneralInfoSchema.safeParse(info);
  // The same medicine (its normalised name); the shown information then carries the name exactly as she asked for it now.
  if (!parsed.success || normaliseMedicineInfoName(parsed.data.name) !== normaliseMedicineInfoName(medicineName)) return reject(new Set(["SCHEMA"]));
  const result = validateMedicineInfoReply({ kind: "OK", name: parsed.data.name, genericName: parsed.data.genericName, usedFor: parsed.data.usedFor, howGenerallyTaken: parsed.data.howGenerallyTaken }, { medicineName });
  return result.ok && result.value.kind !== "OK" ? reject(new Set(["SCHEMA"])) : result;
}
