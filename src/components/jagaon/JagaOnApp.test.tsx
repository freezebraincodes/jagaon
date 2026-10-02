import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  GlucoseRecordViewModel,
  JournalCommitResult,
  TodayJournalEntry,
  TodayJournalViewModel,
} from "@/application/journal/journal-contracts";
import type { JagaOnRuntime } from "@/application/journal/browser-journal-runtime";
import { getMessages } from "@/i18n/get-messages";
import { createDemoScenarioFixture } from "@/application/governed/demo-scenario-fixture";
import { JagaOnApp } from "./JagaOnApp";

afterEach(() => cleanup());

const committed: JournalCommitResult = {
  kind: "COMMITTED",
  recordId: "00000000-0000-4000-8000-000000000201" as never,
  revisionId: "00000000-0000-4000-8000-000000000202" as never,
};

function fakeRuntime(): JagaOnRuntime {
  let today: TodayJournalViewModel = { entries: [], unavailable: false };
  let glucose: GlucoseRecordViewModel | null = null;

  function upsert(entry: TodayJournalEntry) {
    today = {
      unavailable: false,
      entries: [
        entry,
        ...today.entries.filter((candidate) => candidate.recordId !== entry.recordId),
      ],
    };
  }

  const commands = {
    recordGlucose: vi.fn(async (input) => {
      if (committed.kind !== "COMMITTED") return committed;
      glucose = {
        recordId: committed.recordId,
        revisionId: committed.revisionId,
        revisionNumber: 1,
        recordedAt: input.recordedAt,
        payload: input.payload,
        temporal: input.temporal,
      };
      upsert({
        recordId: committed.recordId,
        revisionId: committed.revisionId,
        recordType: "GLUCOSE_READING",
        revisionNumber: 1,
        recordedAt: input.recordedAt,
        occurrenceSortInstant: input.temporal.occurrence.kind === "EXACT" ? input.temporal.occurrence.instantUtc : null,
        summary: `${input.payload.measurement.enteredValue} mmol/L`,
        displayValue: input.payload.measurement.enteredValue,
        displayUnit: "mmol/L",
        displayContext: input.payload.context.kind === "PATIENT_SELECTED_SLOT"
          ? input.payload.context.slot
          : "UNSPECIFIED",
      });
      return committed;
    }),
    correctGlucoseTime: vi.fn(async (input) => {
      if (committed.kind !== "COMMITTED" || !glucose) return committed;
      glucose = {
        ...glucose,
        revisionId: committed.revisionId,
        revisionNumber: glucose.revisionNumber + 1,
        recordedAt: input.recordedAt,
        temporal: input.temporal,
      };
      upsert({
        recordId: glucose.recordId,
        revisionId: glucose.revisionId,
        recordType: "GLUCOSE_READING",
        revisionNumber: glucose.revisionNumber,
        recordedAt: glucose.recordedAt,
        occurrenceSortInstant: input.temporal.occurrence.kind === "EXACT" ? input.temporal.occurrence.instantUtc : null,
        summary: `${glucose.payload.measurement.enteredValue} mmol/L`,
        displayValue: glucose.payload.measurement.enteredValue,
        displayUnit: "mmol/L",
        displayContext: glucose.payload.context.kind === "PATIENT_SELECTED_SLOT"
          ? glucose.payload.context.slot
          : "UNSPECIFIED",
      });
      return committed;
    }),
    recordInsulin: vi.fn(async (input) => {
      const amount = input.payload.amountTaken.kind === "KNOWN"
        ? input.payload.amountTaken.amount
        : undefined;
      upsert({
        recordId: "00000000-0000-4000-8000-000000000211" as never,
        revisionId: "00000000-0000-4000-8000-000000000212" as never,
        recordType: "MEDICATION_EVENT",
        revisionNumber: 1,
        recordedAt: input.recordedAt,
        occurrenceSortInstant: input.temporal.occurrence.kind === "EXACT" ? input.temporal.occurrence.instantUtc : null,
        summary: amount ? `Insulin · ${amount.value} ${amount.unit}` : "Taken",
        ...(amount ? { displayValue: amount.value, displayUnit: amount.unit } : {}),
        displayContext: input.payload.medication.recordId,
      });
      return committed;
    }),
    recordMeal: vi.fn(async (input) => {
      const firstItem = input.payload.items[0]?.label ?? "Meal recorded";
      upsert({
        recordId: "00000000-0000-4000-8000-000000000221" as never,
        revisionId: "00000000-0000-4000-8000-000000000222" as never,
        recordType: "INTAKE_EVENT",
        revisionNumber: 1,
        recordedAt: input.recordedAt,
        occurrenceSortInstant: input.temporal.occurrence.kind === "EXACT" ? input.temporal.occurrence.instantUtc : null,
        summary: firstItem,
        displayValue: firstItem,
        displayContext: input.payload.intakeSlot?.code ?? "OTHER",
      });
      return committed;
    }),
  };

  const resetDemo = vi.fn(async () => {
    today = { entries: [], unavailable: false };
    glucose = null;
  });

  return {
    databaseName: "fake",
    commands,
    query: {
      loadToday: vi.fn(async () => today),
      loadGlucose: vi.fn(async (recordId) =>
        glucose?.recordId === recordId ? glucose : null,
      ),
    },
    resolveLocale: vi.fn(async () => "en-SG" as const),
    persistLocale: vi.fn(async () => undefined),
    resetDemo,
    close: vi.fn(),
  };
}

describe("JagaOnApp journal integration", () => {
  it("refreshes Today from the query port after a committed glucose entry", async () => {
    const runtime = fakeRuntime();
    render(<JagaOnApp runtimeFactory={async () => runtime} />);

    await waitFor(() => expect(runtime.query.loadToday).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Record a reading" }));
    // Navigation moves focus to the new screen's heading.
    expect(screen.getByRole("heading", { level: 1, name: "Record a reading" })).toHaveFocus();
    fireEvent.click(screen.getByRole("radio", { name: "Before breakfast" }));
    fireEvent.change(screen.getByLabelText(/Reading \(mmol\/L\)/), {
      target: { value: "6.8" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save reading" }));

    await screen.findByText("Reading saved");
    await waitFor(() => expect(runtime.query.loadToday).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect((await screen.findAllByText("6.8")).length).toBeGreaterThan(0);
  });

  it("completes the Packet 6 bilingual journal journey and clears it on reset", async () => {
    const en = getMessages("en-SG");
    const zh = getMessages("zh-SG");
    const runtime = fakeRuntime();
    render(<JagaOnApp runtimeFactory={async () => runtime} />);

    await screen.findByRole("button", { name: en.today.recordReading });
    fireEvent.click(screen.getByRole("button", { name: en.today.recordReading }));
    fireEvent.click(screen.getByRole("radio", { name: en.glucose.contextBeforeBreakfast }));
    fireEvent.change(screen.getByLabelText(/Reading \(mmol\/L\)/), {
      target: { value: "6.8" },
    });
    fireEvent.click(screen.getByRole("button", { name: en.glucose.saveAction }));
    await screen.findByText(en.glucose.saved);
    fireEvent.click(screen.getByRole("button", { name: en.shared.back }));
    expect((await screen.findAllByText("6.8")).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: en.readingTime.editTime }));
    await screen.findByText(en.readingTime.sameAsCurrent);
    fireEvent.change(screen.getByLabelText(en.readingTime.newTime), {
      target: { value: "09:15" },
    });
    fireEvent.click(screen.getByRole("button", { name: en.readingTime.saveOccurrence }));
    await screen.findByText(en.readingTime.saved);
    expect(runtime.commands.correctGlucoseTime).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: en.shared.back }));

    fireEvent.click(screen.getByRole("button", { name: en.today.addRecord }));
    fireEvent.change(screen.getByLabelText(/Amount taken \(units\)/), {
      target: { value: "8" },
    });
    fireEvent.click(screen.getByRole("button", { name: en.insulin.saveAction }));
    await screen.findByText(en.insulin.saved);
    fireEvent.click(screen.getByRole("button", { name: en.shared.back }));
    const glargine = createDemoScenarioFixture().recordedPrescriptions[0]!;
    const insulinGroup = await screen.findByRole("group", { name: glargine.displayName });
    expect(within(insulinGroup).getByText(`8 ${en.insulin.unit}`)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: en.today.mealTitle }));
    fireEvent.click(screen.getByRole("radio", { name: en.meal.kindMeal }));
    fireEvent.click(screen.getByRole("button", { name: en.meal.breakfast }));
    fireEvent.click(screen.getByRole("button", { name: en.meal.somethingElse }));
    fireEvent.change(screen.getByLabelText(en.meal.itemLabel), {
      target: { value: "Brown rice" },
    });
    fireEvent.click(screen.getByRole("button", { name: en.meal.saveIntake }));
    await screen.findByText(en.meal.saved);
    fireEvent.click(screen.getByRole("button", { name: en.shared.back }));
    expect(await screen.findByText(`${en.meal.breakfast}: Brown rice`)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: en.shared.navMore }));
    fireEvent.click(screen.getByRole("button", { name: en.medication.screenTitle }));
    expect((await screen.findAllByText(en.medication.reviewedTag)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(en.medication.recordedVerbatim).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: en.shared.back }));

    fireEvent.click(screen.getByRole("button", { name: new RegExp(en.more.foodInformation) }));
    fireEvent.click(screen.getByRole("button", { name: en.food.useCurrentLocation }));
    await screen.findByText(en.food.prePermissionTitle);
    fireEvent.click(screen.getByRole("button", { name: en.food.usePostalInstead }));
    expect(await screen.findByText(en.food.permissionDeniedTitle)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(en.food.locationPlaceholder)).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: en.shared.back }));

    // Language and reset are part of More (frame 12), not a separate route.
    fireEvent.click(screen.getByRole("button", { name: en.settings.chinese }));
    expect(await screen.findByText(zh.settings.languageSaved)).toBeInTheDocument();
    expect(runtime.persistLocale).toHaveBeenCalledWith("zh-SG");
    expect(document.documentElement.lang).toBe("zh-SG");
    expect(screen.getByRole("heading", { level: 1, name: zh.more.title })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: new RegExp(zh.more.helpInfo) }));
    expect(await screen.findByRole("link", { name: new RegExp(zh.help.call995) })).toHaveAttribute("href", "tel:995");
    expect(screen.getByRole("link", { name: new RegExp(zh.help.nurseFirst) })).toHaveAttribute("href", "tel:62626262");
    expect(screen.getByRole("link", { name: new RegExp(zh.help.accessibleEmergency) })).toHaveAttribute(
      "href",
      "sms:70995",
    );
    expect(screen.queryByText(/1777/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: zh.shared.back }));

    fireEvent.click(screen.getByRole("button", { name: zh.settings.resetAction }));
    fireEvent.click(screen.getByRole("button", { name: zh.settings.resetConfirm }));

    expect(await screen.findByText(en.today.greeting("Alex"))).toBeInTheDocument();
    expect(runtime.resetDemo).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("6.8")).not.toBeInTheDocument();
    expect(screen.queryByText("Brown rice")).not.toBeInTheDocument();
  });
  it("leaves Today unchanged when every journal write is rejected or fails", async () => {
    const en = getMessages("en-SG");
    const fixture = createDemoScenarioFixture();
    const runtime = fakeRuntime();
    const occurredAt = new Date(Date.now() - 60_000).toISOString();
    const existing: TodayJournalEntry = {
      recordId: "00000000-0000-4000-8000-000000000401" as never,
      revisionId: "00000000-0000-4000-8000-000000000402" as never,
      recordType: "GLUCOSE_READING",
      revisionNumber: 1,
      recordedAt: occurredAt as never,
      occurrenceSortInstant: occurredAt as never,
      summary: "6.2 mmol/L",
      displayValue: "6.2",
      displayUnit: "mmol/L",
      displayContext: "UNSPECIFIED",
    };
    const stored: TodayJournalViewModel = { unavailable: false, entries: [existing] };
    const storedGlucose: GlucoseRecordViewModel = {
      recordId: existing.recordId,
      revisionId: existing.revisionId,
      revisionNumber: 1,
      recordedAt: existing.recordedAt,
      payload: {
        measurement: { enteredValue: "6.2" as never, enteredUnit: "MMOL_L", normalization: null },
        measurementMethod: "FINGERSTICK_METER",
        context: { kind: "UNSPECIFIED" },
      },
      temporal: {
        kind: "POINT",
        occurrence: {
          kind: "EXACT",
          instantUtc: occurredAt as never,
          timeZoneId: "Asia/Singapore",
          utcOffsetMinutes: 480,
        },
      },
    };
    runtime.query.loadToday = vi.fn(async () => stored);
    runtime.query.loadGlucose = vi.fn(async () => storedGlucose);
    runtime.commands.recordGlucose = vi.fn(async () => ({ kind: "FAILED", code: "STORAGE_UNAVAILABLE" }) as const);
    runtime.commands.correctGlucoseTime = vi.fn(async () => ({ kind: "REJECTED", code: "HEAD_CONFLICT" }) as const);
    runtime.commands.recordInsulin = vi.fn(async () => ({ kind: "FAILED", code: "COMMIT_FAILED" }) as const);
    runtime.commands.recordMeal = vi.fn(async () => ({ kind: "FAILED", code: "VALIDATION_FAILED" }) as const);

    render(<JagaOnApp runtimeFactory={async () => runtime} />);
    await screen.findByRole("button", { name: en.today.recordReading });
    await waitFor(() => expect(screen.getByRole("button", { name: en.today.recordReading })).toBeEnabled());
    const todayText = () => screen.getByRole("main").textContent;
    const initialToday = todayText();
    expect(initialToday).toContain("6.2");

    // Glucose write fails.
    fireEvent.click(screen.getByRole("button", { name: en.today.recordReading }));
    fireEvent.click(screen.getByRole("radio", { name: en.glucose.contextBedtime }));
    fireEvent.change(screen.getByLabelText(/Reading \(mmol\/L\)/), { target: { value: "9.9" } });
    fireEvent.click(screen.getByRole("button", { name: en.glucose.saveAction }));
    expect(await screen.findByText(en.shared.notSaved)).toBeInTheDocument();
    expect(screen.queryByText(en.glucose.saved)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en.shared.back }));
    expect(todayText()).toBe(initialToday);
    expect(screen.queryByText("9.9")).not.toBeInTheDocument();

    // Time correction hits a stale head.
    fireEvent.click(screen.getByRole("button", { name: en.readingTime.editTime }));
    await screen.findByText(en.readingTime.sameAsCurrent);
    fireEvent.change(screen.getByLabelText(en.readingTime.newTime), { target: { value: "00:01" } });
    fireEvent.click(screen.getByRole("button", { name: en.readingTime.saveOccurrence }));
    expect(await screen.findByText(en.shared.notSaved)).toBeInTheDocument();
    expect(screen.queryByText(en.readingTime.saved)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en.shared.back }));
    expect(todayText()).toBe(initialToday);

    // Insulin write fails.
    fireEvent.click(screen.getByRole("button", { name: en.today.addRecord }));
    fireEvent.change(screen.getByLabelText(/Amount taken \(units\)/), { target: { value: "8" } });
    fireEvent.click(screen.getByRole("button", { name: en.insulin.saveAction }));
    expect(await screen.findByText(en.shared.notSaved)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en.shared.back }));
    const glargine = screen.getByRole("group", { name: fixture.recordedPrescriptions[0]!.displayName });
    expect(within(glargine).getByText(en.today.notRecorded)).toBeInTheDocument();
    expect(todayText()).toBe(initialToday);

    // Meal write fails.
    fireEvent.click(screen.getByRole("button", { name: en.today.mealTitle }));
    fireEvent.click(screen.getByRole("button", { name: en.meal.somethingElse }));
    fireEvent.change(screen.getByLabelText(en.meal.itemLabel), { target: { value: "Brown rice" } });
    fireEvent.click(screen.getByRole("button", { name: en.meal.saveIntake }));
    expect(await screen.findByText(en.shared.notSaved)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en.shared.back }));
    expect(screen.queryByText(/Brown rice/)).not.toBeInTheDocument();
    expect(todayText()).toBe(initialToday);

    // Today was never re-queried for a write that did not commit.
    expect(runtime.query.loadToday).toHaveBeenCalledTimes(1);
  });
  it("shows Booklet and History as disabled later-packet tabs that never navigate", async () => {
    const en = getMessages("en-SG");
    const runtime = fakeRuntime();
    render(<JagaOnApp runtimeFactory={async () => runtime} />);
    await screen.findByRole("button", { name: en.today.recordReading });

    const nav = screen.getByRole("navigation");
    const tabs = within(nav).getAllByRole("button");
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      en.shared.navToday,
      en.shared.navBooklet,
      en.shared.navHistory,
      en.shared.navMore,
    ]);
    for (const label of [en.shared.navBooklet, en.shared.navHistory]) {
      const tab = within(nav).getByRole("button", { name: label });
      expect(tab).toHaveAttribute("aria-disabled", "true");
      expect(tab).toHaveAccessibleDescription(en.today.futureFeature);
      fireEvent.click(tab);
      expect(within(nav).getByRole("button", { name: en.shared.navToday })).toHaveAttribute("aria-current", "page");
    }
  });
});
