"use client";

import type { AppMessages } from "@/i18n/types";
import { Button } from "../primitives/Button";
import { AlertCircleIcon, DeviceIcon, ResetIcon } from "../primitives/Icons";
import { Notice } from "../primitives/ScreenHeader";

/**
 * Frame 28. Nothing is claimed as saved; the entered values stay in memory
 * for an exact retry. Returning discards only the unsaved delta.
 */
export function StorageFailureScreen({
  messages,
  onRetry,
  onReturn,
  returnLabel,
}: {
  messages: AppMessages;
  onRetry: () => void;
  onReturn: () => void;
  returnLabel?: string;
}) {
  const msg = messages.onboarding;
  return (
    <div className="onboarding-page onboarding-page--spread">
      <div className="onboarding-intro">
        <span className="onboarding-icon-tile onboarding-icon-tile--large" aria-hidden="true">
          <AlertCircleIcon size={34} />
        </span>
        <h1 className="onboarding-title">{msg.failureTitle}</h1>
        <p className="onboarding-lead">{msg.failureBody}</p>
        <p className="failure-status" role="alert">
          <AlertCircleIcon size={22} />
          {msg.failureStatus}
        </p>
      </div>
      <div className="onboarding-actions">
        <Button variant="primary" className="btn-hero" onClick={onRetry}>
          <ResetIcon size={24} />
          {msg.tryAgain}
        </Button>
        <Button variant="outline" className="btn-wide" onClick={onReturn}>
          {returnLabel ?? msg.returnWelcome}
        </Button>
        <p className="onboarding-footnote onboarding-footnote--center">{msg.returnDiscards}</p>
        <Notice icon={<DeviceIcon size={20} />}>{msg.noCloud}</Notice>
      </div>
    </div>
  );
}
