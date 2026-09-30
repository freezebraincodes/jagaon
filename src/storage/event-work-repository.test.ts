import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import Dexie from "dexie";
import fakeIndexedDB, { IDBKeyRange as FDBKeyRange } from "fake-indexeddb";
import {
  commandIdSchema,
  domainEventIdSchema,
  eventSequenceSchema,
} from "@/application/contracts/command-event-identifiers";
import {
  type EventWorkItem,
  type WorkPriority,
  workItemIdSchema,
} from "@/application/contracts/event-work";
import type { EventConsumerReceipt } from "@/application/contracts/event-consumer-receipt";
import { instantSchema, type Instant } from "@/domain/shared/time";
import { createJagaOnDatabase, type JagaOnDatabase } from "./database";
import {
  createStoredEventWorkItem,
  type StoredEventWorkItem,
} from "./stored-event-work-item";
import {
  createEventWorkRepository,
  WorkLeaseError,
} from "./event-work-repository";

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

async function openDatabase(name = `work-${crypto.randomUUID()}`) {
  const database = createJagaOnDatabase(name);
  databases.push(database);
  await database.open();
  return database;
}

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
}

function at(value: string): Instant {
  return instantSchema.parse(value);
}

const now = at("2026-09-30T12:00:00Z");
const later = at("2026-09-30T12:05:00Z");
const muchLater = at("2026-09-30T13:00:00Z");
const earlier = at("2026-09-30T11:55:00Z");

function storedWork(options: {
  id: number;
  priority?: WorkPriority;
  createdAt?: Instant;
  sequence?: number;
  state?: EventWorkItem["state"];
  attemptCount?: number;
  handlerVersion?: string;
}): StoredEventWorkItem {
  const item: EventWorkItem = {
    workItemId: workItemIdSchema.parse(uuid(options.id)),
    eventId: domainEventIdSchema.parse(uuid(1_000 + options.id)),
    consumer: "MAINTENANCE",
    handlerVersion: options.handlerVersion ?? "1",
    priority: options.priority ?? "ORDINARY_INTELLIGENCE",
    createdAt: options.createdAt ?? earlier,
    attemptCount: options.attemptCount ?? 0,
    state: options.state ?? { state: "PENDING" },
    plannedCommands: [],
  };
  return createStoredEventWorkItem(
    item,
    eventSequenceSchema.parse(options.sequence ?? options.id),
  );
}

async function addWork(
  database: JagaOnDatabase,
  ...rows: StoredEventWorkItem[]
) {
  await database.table<StoredEventWorkItem>("eventWorkItems").bulkAdd(rows);
}

function claimRequest(overrides: Partial<{
  now: Instant;
  leaseExpiresAt: Instant;
  leaseToken: string;
  claimedByInstance: string;
}> = {}) {
  return {
    now,
    leaseExpiresAt: later,
    leaseToken: "lease-token-1",
    claimedByInstance: "worker-1",
    ...overrides,
  };
}

function receiptFor(row: StoredEventWorkItem): EventConsumerReceipt {
  return {
    eventId: row.eventId,
    consumer: row.consumer,
    handlerVersion: row.handlerVersion,
    completedAt: now,
    outcome: { kind: "NO_ACTION_REQUIRED" },
  };
}

describe("event work selection", () => {
  it("claims all five priorities in stable rank order", async () => {
    const database = await openDatabase();
    const repository = createEventWorkRepository(database);
    await addWork(
      database,
      storedWork({ id: 5, priority: "MAINTENANCE" }),
      storedWork({ id: 3, priority: "PATIENT_VISIBLE_CURRENT_STATE" }),
      storedWork({ id: 1, priority: "SAFETY_RECOVERY" }),
      storedWork({ id: 4, priority: "ORDINARY_INTELLIGENCE" }),
      storedWork({ id: 2, priority: "DEPENDENCY_INVALIDATION" }),
    );

    const claimed: WorkPriority[] = [];
    for (let i = 0; i < 5; i++) {
      const row = await repository.claimNext(
        claimRequest({
          leaseToken: `lease-${i}`,
          claimedByInstance: `worker-${i}`,
        }),
      );
      expect(row).not.toBeNull();
      claimed.push(row!.priority);
    }

    expect(claimed).toEqual([
      "SAFETY_RECOVERY",
      "DEPENDENCY_INVALIDATION",
      "PATIENT_VISIBLE_CURRENT_STATE",
      "ORDINARY_INTELLIGENCE",
      "MAINTENANCE",
    ]);
  });

  it("filters future retry work and returns null when nothing is due", async () => {
    const database = await openDatabase();
    const repository = createEventWorkRepository(database);
    await addWork(
      database,
      storedWork({
        id: 1,
        state: {
          state: "RETRY_WAIT",
          availableAt: muchLater,
          errorCode: "TRANSIENT_STORAGE_ERROR",
        },
      }),
    );

    await expect(repository.claimNext(claimRequest())).resolves.toBeNull();
  });

  it("uses source sequence and workItemId as deterministic tie breakers", async () => {
    const database = await openDatabase();
    const repository = createEventWorkRepository(database);
    await addWork(
      database,
      storedWork({ id: 3, sequence: 2 }),
      storedWork({ id: 2, sequence: 1 }),
      storedWork({ id: 1, sequence: 1 }),
    );

    const first = await repository.claimNext(claimRequest());
    expect(first?.workItemId).toBe(uuid(1));
  });
});

describe("event work leases", () => {
  it("requires lease expiry to be strictly later than the caller supplied now", async () => {
    const database = await openDatabase();
    const repository = createEventWorkRepository(database);

    await expect(
      repository.claimNext(claimRequest({ leaseExpiresAt: now })),
    ).rejects.toMatchObject({
      name: "WorkLeaseError",
      code: "INVALID_LEASE_REQUEST",
    });
  });

  it("does not steal a live lease", async () => {
    const database = await openDatabase();
    const repository = createEventWorkRepository(database);
    await addWork(
      database,
      storedWork({
        id: 1,
        state: {
          state: "CLAIMED",
          leaseToken: "existing-token",
          claimedByInstance: "existing-worker",
          leaseExpiresAt: muchLater,
        },
        attemptCount: 1,
      }),
    );

    await expect(repository.claimNext(claimRequest())).resolves.toBeNull();
  });

  it("reclaims an expired lease and increments the attempt count", async () => {
    const database = await openDatabase();
    const repository = createEventWorkRepository(database);
    await addWork(
      database,
      storedWork({
        id: 1,
        state: {
          state: "CLAIMED",
          leaseToken: "expired-token",
          claimedByInstance: "old-worker",
          leaseExpiresAt: earlier,
        },
        attemptCount: 2,
      }),
    );

    const claimed = await repository.claimNext(claimRequest());
    expect(claimed).toMatchObject({
      attemptCount: 3,
      state: {
        state: "CLAIMED",
        leaseToken: "lease-token-1",
        claimedByInstance: "worker-1",
        leaseExpiresAt: later,
      },
    });
  });

  it("rejects planning with the wrong lease token", async () => {
    const database = await openDatabase();
    const repository = createEventWorkRepository(database);
    await addWork(database, storedWork({ id: 1 }));
    const claimed = await repository.claimNext(claimRequest());

    await expect(
      repository.persistPlannedCommands({
        workItemId: claimed!.workItemId,
        leaseToken: "wrong-token",
        now,
        plannedCommands: [],
      }),
    ).rejects.toBeInstanceOf(WorkLeaseError);
  });

  it("persists validated planned commands for the lease owner", async () => {
    const database = await openDatabase();
    const repository = createEventWorkRepository(database);
    await addWork(database, storedWork({ id: 1 }));
    const claimed = await repository.claimNext(claimRequest());
    const commandId = commandIdSchema.parse(uuid(8_001));

    const planned = await repository.persistPlannedCommands({
      workItemId: claimed!.workItemId,
      leaseToken: "lease-token-1",
      now,
      plannedCommands: [{ effectKey: "effect-1", commandId }],
    });

    expect(planned.plannedCommands).toEqual([
      { effectKey: "effect-1", commandId },
    ]);
  });

  it("rejects unknown request keys at work mutation boundaries", async () => {
    const database = await openDatabase();
    const repository = createEventWorkRepository(database);
    await addWork(database, storedWork({ id: 1 }));
    const claimed = await repository.claimNext(claimRequest());

    await expect(
      repository.persistPlannedCommands({
        workItemId: claimed!.workItemId,
        leaseToken: "lease-token-1",
        now,
        plannedCommands: [],
        extra: true,
      } as Parameters<typeof repository.persistPlannedCommands>[0]),
    ).rejects.toMatchObject({ code: "INVALID_LEASE_REQUEST" });
  });
});

describe("event work completion and receipt idempotency", () => {
  it("stores the receipt and COMPLETED work state atomically", async () => {
    const database = await openDatabase();
    const repository = createEventWorkRepository(database);
    await addWork(database, storedWork({ id: 1 }));
    const claimed = await repository.claimNext(claimRequest());
    const receipt = receiptFor(claimed!);

    const completed = await repository.complete({
      workItemId: claimed!.workItemId,
      leaseToken: "lease-token-1",
      now,
      receipt,
    });

    expect(completed.state).toEqual({ state: "COMPLETED", completedAt: now });
    await expect(
      database
        .table<EventConsumerReceipt>("eventConsumerReceipts")
        .get([receipt.eventId, receipt.consumer, receipt.handlerVersion]),
    ).resolves.toEqual(receipt);
  });

  it("rolls back the work update when receipt persistence fails", async () => {
    const database = await openDatabase();
    const repository = createEventWorkRepository(database);
    await addWork(database, storedWork({ id: 1 }));
    const claimed = await repository.claimNext(claimRequest());
    const receipts = database.table<EventConsumerReceipt>(
      "eventConsumerReceipts",
    );
    receipts.hook("creating", () => {
      throw new Error("injected failure");
    });

    await expect(
      repository.complete({
        workItemId: claimed!.workItemId,
        leaseToken: "lease-token-1",
        now,
        receipt: receiptFor(claimed!),
      }),
    ).rejects.toThrow();

    const stored = await database
      .table<StoredEventWorkItem>("eventWorkItems")
      .get(claimed!.workItemId);
    expect(stored?.state.state).toBe("CLAIMED");
  });

  it("recovers receipt-before-work-update without repeating the effect", async () => {
    const database = await openDatabase();
    const repository = createEventWorkRepository(database);
    const work = storedWork({ id: 1 });
    await addWork(database, work);
    const receipt = receiptFor(work);
    await database
      .table<EventConsumerReceipt>("eventConsumerReceipts")
      .add(receipt);

    await expect(repository.claimNext(claimRequest())).resolves.toBeNull();
    const reconciled = await database
      .table<StoredEventWorkItem>("eventWorkItems")
      .get(work.workItemId);
    expect(reconciled?.state).toEqual({
      state: "COMPLETED",
      completedAt: receipt.completedAt,
    });
    expect(reconciled?.attemptCount).toBe(0);
  });

  it("does not let a wrong lease owner reconcile an existing receipt", async () => {
    const database = await openDatabase();
    const repository = createEventWorkRepository(database);
    await addWork(database, storedWork({ id: 1 }));
    const claimed = await repository.claimNext(claimRequest());
    const receipt = receiptFor(claimed!);
    await database
      .table<EventConsumerReceipt>("eventConsumerReceipts")
      .add(receipt);

    await expect(
      repository.complete({
        workItemId: claimed!.workItemId,
        leaseToken: "wrong-token",
        now,
        receipt,
      }),
    ).rejects.toMatchObject({ code: "LEASE_NOT_OWNED" });
  });

  it("converges two completion attempts on one durable receipt", async () => {
    const name = `work-race-${crypto.randomUUID()}`;
    const databaseA = await openDatabase(name);
    const databaseB = await openDatabase(name);
    const repositoryA = createEventWorkRepository(databaseA);
    const repositoryB = createEventWorkRepository(databaseB);
    await addWork(databaseA, storedWork({ id: 1 }));
    const claimed = await repositoryA.claimNext(claimRequest());
    const request = {
      workItemId: claimed!.workItemId,
      leaseToken: "lease-token-1",
      now,
      receipt: receiptFor(claimed!),
    };

    const results = await Promise.all([
      repositoryA.complete(request),
      repositoryB.complete(request),
    ]);
    expect(results.every((row) => row.state.state === "COMPLETED")).toBe(true);
    await expect(
      databaseA.table("eventConsumerReceipts").count(),
    ).resolves.toBe(1);
  });
});

describe("event work terminal transitions", () => {
  async function claimedRepository() {
    const database = await openDatabase();
    const repository = createEventWorkRepository(database);
    await addWork(database, storedWork({ id: 1 }));
    const claimed = await repository.claimNext(claimRequest());
    return { repository, claimed: claimed! };
  }

  it("moves an owned lease to caller-governed retry wait", async () => {
    const { repository, claimed } = await claimedRepository();
    const row = await repository.transition({
      workItemId: claimed.workItemId,
      leaseToken: "lease-token-1",
      now,
      state: {
        state: "RETRY_WAIT",
        availableAt: muchLater,
        errorCode: "TRANSIENT_STORAGE_ERROR",
      },
    });
    expect(row.state).toEqual({
      state: "RETRY_WAIT",
      availableAt: muchLater,
      errorCode: "TRANSIENT_STORAGE_ERROR",
    });
    expect(row.availableAt).toBe(muchLater);
  });

  it("moves an owned lease to terminal failure", async () => {
    const { repository, claimed } = await claimedRepository();
    const row = await repository.transition({
      workItemId: claimed.workItemId,
      leaseToken: "lease-token-1",
      now,
      state: {
        state: "TERMINAL_FAILURE",
        failedAt: now,
        errorCode: "INTEGRITY_CHECK_FAILED",
      },
    });
    expect(row.state.state).toBe("TERMINAL_FAILURE");
  });

  it("moves an owned lease to cancelled-obsolete", async () => {
    const { repository, claimed } = await claimedRepository();
    const row = await repository.transition({
      workItemId: claimed.workItemId,
      leaseToken: "lease-token-1",
      now,
      state: {
        state: "CANCELLED_OBSOLETE",
        cancelledAt: now,
        reasonCode: "SOURCE_SUPERSEDED",
      },
    });
    expect(row.state.state).toBe("CANCELLED_OBSOLETE");
  });
});
