import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import Dexie from "dexie";
import fakeIndexedDB, { IDBKeyRange as FDBKeyRange } from "fake-indexeddb";
import { z } from "zod";
import {
  auditEventIdSchema,
  recordHeadSchema,
  recordIdSchema,
  revisionIdSchema,
  transactionIdSchema,
  type RecordHead,
} from "@/domain/shared";
import { instantSchema } from "@/domain/shared/time";
import {
  commandIdSchema,
  correlationIdSchema,
  domainEventIdSchema,
  eventSequenceSchema,
} from "@/application/contracts/command-event-identifiers";
import { workItemIdSchema } from "@/application/contracts/event-work";
import { sha256DigestSchema } from "@/application/contracts/canonical-json";
import { commandReceiptSchema } from "@/application/contracts/command-receipt";
import { eventRecordChangeSchema } from "@/application/contracts/domain-event-envelope";
import { createJagaOnDatabase, type JagaOnDatabase } from "./database";
import { createStorageRowCodec } from "./storage-row-codec";
import type { StoredEventWorkItem } from "./stored-event-work-item";
import {
  CommandTransactionError,
  createAuthoritativeCommandStore,
} from "./authoritative-command-transaction";

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

async function openDatabase(name = `transaction-${crypto.randomUUID()}`) {
  const database = createJagaOnDatabase(name);
  databases.push(database);
  await database.open();
  return database;
}

const positiveSafeInteger = z.number().int().positive().safe();
const nonNegativeSafeInteger = z.number().int().nonnegative().safe();

const testRevisionRowSchema = z
  .object({
    revisionId: revisionIdSchema,
    recordId: recordIdSchema,
    recordType: z.literal("PATIENT_PROFILE"),
    revisionNumber: positiveSafeInteger,
    previousRevisionId: revisionIdSchema.nullable(),
    transactionId: transactionIdSchema,
    auditEventId: auditEventIdSchema,
    payload: z.object({ displayName: z.string().min(1) }).strict(),
  })
  .strict();

const testAuditRowSchema = z
  .object({
    auditEventId: auditEventIdSchema,
    transactionId: transactionIdSchema,
    recordId: recordIdSchema,
    occurredAt: instantSchema,
    reasonCode: z.literal("TEST_REASON"),
  })
  .strict();

const testEventRowSchema = z
  .object({
    eventId: domainEventIdSchema,
    eventName: z.literal("PATIENT_PROFILE_RECORDED"),
    localSequence: eventSequenceSchema,
    transactionIndex: nonNegativeSafeInteger,
    transactionId: transactionIdSchema,
    commandId: commandIdSchema,
    correlationId: correlationIdSchema,
    committedAt: instantSchema,
    change: eventRecordChangeSchema,
    payload: z.object({ revisionId: revisionIdSchema }).strict(),
  })
  .strict();

const testReverseDependencyRowSchema = z
  .object({
    sourceRevisionId: revisionIdSchema,
    dependentRevisionId: revisionIdSchema,
    dependencyRole: z.string().min(1),
  })
  .strict();

const testEvaluationAuditRowSchema = z
  .object({
    evaluationId: z.string().uuid(),
    evaluatedAt: instantSchema,
    resultFingerprint: z.string().min(1),
  })
  .strict();

type TestRevisionRow = z.infer<typeof testRevisionRowSchema>;
type TestAuditRow = z.infer<typeof testAuditRowSchema>;
type TestEventRow = z.infer<typeof testEventRowSchema>;
type TestReverseDependencyRow = z.infer<
  typeof testReverseDependencyRowSchema
>;
type TestEvaluationAuditRow = z.infer<typeof testEvaluationAuditRowSchema>;

const codecs = {
  revisionCodec: createStorageRowCodec<TestRevisionRow>(
    "recordRevisions",
    testRevisionRowSchema,
  ),
  auditCodec: createStorageRowCodec<TestAuditRow>(
    "auditEvents",
    testAuditRowSchema,
  ),
  eventCodec: createStorageRowCodec<TestEventRow>(
    "domainEvents",
    testEventRowSchema,
  ),
  reverseDependencyCodec: createStorageRowCodec<TestReverseDependencyRow>(
    "reverseDependencies",
    testReverseDependencyRowSchema,
  ),
  evaluationAuditCodec: createStorageRowCodec<TestEvaluationAuditRow>(
    "engineEvaluationAudits",
    testEvaluationAuditRowSchema,
  ),
};

const commandId = commandIdSchema.parse(
  "00000000-0000-4000-8000-000000000001",
);
const secondCommandId = commandIdSchema.parse(
  "00000000-0000-4000-8000-000000000002",
);
const correlationId = correlationIdSchema.parse(
  "00000000-0000-4000-8000-000000000003",
);
const transactionId = transactionIdSchema.parse(
  "00000000-0000-4000-8000-000000000004",
);
const recordId = recordIdSchema.parse(
  "00000000-0000-4000-8000-000000000005",
);
const revisionId = revisionIdSchema.parse(
  "00000000-0000-4000-8000-000000000006",
);
const auditEventId = auditEventIdSchema.parse(
  "00000000-0000-4000-8000-000000000007",
);
const eventId = domainEventIdSchema.parse(
  "00000000-0000-4000-8000-000000000008",
);
const completedAt = instantSchema.parse("2026-09-30T12:00:00Z");
const commandHash = sha256DigestSchema.parse("a".repeat(64));
const otherHash = sha256DigestSchema.parse("b".repeat(64));

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
}

function noChangePlan(overrides: Record<string, unknown> = {}) {
  return {
    kind: "NO_CHANGE" as const,
    receipt: {
      outcome: "NO_CHANGE" as const,
      commandId,
      commandHash,
      completedAt,
      existingRevisions: [],
    },
    ...overrides,
  };
}

function commitPlan(overrides: Record<string, unknown> = {}) {
  const revision: TestRevisionRow = {
    revisionId,
    recordId,
    recordType: "PATIENT_PROFILE",
    revisionNumber: 1,
    previousRevisionId: null,
    transactionId,
    auditEventId,
    payload: { displayName: "Synthetic Patient" },
  };
  const head: RecordHead = recordHeadSchema.parse({
    recordId,
    recordType: "PATIENT_PROFILE",
    headRevisionId: revisionId,
    headRevisionNumber: 1,
    state: "ACTIVE",
    updatedAt: completedAt,
  });
  return {
    kind: "COMMIT" as const,
    commandId,
    commandHash,
    completedAt,
    transactionId,
    headExpectations: [
      {
        kind: "MUST_NOT_EXIST" as const,
        recordType: "PATIENT_PROFILE" as const,
        proposedRecordId: recordId,
      },
    ],
    recordRevisions: [revision],
    recordHeads: [head],
    deletionTombstones: [],
    auditEvents: [
      {
        auditEventId,
        transactionId,
        recordId,
        occurredAt: completedAt,
        reasonCode: "TEST_REASON" as const,
      },
    ],
    domainEvents: [
      {
        eventId,
        eventName: "PATIENT_PROFILE_RECORDED" as const,
        transactionId,
        commandId,
        correlationId,
        change: {
          kind: "REVISION_CREATED" as const,
          recordType: "PATIENT_PROFILE" as const,
          recordId,
          action: "CREATE" as const,
          previousRevisionId: null,
          resultingRevisionId: revisionId,
          resultingRevisionNumber: 1,
        },
        payload: { revisionId },
      },
    ],
    eventWorkItems: [],
    reverseDependencies: [],
    evaluationAudits: [],
    appPreference: null,
    safety: { kind: "NOT_REQUIRED" as const },
    ...overrides,
  };
}

function alternateCommitPlan(options: {
  sameRecord?: boolean;
  includeAllWriteGroups?: boolean;
} = {}) {
  const base = commitPlan();
  const alternateCommandId = commandIdSchema.parse(uuid(20));
  const alternateCorrelationId = correlationIdSchema.parse(uuid(21));
  const alternateTransactionId = transactionIdSchema.parse(uuid(22));
  const alternateRecordId = options.sameRecord
    ? recordId
    : recordIdSchema.parse(uuid(23));
  const alternateRevisionId = revisionIdSchema.parse(uuid(24));
  const alternateAuditEventId = auditEventIdSchema.parse(uuid(25));
  const alternateEventId = domainEventIdSchema.parse(uuid(26));
  return {
    ...base,
    commandId: alternateCommandId,
    commandHash: otherHash,
    transactionId: alternateTransactionId,
    headExpectations: [
      {
        kind: "MUST_NOT_EXIST" as const,
        recordType: "PATIENT_PROFILE" as const,
        proposedRecordId: alternateRecordId,
      },
    ],
    recordRevisions: [
      {
        ...base.recordRevisions[0],
        revisionId: alternateRevisionId,
        recordId: alternateRecordId,
        transactionId: alternateTransactionId,
        auditEventId: alternateAuditEventId,
      },
    ],
    recordHeads: [
      {
        ...base.recordHeads[0],
        recordId: alternateRecordId,
        headRevisionId: alternateRevisionId,
      },
    ],
    auditEvents: [
      {
        ...base.auditEvents[0],
        auditEventId: alternateAuditEventId,
        transactionId: alternateTransactionId,
        recordId: alternateRecordId,
      },
    ],
    domainEvents: [
      {
        ...base.domainEvents[0],
        eventId: alternateEventId,
        transactionId: alternateTransactionId,
        commandId: alternateCommandId,
        correlationId: alternateCorrelationId,
        change: {
          ...base.domainEvents[0].change,
          recordId: alternateRecordId,
          resultingRevisionId: alternateRevisionId,
        },
        payload: { revisionId: alternateRevisionId },
      },
    ],
    eventWorkItems: options.includeAllWriteGroups
      ? [
          {
            workItemId: workItemIdSchema.parse(uuid(27)),
            eventId: alternateEventId,
            consumer: "MAINTENANCE" as const,
            handlerVersion: "test-handler-v1",
            priority: "MAINTENANCE" as const,
            createdAt: completedAt,
            attemptCount: 0,
            state: { state: "PENDING" as const },
            plannedCommands: [],
          },
        ]
      : [],
    reverseDependencies: options.includeAllWriteGroups
      ? [
          {
            sourceRevisionId: alternateRevisionId,
            dependentRevisionId: alternateRevisionId,
            dependencyRole: "TEST_DEPENDENCY",
          },
        ]
      : [],
    evaluationAudits: options.includeAllWriteGroups
      ? [
          {
            evaluationId: uuid(28),
            evaluatedAt: completedAt,
            resultFingerprint: "test-result-fingerprint",
          },
        ]
      : [],
    appPreference: options.includeAllWriteGroups
      ? { key: "language" as const, value: "en-SG" as const, updatedAt: completedAt }
      : null,
  };
}

function deletionCommitPlan() {
  const base = commitPlan();
  const deletedRecordId = recordIdSchema.parse(uuid(30));
  const deletedRevisionId = revisionIdSchema.parse(uuid(31));
  const deletedAuditEventId = auditEventIdSchema.parse(uuid(32));
  const deletedEventId = domainEventIdSchema.parse(uuid(33));
  return {
    ...base,
    headExpectations: [
      {
        kind: "MUST_MATCH" as const,
        recordType: "PATIENT_PROFILE" as const,
        recordId: deletedRecordId,
        expectedRevisionId: deletedRevisionId,
        expectedRevisionNumber: 1,
      },
    ],
    recordRevisions: [],
    recordHeads: [
      {
        recordId: deletedRecordId,
        recordType: "PATIENT_PROFILE" as const,
        headRevisionId: deletedRevisionId,
        headRevisionNumber: 1,
        state: "DELETED" as const,
        updatedAt: completedAt,
      },
    ],
    deletionTombstones: [
      {
        recordId: deletedRecordId,
        recordType: "PATIENT_PROFILE" as const,
        deletedAt: completedAt,
        initiator: "PATIENT" as const,
        auditEventId: deletedAuditEventId,
        transactionId,
      },
    ],
    auditEvents: [
      {
        auditEventId: deletedAuditEventId,
        transactionId,
        recordId: deletedRecordId,
        occurredAt: completedAt,
        reasonCode: "TEST_REASON" as const,
      },
    ],
    domainEvents: [
      {
        ...base.domainEvents[0],
        eventId: deletedEventId,
        change: {
          kind: "RECORD_DELETED" as const,
          recordType: "PATIENT_PROFILE" as const,
          recordId: deletedRecordId,
          previousRevisionId: deletedRevisionId,
          resultingRevisionId: null,
        },
        payload: { revisionId: deletedRevisionId },
      },
    ],
  };
}

describe("authoritative command receipts and replay", () => {
  it("stores a no-change receipt without domain effects", async () => {
    const database = await openDatabase();
    const store = createAuthoritativeCommandStore(database, codecs);

    const receipt = await store.execute(noChangePlan());

    expect(receipt.outcome).toBe("NO_CHANGE");
    expect(
      commandReceiptSchema.parse(
        await database.table("commandReceipts").get(commandId),
      ),
    ).toEqual(receipt);
    expect(await database.table("domainEvents").count()).toBe(0);
    expect(await database.table("recordRevisions").count()).toBe(0);
  });

  it("returns the exact stored receipt for an identical replay", async () => {
    const database = await openDatabase();
    const store = createAuthoritativeCommandStore(database, codecs);
    const first = await store.execute(noChangePlan());

    expect(await store.execute(noChangePlan())).toEqual(first);
    expect(await database.table("commandReceipts").count()).toBe(1);
  });

  it("rejects the same command ID with a different hash", async () => {
    const database = await openDatabase();
    const store = createAuthoritativeCommandStore(database, codecs);
    await store.execute(noChangePlan());

    await expect(
      store.execute(
        noChangePlan({
          receipt: { ...noChangePlan().receipt, commandHash: otherHash },
        }),
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<CommandTransactionError>>({
        code: "COMMAND_REPLAY_MISMATCH",
      }),
    );
    expect(await database.table("commandReceipts").count()).toBe(1);
  });

  it("stores an exact rejected receipt and no domain effects", async () => {
    const database = await openDatabase();
    const store = createAuthoritativeCommandStore(database, codecs);

    const receipt = await store.execute({
      kind: "REJECTED",
      receipt: {
        outcome: "REJECTED",
        commandId,
        commandHash,
        completedAt,
        errorCode: "COMMAND_NOT_ALLOWED",
        currentHeads: [],
      },
    });

    expect(receipt.outcome).toBe("REJECTED");
    expect(await database.table("domainEvents").count()).toBe(0);
    expect(await database.table("recordRevisions").count()).toBe(0);
  });

  it("rejects unknown keys on terminal plans", async () => {
    const database = await openDatabase();
    const store = createAuthoritativeCommandStore(database, codecs);

    await expect(
      store.execute({
        ...noChangePlan(),
        extra: true,
      } as ReturnType<typeof noChangePlan>),
    ).rejects.toMatchObject({ code: "INVALID_TRANSACTION_PLAN" });
    expect(await database.table("commandReceipts").count()).toBe(0);
  });
});

describe("expected-head enforcement", () => {
  it("rejects MUST_NOT_EXIST when a head is already present", async () => {
    const database = await openDatabase();
    const existingHead = recordHeadSchema.parse({
      recordId,
      recordType: "PATIENT_PROFILE",
      headRevisionId: revisionId,
      headRevisionNumber: 1,
      state: "ACTIVE",
      updatedAt: completedAt,
    });
    await database.table<RecordHead>("recordHeads").add(existingHead);
    const store = createAuthoritativeCommandStore(database, codecs);

    const receipt = await store.execute(commitPlan());

    expect(receipt).toEqual(
      expect.objectContaining({
        outcome: "REJECTED",
        errorCode: "HEAD_CONFLICT",
        currentHeads: [existingHead],
      }),
    );
    expect(await database.table("recordRevisions").count()).toBe(0);
    expect(await database.table("domainEvents").count()).toBe(0);
  });

  it("commits when MUST_MATCH names the exact current head", async () => {
    const database = await openDatabase();
    const previousRevisionId = revisionIdSchema.parse(
      "00000000-0000-4000-8000-000000000009",
    );
    const existingHead = recordHeadSchema.parse({
      recordId,
      recordType: "PATIENT_PROFILE",
      headRevisionId: previousRevisionId,
      headRevisionNumber: 1,
      state: "ACTIVE",
      updatedAt: instantSchema.parse("2026-09-30T11:00:00Z"),
    });
    await database.table<RecordHead>("recordHeads").add(existingHead);
    const store = createAuthoritativeCommandStore(database, codecs);
    const plan = commitPlan({
      headExpectations: [
        {
          kind: "MUST_MATCH" as const,
          recordType: "PATIENT_PROFILE" as const,
          recordId,
          expectedRevisionId: previousRevisionId,
          expectedRevisionNumber: 1,
        },
      ],
      recordRevisions: [
        {
          ...commitPlan().recordRevisions[0],
          revisionNumber: 2,
          previousRevisionId,
        },
      ],
      recordHeads: [
        {
          ...commitPlan().recordHeads[0],
          headRevisionNumber: 2,
        },
      ],
      domainEvents: [
        {
          ...commitPlan().domainEvents[0],
          change: {
            ...commitPlan().domainEvents[0].change,
            action: "UPDATE" as const,
            previousRevisionId,
            resultingRevisionNumber: 2,
          },
        },
      ],
    });

    const receipt = await store.execute(plan);

    expect(receipt.outcome).toBe("COMMITTED");
    expect(await database.table("recordRevisions").count()).toBe(1);
    expect(await database.table("domainEvents").count()).toBe(1);
  });

  it("rejects duplicate expectations for one record before persistence", async () => {
    const database = await openDatabase();
    const store = createAuthoritativeCommandStore(database, codecs);
    const expectation = commitPlan().headExpectations[0];

    await expect(
      store.execute(commitPlan({ headExpectations: [expectation, expectation] })),
    ).rejects.toEqual(
      expect.objectContaining<Partial<CommandTransactionError>>({
        code: "INVALID_TRANSACTION_PLAN",
      }),
    );
    expect(await database.table("commandReceipts").count()).toBe(0);
  });

  it("does not confuse another command ID with an exact replay", async () => {
    const database = await openDatabase();
    const store = createAuthoritativeCommandStore(database, codecs);
    await store.execute(noChangePlan());

    const second = await store.execute({
      ...noChangePlan(),
      receipt: { ...noChangePlan().receipt, commandId: secondCommandId },
    });

    expect(second.commandId).toBe(secondCommandId);
    expect(await database.table("commandReceipts").count()).toBe(2);
  });
});

describe("sequence allocation and transaction derivatives", () => {
  it("allocates contiguous sequences and transaction indexes in plan order", async () => {
    const database = await openDatabase();
    const store = createAuthoritativeCommandStore(database, codecs);
    const secondEventId = domainEventIdSchema.parse(uuid(40));
    const plan = commitPlan({
      domainEvents: [
        commitPlan().domainEvents[0],
        { ...commitPlan().domainEvents[0], eventId: secondEventId },
      ],
    });

    await store.execute(plan);

    const events = await database
      .table<TestEventRow>("domainEvents")
      .orderBy("localSequence")
      .toArray();
    expect(events.map((event) => event.localSequence)).toEqual([1, 2]);
    expect(events.map((event) => event.transactionIndex)).toEqual([0, 1]);
    expect(events.map((event) => event.committedAt)).toEqual([
      completedAt,
      completedAt,
    ]);
    expect(await database.table("storageMetadata").get("EVENT_SEQUENCE_HIGH_WATER_MARK")).toEqual({
      key: "EVENT_SEQUENCE_HIGH_WATER_MARK",
      lastAllocatedSequence: 2,
      updatedAt: completedAt,
    });
  });

  it("derives work sourceEventSequence from the committed source event", async () => {
    const database = await openDatabase();
    const store = createAuthoritativeCommandStore(database, codecs);
    const plan = alternateCommitPlan({ includeAllWriteGroups: true });

    await store.execute(plan);

    const stored = await database
      .table<StoredEventWorkItem>("eventWorkItems")
      .get(plan.eventWorkItems[0].workItemId);
    expect(stored).toEqual(
      expect.objectContaining({
        eventId: plan.domainEvents[0].eventId,
        sourceEventSequence: 1,
        stateCode: "PENDING",
        priorityRank: 4,
        availableAt: completedAt,
      }),
    );
  });

  it("rejects a high-water row below the highest stored event", async () => {
    const database = await openDatabase();
    const store = createAuthoritativeCommandStore(database, codecs);
    await store.execute(commitPlan());
    await database.table("storageMetadata").put({
      key: "EVENT_SEQUENCE_HIGH_WATER_MARK",
      lastAllocatedSequence: 0,
      updatedAt: completedAt,
    });

    await expect(store.execute(alternateCommitPlan())).rejects.toEqual(
      expect.objectContaining<Partial<CommandTransactionError>>({
        code: "STORAGE_INTEGRITY_FAILED",
      }),
    );
    expect(await database.table("domainEvents").count()).toBe(1);
    expect(await database.table("commandReceipts").count()).toBe(1);
  });
});

describe("commit-plan integrity", () => {
  it("rejects unknown keys on commit plans", async () => {
    const database = await openDatabase();
    const store = createAuthoritativeCommandStore(database, codecs);

    await expect(
      store.execute({
        ...commitPlan(),
        extra: true,
      } as ReturnType<typeof commitPlan>),
    ).rejects.toMatchObject({ code: "INVALID_TRANSACTION_PLAN" });
    expect(await database.table("commandReceipts").count()).toBe(0);
  });

  it("rejects an active head that does not name its proposed revision", async () => {
    const database = await openDatabase();
    const store = createAuthoritativeCommandStore(database, codecs);
    const wrongRevisionId = revisionIdSchema.parse(uuid(50));

    await expect(
      store.execute(
        commitPlan({
          recordHeads: [
            { ...commitPlan().recordHeads[0], headRevisionId: wrongRevisionId },
          ],
        }),
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<CommandTransactionError>>({
        code: "INVALID_TRANSACTION_PLAN",
      }),
    );
    expect(await database.table("commandReceipts").count()).toBe(0);
  });

  it("rejects a deleted head without its exact tombstone", async () => {
    const database = await openDatabase();
    const store = createAuthoritativeCommandStore(database, codecs);
    const plan = deletionCommitPlan();

    await expect(
      store.execute(
        { ...plan, deletionTombstones: [] },
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<CommandTransactionError>>({
        code: "INVALID_TRANSACTION_PLAN",
      }),
    );
  });

  it("requires every declared Safety decision revision to be present and owned by Safety", async () => {
    const database = await openDatabase();
    const store = createAuthoritativeCommandStore(database, codecs);

    await expect(
      store.execute(
        commitPlan({
          safety: {
            kind: "EVALUATED" as const,
            safetyDecisionRevisionIds: [revisionId],
          },
        }),
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<CommandTransactionError>>({
        code: "INVALID_TRANSACTION_PLAN",
      }),
    );
    expect(await database.table("recordRevisions").count()).toBe(0);
  });
});

describe("atomic rollback", () => {
  const writeGroups = [
    "recordRevisions",
    "recordHeads",
    "auditEvents",
    "domainEvents",
    "eventWorkItems",
    "reverseDependencies",
    "engineEvaluationAudits",
    "appPreferences",
    "commandReceipts",
    "storageMetadata",
  ] as const;

  it.each(writeGroups)(
    "rolls back every effect when %s fails during creation",
    async (failingTable) => {
      const database = await openDatabase();
      const store = createAuthoritativeCommandStore(database, codecs);
      database.table(failingTable).hook("creating", () => {
        throw new Error("injected stage fault");
      });

      await expect(
        store.execute(alternateCommitPlan({ includeAllWriteGroups: true })),
      ).rejects.toEqual(
        expect.objectContaining<Partial<CommandTransactionError>>({
          code: "STORAGE_COMMIT_FAILED",
        }),
      );

      for (const tableName of [
        ...writeGroups,
        "deletionTombstones",
      ] as const) {
        expect(await database.table(tableName).count()).toBe(0);
      }
    },
  );

  it("rolls back every effect when tombstone creation fails", async () => {
    const database = await openDatabase();
    const existingHead = {
      ...deletionCommitPlan().recordHeads[0],
      state: "ACTIVE" as const,
    };
    await database.table<RecordHead>("recordHeads").add(existingHead);
    database.table("deletionTombstones").hook("creating", () => {
      throw new Error("injected tombstone fault");
    });
    const store = createAuthoritativeCommandStore(database, codecs);

    await expect(store.execute(deletionCommitPlan())).rejects.toEqual(
      expect.objectContaining<Partial<CommandTransactionError>>({
        code: "STORAGE_COMMIT_FAILED",
      }),
    );
    expect(await database.table("recordHeads").get(existingHead.recordId)).toEqual(
      existingHead,
    );
    expect(await database.table("deletionTombstones").count()).toBe(0);
    expect(await database.table("commandReceipts").count()).toBe(0);
  });
});

describe("multi-connection concurrency", () => {
  it("allows only one command to win a MUST_NOT_EXIST head race", async () => {
    const name = `head-race-${crypto.randomUUID()}`;
    const firstDatabase = await openDatabase(name);
    const secondDatabase = await openDatabase(name);
    const firstStore = createAuthoritativeCommandStore(firstDatabase, codecs);
    const secondStore = createAuthoritativeCommandStore(secondDatabase, codecs);

    const receipts = await Promise.all([
      firstStore.execute(commitPlan()),
      secondStore.execute(alternateCommitPlan({ sameRecord: true })),
    ]);

    expect(receipts.map((receipt) => receipt.outcome).sort()).toEqual([
      "COMMITTED",
      "REJECTED",
    ]);
    expect(await firstDatabase.table("recordRevisions").count()).toBe(1);
    expect(await firstDatabase.table("domainEvents").count()).toBe(1);
    expect(await firstDatabase.table("commandReceipts").count()).toBe(2);
  });

  it("allocates unique contiguous event sequences to concurrent commands", async () => {
    const name = `sequence-race-${crypto.randomUUID()}`;
    const firstDatabase = await openDatabase(name);
    const secondDatabase = await openDatabase(name);
    const firstStore = createAuthoritativeCommandStore(firstDatabase, codecs);
    const secondStore = createAuthoritativeCommandStore(secondDatabase, codecs);

    const receipts = await Promise.all([
      firstStore.execute(commitPlan()),
      secondStore.execute(alternateCommitPlan()),
    ]);

    expect(receipts.every((receipt) => receipt.outcome === "COMMITTED")).toBe(
      true,
    );
    const events = await firstDatabase
      .table<TestEventRow>("domainEvents")
      .orderBy("localSequence")
      .toArray();
    expect(events.map((event) => event.localSequence)).toEqual([1, 2]);
    expect(
      await firstDatabase
        .table("storageMetadata")
        .get("EVENT_SEQUENCE_HIGH_WATER_MARK"),
    ).toEqual(
      expect.objectContaining({ lastAllocatedSequence: 2 }),
    );
  });
});
