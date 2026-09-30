import { describe, it, expect } from "vitest";
import type { Instant } from "@/domain/shared/time";
import * as storage from "./index";
import {
  JAGAON_DATABASE_NAME,
  JAGAON_DEXIE_VERSION,
  JAGAON_TABLE_NAMES,
  JAGAON_STORES_V1,
  JagaOnDatabase,
  createJagaOnDatabase,
  type JagaOnTableName,
  // Packet 4F2A exports
  type AppPreferenceRow,
  appPreferenceRowSchema,
  createLanguagePreferenceRow,
  WORK_PRIORITY_RANKS,
  type WorkPriorityRank,
  type StoredEventWorkItem,
  storedEventWorkItemSchema,
  createStoredEventWorkItem,
  StorageRowValidationError,
  IMPLEMENTED_STORAGE_ROW_TABLES,
  implementedStorageRowCodecs,
  createStoredRecordRevisionCodec,
  type StorageRowBoundary,
  type StorageRowFailureCode,
  type StorageRowCodec,
  type ImplementedStorageRowTable,
  type ImplementedStorageRowByTable,
  type ImplementedStorageRowCodecs,
  type StoredTemporalIndexFields,
  type StoredRecordRevision,
  type StoredRecordRevisionCodec,
} from "./index";

// Compile-time fixture: confirm the approved Packet 4F1 public API is
// available from the storage barrel. If any symbol were accidentally omitted
// or aliased away, the type annotations below would fail to compile.
describe("storage barrel Packet 4F1 exports", () => {
  it("exports JAGAON_DATABASE_NAME with the exact value jagaon", () => {
    const _v: typeof JAGAON_DATABASE_NAME = "jagaon";
    expect(JAGAON_DATABASE_NAME).toBe("jagaon");
    expect(_v).toBe("jagaon");
  });

  it("exports JAGAON_DEXIE_VERSION with the exact value 1", () => {
    const _v: typeof JAGAON_DEXIE_VERSION = 1;
    expect(JAGAON_DEXIE_VERSION).toBe(1);
    expect(_v).toBe(1);
  });

  it("exports the 16-element JAGAON_TABLE_NAMES array", () => {
    expect(JAGAON_TABLE_NAMES).toHaveLength(16);
    expect(Array.isArray(JAGAON_TABLE_NAMES)).toBe(true);
  });

  it("exports the JAGAON_STORES_V1 record keyed by every table name", () => {
    const storeKeys = Object.keys(JAGAON_STORES_V1);
    expect(storeKeys).toHaveLength(16);
    for (const name of JAGAON_TABLE_NAMES) {
      expect(typeof JAGAON_STORES_V1[name]).toBe("string");
    }
  });

  it("exports the JagaOnTableName type", () => {
    const _v: JagaOnTableName = "appPreferences";
    expect(_v).toBe("appPreferences");
  });

  it("exports the JagaOnDatabase class", () => {
    expect(JagaOnDatabase).toBeTypeOf("function");
  });

  it("exports the createJagaOnDatabase factory", () => {
    expect(createJagaOnDatabase).toBeTypeOf("function");
    const db = createJagaOnDatabase("barrel-test-" + Math.random().toString(36).slice(2));
    expect(db).toBeInstanceOf(JagaOnDatabase);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Packet 4F2A barrel-manifest assertions
// ---------------------------------------------------------------------------

describe("storage barrel Packet 4F2A exports", () => {
  it("exports the AppPreferenceRow type", () => {
    const row: AppPreferenceRow = {
      key: "language",
      value: "en-SG",
      updatedAt: "2026-09-30T10:00:00Z" as Instant,
    };
    expect(row.key).toBe("language");
  });

  it("exports the appPreferenceRowSchema", () => {
    expect(appPreferenceRowSchema).toBeDefined();
    const result = appPreferenceRowSchema.safeParse({
      key: "language",
      value: "en-SG",
      updatedAt: "2026-09-30T10:00:00Z",
    });
    expect(result.success).toBe(true);
  });

  it("exports the createLanguagePreferenceRow factory", () => {
    expect(createLanguagePreferenceRow).toBeTypeOf("function");
    const row = createLanguagePreferenceRow("zh-SG", "2026-09-30T10:00:00Z" as Instant);
    expect(row.key).toBe("language");
    expect(row.value).toBe("zh-SG");
  });

  it("exports the WORK_PRIORITY_RANKS constant", () => {
    expect(WORK_PRIORITY_RANKS).toBeDefined();
    expect(Object.isFrozen(WORK_PRIORITY_RANKS)).toBe(true);
    expect(WORK_PRIORITY_RANKS.SAFETY_RECOVERY).toBe(0);
  });

  it("exports the WorkPriorityRank type", () => {
    const _v: WorkPriorityRank = 0;
    expect(_v).toBe(0);
  });

  it("exports the StoredEventWorkItem type", () => {
    const _v: StoredEventWorkItem | undefined = undefined;
    expect(_v).toBeUndefined();
  });

  it("exports the storedEventWorkItemSchema", () => {
    expect(storedEventWorkItemSchema).toBeDefined();
  });

  it("exports the createStoredEventWorkItem factory", () => {
    expect(createStoredEventWorkItem).toBeTypeOf("function");
  });
});

describe("storage barrel Packet 4F2 completion exports", () => {
  it("has the exact approved runtime export manifest", () => {
    expect(Object.keys(storage).sort()).toEqual([
      "IMPLEMENTED_STORAGE_ROW_TABLES",
      "JAGAON_DATABASE_NAME",
      "JAGAON_DEXIE_VERSION",
      "JAGAON_STORES_V1",
      "JAGAON_TABLE_NAMES",
      "JagaOnDatabase",
      "StorageRowValidationError",
      "WORK_PRIORITY_RANKS",
      "appPreferenceRowSchema",
      "createJagaOnDatabase",
      "createLanguagePreferenceRow",
      "createStoredEventWorkItem",
      "createStoredRecordRevisionCodec",
      "implementedStorageRowCodecs",
      "storedEventWorkItemSchema",
    ]);
    expect("createStorageRowCodec" in storage).toBe(false);
  });

  it("exports the bounded storage failure contracts", () => {
    const boundary: StorageRowBoundary = "READ";
    const code: StorageRowFailureCode = "STORAGE_INTEGRITY_FAILED";
    const codec: StorageRowCodec<{ value: string }> | undefined = undefined;
    expect(boundary).toBe("READ");
    expect(code).toBe("STORAGE_INTEGRITY_FAILED");
    expect(codec).toBeUndefined();
    expect(StorageRowValidationError).toBeTypeOf("function");
  });

  it("exports the exact implemented-row codec contracts", () => {
    const table: ImplementedStorageRowTable = "recordHeads";
    const rows: ImplementedStorageRowByTable | undefined = undefined;
    const codecs: ImplementedStorageRowCodecs = implementedStorageRowCodecs;
    expect(table).toBe("recordHeads");
    expect(rows).toBeUndefined();
    expect(IMPLEMENTED_STORAGE_ROW_TABLES).toHaveLength(6);
    expect(codecs.recordHeads).toBeDefined();
  });

  it("exports the schema-driven canonical revision contracts", () => {
    const temporal: StoredTemporalIndexFields = { temporalKind: "ATEMPORAL" };
    const stored: StoredRecordRevision<{ recordType: "PATIENT_PROFILE" }> |
      undefined = undefined;
    const codec: StoredRecordRevisionCodec<{
      recordType: "PATIENT_PROFILE";
    }> | undefined = undefined;
    expect(temporal.temporalKind).toBe("ATEMPORAL");
    expect(stored).toBeUndefined();
    expect(codec).toBeUndefined();
    expect(createStoredRecordRevisionCodec).toBeTypeOf("function");
  });
});
