"use client";

import { useRef, useState } from "react";
import type { AppMessages, SupportedLocale } from "@/i18n/types";
import {
  nextDemoOnboardingStep,
  stepNumber,
  type DemoOnboardingStateV1,
  type DemoOnboardingStep,
} from "@/application/onboarding/demo-onboarding-contracts";
import { labelAndValue } from "../locale-format";
import { Button } from "../primitives/Button";
import { CheckIcon, ChevronRightIcon, LoaderIcon, ResetIcon } from "../primitives/Icons";
import { RestartConfirmationDialog } from "./RestartConfirmationDialog";

export function stepLabel(messages: AppMessages, step: DemoOnboardingStep): string {
  const msg = messages.onboarding;
  switch (step) {
    case "PROFILE":
      return msg.stepProfile;
    case "MEDICINES":
      return msg.stepMedicines;
    case "ADD_MEDICINE":
      return msg.stepAddMedicine;
    case "DIRECTIONS":
      return msg.stepDirections;
    case "REVIEW":
      return msg.stepReview;
  }
}

/** Summary used by the restart dialog, built only from persisted values. */
export function savedSummary(messages: AppMessages, locale: SupportedLocale, state: DemoOnboardingStateV1): string {
  const msg = messages.onboarding;
  const parts = [
    state.preferredName ? msg.restartSavedName : null,
    state.medicines.length > 0 ? msg.medicineCount(state.medicines.length) : null,
  ].filter(Boolean) as string[];
  if (parts.length === 0) return msg.restartNothingSaved;
  return parts.join(locale === "zh-SG" ? "、" : " and ");
}

type ResumeScreenProps = {
  messages: AppMessages;
  locale: SupportedLocale;
  /** The last valid persisted state; nothing unsaved is shown as kept. */
  persisted: DemoOnboardingStateV1;
  onContinue: (step: DemoOnboardingStep) => void;
  onRestart: () => void;
};

/** Frames 26 and 30. */
export function ResumeScreen({ messages, locale, persisted, onContinue, onRestart }: ResumeScreenProps) {
  const msg = messages.onboarding;
  const next = nextDemoOnboardingStep(persisted.lastCompletedStep);
  const nextNumber = stepNumber(next);
  const [confirming, setConfirming] = useState(false);
  const restartButton = useRef<HTMLButtonElement | null>(null);
  const lastMedicine = persisted.medicines.at(-1);
  const pendingWork =
    next === "DIRECTIONS" && lastMedicine ? msg.directionsFor(lastMedicine.displayName) : stepLabel(messages, next);
  const kept = [
    persisted.preferredName ? labelAndValue(locale, msg.preferredNameLabel, persisted.preferredName) : null,
    persisted.medicines.length > 0
      ? labelAndValue(
          locale,
          msg.medicineCount(persisted.medicines.length),
          persisted.medicines.map((medicine) => medicine.displayName).join(", "),
        )
      : null,
  ].filter(Boolean) as string[];

  return (
    <>
      <div className="onboarding-page onboarding-page--spread" inert={confirming || undefined}>
        <div className="onboarding-intro">
          <span className="onboarding-icon-tile onboarding-icon-tile--large" aria-hidden="true">
            <ResetIcon size={34} />
          </span>
          <h1 className="onboarding-title">{msg.resumeTitle}</h1>
          <p className="onboarding-lead">{msg.resumeBody(nextNumber, stepLabel(messages, next))}</p>
          <section className="onboarding-card" aria-labelledby="resume-kept">
            <h2 className="eyebrow" id="resume-kept">
              {msg.kept}
            </h2>
            {kept.length > 0 ? (
              <ul className="check-list">
                {kept.map((item) => (
                  <li key={item}>
                    <CheckIcon size={20} />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="onboarding-footnote">{msg.nothingSavedYet}</p>
            )}
            <h2 className="eyebrow" id="resume-unsaved">
              {msg.notYetSaved}
            </h2>
            <ul className="check-list check-list--pending" aria-labelledby="resume-unsaved">
              <li>
                <LoaderIcon size={20} />
                <span>{msg.continueAtStep(pendingWork, nextNumber)}</span>
              </li>
            </ul>
          </section>
        </div>
        <div className="onboarding-actions">
          <Button variant="primary" className="btn-hero" onClick={() => onContinue(next)}>
            <ChevronRightIcon size={24} />
            {msg.continueFromStep(nextNumber)}
          </Button>
          <Button variant="outline" className="btn-wide" ref={restartButton} onClick={() => setConfirming(true)}>
            {msg.startAgain}
          </Button>
          <p className="onboarding-footnote onboarding-footnote--center">{msg.startAgainNote}</p>
        </div>
      </div>
      {confirming ? (
        <RestartConfirmationDialog
          messages={messages}
          savedSummary={savedSummary(messages, locale, persisted)}
          onKeep={() => setConfirming(false)}
          onRestart={() => {
            setConfirming(false);
            onRestart();
          }}
          returnFocusRef={restartButton}
        />
      ) : null}
    </>
  );
}
