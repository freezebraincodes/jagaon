import type { LearnedKnowledgeEvidence } from "@/domain/learning";
import type { RevisionId } from "@/domain/shared";

/**
 * The exact sources one learned-knowledge revision depends on, derived from
 * its own persisted evidence (registry `learning.familiar-item`: supporting
 * and contradicting evidence). The Learning writer and restore dependency
 * reconstruction both use this rule, so they cannot disagree. Related
 * revisions of a direct statement have no registered role and form no edge.
 */
export type LearnedKnowledgeDependencyRole = "SUPPORTING_EVIDENCE" | "CONTRADICTING_EVIDENCE";

export function learnedKnowledgeDependencySources(evidence: LearnedKnowledgeEvidence): Array<{ revisionId: RevisionId; role: LearnedKnowledgeDependencyRole }> {
  return [
    ...(evidence.kind === "OBSERVATION_SET" ? evidence.supportingRevisions : []).map((ref) => ({ revisionId: ref.revisionId, role: "SUPPORTING_EVIDENCE" as const })),
    ...evidence.contradictingRevisions.map((ref) => ({ revisionId: ref.revisionId, role: "CONTRADICTING_EVIDENCE" as const })),
  ];
}
