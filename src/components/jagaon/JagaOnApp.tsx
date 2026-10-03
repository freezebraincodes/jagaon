"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SupportedLocale } from "@/domain/patient-settings/locale";
import { getMessages } from "@/i18n/get-messages";
import type { AppMessages } from "@/i18n/types";
import { CURRENT_RELEASE_PROFILE } from "@/config/release-profile";
import { DemoBoundaryNotice } from "@/components/demo/DemoBoundaryNotice";
import { createDemoScenarioFixture } from "@/application/governed/demo-scenario-fixture";
import { TOP_LEVEL_SCREENS, type ScreenId } from "./screen-manifest";
import { RecordedHistoryScreen } from "./screens/RecordedHistoryScreen";
import { MedicationScheduleScreen } from "./screens/MedicationScheduleScreen";
import {
  createAppointmentNoteSelectionRepository,
  type AppointmentNoteSelectionRepository,
} from "@/application/history/appointment-note-selection";
import type { DemoOnboardingStoragePort } from "@/application/onboarding/demo-onboarding-repository";
import { AppShell } from "./AppShell";
import { TodayScreen } from "./screens/TodayScreen";
import { GlucoseEntryScreen } from "./screens/GlucoseEntryScreen";
import { ReadingTimeScreen } from "./screens/ReadingTimeScreen";
import { InsulinEntryScreen } from "./screens/InsulinEntryScreen";
import { MealEntryScreen } from "./screens/MealEntryScreen";
import { MedicationInformationScreen } from "./screens/MedicationInformationScreen";
import { NearbyFoodScreen } from "./screens/NearbyFoodScreen";
import { FoodGeneralInfoScreen } from "./screens/FoodGeneralInfoScreen";
import { MoreScreen } from "./screens/MoreScreen";
import { HelpScreen } from "./screens/HelpScreen";
import {
  createBrowserJournalRuntime,
  type JagaOnRuntime,
} from "@/application/journal/browser-journal-runtime";
import type { TodayJournalViewModel } from "@/application/journal/journal-contracts";
import type { RecordId } from "@/domain/shared/identifiers";
import type { DemoOnboardingStateV1 } from "@/application/onboarding/demo-onboarding-contracts";
import {
  createBrowserOnboardingStorage,
  createDemoOnboardingRepository,
  type DemoOnboardingRepository,
} from "@/application/onboarding/demo-onboarding-repository";
import { OnboardingFlow, type OnboardingExit } from "./onboarding/OnboardingFlow";
import { MyMedicinesScreen, type MyMedicinesView } from "./screens/MyMedicinesScreen";

// --- Section: Navigation state --------------------------------------------

type NavigationEntry = {
  screen: ScreenId;
  params?: Record<string, string>;
};

type JagaOnAppProps = {
  runtimeFactory?: () => Promise<JagaOnRuntime>;
  /** Injected for tests; defaults to the single versioned browser storage key. */
  onboardingRepositoryFactory?: () => DemoOnboardingRepository;
  /** Packet 7A: storage port for the local appointment-note selection. */
  appointmentNoteStorageFactory?: () => DemoOnboardingStoragePort;
};

/** Startup gate: onboarding until setup is completed or explicitly skipped. */
type Phase =
  | { kind: "LOADING" }
  | { kind: "ONBOARDING"; initial: DemoOnboardingStateV1 | null }
  | { kind: "APP" };

function browserOnboardingRepository(): DemoOnboardingRepository {
  return createDemoOnboardingRepository(createBrowserOnboardingStorage());
}

const EMPTY_TODAY: TodayJournalViewModel = Object.freeze({
  entries: [],
  unavailable: false,
});

export function JagaOnApp({
  runtimeFactory = createBrowserJournalRuntime,
  onboardingRepositoryFactory = browserOnboardingRepository,
  appointmentNoteStorageFactory = createBrowserOnboardingStorage,
}: JagaOnAppProps = {}) {
  const appointmentNotes = useMemo<AppointmentNoteSelectionRepository>(
    () =>
      createAppointmentNoteSelectionRepository(
        appointmentNoteStorageFactory(),
        () => new Date().toISOString() as never,
      ),
    [appointmentNoteStorageFactory],
  );
  const [repository, setRepository] = useState<DemoOnboardingRepository | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "LOADING" });
  const [onboarding, setOnboarding] = useState<DemoOnboardingStateV1 | null>(null);
  const fixture = useMemo(() => createDemoScenarioFixture(onboarding), [onboarding]);
  const [locale, setLocale] = useState<SupportedLocale>("en-SG");
  const messages = useMemo<AppMessages>(
    () => getMessages(locale),
    [locale],
  );

  const [stack, setStack] = useState<NavigationEntry[]>([
    { screen: "TODAY" },
  ]);
  const [runtime, setRuntime] = useState<JagaOnRuntime | null>(null);
  const [today, setToday] = useState<TodayJournalViewModel>(EMPTY_TODAY);
  /** True once a saved setup supplied the locale; it then wins over IndexedDB. */
  const onboardingLocaleRef = useRef(false);

  useEffect(() => {
    let active = true;
    let createdRuntime: JagaOnRuntime | null = null;

    void runtimeFactory()
      .then(async (nextRuntime) => {
        createdRuntime = nextRuntime;
        const [resolvedLocale, todayView] = await Promise.all([
          nextRuntime.resolveLocale(),
          nextRuntime.query.loadToday(),
        ]);
        if (!active) {
          nextRuntime.close();
          return;
        }
        setRuntime(nextRuntime);
        // The setup's own locale wins once onboarding state exists.
        setLocale((current) => (onboardingLocaleRef.current ? current : resolvedLocale));
        setToday(todayView);
      })
      .catch(() => {
        if (active) setToday({ entries: [], unavailable: true });
      });

    return () => {
      active = false;
      createdRuntime?.close();
    };
  }, [runtimeFactory]);

  // Load the onboarding state on the client only (never during server
  // rendering). Malformed state has already been cleared by the repository.
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      if (!active) return;
      const repo = onboardingRepositoryFactory();
      const saved = repo.load();
      setRepository(repo);
      setOnboarding(saved);
      if (saved) {
        onboardingLocaleRef.current = true;
        setLocale(saved.locale);
      }
      setPhase(
        saved && (saved.status === "COMPLETED" || saved.status === "SKIPPED")
          ? { kind: "APP" }
          : { kind: "ONBOARDING", initial: saved },
      );
    });
    return () => {
      active = false;
    };
  }, [onboardingRepositoryFactory]);

  // Keep the document language in step with the UI so assistive technology
  // reads zh-SG copy with a Chinese voice.
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const current = stack[stack.length - 1]!;
  const isTopLevel = TOP_LEVEL_SCREENS.includes(current.screen);

  const navigate = useCallback((screen: ScreenId, params?: Record<string, string>) => {
    setStack((prev) => [...prev, { screen, params }]);
  }, []);

  const goBack = useCallback(() => {
    setStack((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev));
  }, []);

  const switchTab = useCallback((screen: ScreenId) => {
    setStack([{ screen }]);
  }, []);

  /** My medicines sub-views: add/directions push; list pops back to the list. */
  const showMedicinesView = useCallback((view: MyMedicinesView, medicineId?: string) => {
    setStack((prev) => {
      const entry: NavigationEntry = {
        screen: "MY_MEDICINES",
        params: medicineId ? { view, medicineId } : { view },
      };
      if (view === "list") {
        const index = prev.findLastIndex(
          (candidate) => candidate.screen === "MY_MEDICINES" && (candidate.params?.view ?? "list") === "list",
        );
        return index >= 0 ? prev.slice(0, index + 1) : [...prev.slice(0, -1), entry];
      }
      const top = prev[prev.length - 1];
      if (view === "directions" && top?.screen === "MY_MEDICINES" && top.params?.view === "add") {
        return [...prev.slice(0, -1), entry];
      }
      return [...prev, entry];
    });
  }, []);

  /** Persists a complete onboarding state from the journal side. */
  const saveOnboarding = useCallback(
    (next: DemoOnboardingStateV1) => {
      if (!repository) return { ok: false as const, reason: "STORAGE_UNAVAILABLE" as const };
      const result = repository.save({ ...next, updatedAt: new Date().toISOString() });
      if (result.ok) setOnboarding(result.state);
      return result;
    },
    [repository],
  );

  const finishOnboarding = useCallback((exit: OnboardingExit) => {
    setOnboarding(exit.state);
    setPhase({ kind: "APP" });
    setStack(
      exit.destination === "TODAY"
        ? [{ screen: "TODAY" }]
        : [
            { screen: "TODAY" },
            {
              screen: "MY_MEDICINES",
              params: { view: exit.destination === "MY_MEDICINES_ADD" ? "add" : "list" },
            },
          ],
    );
  }, []);

  const refreshToday = useCallback(async () => {
    if (!runtime) return;
    setToday(await runtime.query.loadToday());
  }, [runtime]);

  // --- Screen rendering ---

  function renderScreen() {
    const entry = current;
    switch (entry.screen) {
      case "TODAY":
        return (
          <TodayScreen
            messages={messages}
            locale={locale}
            fixture={fixture}
            journal={today}
            actionsDisabled={!runtime}
            navigate={navigate}
          />
        );
      case "LOG_GLUCOSE":
        if (!runtime) return <p role="status">{messages.shared.loading}</p>;
        return (
          <GlucoseEntryScreen
            messages={messages}
            locale={locale}
            commandService={runtime.commands}
            goBack={goBack}
            onCommitted={refreshToday}
          />
        );
      case "CHANGE_READING_TIME":
        if (!runtime) return <p role="status">{messages.shared.loading}</p>;
        return (
          <ReadingTimeScreen
            messages={messages}
            locale={locale}
            goBack={goBack}
            recordId={(entry.params?.recordId ?? "") as RecordId}
            queryPort={runtime.query}
            commandService={runtime.commands}
            onCommitted={refreshToday}
          />
        );
      case "RECORD_INSULIN":
        if (!runtime) return <p role="status">{messages.shared.loading}</p>;
        return (
          <InsulinEntryScreen
            messages={messages}
            locale={locale}
            fixture={fixture}
            commandService={runtime.commands}
            goBack={goBack}
            onCommitted={refreshToday}
          />
        );
      case "LOG_MEAL":
        if (!runtime) return <p role="status">{messages.shared.loading}</p>;
        return (
          <MealEntryScreen
            messages={messages}
            locale={locale}
            fixture={fixture}
            commandService={runtime.commands}
            goBack={goBack}
            onCommitted={refreshToday}
          />
        );
      case "MEDICATION_INFORMATION":
        return (
          <MedicationInformationScreen
            messages={messages}
            locale={locale}
            fixture={fixture}
            goBack={goBack}
          />
        );
      case "NEARBY_FOOD":
        return (
          <NearbyFoodScreen
            messages={messages}
            locale={locale}
            goBack={goBack}
            navigate={navigate}
          />
        );
      case "GENERAL_FOOD_INFORMATION":
        return (
          <FoodGeneralInfoScreen
            messages={messages}
            goBack={goBack}
          />
        );
      case "MORE":
        return (
          <MoreScreen
            messages={messages}
            navigate={navigate}
            locale={locale}
            setLocale={setLocale}
            persistLocale={async (nextLocale) => {
              if (!runtime) throw new Error("STORAGE_UNAVAILABLE");
              await runtime.persistLocale(nextLocale);
              if (onboarding && !saveOnboarding({ ...onboarding, locale: nextLocale }).ok) {
                throw new Error("STORAGE_UNAVAILABLE");
              }
            }}
            resetDemo={async () => {
              if (!runtime || !repository) throw new Error("STORAGE_UNAVAILABLE");
              // Clear the small onboarding key first so a known adapter
              // failure cannot erase the larger IndexedDB journal. If the
              // IndexedDB reset then fails, restore the prior strict state.
              if (!repository.clear().ok) throw new Error("STORAGE_UNAVAILABLE");
              try {
                await runtime.resetDemo();
              } catch (error) {
                if (onboarding) repository.save(onboarding);
                throw error;
              }
              // The local appointment-note selection is demo data too.
              appointmentNotes.clear();
              onboardingLocaleRef.current = false;
              setOnboarding(null);
              setLocale("en-SG");
              setToday(await runtime.query.loadToday());
              setStack([{ screen: "TODAY" }]);
              setPhase({ kind: "ONBOARDING", initial: null });
            }}
          />
        );
      case "MY_MEDICINES":
        if (!onboarding) return <p role="status">{messages.shared.loading}</p>;
        return (
          <MyMedicinesScreen
            key={`${entry.params?.view ?? "list"}:${entry.params?.medicineId ?? ""}`}
            messages={messages}
            locale={locale}
            state={onboarding}
            view={(entry.params?.view as MyMedicinesView | undefined) ?? "list"}
            medicineId={entry.params?.medicineId}
            save={saveOnboarding}
            navigate={navigate}
            showView={showMedicinesView}
          />
        );
      case "HISTORY":
        return (
          <RecordedHistoryScreen
            messages={messages}
            locale={locale}
            history={runtime?.history ?? null}
            selection={appointmentNotes}
          />
        );
      case "MEDICATION_SCHEDULE":
        return (
          <MedicationScheduleScreen
            messages={messages}
            locale={locale}
            schedule={runtime?.medicationSchedule ?? null}
            medicationRecordIds={fixture.recordedPrescriptions.map((prescription) => prescription.medicationRecordId)}
          />
        );
      case "HELP_INFORMATION":
        return (
          <HelpScreen
            messages={messages}
            goBack={goBack}
          />
        );
      default:
        return null;
    }
  }

  // --- Release profile guard ---
  if (CURRENT_RELEASE_PROFILE !== "HACKATHON_DEMO") {
    return (
      <>
        <DemoBoundaryNotice />
        <main className="app-main">
          <h1 className="app-title">{messages.shared.appName}</h1>
          <p className="app-status">{messages.shared.demoBoundary}</p>
        </main>
      </>
    );
  }

  if (phase.kind === "LOADING") {
    return (
      <>
        <DemoBoundaryNotice />
        <main className="app-main">
          <p role="status">{messages.shared.loading}</p>
        </main>
      </>
    );
  }

  if (phase.kind === "ONBOARDING" && repository) {
    // Bottom navigation stays hidden until setup is completed or skipped.
    return (
      <OnboardingFlow
        key={phase.initial?.updatedAt ?? "fresh"}
        messages={messages}
        locale={locale}
        onLocaleChange={setLocale}
        repository={repository}
        initialState={phase.initial}
        onExit={finishOnboarding}
      />
    );
  }

  return (
    <>
      <DemoBoundaryNotice />
      <AppShell
        messages={messages}
        currentScreen={current.screen}
        isTopLevel={isTopLevel}
        onBack={goBack}
        onSwitchTab={switchTab}
      >
        {renderScreen()}
      </AppShell>
    </>
  );
}

// Re-export for tests
export type { AppMessages };
