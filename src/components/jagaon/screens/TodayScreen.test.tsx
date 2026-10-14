import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent, within } from "@testing-library/react";
import { getMessages } from "@/i18n/get-messages";
import { createDemoScenarioFixture } from "@/application/governed/demo-scenario-fixture";
import type { AppMessages } from "@/i18n/types";
import type { ScreenId } from "../screen-manifest";
import { TodayScreen } from "./TodayScreen";
import type { TodayJournalEntry, TodayJournalViewModel } from "@/application/journal/journal-contracts";
import { formatSingaporeDateTime, formatSingaporeTime } from "../journal/singapore-time";

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

function setup(props?: { locale?: "en-SG" | "zh-SG"; navigate?: (screen: ScreenId) => void; onOpenHistory?: () => void }) {
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
      onOpenHistory={props?.onOpenHistory}
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
    const glulisine = getByRole("group", { name: fixture.recordedPrescriptions[1]!.displayName });
    // The domain unit code is labelled in the active locale, never shown raw.
    expect(within(glargine).getByText("8 units")).toBeInTheDocument();
    expect(glargine).not.toHaveTextContent("UNIT ");
    expect(within(glulisine).getByText(messages.today.notRecorded)).toBeInTheDocument();
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

  it("opens the History tab from View history on the latest reading", () => {
    const navigate = vi.fn();
    const onOpenHistory = vi.fn();
    const { messages, getByRole } = setup({ navigate, onOpenHistory });
    const link = getByRole("button", { name: messages.today.viewHistory });
    expect(link).toBeEnabled();
    expect(link).not.toHaveAttribute("aria-disabled");
    fireEvent.click(link);
    expect(onOpenHistory).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("keeps View history disabled when no History destination is given", () => {
    const { messages, getByRole } = setup();
    const link = getByRole("button", { name: messages.today.viewHistory });
    expect(link).toBeDisabled();
    expect(link).toHaveAttribute("aria-disabled", "true");
  });

  it("shows only the care dates the person entered, with a link to Prepare for my visit", () => {
    const { messages, fixture, getByRole, navigate } = setup({ locale: "en-SG" });
    const care = getByRole("region", { name: messages.today.careDatesHeading });
    for (const date of fixture.careDates) {
      expect(care).toHaveTextContent(date.label);
      expect(care).toHaveTextContent(date.enteredDateText);
    }
    expect(care).toHaveTextContent(messages.today.careDatesNote);
    const prepare = within(care).getByRole("button", { name: messages.today.prepareAppointment });
    expect(prepare).toBeEnabled();
    fireEvent.click(prepare);
    expect(navigate).toHaveBeenCalledWith("CARE_PREPARATION");
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

  it("shows Not recorded on the Activity tile when no activity is recorded, and the tile opens Tell JagaOn", () => {
    const { messages, getByRole, navigate } = setup({ locale: "en-SG" });
    const tile = getByRole("button", { name: messages.today.activityTitle });
    expect(tile).toHaveTextContent(messages.today.notRecorded);
    fireEvent.click(tile);
    expect(navigate).toHaveBeenCalledWith("TELL_JAGAON");
  });

  it("shows the latest recorded activity on the Activity tile, from any day", () => {
    const messages = getMessages("en-SG");
    const activity = (id: string, label: string, at: string, minutes?: number): TodayJournalEntry => ({
      recordId: `00000000-0000-4000-8000-0000000004${id}` as never,
      revisionId: `00000000-0000-4000-8000-0000000005${id}` as never,
      recordType: "ACTIVITY_EVENT",
      revisionNumber: 1,
      recordedAt: at as never,
      occurrenceSortInstant: at as never,
      summary: label,
      displayValue: label,
      displayContext: "WALKING",
      ...(minutes === undefined ? {} : { displayMinutes: minutes }),
    });
    const newest = activity("01", "Walked after dinner", "2026-10-01T12:30:00Z", 30);
    const older = activity("02", "Morning walk", "2026-09-30T00:20:00Z", 28);
    const { getByRole } = render(
      <TodayScreen
        messages={messages}
        locale="en-SG"
        fixture={createDemoScenarioFixture()}
        journal={{ unavailable: false, entries: [journal.entries[0]!, newest, older] }}
        navigate={vi.fn()}
        now={NOW}
      />,
    );
    const tile = getByRole("button", { name: messages.today.activityTitle });
    expect(tile).toHaveTextContent("Walked after dinner");
    expect(tile).toHaveTextContent(messages.shared.minutes(30));
    expect(tile).toHaveTextContent(formatSingaporeDateTime("en-SG", "2026-10-01T12:30:00Z" as never));
    expect(tile).not.toHaveTextContent("Morning walk");
  });

  it("shows frame 31 — no medicines recorded, never missed — after an explicit skip", () => {
    const messages = getMessages("en-SG");
    const navigate = vi.fn();
    const skipped = createDemoScenarioFixture({
      schemaVersion: 1,
      status: "SKIPPED",
      lastCompletedStep: null,
      locale: "en-SG",
      preferredName: null,
      medicines: [],
      updatedAt: "2026-10-02T04:00:00.000Z",
    });
    const { getByRole, getByText, queryByRole } = render(
      <TodayScreen messages={messages} locale="en-SG" fixture={skipped} journal={journal} navigate={navigate} now={NOW} />,
    );
    expect(getByRole("heading", { level: 1, name: messages.today.greetingNoName })).toBeInTheDocument();
    const medicines = getByRole("region", { name: messages.today.medicinesToday });
    expect(within(medicines).getByText(messages.today.noMedicinesTitle)).toBeInTheDocument();
    expect(within(medicines).getByText(messages.today.noMedicinesNotMissed)).toBeInTheDocument();
    expect(getByText(messages.today.noMedicinesNote)).toBeInTheDocument();
    expect(queryByRole("button", { name: messages.today.addRecord })).not.toBeInTheDocument();
    expect(medicines.textContent).not.toMatch(/scheduled|due|overdue/i);
    fireEvent.click(within(medicines).getByRole("button", { name: messages.onboarding.addMedicine }));
    expect(navigate).toHaveBeenCalledWith("MY_MEDICINES");
    // Unrelated synthetic sections keep working.
    expect(getByRole("button", { name: messages.today.recordReading })).toBeInTheDocument();
  });

  it("titles the card by medicines when a non-pen medicine is recorded and offers insulin only for pens", () => {
    const messages = getMessages("en-SG");
    const base = createDemoScenarioFixture();
    const tabletOnly = {
      ...base,
      recordedPrescriptions: [{ ...base.recordedPrescriptions[0]!, catalogueForm: "TABLET" as const, displayName: "Glucotab (demo)" }],
    };
    const { getByRole, queryByRole } = render(
      <TodayScreen messages={messages} locale="en-SG" fixture={tabletOnly} journal={journal} navigate={vi.fn()} now={NOW} />,
    );
    expect(getByRole("heading", { name: messages.today.medicinesToday })).toBeInTheDocument();
    expect(queryByRole("button", { name: messages.today.addRecord })).not.toBeInTheDocument();
  });

  it("does not offer insulin recording for an arbitrary free-text medicine", () => {
    const messages = getMessages("en-SG");
    const base = createDemoScenarioFixture();
    const freeTextOnly = {
      ...base,
      recordedPrescriptions: [
        {
          ...base.recordedPrescriptions[0]!,
          medicationId: "demo-medicine:free-text",
          displayName: "Aspirin",
          genericName: null,
          catalogueForm: null,
          hasReviewedInfo: false,
        },
      ],
    };
    const { queryByRole } = render(
      <TodayScreen messages={messages} locale="en-SG" fixture={freeTextOnly} journal={journal} navigate={vi.fn()} now={NOW} />,
    );
    expect(queryByRole("button", { name: messages.today.addRecord })).not.toBeInTheDocument();
  });
});

/**
 * Finding T-1 (owner-approved display correction): the measurement/event time and the recording time stay separate. An UNKNOWN occurrence
 * (`occurrenceSortInstant: null`, as the voice save writes it) is never shown at `recordedAt`, never placed in a Morning/Afternoon/Evening
 * slot, never counted as stamped and never called missing or missed; it is labelled "Time not recorded · Entered at {time}".
 */
describe.each(["en-SG", "zh-SG"] as const)("TodayScreen unknown occurrence time (T-1) %s", (locale) => {
  afterEach(() => cleanup());
  const messages = getMessages(locale);
  const fixture = createDemoScenarioFixture();
  // 00:45 on 2 Oct in Singapore: entered just after midnight, so the old fallback stamped it into Morning at 12:45 am.
  const ENTERED = "2026-10-01T16:45:00Z";
  const unknownTimeText = (when: string) => `${messages.today.timeNotRecorded} · ${messages.today.enteredAt(when)}`;
  const unknownReading: TodayJournalEntry = {
    recordId: "00000000-0000-4000-8000-000000000401" as never,
    revisionId: "00000000-0000-4000-8000-000000000402" as never,
    recordType: "GLUCOSE_READING",
    revisionNumber: 1,
    recordedAt: ENTERED as never,
    occurrenceSortInstant: null,
    summary: "6.8 mmol/L",
    displayValue: "6.8",
    displayUnit: "mmol/L",
    displayContext: "UNSPECIFIED",
  };
  const knownReading = journal.entries[0]!;

  function renderToday(entries: TodayJournalEntry[], extra?: { recordDeletion?: Parameters<typeof TodayScreen>[0]["recordDeletion"]; now?: Date }) {
    return render(
      <TodayScreen
        messages={messages}
        locale={locale}
        fixture={fixture}
        journal={{ unavailable: false, entries }}
        navigate={vi.fn()}
        now={extra?.now ?? NOW}
        recordDeletion={extra?.recordDeletion}
      />,
    );
  }
  const bookletSlots = (rendered: ReturnType<typeof renderToday>) =>
    within(rendered.container.querySelector(".booklet-slots") as HTMLElement).getAllByRole("listitem");

  it("keeps an unknown-time reading visible on its entry day without a slot or a stamp", () => {
    const rendered = renderToday([unknownReading]);
    expect(rendered.container).toHaveTextContent(messages.today.bookletProgress(0, 3));
    for (const slot of bookletSlots(rendered)) {
      expect(slot).toHaveTextContent(messages.today.notRecorded);
      expect(slot).not.toHaveTextContent("6.8");
    }
    const listed = rendered.container.querySelector(".booklet-unknown-time");
    expect(listed).toHaveTextContent("6.8");
    expect(listed).toHaveTextContent(unknownTimeText(formatSingaporeTime(locale, ENTERED)));
    expect((listed?.textContent ?? "").toLowerCase()).not.toMatch(/miss|漏|缺/);
  });

  it("stamps only the known-time reading when both are present", () => {
    // Entered at 13:00 Singapore time: the old fallback would have stamped it into Afternoon.
    const afternoonEntry = { ...unknownReading, recordedAt: "2026-10-02T05:00:00Z" as never };
    const rendered = renderToday([afternoonEntry, knownReading], { now: new Date("2026-10-02T08:00:00Z") });
    const slots = bookletSlots(rendered);
    expect(slots[0]).toHaveTextContent("6.2");
    expect(slots[1]).toHaveTextContent(messages.today.notRecorded);
    expect(slots[2]).toHaveTextContent(messages.today.notRecorded);
    expect(rendered.container).toHaveTextContent(messages.today.bookletProgress(1, 3));
    expect(rendered.container.querySelector(".booklet-unknown-time")).toHaveTextContent(
      unknownTimeText(formatSingaporeTime(locale, "2026-10-02T05:00:00Z")),
    );
  });

  it("shows the latest reading's unknown time as not recorded, with the entry time labelled, and keeps Edit time", () => {
    const rendered = renderToday([unknownReading]);
    const meta = rendered.container.querySelector(".reading-meta");
    expect(meta).toHaveTextContent(unknownTimeText(formatSingaporeTime(locale, ENTERED)));
    expect(meta?.textContent?.startsWith(messages.today.timeNotRecorded)).toBe(true);
    expect(rendered.getByRole("button", { name: messages.readingTime.editTime })).toBeInTheDocument();
  });

  it("shows the entry date with the entry time when an unknown-time reading was entered on another day", () => {
    const rendered = renderToday([unknownReading], { now: new Date("2026-10-03T04:00:00Z") });
    expect(rendered.container).toHaveTextContent(messages.today.bookletProgress(0, 3));
    expect(rendered.container.querySelector(".booklet-unknown-time")).toBeNull();
    expect(rendered.container.querySelector(".reading-meta")).toHaveTextContent(unknownTimeText(formatSingaporeDateTime(locale, ENTERED)));
  });

  it("leaves a known-time reading exactly as before (regression)", () => {
    const rendered = renderToday([knownReading]);
    const meta = rendered.container.querySelector(".reading-meta");
    expect(meta).toHaveTextContent(formatSingaporeTime(locale, knownReading.occurrenceSortInstant!));
    expect(meta).not.toHaveTextContent(messages.today.timeNotRecorded);
    expect(rendered.container.querySelector(".booklet-unknown-time")).toBeNull();
    expect(bookletSlots(rendered)[0]).toHaveTextContent(formatSingaporeTime(locale, knownReading.occurrenceSortInstant!));
  });

  it("labels a medicine event with an unknown time as entered, and keeps a known time as recorded", () => {
    const medicine = (occurrence: string | null, id: string): TodayJournalEntry => ({
      recordId: `00000000-0000-4000-8000-00000000${id}` as never,
      revisionId: `00000000-0000-4000-8000-00000001${id}` as never,
      recordType: "MEDICATION_EVENT",
      revisionNumber: 1,
      recordedAt: ENTERED as never,
      occurrenceSortInstant: occurrence as never,
      summary: "Medicine",
      displayContext: fixture.recordedPrescriptions[0]!.medicationRecordId,
    });
    const group = (rendered: ReturnType<typeof renderToday>) =>
      rendered.getByRole("group", { name: fixture.recordedPrescriptions[0]!.displayName });

    const unknown = renderToday([medicine(null, "0501")]);
    expect(group(unknown)).toHaveTextContent(unknownTimeText(formatSingaporeTime(locale, ENTERED)));
    expect(group(unknown)).not.toHaveTextContent(messages.shared.recordedAt(formatSingaporeTime(locale, ENTERED)));
    unknown.unmount();

    const known = renderToday([medicine("2026-10-02T01:00:00Z", "0502")]);
    expect(group(known)).toHaveTextContent(messages.shared.recordedAt(formatSingaporeTime(locale, "2026-10-02T01:00:00Z")));
    expect(group(known)).not.toHaveTextContent(messages.today.timeNotRecorded);
  });

  it("names the unknown time and the entry date-time in the deletion dialog; a known time is unchanged", () => {
    const port = { prepare: () => new Promise<never>(() => {}), confirm: vi.fn() };
    const unknown = renderToday([unknownReading], { recordDeletion: port });
    fireEvent.click(unknown.getByRole("button", { name: messages.packet10.deletion.deleteRecordAction }));
    expect(unknown.container.ownerDocument.querySelector(".data-plan-meta")).toHaveTextContent(
      unknownTimeText(formatSingaporeDateTime(locale, ENTERED)),
    );
    unknown.unmount();

    const known = renderToday([knownReading], { recordDeletion: port });
    fireEvent.click(known.getByRole("button", { name: messages.packet10.deletion.deleteRecordAction }));
    const when = known.container.ownerDocument.querySelector(".data-plan-meta");
    expect(when).toHaveTextContent(formatSingaporeDateTime(locale, knownReading.occurrenceSortInstant!));
    expect(when).not.toHaveTextContent(messages.today.timeNotRecorded);
  });
});
