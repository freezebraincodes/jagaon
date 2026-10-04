import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  JournalCommandService,
  JournalCommitResult,
} from "@/application/journal/journal-contracts";
import { createDemoScenarioFixture } from "@/application/governed/demo-scenario-fixture";
import { getMessages } from "@/i18n/get-messages";
import { GlucoseEntryScreen } from "./GlucoseEntryScreen";
import { InsulinEntryScreen } from "./InsulinEntryScreen";
import { MealEntryScreen } from "./MealEntryScreen";
import {
  singaporeNowParts,
  singaporeWallClockToInstant,
} from "../journal/singapore-time";

afterEach(() => cleanup());

const committed: JournalCommitResult = {
  kind: "COMMITTED",
  recordId: "00000000-0000-4000-8000-000000000081" as never,
  revisionId: "00000000-0000-4000-8000-000000000082" as never,
};

const failed: JournalCommitResult = { kind: "FAILED", code: "COMMIT_FAILED" };
const rejected: JournalCommitResult = { kind: "REJECTED", code: "HEAD_CONFLICT" };

const en = getMessages("en-SG");
const zh = getMessages("zh-SG");
const fixture = createDemoScenarioFixture();

/** Wording the journal entry screens must never use (clinical/adherence). */
const PROHIBITED = [
  /\bhigh\b/i, /\blow\b/i, /\bsafe\b/i, /\bnormal\b/i, /\bmissed\b/i, /take now/i,
  /recommend(ed)? dose/i, /\brisk\b/i, /\bcarb/i, /calorie/i, /glycaemic|glycemic/i,
];

function serviceWith(
  overrides: Partial<JournalCommandService> = {},
): JournalCommandService {
  return {
    recordGlucose: vi.fn().mockResolvedValue(committed),
    correctGlucoseTime: vi.fn().mockResolvedValue(committed),
    recordInsulin: vi.fn().mockResolvedValue(committed),
    recordMeal: vi.fn().mockResolvedValue(committed),
    recordActivity: vi.fn().mockResolvedValue(committed),
    ...overrides,
  };
}

/** Drops the per-attempt `recordedAt` stamp so retries can be compared. */
function withoutRecordedAt(input: unknown) {
  const { recordedAt: _recordedAt, ...rest } = input as { recordedAt: string };
  return rest;
}

function todayAt(time: string) {
  return singaporeWallClockToInstant(singaporeNowParts().date, time);
}

function expectNoProhibitedWording(container: HTMLElement, allowed: string[] = []) {
  let text = container.textContent ?? "";
  for (const phrase of allowed) text = text.split(phrase).join(" ");
  for (const pattern of PROHIBITED) expect(text).not.toMatch(pattern);
}

// ---------------------------------------------------------------------------
// Glucose (frame 02)
// ---------------------------------------------------------------------------

function renderGlucose(commands = serviceWith(), locale: "en-SG" | "zh-SG" = "en-SG") {
  const view = render(
    <GlucoseEntryScreen
      messages={getMessages(locale)}
      locale={locale}
      commandService={commands}
      goBack={() => undefined}
    />,
  );
  return { commands, ...view };
}

function glucoseValueInput() {
  return screen.getByLabelText(/Reading \(mmol\/L\)/);
}

function chooseContext(label: string) {
  fireEvent.click(screen.getByRole("radio", { name: label }));
}

function openTimeEditor(editLabel = en.readingTime.editTime) {
  const edit = screen.getByRole("button", { name: editLabel });
  if (edit.getAttribute("aria-expanded") !== "true") fireEvent.click(edit);
}

function setWheelTime(value: string) {
  const [hour24Text = "0", minute = "00"] = value.split(":");
  const hour24 = Number(hour24Text);
  const setColumn = (label: string, steps: number) => {
    const column = screen.getByRole("listbox", { name: label });
    fireEvent.keyDown(column, { key: "Home" });
    for (let index = 0; index < steps; index += 1) fireEvent.keyDown(column, { key: "ArrowDown" });
  };
  setColumn(en.readingTime.hourLabel, (hour24 % 12 === 0 ? 12 : hour24 % 12) - 1);
  setColumn(en.readingTime.minuteLabel, Number(minute));
  setColumn(en.readingTime.periodLabel, hour24 >= 12 ? 1 : 0);
}

function expectWheelTime(value: string) {
  const [hour24Text = "0", minute = "00"] = value.split(":");
  const hour24 = Number(hour24Text);
  const selected = (label: string) =>
    within(screen.getByRole("listbox", { name: label })).getByRole("option", { selected: true });
  expect(selected(en.readingTime.hourLabel)).toHaveTextContent(
    String(hour24 % 12 === 0 ? 12 : hour24 % 12),
  );
  expect(selected(en.readingTime.minuteLabel)).toHaveTextContent(minute);
  expect(selected(en.readingTime.periodLabel)).toHaveTextContent(hour24 >= 12 ? en.readingTime.pm : en.readingTime.am);
}

function setGlucoseTime(value: string) {
  openTimeEditor();
  const [date = "", time = ""] = value.split("T");
  const today = singaporeNowParts().date;
  const yesterday = new Date(`${today}T12:00:00+08:00`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const yesterdayDate = yesterday.toLocaleDateString("en-CA", { timeZone: "Asia/Singapore" });

  if (date === today) {
    fireEvent.click(screen.getByRole("radio", { name: en.readingTime.dayToday }));
  } else if (date === yesterdayDate) {
    fireEvent.click(screen.getByRole("radio", { name: en.readingTime.dayYesterday }));
  } else {
    fireEvent.click(screen.getByRole("radio", { name: en.readingTime.dayOther }));
    fireEvent.change(screen.getByLabelText(en.readingTime.newDate), { target: { value: date } });
  }
  if (time) setWheelTime(time);
}

/** Asserts the day choice that `setGlucoseTime` made for a date, on any test date. */
function expectGlucoseDate(date: string) {
  const today = singaporeNowParts().date;
  const yesterday = new Date(`${today}T12:00:00+08:00`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const yesterdayDate = yesterday.toLocaleDateString("en-CA", { timeZone: "Asia/Singapore" });
  if (date === today) expect(screen.getByRole("radio", { name: en.readingTime.dayToday })).toBeChecked();
  else if (date === yesterdayDate) expect(screen.getByRole("radio", { name: en.readingTime.dayYesterday })).toBeChecked();
  else {
    expect(screen.getByRole("radio", { name: en.readingTime.dayOther })).toBeChecked();
    expect(screen.getByLabelText(en.readingTime.newDate)).toHaveValue(date);
  }
}

describe("glucose entry", () => {
  it("uses the frame 02 title and the five context chips", () => {
    renderGlucose();
    expect(screen.getByRole("heading", { level: 1, name: en.today.recordReading })).toBeInTheDocument();
    const group = screen.getByRole("group", { name: en.glucose.whenQuestion });
    expect(within(group).getAllByRole("radio").map((radio) => radio.closest("label")!.textContent)).toEqual([
      en.glucose.contextBeforeBreakfast,
      en.glucose.contextBeforeLunch,
      en.glucose.contextBeforeDinner,
      en.glucose.contextBedtime,
      en.glucose.contextJustChecking,
    ]);
  });

  it("shows a glucose success only after the command service commits", async () => {
    const { commands } = renderGlucose();
    chooseContext(en.glucose.contextBeforeBreakfast);
    fireEvent.change(glucoseValueInput(), { target: { value: "6.8" } });
    fireEvent.click(screen.getByRole("button", { name: en.glucose.saveAction }));

    expect(await screen.findByText(en.glucose.saved)).toBeInTheDocument();
    expect(commands.recordGlucose).toHaveBeenCalledTimes(1);
  });

  it("requires a context choice instead of guessing one", async () => {
    const { commands } = renderGlucose();
    fireEvent.change(glucoseValueInput(), { target: { value: "6.8" } });
    fireEvent.click(screen.getByRole("button", { name: en.glucose.saveAction }));

    expect(await screen.findByText(en.shared.requiredField)).toBeInTheDocument();
    expect(screen.getByRole("group", { name: en.glucose.whenQuestion })).toHaveAttribute("aria-invalid", "true");
    expect(commands.recordGlucose).not.toHaveBeenCalled();
  });

  it.each(["", "abc", "0", "0.0", "6.8.1", "-4", "6,8", "75", "6.123"])(
    "rejects invalid glucose input %j without calling the service",
    async (value) => {
      const { commands } = renderGlucose();
      chooseContext(en.glucose.contextBedtime);
      fireEvent.change(glucoseValueInput(), { target: { value } });
      fireEvent.click(screen.getByRole("button", { name: en.glucose.saveAction }));

      const error = await screen.findByText(en.glucose.invalidDecimal);
      const input = glucoseValueInput();
      expect(input).toHaveAttribute("aria-invalid", "true");
      expect(input.getAttribute("aria-describedby")).toContain(error.id);
      expect(commands.recordGlucose).not.toHaveBeenCalled();
      expect(screen.queryByText(en.glucose.saved)).not.toBeInTheDocument();
    },
  );

  it("edits the same value from the accessible keypad", () => {
    renderGlucose();
    const keypad = screen.getByRole("group", { name: en.glucose.keypadLabel });
    fireEvent.click(within(keypad).getByRole("button", { name: en.glucose.decimalPoint }));
    expect(glucoseValueInput()).toHaveValue("0.");
    fireEvent.click(within(keypad).getByRole("button", { name: en.glucose.deleteDigit }));
    fireEvent.click(within(keypad).getByRole("button", { name: en.glucose.deleteDigit }));
    for (const key of ["6", en.glucose.decimalPoint, "8"]) {
      fireEvent.click(within(keypad).getByRole("button", { name: key }));
    }
    expect(glucoseValueInput()).toHaveValue("6.8");
    fireEvent.click(within(keypad).getByRole("button", { name: en.glucose.deleteDigit }));
    fireEvent.click(within(keypad).getByRole("button", { name: "9" }));
    // A second decimal point is ignored rather than producing an invalid value.
    fireEvent.click(within(keypad).getByRole("button", { name: en.glucose.decimalPoint }));
    expect(glucoseValueInput()).toHaveValue("6.9");
    expect(within(keypad).getAllByRole("button")).toHaveLength(12);
  });

  it("maps the exact typed value, method, note and Singapore occurrence time", async () => {
    const { commands } = renderGlucose();
    chooseContext(en.glucose.contextBeforeLunch);
    fireEvent.change(glucoseValueInput(), { target: { value: "6.80" } });
    fireEvent.change(screen.getByLabelText(en.glucose.methodLabel), {
      target: { value: "CGM" },
    });
    setGlucoseTime("2026-10-02T07:48");
    fireEvent.change(screen.getByLabelText(`${en.glucose.noteLabel} (${en.shared.optional})`), {
      target: { value: "After my walk" },
    });
    fireEvent.click(screen.getByRole("button", { name: en.glucose.saveAction }));

    await waitFor(() => expect(commands.recordGlucose).toHaveBeenCalledTimes(1));
    const input = vi.mocked(commands.recordGlucose).mock.calls[0]![0];
    expect(input.payload).toEqual({
      measurement: { enteredValue: "6.80", enteredUnit: "MMOL_L", normalization: null },
      measurementMethod: "CGM",
      context: { kind: "PATIENT_SELECTED_SLOT", slot: "BEFORE_LUNCH" },
      patientNote: { text: "After my walk", language: "en-SG" },
    });
    expect(input.temporal).toEqual({
      kind: "POINT",
      occurrence: {
        kind: "EXACT",
        instantUtc: "2026-10-01T23:48:00.000Z",
        timeZoneId: "Asia/Singapore",
        utcOffsetMinutes: 480,
      },
    });
  });

  it.each([
    [en.glucose.contextBeforeBreakfast, "BEFORE_BREAKFAST"],
    [en.glucose.contextBeforeLunch, "BEFORE_LUNCH"],
    [en.glucose.contextBeforeDinner, "BEFORE_DINNER"],
    [en.glucose.contextBedtime, "BEDTIME"],
    [en.glucose.contextJustChecking, "OTHER"],
  ] as const)("maps the %s chip to the %s slot exactly", async (label, slot) => {
    const { commands } = renderGlucose();
    chooseContext(label);
    fireEvent.change(glucoseValueInput(), { target: { value: "5.4" } });
    fireEvent.click(screen.getByRole("button", { name: en.glucose.saveAction }));

    await waitFor(() => expect(commands.recordGlucose).toHaveBeenCalledTimes(1));
    expect(vi.mocked(commands.recordGlucose).mock.calls[0]![0].payload.context).toEqual({
      kind: "PATIENT_SELECTED_SLOT",
      slot,
    });
  });

  it("summarises where the entry goes and reveals the time editor on demand", () => {
    renderGlucose();
    const edit = screen.getByRole("button", { name: en.readingTime.editTime });
    expect(edit).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(edit);
    expect(edit).toHaveAttribute("aria-expanded", "true");
    setGlucoseTime("2026-10-02T07:48");
    chooseContext(en.glucose.contextBeforeBreakfast);
    expect(screen.getByText(/^Goes in your booklet as Before breakfast · /)).toBeInTheDocument();
  });

  it("uses an in-app day and time wheel instead of a browser date-time picker", () => {
    const { container } = renderGlucose();
    fireEvent.click(screen.getByRole("button", { name: en.readingTime.editTime }));

    expect(container.querySelector('input[type="datetime-local"]')).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: en.readingTime.dayToday })).toBeChecked();
    expect(screen.getByRole("radio", { name: en.readingTime.dayYesterday })).not.toBeChecked();
    expect(within(screen.getByRole("listbox", { name: en.readingTime.hourLabel })).getAllByRole("option")).toHaveLength(12);
    expect(within(screen.getByRole("listbox", { name: en.readingTime.minuteLabel })).getAllByRole("option")).toHaveLength(60);
    expect(within(screen.getByRole("listbox", { name: en.readingTime.periodLabel })).getAllByRole("option")).toHaveLength(2);
  });

  it("rejects an occurrence time that is not a real date", async () => {
    const { commands } = renderGlucose();
    chooseContext(en.glucose.contextBedtime);
    fireEvent.change(glucoseValueInput(), { target: { value: "5.4" } });
    setGlucoseTime("");
    fireEvent.click(screen.getByRole("button", { name: en.glucose.saveAction }));

    expect(await screen.findByRole("alert")).toHaveTextContent(en.shared.requiredField);
    expect(screen.getByRole("group", { name: en.glucose.occurrenceTime })).toBeVisible();
    expect(commands.recordGlucose).not.toHaveBeenCalled();
  });

  it("submits from the keyboard through the native form", async () => {
    const { commands } = renderGlucose();
    chooseContext(en.glucose.contextBedtime);
    const input = glucoseValueInput();
    fireEvent.change(input, { target: { value: "7.2" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(commands.recordGlucose).toHaveBeenCalledTimes(1));
  });

  it.each([
    ["FAILED", failed],
    ["REJECTED", rejected],
  ] as const)("retains every input after a %s write and retries with unchanged values", async (_kind, firstResult) => {
    const recordGlucose = vi.fn().mockResolvedValueOnce(firstResult).mockResolvedValueOnce(committed);
    const { commands } = renderGlucose(serviceWith({ recordGlucose }));

    fireEvent.change(glucoseValueInput(), { target: { value: "6.8" } });
    chooseContext(en.glucose.contextBeforeDinner);
    fireEvent.change(screen.getByLabelText(en.glucose.methodLabel), {
      target: { value: "FLASH_SENSOR" },
    });
    setGlucoseTime("2026-10-02T12:10");
    fireEvent.change(screen.getByLabelText(`${en.glucose.noteLabel} (${en.shared.optional})`), {
      target: { value: "felt fine" },
    });
    fireEvent.click(screen.getByRole("button", { name: en.glucose.saveAction }));

    expect(await screen.findByText(en.shared.notSaved)).toBeInTheDocument();
    expect(screen.queryByText(en.glucose.saved)).not.toBeInTheDocument();
    expect(glucoseValueInput()).toHaveValue("6.8");
    expect(screen.getByRole("radio", { name: en.glucose.contextBeforeDinner })).toBeChecked();
    expect(screen.getByLabelText(en.glucose.methodLabel)).toHaveValue("FLASH_SENSOR");
    expectGlucoseDate("2026-10-02");
    expectWheelTime("12:10");
    expect(
      screen.getByLabelText(`${en.glucose.noteLabel} (${en.shared.optional})`),
    ).toHaveValue("felt fine");

    fireEvent.click(screen.getByRole("button", { name: en.glucose.saveAction }));
    expect(await screen.findByText(en.glucose.saved)).toBeInTheDocument();
    expect(screen.queryByText(en.shared.notSaved)).not.toBeInTheDocument();
    expect(commands.recordGlucose).toHaveBeenCalledTimes(2);
    const [first, second] = recordGlucose.mock.calls.map(([input]) => withoutRecordedAt(input));
    expect(second).toEqual(first);
  });

  it("prevents an accidental duplicate save until the entry changes", async () => {
    const { commands } = renderGlucose();
    chooseContext(en.glucose.contextBedtime);
    fireEvent.change(glucoseValueInput(), { target: { value: "6.8" } });
    const save = screen.getByRole("button", { name: en.glucose.saveAction });
    fireEvent.click(save);
    await screen.findByText(en.glucose.saved);
    expect(save).toBeDisabled();
    fireEvent.change(glucoseValueInput(), { target: { value: "6.9" } });
    expect(save).toBeEnabled();
    expect(commands.recordGlucose).toHaveBeenCalledTimes(1);
  });

  it("labels every control in zh-SG", () => {
    renderGlucose(serviceWith(), "zh-SG");
    expect(screen.getByLabelText(new RegExp(`${zh.glucose.valueLabel}`))).toBeInTheDocument();
    openTimeEditor(zh.readingTime.editTime);
    expect(screen.getByRole("group", { name: zh.glucose.occurrenceTime })).toBeInTheDocument();
    expect(screen.getByRole("listbox", { name: zh.readingTime.hourLabel })).toBeInTheDocument();
    expect(screen.getByLabelText(zh.glucose.methodLabel)).toBeInTheDocument();
    expect(screen.getByRole("group", { name: zh.glucose.whenQuestion })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: zh.glucose.keypadLabel })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: zh.glucose.saveAction })).toBeInTheDocument();
  });

  it("never classifies or advises on a reading", () => {
    const { container } = renderGlucose();
    chooseContext(en.glucose.contextBeforeBreakfast);
    fireEvent.change(glucoseValueInput(), { target: { value: "15.2" } });
    // The approved boundary sentence names "high, low or safe" only to deny it.
    expectNoProhibitedWording(container, [en.glucose.noInterpretation]);
  });
});

// ---------------------------------------------------------------------------
// Insulin (frame 04)
// ---------------------------------------------------------------------------

function renderInsulin(commands = serviceWith(), scenario = fixture) {
  const view = render(
    <InsulinEntryScreen
      messages={en}
      locale="en-SG"
      fixture={scenario}
      commandService={commands}
      goBack={() => undefined}
    />,
  );
  return { commands, ...view };
}

function insulinAmountInput() {
  return screen.getByLabelText(/Amount taken \(units\)/);
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const named = (text: string) => new RegExp(escape(text));

const [nocturin, veltora] = fixture.recordedPrescriptions as [
  (typeof fixture.recordedPrescriptions)[number],
  (typeof fixture.recordedPrescriptions)[number],
];

describe("insulin entry", () => {
  it("records insulin through the command service", async () => {
    const { commands } = renderInsulin();
    fireEvent.change(insulinAmountInput(), { target: { value: "8" } });
    fireEvent.click(screen.getByRole("button", { name: en.insulin.saveAction }));

    await waitFor(() => expect(commands.recordInsulin).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(en.insulin.saved)).toBeInTheDocument();
  });

  it("offers the recorded medicines as cards with their recorded generic names", () => {
    renderInsulin();
    const name = (rx: typeof nocturin) => new RegExp(`^${escape(rx.displayName)}\\s*${escape(rx.genericName!)}$`);
    expect(screen.getByRole("radio", { name: name(nocturin) })).toBeChecked();
    expect(screen.getByRole("radio", { name: name(veltora) })).not.toBeChecked();
  });

  it("never offers an arbitrary free-text medicine as insulin", () => {
    const freeTextOnly = {
      ...fixture,
      recordedPrescriptions: [
        {
          ...nocturin,
          medicationId: "demo-medicine:free-text",
          displayName: "Aspirin",
          genericName: null,
          catalogueForm: null,
          hasReviewedInfo: false,
        },
      ],
    };
    renderInsulin(serviceWith(), freeTextOnly);
    expect(screen.queryByRole("radio", { name: /Aspirin/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: en.insulin.saveAction })).toBeDisabled();
  });

  it("sends exactly the selected medicine, typed amount and time", async () => {
    const { commands } = renderInsulin();
    fireEvent.click(screen.getByRole("radio", { name: named(veltora.displayName) }));
    fireEvent.change(insulinAmountInput(), { target: { value: "6.5" } });
    openTimeEditor();
    setWheelTime("12:05");
    fireEvent.change(screen.getByLabelText(`${en.insulin.noteLabel} (${en.shared.optional})`), {
      target: { value: "left arm" },
    });
    fireEvent.click(screen.getByRole("button", { name: en.insulin.saveAction }));

    await waitFor(() => expect(commands.recordInsulin).toHaveBeenCalledTimes(1));
    const input = vi.mocked(commands.recordInsulin).mock.calls[0]![0];
    expect(input.payload).toEqual({
      state: "TAKEN",
      medication: {
        recordType: "MEDICATION",
        recordId: veltora.medicationRecordId,
        revisionId: veltora.medicationRevisionId,
      },
      amountTaken: { kind: "KNOWN", amount: { value: "6.5", unit: "UNIT" } },
      patientNote: { text: "left arm", language: "en-SG" },
    });
    expect(input.temporal).toEqual({
      kind: "POINT",
      occurrence: {
        kind: "EXACT",
        instantUtc: todayAt("12:05"),
        timeZoneId: "Asia/Singapore",
        utcOffsetMinutes: 480,
      },
    });
  });

  it("edits only the typed amount with the − and + controls", () => {
    const { commands } = renderInsulin();
    const minus = screen.getByRole("button", { name: en.insulin.decreaseUnits });
    const plus = screen.getByRole("button", { name: en.insulin.increaseUnits });
    // Starts empty: nothing is pre-filled from the recorded prescription.
    expect(insulinAmountInput()).toHaveValue("");
    expect(screen.getByText(en.insulin.notEnteredYet)).toBeInTheDocument();
    expect(minus).toBeDisabled();
    fireEvent.click(plus);
    expect(insulinAmountInput()).toHaveValue("1");
    fireEvent.click(plus);
    fireEvent.click(minus);
    expect(insulinAmountInput()).toHaveValue("1");
    fireEvent.change(insulinAmountInput(), { target: { value: "6.5" } });
    fireEvent.click(plus);
    expect(insulinAmountInput()).toHaveValue("7.5");
    fireEvent.change(insulinAmountInput(), { target: { value: "1" } });
    fireEvent.click(minus);
    expect(insulinAmountInput()).toHaveValue("");
    expect(commands.recordInsulin).not.toHaveBeenCalled();
  });

  it("keeps save disabled until a positive amount is entered", () => {
    renderInsulin();
    const save = screen.getByRole("button", { name: en.insulin.saveAction });
    for (const value of ["", "0", "abc", "-2"]) {
      fireEvent.change(insulinAmountInput(), { target: { value } });
      expect(save).toBeDisabled();
      expect(screen.getByText(en.insulin.enterUnitsToSave)).toBeInTheDocument();
    }
    fireEvent.change(insulinAmountInput(), { target: { value: "4" } });
    expect(save).toBeEnabled();
    expect(screen.queryByText(en.insulin.enterUnitsToSave)).not.toBeInTheDocument();
  });

  it.each(["101", "1.234"])("rejects out-of-format amount %j without calling the service", async (value) => {
    const { commands } = renderInsulin();
    fireEvent.change(insulinAmountInput(), { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: en.insulin.saveAction }));
    expect(await screen.findByText(en.shared.invalidValue)).toBeInTheDocument();
    expect(insulinAmountInput()).toHaveAttribute("aria-invalid", "true");
    expect(commands.recordInsulin).not.toHaveBeenCalled();
  });

  it("shows the selected medicine's recorded schedule and direction verbatim with its source", () => {
    renderInsulin();
    expect(screen.getByText(nocturin.recordedDirection!)).toBeInTheDocument();
    expect(screen.getByText(en.onboarding.sourcePrescriptionLabel)).toBeInTheDocument();
    expect(
      screen.getByText(`${en.insulin.prescriptionSchedule}: ${nocturin.amountText}, ${nocturin.timingText}`),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: named(veltora.displayName) }));
    expect(screen.getByText(veltora.recordedDirection!)).toBeInTheDocument();
    expect(screen.queryByText(nocturin.recordedDirection!)).not.toBeInTheDocument();
  });

  it("shows correction history as a disabled later-packet row", () => {
    renderInsulin();
    const row = screen.getByRole("group", { name: en.insulin.correctionHistory });
    expect(row).toHaveAttribute("aria-disabled", "true");
    expect(row).toHaveTextContent(en.today.futureFeature);
  });

  it("retains input after a failed write and retries with unchanged values", async () => {
    const recordInsulin = vi.fn().mockResolvedValueOnce(failed).mockResolvedValueOnce(committed);
    renderInsulin(serviceWith({ recordInsulin }));
    fireEvent.click(screen.getByRole("radio", { name: named(veltora.displayName) }));
    fireEvent.change(insulinAmountInput(), { target: { value: "4" } });
    openTimeEditor();
    setWheelTime("11:55");
    fireEvent.click(screen.getByRole("button", { name: en.insulin.saveAction }));

    expect(await screen.findByText(en.shared.notSaved)).toBeInTheDocument();
    expect(screen.queryByText(en.insulin.saved)).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: named(veltora.displayName) })).toBeChecked();
    expect(insulinAmountInput()).toHaveValue("4");
    expectWheelTime("11:55");

    fireEvent.click(screen.getByRole("button", { name: en.insulin.saveAction }));
    expect(await screen.findByText(en.insulin.saved)).toBeInTheDocument();
    const [first, second] = recordInsulin.mock.calls.map(([input]) => withoutRecordedAt(input));
    expect(second).toEqual(first);
  });

  it("never suggests, calculates or compares doses", () => {
    const { container } = renderInsulin();
    fireEvent.change(insulinAmountInput(), { target: { value: "30" } });
    expectNoProhibitedWording(container);
    expect(container.textContent).not.toMatch(/too (much|many|little)|more than prescribed|suggested/i);
  });
});

// ---------------------------------------------------------------------------
// Meal (frame 05)
// ---------------------------------------------------------------------------

function renderMeal(commands = serviceWith()) {
  const view = render(
    <MealEntryScreen
      messages={en}
      locale="en-SG"
      fixture={fixture}
      commandService={commands}
      goBack={() => undefined}
    />,
  );
  return { commands, ...view };
}

function lastMealPayload(commands: JournalCommandService) {
  const calls = vi.mocked(commands.recordMeal).mock.calls;
  return calls[calls.length - 1]![0].payload;
}

describe("meal entry", () => {
  it("records a meal through the command service", async () => {
    const { commands } = renderMeal();
    fireEvent.click(screen.getByRole("radio", { name: en.meal.kindMeal }));
    fireEvent.click(screen.getByRole("button", { name: en.meal.saveIntake }));

    await waitFor(() => expect(commands.recordMeal).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(en.meal.saved)).toBeInTheDocument();
  });

  it("keeps save disabled until a category or an item is chosen", () => {
    renderMeal();
    const save = screen.getByRole("button", { name: en.meal.saveIntake });
    expect(save).toBeDisabled();
    expect(screen.getByText(en.meal.chooseToSave)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Kaya toast/ }));
    expect(save).toBeEnabled();
  });

  it.each([
    [en.meal.kindMeal, { intakeKind: "MEAL", foodIncluded: "YES", drinkIncluded: "UNKNOWN" }],
    [en.meal.kindSnack, { intakeKind: "SNACK", foodIncluded: "YES", drinkIncluded: "UNKNOWN" }],
    [en.meal.kindTeaWithFood, { intakeKind: "TEA", foodIncluded: "YES", drinkIncluded: "YES" }],
    [en.meal.kindTeaWithoutFood, { intakeKind: "TEA", foodIncluded: "NO", drinkIncluded: "YES" }],
    [en.meal.kindDessert, { intakeKind: "DESSERT", foodIncluded: "YES", drinkIncluded: "UNKNOWN" }],
    [en.meal.kindDrink, { intakeKind: "DRINK", foodIncluded: "UNKNOWN", drinkIncluded: "YES" }],
    [en.meal.kindNotSure, { intakeKind: "OTHER", foodIncluded: "UNKNOWN", drinkIncluded: "UNKNOWN" }],
  ] as const)("records the %s category exactly", async (label, facts) => {
    const { commands } = renderMeal();
    fireEvent.click(screen.getByRole("radio", { name: label }));
    fireEvent.click(screen.getByRole("button", { name: en.meal.saveIntake }));
    await waitFor(() => expect(commands.recordMeal).toHaveBeenCalledTimes(1));
    expect(lastMealPayload(commands)).toMatchObject(facts);
    expect(lastMealPayload(commands)).not.toHaveProperty("intakeSlot");
  });

  it("adds a meal slot only when Meal is chosen", async () => {
    const { commands } = renderMeal();
    expect(screen.queryByRole("group", { name: /Meal \(Optional\)/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: en.meal.kindMeal }));
    fireEvent.click(screen.getByRole("button", { name: en.meal.lunch }));
    fireEvent.click(screen.getByRole("button", { name: en.meal.saveIntake }));
    await waitFor(() => expect(commands.recordMeal).toHaveBeenCalledTimes(1));
    expect(lastMealPayload(commands).intakeSlot).toEqual({ kind: "STANDARD_MEAL", code: "LUNCH" });
  });

  it("turns selected usuals into the same text the person would type, and nothing more", async () => {
    const { commands } = renderMeal();
    const kaya = screen.getByRole("button", { name: /Kaya toast/ });
    const kopi = screen.getByRole("button", { name: /Kopi C kosong/ });
    const eggs = screen.getByRole("button", { name: /Soft-boiled eggs/ });
    fireEvent.click(kaya);
    fireEvent.click(kopi);
    fireEvent.click(eggs);
    fireEvent.click(eggs);
    expect(kaya).toHaveAttribute("aria-pressed", "true");
    expect(eggs).toHaveAttribute("aria-pressed", "false");
    openTimeEditor();
    setWheelTime("08:10");
    fireEvent.click(screen.getByRole("button", { name: en.meal.saveIntake }));

    await waitFor(() => expect(commands.recordMeal).toHaveBeenCalledTimes(1));
    const input = vi.mocked(commands.recordMeal).mock.calls[0]![0];
    expect(input.payload).toEqual({
      intakeKind: "OTHER",
      foodIncluded: "UNKNOWN",
      drinkIncluded: "UNKNOWN",
      occasion: "ROUTINE",
      items: [
        { kind: "FOOD", label: "Kaya toast", quantityText: "2 slices" },
        { kind: "DRINK", label: "Kopi C kosong", quantityText: "1 cup" },
      ],
    });
    expect(input.temporal.occurrence).toEqual({
      kind: "EXACT",
      instantUtc: todayAt("08:10"),
      timeZoneId: "Asia/Singapore",
      utcOffsetMinutes: 480,
    });
  });

  it("records the chosen portion with the person's own note", async () => {
    const { commands } = renderMeal();
    fireEvent.click(screen.getByRole("radio", { name: en.meal.kindSnack }));
    const portion = screen.getByRole("group", { name: en.meal.portionLabel });
    fireEvent.click(within(portion).getByRole("button", { name: en.meal.portionSmall }));
    fireEvent.click(within(portion).getByRole("button", { name: en.meal.portionBig }));
    expect(within(portion).getByRole("button", { name: en.meal.portionBig })).toHaveAttribute("aria-pressed", "true");
    expect(within(portion).getByRole("button", { name: en.meal.portionSmall })).toHaveAttribute("aria-pressed", "false");
    fireEvent.change(screen.getByLabelText(`${en.meal.noteLabel} (${en.shared.optional})`), {
      target: { value: "with family" },
    });
    fireEvent.click(screen.getByRole("button", { name: en.meal.saveIntake }));
    await waitFor(() => expect(commands.recordMeal).toHaveBeenCalledTimes(1));
    expect(lastMealPayload(commands).patientNote).toEqual({
      text: `${en.meal.portionNote(en.meal.portionBig)}\nwith family`,
      language: "en-SG",
    });
  });

  it("adds, names and removes a 'Something else' item", async () => {
    const { commands } = renderMeal();
    fireEvent.click(screen.getByRole("button", { name: en.meal.somethingElse }));
    fireEvent.change(screen.getByLabelText(en.meal.itemLabel), { target: { value: "Fish ball noodles" } });
    fireEvent.change(screen.getByLabelText(en.meal.quantityLabel), { target: { value: "1 bowl" } });
    fireEvent.click(screen.getByRole("button", { name: en.meal.addItem }));
    fireEvent.change(screen.getByLabelText(`${en.meal.itemLabel} 2`), { target: { value: "Teh O" } });
    fireEvent.click(screen.getByRole("button", { name: en.meal.removeItem("Teh O") }));
    expect(screen.queryByDisplayValue("Teh O")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en.meal.saveIntake }));
    await waitFor(() => expect(commands.recordMeal).toHaveBeenCalledTimes(1));
    expect(lastMealPayload(commands).items).toEqual([
      { kind: "FOOD", label: "Fish ball noodles", quantityText: "1 bowl" },
    ]);
  });

  it("retains every choice after a failed write and retries with unchanged values", async () => {
    const recordMeal = vi.fn().mockResolvedValueOnce(failed).mockResolvedValueOnce(committed);
    renderMeal(serviceWith({ recordMeal }));
    fireEvent.click(screen.getByRole("radio", { name: en.meal.kindMeal }));
    fireEvent.click(screen.getByRole("button", { name: en.meal.dinner }));
    fireEvent.click(screen.getByRole("button", { name: /Sliced fish soup/ }));
    fireEvent.change(screen.getByLabelText(`${en.meal.noteLabel} (${en.shared.optional})`), {
      target: { value: "with family" },
    });
    fireEvent.click(screen.getByRole("button", { name: en.meal.saveIntake }));

    expect(await screen.findByText(en.shared.notSaved)).toBeInTheDocument();
    expect(screen.queryByText(en.meal.saved)).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: en.meal.kindMeal })).toBeChecked();
    expect(screen.getByRole("button", { name: en.meal.dinner })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Sliced fish soup/ })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: en.meal.saveIntake }));
    expect(await screen.findByText(en.meal.saved)).toBeInTheDocument();
    const [first, second] = recordMeal.mock.calls.map(([input]) => withoutRecordedAt(input));
    expect(second).toEqual(first);
  });

  it("never judges the meal or estimates nutrition", () => {
    const { container } = renderMeal();
    fireEvent.click(screen.getByRole("button", { name: /Chicken rice/ }));
    expectNoProhibitedWording(container);
  });
});
