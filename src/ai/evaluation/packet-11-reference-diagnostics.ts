import { parseStrictJson, toPlainData } from "@/backup/strict-json";
import { aiTaskOutputSchema, payloadReferences, type AiTaskOutput } from "@/domain/ai";
import { PACKET_11_FIXTURES, type AiEvaluationFixture } from "./packet-11-fixtures";

/**
 * Packet 11B offline, evaluation-only reference-closure diagnostic (owner
 * approval 2026-10-05). It explains a REFERENCE_MISMATCH without changing it:
 * the 11A validator still decides, and production callers still receive only
 * the closed reason. The diagnostic records closed categories, closed
 * reference kinds, closed output paths and counts. A reference value is
 * recorded only when it is one of the shipped synthetic fixture's own
 * request-local identifiers; an invented or unsupplied identifier is never
 * recorded, and output that is not a strict-schema SUCCESS envelope is not
 * inspected at all. Nothing outside src/ai/evaluation may import this module.
 */

export const REFERENCE_DIAGNOSTIC_CATEGORIES = Object.freeze(["INVENTED_OR_UNSUPPLIED_REFERENCE", "CITED_REFERENCE_NOT_LISTED", "REFERENCE_OUTSIDE_PERMITTED_SCOPE"] as const);
export const REFERENCE_DIAGNOSTIC_KINDS = Object.freeze(["CLAIM", "FACT", "LIMITATION", "SECTION", "OTHER_LOCAL", "UNRECOGNISED"] as const);
export const REFERENCE_DIAGNOSTIC_PATHS = Object.freeze([
  "inputRefsUsed",
  "headline.claimRefs",
  "observation.claimRefs",
  "evidence.factRefs",
  "sections.sectionRef",
  "sections.bullets.factRefs",
] as const);

export type ReferenceDiagnosticCategory = (typeof REFERENCE_DIAGNOSTIC_CATEGORIES)[number];
export type ReferenceDiagnosticKind = (typeof REFERENCE_DIAGNOSTIC_KINDS)[number];
export type ReferenceDiagnosticPath = (typeof REFERENCE_DIAGNOSTIC_PATHS)[number];

export type ReferenceFinding = Readonly<{
  category: ReferenceDiagnosticCategory;
  referenceKind: ReferenceDiagnosticKind;
  path: ReferenceDiagnosticPath;
  count: number;
  /** Only identifiers that the shipped synthetic fixture itself supplied; never a provider-invented value. */
  fixtureReferences: readonly string[];
}>;

export type ReferenceClosureDiagnostic = Readonly<{
  version: "packet11-refdiag.1";
  /** The shipped fixture id, or null for any other request (then no identifier is recorded). */
  fixtureId: string | null;
  taskType: "EXPLAIN_PATTERN" | "DRAFT_CARE_PREPARATION_SUMMARY";
  findings: readonly ReferenceFinding[];
}>;

function kindOf(reference: string): ReferenceDiagnosticKind {
  const prefix = /^(claim|fact|limitation|section|option|record)-[1-9]\d{0,2}$/.exec(reference)?.[1];
  if (prefix === "claim") return "CLAIM";
  if (prefix === "fact") return "FACT";
  if (prefix === "limitation") return "LIMITATION";
  if (prefix === "section") return "SECTION";
  return prefix ? "OTHER_LOCAL" : "UNRECOGNISED";
}

function strictSuccess(fixture: AiEvaluationFixture, candidate: unknown): Extract<AiTaskOutput, { outcome: "SUCCESS" }> | null {
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
  return parsed.data as Extract<AiTaskOutput, { outcome: "SUCCESS" }>;
}

export function diagnoseReferenceClosure(fixture: AiEvaluationFixture, candidate: unknown): ReferenceClosureDiagnostic | null {
  if (fixture.taskType !== "EXPLAIN_PATTERN" && fixture.taskType !== "DRAFT_CARE_PREPARATION_SUMMARY") return null;
  const output = strictSuccess(fixture, candidate);
  if (!output) return null;

  const request = fixture.request;
  const known = PACKET_11_FIXTURES.includes(fixture);
  // Declared exactly as the provider saw them: Option B keeps EXPLAIN_PATTERN limitation references local.
  const providerPayload = request.taskType === "EXPLAIN_PATTERN" ? { claim: request.taskPayload.claim } : request.taskPayload;
  const declared = new Set([...request.facts.map((fact) => fact.ref), ...payloadReferences(request.taskType, providerPayload).declared]);
  const used = new Set(output.inputRefsUsed);
  const findings = new Map<string, { category: ReferenceDiagnosticCategory; referenceKind: ReferenceDiagnosticKind; path: ReferenceDiagnosticPath; count: number; references: Set<string> }>();
  const note = (category: ReferenceDiagnosticCategory, path: ReferenceDiagnosticPath, reference: string) => {
    const referenceKind = kindOf(reference);
    const key = `${category}|${path}|${referenceKind}`;
    const entry = findings.get(key) ?? { category, referenceKind, path, count: 0, references: new Set<string>() };
    entry.count += 1;
    // Only the fixture's own supplied identifiers may be recorded; invented values never are.
    if (known && declared.has(reference) && category !== "INVENTED_OR_UNSUPPLIED_REFERENCE") entry.references.add(reference);
    findings.set(key, entry);
  };
  /** Mirrors the validator's closure: within scope and listed in inputRefsUsed. */
  const check = (path: ReferenceDiagnosticPath, references: readonly string[], scope: ReadonlySet<string>) => {
    for (const reference of references) {
      if (!scope.has(reference)) note(declared.has(reference) ? "REFERENCE_OUTSIDE_PERMITTED_SCOPE" : "INVENTED_OR_UNSUPPLIED_REFERENCE", path, reference);
      else if (!used.has(reference)) note("CITED_REFERENCE_NOT_LISTED", path, reference);
    }
  };

  for (const reference of output.inputRefsUsed) if (!declared.has(reference)) note("INVENTED_OR_UNSUPPLIED_REFERENCE", "inputRefsUsed", reference);

  if (output.taskType === "EXPLAIN_PATTERN" && request.taskType === "EXPLAIN_PATTERN") {
    const payload = request.taskPayload;
    check("headline.claimRefs", output.payload.headline.claimRefs, new Set([payload.claim.ref]));
    check("observation.claimRefs", output.payload.observation.claimRefs, new Set([payload.claim.ref]));
    check("evidence.factRefs", output.payload.evidence.factRefs, new Set(payload.claim.factRefs));
  }
  if (output.taskType === "DRAFT_CARE_PREPARATION_SUMMARY" && request.taskType === "DRAFT_CARE_PREPARATION_SUMMARY") {
    const sections = new Map(request.taskPayload.sections.map((section) => [section.ref, new Set(section.factRefs)]));
    for (const section of output.payload.sections) {
      check("sections.sectionRef", [section.sectionRef], new Set(sections.keys()));
      const own = sections.get(section.sectionRef);
      // A bullet's scope is its own supplied section; under an unknown section there is no scope to judge.
      if (own) check("sections.bullets.factRefs", section.bullets.flatMap((bullet) => bullet.factRefs), own);
    }
  }

  if (findings.size === 0) return null;
  const ordered = [...findings.values()]
    .map((entry): ReferenceFinding => ({ category: entry.category, referenceKind: entry.referenceKind, path: entry.path, count: entry.count, fixtureReferences: [...entry.references].sort() }))
    .sort((a, b) => a.category.localeCompare(b.category) || a.path.localeCompare(b.path) || a.referenceKind.localeCompare(b.referenceKind));
  return Object.freeze({ version: "packet11-refdiag.1", fixtureId: known ? fixture.id : null, taskType: fixture.taskType, findings: Object.freeze(ordered) });
}
