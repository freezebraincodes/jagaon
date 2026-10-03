import type { Sha256Digest } from "@/application/contracts/canonical-json";
import {
  FAMILIAR_ITEM_LEARNING_CONFIG_V1,
  INTELLIGENCE_ACTIVATION_MANIFEST,
  type EnabledLearningDisposition,
} from "@/application/intelligence/activation-manifest";
import {
  collectFamiliarOccurrences,
  hasSpanWithin,
  distinctOccurrenceDays,
} from "@/application/intelligence/familiar-occurrences";
import { addDays, fingerprint, instantMs, sortRevisionRefs } from "@/application/intelligence/metrics";
import type { Instant } from "@/domain/shared/time";
import type { RecordType } from "@/domain/shared/record-catalogue";
import type { TypedRevisionRef } from "@/domain/shared/typed-revision-ref";
import type {
  LearnedKnowledgeContent,
  LearnedKnowledgeEvidence,
  LearnedKnowledgeLifecycle,
  LearnedKnowledgeRevision,
} from "@/domain/learning";
import type {
  ResolvedActivityEvent,
  ResolvedIntakeEvent,
  SupersededRevision,
} from "@/patterns/pattern-evaluator-contracts";

/**
 * Minimum Packet 7A Learning behaviour: the FAMILIAR_ITEM family only
 * ("familiar-item-learning-rule.v1", deterministic-engine Section 5.1).
 * It retains the familiar-item identity and its exact supporting revisions.
 * Activation permits nothing beyond a reversible logging convenience, and no
 * Packet 7A path presents or acts on it.
 */

const DISPOSITION = INTELLIGENCE_ACTIVATION_MANIFEST.learning.FAMILIAR_ITEM as EnabledLearningDisposition;
const CONFIG = FAMILIAR_ITEM_LEARNING_CONFIG_V1;
const DAY_MS = 86_400_000;

export type FamiliarItemLearningInput = {
  evaluatedAt: Instant;
  inputSequenceCutoff: number;
  familiarItemKey: string;
  intakeEvents: readonly ResolvedIntakeEvent[];
  activityEvents: readonly ResolvedActivityEvent[];
  superseded: readonly SupersededRevision[];
  previous: LearnedKnowledgeRevision | null;
};

export type LearningChangeReason = "LEARNED_KNOWLEDGE_CREATED" | "LEARNED_KNOWLEDGE_REVISED" | "LEARNED_KNOWLEDGE_TRANSITIONED";

export type LearningEvaluationResult =
  | {
      kind: "PROPOSAL";
      candidateKey: string;
      content: LearnedKnowledgeContent;
      lifecycle: LearnedKnowledgeLifecycle;
      evidence: LearnedKnowledgeEvidence;
      reasonCode: LearningChangeReason;
      supportingRevisions: TypedRevisionRef<RecordType>[];
    }
  | { kind: "NO_CHANGE"; candidateKey: string }
  | { kind: "INSUFFICIENT_EVIDENCE"; candidateKey: string; counts: Record<string, number> };

export type LearningEvaluation = {
  evaluatorKey: string;
  evaluatorVersion: string;
  configurationVersion: string;
  evaluatedAt: Instant;
  inputSequenceCutoff: number;
  candidateKey: string;
  consideredRevisions: TypedRevisionRef<RecordType>[];
  inputFingerprint: Sha256Digest;
  resultFingerprint: Sha256Digest;
  result: LearningEvaluationResult;
};

export function familiarLearningCandidateKey(familiarItemKey: string): string {
  return `FAMILIAR_ITEM:${familiarItemKey}:ORDINARY`;
}

type Level = "NONE" | "EMERGING" | "CANDIDATE" | "ACTIVE";
const RANK: Record<Level, number> = { NONE: 0, EMERGING: 1, CANDIDATE: 2, ACTIVE: 3 };

export function evaluateFamiliarItemLearning(input: FamiliarItemLearningInput): LearningEvaluation {
  const key = input.familiarItemKey;
  const candidateKey = familiarLearningCandidateKey(key);
  const T = input.evaluatedAt;
  const { occasions, considered } = collectFamiliarOccurrences({
    familiarItemKey: key,
    windowStart: addDays(T, -CONFIG.sourceWindowDays),
    windowEnd: T,
    intakeEvents: input.intakeEvents,
    activityEvents: input.activityEvents,
    superseded: input.superseded,
  });

  const days = distinctOccurrenceDays(occasions);
  const level: Level = hasSpanWithin(occasions, CONFIG.active.withinDays * DAY_MS, CONFIG.active.occasions, CONFIG.active.distinctDays)
    ? "ACTIVE"
    : hasSpanWithin(occasions, CONFIG.candidate.withinDays * DAY_MS, CONFIG.candidate.occasions, 1)
      ? "CANDIDATE"
      : occasions.length >= CONFIG.emerging.occasions && days >= CONFIG.emerging.distinctDays
        ? "EMERGING"
        : "NONE";
  const latest = occasions.at(-1)?.instant ?? null;
  const staleNow = latest === null || instantMs(latest) < instantMs(addDays(T, -CONFIG.stalenessDays));

  const envelope = (result: LearningEvaluationResult): LearningEvaluation => ({
    evaluatorKey: DISPOSITION.evaluatorKey,
    evaluatorVersion: DISPOSITION.evaluatorVersion,
    configurationVersion: DISPOSITION.configurationVersion,
    evaluatedAt: T,
    inputSequenceCutoff: input.inputSequenceCutoff,
    candidateKey,
    consideredRevisions: sortRevisionRefs(considered),
    inputFingerprint: fingerprint({
      evaluatorKey: DISPOSITION.evaluatorKey,
      evaluatorVersion: DISPOSITION.evaluatorVersion,
      configurationVersion: DISPOSITION.configurationVersion,
      evaluatedAt: T,
      inputSequenceCutoff: input.inputSequenceCutoff,
      candidateKey,
      sources: sortRevisionRefs([...input.intakeEvents.map((e) => e.ref), ...input.activityEvents.map((e) => e.ref)]),
      superseded: sortRevisionRefs(input.superseded.map((entry) => entry.ref)),
      previous: input.previous?.revisionId ?? null,
    }),
    resultFingerprint: fingerprint(result),
    result,
  });

  const previous = input.previous;
  const previousLifecycle = previous?.payload.lifecycle;
  if (previousLifecycle && (previousLifecycle.state === "REJECTED" || previousLifecycle.state === "ADOPTED")) {
    return envelope({ kind: "NO_CHANGE", candidateKey });
  }
  if (level === "NONE" && !previous) {
    return envelope({ kind: "INSUFFICIENT_EVIDENCE", candidateKey, counts: { occasions: occasions.length, distinctDays: days } });
  }

  const supportingRevisions = sortRevisionRefs(occasions.map((o) => o.ref));
  const evidence: LearnedKnowledgeEvidence | null =
    supportingRevisions.length > 0
      ? ({
          kind: "OBSERVATION_SET",
          supportingRevisions,
          contradictingRevisions: [],
          distinctOccasionCount: occasions.length,
          assessmentPolicyVersion: DISPOSITION.assessmentPolicyVersion,
          evaluationRuleVersion: DISPOSITION.evaluationRuleVersion,
        } as LearnedKnowledgeEvidence)
      : null;

  const activation = { kind: "LOW_CONSEQUENCE_POLICY" as const, policyVersion: DISPOSITION.activationPolicyVersion };
  const lifecycleForLevel = (value: Level): LearnedKnowledgeLifecycle =>
    value === "ACTIVE" ? { state: "ACTIVE", activation } : value === "CANDIDATE" ? { state: "CANDIDATE" } : { state: "EMERGING" };

  let lifecycle: LearnedKnowledgeLifecycle;
  if (previousLifecycle && (previousLifecycle.state === "ACTIVE" || previousLifecycle.state === "WEAKENING")) {
    const previousActivation = previousLifecycle.state === "ACTIVE" ? previousLifecycle.activation : previousLifecycle.previousActivation;
    lifecycle = level === "ACTIVE" ? { state: "ACTIVE", activation } : staleNow ? { state: "STALE" } : { state: "WEAKENING", previousActivation };
  } else if (level === "NONE" || (previousLifecycle && RANK[level] === 0)) {
    lifecycle = { state: "STALE" };
  } else {
    lifecycle = lifecycleForLevel(level);
  }

  // Item identity: the earliest occurrence's authored wording, unchanged.
  const content: LearnedKnowledgeContent =
    occasions.length > 0
      ? ({
          kind: "FAMILIAR_ITEM",
          item:
            occasions[0]!.identity.kind === "INTAKE_ITEM"
              ? {
                  kind: "INTAKE_ITEM",
                  familiarItemKey: key,
                  label: { text: occasions[0]!.labels[0]!.label, language: "und" },
                  itemKind: occasions[0]!.identity.itemKind,
                  intakeContext: { kind: "ANY_RECORDED_INTAKE" },
                }
              : {
                  kind: "ACTIVITY",
                  familiarItemKey: key,
                  label: { text: occasions[0]!.labels[0]!.label, language: "und" },
                  activityCategory: occasions[0]!.identity.activityCategory,
                },
          scope: { kind: "ORDINARY" },
        } as LearnedKnowledgeContent)
      : previous!.payload.content;
  // A stale chain keeps the evidence that last supported it.
  const resultEvidence = lifecycle.state === "STALE" || evidence === null ? previous?.payload.evidence ?? evidence! : evidence;

  if (previous) {
    const same =
      fingerprint({ content, lifecycle, evidence: resultEvidence }) ===
      fingerprint({ content: previous.payload.content, lifecycle: previous.payload.lifecycle, evidence: previous.payload.evidence });
    if (same) return envelope({ kind: "NO_CHANGE", candidateKey });
  }
  const evidenceChanged = previous ? fingerprint(resultEvidence) !== fingerprint(previous.payload.evidence) : true;
  const reasonCode: LearningChangeReason = !previous
    ? "LEARNED_KNOWLEDGE_CREATED"
    : evidenceChanged && lifecycle.state !== "WEAKENING" && lifecycle.state !== "STALE"
      ? "LEARNED_KNOWLEDGE_REVISED"
      : "LEARNED_KNOWLEDGE_TRANSITIONED";

  return envelope({
    kind: "PROPOSAL",
    candidateKey,
    content,
    lifecycle,
    evidence: resultEvidence,
    reasonCode,
    supportingRevisions: resultEvidence.kind === "OBSERVATION_SET" ? resultEvidence.supportingRevisions : [],
  });
}
