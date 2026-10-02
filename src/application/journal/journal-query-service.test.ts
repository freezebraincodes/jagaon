import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import Dexie from "dexie";
import fakeIndexedDB, { IDBKeyRange as FDBKeyRange } from "fake-indexeddb";
import { createJagaOnDatabase, type JagaOnDatabase } from "@/storage/database";
import { createJournalCommandService } from "./journal-command-service";
import { createJournalQueryService } from "./journal-query-service";
import type { JournalCommandDependencies } from "./journal-contracts";
import type { Instant } from "@/domain/shared/time";
import type {
  RecordId,
  RevisionId,
  AuditEventId,
  TransactionId,
} from "@/domain/shared/identifiers";
import type {
  CommandId,
  CorrelationId,
  DomainEventId,
} from "@/application/contracts/command-event-identifiers";

const originalIndexedDB = Dexie.dependencies.indexedDB;
const originalIDBKeyRange = Dexie.dependencies.IDBKeyRange;

beforeAll(() => {
  Dexie.dependencies.indexedDB = fakeIndexedDB;
  Dexie.dependencies.IDBKeyRange = FDBKeyRange;
});

afterAll(() => {
  Dexie.dependencies.indexedDB = originalIndexedDB;
  Dexie.dependencies.IDBKeyRange = originalIDBKeyRange;
});

const databases: JagaOnDatabase[] = [];

afterEach(async () => {
  const names = [...new Set(databases.map((database) => database.name))];
  for (const database of databases) database.close();
  databases.length = 0;
  for (const name of names) await Dexie.delete(name);
});

async function openDatabase(name = `journal-q-${crypto.randomUUID()}`) {
  const database = createJagaOnDatabase(name);
  databases.push(database);
  await database.open();
  return database;
}

let idCounter = 0;
function makeDependencies(): JournalCommandDependencies {
  const now = () => "2026-10-02T08:00:00Z" as Instant;
  const uuid = () =>
    `00000000-0000-4000-8000-${(idCounter++).toString().padStart(12, "0")}` as any;
  return {
    now,
    ids: {
      commandId: () => uuid() as CommandId,
      correlationId: () => uuid() as CorrelationId,
      recordId: () => uuid() as RecordId,
      revisionId: () => uuid() as RevisionId,
      auditEventId: () => uuid() as AuditEventId,
      transactionId: () => uuid() as TransactionId,
      domainEventId: () => uuid() as DomainEventId,
    },
  };
}

const VALID_GLUCOSE_PAYLOAD = {
  measurement: {
    enteredValue: "7.2" as any,
    enteredUnit: "MMOL_L",
    normalization: null,
  },
  measurementMethod: "FINGERSTICK_METER",
  context: { kind: "UNSPECIFIED" },
} as any;

const VALID_GLUCOSE_TEMPORAL = {
  kind: "POINT",
  occurrence: {
    kind: "EXACT",
    instantUtc: "2026-10-02T08:00:00Z" as Instant,
    timeZoneId: "Asia/Singapore",
    utcOffsetMinutes: 480,
  },
} as any;

const VALID_INSULIN_PAYLOAD = {
  state: "TAKEN",
  medication: {
    recordType: "MEDICATION",
    recordId: "00000000-0000-4000-8000-000000000010" as any,
    revisionId: "00000000-0000-4000-8000-000000000011" as any,
  },
  amountTaken: {
    kind: "KNOWN",
    amount: { value: "10" as any, unit: "UNIT" },
  },
} as any;

const VALID_INSULIN_TEMPORAL = {
  kind: "POINT",
  occurrence: {
    kind: "EXACT",
    instantUtc: "2026-10-02T07:00:00Z" as Instant,
    timeZoneId: "Asia/Singapore",
    utcOffsetMinutes: 480,
  },
} as any;

const VALID_MEAL_PAYLOAD = {
  intakeKind: "MEAL",
  intakeSlot: { kind: "STANDARD_MEAL", code: "BREAKFAST" },
  occasion: "ROUTINE",
  foodIncluded: "YES",
  drinkIncluded: "NO",
  items: [{ kind: "FOOD", label: "Rice" }],
} as any;

const VALID_MEAL_TEMPORAL = {
  kind: "POINT",
  occurrence: {
    kind: "EXACT",
    instantUtc: "2026-10-02T09:00:00Z" as Instant,
    timeZoneId: "Asia/Singapore",
    utcOffsetMinutes: 480,
  },
} as any;

describe("journal-query-service", () => {
  it("returns empty entries when no records exist", async () => {
    const db = await openDatabase();
    const query = createJournalQueryService(db);
    const result = await query.loadToday();
    expect(result.entries).toHaveLength(0);
    expect(result.unavailable).toBe(false);
  });

  it("returns entries sorted by occurrence time descending", async () => {
    const db = await openDatabase();
    const deps = makeDependencies();
    const command = createJournalCommandService(db, deps);
    const query = createJournalQueryService(db);

    // Create three entries with different times
    await command.recordGlucose({
      payload: VALID_GLUCOSE_PAYLOAD,
      temporal: { ...VALID_GLUCOSE_TEMPORAL, occurrence: { ...VALID_GLUCOSE_TEMPORAL.occurrence, instantUtc: "2026-10-02T08:00:00Z" as Instant } },
      recordedAt: "2026-10-02T08:00:00Z" as Instant,
    });
    await command.recordInsulin({
      payload: VALID_INSULIN_PAYLOAD,
      temporal: VALID_INSULIN_TEMPORAL,
      recordedAt: "2026-10-02T07:00:00Z" as Instant,
    });
    await command.recordMeal({
      payload: VALID_MEAL_PAYLOAD,
      temporal: VALID_MEAL_TEMPORAL,
      recordedAt: "2026-10-02T09:00:00Z" as Instant,
    });

    const result = await query.loadToday();
    expect(result.entries).toHaveLength(3);
    expect(result.entries[0]!.recordType).toBe("INTAKE_EVENT");
    expect(result.entries[1]!.recordType).toBe("GLUCOSE_READING");
    expect(result.entries[2]!.recordType).toBe("MEDICATION_EVENT");
  });

  it("projects the source references needed to render recorded insulin and meal facts", async () => {
    const db = await openDatabase();
    const command = createJournalCommandService(db, makeDependencies());
    const query = createJournalQueryService(db);

    await command.recordInsulin({
      payload: VALID_INSULIN_PAYLOAD,
      temporal: VALID_INSULIN_TEMPORAL,
      recordedAt: "2026-10-02T07:00:00Z" as Instant,
    });
    await command.recordMeal({
      payload: VALID_MEAL_PAYLOAD,
      temporal: VALID_MEAL_TEMPORAL,
      recordedAt: "2026-10-02T09:00:00Z" as Instant,
    });

    const result = await query.loadToday();
    const insulin = result.entries.find(
      (entry) => entry.recordType === "MEDICATION_EVENT",
    );
    const meal = result.entries.find(
      (entry) => entry.recordType === "INTAKE_EVENT",
    );

    expect(insulin).toMatchObject({
      displayContext: VALID_INSULIN_PAYLOAD.medication.recordId,
      displayValue: "10",
      displayUnit: "UNIT",
    });
    expect(meal).toMatchObject({
      displayContext: "BREAKFAST",
      displayValue: "Rice",
    });
  });

  it("summary includes glucose value and unit", async () => {
    const db = await openDatabase();
    const deps = makeDependencies();
    const command = createJournalCommandService(db, deps);
    const query = createJournalQueryService(db);

    await command.recordGlucose({
      payload: VALID_GLUCOSE_PAYLOAD,
      temporal: VALID_GLUCOSE_TEMPORAL,
      recordedAt: "2026-10-02T08:00:00Z" as Instant,
    });

    const result = await query.loadToday();
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.summary).toContain("7.2");
    expect(result.entries[0]!.summary).toContain("mmol/L");
  });

  it("loadGlucose returns the head revision payload and temporal", async () => {
    const db = await openDatabase();
    const deps = makeDependencies();
    const command = createJournalCommandService(db, deps);
    const query = createJournalQueryService(db);

    const created = await command.recordGlucose({
      payload: VALID_GLUCOSE_PAYLOAD,
      temporal: VALID_GLUCOSE_TEMPORAL,
      recordedAt: "2026-10-02T08:00:00Z" as Instant,
    });
    expect(created.kind).toBe("COMMITTED");
    if (created.kind !== "COMMITTED") return;

    const glucose = await query.loadGlucose(created.recordId);
    expect(glucose).not.toBeNull();
    expect(glucose!.recordId).toBe(created.recordId);
    expect(glucose!.revisionNumber).toBe(1);
    expect(glucose!.payload.measurement.enteredValue).toBe("7.2" as any);
  });

  it("loadGlucose returns null for a non-existent record", async () => {
    const db = await openDatabase();
    const query = createJournalQueryService(db);
    const result = await query.loadGlucose(
      "00000000-0000-4000-8000-000000000099" as any,
    );
    expect(result).toBeNull();
  });

  it("loadGlucose returns null for a non-glucose record", async () => {
    const db = await openDatabase();
    const deps = makeDependencies();
    const command = createJournalCommandService(db, deps);
    const query = createJournalQueryService(db);

    const created = await command.recordInsulin({
      payload: VALID_INSULIN_PAYLOAD,
      temporal: VALID_INSULIN_TEMPORAL,
      recordedAt: "2026-10-02T07:00:00Z" as Instant,
    });
    expect(created.kind).toBe("COMMITTED");
    if (created.kind !== "COMMITTED") return;

    const result = await query.loadGlucose(created.recordId);
    expect(result).toBeNull();
  });

  it("does not leak SAFETY_EVENT rows into Today", async () => {
    const db = await openDatabase();
    const query = createJournalQueryService(db);
    const result = await query.loadToday();
    expect(result.entries.every((e) => e.recordType !== ("SAFETY_EVENT" as never))).toBe(true);
  });

  it("returns unavailable when the database is closed", async () => {
    const db = await openDatabase();
    const query = createJournalQueryService(db);
    db.close();
    const result = await query.loadToday();
    expect(result.unavailable).toBe(true);
    expect(result.entries).toHaveLength(0);
  });

  it("fails the whole Today read closed when an active head points to a malformed revision", async () => {
    const db = await openDatabase();
    const recordId = "00000000-0000-4000-8000-000000000091";
    const revisionId = "00000000-0000-4000-8000-000000000092";

    await db.table("recordHeads").add({
      recordId,
      recordType: "GLUCOSE_READING",
      headRevisionId: revisionId,
      headRevisionNumber: 1,
      state: "ACTIVE",
      updatedAt: "2026-10-02T08:00:00Z",
    } as never);
    await db.table("recordRevisions").add({
      revisionId,
      recordId,
      recordType: "GLUCOSE_READING",
      revisionNumber: 1,
      malformed: true,
    } as never);

    const result = await createJournalQueryService(db).loadToday();

    expect(result).toEqual({ entries: [], unavailable: true });
  });
});
