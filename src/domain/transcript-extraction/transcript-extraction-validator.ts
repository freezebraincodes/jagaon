import {
  EXTRACTION_GLUCOSE_UNITS,
  EXTRACTION_MEDICINE_UNITS,
  TRANSCRIPT_EXTRACTION_LIMITS,
  codePoints,
  extractionOutputSchema,
  type ExtractionFact,
  type ExtractionOutput,
  type ExtractionRequest,
  type ExtractionSpan,
} from "./transcript-extraction-contract";
import { hasCounterfactualCue, hasNegationCue, hasSpokenNumber, hasStatusCue, hasUncertaintyCue, hasUnitCue, valueStatedIn } from "./transcript-extraction-lexicon";

/**
 * Packet 13 (P13X): the extraction r-rules (validator transcript-extraction-validator.13.1). Pure. The model output is untrusted; any
 * rule failure REJECTS the whole answer (no partial use) and the caller falls back to the deterministic local extractor.
 *
 *  r1 schema: the strict output schema (closed fields, bounded counts, decimal value format).
 *  r2 spans: every fact and unsupported span is in range, at most 200 code points, and EXACTLY the transcript's text at its offsets.
 *  r3 kind: the fact kind is one of the request's allowed kinds.
 *  r4 redirect: no fact span may be a dose/treatment question (the injected deterministic classifier, which also ran before any call).
 *  r5 kind fields: status only on a medicine occurrence (required there); a glucose reading needs a value; units only of the fact's own
 *     family (glucose: mmol/L, mg/dL; medicine: units, mg, tablet, ml); a meal note carries no value or unit.
 *  r6 words: the value is a number the span states (digits or number words); the unit has its cue in the span.
 *  r7 status: TAKEN needs an explicit taken cue and no negation; PLANNED and SKIPPED need their cues (SKIPPED also accepts a negation).
 *     13.2 (review): TAKEN is also rejected when the same span holds a PLANNED cue ("had to … later"); every negation in any contracted
 *     form, with the straight or curly apostrophe, counts (lexicon 13.2). r4 uses the EN and ZH redirect together (code-switching).
 *     13.3 (recheck 6): TAKEN is also rejected beside a counterfactual ("I'd have taken", "would've", 本来会, 要是…就; lexicon 13.3).
 *  r8 negation and uncertainty: `negated` equals whether the span holds a negation cue; a stated uncertainty sets `uncertain`.
 *  r9 unresolved: an `unresolvedPhrase` is verbatim inside its span (no medicine identity, no resolution by the model).
 *  r10 duplicates: no two facts share kind and span.
 *  r11 coverage: nothing is silently dropped; every clause with content and every spoken number lies in a fact or unsupported span.
 * There is no free-text field, so advice, diagnosis, dose suggestions, medicine identity and invented times cannot appear (r1).
 */
export const TRANSCRIPT_EXTRACTION_VALIDATOR_VERSION = "transcript-extraction-validator.13.3";

export const EXTRACTION_REJECTION_REASONS = Object.freeze([
  "SCHEMA_INVALID",
  "SPAN_OUT_OF_RANGE",
  "SPAN_NOT_VERBATIM",
  "KIND_NOT_ALLOWED",
  "FACT_COVERS_REDIRECT",
  "STATUS_NOT_ALLOWED_FOR_KIND",
  "STATUS_REQUIRED",
  "GLUCOSE_VALUE_REQUIRED",
  "VALUE_NOT_ALLOWED_FOR_KIND",
  "UNIT_NOT_ALLOWED_FOR_KIND",
  "VALUE_NOT_IN_SPAN",
  "UNIT_NOT_IN_SPAN",
  "TAKEN_WITH_NEGATION",
  "TAKEN_WITH_PLANNED",
  "TAKEN_WITH_COUNTERFACTUAL",
  "STATUS_NOT_IN_SPAN",
  "NEGATION_NOT_PRESERVED",
  "UNCERTAINTY_NOT_PRESERVED",
  "UNRESOLVED_NOT_IN_SPAN",
  "DUPLICATE_FACT",
  "CONTENT_NOT_ACCOUNTED",
] as const);
export type ExtractionRejectionReason = (typeof EXTRACTION_REJECTION_REASONS)[number];

/**
 * The validation result. The passing kind is "VALID" (renamed from its first draft name; same rules, so the validator version is
 * unchanged): this module joins the browser graph through the voice adapter, where the remote-use decision word is reserved for the
 * Packet 11C C3 decision machinery.
 */
export type ExtractionValidation =
  | Readonly<{ kind: "VALID"; output: ExtractionOutput }>
  | Readonly<{ kind: "REJECTED"; reason: ExtractionRejectionReason; index: number | null }>;

export type ExtractionValidatorOptions = Readonly<{
  /** The deterministic dose/treatment redirect classifier for the request's language (true = redirect). */
  isRedirect: (text: string) => boolean;
}>;

const FILLER = new Set(["and", "then", "so", "um", "uh", "er", "erm", "ok", "okay", "also", "hi", "hello", "jagaon", "嗯", "啊", "哦", "然后", "还有", "那个", "就是", "好"]);
const CLAUSE_BREAK = /[,.;!?，。；！？、]|(?<![A-Za-z])(?:and|then)(?![A-Za-z])|然后|还有/gi;

function spanError(points: readonly string[], span: ExtractionSpan): ExtractionRejectionReason | null {
  if (span.start >= span.end || span.end > points.length || span.end - span.start > TRANSCRIPT_EXTRACTION_LIMITS.spanMaxCodePoints) return "SPAN_OUT_OF_RANGE";
  return points.slice(span.start, span.end).join("") === span.text ? null : "SPAN_NOT_VERBATIM";
}

function factError(fact: ExtractionFact, request: ExtractionRequest, options: ExtractionValidatorOptions): ExtractionRejectionReason | null {
  const text = fact.sourceSpan.text;
  if (!request.allowedFactKinds.includes(fact.kind)) return "KIND_NOT_ALLOWED";
  if (options.isRedirect(text)) return "FACT_COVERS_REDIRECT";
  const negation = hasNegationCue(text);
  if (fact.kind === "MEDICINE_OCCURRENCE") {
    if (fact.status === null) return "STATUS_REQUIRED";
    if (fact.unit !== null && !(EXTRACTION_MEDICINE_UNITS as readonly string[]).includes(fact.unit)) return "UNIT_NOT_ALLOWED_FOR_KIND";
  } else {
    if (fact.status !== null) return "STATUS_NOT_ALLOWED_FOR_KIND";
    if (fact.kind === "GLUCOSE_READING") {
      if (fact.value === null) return "GLUCOSE_VALUE_REQUIRED";
      if (fact.unit !== null && !(EXTRACTION_GLUCOSE_UNITS as readonly string[]).includes(fact.unit)) return "UNIT_NOT_ALLOWED_FOR_KIND";
    } else if (fact.value !== null || fact.unit !== null) return fact.unit !== null ? "UNIT_NOT_ALLOWED_FOR_KIND" : "VALUE_NOT_ALLOWED_FOR_KIND";
  }
  if (fact.value !== null && !valueStatedIn(text, fact.value)) return "VALUE_NOT_IN_SPAN";
  if (fact.unit !== null && !hasUnitCue(text, fact.unit)) return "UNIT_NOT_IN_SPAN";
  if (fact.status === "TAKEN" && negation) return "TAKEN_WITH_NEGATION";
  if (fact.status === "TAKEN" && hasStatusCue(text, "PLANNED")) return "TAKEN_WITH_PLANNED";
  if (fact.status === "TAKEN" && hasCounterfactualCue(text)) return "TAKEN_WITH_COUNTERFACTUAL";
  if (fact.status === "TAKEN" && !hasStatusCue(text, "TAKEN")) return "STATUS_NOT_IN_SPAN";
  if (fact.status === "PLANNED" && !hasStatusCue(text, "PLANNED")) return "STATUS_NOT_IN_SPAN";
  if (fact.status === "SKIPPED" && !hasStatusCue(text, "SKIPPED") && !negation) return "STATUS_NOT_IN_SPAN";
  if (fact.negated !== negation) return "NEGATION_NOT_PRESERVED";
  if (hasUncertaintyCue(text) && !fact.uncertain) return "UNCERTAINTY_NOT_PRESERVED";
  if (fact.unresolvedPhrase !== null && (!text.includes(fact.unresolvedPhrase) || codePoints(fact.unresolvedPhrase).length > TRANSCRIPT_EXTRACTION_LIMITS.unresolvedPhraseMaxCodePoints)) {
    return "UNRESOLVED_NOT_IN_SPAN";
  }
  return null;
}

/** Clause ranges (code points) that carry content beyond filler words and punctuation. */
function contentClauses(transcript: string): { start: number; end: number; text: string }[] {
  const clauses: { start: number; end: number; text: string }[] = [];
  let last = 0;
  const push = (startUnit: number, endUnit: number) => {
    const text = transcript.slice(startUnit, endUnit);
    const words = text.toLowerCase().match(/[a-z0-9']+|[㐀-鿿]+|[０-９]+/g) ?? [];
    const meaningful = words.filter((word) => !FILLER.has(word) && ![...FILLER].some((filler) => /[㐀-鿿]/.test(filler) && word === filler));
    if (meaningful.length === 0) return;
    const start = codePoints(transcript.slice(0, startUnit)).length;
    clauses.push({ start, end: start + codePoints(text).length, text });
  };
  for (const match of transcript.matchAll(CLAUSE_BREAK)) {
    push(last, match.index!);
    last = match.index! + match[0].length;
  }
  push(last, transcript.length);
  return clauses;
}

const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) => a.start < b.end && b.start < a.end;
const inside = (a: { start: number; end: number }, b: { start: number; end: number }) => b.start <= a.start && a.end <= b.end;

/** Validates one untrusted model output against its request. */
export function validateExtraction(request: ExtractionRequest, candidate: unknown, options: ExtractionValidatorOptions): ExtractionValidation {
  const reject = (reason: ExtractionRejectionReason, index: number | null = null): ExtractionValidation => Object.freeze({ kind: "REJECTED" as const, reason, index });
  const parsed = extractionOutputSchema.safeParse(candidate);
  if (!parsed.success) return reject("SCHEMA_INVALID");
  const output = parsed.data;
  const points = codePoints(request.transcript);

  for (const [index, fact] of output.facts.entries()) {
    const error = spanError(points, fact.sourceSpan) ?? factError(fact, request, options);
    if (error) return reject(error, index);
  }
  for (const [index, span] of output.unsupportedSpans.entries()) {
    const error = spanError(points, span);
    if (error) return reject(error, output.facts.length + index);
  }
  const keys = output.facts.map((fact) => `${fact.kind}|${fact.sourceSpan.start}|${fact.sourceSpan.end}`);
  const duplicate = keys.findIndex((key, index) => keys.indexOf(key) !== index);
  if (duplicate >= 0) return reject("DUPLICATE_FACT", duplicate);

  // r11: every content clause overlaps a stated span; every spoken number lies inside one.
  const spans = [...output.facts.map((fact) => fact.sourceSpan), ...output.unsupportedSpans];
  for (const clause of contentClauses(request.transcript)) {
    if (!spans.some((span) => overlaps(clause, span))) return reject("CONTENT_NOT_ACCOUNTED");
    if (hasSpokenNumber(clause.text) && !spans.some((span) => overlaps(clause, span) && (inside(clause, span) || hasSpokenNumber(span.text)))) return reject("CONTENT_NOT_ACCOUNTED");
  }
  return Object.freeze({ kind: "VALID" as const, output });
}
