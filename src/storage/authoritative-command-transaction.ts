import type { Table } from "dexie";
import {
  commandIdSchema,
  type CommandId,
  type DomainEventId,
  type EventSequence,
} from "@/application/contracts/command-event-identifiers";
import {
  type CommandReceipt,
} from "@/application/contracts/command-receipt";
import {
  recordHeadExpectationSchema,
  type RecordHeadExpectation,
} from "@/application/contracts/command-envelope";
import type { EventRecordChange } from "@/application/contracts/domain-event-envelope";
import {
  eventWorkItemSchema,
  type EventWorkItem,
} from "@/application/contracts/event-work";
import { sha256DigestSchema, type Sha256Digest } from "@/application/contracts/canonical-json";
import {
  recordHeadSchema,
  deletionTombstoneSchema,
  type AuditEventId,
  type DeletionTombstone,
  type RecordHead,
  type RecordId,
  type RecordType,
  type RevisionId,
  type TransactionId,
} from "@/domain/shared";
import { instantSchema, type Instant } from "@/domain/shared/time";
import type { AppPreferenceRow } from "./app-preference-row";
import type { JagaOnDatabase } from "./database";
import {
  eventSequenceHighWaterMarkRowCodec,
  type EventSequenceHighWaterMarkRow,
} from "./event-sequence-metadata";
import { implementedStorageRowCodecs } from "./implemented-row-codecs";
import {
  createStoredEventWorkItem,
  type StoredEventWorkItem,
} from "./stored-event-work-item";
import {
  StorageRowValidationError,
  type StorageRowCodec,
} from "./storage-row-codec";
import {
  applyPermanentDeletion,
  DeletionClosureChangedError,
  type PermanentDeletionEffects,
} from "./permanent-deletion-transaction";

/**
 * Records whose historical payloads may disclose permanently deleted source
 * material or patient answers (domain Sections 8.10, 9.7 and 9.16). A
 * tombstone for one of these types purges the record's stored revisions and
 * its reverse dependency edges in the same transaction; other record types
 * keep their existing tombstone semantics.
 */
const PURGED_DERIVED_RECORD_TYPES: ReadonlySet<RecordType> = new Set<RecordType>([
  "LEARNED_KNOWLEDGE",
  "PATTERN_OBSERVATION",
  "PATTERN_EVIDENCE_SNAPSHOT",
  // Packet 8: a deleted inquiry or answer keeps no identifiable wording or raw answer.
  "INQUIRY",
  "INQUIRY_RESPONSE",
  // Packet 9B: a patient-deleted occurrence or context keeps no reported content (domain 1.10).
  "PREVENTIVE_CARE_RECORD",
  "CONTEXT_WINDOW",
  // Packet 9C: a deleted snapshot duplicates patient content, so none is kept (domain 11.12).
  "CARE_SUMMARY_SNAPSHOT",
]);

export type CommandTransactionErrorCode =
  | "INVALID_TRANSACTION_PLAN"
  | "COMMAND_REPLAY_MISMATCH"
  | "STORAGE_INTEGRITY_FAILED"
  | "STORAGE_COMMIT_FAILED"
  // Packet 10A: a permanent-deletion closure changed after planning.
  | "DELETION_CLOSURE_CHANGED";

/** A bounded transaction failure that never retains input rows or raw errors. */
export class CommandTransactionError extends Error {
  readonly name = "CommandTransactionError";

  constructor(readonly code: CommandTransactionErrorCode) {
    super(
      code === "COMMAND_REPLAY_MISMATCH"
        ? "Command identity was already used for different content"
        : code === "INVALID_TRANSACTION_PLAN"
          ? "Authoritative transaction plan is invalid"
          : code === "STORAGE_INTEGRITY_FAILED"
            ? "Stored authoritative state failed integrity validation"
            : code === "DELETION_CLOSURE_CHANGED"
              ? "Permanent-deletion dependency closure changed"
              : "Authoritative storage transaction failed",
    );
  }
}

type PersistedRevisionRow = {
  revisionId: RevisionId;
  recordId: RecordId;
  recordType: RecordType;
  revisionNumber: number;
  previousRevisionId: RevisionId | null;
  transactionId: TransactionId;
  auditEventId: AuditEventId;
};

type PersistedAuditRow = {
  auditEventId: AuditEventId;
  transactionId: TransactionId;
  recordId: RecordId;
  occurredAt: Instant;
};

type PersistedDomainEventRow = {
  eventId: DomainEventId;
  localSequence: EventSequence;
  transactionIndex: number;
  transactionId: TransactionId;
  commandId: CommandId;
  committedAt: Instant;
  change: EventRecordChange;
};

export type PreparedDomainEvent<TEvent extends PersistedDomainEventRow> = Omit<
  TEvent,
  "localSequence" | "transactionIndex" | "committedAt"
>;

export type SafetyTransactionParticipation =
  | { kind: "NOT_REQUIRED" }
  | {
      kind: "EVALUATED";
      safetyDecisionRevisionIds: [RevisionId, ...RevisionId[]];
    };

export type AuthoritativeCommitPlan<
  TRevision extends PersistedRevisionRow,
  TAudit extends PersistedAuditRow,
  TEvent extends PersistedDomainEventRow,
  TReverseDependency extends object,
  TEvaluationAudit extends object,
> = {
  kind: "COMMIT";
  commandId: CommandId;
  commandHash: Sha256Digest;
  completedAt: Instant;
  transactionId: TransactionId;
  headExpectations: RecordHeadExpectation[];
  recordRevisions: TRevision[];
  recordHeads: RecordHead[];
  deletionTombstones: DeletionTombstone[];
  auditEvents: TAudit[];
  domainEvents: PreparedDomainEvent<TEvent>[];
  eventWorkItems: EventWorkItem[];
  reverseDependencies: TReverseDependency[];
  evaluationAudits: TEvaluationAudit[];
  appPreference: AppPreferenceRow | null;
  safety: SafetyTransactionParticipation;
  /** Packet 10A: present only on a confirmed permanent-deletion plan. */
  permanentDeletion?: PermanentDeletionEffects;
};

export type TerminalReceiptPlan =
  | {
      kind: "NO_CHANGE";
      receipt: Extract<CommandReceipt, { outcome: "NO_CHANGE" }>;
    }
  | {
      kind: "REJECTED";
      receipt: Extract<CommandReceipt, { outcome: "REJECTED" }>;
    };

export type AuthoritativeCommandPlan<
  TRevision extends PersistedRevisionRow,
  TAudit extends PersistedAuditRow,
  TEvent extends PersistedDomainEventRow,
  TReverseDependency extends object,
  TEvaluationAudit extends object,
> =
  | AuthoritativeCommitPlan<
      TRevision,
      TAudit,
      TEvent,
      TReverseDependency,
      TEvaluationAudit
    >
  | TerminalReceiptPlan;

export type AuthoritativeCommandStore<
  TRevision extends PersistedRevisionRow,
  TAudit extends PersistedAuditRow,
  TEvent extends PersistedDomainEventRow,
  TReverseDependency extends object,
  TEvaluationAudit extends object,
> = {
  execute(
    plan: AuthoritativeCommandPlan<
      TRevision,
      TAudit,
      TEvent,
      TReverseDependency,
      TEvaluationAudit
    >,
  ): Promise<CommandReceipt>;
};

type TransactionCodecs<
  TRevision extends PersistedRevisionRow,
  TAudit extends PersistedAuditRow,
  TEvent extends PersistedDomainEventRow,
  TReverseDependency extends object,
  TEvaluationAudit extends object,
> = {
  revisionCodec: StorageRowCodec<TRevision>;
  auditCodec: StorageRowCodec<TAudit>;
  eventCodec: StorageRowCodec<TEvent>;
  reverseDependencyCodec: StorageRowCodec<TReverseDependency>;
  evaluationAuditCodec: StorageRowCodec<TEvaluationAudit>;
};

type ValidatedCommit<
  TRevision extends PersistedRevisionRow,
  TAudit extends PersistedAuditRow,
  TEvent extends PersistedDomainEventRow,
  TReverseDependency extends object,
  TEvaluationAudit extends object,
> = Omit<
  AuthoritativeCommitPlan<
    TRevision,
    TAudit,
    TEvent,
    TReverseDependency,
    TEvaluationAudit
  >,
  | "recordRevisions"
  | "recordHeads"
  | "deletionTombstones"
  | "auditEvents"
  | "eventWorkItems"
  | "reverseDependencies"
  | "evaluationAudits"
  | "appPreference"
> & {
  recordRevisions: TRevision[];
  recordHeads: RecordHead[];
  deletionTombstones: DeletionTombstone[];
  auditEvents: TAudit[];
  eventWorkItems: EventWorkItem[];
  reverseDependencies: TReverseDependency[];
  evaluationAudits: TEvaluationAudit[];
  appPreference: AppPreferenceRow | null;
};

const COMMIT_KEYS = [
  "kind",
  "commandId",
  "commandHash",
  "completedAt",
  "transactionId",
  "headExpectations",
  "recordRevisions",
  "recordHeads",
  "deletionTombstones",
  "auditEvents",
  "domainEvents",
  "eventWorkItems",
  "reverseDependencies",
  "evaluationAudits",
  "appPreference",
  "safety",
] as const;

function failPlan(): never {
  throw new CommandTransactionError("INVALID_TRANSACTION_PLAN");
}

function assertExactKeys(value: object, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    failPlan();
  }
}

function assertUnique(values: readonly (string | number)[]): void {
  if (new Set(values).size !== values.length) failPlan();
}

function table<T>(database: JagaOnDatabase, name: string): Table<T> {
  return database.table<T>(name);
}

function validateSafety<TRevision extends PersistedRevisionRow>(
  safety: SafetyTransactionParticipation,
  revisions: readonly TRevision[],
): void {
  if (safety.kind === "NOT_REQUIRED") {
    assertExactKeys(safety, ["kind"]);
    return;
  }
  if (safety.kind !== "EVALUATED") failPlan();
  assertExactKeys(safety, ["kind", "safetyDecisionRevisionIds"]);
  if (safety.safetyDecisionRevisionIds.length === 0) failPlan();
  assertUnique(safety.safetyDecisionRevisionIds);
  const revisionsById = new Map(
    revisions.map((revision) => [revision.revisionId, revision]),
  );
  for (const revisionId of safety.safetyDecisionRevisionIds) {
    const revision = revisionsById.get(revisionId);
    if (revision?.recordType !== "SAFETY_EVENT") failPlan();
  }
}

function validateHeadConsistency<TRevision extends PersistedRevisionRow>(
  revisions: readonly TRevision[],
  heads: readonly RecordHead[],
  tombstones: readonly DeletionTombstone[],
  audits: readonly PersistedAuditRow[],
  transactionId: TransactionId,
): void {
  assertUnique(revisions.map((row) => row.revisionId));
  assertUnique(revisions.map((row) => row.recordId));
  assertUnique(heads.map((row) => row.recordId));
  assertUnique(tombstones.map((row) => row.recordId));
  assertUnique(audits.map((row) => row.auditEventId));

  const revisionByRecord = new Map(
    revisions.map((revision) => [revision.recordId, revision]),
  );
  const tombstoneByRecord = new Map(
    tombstones.map((tombstone) => [tombstone.recordId, tombstone]),
  );
  const auditIds = new Set(audits.map((audit) => audit.auditEventId));

  for (const revision of revisions) {
    if (
      revision.transactionId !== transactionId ||
      !auditIds.has(revision.auditEventId)
    ) {
      failPlan();
    }
  }
  for (const tombstone of tombstones) {
    if (
      tombstone.transactionId !== transactionId ||
      !auditIds.has(tombstone.auditEventId) ||
      revisionByRecord.has(tombstone.recordId)
    ) {
      failPlan();
    }
  }
  for (const audit of audits) {
    if (audit.transactionId !== transactionId) failPlan();
  }

  for (const head of heads) {
    const revision = revisionByRecord.get(head.recordId);
    const tombstone = tombstoneByRecord.get(head.recordId);
    if (head.state === "ACTIVE") {
      if (
        revision === undefined ||
        tombstone !== undefined ||
        revision.recordType !== head.recordType ||
        revision.revisionId !== head.headRevisionId ||
        revision.revisionNumber !== head.headRevisionNumber
      ) {
        failPlan();
      }
    } else if (
      tombstone === undefined ||
      revision !== undefined ||
      tombstone.recordType !== head.recordType
    ) {
      failPlan();
    }
  }

  for (const revision of revisions) {
    if (!heads.some((head) => head.recordId === revision.recordId)) failPlan();
  }
  for (const tombstone of tombstones) {
    if (!heads.some((head) => head.recordId === tombstone.recordId)) failPlan();
  }
}

function validateCommit<
  TRevision extends PersistedRevisionRow,
  TAudit extends PersistedAuditRow,
  TEvent extends PersistedDomainEventRow,
  TReverseDependency extends object,
  TEvaluationAudit extends object,
>(
  plan: AuthoritativeCommitPlan<
    TRevision,
    TAudit,
    TEvent,
    TReverseDependency,
    TEvaluationAudit
  >,
  codecs: TransactionCodecs<
    TRevision,
    TAudit,
    TEvent,
    TReverseDependency,
    TEvaluationAudit
  >,
): ValidatedCommit<
  TRevision,
  TAudit,
  TEvent,
  TReverseDependency,
  TEvaluationAudit
> {
  assertExactKeys(
    plan,
    Object.prototype.hasOwnProperty.call(plan, "permanentDeletion") ? [...COMMIT_KEYS, "permanentDeletion"] : COMMIT_KEYS,
  );
  if (plan.permanentDeletion !== undefined) {
    // Every purged record is tombstoned by this same plan.
    const tombstoned = new Set(plan.deletionTombstones.map((row) => row.recordId as string));
    assertUnique([...plan.permanentDeletion.purgedRecordIds]);
    if (plan.permanentDeletion.purgedRecordIds.length === 0) failPlan();
    for (const recordId of plan.permanentDeletion.purgedRecordIds) if (!tombstoned.has(recordId)) failPlan();
    if (typeof plan.permanentDeletion.closureUnchanged !== "function") failPlan();
  }
  commandIdSchema.parse(plan.commandId);
  sha256DigestSchema.parse(plan.commandHash);
  instantSchema.parse(plan.completedAt);
  if (plan.domainEvents.length === 0) failPlan();

  const headExpectations = plan.headExpectations.map((expectation) =>
    recordHeadExpectationSchema.parse(expectation),
  );
  assertUnique(
    headExpectations.map((expectation) =>
      expectation.kind === "MUST_NOT_EXIST"
        ? expectation.proposedRecordId
        : expectation.recordId,
    ),
  );

  const recordRevisions = plan.recordRevisions.map((row) =>
    codecs.revisionCodec.validateForWrite(row),
  );
  const recordHeads = plan.recordHeads.map((row) => recordHeadSchema.parse(row));
  const deletionTombstones = plan.deletionTombstones.map((row) =>
    deletionTombstoneSchema.parse(row),
  );
  const auditEvents = plan.auditEvents.map((row) =>
    codecs.auditCodec.validateForWrite(row),
  );
  const eventWorkItems = plan.eventWorkItems.map((row) =>
    eventWorkItemSchema.parse(row),
  );
  const reverseDependencies = plan.reverseDependencies.map((row) =>
    codecs.reverseDependencyCodec.validateForWrite(row),
  );
  const evaluationAudits = plan.evaluationAudits.map((row) =>
    codecs.evaluationAuditCodec.validateForWrite(row),
  );
  const appPreference =
    plan.appPreference === null
      ? null
      : implementedStorageRowCodecs.appPreferences.validateForWrite(
          plan.appPreference,
        );

  assertUnique(plan.domainEvents.map((event) => event.eventId));
  for (let index = 0; index < plan.domainEvents.length; index += 1) {
    const event = plan.domainEvents[index] as object;
    if (
      Object.prototype.hasOwnProperty.call(event, "localSequence") ||
      Object.prototype.hasOwnProperty.call(event, "transactionIndex") ||
      Object.prototype.hasOwnProperty.call(event, "committedAt")
    ) {
      failPlan();
    }
    codecs.eventCodec.validateForWrite({
      ...event,
      localSequence: 1,
      transactionIndex: index,
      committedAt: plan.completedAt,
    });
    const typedEvent = plan.domainEvents[index];
    if (
      typedEvent.commandId !== plan.commandId ||
      typedEvent.transactionId !== plan.transactionId
    ) {
      failPlan();
    }
  }

  assertUnique(eventWorkItems.map((item) => item.workItemId));
  assertUnique(
    eventWorkItems.map(
      (item) => `${item.eventId}|${item.consumer}|${item.handlerVersion}`,
    ),
  );
  const eventIds = new Set(plan.domainEvents.map((event) => event.eventId));
  for (const work of eventWorkItems) {
    if (!eventIds.has(work.eventId)) failPlan();
  }

  validateHeadConsistency(
    recordRevisions,
    recordHeads,
    deletionTombstones,
    auditEvents,
    plan.transactionId,
  );
  validateSafety(plan.safety, recordRevisions);

  return {
    ...plan,
    headExpectations,
    recordRevisions,
    recordHeads,
    deletionTombstones,
    auditEvents,
    eventWorkItems,
    reverseDependencies,
    evaluationAudits,
    appPreference,
  };
}

async function readExistingReceipt(
  receipts: Table<CommandReceipt>,
  commandId: CommandId,
): Promise<CommandReceipt | undefined> {
  const raw = await receipts.get(commandId);
  return raw === undefined
    ? undefined
    : implementedStorageRowCodecs.commandReceipts.validateAfterRead(raw);
}

function replayOrThrow(
  existing: CommandReceipt,
  commandHash: Sha256Digest,
): CommandReceipt {
  if (existing.commandHash !== commandHash) {
    throw new CommandTransactionError("COMMAND_REPLAY_MISMATCH");
  }
  return existing;
}

async function readCurrentHeads(
  heads: Table<RecordHead>,
  expectations: readonly RecordHeadExpectation[],
): Promise<{ conflict: boolean; currentHeads: RecordHead[] }> {
  let conflict = false;
  const currentHeads: RecordHead[] = [];
  for (const expectation of expectations) {
    const recordId =
      expectation.kind === "MUST_NOT_EXIST"
        ? expectation.proposedRecordId
        : expectation.recordId;
    const raw = await heads.get(recordId);
    const current =
      raw === undefined
        ? undefined
        : implementedStorageRowCodecs.recordHeads.validateAfterRead(raw);
    if (current !== undefined) currentHeads.push(current);
    if (expectation.kind === "MUST_NOT_EXIST") {
      if (current !== undefined) conflict = true;
    } else if (
      current === undefined ||
      current.recordType !== expectation.recordType ||
      current.headRevisionId !== expectation.expectedRevisionId ||
      current.headRevisionNumber !== expectation.expectedRevisionNumber
    ) {
      conflict = true;
    }
  }
  return { conflict, currentHeads };
}

async function currentHighWater<TEvent extends PersistedDomainEventRow>(
  metadataTable: Table<EventSequenceHighWaterMarkRow>,
  events: Table<TEvent>,
  eventCodec: StorageRowCodec<TEvent>,
): Promise<number> {
  const rawMetadata = await metadataTable.get("EVENT_SEQUENCE_HIGH_WATER_MARK");
  const lastRawEvent = await events.orderBy("localSequence").last();
  const lastEvent =
    lastRawEvent === undefined
      ? undefined
      : eventCodec.validateAfterRead(lastRawEvent);

  if (rawMetadata === undefined) {
    if (lastEvent !== undefined) {
      throw new CommandTransactionError("STORAGE_INTEGRITY_FAILED");
    }
    return 0;
  }

  const metadata = eventSequenceHighWaterMarkRowCodec.validateAfterRead(
    rawMetadata,
  );
  if (
    lastEvent !== undefined &&
    metadata.lastAllocatedSequence < lastEvent.localSequence
  ) {
    throw new CommandTransactionError("STORAGE_INTEGRITY_FAILED");
  }
  return metadata.lastAllocatedSequence;
}

function buildCommittedReceipt<
  TRevision extends PersistedRevisionRow,
  TAudit extends PersistedAuditRow,
  TEvent extends PersistedDomainEventRow,
  TReverseDependency extends object,
  TEvaluationAudit extends object,
>(
  plan: ValidatedCommit<
    TRevision,
    TAudit,
    TEvent,
    TReverseDependency,
    TEvaluationAudit
  >,
  finalEvents: readonly TEvent[],
): Extract<CommandReceipt, { outcome: "COMMITTED" }> {
  return {
    outcome: "COMMITTED",
    commandId: plan.commandId,
    commandHash: plan.commandHash,
    completedAt: plan.completedAt,
    transactionId: plan.transactionId,
    resultingRevisions: plan.recordRevisions.map((revision) => ({
      recordType: revision.recordType,
      recordId: revision.recordId,
      revisionId: revision.revisionId,
    })),
    deletedRecords: plan.deletionTombstones.map((tombstone) => ({
      recordType: tombstone.recordType,
      recordId: tombstone.recordId,
    })),
    auditEventIds: plan.auditEvents.map((audit) => audit.auditEventId),
    domainEventIds: finalEvents.map((event) => event.eventId),
  };
}

export function createAuthoritativeCommandStore<
  TRevision extends PersistedRevisionRow,
  TAudit extends PersistedAuditRow,
  TEvent extends PersistedDomainEventRow,
  TReverseDependency extends object,
  TEvaluationAudit extends object,
>(
  database: JagaOnDatabase,
  codecs: TransactionCodecs<
    TRevision,
    TAudit,
    TEvent,
    TReverseDependency,
    TEvaluationAudit
  >,
): AuthoritativeCommandStore<
  TRevision,
  TAudit,
  TEvent,
  TReverseDependency,
  TEvaluationAudit
> {
  const receipts = table<CommandReceipt>(database, "commandReceipts");
  const revisions = table<TRevision>(database, "recordRevisions");
  const heads = table<RecordHead>(database, "recordHeads");
  const tombstones = table<DeletionTombstone>(database, "deletionTombstones");
  const audits = table<TAudit>(database, "auditEvents");
  const events = table<TEvent>(database, "domainEvents");
  const work = table<StoredEventWorkItem>(database, "eventWorkItems");
  const dependencies = table<TReverseDependency>(
    database,
    "reverseDependencies",
  );
  const evaluations = table<TEvaluationAudit>(
    database,
    "engineEvaluationAudits",
  );
  const preferences = table<AppPreferenceRow>(database, "appPreferences");
  const metadata = table<EventSequenceHighWaterMarkRow>(
    database,
    "storageMetadata",
  );

  const transactionTables = [
    receipts,
    revisions,
    heads,
    tombstones,
    audits,
    events,
    work,
    dependencies,
    evaluations,
    preferences,
    metadata,
  ];

  return Object.freeze({
    async execute(
      plan: AuthoritativeCommandPlan<
        TRevision,
        TAudit,
        TEvent,
        TReverseDependency,
        TEvaluationAudit
      >,
    ): Promise<CommandReceipt> {
      try {
        if (plan.kind === "NO_CHANGE" || plan.kind === "REJECTED") {
          assertExactKeys(plan, ["kind", "receipt"]);
          if (plan.kind !== plan.receipt.outcome) failPlan();
          const receipt =
            implementedStorageRowCodecs.commandReceipts.validateForWrite(
              plan.receipt,
            );
          return await database.transaction("rw", receipts, async () => {
            const existing = await readExistingReceipt(
              receipts,
              receipt.commandId,
            );
            if (existing !== undefined) {
              return replayOrThrow(existing, receipt.commandHash);
            }
            await receipts.add(receipt);
            return receipt;
          });
        }

        const validated = validateCommit(plan, codecs);
        return await database.transaction(
          "rw",
          transactionTables,
          async (): Promise<CommandReceipt> => {
            const existing = await readExistingReceipt(
              receipts,
              validated.commandId,
            );
            if (existing !== undefined) {
              return replayOrThrow(existing, validated.commandHash);
            }

            const headCheck = await readCurrentHeads(
              heads,
              validated.headExpectations,
            );
            if (headCheck.conflict) {
              const rejection =
                implementedStorageRowCodecs.commandReceipts.validateForWrite({
                  outcome: "REJECTED",
                  commandId: validated.commandId,
                  commandHash: validated.commandHash,
                  completedAt: validated.completedAt,
                  errorCode: "HEAD_CONFLICT",
                  currentHeads: headCheck.currentHeads,
                });
              await receipts.add(rejection);
              return rejection;
            }

            const highWater = await currentHighWater(
              metadata,
              events,
              codecs.eventCodec,
            );
            if (
              validated.domainEvents.length >
              Number.MAX_SAFE_INTEGER - highWater
            ) {
              throw new CommandTransactionError("STORAGE_INTEGRITY_FAILED");
            }

            const sequenceByEvent = new Map<DomainEventId, EventSequence>();
            const finalEvents = validated.domainEvents.map((prepared, index) => {
              const localSequence = (highWater + index + 1) as EventSequence;
              const event = codecs.eventCodec.validateForWrite({
                ...prepared,
                localSequence,
                transactionIndex: index,
                committedAt: validated.completedAt,
              });
              sequenceByEvent.set(event.eventId, event.localSequence);
              return event;
            });
            const finalWork = validated.eventWorkItems.map((item) => {
              const sourceSequence = sequenceByEvent.get(item.eventId);
              if (sourceSequence === undefined) failPlan();
              return implementedStorageRowCodecs.eventWorkItems.validateForWrite(
                createStoredEventWorkItem(item, sourceSequence),
              );
            });
            const receipt =
              implementedStorageRowCodecs.commandReceipts.validateForWrite(
                buildCommittedReceipt(validated, finalEvents),
              );
            const sequenceRow =
              eventSequenceHighWaterMarkRowCodec.validateForWrite({
                key: "EVENT_SEQUENCE_HIGH_WATER_MARK",
                lastAllocatedSequence: highWater + finalEvents.length,
                updatedAt: validated.completedAt,
              });

            if (validated.permanentDeletion !== undefined) {
              await applyPermanentDeletion(
                {
                  heads: heads as Table<unknown>,
                  revisions: revisions as Table<unknown>,
                  dependencies: dependencies as Table<unknown>,
                  evaluations: evaluations as Table<unknown>,
                  receipts,
                  events: events as Table<unknown>,
                },
                validated.permanentDeletion,
                {
                  eventCodec: codecs.eventCodec as StorageRowCodec<unknown>,
                  receiptCodec: implementedStorageRowCodecs.commandReceipts,
                },
              );
            }
            if (validated.recordRevisions.length > 0) {
              await revisions.bulkAdd(validated.recordRevisions);
            }
            if (validated.deletionTombstones.length > 0) {
              await tombstones.bulkAdd(validated.deletionTombstones);
              for (const tombstone of validated.deletionTombstones) {
                if (!PURGED_DERIVED_RECORD_TYPES.has(tombstone.recordType)) continue;
                await revisions.where("recordId").equals(tombstone.recordId).delete();
                await dependencies.where("dependentRecordId").equals(tombstone.recordId).delete();
              }
            }
            if (validated.recordHeads.length > 0) {
              await heads.bulkPut(validated.recordHeads);
            }
            if (validated.auditEvents.length > 0) {
              await audits.bulkAdd(validated.auditEvents);
            }
            await events.bulkAdd(finalEvents);
            if (finalWork.length > 0) await work.bulkAdd(finalWork);
            if (validated.reverseDependencies.length > 0) {
              await dependencies.bulkAdd(validated.reverseDependencies);
            }
            if (validated.evaluationAudits.length > 0) {
              await evaluations.bulkAdd(validated.evaluationAudits);
            }
            if (validated.appPreference !== null) {
              await preferences.put(validated.appPreference);
            }
            await receipts.add(receipt);
            await metadata.put(sequenceRow);
            return receipt;
          },
        );
      } catch (error) {
        if (
          error instanceof CommandTransactionError ||
          error instanceof StorageRowValidationError
        ) {
          throw error;
        }
        if (error instanceof DeletionClosureChangedError) {
          throw new CommandTransactionError("DELETION_CLOSURE_CHANGED");
        }
        throw new CommandTransactionError("STORAGE_COMMIT_FAILED");
      }
    },
  });
}
