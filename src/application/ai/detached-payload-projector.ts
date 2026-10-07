import { CARE_SUMMARY_SOURCE_FIELD_KEYS } from "@/domain/care-preparation/care-summary-snapshot";
import { aiTaskRequestSchema, payloadReferences, providerTaskRequestSchema, type AiRequestFact, type AiTaskRequest, type AiTaskType, type ProviderFact, type ProviderTaskRequest } from "@/domain/ai/ai-task-contracts";
import { approvedClaimMeaning, renderExplainLimitations } from "./ai-meaning-registry";
import type { AiTaskRuntimeBundle } from "./ai-runtime-bundles";

/**
 * Packet 11A detached provider payload projector (ai-system-spec Sections 7,
 * 7.1, 14.2; design Section 7). It fails closed: a request outside its task
 * allowlist, budget or redaction boundary yields a typed fallback reason and
 * nothing is transmitted. It never truncates or generalises meaning; the only
 * registered reduction is identifier redaction inside selected free text.
 * Local provenance stays in the returned reference map, never in the payload.
 */

type FactField = (typeof CARE_SUMMARY_SOURCE_FIELD_KEYS)[number];

/** Per-task allowlists. Medication, prescription, dose and every Safety field never cross the boundary. */
export const AI_FIELD_ALLOWLISTS: Readonly<Record<AiTaskType, readonly FactField[]>> = Object.freeze({
  EXTRACT_CANDIDATE_FACTS: Object.freeze(["PATIENT_AUTHORED_TEXT", "INTAKE_KIND", "INTAKE_LABEL", "ACTIVITY_LABEL", "OCCURRENCE_TIME"] as const),
  // Option B: limitation data never reaches the model, so PATTERN_LIMITATION is not an EXPLAIN_PATTERN fact field.
  EXPLAIN_PATTERN: Object.freeze(["MEASUREMENT_VALUE", "MEASUREMENT_METHOD", "OCCURRENCE_TIME", "EFFECTIVE_INTERVAL", "EVIDENCE_COUNT", "PATTERN_CLAIM", "PATTERN_MATURITY", "INTAKE_LABEL", "ACTIVITY_LABEL", "UNCERTAINTY"] as const),
  DRAFT_NEUTRAL_INQUIRY: Object.freeze(["OCCURRENCE_TIME", "RECORDED_STATUS", "EVIDENCE_COUNT", "INTAKE_KIND", "INTAKE_LABEL", "ACTIVITY_LABEL", "UNCERTAINTY"] as const),
  ANSWER_BOUNDED_RECORD_QUERY: Object.freeze(["MEASUREMENT_VALUE", "MEASUREMENT_METHOD", "KETONE_RESULT", "OCCURRENCE_TIME", "EFFECTIVE_INTERVAL", "RECORDED_STATUS", "INTAKE_KIND", "INTAKE_LABEL", "ACTIVITY_LABEL", "ACTIVITY_DURATION", "ACTIVITY_INTENSITY", "UNCERTAINTY"] as const),
  DRAFT_CARE_PREPARATION_SUMMARY: Object.freeze([
    "CONDITION_LABEL", "MEASUREMENT_VALUE", "MEASUREMENT_METHOD", "KETONE_RESULT", "OCCURRENCE_TIME", "EFFECTIVE_INTERVAL", "RECORDED_STATUS",
    "INTAKE_KIND", "INTAKE_LABEL", "ACTIVITY_LABEL", "ACTIVITY_DURATION", "ACTIVITY_INTENSITY", "APPOINTMENT_SERVICE", "APPOINTMENT_TIME",
    "CARE_ITEM_LABEL", "CARE_ITEM_STATUS", "QUESTION_TEXT", "QUESTION_PURPOSE", "PATTERN_CLAIM", "PATTERN_MATURITY", "PATTERN_LIMITATION",
    "EVIDENCE_COUNT", "PROVENANCE_CLASS", "UNCERTAINTY",
  ] as const),
  PHRASE_NON_CLINICAL_RESPONSE: Object.freeze(["RECORDED_STATUS", "EVIDENCE_COUNT"] as const),
});

export type ProviderReferenceMap = Readonly<Record<string, { sources: AiRequestFact["sources"] }>>;
export type ProviderProjectionResult =
  | { kind: "PROJECTED"; payload: ProviderTaskRequest; referenceMap: ProviderReferenceMap }
  | { kind: "FALLBACK"; reason: "PAYLOAD_INVALID" | "PRIVACY_REJECTED" | "BUDGET_EXCEEDED" };

export const REDACTION_TOKEN = "[REDACTED]";

/** Identifier patterns removed from selected text before transmission (Section 7.1). */
const IDENTIFIER_PATTERNS: readonly RegExp[] = [
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, // local identifiers
  /\b[STFGM]\d{7}[A-Z]\b/gi, // NRIC / FIN
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, // email
  /(?:\+65[\s-]?)?\b[689]\d{3}[\s-]?\d{4}\b/g, // Singapore phone
  /\b\d{6}\b/g, // Singapore postal code
  /\b(?:https?:\/\/|www\.)\S+/gi, // links
];

/** Redacts identifiers; returns null when no meaningful text would remain. */
export function redactSelectedText(text: string): string | null {
  let redacted = text;
  for (const pattern of IDENTIFIER_PATTERNS) redacted = redacted.replace(pattern, REDACTION_TOKEN);
  const meaningful = redacted.split(REDACTION_TOKEN).join("").replace(/[\s\p{P}\p{S}\d]/gu, "");
  return meaningful.length === 0 ? null : redacted;
}

const codePoints = (text: string) => [...text].length;
const DAY_MS = 86_400_000;
const dayNumber = (localDate: string) => Date.parse(`${localDate}T00:00:00Z`) / DAY_MS;

function periodDays(facts: readonly AiRequestFact[]): number {
  const days: number[] = [];
  for (const fact of facts) {
    if (fact.value.kind === "DATE") days.push(dayNumber(fact.value.localDate));
    if (fact.value.kind === "DATE_RANGE") days.push(dayNumber(fact.value.startDate), dayNumber(fact.value.endDate));
  }
  return days.length === 0 ? 0 : Math.max(...days) - Math.min(...days) + 1;
}

function recordCount(request: AiTaskRequest): number {
  return request.taskType === "ANSWER_BOUNDED_RECORD_QUERY" ? request.taskPayload.records.length : 0;
}

export function projectProviderTaskPayload(request: AiTaskRequest, bundle: AiTaskRuntimeBundle): ProviderProjectionResult {
  const parsed = aiTaskRequestSchema.safeParse(request);
  if (!parsed.success) return { kind: "FALLBACK", reason: "PAYLOAD_INVALID" };
  const valid = parsed.data;
  if (bundle.taskType !== valid.taskType || bundle.bundleKey !== valid.runtimeBundleKey) return { kind: "FALLBACK", reason: "PAYLOAD_INVALID" };

  const allowed = new Set<string>(AI_FIELD_ALLOWLISTS[valid.taskType]);
  if (valid.facts.some((fact) => !allowed.has(fact.field))) return { kind: "FALLBACK", reason: "PRIVACY_REJECTED" };

  const budget = bundle.executionBudget;
  if (valid.facts.length > budget.maxFacts) return { kind: "FALLBACK", reason: "BUDGET_EXCEEDED" };
  if (budget.maxRecords !== undefined && recordCount(valid) > budget.maxRecords) return { kind: "FALLBACK", reason: "BUDGET_EXCEEDED" };
  if (budget.maxPeriodDays !== undefined && periodDays(valid.facts) > budget.maxPeriodDays) return { kind: "FALLBACK", reason: "BUDGET_EXCEEDED" };
  if (budget.maxExcerptCodePoints !== undefined && valid.facts.some((fact) => fact.value.kind === "TEXT" && codePoints(fact.value.text) > budget.maxExcerptCodePoints!)) {
    return { kind: "FALLBACK", reason: "BUDGET_EXCEEDED" };
  }

  const facts: ProviderFact[] = [];
  for (const fact of valid.facts) {
    const { sources: _sources, ...providerFact } = fact;
    void _sources;
    if (providerFact.value.kind === "TEXT") {
      const text = redactSelectedText(providerFact.value.text);
      if (text === null) return { kind: "FALLBACK", reason: "PRIVACY_REJECTED" };
      facts.push({ ...providerFact, value: { ...providerFact.value, text } });
    } else {
      facts.push(providerFact as ProviderFact);
    }
  }

  let taskPayload: unknown = structuredClone(valid.taskPayload);
  if (valid.taskType === "EXPLAIN_PATTERN") {
    // Option B: the claim carries the registry's approved meaning; limitations stay local. A family or
    // limitation without an approved entry in this locale falls back before any provider call.
    const approvedMeaning = approvedClaimMeaning(valid.taskPayload.claim.family, valid.locale);
    if (approvedMeaning === null || !renderExplainLimitations(valid.taskPayload.limitations, valid.locale).complete) return { kind: "FALLBACK", reason: "PAYLOAD_INVALID" };
    const { ref, family, factRefs } = valid.taskPayload.claim;
    taskPayload = { claim: { ref, family, approvedMeaning, factRefs: [...factRefs] } };
  }
  const payload = { taskType: valid.taskType, locale: valid.locale, runtimeBundleKey: valid.runtimeBundleKey, facts, taskPayload };
  const checked = providerTaskRequestSchema.safeParse(payload);
  if (!checked.success) return { kind: "FALLBACK", reason: "PAYLOAD_INVALID" };
  // A conservative pre-transmission ceiling: at least one token per code point of the detached payload.
  if (codePoints(JSON.stringify(checked.data)) > budget.inputTokenCeiling) return { kind: "FALLBACK", reason: "BUDGET_EXCEEDED" };

  const referenceMap: Record<string, { sources: AiRequestFact["sources"] }> = {};
  for (const fact of valid.facts) referenceMap[fact.ref] = { sources: structuredClone(fact.sources) };
  for (const ref of payloadReferences(checked.data.taskType, checked.data.taskPayload).declared) referenceMap[ref] = { sources: [] };
  return { kind: "PROJECTED", payload: checked.data, referenceMap: Object.freeze(referenceMap) };
}
