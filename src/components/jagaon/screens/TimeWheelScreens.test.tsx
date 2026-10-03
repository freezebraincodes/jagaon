import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GlucoseRecordViewModel,
  JournalCommandService,
  JournalCommitResult,
  JournalQueryPort,
} from "@/application/journal/journal-contracts";
import { createDemoScenarioFixture } from "@/application/governed/demo-scenario-fixture";
import { getMessages } from "@/i18n/get-messages";
import { dragWheel, stubWheelGeometry } from "../primitives/time-wheel-test-support";
import { GlucoseEntryScreen } from "./GlucoseEntryScreen";
import { InsulinEntryScreen } from "./InsulinEntryScreen";
import { MealEntryScreen } from "./MealEntryScreen";
import { ReadingTimeScreen } from "./ReadingTimeScreen";
import { shiftSingaporeDate, singaporeNowParts, singaporeWallClockToInstant } from "../journal/singapore-time";

/**
 * The Keen Slider time wheel on every screen that records or corrects an
 * occurrence time: wheel drags reach the summary and the submitted command.
 */

const en = getMessages("en-SG");
const zh = getMessages("zh-SG");
const fixture = createDemoScenarioFixture();
const recordId = "00000000-0000-4000-8000-000000000501" as never;
const revisionId = "00000000-0000-4000-8000-000000000502" as never;
const committed: JournalCommitResult = { kind: "COMMITTED", recordId, revisionId };
const today = singaporeNowParts().date;
const yesterday = shiftSingaporeDate(today, -1);

function service(): JournalCommandService {
  return {
    recordGlucose: vi.fn().mockResolvedValue(committed),
    correctGlucoseTime: vi.fn().mockResolvedValue(committed),
    recordInsulin: vi.fn().mockResolvedValue(committed),
    recordMeal: vi.fn().mockResolvedValue(committed),
    recordActivity: vi.fn().mockResolvedValue(committed),
  };
}

const wheel = (name: string) => screen.getByRole("listbox", { name });
const selected = (name: string) => within(wheel(name)).getByRole("option", { selected: true });

const columns = [en.readingTime.hourLabel, en.readingTime.minuteLabel, en.readingTime.periodLabel];

/** Waits until Keen has moved every wheel's selected option into the centre band. */
async function wheelsAtRest() {
  await waitFor(() => {
    for (const name of columns) {
      expect(wheel(name).querySelector('[role="option"][data-centred="true"]')).toBe(selected(name));
    }
  });
}

/** Puts the wheel on 07:48 am with the keyboard, the starting point for each drag. */
async function startAt0748() {
  const set = (name: string, steps: number) => {
    fireEvent.keyDown(wheel(name), { key: "Home" });
    for (let index = 0; index < steps; index += 1) fireEvent.keyDown(wheel(name), { key: "ArrowDown" });
  };
  set(en.readingTime.hourLabel, 6);
  set(en.readingTime.minuteLabel, 48);
  set(en.readingTime.periodLabel, 0);
  await wheelsAtRest();
}

/** Drags 07:48 am to 9:45 pm through Keen Slider, one column at a time. */
async function dragTo2145() {
  await dragWheel(wheel(en.readingTime.hourLabel), 2);
  await waitFor(() => expect(selected(en.readingTime.hourLabel)).toHaveTextContent("9"));
  await dragWheel(wheel(en.readingTime.minuteLabel), -3);
  await waitFor(() => expect(selected(en.readingTime.minuteLabel)).toHaveTextContent("45"));
  await dragWheel(wheel(en.readingTime.periodLabel), 1);
  await waitFor(() => expect(selected(en.readingTime.periodLabel)).toHaveTextContent(en.readingTime.pm));
}

function expectWheelIsPrimary(container: HTMLElement) {
  expect(container.querySelector('input[type="datetime-local"]')).toBeNull();
  for (const name of columns) {
    expect(within(wheel(name)).getAllByRole("option", { selected: true })).toHaveLength(1);
  }
}

function openTimeEditor() {
  fireEvent.click(screen.getByRole("button", { name: en.readingTime.editTime }));
}

const summary = (container: HTMLElement) => container.querySelector(".time-card-value")?.textContent ?? "";
const occurrence = (input: unknown) =>
  (input as { temporal: { occurrence: { instantUtc: string } } }).temporal.occurrence.instantUtc;

beforeEach(() => stubWheelGeometry());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("time wheel on journal screens", () => {
  it("glucose entry: drags update the summary and the submitted time", async () => {
    const commands = service();
    const { container } = render(
      <GlucoseEntryScreen messages={en} locale="en-SG" commandService={commands} goBack={() => undefined} />,
    );
    fireEvent.click(screen.getByRole("radio", { name: en.glucose.contextBedtime }));
    fireEvent.change(screen.getByLabelText(/Reading \(mmol\/L\)/), { target: { value: "5.4" } });
    openTimeEditor();
    fireEvent.click(screen.getByRole("radio", { name: en.readingTime.dayYesterday }));
    expectWheelIsPrimary(container);
    await startAt0748();
    await dragTo2145();
    expect(summary(container)).toMatch(/9:45/);
    fireEvent.click(screen.getByRole("button", { name: en.glucose.saveAction }));
    await waitFor(() => expect(commands.recordGlucose).toHaveBeenCalledTimes(1));
    expect(occurrence(vi.mocked(commands.recordGlucose).mock.calls[0]![0])).toBe(singaporeWallClockToInstant(yesterday, "21:45"));
  });

  it("insulin entry: drags update the summary and the submitted time", async () => {
    const commands = service();
    const { container } = render(
      <InsulinEntryScreen messages={en} locale="en-SG" fixture={fixture} commandService={commands} goBack={() => undefined} />,
    );
    fireEvent.change(screen.getByLabelText(/Amount taken \(units\)/), { target: { value: "8" } });
    openTimeEditor();
    expectWheelIsPrimary(container);
    await startAt0748();
    await dragTo2145();
    expect(summary(container)).toMatch(/9:45/);
    fireEvent.click(screen.getByRole("button", { name: en.insulin.saveAction }));
    await waitFor(() => expect(commands.recordInsulin).toHaveBeenCalledTimes(1));
    expect(occurrence(vi.mocked(commands.recordInsulin).mock.calls[0]![0])).toBe(singaporeWallClockToInstant(today, "21:45"));
  });

  it("meal entry: drags update the summary and the submitted time", async () => {
    const commands = service();
    const { container } = render(
      <MealEntryScreen messages={en} locale="en-SG" fixture={fixture} commandService={commands} goBack={() => undefined} />,
    );
    fireEvent.click(screen.getByRole("radio", { name: en.meal.kindMeal }));
    openTimeEditor();
    expectWheelIsPrimary(container);
    await startAt0748();
    await dragTo2145();
    expect(summary(container)).toMatch(/9:45/);
    fireEvent.click(screen.getByRole("button", { name: en.meal.saveIntake }));
    await waitFor(() => expect(commands.recordMeal).toHaveBeenCalledTimes(1));
    expect(occurrence(vi.mocked(commands.recordMeal).mock.calls[0]![0])).toBe(singaporeWallClockToInstant(today, "21:45"));
  });

  it("reading-time correction: drags update the typed fallback and the submitted time", async () => {
    const stored = singaporeWallClockToInstant(today, "07:48")!;
    const glucose: GlucoseRecordViewModel = {
      recordId,
      revisionId,
      revisionNumber: 1,
      recordedAt: "2026-10-02T00:00:00Z" as never,
      payload: {
        measurement: { enteredValue: "6.2" as never, enteredUnit: "MMOL_L", normalization: null },
        measurementMethod: "FINGERSTICK_METER",
        context: { kind: "PATIENT_SELECTED_SLOT", slot: "BEFORE_BREAKFAST" },
      },
      temporal: {
        kind: "POINT",
        occurrence: { kind: "EXACT", instantUtc: stored, timeZoneId: "Asia/Singapore", utcOffsetMinutes: 480 },
      },
    };
    const queryPort: JournalQueryPort = {
      loadToday: vi.fn(async () => ({ entries: [], unavailable: false })),
      loadGlucose: vi.fn(async () => glucose),
    };
    const commands = service();
    const { container } = render(
      <ReadingTimeScreen messages={en} locale="en-SG" goBack={vi.fn()} recordId={recordId} queryPort={queryPort} commandService={commands} />,
    );
    await screen.findByDisplayValue("07:48");
    fireEvent.click(screen.getByRole("radio", { name: en.readingTime.dayYesterday }));
    expectWheelIsPrimary(container);
    await wheelsAtRest();
    expect(screen.getByText(en.readingTime.typeInstead)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: en.readingTime.useNow })).toBeInTheDocument();
    await dragTo2145();
    expect(screen.getByLabelText(en.readingTime.newTime)).toHaveValue("21:45");
    fireEvent.click(screen.getByRole("button", { name: en.readingTime.saveOccurrence }));
    await waitFor(() => expect(commands.correctGlucoseTime).toHaveBeenCalledTimes(1));
    expect(occurrence(vi.mocked(commands.correctGlucoseTime).mock.calls[0]![0])).toBe(singaporeWallClockToInstant(yesterday, "21:45"));
  });

  it("labels the wheel in zh-SG", () => {
    render(<GlucoseEntryScreen messages={zh} locale="zh-SG" commandService={service()} goBack={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: zh.readingTime.editTime }));
    for (const name of [zh.readingTime.hourLabel, zh.readingTime.minuteLabel, zh.readingTime.periodLabel]) {
      expect(screen.getByRole("listbox", { name })).toBeInTheDocument();
    }
  });
});
