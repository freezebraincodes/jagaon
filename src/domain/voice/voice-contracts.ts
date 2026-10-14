import { z } from "zod";
import { MMOL_CONFIRMATION_TRIGGER, isMmolEntryValue, mmolEntryNeedsConfirmation } from "./glucose-entry-format";
import { VOICE_ACTIVITY_CATEGORIES, VOICE_ACTIVITY_MAX_MINUTES } from "./voice-activity-cues";
import { VOICE_DISTRESS_CUES_VERSION, VOICE_DISTRESS_CUE_KEYS } from "./voice-distress-gate";
import { isVoiceMedicineInfoName } from "./voice-medicine-info-cues";
import { VOICE_VOCABULARY_VERSION } from "./voice-vocabulary";

/**
 * Packet 13 (P13S, owner scope expansion 2026-10-09): the closed voice candidate and analysis contracts, `voice-contract.13s.7`
 * (13s.3, 13s.4, 13s.5, 13s.6 and 13s.7 changes are listed below the version constants).
 * FROZEN INTERFACE: stream 1 maps its validated remote transcript extraction into THIS union (`source: "REMOTE_EXTRACTION"`); the
 * deterministic extractor produces `source: "DETERMINISTIC"`. Change only by a coordinated version bump.
 *
 * One utterance yields several separate facts. Each candidate:
 * - carries the code-point `span` and the exact `sourcePhrase` of the transcript (`candidateMatchesTranscript` checks both), its
 *   `source` and the producer's version label;
 * - preserves what was said and nothing more: numbers, units, negation, uncertainty and occurrence status are kept; no medicine is
 *   inferred from a colour or a description, and no dose, unit or time that was not said is ever added (the only amount is a
 *   medicine occurrence's `reportedAmount`, filled only from the person's own spoken words);
 * - is `UNDERSTOOD` only with no ambiguity reason; otherwise `AMBIGUOUS`, listing every reason in the fixed order;
 * - has no record id of its own, committed state, advice, clinical class or free-text field (every schema is strict). The only
 *   reference is a MAPPED medicine: an existing canonical MEDICATION record revision, reached by remembered terminology or by an exact
 *   name match, never by a guess.
 *
 * Kinds:
 * - GLUCOSE_READING: `valueText` (decimal string, the spoken number) and `unit` with `unitSource`: SPOKEN when the person said mmol;
 *   APP_DEFAULT only for an otherwise unambiguous, positively stated reading of the current person, when the caller passes the app's
 *   effective glucose ENTRY unit (owner default-unit boundary; shown as "unit from the app setting", never as spoken); else UNSTATED
 *   with `unitSource: null`. A default never clears another reason, never overrides a spoken unit and never converts a unit.
 * - MEAL_NOTE: the standard meal `slot` when said (else UNSTATED) and the exact food words `itemText` when said (else null).
 * - MEDICATION_OCCURRENCE: `status` PLANNED ("I need to inject": never taken) | TAKEN | SKIPPED | UNKNOWN ("forgot", "remembered later",
 *   "not sure"), `medicineRef`: UNRESOLVED with the spoken phrase, or MAPPED (canonical record ref, via TERMINOLOGY | EXACT_NAME),
 *   and `reportedAmount` (13s.3): the amount the person reported ("I injected 10 units"), exactly as spoken, or null.
 * - FEELING_NOTE (13s.6): how she said she feels, `cueKeys` (the recognised cue keys, `voice-feeling-cues.1`) and `text` (her own
 *   words, trimmed). DETERMINISTIC only; no state, no ambiguity (it is saved, edited or skipped as her note, never as a health fact).
 * - ACTIVITY_NOTE (13s.6): an activity she reported, `category` (the activity-event categories), `label` (her own words) and
 *   `durationMinutes` (only when said; 1–1440) or null. DETERMINISTIC only; no state, no ambiguity.
 * - MEDICINE_INFO_REQUEST (13s.7): she asked for general information about one named medicine ("Tell me about my Metformin"),
 *   `name` (her words for it). DETERMINISTIC only; no state, no ambiguity; never a fact and never saved.
 * - UNSUPPORTED_SPAN: a part of the utterance that is not understood (shown as such, never dropped, never interpreted).
 */
export const VOICE_CONTRACT_VERSION = "voice-contract.13s.7";
export const VOICE_EXTRACTOR_VERSION = "voice-extractor.13s.7";
/*
 * voice-contract.13s.3 (owner decisions 2026-10-09 ~14:55, #2–#4; safety re-review fixes):
 * - MEDICATION_OCCURRENCE gains `reportedAmount: { valueText, unitText } | null`: an amount the person REPORTED for an occurrence
 *   ("I injected 10 units"), kept exactly as spoken (valueText the spoken number as a decimal, unitText the spoken unit words). It is
 *   never advice and never a recommendation; null when no amount was said.
 * - The redirect carries a `category`: DOSE_TREATMENT (copy `voice.redirect.body`) or HEALTH_QUESTION (copy `voice.redirect.healthBody`),
 *   in the REDIRECT result and in the notice beside separated facts.
 * - (superseded by 13s.4) VOICE_GLUCOSE_MMOL_PER_L_RANGE (0 < value ≤ 50): an APP_DEFAULT unit only inside it; the review refused a
 *   value outside it.
 * voice-contract.13s.4 (CR-11, owner decisions 2026-10-11, design v3.1):
 * - GLUCOSE_READING `valueText` uses the shared new-entry format (`glucose-entry-format`): 1–4 integer digits, no leading zero except
 *   "0", at most ONE decimal digit. A value with more decimals ("9.25", "60.00") is never a candidate value (never rounded).
 * - 50 is no longer a save limit. The app-default window (0 < value ≤ 50) only bounds where the app may ASSUME mmol/L; outside it the
 *   unit must be said or explicitly confirmed ("Yes, mmol/L"). A value above 50, or zero, needs explicit confirmation before saving
 *   (`glucoseNeedsConfirmation`); the review contract enforces it.
 * voice-contract.13s.5 (owner decision 2026-10-14, distress safety):
 * - The analysis gains a DISTRESS result: the deterministic distress gate (`voice-distress-gate`, `voice-distress-cues.1`) runs before
 *   everything else; on a match the result has ZERO candidates, no redirect and no transcript, only the matched `cueKey` and the cue
 *   list version. The app then shows only the safety message with helplines; nothing is saved and nothing goes to remote extraction.
 * voice-contract.13s.6 (owner decision 2026-10-14, Tell JagaOn understands more, design §2–§4):
 * - Two new kinds, FEELING_NOTE and ACTIVITY_NOTE, produced ONLY by the deterministic extractor (`voice-feeling-cues.1`,
 *   `voice-activity-cues.1`). A REMOTE_EXTRACTION candidate of either kind is invalid (`DETERMINISTIC_ONLY_KIND`), so remote extraction
 *   can never add or alter one. Neither carries a state or ambiguity reasons. The distress gate still runs before both.
 * voice-contract.13s.7 (owner decision 2026-10-14, HSA preview "Tell me about my medicine"):
 * - A new kind, MEDICINE_INFO_REQUEST { name }, produced ONLY by the deterministic extractor (`voice-medicine-info-cues.1`) and only
 *   when the caller asks for it (HSA-bounded mode off); a REMOTE_EXTRACTION candidate of this kind is invalid
 *   (`DETERMINISTIC_ONLY_KIND`). It is never a fact: the review contract refuses to save it (NOT_A_FACT) and the app never sends a
 *   transcript holding one to remote extraction. The distress gate and the dose/treatment redirect still run first.
 */
export { VOICE_VOCABULARY_VERSION };
/** 13s.4 (CR-11): the shared new-entry value format, re-exported so the pure extractor depends only on its own contract module. */
export { isMmolEntryValue };

export const VOICE_TRANSCRIPT_MAX_CODE_POINTS = 1_200;
/** At most this many candidates (facts and unsupported spans together); `truncated` beyond. */
export const VOICE_MAX_CANDIDATES = 12;
export const VOICE_SOURCE_PHRASE_MAX_CODE_POINTS = 160;

export const VOICE_LANGUAGES = ["en", "zh"] as const;
export const voiceLanguageSchema = z.enum(VOICE_LANGUAGES);
export type VoiceLanguage = z.infer<typeof voiceLanguageSchema>;

export const VOICE_CANDIDATE_SOURCES = ["DETERMINISTIC", "REMOTE_EXTRACTION"] as const;
export type VoiceCandidateSource = (typeof VOICE_CANDIDATE_SOURCES)[number];

export const VOICE_GLUCOSE_UNITS = ["MMOL_PER_L", "UNSTATED"] as const;
export type VoiceGlucoseUnit = (typeof VOICE_GLUCOSE_UNITS)[number];
export const VOICE_MEAL_SLOTS = ["BREAKFAST", "LUNCH", "DINNER", "SUPPER", "UNSTATED"] as const;
export type VoiceMealSlot = (typeof VOICE_MEAL_SLOTS)[number];
export const VOICE_OCCURRENCE_STATUSES = ["PLANNED", "TAKEN", "SKIPPED", "UNKNOWN"] as const;
export type VoiceOccurrenceStatus = (typeof VOICE_OCCURRENCE_STATUSES)[number];

/** Every reason a fact is AMBIGUOUS, in this fixed order (each kind allows a subset; see ALLOWED_REASONS). */
export const VOICE_AMBIGUITY_REASONS = ["UNIT_UNSTATED", "NEGATION", "UNCERTAINTY", "CORRECTION", "OTHER_PERSON", "MULTIPLE_NUMBERS", "MEDICINE_UNRESOLVED", "STATUS_UNCLEAR"] as const;
/**
 * The only reasons the person may resolve in review by answering a targeted question (a unit, a medicine pick, an occurrence
 * status). Every other reason (negation, uncertainty, correction, another person, several numbers) needs an explicit edit of the fact
 * or manual entry (review C3).
 */
export const VOICE_PERSON_RESOLVABLE_REASONS = ["UNIT_UNSTATED", "MEDICINE_UNRESOLVED", "STATUS_UNCLEAR"] as const satisfies readonly (typeof VOICE_AMBIGUITY_REASONS)[number][];
export type VoiceAmbiguityReason = (typeof VOICE_AMBIGUITY_REASONS)[number];

/** The fixed copy keys of the neutral redirect: dose/treatment wording, health-assessment wording (owner #3), and the shared note. */
export const VOICE_REDIRECT_MESSAGE_KEY = "voice.redirect.body";
export const VOICE_REDIRECT_HEALTH_MESSAGE_KEY = "voice.redirect.healthBody";
export const VOICE_REDIRECT_TRANSCRIBED_NOTE_KEY = "voice.redirect.transcribedNote";
export const VOICE_REDIRECT_CATEGORIES = ["DOSE_TREATMENT", "HEALTH_QUESTION"] as const;
export type VoiceRedirectCategory = (typeof VOICE_REDIRECT_CATEGORIES)[number];
export const voiceRedirectMessageKey = (category: VoiceRedirectCategory) => (category === "HEALTH_QUESTION" ? VOICE_REDIRECT_HEALTH_MESSAGE_KEY : VOICE_REDIRECT_MESSAGE_KEY);

/**
 * 13s.4 (CR-11): the window in which the app may ASSUME mmol/L for a reading whose unit was not said (APP_DEFAULT): 0 < value ≤ 50.
 * It is NOT a save limit: outside it the person states or explicitly confirms the unit ("Yes, mmol/L"). Never a clinical range.
 */
export const VOICE_GLUCOSE_APP_DEFAULT_WINDOW = Object.freeze({ exclusiveMinimum: 0, maximum: MMOL_CONFIRMATION_TRIGGER });
export function glucoseValueInAppDefaultWindow(valueText: string): boolean {
  if (!isMmolEntryValue(valueText)) return false;
  const value = Number(valueText);
  return value > VOICE_GLUCOSE_APP_DEFAULT_WINDOW.exclusiveMinimum && value <= VOICE_GLUCOSE_APP_DEFAULT_WINDOW.maximum;
}
/** 13s.4 (CR-11): a reading above 50 mmol/L, or zero, is saved only after the person's explicit "Save as shown" (a trigger, not a limit). */
export function glucoseNeedsConfirmation(valueText: string): boolean {
  return mmolEntryNeedsConfirmation(valueText);
}
/**
 * CR-11 round 5 (owner decision 2026-10-11, revised B): the hedge words and symbols the extractor drops so only the number is offered
 * ("about 7.8" → 7.8): EN about, around, approximately, roughly; ZH 大约, 大概, 差不多 and 左右 (after the number); the symbols ~ ≈ ～ ∼. Round 8
 * (owner decision 2026-10-11): "=" is not a hedge; before a number it gives no value (like "＝").
 * A reading whose phrase carries one is ALWAYS confirmed through the panel (a latched trigger like above 50 and zero) and never gets
 * the app-default unit. It logs the number the person confirms; it claims no exact or verified measurement. Other hedges are unchanged.
 */
export const GLUCOSE_HEDGE_MARKS = /(?<![A-Za-z])(?:about|around|approximately|roughly)(?![A-Za-z])|[~≈～∼]|大约|大概|差不多|左右/iu;
export function glucoseHedgeMarked(sourcePhrase: string): boolean {
  return GLUCOSE_HEDGE_MARKS.test(sourcePhrase);
}

export const codePointLength = (text: string): number => [...text].length;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** A producer version label: the vocabulary version for DETERMINISTIC, the extraction contract version for REMOTE_EXTRACTION. */
const PRODUCER_VERSION = /^[a-z0-9][a-z0-9.-]{0,63}$/;

export const voiceSpanSchema = z
  .object({
    start: z.number().int().min(0).max(VOICE_TRANSCRIPT_MAX_CODE_POINTS - 1),
    end: z.number().int().min(1).max(VOICE_TRANSCRIPT_MAX_CODE_POINTS),
  })
  .strict()
  .refine((span) => span.end > span.start, { message: "SPAN_EMPTY" });
export type VoiceSpan = z.infer<typeof voiceSpanSchema>;

const phraseSchema = (max: number) =>
  z
    .string()
    .min(1)
    .refine((phrase) => phrase.trim().length > 0 && codePointLength(phrase) <= max, { message: "PHRASE_INVALID" });

/** An existing canonical MEDICATION record revision (structurally the journal's TypedRevisionRef<"MEDICATION">). */
export const voiceMedicationRefSchema = z
  .object({ recordType: z.literal("MEDICATION"), recordId: z.string().regex(UUID_V4), revisionId: z.string().regex(UUID_V4) })
  .strict();
export type VoiceMedicationRef = z.infer<typeof voiceMedicationRefSchema>;

export const voiceMedicineRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("UNRESOLVED"), phrase: phraseSchema(64) }).strict(),
  z.object({ kind: z.literal("MAPPED"), phrase: phraseSchema(64), medication: voiceMedicationRefSchema, via: z.enum(["TERMINOLOGY", "EXACT_NAME"]) }).strict(),
]);
export type VoiceMedicineRef = z.infer<typeof voiceMedicineRefSchema>;

const base = {
  span: voiceSpanSchema,
  sourcePhrase: phraseSchema(VOICE_SOURCE_PHRASE_MAX_CODE_POINTS),
  source: z.enum(VOICE_CANDIDATE_SOURCES),
  producerVersion: z.string().regex(PRODUCER_VERSION),
};
const factBase = { ...base, state: z.enum(["UNDERSTOOD", "AMBIGUOUS"]), ambiguity: z.array(z.enum(VOICE_AMBIGUITY_REASONS)).max(VOICE_AMBIGUITY_REASONS.length) };

export const VOICE_UNIT_SOURCES = ["SPOKEN", "APP_DEFAULT"] as const;
const glucoseSchema = z.object({ kind: z.literal("GLUCOSE_READING"), ...factBase, valueText: z.string().refine(isMmolEntryValue, { message: "VALUE_FORMAT" }), unit: z.enum(VOICE_GLUCOSE_UNITS), unitSource: z.enum(VOICE_UNIT_SOURCES).nullable() }).strict();
const mealSchema = z.object({ kind: z.literal("MEAL_NOTE"), ...factBase, slot: z.enum(VOICE_MEAL_SLOTS), itemText: phraseSchema(120).nullable() }).strict();
/** An amount the person reported for an occurrence, exactly as spoken (13s.3). Never advice. */
export const voiceReportedAmountSchema = z.object({ valueText: z.string().regex(/^\d{1,4}(?:\.\d{1,2})?$/), unitText: phraseSchema(24) }).strict();
export type VoiceReportedAmount = z.infer<typeof voiceReportedAmountSchema>;
const medicationSchema = z
  .object({ kind: z.literal("MEDICATION_OCCURRENCE"), ...factBase, status: z.enum(VOICE_OCCURRENCE_STATUSES), medicineRef: voiceMedicineRefSchema, reportedAmount: voiceReportedAmountSchema.nullable() })
  .strict();
const unsupportedSchema = z.object({ kind: z.literal("UNSUPPORTED_SPAN"), ...base }).strict();

/** 13s.6: her own words for a feeling note or an activity label: trimmed, not empty, at most `max` code points. */
const ownWordsSchema = (max: number) => z.string().min(1).refine((text) => text === text.trim() && text.length > 0 && codePointLength(text) <= max, { message: "OWN_WORDS_INVALID" });
/** 13s.6: the most cue keys one feeling note carries (the personal-note record allows as many). */
export const VOICE_FEELING_MAX_CUES = 12;
export const VOICE_FEELING_TEXT_MAX_CODE_POINTS = 1_000;
/** A stored feeling cue key: lowercase letters, single hyphens or underscores between ("tired", "worn-out", "not-good"); ≤ 32. */
export const voiceFeelingCueKeySchema = z.string().min(1).max(32).regex(/^[a-z]+(?:[-_][a-z]+)*$/);
const feelingSchema = z
  .object({
    kind: z.literal("FEELING_NOTE"),
    ...base,
    cueKeys: z.array(voiceFeelingCueKeySchema).min(1).max(VOICE_FEELING_MAX_CUES),
    text: ownWordsSchema(VOICE_FEELING_TEXT_MAX_CODE_POINTS),
  })
  .strict();
export const voiceActivityDurationSchema = z.number().int().min(1).max(VOICE_ACTIVITY_MAX_MINUTES);
const activitySchema = z
  .object({
    kind: z.literal("ACTIVITY_NOTE"),
    ...base,
    category: z.enum(VOICE_ACTIVITY_CATEGORIES),
    label: ownWordsSchema(VOICE_SOURCE_PHRASE_MAX_CODE_POINTS),
    durationMinutes: voiceActivityDurationSchema.nullable(),
  })
  .strict();

/** 13s.7: a request for general information about one named medicine (her words for the name; never a fact). */
const medicineInfoRequestSchema = z
  .object({ kind: z.literal("MEDICINE_INFO_REQUEST"), ...base, name: z.string().refine(isVoiceMedicineInfoName, { message: "NAME_INVALID" }) })
  .strict();

const ALLOWED_REASONS: Readonly<Record<"GLUCOSE_READING" | "MEAL_NOTE" | "MEDICATION_OCCURRENCE", readonly VoiceAmbiguityReason[]>> = Object.freeze({
  GLUCOSE_READING: ["UNIT_UNSTATED", "NEGATION", "UNCERTAINTY", "CORRECTION", "OTHER_PERSON", "MULTIPLE_NUMBERS"],
  MEAL_NOTE: ["NEGATION", "UNCERTAINTY", "CORRECTION", "OTHER_PERSON"],
  MEDICATION_OCCURRENCE: ["NEGATION", "UNCERTAINTY", "CORRECTION", "OTHER_PERSON", "MEDICINE_UNRESOLVED", "STATUS_UNCLEAR"],
});

export const voiceCandidateSchema = z.discriminatedUnion("kind", [glucoseSchema, mealSchema, medicationSchema, feelingSchema, activitySchema, medicineInfoRequestSchema, unsupportedSchema]).superRefine((candidate, context) => {
  const issue = (message: string) => context.addIssue({ code: z.ZodIssueCode.custom, message });
  if (codePointLength(candidate.sourcePhrase) !== candidate.span.end - candidate.span.start) issue("PHRASE_SPAN_MISMATCH");
  if (candidate.source === "DETERMINISTIC" && candidate.producerVersion !== VOICE_VOCABULARY_VERSION) issue("PRODUCER_VERSION_MISMATCH");
  if (candidate.kind === "UNSUPPORTED_SPAN") return;
  // 13s.7: a medicine-information request is recognised only by the fixed rules on the device.
  if (candidate.kind === "MEDICINE_INFO_REQUEST") {
    if (candidate.source !== "DETERMINISTIC") issue("DETERMINISTIC_ONLY_KIND");
    return;
  }
  // 13s.6: a feeling or an activity is recognised only by the fixed rules on the device; remote extraction never adds or alters one.
  if (candidate.kind === "FEELING_NOTE" || candidate.kind === "ACTIVITY_NOTE") {
    if (candidate.source !== "DETERMINISTIC") issue("DETERMINISTIC_ONLY_KIND");
    if (candidate.kind === "FEELING_NOTE" && new Set(candidate.cueKeys).size !== candidate.cueKeys.length) issue("CUE_KEYS_NOT_UNIQUE");
    return;
  }
  const ordered = VOICE_AMBIGUITY_REASONS.filter((reason) => candidate.ambiguity.includes(reason));
  if (ordered.length !== candidate.ambiguity.length || ordered.some((reason, index) => candidate.ambiguity[index] !== reason)) issue("AMBIGUITY_NOT_CANONICAL");
  if (candidate.ambiguity.some((reason) => !ALLOWED_REASONS[candidate.kind].includes(reason))) issue("AMBIGUITY_NOT_ALLOWED");
  if ((candidate.state === "UNDERSTOOD") !== (candidate.ambiguity.length === 0)) issue("STATE_AMBIGUITY_MISMATCH");
  if (candidate.kind === "GLUCOSE_READING") {
    if ((candidate.unit === "UNSTATED") !== candidate.ambiguity.includes("UNIT_UNSTATED")) issue("UNIT_AMBIGUITY_MISMATCH");
    if ((candidate.unit === "UNSTATED") !== (candidate.unitSource === null)) issue("UNIT_SOURCE_MISMATCH");
    if (candidate.unitSource === "APP_DEFAULT" && candidate.ambiguity.length > 0) issue("APP_DEFAULT_ON_AMBIGUOUS_READING");
    if (candidate.unitSource === "APP_DEFAULT" && !glucoseValueInAppDefaultWindow(candidate.valueText)) issue("APP_DEFAULT_OUT_OF_RANGE");
    if (candidate.unitSource === "APP_DEFAULT" && glucoseHedgeMarked(candidate.sourcePhrase)) issue("APP_DEFAULT_HEDGED");
  }
  if (candidate.kind === "MEDICATION_OCCURRENCE") {
    if ((candidate.medicineRef.kind === "UNRESOLVED") !== candidate.ambiguity.includes("MEDICINE_UNRESOLVED")) issue("MEDICINE_AMBIGUITY_MISMATCH");
    if ((candidate.status === "UNKNOWN") !== candidate.ambiguity.includes("STATUS_UNCLEAR")) issue("STATUS_AMBIGUITY_MISMATCH");
  }
});
export type VoiceCandidate = z.infer<typeof voiceCandidateSchema>;
export type VoiceGlucoseCandidate = Extract<VoiceCandidate, { kind: "GLUCOSE_READING" }>;
export type VoiceMealCandidate = Extract<VoiceCandidate, { kind: "MEAL_NOTE" }>;
export type VoiceMedicationCandidate = Extract<VoiceCandidate, { kind: "MEDICATION_OCCURRENCE" }>;
export type VoiceUnsupportedSpan = Extract<VoiceCandidate, { kind: "UNSUPPORTED_SPAN" }>;
/** 13s.6: a feeling she stated, and an activity she reported (deterministic only; no state or ambiguity). */
export type VoiceFeelingCandidate = Extract<VoiceCandidate, { kind: "FEELING_NOTE" }>;
export type VoiceActivityCandidate = Extract<VoiceCandidate, { kind: "ACTIVITY_NOTE" }>;
/** 13s.7: a request for general information about one named medicine (deterministic only; never a fact). */
export type VoiceMedicineInfoRequestCandidate = Extract<VoiceCandidate, { kind: "MEDICINE_INFO_REQUEST" }>;
export type VoiceFactCandidate = VoiceGlucoseCandidate | VoiceMealCandidate | VoiceMedicationCandidate;

/** True when the candidate's span and phrase are exactly the transcript's code points (required for REMOTE_EXTRACTION too). */
export function candidateMatchesTranscript(candidate: Pick<VoiceCandidate, "span" | "sourcePhrase">, transcript: string): boolean {
  const points = [...transcript];
  return candidate.span.end <= points.length && points.slice(candidate.span.start, candidate.span.end).join("") === candidate.sourcePhrase;
}

const messageKeyMatches = (value: { category: VoiceRedirectCategory; messageKey: string }) => value.messageKey === voiceRedirectMessageKey(value.category);
export const voiceRedirectNoticeSchema = z
  .object({ category: z.enum(VOICE_REDIRECT_CATEGORIES), messageKey: z.enum([VOICE_REDIRECT_MESSAGE_KEY, VOICE_REDIRECT_HEALTH_MESSAGE_KEY]), transcribedNoteKey: z.literal(VOICE_REDIRECT_TRANSCRIBED_NOTE_KEY) })
  .strict()
  .refine(messageKeyMatches, { message: "REDIRECT_KEY_CATEGORY_MISMATCH" });

const analysedSchema = z
  .object({
    kind: z.literal("ANALYSED"),
    language: voiceLanguageSchema,
    candidates: z.array(voiceCandidateSchema).max(VOICE_MAX_CANDIDATES),
    /** More than VOICE_MAX_CANDIDATES candidates were found; only the first ones (by span) are listed. */
    truncated: z.boolean(),
    /**
     * Mixed safety content (owner requirement 6): the fixed redirect for a dose/treatment/health question that was safely separated
     * from the facts listed here. Its clauses produced no candidate and no medicine occurrence is offered beside it. When the question
     * cannot be safely separated the result is REDIRECT instead (no candidate; manual handling).
     */
    redirect: voiceRedirectNoticeSchema.nullable(),
    extractorVersion: z.string().regex(PRODUCER_VERSION),
  })
  .strict();

const redirectSchema = z
  .object({
    kind: z.literal("REDIRECT"),
    language: voiceLanguageSchema,
    candidates: z.array(voiceCandidateSchema).max(0),
    category: z.enum(VOICE_REDIRECT_CATEGORIES),
    messageKey: z.enum([VOICE_REDIRECT_MESSAGE_KEY, VOICE_REDIRECT_HEALTH_MESSAGE_KEY]),
    transcribedNoteKey: z.literal(VOICE_REDIRECT_TRANSCRIBED_NOTE_KEY),
    extractorVersion: z.string().regex(PRODUCER_VERSION),
  })
  .strict();

const tooLongSchema = z
  .object({
    kind: z.literal("TRANSCRIPT_TOO_LONG"),
    language: voiceLanguageSchema,
    candidates: z.array(voiceCandidateSchema).max(0),
    extractorVersion: z.string().regex(PRODUCER_VERSION),
  })
  .strict();

/** 13s.5 (owner decision 2026-10-14): a distress cue was said. Nothing else is analysed, offered or saved. */
const distressSchema = z
  .object({
    kind: z.literal("DISTRESS"),
    language: voiceLanguageSchema,
    candidates: z.array(voiceCandidateSchema).max(0),
    cueKey: z.enum(VOICE_DISTRESS_CUE_KEYS),
    cuesVersion: z.literal(VOICE_DISTRESS_CUES_VERSION),
    extractorVersion: z.string().regex(PRODUCER_VERSION),
  })
  .strict();

export const voiceAnalysisSchema = z.discriminatedUnion("kind", [analysedSchema, redirectSchema, tooLongSchema, distressSchema]).superRefine((result, context) => {
  if (result.kind === "REDIRECT" && !messageKeyMatches(result)) context.addIssue({ code: z.ZodIssueCode.custom, message: "REDIRECT_KEY_CATEGORY_MISMATCH" });
  if (result.kind === "ANALYSED" && result.redirect !== null && result.candidates.some((candidate) => candidate.kind === "MEDICATION_OCCURRENCE")) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "MEDICINE_BESIDE_REDIRECT" });
  }
});
export type VoiceAnalysis = z.infer<typeof voiceAnalysisSchema>;
