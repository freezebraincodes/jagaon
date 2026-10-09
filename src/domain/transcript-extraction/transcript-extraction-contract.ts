import { z } from "zod";

/**
 * Packet 13 (P13X; owner scope expansion 2026-10-09): the bounded DeepSeek transcript-extraction task contract, its own contract and
 * never the value-blind wording route's. Browser-safe: no credential, prompt, provider or network code.
 *
 * Request (the minimum approved transcript and context): the transcript text, the locale and the allowed fact kinds. Nothing else: no
 * journal data, medicine names, record ids, profile, history or display name (a strict object refuses any other field).
 *
 * Output: facts and unsupported spans only. Every string the model returns is either a closed enum, a bounded decimal or a verbatim
 * substring of the transcript at stated code-point offsets; there is no free-text, advice, diagnosis, medicine-identity, dose-suggestion
 * or time field, so none can be produced. `value`/`unit` only when the words say so; `status` for a medicine occurrence only;
 * `negated` and `uncertain` preserve what was said; an unresolved description ("the grey pen") stays a verbatim `unresolvedPhrase` and is
 * resolved locally after extraction, never by the model. The rules that tie each field to the words are in
 * transcript-extraction-validator.ts.
 */
export const TRANSCRIPT_EXTRACTION_TASK = "EXTRACT_VOICE_FACTS";
export const TRANSCRIPT_EXTRACTION_CONTRACT_VERSION = "transcript-extraction.13.1";
export const TRANSCRIPT_EXTRACTION_LOCALES = Object.freeze(["en-SG", "zh-SG"] as const);
export type TranscriptExtractionLocale = (typeof TRANSCRIPT_EXTRACTION_LOCALES)[number];

export const EXTRACTION_FACT_KINDS = Object.freeze(["GLUCOSE_READING", "MEAL_OR_FOOD_NOTE", "MEDICINE_OCCURRENCE"] as const);
export type ExtractionFactKind = (typeof EXTRACTION_FACT_KINDS)[number];

export const EXTRACTION_GLUCOSE_UNITS = Object.freeze(["MMOL_PER_L", "MG_PER_DL"] as const);
export const EXTRACTION_MEDICINE_UNITS = Object.freeze(["UNITS", "MG", "TABLET", "ML"] as const);
export const EXTRACTION_UNITS = Object.freeze([...EXTRACTION_GLUCOSE_UNITS, ...EXTRACTION_MEDICINE_UNITS] as const);
export type ExtractionUnit = (typeof EXTRACTION_UNITS)[number];

export const MEDICINE_OCCURRENCE_STATUSES = Object.freeze(["PLANNED", "TAKEN", "SKIPPED", "UNKNOWN"] as const);
export type MedicineOccurrenceStatus = (typeof MEDICINE_OCCURRENCE_STATUSES)[number];

export const TRANSCRIPT_EXTRACTION_LIMITS = Object.freeze({
  /** Same ceiling as the voice slice's transcript (voice-contract.13s.1). */
  transcriptMaxCodePoints: 1_200,
  maxFacts: 8,
  maxUnsupportedSpans: 8,
  spanMaxCodePoints: 200,
  unresolvedPhraseMaxCodePoints: 80,
});

export const codePoints = (text: string): string[] => Array.from(text);
const CONTROL = /[\u0000-\u001f\u007f]/;

export const extractionRequestSchema = z.strictObject({
  taskType: z.literal(TRANSCRIPT_EXTRACTION_TASK),
  contractVersion: z.literal(TRANSCRIPT_EXTRACTION_CONTRACT_VERSION),
  locale: z.enum(TRANSCRIPT_EXTRACTION_LOCALES),
  transcript: z
    .string()
    .refine((text) => text.trim().length > 0, "EMPTY")
    .refine((text) => codePoints(text).length <= TRANSCRIPT_EXTRACTION_LIMITS.transcriptMaxCodePoints, "TOO_LONG")
    .refine((text) => !CONTROL.test(text), "CONTROL_CHARACTER"),
  allowedFactKinds: z
    .array(z.enum(EXTRACTION_FACT_KINDS))
    .min(1)
    .max(EXTRACTION_FACT_KINDS.length)
    .refine((kinds) => new Set(kinds).size === kinds.length, "DUPLICATE_KIND"),
});
export type ExtractionRequest = z.infer<typeof extractionRequestSchema>;

export const extractionSpanSchema = z.strictObject({
  start: z.number().int().min(0).max(TRANSCRIPT_EXTRACTION_LIMITS.transcriptMaxCodePoints),
  end: z.number().int().min(1).max(TRANSCRIPT_EXTRACTION_LIMITS.transcriptMaxCodePoints),
  text: z.string().min(1),
});
export type ExtractionSpan = z.infer<typeof extractionSpanSchema>;

/** A decimal as it can be read from the words: 1–4 integer digits, at most 2 decimals. */
export const EXTRACTION_VALUE_PATTERN = /^\d{1,4}(?:\.\d{1,2})?$/;

export const extractionFactSchema = z.strictObject({
  kind: z.enum(EXTRACTION_FACT_KINDS),
  sourceSpan: extractionSpanSchema,
  value: z.string().regex(EXTRACTION_VALUE_PATTERN).nullable(),
  unit: z.enum(EXTRACTION_UNITS).nullable(),
  status: z.enum(MEDICINE_OCCURRENCE_STATUSES).nullable(),
  negated: z.boolean(),
  uncertain: z.boolean(),
  unresolvedPhrase: z.string().min(1).nullable(),
});
export type ExtractionFact = z.infer<typeof extractionFactSchema>;

export const extractionOutputSchema = z.strictObject({
  facts: z.array(extractionFactSchema).max(TRANSCRIPT_EXTRACTION_LIMITS.maxFacts),
  unsupportedSpans: z.array(extractionSpanSchema).max(TRANSCRIPT_EXTRACTION_LIMITS.maxUnsupportedSpans),
});
export type ExtractionOutput = z.infer<typeof extractionOutputSchema>;

/** The strict JSON schema sent as `text.format` (every property required; nullable as a type union; no additional property). */
export function extractionOutputJsonSchema(): Record<string, unknown> {
  const span = {
    type: "object",
    additionalProperties: false,
    required: ["start", "end", "text"],
    properties: { start: { type: "integer", minimum: 0 }, end: { type: "integer", minimum: 1 }, text: { type: "string" } },
  };
  return {
    type: "object",
    additionalProperties: false,
    required: ["facts", "unsupportedSpans"],
    properties: {
      facts: {
        type: "array",
        maxItems: TRANSCRIPT_EXTRACTION_LIMITS.maxFacts,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "sourceSpan", "value", "unit", "status", "negated", "uncertain", "unresolvedPhrase"],
          properties: {
            kind: { type: "string", enum: [...EXTRACTION_FACT_KINDS] },
            sourceSpan: span,
            value: { type: ["string", "null"] },
            unit: { type: ["string", "null"], enum: [...EXTRACTION_UNITS, null] },
            status: { type: ["string", "null"], enum: [...MEDICINE_OCCURRENCE_STATUSES, null] },
            negated: { type: "boolean" },
            uncertain: { type: "boolean" },
            unresolvedPhrase: { type: ["string", "null"] },
          },
        },
      },
      unsupportedSpans: { type: "array", maxItems: TRANSCRIPT_EXTRACTION_LIMITS.maxUnsupportedSpans, items: span },
    },
  };
}
