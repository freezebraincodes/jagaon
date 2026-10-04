import { z } from "zod";
import type { CommandId, CorrelationId, DomainEventId } from "@/application/contracts/command-event-identifiers";
import { fingerprint } from "@/application/intelligence/metrics";
import type { AuditEventId, Instant, RecordHead, RecordId, RevisionId, TransactionId } from "@/domain/shared";
import type { ProvenanceCore } from "@/domain/shared/provenance";
import type { TypedRevisionRef } from "@/domain/shared/typed-revision-ref";
import type { CareSummaryInvalidationReason, CareSummarySnapshotPayload, CareSummarySnapshotRevision } from "@/domain/care-preparation/care-summary-snapshot";
import { HACKATHON_EXPORT_PROFILE, type CareSummaryExportOutcome, type CareSummaryExportRevision } from "@/domain/care-preparation/care-summary-export";
import { CommandTransactionError } from "@/storage/authoritative-command-transaction";
import { StorageRowValidationError } from "@/storage/storage-row-codec";
import type { JagaOnDatabase } from "@/storage/database";
import { OwnerPlanError } from "@/application/owner-plan-support";
import {
  buildCarePreparationCommitPlan,
  carePreparationRevisionRowCodec,
  createCarePreparationCommandStore,
  type CarePreparationAuditReason,
  type CarePreparationChange,
  type CarePreparationEventReason,
  type CarePreparationRevision,
} from "./care-preparation-persistence";
import { renderDeterministicCareSummary } from "./deterministic-care-summary-renderer";
import { loadCareSummaryDraft, sourcesAreCurrent } from "./care-summary-candidates";
import type { CarePreparationCommandPort, CarePreparationCommitResult, ExpectedHead, PrintObservation } from "./care-preparation-contracts";

/**
 * Packet 9C Care Preparation command service (domain 11.10; event-contracts
 * 7.4 and 11.1). Every write is one authoritative transaction. No external
 * side effect happens here: the caller performs the print interaction
 * between `requestPrintExport` and `completePrintExport`.
 */

export type CarePreparationDependencies = {
  now(): Instant;
  ids: {
    commandId(): CommandId;
    correlationId(): CorrelationId;
    recordId(): RecordId;
    revisionId(): RevisionId;
    auditEventId(): AuditEventId;
    transactionId(): TransactionId;
    domainEventId(): DomainEventId;
  };
};

/** Internal system effect used by the invalidation worker only. */
export type CarePreparationService = CarePreparationCommandPort & {
  systemInvalidate(input: { recordId: RecordId; reason: CareSummaryInvalidationReason; commandId?: CommandId }): Promise<CarePreparationCommitResult | "NO_CHANGE">;
};

const SYSTEM_DERIVATION: ProvenanceCore = { sourceKind: "SYSTEM_DERIVATION", captureMethod: "RULE_ENGINE", initiator: "JAGAON_SYSTEM", assistance: "NONE" };
const PATIENT_ENTRY: ProvenanceCore = { sourceKind: "PATIENT_ENTRY", captureMethod: "FORM", initiator: "PATIENT", assistance: "NONE" };
const ACTIONABLE = new Set(["PREPARED", "PREVIEWED", "APPROVED"]);
const PATIENT_REASONS = new Set<CareSummaryInvalidationReason>(["PATIENT_CHANGED_SELECTION", "PATIENT_CHANGED_PURPOSE", "PATIENT_CHANGED_PERIOD", "PATIENT_CHANGED_LOCALE"]);

const refOf = <T extends "CARE_SUMMARY_SNAPSHOT" | "CARE_SUMMARY_EXPORT">(revision: { recordType: T; recordId: RecordId; revisionId: RevisionId }): TypedRevisionRef<T> => ({
  recordType: revision.recordType,
  recordId: revision.recordId,
  revisionId: revision.revisionId,
});

export function createCarePreparationService(database: JagaOnDatabase, dependencies: CarePreparationDependencies): CarePreparationService {
  const store = createCarePreparationCommandStore(database);
  const { ids } = dependencies;

  async function readHead(recordId: RecordId): Promise<RecordHead | null> {
    return ((await database.table("recordHeads").get(recordId)) as RecordHead | undefined) ?? null;
  }

  async function readRevision(revisionId: RevisionId): Promise<CarePreparationRevision | null> {
    const raw = await database.table("recordRevisions").get(revisionId);
    return raw === undefined ? null : carePreparationRevisionRowCodec.validateAfterRead(raw).revision;
  }

  async function commit(input: {
    commandName: string;
    hashMaterial: unknown;
    commandId?: CommandId;
    transactionId: TransactionId;
    now: Instant;
    changes: CarePreparationChange[];
    summarySources?: { snapshot: { recordId: RecordId; revisionId: RevisionId }; sourceRevisionIds: RevisionId[] };
  }): Promise<CarePreparationCommitResult> {
    try {
      const plan = buildCarePreparationCommitPlan({
        commandId: input.commandId ?? ids.commandId(),
        commandHash: fingerprint({ commandName: input.commandName, content: input.hashMaterial }),
        correlationId: ids.correlationId(),
        transactionId: input.transactionId,
        completedAt: input.now,
        changes: input.changes,
        summarySources: input.summarySources,
      });
      const receipt = await store.execute(plan);
      if (receipt.outcome === "COMMITTED") {
        const first = receipt.resultingRevisions[0];
        const target = input.changes[0];
        if (first) {
          const revisionNumber = target?.kind === "REVISION" && target.revision.revisionId === first.revisionId ? target.revision.revisionNumber : ((await readHead(first.recordId))?.headRevisionNumber ?? 1);
          return { kind: "COMMITTED", recordId: first.recordId, revisionId: first.revisionId, revisionNumber };
        }
        if (receipt.deletedRecords.length > 0 && target?.kind === "DELETE") return { kind: "COMMITTED", recordId: target.head.recordId, revisionId: target.head.headRevisionId, revisionNumber: target.head.headRevisionNumber };
        return { kind: "FAILED", code: "COMMIT_FAILED" };
      }
      if (receipt.outcome === "REJECTED") return { kind: "REJECTED", code: "HEAD_CONFLICT" };
      return { kind: "FAILED", code: "COMMIT_FAILED" };
    } catch (error) {
      if (error instanceof OwnerPlanError || error instanceof z.ZodError || error instanceof StorageRowValidationError) return { kind: "FAILED", code: "VALIDATION_FAILED" };
      if (error instanceof CommandTransactionError && error.code === "COMMAND_REPLAY_MISMATCH") return { kind: "FAILED", code: "COMMIT_FAILED" };
      return { kind: "FAILED", code: "STORAGE_UNAVAILABLE" };
    }
  }

  function envelope<T extends CarePreparationRevision["recordType"]>(input: {
    recordType: T;
    recordId: RecordId;
    revisionNumber: number;
    previousRevisionId: RevisionId | null;
    action: "CREATE" | "UPDATE" | "SYSTEM_DERIVE";
    recordedAt: Instant;
    now: Instant;
    transactionId: TransactionId;
  }) {
    return {
      schemaVersion: 1,
      recordType: input.recordType,
      recordId: input.recordId,
      revisionId: ids.revisionId(),
      revisionNumber: input.revisionNumber,
      previousRevisionId: input.previousRevisionId,
      action: input.action,
      recordedAt: input.recordedAt,
      revisionCreatedAt: input.now,
      temporal: { kind: "ATEMPORAL" as const },
      provenance: input.recordType === "CARE_SUMMARY_SNAPSHOT" ? SYSTEM_DERIVATION : PATIENT_ENTRY,
      auditEventId: ids.auditEventId(),
      transactionId: input.transactionId,
    };
  }

  function change(
    revision: CarePreparationRevision,
    expectedHead: RecordHead | null,
    eventName: Extract<CarePreparationChange, { kind: "REVISION" }>["eventName"],
    eventReason: CarePreparationEventReason,
    auditReason: CarePreparationAuditReason,
    initiator: "PATIENT" | "JAGAON_SYSTEM",
  ): CarePreparationChange {
    return { kind: "REVISION", revision, expectedHead, eventId: ids.domainEventId(), eventName, eventReason, auditReason, initiator };
  }

  type Loaded<T> = { head: RecordHead; revision: T };

  async function loadExpected<T extends CarePreparationRevision>(expected: ExpectedHead, recordType: T["recordType"]): Promise<Loaded<T> | CarePreparationCommitResult> {
    try {
      const head = await readHead(expected.recordId);
      if (!head || head.recordType !== recordType) return { kind: "FAILED", code: "NOT_FOUND" };
      // A purged snapshot can never be previewed, approved or exported again.
      if (head.state === "DELETED") return { kind: "REJECTED", code: "SUMMARY_INVALIDATED_FOR_EXPORT" };
      if (head.state !== "ACTIVE" || head.headRevisionId !== expected.expectedRevisionId || head.headRevisionNumber !== expected.expectedRevisionNumber) return { kind: "REJECTED", code: "HEAD_CONFLICT" };
      const revision = await readRevision(head.headRevisionId);
      if (!revision || revision.recordType !== recordType) return { kind: "FAILED", code: "NOT_FOUND" };
      return { head, revision: revision as T };
    } catch {
      return { kind: "FAILED", code: "STORAGE_UNAVAILABLE" };
    }
  }

  const isResult = (value: unknown): value is CarePreparationCommitResult => typeof value === "object" && value !== null && "kind" in value;

  /** A lifecycle revision never changes content: only status, approval or invalidation. */
  function lifecycleRevision(loaded: Loaded<CareSummarySnapshotRevision>, payload: CareSummarySnapshotPayload, action: "UPDATE" | "SYSTEM_DERIVE", now: Instant, transactionId: TransactionId): CareSummarySnapshotRevision {
    return {
      ...envelope({ recordType: "CARE_SUMMARY_SNAPSHOT", recordId: loaded.revision.recordId, revisionNumber: loaded.head.headRevisionNumber + 1, previousRevisionId: loaded.head.headRevisionId, action, recordedAt: loaded.revision.recordedAt, now, transactionId }),
      payload,
    } as CareSummarySnapshotRevision;
  }

  const sourcesOf = (payload: CareSummarySnapshotPayload) => payload.selection.includedSourceRevisions;

  async function invalidateLoaded(loaded: Loaded<CareSummarySnapshotRevision>, reason: CareSummaryInvalidationReason, commandId: CommandId | undefined): Promise<CarePreparationCommitResult> {
    const now = dependencies.now();
    const transactionId = ids.transactionId();
    const system = !PATIENT_REASONS.has(reason);
    const { invalidation: _previous, ...rest } = loaded.revision.payload;
    const revision = lifecycleRevision(loaded, { ...rest, status: "INVALIDATED", invalidation: { invalidatedAt: now, reason } }, system ? "SYSTEM_DERIVE" : "UPDATE", now, transactionId);
    return commit({
      commandName: "INVALIDATE_CARE_SUMMARY",
      hashMaterial: { target: loaded.head.headRevisionId, reason },
      commandId,
      transactionId,
      now,
      changes: [change(revision, loaded.head, "CARE_SUMMARY_SNAPSHOT_INVALIDATED", "INVALIDATED", "SUMMARY_INVALIDATED", system ? "JAGAON_SYSTEM" : "PATIENT")],
    });
  }

  async function activeSnapshot(recordId: RecordId): Promise<Loaded<CareSummarySnapshotRevision> | null> {
    const head = await readHead(recordId);
    if (!head || head.state !== "ACTIVE" || head.recordType !== "CARE_SUMMARY_SNAPSHOT") return null;
    const revision = await readRevision(head.headRevisionId);
    return revision && revision.recordType === "CARE_SUMMARY_SNAPSHOT" ? { head, revision } : null;
  }

  async function completeLoaded(loaded: Loaded<CareSummaryExportRevision>, outcome: CareSummaryExportOutcome, commandId: CommandId | undefined, now: Instant): Promise<CarePreparationCommitResult> {
    const transactionId = ids.transactionId();
    const revision = {
      ...envelope({ recordType: "CARE_SUMMARY_EXPORT", recordId: loaded.revision.recordId, revisionNumber: loaded.head.headRevisionNumber + 1, previousRevisionId: loaded.head.headRevisionId, action: "UPDATE", recordedAt: loaded.revision.recordedAt, now, transactionId }),
      payload: { ...loaded.revision.payload, outcome },
    } as CareSummaryExportRevision;
    return commit({
      commandName: "COMPLETE_CARE_SUMMARY_EXPORT",
      hashMaterial: { target: loaded.head.headRevisionId, outcome: outcome.state },
      commandId,
      transactionId,
      now,
      changes: [change(revision, loaded.head, "CARE_SUMMARY_EXPORT_OUTCOME_RECORDED", outcome.state as CarePreparationEventReason, "EXPORT_OUTCOME_RECORDED", "PATIENT")],
    });
  }

  return Object.freeze({
    async prepare(input) {
      const now = dependencies.now();
      let loaded;
      let replaced: Loaded<CareSummarySnapshotRevision> | null = null;
      try {
        loaded = await loadCareSummaryDraft(database, input, now);
        if (input.replaces) {
          const result = await loadExpected<CareSummarySnapshotRevision>(input.replaces, "CARE_SUMMARY_SNAPSHOT");
          if (isResult(result)) return result;
          replaced = result;
        }
      } catch {
        return { kind: "FAILED", code: "STORAGE_UNAVAILABLE" };
      }
      if (loaded.kind === "EMPTY") return { kind: "REJECTED", code: "SUMMARY_SELECTION_EMPTY" };
      if (loaded.kind === "TOO_LARGE") return { kind: "REJECTED", code: "SUMMARY_SELECTION_TOO_LARGE" };
      if (loaded.kind === "INELIGIBLE") return { kind: "REJECTED", code: "SUMMARY_SOURCE_INELIGIBLE" };
      const draft = replaced ? { ...loaded.draft, replacesSnapshot: refOf(replaced.revision) } : loaded.draft;
      let prepared;
      try {
        prepared = await renderDeterministicCareSummary(draft);
      } catch {
        return { kind: "FAILED", code: "VALIDATION_FAILED" };
      }
      const transactionId = ids.transactionId();
      const recordId = ids.recordId();
      const revision = {
        ...envelope({ recordType: "CARE_SUMMARY_SNAPSHOT", recordId, revisionNumber: 1, previousRevisionId: null, action: "CREATE", recordedAt: now, now, transactionId }),
        payload: prepared.payload,
      } as CareSummarySnapshotRevision;
      const changes: CarePreparationChange[] = [change(revision, null, "CARE_SUMMARY_SNAPSHOT_PREPARED", "PREPARED", "SUMMARY_PREPARED", "PATIENT")];
      // A replacement supersedes an earlier snapshot that could still be exported.
      if (replaced && ACTIONABLE.has(replaced.revision.payload.status)) {
        const superseded = lifecycleRevision(replaced, { ...replaced.revision.payload, status: "SUPERSEDED" }, "UPDATE", now, transactionId);
        changes.push(change(superseded, replaced.head, "CARE_SUMMARY_SNAPSHOT_SUPERSEDED", "SUPERSEDED", "SUMMARY_SUPERSEDED", "PATIENT"));
      }
      return commit({
        commandName: "PREPARE_CARE_SUMMARY",
        hashMaterial: { selection: input, contentHash: prepared.contentHash },
        commandId: input.commandId,
        transactionId,
        now,
        changes,
        summarySources: { snapshot: { recordId, revisionId: revision.revisionId }, sourceRevisionIds: prepared.sourceRevisions.map((source) => source.revisionId) },
      });
    },

    async markPreviewed(input) {
      const loaded = await loadExpected<CareSummarySnapshotRevision>(input, "CARE_SUMMARY_SNAPSHOT");
      if (isResult(loaded)) return loaded;
      const payload = loaded.revision.payload;
      if (payload.rendering.contentHash !== input.contentHash) return { kind: "REJECTED", code: "SUMMARY_CONTENT_HASH_MISMATCH" };
      if (!ACTIONABLE.has(payload.status)) return { kind: "REJECTED", code: "SUMMARY_INVALIDATED_FOR_EXPORT" };
      // Previewing again records nothing new.
      if (payload.status !== "PREPARED") return { kind: "COMMITTED", recordId: loaded.head.recordId, revisionId: loaded.head.headRevisionId, revisionNumber: loaded.head.headRevisionNumber };
      const now = dependencies.now();
      const transactionId = ids.transactionId();
      return commit({
        commandName: "MARK_CARE_SUMMARY_PREVIEWED",
        hashMaterial: { target: loaded.head.headRevisionId, contentHash: input.contentHash },
        commandId: input.commandId,
        transactionId,
        now,
        changes: [change(lifecycleRevision(loaded, { ...payload, status: "PREVIEWED" }, "UPDATE", now, transactionId), loaded.head, "CARE_SUMMARY_SNAPSHOT_PREVIEWED", "PREVIEWED", "SUMMARY_PREVIEWED", "PATIENT")],
      });
    },

    async approve(input) {
      const loaded = await loadExpected<CareSummarySnapshotRevision>(input, "CARE_SUMMARY_SNAPSHOT");
      if (isResult(loaded)) return loaded;
      const payload = loaded.revision.payload;
      if (payload.status === "INVALIDATED" || payload.status === "SUPERSEDED") return { kind: "REJECTED", code: "SUMMARY_INVALIDATED_FOR_EXPORT" };
      if (payload.status !== "PREVIEWED") return { kind: "REJECTED", code: "SUMMARY_NOT_APPROVED" };
      if (payload.rendering.contentHash !== input.contentHash) return { kind: "REJECTED", code: "SUMMARY_CONTENT_HASH_MISMATCH" };
      try {
        if (!(await sourcesAreCurrent(database, sourcesOf(payload)))) return { kind: "REJECTED", code: "SUMMARY_INVALIDATED_FOR_EXPORT" };
      } catch {
        return { kind: "FAILED", code: "STORAGE_UNAVAILABLE" };
      }
      const now = dependencies.now();
      const transactionId = ids.transactionId();
      const approved = { ...payload, status: "APPROVED" as const, patientApproval: { state: "APPROVED" as const, approvedAt: now, approvedContentHash: payload.rendering.contentHash } };
      return commit({
        commandName: "APPROVE_CARE_SUMMARY",
        hashMaterial: { target: loaded.head.headRevisionId, contentHash: input.contentHash },
        commandId: input.commandId,
        transactionId,
        now,
        changes: [change(lifecycleRevision(loaded, approved, "UPDATE", now, transactionId), loaded.head, "CARE_SUMMARY_SNAPSHOT_APPROVED", "APPROVED", "SUMMARY_APPROVED", "PATIENT")],
      });
    },

    async invalidate(input) {
      const loaded = await loadExpected<CareSummarySnapshotRevision>(input, "CARE_SUMMARY_SNAPSHOT");
      if (isResult(loaded)) return loaded;
      if (loaded.revision.payload.status === "INVALIDATED") return { kind: "COMMITTED", recordId: loaded.head.recordId, revisionId: loaded.head.headRevisionId, revisionNumber: loaded.head.headRevisionNumber };
      return invalidateLoaded(loaded, input.reason, input.commandId);
    },

    async supersede(input) {
      const loaded = await loadExpected<CareSummarySnapshotRevision>(input, "CARE_SUMMARY_SNAPSHOT");
      if (isResult(loaded)) return loaded;
      if (!ACTIONABLE.has(loaded.revision.payload.status)) return { kind: "REJECTED", code: "SUMMARY_INVALIDATED_FOR_EXPORT" };
      if (input.replacement.recordId === loaded.head.recordId) return { kind: "FAILED", code: "VALIDATION_FAILED" };
      const now = dependencies.now();
      const transactionId = ids.transactionId();
      return commit({
        commandName: "SUPERSEDE_CARE_SUMMARY",
        hashMaterial: { target: loaded.head.headRevisionId, replacement: input.replacement },
        commandId: input.commandId,
        transactionId,
        now,
        changes: [change(lifecycleRevision(loaded, { ...loaded.revision.payload, status: "SUPERSEDED" }, "UPDATE", now, transactionId), loaded.head, "CARE_SUMMARY_SNAPSHOT_SUPERSEDED", "SUPERSEDED", "SUMMARY_SUPERSEDED", "PATIENT")],
      });
    },

    async requestPrintExport(input) {
      const loaded = await loadExpected<CareSummarySnapshotRevision>(input, "CARE_SUMMARY_SNAPSHOT");
      if (isResult(loaded)) return loaded;
      const payload = loaded.revision.payload;
      // Preflight before any record or side effect (domain 11.10).
      if (payload.status === "INVALIDATED" || payload.status === "SUPERSEDED") return { kind: "REJECTED", code: "SUMMARY_INVALIDATED_FOR_EXPORT" };
      if (payload.status !== "APPROVED" || payload.patientApproval.state !== "APPROVED") return { kind: "REJECTED", code: "SUMMARY_NOT_APPROVED" };
      if (payload.patientApproval.approvedContentHash !== payload.rendering.contentHash || input.approvedContentHash !== payload.rendering.contentHash) return { kind: "REJECTED", code: "SUMMARY_CONTENT_HASH_MISMATCH" };
      try {
        if (!(await sourcesAreCurrent(database, sourcesOf(payload)))) return { kind: "REJECTED", code: "SUMMARY_INVALIDATED_FOR_EXPORT" };
      } catch {
        return { kind: "FAILED", code: "STORAGE_UNAVAILABLE" };
      }
      const now = dependencies.now();
      const transactionId = ids.transactionId();
      const revision = {
        ...envelope({ recordType: "CARE_SUMMARY_EXPORT", recordId: ids.recordId(), revisionNumber: 1, previousRevisionId: null, action: "CREATE", recordedAt: now, now, transactionId }),
        payload: {
          snapshot: refOf(loaded.revision),
          approvedContentHash: payload.rendering.contentHash,
          method: HACKATHON_EXPORT_PROFILE.method,
          artifactFormat: HACKATHON_EXPORT_PROFILE.artifactFormat,
          requestedAt: now,
          outcome: { state: "REQUESTED" },
          externalConfirmation: { state: "NONE" },
          replacesExports: input.replacesExports ?? [],
        },
      } as CareSummaryExportRevision;
      return commit({
        commandName: "REQUEST_CARE_SUMMARY_EXPORT",
        hashMaterial: { snapshot: loaded.head.headRevisionId, approvedContentHash: input.approvedContentHash },
        commandId: input.commandId,
        transactionId,
        now,
        changes: [change(revision, null, "CARE_SUMMARY_EXPORT_REQUESTED", "REQUESTED", "EXPORT_REQUESTED", "PATIENT")],
      });
    },

    async completePrintExport(input) {
      const loaded = await loadExpected<CareSummaryExportRevision>(input, "CARE_SUMMARY_EXPORT");
      if (isResult(loaded)) return loaded;
      if (loaded.revision.payload.outcome.state !== "REQUESTED") return { kind: "REJECTED", code: "EXPORT_OUTCOME_INVALID" };
      const now = dependencies.now();
      const outcome = printOutcome(input.observation, input.artifact, now);
      if (!outcome) return { kind: "REJECTED", code: "EXPORT_OUTCOME_INVALID" };
      return completeLoaded(loaded, outcome, input.commandId, now);
    },

    async recoverInterruptedExports() {
      const heads = (await database.table("recordHeads").where("recordType").equals("CARE_SUMMARY_EXPORT").toArray()) as RecordHead[];
      let recovered = 0;
      for (const head of heads) {
        if (head.state !== "ACTIVE") continue;
        const revision = await readRevision(head.headRevisionId);
        if (!revision || revision.recordType !== "CARE_SUMMARY_EXPORT" || revision.payload.outcome.state !== "REQUESTED") continue;
        const now = dependencies.now();
        // The attempt is never replayed; its result is recorded as unknown.
        const result = await completeLoaded({ head, revision }, { state: "OUTCOME_UNKNOWN", lastObservedAt: now, stage: "PRINT" }, undefined, now);
        if (result.kind === "COMMITTED") recovered += 1;
      }
      return recovered;
    },

    async systemInvalidate(input) {
      const loaded = await activeSnapshot(input.recordId);
      if (!loaded || !ACTIONABLE.has(loaded.revision.payload.status)) return "NO_CHANGE";
      return invalidateLoaded(loaded, input.reason, input.commandId);
    },

  });
}

/** Only what the browser interaction proved; nothing becomes delivery or review. */
function printOutcome(observation: PrintObservation, artifact: { hash: string; byteLength: number } | null, now: Instant): CareSummaryExportOutcome | null {
  if (observation === "DIALOG_OPENED") {
    if (!artifact) return null;
    return { state: "EXPORTED", completedAt: now, artifactHash: artifact.hash, byteLength: artifact.byteLength, evidence: "PRINT_DIALOG_OPENED" };
  }
  if (observation === "UNAVAILABLE") return { state: "FAILED", failedAt: now, reason: "PRINT_UNAVAILABLE" };
  return { state: "OUTCOME_UNKNOWN", lastObservedAt: now, stage: "PRINT" };
}
