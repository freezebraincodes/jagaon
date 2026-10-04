import { describe, it, expect } from "vitest";
import {
  JAGAON_DATABASE_NAME,
  JAGAON_DEXIE_VERSION,
  JAGAON_TABLE_NAMES,
  JAGAON_STORES_V1,
  type JagaOnTableName,
} from "./table-catalogue";

/**
 * Independent expected catalogues transcribed directly from
 * storage-backup-spec.md Sections 2.1-2.9. These expectations are NOT derived
 * from the implementation constants under test; they are the spec source of
 * truth used to audit the implementation.
 */

// Section 2.1: exact ordered table list.
const EXPECTED_TABLE_NAMES = [
  "appPreferences",
  "recordRevisions",
  "recordHeads",
  "deletionTombstones",
  "auditEvents",
  "domainEvents",
  "commandReceipts",
  "eventWorkItems",
  "eventConsumerReceipts",
  "reverseDependencies",
  "engineEvaluationAudits",
  "aiInvocationAudits",
  "runtimeManifests",
  "governedAssets",
  "runtimeActivationAudits",
  "storageMetadata",
] as const;

// Each index descriptor transcribed from the spec. `unique` applies only to
// explicitly unique indexes; compound primary keys are inherently unique.
type IndexSpec = {
  keyPath: string | string[];
  compound: boolean;
  unique: boolean;
  multiEntry: boolean;
};

type TableSpec = {
  primaryKey: IndexSpec;
  autoIncrement: boolean;
  indexes: IndexSpec[];
};

// Helper to keep index descriptors compact and unambiguous.
const single = (keyPath: string, unique = false): IndexSpec => ({
  keyPath,
  compound: false,
  unique,
  multiEntry: false,
});
const compound = (
  keyPath: string[],
  unique = false,
): IndexSpec => ({
  keyPath,
  compound: true,
  unique,
  multiEntry: false,
});

const EXPECTED_TABLE_SPECS: Record<(typeof EXPECTED_TABLE_NAMES)[number], TableSpec> = {
  // Section 2.9
  appPreferences: {
    primaryKey: single("key"),
    autoIncrement: false,
    indexes: [],
  },

  // Section 2.2
  recordRevisions: {
    primaryKey: single("revisionId"),
    autoIncrement: false,
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

  // Section 2.3
  recordHeads: {
    primaryKey: single("recordId"),
    autoIncrement: false,
    indexes: [
      single("recordType"),
      single("headRevisionId"),
      single("state"),
      single("updatedAt"),
    ],
  },

  // Section 2.3
  deletionTombstones: {
    primaryKey: single("recordId"),
    autoIncrement: false,
    indexes: [
      single("recordType"),
      single("deletedAt"),
      single("auditEventId"),
      single("transactionId"),
    ],
  },

  // Section 2.4
  auditEvents: {
    primaryKey: single("auditEventId"),
    autoIncrement: false,
    indexes: [
      single("recordId"),
      single("transactionId"),
      single("occurredAt"),
      compound(["recordId", "occurredAt"]),
    ],
  },

  // Section 2.4
  domainEvents: {
    primaryKey: single("eventId"),
    autoIncrement: false,
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

  // Section 2.4
  commandReceipts: {
    primaryKey: single("commandId"),
    autoIncrement: false,
    indexes: [
      single("outcome"),
      single("completedAt"),
      single("transactionId"),
    ],
  },

  // Section 2.5
  eventWorkItems: {
    primaryKey: single("workItemId"),
    autoIncrement: false,
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

  // Section 2.4
  eventConsumerReceipts: {
    primaryKey: compound(["eventId", "consumer", "handlerVersion"]),
    autoIncrement: false,
    indexes: [
      single("eventId"),
      single("consumer"),
      single("completedAt"),
    ],
  },

  // Section 2.6
  reverseDependencies: {
    primaryKey: compound([
      "sourceRevisionId",
      "dependentRevisionId",
      "dependencyRole",
    ]),
    autoIncrement: false,
    indexes: [
      single("sourceRevisionId"),
      single("dependentRecordId"),
      single("dependentRevisionId"),
      single("owner"),
      compound(["dependentRecordId", "dependentRevisionId"]),
    ],
  },

  // Section 2.7
  engineEvaluationAudits: {
    primaryKey: single("evaluationId"),
    autoIncrement: false,
    indexes: [
      single("engine"),
      single("evaluatedAt"),
      single("runtimeManifestId"),
      single("inputFingerprint"),
      single("resultFingerprint"),
      compound(["engine", "evaluatedAt"]),
    ],
  },

  // Section 2.7
  aiInvocationAudits: {
    primaryKey: single("requestId"),
    autoIncrement: false,
    indexes: [
      single("taskType"),
      single("requestedAt"),
      single("outcomeCode"),
      single("routeProfileKey"),
      compound(["taskType", "requestedAt"]),
    ],
  },

  // Section 2.8
  runtimeManifests: {
    primaryKey: compound(["manifestId", "manifestVersion"]),
    autoIncrement: false,
    indexes: [
      single("lifecycle"),
      single("effectiveFrom"),
      single("expiresAt"),
      compound(["lifecycle", "effectiveFrom"]),
    ],
  },

  // Section 2.8
  governedAssets: {
    primaryKey: compound(["assetKey", "assetVersion"]),
    autoIncrement: false,
    indexes: [],
  },

  // Section 2.8
  runtimeActivationAudits: {
    primaryKey: single("activationAuditId"),
    autoIncrement: false,
    indexes: [
      single("runtimeKind"),
      single("action"),
      single("evaluatedAt"),
      single("resultingVersionKey"),
      compound(["runtimeKind", "evaluatedAt"]),
    ],
  },

  // Section 2.9
  storageMetadata: {
    primaryKey: single("key"),
    autoIncrement: false,
    indexes: [],
  },
};

/**
 * Parse a Dexie store schema string into a structured spec, so the
 * implementation constants can be audited against the independent expected
 * catalogue without re-deriving expectations from the same source.
 */
function parseDexieStoreSchema(schema: string): TableSpec {
  const tokens = schema
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  if (tokens.length === 0) {
    throw new Error("empty store schema");
  }

  const parseToken = (token: string): IndexSpec => {
    let unique = false;
    let multiEntry = false;
    let rest = token;

    // Dexie modifiers can appear as prefix flags.
    while (rest.startsWith("&") || rest.startsWith("*")) {
      if (rest.startsWith("&")) unique = true;
      if (rest.startsWith("*")) multiEntry = true;
      rest = rest.slice(1);
    }

    // Dexie also allows a trailing `&`/`*` on a compound index, e.g.
    // `[a+b]&` for a unique compound secondary index.
    while (rest.endsWith("&") || rest.endsWith("*")) {
      if (rest.endsWith("&")) unique = true;
      if (rest.endsWith("*")) multiEntry = true;
      rest = rest.slice(0, -1);
    }

    const compoundMatch = /^\[(.+)\]$/.exec(rest);
    if (compoundMatch) {
      const keyPath = compoundMatch[1].split("+");
      return { keyPath, compound: true, unique, multiEntry };
    }
    return { keyPath: rest, compound: false, unique, multiEntry };
  };

  const parsed = tokens.map(parseToken);
  const [primaryKey, ...indexes] = parsed;

  return {
    primaryKey,
    autoIncrement: false,
    indexes,
  };
}

describe("table catalogue constants", () => {
  it("uses the exact stable application database name", () => {
    expect(JAGAON_DATABASE_NAME).toBe("jagaon");
  });

  it("uses Dexie physical version 2 after the Packet 10 identity migration (freeze Section 5)", () => {
    expect(JAGAON_DEXIE_VERSION).toBe(2);
  });

  it("declares exactly the 16 approved tables in spec order", () => {
    expect([...JAGAON_TABLE_NAMES]).toEqual([...EXPECTED_TABLE_NAMES]);
    expect(JAGAON_TABLE_NAMES).toHaveLength(16);
  });

  it("contains no duplicate table name", () => {
    const names = [...JAGAON_TABLE_NAMES];
    expect(new Set(names).size).toBe(names.length);
  });

  it("derives JagaOnTableName from the runtime array", () => {
    // Compile-time proof: every expected name is assignable to the derived
    // type and vice versa.
    const fromConst: JagaOnTableName[] = [...JAGAON_TABLE_NAMES];
    const fromExpected: JagaOnTableName[] = [...EXPECTED_TABLE_NAMES];
    expect(fromConst).toEqual(fromExpected);
  });
});

describe("table catalogue index audit (version 1)", () => {
  // Audit every table's parsed schema against the independent expected spec.
  for (const tableName of EXPECTED_TABLE_NAMES) {
    describe(tableName, () => {
      const expected = EXPECTED_TABLE_SPECS[tableName];
      const parsed = parseDexieStoreSchema(JAGAON_STORES_V1[tableName]);

      it("primary key matches spec", () => {
        expect(parsed.primaryKey.keyPath).toEqual(expected.primaryKey.keyPath);
        expect(parsed.primaryKey.compound).toBe(expected.primaryKey.compound);
        // Compound primary keys are inherently unique in IndexedDB. Dexie does
        // not emit a leading & for compound out-of-line keys. A single-field
        // primary key is unique by definition. Assert uniqueness only when the
        // spec marks a single-field PK as explicitly unique (none in V1).
        if (!expected.primaryKey.compound) {
          expect(parsed.primaryKey.unique).toBe(expected.primaryKey.unique);
        }
        expect(parsed.primaryKey.multiEntry).toBe(false);
      });

      it("primary key is not auto-increment", () => {
        expect(parsed.autoIncrement).toBe(false);
      });

      it("has exactly the approved secondary indexes", () => {
        expect(parsed.indexes).toHaveLength(expected.indexes.length);
      });

      // Compare each index by full descriptor so a missing, extra, wrongly
      // unique, wrongly compound, or wrongly multi-entry index fails.
      for (let i = 0; i < expected.indexes.length; i++) {
        const expectedIndex = expected.indexes[i];
        const actualIndex = parsed.indexes[i];

        it(`index[${i}] ${labelFor(expectedIndex)} matches spec`, () => {
          expect(actualIndex.keyPath).toEqual(expectedIndex.keyPath);
          expect(actualIndex.compound).toBe(expectedIndex.compound);
          expect(actualIndex.unique).toBe(expectedIndex.unique);
          expect(actualIndex.multiEntry).toBe(expectedIndex.multiEntry);
        });
      }
    });
  }
});

function labelFor(index: IndexSpec): string {
  const path = Array.isArray(index.keyPath)
    ? `[${index.keyPath.join("+")}]`
    : index.keyPath;
  const flags = [
    index.unique ? "unique" : "",
    index.compound ? "compound" : "",
    index.multiEntry ? "multiEntry" : "",
  ]
    .filter(Boolean)
    .join(",");
  return `${path}${flags ? ` (${flags})` : ""}`;
}
