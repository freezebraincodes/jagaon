import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Dexie from "dexie";
import fakeIndexedDB, { IDBKeyRange as FDBKeyRange } from "fake-indexeddb";
import { aiInvocationAuditRowSchema, shellTaskRequestSchema, slotToken, type AiInvocationAuditRow, type ShellFieldPath } from "@/domain/ai";
import { AI_ACTIVATION_MANIFEST, type AiActivationManifest } from "@/application/ai/ai-activation-manifest";
import { createBrowserAiAssistance } from "@/application/ai/browser-history-explainer";
import type { BrowserShellFetcher } from "@/application/ai/browser-shell-client";
import { createAiInvocationAuditRepository } from "@/application/ai/ai-audit-persistence";
import { closeCarePreparationHarnesses, createCarePreparationHarness, ENABLED_CARE_MANIFEST, exact, fakeModelCareShells, testIds } from "@/application/care-preparation/care-preparation-test-support";
import { createCarePreparationService } from "@/application/care-preparation/care-preparation-service";
import { projectValidatedAiCareSummary } from "@/application/care-preparation/ai-care-summary-replacement";
import { shellPlanView } from "@/application/ai/language/shell-projector";
import { shellCandidate } from "@/ai/evaluation/packet-11-hybrid-test-support";
import { databases as historyDatabases, higherFixture } from "@/application/history/history-test-support";
import type {
  GlucoseRecordViewModel,
  JournalCommitResult,
  TodayJournalEntry,
  TodayJournalViewModel,
} from "@/application/journal/journal-contracts";
import type { BrowserJournalRuntimeOptions, JagaOnRuntime } from "@/application/journal/browser-journal-runtime";
import { getMessages } from "@/i18n/get-messages";
import { createDemoScenarioFixture } from "@/application/governed/demo-scenario-fixture";
import { JagaOnApp, type AiAssistanceFactory, type DeleteAllPortFactory } from "./JagaOnApp";
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
// Packet 11C Addendum C (C1): the activated paths inject test-only QUALIFIED records (independent of the shipped records).
import { pendingTestRequestClassGate, qualifiedTestRequestClassGate, testManifestEnabling } from "@/application/ai/request-class-test-support";
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
      loadExplainablePattern: vi.fn(async () => ({ kind: "INELIGIBLE" as const, reason: "NOT_FOUND" as const })),
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
        replaceWithAiAssistedPreview: vi.fn(),
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
    // Packet 11C Addendum C (C2): the patient's "Keep wording on this device" setting (default off).
    keepWordingOnDevice: { read: vi.fn(async () => false), persist: vi.fn(async (_keepOnDevice: boolean) => undefined), subscribe: vi.fn((_listener: () => void) => () => undefined) },
    resetDemo,
    aiAudit: { append: vi.fn(async () => undefined) },
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

  it("shows no demo boundary banner on Today (owner decision 2026-10-12: DEMO_BOUNDARY_PLACEMENT hidden)", async () => {
    const en = getMessages("en-SG");
    render(<JagaOnApp runtimeFactory={vi.fn(async () => fakeRuntime())} onboardingRepositoryFactory={completed()} appointmentNoteStorageFactory={() => createMemoryOnboardingStorage()} />);
    await screen.findByRole("button", { name: en.today.recordReading });
    expect(screen.queryByRole("complementary", { name: "Public demo boundary notice" })).not.toBeInTheDocument();
    expect(screen.queryByText(en.shared.demoBoundary)).not.toBeInTheDocument();
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
    // Yesterday, so 09:15 is never later than now.
    fireEvent.click(screen.getByRole("radio", { name: en.readingTime.dayYesterday }));
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
    // Packet 11C B4b (race fix, diagnosed): the preview loads in a passive effect plus a microtask after its heading commits
    // (`use-care-load.ts`), so the heading can appear before the load starts. Wait for the load itself; the assertion is unchanged.
    await waitFor(() => expect(runtime.carePreparation.query.loadSummary).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000401"));
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

  /**
   * Packet 11C C7 finding D1 (fix round 1): the language chosen on Welcome is the setup's own locale. The first runtime's stored locale
   * (en-SG here) never replaces it, whether the runtime opens after the prepared setup finished (a) or while Welcome is still shown (b).
   */
  it("D1 (a): zh-SG chosen on Welcome stays zh-SG when the first runtime opens after the prepared setup finished", async () => {
    const zh = getMessages("zh-SG");
    const dev = device(false);
    dev.holdOpen();
    mount(dev, ownerStorage({}, false), ownerStorage({}, false));
    await welcome();
    fireEvent.click(screen.getByRole("radio", { name: en.settings.chinese }));
    fireEvent.click(await screen.findByRole("button", { name: zh.onboarding.usePrepared }));
    await screen.findByRole("button", { name: zh.today.recordReading });
    dev.releaseOpen();
    await waitFor(() => expect(dev.runtimeFactory).toHaveBeenCalled());
    await waitFor(() => expect(dev.disk.exists).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByRole("button", { name: zh.today.recordReading })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: en.today.recordReading })).toBeNull();
    expect(document.documentElement.lang).toBe("zh-SG");
  });

  it("D1 (b): zh-SG chosen on Welcome stays zh-SG when the first runtime opens while Welcome is still shown", async () => {
    const zh = getMessages("zh-SG");
    const dev = device(false);
    dev.holdOpen();
    mount(dev, ownerStorage({}, false), ownerStorage({}, false));
    await welcome();
    fireEvent.click(screen.getByRole("radio", { name: en.settings.chinese }));
    await screen.findByRole("heading", { level: 1, name: zh.onboarding.welcomeTitle });
    dev.releaseOpen();
    await waitFor(() => expect(dev.runtimeFactory).toHaveBeenCalled());
    await waitFor(() => expect(dev.disk.exists).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByRole("heading", { level: 1, name: zh.onboarding.welcomeTitle })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: zh.onboarding.usePrepared })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe("zh-SG");
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

/**
 * Packet 11C Addendum B, Task B2b: the history explanation is wired deterministically while NOT_ACTIVATED. One explainer per opened
 * runtime (stable identity); nothing at startup, screen load or navigation; only the patient's explicit action composes, locally, with
 * one audit row and no network call, no AI label and no disclosure.
 */
describe("JagaOnApp history explanation wiring (Packet 11C B2b)", () => {
  const originalIndexedDB = Dexie.dependencies.indexedDB;
  const originalIDBKeyRange = Dexie.dependencies.IDBKeyRange;
  beforeAll(() => {
    Dexie.dependencies.indexedDB = fakeIndexedDB;
    Dexie.dependencies.IDBKeyRange = FDBKeyRange;
  });
  afterAll(() => {
    Dexie.dependencies.indexedDB = originalIndexedDB;
    Dexie.dependencies.IDBKeyRange = originalIDBKeyRange;
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    for (const database of historyDatabases) database.close();
    for (const database of historyDatabases.splice(0)) await Dexie.delete(database.name);
  });

  it("builds one explainer per runtime from its history and audit ports, stable across re-renders and navigation", async () => {
    const en = getMessages("en-SG");
    const runtime = fakeRuntime();
    const explainer = { explain: vi.fn() };
    // Packet 11C B4b (deliberate retarget): one AI wiring per runtime serves both flows (history explanation, care-summary wording).
    const factory = vi.fn<AiAssistanceFactory>(() => ({ history: explainer, careSummary: null }));
    const props = { runtimeFactory: async () => runtime, onboardingRepositoryFactory: completed(), aiAssistanceFactory: factory };
    const { rerender } = render(<JagaOnApp {...props} />);
    await screen.findByRole("button", { name: en.today.recordReading });
    const nav = screen.getByRole("navigation");
    for (const tab of [en.shared.navHistory, en.shared.navBooklet, en.shared.navHistory, en.shared.navToday, en.shared.navHistory]) {
      fireEvent.click(within(nav).getByRole("button", { name: tab }));
      await act(async () => undefined);
    }
    rerender(<JagaOnApp {...props} />);
    await act(async () => undefined);
    expect(factory).toHaveBeenCalledTimes(1);
    // Packet 11C B4b: plus the runtime's care-preparation ports (the care-summary wording uses the same wiring).
    // Packet 11C Addendum C, C3 (deliberate retarget): exactly the three runtime ports; the B3 app-session disclosure is gone (acceptance
    // is per explicit request).
    // Packet 11C Addendum C, C2 (deliberate retarget): plus the patient's "Keep wording on this device" setting, as a function the
    // wiring reads per request (the factory is not rebuilt when it changes).
    // Fix round 1 (I-1): the awaited per-request value (this tab's choice, else the stored value) and the in-memory hint.
    expect(factory).toHaveBeenCalledWith({ history: runtime.history, carePreparation: runtime.carePreparation, audit: runtime.aiAudit, privateMode: expect.any(Function), privateModeHint: expect.any(Function) });
    expect(Object.keys(factory.mock.calls[0]![0]).sort()).toEqual(["audit", "carePreparation", "history", "privateMode", "privateModeHint"]);
    expect(await factory.mock.calls[0]![0].privateMode()).toBe(false);
    expect(factory.mock.calls[0]![0].privateModeHint()).toBe(false);
    // Nothing is explained without the patient's explicit action (this runtime's history offers none).
    expect(explainer.explain).not.toHaveBeenCalled();
  });

  /**
   * Packet 11C English activation (owner decisions Q and A, 2026-10-12; was: "shipped manifest ... one deterministic local explanation,
   * TASK_DISABLED"): the real shipped wiring (no factory injected: the shipped manifest and records, the browser network primitive stubbed
   * as a spy) over the prepared demo profile. en-SG: nothing at startup, history load or probing; the explicit action shows the
   * disclosure FIRST (nothing written or sent before the decision); Cancel keeps the standard wording, one REMOTE_USE_DECLINED row.
   */
  it("shipped manifest and records (en-SG): no audit row or network call at startup, history load or probing; the explicit action shows the disclosure first; Cancel gives the deterministic explanation and sends nothing", async () => {
    const en = getMessages("en-SG");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { history } = await higherFixture();
    const runtime = fakeRuntime();
    const probe = vi.fn((request: { factId: string }) => history.loadExplainablePattern(request));
    runtime.history = { load: (request) => history.load(request), loadExplainablePattern: probe };
    const rows: unknown[] = [];
    runtime.aiAudit = { append: vi.fn(async (row) => void rows.push(row)) };
    render(<JagaOnApp runtimeFactory={async () => runtime} onboardingRepositoryFactory={completed()} />);
    await screen.findByRole("button", { name: en.today.recordReading });
    expect(runtime.aiAudit.append).not.toHaveBeenCalled();

    fireEvent.click(within(screen.getByRole("navigation")).getByRole("button", { name: en.shared.navHistory }));
    const action = await screen.findByRole("button", { name: en.history.explanation.action });
    // Loading the screen and probing which comparison can be explained is local and writes no audit row.
    expect(probe).toHaveBeenCalledWith({ factId: "COMPARISON:BEFORE_BREAKFAST" });
    expect(runtime.aiAudit.append).not.toHaveBeenCalled();

    fireEvent.click(action);
    const dialog = await screen.findByRole("dialog", { name: en.ai.remoteTitle });
    expect(runtime.aiAudit.append).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: en.ai.cancel }));
    const panel = await screen.findByRole("region", { name: en.history.explanation.title });
    await waitFor(() => expect(within(panel).getByRole("status")).not.toBeEmptyDOMElement());
    expect(within(panel).getByRole("status")).not.toHaveTextContent(en.history.explanation.unavailable);
    expect(within(panel).queryByText(en.history.explanation.aiLabel)).not.toBeInTheDocument();
    expect(within(panel).getByText(en.ai.remoteNotAccepted)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(rows).toHaveLength(1);
    expect(aiInvocationAuditRowSchema.parse(rows[0])).toMatchObject({ taskType: "EXPLAIN_PATTERN", locale: "en-SG", outcomeCode: "REMOTE_USE_DECLINED", providerModel: null, attempts: { count: 0 } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("shipped manifest and records (zh-SG): the class is PENDING: no disclosure, one deterministic local explanation, one REQUEST_CLASS_NOT_QUALIFIED row, no network call", async () => {
    const zh = getMessages("zh-SG");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { history } = await higherFixture();
    const runtime = fakeRuntime();
    runtime.resolveLocale = vi.fn(async () => "zh-SG" as const);
    runtime.history = history;
    const rows: unknown[] = [];
    runtime.aiAudit = { append: vi.fn(async (row) => void rows.push(row)) };
    render(<JagaOnApp runtimeFactory={async () => runtime} onboardingRepositoryFactory={onboardingStorage(createPreparedOnboardingState("zh-SG", NOW)).factory} />);
    await screen.findByRole("button", { name: zh.today.recordReading });
    fireEvent.click(within(screen.getByRole("navigation")).getByRole("button", { name: zh.shared.navHistory }));
    fireEvent.click(await screen.findByRole("button", { name: zh.history.explanation.action }));
    const panel = await screen.findByRole("region", { name: zh.history.explanation.title });
    await waitFor(() => expect(within(panel).getByRole("status")).not.toBeEmptyDOMElement());
    expect(within(panel).getByRole("status")).not.toHaveTextContent(zh.history.explanation.unavailable);
    expect(within(panel).queryByText(zh.history.explanation.aiLabel)).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(rows).toHaveLength(1));
    expect(aiInvocationAuditRowSchema.parse(rows[0])).toMatchObject({ taskType: "EXPLAIN_PATTERN", locale: "zh-SG", outcomeCode: "REQUEST_CLASS_NOT_QUALIFIED", providerModel: null, attempts: { count: 0 } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/**
 * Packet 11C Addendum B, Task B3: the disclosure in the wired app. Packet 11C Addendum C, C3 (replaces the B3 once-per-app-session
 * acceptance): an acceptance covers the one explicit request it was given for; every new request asks again; nothing is persisted. Activated behaviour only through an injected factory that adds a test manifest and a fake route
 * to the real browser wiring (the shipped wiring is pinned in "JagaOnApp history explanation wiring" above).
 */
/**
 * Owner UI decision U03 (2026-10-09): while the disclosure shows the demo passcode field, its primary action needs non-whitespace input,
 * so the activated tests fill a test-only value first (only when the field is shown), then accept.
 */
function acceptDisclosure(dialog: HTMLElement, confirm: string) {
  const field = within(dialog).queryByLabelText(getMessages("en-SG").aiAccess.passcodeLabel);
  if (field) fireEvent.change(field, { target: { value: "TEST-ONLY-passcode-value" } });
  fireEvent.click(within(dialog).getByRole("button", { name: confirm }));
}

describe("JagaOnApp AI disclosure (Packet 11C B3)", () => {
  const originalIndexedDB = Dexie.dependencies.indexedDB;
  const originalIDBKeyRange = Dexie.dependencies.IDBKeyRange;
  beforeAll(() => {
    Dexie.dependencies.indexedDB = fakeIndexedDB;
    Dexie.dependencies.IDBKeyRange = FDBKeyRange;
  });
  afterAll(() => {
    Dexie.dependencies.indexedDB = originalIndexedDB;
    Dexie.dependencies.IDBKeyRange = originalIDBKeyRange;
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    for (const database of historyDatabases) database.close();
    for (const database of historyDatabases.splice(0)) await Dexie.delete(database.name);
  });

  // Packet 11C English activation: built on the pre-activation manifest, so it enables EXPLAIN_PATTERN only.
  const ENABLED: AiActivationManifest = testManifestEnabling("EXPLAIN_PATTERN");
  function fakeRoute() {
    return vi.fn<BrowserShellFetcher>(async (_url, init) => {
      const plan = shellPlanView(shellTaskRequestSchema.parse(JSON.parse(init.body as string)));
      const home = (path: ShellFieldPath) => plan.slots.find((slot) => slot.homeField === path)!.slotId;
      const candidate = shellCandidate(plan, new Map<ShellFieldPath, string>([["headline", `A look at ${slotToken(home("headline"))}.`], ["evidence", `This is based on ${slotToken(home("evidence"))}.`]]));
      return new Response(JSON.stringify({ kind: "CANDIDATE", candidate, retention: "CONFIRMED_NOT_STORED", usage: { inputTokens: 1, outputTokens: 1, costMicroUsd: 1 } }), { headers: { "content-type": "application/json" } });
    });
  }
  async function activatedApp() {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { history } = await higherFixture();
    const runtime = fakeRuntime();
    runtime.history = history;
    const rows: AiInvocationAuditRow[] = [];
    runtime.aiAudit = { append: vi.fn(async (row: AiInvocationAuditRow) => void rows.push(row)) };
    const fetcher = fakeRoute();
    const factory: AiAssistanceFactory = (ports) => createBrowserAiAssistance({ ...ports, manifest: ENABLED, requestClassGate: qualifiedTestRequestClassGate(), fetcher });
    const props = { runtimeFactory: async () => runtime, onboardingRepositoryFactory: completed(), aiAssistanceFactory: factory };
    return { props, rows, fetcher, fetchSpy };
  }
  async function toHistoryAction() {
    const en = getMessages("en-SG");
    await screen.findByRole("button", { name: en.today.recordReading });
    fireEvent.click(within(screen.getByRole("navigation")).getByRole("button", { name: en.shared.navHistory }));
    return screen.findByRole("button", { name: en.history.explanation.action });
  }

  it("cancelled: no POST, the deterministic explanation, one audit row with no attempt, provider model or source", async () => {
    const en = getMessages("en-SG");
    const app = await activatedApp();
    render(<JagaOnApp {...app.props} />);
    const action = await toHistoryAction();
    action.focus();
    fireEvent.click(action);
    const dialog = await screen.findByRole("dialog", { name: en.ai.remoteTitle });
    expect(app.rows).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: en.ai.cancel }));
    const panel = await screen.findByRole("region", { name: en.history.explanation.title });
    await waitFor(() => expect(within(panel).getByRole("status")).not.toBeEmptyDOMElement());
    expect(within(panel).queryByText(en.history.explanation.aiLabel)).not.toBeInTheDocument();
    expect(app.fetcher).not.toHaveBeenCalled();
    expect(app.fetchSpy).not.toHaveBeenCalled();
    expect(app.rows).toHaveLength(1);
    // Packet 11C B4a: the panel says AI wording was not used. Packet 11C Addendum C (C5): the explicit decline is audited with the truthful
    // audit-only REMOTE_USE_DECLINED (REQUEST_CANCELLED under the B4a interim ruling), in a current (11c.2) row.
    expect(within(panel).getByText(en.ai.remoteNotAccepted)).toBeInTheDocument();
    expect(aiInvocationAuditRowSchema.parse(app.rows[0])).toMatchObject({ auditSchemaVersion: "ai-invocation-audit.11c.2", outcomeCode: "REMOTE_USE_DECLINED", providerModel: null, attempts: { count: 0, structuralRepairUsed: false, timedOut: false }, sourceRevisions: [], measurements: { inputTokens: null, outputTokens: null, costMicroUsd: null }, usageBasis: "NONE" });
  });

  it("C5: a disclosure closed as moot (period change, leaving the screen) writes one DISCLOSURE_CLOSED_MOOT row each; nothing sent", async () => {
    const en = getMessages("en-SG");
    const app = await activatedApp();
    render(<JagaOnApp {...app.props} />);
    fireEvent.click(await toHistoryAction());
    await screen.findByRole("dialog", { name: en.ai.remoteTitle });
    fireEvent.click(screen.getByRole("radio", { name: en.history.periodLastWeek }));
    await waitFor(() => expect(app.rows).toHaveLength(1));
    expect(aiInvocationAuditRowSchema.parse(app.rows[0])).toMatchObject({ taskType: "EXPLAIN_PATTERN", locale: "en-SG", outcomeCode: "DISCLOSURE_CLOSED_MOOT", providerModel: null, attempts: { count: 0 }, usageBasis: "NONE" });
    fireEvent.click(screen.getByRole("radio", { name: en.history.periodThisWeek }));
    fireEvent.click(await screen.findByRole("button", { name: en.history.explanation.action }));
    await screen.findByRole("dialog", { name: en.ai.remoteTitle });
    // The modal is open; leaving the screen (here: the whole app closes) makes that request moot too.
    cleanup();
    await waitFor(() => expect(app.rows).toHaveLength(2));
    expect(app.rows.map((row) => row.outcomeCode)).toEqual(["DISCLOSURE_CLOSED_MOOT", "DISCLOSURE_CLOSED_MOOT"]);
    expect(app.fetcher).not.toHaveBeenCalled();
    expect(app.fetchSpy).not.toHaveBeenCalled();
  });

  it("C5: an explanation asked for a comparison that stopped being explainable writes one NOT_ELIGIBLE row; the probe wrote none", async () => {
    const en = getMessages("en-SG");
    const app = await activatedApp();
    // The screen probes through the runtime's history (explainable, so the action is offered); the explainer's own read then finds the
    // comparison no longer explainable (as after a correction between the probe and the click).
    const factory: AiAssistanceFactory = (ports) =>
      createBrowserAiAssistance({
        ...ports,
        history: { load: (request) => ports.history.load(request), loadExplainablePattern: async () => ({ kind: "INELIGIBLE", reason: "STALE_SOURCE" }) },
        manifest: AI_ACTIVATION_MANIFEST,
        fetcher: app.fetcher,
      });
    render(<JagaOnApp {...app.props} aiAssistanceFactory={factory} />);
    const action = await toHistoryAction();
    expect(app.rows).toHaveLength(0);
    fireEvent.click(action);
    await waitFor(() => expect(app.rows).toHaveLength(1));
    expect(aiInvocationAuditRowSchema.parse(app.rows[0])).toMatchObject({ taskType: "EXPLAIN_PATTERN", outcomeCode: "NOT_ELIGIBLE", providerModel: null, attempts: { count: 0 }, usageBasis: "NONE" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(app.fetcher).not.toHaveBeenCalled();
  });

  it("C3: accepted per explicit request: leaving and coming back is a new request that asks again; a reload asks again too", async () => {
    const en = getMessages("en-SG");
    const app = await activatedApp();
    const { unmount } = render(<JagaOnApp {...app.props} />);
    fireEvent.click(await toHistoryAction());
    acceptDisclosure(await screen.findByRole("dialog", { name: en.ai.remoteTitle }), en.ai.pattern.confirm);
    const panel = await screen.findByRole("region", { name: en.history.explanation.title });
    await waitFor(() => expect(within(panel).getByText(en.history.explanation.aiLabel)).toBeInTheDocument());
    expect(app.fetcher).toHaveBeenCalledTimes(1);
    expect(app.rows[0]).toMatchObject({ outcomeCode: "ACCEPTED", providerModel: { providerKey: "deepseek", modelSnapshot: "deepseek-flash" } });

    // Leave and come back: a new explicit request, so the disclosure is shown again and nothing is sent before it is answered.
    fireEvent.click(within(screen.getByRole("navigation")).getByRole("button", { name: en.shared.navToday }));
    await act(async () => undefined);
    fireEvent.click(await toHistoryAction());
    const again = await screen.findByRole("dialog", { name: en.ai.remoteTitle });
    expect(app.fetcher).toHaveBeenCalledTimes(1);
    acceptDisclosure(again, en.ai.pattern.confirm);
    await waitFor(() => expect(app.fetcher).toHaveBeenCalledTimes(2));

    // A reload: the disclosure is asked again before any POST (nothing is persisted).
    unmount();
    render(<JagaOnApp {...app.props} />);
    fireEvent.click(await toHistoryAction());
    expect(await screen.findByRole("dialog", { name: en.ai.remoteTitle })).toBeInTheDocument();
    expect(app.fetcher).toHaveBeenCalledTimes(2);
    expect(app.rows.map((row) => row.outcomeCode)).toEqual(["ACCEPTED", "ACCEPTED"]);
    expect(app.fetchSpy).not.toHaveBeenCalled();
  });

  /**
   * Packet 11C Addendum C, Task C2 (hybrid spec D11): the "Keep wording on this device" toggle on the More screen, wired to the one AI
   * wiring per runtime and read per request (no reload). When on: no dialog or passcode field, no POST, a deterministic explanation and
   * one exact PRIVACY_REJECTED row; turning it off again restores the disclosure for the next request.
   */
  describe("C2: Keep wording on this device", () => {
    async function toMore() {
      const en = getMessages("en-SG");
      await screen.findByRole("button", { name: en.today.recordReading });
      fireEvent.click(within(screen.getByRole("navigation")).getByRole("button", { name: en.shared.navMore }));
      return screen.findByRole("checkbox", { name: en.aiWording.keepOnDeviceLabel });
    }

    it("loads the stored setting (default off), persists the patient's choice and applies it without rebuilding the AI wiring", async () => {
      const runtime = fakeRuntime();
      const factory = vi.fn<AiAssistanceFactory>(() => ({ history: { explain: vi.fn() }, careSummary: null }));
      render(<JagaOnApp runtimeFactory={async () => runtime} onboardingRepositoryFactory={completed()} aiAssistanceFactory={factory} />);
      const toggle = await toMore();
      expect(runtime.keepWordingOnDevice.read).toHaveBeenCalled();
      expect(toggle).not.toBeChecked();
      const { privateMode, privateModeHint } = factory.mock.calls[0]![0];
      expect(await privateMode()).toBe(false);
      fireEvent.click(toggle);
      await waitFor(() => expect(runtime.keepWordingOnDevice.persist).toHaveBeenCalledWith(true));
      expect(toggle).toBeChecked();
      expect(await privateMode()).toBe(true);
      expect(privateModeHint()).toBe(true);
      fireEvent.click(toggle);
      await waitFor(() => expect(runtime.keepWordingOnDevice.persist).toHaveBeenLastCalledWith(false));
      expect(await privateMode()).toBe(false);
      expect(privateModeHint()).toBe(false);
      expect(factory).toHaveBeenCalledTimes(1);
    });

    it("a stored on is shown checked and applies from the first request", async () => {
      const runtime = fakeRuntime();
      runtime.keepWordingOnDevice.read = vi.fn(async () => true);
      const factory = vi.fn<AiAssistanceFactory>(() => ({ history: { explain: vi.fn() }, careSummary: null }));
      render(<JagaOnApp runtimeFactory={async () => runtime} onboardingRepositoryFactory={completed()} aiAssistanceFactory={factory} />);
      expect(await toMore()).toBeChecked();
      expect(await factory.mock.calls[0]![0].privateMode()).toBe(true);
      expect(factory.mock.calls[0]![0].privateModeHint()).toBe(true);
    });

    it("an unreadable setting keeps the wording on the device (fail closed) and is shown as on", async () => {
      const runtime = fakeRuntime();
      runtime.keepWordingOnDevice.read = vi.fn(async () => { throw new Error("storage"); });
      const factory = vi.fn<AiAssistanceFactory>(() => ({ history: { explain: vi.fn() }, careSummary: null }));
      render(<JagaOnApp runtimeFactory={async () => runtime} onboardingRepositoryFactory={completed()} aiAssistanceFactory={factory} />);
      expect(await toMore()).toBeChecked();
      expect(await factory.mock.calls[0]![0].privateMode()).toBe(true);
    });

    it("fix round 1 (I-1): the per-request value awaits the stored setting, so another tab's on is honoured without any notice", async () => {
      const runtime = fakeRuntime();
      const factory = vi.fn<AiAssistanceFactory>(() => ({ history: { explain: vi.fn() }, careSummary: null }));
      render(<JagaOnApp runtimeFactory={async () => runtime} onboardingRepositoryFactory={completed()} aiAssistanceFactory={factory} />);
      expect(await toMore()).not.toBeChecked();
      const { privateMode } = factory.mock.calls[0]![0];
      expect(await privateMode()).toBe(false);
      // Another tab stored "on"; this tab has received nothing.
      runtime.keepWordingOnDevice.read = vi.fn(async () => true);
      expect(await privateMode()).toBe(true);
      runtime.keepWordingOnDevice.read = vi.fn(async () => { throw new Error("storage"); });
      expect(await privateMode()).toBe(true);
    });

    it("fix round 1 (I-1): a change notice from another tab re-reads the stored value and updates the checkbox and the in-memory value", async () => {
      const runtime = fakeRuntime();
      const listeners: Array<() => void> = [];
      runtime.keepWordingOnDevice.subscribe = vi.fn((listener: () => void) => (listeners.push(listener), () => undefined));
      const factory = vi.fn<AiAssistanceFactory>(() => ({ history: { explain: vi.fn() }, careSummary: null }));
      render(<JagaOnApp runtimeFactory={async () => runtime} onboardingRepositoryFactory={completed()} aiAssistanceFactory={factory} />);
      const toggle = await toMore();
      expect(toggle).not.toBeChecked();
      expect(listeners).toHaveLength(1);
      runtime.keepWordingOnDevice.read = vi.fn(async () => true);
      await act(async () => listeners[0]!());
      await waitFor(() => expect(screen.getByRole("checkbox", { name: getMessages("en-SG").aiWording.keepOnDeviceLabel })).toBeChecked());
      expect(factory.mock.calls[0]![0].privateModeHint()).toBe(true);
      runtime.keepWordingOnDevice.read = vi.fn(async () => false);
      await act(async () => listeners[0]!());
      await waitFor(() => expect(screen.getByRole("checkbox", { name: getMessages("en-SG").aiWording.keepOnDeviceLabel })).not.toBeChecked());
      expect(factory.mock.calls[0]![0].privateModeHint()).toBe(false);
    });

    it("fix round 1 (M-1): disabled while no dataset is open; a choice whose save failed survives the reopen", async () => {
      const en = getMessages("en-SG");
      const first = fakeRuntime();
      first.keepWordingOnDevice.persist = vi.fn(async () => { throw new Error("storage"); });
      let openSecond!: (runtime: JagaOnRuntime) => void;
      const second = fakeRuntime();
      const runtimeFactory = vi.fn().mockResolvedValueOnce(first).mockReturnValueOnce(new Promise<JagaOnRuntime>((resolve) => (openSecond = resolve)));
      // A delete-all that closes this tab's runtime and then fails: the app reopens the dataset.
      const failingDelete: DeleteAllPortFactory = (hooks) => ({
        prepare: () => ({ createdAt: "2026-10-04T02:00:00.000Z" as never, expiresAt: "2099-10-04T02:10:00.000Z" as never }),
        confirm: async () => {
          hooks.closeRuntime();
          return { kind: "FAILED", failure: storageFailure("DELETE_DATASET", "STORAGE_TRANSACTION_ABORTED","2026-10-04T02:00:00.000Z" as never) };
        },
      });
      const factory = vi.fn<AiAssistanceFactory>(() => ({ history: { explain: vi.fn() }, careSummary: null }));
      render(<JagaOnApp runtimeFactory={runtimeFactory} onboardingRepositoryFactory={completed()} aiAssistanceFactory={factory} deleteAllPortFactory={failingDelete} />);
      const toggle = await toMore();
      fireEvent.click(toggle);
      expect(await screen.findByText(en.shared.storageUnavailable)).toBeInTheDocument();
      expect(toggle).toBeChecked();
      confirmDeleteAll(en);
      await waitFor(() => expect(runtimeFactory).toHaveBeenCalledTimes(2));
      // No dataset is open: the setting is not shown as known.
      await waitFor(() => expect(screen.getByRole("checkbox", { name: en.aiWording.keepOnDeviceLabel })).toBeDisabled());
      // The reopened dataset stores off, but the unsaved "on" from this session is kept (never silently reverted).
      await act(async () => openSecond(second));
      await waitFor(() => expect(screen.getByRole("checkbox", { name: en.aiWording.keepOnDeviceLabel })).toBeEnabled());
      expect(screen.getByRole("checkbox", { name: en.aiWording.keepOnDeviceLabel })).toBeChecked();
      const latest = factory.mock.calls.at(-1)![0];
      expect(latest.privateModeHint()).toBe(true);
      expect(await latest.privateMode()).toBe(true);
    });

    it.each([
      ["activated (test manifest, test-only QUALIFIED classes, fake route)", true],
      ["the shipped manifest and records (the en-SG class QUALIFIED)", false],
    ])("on, %s: no dialog or passcode field, no POST, a deterministic explanation and one exact PRIVACY_REJECTED row", async (_label, activated) => {
      const en = getMessages("en-SG");
      const app = await activatedApp();
      const factory: AiAssistanceFactory = activated ? app.props.aiAssistanceFactory : (ports) => createBrowserAiAssistance(ports);
      render(<JagaOnApp {...app.props} aiAssistanceFactory={factory} />);
      fireEvent.click(await toMore());
      await waitFor(() => expect(screen.getByRole("checkbox", { name: en.aiWording.keepOnDeviceLabel })).toBeChecked());
      fireEvent.click(within(screen.getByRole("navigation")).getByRole("button", { name: en.shared.navHistory }));
      fireEvent.click(await screen.findByRole("button", { name: en.history.explanation.action }));
      const panel = await screen.findByRole("region", { name: en.history.explanation.title });
      await waitFor(() => expect(within(panel).getByRole("status")).not.toBeEmptyDOMElement());
      expect(within(panel).queryByText(en.history.explanation.aiLabel)).not.toBeInTheDocument();
      expect(within(panel).queryByText(en.ai.remoteNotAccepted)).not.toBeInTheDocument();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.queryByLabelText(en.aiAccess.passcodeLabel)).toBeNull();
      await waitFor(() => expect(app.rows).toHaveLength(1));
      expect(aiInvocationAuditRowSchema.parse(app.rows[0])).toMatchObject({ auditSchemaVersion: "ai-invocation-audit.11c.2", taskType: "EXPLAIN_PATTERN", outcomeCode: "PRIVACY_REJECTED", providerModel: null, attempts: { count: 0, structuralRepairUsed: false, timedOut: false }, sourceRevisions: [], measurements: { inputTokens: null, outputTokens: null, costMicroUsd: null }, usageBasis: "NONE" });
      expect(app.fetcher).not.toHaveBeenCalled();
      expect(app.fetchSpy).not.toHaveBeenCalled();
    });

    it("turned off again (no reload): the next explicit request asks the disclosure as before", async () => {
      const en = getMessages("en-SG");
      const app = await activatedApp();
      render(<JagaOnApp {...app.props} />);
      const toggle = await toMore();
      fireEvent.click(toggle);
      await waitFor(() => expect(toggle).toBeChecked());
      fireEvent.click(toggle);
      await waitFor(() => expect(toggle).not.toBeChecked());
      fireEvent.click(within(screen.getByRole("navigation")).getByRole("button", { name: en.shared.navHistory }));
      fireEvent.click(await screen.findByRole("button", { name: en.history.explanation.action }));
      expect(await screen.findByRole("dialog", { name: en.ai.remoteTitle })).toBeInTheDocument();
      expect(app.fetcher).not.toHaveBeenCalled();
      expect(app.rows).toHaveLength(0);
    });
  });
});

/**
 * Packet 11C Addendum B, Task B4b: the care-summary AI wording in the wired app. The preview gets the care wording of the same AI wiring
 * as the history explanation (one hybrid service, browser shell client, session disclosure and audit port). Packet 11C English activation
 * (owner decisions Q and A): the shipped manifest enables the care task and the shipped records qualify the en-SG care classes, but this
 * preview (one reading, no question, no appointment) is not an evaluated class, so with the shipped wiring the action is never shown and
 * nothing is called at startup, screen load, preview, approval or print. Activated behaviour only through
 * an injected factory that adds a test manifest and a fake route to the real wiring, over a real care-preparation service with the AI
 * projection (the shipped runtime's projector is pinned in browser-journal-runtime.test.ts).
 */
describe("JagaOnApp care-summary AI wording (Packet 11C B4b)", () => {
  const originalIndexedDB = Dexie.dependencies.indexedDB;
  const originalIDBKeyRange = Dexie.dependencies.IDBKeyRange;
  beforeAll(() => {
    Dexie.dependencies.indexedDB = fakeIndexedDB;
    Dexie.dependencies.IDBKeyRange = FDBKeyRange;
  });
  afterAll(() => {
    Dexie.dependencies.indexedDB = originalIndexedDB;
    Dexie.dependencies.IDBKeyRange = originalIDBKeyRange;
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    for (const database of historyDatabases) database.close();
    for (const database of historyDatabases.splice(0)) await Dexie.delete(database.name);
    await closeCarePreparationHarnesses();
  });

  const LATER = "2026-10-04T02:05:00.000Z";
  const BOTH: AiActivationManifest = { ...ENABLED_CARE_MANIFEST, tasks: { ...ENABLED_CARE_MANIFEST.tasks, EXPLAIN_PATTERN: "SYNTHETIC_REMOTE_ENABLED" } };
  const glucosePayload = { measurement: { enteredValue: "6.6" as never, enteredUnit: "MMOL_L" as const, normalization: null }, measurementMethod: "FINGERSTICK_METER" as const, context: { kind: "PATIENT_SELECTED_SLOT" as const, slot: "BEDTIME" as const } };

  /** A fake runtime whose care preparation is real (prepared preview; the AI projection configured) and whose AI audit is persisted. */
  async function careRuntime() {
    const h = await createCarePreparationHarness();
    const service = createCarePreparationService(h.database, { now: () => LATER as never, ids: testIds, projectAiCareSummary: projectValidatedAiCareSummary });
    const reading = await h.journal.recordGlucose({ payload: glucosePayload, temporal: { kind: "POINT", occurrence: exact("2026-10-03T13:00:00.000Z") }, recordedAt: LATER as never });
    const question = await h.organisation.createCareQuestion({ questionText: { text: "Can I keep the pen in my bag? (demo)", language: "en-SG" } });
    if (reading.kind !== "COMMITTED" || question.kind !== "COMMITTED") throw new Error("fixture");
    const prepared = await service.prepare(await h.selection());
    if (prepared.kind !== "COMMITTED") throw new Error(JSON.stringify(prepared));
    const runtime = fakeRuntime();
    const prepare = vi.fn(async () => prepared);
    runtime.carePreparation = { commands: { ...service, prepare }, query: h.query };
    runtime.careOrganisation.query.loadVisitPreparation = vi.fn(async () => ({
      status: "READY" as const,
      appointment: null,
      questions: [],
      period: { startAt: "2026-09-04T16:00:00.000Z" as never, endAtExclusive: "2026-10-04T16:00:00.000Z" as never, startDate: "2026-09-05", endDate: "2026-10-04" },
      factGroups: [
        { key: "GLUCOSE" as const, sources: [{ recordType: "GLUCOSE_READING" as const, recordId: reading.recordId, revisionId: reading.revisionId }] },
        { key: "INSULIN" as const, sources: [] },
        { key: "MEALS" as const, sources: [] },
        { key: "WALKS" as const, sources: [] },
      ],
    }));
    const audits = createAiInvocationAuditRepository(h.database);
    runtime.aiAudit = { append: vi.fn(audits.append) };
    return { h, runtime, prepared, audits };
  }

  /** A fake POST /api/ai/shell answering valid shells for either flow's approved value-blind request. */
  function fakeRoute() {
    return vi.fn<BrowserShellFetcher>(async (_url, init) => {
      const plan = shellPlanView(shellTaskRequestSchema.parse(JSON.parse(init.body as string)));
      const home = (path: ShellFieldPath) => plan.slots.find((slot) => slot.homeField === path)!.slotId;
      const texts = plan.taskType === "EXPLAIN_PATTERN" ? new Map<ShellFieldPath, string>([["headline", `A look at ${slotToken(home("headline"))}.`], ["evidence", `This is based on ${slotToken(home("evidence"))}.`]]) : fakeModelCareShells(plan);
      return new Response(JSON.stringify({ kind: "CANDIDATE", candidate: shellCandidate(plan, texts), retention: "CONFIRMED_NOT_STORED", usage: { inputTokens: 1, outputTokens: 1, costMicroUsd: 1 } }), { headers: { "content-type": "application/json" } });
    });
  }

  async function toCarePreview() {
    const en = getMessages("en-SG");
    await screen.findByRole("button", { name: en.today.recordReading });
    fireEvent.click(screen.getByRole("button", { name: en.today.prepareAppointment }));
    fireEvent.click(await screen.findByRole("checkbox", { name: new RegExp(en.carePreparation.glucoseReadings) }));
    fireEvent.click(screen.getByRole("button", { name: en.carePreparation.previewSummary }));
    await screen.findByRole("heading", { level: 1, name: en.careSummary.title });
    return screen.findByRole("article");
  }

  // Owner demo override (owner decision 2026-10-12: English AI care drafts beyond the tested shapes): an en-SG preview outside the
  // evaluated classes now OFFERS the AI action; offering it sends nothing, writes no audit row and opens no dialog.
  it("shipped manifest and records, an en-SG preview outside the evaluated classes: the AI action is offered (owner demo override), but no dialog, audit row or network call at startup, preview, approval or print", async () => {
    const en = getMessages("en-SG");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const care = await careRuntime();
    const print = vi.fn(async () => "DIALOG_OPENED" as const);
    render(<JagaOnApp runtimeFactory={async () => care.runtime} onboardingRepositoryFactory={completed()} printPortFactory={() => ({ print })} />);
    await toCarePreview();
    const approve = (await screen.findByRole("button", { name: en.careSummary.approveAction })) as HTMLButtonElement;
    await waitFor(() => expect(approve.disabled).toBe(false));
    expect(await screen.findByRole("button", { name: en.ai.careSummary.action })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(approve);
    fireEvent.click(await screen.findByRole("button", { name: en.careSummary.printAction }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    // The action is offered only on an unapproved preview: gone after approval and print.
    expect(screen.queryByRole("button", { name: en.ai.careSummary.action })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText(en.ai.careSummary.resultTitle)).not.toBeInTheDocument();
    expect(care.runtime.aiAudit.append).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // Packet 11C English activation (owner decisions Q and A): the shipped records qualify the en-SG classes, so "nothing qualified" is an
  // injected all-PENDING gate (the pre-activation state; was: the shipped records).
  it("C3: activated (test manifest) with an all-PENDING gate: no disclosure in either flow, no care AI action, nothing sent", async () => {
    const en = getMessages("en-SG");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const care = await careRuntime();
    const { history } = await higherFixture();
    care.runtime.history = history;
    const fetcher = fakeRoute();
    const factory: AiAssistanceFactory = (ports) => createBrowserAiAssistance({ ...ports, manifest: BOTH, requestClassGate: pendingTestRequestClassGate(), fetcher, now: () => LATER as never });
    render(<JagaOnApp runtimeFactory={async () => care.runtime} onboardingRepositoryFactory={completed()} printPortFactory={() => ({ print: vi.fn() })} aiAssistanceFactory={factory} />);
    fireEvent.click(within(await screen.findByRole("navigation")).getByRole("button", { name: en.shared.navHistory }));
    fireEvent.click(await screen.findByRole("button", { name: en.history.explanation.action }));
    const panel = await screen.findByRole("region", { name: en.history.explanation.title });
    await waitFor(() => expect(within(panel).getByRole("status")).not.toBeEmptyDOMElement());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(within(panel).queryByText(en.history.explanation.aiLabel)).not.toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("navigation")).getByRole("button", { name: en.shared.navToday }));
    await toCarePreview();
    const approve = (await screen.findByRole("button", { name: en.careSummary.approveAction })) as HTMLButtonElement;
    await waitFor(() => expect(approve.disabled).toBe(false));
    expect(screen.queryByRole("button", { name: en.ai.careSummary.action })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect((await care.audits.list()).map((row) => `${row.taskType}:${row.outcomeCode}:${row.attempts.count}`)).toEqual(["EXPLAIN_PATTERN:REQUEST_CLASS_NOT_QUALIFIED:0"]);
    expect(fetcher).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("activated (test manifest, fake route): a declined disclosure sends nothing, keeps the preview and writes one REMOTE_USE_DECLINED row (C5)", async () => {
    const en = getMessages("en-SG");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const care = await careRuntime();
    const fetcher = fakeRoute();
    const factory: AiAssistanceFactory = (ports) => createBrowserAiAssistance({ ...ports, manifest: BOTH, requestClassGate: qualifiedTestRequestClassGate(), fetcher, now: () => LATER as never });
    render(<JagaOnApp runtimeFactory={async () => care.runtime} onboardingRepositoryFactory={completed()} printPortFactory={() => ({ print: vi.fn() })} aiAssistanceFactory={factory} />);
    const before = (await toCarePreview()).textContent;
    const action = (await screen.findByRole("button", { name: en.ai.careSummary.action })) as HTMLButtonElement;
    await waitFor(() => expect(action.disabled).toBe(false));
    fireEvent.click(action);
    const dialog = await screen.findByRole("dialog", { name: en.ai.remoteTitle });
    expect(care.runtime.aiAudit.append).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: en.ai.cancel }));
    expect(await screen.findByText(en.ai.remoteNotAccepted)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: en.ai.careSummary.resultTitle })).not.toBeInTheDocument();
    expect(screen.getByRole("article").textContent).toBe(before);
    const rows = await care.audits.list();
    expect(rows.map((row) => [row.taskType, row.outcomeCode, row.attempts.count, row.providerModel, row.sourceRevisions.length])).toEqual([["DRAFT_CARE_PREPARATION_SUMMARY", "REMOTE_USE_DECLINED", 0, null, 0]]);
    expect(await care.h.database.table("recordHeads").where("recordType").equals("CARE_SUMMARY_SNAPSHOT").count()).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("C5 activated (test manifest, fake route): a care disclosure left open when the app closes writes one DISCLOSURE_CLOSED_MOOT row; nothing sent", async () => {
    const en = getMessages("en-SG");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const care = await careRuntime();
    const fetcher = fakeRoute();
    const factory: AiAssistanceFactory = (ports) => createBrowserAiAssistance({ ...ports, manifest: BOTH, requestClassGate: qualifiedTestRequestClassGate(), fetcher, now: () => LATER as never });
    render(<JagaOnApp runtimeFactory={async () => care.runtime} onboardingRepositoryFactory={completed()} printPortFactory={() => ({ print: vi.fn() })} aiAssistanceFactory={factory} />);
    await toCarePreview();
    const action = (await screen.findByRole("button", { name: en.ai.careSummary.action })) as HTMLButtonElement;
    await waitFor(() => expect(action.disabled).toBe(false));
    fireEvent.click(action);
    await screen.findByRole("dialog", { name: en.ai.remoteTitle });
    expect(await care.audits.list()).toEqual([]);
    cleanup();
    await waitFor(async () => expect(await care.audits.list()).toHaveLength(1));
    const rows = await care.audits.list();
    expect(rows.map((row) => [row.taskType, row.locale, row.outcomeCode, row.attempts.count, row.providerModel])).toEqual([["DRAFT_CARE_PREPARATION_SUMMARY", "en-SG", "DISCLOSURE_CLOSED_MOOT", 0, null]]);
    expect(fetcher).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  /**
   * C4 fix round 1 (regression for the C2 fix round 1 disclosure-key race; flake-investigation.md item 1): a click on the care action
   * handled right after the commit that enables it (PREPARED -> PREVIEWED, a new revision so a new disclosure key), before React's
   * passive effects of that commit have run, must still open the disclosure. Before the fix the asynchronous disclosure answer was
   * compared with the stale key and the patient's explicit request was dropped: no dialog, nothing sent, no audit row.
   */
  it("C2 regression: a care action click landing right after the action becomes enabled still opens the disclosure", async () => {
    const en = getMessages("en-SG");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const care = await careRuntime();
    // The PREPARED -> PREVIEWED commit lands while the test is already waiting for the enabled action (as on a slow worker).
    const commands = care.runtime.carePreparation!.commands;
    const markPreviewed = commands.markPreviewed.bind(commands);
    care.runtime.carePreparation = {
      ...care.runtime.carePreparation!,
      commands: {
        ...commands,
        markPreviewed: async (input: never) => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return markPreviewed(input);
        },
      },
    } as never;
    const fetcher = fakeRoute();
    const factory: AiAssistanceFactory = (ports) => createBrowserAiAssistance({ ...ports, manifest: BOTH, requestClassGate: qualifiedTestRequestClassGate(), fetcher, now: () => LATER as never });
    render(<JagaOnApp runtimeFactory={async () => care.runtime} onboardingRepositoryFactory={completed()} printPortFactory={() => ({ print: vi.fn() })} aiAssistanceFactory={factory} />);
    await toCarePreview();
    const action = (await screen.findByRole("button", { name: en.ai.careSummary.action })) as HTMLButtonElement;
    expect(action.disabled).toBe(true);
    // The click lands in the same task as the commit that enables the action, before that commit's passive effects run.
    await new Promise<void>((resolve) => {
      const observer = new MutationObserver(() => {
        if (action.disabled) return;
        observer.disconnect();
        fireEvent.click(action);
        resolve();
      });
      observer.observe(document.body, { subtree: true, attributes: true, childList: true });
    });
    await screen.findByRole("dialog", { name: en.ai.remoteTitle }, { timeout: 3000 });
    // The dialog is open and undecided: nothing has been sent or audited yet.
    expect(await care.audits.list()).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("activated (test manifest, fake route): C3: a history acceptance never covers the care request (it asks its own); the accepted replacement opens in place of the old preview", async () => {
    const en = getMessages("en-SG");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const care = await careRuntime();
    const { history } = await higherFixture();
    care.runtime.history = history;
    const fetcher = fakeRoute();
    const factory: AiAssistanceFactory = (ports) => createBrowserAiAssistance({ ...ports, manifest: BOTH, requestClassGate: qualifiedTestRequestClassGate(), fetcher, now: () => LATER as never });
    render(<JagaOnApp runtimeFactory={async () => care.runtime} onboardingRepositoryFactory={completed()} printPortFactory={() => ({ print: vi.fn() })} aiAssistanceFactory={factory} />);

    // The disclosure is accepted for one history request.
    fireEvent.click(within(await screen.findByRole("navigation")).getByRole("button", { name: en.shared.navHistory }));
    fireEvent.click(await screen.findByRole("button", { name: en.history.explanation.action }));
    acceptDisclosure(await screen.findByRole("dialog", { name: en.ai.remoteTitle }), en.ai.pattern.confirm);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    fireEvent.click(within(screen.getByRole("navigation")).getByRole("button", { name: en.shared.navToday }));

    // Packet 11C Addendum C (C3): that acceptance never covers the care flow: its request shows its own disclosure first.
    const before = (await toCarePreview()).textContent;
    const action = (await screen.findByRole("button", { name: en.ai.careSummary.action })) as HTMLButtonElement;
    await waitFor(() => expect(action.disabled).toBe(false));
    fireEvent.click(action);
    const careDialog = await screen.findByRole("dialog", { name: en.ai.remoteTitle });
    expect(fetcher).toHaveBeenCalledTimes(1);
    acceptDisclosure(careDialog, en.ai.careSummary.confirm);
    const region = await screen.findByRole("region", { name: en.ai.careSummary.resultTitle });
    expect(within(region).getByText(en.ai.careSummary.resultBody)).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.getByRole("article").textContent).not.toBe(before));
    const rows = await care.audits.list();
    expect(rows.map((row) => `${row.taskType}:${row.outcomeCode}`).sort()).toEqual(["DRAFT_CARE_PREPARATION_SUMMARY:ACCEPTED", "EXPLAIN_PATTERN:ACCEPTED"]);
    // Approval is still the patient's own click: the new preview is not approved and nothing printed.
    const replaced = (await care.h.database.table("recordHeads").where("recordType").equals("CARE_SUMMARY_SNAPSHOT").toArray()).map((head) => head.recordId).find((id) => id !== care.prepared.recordId)!;
    await waitFor(async () => {
      const view = await care.h.query.loadSummary(replaced);
      expect(view.status === "READY" && [view.snapshotStatus, view.payload.composition.method]).toEqual(["PREVIEWED", "AI_ASSISTED"]);
    });
    expect(care.runtime.carePreparation.commands.prepare).toHaveBeenCalledTimes(1);
    // The replaced preview took the old one's place: Back returns to visit preparation, not to the superseded preview.
    fireEvent.click(screen.getAllByRole("button", { name: en.careSummary.backToPreparation }).at(-1)!);
    expect(await screen.findByRole("heading", { level: 1, name: en.carePreparation.title })).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
