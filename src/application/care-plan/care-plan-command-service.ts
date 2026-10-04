import { z } from "zod";
import type { CommandId, CorrelationId, DomainEventId } from "@/application/contracts/command-event-identifiers";
import type { WorkItemId } from "@/application/contracts/event-work";
import { fingerprint } from "@/application/intelligence/metrics";
import type { AuditEventId, Instant, RecordHead, RecordId, RevisionId, TransactionId } from "@/domain/shared";
import type { ProvenanceCore } from "@/domain/shared/provenance";
import type { MedicationPayload } from "@/domain/care-plan/medication";
import type { PrescriptionVersionPayload } from "@/domain/care-plan/prescription-version";
import type { MedicationRevision, PrescriptionVersionRevision } from "@/domain/care-plan/care-plan-revisions";
import type { ReminderPayload, ReminderRevision } from "@/domain/care-plan/reminder";
import type { CareQuestionPayload, CareQuestionRevision } from "@/domain/care-plan/care-question";
import type { PreventiveCareItemPayload, PreventiveCareItemRevision } from "@/domain/care-plan/preventive-care";
import type { AppointmentPayload, AppointmentRevision } from "@/domain/care-plan/appointment";
import type { TimePoint } from "@/domain/shared/temporal";
import type { RecordType } from "@/domain/shared/record-catalogue";
import type { TypedRevisionRef } from "@/domain/shared/typed-revision-ref";
import { CommandTransactionError } from "@/storage/authoritative-command-transaction";
import { StorageRowValidationError } from "@/storage/storage-row-codec";
import type { JagaOnDatabase } from "@/storage/database";
import type { StoredReverseDependency } from "@/storage/reverse-dependency-row";
import {
  CarePlanPlanError,
  buildCarePlanCommitPlan,
  carePlanRevisionRowCodec,
  createCarePlanCommandStore,
  type CarePlanAuditReason,
  type CarePlanChange,
  type CarePlanEventReason,
  type CarePlanRevision,
} from "./care-plan-persistence";

/**
 * Packet 8 Care Plan command service (event-contracts Section 6.3).
 *
 * Creating, activating or materially changing a reminder requires an
 * explicit patient confirmation flag. A reminder or care question never
 * creates a medication, measurement, appointment or adherence fact, and the
 * system may only move a dependent reminder to `REVIEW_REQUIRED`.
 */

export type CarePlanCommitResult =
  | { kind: "COMMITTED"; recordId: RecordId; revisionId: RevisionId }
  | { kind: "REJECTED"; code: "HEAD_CONFLICT" }
  | { kind: "FAILED"; code: "VALIDATION_FAILED" | "CONFIRMATION_REQUIRED" | "NOT_FOUND" | "STORAGE_UNAVAILABLE" | "COMMIT_FAILED" };

export type CarePlanDependencies = {
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
};

export type ExpectedHead = { recordId: RecordId; expectedRevisionId: RevisionId; expectedRevisionNumber: number };

const PATIENT_ENTRY: ProvenanceCore = { sourceKind: "PATIENT_ENTRY", captureMethod: "FORM", initiator: "PATIENT", assistance: "NONE" };
const SYSTEM_RULE: ProvenanceCore = { sourceKind: "SYSTEM_DERIVATION", captureMethod: "RULE_ENGINE", initiator: "JAGAON_SYSTEM", assistance: "NONE" };

export const REMINDER_DEPENDENCY_EVALUATOR = Object.freeze({ key: "care-plan.reminder-target", version: "8.1", role: "REMINDER_TARGET" });

export type CarePlanCommandService = ReturnType<typeof createCarePlanCommandService>;

export function createCarePlanCommandService(database: JagaOnDatabase, dependencies: CarePlanDependencies) {
  const store = createCarePlanCommandStore(database);
  const { ids } = dependencies;

  async function readRevision(revisionId: RevisionId): Promise<CarePlanRevision | null> {
    const raw = await database.table("recordRevisions").get(revisionId);
    if (raw === undefined) return null;
    return carePlanRevisionRowCodec.validateAfterRead(raw).revision;
  }

  async function readHead(recordId: RecordId): Promise<RecordHead | null> {
    const raw = await database.table("recordHeads").get(recordId);
    return (raw as RecordHead | undefined) ?? null;
  }

  function headFrom(expected: ExpectedHead, recordType: CarePlanRevision["recordType"]): RecordHead {
    return {
      recordId: expected.recordId,
      recordType,
      headRevisionId: expected.expectedRevisionId,
      headRevisionNumber: expected.expectedRevisionNumber,
      state: "ACTIVE",
      updatedAt: dependencies.now(),
    };
  }

  /** Exact source revisions a reminder references: its subject target and any appointment anchor. */
  function reminderSources(payload: ReminderPayload): TypedRevisionRef<"PRESCRIPTION_VERSION" | "APPOINTMENT" | "PREVENTIVE_CARE_ITEM" | "CARE_QUESTION">[] {
    const sources: TypedRevisionRef<"PRESCRIPTION_VERSION" | "APPOINTMENT" | "PREVENTIVE_CARE_ITEM" | "CARE_QUESTION">[] = [];
    if ("target" in payload.subject) sources.push(payload.subject.target);
    const schedule = payload.schedule;
    if (schedule.kind === "RELATIVE_TO_APPOINTMENT" && !sources.some((ref) => ref.revisionId === schedule.appointment.revisionId)) {
      sources.push(schedule.appointment);
    }
    return sources;
  }

  function reminderEdges(revision: ReminderRevision, createdAt: Instant): StoredReverseDependency[] {
    return reminderSources(revision.payload).map((source) => ({
      sourceRevisionId: source.revisionId,
      dependentRecordType: "REMINDER",
      dependentRecordId: revision.recordId,
      dependentRevisionId: revision.revisionId,
      dependencyRole: REMINDER_DEPENDENCY_EVALUATOR.role,
      owner: "CARE_PLAN",
      evaluatorKey: REMINDER_DEPENDENCY_EVALUATOR.key,
      evaluatorVersion: REMINDER_DEPENDENCY_EVALUATOR.version,
      createdAt,
    }));
  }

  /** Every referenced source must be the current active head of its record. */
  async function sourcesAreCurrent(refs: readonly TypedRevisionRef<RecordType>[]): Promise<boolean> {
    for (const ref of refs) {
      const head = await readHead(ref.recordId);
      if (!head || head.state !== "ACTIVE" || head.recordType !== ref.recordType || head.headRevisionId !== ref.revisionId) return false;
    }
    return true;
  }

  async function commit(input: {
    commandName: string;
    hashMaterial: unknown;
    commandId?: CommandId;
    transactionId: TransactionId;
    changes: CarePlanChange[];
    edges?: StoredReverseDependency[];
    now: Instant;
  }): Promise<CarePlanCommitResult> {
    try {
      const plan = buildCarePlanCommitPlan({
        commandId: input.commandId ?? ids.commandId(),
        // Generated record and revision identities are excluded so an exact
        // retry with the same command ID replays the stored receipt.
        commandHash: fingerprint({ commandName: input.commandName, content: input.hashMaterial }),
        correlationId: ids.correlationId(),
        transactionId: input.transactionId,
        completedAt: input.now,
        changes: input.changes,
        reverseDependencies: input.edges ?? [],
        workItemId: ids.workItemId,
      });
      const receipt = await store.execute(plan);
      if (receipt.outcome === "COMMITTED") {
        const first = receipt.resultingRevisions[0];
        if (!first) return { kind: "FAILED", code: "COMMIT_FAILED" };
        return { kind: "COMMITTED", recordId: first.recordId, revisionId: first.revisionId };
      }
      if (receipt.outcome === "REJECTED") return { kind: "REJECTED", code: "HEAD_CONFLICT" };
      return { kind: "FAILED", code: "COMMIT_FAILED" };
    } catch (error) {
      if (error instanceof CarePlanPlanError || error instanceof z.ZodError || error instanceof StorageRowValidationError) {
        return { kind: "FAILED", code: "VALIDATION_FAILED" };
      }
      if (error instanceof CommandTransactionError && error.code === "COMMAND_REPLAY_MISMATCH") return { kind: "FAILED", code: "COMMIT_FAILED" };
      return { kind: "FAILED", code: "STORAGE_UNAVAILABLE" };
    }
  }

  function envelope<TType extends CarePlanRevision["recordType"]>(input: {
    recordType: TType;
    recordId: RecordId;
    revisionNumber: number;
    previousRevisionId: RevisionId | null;
    action: CarePlanRevision["action"];
    recordedAt: Instant;
    now: Instant;
    provenance: ProvenanceCore;
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
      provenance: input.provenance,
      auditEventId: ids.auditEventId(),
      transactionId: input.transactionId,
    };
  }

  function change(revision: CarePlanRevision, expectedHead: RecordHead | null, eventName: string, eventReason: CarePlanEventReason, auditReason: CarePlanAuditReason): CarePlanChange {
    return { kind: "REVISION", revision, expectedHead, eventId: ids.domainEventId(), eventName, eventReason, auditReason };
  }

  async function revise<TRevision extends ReminderRevision | CareQuestionRevision | PrescriptionVersionRevision | PreventiveCareItemRevision | AppointmentRevision>(input: {
    expected: ExpectedHead;
    recordType: TRevision["recordType"];
    build: (previous: TRevision, base: ReturnType<typeof envelope>) => TRevision;
    commandName: string;
    hashMaterial: unknown;
    eventName: string;
    eventReason: CarePlanEventReason;
    auditReason: CarePlanAuditReason;
    commandId?: CommandId;
    action: CarePlanRevision["action"];
    provenance: ProvenanceCore;
  }): Promise<CarePlanCommitResult> {
    const now = dependencies.now();
    let previous: CarePlanRevision | null;
    try {
      previous = await readRevision(input.expected.expectedRevisionId);
    } catch {
      return { kind: "FAILED", code: "STORAGE_UNAVAILABLE" };
    }
    if (!previous || previous.recordType !== input.recordType || previous.recordId !== input.expected.recordId) return { kind: "FAILED", code: "NOT_FOUND" };
    const transactionId = ids.transactionId();
    const base = envelope({
      recordType: input.recordType,
      recordId: input.expected.recordId,
      revisionNumber: input.expected.expectedRevisionNumber + 1,
      previousRevisionId: input.expected.expectedRevisionId,
      action: input.action,
      recordedAt: previous.recordedAt,
      now,
      provenance: input.provenance,
      transactionId,
    });
    const revision = input.build(previous as TRevision, base);
    return commit({
      commandName: input.commandName,
      hashMaterial: input.hashMaterial,
      commandId: input.commandId,
      transactionId,
      now,
      changes: [change(revision, headFrom(input.expected, input.recordType), input.eventName, input.eventReason, input.auditReason)],
      edges: revision.recordType === "REMINDER" ? reminderEdges(revision as ReminderRevision, now) : [],
    });
  }

  return Object.freeze({
    /** Synthetic demo seed: medication identity with an exact synthetic identity. */
    async registerMedication(input: { recordId: RecordId; revisionId: RevisionId; payload: MedicationPayload; recordedAt: Instant }) {
      const now = dependencies.now();
      const transactionId = ids.transactionId();
      const revision = {
        ...envelope({ recordType: "MEDICATION", recordId: input.recordId, revisionNumber: 1, previousRevisionId: null, action: "CREATE", recordedAt: input.recordedAt, now, provenance: PATIENT_ENTRY, transactionId }),
        revisionId: input.revisionId,
        temporal: { kind: "ATEMPORAL" },
        payload: input.payload,
      } as MedicationRevision;
      return commit({
        commandName: "REGISTER_MEDICATION",
        hashMaterial: { recordId: input.recordId, payload: input.payload },
        transactionId,
        now,
        changes: [change(revision, null, "MEDICATION_REGISTERED", "RECORDED", "SYNTHETIC_DEMO_SEEDED")],
      });
    },

    /** Synthetic demo seed: one recorded prescription version. */
    async recordPrescriptionVersion(input: { recordId?: RecordId; payload: PrescriptionVersionPayload; recordedAt: Instant }) {
      const now = dependencies.now();
      const transactionId = ids.transactionId();
      const recordId = input.recordId ?? ids.recordId();
      const revision = {
        ...envelope({ recordType: "PRESCRIPTION_VERSION", recordId, revisionNumber: 1, previousRevisionId: null, action: "CREATE", recordedAt: input.recordedAt, now, provenance: PATIENT_ENTRY, transactionId }),
        temporal: { kind: "INTERVAL", start: input.payload.effectivePeriod.start, end: input.payload.effectivePeriod.end },
        payload: input.payload,
      } as PrescriptionVersionRevision;
      return commit({
        commandName: "RECORD_PRESCRIPTION_VERSION",
        hashMaterial: { recordId, payload: input.payload },
        transactionId,
        now,
        changes: [change(revision, null, "PRESCRIPTION_VERSION_RECORDED", "RECORDED", "SYNTHETIC_DEMO_SEEDED")],
      });
    },

    /** A recorded-error correction of a prescription version. Dependent reminders then require review. */
    async correctPrescriptionVersion(input: ExpectedHead & { payload: PrescriptionVersionPayload; seeded?: boolean }) {
      return revise<PrescriptionVersionRevision>({
        expected: input,
        recordType: "PRESCRIPTION_VERSION",
        commandName: "REVISE_PRESCRIPTION_VERSION",
        hashMaterial: { target: input, payload: input.payload },
        eventName: "PRESCRIPTION_VERSION_REVISED",
        eventReason: "RECORDED_ERROR_CORRECTED",
        auditReason: input.seeded ? "SYNTHETIC_DEMO_SEEDED" : "PATIENT_CORRECTED",
        action: "CORRECT",
        provenance: PATIENT_ENTRY,
        build: (_previous, base) =>
          ({
            ...base,
            temporal: { kind: "INTERVAL", start: input.payload.effectivePeriod.start, end: input.payload.effectivePeriod.end },
            payload: input.payload,
          }) as PrescriptionVersionRevision,
      });
    },

    async createReminder(input: { payload: ReminderPayload; patientConfirmed: true; commandId?: CommandId; seeded?: boolean }) {
      if (input.patientConfirmed !== true) return { kind: "FAILED", code: "CONFIRMATION_REQUIRED" } as const;
      const now = dependencies.now();
      const transactionId = ids.transactionId();
      if (!(await sourcesAreCurrent(reminderSources(input.payload)))) return { kind: "FAILED", code: "VALIDATION_FAILED" } as const;
      const revision = {
        ...envelope({ recordType: "REMINDER", recordId: ids.recordId(), revisionNumber: 1, previousRevisionId: null, action: "CREATE", recordedAt: now, now, provenance: PATIENT_ENTRY, transactionId }),
        temporal: { kind: "ATEMPORAL" },
        payload: input.payload,
      } as ReminderRevision;
      return commit({
        commandName: "CREATE_REMINDER",
        hashMaterial: { payload: input.payload },
        commandId: input.commandId,
        transactionId,
        now,
        changes: [change(revision, null, "REMINDER_CREATED", "RECORDED", input.seeded ? "SYNTHETIC_DEMO_SEEDED" : "PATIENT_RECORDED")],
        edges: reminderEdges(revision, now),
      });
    },

    /** A patient-confirmed reminder change: pause, resume, reschedule, end or review. */
    async reviseReminder(
      input: ExpectedHead & {
        payload: ReminderPayload;
        intent: "CORRECT" | "SUPERSEDE";
        reason: Extract<CarePlanEventReason, "RECORDED_ERROR_CORRECTED" | "PAUSED" | "RESUMED" | "SCHEDULE_CHANGED" | "ENDED" | "REVIEW_CONFIRMED">;
        patientConfirmed: true;
        commandId?: CommandId;
        seeded?: boolean;
      },
    ) {
      if (input.patientConfirmed !== true) return { kind: "FAILED", code: "CONFIRMATION_REQUIRED" } as const;
      if (input.payload.state === "REVIEW_REQUIRED") return { kind: "FAILED", code: "VALIDATION_FAILED" } as const;
      // Activation relays only the current revision of every referenced source.
      if (input.payload.state === "ACTIVE" && !(await sourcesAreCurrent(reminderSources(input.payload)))) {
        return { kind: "FAILED", code: "VALIDATION_FAILED" } as const;
      }
      return revise<ReminderRevision>({
        expected: input,
        recordType: "REMINDER",
        commandName: "REVISE_REMINDER",
        hashMaterial: { target: input.recordId, expected: input.expectedRevisionId, payload: input.payload, reason: input.reason },
        commandId: input.commandId,
        eventName: "REMINDER_REVISED",
        eventReason: input.reason,
        auditReason: input.seeded ? "SYNTHETIC_DEMO_SEEDED" : input.intent === "CORRECT" ? "PATIENT_CORRECTED" : "PATIENT_CONFIRMED_CHANGE",
        action: input.intent,
        provenance: PATIENT_ENTRY,
        build: (_previous, base) => ({ ...base, temporal: { kind: "ATEMPORAL" }, payload: input.payload }) as ReminderRevision,
      });
    },

    /** System reconciliation: suspend a reminder whose referenced source changed. */
    async requireReminderReview(input: ExpectedHead & { commandId: CommandId }) {
      return revise<ReminderRevision>({
        expected: input,
        recordType: "REMINDER",
        commandName: "REVISE_REMINDER",
        hashMaterial: { target: input.recordId, expected: input.expectedRevisionId, reason: "SOURCE_CHANGED_REVIEW_REQUIRED" },
        commandId: input.commandId,
        eventName: "REMINDER_REVISED",
        eventReason: "SOURCE_CHANGED_REVIEW_REQUIRED",
        auditReason: "SOURCE_CHANGED_REVIEW_REQUIRED",
        action: "SYSTEM_DERIVE",
        provenance: SYSTEM_RULE,
        build: (previous, base) => ({ ...base, temporal: { kind: "ATEMPORAL" }, payload: { ...previous.payload, state: "REVIEW_REQUIRED" } }) as ReminderRevision,
      });
    },

    async createCareQuestion(input: {
      questionText: CareQuestionPayload["questionText"];
      /** Packet 9B: an organisational link only; it never means the clinic received it. */
      relatedAppointment?: TypedRevisionRef<"APPOINTMENT">;
      commandId?: CommandId;
    }) {
      const now = dependencies.now();
      const transactionId = ids.transactionId();
      if (input.relatedAppointment && !(await sourcesAreCurrent([input.relatedAppointment]))) return { kind: "FAILED", code: "VALIDATION_FAILED" } as const;
      const payload: CareQuestionPayload = {
        questionText: input.questionText,
        origin: { kind: "PATIENT_AUTHORED" },
        intendedRecipient: "UNSPECIFIED",
        // Saving is the patient's own explicit intent to keep the question.
        state: "READY_TO_ASK",
        ...(input.relatedAppointment ? { relatedAppointment: input.relatedAppointment } : {}),
      };
      const revision = {
        ...envelope({ recordType: "CARE_QUESTION", recordId: ids.recordId(), revisionNumber: 1, previousRevisionId: null, action: "CREATE", recordedAt: now, now, provenance: PATIENT_ENTRY, transactionId }),
        temporal: { kind: "ATEMPORAL" },
        payload,
      } as CareQuestionRevision;
      return commit({
        commandName: "CREATE_CARE_QUESTION",
        hashMaterial: { payload },
        commandId: input.commandId,
        transactionId,
        now,
        changes: [change(revision, null, "CARE_QUESTION_CREATED", "RECORDED", "PATIENT_RECORDED")],
      });
    },

    /** Patient edit or dismissal; the earlier revision stays in history. */
    async reviseCareQuestion(
      input: ExpectedHead & {
        questionText: CareQuestionPayload["questionText"];
        state: Extract<CareQuestionPayload["state"], "READY_TO_ASK" | "DISMISSED">;
        commandId?: CommandId;
      },
    ) {
      return revise<CareQuestionRevision>({
        expected: input,
        recordType: "CARE_QUESTION",
        commandName: "REVISE_CARE_QUESTION",
        hashMaterial: { target: input.recordId, expected: input.expectedRevisionId, questionText: input.questionText, state: input.state },
        commandId: input.commandId,
        eventName: "CARE_QUESTION_REVISED",
        eventReason: input.state === "DISMISSED" ? "QUESTION_DISMISSED" : "QUESTION_EDITED",
        auditReason: "PATIENT_CONFIRMED_CHANGE",
        action: "SUPERSEDE",
        provenance: PATIENT_ENTRY,
        build: (previous, base) =>
          ({ ...base, temporal: { kind: "ATEMPORAL" }, payload: { ...previous.payload, questionText: input.questionText, state: input.state } }) as CareQuestionRevision,
      });
    },

    // --- Packet 9B: preventive-care items (domain 7.2–7.4) ------------------------------

    async createPreventiveItem(input: { payload: PreventiveCareItemPayload; commandId?: CommandId; seeded?: boolean }) {
      const now = dependencies.now();
      const transactionId = ids.transactionId();
      const revision = {
        ...envelope({ recordType: "PREVENTIVE_CARE_ITEM", recordId: ids.recordId(), revisionNumber: 1, previousRevisionId: null, action: "CREATE", recordedAt: now, now, provenance: PATIENT_ENTRY, transactionId }),
        temporal: { kind: "ATEMPORAL" },
        payload: input.payload,
      } as PreventiveCareItemRevision;
      return commit({
        commandName: "CREATE_PREVENTIVE_CARE_ITEM",
        hashMaterial: { payload: input.payload },
        commandId: input.commandId,
        transactionId,
        now,
        changes: [change(revision, null, "PREVENTIVE_CARE_ITEM_CREATED", "RECORDED", input.seeded ? "SYNTHETIC_DEMO_SEEDED" : "PATIENT_RECORDED")],
      });
    },

    /** A mistyped item corrects; a genuinely new plan or tracking state supersedes. */
    async revisePreventiveItem(input: ExpectedHead & { payload: PreventiveCareItemPayload; intent: "CORRECT" | "SUPERSEDE"; commandId?: CommandId }) {
      return revise<PreventiveCareItemRevision>({
        expected: input,
        recordType: "PREVENTIVE_CARE_ITEM",
        commandName: "REVISE_PREVENTIVE_CARE_ITEM",
        hashMaterial: { target: input.recordId, expected: input.expectedRevisionId, payload: input.payload, intent: input.intent },
        commandId: input.commandId,
        eventName: "PREVENTIVE_CARE_ITEM_REVISED",
        eventReason: input.intent === "CORRECT" ? "RECORDED_ERROR_CORRECTED" : "PLAN_CHANGED",
        auditReason: input.intent === "CORRECT" ? "PATIENT_CORRECTED" : "PATIENT_CONFIRMED_CHANGE",
        action: input.intent,
        provenance: PATIENT_ENTRY,
        build: (_previous, base) => ({ ...base, temporal: { kind: "ATEMPORAL" }, payload: input.payload }) as PreventiveCareItemRevision,
      });
    },

    // --- Packet 9B: appointments (domain 7.6–7.8) ---------------------------------------

    async scheduleAppointment(input: { payload: AppointmentPayload; scheduledAt: TimePoint; commandId?: CommandId; seeded?: boolean }) {
      const now = dependencies.now();
      const transactionId = ids.transactionId();
      const links = input.payload.relatedPreventiveCareItems ?? [];
      if (!(await sourcesAreCurrent(links))) return { kind: "FAILED", code: "VALIDATION_FAILED" } as const;
      const revision = {
        ...envelope({ recordType: "APPOINTMENT", recordId: ids.recordId(), revisionNumber: 1, previousRevisionId: null, action: "CREATE", recordedAt: now, now, provenance: PATIENT_ENTRY, transactionId }),
        temporal: { kind: "POINT", occurrence: input.scheduledAt },
        payload: input.payload,
      } as AppointmentRevision;
      return commit({
        commandName: "SCHEDULE_APPOINTMENT",
        hashMaterial: { payload: input.payload, scheduledAt: input.scheduledAt },
        commandId: input.commandId,
        transactionId,
        now,
        changes: [change(revision, null, "APPOINTMENT_SCHEDULED", "RECORDED", input.seeded ? "SYNTHETIC_DEMO_SEEDED" : "PATIENT_RECORDED")],
      });
    },

    /**
     * Correction, reschedule, cancellation, reported outcome or organisational
     * change. A passed time never changes status here; only the patient does.
     */
    async reviseAppointment(
      input: ExpectedHead & {
        payload: AppointmentPayload;
        scheduledAt: TimePoint;
        reason: Extract<CarePlanEventReason, "RECORDED_ERROR_CORRECTED" | "RESCHEDULED" | "CANCELLED" | "OUTCOME_REPORTED" | "ORGANISATIONAL_DETAILS_CHANGED">;
        commandId?: CommandId;
      },
    ) {
      let previous: CarePlanRevision | null;
      try {
        previous = await readRevision(input.expectedRevisionId);
      } catch {
        return { kind: "FAILED", code: "STORAGE_UNAVAILABLE" } as const;
      }
      if (!previous || previous.recordType !== "APPOINTMENT" || previous.recordId !== input.recordId) return { kind: "FAILED", code: "NOT_FOUND" } as const;
      const sameTime = JSON.stringify(previous.temporal.occurrence) === JSON.stringify(input.scheduledAt);
      const status = input.payload.status;
      const consistent =
        input.reason === "RESCHEDULED"
          ? !sameTime && status === "SCHEDULED"
          : input.reason === "CANCELLED"
            ? sameTime && status === "CANCELLED"
            : input.reason === "OUTCOME_REPORTED"
              ? sameTime && (status === "PATIENT_REPORTED_ATTENDED" || status === "PATIENT_REPORTED_MISSED" || status === "UNSURE")
              : input.reason === "ORGANISATIONAL_DETAILS_CHANGED"
                ? sameTime && status === previous.payload.status
                : true;
      if (!consistent) return { kind: "FAILED", code: "VALIDATION_FAILED" } as const;
      if (!(await sourcesAreCurrent(input.payload.relatedPreventiveCareItems ?? []))) return { kind: "FAILED", code: "VALIDATION_FAILED" } as const;
      const intent = input.reason === "RECORDED_ERROR_CORRECTED" ? "CORRECT" : "SUPERSEDE";
      return revise<AppointmentRevision>({
        expected: input,
        recordType: "APPOINTMENT",
        commandName: "REVISE_APPOINTMENT",
        hashMaterial: { target: input.recordId, expected: input.expectedRevisionId, payload: input.payload, scheduledAt: input.scheduledAt, reason: input.reason },
        commandId: input.commandId,
        eventName: "APPOINTMENT_REVISED",
        eventReason: input.reason,
        auditReason: intent === "CORRECT" ? "PATIENT_CORRECTED" : "PATIENT_CONFIRMED_CHANGE",
        action: intent,
        provenance: PATIENT_ENTRY,
        build: (_previous, base) => ({ ...base, temporal: { kind: "POINT", occurrence: input.scheduledAt }, payload: input.payload }) as AppointmentRevision,
      });
    },
  });
}
