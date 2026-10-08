import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/get-messages";
import { createMemoryOnboardingStorage } from "@/application/onboarding/demo-onboarding-repository";
import {
  APPOINTMENT_NOTE_SELECTION_KEY,
  createAppointmentNoteSelectionRepository,
} from "@/application/history/appointment-note-selection";
import type { RecordedHistoryQueryPort, RecordedHistoryView } from "@/application/history/recorded-history-contracts";
import { RecordedHistoryScreen } from "./RecordedHistoryScreen";

afterEach(() => cleanup());

const en = getMessages("en-SG");
const zh = getMessages("zh-SG");

function readyView(overrides: Partial<Extract<RecordedHistoryView, { status: "READY" }>> = {}): RecordedHistoryView {
  return {
    status: "READY",
    unavailableFamilies: [],
    comparisons: [
      {
        factId: "COMPARISON:BEFORE_BREAKFAST",
        slot: "BEFORE_BREAKFAST",
        kind: "HIGHER",
        recent: "7.3",
        reference: "6",
        recentWindow: { startDate: "2026-09-20", endDate: "2026-10-04" },
        referenceWindow: { startDate: "2026-08-23", endDate: "2026-09-20" },
        correctionUpdated: true,
      },
      {
        factId: "NO_MATERIAL:BEFORE_DINNER",
        slot: "BEFORE_DINNER",
        kind: "NO_MATERIAL",
        recent: null,
        reference: null,
        recentWindow: { startDate: "2026-09-20", endDate: "2026-10-04" },
        referenceWindow: { startDate: "2026-08-23", endDate: "2026-09-20" },
        correctionUpdated: false,
      },
    ],
    projection: {
      period: "THIS_WEEK",
      range: { startDate: "2026-09-28", endDate: "2026-09-30" },
      unit: "MMOL_L",
      readingCount: 4,
      valueRange: { minimum: "5.9", maximum: "8.4" },
      slotCounts: [
        { slot: "BEFORE_BREAKFAST", count: 3 },
        { slot: "BEFORE_DINNER", count: 1 },
      ],
      chart: [
        { date: "2026-09-28", position: "MORNING", state: "RECORDED", valueMmolL: "6.1", readingCount: 1 },
        { date: "2026-09-28", position: "EVENING", state: "RECORDED", valueMmolL: "8.4", readingCount: 1 },
        { date: "2026-09-29", position: "MORNING", state: "RECORDED", valueMmolL: "6.4", readingCount: 1 },
        { date: "2026-09-29", position: "EVENING", state: "NOT_RECORDED" },
        { date: "2026-09-30", position: "MORNING", state: "RECORDED", valueMmolL: "5.9", readingCount: 1 },
        { date: "2026-09-30", position: "EVENING", state: "NOT_RECORDED" },
      ],
      notRecordedPositions: [
        { date: "2026-09-29", position: "EVENING" },
        { date: "2026-09-30", position: "EVENING" },
      ],
      stamps: [
        { date: "2026-09-28", recordedPositions: 2, complete: true },
        { date: "2026-09-29", recordedPositions: 1, complete: false },
        { date: "2026-09-30", recordedPositions: 1, complete: false },
      ],
      source: "PATIENT_ENTERED",
      correctedRecordCount: 1,
      repeated: [
        { factId: "REPEATED:fik-a", kind: "ITEM", label: "Kaya toast", count: 3, days: 3 },
        { factId: "REPEATED:fik-b", kind: "CONTEXT", label: "Morning walk", count: 2, days: 2 },
      ],
      selectableFactIds: [
        "READING_COUNT",
        "VALUE_RANGE",
        "SLOT_COUNT:BEFORE_BREAKFAST",
        "SLOT_COUNT:BEFORE_DINNER",
        "COMPARISON:BEFORE_BREAKFAST",
        "NO_MATERIAL:BEFORE_DINNER",
        "REPEATED:fik-a",
        "REPEATED:fik-b",
        "NOT_RECORDED_POSITIONS",
        "SOURCE",
        "CORRECTIONS",
      ],
    },
    ...overrides,
  } as RecordedHistoryView;
}

const notExplained = vi.fn(async () => ({ kind: "INELIGIBLE" as const, reason: "NOT_FOUND" as const }));

function port(view: RecordedHistoryView | ((period: string) => Promise<RecordedHistoryView>)): RecordedHistoryQueryPort {
  return { load: vi.fn(async ({ period }) => (typeof view === "function" ? view(period) : view)), loadExplainablePattern: notExplained };
}

function selectionRepository() {
  const storage = createMemoryOnboardingStorage();
  return { storage, repository: createAppointmentNoteSelectionRepository(storage, () => "2026-10-04T02:00:00.000Z" as never) };
}

async function renderScreen(history: RecordedHistoryQueryPort, locale: "en-SG" | "zh-SG" = "en-SG", repository = selectionRepository().repository) {
  const messages = locale === "en-SG" ? en : zh;
  const result = render(<RecordedHistoryScreen messages={messages} locale={locale} history={history} selection={repository} />);
  await act(async () => undefined);
  return result;
}

describe("Recorded history screen", () => {
  it("shows the loading state until the port answers", async () => {
    let resolve: (view: RecordedHistoryView) => void = () => undefined;
    const pending = port(() => new Promise<RecordedHistoryView>((r) => (resolve = r)));
    render(<RecordedHistoryScreen messages={en} locale="en-SG" history={pending} selection={selectionRepository().repository} />);
    expect(screen.getByRole("status")).toHaveTextContent(en.history.loading);
    await act(async () => undefined);
    await act(async () => resolve(readyView()));
    expect(screen.queryByText(en.history.loading)).not.toBeInTheDocument();
  });

  it("renders one page heading, the period control, the explicit range and a neutral chart with a table equivalent", async () => {
    await renderScreen(port(readyView()));
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: en.history.title })).toBeInTheDocument();
    const radios = screen.getAllByRole("radio");
    expect(radios.map((radio) => radio.closest("label")?.textContent)).toEqual([
      en.history.periodThisWeek,
      en.history.periodLastWeek,
      en.history.periodThirtyDays,
    ]);
    expect(radios[0]).toBeChecked();
    expect(screen.getAllByText("28–30 Sep 2026").length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { level: 2, name: en.history.readingsTitle("mmol/L") })).toBeInTheDocument();
    expect(screen.getByText(en.history.chartDescription(4, 6, "mmol/L"))).toBeInTheDocument();
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(7);
    expect(within(table).getAllByText(en.history.notRecordedLegend)).toHaveLength(2);
    expect(screen.getByText(en.history.recordedLegend)).toBeInTheDocument();
    expect(screen.getByText(en.history.chartSlotsNote)).toBeInTheDocument();
    expect(document.querySelectorAll(".history-bar--missing")).toHaveLength(2);
    expect(document.querySelectorAll("[class*='target'], [class*='threshold'], [class*='risk']")).toHaveLength(0);
  });

  it("states every descriptive fact with its window, provenance and limitations", async () => {
    await renderScreen(port(readyView()));
    const h = en.history;
    expect(screen.getByRole("heading", { level: 2, name: h.factsTitle })).toBeInTheDocument();
    expect(screen.getByText(h.recordedDataTag)).toBeInTheDocument();
    expect(screen.getByText("4 readings were recorded from 28–30 Sep 2026.")).toBeInTheDocument();
    expect(screen.getByText(h.valueRange("5.9", "8.4", "mmol/L"))).toBeInTheDocument();
    expect(screen.getByText(h.slotCount(h.slotLabels.BEFORE_BREAKFAST, 3))).toBeInTheDocument();
    expect(screen.getByText(h.comparisonHigher(h.slotLabels.BEFORE_BREAKFAST, "7.3", "6", "mmol/L"))).toBeInTheDocument();
    expect(screen.getByText(h.noMaterialComparison(h.slotLabels.BEFORE_DINNER))).toBeInTheDocument();
    expect(screen.getAllByText("Evidence windows: recent 20 Sep – 4 Oct 2026; earlier comparison 23 Aug – 20 Sep 2026.")).toHaveLength(2);
    expect(screen.getByText(h.correctionUpdated)).toBeInTheDocument();
    expect(screen.getByText(h.repeatedItem("Kaya toast", 3, 3))).toBeInTheDocument();
    expect(screen.getByText(h.repeatedContext("Morning walk", 2, 2))).toBeInTheDocument();
    expect(screen.getByText("No reading was recorded for Tuesday evening and Wednesday evening.")).toBeInTheDocument();
    expect(screen.getByText(h.sourceSummary(h.sourcePatientEntered))).toBeInTheDocument();
    expect(screen.getByText(h.correctionSummary(1))).toBeInTheDocument();
    expect(screen.getByText(h.nonCausalLimitation)).toBeInTheDocument();
    expect(screen.getByText(h.loggingLimitation)).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: h.bookletTitle })).toBeInTheDocument();
    expect(screen.getByText(h.bookletOnly)).toBeInTheDocument();
    expect(screen.getByText(h.bookletExplanation)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /^Both display positions recorded on Mon 28 Sep/ })).toBeInTheDocument();
    expect(screen.getAllByRole("img", { name: /^1 of 2 display positions recorded on/ })).toHaveLength(2);
  });

  it("loads another period and ignores a stale response", async () => {
    const responses: Record<string, (view: RecordedHistoryView) => void> = {};
    const history = port((period) => new Promise<RecordedHistoryView>((resolve) => (responses[period] = resolve)));
    render(<RecordedHistoryScreen messages={en} locale="en-SG" history={history} selection={selectionRepository().repository} />);
    await act(async () => undefined);
    fireEvent.click(screen.getByRole("radio", { name: en.history.periodLastWeek }));
    await act(async () => undefined);
    expect(history.load).toHaveBeenLastCalledWith({ period: "LAST_WEEK" });
    await act(async () => responses.LAST_WEEK!({ status: "EMPTY", period: "LAST_WEEK", range: { startDate: "2026-09-21", endDate: "2026-09-27" }, unavailableFamilies: [] } as unknown as RecordedHistoryView));
    await act(async () => responses.THIS_WEEK!(readyView()));
    expect(screen.getByText(en.history.emptyTitle)).toBeInTheDocument();
    expect(screen.getByText(en.history.emptyBody)).toBeInTheDocument();
    expect(screen.queryByText(en.history.factsTitle)).not.toBeInTheDocument();
  });

  it("explains insufficient evidence while still showing recorded counts", async () => {
    const view = readyView();
    if (view.status !== "READY") throw new Error();
    await renderScreen(port({ ...view, status: "INSUFFICIENT_EVIDENCE", comparisons: [] } as RecordedHistoryView));
    expect(screen.getByText(en.history.insufficientTitle)).toBeInTheDocument();
    expect(screen.getByText(en.history.insufficientBody)).toBeInTheDocument();
    expect(screen.getByText(en.history.valueRange("5.9", "8.4", "mmol/L"))).toBeInTheDocument();
  });

  it("shows a truthful unavailable state and retries", async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce({ status: "UNAVAILABLE", code: "STORAGE_UNAVAILABLE" })
      .mockResolvedValueOnce(readyView());
    await renderScreen({ load, loadExplainablePattern: notExplained });
    expect(screen.getByRole("heading", { level: 2, name: en.history.unavailableTitle })).toBeInTheDocument();
    expect(screen.getByText(en.history.unavailableBody)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en.history.retry }));
    await act(async () => undefined);
    expect(load).toHaveBeenCalledTimes(2);
    expect(screen.getByText(en.history.factsTitle)).toBeInTheDocument();
  });

  it("names a disabled comparison family as unavailable without a conclusion", async () => {
    await renderScreen(port(readyView({ unavailableFamilies: ["ROUTINE_SHIFT"] })));
    expect(screen.getByText(en.history.familyUnavailable)).toBeInTheDocument();
  });

  it("saves a user-initiated selection locally and says nothing was sent", async () => {
    const { storage, repository } = selectionRepository();
    await renderScreen(port(readyView()), "en-SG", repository);
    expect(screen.getByText(en.history.actionsTag)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en.history.addFacts }));
    expect(screen.getByRole("status")).toHaveTextContent(en.history.selectionSaved);
    const saved = JSON.parse(storage.getItem(APPOINTMENT_NOTE_SELECTION_KEY)!);
    expect(saved.selections[0].factIds).toHaveLength(11);

    fireEvent.click(screen.getByRole("button", { name: en.history.selectFacts }));
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(11);
    expect(checkboxes.every((box) => (box as HTMLInputElement).checked)).toBe(true);
    expect(screen.getAllByText(en.history.factSelected)).toHaveLength(11);
    fireEvent.click(screen.getByRole("checkbox", { name: en.history.valueRange("5.9", "8.4", "mmol/L") }));
    expect(screen.getAllByText(en.history.factNotSelected)).toHaveLength(1);
    expect(JSON.parse(storage.getItem(APPOINTMENT_NOTE_SELECTION_KEY)!).selections[0].factIds).not.toContain("VALUE_RANGE");
  });

  it("renders zh-SG copy with patient labels verbatim", async () => {
    await renderScreen(port(readyView()), "zh-SG");
    expect(screen.getByRole("heading", { level: 1, name: zh.history.title })).toBeInTheDocument();
    expect(screen.getByText(zh.history.repeatedItem("Kaya toast", 3, 3))).toBeInTheDocument();
    expect(screen.getByText(zh.history.comparisonHigher(zh.history.slotLabels.BEFORE_BREAKFAST, "7.3", "6", "mmol/L"))).toBeInTheDocument();
    expect(screen.getByText(/周二晚上和周三晚上没有读数记录。/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Recorded history|What these records show|Booklet stamps/);
  });

  it("never renders clinical, causal or adherence wording", async () => {
    await renderScreen(port(readyView()));
    const text = (document.body.textContent ?? "").replace(en.history.nonCausalLimitation, "").replace(en.history.loggingLimitation, "");
    for (const pattern of [/\bhigh\b/i, /\blow\b/i, /normal/i, /\bsafe\b/i, /target/i, /risk/i, /missed/i, /adheren/i, /improv/i, /worsen/i, /cause/i]) {
      expect(text).not.toMatch(pattern);
    }
  });
});
