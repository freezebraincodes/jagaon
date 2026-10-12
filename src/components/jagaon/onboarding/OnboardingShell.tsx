"use client";

import { useEffect, useRef, type ReactNode } from "react";
import type { AppMessages } from "@/i18n/types";
import { getMessages } from "@/i18n/get-messages";
import type { DemoOnboardingStep } from "@/application/onboarding/demo-onboarding-contracts";
import { ChevronLeftIcon, FlaskIcon } from "../primitives/Icons";
import { OnboardingProgress } from "./OnboardingProgress";

type OnboardingShellProps = {
  messages: AppMessages;
  /** Identifies the current view so focus moves to its heading on change. */
  viewKey: string;
  /** Numbered steps only; Welcome, completion and recovery omit it. */
  step?: DemoOnboardingStep | null;
  onBack?: () => void;
  /** Polite announcement (save, language change, recovery). */
  announcement?: string;
  /** The compact demo boundary; where it shows is set by `DEMO_BOUNDARY_PLACEMENT` (owner decision 2026-10-12: hidden). */
  showBoundary?: boolean;
  children: ReactNode;
};

/**
 * Onboarding frame: compact bilingual demo boundary (per `DEMO_BOUNDARY_PLACEMENT`), optional back button
 * and five-step progress, a single main region, and a polite live region.
 * The journal's bottom navigation is never rendered here.
 */
export function OnboardingShell({
  messages,
  viewKey,
  step = null,
  onBack,
  announcement = "",
  showBoundary = false,
  children,
}: OnboardingShellProps) {
  const mainRef = useRef<HTMLElement>(null);
  const previousView = useRef(viewKey);

  useEffect(() => {
    if (previousView.current === viewKey) return;
    previousView.current = viewKey;
    const scroller = document.scrollingElement;
    if (scroller) scroller.scrollTop = 0;
    const heading = mainRef.current?.querySelector<HTMLElement>("h1");
    if (heading) {
      heading.setAttribute("tabindex", "-1");
      heading.focus({ preventScroll: true });
    }
  }, [viewKey]);

  return (
    <div className="onboarding">
      {showBoundary ? (
        <aside className="onboarding-boundary" aria-label={messages.onboarding.compactBoundary}>
          <FlaskIcon size={20} />
          <div>
            <p lang="en-SG">{getMessages("en-SG").onboarding.compactBoundary}</p>
            <p lang="zh-SG">{getMessages("zh-SG").onboarding.compactBoundary}</p>
          </div>
        </aside>
      ) : null}
      <main ref={mainRef} className="onboarding-main" data-onboarding-view={viewKey}>
        {onBack || step ? (
          <div className="onboarding-topbar">
            {onBack ? (
              <button
                type="button"
                className="screen-back-button onboarding-back"
                onClick={onBack}
                aria-label={messages.shared.back}
              >
                <ChevronLeftIcon size={28} />
              </button>
            ) : null}
            {step ? <OnboardingProgress messages={messages} step={step} /> : null}
          </div>
        ) : null}
        {children}
      </main>
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}
