/**
 * Narrow storage barrel for Packet 4F1 and Packet 4F2.
 *
 * Exports only the approved Packet 4F1 constants, types, class, and factory,
 * plus the Packet 4F2 strict stored-row contracts and validation codecs.
 * It deliberately does NOT export Dexie table instances, mutable store
 * definitions, test helpers, schema internals, Dexie tables, or a direct
 * write function. Those belong to later packets once exact validated row
 * adapters and repositories are defined.
 */

// --- Packet 4F1 exports ---

export {
  JAGAON_DATABASE_NAME,
  JAGAON_DEXIE_VERSION,
  JAGAON_TABLE_NAMES,
  JAGAON_STORES_V1,
  type JagaOnTableName,
} from "./table-catalogue";

export {
  JagaOnDatabase,
  createJagaOnDatabase,
} from "./database";

// --- Packet 4F2A exports ---

export {
  type AppPreferenceRow,
  appPreferenceRowSchema,
  createLanguagePreferenceRow,
} from "./app-preference-row";

export {
  WORK_PRIORITY_RANKS,
  type WorkPriorityRank,
  type StoredEventWorkItem,
  storedEventWorkItemSchema,
  createStoredEventWorkItem,
} from "./stored-event-work-item";

// --- Packet 4F2 validation boundaries ---

export {
  StorageRowValidationError,
  type StorageRowBoundary,
  type StorageRowFailureCode,
  type StorageRowCodec,
} from "./storage-row-codec";

export {
  IMPLEMENTED_STORAGE_ROW_TABLES,
  implementedStorageRowCodecs,
  type ImplementedStorageRowTable,
  type ImplementedStorageRowByTable,
  type ImplementedStorageRowCodecs,
} from "./implemented-row-codecs";

export {
  createStoredRecordRevisionCodec,
  type StoredTemporalIndexFields,
  type StoredRecordRevision,
  type StoredRecordRevisionCodec,
} from "./stored-record-revision";
