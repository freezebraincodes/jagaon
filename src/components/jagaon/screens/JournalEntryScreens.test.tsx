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
  shiftSingaporeDate,
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

  // CR-11 (owner decisions 2026-10-11): "0", "0.0" and "75" are no longer refused (they go through the confirmation step; see the
  // CR-11 describe below). Malformed text is refused while typing (the field keeps its last valid text) and again on Save.
  it.each(["", "abc", "6.8.1", "-4", "6,8", "6.123"])(
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
    // A second decimal point is refused (CR-11: with a message) rather than producing an invalid value.
    fireEvent.click(within(keypad).getByRole("button", { name: en.glucose.decimalPoint }));
    expect(glucoseValueInput()).toHaveValue("6.9");
    expect(screen.getByText(en.glucose.formatRefused)).toBeInTheDocument();
    expect(within(keypad).getAllByRole("button")).toHaveLength(12);
  });

  // CR-11 (owner R-4 formatting rule): this pinned a manual "6.80" save. Two decimals are now refused for NEW entries, so the typed
  // value is "6.8" (stored "6.8"); historical "6.80" records are covered by the History/Today/care/export precision tests.
  it("maps the exact typed value, method, note and Singapore occurrence time", async () => {
    const { commands } = renderGlucose();
    chooseContext(en.glucose.contextBeforeLunch);
    fireEvent.change(glucoseValueInput(), { target: { value: "6.80" } });
    expect(glucoseValueInput()).toHaveValue("");
    expect(screen.getByText(en.glucose.formatRefused)).toBeInTheDocument();
    fireEvent.change(glucoseValueInput(), { target: { value: "6.8" } });
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
      measurement: { enteredValue: "6.8", enteredUnit: "MMOL_L", normalization: null },
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

  it("refuses a time later than now with a message and saves nothing until the time has passed", async () => {
    const { commands } = renderGlucose();
    chooseContext(en.glucose.contextBeforeBreakfast);
    fireEvent.change(glucoseValueInput(), { target: { value: "6.2" } });
    const tomorrow = shiftSingaporeDate(singaporeNowParts().date, 1);
    setGlucoseTime(`${tomorrow}T07:40`);
    fireEvent.click(screen.getByRole("button", { name: en.glucose.saveAction }));

    expect(await screen.findByRole("alert")).toHaveTextContent(en.readingTime.laterThanNow);
    expect(screen.getByRole("group", { name: en.glucose.occurrenceTime })).toBeVisible();
    expect(commands.recordGlucose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("radio", { name: en.readingTime.dayYesterday }));
    expect(screen.queryByText(en.readingTime.laterThanNow)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en.glucose.saveAction }));
    await waitFor(() => expect(commands.recordGlucose).toHaveBeenCalledTimes(1));
  });

  it("refuses a time later than now before the confirmation step for 60", async () => {
    const { commands } = renderGlucose();
    chooseContext(en.glucose.contextBeforeBreakfast);
    fireEvent.change(glucoseValueInput(), { target: { value: "60" } });
    setGlucoseTime(`${shiftSingaporeDate(singaporeNowParts().date, 1)}T07:40`);
    fireEvent.click(screen.getByRole("button", { name: en.glucose.saveAction }));

    expect(await screen.findByRole("alert")).toHaveTextContent(en.readingTime.laterThanNow);
    expect(screen.queryByRole("button", { name: en.glucose.saveAsShown })).not.toBeInTheDocument();
    expect(commands.recordGlucose).not.toHaveBeenCalled();
  });

  it("starts the next entry at the time now after a save, so it never inherits the saved entry's edited time", async () => {
    const { commands } = renderGlucose();
    chooseContext(en.glucose.contextBeforeBreakfast);
    fireEvent.change(glucoseValueInput(), { target: { value: "6.2" } });
    const yesterday = shiftSingaporeDate(singaporeNowParts().date, -1);
    setGlucoseTime(`${yesterday}T07:40`);
    fireEvent.click(screen.getByRole("button", { name: en.glucose.saveAction }));
    await screen.findByText(en.glucose.saved);

    fireEvent.change(glucoseValueInput(), { target: { value: "5.8" } });
    fireEvent.click(screen.getByRole("button", { name: en.glucose.saveAction }));
    await waitFor(() => expect(commands.recordGlucose).toHaveBeenCalledTimes(2));

    const instants = vi.mocked(commands.recordGlucose).mock.calls.map(([input]) =>
      input.temporal.kind === "POINT" && input.temporal.occurrence.kind === "EXACT" ? input.temporal.occurrence.instantUtc : null,
    );
    expect(instants[0]).toBe(singaporeWallClockToInstant(yesterday, "07:40"));
    // The time now, at the wheel's whole-minute precision.
    expect(Math.abs(Date.parse(instants[1]!) - Date.now())).toBeLessThan(2 * 60_000);
  });

  it("shows the next entry's day as today after an entry saved for another date", async () => {
    renderGlucose();
    chooseContext(en.glucose.contextBeforeBreakfast);
    fireEvent.change(glucoseValueInput(), { target: { value: "6.2" } });
    setGlucoseTime(`${shiftSingaporeDate(singaporeNowParts().date, -3)}T07:40`);
    fireEvent.click(screen.getByRole("button", { name: en.glucose.saveAction }));
    await screen.findByText(en.glucose.saved);

    fireEvent.change(glucoseValueInput(), { target: { value: "5.8" } });
    openTimeEditor();
    expect(screen.getByRole("radio", { name: en.readingTime.dayToday })).toBeChecked();
    expect(screen.queryByLabelText(en.readingTime.newDate)).not.toBeInTheDocument();
  });

  it("keeps a time chosen after a save for the next entry", async () => {
    const { commands } = renderGlucose();
    chooseContext(en.glucose.contextBeforeBreakfast);
    fireEvent.change(glucoseValueInput(), { target: { value: "6.2" } });
    fireEvent.click(screen.getByRole("button", { name: en.glucose.saveAction }));
    await screen.findByText(en.glucose.saved);

    const yesterday = shiftSingaporeDate(singaporeNowParts().date, -1);
    setGlucoseTime(`${yesterday}T21:15`);
    fireEvent.change(glucoseValueInput(), { target: { value: "5.8" } });
    fireEvent.click(screen.getByRole("button", { name: en.glucose.saveAction }));
    await waitFor(() => expect(commands.recordGlucose).toHaveBeenCalledTimes(2));
    expect(vi.mocked(commands.recordGlucose).mock.calls[1]![0].temporal).toEqual(
      expect.objectContaining({ occurrence: expect.objectContaining({ instantUtc: singaporeWallClockToInstant(yesterday, "21:15") }) }),
    );
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

// ---------------------------------------------------------------------------
// CR-11: number-and-unit confirmation instead of a maximum (design v3.1; EN and ZH)
// ---------------------------------------------------------------------------

describe.each(["en-SG", "zh-SG"] as const)("CR-11 manual glucose confirmation (%s)", (locale) => {
  const m = getMessages(locale);
  const valueInput = () => screen.getByLabelText(new RegExp(m.glucose.valueLabel)) as HTMLInputElement;
  const keypad = () => screen.getByRole("group", { name: m.glucose.keypadLabel });
  const press = (...keys: string[]) => {
    for (const key of keys) fireEvent.click(within(keypad()).getByRole("button", { name: key === "." ? m.glucose.decimalPoint : key }));
  };
  const start = (value: string, commands = serviceWith()) => {
    const view = renderGlucose(commands, locale);
    fireEvent.click(screen.getByRole("radio", { name: m.glucose.contextBedtime }));
    fireEvent.change(valueInput(), { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: m.glucose.saveAction }));
    return view;
  };
  const panel = () => screen.getByRole("region", { name: new RegExp(`${m.glucose.unit}$`) });
  const stored = (commands: JournalCommandService) => vi.mocked(commands.recordGlucose).mock.calls.map(([input]) => input.payload.measurement.enteredValue);

  it("AC-1 / AC-2: 60 opens the confirmation with \"60.0 mmol/L\", sentences 1–2 and the three controls; Save as shown stores 60.0 once", async () => {
    const { commands, container } = start("60");
    const region = panel();
    expect(within(region).getByRole("heading", { name: `60.0 ${m.glucose.unit}` })).toHaveFocus();
    expect(within(region).getByText(m.glucose.confirmBody)).toBeInTheDocument();
    expect(within(region).getAllByRole("button").map((button) => button.textContent)).toEqual([m.glucose.saveAsShown, m.glucose.editReading, m.glucose.cancelConfirm]);
    expect(valueInput()).toHaveValue("60.0");
    expect(commands.recordGlucose).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: m.glucose.saveAction })).not.toBeInTheDocument();
    expectNoProhibitedWording(container, [m.glucose.noInterpretation]);
    expect(container.textContent).not.toMatch(/verified|核实无误|已验证/i);
    fireEvent.click(within(region).getByRole("button", { name: m.glucose.saveAsShown }));
    expect(await screen.findByText(m.glucose.saved)).toBeInTheDocument();
    expect(stored(commands)).toEqual(["60.0"]);
    expect(vi.mocked(commands.recordGlucose).mock.calls[0]![0].payload.measurement).toEqual({ enteredValue: "60.0", enteredUnit: "MMOL_L", normalization: null });
    expect(screen.queryByText(m.glucose.confirmBody)).not.toBeInTheDocument();
  });

  it("AC-3: the latch: Edit reading to 45 still returns to the confirmation; saved as 45.0", async () => {
    const { commands } = start("60");
    fireEvent.click(within(panel()).getByRole("button", { name: m.glucose.editReading }));
    expect(valueInput()).toHaveFocus();
    expect(screen.queryByText(m.glucose.confirmBody)).not.toBeInTheDocument();
    fireEvent.change(valueInput(), { target: { value: "45" } });
    fireEvent.click(screen.getByRole("button", { name: m.glucose.saveAction }));
    expect(within(panel()).getByRole("heading", { name: `45.0 ${m.glucose.unit}` })).toBeInTheDocument();
    expect(commands.recordGlucose).not.toHaveBeenCalled();
    fireEvent.click(within(panel()).getByRole("button", { name: m.glucose.saveAsShown }));
    await screen.findByText(m.glucose.saved);
    expect(stored(commands)).toEqual(["45.0"]);
  });

  it("AC-4 / AC-5: Cancel writes nothing and keeps the value; Save again re-enters the confirmation; nothing saves before Save as shown", async () => {
    const { commands } = start("60");
    fireEvent.click(within(panel()).getByRole("button", { name: m.glucose.cancelConfirm }));
    // Fix round 3 (ruling 7): Cancel returns focus to the field, which shows what was typed ("60"; the ".0" was added automatically).
    expect(valueInput()).toHaveFocus();
    expect(valueInput()).toHaveValue("60");
    fireEvent.blur(valueInput());
    expect(valueInput()).toHaveValue("60.0");
    expect(commands.recordGlucose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: m.glucose.saveAction }));
    expect(panel()).toBeInTheDocument();
    fireEvent.click(within(panel()).getByRole("button", { name: m.glucose.cancelConfirm }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(commands.recordGlucose).not.toHaveBeenCalled();
    expect(screen.queryByText(m.glucose.saved)).not.toBeInTheDocument();
  });

  it("AC-6: a double press on Save as shown gives exactly one write", async () => {
    let release: (result: JournalCommitResult) => void = () => undefined;
    const recordGlucose = vi.fn().mockImplementation(() => new Promise<JournalCommitResult>((resolve) => (release = resolve)));
    const { commands } = start("60", serviceWith({ recordGlucose }));
    const saveAsShown = within(panel()).getByRole("button", { name: m.glucose.saveAsShown });
    fireEvent.click(saveAsShown);
    fireEvent.click(saveAsShown);
    release(committed);
    await screen.findByText(m.glucose.saved);
    expect(commands.recordGlucose).toHaveBeenCalledTimes(1);
  });

  it("AC-7: zero shows \"0.0 mmol/L\" in the confirmation and saves only after Save as shown", async () => {
    for (const typed of ["0", "0.0"]) {
      const { commands, unmount } = start(typed);
      expect(within(panel()).getByRole("heading", { name: `0.0 ${m.glucose.unit}` })).toBeInTheDocument();
      expect(commands.recordGlucose).not.toHaveBeenCalled();
      fireEvent.click(within(panel()).getByRole("button", { name: m.glucose.saveAsShown }));
      await screen.findByText(m.glucose.saved);
      expect(stored(commands), typed).toEqual(["0.0"]);
      unmount();
    }
  });

  it("AC-8: completion formats to one decimal (0 → 0.0, 9 → 9.0, 9.2 → 9.2, 60 → 60.0); no forced .0 while typing", async () => {
    for (const [typed, expected] of [["9", "9.0"], ["9.2", "9.2"], ["9.", "9.0"], ["50", "50.0"]] as const) {
      const { commands, unmount } = start(typed);
      await screen.findByText(m.glucose.saved);
      expect(stored(commands), typed).toEqual([expected]);
      unmount();
    }
    renderGlucose(serviceWith(), locale);
    press("9");
    expect(valueInput()).toHaveValue("9");
    press(".");
    expect(valueInput()).toHaveValue("9.");
    press("2");
    expect(valueInput()).toHaveValue("9.2");
    fireEvent.change(valueInput(), { target: { value: "9" } });
    fireEvent.blur(valueInput());
    expect(valueInput()).toHaveValue("9.0");
    fireEvent.focus(valueInput());
    expect(valueInput()).toHaveValue("9");
    fireEvent.blur(valueInput());
    expect(valueInput()).toHaveValue("9.0");
    // A keypad tap after completion formatting continues from what was typed, never from the added ".0".
    press("2");
    expect(valueInput()).toHaveValue("92");
  });

  it("AC-9 / AC-10: one separator and one fractional digit, by keypad, typing and paste; refused with a message, never trimmed or rounded", async () => {
    const commands = serviceWith();
    renderGlucose(commands, locale);
    press("9", ".", "2", "5");
    expect(valueInput()).toHaveValue("9.2");
    expect(screen.getByText(m.glucose.formatRefused)).toBeInTheDocument();
    press(".");
    expect(valueInput()).toHaveValue("9.2");
    for (const pasted of ["9.25", "60.00", "6..5"]) {
      fireEvent.change(valueInput(), { target: { value: pasted } });
      expect(valueInput(), pasted).toHaveValue("9.2");
      expect(screen.getByText(m.glucose.formatRefused)).toBeInTheDocument();
    }
    fireEvent.change(valueInput(), { target: { value: "" } });
    expect(screen.queryByText(m.glucose.formatRefused)).not.toBeInTheDocument();
    fireEvent.change(valueInput(), { target: { value: "9.25" } });
    expect(valueInput()).toHaveValue("");
    expect(commands.recordGlucose).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toMatch(/9\.3|9\.2(?!5)/);
  });

  it("AC-11: no hidden ceiling: 100, 999.5 and 1234.5 confirm and save formatted", async () => {
    for (const [typed, expected] of [["100", "100.0"], ["999.5", "999.5"], ["1234.5", "1234.5"]] as const) {
      const { commands, unmount } = start(typed);
      expect(within(panel()).getByRole("heading", { name: `${expected} ${m.glucose.unit}` })).toBeInTheDocument();
      fireEvent.click(within(panel()).getByRole("button", { name: m.glucose.saveAsShown }));
      await screen.findByText(m.glucose.saved);
      expect(stored(commands), typed).toEqual([expected]);
      unmount();
    }
  });

  it("AC-12: the technical bound: -5, 1e3, abc, 060 and five integer digits are refused while typing; nothing is saved", async () => {
    const commands = serviceWith();
    renderGlucose(commands, locale);
    for (const typed of ["-5", "1e3", "abc", "060", "12345", "1234.56"]) {
      fireEvent.change(valueInput(), { target: { value: typed } });
      expect(valueInput().value, typed).not.toBe(typed);
      expect(screen.getByText(m.glucose.formatRefused)).toBeInTheDocument();
    }
    // Fix round 1 (I-1): no maxlength, so a browser never truncates a paste before the validator sees it.
    expect(valueInput()).not.toHaveAttribute("maxlength");
    expect(commands.recordGlucose).not.toHaveBeenCalled();
  });

  it("I-1: a 7+ character paste (\"1234.56\", or \"4.56\" after a typed \"123\") is refused with the message and leaves the field unchanged", () => {
    const commands = serviceWith();
    renderGlucose(commands, locale);
    expect(valueInput()).not.toHaveAttribute("maxlength");
    fireEvent.change(valueInput(), { target: { value: "1234.56" } });
    expect(valueInput()).toHaveValue("");
    expect(screen.getByText(m.glucose.formatRefused)).toBeInTheDocument();
    fireEvent.change(valueInput(), { target: { value: "123" } });
    expect(screen.queryByText(m.glucose.formatRefused)).not.toBeInTheDocument();
    fireEvent.change(valueInput(), { target: { value: "1234.56" } });
    expect(valueInput()).toHaveValue("123");
    expect(screen.getByText(m.glucose.formatRefused)).toBeInTheDocument();
    expect(commands.recordGlucose).not.toHaveBeenCalled();
  });

  it("I-3 (M10): editing the value while the confirmation is open closes it; Save as shown never saves the stale 60; re-confirmation shows 70.0", async () => {
    const { commands } = start("60");
    expect(within(panel()).getByRole("heading", { name: `60.0 ${m.glucose.unit}` })).toBeInTheDocument();
    fireEvent.change(valueInput(), { target: { value: "70" } });
    expect(screen.queryByRole("region", { name: new RegExp(`${m.glucose.unit}$`) })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: m.glucose.saveAsShown })).not.toBeInTheDocument();
    expect(commands.recordGlucose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: m.glucose.saveAction }));
    expect(within(panel()).getByRole("heading", { name: `70.0 ${m.glucose.unit}` })).toBeInTheDocument();
    fireEvent.click(within(panel()).getByRole("button", { name: m.glucose.saveAsShown }));
    await screen.findByText(m.glucose.saved);
    expect(stored(commands)).toEqual(["70.0"]);
  });

  it("round 3 (ruling 7): after an automatic \".0\" the keypad continues the typed number (9 → 9.0 → keypad 5 → 95; saved only after confirming 95.0)", async () => {
    const commands = serviceWith();
    renderGlucose(commands, locale);
    fireEvent.click(screen.getByRole("radio", { name: m.glucose.contextBedtime }));
    fireEvent.change(valueInput(), { target: { value: "9" } });
    fireEvent.blur(valueInput());
    expect(valueInput()).toHaveValue("9.0");
    press("5");
    expect(valueInput()).toHaveValue("95");
    expect(screen.queryByText(m.glucose.formatRefused)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: m.glucose.saveAction }));
    expect(within(panel()).getByRole("heading", { name: `95.0 ${m.glucose.unit}` })).toBeInTheDocument();
    expect(commands.recordGlucose).not.toHaveBeenCalled();
    fireEvent.click(within(panel()).getByRole("button", { name: m.glucose.saveAsShown }));
    await screen.findByText(m.glucose.saved);
    expect(stored(commands)).toEqual(["95.0"]);
  });

  it("round 3 (ruling 7): an explicitly entered decimal is never removed: 9.0 + 5 and 9.2 + 5 are refused; 9. + 5 gives 9.5", () => {
    renderGlucose(serviceWith(), locale);
    for (const [explicit, after, refused] of [["9.0", "9.0", true], ["9.2", "9.2", true], ["9.", "9.5", false]] as const) {
      fireEvent.change(valueInput(), { target: { value: "" } });
      fireEvent.change(valueInput(), { target: { value: explicit } });
      fireEvent.blur(valueInput());
      fireEvent.focus(valueInput());
      press("5");
      expect(valueInput(), explicit).toHaveValue(after);
      if (refused) expect(screen.getByText(m.glucose.formatRefused), explicit).toBeInTheDocument();
      else expect(screen.queryByText(m.glucose.formatRefused), explicit).not.toBeInTheDocument();
    }
  });

  it("round 3 (ruling 7): a keypad edit makes an open confirmation stale: it closes and the updated value must be confirmed (continuing after the automatic .0)", async () => {
    const { commands } = start("60");
    expect(within(panel()).getByRole("heading", { name: `60.0 ${m.glucose.unit}` })).toBeInTheDocument();
    press("5");
    expect(screen.queryByRole("region", { name: new RegExp(`${m.glucose.unit}$`) })).not.toBeInTheDocument();
    expect(valueInput()).toHaveValue("605");
    expect(commands.recordGlucose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: m.glucose.saveAction }));
    expect(within(panel()).getByRole("heading", { name: `605.0 ${m.glucose.unit}` })).toBeInTheDocument();
    fireEvent.click(within(panel()).getByRole("button", { name: m.glucose.saveAsShown }));
    await screen.findByText(m.glucose.saved);
    expect(stored(commands)).toEqual(["605.0"]);
  });

  it("round 4 (I-1): typing 60 then clicking Save (the field blurs first) still lets the keypad continue: 5 → 605, the stale panel closes, 605.0 must be confirmed", async () => {
    const commands = serviceWith();
    renderGlucose(commands, locale);
    fireEvent.click(screen.getByRole("radio", { name: m.glucose.contextBedtime }));
    const save = screen.getByRole("button", { name: m.glucose.saveAction });
    fireEvent.focus(valueInput());
    fireEvent.change(valueInput(), { target: { value: "60" } });
    // A real click on Save: the field loses focus to the Save button first (completion formatting), then the form submits.
    fireEvent.blur(valueInput(), { relatedTarget: save });
    expect(valueInput()).toHaveValue("60.0");
    fireEvent.click(save);
    expect(within(panel()).getByRole("heading", { name: `60.0 ${m.glucose.unit}` })).toBeInTheDocument();
    press("5");
    expect(valueInput()).toHaveValue("605");
    expect(screen.queryByText(m.glucose.formatRefused)).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: new RegExp(`${m.glucose.unit}$`) })).not.toBeInTheDocument();
    expect(commands.recordGlucose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: m.glucose.saveAction }));
    expect(within(panel()).getByRole("heading", { name: `605.0 ${m.glucose.unit}` })).toBeInTheDocument();
    expect(commands.recordGlucose).not.toHaveBeenCalled();
    fireEvent.click(within(panel()).getByRole("button", { name: m.glucose.saveAsShown }));
    await screen.findByText(m.glucose.saved);
    expect(stored(commands)).toEqual(["605.0"]);
  });

  it("round 4 (m-2): an explicitly typed decimal is never dropped at Save time: 60.5, Save, keypad 5 is refused and the value stays 60.5", () => {
    const { commands } = start("60.5");
    expect(within(panel()).getByRole("heading", { name: `60.5 ${m.glucose.unit}` })).toBeInTheDocument();
    press("5");
    expect(valueInput()).toHaveValue("60.5");
    expect(screen.getByText(m.glucose.formatRefused)).toBeInTheDocument();
    expect(within(panel()).getByRole("heading", { name: `60.5 ${m.glucose.unit}` })).toBeInTheDocument();
    expect(commands.recordGlucose).not.toHaveBeenCalled();
  });

  it("round 3 (ruling 7): keypad Delete on an open confirmation also closes it; saving again asks for the shown value", async () => {
    const { commands } = start("60");
    fireEvent.click(within(keypad()).getByRole("button", { name: m.glucose.deleteDigit }));
    expect(screen.queryByRole("region", { name: new RegExp(`${m.glucose.unit}$`) })).not.toBeInTheDocument();
    expect(commands.recordGlucose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: m.glucose.saveAction }));
    expect(within(panel()).getByRole("heading", { name: new RegExp(`^\\d+\\.\\d ${m.glucose.unit}$`) })).toBeInTheDocument();
    expect(commands.recordGlucose).not.toHaveBeenCalled();
  });

  it("at or below 50 (and above zero) one Save stores the formatted value with no confirmation step", async () => {
    const { commands } = start("50");
    await screen.findByText(m.glucose.saved);
    expect(screen.queryByText(m.glucose.confirmBody)).not.toBeInTheDocument();
    expect(stored(commands)).toEqual(["50.0"]);
  });
});

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
