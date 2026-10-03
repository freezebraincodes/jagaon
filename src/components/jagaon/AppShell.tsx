"use client";

import { useEffect, useRef, type ReactNode } from "react";
import type { AppMessages } from "@/i18n/types";
import type { ScreenId } from "./screen-manifest";
import { BookletIcon, ChartIcon, ChevronLeftIcon, HomeIcon, MoreIcon } from "./primitives/Icons";

type AppShellProps = {
  messages: AppMessages;
  currentScreen: ScreenId;
  isTopLevel: boolean;
  onBack: () => void;
  onSwitchTab: (screen: ScreenId) => void;
  children: ReactNode;
};

export function AppShell({
  messages,
  currentScreen,
  isTopLevel,
  onBack,
  onSwitchTab,
  children,
}: AppShellProps) {
  const mainRef = useRef<HTMLElement>(null);
  const previousScreen = useRef(currentScreen);

  // On every screen change (not the first load) start at the top and move
  // focus to the new screen's heading so keyboard and screen-reader users
  // land on the new content instead of a detached control.
  useEffect(() => {
    if (previousScreen.current === currentScreen) return;
    previousScreen.current = currentScreen;
    const scroller = document.scrollingElement;
    if (scroller) scroller.scrollTop = 0;
    const heading = mainRef.current?.querySelector<HTMLElement>("h1");
    if (heading) {
      heading.setAttribute("tabindex", "-1");
      heading.focus({ preventScroll: true });
    }
  }, [currentScreen]);

  // Booklet is the Packet 8 Medication schedule; History is Packet 7A.
  const tabs: Array<{ screen: ScreenId; label: string; icon: ReactNode }> = [
    { screen: "TODAY", label: messages.shared.navToday, icon: <HomeIcon size={26} /> },
    { screen: "MEDICATION_SCHEDULE", label: messages.shared.navBooklet, icon: <BookletIcon size={26} /> },
    { screen: "HISTORY", label: messages.shared.navHistory, icon: <ChartIcon size={26} /> },
    { screen: "MORE", label: messages.shared.navMore, icon: <MoreIcon size={26} /> },
  ];

  return (
    <>
      <main
        ref={mainRef}
        className={`app-main ${isTopLevel ? "app-main--top" : "app-main--child"}`}
        data-screen={currentScreen}
      >
        {!isTopLevel ? (
          <button
            type="button"
            className="screen-back-button"
            onClick={onBack}
            aria-label={messages.shared.back}
          >
            <ChevronLeftIcon size={28} />
          </button>
        ) : null}
        {children}
      </main>
      {isTopLevel ? (
        <nav className="app-nav">
          <div className="app-nav-inner">
            {tabs.map((tab) => (
              <button
                key={tab.screen}
                type="button"
                className="app-nav-button"
                aria-current={currentScreen === tab.screen ? "page" : undefined}
                onClick={() => onSwitchTab(tab.screen)}
              >
                {tab.icon}
                <span>{tab.label}</span>
              </button>
            ))}
          </div>
        </nav>
      ) : null}
    </>
  );
}
