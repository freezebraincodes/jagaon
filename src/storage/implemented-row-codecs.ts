import {
  commandReceiptSchema,
  eventConsumerReceiptSchema,
  type CommandReceipt,
  type EventConsumerReceipt,
} from "@/application/contracts";
import {
  deletionTombstoneSchema,
  recordHeadSchema,
  type DeletionTombstone,
  type RecordHead,
} from "@/domain/shared";
import {
  appPreferenceRowSchema,
  type AppPreferenceRow,
} from "./app-preference-row";
import {
  storedEventWorkItemSchema,
  type StoredEventWorkItem,
} from "./stored-event-work-item";
import {
  createStorageRowCodec,
  type StorageRowCodec,
} from "./storage-row-codec";
import {
  reverseDependencyRowSchema,
  type StoredReverseDependency,
} from "./reverse-dependency-row";
import {
  engineEvaluationAuditRowSchema,
  type StoredEngineEvaluationAudit,
} from "./engine-evaluation-audit-row";

/**
 * Tables whose exact owning row schema exists after Packet 7A.
 *
 * Packet 7A adds the reverse-dependency and engine-evaluation audit rows. The
 * remaining eight physical tables stay intentionally unregistered until their
 * owning packets supply exact closed row contracts.
 */
export const IMPLEMENTED_STORAGE_ROW_TABLES = Object.freeze([
  "appPreferences",
  "recordHeads",
  "deletionTombstones",
  "commandReceipts",
  "eventWorkItems",
  "eventConsumerReceipts",
  "reverseDependencies",
  "engineEvaluationAudits",
] as const);

export type ImplementedStorageRowTable =
  (typeof IMPLEMENTED_STORAGE_ROW_TABLES)[number];

export type ImplementedStorageRowByTable = {
  appPreferences: AppPreferenceRow;
  recordHeads: RecordHead;
  deletionTombstones: DeletionTombstone;
  commandReceipts: CommandReceipt;
  eventWorkItems: StoredEventWorkItem;
  eventConsumerReceipts: EventConsumerReceipt;
  reverseDependencies: StoredReverseDependency;
  engineEvaluationAudits: StoredEngineEvaluationAudit;
};

export type ImplementedStorageRowCodecs = {
  readonly [TTable in ImplementedStorageRowTable]: StorageRowCodec<
    ImplementedStorageRowByTable[TTable]
  >;
};

export const implementedStorageRowCodecs: ImplementedStorageRowCodecs =
  Object.freeze({
    appPreferences: createStorageRowCodec<AppPreferenceRow>(
      "appPreferences",
      appPreferenceRowSchema,
    ),
    recordHeads: createStorageRowCodec<RecordHead>(
      "recordHeads",
      recordHeadSchema,
    ),
    deletionTombstones: createStorageRowCodec<DeletionTombstone>(
      "deletionTombstones",
      deletionTombstoneSchema,
    ),
    commandReceipts: createStorageRowCodec<CommandReceipt>(
      "commandReceipts",
      commandReceiptSchema,
    ),
    eventWorkItems: createStorageRowCodec<StoredEventWorkItem>(
      "eventWorkItems",
      storedEventWorkItemSchema,
    ),
    eventConsumerReceipts: createStorageRowCodec<EventConsumerReceipt>(
      "eventConsumerReceipts",
      eventConsumerReceiptSchema,
    ),
    reverseDependencies: createStorageRowCodec<StoredReverseDependency>(
      "reverseDependencies",
      reverseDependencyRowSchema,
    ),
    engineEvaluationAudits: createStorageRowCodec<StoredEngineEvaluationAudit>(
      "engineEvaluationAudits",
      engineEvaluationAuditRowSchema,
    ),
  });
