import Dexie from "dexie";
import fakeIndexedDB, { IDBKeyRange as FDBKeyRange } from "fake-indexeddb";
import { afterAll, beforeAll } from "vitest";
import { createBrowserJournalRuntime, type JagaOnRuntime } from "@/application/journal/browser-journal-runtime";
import type { Instant } from "@/domain/shared/time";
import { createJagaOnDatabase, type JagaOnDatabase } from "@/storage/database";
import { JAGAON_TABLE_NAMES, type JagaOnTableName } from "@/storage/table-catalogue";

/**
 * Test-only Packet 10 support: fake IndexedDB, a fully populated synthetic
 * dataset written through the real runtime owners, and raw table reads for
 * assertions. Never imported by runtime modules.
 */

// Sunday 4 Oct 2026, 10:00 in Singapore.
export const PACKET10_NOW = "2026-10-04T02:00:00.000Z" as Instant;

export function installFakeIndexedDb(): void {
  const originalIndexedDB = Dexie.dependencies.indexedDB;
  const originalKeyRange = Dexie.dependencies.IDBKeyRange;
  beforeAll(() => {
    Dexie.dependencies.indexedDB = fakeIndexedDB;
    Dexie.dependencies.IDBKeyRange = FDBKeyRange;
  });
  afterAll(() => {
    Dexie.dependencies.indexedDB = originalIndexedDB;
    Dexie.dependencies.IDBKeyRange = originalKeyRange;
  });
}

export type PopulatedDataset = { name: string; runtime: JagaOnRuntime };

/**
 * Seeds the synthetic scenario, settles intelligence and Inquiry work, and
 * prepares one care-summary snapshot so every enabled owner has stored rows.
 */
export async function createPopulatedDataset(name = `packet10-${crypto.randomUUID()}`, now: () => Instant = () => PACKET10_NOW): Promise<PopulatedDataset> {
  const runtime = await createBrowserJournalRuntime(name, { now });
  await runtime.history.load({ period: "THIS_WEEK" });
  await runtime.medicationSchedule.load({ locale: "en-SG", medicationRecordIds: [] });
  await runtime.careOrganisation.commands.createCareQuestion({ questionText: { text: "Can I keep the pen in my bag? (demo)", language: "en-SG" } });
  const visit = await runtime.careOrganisation.query.loadVisitPreparation();
  if (visit.status === "READY" && visit.appointment) {
    const glucose = visit.factGroups.find((group) => group.key === "GLUCOSE");
    await runtime.carePreparation.commands.prepare({
      locale: "en-SG",
      period: visit.period,
      appointment: { recordType: "APPOINTMENT", recordId: visit.appointment.recordId, revisionId: visit.appointment.revisionId },
      groups: glucose ? [{ key: "GLUCOSE", sources: glucose.sources }] : [],
      questions: visit.questions.map((entry) => ({ recordType: "CARE_QUESTION" as const, recordId: entry.recordId, revisionId: entry.revisionId })),
      notSelected: [],
    });
  }
  return { name, runtime };
}

export async function openRaw(name: string): Promise<JagaOnDatabase> {
  const database = createJagaOnDatabase(name);
  await database.open();
  return database;
}

export async function readAllTables(database: JagaOnDatabase): Promise<Record<JagaOnTableName, unknown[]>> {
  const entries = await Promise.all(JAGAON_TABLE_NAMES.map(async (table) => [table, await database.table(table).toArray()] as const));
  return Object.fromEntries(entries) as Record<JagaOnTableName, unknown[]>;
}
