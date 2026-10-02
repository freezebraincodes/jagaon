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
import {
  createDemoOnboardingRepository,
  createMemoryOnboardingStorage,
  DEMO_ONBOARDING_STORAGE_KEY,
  type DemoOnboardingStoragePort,
} from "@/application/onboarding/demo-onboarding-repository";
import { createPreparedOnboardingState } from "@/application/onboarding/prepared-onboarding-fixture";
import type { DemoOnboardingStateV1 } from "@/application/onboarding/demo-onboarding-contracts";

afterEach(() => cleanup());

const NOW = "2026-10-02T08:00:00.000Z";

/** Onboarding storage seeded with a raw payload under the versioned key. */
function onboardingStorage(payload?: DemoOnboardingStateV1 | string, extra: Record<string, string> = {}) {
  const initial: Record<string, string> = { ...extra };
  if (payload !== undefined) {
    initial[DEMO_ONBOARDING_STORAGE_KEY] = typeof payload === "string" ? payload : JSON.stringify(payload);
  }
  const storage: DemoOnboardingStoragePort = createMemoryOnboardingStorage(initial);
  return { storage, factory: () => createDemoOnboardingRepository(storage) };
}

/** A completed prepared setup, so journal tests start on Today. */
const completed = () => onboardingStorage(createPreparedOnboardingState("en-SG", NOW)).factory;

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
  it("does not erase IndexedDB when onboarding storage cannot be cleared", async () => {
    const messages = getMessages("en-SG");
    const runtime = fakeRuntime();
    const state = createPreparedOnboardingState("en-SG", NOW);
    const repository = createDemoOnboardingRepository({
      getItem: () => JSON.stringify(state),
      setItem: () => undefined,
      removeItem: () => {
        throw new Error("storage unavailable");
      },
    });
    render(<JagaOnApp runtimeFactory={async () => runtime} onboardingRepositoryFactory={() => repository} />);
    await screen.findByRole("button", { name: messages.today.recordReading });
    fireEvent.click(screen.getByRole("button", { name: messages.shared.navMore }));
    fireEvent.click(screen.getByRole("button", { name: messages.settings.resetAction }));
    fireEvent.click(screen.getByRole("button", { name: messages.settings.resetConfirm }));
    expect(await screen.findByText(messages.shared.storageUnavailable)).toBeInTheDocument();
    expect(runtime.resetDemo).not.toHaveBeenCalled();
  });

  it("refreshes Today from the query port after a committed glucose entry", async () => {
    const runtime = fakeRuntime();
    render(<JagaOnApp runtimeFactory={async () => runtime} onboardingRepositoryFactory={completed()} />);

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
    render(<JagaOnApp runtimeFactory={async () => runtime} onboardingRepositoryFactory={completed()} />);

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
    // My medicines (management list) links to the reviewed information.
    expect(screen.getByRole("heading", { level: 1, name: en.medication.screenTitle })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en.onboarding.medicineInformationLink }));
    expect((await screen.findAllByText(en.medication.reviewedTag)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(en.medication.recordedVerbatim).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: en.shared.back }));
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

    // A full demo reset clears IndexedDB and the onboarding key: back to Welcome.
    expect(await screen.findByRole("heading", { level: 1, name: en.onboarding.welcomeTitle })).toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
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

    render(<JagaOnApp runtimeFactory={async () => runtime} onboardingRepositoryFactory={completed()} />);
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
    render(<JagaOnApp runtimeFactory={async () => runtime} onboardingRepositoryFactory={completed()} />);
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

describe("JagaOnApp onboarding startup gate", () => {
  const en = getMessages("en-SG");

  function start(storage: ReturnType<typeof onboardingStorage>) {
    const runtime = fakeRuntime();
    render(<JagaOnApp runtimeFactory={async () => runtime} onboardingRepositoryFactory={storage.factory} />);
    return runtime;
  }

  it("opens Welcome with no bottom navigation when nothing is saved", async () => {
    start(onboardingStorage());
    expect(await screen.findByRole("heading", { level: 1, name: en.onboarding.welcomeTitle })).toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  });

  it.each([
    ["malformed JSON", "{oops"],
    ["an unknown version", JSON.stringify({ ...createPreparedOnboardingState("en-SG", NOW), schemaVersion: 9 })],
  ])("clears only the onboarding key and opens Welcome for %s", async (_label, payload) => {
    const storage = onboardingStorage(payload, { "jagaon:other": "keep" });
    start(storage);
    expect(await screen.findByRole("heading", { level: 1, name: en.onboarding.welcomeTitle })).toBeInTheDocument();
    expect(storage.storage.getItem(DEMO_ONBOARDING_STORAGE_KEY)).toBeNull();
    expect(storage.storage.getItem("jagaon:other")).toBe("keep");
  });

  it("opens Resume for an in-progress setup", async () => {
    start(
      onboardingStorage({
        ...createPreparedOnboardingState("en-SG", NOW),
        status: "IN_PROGRESS",
        lastCompletedStep: "PROFILE",
      }),
    );
    expect(await screen.findByRole("heading", { level: 1, name: en.onboarding.resumeTitle })).toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  });

  it("opens Today with the setup's name, locale and medicines once completed", async () => {
    const zh = getMessages("zh-SG");
    start(onboardingStorage({ ...createPreparedOnboardingState("zh-SG", NOW), preferredName: "陈女士（示例）" }));
    expect(await screen.findByRole("heading", { level: 1, name: zh.today.greeting("陈女士（示例）") })).toBeInTheDocument();
    expect(screen.getByRole("navigation")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Nocturin pen (demo)" })).toBeInTheDocument();
  });

  it("opens a neutral Today with no medicines after an explicit skip, and adds one from there", async () => {
    const storage = onboardingStorage({
      schemaVersion: 1,
      status: "SKIPPED",
      lastCompletedStep: null,
      locale: "en-SG",
      preferredName: null,
      medicines: [],
      updatedAt: NOW,
    });
    start(storage);
    expect(await screen.findByRole("heading", { level: 1, name: en.today.greetingNoName })).toBeInTheDocument();
    expect(screen.getByText(en.today.noMedicinesTitle)).toBeInTheDocument();
    expect(screen.getByText(en.today.noMedicinesNotMissed)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: en.today.addRecord })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: en.onboarding.addMedicine }));
    expect(screen.getByRole("heading", { level: 1, name: en.medication.screenTitle })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en.onboarding.addMedicine }));
    fireEvent.click(screen.getByRole("radio", { name: /Veltora pen \(demo\)/ }));
    fireEvent.click(screen.getByRole("button", { name: en.shared.continue }));
    fireEvent.click(screen.getByRole("button", { name: en.onboarding.saveRecorded }));
    expect(screen.getByRole("heading", { level: 1, name: en.medication.screenTitle })).toBeInTheDocument();
    const saved = JSON.parse(storage.storage.getItem(DEMO_ONBOARDING_STORAGE_KEY)!);
    expect(saved).toMatchObject({ status: "COMPLETED" });
    expect(saved.medicines[0]).toMatchObject({ displayName: "Veltora pen (demo)", reviewedContentKey: "insulin-aspart" });

    fireEvent.click(screen.getByRole("button", { name: en.shared.back }));
    expect(screen.getByRole("group", { name: "Veltora pen (demo)" })).toBeInTheDocument();
  });

  it("enters the journal from completion and hands Review my medicines to My medicines", async () => {
    start(onboardingStorage());
    await screen.findByRole("heading", { level: 1, name: en.onboarding.welcomeTitle });
    fireEvent.click(screen.getByRole("button", { name: en.onboarding.startSetup }));
    fireEvent.click(screen.getByRole("button", { name: en.shared.continue }));
    fireEvent.click(screen.getByRole("button", { name: en.onboarding.addMedicine }));
    fireEvent.click(screen.getByRole("radio", { name: /Glucotab \(demo\)/ }));
    fireEvent.click(screen.getByRole("button", { name: en.shared.continue }));
    fireEvent.click(screen.getByRole("button", { name: en.onboarding.saveRecorded }));
    fireEvent.click(screen.getByRole("button", { name: en.onboarding.finishSetup }));
    fireEvent.click(screen.getByRole("button", { name: en.onboarding.reviewMedicines }));
    expect(screen.getByRole("heading", { level: 1, name: en.medication.screenTitle })).toBeInTheDocument();
    expect(screen.getByText("Glucotab (demo)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en.shared.back }));
    expect(screen.getByRole("navigation")).toBeInTheDocument();
  });

  it("does not claim reset success when the onboarding key cannot be cleared", async () => {
    const storage = onboardingStorage(createPreparedOnboardingState("en-SG", NOW));
    const failing = {
      factory: () =>
        createDemoOnboardingRepository({
          ...storage.storage,
          getItem: storage.storage.getItem,
          setItem: storage.storage.setItem,
          removeItem: () => {
            throw new Error("blocked");
          },
        }),
    };
    start({ ...storage, factory: failing.factory });
    await screen.findByRole("button", { name: en.today.recordReading });
    fireEvent.click(screen.getByRole("button", { name: en.shared.navMore }));
    fireEvent.click(screen.getByRole("button", { name: en.settings.resetAction }));
    fireEvent.click(screen.getByRole("button", { name: en.settings.resetConfirm }));
    expect(await screen.findByText(en.shared.storageUnavailable)).toBeInTheDocument();
    expect(screen.queryByText(en.settings.resetDone)).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1, name: en.onboarding.welcomeTitle })).not.toBeInTheDocument();
  });
});
