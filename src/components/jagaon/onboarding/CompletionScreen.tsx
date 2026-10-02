"use client";

import type { AppMessages, SupportedLocale } from "@/i18n/types";
import type { DemoOnboardingStateV1 } from "@/application/onboarding/demo-onboarding-contracts";
import { labelAndValue } from "../locale-format";
import { Button } from "../primitives/Button";
import { CheckIcon, PillIcon, SunIcon } from "../primitives/Icons";
import { sourceLabel } from "./medicine-labels";
import { languageName } from "./ReviewStep";

type CompletionScreenProps = {
  messages: AppMessages;
  locale: SupportedLocale;
  state: DemoOnboardingStateV1;
  onOpenToday: () => void;
  onReviewMedicines: () => void;
};

/** Frame 20. A calm summary of what was recorded; no treatment claims. */
export function CompletionScreen({ messages, locale, state, onOpenToday, onReviewMedicines }: CompletionScreenProps) {
  const msg = messages.onboarding;
  const names = state.medicines.map((medicine) => medicine.displayName).join(", ");
  return (
    <div className="onboarding-page onboarding-page--spread">
      <div className="onboarding-intro">
        <span className="completion-mark" aria-hidden="true">
          <CheckIcon size={48} />
        </span>
        <h1 className="onboarding-title">{msg.completeTitle}</h1>
        <p className="onboarding-lead">{msg.completeBody}</p>
        <section className="onboarding-card" aria-labelledby="completion-recorded">
          <h2 className="eyebrow" id="completion-recorded">
            {msg.recordedHeading}
          </h2>
          <ul className="check-list">
            <li>
              <CheckIcon size={20} />
              <span>
                {labelAndValue(locale, msg.preferredNameLabel, state.preferredName ?? msg.notProvided)}
                {" · "}
                {languageName(messages, state.locale)}
              </span>
            </li>
            <li>
              <CheckIcon size={20} />
              <span>
                {state.medicines.length === 0
                  ? msg.noMedicinesRecorded
                  : labelAndValue(locale, msg.medicineCount(state.medicines.length), names)}
              </span>
            </li>
            {state.medicines.map((medicine) => (
              <li key={medicine.id}>
                <CheckIcon size={20} />
                <span>
                  {`${medicine.displayName} — ${labelAndValue(
                    locale,
                    msg.recordedSchedule,
                    medicine.scheduleOrTiming ?? msg.unknownValue,
                  )} · ${sourceLabel(messages, medicine.source)}`}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
      <div className="onboarding-actions">
        <Button variant="primary" className="btn-hero" onClick={onOpenToday}>
          <SunIcon size={24} />
          {msg.openToday}
        </Button>
        <Button variant="outline" className="btn-wide" onClick={onReviewMedicines}>
          <PillIcon size={22} />
          {msg.reviewMedicines}
        </Button>
      </div>
    </div>
  );
}
