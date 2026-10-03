import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import Dexie from "dexie";
import fakeIndexedDB, { IDBKeyRange as FDBKeyRange } from "fake-indexeddb";
import type { Instant } from "@/domain/shared/time";
import { createBrowserJournalRuntime } from "./browser-journal-runtime";

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

const runtimes: Awaited<ReturnType<typeof createBrowserJournalRuntime>>[] = [];

afterEach(async () => {
  const names = [...new Set(runtimes.map((runtime) => runtime.databaseName))];
  for (const runtime of runtimes) runtime.close();
  runtimes.length = 0;
  for (const name of names) await Dexie.delete(name);
});

// Seeding through real journal commands and evaluation is an integration path.
const INTEGRATION_TIMEOUT_MS = 60_000;

// Sunday 4 Oct 2026, 10:00 in Singapore.
const NOW = "2026-10-04T02:00:00.000Z" as Instant;

async function open(name = `packet-7a-runtime-${crypto.randomUUID()}`) {
  const runtime = await createBrowserJournalRuntime(name, { now: () => NOW });
  runtimes.push(runtime);
  return runtime;
}

describe("browser journal runtime", () => {
  it("bootstraps the synthetic scenario through journal commands and evaluates it", async () => {
    const runtime = await open();
    const today = await runtime.query.loadToday();
    expect(today.unavailable).toBe(false);
    expect(today.entries[0]?.recordType).toBeDefined();

    const view = await runtime.history.load({ period: "THIS_WEEK" });
    expect(view.status).toBe("READY");
    if (view.status !== "READY") throw new Error("ready");
    expect(view.comparisons.map((fact) => [fact.factId, fact.kind])).toEqual([
      ["COMPARISON:BEFORE_BREAKFAST", "HIGHER"],
      ["NO_MATERIAL:BEFORE_DINNER", "NO_MATERIAL"],
    ]);
    // Chicken rice recurs every third day and never passes the familiar-item gate.
    expect(view.projection.repeated.map((fact) => [fact.kind, fact.label])).toEqual([
      ["ITEM", "Kaya toast"],
      ["CONTEXT", "Morning walk"],
    ]);
    expect(view.projection.notRecordedPositions.length).toBeGreaterThan(0);
    expect(view.comparisons[0]?.correctionUpdated).toBe(true);
    expect(view.projection.correctedRecordCount).toBe(1);
  }, INTEGRATION_TIMEOUT_MS);

  it("seeds only an empty database and reevaluates after a new journal entry", async () => {
    const name = `packet-7a-runtime-${crypto.randomUUID()}`;
    const first = await open(name);
    const before = await first.history.load({ period: "THIS_WEEK" });
    first.close();
    const second = await open(name);
    const again = await second.history.load({ period: "THIS_WEEK" });
    expect(again).toEqual(before);

    await second.commands.recordGlucose({
      payload: {
        measurement: { enteredValue: "6.6" as never, enteredUnit: "MMOL_L", normalization: null },
        measurementMethod: "FINGERSTICK_METER",
        context: { kind: "PATIENT_SELECTED_SLOT", slot: "BEDTIME" },
      },
      temporal: {
        kind: "POINT",
        occurrence: { kind: "EXACT", instantUtc: "2026-10-04T01:50:00.000Z" as Instant, timeZoneId: "Asia/Singapore", utcOffsetMinutes: 480 },
      },
      recordedAt: NOW,
    });
    const after = await second.history.load({ period: "THIS_WEEK" });
    if (after.status !== "READY" || before.status !== "READY") throw new Error("ready");
    expect(after.projection.readingCount).toBe(before.projection.readingCount + 1);
    expect(after.projection.slotCounts).toContainEqual({ slot: "BEDTIME", count: 1 });
  }, INTEGRATION_TIMEOUT_MS);

  it("persists an explicit locale and restores a clean synthetic scenario after reset", async () => {
    const runtime = await open();
    const seeded = await runtime.history.load({ period: "THIRTY_DAYS" });

    await runtime.persistLocale("zh-SG");
    expect(await runtime.resolveLocale()).toBe("zh-SG");

    await runtime.resetDemo();

    expect(await runtime.resolveLocale()).toBe("en-SG");
    expect(await runtime.history.load({ period: "THIRTY_DAYS" })).toEqual(seeded);
  }, INTEGRATION_TIMEOUT_MS);

  it("seeds the Packet 8 care plan once and restores the Medication schedule after reset", async () => {
    const runtime = await open();
    const scope = ["00000000-0000-4000-8000-000000000101", "00000000-0000-4000-8000-000000000103"];
    const seeded = await runtime.medicationSchedule.load({ locale: "en-SG", medicationRecordIds: scope });
    if (seeded.status !== "READY") throw new Error("ready");
    expect(seeded.occasions.map((entry) => [entry.section, entry.medicineName, entry.scheduledTime])).toEqual([
      ["YESTERDAY", "Nocturin pen (demo)", "21:00"],
      ["TODAY", "Nocturin pen (demo)", "21:00"],
    ]);
    expect(seeded.withoutFixedTime).toEqual([{ medicineName: "Veltora pen (demo)" }]);
    expect(seeded.counts.map((count) => [count.optionKey, count.occasionCount])).toEqual([
      ["ROUTINE_CHANGED", 2],
      ["AWAY_FROM_HOME", 1],
    ]);
    expect(seeded.reminders.map((reminder) => reminder.state)).toContain("REVIEW_REQUIRED");

    const yesterday = seeded.occasions.find((entry) => entry.section === "YESTERDAY")!;
    const saved = await runtime.medicationSchedule.recordOccasion({ occasion: yesterday.occasion, state: "SKIPPED", amount: null, locale: "en-SG", commandId: crypto.randomUUID() as never });
    expect(saved.kind === "SAVED" && saved.offer !== null).toBe(true);

    await runtime.resetDemo();
    // Record identifiers are regenerated; the restored meaning is identical.
    const semantic = (view: typeof seeded) => ({
      occasions: view.occasions.map((entry) => [entry.section, entry.localDate, entry.scheduledTime, entry.record, entry.barrier]),
      counts: view.counts,
      unrecordedCount: view.unrecordedCount,
      reminders: view.reminders.map((reminder) => [reminder.label, reminder.state, reminder.times]),
      careQuestions: view.careQuestions,
    });
    const restored = await runtime.medicationSchedule.load({ locale: "en-SG", medicationRecordIds: scope });
    if (restored.status !== "READY") throw new Error("ready");
    expect(semantic(restored)).toEqual(semantic(seeded));
  }, INTEGRATION_TIMEOUT_MS);
});
