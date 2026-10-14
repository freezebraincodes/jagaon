import { isNoteThemeKey, type NoteThemeKey } from "@/domain/notes/note-themes";
import {
  FEELINGS_CHAT_DOCTOR_QUESTION_MAX_CHARS,
  FEELINGS_CHAT_SUMMARY_MAX_CHARS,
  feelingsChatReplySchema,
  isFeelingsChatSafetyStop,
  type FeelingsChatReply,
  type FeelingsChatRequest,
} from "./feelings-chat-contract";

/**
 * Tell JagaOn understands more (design §3.5): the deterministic output validator that guards EVERY AI reply of the feelings chat. Pure;
 * the server route runs it before answering and the browser client runs it again before showing anything. A reply is rejected (and the
 * reviewed bank used instead) when any rule fails:
 *   1. schema: strict JSON matching the contract (unknown fields rejected) with the kind rules;
 *   2. question format: one sentence ending in "?", 3–25 words, no line breaks or lists, not a repeat of an earlier question; and at the
 *      last turn no question at all (TURN_LIMIT: the chat never runs past three turns);
 *   3. no advice; 4. no medicine actions (dose words, or a change verb near a medicine noun); 5. no diagnosis; 6. no glucose causality
 *      (a sugar word in the same sentence as a cause word); rules 3–6 apply to the question, the summary and the doctor question;
 *   7. summary: at most 160 characters, one line;
 *   8. doctor question: first person, ends in "?", at most 200 characters, one line, and reuses at least one content word (4+ letters,
 *      not a stopword) from her own messages;
 *   9. themes only from the allow-list, without repeats.
 * The reasons are closed codes, never text. The lexicons are reviewed and versioned; a change is a new version.
 *
 * Owner decision 2026-10-14 (feelings-chat-validator.2): in a WRAP_UP, when ONLY the drafted doctor question fails (rule 8, or rules
 * 3–6 found in the doctor question alone), the doctor question is dropped (null) and the summary is kept: the result is ok, with the
 * doctor question's closed reasons in `doctorQuestionDropped`. When anything else fails (schema, themes, the summary), the whole reply
 * is rejected as before. The server route and the browser client share this function, so both apply the rule the same way.
 */
export const FEELINGS_CHAT_VALIDATOR_VERSION = "feelings-chat-validator.2";

export const FEELINGS_CHAT_REJECTION_REASONS = Object.freeze([
  "SCHEMA",
  "QUESTION_FORMAT",
  "QUESTION_REPEATED",
  "TURN_LIMIT",
  "ADVICE",
  "MEDICINE_ACTION",
  "DIAGNOSIS",
  "GLUCOSE_CAUSALITY",
  "SUMMARY_FORMAT",
  "DOCTOR_QUESTION_FORMAT",
  "DOCTOR_QUESTION_NOT_OWN_WORDS",
  "THEMES",
] as const);
export type FeelingsChatRejectionReason = (typeof FEELINGS_CHAT_REJECTION_REASONS)[number];

export type ValidatedFeelingsChatReply = Readonly<{
  kind: FeelingsChatReply["kind"];
  question: string | null;
  summary: string | null;
  doctorQuestion: string | null;
  themes: readonly NoteThemeKey[];
  end: boolean;
}>;

/**
 * `doctorQuestionDropped` is present only when the AI's doctor question was dropped from an otherwise valid wrap-up (its closed
 * reasons, never text).
 */
export type FeelingsChatValidation =
  | Readonly<{ ok: true; value: ValidatedFeelingsChatReply; doctorQuestionDropped?: readonly FeelingsChatRejectionReason[] }>
  | Readonly<{ ok: false; reasons: readonly FeelingsChatRejectionReason[] }>;

// ---------------------------------------------------------------------------------------------------------------------------------
// Reviewed lexicons (feelings-chat-validator.1). Every pattern runs on the normalised text: lower case, curly quotes made straight,
// whitespace collapsed.
// ---------------------------------------------------------------------------------------------------------------------------------

/** Rule 3: advice and suggestions (statements of what she should do). */
export const ADVICE_PATTERNS: readonly RegExp[] = Object.freeze([
  /\byou (?:should|must|need to|have to|ought to)\b/,
  /\byou(?:'d| had) better\b/,
  /\b(?:she|he|they) (?:should|must|needs? to|has to|have to|ought to)\b/,
  /\bshould you\b/,
  /\btry to\b/,
  /\btry (?:not to\b|\w+ing\b)/,
  /\bhave you tried\b/,
  /\b(?:could|might|can) (?:you )?try\b/,
  /\bmake sure\b/,
  /\bi(?: would|'d)? (?:recommend|suggest|advise)\b/,
  /\bit(?:'s| is| would be| might be) (?:best|better|important|a good idea|wise) to\b/,
  /\bconsider(?:s|ed|ing)?\b/,
  /\bwhy (?:don't|do not|not|wouldn't) you\b/,
  /\bwhy not\b/,
  /\bhow about (?:you\b|\w+ing\b)/,
  /\bdon't forget to\b/,
  /\bit (?:would|might|may|could|can) help (?:to|if)\b/,
  /\byou (?:can|could) (?:also )?(?:try|ask|take|talk to|speak to|see|call|go|start|stop)\b/,
]);

/** Rule 4a: dose and amount words. */
export const DOSE_PATTERNS: readonly RegExp[] = Object.freeze([
  /\bunits?\b/,
  /\bmg\b/,
  /\b\d+(?:\.\d+)?\s*(?:mg|mcg|ml|iu|u)\b/,
  /\bdos(?:e|es|ed|age|ages|ing)\b/,
  /\bdouble\b/,
  /\bskip(?:ping)? (?:your|my|a|the)\b/,
]);

/** Rule 4b: medicine-change verbs, rejected within MEDICINE_NEAR_WORDS words of a medicine noun (either order, same sentence). */
export const MEDICINE_CHANGE_VERBS =
  /\b(?:stop(?:s|ped|ping)?|start(?:s|ed|ing)?|chang(?:e|es|ed|ing)|increas(?:e|es|ed|ing)|reduc(?:e|es|ed|ing)|cut(?:ting)? (?:down|back)|(?:take|taking|took) (?:more|less|extra|fewer)|lower(?:s|ed|ing)?|rais(?:e|es|ed|ing)|adjust(?:s|ed|ing)?|switch(?:es|ed|ing)?|skip(?:s|ped|ping)?|doubl(?:e|ed|ing)|quit(?:s|ting)?|(?:come|coming|came) off)\b/g;
export const MEDICINE_NOUNS = /\b(?:insulin|medicines?|medications?|meds|tablets?|pills?|injections?|jabs?|drugs?|lantus|apidra|glucotab|metformin)\b/g;
export const MEDICINE_NEAR_WORDS = 6;

/** Rule 5: condition names, labels and diagnostic phrasing. */
export const DIAGNOSIS_PATTERNS: readonly RegExp[] = Object.freeze([
  /\bdepression\b/,
  /\bdepressive\b/,
  /\b(?:you(?:'re| are)|you seem|you sound|sounds|seems?|you (?:may|might|could) be)(?: \w+){0,2} depressed\b/,
  /\banxiety disorders?\b/,
  /\b(?:generali[sz]ed|social) anxiety\b/,
  /\bpanic disorder\b/,
  /\binsomnia\b/,
  /\bhypo-?glyc(?:a)?emi(?:a|c)\b/,
  /\bhyper-?glyc(?:a)?emi(?:a|c)\b/,
  /\bdiabet(?:ic|es) distress\b/,
  /\b(?:you(?:'re| are)|you have|you(?:'ve| have) got|it(?:'s| is)|sounds like|signs of|symptoms of|suffering from|you (?:may|might|could) have)(?: \w+)? burn-?\s?out\b/,
  /\bdisorders?\b/,
  /\bsyndrome\b/,
  /\bptsd\b/,
  /\bocd\b/,
  /\bbipolar\b/,
  /\bmental illness\b/,
  /\bdiagnos(?:e|ed|es|is|ing)\b/,
  /\bclinical(?:ly)?\b/,
  /\bsounds like you have\b/,
  /\byou (?:may|might|could) have\b/,
  /\bsymptoms? of\b/,
]);

/** Rule 6: a glucose word and a cause word in the same sentence. */
export const GLUCOSE_WORDS = /\b(?:sugars?|glucose|readings?|hba1c|a1c)\b/;
export const CAUSE_WORDS = /\b(?:because|caus(?:e|es|ed|ing)|due to|(?:makes?|made|making) your|rais(?:e|es|ed|ing)|lower(?:s|ed|ing)?|linked to|leads? to|led to|result(?:s|ed)? (?:in|from))\b/;

/** Rule 8: first-person markers of her own question. */
const FIRST_PERSON = /\b(?:i|i'm|i've|i'd|i'll|my|me|mine|myself)\b/;

/** Rule 8: words that never count as reused content words (all 4+ letters). */
export const CONTENT_STOPWORDS: ReadonlySet<string> = new Set([
  "about", "after", "again", "also", "always", "anything", "back", "been", "before", "being", "could", "does", "doing", "done", "down",
  "each", "even", "ever", "every", "feel", "feeling", "feelings", "felt", "from", "have", "having", "here", "into", "just", "know", "last",
  "like", "made", "make", "many", "maybe", "might", "more", "most", "much", "must", "never", "nothing", "only", "other", "over", "quite",
  "really", "same", "shall", "should", "since", "some", "something", "still", "such", "than", "that", "their", "them", "then", "there",
  "these", "they", "thing", "things", "think", "this", "those", "through", "today", "very", "want", "week", "well", "were", "what", "when",
  "where", "which", "while", "will", "with", "would", "your", "yours", "doctor", "okay",
]);

// ---------------------------------------------------------------------------------------------------------------------------------

const LINE_BREAK = new RegExp(`[\\r\\n${String.fromCharCode(0x2028, 0x2029)}]`); // CR, LF, U+2028, U+2029 (built from code points: plain-ASCII source)
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const LIST_MARKER = /[•●]|(?:^|\s)\d+[.)]\s|(?:^|\s)[-*]\s/;

export function normaliseFeelingsText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

const sentencesOf = (normalised: string): string[] => normalised.split(/(?<=[.!?])\s+/).filter((sentence) => sentence.length > 0);
const wordIndexAt = (sentence: string, charIndex: number): number => (sentence.slice(0, charIndex).match(/\S+/g) ?? []).length;

function medicineActionIn(sentence: string): boolean {
  const verbs = [...sentence.matchAll(MEDICINE_CHANGE_VERBS)].map((match) => wordIndexAt(sentence, match.index ?? 0));
  if (verbs.length === 0) return false;
  const nouns = [...sentence.matchAll(MEDICINE_NOUNS)].map((match) => wordIndexAt(sentence, match.index ?? 0));
  return verbs.some((verb) => nouns.some((noun) => Math.abs(verb - noun) <= MEDICINE_NEAR_WORDS));
}

/** Rules 3–6 over one text: the closed reasons it fails (empty when clean). */
export function contentReasons(text: string): FeelingsChatRejectionReason[] {
  const normalised = normaliseFeelingsText(text);
  const reasons: FeelingsChatRejectionReason[] = [];
  if (ADVICE_PATTERNS.some((pattern) => pattern.test(normalised))) reasons.push("ADVICE");
  const sentences = sentencesOf(normalised);
  if (DOSE_PATTERNS.some((pattern) => pattern.test(normalised)) || sentences.some(medicineActionIn)) reasons.push("MEDICINE_ACTION");
  if (DIAGNOSIS_PATTERNS.some((pattern) => pattern.test(normalised))) reasons.push("DIAGNOSIS");
  if (sentences.some((sentence) => GLUCOSE_WORDS.test(sentence) && CAUSE_WORDS.test(sentence))) reasons.push("GLUCOSE_CAUSALITY");
  return reasons;
}

const wordsOf = (text: string): string[] => text.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word));

/** Rule 2: exactly one sentence ending in "?", 3–25 words, one line, no list. */
export function questionFormatOk(question: string): boolean {
  const trimmed = question.trim();
  if (trimmed.length === 0 || LINE_BREAK.test(question) || CONTROL.test(question) || LIST_MARKER.test(trimmed)) return false;
  if (!trimmed.endsWith("?") || (trimmed.match(/\?/g) ?? []).length !== 1) return false;
  // Another sentence before the question ("That sounds hard. What happened?") is a statement: statements come from the bank only.
  if (/[.!;](?:\s|$)/.test(trimmed.slice(0, -1))) return false;
  const count = wordsOf(trimmed).length;
  return count >= 3 && count <= 25;
}

const stem = (word: string): string => {
  for (const suffix of ["ing", "ed", "es", "ly", "s"]) if (word.endsWith(suffix) && word.length - suffix.length >= 3) return word.slice(0, -suffix.length);
  return word;
};

/** Her content words (4+ letters, not stopwords), stemmed. */
export function contentWordsOf(text: string): Set<string> {
  const words = normaliseFeelingsText(text).match(/[a-z]+(?:'[a-z]+)*/g) ?? [];
  return new Set(words.filter((word) => word.length >= 4 && !CONTENT_STOPWORDS.has(word)).map(stem));
}

/** Rule 8 (own words): the doctor question reuses at least one of her content words. */
export function reusesPatientWords(doctorQuestion: string, patientTexts: readonly string[]): boolean {
  const hers = new Set(patientTexts.flatMap((text) => [...contentWordsOf(text)]));
  return [...contentWordsOf(doctorQuestion)].some((word) => hers.has(word));
}

function doctorQuestionFormatOk(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > FEELINGS_CHAT_DOCTOR_QUESTION_MAX_CHARS || LINE_BREAK.test(text) || CONTROL.test(text)) return false;
  return trimmed.endsWith("?") && FIRST_PERSON.test(normaliseFeelingsText(trimmed));
}

function summaryFormatOk(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed.length <= FEELINGS_CHAT_SUMMARY_MAX_CHARS && !LINE_BREAK.test(text) && !CONTROL.test(text);
}

/**
 * Validates one model reply against the request it answers (the request supplies her words for rule 8, the earlier questions for the
 * no-repeat rule and the turn for TURN_LIMIT). Never throws.
 */
export function validateFeelingsChatReply(candidate: unknown, request: FeelingsChatRequest): FeelingsChatValidation {
  const parsed = feelingsChatReplySchema.safeParse(candidate);
  if (!parsed.success) return Object.freeze({ ok: false as const, reasons: Object.freeze(["SCHEMA" as const]) });
  const reply = parsed.data;
  const reasons = new Set<FeelingsChatRejectionReason>();
  // The doctor question's own failures, kept apart: alone they drop the doctor question, never the wrap-up.
  const doctorReasons = new Set<FeelingsChatRejectionReason>();

  const themesOk = reply.themes.every(isNoteThemeKey) && new Set(reply.themes).size === reply.themes.length;
  if (!themesOk) reasons.add("THEMES");

  if (!isFeelingsChatSafetyStop(reply)) {
    if (reply.question !== null) {
      if (!questionFormatOk(reply.question)) reasons.add("QUESTION_FORMAT");
      const earlier = request.messages.filter((message) => message.role === "jagaon_question").map((message) => normaliseFeelingsText(message.text));
      if (earlier.includes(normaliseFeelingsText(reply.question))) reasons.add("QUESTION_REPEATED");
      if (request.turn >= request.maxTurns) reasons.add("TURN_LIMIT");
      for (const reason of contentReasons(reply.question)) reasons.add(reason);
    }
    if (reply.summary !== null) {
      if (!summaryFormatOk(reply.summary)) reasons.add("SUMMARY_FORMAT");
      for (const reason of contentReasons(reply.summary)) reasons.add(reason);
    }
    if (reply.doctorQuestion !== null) {
      if (!doctorQuestionFormatOk(reply.doctorQuestion)) doctorReasons.add("DOCTOR_QUESTION_FORMAT");
      const hers = request.messages.filter((message) => message.role === "patient").map((message) => message.text);
      if (!reusesPatientWords(reply.doctorQuestion, hers)) doctorReasons.add("DOCTOR_QUESTION_NOT_OWN_WORDS");
      for (const reason of contentReasons(reply.doctorQuestion)) doctorReasons.add(reason);
    }
  }

  const ordered = (set: ReadonlySet<FeelingsChatRejectionReason>) => Object.freeze(FEELINGS_CHAT_REJECTION_REASONS.filter((reason) => set.has(reason)));
  if (reasons.size > 0) return Object.freeze({ ok: false as const, reasons: ordered(new Set([...reasons, ...doctorReasons])) });
  // Owner decision 2026-10-14: only the doctor question failed (a WRAP_UP whose summary passed): drop it, keep the summary.
  const dropDoctorQuestion = doctorReasons.size > 0;
  const value: ValidatedFeelingsChatReply = Object.freeze({
    kind: reply.kind,
    question: reply.question?.trim() ?? null,
    summary: reply.summary?.trim() ?? null,
    doctorQuestion: dropDoctorQuestion ? null : (reply.doctorQuestion?.trim() ?? null),
    themes: Object.freeze(reply.themes.filter(isNoteThemeKey)),
    end: reply.end,
  });
  return dropDoctorQuestion ? Object.freeze({ ok: true as const, value, doctorQuestionDropped: ordered(doctorReasons) }) : Object.freeze({ ok: true as const, value });
}
