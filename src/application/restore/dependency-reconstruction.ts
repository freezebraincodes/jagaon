import { reminderSources } from "@/application/care-plan/care-plan-command-service";
import { INTELLIGENCE_ACTIVATION_MANIFEST } from "@/application/intelligence/activation-manifest";
import { learnedKnowledgeDependencySources } from "@/application/intelligence/learning-dependencies";
import type { ReminderPayload } from "@/domain/care-plan/reminder";
import type { LearnedKnowledgeEvidence } from "@/domain/learning";
import { REVERSE_DEPENDENCY_EVALUATORS } from "@/storage/reverse-dependency-row";

/**
 * The single authoritative reverse-dependency validator (storage-backup-spec
 * 2.6, 5.7, 8.4, 8.6 step 1 and 8.7 step 2; Packet 10 Corrective Pass B).
 * Each enabled dependent owner's rule derives, from the dependent revision's
 * own canonical payload, the exact sources and roles it requires. Every other
 * governed field is fixed by that revision and the closed evaluator registry:
 * `dependentRecordType`/`dependentRecordId` are the dependent revision's,
 * `owner` is the evaluator's registered owner, `createdAt` is the instant the
 * owner committed the dependent revision (its `revisionCreatedAt`), and
 * `evaluatorVersion` is registered for the evaluator and shared by every edge
 * of one dependent revision. The stored set must equal the derived set
 * exactly: missing, surplus, duplicated, malformed or mismatched edges fail.
 * Restore runs it on the candidate, the plan target, the confirmed private
 * plan, inside the replacement transaction and again after commit. Results
 * carry only a closed reason; no row or value leaves.
 */

export type DependencyValidation = { kind: "VALID" } | { kind: "INVALID"; reason: "MALFORMED" | "DUPLICATE" | "SURPLUS" | "MISSING" | "MISMATCH" };

type RevisionRow = { recordType: string; recordId: string; revisionId: string; revisionNumber: number; revision: { revisionCreatedAt?: unknown; payload?: unknown } };
type Ref = { revisionId: string };
type Source = { revisionId: string; role: string };
type Derivation = { evaluatorKey: string | undefined; sources: Source[] };

const EDGE_FIELDS = Object.freeze(["sourceRevisionId", "dependentRecordType", "dependentRecordId", "dependentRevisionId", "dependencyRole", "owner", "evaluatorKey", "evaluatorVersion", "createdAt"] as const);
type Edge = Record<(typeof EDGE_FIELDS)[number], string>;
type ExpectedEdge = Omit<Edge, "evaluatorVersion">;

const refs = (value: unknown): Ref[] => (Array.isArray(value) ? (value as Ref[]).filter((ref) => typeof ref?.revisionId === "string") : []);

/** The one evaluator the closed registry declares for a dependent record type, if exactly one. */
function soleEvaluator(recordType: string): string | undefined {
  const keys = Object.entries(REVERSE_DEPENDENCY_EVALUATORS).filter(([, registration]) => registration.dependentRecordType === recordType);
  return keys.length === 1 ? keys[0]![0] : undefined;
}

/** A pattern snapshot names its family; the activation manifest binds the family to its evaluator. */
function patternEvaluator(family: unknown): string | undefined {
  const disposition = (INTELLIGENCE_ACTIVATION_MANIFEST.pattern as Record<string, { kind: string; evaluatorKey?: string }>)[String(family)];
  return disposition?.kind === "ENABLED" ? disposition.evaluatorKey : undefined;
}

/** Closed per-owner rules; a dependent type without a rule requires no edge. */
const RULES: Readonly<Record<string, (row: RevisionRow) => Derivation>> = Object.freeze({
  // Pattern engine: a new evidence snapshot names each evidence group (`<group>_EVIDENCE`)
  // and every revision it considered but excluded.
  PATTERN_EVIDENCE_SNAPSHOT: (row) => {
    const payload = row.revision.payload as { family?: unknown; evidenceGroups?: Array<{ role: string; revisions: unknown }>; consideredButExcluded?: Array<{ revision: Ref }> };
    return {
      evaluatorKey: patternEvaluator(payload?.family),
      sources: [
        ...(payload?.evidenceGroups ?? []).flatMap((group) => refs(group.revisions).map((ref) => ({ revisionId: ref.revisionId, role: `${group.role}_EVIDENCE` }))),
        ...(payload?.consideredButExcluded ?? []).filter((entry) => typeof entry?.revision?.revisionId === "string").map((entry) => ({ revisionId: entry.revision.revisionId, role: "CONSIDERED_EXCLUDED" })),
      ],
    };
  },
  // Learning engine: the shared writer rule over the revision's own evidence.
  LEARNED_KNOWLEDGE: (row) => {
    const evidence = (row.revision.payload as { evidence?: LearnedKnowledgeEvidence })?.evidence;
    return { evaluatorKey: soleEvaluator(row.recordType), sources: evidence ? learnedKnowledgeDependencySources(evidence) : [] };
  },
  // Inquiry: the creating revision records the exact basis it asks about.
  INQUIRY: (row) => ({
    evaluatorKey: soleEvaluator(row.recordType),
    sources: row.revisionNumber === 1 ? refs((row.revision.payload as { basis?: { records?: unknown } })?.basis?.records).map((ref) => ({ revisionId: ref.revisionId, role: "INQUIRY_BASIS" })) : [],
  }),
  // Care plan: every reminder revision depends on its subject target and appointment anchor.
  REMINDER: (row) => ({
    evaluatorKey: soleEvaluator(row.recordType),
    sources: reminderSources(row.revision.payload as ReminderPayload).map((ref) => ({ revisionId: ref.revisionId, role: "REMINDER_TARGET" })),
  }),
  // Care preparation: the prepared snapshot depends on every included source revision.
  CARE_SUMMARY_SNAPSHOT: (row) => ({
    evaluatorKey: soleEvaluator(row.recordType),
    sources:
      row.revisionNumber === 1
        ? refs((row.revision.payload as { selection?: { includedSourceRevisions?: unknown } })?.selection?.includedSourceRevisions).map((ref) => ({ revisionId: ref.revisionId, role: "CARE_SUMMARY_SOURCE" }))
        : [],
  }),
});

const keyOf = (edge: { sourceRevisionId: string; dependentRevisionId: string; dependencyRole: string }) => `${edge.sourceRevisionId}|${edge.dependentRevisionId}|${edge.dependencyRole}`;

/** Every edge current canonical revisions require, keyed by the edge primary key. */
export function expectedReverseDependencies(revisions: readonly unknown[]): Map<string, ExpectedEdge> {
  const expected = new Map<string, ExpectedEdge>();
  for (const row of revisions as RevisionRow[]) {
    const rule = RULES[row.recordType];
    if (!rule) continue;
    const { evaluatorKey, sources } = rule(row);
    const owner = evaluatorKey ? REVERSE_DEPENDENCY_EVALUATORS[evaluatorKey]?.owner : undefined;
    for (const source of sources) {
      const edge = {
        sourceRevisionId: source.revisionId,
        dependentRecordType: row.recordType,
        dependentRecordId: row.recordId,
        dependentRevisionId: row.revisionId,
        dependencyRole: source.role,
        owner: owner as string,
        evaluatorKey: evaluatorKey as string,
        createdAt: row.revision.revisionCreatedAt as string,
      };
      expected.set(keyOf(edge), edge);
    }
  }
  return expected;
}

export function validateReverseDependencies(revisions: readonly unknown[], edges: readonly unknown[]): DependencyValidation {
  const expected = expectedReverseDependencies(revisions);
  const seen = new Set<string>();
  const versions = new Map<string, string>();
  for (const value of edges) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return { kind: "INVALID", reason: "MALFORMED" };
    const edge = value as Edge;
    if (Object.keys(edge).length !== EDGE_FIELDS.length || EDGE_FIELDS.some((field) => typeof edge[field] !== "string")) return { kind: "INVALID", reason: "MALFORMED" };
    const key = keyOf(edge);
    if (seen.has(key)) return { kind: "INVALID", reason: "DUPLICATE" };
    seen.add(key);
    const want = expected.get(key);
    if (!want) return { kind: "INVALID", reason: "SURPLUS" };
    if ((Object.keys(want) as Array<keyof ExpectedEdge>).some((field) => edge[field] !== want[field])) return { kind: "INVALID", reason: "MISMATCH" };
    if (!REVERSE_DEPENDENCY_EVALUATORS[edge.evaluatorKey]?.versions.includes(edge.evaluatorVersion)) return { kind: "INVALID", reason: "MISMATCH" };
    const version = versions.get(edge.dependentRevisionId);
    if (version !== undefined && version !== edge.evaluatorVersion) return { kind: "INVALID", reason: "MISMATCH" };
    versions.set(edge.dependentRevisionId, edge.evaluatorVersion);
  }
  if (seen.size !== expected.size) return { kind: "INVALID", reason: "MISSING" };
  return { kind: "VALID" };
}
