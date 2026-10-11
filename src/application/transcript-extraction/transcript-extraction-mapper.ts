import { VOICE_AMBIGUITY_REASONS, VOICE_MAX_CANDIDATES, VOICE_SOURCE_PHRASE_MAX_CODE_POINTS, candidateMatchesTranscript, codePointLength, voiceCandidateSchema, type VoiceAmbiguityReason, type VoiceCandidate, type VoiceLanguage, type VoiceMealSlot } from "@/domain/voice/voice-contracts";
import { voiceWordMatcher } from "@/domain/voice/voice-advice-redirect";
import { VOICE_COUNTERFACTUAL_CUES, voiceVocabulary } from "@/domain/voice/voice-vocabulary";
import { TRANSCRIPT_EXTRACTION_CONTRACT_VERSION, type ExtractionFact, type ExtractionOutput, type TranscriptExtractionLocale } from "@/domain/transcript-extraction/transcript-extraction-contract";
import { isMmolEntryValue } from "@/domain/voice/glucose-entry-format";
import { hasCounterfactualCue, hasNegationCue, spokenNumbers } from "@/domain/transcript-extraction/transcript-extraction-lexicon";

/** Review minor: the canonical decimal text (no leading zeros in the integer part: "06.80" → "6.80"), never the raw model string. */
const canonicalValue = (value: string) => value.replace(/^0+(?=\d)/, "");

/**
 * Packet 13 (P13X): validated extraction output → the voice slice's frozen `VoiceCandidate` union (voice-contract.13s.3). Pure.
 *
 * Every candidate is `source: "REMOTE_EXTRACTION"`, `producerVersion: "transcript-extraction.13.1"`, and passes `voiceCandidateSchema`
 * and `candidateMatchesTranscript`; any failure makes the whole mapping UNMAPPABLE (the caller falls back to the deterministic
 * extractor). The mapping is never less cautious than the deterministic extractor: the ambiguity reasons the extraction contract does
 * not model (CORRECTION, OTHER_PERSON, MULTIPLE_NUMBERS) and the voice slice's broader uncertainty and status-unknown cues are derived
 * locally from the span's words with the voice slice's own vocabulary (read-only), and only ever ADD caution:
 * - GLUCOSE_READING: `valueText`, unit MMOL_PER_L with `unitSource: SPOKEN` only when spoken, else UNSTATED/null (+UNIT_UNSTATED). Never
 *   APP_DEFAULT (the default unit is applied locally only). A mg/dL reading or a value outside the voice format (CR-11: 1–4 integer
 *   digits, at most one decimal) becomes UNSUPPORTED_SPAN.
 * - MEAL_NOTE: the meal `slot` only when exactly one slot word is in the span; `itemText` null (the contract does not isolate food words).
 * - MEDICATION_OCCURRENCE: the status (UNKNOWN when a voice status-unknown cue such as "forgot" is in the span), `medicineRef` ALWAYS
 *   UNRESOLVED with the verbatim description (else the span's words); mapping to a medicine is local. 13s.3: a spoken amount fills
 *   `reportedAmount` (the validated value and the unit words exactly as they appear in the span); an amount whose unit words are not in
 *   the span becomes UNSUPPORTED_SPAN rather than being lost or invented.
 * - unsupported spans → UNSUPPORTED_SPAN. Ordered by span.
 */
export const REMOTE_EXTRACTION_SOURCE = "REMOTE_EXTRACTION";
export const REMOTE_EXTRACTION_PRODUCER_VERSION = TRANSCRIPT_EXTRACTION_CONTRACT_VERSION;

export type VoiceMapping =
  | Readonly<{ kind: "MAPPED"; candidates: readonly VoiceCandidate[]; downgraded: number }>
  | Readonly<{ kind: "UNMAPPABLE"; reason: "PHRASE_TOO_LONG" | "TOO_MANY_CANDIDATES" | "VOICE_SCHEMA" | "SPAN_MISMATCH" }>;


function cues(language: VoiceLanguage) {
  const vocabulary = voiceVocabulary(language);
  return Object.freeze({
    otherPerson: voiceWordMatcher(vocabulary.otherPersonCues, language),
    correction: voiceWordMatcher(vocabulary.correctionCues, language),
    uncertainty: voiceWordMatcher(vocabulary.uncertaintyCues, language),
    negation: voiceWordMatcher(vocabulary.negationCues, language),
    statusUnknown: voiceWordMatcher(vocabulary.statusUnknown, language),
    counterfactual: voiceWordMatcher(VOICE_COUNTERFACTUAL_CUES[language], language),
    amountUnit: voiceWordMatcher(vocabulary.amountUnits, language),
    slots: (Object.entries(vocabulary.mealSlots) as [Exclude<VoiceMealSlot, "UNSTATED">, readonly string[]][]).map(([slot, words]) => [slot, voiceWordMatcher(words, language)] as const),
  });
}
const CUES = Object.freeze({ en: cues("en"), zh: cues("zh") });

function ordered(reasons: Iterable<VoiceAmbiguityReason>): VoiceAmbiguityReason[] {
  const set = new Set(reasons);
  return VOICE_AMBIGUITY_REASONS.filter((reason) => set.has(reason));
}

type Built = Readonly<{ candidate: Record<string, unknown>; downgraded: boolean }>;

function mapFact(fact: ExtractionFact, language: VoiceLanguage): Built {
  const c = CUES[language];
  const text = fact.sourceSpan.text;
  const base = { span: { start: fact.sourceSpan.start, end: fact.sourceSpan.end }, sourcePhrase: text, source: REMOTE_EXTRACTION_SOURCE, producerVersion: REMOTE_EXTRACTION_PRODUCER_VERSION };
  const unsupported: Built = { candidate: { kind: "UNSUPPORTED_SPAN", ...base }, downgraded: true };
  const shared = new Set<VoiceAmbiguityReason>();
  // Review CRITICAL 1: the voice cues AND the extraction lexicon (every contracted negation, straight or curly apostrophe) both count.
  if (fact.negated || c.negation.test(text) || hasNegationCue(text) || (language === "en" && /n['’]t(?![A-Za-z])/i.test(text))) shared.add("NEGATION");
  if (fact.uncertain || c.uncertainty.test(text)) shared.add("UNCERTAINTY");
  if (c.correction.test(text)) shared.add("CORRECTION");
  if (c.otherPerson.test(text)) shared.add("OTHER_PERSON");
  const fact_ = (kind: string, reasons: Set<VoiceAmbiguityReason>, fields: Record<string, unknown>): Built => {
    const ambiguity = ordered(reasons);
    return { candidate: { kind, ...base, state: ambiguity.length === 0 ? "UNDERSTOOD" : "AMBIGUOUS", ambiguity, ...fields }, downgraded: false };
  };

  if (fact.kind === "GLUCOSE_READING") {
    // CR-11 (owner R-6; the feature stays off): the same new-entry format as the voice slice (1–4 integer digits, at most one decimal);
    // "6.80" or "9.25" is never shortened or rounded: it becomes UNSUPPORTED_SPAN.
    if (fact.unit === "MG_PER_DL" || fact.value === null || !isMmolEntryValue(canonicalValue(fact.value))) return unsupported;
    const reasons = new Set(shared);
    if (fact.unit === null) reasons.add("UNIT_UNSTATED");
    if (new Set(spokenNumbers(text)).size > 1) reasons.add("MULTIPLE_NUMBERS");
    return fact_("GLUCOSE_READING", reasons, { valueText: canonicalValue(fact.value), unit: fact.unit === "MMOL_PER_L" ? "MMOL_PER_L" : "UNSTATED", unitSource: fact.unit === "MMOL_PER_L" ? "SPOKEN" : null });
  }
  if (fact.kind === "MEAL_OR_FOOD_NOTE") {
    const slots = c.slots.filter(([, matcher]) => matcher.test(text)).map(([slot]) => slot);
    return fact_("MEAL_NOTE", new Set(shared), { slot: slots.length === 1 ? slots[0] : "UNSTATED", itemText: null });
  }
  // 13s.3 (owner #4): a REPORTED amount is kept exactly as spoken, only when the span says both the number (validated by the r-rules)
  // and its unit words; anything else with an amount is shown as not understood rather than losing it.
  let reportedAmount: { valueText: string; unitText: string } | null = null;
  if (fact.value !== null || fact.unit !== null) {
    const unitText = fact.value !== null && fact.unit !== null ? c.amountUnit.exec(text)?.[0] ?? null : null;
    if (unitText === null || !/^\d{1,4}(?:\.\d{1,2})?$/.test(fact.value!)) return unsupported;
    reportedAmount = { valueText: canonicalValue(fact.value!), unitText };
  }
  const phrase = fact.unresolvedPhrase ?? (codePointLength(text) <= 64 ? text : null);
  if (phrase === null || codePointLength(phrase) > 64 || phrase.trim().length === 0) return unsupported;
  // Review CRITICAL 1 (defence in depth; the validator already rejects TAKEN with a negation): a negated span is never TAKEN here.
  // Recheck 6 (CRITICAL A): nor is a counterfactual span ("I'd have taken", 本来会打).
  const status = fact.status === null || c.statusUnknown.test(text) || (fact.status === "TAKEN" && (shared.has("NEGATION") || hasCounterfactualCue(text) || c.counterfactual.test(text))) ? "UNKNOWN" : fact.status;
  const reasons = new Set(shared);
  reasons.add("MEDICINE_UNRESOLVED");
  if (status === "UNKNOWN") reasons.add("STATUS_UNCLEAR");
  return fact_("MEDICATION_OCCURRENCE", reasons, { status, medicineRef: { kind: "UNRESOLVED", phrase }, reportedAmount });
}

/** Maps an ACCEPTED (validated) output for its own transcript. Callers must never pass an unvalidated model output. */
export function mapToVoiceCandidates(output: ExtractionOutput, transcript: string, locale: TranscriptExtractionLocale): VoiceMapping {
  const language: VoiceLanguage = locale === "zh-SG" ? "zh" : "en";
  const built: Built[] = [
    ...output.facts.map((fact) => mapFact(fact, language)),
    ...output.unsupportedSpans.map((span): Built => ({
      candidate: { kind: "UNSUPPORTED_SPAN", span: { start: span.start, end: span.end }, sourcePhrase: span.text, source: REMOTE_EXTRACTION_SOURCE, producerVersion: REMOTE_EXTRACTION_PRODUCER_VERSION },
      downgraded: false,
    })),
  ];
  if (built.length > VOICE_MAX_CANDIDATES) return Object.freeze({ kind: "UNMAPPABLE", reason: "TOO_MANY_CANDIDATES" });
  const candidates: VoiceCandidate[] = [];
  for (const { candidate } of built) {
    if (codePointLength(String(candidate.sourcePhrase)) > VOICE_SOURCE_PHRASE_MAX_CODE_POINTS) return Object.freeze({ kind: "UNMAPPABLE", reason: "PHRASE_TOO_LONG" });
    const parsed = voiceCandidateSchema.safeParse(candidate);
    if (!parsed.success) return Object.freeze({ kind: "UNMAPPABLE", reason: "VOICE_SCHEMA" });
    if (!candidateMatchesTranscript(parsed.data, transcript)) return Object.freeze({ kind: "UNMAPPABLE", reason: "SPAN_MISMATCH" });
    candidates.push(parsed.data);
  }
  candidates.sort((a, b) => a.span.start - b.span.start || a.span.end - b.span.end);
  return Object.freeze({ kind: "MAPPED", candidates: Object.freeze(candidates), downgraded: built.filter((entry) => entry.downgraded).length });
}
