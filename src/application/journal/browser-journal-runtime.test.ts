import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Dexie from "dexie";
import fakeIndexedDB, { IDBKeyRange as FDBKeyRange } from "fake-indexeddb";
import type { Instant } from "@/domain/shared/time";
import { createCarePreparationService } from "@/application/care-preparation/care-preparation-service";
import { projectValidatedAiCareSummary } from "@/application/care-preparation/ai-care-summary-replacement";
import { SYNTHETIC_CARE_QUESTION_TEXT } from "@/application/care-organisation/synthetic-care-organisation-seed";
import { createBrowserJournalRuntime } from "./browser-journal-runtime";

// Packet 11C B4b: a pass-through spy on the care-preparation service factory, so the runtime's injected AI projection can be pinned.
vi.mock("@/application/care-preparation/care-preparation-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/application/care-preparation/care-preparation-service")>();
  return { ...actual, createCarePreparationService: vi.fn(actual.createCarePreparationService) };
});

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
  it("Packet 11C B4b: wires exactly projectValidatedAiCareSummary as the care-preparation AI projection, and nothing else", async () => {
    const before = vi.mocked(createCarePreparationService).mock.calls.length;
    await open();
    const calls = vi.mocked(createCarePreparationService).mock.calls.slice(before);
    expect(calls).toHaveLength(1);
    expect(calls[0]![1].projectAiCareSummary).toBe(projectValidatedAiCareSummary);
    expect(Object.keys(calls[0]![1]).sort()).toEqual(["ids", "now", "projectAiCareSummary"]);
  });

  it("bootstraps the synthetic scenario through journal commands and evaluates it", async () => {
    const runtime = await open();
    const today = await runtime.query.loadToday();
    expect(today.unavailable).toBe(false);
    expect(today.entries[0]?.recordType).toBeDefined();

    const view = await runtime.history.load({ period: "THIS_WEEK" });
    expect(view.status).toBe("READY");
    if (view.status !== "READY") throw new Error("ready");
    expect(view.comparisons.map((fact) => [fact.factId, fact.kind])).toEqual([
      // The prepared demo data (owner instruction 2026-10-12) shows an improvement before breakfast (was HIGHER) and has too few recent
      // before-dinner readings for a governed before-dinner statement (was NO_MATERIAL:BEFORE_DINNER).
      ["COMPARISON:BEFORE_BREAKFAST", "LOWER"],
    ]);
    // Chicken rice is recorded too rarely in the prepared data to pass the familiar-item gate.
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

  it("seeds the Packet 9B health checks and appointment once, keeps patient changes and restores them after reset", async () => {
    const runtime = await open();
    const view = await runtime.careOrganisation.query.loadPreventiveCare();
    if (view.status !== "READY") throw new Error("ready");
    expect(view.items.map((item) => [item.payload.identity.label, item.status])).toEqual([
      ["Eye screening", "SCHEDULED"],
      ["Blood test", "SCHEDULED"],
      ["Foot check", "RECORDED"],
      ["Flu vaccine", "NO_DATE"],
    ]);
    const visit = await runtime.careOrganisation.query.loadVisitPreparation();
    if (visit.status !== "READY") throw new Error("ready");
    expect(visit.appointment?.payload.appointmentLabel).toBe("Dr Lim, Bukit Merah Polyclinic");

    expect(await runtime.careOrganisation.commands.createCareQuestion({ questionText: { text: "Bring my meter?", language: "en-SG" } })).toMatchObject({ kind: "COMMITTED" });
    // Reopening the same database does not reseed over the patient's records.
    const reopened = await open(runtime.databaseName);
    const again = await reopened.careOrganisation.query.loadVisitPreparation();
    if (again.status !== "READY") throw new Error("ready");
    // The seeded demo question (owner decision 2026-10-12) stays beside the patient's own.
    expect(again.questions.map((question) => question.text).sort()).toEqual(["Bring my meter?", SYNTHETIC_CARE_QUESTION_TEXT]);
    const items = await reopened.careOrganisation.query.loadPreventiveCare();
    expect(items.status === "READY" && items.items.length).toBe(4);

    await reopened.resetDemo();
    const restored = await reopened.careOrganisation.query.loadVisitPreparation();
    if (restored.status !== "READY") throw new Error("ready");
    expect(restored.questions.map((question) => question.text)).toEqual([SYNTHETIC_CARE_QUESTION_TEXT]);
    expect(restored.appointment?.payload.appointmentLabel).toBe("Dr Lim, Bukit Merah Polyclinic");
  }, INTEGRATION_TIMEOUT_MS);

  it("runs the Packet 9C journey: prepare, preview, approve, print, retry, reload and invalidate after a correction", async () => {
    const runtime = await open();
    const visit = await runtime.careOrganisation.query.loadVisitPreparation();
    if (visit.status !== "READY" || !visit.appointment) throw new Error("visit");
    const glucose = visit.factGroups.find((group) => group.key === "GLUCOSE")!;
    expect(glucose.sources.length).toBeGreaterThan(0);
    const prepared = await runtime.carePreparation.commands.prepare({
      locale: "zh-SG",
      period: visit.period,
      appointment: { recordType: "APPOINTMENT", recordId: visit.appointment.recordId, revisionId: visit.appointment.revisionId },
      groups: [{ key: "GLUCOSE", sources: glucose.sources }],
      questions: [],
      notSelected: visit.factGroups.filter((group) => group.key !== "GLUCOSE").flatMap((group) => group.sources),
    });
    if (prepared.kind !== "COMMITTED") throw new Error(JSON.stringify(prepared));
    let view = await runtime.carePreparation.query.loadSummary(prepared.recordId);
    if (view.status !== "READY") throw new Error("ready");
    expect(view.payload.locale).toBe("zh-SG");
    const hash = view.payload.rendering.contentHash;
    const commands = runtime.carePreparation.commands;
    const previewed = await commands.markPreviewed({ recordId: prepared.recordId, expectedRevisionId: prepared.revisionId, expectedRevisionNumber: 1, contentHash: hash });
    if (previewed.kind !== "COMMITTED") throw new Error("previewed");
    const approved = await commands.approve({ recordId: prepared.recordId, expectedRevisionId: previewed.revisionId, expectedRevisionNumber: 2, contentHash: hash });
    if (approved.kind !== "COMMITTED") throw new Error("approved");
    for (const observation of ["UNAVAILABLE", "OUTCOME_UNKNOWN"] as const) {
      const requested = await commands.requestPrintExport({ recordId: prepared.recordId, expectedRevisionId: approved.revisionId, expectedRevisionNumber: 3, approvedContentHash: hash });
      if (requested.kind !== "COMMITTED") throw new Error("requested");
      await commands.completePrintExport({ recordId: requested.recordId, expectedRevisionId: requested.revisionId, expectedRevisionNumber: 1, observation, artifact: null });
    }

    // A reload of the same database keeps the snapshot and both attempts.
    const reopened = await open(runtime.databaseName);
    view = await reopened.carePreparation.query.loadSummary(prepared.recordId);
    if (view.status !== "READY") throw new Error("ready");
    expect(view.snapshotStatus).toBe("APPROVED");
    expect(view.exports.map((entry) => entry.outcome.state).sort()).toEqual(["FAILED", "OUTCOME_UNKNOWN"]);

    // Correcting a selected reading invalidates the snapshot before any new export.
    const reading = glucose.sources[0]!;
    const current = await reopened.query.loadGlucose(reading.recordId as never);
    if (!current) throw new Error("reading");
    await reopened.commands.correctGlucoseTime({
      recordId: reading.recordId as never,
      expectedRevisionId: reading.revisionId as never,
      expectedRevisionNumber: current.revisionNumber,
      payload: current.payload,
      temporal: { kind: "POINT", occurrence: { kind: "EXACT", instantUtc: "2026-10-03T11:00:00.000Z" as Instant, timeZoneId: "Asia/Singapore" as never, utcOffsetMinutes: 480 } },
      recordedAt: NOW,
    });
    view = await reopened.carePreparation.query.loadSummary(prepared.recordId);
    if (view.status !== "READY") throw new Error("ready");
    expect([view.snapshotStatus, view.payload.invalidation?.reason, view.sourcesCurrent]).toEqual(["INVALIDATED", "SOURCE_CORRECTED", false]);
    expect(await reopened.carePreparation.commands.requestPrintExport({ recordId: prepared.recordId, expectedRevisionId: view.revisionId, expectedRevisionNumber: view.revisionNumber, approvedContentHash: hash })).toEqual({
      kind: "REJECTED",
      code: "SUMMARY_INVALIDATED_FOR_EXPORT",
    });
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
      careQuestions: view.careQuestions.map((question) => [question.text, question.language, question.revisionNumber]),
    });
    const restored = await runtime.medicationSchedule.load({ locale: "en-SG", medicationRecordIds: scope });
    if (restored.status !== "READY") throw new Error("ready");
    expect(semantic(restored)).toEqual(semantic(seeded));
  }, INTEGRATION_TIMEOUT_MS);
});
