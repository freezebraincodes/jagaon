"use client";

import type { AppMessages } from "@/i18n/types";
import { Button } from "../primitives/Button";
import { BookletIcon, SunIcon } from "../primitives/Icons";

/** Frame 27. Skipping never blocks Today and implies nothing was missed. */
export function SkippedScreen({
  messages,
  onOpenToday,
  onAddMedicine,
}: {
  messages: AppMessages;
  onOpenToday: () => void;
  onAddMedicine: () => void;
}) {
  const msg = messages.onboarding;
  return (
    <div className="onboarding-page onboarding-page--spread">
      <div className="onboarding-intro">
        <span className="onboarding-icon-tile onboarding-icon-tile--large" aria-hidden="true">
          <BookletIcon size={34} />
        </span>
        <h1 className="onboarding-title">{msg.skippedTitle}</h1>
        <p className="onboarding-lead">{msg.skippedBody}</p>
      </div>
      <div className="onboarding-actions">
        <Button variant="primary" className="btn-hero" onClick={onOpenToday}>
          <SunIcon size={24} />
          {msg.openToday}
        </Button>
        <Button variant="outline" className="btn-wide" onClick={onAddMedicine}>
          {msg.addMedicineNow}
        </Button>
      </div>
    </div>
  );
}
