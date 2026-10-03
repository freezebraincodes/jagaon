import { z } from "zod";
import {
  instantSchema,
  recordIdSchema,
  revisionIdSchema,
  type Instant,
  type RecordId,
  type RevisionId,
} from "@/domain/shared";

/**
 * Exact reverse-dependency edge (storage-backup-spec Section 2.6) from one
 * source revision to one derived revision. The role, evaluator key and
 * version resolve in the closed registry owned by the derived record type;
 * an edge never copies evidence.
 */

type EvaluatorRegistration = {
  versions: readonly string[];
  owner: "PATTERN_ENGINE" | "LEARNING_ENGINE";
  dependentRecordType: "PATTERN_EVIDENCE_SNAPSHOT" | "LEARNED_KNOWLEDGE";
  roles: readonly string[];
};

export const REVERSE_DEPENDENCY_EVALUATORS: Readonly<Record<string, EvaluatorRegistration>> = Object.freeze({
  "pattern.comparable-slot-trend": {
    versions: ["7a.1"],
    owner: "PATTERN_ENGINE",
    dependentRecordType: "PATTERN_EVIDENCE_SNAPSHOT",
    roles: ["BASELINE_EVIDENCE", "RECENT_EVIDENCE", "NEUTRAL_EVIDENCE", "CONTRADICTORY_EVIDENCE", "CONSIDERED_EXCLUDED"],
  },
  "pattern.familiar-or-frequent-item": {
    versions: ["7a.1"],
    owner: "PATTERN_ENGINE",
    dependentRecordType: "PATTERN_EVIDENCE_SNAPSHOT",
    roles: ["SUPPORTING_EVIDENCE", "COMPARATOR_EVIDENCE", "CONTRADICTORY_EVIDENCE", "CONSIDERED_EXCLUDED"],
  },
  "learning.familiar-item": {
    versions: ["7a.1"],
    owner: "LEARNING_ENGINE",
    dependentRecordType: "LEARNED_KNOWLEDGE",
    roles: ["SUPPORTING_EVIDENCE", "CONTRADICTING_EVIDENCE"],
  },
});

export type StoredReverseDependency = {
  sourceRevisionId: RevisionId;
  dependentRecordType: "PATTERN_EVIDENCE_SNAPSHOT" | "LEARNED_KNOWLEDGE";
  dependentRecordId: RecordId;
  dependentRevisionId: RevisionId;
  dependencyRole: string;
  owner: "PATTERN_ENGINE" | "LEARNING_ENGINE";
  evaluatorKey: string;
  evaluatorVersion: string;
  createdAt: Instant;
};

export const reverseDependencyRowSchema = z
  .strictObject({
    sourceRevisionId: revisionIdSchema,
    dependentRecordType: z.enum(["PATTERN_EVIDENCE_SNAPSHOT", "LEARNED_KNOWLEDGE"]),
    dependentRecordId: recordIdSchema,
    dependentRevisionId: revisionIdSchema,
    dependencyRole: z.string().min(1).max(64),
    owner: z.enum(["PATTERN_ENGINE", "LEARNING_ENGINE"]),
    evaluatorKey: z.string().min(1).max(96),
    evaluatorVersion: z.string().min(1).max(32),
    createdAt: instantSchema,
  })
  .superRefine((row, ctx) => {
    const registration = REVERSE_DEPENDENCY_EVALUATORS[row.evaluatorKey];
    const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    if (!registration) return fail("UNKNOWN_EVALUATOR");
    if (!registration.versions.includes(row.evaluatorVersion)) fail("UNKNOWN_EVALUATOR_VERSION");
    if (!registration.roles.includes(row.dependencyRole)) fail("ROLE_NOT_REGISTERED_FOR_EVALUATOR");
    if (registration.owner !== row.owner) fail("OWNER_DISAGREES_WITH_EVALUATOR");
    if (registration.dependentRecordType !== row.dependentRecordType) fail("DEPENDENT_TYPE_DISAGREES_WITH_EVALUATOR");
    if (row.sourceRevisionId === row.dependentRevisionId) fail("SELF_DEPENDENCY");
  })
  .transform((row): StoredReverseDependency => row as StoredReverseDependency);
