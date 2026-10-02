import type { AppMessages } from "@/i18n/types";
import { DEMO_ONBOARDING_STEPS, stepNumber, type DemoOnboardingStep } from "@/application/onboarding/demo-onboarding-contracts";

/** Five-step indicator; text and segments convey progress, not colour alone. */
export function OnboardingProgress({ messages, step }: { messages: AppMessages; step: DemoOnboardingStep }) {
  const current = stepNumber(step);
  const total = DEMO_ONBOARDING_STEPS.length;
  const text = messages.onboarding.stepOf(current, total);
  return (
    <div
      className="onboarding-progress"
      role="progressbar"
      aria-label={messages.onboarding.progressLabel}
      aria-valuemin={1}
      aria-valuemax={total}
      aria-valuenow={current}
      aria-valuetext={text}
    >
      <p className="onboarding-progress-text" aria-hidden="true">
        {text}
      </p>
      <ol className="onboarding-progress-segments" aria-hidden="true">
        {DEMO_ONBOARDING_STEPS.map((candidate, index) => (
          <li
            key={candidate}
            className={index < current ? "onboarding-progress-segment is-done" : "onboarding-progress-segment"}
          />
        ))}
      </ol>
    </div>
  );
}
