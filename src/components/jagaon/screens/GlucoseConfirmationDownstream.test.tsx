// @vitest-environment jsdom
// CR-11 (owner decisions 2026-10-11, design v3.1 §4, §6 AC-16–AC-20, AC-20z): a confirmed 60.0 and a confirmed 0.0 mmol/L, and historical
// "6.80", "6.85" and "7" records, on every downstream surface: Today (booklet and latest reading), History (list, explanation facts,
// chart and completion stamps), pattern processing, the care summary, backup, restore and the export. Stored text is shown verbatim
// (never rounded; never re-canonicalised), and nothing is rewritten. Synthetic data only; fake IndexedDB; no network.
import Dexie from "dexie";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createJournalQueryService } from "@/application/journal/journal-query-service";
import { createRecordedHistoryQuery } from "@/application/history/recorded-history-query";
import { databases, dayBefore, FACT, local, reading, RECENT, REFERENCE, setup, TODAY } from "@/application/history/history-test-support";
import { createAppointmentNoteSelectionRepository } from "@/application/history/appointment-note-selection";
import { createMemoryOnboardingStorage } from "@/application/onboarding/demo-onboarding-repository";
import { createDemoScenarioFixture } from "@/application/governed/demo-scenario-fixture";
import { createBrowserJournalRuntime } from "@/application/journal/browser-journal-runtime";
import { createPopulatedDataset, installFakeIndexedDb, openRaw, PACKET10_NOW, readAllTables } from "@/application/storage/packet10-test-support";
import { createBackupExportService } from "@/backup/backup-export-service";
import { createBackupSnapshotRepository } from "@/backup/backup-snapshot-repository";
import { capturingFilePort, decryptForTest, parseContainer } from "@/backup/backup-test-support";
import { createWebCryptoPort } from "@/backup/web-crypto-port";
import { createRestoreService } from "@/application/restore/restore-service";
import { printableCareSummary } from "@/application/care-preparation/care-summary-artifact";
import type { Instant } from "@/domain/shared/time";
import type { JagaOnDatabase } from "@/storage/database";
import { getMessages } from "@/i18n/get-messages";
import { RecordedHistoryScreen } from "./RecordedHistoryScreen";
import { TodayScreen } from "./TodayScreen";

installFakeIndexedDb();
const TIMEOUT = 240_000;
const PASS = "correct horse battery staple";
const names: string[] = [];
afterEach(async () => {
  cleanup();
  for (const database of databases) database.close();
  for (const database of databases.splice(0)) await Dexie.delete(database.name);
  for (const name of names.splice(0)) await Dexie.delete(name);
});

/** New confirmed entries (stored with one decimal) and historical records (stored as they were), all in this week. */
const SEED: ReadonlyArray<readonly [date: string, time: string, value: string, slot: string]> = [
  ["2026-10-03", "07:30", "60.0", "BEFORE_BREAKFAST"],
  ["2026-10-03", "20:00", "0.0", "BEDTIME"],
  ["2026-10-02", "07:30", "6.80", "BEFORE_BREAKFAST"],
  ["2026-10-02", "20:00", "6.85", "BEDTIME"],
  ["2026-10-01", "07:30", "7", "BEFORE_BREAKFAST"],
];

async function seeded() {
  const harness = await setup();
  for (const [date, time, value, slot] of SEED) await reading(harness.journal, date, time, value, slot);
  await harness.coordinator.processPending();
  return harness;
}

async function storedValues(database: JagaOnDatabase): Promise<string[]> {
  const rows = (await database.table("recordRevisions").where("recordType").equals("GLUCOSE_READING").toArray()) as Array<{ revision: { payload: { measurement: { enteredValue: string } } } }>;
  return rows.map((row) => row.revision.payload.measurement.enteredValue).sort();
}

describe.each(["en-SG", "zh-SG"] as const)("CR-11 downstream surfaces (%s)", (locale) => {
  const m = getMessages(locale);

  it("AC-16 / AC-20 / AC-20z: Today's booklet and latest reading show the stored text (60.0, 0.0, 6.80, 6.85, 7) unchanged", async () => {
    const { database } = await seeded();
    const journal = await createJournalQueryService(database).loadToday();
    expect(journal.unavailable).toBe(false);
    expect(journal.entries.filter((entry) => entry.recordType === "GLUCOSE_READING").map((entry) => entry.displayValue).sort()).toEqual(["0.0", "6.80", "6.85", "60.0", "7"]);
    const fixture = createDemoScenarioFixture();
    const renderOn = (now: string) => render(<TodayScreen messages={m} locale={locale} fixture={fixture} journal={journal} navigate={vi.fn()} now={new Date(now)} />);

    // 3 Oct, 22:00 Singapore: the morning 60.0 and the evening 0.0 fill their booklet slots; the latest reading is the 0.0.
    const day3 = renderOn("2026-10-03T14:00:00Z");
    const booklet = day3.container.querySelector(".booklet-slots") as HTMLElement;
    expect([...booklet.querySelectorAll(".booklet-slot-value")].map((node) => node.firstChild?.textContent)).toEqual(["60.0", "0.0"]);
    expect(day3.container.querySelector(".booklet-progress")?.textContent).toBe(m.today.bookletProgress(2, 3));
    const latest = screen.getByRole("region", { name: m.today.latestRecordedReading });
    expect(latest.querySelector(".reading-value")?.textContent).toBe("0.0");
    expect(latest.querySelector(".reading-unit")?.textContent).toBe("mmol/L");
    cleanup();

    // 2 Oct and 1 Oct: the historical records keep their precision ("6.80", "6.85"); "7" is shown as stored.
    const day2 = renderOn("2026-10-02T14:00:00Z");
    expect([...day2.container.querySelectorAll(".booklet-slot-value")].map((node) => node.firstChild?.textContent)).toEqual(["6.80", "6.85"]);
    cleanup();
    const day1 = renderOn("2026-10-01T14:00:00Z");
    expect([...day1.container.querySelectorAll(".booklet-slot-value")].map((node) => node.firstChild?.textContent)).toEqual(["7"]);
    expect(await storedValues(database)).toEqual(["0.0", "6.80", "6.85", "60.0", "7"]);
  });

  it("AC-17 / AC-18 / AC-20 / AC-20z: History keeps the stored precision in the list and facts, draws and labels 0.0, and stamps count both", async () => {
    const { database, history } = await seeded();
    const view = await history.load({ period: "THIS_WEEK" });
    expect(view.status === "READY" || view.status === "INSUFFICIENT_EVIDENCE").toBe(true);
    if (view.status !== "READY" && view.status !== "INSUFFICIENT_EVIDENCE") throw new Error(view.status);
    const projection = view.projection;
    const recorded = projection.chart.filter((position) => position.state === "RECORDED");
    expect(recorded.map((position) => [position.date, position.position, position.state === "RECORDED" ? position.valueMmolL : null])).toEqual([
      ["2026-10-01", "MORNING", "7"],
      ["2026-10-02", "MORNING", "6.80"],
      ["2026-10-02", "EVENING", "6.85"],
      ["2026-10-03", "MORNING", "60.0"],
      ["2026-10-03", "EVENING", "0.0"],
    ]);
    expect(projection.valueRange).toEqual({ minimum: "0.0", maximum: "60.0" });
    expect(projection.readingCount).toBe(5);
    // Completion stamps: logging only, never values; the confirmed 60.0 and 0.0 complete 3 Oct.
    expect(projection.stamps.find((stamp) => stamp.date === "2026-10-03")).toEqual({ date: "2026-10-03", recordedPositions: 2, complete: true });
    expect(projection.stamps.find((stamp) => stamp.date === "2026-10-02")).toEqual({ date: "2026-10-02", recordedPositions: 2, complete: true });
    expect(JSON.stringify(projection.stamps)).not.toMatch(/60|6\.8/);

    const selection = createAppointmentNoteSelectionRepository(createMemoryOnboardingStorage(), () => "2026-10-04T02:00:00.000Z" as never);
    const { container } = render(<RecordedHistoryScreen messages={m} locale={locale} history={history} selection={selection} />);
    await act(async () => undefined);
    // Explanation facts: the value range with the stored text.
    expect((await screen.findAllByText(m.history.valueRange("0.0", "60.0", "mmol/L"), {}, { timeout: 10_000 })).length).toBeGreaterThan(0);
    // The list (table equivalent of the chart): every stored text verbatim.
    const cells = [...container.querySelectorAll(".history-chart table td")].map((cell) => cell.textContent);
    for (const value of ["7", "6.80", "6.85", "60.0", "0.0"]) expect(cells, value).toContain(value);
    expect(cells).not.toContain("6.8");
    // The chart: a 0.0 is drawn (a thin solid bar), never shown as not recorded; the axis includes 60.
    const bars = [...container.querySelectorAll(".history-bar--recorded")] as HTMLElement[];
    expect(bars.map((bar) => bar.dataset.value)).toEqual(["7", "6.80", "6.85", "60.0", "0.0"]);
    expect(bars.find((bar) => bar.dataset.value === "0.0")!.className).toContain("history-bar--zero");
    expect(bars.find((bar) => bar.dataset.value === "60.0")!.style.height).toBe("100%");
    expect([...container.querySelectorAll(".history-axis-label")].map((label) => label.textContent)).toContain("60");
    expect(await storedValues(database)).toEqual(["0.0", "6.80", "6.85", "60.0", "7"]);
  });
});

describe("CR-11 pattern processing and explanation with 60.0 and 0.0 (AC-19, AC-20z)", () => {
  it("includes both readings in the governed comparison without errors; the explanation lists their stored text", async () => {
    const { journal, coordinator, history, database } = await setup();
    for (const [d, v] of REFERENCE) await reading(journal, dayBefore(TODAY, d), "07:30", v);
    for (const [d, v] of RECENT) await reading(journal, dayBefore(TODAY, d), "07:30", v);
    await reading(journal, dayBefore(TODAY, 2), "07:30", "60.0");
    await reading(journal, dayBefore(TODAY, 4), "07:30", "0.0");
    await coordinator.processPending();
    const view = await history.load({ period: "THIRTY_DAYS" });
    expect(view.status === "READY" || view.status === "INSUFFICIENT_EVIDENCE").toBe(true);
    if (view.status !== "READY" && view.status !== "INSUFFICIENT_EVIDENCE") throw new Error(view.status);
    expect(view.projection.valueRange).toEqual({ minimum: "0.0", maximum: "60.0" });
    const explanation = await history.loadExplainablePattern({ factId: FACT });
    expect(explanation.kind).toBe("EXPLAINABLE");
    if (explanation.kind !== "EXPLAINABLE") throw new Error(explanation.reason);
    const recent = explanation.view.periods[1];
    expect(recent.readings.map((entry) => entry.enteredValue)).toEqual(expect.arrayContaining(["60.0", "0.0"]));
    expect(recent.count).toBe(RECENT.length + 2);
    // Numeric statistics stay numeric (no precision claim); the stored text is unchanged.
    expect(Number(recent.summary.valueMmolL)).toBeGreaterThan(0);
    expect((await storedValues(database)).filter((value) => value === "60.0" || value === "0.0")).toEqual(["0.0", "60.0"]);
    // The same query with a later clock still works (no division or empty-range error with a zero).
    const later = createRecordedHistoryQuery(database, { now: () => "2026-10-04T15:00:00.000Z" as Instant });
    expect((await later.load({ period: "THIS_WEEK" })).status).not.toBe("UNAVAILABLE");
  });
});

describe("CR-11 care summary, backup, restore and export (AC-19, AC-20, AC-20z)", () => {
  it(
    "the care summary prints the stored text; backup and restore round-trip it verbatim; nothing is rewritten",
    async () => {
      const { name, runtime } = await createPopulatedDataset();
      names.push(name);
      const added: Array<{ recordId: string; revisionId: string }> = [];
      for (const [date, time, value, slot] of SEED) {
        const result = await runtime.commands.recordGlucose({
          payload: { measurement: { enteredValue: value as never, enteredUnit: "MMOL_L", normalization: null }, measurementMethod: "FINGERSTICK_METER", context: { kind: "PATIENT_SELECTED_SLOT", slot: slot as never } },
          temporal: local(date, time),
          recordedAt: PACKET10_NOW,
        });
        if (result.kind !== "COMMITTED") throw new Error(JSON.stringify(result));
        added.push({ recordId: result.recordId, revisionId: result.revisionId });
      }
      // Today (the app's own query port): the stored text.
      const today = await runtime.query.loadToday();
      for (const value of ["60.0", "0.0", "6.80", "6.85", "7"]) expect(today.entries.some((entry) => entry.displayValue === value), value).toBe(true);

      // Care summary (EN and ZH): the selected readings print with their stored text.
      const visit = await runtime.careOrganisation.query.loadVisitPreparation();
      if (visit.status !== "READY") throw new Error(visit.status);
      for (const locale of ["en-SG", "zh-SG"] as const) {
        const prepared = await runtime.carePreparation.commands.prepare({
          locale,
          period: visit.period,
          appointment: null,
          groups: [{ key: "GLUCOSE", sources: added.map((ref) => ({ recordType: "GLUCOSE_READING" as const, recordId: ref.recordId as never, revisionId: ref.revisionId as never })) }],
          questions: [],
          notSelected: [],
        });
        if (prepared.kind !== "COMMITTED") throw new Error(JSON.stringify(prepared));
        const summary = await runtime.carePreparation.query.loadSummary(prepared.recordId);
        if (summary.status !== "READY") throw new Error(summary.status);
        const text = printableCareSummary(summary.payload).text;
        for (const value of ["60.0", "0.0", "6.80", "6.85"]) expect(text, `${locale} ${value}`).toMatch(new RegExp(`(^|[^0-9.])${value.replace(".", "\\.")}([^0-9]|$)`));
        expect(text).toMatch(/(^|[^0-9.])7(?![0-9.])/);
        expect(text).not.toMatch(/(^|[^0-9.])6\.8(?![0-9])/);
      }
      runtime.close();

      // Backup export: the encrypted payload carries the stored text verbatim.
      const source = await openRaw(name);
      const capture = capturingFilePort();
      const exported = await createBackupExportService({ snapshot: createBackupSnapshotRepository(source), crypto: () => createWebCryptoPort(), file: capture.port, now: () => PACKET10_NOW, timeZone: "Asia/Singapore" }).export({ passphrase: PASS, confirmation: PASS });
      expect(exported.kind).toBe("DOWNLOAD_STARTED");
      const bytes = capture.saved[0]!.bytes;
      const payload = JSON.stringify(await decryptForTest(parseContainer(bytes), PASS));
      for (const value of ["60.0", "0.0", "6.80", "6.85"]) expect(payload, value).toContain(`"enteredValue":"${value}"`);
      expect(payload).toContain(`"enteredValue":"7"`);
      const sourceValues = await storedValues(source);
      source.close();

      // Restore into an empty dataset: the same stored text, unchanged.
      const target = `cr11-restore-${crypto.randomUUID()}`;
      names.push(target);
      (await createBrowserJournalRuntime(target, { now: () => PACKET10_NOW, seedSyntheticScenarioOnCreate: false })).close();
      const restore = createRestoreService({
        databaseName: target,
        now: () => "2026-10-04T03:00:00.000Z" as never,
        crypto: () => createWebCryptoPort(),
        coordinator: { acquireExclusive: async () => () => undefined, announceDeleted: () => undefined },
        closeRuntime: vi.fn(),
      });
      const inspected = await restore.inspect(bytes, PASS);
      if (inspected.kind !== "PLAN_READY") throw new Error(JSON.stringify(inspected));
      expect(await restore.confirm(inspected.plan, { planHash: inspected.plan.planHash, confirmedAt: "2026-10-04T03:00:00.000Z" as never })).toEqual({ kind: "COMMITTED" });
      const restored = await openRaw(target);
      expect(await storedValues(restored)).toEqual(sourceValues);
      const tables = await readAllTables(restored);
      restored.close();
      const restoredText = JSON.stringify(tables.recordRevisions);
      for (const value of ["60.0", "0.0", "6.80", "6.85", "7"]) expect(restoredText, value).toContain(`"enteredValue":"${value}"`);
    },
    TIMEOUT,
  );
});
