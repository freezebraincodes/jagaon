import { z } from "zod";
import type { CommandId, CorrelationId, DomainEventId } from "@/application/contracts/command-event-identifiers";
import type { WorkItemId } from "@/application/contracts/event-work";
import { fingerprint } from "@/application/intelligence/metrics";
import type { AuditEventId, Instant, RecordHead, RecordId, RevisionId, TransactionId } from "@/domain/shared";
import type { ProvenanceCore } from "@/domain/shared/provenance";
import type { PreventiveCareRecordRevision } from "@/domain/health-records/preventive-care-record";
import type { ContextWindowRevision } from "@/domain/health-records/context-window";
import { CommandTransactionError } from "@/storage/authoritative-command-transaction";
import { StorageRowValidationError } from "@/storage/storage-row-codec";
import type { JagaOnDatabase } from "@/storage/database";
import { OwnerPlanError } from "@/application/owner-plan-support";
import type { CarePlanCommandService } from "@/application/care-plan/care-plan-command-service";
import {
  buildCareOrganisationCommitPlan,
  careOrganisationRevisionRowCodec,
  createCareOrganisationCommandStore,
  type CareOrganisationAuditReason,
  type CareOrganisationChange,
  type CareOrganisationEventReason,
  type CareOrganisationRevision,
} from "./care-organisation-persistence";
import type { CareOrganisationCommandPort, CareOrganisationCommitResult, ExpectedHead } from "./care-organisation-contracts";

/**
 * Packet 9B care-organisation command service (event-contracts 6.3–6.5).
 * Care-plan-owned records (preventive items, appointments, questions) go to
 * the Care Plan service; health-record-owned occurrences and contexts are
 * committed here. Nothing infers completion, attendance or due state.
 */

export type CareOrganisationDependencies = {
  now(): Instant;
  ids: {
    commandId(): CommandId;
    correlationId(): CorrelationId;
    recordId(): RecordId;
    revisionId(): RevisionId;
    auditEventId(): AuditEventId;
    transactionId(): TransactionId;
    domainEventId(): DomainEventId;
    workItemId(): WorkItemId;
  };
  carePlan: CarePlanCommandService;
};

const PATIENT_ENTRY: ProvenanceCore = { sourceKind: "PATIENT_ENTRY", captureMethod: "FORM", initiator: "PATIENT", assistance: "NONE" };

export function createCareOrganisationService(database: JagaOnDatabase, dependencies: CareOrganisationDependencies): CareOrganisationCommandPort {
  const store = createCareOrganisationCommandStore(database);
  const { ids, carePlan } = dependencies;

  async function readHead(recordId: RecordId): Promise<RecordHead | null> {
    return ((await database.table("recordHeads").get(recordId)) as RecordHead | undefined) ?? null;
  }

  async function readRevision(revisionId: RevisionId): Promise<CareOrganisationRevision | null> {
    const raw = await database.table("recordRevisions").get(revisionId);
    return raw === undefined ? null : careOrganisationRevisionRowCodec.validateAfterRead(raw).revision;
  }

  async function commit(input: { commandName: string; hashMaterial: unknown; commandId?: CommandId; transactionId: TransactionId; now: Instant; changes: CareOrganisationChange[] }): Promise<CareOrganisationCommitResult> {
    try {
      const plan = buildCareOrganisationCommitPlan({
        commandId: input.commandId ?? ids.commandId(),
        commandHash: fingerprint({ commandName: input.commandName, content: input.hashMaterial }),
        correlationId: ids.correlationId(),
        transactionId: input.transactionId,
        completedAt: input.now,
        changes: input.changes,
        workItemId: ids.workItemId,
      });
      const receipt = await store.execute(plan);
      if (receipt.outcome === "COMMITTED") {
        const first = receipt.resultingRevisions[0];
        if (first) return { kind: "COMMITTED", recordId: first.recordId, revisionId: first.revisionId };
        // A deletion reports the removed record and the head revision it replaced.
        const target = input.changes[0];
        if (receipt.deletedRecords.length > 0 && target?.kind === "DELETE") return { kind: "COMMITTED", recordId: target.head.recordId, revisionId: target.head.headRevisionId };
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

  function envelope(input: { recordType: CareOrganisationRevision["recordType"]; recordId: RecordId; revisionNumber: number; previousRevisionId: RevisionId | null; action: "CREATE" | "CORRECT" | "SUPERSEDE"; recordedAt: Instant; now: Instant; transactionId: TransactionId }) {
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
      provenance: PATIENT_ENTRY,
      auditEventId: ids.auditEventId(),
      transactionId: input.transactionId,
    };
  }

  const expectedHeadOf = (expected: ExpectedHead, recordType: CareOrganisationRevision["recordType"], now: Instant): RecordHead => ({
    recordId: expected.recordId,
    recordType,
    headRevisionId: expected.expectedRevisionId,
    headRevisionNumber: expected.expectedRevisionNumber,
    state: "ACTIVE",
    updatedAt: now,
  });

  function change(revision: CareOrganisationRevision, expectedHead: RecordHead | null, eventName: string, eventReason: CareOrganisationEventReason, auditReason: CareOrganisationAuditReason): CareOrganisationChange {
    return { kind: "REVISION", revision, expectedHead, eventId: ids.domainEventId(), eventName, eventReason, auditReason };
  }

  /** A planned-item occurrence must reference the item's current revision. */
  async function plannedItemIsCurrent(payload: PreventiveCareRecordRevision["payload"]): Promise<boolean> {
    if (payload.careReference.kind !== "PLANNED_ITEM") return true;
    const head = await readHead(payload.careReference.item.recordId);
    return !!head && head.state === "ACTIVE" && head.recordType === "PREVENTIVE_CARE_ITEM" && head.headRevisionId === payload.careReference.item.revisionId;
  }

  async function readPrevious<T extends CareOrganisationRevision>(expected: ExpectedHead, recordType: T["recordType"]): Promise<T | "NOT_FOUND" | "STORAGE_UNAVAILABLE"> {
    try {
      const previous = await readRevision(expected.expectedRevisionId);
      if (!previous || previous.recordType !== recordType || previous.recordId !== expected.recordId) return "NOT_FOUND";
      return previous as T;
    } catch {
      return "STORAGE_UNAVAILABLE";
    }
  }

  return Object.freeze({
    createPreventiveItem: (input) => carePlan.createPreventiveItem(input),
    revisePreventiveItem: (input) => carePlan.revisePreventiveItem(input),
    scheduleAppointment: (input) => carePlan.scheduleAppointment(input),
    reviseAppointment: (input) => carePlan.reviseAppointment(input),
    createCareQuestion: (input) => carePlan.createCareQuestion(input),
    reviseCareQuestion: (input) => carePlan.reviseCareQuestion(input),

    async recordPreventiveOutcome(input) {
      const now = dependencies.now();
      try {
        if (!(await plannedItemIsCurrent(input.payload))) return { kind: "FAILED", code: "VALIDATION_FAILED" };
      } catch {
        return { kind: "FAILED", code: "STORAGE_UNAVAILABLE" };
      }
      const transactionId = ids.transactionId();
      const revision = {
        ...envelope({ recordType: "PREVENTIVE_CARE_RECORD", recordId: ids.recordId(), revisionNumber: 1, previousRevisionId: null, action: "CREATE", recordedAt: now, now, transactionId }),
        // The occurrence is what the patient reported; entry time never replaces it.
        temporal: { kind: "POINT", occurrence: input.occurrence },
        payload: input.payload,
      } as PreventiveCareRecordRevision;
      return commit({
        commandName: "RECORD_PREVENTIVE_CARE_OUTCOME",
        hashMaterial: { payload: input.payload, occurrence: input.occurrence },
        commandId: input.commandId,
        transactionId,
        now,
        changes: [change(revision, null, "PREVENTIVE_CARE_OUTCOME_RECORDED", "RECORDED", "PATIENT_RECORDED")],
      });
    },

    async correctPreventiveOutcome(input) {
      const now = dependencies.now();
      const previous = await readPrevious<PreventiveCareRecordRevision>(input, "PREVENTIVE_CARE_RECORD");
      if (previous === "NOT_FOUND" || previous === "STORAGE_UNAVAILABLE") return { kind: "FAILED", code: previous };
      const transactionId = ids.transactionId();
      const revision = {
        ...envelope({ recordType: "PREVENTIVE_CARE_RECORD", recordId: input.recordId, revisionNumber: input.expectedRevisionNumber + 1, previousRevisionId: input.expectedRevisionId, action: "CORRECT", recordedAt: previous.recordedAt, now, transactionId }),
        temporal: { kind: "POINT", occurrence: input.occurrence },
        payload: input.payload,
      } as PreventiveCareRecordRevision;
      return commit({
        commandName: "CORRECT_HEALTH_RECORD",
        hashMaterial: { target: input.recordId, expected: input.expectedRevisionId, payload: input.payload, occurrence: input.occurrence },
        commandId: input.commandId,
        transactionId,
        now,
        changes: [change(revision, expectedHeadOf(input, "PREVENTIVE_CARE_RECORD", now), "PREVENTIVE_CARE_OUTCOME_CORRECTED", "RECORDED_ERROR_CORRECTED", "PATIENT_CORRECTED")],
      });
    },

    async undoPreventiveOutcome(input) {
      const now = dependencies.now();
      const transactionId = ids.transactionId();
      return commit({
        commandName: "DELETE_PATIENT_RECORD",
        hashMaterial: { target: input.recordId, expected: input.expectedRevisionId },
        commandId: input.commandId,
        transactionId,
        now,
        changes: [{ kind: "DELETE", head: expectedHeadOf(input, "PREVENTIVE_CARE_RECORD", now), deletedAt: now, auditEventId: ids.auditEventId(), eventId: ids.domainEventId() }],
      });
    },

    async recordContextWindow(input) {
      const now = dependencies.now();
      const transactionId = ids.transactionId();
      const revision = {
        ...envelope({ recordType: "CONTEXT_WINDOW", recordId: ids.recordId(), revisionNumber: 1, previousRevisionId: null, action: "CREATE", recordedAt: now, now, transactionId }),
        temporal: { kind: "INTERVAL", start: input.start, end: input.end },
        payload: input.payload,
      } as ContextWindowRevision;
      return commit({
        commandName: "RECORD_CONTEXT_WINDOW",
        hashMaterial: { payload: input.payload, start: input.start, end: input.end },
        commandId: input.commandId,
        transactionId,
        now,
        changes: [change(revision, null, "CONTEXT_WINDOW_RECORDED", "RECORDED", "PATIENT_RECORDED")],
      });
    },

    async reviseContextWindow(input) {
      const now = dependencies.now();
      const previous = await readPrevious<ContextWindowRevision>(input, "CONTEXT_WINDOW");
      if (previous === "NOT_FOUND" || previous === "STORAGE_UNAVAILABLE") return { kind: "FAILED", code: previous };
      const transactionId = ids.transactionId();
      const revision = {
        ...envelope({ recordType: "CONTEXT_WINDOW", recordId: input.recordId, revisionNumber: input.expectedRevisionNumber + 1, previousRevisionId: input.expectedRevisionId, action: input.intent, recordedAt: previous.recordedAt, now, transactionId }),
        temporal: { kind: "INTERVAL", start: input.start, end: input.end },
        payload: input.payload,
      } as ContextWindowRevision;
      return commit({
        commandName: "REVISE_CONTEXT_WINDOW",
        hashMaterial: { target: input.recordId, expected: input.expectedRevisionId, payload: input.payload, start: input.start, end: input.end, intent: input.intent },
        commandId: input.commandId,
        transactionId,
        now,
        changes: [
          change(
            revision,
            expectedHeadOf(input, "CONTEXT_WINDOW", now),
            "CONTEXT_WINDOW_REVISED",
            input.intent === "CORRECT" ? "RECORDED_ERROR_CORRECTED" : "STATE_CHANGED",
            input.intent === "CORRECT" ? "PATIENT_CORRECTED" : "PATIENT_CONFIRMED_CHANGE",
          ),
        ],
      });
    },
  } satisfies CareOrganisationCommandPort);
}
