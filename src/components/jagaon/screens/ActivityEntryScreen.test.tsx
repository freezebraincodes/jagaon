import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JournalCommandService, JournalCommitResult } from "@/application/journal/journal-contracts";
import { activityEventPayloadSchema } from "@/domain/health-records/activity-event";
import { getMessages } from "@/i18n/get-messages";
import { ActivityEntryScreen, typedDurationMinutes } from "./ActivityEntryScreen";
import { singaporeNowParts, singaporeWallClockToInstant } from "../journal/singapore-time";

afterEach(() => cleanup());

const committed: JournalCommitResult = {
  kind: "COMMITTED",
  recordId: "00000000-0000-4000-8000-000000000091" as never,
  revisionId: "00000000-0000-4000-8000-000000000092" as never,
};
const failed: JournalCommitResult = { kind: "FAILED", code: "COMMIT_FAILED" };

const en = getMessages("en-SG");
const msg = en.activityEntry;

/** Wording the form must never use: advice, goals, judgement or clinical estimates. */
const PROHIBITED = [
  /\bshould\b/i, /\bgoal\b/i, /\btarget\b/i, /\bgreat\b/i, /\bwell done\b/i, /\bgood job\b/i, /\benough\b/i,
  /\bnot enough\b/i, /\brecommend/i, /\bburn/i, /\bintensity\b/i, /\bhealthy\b/i, /\brisk\b/i,
];

function serviceWith(overrides: Partial<JournalCommandService> = {}): JournalCommandService {
  return {
    recordGlucose: vi.fn().mockResolvedValue(committed),
    correctGlucoseTime: vi.fn().mockResolvedValue(committed),
    recordInsulin: vi.fn().mockResolvedValue(committed),
    recordMeal: vi.fn().mockResolvedValue(committed),
    recordActivity: vi.fn().mockResolvedValue(committed),
    ...overrides,
  };
}

function renderActivity(commands = serviceWith(), locale: "en-SG" | "zh-SG" = "en-SG") {
  const goBack = vi.fn();
  const onCommitted = vi.fn();
  const view = render(
    <ActivityEntryScreen messages={getMessages(locale)} locale={locale} commandService={commands} goBack={goBack} onCommitted={onCommitted} />,
  );
  return { commands, goBack, onCommitted, ...view };
}

const kindGroup = () => screen.getByRole("group", { name: msg.whatDidYouDo });
const durationGroup = () => screen.getByRole("group", { name: `${msg.durationLabel} (${en.shared.optional})` });
const chooseKind = (label: string) => fireEvent.click(within(kindGroup()).getByRole("radio", { name: label }));
const chooseDuration = (label: string) => fireEvent.click(within(durationGroup()).getByRole("radio", { name: label }));
const labelInput = () => screen.getByRole("textbox", { name: new RegExp(`^${msg.labelField}`) }) as HTMLInputElement;
const save = () => screen.getByRole("button", { name: msg.saveAction });

function lastInput(commands: JournalCommandService) {
  const calls = vi.mocked(commands.recordActivity).mock.calls;
  return calls[calls.length - 1]![0];
}

function todayAt(time: string) {
  return singaporeWallClockToInstant(singaporeNowParts().date, time);
}

function openTimeEditor() {
  const edit = screen.getByRole("button", { name: en.readingTime.editTime });
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

describe("Record an activity", () => {
  it("shows the eight activity chips and the duration chips, with save disabled until an activity is chosen", () => {
    renderActivity();
    expect(screen.getByRole("heading", { level: 1, name: msg.screenTitle })).toBeInTheDocument();
    expect(within(kindGroup()).getAllByRole("radio").map((radio) => radio.closest("label")?.textContent)).toEqual([
      "Walk", "Run or jog", "Swim", "Cycle", "Yoga or stretching", "Strength", "Housework or gardening", "Other",
    ]);
    expect(within(durationGroup()).getAllByRole("radio").map((radio) => radio.closest("label")?.textContent)).toEqual([
      "10 min", "15 min", "20 min", "30 min", "45 min", "60 min", "Other", "Not sure",
    ]);
    expect(save()).toBeDisabled();
    expect(screen.getByText(msg.chooseToSave)).toBeInTheDocument();
    chooseKind(msg.kindWalk);
    expect(save()).toBeEnabled();
    expect(screen.queryByText(msg.chooseToSave)).not.toBeInTheDocument();
  });

  it.each([
    [msg.kindWalk, "WALKING"],
    [msg.kindRun, "AEROBIC"],
    [msg.kindSwim, "AEROBIC"],
    [msg.kindCycle, "AEROBIC"],
    [msg.kindYoga, "FLEXIBILITY_OR_MOBILITY"],
    [msg.kindStrength, "STRENGTH"],
    [msg.kindHousework, "HOUSEHOLD_ACTIVITY"],
  ] as const)("records %s as %s with its own plain label", async (label, category) => {
    const { commands } = renderActivity();
    chooseKind(label);
    expect(labelInput().value).toBe(label);
    fireEvent.click(save());
    await waitFor(() => expect(commands.recordActivity).toHaveBeenCalledTimes(1));
    expect(lastInput(commands).payload).toEqual({ activityCategory: category, patientLabel: label });
  });

  it("saves the exact payload, EXACT POINT time and duration, then refreshes Today and goes back", async () => {
    const { commands, goBack, onCommitted } = renderActivity();
    chooseKind(msg.kindSwim);
    fireEvent.change(labelInput(), { target: { value: "  Morning swim at Bishan  " } });
    chooseDuration(en.shared.minutes(45));
    openTimeEditor();
    setWheelTime("07:15");
    fireEvent.click(save());

    await waitFor(() => expect(commands.recordActivity).toHaveBeenCalledTimes(1));
    const input = lastInput(commands);
    expect(input.payload).toEqual({ activityCategory: "AEROBIC", patientLabel: "Morning swim at Bishan", reportedDurationMinutes: 45 });
    expect(activityEventPayloadSchema.safeParse(input.payload).success).toBe(true);
    expect(input.temporal).toEqual({
      kind: "POINT",
      occurrence: { kind: "EXACT", instantUtc: todayAt("07:15"), timeZoneId: "Asia/Singapore", utcOffsetMinutes: 480 },
    });
    expect(typeof input.recordedAt).toBe("string");
    await waitFor(() => expect(goBack).toHaveBeenCalledTimes(1));
    expect(onCommitted).toHaveBeenCalledTimes(1);
    expect(onCommitted.mock.invocationCallOrder[0]!).toBeLessThan(goBack.mock.invocationCallOrder[0]!);
  });

  it("defaults the time to now", async () => {
    const before = Date.now();
    const { commands } = renderActivity();
    expect(screen.getByText(/^Now, /)).toBeInTheDocument();
    chooseKind(msg.kindWalk);
    fireEvent.click(save());
    await waitFor(() => expect(commands.recordActivity).toHaveBeenCalledTimes(1));
    const { temporal } = lastInput(commands);
    if (temporal.kind !== "POINT" || temporal.occurrence.kind !== "EXACT") throw new Error("expected an EXACT POINT time");
    const saved = Date.parse(temporal.occurrence.instantUtc);
    // The time is kept to the minute, so it lies within the minute before now.
    expect(saved).toBeLessThanOrEqual(Date.now());
    expect(saved).toBeGreaterThan(before - 61_000);
  });

  it("follows the chip with the words until the person writes their own", () => {
    renderActivity();
    chooseKind(msg.kindWalk);
    expect(labelInput().value).toBe("Walk");
    chooseKind(msg.kindCycle);
    expect(labelInput().value).toBe("Cycle");
    fireEvent.change(labelInput(), { target: { value: "Cycled to the market" } });
    chooseKind(msg.kindWalk);
    expect(labelInput().value).toBe("Cycled to the market");
    expect(labelInput()).toHaveAttribute("maxLength", "160");
  });

  it("an empty label falls back to the chip's plain label", async () => {
    const { commands } = renderActivity();
    chooseKind(msg.kindYoga);
    fireEvent.change(labelInput(), { target: { value: "   " } });
    fireEvent.click(save());
    await waitFor(() => expect(commands.recordActivity).toHaveBeenCalledTimes(1));
    expect(lastInput(commands).payload.patientLabel).toBe("Yoga or stretching");
  });

  it("Other starts blank and needs the person's own words before it saves", async () => {
    const { commands } = renderActivity();
    chooseKind(msg.kindOther);
    expect(labelInput().value).toBe("");
    expect(labelInput()).toBeRequired();
    fireEvent.click(save());
    expect(await screen.findByText(msg.labelRequired)).toBeInTheDocument();
    expect(labelInput()).toHaveAttribute("aria-invalid", "true");
    expect(labelInput()).toHaveFocus();
    expect(commands.recordActivity).not.toHaveBeenCalled();

    fireEvent.change(labelInput(), { target: { value: "Tai chi at the void deck" } });
    expect(screen.queryByText(msg.labelRequired)).not.toBeInTheDocument();
    fireEvent.click(save());
    await waitFor(() => expect(commands.recordActivity).toHaveBeenCalledTimes(1));
    expect(lastInput(commands).payload).toEqual({ activityCategory: "OTHER", patientLabel: "Tai chi at the void deck" });
  });

  it("Not sure, or no duration chosen, saves no duration", async () => {
    const { commands } = renderActivity();
    chooseKind(msg.kindWalk);
    chooseDuration(msg.durationNotSure);
    fireEvent.click(save());
    await waitFor(() => expect(commands.recordActivity).toHaveBeenCalledTimes(1));
    expect(lastInput(commands).payload).not.toHaveProperty("reportedDurationMinutes");
  });

  it.each([
    ["", "90", 90],
    ["1", "30", 90],
    ["2", "", 120],
    ["0", "5", 5],
    ["24", "0", 1440],
  ])("Other duration: %s h %s min saves %i minutes", async (hours, minutes, expected) => {
    const { commands } = renderActivity();
    chooseKind(msg.kindStrength);
    chooseDuration(msg.durationOther);
    fireEvent.change(screen.getByRole("textbox", { name: msg.hoursLabel }), { target: { value: hours } });
    fireEvent.change(screen.getByRole("textbox", { name: msg.minutesLabel }), { target: { value: minutes } });
    fireEvent.click(save());
    await waitFor(() => expect(commands.recordActivity).toHaveBeenCalledTimes(1));
    expect(lastInput(commands).payload.reportedDurationMinutes).toBe(expected);
  });

  it.each([
    ["", ""],
    ["0", "0"],
    ["24", "1"],
    ["", "1.5"],
    ["", "-5"],
    ["one", ""],
  ])("Other duration refuses %s h %s min with a plain message and keeps the input", async (hours, minutes) => {
    const { commands } = renderActivity();
    chooseKind(msg.kindStrength);
    chooseDuration(msg.durationOther);
    const hoursInput = screen.getByRole("textbox", { name: msg.hoursLabel });
    fireEvent.change(hoursInput, { target: { value: hours } });
    fireEvent.change(screen.getByRole("textbox", { name: msg.minutesLabel }), { target: { value: minutes } });
    fireEvent.click(save());
    expect(await screen.findByText(msg.durationInvalid)).toBeInTheDocument();
    expect(hoursInput).toHaveFocus();
    expect(hoursInput).toHaveAccessibleDescription(`${msg.durationHint} ${msg.durationInvalid}`);
    expect(commands.recordActivity).not.toHaveBeenCalled();
    expect((hoursInput as HTMLInputElement).value).toBe(hours);
  });

  it("shows the hours and minutes fields only for Other", () => {
    renderActivity();
    expect(screen.queryByRole("textbox", { name: msg.hoursLabel })).not.toBeInTheDocument();
    chooseDuration(msg.durationOther);
    expect(screen.getByRole("textbox", { name: msg.hoursLabel })).toHaveAttribute("inputMode", "numeric");
    expect(screen.getByText(msg.durationHint)).toBeInTheDocument();
    chooseDuration(en.shared.minutes(20));
    expect(screen.queryByRole("textbox", { name: msg.hoursLabel })).not.toBeInTheDocument();
  });

  it("keeps every input after a failed save, stays on the form, and retries with unchanged values", async () => {
    const recordActivity = vi.fn().mockResolvedValueOnce(failed).mockResolvedValueOnce(committed);
    const { goBack, onCommitted } = renderActivity(serviceWith({ recordActivity }));
    chooseKind(msg.kindHousework);
    fireEvent.change(labelInput(), { target: { value: "Mopped the flat" } });
    chooseDuration(en.shared.minutes(30));
    fireEvent.click(save());

    expect(await screen.findByText(en.shared.notSaved)).toBeInTheDocument();
    expect(goBack).not.toHaveBeenCalled();
    expect(onCommitted).not.toHaveBeenCalled();
    expect(within(kindGroup()).getByRole("radio", { name: msg.kindHousework })).toBeChecked();
    expect(within(durationGroup()).getByRole("radio", { name: en.shared.minutes(30) })).toBeChecked();
    expect(labelInput().value).toBe("Mopped the flat");

    fireEvent.click(save());
    await waitFor(() => expect(goBack).toHaveBeenCalledTimes(1));
    const [first, second] = recordActivity.mock.calls.map(([input]) => {
      const { recordedAt: _recordedAt, ...rest } = input as { recordedAt: string };
      return rest;
    });
    expect(second).toEqual(first);
    expect(first).toMatchObject({ payload: { activityCategory: "HOUSEHOLD_ACTIVITY", patientLabel: "Mopped the flat", reportedDurationMinutes: 30 } });
  });

  it("never advises, sets goals or judges the activity", () => {
    const { container } = renderActivity();
    chooseKind(msg.kindRun);
    chooseDuration(msg.durationOther);
    for (const pattern of PROHIBITED) expect(container.textContent).not.toMatch(pattern);
  });

  it("renders the Chinese drafts with the same structure", () => {
    const zh = getMessages("zh-SG").activityEntry;
    renderActivity(serviceWith(), "zh-SG");
    expect(screen.getByRole("heading", { level: 1, name: zh.screenTitle })).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: zh.whatDidYouDo })).getAllByRole("radio")).toHaveLength(8);
  });
});

describe("typedDurationMinutes", () => {
  it("accepts whole hours and minutes from 1 minute to 24 hours", () => {
    expect(typedDurationMinutes("", "1")).toBe(1);
    expect(typedDurationMinutes(" 1 ", " 05 ")).toBe(65);
    expect(typedDurationMinutes("", "1440")).toBe(1440);
    expect(typedDurationMinutes("", "1441")).toBeNull();
    expect(typedDurationMinutes("", "")).toBeNull();
    expect(typedDurationMinutes("1h", "")).toBeNull();
  });
});
