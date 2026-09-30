import Dexie, { type Table } from "dexie";
import {
  JAGAON_DATABASE_NAME,
  JAGAON_DEXIE_VERSION,
  JAGAON_STORES_V1,
} from "./table-catalogue";

/**
 * Server-safe Dexie database class for the first complete JagaOn schema.
 *
 * The class declaration records every physical table as a property so the
 * table catalogue is visible at the type level, but until Packet 4F2 supplies
 * exact validated row adapters each table is typed as `Table<never, ...>`. This
 * makes incomplete future row shapes non-writable: Dexie's `put`/`add` accept
 * `TInsertType`, which is `never` here, so no row can be written through this
 * class until the row adapters land.
 *
 * Importing this module does not open or require IndexedDB. Dexie only touches
 * IndexedDB when `open()` is called or a query triggers auto-open. The factory
 * below constructs the class with `autoOpen: false` and never calls `open()`,
 * so importing this module during server build stays side-effect free.
 */
export class JagaOnDatabase extends Dexie {
  // Section 2.9
  appPreferences!: Table<never, string>;

  // Section 2.2
  recordRevisions!: Table<never, string>;

  // Section 2.3
  recordHeads!: Table<never, string>;

  // Section 2.3
  deletionTombstones!: Table<never, string>;

  // Section 2.4
  auditEvents!: Table<never, string>;

  // Section 2.4
  domainEvents!: Table<never, string>;

  // Section 2.4
  commandReceipts!: Table<never, string>;

  // Section 2.5
  eventWorkItems!: Table<never, string>;

  // Section 2.4
  eventConsumerReceipts!: Table<never, string>;

  // Section 2.6
  reverseDependencies!: Table<never, string>;

  // Section 2.7
  engineEvaluationAudits!: Table<never, string>;

  // Section 2.7
  aiInvocationAudits!: Table<never, string>;

  // Section 2.8
  runtimeManifests!: Table<never, string>;

  // Section 2.8
  governedAssets!: Table<never, string>;

  // Section 2.8
  runtimeActivationAudits!: Table<never, string>;

  // Section 2.9
  storageMetadata!: Table<never, string>;

  constructor(databaseName: string = JAGAON_DATABASE_NAME) {
    // autoOpen: false keeps the instance unopened until a caller explicitly
    // opens it. This prevents any IndexedDB access at construction time and
    // makes the module safe to import during server build.
    super(databaseName, { autoOpen: false });

    this.version(JAGAON_DEXIE_VERSION).stores(JAGAON_STORES_V1);
  }
}

/**
 * Factory for a JagaOn Dexie database instance.
 *
 * Defaults to the exact stable application name {@link JAGAON_DATABASE_NAME}
 * (`"jagaon"`) while accepting an injected `databaseName` for isolated tests.
 * The returned instance is unopened; tests call `open()` with an injected
 * `fake-indexeddb` and close and delete the database in cleanup.
 */
export function createJagaOnDatabase(
  databaseName: string = JAGAON_DATABASE_NAME,
): JagaOnDatabase {
  return new JagaOnDatabase(databaseName);
}
