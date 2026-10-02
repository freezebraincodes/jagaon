import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent, within } from "@testing-library/react";
import { getMessages } from "@/i18n/get-messages";
import { createDemoScenarioFixture } from "@/application/governed/demo-scenario-fixture";
import type { AppMessages } from "@/i18n/types";
import type { ScreenId } from "../screen-manifest";
import { TodayScreen } from "./TodayScreen";
import type { TodayJournalViewModel } from "@/application/journal/journal-contracts";

// 12:00 in Singapore on the same day as the fixture reading (07:48 SGT).
const NOW = new Date("2026-10-02T04:00:00Z");

const journal: TodayJournalViewModel = {
  unavailable: false,
  entries: [
    {
      recordId: "00000000-0000-4000-8000-000000000301" as never,
      revisionId: "00000000-0000-4000-8000-000000000302" as never,
      recordType: "GLUCOSE_READING",
      revisionNumber: 1,
      recordedAt: "2026-10-02T00:00:00Z" as never,
      occurrenceSortInstant: "2026-10-01T23:48:00Z" as never,
      summary: "6.2 mmol/L",
      displayValue: "6.2",
      displayUnit: "mmol/L",
      displayContext: "BEFORE_BREAKFAST",
    },
  ],
};

function setup(props?: { locale?: "en-SG" | "zh-SG"; navigate?: (screen: ScreenId) => void }) {
  const locale = props?.locale ?? "en-SG";
  const messages = getMessages(locale);
  const fixture = createDemoScenarioFixture();
  const navigate = props?.navigate ?? vi.fn();

  const rendered = render(
    <TodayScreen
      messages={messages}
      locale={locale}
      fixture={fixture}
      journal={journal}
      navigate={navigate}
      now={NOW}
    />,
  );

  return { ...rendered, messages, fixture, navigate };
}

describe("TodayScreen", () => {
  afterEach(() => cleanup());

  it("renders a personalised synthetic greeting in English", () => {
    const { getByRole, fixture } = setup({ locale: "en-SG" });
    expect(getByRole("heading", { level: 1 })).toHaveTextContent(
      `Hello, ${fixture.displayName}`,
    );
  });

  it("renders a personalised synthetic greeting in Chinese", () => {
    const { getByRole, fixture } = setup({ locale: "zh-SG" });
    expect(getByRole("heading", { level: 1 })).toHaveTextContent(
      `${fixture.displayNameZh}，您好`,
    );
  });

  it("renders today's date", () => {
    const { container } = setup({ locale: "en-SG" });
    const dateText = container.querySelector(".today-date")?.textContent ?? "";
    expect(dateText.length).toBeGreaterThan(0);
    expect(dateText).toMatch(/\d{4}/);
  });

  it("renders morning, afternoon, and evening booklet slots", () => {
    const { messages, getByRole } = setup({ locale: "en-SG" });
    const heading = getByRole("heading", { name: messages.today.todayBooklet });
    expect(heading).toBeInTheDocument();

    const booklet = getByRole("region", { name: messages.today.todayBooklet });
    const slots = within(booklet).getAllByRole("listitem");
    expect(slots).toHaveLength(3);
    expect(slots[0]).toHaveTextContent(messages.today.slotMorning);
    expect(slots[1]).toHaveTextContent(messages.today.slotAfternoon);
    expect(slots[2]).toHaveTextContent(messages.today.slotEvening);
  });

  it("navigates to LOG_GLUCOSE when the primary action is activated", () => {
    const navigate = vi.fn();
    const { messages, getByRole } = setup({ navigate });
    const action = getByRole("button", { name: messages.today.recordReading });
    fireEvent.click(action);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith("LOG_GLUCOSE");
  });

  it("renders the latest recorded reading with neutral descriptive wording", () => {
    const { messages, container } = setup({ locale: "en-SG" });
    expect(container.textContent).toContain(messages.today.latestRecordedReading);
    expect(container.textContent).toContain("6.2");
    expect(container.textContent).toContain("mmol/L");
    expect(container.textContent).toContain(messages.glucose.contextBeforeBreakfast);
  });

  it("labels insulin schedule and intake status descriptively", () => {
    const { messages, container } = setup({ locale: "en-SG" });
    expect(container.textContent).toContain(messages.today.insulinToday);
    expect(container.textContent).toContain(messages.today.scheduled);
    expect(container.textContent).toContain(messages.today.intakeRecord);
    expect(container.textContent).toContain(messages.today.notRecorded);
  });

  it("shows a committed insulin fact against the matching recorded medicine", () => {
    const fixture = createDemoScenarioFixture();
    const messages = getMessages("en-SG");
    const insulinJournal: TodayJournalViewModel = {
      unavailable: false,
      entries: [
        {
          recordId: "00000000-0000-4000-8000-000000000311" as never,
          revisionId: "00000000-0000-4000-8000-000000000312" as never,
          recordType: "MEDICATION_EVENT",
          revisionNumber: 1,
          recordedAt: "2026-10-02T00:00:00Z" as never,
          occurrenceSortInstant: "2026-10-02T00:00:00Z" as never,
          summary: "Insulin · 8 UNIT",
          displayContext: fixture.recordedPrescriptions[0]!.medicationRecordId,
          displayValue: "8",
          displayUnit: "UNIT",
        },
      ],
    };
    const { getByRole } = render(
      <TodayScreen
        messages={messages}
        locale="en-SG"
        fixture={fixture}
        journal={insulinJournal}
        navigate={vi.fn()}
        now={NOW}
      />,
    );

    const glargine = getByRole("group", { name: fixture.recordedPrescriptions[0]!.displayName });
    const aspart = getByRole("group", { name: fixture.recordedPrescriptions[1]!.displayName });
    // The domain unit code is labelled in the active locale, never shown raw.
    expect(within(glargine).getByText("8 units")).toBeInTheDocument();
    expect(glargine).not.toHaveTextContent("UNIT ");
    expect(within(aspart).getByText(messages.today.notRecorded)).toBeInTheDocument();
  });

  it("localises the meal slot while preserving the patient-entered item", () => {
    const messages = getMessages("zh-SG");
    const mealJournal: TodayJournalViewModel = {
      unavailable: false,
      entries: [
        {
          recordId: "00000000-0000-4000-8000-000000000321" as never,
          revisionId: "00000000-0000-4000-8000-000000000322" as never,
          recordType: "INTAKE_EVENT",
          revisionNumber: 1,
          recordedAt: "2026-10-02T01:00:00Z" as never,
          occurrenceSortInstant: "2026-10-02T01:00:00Z" as never,
          summary: "BREAKFAST · Brown rice",
          displayContext: "BREAKFAST",
          displayValue: "Brown rice",
        },
      ],
    };
    const { container } = render(
      <TodayScreen
        messages={messages}
        locale="zh-SG"
        fixture={createDemoScenarioFixture()}
        journal={mealJournal}
        navigate={vi.fn()}
        now={NOW}
      />,
    );

    expect(container).toHaveTextContent(`${messages.meal.breakfast}：Brown rice`);
    expect(container).not.toHaveTextContent("Breakfast: recorded");
  });

  it("uses 'Not recorded' and never 'missed'", () => {
    const { container } = setup({ locale: "en-SG" });
    const text = container.textContent ?? "";
    expect(text).toContain("Not recorded");
    expect(text.toLowerCase()).not.toContain("missed");
  });

  it("navigates to RECORD_INSULIN from the add-record action", () => {
    const navigate = vi.fn();
    const { messages, getByRole } = setup({ navigate });
    const addButton = getByRole("button", { name: new RegExp(messages.today.addRecord) });
    fireEvent.click(addButton);
    expect(navigate).toHaveBeenCalledWith("RECORD_INSULIN");
  });

  it("navigates to LOG_MEAL from the meal tile", () => {
    const navigate = vi.fn();
    const { messages, getByRole } = setup({ navigate });
    fireEvent.click(getByRole("button", { name: messages.today.mealTitle }));
    expect(navigate).toHaveBeenCalledWith("LOG_MEAL");
  });

  it("opens time correction for the exact latest glucose record", () => {
    const navigate = vi.fn();
    const { messages, getByRole } = setup({ navigate });
    fireEvent.click(getByRole("button", { name: messages.readingTime.editTime }));
    expect(navigate).toHaveBeenCalledWith("CHANGE_READING_TIME", {
      recordId: journal.entries[0]?.recordId,
    });
  });

  it("shows the exact unavailable message instead of a partial journal", () => {
    const locale = "en-SG" as const;
    const messages = getMessages(locale);
    const fixture = createDemoScenarioFixture();
    const { getByText } = render(
      <TodayScreen
        messages={messages}
        locale={locale}
        fixture={fixture}
        journal={{ entries: [], unavailable: true }}
        navigate={vi.fn()}
      />,
    );
    expect(getByText(messages.shared.storageUnavailable)).toBeInTheDocument();
  });

  it("disables the View history link because history is a later-packet destination", () => {
    const navigate = vi.fn();
    const { messages, getByRole } = setup({ navigate });
    const link = getByRole("button", { name: messages.today.viewHistory });
    expect(link).toBeDisabled();
    expect(link).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(link);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("shows only the care dates the person entered, with a disabled later-packet link", () => {
    const { messages, fixture, getByRole } = setup({ locale: "en-SG" });
    const care = getByRole("region", { name: messages.today.careDatesHeading });
    for (const date of fixture.careDates) {
      expect(care).toHaveTextContent(date.label);
      expect(care).toHaveTextContent(date.enteredDateText);
    }
    expect(care).toHaveTextContent(messages.today.careDatesNote);
    const prepare = within(care).getByRole("button", { name: messages.today.prepareAppointment });
    expect(prepare).toBeDisabled();
    expect(prepare).toHaveAccessibleDescription(messages.today.futureFeature);
    // No due, overdue or urgency wording is derived from the dates.
    expect(care.textContent).not.toMatch(/due on|overdue|upcoming|urgent|soon/i);
  });

  it("does not introduce prohibited clinical or adherence wording", () => {
    const { container } = setup({ locale: "en-SG" });
    const text = (container.textContent ?? "").toLowerCase();
    const prohibited = [
      "high",
      "low",
      "safe",
      "missed",
      "take now",
      "double up",
      "risk",
      "adherence",
      "dose recommendation",
      "better",
    ];
    for (const word of prohibited) {
      expect(text).not.toContain(word);
    }
  });

  it("keeps English and Chinese catalogues structurally aligned", () => {
    const en = getMessages("en-SG");
    const zh = getMessages("zh-SG");

    function keys(obj: Record<string, unknown>): string[] {
      return Object.keys(obj).sort();
    }

    expect(keys(en.today)).toEqual(keys(zh.today));
    expect(keys(en.shared)).toEqual(keys(zh.shared));
  });

  it("uses the approved unit from the glucose catalogue instead of a decorative literal", () => {
    const { messages, container } = setup({ locale: "en-SG" });
    expect(container.textContent).toContain(messages.glucose.unit);
  });
  it("stamps only readings that occurred on the current Singapore day", () => {
    const messages = getMessages("en-SG");
    const rendered = render(
      <TodayScreen
        messages={messages}
        locale="en-SG"
        fixture={createDemoScenarioFixture()}
        journal={journal}
        navigate={vi.fn()}
        now={new Date("2026-10-03T04:00:00Z")}
      />,
    );
    expect(rendered.container).toHaveTextContent(messages.today.bookletProgress(0, 3));
    // The latest reading stays visible, with its date because it is not today.
    expect(rendered.getByRole("heading", { name: messages.today.latestRecordedReading }))
      .toBeInTheDocument();
    expect(rendered.container.querySelector(".reading-meta")).toHaveTextContent("Fri");
  });

  it("places each same-day reading in its own booklet slot", () => {
    const messages = getMessages("en-SG");
    const evening = {
      ...journal.entries[0]!,
      recordId: "00000000-0000-4000-8000-000000000303" as never,
      occurrenceSortInstant: "2026-10-02T12:30:00Z" as never,
      displayValue: "7.1",
    };
    const { container, getByRole } = render(
      <TodayScreen
        messages={messages}
        locale="en-SG"
        fixture={createDemoScenarioFixture()}
        journal={{ unavailable: false, entries: [evening, journal.entries[0]!] }}
        navigate={vi.fn()}
        now={NOW}
      />,
    );
    const slots = within(getByRole("region", { name: messages.today.todayBooklet })).getAllByRole("listitem");
    expect(slots[0]).toHaveTextContent("6.2");
    expect(slots[1]).toHaveTextContent(messages.today.notRecorded);
    expect(slots[2]).toHaveTextContent("7.1");
    expect(container).toHaveTextContent(messages.today.bookletProgress(2, 3));
  });

  it("shows the synthetic user-entered walk as a read-only tile", () => {
    const { messages, fixture, getByRole } = setup({ locale: "en-SG" });
    const tile = getByRole("group", { name: fixture.activity.title });
    expect(tile).toHaveTextContent(fixture.activity.place);
    expect(tile).toHaveTextContent(messages.shared.minutes(fixture.activity.minutes));
    expect(tile).toHaveTextContent(messages.today.enteredByYou);
    expect(within(tile).queryByRole("button")).not.toBeInTheDocument();
  });
});
