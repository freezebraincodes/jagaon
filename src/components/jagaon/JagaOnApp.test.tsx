import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  GlucoseRecordViewModel,
  JournalCommitResult,
  TodayJournalEntry,
  TodayJournalViewModel,
} from "@/application/journal/journal-contracts";
import type { BrowserJournalRuntimeOptions, JagaOnRuntime } from "@/application/journal/browser-journal-runtime";
import { getMessages } from "@/i18n/get-messages";
import { createDemoScenarioFixture } from "@/application/governed/demo-scenario-fixture";
import { JagaOnApp, type DeleteAllPortFactory } from "./JagaOnApp";
import { createDeleteDatasetService } from "@/storage/delete-dataset";
import { JagaOnStorageLockedError, LocalStateCleanupUnconfirmedError } from "@/application/journal/browser-journal-runtime";
import { lockStateFor } from "@/application/storage/integrity-gate";
import { storageFailure } from "@/storage/storage-failure";

/** Packet 10A: the real delete-all service over fake tab and IndexedDB ports. */
function fakeDeleteAll(options: { otherTabOpen?: boolean } = {}) {
  const calls = { deleted: 0, closed: 0 };
  const factory: DeleteAllPortFactory = (hooks) =>
    createDeleteDatasetService({
      databaseName: hooks.databaseName,
      now: () => new Date().toISOString() as never,
      coordinator: { acquireExclusive: async () => (options.otherTabOpen ? null : () => undefined), announceDeleted: () => undefined },
      deletion: {
        deleteDatabase: async () => {
          calls.deleted += 1;
        },
        exists: async () => false,
      },
      closeOwnConnections: () => {
        calls.closed += 1;
        hooks.closeRuntime();
      },
      clearLocalState: hooks.clearLocalState,
    });
  return { factory, calls };
}

function confirmDeleteAll(messages: ReturnType<typeof getMessages>) {
  fireEvent.click(screen.getByRole("button", { name: messages.packet10.hub.deleteAll }));
  const dialog = within(screen.getByRole("alertdialog"));
  fireEvent.change(dialog.getByLabelText(messages.packet10.deletion.typeToConfirm), { target: { value: "DELETE" } });
  fireEvent.click(dialog.getByRole("button", { name: messages.packet10.deletion.deleteAllAction }));
}
import { APPOINTMENT_NOTE_SELECTION_KEY } from "@/application/history/appointment-note-selection";
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

/** `options` models the runtime marker contract: an explicit cleanup request leaves the marker pending. */
function fakeRuntime(options?: BrowserJournalRuntimeOptions): JagaOnRuntime {
  let markerPending = options?.localStateCleanup?.when === "ALWAYS";
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
    recordActivity: vi.fn(async () => committed),
  };

  const resetDemo = vi.fn(async () => {
    today = { entries: [], unavailable: false };
    glucose = null;
  });

  return {
    databaseName: "fake",
    integrityLock: () => null,
    onIntegrityLock: () => () => undefined,
    commands,
    query: {
      loadToday: vi.fn(async () => today),
      loadGlucose: vi.fn(async (recordId) =>
        glucose?.recordId === recordId ? glucose : null,
      ),
    },
    history: {
      load: vi.fn(async ({ period }: { period: "THIS_WEEK" | "LAST_WEEK" | "THIRTY_DAYS" }) => ({
        status: "EMPTY" as const,
        period,
        range: { startDate: "2026-09-28" as never, endDate: "2026-10-04" as never },
        unavailableFamilies: [],
      })),
    },
    medicationSchedule: {
      load: vi.fn(async () => ({
        status: "READY" as const,
        today: "2026-10-04",
        yesterday: "2026-10-03",
        occasions: [],
        withoutFixedTime: [],
        window: { startDate: "2026-09-21", endDate: "2026-10-04" },
        counts: [],
        excludedCorrected: 0,
        unrecordedCount: 0,
        reminders: [],
        careQuestions: [],
      })),
      recordOccasion: vi.fn(),
      correctOccasion: vi.fn(),
      openBarrierQuestion: vi.fn(),
      answerBarrier: vi.fn(),
      snoozeBarrier: vi.fn(),
      dismissBarrier: vi.fn(),
      correctBarrier: vi.fn(),
      removeBarrier: vi.fn(),
      saveReminder: vi.fn(),
      saveCareQuestion: vi.fn(),
      editCareQuestion: vi.fn(),
      dismissCareQuestion: vi.fn(),
    },
    carePreparation: {
      commands: {
        prepare: vi.fn(async () => ({ kind: "REJECTED" as const, code: "SUMMARY_SELECTION_EMPTY" as const })),
        markPreviewed: vi.fn(),
        approve: vi.fn(),
        invalidate: vi.fn(),
        supersede: vi.fn(),
        requestPrintExport: vi.fn(),
        completePrintExport: vi.fn(),
        recoverInterruptedExports: vi.fn(async () => 0),
      },
      query: { loadSummary: vi.fn(async () => ({ status: "NOT_FOUND" as const })) },
    },
    careOrganisation: {
      query: {
        loadPreventiveCare: vi.fn(async () => ({ status: "READY" as const, items: [] })),
        loadVisitPreparation: vi.fn(async () => ({
          status: "READY" as const,
          appointment: null,
          questions: [],
          period: { startAt: "2026-09-04T16:00:00.000Z" as never, endAtExclusive: "2026-10-04T16:00:00.000Z" as never, startDate: "2026-09-05", endDate: "2026-10-04" },
          factGroups: (["GLUCOSE", "INSULIN", "MEALS", "WALKS"] as const).map((key) => ({ key, sources: [] })),
        })),
      },
      commands: {
        createPreventiveItem: vi.fn(),
        revisePreventiveItem: vi.fn(),
        recordPreventiveOutcome: vi.fn(),
        correctPreventiveOutcome: vi.fn(),
        undoPreventiveOutcome: vi.fn(),
        scheduleAppointment: vi.fn(),
        reviseAppointment: vi.fn(),
        recordContextWindow: vi.fn(),
        reviseContextWindow: vi.fn(),
        createCareQuestion: vi.fn(),
        reviseCareQuestion: vi.fn(),
      },
    },
    resolveLocale: vi.fn(async () => "en-SG" as const),
    persistLocale: vi.fn(async () => undefined),
    resetDemo,
    recordDeletion: { prepare: vi.fn(), confirm: vi.fn() },
    backup: { export: vi.fn() },
    datasetLifecycle: "EXISTING" as "CREATED" | "MIGRATED" | "EXISTING",
    localStateCleanup: {
      isPending: vi.fn(async () => markerPending),
      complete: vi.fn(async () => {
        markerPending = false;
      }),
    },
    close: vi.fn(),
  };
}

describe("JagaOnApp journal integration", () => {
  it("finishes the database deletion truthfully even when the onboarding key cannot be cleared (Corrective Pass A item 5)", async () => {
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
    const deleteAll = fakeDeleteAll();
    render(<JagaOnApp runtimeFactory={async () => runtime} onboardingRepositoryFactory={() => repository} appointmentNoteStorageFactory={() => createMemoryOnboardingStorage()} deleteAllPortFactory={deleteAll.factory} />);
    await screen.findByRole("button", { name: messages.today.recordReading });
    fireEvent.click(screen.getByRole("button", { name: messages.shared.navMore }));
    confirmDeleteAll(messages);
    // The database is deleted; setup restarts and nothing claims that nothing was deleted.
    // Corrective Pass B item 5: nor that all local data was deleted while the key remains.
    expect(await screen.findByRole("heading", { level: 1, name: messages.onboarding.welcomeTitle })).toBeInTheDocument();
    expect(screen.queryByText(messages.packet10.deletion.deleteAllDone)).not.toBeInTheDocument();
    expect(screen.queryByText(messages.packet10.deletion.deleteBlockedUnchanged)).not.toBeInTheDocument();
    expect(screen.queryByText(messages.packet10.shared.recordsUnchanged)).not.toBeInTheDocument();
    expect(deleteAll.calls).toEqual({ deleted: 1, closed: 1 });
  });

  describe("delete-all local-state cleanup outcome (Corrective Pass B item 5)", () => {
    /** A storage port whose `removeItem` throws `failures` times (Infinity: always). */
    function flakyStorage(initial: Record<string, string>, failures: number) {
      const memory = createMemoryOnboardingStorage(initial);
      let remaining = failures;
      const port: DemoOnboardingStoragePort = {
        getItem: (key) => memory.getItem(key),
        setItem: (key, value) => memory.setItem(key, value),
        removeItem: (key) => {
          if (remaining > 0) {
            remaining -= 1;
            throw new Error("storage unavailable");
          }
          memory.removeItem(key);
        },
      };
      return port;
    }
    const setup = createPreparedOnboardingState("en-SG", NOW);
    const notes = { [APPOINTMENT_NOTE_SELECTION_KEY]: JSON.stringify({ schemaVersion: 1, selections: [] }) };

    async function deleteEverything(onboarding: DemoOnboardingStoragePort, appointmentNotes: DemoOnboardingStoragePort) {
      const messages = getMessages("en-SG");
      const deleteAll = fakeDeleteAll();
      render(
        <JagaOnApp
          runtimeFactory={async (_name, options) => fakeRuntime(options)}
          onboardingRepositoryFactory={() => createDemoOnboardingRepository(onboarding)}
          appointmentNoteStorageFactory={() => appointmentNotes}
          deleteAllPortFactory={deleteAll.factory}
        />,
      );
      await screen.findByRole("button", { name: messages.today.recordReading });
      fireEvent.click(screen.getByRole("button", { name: messages.shared.navMore }));
      confirmDeleteAll(messages);
      expect(await screen.findByRole("heading", { level: 1, name: messages.onboarding.welcomeTitle })).toBeInTheDocument();
      // The database deletion itself is never reported as unchanged.
      expect(screen.queryByText(messages.packet10.deletion.deleteBlockedUnchanged)).not.toBeInTheDocument();
      expect(deleteAll.calls.deleted).toBe(1);
      return messages;
    }

    it("clears every local-state owner even when another owner's key cannot be removed", async () => {
      const onboarding = flakyStorage({ [DEMO_ONBOARDING_STORAGE_KEY]: JSON.stringify(setup) }, Infinity);
      const appointmentNotes = flakyStorage(notes, 0);
      await deleteEverything(onboarding, appointmentNotes);
      await waitFor(() => expect(appointmentNotes.getItem(APPOINTMENT_NOTE_SELECTION_KEY)).toBeNull());
    });

    it("never claims local data was deleted while a local key remains", async () => {
      const onboarding = flakyStorage({ [DEMO_ONBOARDING_STORAGE_KEY]: JSON.stringify(setup) }, Infinity);
      const messages = await deleteEverything(onboarding, flakyStorage(notes, 0));
      await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: messages.onboarding.welcomeTitle })).toBeInTheDocument());
      expect(onboarding.getItem(DEMO_ONBOARDING_STORAGE_KEY)).not.toBeNull();
      expect(screen.queryByText(messages.packet10.deletion.deleteAllDone)).not.toBeInTheDocument();
    });

    it("reports a remaining appointment-note key as incomplete cleanup", async () => {
      const appointmentNotes = flakyStorage(notes, Infinity);
      const onboarding = flakyStorage({ [DEMO_ONBOARDING_STORAGE_KEY]: JSON.stringify(setup) }, 0);
      const messages = await deleteEverything(onboarding, appointmentNotes);
      expect(appointmentNotes.getItem(APPOINTMENT_NOTE_SELECTION_KEY)).not.toBeNull();
      expect(onboarding.getItem(DEMO_ONBOARDING_STORAGE_KEY)).toBeNull();
      expect(screen.queryByText(messages.packet10.deletion.deleteAllDone)).not.toBeInTheDocument();
    });

    it("retries the cleanup when the replacement dataset opens and only then reports local data deleted", async () => {
      const onboarding = flakyStorage({ [DEMO_ONBOARDING_STORAGE_KEY]: JSON.stringify(setup) }, 1);
      const messages = await deleteEverything(onboarding, flakyStorage(notes, 0));
      expect(await screen.findByText(messages.packet10.deletion.deleteAllDone)).toBeInTheDocument();
      expect(onboarding.getItem(DEMO_ONBOARDING_STORAGE_KEY)).toBeNull();
    });
  });

  it("never shows a completed profile over a newly created empty dataset (stale local setup)", async () => {
    const messages = getMessages("en-SG");
    const runtime = { ...fakeRuntime(), datasetLifecycle: "CREATED" as const };
    const storage = onboardingStorage(createPreparedOnboardingState("en-SG", NOW));
    render(<JagaOnApp runtimeFactory={async () => runtime} onboardingRepositoryFactory={storage.factory} deleteAllPortFactory={fakeDeleteAll().factory} />);
    expect(await screen.findByRole("heading", { level: 1, name: messages.onboarding.welcomeTitle })).toBeInTheDocument();
    expect(storage.storage.getItem(DEMO_ONBOARDING_STORAGE_KEY)).toBeNull();
  });

  it("keeps an issued delete-all request visible and non-cancellable even if its dialog's screen unmounts (item 3)", async () => {
    const messages = getMessages("en-SG");
    const runtime = fakeRuntime();
    let finish: () => void = () => undefined;
    const factory: DeleteAllPortFactory = (hooks) =>
      createDeleteDatasetService({
        databaseName: hooks.databaseName,
        now: () => new Date().toISOString() as never,
        coordinator: { acquireExclusive: async () => () => undefined, announceDeleted: () => undefined },
        deletion: {
          deleteDatabase: (_name, onBlocked) =>
            new Promise<void>((resolve) => {
              onBlocked();
              finish = resolve;
            }),
          exists: async () => false,
        },
        closeOwnConnections: hooks.closeRuntime,
        clearLocalState: hooks.clearLocalState,
      });
    render(<JagaOnApp runtimeFactory={async () => runtime} onboardingRepositoryFactory={completed()} appointmentNoteStorageFactory={() => createMemoryOnboardingStorage()} deleteAllPortFactory={factory} />);
    await screen.findByRole("button", { name: messages.today.recordReading });
    fireEvent.click(screen.getByRole("button", { name: messages.shared.navMore }));
    confirmDeleteAll(messages);
    const blocker = await screen.findByRole("alertdialog", { name: messages.packet10.hub.deleteAll });
    expect(blocker).toHaveAttribute("aria-busy", "true");
    expect(within(blocker).getByRole("alert")).toHaveTextContent(messages.packet10.deletion.deleteBlocked);
    expect(within(blocker).queryByRole("button")).toBeNull();
    fireEvent.keyDown(blocker, { key: "Escape" });
    expect(screen.queryByRole("button", { name: messages.packet10.deletion.keepData })).toBeNull();
    expect(screen.queryByRole("navigation")).toBeNull();
    finish();
    expect(await screen.findByText(messages.packet10.deletion.deleteAllDone)).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog", { name: messages.packet10.hub.deleteAll })).toBeNull();
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

  it("completes the Packet 6 bilingual journal journey and clears it with delete-all", async () => {
    const en = getMessages("en-SG");
    const zh = getMessages("zh-SG");
    const runtime = fakeRuntime();
    const runtimeFactory = vi.fn(async () => runtime);
    const deleteAll = fakeDeleteAll();
    render(<JagaOnApp runtimeFactory={runtimeFactory} onboardingRepositoryFactory={completed()} appointmentNoteStorageFactory={() => createMemoryOnboardingStorage()} deleteAllPortFactory={deleteAll.factory} />);

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

    confirmDeleteAll(zh);

    // Delete-all removes IndexedDB and the onboarding key: setup restarts on a new, unseeded dataset.
    expect(await screen.findByRole("heading", { level: 1, name: en.onboarding.welcomeTitle })).toBeInTheDocument();
    expect(screen.getByText(en.packet10.deletion.deleteAllDone)).toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(deleteAll.calls).toEqual({ deleted: 1, closed: 1 });
    await waitFor(() => expect(runtimeFactory).toHaveBeenLastCalledWith(undefined, { seedSyntheticScenarioOnCreate: false }));
    expect(runtime.resetDemo).not.toHaveBeenCalled();
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
  it("opens the Medication schedule from Booklet and Recorded history as top-level destinations", async () => {
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
    const booklet = within(nav).getByRole("button", { name: en.shared.navBooklet });
    expect(booklet).not.toHaveAttribute("aria-disabled");
    fireEvent.click(booklet);
    expect(await screen.findByRole("heading", { level: 1, name: en.schedule.title })).toBeInTheDocument();
    expect(await screen.findByText(en.schedule.emptyTitle)).toBeInTheDocument();
    expect(within(screen.getByRole("navigation")).getByRole("button", { name: en.shared.navBooklet })).toHaveAttribute("aria-current", "page");
    // Scoped to the medicines recorded in the current setup only.
    expect(runtime.medicationSchedule.load).toHaveBeenCalledWith({
      locale: "en-SG",
      medicationRecordIds: expect.arrayContaining(["00000000-0000-4000-8000-000000000101"]),
    });

    const historyTab = within(nav).getByRole("button", { name: en.shared.navHistory });
    expect(historyTab).not.toHaveAttribute("aria-disabled");
    fireEvent.click(historyTab);
    expect(await screen.findByRole("heading", { level: 1, name: en.history.title })).toBeInTheDocument();
    expect(await screen.findByText(en.history.emptyTitle)).toBeInTheDocument();
    expect(within(screen.getByRole("navigation")).getByRole("button", { name: en.shared.navHistory })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.queryByRole("button", { name: en.shared.back })).not.toBeInTheDocument();
    expect(runtime.history.load).toHaveBeenCalledWith({ period: "THIS_WEEK" });
  });

  it("opens My health checks and Prepare for my visit as child screens without changing the bottom tabs", async () => {
    const en = getMessages("en-SG");
    const runtime = fakeRuntime();
    render(<JagaOnApp runtimeFactory={async () => runtime} onboardingRepositoryFactory={completed()} />);
    await screen.findByRole("button", { name: en.today.recordReading });

    fireEvent.click(screen.getByRole("button", { name: en.today.prepareAppointment }));
    expect(await screen.findByRole("heading", { level: 1, name: en.carePreparation.title })).toBeInTheDocument();
    expect(await screen.findByText(en.carePreparation.noAppointmentTitle)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en.shared.back }));
    expect(await screen.findByRole("button", { name: en.today.recordReading })).toBeInTheDocument();

    fireEvent.click(within(screen.getByRole("navigation")).getByRole("button", { name: en.shared.navMore }));
    fireEvent.click(screen.getByRole("button", { name: en.more.healthChecks }));
    expect(await screen.findByRole("heading", { level: 1, name: en.preventiveCare.title })).toBeInTheDocument();
    expect(await screen.findByText(en.preventiveCare.emptyTitle)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en.shared.back }));
    fireEvent.click(await screen.findByRole("button", { name: en.more.prepareVisit }));
    expect(await screen.findByRole("heading", { level: 1, name: en.carePreparation.title })).toBeInTheDocument();
    expect(runtime.careOrganisation.query.loadVisitPreparation).toHaveBeenCalled();

    // Child screens use Back; the four bottom tabs are unchanged.
    fireEvent.click(screen.getByRole("button", { name: en.shared.back }));
    await screen.findByRole("button", { name: en.more.prepareVisit });
    expect(within(screen.getByRole("navigation")).getAllByRole("button").map((tab) => tab.textContent)).toEqual([
      en.shared.navToday,
      en.shared.navBooklet,
      en.shared.navHistory,
      en.shared.navMore,
    ]);
  });

  it("prepares a summary from the ticked Screen 10 selection and opens its preview route", async () => {
    const en = getMessages("en-SG");
    const runtime = fakeRuntime();
    runtime.careOrganisation.query.loadVisitPreparation = vi.fn(async () => ({
      status: "READY" as const,
      appointment: null,
      questions: [],
      period: { startAt: "2026-09-04T16:00:00.000Z" as never, endAtExclusive: "2026-10-04T16:00:00.000Z" as never, startDate: "2026-09-05", endDate: "2026-10-04" },
      factGroups: [
        { key: "GLUCOSE" as const, sources: [{ recordType: "GLUCOSE_READING" as const, recordId: "00000000-0000-4000-8000-000000000301" as never, revisionId: "00000000-0000-4000-8000-000000000302" as never }] },
        { key: "INSULIN" as const, sources: [] },
        { key: "MEALS" as const, sources: [] },
        { key: "WALKS" as const, sources: [] },
      ],
    }));
    runtime.carePreparation.commands.prepare = vi.fn(async () => ({ kind: "COMMITTED" as const, recordId: "00000000-0000-4000-8000-000000000401" as never, revisionId: "00000000-0000-4000-8000-000000000402" as never, revisionNumber: 1 }));
    render(<JagaOnApp runtimeFactory={async () => runtime} onboardingRepositoryFactory={completed()} printPortFactory={() => ({ print: vi.fn() })} />);
    await screen.findByRole("button", { name: en.today.recordReading });
    fireEvent.click(screen.getByRole("button", { name: en.today.prepareAppointment }));
    fireEvent.click(await screen.findByRole("checkbox", { name: new RegExp(en.carePreparation.glucoseReadings) }));
    fireEvent.click(screen.getByRole("button", { name: en.carePreparation.previewSummary }));
    expect(await screen.findByRole("heading", { level: 1, name: en.careSummary.title })).toBeInTheDocument();
    expect(runtime.carePreparation.commands.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ locale: "en-SG", appointment: null, groups: [{ key: "GLUCOSE", sources: [expect.objectContaining({ recordType: "GLUCOSE_READING" })] }], questions: [], notSelected: [] }),
    );
    expect(runtime.carePreparation.query.loadSummary).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000401");
    fireEvent.click(await screen.findByRole("button", { name: en.careSummary.backToPreparation }));
    expect(await screen.findByRole("heading", { level: 1, name: en.carePreparation.title })).toBeInTheDocument();
  });

  it("clears the local appointment-note selection on delete-all", async () => {
    const en = getMessages("en-SG");
    const runtime = fakeRuntime();
    const selectionStorage = createMemoryOnboardingStorage({
      [APPOINTMENT_NOTE_SELECTION_KEY]: JSON.stringify({ schemaVersion: 1, selections: [] }),
    });
    render(
      <JagaOnApp
        runtimeFactory={async () => runtime}
        onboardingRepositoryFactory={completed()}
        appointmentNoteStorageFactory={() => selectionStorage}
        deleteAllPortFactory={fakeDeleteAll().factory}
      />,
    );
    await screen.findByRole("button", { name: en.today.recordReading });
    fireEvent.click(screen.getByRole("button", { name: en.shared.navMore }));
    confirmDeleteAll(en);
    await screen.findByRole("heading", { level: 1, name: en.onboarding.welcomeTitle });
    expect(selectionStorage.getItem(APPOINTMENT_NOTE_SELECTION_KEY)).toBeNull();
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

  it("restarts setup on the new dataset even when the onboarding key cannot be cleared", async () => {
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
    const runtime = fakeRuntime();
    render(<JagaOnApp runtimeFactory={async () => runtime} onboardingRepositoryFactory={failing.factory} appointmentNoteStorageFactory={() => createMemoryOnboardingStorage()} deleteAllPortFactory={fakeDeleteAll().factory} />);
    await screen.findByRole("button", { name: en.today.recordReading });
    fireEvent.click(screen.getByRole("button", { name: en.shared.navMore }));
    confirmDeleteAll(en);
    expect(await screen.findByRole("heading", { level: 1, name: en.onboarding.welcomeTitle })).toBeInTheDocument();
    expect(screen.queryByText(en.packet10.deletion.deleteBlockedUnchanged)).not.toBeInTheDocument();
    // Corrective Pass B item 5: the remaining key is never reported as deleted.
    expect(screen.queryByText(en.packet10.deletion.deleteAllDone)).not.toBeInTheDocument();
  });
});

describe("JagaOnApp Packet 10A integrity lock", () => {
  const en = getMessages("en-SG");

  it("shows only the neutral recovery shell when the dataset is integrity-locked, and retries", async () => {
    const lock = lockStateFor(storageFailure("OPEN", "STORAGE_INTEGRITY_FAILED", "2026-10-04T02:00:00.000Z" as never));
    const runtime = fakeRuntime();
    const runtimeFactory = vi.fn().mockRejectedValueOnce(new JagaOnStorageLockedError(lock)).mockResolvedValue(runtime);
    render(<JagaOnApp runtimeFactory={runtimeFactory} onboardingRepositoryFactory={completed()} deleteAllPortFactory={fakeDeleteAll().factory} />);
    expect(await screen.findByRole("heading", { level: 1, name: en.packet10.integrity.integrityTitle })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(en.packet10.integrity.integrityBody);
    expect(screen.getByText(en.packet10.shared.noHealthClaim)).toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: en.today.recordReading })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en.packet10.integrity.retryRecovery }));
    expect(await screen.findByRole("button", { name: en.today.recordReading })).toBeInTheDocument();
    expect(runtimeFactory).toHaveBeenCalledTimes(2);
  });

  it("renders the newer-database and blocked-update variants one at a time", async () => {
    for (const [code, key, text] of [
      ["DATABASE_VERSION_UNSUPPORTED", en.packet10.integrity.intVariantNewerK, en.packet10.integrity.newerDatabase],
      ["MIGRATION_BLOCKED_BY_OTHER_TAB", en.packet10.integrity.intVariantMigrationK, en.packet10.integrity.migrationBlocked],
    ] as const) {
      const lock = lockStateFor(storageFailure("MIGRATE", code, "2026-10-04T02:00:00.000Z" as never));
      render(<JagaOnApp runtimeFactory={vi.fn().mockRejectedValue(new JagaOnStorageLockedError(lock))} onboardingRepositoryFactory={completed()} deleteAllPortFactory={fakeDeleteAll().factory} />);
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(key);
      expect(alert).toHaveTextContent(text);
      expect(alert).not.toHaveTextContent(en.packet10.integrity.integrityBody);
      cleanup();
    }
  });
});

describe("durable local-state cleanup across app instances (Corrective Pass C)", () => {
  const en = getMessages("en-SG");
  const prepared = createPreparedOnboardingState("en-SG", NOW);
  const skipped: DemoOnboardingStateV1 = { schemaVersion: 1, status: "SKIPPED", lastCompletedStep: null, locale: "en-SG", preferredName: null, medicines: [], updatedAt: NOW } as DemoOnboardingStateV1;
  const noteSelection = JSON.stringify({ schemaVersion: 1, selections: [] });

  /** A local-storage owner whose removal can be switched between failing and working. */
  function ownerStorage(initial: Record<string, string>, failing: boolean) {
    const memory = createMemoryOnboardingStorage(initial);
    const state = { failing, removeAttempts: 0 };
    const port: DemoOnboardingStoragePort = {
      getItem: (key) => memory.getItem(key),
      setItem: (key, value) => memory.setItem(key, value),
      removeItem: (key) => {
        state.removeAttempts += 1;
        if (state.failing) throw new Error("storage unavailable");
        memory.removeItem(key);
      },
    };
    return { port, state };
  }

  /**
   * One simulated device: the IndexedDB dataset (existence and the durable
   * marker) outlives every app instance, exactly like the real runtime contract
   * proven in `local-state-cleanup.test.ts`.
   */
  function device(datasetExists: boolean) {
    const disk = { exists: datasetExists, marker: null as null | { requestedAt: string }, deletions: 0, failMarkerWrite: false };
    let gate: Promise<void> = Promise.resolve();
    let release: () => void = () => undefined;
    const runtimeFactory = vi.fn(async (_name?: string, options?: BrowserJournalRuntimeOptions) => {
      await gate;
      const request = options?.localStateCleanup;
      let lifecycle: "CREATED" | "EXISTING" = "EXISTING";
      if (!disk.exists) {
        if (request && disk.failMarkerWrite) throw new LocalStateCleanupUnconfirmedError();
        disk.exists = true;
        lifecycle = "CREATED";
        if (request) disk.marker = { requestedAt: request.requestedAt };
      } else if (request?.when === "ALWAYS") {
        if (disk.failMarkerWrite) throw new LocalStateCleanupUnconfirmedError();
        disk.marker = { requestedAt: request.requestedAt };
      }
      return {
        ...fakeRuntime(),
        datasetLifecycle: lifecycle,
        localStateCleanup: {
          isPending: async () => disk.marker !== null,
          complete: async () => {
            await completion.gate;
            disk.marker = null;
          },
        },
      };
    });
    const completion = { gate: Promise.resolve() as Promise<void> };
    const deleteAll: DeleteAllPortFactory = (hooks) =>
      createDeleteDatasetService({
        databaseName: hooks.databaseName,
        now: () => new Date().toISOString() as never,
        coordinator: { acquireExclusive: async () => () => undefined, announceDeleted: () => undefined },
        deletion: {
          deleteDatabase: async () => {
            disk.deletions += 1;
            disk.exists = false;
            disk.marker = null;
          },
          exists: async () => disk.exists,
        },
        closeOwnConnections: hooks.closeRuntime,
        clearLocalState: hooks.clearLocalState,
      });
    return {
      disk,
      runtimeFactory,
      deleteAll,
      completion,
      holdOpen() {
        gate = new Promise((resolve) => (release = resolve));
      },
      releaseOpen: () => release(),
    };
  }

  function mount(dev: ReturnType<typeof device>, onboarding: ReturnType<typeof ownerStorage>, notes: ReturnType<typeof ownerStorage>) {
    return render(
      <JagaOnApp
        runtimeFactory={dev.runtimeFactory}
        onboardingRepositoryFactory={() => createDemoOnboardingRepository(onboarding.port)}
        appointmentNoteStorageFactory={() => notes.port}
        deleteAllPortFactory={dev.deleteAll}
      />,
    );
  }

  const onToday = () => screen.queryByRole("button", { name: en.today.recordReading });
  const welcome = () => screen.findByRole("heading", { level: 1, name: en.onboarding.welcomeTitle });

  async function deleteEverything() {
    await screen.findByRole("button", { name: en.today.recordReading });
    fireEvent.click(screen.getByRole("button", { name: en.shared.navMore }));
    confirmDeleteAll(en);
    await welcome();
  }

  function expectFreshSetupOnly() {
    expect(onToday()).toBeNull();
    expect(screen.queryByText(new RegExp(prepared.preferredName ?? "\\u0000"))).toBeNull();
    expect(screen.queryByText(en.packet10.deletion.deleteAllDone)).toBeNull();
  }

  it("A: delete-all with incomplete cleanup leaves a durable marker in the replacement dataset and no success banner", async () => {
    const dev = device(true);
    const onboarding = ownerStorage({ [DEMO_ONBOARDING_STORAGE_KEY]: JSON.stringify(prepared) }, true);
    const notes = ownerStorage({ [APPOINTMENT_NOTE_SELECTION_KEY]: noteSelection }, false);
    mount(dev, onboarding, notes);
    await deleteEverything();
    await waitFor(() => expect(dev.disk.marker).not.toBeNull());
    expect(dev.disk.marker!.requestedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Object.keys(dev.disk.marker!)).toEqual(["requestedAt"]);
    expect(dev.disk.exists).toBe(true);
    expectFreshSetupOnly();
  });

  it("B/C: after a full unmount, startup reads the marker first, retries every owner and keeps fresh setup until cleanup is confirmed", async () => {
    const dev = device(true);
    const onboarding = ownerStorage({ [DEMO_ONBOARDING_STORAGE_KEY]: JSON.stringify(prepared) }, true);
    const notes = ownerStorage({ [APPOINTMENT_NOTE_SELECTION_KEY]: noteSelection }, false);
    mount(dev, onboarding, notes);
    await deleteEverything();
    await waitFor(() => expect(dev.disk.marker).not.toBeNull());
    cleanup();

    // B: a new app instance while cleanup still fails. Nothing is decided before the marker is read.
    const before = { onboarding: onboarding.state.removeAttempts, notes: notes.state.removeAttempts };
    notes.port.setItem(APPOINTMENT_NOTE_SELECTION_KEY, noteSelection);
    dev.holdOpen();
    mount(dev, onboarding, notes);
    await waitFor(() => expect(dev.runtimeFactory).toHaveBeenCalled());
    await Promise.resolve();
    expect(screen.getByRole("status")).toHaveTextContent(en.shared.loading);
    expectFreshSetupOnly();
    dev.releaseOpen();
    await welcome();
    await waitFor(() => expect(onboarding.state.removeAttempts).toBeGreaterThan(before.onboarding));
    expect(notes.state.removeAttempts).toBeGreaterThan(before.notes);
    expect(notes.port.getItem(APPOINTMENT_NOTE_SELECTION_KEY)).toBeNull();
    expect(onboarding.port.getItem(DEMO_ONBOARDING_STORAGE_KEY)).not.toBeNull();
    expect(dev.disk.marker).not.toBeNull();
    expect(dev.disk.deletions).toBe(1);
    expectFreshSetupOnly();
    cleanup();

    // C: a later instance where cleanup works. Success is claimed only after the marker is gone.
    onboarding.state.failing = false;
    notes.port.setItem(APPOINTMENT_NOTE_SELECTION_KEY, noteSelection);
    let finish: () => void = () => undefined;
    dev.completion.gate = new Promise((resolve) => (finish = resolve));
    mount(dev, onboarding, notes);
    await welcome();
    await waitFor(() => expect(onboarding.port.getItem(DEMO_ONBOARDING_STORAGE_KEY)).toBeNull());
    expect(notes.port.getItem(APPOINTMENT_NOTE_SELECTION_KEY)).toBeNull();
    expect(dev.disk.marker).not.toBeNull();
    expectFreshSetupOnly();
    finish();
    expect(await screen.findByText(en.packet10.deletion.deleteAllDone)).toBeInTheDocument();
    expect(dev.disk.marker).toBeNull();
    expect(onToday()).toBeNull();
    expect(dev.disk.deletions).toBe(1);
    cleanup();

    // The stale profile never returns once cleanup is complete.
    mount(dev, onboarding, notes);
    await welcome();
    expectFreshSetupOnly();
  });

  it("D: a crash after the old dataset was deleted still forces fresh setup on every later launch", async () => {
    const dev = device(false);
    const onboarding = ownerStorage({ [DEMO_ONBOARDING_STORAGE_KEY]: JSON.stringify(prepared) }, true);
    const notes = ownerStorage({}, false);
    mount(dev, onboarding, notes);
    await welcome();
    expect(dev.disk.marker).not.toBeNull();
    expectFreshSetupOnly();
    cleanup();
    // The replacement dataset is now an ordinary EXISTING dataset; the marker still governs.
    mount(dev, onboarding, notes);
    await welcome();
    expect(dev.disk.marker).not.toBeNull();
    expectFreshSetupOnly();
  });

  it("fails closed when the marker itself cannot be persisted", async () => {
    const dev = device(false);
    dev.disk.failMarkerWrite = true;
    const onboarding = ownerStorage({ [DEMO_ONBOARDING_STORAGE_KEY]: JSON.stringify(prepared) }, true);
    mount(dev, onboarding, ownerStorage({}, false));
    await welcome();
    expectFreshSetupOnly();
    expect(dev.disk.exists).toBe(false);
  });

  it("a setup finished before the first runtime opens is never sent back to setup", async () => {
    const dev = device(false);
    const onboarding = ownerStorage({}, false);
    dev.holdOpen();
    mount(dev, onboarding, ownerStorage({}, false));
    await welcome();
    fireEvent.click(screen.getByRole("button", { name: en.onboarding.usePrepared }));
    await screen.findByRole("button", { name: en.today.recordReading });
    dev.releaseOpen();
    await waitFor(() => expect(dev.runtimeFactory).toHaveBeenCalled());
    await waitFor(() => expect(dev.disk.exists).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByRole("button", { name: en.today.recordReading })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1, name: en.onboarding.welcomeTitle })).toBeNull();
    expect(dev.disk.marker).toBeNull();
  });

  it("E: a successful delete-all with complete cleanup leaves no marker", async () => {
    const dev = device(true);
    const onboarding = ownerStorage({ [DEMO_ONBOARDING_STORAGE_KEY]: JSON.stringify(prepared) }, false);
    mount(dev, onboarding, ownerStorage({}, false));
    await deleteEverything();
    expect(await screen.findByText(en.packet10.deletion.deleteAllDone)).toBeInTheDocument();
    expect(dev.disk.marker).toBeNull();
  });

  it("E: an ordinary first launch creates no marker and a legitimate setup is never mistaken for stale state", async () => {
    const first = device(false);
    mount(first, ownerStorage({}, false), ownerStorage({}, false));
    await welcome();
    expect(first.disk.marker).toBeNull();
    cleanup();

    for (const state of [skipped, prepared]) {
      const dev = device(true);
      const onboarding = ownerStorage({ [DEMO_ONBOARDING_STORAGE_KEY]: JSON.stringify(state) }, false);
      mount(dev, onboarding, ownerStorage({}, false));
      await screen.findByRole("button", { name: en.today.recordReading });
      expect(dev.disk.marker).toBeNull();
      expect(onboarding.state.removeAttempts).toBe(0);
      expect(onboarding.port.getItem(DEMO_ONBOARDING_STORAGE_KEY)).not.toBeNull();
      cleanup();
    }
  });
});
