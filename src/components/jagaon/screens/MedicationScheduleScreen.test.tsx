import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/get-messages";
import type {
  MedicationSchedulePort,
  MedicationScheduleView,
  PresentedBarrierQuestion,
  ScheduleOccasionView,
  ScheduleReminderView,
} from "@/application/medication-schedule/medication-schedule-contracts";
import { MedicationScheduleScreen } from "./MedicationScheduleScreen";

afterEach(() => cleanup());

const en = getMessages("en-SG");
const zh = getMessages("zh-SG");
const IDS = ["00000000-0000-4000-8000-000000000101", "00000000-0000-4000-8000-000000000103"];

const ref = (id: string) => ({ recordId: id as never, revisionId: id as never });

function occasion(section: "YESTERDAY" | "TODAY", record: ScheduleOccasionView["record"] = null, barrier: ScheduleOccasionView["barrier"] = { kind: "NONE" }): ScheduleOccasionView {
  const localDate = section === "TODAY" ? "2026-10-04" : "2026-10-03";
  return {
    occasionId: `rx|night|${localDate}`,
    section,
    localDate,
    scheduledTime: "21:00",
    medicineName: "Nocturin pen (demo)",
    scheduleSource: { kind: "SYNTHETIC_DEMO", date: "2026-08-12" },
    occasion: { medication: ref("m"), prescription: ref("rx"), scheduleKey: "night", expectedAt: `${localDate}T13:00:00.000Z` as never },
    amountUnit: { unit: "UNIT", otherUnitText: null },
    record,
    barrier,
  };
}

const reviewReminder: ScheduleReminderView = {
  recordId: "r-noct" as never,
  revisionId: "r-noct-2" as never,
  revisionNumber: 2,
  label: "Nocturin pen (demo)",
  state: "REVIEW_REQUIRED",
  daysOfWeek: ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"],
  times: ["21:30"],
  subject: "MEDICATION",
  currentPrescription: { recordId: "rx" as never, revisionId: "rx-2" as never, times: ["21:00"] },
};
const morningReminder: ScheduleReminderView = {
  ...reviewReminder,
  recordId: "r-morning" as never,
  revisionId: "r-morning-1" as never,
  label: "Morning reading",
  state: "ACTIVE",
  times: ["07:00"],
  subject: "MEASUREMENT",
  currentPrescription: null,
};
const footReminder: ScheduleReminderView = {
  ...morningReminder,
  recordId: "r-foot" as never,
  revisionId: "r-foot-1" as never,
  label: "Sunday foot check",
  state: "PAUSED",
  daysOfWeek: ["SUNDAY"],
  times: ["09:00"],
  subject: "CUSTOM",
};

function ready(overrides: Partial<Extract<MedicationScheduleView, { status: "READY" }>> = {}): MedicationScheduleView {
  return {
    status: "READY",
    today: "2026-10-04",
    yesterday: "2026-10-03",
    occasions: [
      occasion("YESTERDAY"),
      occasion("TODAY", { recordId: "e1" as never, revisionId: "e1-1" as never, revisionNumber: 1, state: "TAKEN", amount: { kind: "KNOWN", value: "12", unit: "UNIT", otherUnitText: null }, recordedAt: "2026-10-04T13:10:00.000Z" as never }),
    ],
    withoutFixedTime: [{ medicineName: "Veltora pen (demo)" }],
    window: { startDate: "2026-09-21", endDate: "2026-10-04" },
    counts: [
      { optionKey: "ROUTINE_CHANGED", occasionCount: 2, evidence: [{ localDate: "2026-09-22", scheduledTime: "21:00", medicineName: "Nocturin pen (demo)" }, { localDate: "2026-09-30", scheduledTime: "21:00", medicineName: "Nocturin pen (demo)" }] },
      { optionKey: "AWAY_FROM_HOME", occasionCount: 1, evidence: [{ localDate: "2026-09-25", scheduledTime: "21:00", medicineName: "Nocturin pen (demo)" }] },
    ],
    excludedCorrected: 0,
    unrecordedCount: 4,
    reminders: [morningReminder, footReminder, reviewReminder],
    careQuestions: [],
    ...overrides,
  };
}

const offer: PresentedBarrierQuestion = {
  inquiryRecordId: "i1" as never,
  inquiryRevisionId: "i1-3" as never,
  presentationKey: "p1" as never,
  locale: "en-SG",
  leadIn: "You recorded Skipped for Nocturin pen (demo) on Sat, 3 Oct. Answering is optional.",
  question: en.schedule.barrierQuestion,
  options: [
    { optionKey: "FORGOT", label: en.schedule.barrierForgot },
    { optionKey: "ROUTINE_CHANGED", label: en.schedule.barrierRoutineChanged },
    { optionKey: "AWAY_FROM_HOME", label: en.schedule.barrierAway },
    { optionKey: "ACCESS_DIFFICULTY", label: en.schedule.barrierAccess },
    { optionKey: "SIDE_EFFECT_CONCERN", label: en.schedule.barrierSideEffectConcern },
  ],
  medicationEventRecordId: "e2" as never,
};

function port(view: MedicationScheduleView = ready()): MedicationSchedulePort & { [K in keyof MedicationSchedulePort]: ReturnType<typeof vi.fn> } {
  return {
    load: vi.fn(async () => view),
    recordOccasion: vi.fn(async () => ({ kind: "SAVED" as const, medicationEventRecordId: "e2" as never, offer: null })),
    correctOccasion: vi.fn(async () => ({ kind: "SAVED" as const, medicationEventRecordId: "e1" as never, offer: null })),
    openBarrierQuestion: vi.fn(async () => offer),
    answerBarrier: vi.fn(async () => ({ kind: "SAVED" as const })),
    snoozeBarrier: vi.fn(async () => ({ kind: "SAVED" as const })),
    dismissBarrier: vi.fn(async () => ({ kind: "SAVED" as const })),
    correctBarrier: vi.fn(async () => ({ kind: "SAVED" as const })),
    removeBarrier: vi.fn(async () => ({ kind: "SAVED" as const })),
    saveReminder: vi.fn(async () => ({ kind: "SAVED" as const })),
    saveCareQuestion: vi.fn(async () => ({ kind: "SAVED" as const })),
    editCareQuestion: vi.fn(async () => ({ kind: "SAVED" as const })),
    dismissCareQuestion: vi.fn(async () => ({ kind: "SAVED" as const })),
  } as never;
}

function show(schedule: MedicationSchedulePort | null, locale: "en-SG" | "zh-SG" = "en-SG", ids = IDS) {
  return render(<MedicationScheduleScreen messages={locale === "en-SG" ? en : zh} locale={locale} schedule={schedule} medicationRecordIds={ids} />);
}

const addRecordButton = () => screen.getByRole("button", { name: new RegExp(`^${en.schedule.addRecord}`) });

describe("MedicationScheduleScreen", () => {
  it("shows loading until the port is available, then recorded and not-recorded occasions without inference", async () => {
    const { rerender } = show(null);
    expect(screen.getByText(en.schedule.loading)).toHaveAttribute("role", "status");

    const schedule = port();
    rerender(<MedicationScheduleScreen messages={en} locale="en-SG" schedule={schedule} medicationRecordIds={IDS} />);
    expect(await screen.findByRole("heading", { level: 2, name: /Yesterday · 3 Oct/ })).toBeInTheDocument();
    expect(schedule.load).toHaveBeenCalledWith({ locale: "en-SG", medicationRecordIds: IDS });
    expect(screen.getByRole("heading", { level: 1, name: en.schedule.title })).toBeInTheDocument();
    expect(screen.getByText(en.schedule.notRecorded)).toBeInTheDocument();
    expect(screen.getByText(en.schedule.recordedTaken)).toBeInTheDocument();
    expect(screen.getByText("12 units recorded")).toBeInTheDocument();
    expect(screen.getByText(en.schedule.missingMeaning)).toBeInTheDocument();
    expect(screen.getByText(en.schedule.noFixedTimeFor("Veltora pen (demo)"))).toBeInTheDocument();

    // Counts: reviewed options only, with evidence, window, limitation and meaning.
    expect(screen.getByRole("heading", { name: en.schedule.whatRecorded("21 Sept", "4 Oct") })).toBeInTheDocument();
    expect(screen.getByText(en.schedule.countMany(en.schedule.barrierRoutineChanged, 2))).toBeInTheDocument();
    expect(screen.getByText(en.schedule.countOne(en.schedule.barrierAway))).toBeInTheDocument();
    expect(screen.getByText(en.schedule.unrecordedCountMany(4))).toBeInTheDocument();
    expect(screen.getByText(en.schedule.countLimitation)).toBeInTheDocument();
    expect(screen.getByText(en.schedule.countMeaning)).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(en.schedule.barrierPreferNot))).not.toBeInTheDocument();

    const text = document.body.textContent ?? "";
    for (const forbidden of [/ring twice/i, /\bmissed\b/i, /adherence (?:is|was)/i, /non-adherence/i, /\brisk\b/i]) {
      expect(text).not.toMatch(forbidden);
    }
  });

  it("shows the no-fixed-schedule, empty-count and unavailable-with-retry states", async () => {
    const empty = port(ready({ occasions: [], withoutFixedTime: [], counts: [], unrecordedCount: 0, reminders: [] }));
    show(empty);
    expect(await screen.findByText(en.schedule.emptyTitle)).toBeInTheDocument();
    expect(screen.getByText(en.schedule.emptyBody)).toBeInTheDocument();
    expect(screen.getByText(en.schedule.noBarrierCounts)).toBeInTheDocument();
    cleanup();

    const schedule = port({ status: "UNAVAILABLE" });
    show(schedule);
    expect(await screen.findByText(en.schedule.unavailableTitle)).toBeInTheDocument();
    schedule.load.mockResolvedValueOnce(ready());
    fireEvent.click(screen.getByRole("button", { name: en.schedule.retry }));
    expect(await screen.findByRole("heading", { level: 2, name: /Today · 4 Oct/ })).toBeInTheDocument();
    expect(schedule.load).toHaveBeenCalledTimes(2);
  });

  it("opens Add record as a modal that traps focus, closes on Escape and returns focus", async () => {
    show(port());
    await screen.findByText(en.schedule.notRecorded);
    const opener = addRecordButton();
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: en.schedule.recordTitle });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleDescription(/For Nocturin pen \(demo\), scheduled Sat, 3 Oct at 9:00/);
    expect(dialog.contains(document.activeElement)).toBe(true);
    // Nothing is preselected.
    for (const radio of within(dialog).getAllByRole("radio")) expect(radio).not.toBeChecked();

    const cancel = within(dialog).getByRole("button", { name: en.schedule.cancelRecord });
    cancel.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(dialog.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(opener);
  });

  it("requires an explicit amount choice for Taken, never prefills one and saves exactly what was entered", async () => {
    const schedule = port();
    show(schedule);
    await screen.findByText(en.schedule.notRecorded);
    fireEvent.click(addRecordButton());
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: en.schedule.saveRecord }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent(en.schedule.stateRequired);

    fireEvent.click(within(dialog).getByRole("radio", { name: en.schedule.optionTaken }));
    fireEvent.click(within(dialog).getByRole("button", { name: en.schedule.saveRecord }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent(en.schedule.amountRequired);
    expect(within(dialog).getByText(en.schedule.noDoseAdvice)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("radio", { name: en.schedule.amountKnown }));
    const amount = within(dialog).getByLabelText(en.schedule.amountInputLabel("units"));
    expect(amount).toHaveValue("");
    fireEvent.change(amount, { target: { value: "11.5" } });
    fireEvent.click(within(dialog).getByRole("button", { name: en.schedule.saveRecord }));
    await waitFor(() => expect(schedule.recordOccasion).toHaveBeenCalledTimes(1));
    expect(schedule.recordOccasion.mock.calls[0]![0]).toMatchObject({
      state: "TAKEN",
      amount: { kind: "KNOWN", value: "11.5", unit: "UNIT" },
      locale: "en-SG",
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByText(en.schedule.saved)).toBeInTheDocument();
  });

  it("keeps the entered state after a failed save and retries the same command", async () => {
    const schedule = port();
    schedule.recordOccasion.mockResolvedValueOnce({ kind: "FAILED", code: "STORAGE_UNAVAILABLE" });
    show(schedule);
    await screen.findByText(en.schedule.notRecorded);
    fireEvent.click(addRecordButton());
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("radio", { name: en.schedule.optionNotSure }));
    fireEvent.click(within(dialog).getByRole("button", { name: en.schedule.saveRecord }));
    expect(await within(dialog).findByText(en.schedule.saveFailedTitle)).toBeInTheDocument();
    expect(within(dialog).getByRole("alert")).toHaveTextContent(en.schedule.saveFailedBody);
    expect(within(dialog).getByRole("radio", { name: en.schedule.optionNotSure })).toBeChecked();

    fireEvent.click(within(dialog).getByRole("button", { name: en.schedule.trySavingAgain }));
    await waitFor(() => expect(schedule.recordOccasion).toHaveBeenCalledTimes(2));
    const [first, second] = schedule.recordOccasion.mock.calls.map((call) => call[0]);
    expect(second.commandId).toBe(first.commandId);
  });

  it("offers the optional question only after Skipped, saves an answer and announces it", async () => {
    const schedule = port();
    schedule.recordOccasion.mockResolvedValueOnce({ kind: "SAVED", medicationEventRecordId: "e2" as never, offer });
    show(schedule);
    await screen.findByText(en.schedule.notRecorded);
    fireEvent.click(addRecordButton());
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("radio", { name: en.schedule.optionSkipped }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: en.schedule.saveRecord }));

    const barrier = await screen.findByRole("dialog", { name: en.schedule.barrierOfferTitle });
    expect(barrier).toHaveAccessibleDescription(offer.leadIn);
    const group = within(barrier).getByRole("group", { name: en.schedule.barrierQuestion });
    expect(within(group).getAllByRole("radio").map((radio) => radio.closest("label")?.textContent)).toEqual([
      en.schedule.barrierForgot,
      en.schedule.barrierRoutineChanged,
      en.schedule.barrierAway,
      en.schedule.barrierAccess,
      en.schedule.barrierSideEffectConcern,
      en.schedule.barrierSomethingElse,
      en.schedule.barrierNotSure,
      en.schedule.barrierPreferNot,
    ]);

    fireEvent.click(within(barrier).getByRole("radio", { name: en.schedule.barrierSomethingElse }));
    fireEvent.click(within(barrier).getByRole("button", { name: en.schedule.barrierSave }));
    expect(within(barrier).getByRole("alert")).toHaveTextContent(en.schedule.somethingElseRequired);
    fireEvent.change(within(barrier).getByLabelText(en.schedule.somethingElseLabel), { target: { value: "  Pen cap was lost  " } });
    fireEvent.click(within(barrier).getByRole("button", { name: en.schedule.barrierSave }));
    await waitFor(() => expect(schedule.answerBarrier).toHaveBeenCalledTimes(1));
    expect(schedule.answerBarrier.mock.calls[0]![0]).toMatchObject({ question: offer, answer: { kind: "SOMETHING_ELSE", text: "Pen cap was lost", language: "en-SG" } });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByText(en.schedule.barrierSaved)).toBeInTheDocument();
  });

  it("supports Ask me later and Skip this question without recording an answer", async () => {
    const schedule = port(ready({ occasions: [occasion("YESTERDAY", { recordId: "e2" as never, revisionId: "e2-1" as never, revisionNumber: 1, state: "SKIPPED", amount: null, recordedAt: "2026-10-03T13:20:00.000Z" as never }, { kind: "OFFER_AVAILABLE" })] }));
    show(schedule);
    fireEvent.click(await screen.findByRole("button", { name: new RegExp(`^${en.schedule.barrierOfferTitle}`) }));
    const barrier = await screen.findByRole("dialog", { name: en.schedule.barrierOfferTitle });
    fireEvent.click(within(barrier).getByRole("button", { name: en.schedule.barrierLater }));
    await waitFor(() => expect(schedule.snoozeBarrier).toHaveBeenCalledWith(offer, "TOMORROW"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${en.schedule.barrierOfferTitle}`) }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: en.schedule.barrierSkip }));
    await waitFor(() => expect(schedule.dismissBarrier).toHaveBeenCalledWith(offer));
    expect(schedule.answerBarrier).not.toHaveBeenCalled();
  });

  it("corrects a medication record and corrects or removes a saved answer", async () => {
    const answered = occasion(
      "YESTERDAY",
      { recordId: "e2" as never, revisionId: "e2-1" as never, revisionNumber: 1, state: "NOT_SURE", amount: null, recordedAt: "2026-10-03T13:20:00.000Z" as never },
      { kind: "ANSWERED", responseRecordId: "resp" as never, answer: { kind: "PREFER_NOT_TO_SAY" } },
    );
    const schedule = port(ready({ occasions: [answered] }));
    show(schedule);
    expect(await screen.findByText(en.schedule.answerRecordedAs(en.schedule.barrierPreferNot))).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${en.schedule.changeRecord}`) }));
    const record = screen.getByRole("dialog", { name: en.schedule.changeRecord });
    fireEvent.click(within(record).getByRole("radio", { name: en.schedule.optionSkipped }));
    fireEvent.click(within(record).getByRole("button", { name: en.schedule.saveRecord }));
    await waitFor(() => expect(schedule.correctOccasion).toHaveBeenCalledTimes(1));
    expect(schedule.correctOccasion.mock.calls[0]![0]).toMatchObject({ recordId: "e2", expectedRevisionId: "e2-1", expectedRevisionNumber: 1, state: "SKIPPED", amount: null });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${en.schedule.barrierCorrect}`) }));
    const correct = screen.getByRole("dialog", { name: en.schedule.barrierOfferTitle });
    fireEvent.click(within(correct).getByRole("radio", { name: en.schedule.barrierForgot }));
    fireEvent.click(within(correct).getByRole("button", { name: en.schedule.barrierSave }));
    await waitFor(() => expect(schedule.correctBarrier).toHaveBeenCalledWith(expect.objectContaining({ responseRecordId: "resp", answer: { kind: "OPTION", optionKey: "FORGOT" } })));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${en.schedule.barrierRemove}`) }));
    const remove = screen.getByRole("dialog", { name: en.schedule.barrierRemove });
    // The safe action is focused first.
    expect(document.activeElement).toBe(within(remove).getByRole("button", { name: en.schedule.cancelRecord }));
    fireEvent.click(within(remove).getByRole("button", { name: en.schedule.barrierRemove }));
    await waitFor(() => expect(schedule.removeBarrier).toHaveBeenCalledWith("resp"));
  });

  it("changes reminders only after explicit confirmation and confirms a review against the recorded time", async () => {
    const schedule = port();
    show(schedule);
    const toggle = await screen.findByRole("switch", { name: en.schedule.reminderToggleLabel("Morning reading") });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("switch", { name: en.schedule.reminderToggleLabel("Sunday foot check") })).toHaveAttribute("aria-checked", "false");
    toggle.focus();
    fireEvent.click(toggle);
    let confirm = screen.getByRole("dialog", { name: en.schedule.reminderConfirmTitle });
    expect(confirm).toHaveAccessibleDescription(en.schedule.reminderConfirmBody);
    fireEvent.click(within(confirm).getByRole("button", { name: en.schedule.reminderCancel }));
    expect(schedule.saveReminder).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(toggle);

    fireEvent.click(toggle);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: en.schedule.reminderConfirm }));
    await waitFor(() => expect(schedule.saveReminder).toHaveBeenCalledWith(expect.objectContaining({ reminder: morningReminder, change: { kind: "PAUSE" } })));
    expect(await screen.findByText(en.schedule.reminderSaved)).toBeInTheDocument();

    expect(screen.getByText(en.schedule.reminderReview)).toBeInTheDocument();
    expect(screen.getByText(en.schedule.reminderReviewBody)).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: en.schedule.reminderToggleLabel("Nocturin pen (demo)") })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${en.schedule.reminderReviewAction}`) }));
    confirm = screen.getByRole("dialog", { name: en.schedule.reminderConfirmTitle });
    expect(within(confirm).getByText(/9:00/)).toBeInTheDocument();
    fireEvent.click(within(confirm).getByRole("button", { name: en.schedule.reminderConfirm }));
    await waitFor(() => expect(schedule.saveReminder).toHaveBeenLastCalledWith(expect.objectContaining({ reminder: reviewReminder, change: { kind: "CONFIRM_REVIEW" } })));
    // The review control is replaced after reload; focus moves to that reminder's control, not the page body.
    await waitFor(() => expect(document.activeElement?.getAttribute("data-focus-key")).toBe("reminder-r-noct"));
  });

  it("shows a reminder failure inside the confirmation and leaves the reminder unchanged", async () => {
    const schedule = port();
    schedule.saveReminder.mockResolvedValueOnce({ kind: "FAILED", code: "HEAD_CONFLICT" });
    show(schedule);
    fireEvent.click(await screen.findByRole("switch", { name: en.schedule.reminderToggleLabel("Sunday foot check") }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: en.schedule.reminderConfirm }));
    expect(await within(screen.getByRole("dialog")).findByRole("alert")).toHaveTextContent(en.schedule.reminderFailed);
  });

  it("saves a care question locally without answering or sending it", async () => {
    const schedule = port();
    show(schedule);
    fireEvent.click(await screen.findByRole("button", { name: en.schedule.addProfessionalQuestion }));
    const dialog = screen.getByRole("dialog", { name: en.schedule.addProfessionalQuestion });
    expect(dialog).toHaveAccessibleDescription(en.schedule.questionHelp);
    fireEvent.click(within(dialog).getByRole("button", { name: en.schedule.questionSave }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent(en.schedule.questionRequired);
    fireEvent.change(within(dialog).getByLabelText(en.schedule.questionTitle), { target: { value: "Can I keep the pen in my bag?" } });
    fireEvent.click(within(dialog).getByRole("button", { name: en.schedule.questionSave }));
    await waitFor(() => expect(schedule.saveCareQuestion).toHaveBeenCalledWith(expect.objectContaining({ text: "Can I keep the pen in my bag?", language: "en-SG" })));
    expect(await screen.findByText(en.schedule.questionSaved)).toBeInTheDocument();
  });

  it("renders governed zh-SG copy while keeping recorded names verbatim", async () => {
    show(port(), "zh-SG");
    expect(await screen.findByRole("heading", { level: 1, name: zh.schedule.title })).toBeInTheDocument();
    expect(screen.getByText(zh.schedule.notRecorded)).toBeInTheDocument();
    expect(screen.getAllByText("Nocturin pen (demo)").length).toBeGreaterThan(0);
    expect(screen.getByText(zh.schedule.countMany(zh.schedule.barrierRoutineChanged, 2))).toBeInTheDocument();
    expect(screen.getByText(zh.schedule.reminderReview)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Not recorded|Medication schedule/);
  });
});
