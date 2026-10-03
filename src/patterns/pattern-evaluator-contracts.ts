import type { Sha256Digest } from "@/application/contracts/canonical-json";
import type { ProvenanceCore } from "@/domain/shared/provenance";
import type { RecordType } from "@/domain/shared/record-catalogue";
import type { RevisionAction } from "@/domain/shared/revision";
import type { Instant } from "@/domain/shared/time";
import type { TypedRevisionRef } from "@/domain/shared/typed-revision-ref";
import type { GlucoseReadingPayload } from "@/domain/health-records/glucose-reading";
import type { ReadingTemporal } from "@/domain/health-records/reading-temporal";
import type { IntakeEventPayload } from "@/domain/health-records/intake-event";
import type { ActivityEventPayload } from "@/domain/health-records/activity-event";
import type { ActivityTemporal, IntakeTemporal } from "@/domain/health-records/observation-temporal";
import type {
  PatternClaim,
  PatternEvidenceSnapshotPayload,
  PatternEvidenceSnapshotRevision,
  PatternFamily,
  PatternLifecycle,
  PatternLimitationCode,
  PatternObservationRevision,
} from "@/domain/patterns";

/**
 * Narrow pure Pattern evaluator ports (deterministic-engine Sections 1.3 and
 * 20.1). Inputs are complete immutable views of exact latest source
 * revisions; evaluators perform no storage, clock, network, AI or random
 * access and return typed results only.
 */

export type ResolvedSource<TType extends RecordType, TPayload, TTemporal> = {
  ref: TypedRevisionRef<TType>;
  revisionNumber: number;
  action: RevisionAction;
  provenance: ProvenanceCore;
  temporal: TTemporal;
  payload: TPayload;
};

export type ResolvedGlucoseReading = ResolvedSource<"GLUCOSE_READING", GlucoseReadingPayload, ReadingTemporal>;
export type ResolvedIntakeEvent = ResolvedSource<"INTAKE_EVENT", IntakeEventPayload, IntakeTemporal>;
export type ResolvedActivityEvent = ResolvedSource<"ACTIVITY_EVENT", ActivityEventPayload, ActivityTemporal>;

/** An earlier revision of a record whose latest revision is also supplied. */
export type SupersededRevision = { ref: TypedRevisionRef<RecordType> };

export type PreviousPatternChain = {
  observation: PatternObservationRevision;
  snapshot: PatternEvidenceSnapshotRevision;
};

export type PatternDependencyRole =
  | "BASELINE_EVIDENCE"
  | "RECENT_EVIDENCE"
  | "SUPPORTING_EVIDENCE"
  | "COMPARATOR_EVIDENCE"
  | "NEUTRAL_EVIDENCE"
  | "CONTRADICTORY_EVIDENCE"
  | "CONSIDERED_EXCLUDED";

export type PatternSourceRole = { ref: TypedRevisionRef<RecordType>; role: PatternDependencyRole };

export type PatternChangeReason =
  | "PATTERN_OBSERVATION_CREATED"
  | "PATTERN_OBSERVATION_REVISED"
  | "PATTERN_OBSERVATION_TRANSITIONED";

export type PatternEvaluationResult =
  | {
      kind: "PROPOSAL";
      family: PatternFamily;
      candidateKey: string;
      claim: PatternClaim;
      lifecycle: PatternLifecycle;
      snapshot: { kind: "NEW"; payload: PatternEvidenceSnapshotPayload } | { kind: "REUSE" };
      reasonCode: PatternChangeReason;
      sourceRoles: PatternSourceRole[];
      limitationCodes: PatternLimitationCode[];
    }
  | { kind: "NO_CHANGE"; family: PatternFamily; candidateKey: string }
  | {
      kind: "INSUFFICIENT_EVIDENCE";
      family: PatternFamily;
      candidateKey: string;
      reasonCodes: string[];
      counts: Record<string, number>;
    }
  | {
      kind: "NO_MATERIAL_DIFFERENCE";
      family: PatternFamily;
      candidateKey: string;
      coverage: "SIGNAL" | "EMERGING" | "SUPPORTED";
      counts: Record<string, number>;
    };

/** Deterministic evaluation envelope (deterministic-engine Section 19.1, pure part). */
export type PatternEvaluation = {
  evaluatorKey: string;
  evaluatorVersion: string;
  configurationVersion: string;
  evaluatedAt: Instant;
  inputSequenceCutoff: number;
  candidateKey: string;
  consideredRevisions: TypedRevisionRef<RecordType>[];
  inputFingerprint: Sha256Digest;
  resultFingerprint: Sha256Digest;
  result: PatternEvaluationResult;
};
