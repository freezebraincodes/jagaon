import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import Dexie from "dexie";
import fakeIndexedDB, { IDBKeyRange as FDBKeyRange } from "fake-indexeddb";
import { createJagaOnDatabase, type JagaOnDatabase } from "@/storage/database";
import {
  createJournalCommandService,
} from "./journal-command-service";
import type {
  JournalCommandDependencies,
  JournalCommitResult,
} from "./journal-contracts";
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
import type { GlucoseReadingPayload } from "@/domain/health-records/glucose-reading";
import type { ReadingTemporal } from "@/domain/health-records/reading-temporal";
import type { MedicationEventPayload } from "@/domain/health-records/medication-event";
import type { MedicationEventTemporal } from "@/domain/health-records/medication-event";
import type { IntakeEventPayload } from "@/domain/health-records/intake-event";
import type { IntakeTemporal } from "@/domain/health-records/observation-temporal";

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

async function openDatabase(name = `journal-${crypto.randomUUID()}`) {
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

const VALID_GLUCOSE_PAYLOAD: GlucoseReadingPayload = {
  measurement: {
    enteredValue: "7.2" as any,
    enteredUnit: "MMOL_L",
    normalization: null,
  },
  measurementMethod: "FINGERSTICK_METER",
  context: { kind: "UNSPECIFIED" },
} as any;

const VALID_GLUCOSE_TEMPORAL: ReadingTemporal = {
  kind: "POINT",
  occurrence: {
    kind: "EXACT",
    instantUtc: "2026-10-02T08:00:00Z" as Instant,
    timeZoneId: "Asia/Singapore",
    utcOffsetMinutes: 480,
  },
} as any;

const VALID_INSULIN_PAYLOAD: MedicationEventPayload = {
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

const VALID_INSULIN_TEMPORAL: MedicationEventTemporal = {
  kind: "POINT",
  occurrence: {
    kind: "EXACT",
    instantUtc: "2026-10-02T08:00:00Z" as Instant,
    timeZoneId: "Asia/Singapore",
    utcOffsetMinutes: 480,
  },
} as any;

const VALID_MEAL_PAYLOAD: IntakeEventPayload = {
  intakeKind: "MEAL",
  intakeSlot: { kind: "STANDARD_MEAL", code: "BREAKFAST" },
  occasion: "ROUTINE",
  foodIncluded: "YES",
  drinkIncluded: "NO",
  items: [{ kind: "FOOD", label: "Rice" }],
} as any;

const VALID_MEAL_TEMPORAL: IntakeTemporal = {
  kind: "POINT",
  occurrence: {
    kind: "EXACT",
    instantUtc: "2026-10-02T08:00:00Z" as Instant,
    timeZoneId: "Asia/Singapore",
    utcOffsetMinutes: 480,
  },
} as any;

describe("journal-command-service", () => {
  it("records a glucose reading atomically (revision, head, audit, event, receipt)", async () => {
    const db = await openDatabase();
    const deps = makeDependencies();
    const service = createJournalCommandService(db, deps);

    const result = await service.recordGlucose({
      payload: VALID_GLUCOSE_PAYLOAD,
      temporal: VALID_GLUCOSE_TEMPORAL,
      recordedAt: "2026-10-02T08:00:00Z" as Instant,
    });

    expect(result.kind).toBe("COMMITTED");
    if (result.kind !== "COMMITTED") return;
    expect(result.recordId).toBeDefined();
    expect(result.revisionId).toBeDefined();

    // Verify rows exist in the database
    const heads = await db.table("recordHeads").toArray();
    expect(heads).toHaveLength(1);
    expect(heads[0]!.state).toBe("ACTIVE");
    expect(heads[0]!.recordType).toBe("GLUCOSE_READING");

    const revisions = await db.table("recordRevisions").toArray();
    expect(revisions).toHaveLength(1);
    expect(revisions[0]!.action).toBe("CREATE");
    expect(revisions[0]!.revisionNumber).toBe(1);

    const audits = await db.table("auditEvents").toArray();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.action).toBe("CREATE");

    const events = await db.table("domainEvents").toArray();
    expect(events).toHaveLength(1);
    expect(events[0]!.eventName).toBe("GLUCOSE_READING_RECORDED");

    const receipts = await db.table("commandReceipts").toArray();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.outcome).toBe("COMMITTED");
  });

  it("corrects glucose time with CORRECT action, MUST_MATCH, revision +1", async () => {
    const db = await openDatabase();
    const deps = makeDependencies();
    const service = createJournalCommandService(db, deps);

    // First create
    const first = await service.recordGlucose({
      payload: VALID_GLUCOSE_PAYLOAD,
      temporal: VALID_GLUCOSE_TEMPORAL,
      recordedAt: "2026-10-02T08:00:00Z" as Instant,
    });
    expect(first.kind).toBe("COMMITTED");
    if (first.kind !== "COMMITTED") return;

    // Correct
    const second = await service.correctGlucoseTime({
      recordId: first.recordId,
      expectedRevisionId: first.revisionId,
      expectedRevisionNumber: 1,
      payload: VALID_GLUCOSE_PAYLOAD,
      temporal: VALID_GLUCOSE_TEMPORAL,
      recordedAt: "2026-10-02T08:00:00Z" as Instant,
    });

    expect(second.kind).toBe("COMMITTED");
    if (second.kind !== "COMMITTED") return;

    const revisions = await db.table("recordRevisions").toArray();
    expect(revisions).toHaveLength(2);
    expect(revisions[1]!.action).toBe("CORRECT");
    expect(revisions[1]!.revisionNumber).toBe(2);

    const events = await db.table("domainEvents").toArray();
    expect(events).toHaveLength(2);
    expect(events[1]!.eventName).toBe("GLUCOSE_READING_CORRECTED");

    const heads = await db.table("recordHeads").toArray();
    expect(heads[0]!.headRevisionNumber).toBe(2);
  });

  it("returns HEAD_CONFLICT when correcting with a stale head", async () => {
    const db = await openDatabase();
    const deps = makeDependencies();
    const service = createJournalCommandService(db, deps);

    // First create
    const first = await service.recordGlucose({
      payload: VALID_GLUCOSE_PAYLOAD,
      temporal: VALID_GLUCOSE_TEMPORAL,
      recordedAt: "2026-10-02T08:00:00Z" as Instant,
    });
    expect(first.kind).toBe("COMMITTED");

    // Correct with wrong revision number
    const second = await service.correctGlucoseTime({
      recordId: first.kind === "COMMITTED" ? first.recordId : ("00000000-0000-4000-8000-000000000099" as any),
      expectedRevisionId: first.kind === "COMMITTED" ? first.revisionId : ("00000000-0000-4000-8000-000000000098" as any),
      expectedRevisionNumber: 99, // wrong
      payload: VALID_GLUCOSE_PAYLOAD,
      temporal: VALID_GLUCOSE_TEMPORAL,
      recordedAt: "2026-10-02T08:00:00Z" as Instant,
    });

    expect(second.kind).toBe("REJECTED");
    if (second.kind !== "REJECTED") return;
    expect(second.code).toBe("HEAD_CONFLICT");
  });

  it("records an insulin (medication event) atomically", async () => {
    const db = await openDatabase();
    const deps = makeDependencies();
    const service = createJournalCommandService(db, deps);

    const result = await service.recordInsulin({
      payload: VALID_INSULIN_PAYLOAD,
      temporal: VALID_INSULIN_TEMPORAL,
      recordedAt: "2026-10-02T08:00:00Z" as Instant,
    });

    expect(result.kind).toBe("COMMITTED");

    const heads = await db.table("recordHeads").toArray();
    expect(heads[0]!.recordType).toBe("MEDICATION_EVENT");

    const events = await db.table("domainEvents").toArray();
    expect(events[0]!.eventName).toBe("MEDICATION_EVENT_RECORDED");
  });

  it("records a meal (intake event) atomically", async () => {
    const db = await openDatabase();
    const deps = makeDependencies();
    const service = createJournalCommandService(db, deps);

    const result = await service.recordMeal({
      payload: VALID_MEAL_PAYLOAD,
      temporal: VALID_MEAL_TEMPORAL,
      recordedAt: "2026-10-02T08:00:00Z" as Instant,
    });

    expect(result.kind).toBe("COMMITTED");

    const heads = await db.table("recordHeads").toArray();
    expect(heads[0]!.recordType).toBe("INTAKE_EVENT");

    const events = await db.table("domainEvents").toArray();
    expect(events[0]!.eventName).toBe("INTAKE_EVENT_RECORDED");
  });

  it("returns VALIDATION_FAILED for an invalid glucose payload", async () => {
    const db = await openDatabase();
    const deps = makeDependencies();
    const service = createJournalCommandService(db, deps);

    const result = await service.recordGlucose({
      payload: { ...VALID_GLUCOSE_PAYLOAD, measurement: "invalid" } as any,
      temporal: VALID_GLUCOSE_TEMPORAL,
      recordedAt: "2026-10-02T08:00:00Z" as Instant,
    });

    expect(result.kind).toBe("FAILED");
    if (result.kind !== "FAILED") return;
    expect(result.code).toBe("VALIDATION_FAILED");
  });

  it("safety is always NOT_REQUIRED on every plan", async () => {
    const db = await openDatabase();
    const deps = makeDependencies();
    const service = createJournalCommandService(db, deps);

    // The safety check is internal. We verify indirectly: no SAFETY_EVENT
    // rows appear in any table after any mutation.
    await service.recordGlucose({
      payload: VALID_GLUCOSE_PAYLOAD,
      temporal: VALID_GLUCOSE_TEMPORAL,
      recordedAt: "2026-10-02T08:00:00Z" as Instant,
    });

    const heads = await db.table("recordHeads").toArray();
    const safetyHeads = heads.filter((h) => h.recordType === "SAFETY_EVENT");
    expect(safetyHeads).toHaveLength(0);

    const revisions = await db.table("recordRevisions").toArray();
    expect(revisions.every((r) => r.recordType !== "SAFETY_EVENT")).toBe(true);
  });

  it("reverse dependencies and evaluation audits are always empty", async () => {
    const db = await openDatabase();
    const deps = makeDependencies();
    const service = createJournalCommandService(db, deps);

    await service.recordGlucose({
      payload: VALID_GLUCOSE_PAYLOAD,
      temporal: VALID_GLUCOSE_TEMPORAL,
      recordedAt: "2026-10-02T08:00:00Z" as Instant,
    });

    const deps2 = await db.table("reverseDependencies").toArray();
    expect(deps2).toHaveLength(0);

    const evals = await db.table("engineEvaluationAudits").toArray();
    expect(evals).toHaveLength(0);
  });
});

describe("Packet 7A subscription work and activity recording", () => {
  async function consumersFor(db: JagaOnDatabase) {
    const items = (await db.table("eventWorkItems").toArray()) as Array<{ consumer: string; handlerVersion: string }>;
    return items.map((item) => `${item.consumer}@${item.handlerVersion}`).sort();
  }

  it("creates comparable-slot Pattern work in the same transaction as a glucose reading", async () => {
    const db = await openDatabase();
    const service = createJournalCommandService(db, makeDependencies());
    const result = await service.recordGlucose({
      payload: VALID_GLUCOSE_PAYLOAD,
      temporal: VALID_GLUCOSE_TEMPORAL,
      recordedAt: "2026-10-02T08:00:00Z" as Instant,
    });
    expect(result.kind).toBe("COMMITTED");
    expect(await consumersFor(db)).toEqual(["PATTERN_REEVALUATION@pattern-reevaluation.7a.1"]);
  });

  it("creates Pattern and Learning work for a meal and none for a medicine event", async () => {
    const db = await openDatabase();
    const service = createJournalCommandService(db, makeDependencies());
    await service.recordMeal({ payload: VALID_MEAL_PAYLOAD, temporal: VALID_MEAL_TEMPORAL, recordedAt: "2026-10-02T08:00:00Z" as Instant });
    expect(await consumersFor(db)).toEqual([
      "LEARNING_REEVALUATION@learning-reevaluation.7a.1",
      "PATTERN_REEVALUATION@pattern-reevaluation.7a.1",
    ]);
    const second = await openDatabase();
    await createJournalCommandService(second, makeDependencies()).recordInsulin({
      payload: VALID_INSULIN_PAYLOAD,
      temporal: VALID_INSULIN_TEMPORAL,
      recordedAt: "2026-10-02T08:00:00Z" as Instant,
    });
    expect(await consumersFor(second)).toEqual([]);
  });

  it("records an activity through the authoritative transaction", async () => {
    const db = await openDatabase();
    const service = createJournalCommandService(db, makeDependencies());
    const result = await service.recordActivity({
      payload: { activityCategory: "WALKING", patientLabel: "Morning walk", reportedDurationMinutes: 28 },
      temporal: VALID_GLUCOSE_TEMPORAL as never,
      recordedAt: "2026-10-02T08:00:00Z" as Instant,
    });
    expect(result.kind).toBe("COMMITTED");
    const events = (await db.table("domainEvents").toArray()) as Array<{ eventName: string }>;
    expect(events.map((event) => event.eventName)).toEqual(["ACTIVITY_EVENT_RECORDED"]);
    expect(await consumersFor(db)).toEqual([
      "LEARNING_REEVALUATION@learning-reevaluation.7a.1",
      "PATTERN_REEVALUATION@pattern-reevaluation.7a.1",
    ]);
  });

  it("rejects an invalid activity without writing", async () => {
    const db = await openDatabase();
    const service = createJournalCommandService(db, makeDependencies());
    const result = await service.recordActivity({
      payload: { activityCategory: "WALKING", patientLabel: "" } as never,
      temporal: VALID_GLUCOSE_TEMPORAL as never,
      recordedAt: "2026-10-02T08:00:00Z" as Instant,
    });
    expect(result).toEqual({ kind: "FAILED", code: "VALIDATION_FAILED" });
    expect(await db.table("recordRevisions").count()).toBe(0);
  });
});
