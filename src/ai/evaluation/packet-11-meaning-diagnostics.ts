import { generatedTextFields, MEANING_RULES, meaningMatches, withoutQuotations, type MeaningCategory, type MeaningRule } from "@/application/ai/ai-meaning-rules";
import { AI_TASK_RUNTIME_BUNDLES } from "@/application/ai/ai-runtime-bundles";
import { projectProviderTaskPayload } from "@/application/ai/detached-payload-projector";
import { parseStrictJson, toPlainData } from "@/backup/strict-json";
import { aiTaskOutputSchema, type AiLocale, type AiTaskOutput } from "@/domain/ai";
import { PACKET_11_FIXTURES, type AiEvaluationFixture } from "./packet-11-fixtures";

/**
 * Packet 11B evaluation-only clinical-meaning diagnostic (owner instruction
 * 2026-10-06). It explains a CLINICAL_MEANING_VIOLATION or meaning-stage
 * AUTHORITY_BOUNDARY_VIOLATION without changing it: the 11A validator still
 * decides and production callers still receive only the closed reason. It
 * applies the identical shared rules (ai-meaning-rules) in the identical way.
 * The result holds closed categories, closed rule ids, schema-defined paths
 * and counts only: never generated wording, matched text or any provider
 * string. Nothing outside src/ai/evaluation may import this module.
 */

export const MEANING_DIAGNOSTIC_CATEGORIES = Object.freeze([
  "RISK",
  "CAUSATION",
  "CLINICAL_CLASSIFICATION",
  "PREDICTION",
  "DIAGNOSIS_OR_TRAJECTORY",
  "MEDICATION_ACTION",
  "DOSE_OR_MEDICINE_CHANGE",
  "ADHERENCE_JUDGEMENT",
  "TRIAGE_OR_EMERGENCY_INSTRUCTION",
  "FALSE_REASSURANCE",
  "CLINICAL_REVIEW_OR_RECIPIENT_CLAIM",
  "APPLICATION_ACTION_CLAIM",
] as const satisfies readonly MeaningCategory[]);
export type MeaningDiagnosticCategory = MeaningCategory;

/** The shared rules, as the diagnostic reports them (identical objects). */
export const MEANING_CLINICAL_RULES: readonly MeaningRule[] = Object.freeze(MEANING_RULES.filter((entry) => entry.kind === "CLINICAL"));
export const MEANING_AUTHORITY_RULES: readonly MeaningRule[] = Object.freeze(MEANING_RULES.filter((entry) => entry.kind === "AUTHORITY"));

export type MeaningFinding = Readonly<{ category: MeaningDiagnosticCategory; rule: string; path: string; count: number }>;
export type MeaningFailureDiagnostic = Readonly<{
  version: "packet11-meaningdiag.1";
  fixtureId: string | null;
  taskType: "EXPLAIN_PATTERN" | "DRAFT_CARE_PREPARATION_SUMMARY";
  locale: AiLocale;
  findings: readonly MeaningFinding[];
}>;

type Success = Extract<AiTaskOutput, { outcome: "SUCCESS" }>;

/** The validator's generated text fields, in its order, each with its schema-defined path. */
export function meaningTextFields(output: Success): Array<{ path: string; text: string }> {
  return generatedTextFields(output);
}

export function diagnoseMeaningFailure(fixture: AiEvaluationFixture, candidate: unknown): MeaningFailureDiagnostic | null {
  if (fixture.taskType !== "EXPLAIN_PATTERN" && fixture.taskType !== "DRAFT_CARE_PREPARATION_SUMMARY") return null;
  let value = candidate;
  if (typeof value === "string") {
    try {
      value = toPlainData(parseStrictJson(value, { maxDepth: 16, maxLength: 65_536 }));
    } catch {
      return null;
    }
  }
  const parsed = aiTaskOutputSchema.safeParse(value);
  if (!parsed.success || parsed.data.outcome !== "SUCCESS" || parsed.data.taskType !== fixture.taskType || parsed.data.locale !== fixture.locale) return null;
  const projected = projectProviderTaskPayload(fixture.request, AI_TASK_RUNTIME_BUNDLES[fixture.taskType]);
  if (projected.kind !== "PROJECTED") return null;

  const findings = new Map<string, { category: MeaningDiagnosticCategory; rule: string; path: string; count: number }>();
  for (const field of meaningTextFields(parsed.data as Success)) {
    // Exactly the validator's check: verbatim patient text removed, then the shared rules.
    for (const matched of meaningMatches(withoutQuotations(field.text, projected.payload.facts))) {
      const key = `${matched.id}|${field.path}`;
      const entry = findings.get(key) ?? { category: matched.category, rule: matched.id, path: field.path, count: 0 };
      entry.count += 1;
      findings.set(key, entry);
    }
  }
  if (findings.size === 0) return null;
  const ordered = [...findings.values()].sort((a, b) => a.category.localeCompare(b.category) || a.rule.localeCompare(b.rule) || a.path.localeCompare(b.path)).map((entry) => Object.freeze({ ...entry }));
  return Object.freeze({ version: "packet11-meaningdiag.1", fixtureId: PACKET_11_FIXTURES.includes(fixture) ? fixture.id : null, taskType: fixture.taskType, locale: fixture.locale, findings: Object.freeze(ordered) });
}
