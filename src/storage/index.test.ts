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
  // Packet 4F3 exports
  CommandTransactionError,
  createAuthoritativeCommandStore,
  type CommandTransactionErrorCode,
  type PreparedDomainEvent,
  type SafetyTransactionParticipation,
  type AuthoritativeCommitPlan,
  type TerminalReceiptPlan,
  type AuthoritativeCommandPlan,
  type AuthoritativeCommandStore,
  WorkLeaseError,
  createEventWorkRepository,
  type WorkLeaseErrorCode,
  type WorkClaimRequest,
  type PlannedCommandInput,
  type WorkTransitionState,
  type EventWorkRepository,
  eventSequenceHighWaterMarkRowSchema,
  type EventSequenceHighWaterMarkRow,
  createBootstrapLocaleRepository,
  type BootstrapLocaleRepository,
  DEMO_STORAGE_RESET_CONFIRMATION,
  resetSyntheticDemoStorage,
  type SyntheticDemoStorageResetRequest,
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
  it("retains every approved Packet 4F2 runtime export", () => {
    const packet4F2Exports = [
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
    ];
    for (const exportedName of packet4F2Exports) {
      expect(exportedName in storage).toBe(true);
    }
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
    expect(IMPLEMENTED_STORAGE_ROW_TABLES).toHaveLength(8);
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

describe("storage barrel Packet 4F3 exports", () => {
  it("has the exact approved runtime export manifest", () => {
    expect(Object.keys(storage).sort()).toEqual([
      "CommandTransactionError",
      "DEMO_STORAGE_RESET_CONFIRMATION",
      "IMPLEMENTED_STORAGE_ROW_TABLES",
      "JAGAON_DATABASE_NAME",
      "JAGAON_DEXIE_VERSION",
      "JAGAON_STORES_V1",
      "JAGAON_TABLE_NAMES",
      "JagaOnDatabase",
      "StorageRowValidationError",
      "WORK_PRIORITY_RANKS",
      "WorkLeaseError",
      "appPreferenceRowSchema",
      "createAuthoritativeCommandStore",
      "createBootstrapLocaleRepository",
      "createEventWorkRepository",
      "createJagaOnDatabase",
      "createLanguagePreferenceRow",
      "createStoredEventWorkItem",
      "createStoredRecordRevisionCodec",
      "eventSequenceHighWaterMarkRowSchema",
      "implementedStorageRowCodecs",
      "resetSyntheticDemoStorage",
      "storedEventWorkItemSchema",
    ]);
    expect("eventSequenceHighWaterMarkRowCodec" in storage).toBe(false);
    expect("workTable" in storage).toBe(false);
  });

  it("exports the authoritative transaction contracts", () => {
    const errorCode: CommandTransactionErrorCode =
      "COMMAND_REPLAY_MISMATCH";
    const prepared: PreparedDomainEvent<never> | undefined = undefined;
    const safety: SafetyTransactionParticipation = { kind: "NOT_REQUIRED" };
    const commit: AuthoritativeCommitPlan<never, never, never, never, never> |
      undefined = undefined;
    const terminal: TerminalReceiptPlan | undefined = undefined;
    const plan: AuthoritativeCommandPlan<never, never, never, never, never> |
      undefined = undefined;
    const store: AuthoritativeCommandStore<
      never,
      never,
      never,
      never,
      never
    > | undefined = undefined;
    expect(errorCode).toBe("COMMAND_REPLAY_MISMATCH");
    expect(prepared).toBeUndefined();
    expect(safety.kind).toBe("NOT_REQUIRED");
    expect(commit).toBeUndefined();
    expect(terminal).toBeUndefined();
    expect(plan).toBeUndefined();
    expect(store).toBeUndefined();
    expect(CommandTransactionError).toBeTypeOf("function");
    expect(createAuthoritativeCommandStore).toBeTypeOf("function");
  });

  it("exports the durable-work repository contracts", () => {
    const errorCode: WorkLeaseErrorCode = "LEASE_EXPIRED";
    const claim: WorkClaimRequest | undefined = undefined;
    const command: PlannedCommandInput | undefined = undefined;
    const transition: WorkTransitionState | undefined = undefined;
    const repository: EventWorkRepository | undefined = undefined;
    expect(errorCode).toBe("LEASE_EXPIRED");
    expect(claim).toBeUndefined();
    expect(command).toBeUndefined();
    expect(transition).toBeUndefined();
    expect(repository).toBeUndefined();
    expect(WorkLeaseError).toBeTypeOf("function");
    expect(createEventWorkRepository).toBeTypeOf("function");
  });

  it("exports metadata, locale, and guarded demo-reset contracts", () => {
    const metadata: EventSequenceHighWaterMarkRow | undefined = undefined;
    const locale: BootstrapLocaleRepository | undefined = undefined;
    const reset: SyntheticDemoStorageResetRequest | undefined = undefined;
    expect(metadata).toBeUndefined();
    expect(locale).toBeUndefined();
    expect(reset).toBeUndefined();
    expect(eventSequenceHighWaterMarkRowSchema).toBeDefined();
    expect(createBootstrapLocaleRepository).toBeTypeOf("function");
    expect(DEMO_STORAGE_RESET_CONFIRMATION).toBe(
      "RESET_SYNTHETIC_DEMO_DATABASE",
    );
    expect(resetSyntheticDemoStorage).toBeTypeOf("function");
  });
});
