import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { Instant } from "@/domain/shared/time";
import { getMessages } from "@/i18n/get-messages";
import { createMemoryOnboardingStorage } from "@/application/onboarding/demo-onboarding-repository";
import { createAppointmentNoteSelectionRepository } from "@/application/history/appointment-note-selection";
import type { RecordedHistoryQueryPort, RecordedHistoryView } from "@/application/history/recorded-history-contracts";
import type { HabitTrend, PreviewInsightsQueryPort } from "@/application/preview/preview-insights-contracts";
import { HSA_BOUNDED_MODE_STORAGE_KEY, HsaBoundedModeProvider, resetHsaBoundedModeForTests } from "../hsa/hsa-bounded-mode";
import { RecordedHistoryScreen } from "./RecordedHistoryScreen";

const en = getMessages("en-SG");

/** The prepared demo profile's preview trend (see preview-insights-query.test.ts). */
const TREND: HabitTrend = {
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
};

const VIEW: RecordedHistoryView = {
  status: "INSUFFICIENT_EVIDENCE",
  unavailableFamilies: [],
  comparisons: [],
  projection: {
    period: "THIS_WEEK",
    range: { startDate: "2026-10-12", endDate: "2026-10-14" },
    unit: "MMOL_L",
    readingCount: 1,
    valueRange: { minimum: "5.9", maximum: "5.9" },
    slotCounts: [{ slot: "BEFORE_BREAKFAST", count: 1 }],
    chart: [
      { date: "2026-10-13", position: "MORNING", state: "RECORDED", valueMmolL: "5.9", readingCount: 1, readings: [{ valueMmolL: "5.9", at: "2026-10-12T23:27:00.000Z" }] },
    ],
    notRecordedPositions: [],
    stamps: [{ date: "2026-10-13", recordedPositions: 1, complete: false }],
    source: "PATIENT_ENTERED",
    correctedRecordCount: 0,
    repeated: [],
    selectableFactIds: ["READING_COUNT", "VALUE_RANGE", "SLOT_COUNT:BEFORE_BREAKFAST", "SOURCE"],
  },
} as unknown as RecordedHistoryView;

function historyPort(view: RecordedHistoryView = VIEW): RecordedHistoryQueryPort {
  return { load: vi.fn(async () => view), loadExplainablePattern: vi.fn(async () => ({ kind: "INELIGIBLE" as const, reason: "NOT_FOUND" as const })) };
}

function previewPort(trend: HabitTrend | null = TREND): PreviewInsightsQueryPort & { habitTrend: ReturnType<typeof vi.fn> } {
  return { habitTrend: vi.fn(async () => trend) };
}

function renderHistory(previewInsights: PreviewInsightsQueryPort, view?: RecordedHistoryView) {
  const selection = createAppointmentNoteSelectionRepository(createMemoryOnboardingStorage(), () => "2026-10-14T02:00:00.000Z" as Instant);
  return render(
    <HsaBoundedModeProvider>
      <RecordedHistoryScreen messages={en} locale="en-SG" history={historyPort(view)} selection={selection} previewInsights={previewInsights} />
    </HsaBoundedModeProvider>,
  );
}

describe("History: 'What changed alongside' preview (HSA-bounded mode, owner decision 2026-10-14)", () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    resetHsaBoundedModeForTests();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
    });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("ON (the default): History is unchanged and the preview is never read", async () => {
    const preview = previewPort();
    renderHistory(preview);
    await screen.findByRole("heading", { name: en.history.readingsTitle("mmol/L") });
    expect(screen.queryByRole("heading", { name: en.hsaTrend.title })).toBeNull();
    expect(screen.queryByText(en.hsa.previewTag)).toBeNull();
    expect(screen.queryByText(en.hsaTrend.notEnough)).toBeNull();
    expect(preview.habitTrend).not.toHaveBeenCalled();
  });

  it("OFF: shows the trend with its numbers in text, the Preview tag and the timing-not-proof note", async () => {
    store.set(HSA_BOUNDED_MODE_STORAGE_KEY, "off");
    const preview = previewPort();
    renderHistory(preview);
    const heading = await screen.findByRole("heading", { name: en.hsaTrend.title });
    const card = heading.closest("section")!;
    const inCard = within(card as HTMLElement);
    expect(inCard.getByText(en.hsa.previewTag)).toBeInTheDocument();
    expect(inCard.getByText("Before-breakfast glucose 20% lower")).toBeInTheDocument();
    expect(inCard.getByText("in the 16 days since you started recording “Morning walk” (9 times recorded)")).toBeInTheDocument();
    expect(inCard.getByText("Before")).toBeInTheDocument();
    expect(inCard.getByText("7.6")).toBeInTheDocument();
    expect(inCard.getByText("After")).toBeInTheDocument();
    expect(inCard.getByText("6.1")).toBeInTheDocument();
    expect(card).toHaveTextContent("Median mmol/L · From 23 readings before and 11 after.");
    expect(inCard.getByText("This shows timing, not proof that “Morning walk” caused it. Many things affect glucose.")).toBeInTheDocument();
    // Never better/worse/improved wording.
    expect(card.textContent).not.toMatch(/better|worse|improv/i);
    expect(preview.habitTrend).toHaveBeenCalledTimes(1);
  });

  it("OFF with nothing that qualifies: one short 'not enough records' line, no card", async () => {
    store.set(HSA_BOUNDED_MODE_STORAGE_KEY, "off");
    renderHistory(previewPort(null));
    expect(await screen.findByText(en.hsaTrend.notEnough)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: en.hsaTrend.title })).toBeNull();
  });

  it("OFF: also shown when the selected period has no readings", async () => {
    store.set(HSA_BOUNDED_MODE_STORAGE_KEY, "off");
    renderHistory(previewPort(), { status: "EMPTY", period: "THIS_WEEK", range: { startDate: "2026-10-12", endDate: "2026-10-14" }, unavailableFamilies: [] } as unknown as RecordedHistoryView);
    await screen.findByRole("heading", { name: en.history.emptyTitle });
    expect(await screen.findByRole("heading", { name: en.hsaTrend.title })).toBeInTheDocument();
  });
});
