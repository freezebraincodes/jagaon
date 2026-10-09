import { z } from "zod";
import { provenanceCoreSchema } from "../shared/provenance";
import { createRecordRevisionSchema } from "../shared/revision";
import { createTypedRevisionRefSchema } from "../shared/typed-revision-ref";
import { normaliseVoicePhrase } from "../voice/voice-candidate-extractor";

/**
 * Packet 13 (P13S step 3; owner storage decision 2026-10-09): the versioned PATIENT_TERMINOLOGY record type,
 * `patient-terminology.13s.1`, in the existing authoritative record store.
 *
 * A record is ONE patient-confirmed meaning of ONE spoken phrase in ONE language: phrase → an existing canonical MEDICATION record.
 * - It is created only by an explicit "remember" decision, changed only by an explicit "change" (a CORRECT revision), and forgotten by
 *   permanent deletion (the existing patient-deletion path: revisions removed, tombstone kept; no phrase remains).
 * - Remembering a term never records an event, and a journal event never remembers a term: they are separate decisions.
 * - The phrase is stored in its normal form (`normaliseVoicePhrase`, whose behaviour for this record is pinned by a test), 1–32 code
 *   points (terminology review #2); no transcript, audio, dose, time or free text is stored, and a phrase with a digit, a number word, an
 *   amount or unit word or a time word (EN and ZH) is refused (`isRememberableTerminologyPhrase`).
 * - The medicine reference pins the revision seen at confirmation; reuse resolves it to the medicine's CURRENT active head, and a
 *   mapping to a medicine that is no longer active is dormant (never reused; the person is asked again).
 * - Scope: the record lives in the local profile's dataset (one profile per device dataset), so it is profile-scoped by construction.
 */
export const PATIENT_TERMINOLOGY_RECORD_TYPE = "PATIENT_TERMINOLOGY" as const;
export const PATIENT_TERMINOLOGY_SCHEMA_VERSION = 1;
export const PATIENT_TERMINOLOGY_CONTENT_VERSION = "patient-terminology.13s.1";
export const PATIENT_TERMINOLOGY_PHRASE_MAX_CODE_POINTS = 32;
export const PATIENT_TERMINOLOGY_REVISION_ACTIONS = Object.freeze(["CREATE", "CORRECT"] as const);

export const terminologyLanguageSchema = z.enum(["en", "zh"]);
export type TerminologyLanguage = z.infer<typeof terminologyLanguageSchema>;

/**
 * Terminology review #2: words that would make a remembered phrase carry a dose, an amount or a time. Read on the normal form (EN is
 * lower case); the EN lists apply to both languages (Latin words inside a zh phrase), the ZH list to zh. Closed, conservative lists.
 */
const DIGIT = /[0-9０-９]/u;
const EN_NUMBER = /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|half|once|twice|double|triple|single|dozen)\b/;
const EN_AMOUNT = /\b(?:units?|iu|mg|mcg|ug|g|grams?|milligrams?|micrograms?|ml|millilitres?|milliliters?|cc|mmol|tablets?|tabs?|pills?|capsules?|caps|puffs?|drops?|doses?|dosage|sachets?|patch(?:es)?|sprays?)\b/;
const EN_TIME = /\b(?:am|pm|a\.m\.?|p\.m\.?|o'clock|morning|mornings|noon|midday|afternoon|evening|evenings|night|nights|nightly|bedtime|midnight|breakfast|lunch|dinner|supper|daily|hourly|weekly|today|tonight|yesterday|tomorrow|hours?|hrs?|minutes?|mins?)\b/;
const ZH_NUMBER_AMOUNT_TIME = /[零〇一二两三四五六七八九十百千万半]|单位|毫克|微克|毫升|毫摩尔|片|粒|颗|滴|喷|次|点|早上|早晨|上午|中午|下午|傍晚|晚上|夜里|夜间|半夜|凌晨|睡前|饭前|饭后|餐前|餐后|早餐|午餐|晚餐|宵夜|今天|昨天|明天|每天|每日|小时|分钟/u;

/** True when the (normalised) phrase may be remembered: no digit, number, amount, unit or time word, and 1–32 code points. */
export function isRememberableTerminologyPhrase(phrase: string, language: TerminologyLanguage): boolean {
  const length = [...phrase].length;
  if (length < 1 || length > PATIENT_TERMINOLOGY_PHRASE_MAX_CODE_POINTS || !/[\p{L}]/u.test(phrase)) return false;
  const lower = phrase.toLowerCase();
  if (DIGIT.test(lower) || EN_NUMBER.test(lower) || EN_AMOUNT.test(lower) || EN_TIME.test(lower)) return false;
  return language !== "zh" || !ZH_NUMBER_AMOUNT_TIME.test(phrase);
}

const medicationRefSchema = createTypedRevisionRefSchema(z.literal("MEDICATION"));

export const patientTerminologyPayloadSchema = z
  .strictObject({
    contentVersion: z.literal(PATIENT_TERMINOLOGY_CONTENT_VERSION),
    language: terminologyLanguageSchema,
    phrase: z.string().min(1),
    meaning: z.strictObject({ kind: z.literal("MEDICATION"), medication: medicationRefSchema }),
    confirmation: z.literal("PATIENT_CONFIRMED"),
  })
  .superRefine((payload, context) => {
    const normal = normaliseVoicePhrase(payload.phrase, payload.language);
    if (normal !== payload.phrase) context.addIssue({ code: z.ZodIssueCode.custom, message: "PHRASE_NOT_NORMALISED" });
    const length = [...payload.phrase].length;
    if (length < 1 || length > PATIENT_TERMINOLOGY_PHRASE_MAX_CODE_POINTS) context.addIssue({ code: z.ZodIssueCode.custom, message: "PHRASE_LENGTH" });
    if (!/[\p{L}]/u.test(payload.phrase)) context.addIssue({ code: z.ZodIssueCode.custom, message: "PHRASE_HAS_NO_WORD" });
    if (!isRememberableTerminologyPhrase(payload.phrase, payload.language)) context.addIssue({ code: z.ZodIssueCode.custom, message: "PHRASE_NOT_REMEMBERABLE" });
  });
export type PatientTerminologyPayload = z.infer<typeof patientTerminologyPayloadSchema>;

/** Only the patient enters a term, through the review form; never a model, rule engine or import. */
const patientEntryProvenanceSchema = provenanceCoreSchema.refine(
  (provenance) => provenance.sourceKind === "PATIENT_ENTRY" && provenance.captureMethod === "FORM" && provenance.initiator === "PATIENT" && provenance.assistance === "NONE",
  "TERMINOLOGY_REQUIRES_PATIENT_ENTRY",
);

export const patientTerminologyRevisionSchema = createRecordRevisionSchema(
  z.literal(PATIENT_TERMINOLOGY_RECORD_TYPE),
  patientTerminologyPayloadSchema,
  z.strictObject({ kind: z.literal("ATEMPORAL") }),
  patientEntryProvenanceSchema,
).superRefine((revision, context) => {
  if (revision.schemaVersion !== PATIENT_TERMINOLOGY_SCHEMA_VERSION) context.addIssue({ code: z.ZodIssueCode.custom, message: "SCHEMA_VERSION" });
  if (!(PATIENT_TERMINOLOGY_REVISION_ACTIONS as readonly string[]).includes(revision.action)) context.addIssue({ code: z.ZodIssueCode.custom, message: "ACTION_NOT_ALLOWED" });
  if ((revision.action === "CREATE") !== (revision.revisionNumber === 1 && revision.previousRevisionId === null)) context.addIssue({ code: z.ZodIssueCode.custom, message: "CHAIN_DISAGREES_WITH_ACTION" });
});

export type PatientTerminologyRevision = z.infer<typeof patientTerminologyRevisionSchema>;
