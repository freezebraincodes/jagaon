"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { SupportedLocale } from "@/domain/patient-settings/locale";
import { getMessages } from "@/i18n/get-messages";
import type { AppMessages } from "@/i18n/types";
import { CURRENT_RELEASE_PROFILE } from "@/config/release-profile";
import { DemoBoundaryNotice } from "@/components/demo/DemoBoundaryNotice";
import { createDemoScenarioFixture } from "@/application/governed/demo-scenario-fixture";
import type { ScreenId } from "./screen-manifest";
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

// --- Section: Navigation state --------------------------------------------

type NavigationEntry = {
  screen: ScreenId;
  params?: Record<string, string>;
};

type JagaOnAppProps = {
  runtimeFactory?: () => Promise<JagaOnRuntime>;
};

const EMPTY_TODAY: TodayJournalViewModel = Object.freeze({
  entries: [],
  unavailable: false,
});

export function JagaOnApp({
  runtimeFactory = createBrowserJournalRuntime,
}: JagaOnAppProps = {}) {
  const fixture = useMemo(() => createDemoScenarioFixture(), []);
  const [locale, setLocale] = useState<SupportedLocale>(fixture.defaultLocale);
  const messages = useMemo<AppMessages>(
    () => getMessages(locale),
    [locale],
  );

  const [stack, setStack] = useState<NavigationEntry[]>([
    { screen: "TODAY" },
  ]);
  const [runtime, setRuntime] = useState<JagaOnRuntime | null>(null);
  const [today, setToday] = useState<TodayJournalViewModel>(EMPTY_TODAY);

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
        setLocale(resolvedLocale);
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

  // Keep the document language in step with the UI so assistive technology
  // reads zh-SG copy with a Chinese voice.
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const current = stack[stack.length - 1]!;
  const isTopLevel = current.screen === "TODAY" || current.screen === "MORE";

  const navigate = useCallback((screen: ScreenId, params?: Record<string, string>) => {
    setStack((prev) => [...prev, { screen, params }]);
  }, []);

  const goBack = useCallback(() => {
    setStack((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev));
  }, []);

  const switchTab = useCallback((screen: ScreenId) => {
    setStack([{ screen }]);
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
            }}
            resetDemo={async () => {
              if (!runtime) throw new Error("STORAGE_UNAVAILABLE");
              await runtime.resetDemo();
              setLocale("en-SG");
              setToday(await runtime.query.loadToday());
              setStack([{ screen: "TODAY" }]);
            }}
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
