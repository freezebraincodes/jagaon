import { z } from "zod";
import type {
  JournalCommandService,
  JournalCommandDependencies,
  JournalCommitResult,
  RecordGlucoseInput,
  CorrectGlucoseTimeInput,
  RecordInsulinInput,
  RecordMealInput,
  RecordActivityInput,
} from "./journal-contracts";
import { createWorkItemId } from "@/application/contracts/event-work";
import { intelligenceWorkItemsFor } from "@/application/intelligence/intelligence-subscriptions";
import { activityEventPayloadSchema } from "@/domain/health-records/activity-event";
import { activityTemporalSchema } from "@/domain/health-records/observation-temporal";
import type { JagaOnDatabase } from "@/storage/database";
import {
  createAuthoritativeCommandStore,
  type AuthoritativeCommandPlan,
} from "@/storage/authoritative-command-transaction";
import {
  glucoseReadingRevisionCodec,
  medicationEventRevisionCodec,
  intakeEventRevisionCodec,
  activityEventRevisionCodec,
  rejectingReverseDependencyCodec,
  rejectingEvaluationAuditCodec,
  type GlucoseReadingRevision,
  type MedicationEventRevision,
  type IntakeEventRevision,
  type ActivityEventRevision,
  type Packet6JournalRevision,
} from "./journal-row-codecs";
import {
  glucoseReadingPayloadSchema,
} from "@/domain/health-records/glucose-reading";
import { readingTemporalSchema } from "@/domain/health-records/reading-temporal";
import {
  medicationEventPayloadSchema,
} from "@/domain/health-records/medication-event";
import { medicationEventTemporalSchema } from "@/domain/health-records/medication-event";
import {
  intakeEventPayloadSchema,
} from "@/domain/health-records/intake-event";
import { intakeTemporalSchema } from "@/domain/health-records/observation-temporal";
import { type ProvenanceCore } from "@/domain/shared/provenance";
import type { Instant } from "@/domain/shared/time";
import type {
  RecordId,
  RevisionId,
  AuditEventId,
  TransactionId,
} from "@/domain/shared/identifiers";
import type { CommandId, CorrelationId, DomainEventId, EventSequence } from "@/application/contracts/command-event-identifiers";
import { hashCommandEnvelope } from "@/application/contracts/canonical-json";
import type { RecordHead } from "@/domain/shared/revision";
import { CommandTransactionError } from "@/storage/authoritative-command-transaction";
import { StorageRowValidationError } from "@/storage/storage-row-codec";
import { committedDomainEventRowCodec } from "@/storage/committed-domain-event-row";

// ---------------------------------------------------------------------------
// Patient-entry provenance
// ---------------------------------------------------------------------------

const PATIENT_ENTRY_PROVENANCE: ProvenanceCore = {
  sourceKind: "PATIENT_ENTRY",
  captureMethod: "FORM",
  initiator: "PATIENT",
  assistance: "NONE",
};

// ---------------------------------------------------------------------------
// Persisted row types for the authoritative store
// ---------------------------------------------------------------------------

type PersistedRevisionRow = {
  revisionId: RevisionId;
  recordId: RecordId;
  recordType: Packet6JournalRevision["recordType"];
  revisionNumber: number;
  previousRevisionId: RevisionId | null;
  schemaVersion: number;
  action: "CREATE" | "CORRECT" | "CONFIRM" | "SYSTEM_DERIVE" | "UPDATE" | "SUPERSEDE" | "REJECT" | "EXPIRE";
  recordedAt: Instant;
  revisionCreatedAt: Instant;
  transactionId: TransactionId;
  auditEventId: AuditEventId;
  temporalKind: "POINT" | "INTERVAL";
  occurrenceSortInstant?: Instant;
  effectiveStartSortInstant?: Instant;
  localDateSortKey?: string;
  revision: Packet6JournalRevision;
};

type PersistedAuditRow = {
  auditEventId: AuditEventId;
  transactionId: TransactionId;
  recordId: RecordId;
  recordType: Packet6JournalRevision["recordType"];
  previousRevisionId: RevisionId | null;
  resultingRevisionId: RevisionId;
  action: "CREATE" | "CORRECT";
  initiator: "PATIENT";
  assistance: "NONE";
  occurredAt: Instant;
  reasonCode: string;
};

type PersistedDomainEventRow = {
  eventId: DomainEventId;
  eventName: string;
  localSequence: EventSequence;
  transactionIndex: number;
  transactionId: TransactionId;
  commandId: CommandId;
  correlationId: CorrelationId;
  committedAt: Instant;
  change:
    | {
        kind: "REVISION_CREATED";
        recordType: Packet6JournalRevision["recordType"];
        recordId: RecordId;
        action: "CREATE" | "CORRECT";
        previousRevisionId: RevisionId | null;
        resultingRevisionId: RevisionId;
        resultingRevisionNumber: number;
      }
    | {
        kind: "RECORD_DELETED";
        recordType: Packet6JournalRevision["recordType"];
        recordId: RecordId;
        previousRevisionId: RevisionId;
        resultingRevisionId: null;
      };
  payload: unknown;
};

// ---------------------------------------------------------------------------
// Codec wrapper — wraps the typed revision codecs into a form the
// authoritative store can use for validateForWrite/validateAfterRead.
// ---------------------------------------------------------------------------

const persistedRevisionCodec = {
  validateForWrite(value: unknown): PersistedRevisionRow {
    // The value coming from the command service is already a fully-built
    // StoredRecordRevision. Validate it through the appropriate Packet 6 codec.
    const row = value as PersistedRevisionRow;
    const revision = row.revision;
    if (revision.recordType === "GLUCOSE_READING") {
      return glucoseReadingRevisionCodec.validateForWrite(row) as unknown as PersistedRevisionRow;
    }
    if (revision.recordType === "MEDICATION_EVENT") {
      return medicationEventRevisionCodec.validateForWrite(row) as unknown as PersistedRevisionRow;
    }
    if (revision.recordType === "INTAKE_EVENT") {
      return intakeEventRevisionCodec.validateForWrite(row) as unknown as PersistedRevisionRow;
    }
    if (revision.recordType === "ACTIVITY_EVENT") {
      return activityEventRevisionCodec.validateForWrite(row) as unknown as PersistedRevisionRow;
    }
    throw new StorageRowValidationError(
      "STORAGE_VALIDATION_FAILED",
      "recordRevisions",
      "WRITE",
    );
  },
  validateAfterRead(value: unknown): PersistedRevisionRow {
    const row = value as PersistedRevisionRow;
    if (row.recordType === "GLUCOSE_READING") {
      return glucoseReadingRevisionCodec.validateAfterRead(row) as unknown as PersistedRevisionRow;
    }
    if (row.recordType === "MEDICATION_EVENT") {
      return medicationEventRevisionCodec.validateAfterRead(row) as unknown as PersistedRevisionRow;
    }
    if (row.recordType === "INTAKE_EVENT") {
      return intakeEventRevisionCodec.validateAfterRead(row) as unknown as PersistedRevisionRow;
    }
    if (row.recordType === "ACTIVITY_EVENT") {
      return activityEventRevisionCodec.validateAfterRead(row) as unknown as PersistedRevisionRow;
    }
    throw new StorageRowValidationError(
      "STORAGE_INTEGRITY_FAILED",
      "recordRevisions",
      "READ",
    );
  },
};

const persistedAuditCodec = {
  validateForWrite(value: unknown): PersistedAuditRow {
    const result = z
      .object({
        auditEventId: z.string().uuid(),
        transactionId: z.string().uuid(),
        recordId: z.string().uuid(),
        recordType: z.enum(["GLUCOSE_READING", "MEDICATION_EVENT", "INTAKE_EVENT", "ACTIVITY_EVENT"]),
        previousRevisionId: z.string().uuid().nullable(),
        resultingRevisionId: z.string().uuid(),
        action: z.enum(["CREATE", "CORRECT"]),
        initiator: z.literal("PATIENT"),
        assistance: z.literal("NONE"),
        occurredAt: z.string(),
        reasonCode: z.string(),
      })
      .strict()
      .safeParse(value);
    if (!result.success) {
      throw new StorageRowValidationError(
        "STORAGE_VALIDATION_FAILED",
        "auditEvents",
        "WRITE",
      );
    }
    return result.data as unknown as PersistedAuditRow;
  },
  validateAfterRead(value: unknown): PersistedAuditRow {
    return persistedAuditCodec.validateForWrite(value);
  },
};

const persistedEventCodec = {
  validateForWrite(value: unknown): PersistedDomainEventRow {
    const result = z
      .object({
        eventId: z.string().uuid(),
        eventName: z.string().min(1),
        localSequence: z.number().int().positive().safe(),
        transactionIndex: z.number().int().nonnegative().safe(),
        transactionId: z.string().uuid(),
        commandId: z.string().uuid(),
        correlationId: z.string().uuid(),
        committedAt: z.string(),
        change: z.discriminatedUnion("kind", [
          z
            .object({
              kind: z.literal("REVISION_CREATED"),
              recordType: z.enum(["GLUCOSE_READING", "MEDICATION_EVENT", "INTAKE_EVENT", "ACTIVITY_EVENT"]),
              recordId: z.string().uuid(),
              action: z.enum(["CREATE", "CORRECT"]),
              previousRevisionId: z.string().uuid().nullable(),
              resultingRevisionId: z.string().uuid(),
              resultingRevisionNumber: z.number().int().positive(),
            })
            .strict(),
          z
            .object({
              kind: z.literal("RECORD_DELETED"),
              recordType: z.enum(["GLUCOSE_READING", "MEDICATION_EVENT", "INTAKE_EVENT", "ACTIVITY_EVENT"]),
              recordId: z.string().uuid(),
              previousRevisionId: z.string().uuid(),
              resultingRevisionId: z.null(),
            })
            .strict(),
        ]),
        payload: z.unknown(),
      })
      .strict()
      .safeParse(value);
    if (!result.success) {
      throw new StorageRowValidationError(
        "STORAGE_VALIDATION_FAILED",
        "domainEvents",
        "WRITE",
      );
    }
    return result.data as unknown as PersistedDomainEventRow;
  },
  // The shared event log also holds other owners' events (Packet 7A).
  validateAfterRead(value: unknown): PersistedDomainEventRow {
    return committedDomainEventRowCodec.validateAfterRead(value) as unknown as PersistedDomainEventRow;
  },
};

// ---------------------------------------------------------------------------
// Journal command service factory
// ---------------------------------------------------------------------------

export function createJournalCommandService(
  database: JagaOnDatabase,
  dependencies: JournalCommandDependencies,
): JournalCommandService {
  const store = createAuthoritativeCommandStore<
    PersistedRevisionRow,
    PersistedAuditRow,
    PersistedDomainEventRow,
    never,
    never
  >(database, {
    revisionCodec: persistedRevisionCodec,
    auditCodec: persistedAuditCodec,
    eventCodec: persistedEventCodec,
    reverseDependencyCodec: rejectingReverseDependencyCodec,
    evaluationAuditCodec: rejectingEvaluationAuditCodec,
  });

  async function executePlan(
    plan: AuthoritativeCommandPlan<
      PersistedRevisionRow,
      PersistedAuditRow,
      PersistedDomainEventRow,
      never,
      never
    >,
  ): Promise<JournalCommitResult> {
    try {
      const receipt = await store.execute(plan);
      if (receipt.outcome === "COMMITTED") {
        const rev = plan.kind === "COMMIT" ? plan.recordRevisions[0] : null;
        if (!rev) return { kind: "FAILED", code: "COMMIT_FAILED" };
        return {
          kind: "COMMITTED",
          recordId: rev.recordId,
          revisionId: rev.revisionId,
        };
      }
      if (receipt.outcome === "REJECTED") {
        return { kind: "REJECTED", code: "HEAD_CONFLICT" };
      }
      // NO_CHANGE should not happen for CREATE/CORRECT
      return { kind: "FAILED", code: "COMMIT_FAILED" };
    } catch (error) {
      if (error instanceof CommandTransactionError) {
        if (error.code === "COMMAND_REPLAY_MISMATCH") {
          return { kind: "FAILED", code: "COMMIT_FAILED" };
        }
        return { kind: "FAILED", code: "STORAGE_UNAVAILABLE" };
      }
      if (error instanceof StorageRowValidationError) {
        return { kind: "FAILED", code: "VALIDATION_FAILED" };
      }
      return { kind: "FAILED", code: "STORAGE_UNAVAILABLE" };
    }
  }

  // Packet 7A: the static subscription registry schedules ordinary
  // intelligence work in the same authoritative transaction as the event.
  function workItemsFor(
    event: { eventId: DomainEventId; eventName: string; change: { recordType: string } },
    createdAt: Instant,
  ) {
    return intelligenceWorkItemsFor({
      eventId: event.eventId,
      eventName: event.eventName,
      recordType: event.change.recordType as Packet6JournalRevision["recordType"],
      createdAt,
      workItemId: dependencies.ids.workItemId ?? createWorkItemId,
    });
  }

  return Object.freeze({
    async recordGlucose(input: RecordGlucoseInput): Promise<JournalCommitResult> {
      try {
        const payload = glucoseReadingPayloadSchema.parse(input.payload);
        const temporal = readingTemporalSchema.parse(input.temporal);

        const recordId = dependencies.ids.recordId();
        const revisionId = dependencies.ids.revisionId();
        const auditEventId = dependencies.ids.auditEventId();
        const transactionId = dependencies.ids.transactionId();
        const commandId = dependencies.ids.commandId();
        const correlationId = dependencies.ids.correlationId();
        const domainEventId = dependencies.ids.domainEventId();
        const now = dependencies.now();

        const revision: GlucoseReadingRevision = {
          schemaVersion: 1,
          recordType: "GLUCOSE_READING",
          recordId,
          revisionId,
          revisionNumber: 1,
          previousRevisionId: null,
          action: "CREATE",
          recordedAt: input.recordedAt,
          revisionCreatedAt: now,
          temporal,
          provenance: PATIENT_ENTRY_PROVENANCE,
          auditEventId,
          transactionId,
          payload,
        } as unknown as GlucoseReadingRevision;

        const commandEnvelope = {
          schemaVersion: 1,
          commandId,
          commandName: "RECORD_GLUCOSE_READING" as const,
          issuedAt: now,
          initiator: "PATIENT" as const,
          assistance: "NONE" as const,
          origin: "PATIENT_UI" as const,
          correlationId,
          cause: { kind: "DIRECT_PATIENT_ACTION" as const },
          headExpectations: [
            {
              kind: "MUST_NOT_EXIST" as const,
              recordType: "GLUCOSE_READING" as const,
              proposedRecordId: recordId,
            },
          ],
          payload,
        };

        const commandHash = await hashCommandEnvelope(commandEnvelope);

        const storedRevision = glucoseReadingRevisionCodec.create(revision);

        const head: RecordHead = {
          recordId,
          recordType: "GLUCOSE_READING",
          headRevisionId: revisionId,
          headRevisionNumber: 1,
          state: "ACTIVE",
          updatedAt: now,
        };

        const auditEvent: PersistedAuditRow = {
          auditEventId,
          transactionId,
          recordId,
          recordType: "GLUCOSE_READING",
          previousRevisionId: null,
          resultingRevisionId: revisionId,
          action: "CREATE",
          initiator: "PATIENT",
          assistance: "NONE",
          occurredAt: now,
          reasonCode: "PATIENT_LOGGED",
        };

        const domainEvent: Omit<PersistedDomainEventRow, "localSequence" | "transactionIndex" | "committedAt"> = {
          eventId: domainEventId,
          eventName: "GLUCOSE_READING_RECORDED",
          transactionId,
          commandId,
          correlationId,
          change: {
            kind: "REVISION_CREATED",
            recordType: "GLUCOSE_READING",
            recordId,
            action: "CREATE",
            previousRevisionId: null,
            resultingRevisionId: revisionId,
            resultingRevisionNumber: 1,
          },
          payload,
        };

        const plan: AuthoritativeCommandPlan<
          PersistedRevisionRow,
          PersistedAuditRow,
          PersistedDomainEventRow,
          never,
          never
        > = {
          kind: "COMMIT",
          commandId,
          commandHash,
          completedAt: now,
          transactionId,
          headExpectations: [
            {
              kind: "MUST_NOT_EXIST",
              recordType: "GLUCOSE_READING",
              proposedRecordId: recordId,
            },
          ],
          recordRevisions: [storedRevision as unknown as PersistedRevisionRow],
          recordHeads: [head],
          deletionTombstones: [],
          auditEvents: [auditEvent],
          domainEvents: [domainEvent as any],
          eventWorkItems: workItemsFor(domainEvent, now),
          reverseDependencies: [],
          evaluationAudits: [],
          appPreference: null,
          safety: { kind: "NOT_REQUIRED" },
        };

        return executePlan(plan);
      } catch (error) {
        if (error instanceof StorageRowValidationError) {
          return { kind: "FAILED", code: "VALIDATION_FAILED" };
        }
        if (error instanceof z.ZodError) {
          return { kind: "FAILED", code: "VALIDATION_FAILED" };
        }
        return { kind: "FAILED", code: "STORAGE_UNAVAILABLE" };
      }
    },

    async correctGlucoseTime(
      input: CorrectGlucoseTimeInput,
    ): Promise<JournalCommitResult> {
      try {
        const payload = glucoseReadingPayloadSchema.parse(input.payload);
        const temporal = readingTemporalSchema.parse(input.temporal);

        const revisionId = dependencies.ids.revisionId();
        const auditEventId = dependencies.ids.auditEventId();
        const transactionId = dependencies.ids.transactionId();
        const commandId = dependencies.ids.commandId();
        const correlationId = dependencies.ids.correlationId();
        const domainEventId = dependencies.ids.domainEventId();
        const now = dependencies.now();

        const revision: GlucoseReadingRevision = {
          schemaVersion: 1,
          recordType: "GLUCOSE_READING",
          recordId: input.recordId,
          revisionId,
          revisionNumber: input.expectedRevisionNumber + 1,
          previousRevisionId: input.expectedRevisionId,
          action: "CORRECT",
          recordedAt: input.recordedAt,
          revisionCreatedAt: now,
          temporal,
          provenance: PATIENT_ENTRY_PROVENANCE,
          auditEventId,
          transactionId,
          payload,
        } as unknown as GlucoseReadingRevision;

        const commandEnvelope = {
          schemaVersion: 1,
          commandId,
          commandName: "CORRECT_HEALTH_RECORD" as const,
          issuedAt: now,
          initiator: "PATIENT" as const,
          assistance: "NONE" as const,
          origin: "PATIENT_UI" as const,
          correlationId,
          cause: { kind: "DIRECT_PATIENT_ACTION" as const },
          headExpectations: [
            {
              kind: "MUST_MATCH" as const,
              recordType: "GLUCOSE_READING" as const,
              recordId: input.recordId,
              expectedRevisionId: input.expectedRevisionId,
              expectedRevisionNumber: input.expectedRevisionNumber,
            },
          ],
          payload,
        };

        const commandHash = await hashCommandEnvelope(commandEnvelope);

        const storedRevision = glucoseReadingRevisionCodec.create(revision);

        const head: RecordHead = {
          recordId: input.recordId,
          recordType: "GLUCOSE_READING",
          headRevisionId: revisionId,
          headRevisionNumber: input.expectedRevisionNumber + 1,
          state: "ACTIVE",
          updatedAt: now,
        };

        const auditEvent: PersistedAuditRow = {
          auditEventId,
          transactionId,
          recordId: input.recordId,
          recordType: "GLUCOSE_READING",
          previousRevisionId: input.expectedRevisionId,
          resultingRevisionId: revisionId,
          action: "CORRECT",
          initiator: "PATIENT",
          assistance: "NONE",
          occurredAt: now,
          reasonCode: "PATIENT_CORRECTED",
        };

        const domainEvent: Omit<PersistedDomainEventRow, "localSequence" | "transactionIndex" | "committedAt"> = {
          eventId: domainEventId,
          eventName: "GLUCOSE_READING_CORRECTED",
          transactionId,
          commandId,
          correlationId,
          change: {
            kind: "REVISION_CREATED",
            recordType: "GLUCOSE_READING",
            recordId: input.recordId,
            action: "CORRECT",
            previousRevisionId: input.expectedRevisionId,
            resultingRevisionId: revisionId,
            resultingRevisionNumber: input.expectedRevisionNumber + 1,
          },
          payload,
        };

        const plan: AuthoritativeCommandPlan<
          PersistedRevisionRow,
          PersistedAuditRow,
          PersistedDomainEventRow,
          never,
          never
        > = {
          kind: "COMMIT",
          commandId,
          commandHash,
          completedAt: now,
          transactionId,
          headExpectations: [
            {
              kind: "MUST_MATCH",
              recordType: "GLUCOSE_READING",
              recordId: input.recordId,
              expectedRevisionId: input.expectedRevisionId,
              expectedRevisionNumber: input.expectedRevisionNumber,
            },
          ],
          recordRevisions: [storedRevision as unknown as PersistedRevisionRow],
          recordHeads: [head],
          deletionTombstones: [],
          auditEvents: [auditEvent],
          domainEvents: [domainEvent as any],
          eventWorkItems: workItemsFor(domainEvent, now),
          reverseDependencies: [],
          evaluationAudits: [],
          appPreference: null,
          safety: { kind: "NOT_REQUIRED" },
        };

        return executePlan(plan);
      } catch (error) {
        if (error instanceof StorageRowValidationError) {
          return { kind: "FAILED", code: "VALIDATION_FAILED" };
        }
        if (error instanceof z.ZodError) {
          return { kind: "FAILED", code: "VALIDATION_FAILED" };
        }
        return { kind: "FAILED", code: "STORAGE_UNAVAILABLE" };
      }
    },

    async recordInsulin(input: RecordInsulinInput): Promise<JournalCommitResult> {
      try {
        const payload = medicationEventPayloadSchema.parse(input.payload);
        const temporal = medicationEventTemporalSchema.parse(input.temporal);

        const recordId = dependencies.ids.recordId();
        const revisionId = dependencies.ids.revisionId();
        const auditEventId = dependencies.ids.auditEventId();
        const transactionId = dependencies.ids.transactionId();
        const commandId = dependencies.ids.commandId();
        const correlationId = dependencies.ids.correlationId();
        const domainEventId = dependencies.ids.domainEventId();
        const now = dependencies.now();

        const revision: MedicationEventRevision = {
          schemaVersion: 1,
          recordType: "MEDICATION_EVENT",
          recordId,
          revisionId,
          revisionNumber: 1,
          previousRevisionId: null,
          action: "CREATE",
          recordedAt: input.recordedAt,
          revisionCreatedAt: now,
          temporal,
          provenance: PATIENT_ENTRY_PROVENANCE,
          auditEventId,
          transactionId,
          payload,
        } as unknown as MedicationEventRevision;

        const commandEnvelope = {
          schemaVersion: 1,
          commandId,
          commandName: "RECORD_MEDICATION_EVENT" as const,
          issuedAt: now,
          initiator: "PATIENT" as const,
          assistance: "NONE" as const,
          origin: "PATIENT_UI" as const,
          correlationId,
          cause: { kind: "DIRECT_PATIENT_ACTION" as const },
          headExpectations: [
            {
              kind: "MUST_NOT_EXIST" as const,
              recordType: "MEDICATION_EVENT" as const,
              proposedRecordId: recordId,
            },
          ],
          payload,
        };

        const commandHash = await hashCommandEnvelope(commandEnvelope);
        const storedRevision = medicationEventRevisionCodec.create(revision);

        const head: RecordHead = {
          recordId,
          recordType: "MEDICATION_EVENT",
          headRevisionId: revisionId,
          headRevisionNumber: 1,
          state: "ACTIVE",
          updatedAt: now,
        };

        const auditEvent: PersistedAuditRow = {
          auditEventId,
          transactionId,
          recordId,
          recordType: "MEDICATION_EVENT",
          previousRevisionId: null,
          resultingRevisionId: revisionId,
          action: "CREATE",
          initiator: "PATIENT",
          assistance: "NONE",
          occurredAt: now,
          reasonCode: "PATIENT_LOGGED",
        };

        const domainEvent: Omit<PersistedDomainEventRow, "localSequence" | "transactionIndex" | "committedAt"> = {
          eventId: domainEventId,
          eventName: "MEDICATION_EVENT_RECORDED",
          transactionId,
          commandId,
          correlationId,
          change: {
            kind: "REVISION_CREATED",
            recordType: "MEDICATION_EVENT",
            recordId,
            action: "CREATE",
            previousRevisionId: null,
            resultingRevisionId: revisionId,
            resultingRevisionNumber: 1,
          },
          payload,
        };

        const plan: AuthoritativeCommandPlan<
          PersistedRevisionRow,
          PersistedAuditRow,
          PersistedDomainEventRow,
          never,
          never
        > = {
          kind: "COMMIT",
          commandId,
          commandHash,
          completedAt: now,
          transactionId,
          headExpectations: [
            {
              kind: "MUST_NOT_EXIST",
              recordType: "MEDICATION_EVENT",
              proposedRecordId: recordId,
            },
          ],
          recordRevisions: [storedRevision as unknown as PersistedRevisionRow],
          recordHeads: [head],
          deletionTombstones: [],
          auditEvents: [auditEvent],
          domainEvents: [domainEvent as any],
          eventWorkItems: workItemsFor(domainEvent, now),
          reverseDependencies: [],
          evaluationAudits: [],
          appPreference: null,
          safety: { kind: "NOT_REQUIRED" },
        };

        return executePlan(plan);
      } catch (error) {
        if (error instanceof StorageRowValidationError) {
          return { kind: "FAILED", code: "VALIDATION_FAILED" };
        }
        if (error instanceof z.ZodError) {
          return { kind: "FAILED", code: "VALIDATION_FAILED" };
        }
        return { kind: "FAILED", code: "STORAGE_UNAVAILABLE" };
      }
    },

    async recordMeal(input: RecordMealInput): Promise<JournalCommitResult> {
      try {
        const payload = intakeEventPayloadSchema.parse(input.payload);
        const temporal = intakeTemporalSchema.parse(input.temporal);

        const recordId = dependencies.ids.recordId();
        const revisionId = dependencies.ids.revisionId();
        const auditEventId = dependencies.ids.auditEventId();
        const transactionId = dependencies.ids.transactionId();
        const commandId = dependencies.ids.commandId();
        const correlationId = dependencies.ids.correlationId();
        const domainEventId = dependencies.ids.domainEventId();
        const now = dependencies.now();

        const revision: IntakeEventRevision = {
          schemaVersion: 1,
          recordType: "INTAKE_EVENT",
          recordId,
          revisionId,
          revisionNumber: 1,
          previousRevisionId: null,
          action: "CREATE",
          recordedAt: input.recordedAt,
          revisionCreatedAt: now,
          temporal,
          provenance: PATIENT_ENTRY_PROVENANCE,
          auditEventId,
          transactionId,
          payload,
        } as unknown as IntakeEventRevision;

        const commandEnvelope = {
          schemaVersion: 1,
          commandId,
          commandName: "RECORD_INTAKE_EVENT" as const,
          issuedAt: now,
          initiator: "PATIENT" as const,
          assistance: "NONE" as const,
          origin: "PATIENT_UI" as const,
          correlationId,
          cause: { kind: "DIRECT_PATIENT_ACTION" as const },
          headExpectations: [
            {
              kind: "MUST_NOT_EXIST" as const,
              recordType: "INTAKE_EVENT" as const,
              proposedRecordId: recordId,
            },
          ],
          payload,
        };

        const commandHash = await hashCommandEnvelope(commandEnvelope);
        const storedRevision = intakeEventRevisionCodec.create(revision);

        const head: RecordHead = {
          recordId,
          recordType: "INTAKE_EVENT",
          headRevisionId: revisionId,
          headRevisionNumber: 1,
          state: "ACTIVE",
          updatedAt: now,
        };

        const auditEvent: PersistedAuditRow = {
          auditEventId,
          transactionId,
          recordId,
          recordType: "INTAKE_EVENT",
          previousRevisionId: null,
          resultingRevisionId: revisionId,
          action: "CREATE",
          initiator: "PATIENT",
          assistance: "NONE",
          occurredAt: now,
          reasonCode: "PATIENT_LOGGED",
        };

        const domainEvent: Omit<PersistedDomainEventRow, "localSequence" | "transactionIndex" | "committedAt"> = {
          eventId: domainEventId,
          eventName: "INTAKE_EVENT_RECORDED",
          transactionId,
          commandId,
          correlationId,
          change: {
            kind: "REVISION_CREATED",
            recordType: "INTAKE_EVENT",
            recordId,
            action: "CREATE",
            previousRevisionId: null,
            resultingRevisionId: revisionId,
            resultingRevisionNumber: 1,
          },
          payload,
        };

        const plan: AuthoritativeCommandPlan<
          PersistedRevisionRow,
          PersistedAuditRow,
          PersistedDomainEventRow,
          never,
          never
        > = {
          kind: "COMMIT",
          commandId,
          commandHash,
          completedAt: now,
          transactionId,
          headExpectations: [
            {
              kind: "MUST_NOT_EXIST",
              recordType: "INTAKE_EVENT",
              proposedRecordId: recordId,
            },
          ],
          recordRevisions: [storedRevision as unknown as PersistedRevisionRow],
          recordHeads: [head],
          deletionTombstones: [],
          auditEvents: [auditEvent],
          domainEvents: [domainEvent as any],
          eventWorkItems: workItemsFor(domainEvent, now),
          reverseDependencies: [],
          evaluationAudits: [],
          appPreference: null,
          safety: { kind: "NOT_REQUIRED" },
        };

        return executePlan(plan);
      } catch (error) {
        if (error instanceof StorageRowValidationError) {
          return { kind: "FAILED", code: "VALIDATION_FAILED" };
        }
        if (error instanceof z.ZodError) {
          return { kind: "FAILED", code: "VALIDATION_FAILED" };
        }
        return { kind: "FAILED", code: "STORAGE_UNAVAILABLE" };
      }
    },

    async recordActivity(input: RecordActivityInput): Promise<JournalCommitResult> {
      try {
        const payload = activityEventPayloadSchema.parse(input.payload);
        const temporal = activityTemporalSchema.parse(input.temporal);

        const recordId = dependencies.ids.recordId();
        const revisionId = dependencies.ids.revisionId();
        const auditEventId = dependencies.ids.auditEventId();
        const transactionId = dependencies.ids.transactionId();
        const commandId = dependencies.ids.commandId();
        const correlationId = dependencies.ids.correlationId();
        const domainEventId = dependencies.ids.domainEventId();
        const now = dependencies.now();

        const revision: ActivityEventRevision = {
          schemaVersion: 1,
          recordType: "ACTIVITY_EVENT",
          recordId,
          revisionId,
          revisionNumber: 1,
          previousRevisionId: null,
          action: "CREATE",
          recordedAt: input.recordedAt,
          revisionCreatedAt: now,
          temporal,
          provenance: PATIENT_ENTRY_PROVENANCE,
          auditEventId,
          transactionId,
          payload,
        } as unknown as ActivityEventRevision;

        const commandEnvelope = {
          schemaVersion: 1,
          commandId,
          commandName: "RECORD_ACTIVITY_EVENT" as const,
          issuedAt: now,
          initiator: "PATIENT" as const,
          assistance: "NONE" as const,
          origin: "PATIENT_UI" as const,
          correlationId,
          cause: { kind: "DIRECT_PATIENT_ACTION" as const },
          headExpectations: [
            {
              kind: "MUST_NOT_EXIST" as const,
              recordType: "ACTIVITY_EVENT" as const,
              proposedRecordId: recordId,
            },
          ],
          payload,
        };

        const commandHash = await hashCommandEnvelope(commandEnvelope);
        const storedRevision = activityEventRevisionCodec.create(revision);

        const head: RecordHead = {
          recordId,
          recordType: "ACTIVITY_EVENT",
          headRevisionId: revisionId,
          headRevisionNumber: 1,
          state: "ACTIVE",
          updatedAt: now,
        };

        const auditEvent: PersistedAuditRow = {
          auditEventId,
          transactionId,
          recordId,
          recordType: "ACTIVITY_EVENT",
          previousRevisionId: null,
          resultingRevisionId: revisionId,
          action: "CREATE",
          initiator: "PATIENT",
          assistance: "NONE",
          occurredAt: now,
          reasonCode: "PATIENT_LOGGED",
        };

        const domainEvent: Omit<PersistedDomainEventRow, "localSequence" | "transactionIndex" | "committedAt"> = {
          eventId: domainEventId,
          eventName: "ACTIVITY_EVENT_RECORDED",
          transactionId,
          commandId,
          correlationId,
          change: {
            kind: "REVISION_CREATED",
            recordType: "ACTIVITY_EVENT",
            recordId,
            action: "CREATE",
            previousRevisionId: null,
            resultingRevisionId: revisionId,
            resultingRevisionNumber: 1,
          },
          payload,
        };

        const plan: AuthoritativeCommandPlan<
          PersistedRevisionRow,
          PersistedAuditRow,
          PersistedDomainEventRow,
          never,
          never
        > = {
          kind: "COMMIT",
          commandId,
          commandHash,
          completedAt: now,
          transactionId,
          headExpectations: [
            {
              kind: "MUST_NOT_EXIST",
              recordType: "ACTIVITY_EVENT",
              proposedRecordId: recordId,
            },
          ],
          recordRevisions: [storedRevision as unknown as PersistedRevisionRow],
          recordHeads: [head],
          deletionTombstones: [],
          auditEvents: [auditEvent],
          domainEvents: [domainEvent as any],
          eventWorkItems: workItemsFor(domainEvent, now),
          reverseDependencies: [],
          evaluationAudits: [],
          appPreference: null,
          safety: { kind: "NOT_REQUIRED" },
        };

        return executePlan(plan);
      } catch (error) {
        if (error instanceof StorageRowValidationError) {
          return { kind: "FAILED", code: "VALIDATION_FAILED" };
        }
        if (error instanceof z.ZodError) {
          return { kind: "FAILED", code: "VALIDATION_FAILED" };
        }
        return { kind: "FAILED", code: "STORAGE_UNAVAILABLE" };
      }
    },
  });
}

// Re-export for tests
export type {
  JournalCommandService,
  JournalCommandDependencies,
  JournalCommitResult,
} from "./journal-contracts";
export type { PersistedRevisionRow, PersistedAuditRow, PersistedDomainEventRow };
