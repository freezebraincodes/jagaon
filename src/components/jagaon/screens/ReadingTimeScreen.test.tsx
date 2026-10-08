import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  GlucoseRecordViewModel,
  JournalCommandService,
  JournalQueryPort,
} from "@/application/journal/journal-contracts";
import { getMessages } from "@/i18n/get-messages";
import { ReadingTimeScreen } from "./ReadingTimeScreen";
import {
  shiftSingaporeDate,
  singaporeNowParts,
  singaporeWallClockToInstant,
} from "../journal/singapore-time";

afterEach(() => cleanup());

const recordId = "00000000-0000-4000-8000-000000000401" as never;
const revisionId = "00000000-0000-4000-8000-000000000402" as never;

// The stored reading occurred at 07:48 today, Singapore time.
const today = singaporeNowParts().date;
const storedInstant = singaporeWallClockToInstant(today, "07:48")!;
const glucosePayload = {
  measurement: {
    enteredValue: "6.2" as never,
    enteredUnit: "MMOL_L" as const,
    normalization: null,
  },
  measurementMethod: "FINGERSTICK_METER" as const,
  context: { kind: "PATIENT_SELECTED_SLOT" as const, slot: "BEFORE_BREAKFAST" as const },
};

function query(): JournalQueryPort {
  const glucose: GlucoseRecordViewModel = {
    recordId,
    revisionId,
    revisionNumber: 1,
    recordedAt: "2026-10-02T00:00:00Z" as never,
    payload: glucosePayload,
    temporal: {
      kind: "POINT",
      occurrence: {
        kind: "EXACT",
        instantUtc: storedInstant,
        timeZoneId: "Asia/Singapore",
        utcOffsetMinutes: 480,
      },
    },
  };
  return {
    loadToday: vi.fn(async () => ({ entries: [], unavailable: false })),
    loadGlucose: vi.fn(async () => glucose),
  };
}

function commands(resultKind: "COMMITTED" | "FAILED" = "COMMITTED"): JournalCommandService {
  const result = resultKind === "COMMITTED"
    ? { kind: "COMMITTED" as const, recordId, revisionId }
    : { kind: "FAILED" as const, code: "COMMIT_FAILED" as const };
  return {
    recordGlucose: vi.fn(),
    correctGlucoseTime: vi.fn().mockResolvedValue(result),
    recordInsulin: vi.fn(),
    recordMeal: vi.fn(),
    recordActivity: vi.fn(),
  };
}

const en = getMessages("en-SG");

function renderScreen(commandService = commands()) {
  render(
    <ReadingTimeScreen
      messages={en}
      locale="en-SG"
      goBack={vi.fn()}
      recordId={recordId}
      queryPort={query()}
      commandService={commandService}
    />,
  );
  return commandService;
}

const loaded = () => screen.findByDisplayValue("07:48");

describe("ReadingTimeScreen", () => {
  it("shows the stored reading, its context and the current time on the wheel", async () => {
    renderScreen();
    await loaded();
    expect(screen.getByRole("heading", { level: 1, name: en.glucose.whenQuestion })).toBeInTheDocument();
    expect(screen.getByText("6.2")).toBeInTheDocument();
    expect(screen.getByText(en.glucose.contextBeforeBreakfast)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: en.readingTime.dayToday })).toBeChecked();
    expect(within(screen.getByRole("listbox", { name: en.readingTime.hourLabel })).getByRole("option", { selected: true })).toHaveTextContent("7");
    expect(within(screen.getByRole("listbox", { name: en.readingTime.minuteLabel })).getByRole("option", { selected: true })).toHaveTextContent("48");
    expect(within(screen.getByRole("listbox", { name: en.readingTime.periodLabel })).getByRole("option", { selected: true })).toHaveTextContent(en.readingTime.am);
    expect(screen.getByText(en.readingTime.sameAsCurrent)).toBeInTheDocument();
    expect(screen.getByText(en.readingTime.historyNote)).toBeInTheDocument();
  });

  it("loads the exact head and commits a correction with its expectation", async () => {
    const commandService = renderScreen();
    await loaded();
    fireEvent.click(screen.getByRole("radio", { name: en.readingTime.dayYesterday }));
    const minute = screen.getByRole("listbox", { name: en.readingTime.minuteLabel });
    fireEvent.keyDown(minute, { key: "Home" });
    for (let index = 0; index < 15; index += 1) fireEvent.keyDown(minute, { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("listbox", { name: en.readingTime.periodLabel }), { key: "End" });
    expect(screen.getByLabelText(en.readingTime.newTime)).toHaveValue("19:15");
    expect(screen.queryByText(en.readingTime.sameAsCurrent)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en.readingTime.saveOccurrence }));

    await waitFor(() => expect(commandService.correctGlucoseTime).toHaveBeenCalledTimes(1));
    expect(commandService.correctGlucoseTime).toHaveBeenCalledWith(
      expect.objectContaining({
        recordId,
        expectedRevisionId: revisionId,
        expectedRevisionNumber: 1,
        // Only the occurrence changes; the recorded payload is resent as-is.
        payload: glucosePayload,
        temporal: {
          kind: "POINT",
          occurrence: {
            kind: "EXACT",
            instantUtc: singaporeWallClockToInstant(shiftSingaporeDate(today, -1), "19:15"),
            timeZoneId: "Asia/Singapore",
            utcOffsetMinutes: 480,
          },
        },
      }),
    );
    expect(await screen.findByText(en.readingTime.saved)).toBeInTheDocument();
  });

  it("offers another date and a typed fallback that drive the same value", async () => {
    renderScreen();
    await loaded();
    fireEvent.click(screen.getByRole("radio", { name: en.readingTime.dayOther }));
    const dateInputs = screen.getAllByLabelText(en.readingTime.newDate);
    expect(dateInputs).toHaveLength(2);
    fireEvent.change(dateInputs[0]!, { target: { value: "2026-09-20" } });
    fireEvent.change(screen.getByLabelText(en.readingTime.newTime), { target: { value: "21:05" } });
    expect(within(screen.getByRole("listbox", { name: en.readingTime.hourLabel })).getByRole("option", { selected: true })).toHaveTextContent("9");
    expect(within(screen.getByRole("listbox", { name: en.readingTime.minuteLabel })).getByRole("option", { selected: true })).toHaveTextContent("05");
    expect(within(screen.getByRole("listbox", { name: en.readingTime.periodLabel })).getByRole("option", { selected: true })).toHaveTextContent(en.readingTime.pm);
    expect(screen.getByRole("radio", { name: en.readingTime.dayOther })).toBeChecked();
  });

  it("sets the controls to the current time without saving", async () => {
    const commandService = renderScreen();
    await loaded();
    fireEvent.click(screen.getByRole("radio", { name: en.readingTime.dayYesterday }));
    fireEvent.click(screen.getByRole("button", { name: en.readingTime.useNow }));
    expect(screen.getByRole("radio", { name: en.readingTime.dayToday })).toBeChecked();
    expect(screen.getByLabelText(en.readingTime.newDate)).toHaveValue(singaporeNowParts().date);
    expect(commandService.correctGlucoseTime).not.toHaveBeenCalled();
  });

  it("keeps the correction unsaved when the command fails", async () => {
    renderScreen(commands("FAILED"));
    await loaded();
    fireEvent.keyDown(screen.getByRole("listbox", { name: en.readingTime.hourLabel }), { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("button", { name: en.readingTime.saveOccurrence }));
    expect(await screen.findByText(en.shared.notSaved)).toBeInTheDocument();
    expect(screen.queryByText(en.readingTime.saved)).not.toBeInTheDocument();
    // The person's corrected time is still on screen for a retry.
    expect(screen.getByLabelText(en.readingTime.newTime)).toHaveValue("08:48");
  });

  // Regression (full-suite failure 2026-10-08: "08:52" / "08:04" instead of "08:48"). The screen mounts at the current
  // time and then commits the stored 07:48. React runs that commit's passive effects in a later scheduler task, so a
  // keypress can arrive in between. The clock is fixed at 09:03 so a stale merge would show minute 03, not 48.
  it("keeps the stored minute when the hour changes before the stored time's deferred effects run", async () => {
    let observer: MutationObserver | undefined;
    try {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(`${today}T01:03:00.000Z`)); // 09:03 in Singapore
      renderScreen(commands("FAILED"));
      expect(screen.getByLabelText(en.readingTime.newTime)).toHaveValue("09:03");
      // Press ArrowDown in the microtask right after the commit that shows the stored reading, before any later task.
      let pressedAt: string | null = null;
      observer = new MutationObserver(() => {
        if (pressedAt !== null || !screen.queryByText("6.2")) return;
        observer?.disconnect();
        pressedAt = (screen.getByLabelText(en.readingTime.newTime) as HTMLInputElement).value;
        fireEvent.keyDown(screen.getByRole("listbox", { name: en.readingTime.hourLabel }), { key: "ArrowDown" });
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      await waitFor(() => expect(pressedAt).toBe("07:48"));
      expect(screen.getByLabelText(en.readingTime.newTime)).toHaveValue("08:48");
      fireEvent.click(screen.getByRole("button", { name: en.readingTime.saveOccurrence }));
      expect(await screen.findByText(en.shared.notSaved)).toBeInTheDocument();
      expect(screen.getByLabelText(en.readingTime.newTime)).toHaveValue("08:48");
      expect(within(screen.getByRole("listbox", { name: en.readingTime.minuteLabel })).getByRole("option", { selected: true })).toHaveTextContent("48");
    } finally {
      observer?.disconnect();
      vi.useRealTimers();
    }
  });
});
