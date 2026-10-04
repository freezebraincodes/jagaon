import { describe, it, expect, afterEach, beforeEach, beforeAll, afterAll } from "vitest";
import fakeIndexedDB, { IDBKeyRange as FDBKeyRange } from "fake-indexeddb";
import Dexie from "dexie";
import {
  createJagaOnDatabase,
  JagaOnDatabase,
} from "./database";
import {
  JAGAON_DATABASE_NAME,
  JAGAON_DEXIE_VERSION,
  JAGAON_TABLE_NAMES,
  type JagaOnTableName,
} from "./table-catalogue";

/**
 * Packet 4F1 database tests.
 *
 * Each case constructs a uniquely named database backed by `fake-indexeddb`,
 * inspects the live Dexie schema, then closes and deletes the database in
 * cleanup. No test relies on a shared database instance.
 */

// Dexie reads its default indexedDB/IDBKeyRange from the global scope at
// module load time into `Dexie.dependencies`. The jsdom test environment does
// not define them, so install fake-indexeddb onto `Dexie.dependencies` for
// this suite only. Originals are restored in afterAll. This is the documented
// pattern for fake-indexeddb with Dexie and keeps `database.ts` free of any
// test-infrastructure coupling.
let originalIndexedDB: unknown;
let originalIDBKeyRange: unknown;
let hadIndexedDB = false;
let hadIDBKeyRange = false;

beforeAll(() => {
  const deps = Dexie.dependencies as {
    indexedDB: unknown;
    IDBKeyRange: unknown;
  };
  hadIndexedDB = "indexedDB" in deps && deps.indexedDB !== null && deps.indexedDB !== undefined;
  hadIDBKeyRange = "IDBKeyRange" in deps && deps.IDBKeyRange !== null && deps.IDBKeyRange !== undefined;
  originalIndexedDB = deps.indexedDB;
  originalIDBKeyRange = deps.IDBKeyRange;
  deps.indexedDB = fakeIndexedDB;
  deps.IDBKeyRange = FDBKeyRange;
});

afterAll(() => {
  const deps = Dexie.dependencies as {
    indexedDB: unknown;
    IDBKeyRange: unknown;
  };
  if (hadIndexedDB) {
    deps.indexedDB = originalIndexedDB;
  } else {
    deps.indexedDB = null;
  }
  if (hadIDBKeyRange) {
    deps.IDBKeyRange = originalIDBKeyRange;
  } else {
    deps.IDBKeyRange = null;
  }
});

// Track every database instance opened during a test so afterEach can close
// and delete all of them, even on failure.
let openedDbs: JagaOnDatabase[] = [];

function makeUniqueName(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

async function openDatabase(name: string): Promise<JagaOnDatabase> {
  const db = createJagaOnDatabase(name);
  openedDbs.push(db);
  await db.open();
  return db;
}

beforeEach(() => {
  openedDbs = [];
});

afterEach(async () => {
  // Close every open connection first, then delete by name. Closing first
  // avoids the "another connection wants to delete" warning from
  // fake-indexeddb.
  for (const db of openedDbs) {
    try {
      db.close();
    } catch {
      // Best-effort close.
    }
  }
  const names = openedDbs.map((db) => db.name);
  for (const name of names) {
    try {
      await Dexie.delete(name);
    } catch {
      // Best-effort cleanup; a missing database is not a test failure.
    }
  }
  openedDbs = [];
});

// Live Dexie schema inspection helpers. Dexie exposes the parsed schema on
// `db._dbSchema[table]`.
type LiveIndexSpec = {
  keyPath: string | string[];
  compound: boolean;
  unique: boolean;
  autoIncrement: boolean;
  multiEntry: boolean;
  isPrimaryKey: boolean;
};

type LiveTableSchema = {
  primKey: LiveIndexSpec;
  indexes: LiveIndexSpec[];
};

function getLiveTableSchema(db: JagaOnDatabase, table: string): LiveTableSchema {
  const schema = (db as unknown as { _dbSchema: Record<string, unknown> })._dbSchema;
  if (!schema || !schema[table]) {
    throw new Error(`no live schema for table ${table}`);
  }
  // Dexie's live IndexSpec uses `multi`/`auto` (boolean | undefined) rather
  // than `multiEntry`/`autoIncrement`. Coerce undefined to false.
  type DexieIndexSpec = {
    keyPath: string | string[];
    compound: boolean | undefined;
    unique: boolean | undefined;
    auto: boolean | undefined;
    multi: boolean | undefined;
  };
  const t = schema[table] as {
    primKey: DexieIndexSpec;
    indexes: DexieIndexSpec[];
  };
  const map = (ix: DexieIndexSpec, isPrimaryKey: boolean): LiveIndexSpec => ({
    keyPath: ix.keyPath as string | string[],
    compound: ix.compound === true,
    unique: ix.unique === true,
    autoIncrement: ix.auto === true,
    multiEntry: ix.multi === true,
    isPrimaryKey,
  });
  return {
    primKey: map(t.primKey, true),
    indexes: t.indexes.map((ix) => map(ix, false)),
  };
}

// Independent expected live schema, transcribed from storage-backup-spec.md
// Sections 2.2-2.9. NOT derived from the implementation constants.
type ExpectedIndex = {
  keyPath: string | string[];
  unique: boolean;
  multiEntry: boolean;
};
type ExpectedTable = { primKey: ExpectedIndex; indexes: ExpectedIndex[] };

const single = (kp: string, unique = false): ExpectedIndex => ({
  keyPath: kp,
  unique,
  multiEntry: false,
});
const compound = (kp: string[], unique = false): ExpectedIndex => ({
  keyPath: kp,
  unique,
  multiEntry: false,
});

const EXPECTED: Record<JagaOnTableName, ExpectedTable> = {
  appPreferences: {
    primKey: single("key"),
    indexes: [],
  },
  recordRevisions: {
    primKey: single("revisionId"),
    indexes: [
      single("recordId"),
      single("recordType"),
      single("previousRevisionId"),
      single("transactionId"),
      single("auditEventId"),
      single("revisionCreatedAt"),
      compound(["recordId", "revisionNumber"], true),
      compound(["recordType", "recordedAt"]),
      compound(["recordType", "occurrenceSortInstant"]),
      compound(["recordType", "effectiveStartSortInstant"]),
      compound(["recordType", "localDateSortKey"]),
    ],
  },
  recordHeads: {
    primKey: single("recordId"),
    indexes: [
      single("recordType"),
      single("headRevisionId"),
      single("state"),
      single("updatedAt"),
    ],
  },
  deletionTombstones: {
    primKey: single("recordId"),
    indexes: [
      single("recordType"),
      single("deletedAt"),
      single("auditEventId"),
      single("transactionId"),
    ],
  },
  auditEvents: {
    primKey: single("auditEventId"),
    indexes: [
      single("recordId"),
      single("transactionId"),
      single("occurredAt"),
      compound(["recordId", "occurredAt"]),
    ],
  },
  domainEvents: {
    primKey: single("eventId"),
    indexes: [
      single("localSequence", true),
      single("eventName"),
      single("transactionId"),
      single("commandId"),
      single("correlationId"),
      single("committedAt"),
      compound(["eventName", "localSequence"]),
    ],
  },
  commandReceipts: {
    primKey: single("commandId"),
    indexes: [
      single("outcome"),
      single("completedAt"),
      single("transactionId"),
    ],
  },
  eventWorkItems: {
    primKey: single("workItemId"),
    indexes: [
      single("eventId"),
      single("consumer"),
      single("handlerVersion"),
      single("stateCode"),
      single("sourceEventSequence"),
      single("leaseExpiresAt"),
      compound(["eventId", "consumer", "handlerVersion"], true),
      compound([
        "stateCode",
        "priorityRank",
        "availableAt",
        "sourceEventSequence",
      ]),
      compound(["stateCode", "leaseExpiresAt"]),
    ],
  },
  eventConsumerReceipts: {
    primKey: compound(["eventId", "consumer", "handlerVersion"]),
    indexes: [
      single("eventId"),
      single("consumer"),
      single("completedAt"),
    ],
  },
  reverseDependencies: {
    primKey: compound([
      "sourceRevisionId",
      "dependentRevisionId",
      "dependencyRole",
    ]),
    indexes: [
      single("sourceRevisionId"),
      single("dependentRecordId"),
      single("dependentRevisionId"),
      single("owner"),
      compound(["dependentRecordId", "dependentRevisionId"]),
    ],
  },
  engineEvaluationAudits: {
    primKey: single("evaluationId"),
    indexes: [
      single("engine"),
      single("evaluatedAt"),
      single("runtimeManifestId"),
      single("inputFingerprint"),
      single("resultFingerprint"),
      compound(["engine", "evaluatedAt"]),
    ],
  },
  aiInvocationAudits: {
    primKey: single("requestId"),
    indexes: [
      single("taskType"),
      single("requestedAt"),
      single("outcomeCode"),
      single("routeProfileKey"),
      compound(["taskType", "requestedAt"]),
    ],
  },
  runtimeManifests: {
    primKey: compound(["manifestId", "manifestVersion"]),
    indexes: [
      single("lifecycle"),
      single("effectiveFrom"),
      single("expiresAt"),
      compound(["lifecycle", "effectiveFrom"]),
    ],
  },
  governedAssets: {
    primKey: compound(["assetKey", "assetVersion"]),
    indexes: [],
  },
  runtimeActivationAudits: {
    primKey: single("activationAuditId"),
    indexes: [
      single("runtimeKind"),
      single("action"),
      single("evaluatedAt"),
      single("resultingVersionKey"),
      compound(["runtimeKind", "evaluatedAt"]),
    ],
  },
  storageMetadata: {
    primKey: single("key"),
    indexes: [],
  },
};

describe("JagaOnDatabase construction", () => {
  it("does not open IndexedDB at construction time", () => {
    const db = createJagaOnDatabase(makeUniqueName("no-open"));
    // An unopened Dexie instance has no open connection. `verno` reflects the
    // declared version (1), not an opened connection; `isOpen()` is the
    // correct indicator that no IndexedDB access has occurred.
    expect(db.isOpen()).toBe(false);
    expect((db as unknown as { idbdb: unknown }).idbdb).toBeNull();
    openedDbs.push(db);
    db.close();
  });

  it("defaults to the exact stable application name jagaon", () => {
    const db = createJagaOnDatabase();
    expect(db.name).toBe(JAGAON_DATABASE_NAME);
    expect(db.name).toBe("jagaon");
    openedDbs.push(db);
    db.close();
  });

  it("opens at the current Dexie version (version 2; version 1 kept only for the registered upgrade)", async () => {
    const name = makeUniqueName("verno");
    const db = await openDatabase(name);
    expect(db.verno).toBe(JAGAON_DEXIE_VERSION);
    expect(db.verno).toBe(2);
  });

  it("is a JagaOnDatabase instance extending Dexie", () => {
    const db = createJagaOnDatabase(makeUniqueName("instance"));
    expect(db).toBeInstanceOf(JagaOnDatabase);
    expect(db).toBeInstanceOf(Dexie);
    openedDbs.push(db);
    db.close();
  });
});

describe("JagaOnDatabase live schema catalogue", () => {
  it("contains exactly the 16 approved tables", async () => {
    const name = makeUniqueName("catalogue");
    const db = await openDatabase(name);
    const liveNames = db.tables.map((t) => t.name).sort();
    const expectedNames = [...JAGAON_TABLE_NAMES].sort();
    expect(liveNames).toEqual(expectedNames);
    expect(db.tables).toHaveLength(16);
  });

  for (const tableName of JAGAON_TABLE_NAMES) {
    describe(`table ${tableName}`, () => {
      let db: JagaOnDatabase;

      beforeEach(async () => {
        db = await openDatabase(makeUniqueName(tableName));
      });

      it("primary key path, compoundness, and auto-increment match spec", () => {
        const live = getLiveTableSchema(db, tableName);
        const expected = EXPECTED[tableName];
        expect(live.primKey.keyPath).toEqual(expected.primKey.keyPath);
        expect(live.primKey.compound).toBe(!Array.isArray(expected.primKey.keyPath) ? false : true);
        expect(live.primKey.autoIncrement).toBe(false);
      });

      it("has exactly the approved secondary indexes", () => {
        const live = getLiveTableSchema(db, tableName);
        const expected = EXPECTED[tableName];
        expect(live.indexes).toHaveLength(expected.indexes.length);
      });

      it("every index keyPath, compoundness, uniqueness, and multiEntry matches spec", () => {
        const live = getLiveTableSchema(db, tableName);
        const expected = EXPECTED[tableName];
        for (let i = 0; i < expected.indexes.length; i++) {
          const e = expected.indexes[i];
          const a = live.indexes[i];
          expect(a.keyPath).toEqual(e.keyPath);
          expect(a.compound).toBe(Array.isArray(e.keyPath));
          expect(a.unique).toBe(e.unique);
          expect(a.multiEntry).toBe(e.multiEntry);
        }
      });

      it("no unapproved extra index is present", () => {
        const live = getLiveTableSchema(db, tableName);
        const expected = EXPECTED[tableName];
        const expectedKeys = new Set(
          expected.indexes.map((ix) => JSON.stringify(ix.keyPath)),
        );
        for (const a of live.indexes) {
          expect(expectedKeys.has(JSON.stringify(a.keyPath))).toBe(true);
        }
      });
    });
  }
});

describe("JagaOnDatabase test isolation", () => {
  it("keeps two uniquely named injected databases isolated", async () => {
    const nameA = makeUniqueName("iso-a");
    const nameB = makeUniqueName("iso-b");
    expect(nameA).not.toBe(nameB);

    const dbA = await openDatabase(nameA);
    const dbB = await openDatabase(nameB);

    // Both have the same schema but distinct names and instances.
    expect(dbA.name).toBe(nameA);
    expect(dbB.name).toBe(nameB);
    expect(dbA.name).not.toBe(dbB.name);

    // A table count equality proves both opened the full schema, while the
    // names remain distinct so no cross-test contamination is possible.
    expect(dbA.tables).toHaveLength(16);
    expect(dbB.tables).toHaveLength(16);
  });

  it("does not treat the default name as an injected test name", () => {
    const injected = makeUniqueName("injected");
    const defaultDb = createJagaOnDatabase();
    const injectedDb = createJagaOnDatabase(injected);
    expect(defaultDb.name).toBe(JAGAON_DATABASE_NAME);
    expect(injectedDb.name).toBe(injected);
    expect(injectedDb.name).not.toBe(JAGAON_DATABASE_NAME);
    openedDbs.push(defaultDb, injectedDb);
    defaultDb.close();
    injectedDb.close();
  });
});

// Sanity: confirm the module did not construct a singleton or open a database
// as a side effect of import. Importing `./database` must not create the
// default database in the underlying IndexedDB registry.
describe("import side-effect safety", () => {
  it("does not create the default database as an import side effect", async () => {
    // No test in this suite opens the default name; all use injected unique
    // names. Querying the fake registry confirms no stray "jagaon" database
    // was created purely by importing the module.
    const exists = await Dexie.exists(JAGAON_DATABASE_NAME);
    expect(exists).toBe(false);
  });
});

// Internal compile-time proof: the database class declares a property for
// every catalogue table name. This genuinely fails to compile when an
// approved JagaOnTableName is absent from JagaOnDatabase, and uses no type
// assertion that could bypass the check.
//
// When all table names are present on JagaOnDatabase, `MissingTables` is
// `never` and `TableCompleteness` resolves to `true`. When one is missing,
// `TableCompleteness` resolves to a string literal, which is not
// assignable to the `true` literal — a compile error.
type AllDBTableKeys = keyof JagaOnDatabase;
type MissingTables = Exclude<JagaOnTableName, AllDBTableKeys>;
type TableCompleteness = MissingTables extends never ? true : never;
const _CompletenessCheck: TableCompleteness = true;
void _CompletenessCheck;
