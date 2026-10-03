import type { RecordType } from "@/domain/shared/record-catalogue";
import type { TypedRevisionRef } from "@/domain/shared/typed-revision-ref";
import type {
  PatternClaim,
  PatternEvidenceSnapshotPayload,
  PatternLifecycle,
} from "@/domain/patterns";
import { fingerprint, sortRevisionRefs } from "@/application/intelligence/metrics";
import type { PatternEvaluationResult, PreviousPatternChain } from "./pattern-evaluator-contracts";

/**
 * Meaningful state of an observation: claim, lifecycle and the snapshot's
 * evidence, exclusions, coverage, gate, facts and limitations. The evaluation
 * instant and the moving query windows are excluded, so re-running on the
 * same evidence later yields NO_CHANGE instead of an endless revision chain.
 */
export function meaningfulStateFingerprint(
  claim: PatternClaim,
  lifecycle: PatternLifecycle,
  snapshot: PatternEvidenceSnapshotPayload,
): string {
  const facts = snapshot.facts as unknown as Record<string, unknown>;
  const stableFacts = { ...facts };
  for (const segment of ["reference", "recent"]) {
    const value = stableFacts[segment] as Record<string, unknown> | undefined;
    if (value && "window" in value) {
      stableFacts[segment] = { ...value, window: null };
    }
  }
  return fingerprint({
    claim,
    lifecycle,
    snapshot: {
      family: snapshot.family,
      ruleVersions: snapshot.ruleVersions,
      evidenceGroups: snapshot.evidenceGroups.map((group) => ({ role: group.role, revisions: sortRevisionRefs(group.revisions) })),
      consideredButExcluded: [...snapshot.consideredButExcluded].sort((a, b) =>
        a.revision.revisionId < b.revision.revisionId ? -1 : a.revision.revisionId > b.revision.revisionId ? 1 : 0,
      ),
      coverage: snapshot.coverage,
      gate: snapshot.gate,
      facts: stableFacts,
      limitations: [...snapshot.limitations].sort(),
    },
  });
}

export function observationRef(previous: PreviousPatternChain) {
  return {
    recordType: "PATTERN_OBSERVATION" as const,
    recordId: previous.observation.recordId,
    revisionId: previous.observation.revisionId,
  };
}

/** Lifecycles that a 7A evaluator must never resurface or overwrite. */
export function isTerminalForEvaluator(lifecycle: PatternLifecycle): boolean {
  return lifecycle.state === "REJECTED" || lifecycle.state === "RETIRED" || lifecycle.state === "SUPERSEDED";
}

/**
 * Downgrade a previous chain when current evidence no longer supports it,
 * reusing the exact earlier snapshot: SUPPORTED becomes WEAKENING, any
 * other active state becomes STALE, and a chain already there is unchanged.
 */
export function downgradePrevious(
  family: PatternEvaluationResult["family"],
  candidateKey: string,
  previous: PreviousPatternChain,
  staleNow: boolean,
): PatternEvaluationResult {
  const current = previous.observation.payload.lifecycle;
  let lifecycle: PatternLifecycle | null = null;
  if (current.state === "SUPPORTED") {
    lifecycle = staleNow ? { state: "STALE" } : { state: "WEAKENING", previouslySupported: observationRef(previous) };
  } else if (current.state === "WEAKENING") {
    lifecycle = staleNow ? { state: "STALE" } : null;
  } else if (current.state !== "STALE") {
    lifecycle = { state: "STALE" };
  }
  if (lifecycle === null) return { kind: "NO_CHANGE", family, candidateKey };
  return {
    kind: "PROPOSAL",
    family,
    candidateKey,
    claim: previous.observation.payload.claim,
    lifecycle,
    snapshot: { kind: "REUSE" },
    reasonCode: "PATTERN_OBSERVATION_TRANSITIONED",
    sourceRoles: [],
    limitationCodes: [...previous.snapshot.payload.limitations],
  };
}

/** Decide CREATED / REVISED / NO_CHANGE for a freshly computed observation. */
export function finaliseProposal(
  proposal: Extract<PatternEvaluationResult, { kind: "PROPOSAL" }>,
  previous: PreviousPatternChain | null,
): PatternEvaluationResult {
  if (proposal.snapshot.kind !== "NEW") return proposal;
  if (previous === null) return { ...proposal, reasonCode: "PATTERN_OBSERVATION_CREATED" };
  const before = meaningfulStateFingerprint(
    previous.observation.payload.claim,
    previous.observation.payload.lifecycle,
    previous.snapshot.payload,
  );
  const after = meaningfulStateFingerprint(proposal.claim, proposal.lifecycle, proposal.snapshot.payload);
  if (before === after) return { kind: "NO_CHANGE", family: proposal.family, candidateKey: proposal.candidateKey };
  return { ...proposal, reasonCode: "PATTERN_OBSERVATION_REVISED" };
}

export function inputFingerprintOf(value: {
  evaluatorKey: string;
  evaluatorVersion: string;
  configurationVersion: string;
  evaluatedAt: string;
  inputSequenceCutoff: number;
  candidateKey: string;
  sources: readonly TypedRevisionRef<RecordType>[];
  superseded: readonly TypedRevisionRef<RecordType>[];
  previous: PreviousPatternChain | null;
}) {
  return fingerprint({
    ...value,
    sources: sortRevisionRefs(value.sources),
    superseded: sortRevisionRefs(value.superseded),
    previous: value.previous
      ? { observation: value.previous.observation.revisionId, snapshot: value.previous.snapshot.revisionId }
      : null,
  });
}
