"use client";

import type { AppMessages, SupportedLocale } from "@/i18n/types";
import { Button } from "../primitives/Button";
import { DeviceIcon, ChevronRightIcon, BookletIcon } from "../primitives/Icons";
import { Notice } from "../primitives/ScreenHeader";
import { LanguageChoice } from "./LanguageChoice";

type WelcomeScreenProps = {
  messages: AppMessages;
  locale: SupportedLocale;
  onLocaleChange: (locale: SupportedLocale) => void;
  onStart: () => void;
  onPrepared: () => void;
};

/** Frame 14. */
export function WelcomeScreen({ messages, locale, onLocaleChange, onStart, onPrepared }: WelcomeScreenProps) {
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
        <div className="onboarding-card">
          <LanguageChoice messages={messages} locale={locale} onChange={onLocaleChange} />
        </div>
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
