import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import Dexie from "dexie";
import fakeIndexedDB, { IDBKeyRange as FDBKeyRange } from "fake-indexeddb";
import type { Instant } from "@/domain/shared/time";
import { createJagaOnDatabase, type JagaOnDatabase } from "@/storage/database";
import { createJournalCommandService } from "@/application/journal/journal-command-service";
import { seedSyntheticHistory } from "@/application/history/synthetic-history-seed";
import { createPreviewInsightsQuery } from "./preview-insights-query";

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
  for (const database of databases) database.close();
  for (const database of databases.splice(0)) await Dexie.delete(database.name);
});

// Wednesday 14 Oct 2026, 10:00 in Singapore: the prepared demo profile is seeded and read at this instant.
const NOW = "2026-10-14T02:00:00.000Z" as Instant;
const uuid = () => crypto.randomUUID() as never;

async function openDatabase() {
  const database = createJagaOnDatabase(`preview-${crypto.randomUUID()}`);
  databases.push(database);
  await database.open();
  const ids = { commandId: uuid, correlationId: uuid, recordId: uuid, revisionId: uuid, auditEventId: uuid, transactionId: uuid, domainEventId: uuid };
  const journal = createJournalCommandService(database, { now: () => NOW, ids });
  return { database, journal };
}

describe("preview insights query: habit trend (HSA-bounded mode preview)", () => {
  it("finds the prepared demo profile's morning walks alongside lower before-breakfast readings", async () => {
    const { database, journal } = await openDatabase();
    await seedSyntheticHistory(journal, NOW);
    const trend = await createPreviewInsightsQuery(database, { now: () => NOW }).habitTrend();
    // Walks start 16 days ago (28 Sep, 08:24). Before: 23 before-breakfast readings from 2 Sep to 28 Sep 07:50, median 7.6. After: 11
    // readings (the corrected one counted once, at its corrected time), median 6.1. (6.1 − 7.6) / 7.6 = −19.7% → 20% lower. Before
    // dinner has only 4 readings since the walks started, so it does not qualify.
    expect(trend).toEqual({
      ruleVersion: "habit-trend-preview.1",
      habitLabel: "Morning walk",
      slot: "BEFORE_BREAKFAST",
      direction: "LOWER",
      percentChange: 20,
      beforeMedian: "7.6",
      afterMedian: "6.1",
      beforeCount: 23,
      afterCount: 11,
      habitCount: 9,
      daysSince: 16,
      startedAt: "2026-09-28T00:24:00.000Z",
      startDate: "2026-09-28",
    });
  });

  it("stores nothing: the journal and derived records are unchanged by the read", async () => {
    const { database, journal } = await openDatabase();
    await seedSyntheticHistory(journal, NOW);
    const count = async () => [await database.table("recordRevisions").count(), await database.table("recordHeads").count()];
    const before = await count();
    await createPreviewInsightsQuery(database, { now: () => NOW }).habitTrend();
    expect(await count()).toEqual(before);
  });

  it("returns null for an empty journal", async () => {
    const { database } = await openDatabase();
    expect(await createPreviewInsightsQuery(database, { now: () => NOW }).habitTrend()).toBeNull();
  });

  it("returns null when the records cannot be read", async () => {
    const { database } = await openDatabase();
    database.close();
    expect(await createPreviewInsightsQuery(database, { now: () => NOW }).habitTrend()).toBeNull();
  });
});
