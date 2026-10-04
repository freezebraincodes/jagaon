import { eventRecordChangeSchema } from "@/application/contracts/domain-event-envelope";
import type { CommandId, CorrelationId, DomainEventId } from "@/application/contracts/command-event-identifiers";
import type { EventConsumerReceipt } from "@/application/contracts/event-consumer-receipt";
import { validatePacket6StoredRevision } from "@/application/journal/journal-row-codecs";
import { createEventWorkRepository } from "@/storage/event-work-repository";
import type { StoredEventWorkItem } from "@/storage/stored-event-work-item";
import type { JagaOnDatabase } from "@/storage/database";
import type { StoredReverseDependency } from "@/storage/reverse-dependency-row";
import type { StoredEngineEvaluationAudit } from "@/storage/engine-evaluation-audit-row";
import type {
  AuditEventId,
  RecordId,
  RevisionId,
  TransactionId,
} from "@/domain/shared/identifiers";
import type { Instant } from "@/domain/shared/time";
import type { RecordType } from "@/domain/shared/record-catalogue";
import type { TypedRevisionRef } from "@/domain/shared/typed-revision-ref";
import type { ProvenanceCore } from "@/domain/shared/provenance";
import type { LearnedKnowledgeRevision } from "@/domain/learning";
import type {
  EligiblePatientSelectedSlot,
  PatternEvidenceSnapshotRevision,
  PatternObservationRevision,
} from "@/domain/patterns";
import { comparableSlotCandidateKey, evaluateComparableSlotTrend } from "@/patterns/comparable-slot-trend-evaluator";
import {
  discoverFamiliarCandidates,
  evaluateFamiliarOrFrequentItem,
  familiarItemCandidateKey,
} from "@/patterns/familiar-or-frequent-item-evaluator";
import type { PatternEvaluation } from "@/patterns/pattern-evaluator-contracts";
import {
  evaluateFamiliarItemLearning,
  familiarLearningCandidateKey,
  type LearningEvaluation,
} from "@/learning/familiar-item-learning-evaluator";
import {
  COMPARABLE_SLOT_TREND_CONFIG_V1,
  INTELLIGENCE_ACTIVATION_MANIFEST,
  enabledLearningFamilies,
  enabledPatternFamilies,
} from "./activation-manifest";
import { resolveActivityIdentity, resolveIntakeIdentities } from "./familiar-identity";
import {
  buildDerivedDeletionPlan,
  buildLearningCommitPlan,
  buildPatternCommitPlan,
  createIntelligenceCommandStore,
  type IntelligenceCommandPlan,
} from "./intelligence-persistence";
import { LEARNING_HANDLER_VERSION, PATTERN_HANDLER_VERSION } from "./intelligence-subscriptions";
import { learnedKnowledgeDependencySources } from "./learning-dependencies";
import { sortRevisionRefs } from "./metrics";
import { IntelligenceIntegrityError, loadIntelligenceSnapshot, type IntelligenceSnapshot } from "./intelligence-snapshot";

/**
 * Packet 7A evaluation coordinator (deterministic-engine Sections 7, 18, 19;
 * event-contracts Sections 4 and 10).
 *
 * It claims persisted ordinary-intelligence work, coalesces it into one
 * bounded scope, resolves affected candidates through the exact
 * reverse-dependency index, deletes dependent derived content after source
 * deletion, invokes only enabled pure evaluators, commits each changed
 * snapshot/observation pair atomically and stores a receipt for every
 * triggering event. NO_CHANGE and insufficient results write nothing.
 */

export type IntelligenceCoordinatorDependencies = {
  now(): Instant;
  ids: {
    recordId(): RecordId;
    revisionId(): RevisionId;
    auditEventId(): AuditEventId;
    transactionId(): TransactionId;
    commandId(): CommandId;
    correlationId(): CorrelationId;
    domainEventId(): DomainEventId;
    evaluationId(): string;
    leaseToken(): string;
  };
  instanceId: string;
};

export type IntelligenceRunReport = {
  claimedWorkItems: number;
  committedCommands: number;
  failed: boolean;
};

export type IntelligenceCoordinator = {
  /** Process persisted Pattern and Learning work created by journal events. */
  processPending(): Promise<IntelligenceRunReport>;
  /** Time-driven refresh of every candidate inside the bounded windows. */
  refreshAll(): Promise<IntelligenceRunReport>;
};

const SYSTEM_PROVENANCE: ProvenanceCore = {
  sourceKind: "SYSTEM_DERIVATION",
  captureMethod: "RULE_ENGINE",
  initiator: "JAGAON_SYSTEM",
  assistance: "NONE",
};

const MAX_CLAIMS_PER_RUN = 1000;
const LEASE_MS = 5 * 60_000;
const RETRY_MS = 60_000;

type Scope = { pattern: Set<string>; learning: Set<string> };
type ChangeTarget = {
  recordType: RecordType;
  recordId: RecordId;
  /** Every known representation of the record, for candidate discovery and reverse-dependency invalidation. */
  revisionIds: string[];
  /** The revision the event itself produced; null for a deletion, which produces none. */
  triggeringRevisionId: RevisionId | null;
  deleted: boolean;
};
type DeletionPlans = { pattern: IntelligenceCommandPlan[]; learning: IntelligenceCommandPlan[] };

export function createIntelligenceCoordinator(
  database: JagaOnDatabase,
  dependencies: IntelligenceCoordinatorDependencies,
): IntelligenceCoordinator {
  const store = createIntelligenceCommandStore(database);
  const work = createEventWorkRepository(database);
  const { ids } = dependencies;
  const patternEnabled = new Set<string>(enabledPatternFamilies());
  const learningEnabled = new Set<string>(enabledLearningFamilies());
  let running: Promise<unknown> = Promise.resolve();

  function serialised<T>(task: () => Promise<T>): Promise<T> {
    const next = running.then(task, task);
    running = next.catch(() => undefined);
    return next;
  }

  // --- Candidate discovery ----------------------------------------------------------

  function comparableKeyForPayload(payload: unknown): string | null {
    if (!patternEnabled.has("COMPARABLE_SLOT_TREND")) return null;
    const context = (payload as { context?: { kind?: string; slot?: string } }).context;
    if (context?.kind !== "PATIENT_SELECTED_SLOT" || !context.slot) return null;
    if (!(COMPARABLE_SLOT_TREND_CONFIG_V1.eligibleSlots as readonly string[]).includes(context.slot)) return null;
    return comparableSlotCandidateKey({ kind: "PATIENT_SELECTED_SLOT", slot: context.slot as EligiblePatientSelectedSlot });
  }

  function familiarKeysForPayload(recordType: RecordType, payload: unknown): string[] {
    if (recordType === "INTAKE_EVENT") {
      const items = (payload as { items?: { kind: "FOOD" | "DRINK" | "OTHER" | "UNKNOWN"; label: string }[] }).items ?? [];
      return resolveIntakeIdentities(items).map((identity) => identity.familiarItemKey);
    }
    if (recordType === "ACTIVITY_EVENT") {
      return [resolveActivityIdentity(payload as never).familiarItemKey];
    }
    return [];
  }

  function addPayloadCandidates(scope: Scope, recordType: RecordType, payload: unknown, consumers: Set<string>) {
    if (consumers.has("PATTERN_REEVALUATION")) {
      if (recordType === "GLUCOSE_READING") {
        const key = comparableKeyForPayload(payload);
        if (key) scope.pattern.add(key);
      } else if (patternEnabled.has("FAMILIAR_OR_FREQUENT_ITEM")) {
        for (const key of familiarKeysForPayload(recordType, payload)) scope.pattern.add(familiarItemCandidateKey(key));
      }
    }
    if (consumers.has("LEARNING_REEVALUATION") && learningEnabled.has("FAMILIAR_ITEM")) {
      for (const key of familiarKeysForPayload(recordType, payload)) scope.learning.add(familiarLearningCandidateKey(key));
    }
  }

  function discoverAll(snapshot: IntelligenceSnapshot): Scope {
    const scope: Scope = { pattern: new Set(snapshot.patternChains.keys()), learning: new Set(snapshot.learningChains.keys()) };
    for (const reading of snapshot.glucose) {
      const key = comparableKeyForPayload(reading.payload);
      if (key) scope.pattern.add(key);
    }
    for (const key of discoverFamiliarCandidates(snapshot.intakeEvents, snapshot.activityEvents)) {
      if (patternEnabled.has("FAMILIAR_OR_FREQUENT_ITEM")) scope.pattern.add(familiarItemCandidateKey(key));
      if (learningEnabled.has("FAMILIAR_ITEM")) scope.learning.add(familiarLearningCandidateKey(key));
    }
    return scope;
  }

  // --- Plan construction --------------------------------------------------------------

  function derivedRevision<T>(
    recordType: T,
    previous: { recordId: string; revisionId: string; revisionNumber: number; recordedAt: Instant } | null,
    payload: unknown,
    transactionId: TransactionId,
    now: Instant,
  ) {
    return {
      schemaVersion: 1,
      recordType,
      recordId: previous?.recordId ?? ids.recordId(),
      revisionId: ids.revisionId(),
      revisionNumber: previous ? previous.revisionNumber + 1 : 1,
      previousRevisionId: previous?.revisionId ?? null,
      action: previous ? "UPDATE" : "CREATE",
      recordedAt: previous?.recordedAt ?? now,
      revisionCreatedAt: now,
      temporal: { kind: "ATEMPORAL" },
      provenance: SYSTEM_PROVENANCE,
      auditEventId: ids.auditEventId(),
      transactionId,
      payload,
    };
  }

  function audit(
    evaluation: PatternEvaluation | LearningEvaluation,
    engine: "PATTERN" | "LEARNING",
    reasonCode: string,
    limitationCodes: string[],
    triggering: TypedRevisionRef<RecordType>[],
  ): StoredEngineEvaluationAudit {
    return {
      evaluationId: ids.evaluationId(),
      engine,
      evaluatorKey: evaluation.evaluatorKey,
      evaluatorVersion: evaluation.evaluatorVersion,
      configurationVersion: evaluation.configurationVersion,
      runtimeManifestId: INTELLIGENCE_ACTIVATION_MANIFEST.manifestId,
      runtimeManifestVersion: INTELLIGENCE_ACTIVATION_MANIFEST.manifestVersion,
      evaluatedAt: evaluation.evaluatedAt,
      inputSequenceCutoff: evaluation.inputSequenceCutoff,
      candidateKey: evaluation.candidateKey,
      triggeringRevisions: triggering,
      consideredRevisions: evaluation.consideredRevisions,
      inputFingerprint: evaluation.inputFingerprint,
      resultFingerprint: evaluation.resultFingerprint,
      dispositionKind: "RESULT",
      reasonCodes: [reasonCode],
      limitationCodes,
      proposedEffectKeys: [`effect:${evaluation.candidateKey}`],
    } as StoredEngineEvaluationAudit;
  }

  function patternPlan(
    snapshot: IntelligenceSnapshot,
    evaluation: PatternEvaluation,
    triggering: TypedRevisionRef<RecordType>[],
    now: Instant,
    commandId: CommandId,
  ): IntelligenceCommandPlan | null {
    const result = evaluation.result;
    if (result.kind !== "PROPOSAL") return null;
    const chain = snapshot.patternChains.get(evaluation.candidateKey) ?? null;
    const transactionId = ids.transactionId();
    let snapshotRevision: PatternEvidenceSnapshotRevision;
    if (result.snapshot.kind === "NEW") {
      snapshotRevision = derivedRevision(
        "PATTERN_EVIDENCE_SNAPSHOT",
        chain ? chain.snapshotHeadRevision : null,
        result.snapshot.payload,
        transactionId,
        now,
      ) as unknown as PatternEvidenceSnapshotRevision;
    } else {
      if (!chain) return null;
      snapshotRevision = chain.previous.snapshot;
    }
    const observation = derivedRevision(
      "PATTERN_OBSERVATION",
      chain ? chain.previous.observation : null,
      {
        family: result.family,
        claim: result.claim,
        lifecycle: result.lifecycle,
        evidenceSnapshot: {
          recordType: "PATTERN_EVIDENCE_SNAPSHOT",
          recordId: snapshotRevision.recordId,
          revisionId: snapshotRevision.revisionId,
        },
        patientDisposition: chain?.previous.observation.payload.patientDisposition ?? { kind: "NONE" },
      },
      transactionId,
      now,
    ) as unknown as PatternObservationRevision;

    const evaluationAudit = audit(evaluation, "PATTERN", result.reasonCode, result.limitationCodes, triggering);
    const edges: StoredReverseDependency[] =
      result.snapshot.kind === "NEW"
        ? result.sourceRoles.map((source) => ({
            sourceRevisionId: source.ref.revisionId,
            dependentRecordType: "PATTERN_EVIDENCE_SNAPSHOT",
            dependentRecordId: snapshotRevision.recordId,
            dependentRevisionId: snapshotRevision.revisionId,
            dependencyRole: source.role,
            owner: "PATTERN_ENGINE",
            evaluatorKey: evaluation.evaluatorKey,
            evaluatorVersion: evaluation.evaluatorVersion,
            createdAt: now,
          }))
        : [];
    return buildPatternCommitPlan({
      commandId,
      correlationId: ids.correlationId(),
      transactionId,
      completedAt: now,
      snapshot:
        result.snapshot.kind === "NEW"
          ? { kind: "NEW", revision: snapshotRevision, expectedHead: chain?.snapshotHead ?? null }
          : { kind: "REUSED", revision: snapshotRevision },
      observation: { revision: observation, expectedHead: chain?.observationHead ?? null },
      eventIds: result.snapshot.kind === "NEW"
        ? { snapshot: ids.domainEventId(), observation: ids.domainEventId() }
        : { observation: ids.domainEventId() },
      reasonCode: result.reasonCode,
      evaluation: evaluationAudit,
      reverseDependencies: edges,
    });
  }

  function learningPlan(
    snapshot: IntelligenceSnapshot,
    evaluation: LearningEvaluation,
    triggering: TypedRevisionRef<RecordType>[],
    now: Instant,
    commandId: CommandId,
  ): IntelligenceCommandPlan | null {
    const result = evaluation.result;
    if (result.kind !== "PROPOSAL") return null;
    const chain = snapshot.learningChains.get(evaluation.candidateKey) ?? null;
    const transactionId = ids.transactionId();
    const revision = derivedRevision(
      "LEARNED_KNOWLEDGE",
      chain ? chain.revision : null,
      { content: result.content, relationship: { kind: "PRIMARY" }, lifecycle: result.lifecycle, evidence: result.evidence },
      transactionId,
      now,
    ) as unknown as LearnedKnowledgeRevision;
    const evaluationAudit = audit(evaluation, "LEARNING", result.reasonCode, [], triggering);
    return buildLearningCommitPlan({
      commandId,
      correlationId: ids.correlationId(),
      transactionId,
      completedAt: now,
      revision,
      expectedHead: chain?.head ?? null,
      eventId: ids.domainEventId(),
      reasonCode: result.reasonCode,
      evaluation: evaluationAudit,
      // Edges come from the persisted evidence through the rule restore reconstruction also uses.
      reverseDependencies: learnedKnowledgeDependencySources(revision.payload.evidence).map((source) => ({
        sourceRevisionId: source.revisionId,
        dependentRecordType: "LEARNED_KNOWLEDGE",
        dependentRecordId: revision.recordId,
        dependentRevisionId: revision.revisionId,
        dependencyRole: source.role,
        owner: "LEARNING_ENGINE",
        evaluatorKey: evaluation.evaluatorKey,
        evaluatorVersion: evaluation.evaluatorVersion,
        createdAt: now,
      })) as StoredReverseDependency[],
    });
  }

  // --- Evaluation ---------------------------------------------------------------------

  function evaluatePattern(snapshot: IntelligenceSnapshot, key: string): PatternEvaluation | null {
    const previous = snapshot.patternChains.get(key)?.previous ?? null;
    const [family, ...rest] = key.split(":");
    if (!patternEnabled.has(family!)) return null;
    if (family === "COMPARABLE_SLOT_TREND" && rest[0] === "PATIENT_SELECTED_SLOT") {
      return evaluateComparableSlotTrend({
        evaluatedAt: snapshot.evaluatedAt,
        inputSequenceCutoff: snapshot.inputSequenceCutoff,
        slot: { kind: "PATIENT_SELECTED_SLOT", slot: rest[1] as EligiblePatientSelectedSlot },
        readings: snapshot.glucose,
        superseded: snapshot.glucoseSuperseded,
        previous,
      });
    }
    if (family === "FAMILIAR_OR_FREQUENT_ITEM") {
      return evaluateFamiliarOrFrequentItem({
        evaluatedAt: snapshot.evaluatedAt,
        inputSequenceCutoff: snapshot.inputSequenceCutoff,
        familiarItemKey: rest[0]!,
        intakeEvents: snapshot.intakeEvents,
        activityEvents: snapshot.activityEvents,
        superseded: snapshot.eventSuperseded,
        previous,
      });
    }
    return null;
  }

  function evaluateLearning(snapshot: IntelligenceSnapshot, key: string): LearningEvaluation | null {
    const [family, familiarItemKey] = key.split(":");
    if (family !== "FAMILIAR_ITEM" || !learningEnabled.has("FAMILIAR_ITEM")) return null;
    return evaluateFamiliarItemLearning({
      evaluatedAt: snapshot.evaluatedAt,
      inputSequenceCutoff: snapshot.inputSequenceCutoff,
      familiarItemKey: familiarItemKey!,
      intakeEvents: snapshot.intakeEvents,
      activityEvents: snapshot.activityEvents,
      superseded: snapshot.eventSuperseded,
      previous: snapshot.learningChains.get(key)?.revision ?? null,
    });
  }

  async function executeAll(plans: IntelligenceCommandPlan[]): Promise<CommandId[]> {
    const committed: CommandId[] = [];
    for (const plan of plans) {
      const receipt = await store.execute(plan);
      // A head conflict leaves newer data in place; the next run reevaluates it.
      if (receipt.outcome === "COMMITTED") committed.push(receipt.commandId);
    }
    return committed;
  }

  /** Delete dependent derived chains, then evaluate the scope. Returns committed command IDs. */
  async function evaluateScope(
    scope: Scope,
    deletions: { pattern: Set<string>; learning: Set<string> },
    triggering: TypedRevisionRef<RecordType>[],
    plannedCommandIds: Map<string, CommandId>,
  ): Promise<{ pattern: CommandId[]; learning: CommandId[] }> {
    const now = dependencies.now();
    let snapshot = await loadIntelligenceSnapshot(database, now);
    // Each owner's deletion plans stay separate so a rejected plan cannot shift
    // another owner's committed command into the wrong receipt.
    const deletionPlans: DeletionPlans = { pattern: [], learning: [] };
    for (const key of [...deletions.pattern].sort()) {
      const chain = snapshot.patternChains.get(key);
      if (!chain) continue;
      deletionPlans.pattern.push(
        buildDerivedDeletionPlan({
          commandId: plannedCommandIds.get(`delete:${key}`) ?? ids.commandId(),
          correlationId: ids.correlationId(),
          transactionId: ids.transactionId(),
          completedAt: now,
          reasonCode: "PATTERN_DERIVED_CONTENT_DELETED",
          targets: [chain.snapshotHead, chain.observationHead].map((head) => ({
            head,
            auditEventId: ids.auditEventId(),
            eventId: ids.domainEventId(),
          })),
        }),
      );
    }
    for (const key of [...deletions.learning].sort()) {
      const chain = snapshot.learningChains.get(key);
      if (!chain) continue;
      deletionPlans.learning.push(
        buildDerivedDeletionPlan({
          commandId: plannedCommandIds.get(`delete:${key}`) ?? ids.commandId(),
          correlationId: ids.correlationId(),
          transactionId: ids.transactionId(),
          completedAt: now,
          reasonCode: "LEARNED_DERIVED_CONTENT_DELETED",
          targets: [{ head: chain.head, auditEventId: ids.auditEventId(), eventId: ids.domainEventId() }],
        }),
      );
    }
    const deletedPattern = await executeAll(deletionPlans.pattern);
    const deletedLearning = await executeAll(deletionPlans.learning);
    if (deletionPlans.pattern.length + deletionPlans.learning.length > 0) snapshot = await loadIntelligenceSnapshot(database, now);

    const patternPlans = [...scope.pattern]
      .sort()
      .map((key) => evaluatePattern(snapshot, key))
      .map((evaluation) =>
        evaluation ? patternPlan(snapshot, evaluation, triggering, now, plannedCommandIds.get(evaluation.candidateKey) ?? ids.commandId()) : null,
      )
      .filter((plan): plan is IntelligenceCommandPlan => plan !== null);
    const learningPlans = [...scope.learning]
      .sort()
      .map((key) => evaluateLearning(snapshot, key))
      .map((evaluation) =>
        evaluation ? learningPlan(snapshot, evaluation, triggering, now, plannedCommandIds.get(evaluation.candidateKey) ?? ids.commandId()) : null,
      )
      .filter((plan): plan is IntelligenceCommandPlan => plan !== null);

    const patternCommands = await executeAll(patternPlans);
    const learningCommands = await executeAll(learningPlans);
    return { pattern: [...deletedPattern, ...patternCommands], learning: [...deletedLearning, ...learningCommands] };
  }

  // --- Work processing ------------------------------------------------------------------

  async function resolveChangeTarget(eventId: string): Promise<ChangeTarget | null> {
    const raw = (await database.table("domainEvents").get(eventId)) as { change?: unknown } | undefined;
    const parsed = eventRecordChangeSchema.safeParse(raw?.change);
    if (!parsed.success) return null;
    const change = parsed.data;
    const history = (await database.table("recordRevisions").where("recordId").equals(change.recordId).toArray()) as Array<{
      revisionId: string;
    }>;
    const revisionIds = new Set(history.map((row) => row.revisionId));
    if (change.previousRevisionId) revisionIds.add(change.previousRevisionId);
    if (change.resultingRevisionId) revisionIds.add(change.resultingRevisionId);
    return {
      recordType: change.recordType,
      recordId: change.recordId,
      revisionIds: [...revisionIds],
      // Taken from the validated change itself, never inferred from stored history order.
      triggeringRevisionId: change.kind === "REVISION_CREATED" ? change.resultingRevisionId : null,
      deleted: change.kind === "RECORD_DELETED",
    };
  }

  async function processPendingOnce(): Promise<IntelligenceRunReport> {
    const now = dependencies.now();
    const leaseToken = ids.leaseToken();
    const claimed: StoredEventWorkItem[] = [];
    for (let i = 0; i < MAX_CLAIMS_PER_RUN; i += 1) {
      const item = await work.claimNext({
        now,
        leaseExpiresAt: new Date(Date.parse(now) + LEASE_MS).toISOString() as Instant,
        leaseToken,
        claimedByInstance: dependencies.instanceId,
        // Claim only Learning and Pattern work; Packet 8 owners claim their own.
        consumers: ["PATTERN_REEVALUATION", "LEARNING_REEVALUATION"],
      });
      if (!item) break;
      const supported =
        (item.consumer === "PATTERN_REEVALUATION" && item.handlerVersion === PATTERN_HANDLER_VERSION) ||
        (item.consumer === "LEARNING_REEVALUATION" && item.handlerVersion === LEARNING_HANDLER_VERSION);
      if (!supported) {
        await work.transition({
          workItemId: item.workItemId,
          leaseToken,
          now,
          state: { state: "TERMINAL_FAILURE", failedAt: now, errorCode: "HANDLER_CONFIGURATION_INVALID" },
        });
        continue;
      }
      claimed.push(item);
    }
    if (claimed.length === 0) return { claimedWorkItems: 0, committedCommands: 0, failed: false };

    try {
      const scope: Scope = { pattern: new Set(), learning: new Set() };
      const deletions = { pattern: new Set<string>(), learning: new Set<string>() };
      const triggering = new Map<string, TypedRevisionRef<RecordType>>();
      const current = await loadIntelligenceSnapshot(database, now);
      const consumersByEvent = new Map<string, Set<string>>();
      for (const item of claimed) {
        consumersByEvent.set(item.eventId, new Set([...(consumersByEvent.get(item.eventId) ?? []), item.consumer]));
      }
      for (const [eventId, consumers] of consumersByEvent) {
        const target = await resolveChangeTarget(eventId);
        if (!target) continue;
        if (target.triggeringRevisionId !== null) {
          triggering.set(target.triggeringRevisionId, {
            recordType: target.recordType,
            recordId: target.recordId,
            revisionId: target.triggeringRevisionId,
          });
        }
        // Candidates named by the latest and every earlier representation of the record.
        const rows = (await database.table("recordRevisions").where("recordId").equals(target.recordId).toArray()) as unknown[];
        for (const row of rows) {
          try {
            const stored = validatePacket6StoredRevision(row);
            addPayloadCandidates(scope, target.recordType, stored.revision.payload, consumers);
          } catch {
            // Non-journal or purged rows contribute no candidates.
          }
        }
        // Exact reverse dependencies: derived chains that used any representation of the record.
        const edges = (await database.table("reverseDependencies").where("sourceRevisionId").anyOf(target.revisionIds).toArray()) as Array<{
          dependentRecordId: string;
          dependentRecordType: string;
        }>;
        for (const edge of edges) {
          const patternKey = current.candidateBySnapshotRecord.get(edge.dependentRecordId);
          if (patternKey && consumers.has("PATTERN_REEVALUATION")) {
            scope.pattern.add(patternKey);
            if (target.deleted) deletions.pattern.add(patternKey);
          }
          const learningKey = current.candidateByLearnedRecord.get(edge.dependentRecordId);
          if (learningKey && consumers.has("LEARNING_REEVALUATION")) {
            scope.learning.add(learningKey);
            if (target.deleted) deletions.learning.add(learningKey);
          }
        }
      }

      // Planned command IDs are persisted before submission; a crashed run reuses them.
      const plannedCommandIds = new Map<string, CommandId>();
      for (const item of claimed) {
        for (const planned of item.plannedCommands) plannedCommandIds.set(planned.effectKey, planned.commandId as CommandId);
      }
      const effectKeysByConsumer: Record<string, string[]> = {
        PATTERN_REEVALUATION: [...[...deletions.pattern].map((key) => `delete:${key}`), ...scope.pattern],
        LEARNING_REEVALUATION: [...[...deletions.learning].map((key) => `delete:${key}`), ...scope.learning],
      };
      for (const key of Object.values(effectKeysByConsumer).flat()) {
        if (!plannedCommandIds.has(key)) plannedCommandIds.set(key, ids.commandId());
      }
      for (const item of claimed) {
        await work.persistPlannedCommands({
          workItemId: item.workItemId,
          leaseToken,
          now,
          plannedCommands: (effectKeysByConsumer[item.consumer] ?? []).map((key) => ({
            effectKey: key,
            commandId: plannedCommandIds.get(key)!,
          })),
        });
      }

      const committed = await evaluateScope(scope, deletions, sortRevisionRefs([...triggering.values()]), plannedCommandIds);
      const completedAt = dependencies.now();
      for (const item of claimed) {
        const commandIds = item.consumer === "PATTERN_REEVALUATION" ? committed.pattern : committed.learning;
        const receipt: EventConsumerReceipt = {
          eventId: item.eventId,
          consumer: item.consumer,
          handlerVersion: item.handlerVersion,
          completedAt,
          outcome:
            commandIds.length > 0
              ? { kind: "COMMANDS_COMMITTED", commandIds: [...new Set(commandIds)] as [CommandId, ...CommandId[]] }
              : { kind: "NO_ACTION_REQUIRED" },
        };
        await work.complete({ workItemId: item.workItemId, leaseToken, now: completedAt, receipt });
      }
      return {
        claimedWorkItems: claimed.length,
        committedCommands: committed.pattern.length + committed.learning.length,
        failed: false,
      };
    } catch (error) {
      // A technical failure publishes nothing new and leaves work for a bounded retry.
      const terminal = error instanceof IntelligenceIntegrityError;
      for (const item of claimed) {
        try {
          await work.transition({
            workItemId: item.workItemId,
            leaseToken,
            now,
            state: terminal
              ? { state: "TERMINAL_FAILURE", failedAt: now, errorCode: "INTEGRITY_CHECK_FAILED" }
              : {
                  state: "RETRY_WAIT",
                  availableAt: new Date(Date.parse(now) + RETRY_MS).toISOString() as Instant,
                  errorCode: "TRANSIENT_STORAGE_ERROR",
                },
          });
        } catch {
          // The lease expires and another run may reclaim the item.
        }
      }
      return { claimedWorkItems: claimed.length, committedCommands: 0, failed: true };
    }
  }

  async function refreshAllOnce(): Promise<IntelligenceRunReport> {
    try {
      const now = dependencies.now();
      const scope = discoverAll(await loadIntelligenceSnapshot(database, now));
      const committed = await evaluateScope(scope, { pattern: new Set(), learning: new Set() }, [], new Map());
      return { claimedWorkItems: 0, committedCommands: committed.pattern.length + committed.learning.length, failed: false };
    } catch {
      return { claimedWorkItems: 0, committedCommands: 0, failed: true };
    }
  }

  return Object.freeze({
    processPending: () => serialised(processPendingOnce),
    refreshAll: () => serialised(refreshAllOnce),
  });
}
