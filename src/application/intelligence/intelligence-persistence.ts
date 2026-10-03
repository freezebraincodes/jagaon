import { z } from "zod";
import {
  commandIdSchema,
  correlationIdSchema,
  domainEventIdSchema,
  type CommandId,
  type CorrelationId,
  type DomainEventId,
  type EventSequence,
} from "@/application/contracts/command-event-identifiers";
import { eventRecordChangeSchema, type EventRecordChange } from "@/application/contracts/domain-event-envelope";
import type { RecordHeadExpectation } from "@/application/contracts/command-envelope";
import type { EventWorkItem } from "@/application/contracts/event-work";
import { LEARNING_EVENT_NAMES, PATTERN_EVENT_NAMES } from "@/application/contracts/command-event-names";
import {
  auditEventIdSchema,
  instantSchema,
  recordIdSchema,
  revisionIdSchema,
  transactionIdSchema,
  type AuditEventId,
  type DeletionTombstone,
  type Instant,
  type RecordHead,
  type RecordId,
  type RevisionId,
  type TransactionId,
} from "@/domain/shared";
import type { LearnedKnowledgeRevision } from "@/domain/learning";
import {
  validatePatternPair,
  type PatternEvidenceSnapshotRevision,
  type PatternObservationRevision,
} from "@/domain/patterns";
import {
  createAuthoritativeCommandStore,
  type AuthoritativeCommandPlan,
  type AuthoritativeCommandStore,
} from "@/storage/authoritative-command-transaction";
import type { JagaOnDatabase } from "@/storage/database";
import { implementedStorageRowCodecs } from "@/storage/implemented-row-codecs";
import { createStorageRowCodec, type StorageRowCodec } from "@/storage/storage-row-codec";
import { committedDomainEventRowCodec } from "@/storage/committed-domain-event-row";
import type { StoredReverseDependency } from "@/storage/reverse-dependency-row";
import {
  ENGINE_DECISION_REASON_CODES,
  type EngineDecisionReasonCode,
  type StoredEngineEvaluationAudit,
} from "@/storage/engine-evaluation-audit-row";
import {
  DERIVED_RECORD_TYPES,
  derivedRevisionRowCodec,
  learnedKnowledgeRevisionCodec,
  patternEvidenceSnapshotRevisionCodec,
  patternObservationRevisionCodec,
  type DerivedRecordType,
  type StoredDerivedRevision,
} from "./derived-record-codecs";
import { fingerprint } from "./metrics";

/**
 * Packet 7A authoritative persistence for derived intelligence records.
 *
 * Event-contracts Section 11.1 and domain Section 8.10: an evidence snapshot
 * is persisted before its observation, and both heads, reverse dependencies,
 * the evaluation audit and the domain events commit in one existing
 * authoritative transaction. Earlier revisions are never edited.
 */

export type IntelligencePlanErrorCode =
  | "INVALID_DERIVED_REVISION"
  | "PARTIAL_OR_MISMATCHED_PAIR"
  | "INVALID_REVISION_LINEAGE"
  | "INVALID_REVERSE_DEPENDENCY"
  | "DUPLICATE_REVERSE_DEPENDENCY"
  | "INVALID_EVALUATION_AUDIT"
  | "INVALID_DELETION_TARGET";

/** Bounded plan failure that never retains a rejected payload. */
export class IntelligencePlanError extends Error {
  readonly name = "IntelligencePlanError";
  constructor(readonly code: IntelligencePlanErrorCode) {
    super(code);
  }
}

const fail = (code: IntelligencePlanErrorCode): never => {
  throw new IntelligencePlanError(code);
};

// --- Closed audit and event rows ------------------------------------------------

const derivedRecordTypeSchema = z.enum(DERIVED_RECORD_TYPES);

export type IntelligenceAuditRow = {
  auditEventId: AuditEventId;
  transactionId: TransactionId;
  recordId: RecordId;
  recordType: DerivedRecordType;
  previousRevisionId: RevisionId | null;
  resultingRevisionId: RevisionId | null;
  action: "CREATE" | "UPDATE" | "DELETE";
  initiator: "JAGAON_SYSTEM";
  assistance: "NONE";
  occurredAt: Instant;
  reasonCode: EngineDecisionReasonCode;
};

const intelligenceAuditRowSchema = z
  .strictObject({
    auditEventId: auditEventIdSchema,
    transactionId: transactionIdSchema,
    recordId: recordIdSchema,
    recordType: derivedRecordTypeSchema,
    previousRevisionId: revisionIdSchema.nullable(),
    resultingRevisionId: revisionIdSchema.nullable(),
    action: z.enum(["CREATE", "UPDATE", "DELETE"]),
    initiator: z.literal("JAGAON_SYSTEM"),
    assistance: z.literal("NONE"),
    occurredAt: instantSchema,
    reasonCode: z.enum(ENGINE_DECISION_REASON_CODES),
  })
  .refine((row) => (row.action === "DELETE") === (row.resultingRevisionId === null), "DELETE_HAS_NO_RESULTING_REVISION")
  .transform((row): IntelligenceAuditRow => row as IntelligenceAuditRow);

export const INTELLIGENCE_EVENT_NAMES = Object.freeze([
  ...PATTERN_EVENT_NAMES,
  ...LEARNING_EVENT_NAMES,
  "PATIENT_RECORD_DELETED",
] as const);

export type IntelligenceEventRow = {
  eventId: DomainEventId;
  eventName: (typeof INTELLIGENCE_EVENT_NAMES)[number];
  localSequence: EventSequence;
  transactionIndex: number;
  transactionId: TransactionId;
  commandId: CommandId;
  correlationId: CorrelationId;
  committedAt: Instant;
  change: EventRecordChange;
  payload: { evaluationId: string | null; reasonCode: EngineDecisionReasonCode };
};

const intelligenceEventRowSchema = z
  .strictObject({
    eventId: domainEventIdSchema,
    eventName: z.enum(INTELLIGENCE_EVENT_NAMES),
    localSequence: z.number().int().positive().safe(),
    transactionIndex: z.number().int().nonnegative().safe(),
    transactionId: transactionIdSchema,
    commandId: commandIdSchema,
    correlationId: correlationIdSchema,
    committedAt: instantSchema,
    change: eventRecordChangeSchema,
    // Derived events never copy health values, labels or evidence.
    payload: z.strictObject({ evaluationId: z.string().uuid().nullable(), reasonCode: z.enum(ENGINE_DECISION_REASON_CODES) }),
  })
  .refine((row) => (DERIVED_RECORD_TYPES as readonly string[]).includes(row.change.recordType), "EVENT_TARGET_NOT_DERIVED")
  .transform((row): IntelligenceEventRow => row as unknown as IntelligenceEventRow);

const auditCodec = createStorageRowCodec<IntelligenceAuditRow>("auditEvents", intelligenceAuditRowSchema);
const strictEventCodec = createStorageRowCodec<IntelligenceEventRow>("domainEvents", intelligenceEventRowSchema);
const eventCodec: StorageRowCodec<IntelligenceEventRow> = Object.freeze({
  validateForWrite: (value: unknown) => strictEventCodec.validateForWrite(value),
  // The shared event log also holds journal events committed by other owners.
  validateAfterRead: (value: unknown) => committedDomainEventRowCodec.validateAfterRead(value) as unknown as IntelligenceEventRow,
});

export type IntelligenceCommandStore = AuthoritativeCommandStore<
  StoredDerivedRevision,
  IntelligenceAuditRow,
  IntelligenceEventRow,
  StoredReverseDependency,
  StoredEngineEvaluationAudit
>;

export type IntelligenceCommandPlan = AuthoritativeCommandPlan<
  StoredDerivedRevision,
  IntelligenceAuditRow,
  IntelligenceEventRow,
  StoredReverseDependency,
  StoredEngineEvaluationAudit
>;

/** The Packet 7A integration boundary: real edge and audit codecs replace Packet 6's rejecting ones. */
export function createIntelligenceCommandStore(database: JagaOnDatabase): IntelligenceCommandStore {
  return createAuthoritativeCommandStore(database, {
    revisionCodec: derivedRevisionRowCodec,
    auditCodec,
    eventCodec,
    reverseDependencyCodec: implementedStorageRowCodecs.reverseDependencies,
    evaluationAuditCodec: implementedStorageRowCodecs.engineEvaluationAudits,
  });
}

// --- Shared plan helpers ------------------------------------------------------------

type PreparedEvent = Omit<IntelligenceEventRow, "localSequence" | "transactionIndex" | "committedAt">;

type RevisionLike = {
  recordType: DerivedRecordType;
  recordId: RecordId;
  revisionId: RevisionId;
  revisionNumber: number;
  previousRevisionId: RevisionId | null;
  action: string;
  recordedAt: Instant;
  revisionCreatedAt: Instant;
  auditEventId: AuditEventId;
  transactionId: TransactionId;
};

function headExpectation(revision: RevisionLike, expectedHead: RecordHead | null): RecordHeadExpectation {
  if (expectedHead === null) {
    return { kind: "MUST_NOT_EXIST", recordType: revision.recordType, proposedRecordId: revision.recordId };
  }
  return {
    kind: "MUST_MATCH",
    recordType: revision.recordType,
    recordId: revision.recordId,
    expectedRevisionId: expectedHead.headRevisionId,
    expectedRevisionNumber: expectedHead.headRevisionNumber,
  };
}

function checkLineage(revision: RevisionLike, expectedHead: RecordHead | null, transactionId: TransactionId): void {
  if (revision.transactionId !== transactionId) fail("INVALID_REVISION_LINEAGE");
  if (expectedHead === null) {
    if (revision.revisionNumber !== 1 || revision.previousRevisionId !== null || revision.action !== "CREATE") {
      fail("INVALID_REVISION_LINEAGE");
    }
    return;
  }
  if (
    expectedHead.recordId !== revision.recordId ||
    expectedHead.recordType !== revision.recordType ||
    expectedHead.state !== "ACTIVE" ||
    revision.previousRevisionId !== expectedHead.headRevisionId ||
    revision.revisionNumber !== expectedHead.headRevisionNumber + 1 ||
    revision.action === "CREATE"
  ) {
    fail("INVALID_REVISION_LINEAGE");
  }
}

function headFor(revision: RevisionLike, updatedAt: Instant): RecordHead {
  return {
    recordId: revision.recordId,
    recordType: revision.recordType,
    headRevisionId: revision.revisionId,
    headRevisionNumber: revision.revisionNumber,
    state: "ACTIVE",
    updatedAt,
  };
}

function auditFor(revision: RevisionLike, reasonCode: EngineDecisionReasonCode, occurredAt: Instant): IntelligenceAuditRow {
  return {
    auditEventId: revision.auditEventId,
    transactionId: revision.transactionId,
    recordId: revision.recordId,
    recordType: revision.recordType,
    previousRevisionId: revision.previousRevisionId,
    resultingRevisionId: revision.revisionId,
    action: revision.previousRevisionId === null ? "CREATE" : "UPDATE",
    initiator: "JAGAON_SYSTEM",
    assistance: "NONE",
    occurredAt,
    reasonCode,
  };
}

function eventFor(
  eventId: DomainEventId,
  eventName: IntelligenceEventRow["eventName"],
  revision: RevisionLike,
  base: { commandId: CommandId; correlationId: CorrelationId; transactionId: TransactionId },
  payload: IntelligenceEventRow["payload"],
): PreparedEvent {
  return {
    eventId,
    eventName,
    transactionId: base.transactionId,
    commandId: base.commandId,
    correlationId: base.correlationId,
    change: {
      kind: "REVISION_CREATED",
      recordType: revision.recordType,
      recordId: revision.recordId,
      action: revision.action as never,
      previousRevisionId: revision.previousRevisionId,
      resultingRevisionId: revision.revisionId,
      resultingRevisionNumber: revision.revisionNumber,
    },
    payload,
  };
}

function validateEdges(
  edges: readonly StoredReverseDependency[],
  dependent: RevisionLike | null,
): StoredReverseDependency[] {
  const validated = edges.map((edge) => {
    try {
      return implementedStorageRowCodecs.reverseDependencies.validateForWrite(edge);
    } catch {
      return fail("INVALID_REVERSE_DEPENDENCY");
    }
  });
  const keys = validated.map((edge) => `${edge.sourceRevisionId}|${edge.dependentRevisionId}|${edge.dependencyRole}`);
  if (new Set(keys).size !== keys.length) fail("DUPLICATE_REVERSE_DEPENDENCY");
  for (const edge of validated) {
    if (
      dependent === null ||
      edge.dependentRecordId !== dependent.recordId ||
      edge.dependentRevisionId !== dependent.revisionId ||
      edge.dependentRecordType !== dependent.recordType
    ) {
      fail("INVALID_REVERSE_DEPENDENCY");
    }
  }
  return validated;
}

function validateAudit(audit: StoredEngineEvaluationAudit): StoredEngineEvaluationAudit {
  try {
    return implementedStorageRowCodecs.engineEvaluationAudits.validateForWrite(audit);
  } catch {
    return fail("INVALID_EVALUATION_AUDIT");
  }
}

function storeRevision<T>(create: (revision: T) => StoredDerivedRevision, revision: T): StoredDerivedRevision {
  try {
    return create(revision);
  } catch {
    return fail("INVALID_DERIVED_REVISION");
  }
}

// --- Pattern snapshot/observation pair ------------------------------------------------

export type PatternCommitInput = {
  commandId: CommandId;
  correlationId: CorrelationId;
  transactionId: TransactionId;
  completedAt: Instant;
  snapshot:
    | { kind: "NEW"; revision: PatternEvidenceSnapshotRevision; expectedHead: RecordHead | null }
    | { kind: "REUSED"; revision: PatternEvidenceSnapshotRevision };
  observation: { revision: PatternObservationRevision; expectedHead: RecordHead | null };
  eventIds: { snapshot?: DomainEventId; observation: DomainEventId };
  reasonCode: Extract<
    EngineDecisionReasonCode,
    "PATTERN_OBSERVATION_CREATED" | "PATTERN_OBSERVATION_REVISED" | "PATTERN_OBSERVATION_TRANSITIONED"
  >;
  evaluation: StoredEngineEvaluationAudit;
  reverseDependencies: StoredReverseDependency[];
  /** Work items the static subscription registry creates for these events. */
  eventWorkItems?: EventWorkItem[];
};

const OBSERVATION_EVENT_BY_REASON = {
  PATTERN_OBSERVATION_CREATED: "PATTERN_OBSERVATION_CREATED",
  PATTERN_OBSERVATION_REVISED: "PATTERN_OBSERVATION_REVISED",
  PATTERN_OBSERVATION_TRANSITIONED: "PATTERN_OBSERVATION_TRANSITIONED",
} as const;

export function buildPatternCommitPlan(input: PatternCommitInput): IntelligenceCommandPlan {
  const observationRow = storeRevision(patternObservationRevisionCodec.create, input.observation.revision);
  const snapshotRevision = input.snapshot.revision;
  const snapshotRow =
    input.snapshot.kind === "NEW" ? storeRevision(patternEvidenceSnapshotRevisionCodec.create, snapshotRevision) : null;
  if (input.snapshot.kind === "REUSED") {
    // A reused snapshot must itself be a valid revision even though it is not rewritten.
    storeRevision(patternEvidenceSnapshotRevisionCodec.create, snapshotRevision);
  }

  const observation = input.observation.revision;
  if (!validatePatternPair(observation.payload, snapshotRevision).ok) fail("PARTIAL_OR_MISMATCHED_PAIR");
  if ((input.snapshot.kind === "NEW") !== (input.eventIds.snapshot !== undefined)) fail("PARTIAL_OR_MISMATCHED_PAIR");
  if (input.snapshot.kind === "REUSED" && input.reverseDependencies.length > 0) fail("INVALID_REVERSE_DEPENDENCY");
  if (input.observation.expectedHead === null && input.reasonCode !== "PATTERN_OBSERVATION_CREATED") {
    fail("INVALID_REVISION_LINEAGE");
  }

  checkLineage(observation as unknown as RevisionLike, input.observation.expectedHead, input.transactionId);
  if (input.snapshot.kind === "NEW") {
    checkLineage(snapshotRevision as unknown as RevisionLike, input.snapshot.expectedHead, input.transactionId);
  }
  const edges = validateEdges(
    input.reverseDependencies,
    input.snapshot.kind === "NEW" ? (snapshotRevision as unknown as RevisionLike) : null,
  );
  const evaluation = validateAudit(input.evaluation);
  const base = { commandId: input.commandId, correlationId: input.correlationId, transactionId: input.transactionId };
  const payload = { evaluationId: evaluation.evaluationId, reasonCode: input.reasonCode };

  const revisions: StoredDerivedRevision[] = [];
  const heads: RecordHead[] = [];
  const audits: IntelligenceAuditRow[] = [];
  const events: PreparedEvent[] = [];
  const expectations: RecordHeadExpectation[] = [];

  if (input.snapshot.kind === "NEW" && snapshotRow && input.eventIds.snapshot) {
    const rev = snapshotRevision as unknown as RevisionLike;
    revisions.push(snapshotRow);
    heads.push(headFor(rev, input.completedAt));
    audits.push(auditFor(rev, input.reasonCode, input.completedAt));
    events.push(eventFor(input.eventIds.snapshot, "PATTERN_EVIDENCE_SNAPSHOT_CREATED", rev, base, payload));
    expectations.push(headExpectation(rev, input.snapshot.expectedHead));
  }
  const obs = observation as unknown as RevisionLike;
  revisions.push(observationRow);
  heads.push(headFor(obs, input.completedAt));
  audits.push(auditFor(obs, input.reasonCode, input.completedAt));
  events.push(eventFor(input.eventIds.observation, OBSERVATION_EVENT_BY_REASON[input.reasonCode], obs, base, payload));
  expectations.push(headExpectation(obs, input.observation.expectedHead));

  return {
    kind: "COMMIT",
    commandId: input.commandId,
    commandHash: fingerprint({
      commandName: "REEVALUATE_PATTERN_FAMILY",
      family: observation.payload.family,
      candidateKey: evaluation.candidateKey,
      inputFingerprint: evaluation.inputFingerprint,
      resultFingerprint: evaluation.resultFingerprint,
      revisions: revisions.map((row) => row.revisionId),
    }),
    completedAt: input.completedAt,
    transactionId: input.transactionId,
    headExpectations: expectations,
    recordRevisions: revisions,
    recordHeads: heads,
    deletionTombstones: [],
    auditEvents: audits,
    domainEvents: events as never,
    eventWorkItems: input.eventWorkItems ?? [],
    reverseDependencies: edges,
    evaluationAudits: [evaluation],
    appPreference: null,
    safety: { kind: "NOT_REQUIRED" },
  };
}

// --- Learned knowledge --------------------------------------------------------------

export type LearningCommitInput = {
  commandId: CommandId;
  correlationId: CorrelationId;
  transactionId: TransactionId;
  completedAt: Instant;
  revision: LearnedKnowledgeRevision;
  expectedHead: RecordHead | null;
  eventId: DomainEventId;
  reasonCode: Extract<
    EngineDecisionReasonCode,
    "LEARNED_KNOWLEDGE_CREATED" | "LEARNED_KNOWLEDGE_REVISED" | "LEARNED_KNOWLEDGE_TRANSITIONED"
  >;
  evaluation: StoredEngineEvaluationAudit;
  reverseDependencies: StoredReverseDependency[];
};

export function buildLearningCommitPlan(input: LearningCommitInput): IntelligenceCommandPlan {
  const row = storeRevision(learnedKnowledgeRevisionCodec.create, input.revision);
  const rev = input.revision as unknown as RevisionLike;
  if (input.expectedHead === null && input.reasonCode !== "LEARNED_KNOWLEDGE_CREATED") fail("INVALID_REVISION_LINEAGE");
  checkLineage(rev, input.expectedHead, input.transactionId);
  const edges = validateEdges(input.reverseDependencies, rev);
  const evaluation = validateAudit(input.evaluation);
  const base = { commandId: input.commandId, correlationId: input.correlationId, transactionId: input.transactionId };
  return {
    kind: "COMMIT",
    commandId: input.commandId,
    commandHash: fingerprint({
      commandName: "REEVALUATE_LEARNING",
      candidateKey: evaluation.candidateKey,
      inputFingerprint: evaluation.inputFingerprint,
      resultFingerprint: evaluation.resultFingerprint,
      revision: row.revisionId,
    }),
    completedAt: input.completedAt,
    transactionId: input.transactionId,
    headExpectations: [headExpectation(rev, input.expectedHead)],
    recordRevisions: [row],
    recordHeads: [headFor(rev, input.completedAt)],
    deletionTombstones: [],
    auditEvents: [auditFor(rev, input.reasonCode, input.completedAt)],
    domainEvents: [
      eventFor(input.eventId, input.reasonCode, rev, base, { evaluationId: evaluation.evaluationId, reasonCode: input.reasonCode }),
    ] as never,
    eventWorkItems: [],
    reverseDependencies: edges,
    evaluationAudits: [evaluation],
    appPreference: null,
    safety: { kind: "NOT_REQUIRED" },
  };
}

// --- Dependent-content deletion -----------------------------------------------------------

export type DerivedDeletionInput = {
  commandId: CommandId;
  correlationId: CorrelationId;
  transactionId: TransactionId;
  completedAt: Instant;
  reasonCode: Extract<EngineDecisionReasonCode, "PATTERN_DERIVED_CONTENT_DELETED" | "LEARNED_DERIVED_CONTENT_DELETED">;
  targets: { head: RecordHead; auditEventId: AuditEventId; eventId: DomainEventId }[];
};

/**
 * Tombstone every listed derived chain together. The store purges their
 * revisions and edges in the same transaction, so no sensitive historical
 * payload based on deleted evidence survives.
 */
export function buildDerivedDeletionPlan(input: DerivedDeletionInput): IntelligenceCommandPlan {
  if (input.targets.length === 0) fail("INVALID_DELETION_TARGET");
  const tombstones: DeletionTombstone[] = [];
  const heads: RecordHead[] = [];
  const audits: IntelligenceAuditRow[] = [];
  const events: PreparedEvent[] = [];
  const expectations: RecordHeadExpectation[] = [];
  for (const target of input.targets) {
    const { head } = target;
    if (head.state !== "ACTIVE" || !(DERIVED_RECORD_TYPES as readonly string[]).includes(head.recordType)) {
      fail("INVALID_DELETION_TARGET");
    }
    const recordType = head.recordType as DerivedRecordType;
    tombstones.push({
      recordId: head.recordId,
      recordType,
      deletedAt: input.completedAt,
      initiator: "JAGAON_SYSTEM",
      auditEventId: target.auditEventId,
      transactionId: input.transactionId,
    });
    heads.push({ ...head, state: "DELETED", updatedAt: input.completedAt });
    audits.push({
      auditEventId: target.auditEventId,
      transactionId: input.transactionId,
      recordId: head.recordId,
      recordType,
      previousRevisionId: head.headRevisionId,
      resultingRevisionId: null,
      action: "DELETE",
      initiator: "JAGAON_SYSTEM",
      assistance: "NONE",
      occurredAt: input.completedAt,
      reasonCode: input.reasonCode,
    });
    events.push({
      eventId: target.eventId,
      eventName: "PATIENT_RECORD_DELETED",
      transactionId: input.transactionId,
      commandId: input.commandId,
      correlationId: input.correlationId,
      change: {
        kind: "RECORD_DELETED",
        recordType,
        recordId: head.recordId,
        previousRevisionId: head.headRevisionId,
        resultingRevisionId: null,
      },
      payload: { evaluationId: null, reasonCode: input.reasonCode },
    });
    expectations.push({
      kind: "MUST_MATCH",
      recordType,
      recordId: head.recordId,
      expectedRevisionId: head.headRevisionId,
      expectedRevisionNumber: head.headRevisionNumber,
    });
  }
  return {
    kind: "COMMIT",
    commandId: input.commandId,
    commandHash: fingerprint({
      commandName: "DELETE_DEPENDENT_DERIVED_CONTENT",
      targets: input.targets.map((target) => [target.head.recordId, target.head.headRevisionId]),
      reasonCode: input.reasonCode,
    }),
    completedAt: input.completedAt,
    transactionId: input.transactionId,
    headExpectations: expectations,
    recordRevisions: [],
    recordHeads: heads,
    deletionTombstones: tombstones,
    auditEvents: audits,
    domainEvents: events as never,
    eventWorkItems: [],
    reverseDependencies: [],
    evaluationAudits: [],
    appPreference: null,
    safety: { kind: "NOT_REQUIRED" },
  };
}
