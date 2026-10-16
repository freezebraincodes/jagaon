"use client";

import type { AppMessages, SupportedLocale } from "@/i18n/types";
import { Button } from "../primitives/Button";
import { DeviceIcon, ChevronRightIcon, BookletIcon, InfoIcon } from "../primitives/Icons";
import { Notice } from "../primitives/ScreenHeader";

type WelcomeScreenProps = {
  messages: AppMessages;
  locale: SupportedLocale;
  onLocaleChange: (locale: SupportedLocale) => void;
  onStart: () => void;
  onPrepared: () => void;
};

/**
 * Frame 14. Owner decision 2026-10-16: the demo is English only, so the language choice is hidden here; in its place, a highlight card
 * in the middle of the screen explains which start to choose (a new, empty booklet through setup, or the prepared profile with sample
 * records).
 */
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
      </div>
      <section className="welcome-choice-card" aria-labelledby="welcome-choice-title">
        <h2 id="welcome-choice-title" className="welcome-choice-title">
          <InfoIcon size={22} aria-hidden="true" />
          {msg.choiceTitle}
        </h2>
        <ul className="welcome-choice-list">
          <li>
            <strong>{msg.startSetup}:</strong> {msg.choiceSetup}
          </li>
          <li>
            <strong>{msg.usePrepared}:</strong> {msg.choicePrepared}
          </li>
        </ul>
        <p className="welcome-choice-tip">{msg.choiceTip}</p>
      </section>
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
