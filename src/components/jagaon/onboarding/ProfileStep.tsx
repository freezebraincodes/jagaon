"use client";

import { useState } from "react";
import type { AppMessages, SupportedLocale } from "@/i18n/types";
import { DEMO_TEXT_LIMITS } from "@/application/onboarding/demo-onboarding-contracts";
import { labelWithAside } from "../locale-format";
import { Button } from "../primitives/Button";
import { InputField } from "../primitives/Field";
import { ChevronRightIcon, LanguageIcon, ShieldIcon } from "../primitives/Icons";
import { Notice } from "../primitives/ScreenHeader";

type ProfileStepProps = {
  messages: AppMessages;
  locale: SupportedLocale;
  initialName: string;
  /** Visible confirmation after a successful language change (frame 29). */
  languageSwitched: boolean;
  onLocaleChange: (locale: SupportedLocale, currentName: string) => void;
  onContinue: (name: string) => void;
  onSkip: (name: string) => void;
};

/** Frames 15 and 29. Only an optional greeting name is asked for. */
export function ProfileStep({
  messages,
  locale,
  initialName,
  languageSwitched,
  onLocaleChange,
  onContinue,
  onSkip,
}: ProfileStepProps) {
  const msg = messages.onboarding;
  const [name, setName] = useState(initialName);
  const languageName = locale === "zh-SG" ? messages.settings.chinese : messages.settings.english;
  return (
    <div className="onboarding-page">
      <h1 className="onboarding-title">{msg.profileTitle}</h1>
      <InputField
        label={labelWithAside(locale, msg.preferredNameLabel, messages.shared.optional)}
        hint={msg.preferredNameHint}
        placeholder={msg.preferredNamePlaceholder}
        value={name}
        maxLength={DEMO_TEXT_LIMITS.name}
        autoComplete="off"
        onChange={(e) => setName(e.target.value)}
      />
      {/* Owner decision 2026-10-16: the demo is English only, so the language choice is hidden during setup. */}
      {languageSwitched ? (
        <Notice icon={<LanguageIcon size={20} />} className="notice--status">
          <p>{msg.languageSwitched(languageName)}</p>
          <p>{msg.notTranslated}</p>
        </Notice>
      ) : null}
      <Notice icon={<ShieldIcon size={20} />}>{msg.noSensitiveData}</Notice>
      <div className="onboarding-actions">
        <Button variant="primary" className="btn-hero" onClick={() => onContinue(name)}>
          <ChevronRightIcon size={24} />
          {messages.shared.continue}
        </Button>
        <Button variant="outline" className="btn-wide" onClick={() => onSkip(name)}>
          {msg.skipForNow}
        </Button>
      </div>
    </div>
  );
}
