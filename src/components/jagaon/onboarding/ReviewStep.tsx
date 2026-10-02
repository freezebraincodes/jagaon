"use client";

import type { AppMessages, SupportedLocale } from "@/i18n/types";
import type { DemoOnboardingStateV1 } from "@/application/onboarding/demo-onboarding-contracts";
import { labelAndValue } from "../locale-format";
import { Button } from "../primitives/Button";
import { CheckIcon, ChevronLeftIcon, ClockIcon, DocumentIcon, InfoIcon, PencilIcon } from "../primitives/Icons";
import { Notice } from "../primitives/ScreenHeader";
import { medicineSubtitle, sourceLabel } from "./medicine-labels";

type ReviewStepProps = {
  messages: AppMessages;
  locale: SupportedLocale;
  state: DemoOnboardingStateV1;
  onEditProfile: () => void;
  onEditMedicine: (id: string) => void;
  onFinish: () => void;
  onBack: () => void;
};

export function languageName(messages: AppMessages, locale: SupportedLocale): string {
  return locale === "zh-SG" ? messages.settings.chinese : messages.settings.english;
}

/** Frame 19. Shows only what was recorded; unknown stays "Unknown". */
export function ReviewStep({ messages, locale, state, onEditProfile, onEditMedicine, onFinish, onBack }: ReviewStepProps) {
  const msg = messages.onboarding;
  return (
    <div className="onboarding-page">
      <h1 className="onboarding-title">{msg.reviewTitle}</h1>

      <section className="onboarding-card review-card" aria-labelledby="review-about">
        <div className="review-card-head">
          <h2 className="eyebrow" id="review-about">
            {msg.aboutYou}
          </h2>
          <button type="button" className="text-link" aria-label={msg.editNamed(msg.aboutYou)} onClick={onEditProfile}>
            <PencilIcon size={18} />
            {messages.shared.edit}
          </button>
        </div>
        <p className="review-fact">
          <span className="review-fact-label">{msg.preferredNameLabel}{msg.labelSeparator}</span>
          <span>{state.preferredName ?? msg.notProvided}</span>
        </p>
        <p className="review-fact">
          <span className="review-fact-label">{messages.settings.language}{msg.labelSeparator}</span>
          <span>{languageName(messages, state.locale)}</span>
        </p>
      </section>

      <h2 className="eyebrow">{msg.recordedMedicines}</h2>
      {state.medicines.length === 0 ? (
        <p className="onboarding-footnote">{msg.noMedicinesRecorded}</p>
      ) : (
        <ul className="medicine-cards">
          {state.medicines.map((medicine) => (
            <li key={medicine.id} className="medicine-card">
              <div className="review-card-head">
                <div className="medicine-card-names">
                  <h3 className="medicine-card-name">{medicine.displayName}</h3>
                  {medicineSubtitle(messages, medicine) ? (
                    <p className="medicine-card-subtitle">{medicineSubtitle(messages, medicine)}</p>
                  ) : null}
                </div>
                <button
                  type="button"
                  className="text-link"
                  aria-label={msg.editNamed(medicine.displayName)}
                  onClick={() => onEditMedicine(medicine.id)}
                >
                  <PencilIcon size={18} />
                  {messages.shared.edit}
                </button>
              </div>
              <p className="review-fact">
                {labelAndValue(locale, msg.recordedSchedule, medicine.scheduleOrTiming ?? msg.unknownValue)}
              </p>
              <p className="review-fact">
                <span className="review-fact-label">{msg.recordedDirectionsLabel}{msg.labelSeparator}</span>
                <span>{medicine.verbatimDirections ?? msg.unknownValue}</span>
              </p>
              <p className="provenance-line medicine-card-source">
                <DocumentIcon size={18} />
                {sourceLabel(messages, medicine.source)}
              </p>
            </li>
          ))}
        </ul>
      )}

      <Notice icon={<ClockIcon size={20} />}>{msg.unknownLater}</Notice>
      <Notice icon={<InfoIcon size={20} />}>{msg.notMissed}</Notice>

      <div className="onboarding-actions">
        <Button variant="primary" className="btn-hero" onClick={onFinish}>
          <CheckIcon size={24} />
          {msg.finishSetup}
        </Button>
        <Button variant="outline" className="btn-wide" onClick={onBack}>
          <ChevronLeftIcon size={22} />
          {messages.shared.back}
        </Button>
      </div>
    </div>
  );
}
