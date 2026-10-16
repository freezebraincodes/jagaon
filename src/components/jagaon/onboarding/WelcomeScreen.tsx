"use client";

import type { AppMessages, SupportedLocale } from "@/i18n/types";
import { Button } from "../primitives/Button";
import { DeviceIcon, ChevronRightIcon, BookletIcon } from "../primitives/Icons";
import { Notice } from "../primitives/ScreenHeader";

type WelcomeScreenProps = {
  messages: AppMessages;
  locale: SupportedLocale;
  onLocaleChange: (locale: SupportedLocale) => void;
  onStart: () => void;
  onPrepared: () => void;
};

/** Frame 14. */
export function WelcomeScreen({ messages, onStart, onPrepared }: WelcomeScreenProps) {
  const msg = messages.onboarding;
  return (
    <div className="onboarding-page onboarding-page--spread">
      <div className="onboarding-intro">
        <p className="onboarding-logo">
          <span className="onboarding-logo-mark" aria-hidden="true">
            <BookletIcon size={34} />
          </span>
          {messages.shared.appName}
        </p>
        <h1 className="onboarding-title">{msg.welcomeTitle}</h1>
        <p className="onboarding-lead">{msg.welcomeBody}</p>
        {/* Owner decision 2026-10-16: the demo is English only, so the language choice is hidden during setup. */}
      </div>
      <div className="onboarding-actions">
        <Button variant="primary" className="btn-hero" onClick={onStart}>
          <ChevronRightIcon size={24} />
          {msg.startSetup}
        </Button>
        <Button variant="outline" className="btn-wide" onClick={onPrepared}>
          {msg.usePrepared}
        </Button>
        <Notice icon={<DeviceIcon size={20} />}>{msg.deviceNote}</Notice>
      </div>
    </div>
  );
}
