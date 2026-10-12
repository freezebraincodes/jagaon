"use client";

import { DEMO_BOUNDARY_PLACEMENT } from "@/components/demo/demo-boundary-placement";
import { useCallback, useState } from "react";
import type { AppMessages, SupportedLocale } from "@/i18n/types";
import { getMessages } from "@/i18n/get-messages";
import {
  type DemoOnboardingRoute,
  type DemoOnboardingStateV1,
  type DemoOnboardingStep,
} from "@/application/onboarding/demo-onboarding-contracts";
import type { DemoOnboardingRepository } from "@/application/onboarding/demo-onboarding-repository";
import { createPreparedOnboardingState } from "@/application/onboarding/prepared-onboarding-fixture";
import {
  addMedicine,
  emptyOnboardingState,
  medicineFromChoice,
  normalisePreferredName,
  removeMedicine,
  updateMedicineFacts,
  withStep,
} from "@/application/onboarding/demo-onboarding-edits";
import { createRecordId } from "@/domain/shared/identifiers";
import { OnboardingShell } from "./OnboardingShell";
import { WelcomeScreen } from "./WelcomeScreen";
import { ProfileStep } from "./ProfileStep";
import { MedicineListStep } from "./MedicineListStep";
import { MedicineSelectionStep } from "./MedicineSelectionStep";
import { DirectionsStep } from "./DirectionsStep";
import { ReviewStep } from "./ReviewStep";
import { CompletionScreen } from "./CompletionScreen";
import { ResumeScreen } from "./ResumeScreen";
import { SkippedScreen } from "./SkippedScreen";
import { StorageFailureScreen } from "./StorageFailureScreen";

export type OnboardingExit = {
  state: DemoOnboardingStateV1;
  destination: "TODAY" | "MY_MEDICINES" | "MY_MEDICINES_ADD";
};

type OnboardingFlowProps = {
  messages: AppMessages;
  locale: SupportedLocale;
  onLocaleChange: (locale: SupportedLocale) => void;
  repository: DemoOnboardingRepository;
  /** Last valid persisted state, if any (IN_PROGRESS opens Resume). */
  initialState: DemoOnboardingStateV1 | null;
  onExit: (exit: OnboardingExit) => void;
  now?: () => string;
  createId?: () => string;
};

const STEP_FOR_ROUTE: Partial<Record<DemoOnboardingRoute, DemoOnboardingStep>> = {
  PROFILE: "PROFILE",
  MEDICINES: "MEDICINES",
  ADD_MEDICINE: "ADD_MEDICINE",
  DIRECTIONS: "DIRECTIONS",
  REVIEW: "REVIEW",
};

const BACK_ROUTE: Partial<Record<DemoOnboardingRoute, DemoOnboardingRoute>> = {
  PROFILE: "WELCOME",
  MEDICINES: "PROFILE",
  ADD_MEDICINE: "MEDICINES",
  DIRECTIONS: "MEDICINES",
  REVIEW: "MEDICINES",
};

/**
 * First-run synthetic setup (frames 14–30). Every successful action persists
 * the complete strict state before moving on; a failed write keeps the
 * values in memory, shows frame 28 and never advances or claims success.
 */
export function OnboardingFlow({
  messages,
  locale,
  onLocaleChange,
  repository,
  initialState,
  onExit,
  now = () => new Date().toISOString(),
  createId = createRecordId,
}: OnboardingFlowProps) {
  const msg = messages.onboarding;
  const [route, setRoute] = useState<DemoOnboardingRoute>(
    initialState?.status === "IN_PROGRESS" ? "RESUME" : "WELCOME",
  );
  const [persisted, setPersisted] = useState<DemoOnboardingStateV1 | null>(initialState);
  const [draft, setDraft] = useState<DemoOnboardingStateV1>(
    () => initialState ?? emptyOnboardingState(locale, now()),
  );
  const [editingId, setEditingId] = useState<string | null>(null);
  const [retry, setRetry] = useState<(() => void) | null>(null);
  const [announcement, setAnnouncement] = useState(
    initialState?.status === "IN_PROGRESS" ? msg.resumedAnnouncement : "",
  );
  const [languageSwitched, setLanguageSwitched] = useState(false);

  const commit = useCallback(
    (next: DemoOnboardingStateV1, onSaved: (saved: DemoOnboardingStateV1) => void, savedMessage?: string) => {
      const stamped = { ...next, updatedAt: now() };
      const result = repository.save(stamped);
      if (result.ok) {
        setPersisted(result.state);
        setDraft(result.state);
        setRetry(null);
        setAnnouncement(savedMessage ?? msg.savedAnnouncement);
        onSaved(result.state);
        return;
      }
      // Keep exactly what was entered in memory for an identical retry.
      setDraft(stamped);
      setRetry(() => () => commit(stamped, onSaved, savedMessage));
      setAnnouncement(msg.failureStatus);
      setRoute("STORAGE_FAILURE");
    },
    [msg.failureStatus, msg.savedAnnouncement, now, repository],
  );

  function go(next: DemoOnboardingRoute) {
    setLanguageSwitched(false);
    setRoute(next);
  }

  function returnToWelcome() {
    // Discard only the unsaved delta; reload the last valid persisted state.
    const reloaded = repository.load() ?? persisted;
    setPersisted(reloaded);
    setDraft(reloaded ?? emptyOnboardingState(locale, now()));
    if (reloaded && reloaded.locale !== locale) onLocaleChange(reloaded.locale);
    setRetry(null);
    setEditingId(null);
    go("WELCOME");
  }

  function restart() {
    const result = repository.clear();
    if (!result.ok) {
      setRetry(() => restart);
      setAnnouncement(msg.failureStatus);
      setRoute("STORAGE_FAILURE");
      return;
    }
    setPersisted(null);
    setDraft(emptyOnboardingState(locale, now()));
    setEditingId(null);
    setRetry(null);
    go("PROFILE");
  }

  function continueFrom(step: DemoOnboardingStep) {
    if (step === "DIRECTIONS") {
      const pending = draft.medicines.findLast((medicine) => medicine.verbatimDirections === null) ?? draft.medicines.at(-1);
      if (!pending) return go("MEDICINES");
      setEditingId(pending.id);
    }
    go(step);
  }

  const editing = draft.medicines.find((medicine) => medicine.id === editingId) ?? null;
  const step = STEP_FOR_ROUTE[route] ?? null;
  const back = BACK_ROUTE[route];

  function renderRoute() {
    switch (route) {
      case "WELCOME":
        return (
          <WelcomeScreen
            messages={messages}
            locale={locale}
            onLocaleChange={(next) => {
              commit(
                { ...draft, status: "IN_PROGRESS", locale: next },
                () => {
                  onLocaleChange(next);
                  setRoute("WELCOME");
                },
              );
            }}
            onStart={() => go("PROFILE")}
            onPrepared={() =>
              commit(createPreparedOnboardingState(locale, now()), (saved) =>
                onExit({ state: saved, destination: "TODAY" }),
              )
            }
          />
        );
      case "PROFILE":
        return (
          <ProfileStep
            messages={messages}
            locale={locale}
            initialName={draft.preferredName ?? ""}
            languageSwitched={languageSwitched}
            onLocaleChange={(next, name) => {
              onLocaleChange(next);
              const nextMessages = getMessages(next).onboarding;
              const nextName = next === "zh-SG" ? getMessages(next).settings.chinese : getMessages(next).settings.english;
              commit(
                { ...draft, locale: next, status: "IN_PROGRESS", preferredName: normalisePreferredName(name) },
                () => {
                  setRoute("PROFILE");
                  setLanguageSwitched(true);
                },
                nextMessages.languageSwitched(nextName),
              );
            }}
            onContinue={(name) =>
              commit(
                withStep({ ...draft, status: "IN_PROGRESS", preferredName: normalisePreferredName(name) }, "PROFILE"),
                () => go("MEDICINES"),
              )
            }
            onSkip={(name) =>
              commit(
                { ...draft, status: "SKIPPED", preferredName: normalisePreferredName(name) },
                () => go("SKIPPED"),
              )
            }
          />
        );
      case "MEDICINES":
        return (
          <MedicineListStep
            messages={messages}
            medicines={draft.medicines}
            mode="SETUP"
            title={msg.medicinesTitle}
            onAdd={() => go("ADD_MEDICINE")}
            onEdit={(id) => {
              setEditingId(id);
              go("DIRECTIONS");
            }}
            onRemove={(id) => commit(removeMedicine(draft, id), () => setRoute("MEDICINES"))}
            onContinue={() => commit(withStep(draft, "MEDICINES"), () => go("REVIEW"))}
            onSkip={() => commit({ ...draft, status: "SKIPPED" }, () => go("SKIPPED"))}
          />
        );
      case "ADD_MEDICINE":
        return (
          <MedicineSelectionStep
            messages={messages}
            onContinue={(choice) => {
              const medicine = medicineFromChoice(choice, createId());
              commit(withStep(addMedicine(draft, medicine), "ADD_MEDICINE"), () => {
                setEditingId(medicine.id);
                go("DIRECTIONS");
              });
            }}
          />
        );
      case "DIRECTIONS":
        if (!editing) return null;
        return (
          <DirectionsStep
            key={editing.id}
            messages={messages}
            locale={locale}
            medicine={editing}
            onSave={(facts) =>
              commit(withStep(updateMedicineFacts(draft, editing.id, facts), "DIRECTIONS"), () => go("REVIEW"))
            }
          />
        );
      case "REVIEW":
        return (
          <ReviewStep
            messages={messages}
            locale={locale}
            state={draft}
            onEditProfile={() => go("PROFILE")}
            onEditMedicine={(id) => {
              setEditingId(id);
              go("DIRECTIONS");
            }}
            onFinish={() => commit(withStep({ ...draft, status: "COMPLETED" }, "REVIEW"), () => go("COMPLETE"))}
            onBack={() => go("MEDICINES")}
          />
        );
      case "COMPLETE":
        return (
          <CompletionScreen
            messages={messages}
            locale={locale}
            state={draft}
            onOpenToday={() => onExit({ state: draft, destination: "TODAY" })}
            onReviewMedicines={() => onExit({ state: draft, destination: "MY_MEDICINES" })}
          />
        );
      case "RESUME":
        return persisted ? (
          <ResumeScreen
            messages={messages}
            locale={locale}
            persisted={persisted}
            onContinue={continueFrom}
            onRestart={restart}
          />
        ) : null;
      case "SKIPPED":
        return (
          <SkippedScreen
            messages={messages}
            onOpenToday={() => onExit({ state: draft, destination: "TODAY" })}
            onAddMedicine={() => onExit({ state: draft, destination: "MY_MEDICINES_ADD" })}
          />
        );
      case "STORAGE_FAILURE":
        return (
          <StorageFailureScreen
            messages={messages}
            onRetry={() => retry?.()}
            onReturn={returnToWelcome}
          />
        );
    }
  }

  return (
    <OnboardingShell
      messages={messages}
      viewKey={`${route}:${editingId ?? ""}`}
      showBoundary={DEMO_BOUNDARY_PLACEMENT === "EVERY_SCREEN" || (DEMO_BOUNDARY_PLACEMENT === "WELCOME" && route === "WELCOME")}
      step={step}
      onBack={back ? () => go(back) : undefined}
      announcement={announcement}
    >
      {renderRoute()}
    </OnboardingShell>
  );
}
