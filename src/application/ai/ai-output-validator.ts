import { parseStrictJson, StrictJsonError, toPlainData } from "@/backup/strict-json";
import { AI_FACT_UNITS, aiTaskOutputSchema, payloadReferences, type AiLocale, type AiTaskOutput, type AiTaskRequest, type ProviderTaskRequest } from "@/domain/ai/ai-task-contracts";
import type { AiReasonCode } from "./ai-fallbacks";
import type { AiTaskRuntimeBundle } from "./ai-runtime-bundles";
import { generatedTextFields, meaningMatches, withoutQuotations } from "./ai-meaning-rules";
import { projectProviderTaskPayload } from "./detached-payload-projector";

/**
 * Packet 11A deterministic whole-result validation (ai-system-spec Section 9;
 * design Section 9). Gates run in the locked order: strict JSON, exact schema
 * and envelope, request-local reference closure, factual and value fidelity,
 * authority and forbidden meaning, locale, and output budget. The parsed
 * output is returned only when every gate passes; a rejected result exposes
 * no fragment. Only a structural failure is repairable, and only when the
 * bundle permits one repair. Meaning checks are a deterministic backstop, not
 * proof of semantic equivalence (Section 15.4); human review still applies.
 */

export type AiValidationReason = Extract<
  AiReasonCode,
  "SCHEMA_INVALID" | "LOCALE_INVALID" | "MODEL_ABSTAINED" | "REFERENCE_MISMATCH" | "FACT_FIDELITY_FAILED" | "AUTHORITY_BOUNDARY_VIOLATION" | "CLINICAL_MEANING_VIOLATION" | "OUTPUT_BUDGET_EXCEEDED" | "PAYLOAD_INVALID" | "PRIVACY_REJECTED" | "BUDGET_EXCEEDED"
>;
export type AiValidationResult = { kind: "ACCEPTED"; output: AiTaskOutput } | { kind: "REJECTED"; reason: AiValidationReason; repairable: boolean };

class Rejection extends Error {
  constructor(readonly reason: AiValidationReason) {
    super(reason);
  }
}
const reject = (reason: AiValidationReason): never => {
  throw new Rejection(reason);
};

// --- Forbidden meaning (Sections 0, 9, 15.2; test-release 7.4) -------------------------------


// --- Text extraction ------------------------------------------------------------------------

function generatedTexts(output: Extract<AiTaskOutput, { outcome: "SUCCESS" }>): string[] {
  return generatedTextFields(output).map((field) => field.text);
}


// --- Gates ------------------------------------------------------------------------------------

function parseCandidate(candidate: unknown): unknown {
  if (typeof candidate !== "string") return candidate;
  try {
    return toPlainData(parseStrictJson(candidate, { maxDepth: 16, maxLength: 65_536 }));
  } catch (error) {
    if (error instanceof StrictJsonError) return reject("SCHEMA_INVALID");
    throw error;
  }
}

function subset(values: readonly string[], allowed: ReadonlySet<string>): boolean {
  return values.every((value) => allowed.has(value));
}

function checkReferences(output: Extract<AiTaskOutput, { outcome: "SUCCESS" }>, provider: ProviderTaskRequest): void {
  const facts = new Set(provider.facts.map((fact) => fact.ref));
  const used = new Set(output.inputRefsUsed);
  const require = (refs: readonly string[], allowed: ReadonlySet<string>) => {
    if (!subset(refs, allowed) || !subset(refs, used)) reject("REFERENCE_MISMATCH");
  };
  switch (output.taskType) {
    case "EXTRACT_CANDIDATE_FACTS": {
      const payload = provider.taskPayload as Extract<ProviderTaskRequest, { taskType: "EXTRACT_CANDIDATE_FACTS" }>["taskPayload"];
      for (const candidate of output.payload.candidates) {
        if (candidate.sourceRef !== payload.excerptRef) reject("REFERENCE_MISMATCH");
        require([candidate.sourceRef], facts);
        if (!payload.targetFields.includes(candidate.field)) reject("AUTHORITY_BOUNDARY_VIOLATION");
      }
      return;
    }
    case "EXPLAIN_PATTERN": {
      const payload = provider.taskPayload as Extract<ProviderTaskRequest, { taskType: "EXPLAIN_PATTERN" }>["taskPayload"];
      require([...output.payload.headline.claimRefs, ...output.payload.observation.claimRefs], new Set([payload.claim.ref]));
      require(output.payload.evidence.factRefs, new Set(payload.claim.factRefs));
      return;
    }
    case "DRAFT_NEUTRAL_INQUIRY": {
      const payload = provider.taskPayload as Extract<ProviderTaskRequest, { taskType: "DRAFT_NEUTRAL_INQUIRY" }>["taskPayload"];
      if (output.payload.observation) require(output.payload.observation.factRefs, new Set(payload.supportingFactRefs));
      const labelled = output.payload.optionLabels.map((entry) => entry.optionRef);
      const supplied = payload.options.map((option) => option.ref);
      // Options are fixed by the Inquiry layer: same references, count and order.
      if (labelled.length !== supplied.length || labelled.some((ref, index) => ref !== supplied[index])) reject("REFERENCE_MISMATCH");
      require(labelled, new Set(supplied));
      return;
    }
    case "ANSWER_BOUNDED_RECORD_QUERY": {
      const payload = provider.taskPayload as Extract<ProviderTaskRequest, { taskType: "ANSWER_BOUNDED_RECORD_QUERY" }>["taskPayload"];
      require(output.payload.segments.flatMap((segment) => segment.recordRefs), new Set(payload.records.map((record) => record.ref)));
      return;
    }
    case "DRAFT_CARE_PREPARATION_SUMMARY": {
      const payload = provider.taskPayload as Extract<ProviderTaskRequest, { taskType: "DRAFT_CARE_PREPARATION_SUMMARY" }>["taskPayload"];
      const sections = new Map(payload.sections.map((section) => [section.ref, new Set(section.factRefs)]));
      for (const section of output.payload.sections) {
        const own = sections.get(section.sectionRef);
        if (!own) return reject("REFERENCE_MISMATCH");
        require([section.sectionRef], new Set(sections.keys()));
        require(section.bullets.flatMap((bullet) => bullet.factRefs), own);
      }
      return;
    }
    case "PHRASE_NON_CLINICAL_RESPONSE": {
      const payload = provider.taskPayload as Extract<ProviderTaskRequest, { taskType: "PHRASE_NON_CLINICAL_RESPONSE" }>["taskPayload"];
      require(output.payload.message.factRefs, new Set(payload.factRefs));
      return;
    }
  }
}

const NUMBER = /\d+(?:\.\d+)?/g;
/**
 * A request-local reference identifier is structured metadata, never visible wording (validator
 * rules r3). Checked after verbatim patient-authored text is removed, independently of whether
 * its digits happen to equal a supplied value. Non-global, so `test` holds no state.
 */
const VISIBLE_REFERENCE = /\b(?:fact|claim|option|record|section|limitation)-\d+/i;
/**
 * An internal unit code (MMOL_L, MG_DL) is an identifier, never visible wording (validator rules r6):
 * only its approved display form (mmol/L, mg/dL) may appear. Checked after verbatim patient-authored
 * text is removed, in any letter case. Non-global, so `test` holds no state.
 */
const VISIBLE_UNIT_CODE = new RegExp(`\\b(?:${AI_FACT_UNITS.filter((unit) => unit.includes("_")).join("|")})\\b`, "i");
const UNIT_TOKENS: ReadonlyArray<[RegExp, string]> = [
  [/mmol\s*\/\s*l/i, "MMOL_L"],
  [/mg\s*\/\s*dl/i, "MG_DL"],
  [/\bkg\b|公斤/i, "KG"],
  [/\bcm\b|厘米/i, "CM"],
  [/\blbs?\b/i, "LB"],
  [/\bml\b|毫升/i, "ML"],
  [/\bmcg\b/i, "MCG"],
  [/\bmg\b(?!\s*\/)/i, "MG"],
];

/**
 * A spelled-out count is a number too (validator rules r7): an English cardinal (one to twelve) before a count noun,
 * optionally through one qualifier, and a Chinese numeral before a measure word. Its value must equal a supplied COUNT
 * or DECIMAL value; a date or time component never makes a count supplied. Checked after verbatim patient-authored
 * text is removed. Not counts: ordinals (first, 第一), pronoun or partitive "one" (the earlier one, one of), idioms
 * without a measure word (一些, 一样, 一直, 一段时间), each/some/same (每一, 某一, 同一), and 一 before the general
 * classifiers 个 份 位 种, which is the Chinese indefinite article.
 */
const ENGLISH_CARDINALS: Readonly<Record<string, number>> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const ENGLISH_COUNT = new RegExp(
  `\\b(${Object.keys(ENGLISH_CARDINALS).join("|")})[\\s-]+(?:(?:recorded|logged|saved|entered|supplied|separate|different|distinct|individual|consecutive|earlier|later|previous|recent|new|more|other|additional|glucose|weight|blood)\\s+)?` +
    `(?:readings?|values?|measurements?|records?|entries|entry|times|days?|weeks?|months?|years?|periods?|results?|occasions?|checks?|logs?|items?|notes?|questions?)\\b`,
  "gi",
);
const CHINESE_DIGITS: Readonly<Record<string, number>> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CHINESE_COUNT = /(?<![第每某同])([一二两三四五六七八九十]+)([次个条项天周月年份位种组回遍笔])/g;
const INDEFINITE_CLASSIFIERS = new Set(["个", "份", "位", "种"]);
function chineseNumeral(text: string): number {
  if (!text.includes("十")) return text.length === 1 ? CHINESE_DIGITS[text] : Number.NaN;
  const [tens, ones, ...rest] = text.split("十");
  if (rest.length > 0 || tens.length > 1 || ones.length > 1) return Number.NaN;
  return (tens ? CHINESE_DIGITS[tens] : 1) * 10 + (ones ? CHINESE_DIGITS[ones] : 0);
}
export function spelledCounts(text: string): number[] {
  const counts = [...text.matchAll(ENGLISH_COUNT)].map((match) => ENGLISH_CARDINALS[match[1].toLowerCase()]);
  for (const [, numeral, classifier] of text.matchAll(CHINESE_COUNT)) {
    if (numeral === "一" && INDEFINITE_CLASSIFIERS.has(classifier)) continue;
    counts.push(chineseNumeral(numeral));
  }
  return counts;
}

/** Every number and unit in generated wording must come from a supplied fact (Section 9, 15.4). */
function checkFidelity(output: Extract<AiTaskOutput, { outcome: "SUCCESS" }>, provider: ProviderTaskRequest): void {
  const numbers = new Set<number>();
  const counts = new Set<number>();
  const units = new Set<string>();
  for (const fact of provider.facts) {
    const value = fact.value;
    if (value.kind === "DECIMAL") {
      numbers.add(Number(value.value));
      counts.add(Number(value.value));
      units.add(value.unit);
    }
    if (value.kind === "COUNT") {
      numbers.add(value.value);
      counts.add(value.value);
    }
    if (value.kind === "DATE") value.localDate.split("-").forEach((part) => numbers.add(Number(part)));
    if (value.kind === "DATE_RANGE") [...value.startDate.split("-"), ...value.endDate.split("-")].forEach((part) => numbers.add(Number(part)));
    if (value.kind === "LOCAL_TIME") value.localTime.split(":").forEach((part) => numbers.add(Number(part)));
  }
  for (const raw of generatedTexts(output)) {
    const text = withoutQuotations(raw, provider.facts);
    if (VISIBLE_REFERENCE.test(text)) reject("FACT_FIDELITY_FAILED");
    if (VISIBLE_UNIT_CODE.test(text)) reject("FACT_FIDELITY_FAILED");
    if (/%|％/.test(text)) reject("FACT_FIDELITY_FAILED");
    for (const match of text.match(NUMBER) ?? []) if (!numbers.has(Number(match))) reject("FACT_FIDELITY_FAILED");
    for (const [pattern, unit] of UNIT_TOKENS) if (pattern.test(text) && !units.has(unit)) reject("FACT_FIDELITY_FAILED");
    for (const count of spelledCounts(text)) if (!counts.has(count)) reject("FACT_FIDELITY_FAILED");
  }

  switch (output.taskType) {
    case "EXTRACT_CANDIDATE_FACTS": {
      const payload = provider.taskPayload as Extract<ProviderTaskRequest, { taskType: "EXTRACT_CANDIDATE_FACTS" }>["taskPayload"];
      const excerpt = provider.facts.find((fact) => fact.ref === payload.excerptRef)?.value;
      if (!excerpt || excerpt.kind !== "TEXT") return reject("FACT_FIDELITY_FAILED");
      for (const candidate of output.payload.candidates) {
        if (candidate.end > excerpt.text.length || excerpt.text.slice(candidate.start, candidate.end) !== candidate.quotation) reject("FACT_FIDELITY_FAILED");
      }
      return;
    }
    case "EXPLAIN_PATTERN":
      // Option B: limitations are rendered by the application from the approved registry; the model returns none.
      return;
    case "ANSWER_BOUNDED_RECORD_QUERY": {
      const payload = provider.taskPayload as Extract<ProviderTaskRequest, { taskType: "ANSWER_BOUNDED_RECORD_QUERY" }>["taskPayload"];
      const covered = new Set(output.payload.segments.flatMap((segment) => segment.recordRefs));
      if (payload.records.some((record) => !covered.has(record.ref))) reject("FACT_FIDELITY_FAILED");
      return;
    }
    case "DRAFT_CARE_PREPARATION_SUMMARY": {
      const payload = provider.taskPayload as Extract<ProviderTaskRequest, { taskType: "DRAFT_CARE_PREPARATION_SUMMARY" }>["taskPayload"];
      // The selected facts and sections remain identical: none may be dropped.
      const covered = new Set(output.payload.sections.flatMap((section) => section.bullets.flatMap((bullet) => bullet.factRefs)));
      const sections = new Set(output.payload.sections.map((section) => section.sectionRef));
      if (payload.sections.some((section) => !sections.has(section.ref) || section.factRefs.some((ref) => !covered.has(ref)))) reject("FACT_FIDELITY_FAILED");
      return;
    }
    default:
      return;
  }
}

function checkMeaning(output: Extract<AiTaskOutput, { outcome: "SUCCESS" }>, provider: ProviderTaskRequest): void {
  for (const raw of generatedTexts(output)) {
    // Shared rules (ai-meaning-rules): authority on the text, clinical on the limitation-aware scan text.
    const matched = meaningMatches(withoutQuotations(raw, provider.facts));
    if (matched.some((entry) => entry.kind === "AUTHORITY")) reject("AUTHORITY_BOUNDARY_VIOLATION");
    if (matched.some((entry) => entry.kind === "CLINICAL")) reject("CLINICAL_MEANING_VIOLATION");
  }
}

const CJK = /[㐀-鿿豈-﫿]/;
const LATIN_WORD = /[A-Za-z]{2,}/g;
/** Product and technical names that stay untranslated in zh-SG (matrix Section 1) and units. */
const UNTRANSLATED = /\b(AI|JagaOn|Kie\.ai|mmol\/L|mg\/dL|kg|cm|ml|mg|mcg)\b/gi;

/** The shared locale rule for generated text, applied after quotation removal (also used by the shell validator). */
export function localeTextAccepted(text: string, locale: AiLocale): boolean {
  const scanned = text.replace(UNTRANSLATED, " ");
  if (locale === "en-SG") return !CJK.test(scanned);
  const meaningful = scanned.replace(/[\s\p{P}\p{S}\d]/gu, "");
  return meaningful.length === 0 || (CJK.test(scanned) && (scanned.match(LATIN_WORD) ?? []).length <= 2);
}

function checkLocale(output: Extract<AiTaskOutput, { outcome: "SUCCESS" }>, provider: ProviderTaskRequest): void {
  for (const raw of generatedTexts(output)) if (!localeTextAccepted(withoutQuotations(raw, provider.facts), provider.locale)) reject("LOCALE_INVALID");
}

/** A conservative generated-text ceiling derived from the bundle's output token ceiling. */
export const OUTPUT_CODE_POINTS_PER_TOKEN = 1.5;

function checkBudget(output: Extract<AiTaskOutput, { outcome: "SUCCESS" }>, bundle: AiTaskRuntimeBundle): void {
  const generated = generatedTexts(output).reduce((total, text) => total + [...text].length, 0);
  if (generated > bundle.executionBudget.outputTokenCeiling * OUTPUT_CODE_POINTS_PER_TOKEN) reject("OUTPUT_BUDGET_EXCEEDED");
  if (output.taskType === "EXTRACT_CANDIDATE_FACTS" && bundle.executionBudget.maxOutputItems !== undefined && output.payload.candidates.length > bundle.executionBudget.maxOutputItems) {
    reject("OUTPUT_BUDGET_EXCEEDED");
  }
}

export function validateAiTaskOutput(request: AiTaskRequest, bundle: AiTaskRuntimeBundle, candidate: unknown): AiValidationResult {
  const projection = projectProviderTaskPayload(request, bundle);
  if (projection.kind === "FALLBACK") return { kind: "REJECTED", reason: projection.reason, repairable: false };
  const provider = projection.payload;
  const structural = (): AiValidationResult => ({ kind: "REJECTED", reason: "SCHEMA_INVALID", repairable: bundle.executionBudget.structuralRepairAllowed });
  try {
    // 1–2. Strict JSON and the exact task, schema version and locale.
    const parsed = aiTaskOutputSchema.safeParse(parseCandidate(candidate));
    if (!parsed.success) return structural();
    const output = parsed.data;
    if (output.taskType !== provider.taskType || output.schemaVersion !== `${bundle.outputSchema.id}@${bundle.outputSchema.version}`) return structural();
    if (output.locale !== provider.locale) return { kind: "REJECTED", reason: "LOCALE_INVALID", repairable: false };
    const declared = new Set([...provider.facts.map((fact) => fact.ref), ...payloadReferences(provider.taskType, provider.taskPayload).declared]);
    if (!subset(output.inputRefsUsed, declared)) return { kind: "REJECTED", reason: "REFERENCE_MISMATCH", repairable: false };
    if (output.outcome === "ABSTAIN") return { kind: "REJECTED", reason: "MODEL_ABSTAINED", repairable: false };
    // 3–7. References, fidelity, authority and meaning, locale, budget.
    checkReferences(output, provider);
    checkFidelity(output, provider);
    checkMeaning(output, provider);
    checkLocale(output, provider);
    checkBudget(output, bundle);
    return { kind: "ACCEPTED", output };
  } catch (error) {
    if (error instanceof Rejection) return error.reason === "SCHEMA_INVALID" ? structural() : { kind: "REJECTED", reason: error.reason, repairable: false };
    throw error;
  }
}
