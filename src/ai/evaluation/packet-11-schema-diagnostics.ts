import type { ZodIssue } from "zod";
import { AI_TASK_RUNTIME_BUNDLES } from "@/application/ai/ai-runtime-bundles";
import { parseStrictJson, toPlainData } from "@/backup/strict-json";
import { aiTaskOutputVariantSchema, type AiLocale } from "@/domain/ai";
import { PACKET_11_FIXTURES, type AiEvaluationFixture } from "./packet-11-fixtures";

/**
 * Packet 11B offline, evaluation-only schema-failure diagnostic (owner
 * instruction 2026-10-06). It explains a SCHEMA_INVALID rejection without
 * changing it: the 11A validator still decides, and production callers still
 * receive only the closed reason. Rules come from the unchanged 11A output
 * contract: the exact SUCCESS/ABSTAIN variant object for the fixture's task,
 * plus the validator's exact schema-version check. Findings carry only closed
 * categories, schema-defined paths, closed rule identifiers, counts and the
 * contract's own numeric boundaries. Zod messages, received values, unknown
 * property names and raw JSON are never read into the result. Strict zod
 * objects reject additional properties, so that case is UNKNOWN_FIELD_PRESENT.
 * Nothing outside src/ai/evaluation may import this module.
 */

export const SCHEMA_DIAGNOSTIC_CATEGORIES = Object.freeze([
  "ROOT_TYPE_INVALID",
  "REQUIRED_FIELD_MISSING",
  "UNKNOWN_FIELD_PRESENT",
  "FIELD_TYPE_INVALID",
  "ENUM_INVALID",
  "ARRAY_TOO_SHORT",
  "ARRAY_TOO_LONG",
  "DUPLICATE_ITEM",
  "PATTERN_INVALID",
  "STRING_TOO_LONG",
  "STRING_TOO_SHORT",
  "OTHER_SCHEMA_INVALID",
] as const);
export const SCHEMA_DIAGNOSTIC_RULES = Object.freeze([
  "strict_json",
  "object",
  "required",
  "strict_object",
  "type",
  "enum",
  "literal",
  "min_items",
  "max_items",
  "unique",
  "pattern",
  "max_length",
  "min_length",
  "min_value",
  "max_value",
  "exact_schema_version",
  "refinement",
  "other",
] as const);
export type SchemaDiagnosticCategory = (typeof SCHEMA_DIAGNOSTIC_CATEGORIES)[number];
export type SchemaDiagnosticRule = (typeof SCHEMA_DIAGNOSTIC_RULES)[number];

export type SchemaFinding = Readonly<{ category: SchemaDiagnosticCategory; path: string; rule: SchemaDiagnosticRule; count: number; boundary: number | null }>;
export type SchemaFailureDiagnostic = Readonly<{
  version: "packet11-schemadiag.1";
  fixtureId: string | null;
  taskType: string;
  locale: AiLocale;
  findings: readonly SchemaFinding[];
}>;

/** Every property name the 11A output contract defines for the envelope and the two remote payloads. */
const CONTRACT_KEYS = new Set([
  "schemaVersion",
  "taskType",
  "outcome",
  "locale",
  "inputRefsUsed",
  "payload",
  "abstentionReason",
  "headline",
  "observation",
  "evidence",
  "limitations",
  "text",
  "claimRefs",
  "factRefs",
  "limitationRef",
  "sections",
  "sectionRef",
  "bullets",
]);
const MAX_FINDINGS = 32;

/** A schema-defined path: contract keys joined by ".", array positions as "[]", root as "$". */
function closedPath(path: ReadonlyArray<string | number>): string {
  let result = "";
  for (const segment of path) {
    if (typeof segment === "number") result += "[]";
    else result += `${result ? "." : ""}${CONTRACT_KEYS.has(segment) ? segment : "<unrecognised>"}`;
  }
  return result || "$";
}

function classify(issue: ZodIssue): { category: SchemaDiagnosticCategory; rule: SchemaDiagnosticRule; count: number; boundary: number | null; path: ReadonlyArray<string | number> } {
  const base = { count: 1, boundary: null, path: issue.path };
  switch (issue.code) {
    case "invalid_type":
      if (issue.path.length === 0) return { ...base, category: "ROOT_TYPE_INVALID", rule: "object" };
      return issue.received === "undefined" ? { ...base, category: "REQUIRED_FIELD_MISSING", rule: "required" } : { ...base, category: "FIELD_TYPE_INVALID", rule: "type" };
    case "unrecognized_keys":
      // Only the known parent path and how many; never the provider-supplied names.
      return { ...base, category: "UNKNOWN_FIELD_PRESENT", rule: "strict_object", count: issue.keys.length };
    case "invalid_literal":
      return { ...base, category: "ENUM_INVALID", rule: "literal" };
    case "invalid_enum_value":
      return { ...base, category: "ENUM_INVALID", rule: "enum" };
    case "too_small":
      if (issue.type === "array") return { ...base, category: "ARRAY_TOO_SHORT", rule: "min_items", boundary: Number(issue.minimum) };
      if (issue.type === "string") return { ...base, category: "STRING_TOO_SHORT", rule: "min_length", boundary: Number(issue.minimum) };
      return { ...base, category: "OTHER_SCHEMA_INVALID", rule: "min_value", boundary: Number(issue.minimum) };
    case "too_big":
      if (issue.type === "array") return { ...base, category: "ARRAY_TOO_LONG", rule: "max_items", boundary: Number(issue.maximum) };
      if (issue.type === "string") return { ...base, category: "STRING_TOO_LONG", rule: "max_length", boundary: Number(issue.maximum) };
      return { ...base, category: "OTHER_SCHEMA_INVALID", rule: "max_value", boundary: Number(issue.maximum) };
    case "invalid_string":
      return { ...base, category: "PATTERN_INVALID", rule: "pattern" };
    case "custom":
      // The contract's uniqueness refinement is the only custom output rule on these tasks.
      return issue.message === "DUPLICATE_ENTRY" ? { ...base, category: "DUPLICATE_ITEM", rule: "unique" } : { ...base, category: "OTHER_SCHEMA_INVALID", rule: "refinement" };
    default:
      return { ...base, category: "OTHER_SCHEMA_INVALID", rule: "other" };
  }
}

export function diagnoseSchemaFailure(fixture: AiEvaluationFixture, candidate: unknown): SchemaFailureDiagnostic | null {
  const known = PACKET_11_FIXTURES.includes(fixture);
  const finish = (findings: SchemaFinding[]): SchemaFailureDiagnostic | null =>
    findings.length === 0 ? null : Object.freeze({ version: "packet11-schemadiag.1", fixtureId: known ? fixture.id : null, taskType: fixture.taskType, locale: fixture.locale, findings: Object.freeze(findings) });

  let value = candidate;
  if (typeof value === "string") {
    try {
      value = toPlainData(parseStrictJson(value, { maxDepth: 16, maxLength: 65_536 }));
    } catch {
      return finish([{ category: "ROOT_TYPE_INVALID", path: "$", rule: "strict_json", count: 1, boundary: null }]);
    }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return finish([{ category: "ROOT_TYPE_INVALID", path: "$", rule: "object", count: 1, boundary: null }]);

  // The exact contract variant for the fixture's task: ABSTAIN when the candidate says so, otherwise SUCCESS.
  const outcome = (value as { outcome?: unknown }).outcome === "ABSTAIN" ? "ABSTAIN" : "SUCCESS";
  const parsed = aiTaskOutputVariantSchema(fixture.taskType, outcome).safeParse(value);
  const findings = new Map<string, { category: SchemaDiagnosticCategory; path: string; rule: SchemaDiagnosticRule; count: number; boundary: number | null }>();
  const add = (category: SchemaDiagnosticCategory, path: string, rule: SchemaDiagnosticRule, count: number, boundary: number | null) => {
    const key = `${category}|${path}|${rule}|${boundary}`;
    const entry = findings.get(key) ?? { category, path, rule, count: 0, boundary };
    entry.count += count;
    findings.set(key, entry);
  };
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const finding = classify(issue);
      add(finding.category, closedPath(finding.path), finding.rule, finding.count, finding.boundary);
    }
  } else {
    // The validator's exact schema-version rule (a regex-valid but different version is still SCHEMA_INVALID).
    const bundle = AI_TASK_RUNTIME_BUNDLES[fixture.taskType];
    if ((value as { schemaVersion?: unknown }).schemaVersion !== `${bundle.outputSchema.id}@${bundle.outputSchema.version}`) add("OTHER_SCHEMA_INVALID", "schemaVersion", "exact_schema_version", 1, null);
  }
  const ordered = [...findings.values()]
    .sort((a, b) => a.category.localeCompare(b.category) || a.path.localeCompare(b.path) || a.rule.localeCompare(b.rule))
    .slice(0, MAX_FINDINGS)
    .map((entry): SchemaFinding => Object.freeze({ ...entry }));
  return finish(ordered);
}
