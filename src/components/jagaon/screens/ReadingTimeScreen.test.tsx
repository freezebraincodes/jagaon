import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    expect(screen.getByLabelText(en.readingTime.hourLabel)).toHaveValue("7");
    expect(screen.getByLabelText(en.readingTime.minuteLabel)).toHaveValue("48");
    expect(screen.getByLabelText(en.readingTime.periodLabel)).toHaveValue("am");
    expect(screen.getByText(en.readingTime.sameAsCurrent)).toBeInTheDocument();
    expect(screen.getByText(en.readingTime.historyNote)).toBeInTheDocument();
  });

  it("loads the exact head and commits a correction with its expectation", async () => {
    const commandService = renderScreen();
    await loaded();
    fireEvent.click(screen.getByRole("radio", { name: en.readingTime.dayYesterday }));
    fireEvent.change(screen.getByLabelText(en.readingTime.minuteLabel), { target: { value: "15" } });
    fireEvent.change(screen.getByLabelText(en.readingTime.periodLabel), { target: { value: "pm" } });
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
    expect(screen.getByLabelText(en.readingTime.hourLabel)).toHaveValue("9");
    expect(screen.getByLabelText(en.readingTime.minuteLabel)).toHaveValue("05");
    expect(screen.getByLabelText(en.readingTime.periodLabel)).toHaveValue("pm");
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
    fireEvent.change(screen.getByLabelText(en.readingTime.hourLabel), { target: { value: "8" } });
    fireEvent.click(screen.getByRole("button", { name: en.readingTime.saveOccurrence }));
    expect(await screen.findByText(en.shared.notSaved)).toBeInTheDocument();
    expect(screen.queryByText(en.readingTime.saved)).not.toBeInTheDocument();
    // The person's corrected time is still on screen for a retry.
    expect(screen.getByLabelText(en.readingTime.newTime)).toHaveValue("08:48");
  });
});
