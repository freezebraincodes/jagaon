/**
 * Narrow storage barrel for Packet 4F1.
 *
 * Exports only the approved Packet 4F1 constants, types, class, and factory.
 * It deliberately does NOT export Dexie table instances, mutable store
 * definitions, test helpers, row escape hatches, or direct write functions.
 * Those belong to later packets once exact validated row adapters and
 * repositories are defined.
 */
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
