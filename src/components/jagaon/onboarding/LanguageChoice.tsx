"use client";

import type { AppMessages, SupportedLocale } from "@/i18n/types";
import { ChoiceGroup } from "../primitives/ChoiceGroup";

/** The bilingual language picker used on Welcome and Step 1. */
export function LanguageChoice({
  messages,
  locale,
  onChange,
}: {
  messages: AppMessages;
  locale: SupportedLocale;
  onChange: (locale: SupportedLocale) => void;
}) {
  return (
    <ChoiceGroup<SupportedLocale>
      legend={messages.onboarding.languageLabel}
      variant="language"
      options={[
        { value: "en-SG", label: messages.settings.english },
        { value: "zh-SG", label: messages.settings.chinese },
      ]}
      value={locale}
      onChange={onChange}
    />
  );
}
