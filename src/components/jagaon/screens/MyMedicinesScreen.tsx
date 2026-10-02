"use client";

import { useState } from "react";
import type { AppMessages, SupportedLocale } from "@/i18n/types";
import type { DemoOnboardingStateV1 } from "@/application/onboarding/demo-onboarding-contracts";
import type { DemoOnboardingSaveResult } from "@/application/onboarding/demo-onboarding-repository";
import {
  addMedicine,
  medicineFromChoice,
  removeMedicine,
  updateMedicineFacts,
} from "@/application/onboarding/demo-onboarding-edits";
import { createRecordId } from "@/domain/shared/identifiers";
import type { ScreenId } from "../screen-manifest";
import { BookIcon, ChevronRightIcon } from "../primitives/Icons";
import { MedicineListStep } from "../onboarding/MedicineListStep";
import { MedicineSelectionStep } from "../onboarding/MedicineSelectionStep";
import { DirectionsStep } from "../onboarding/DirectionsStep";
import { StorageFailureScreen } from "../onboarding/StorageFailureScreen";

export type MyMedicinesView = "list" | "add" | "directions";

type MyMedicinesScreenProps = {
  messages: AppMessages;
  locale: SupportedLocale;
  state: DemoOnboardingStateV1;
  view: MyMedicinesView;
  medicineId?: string;
  /** Persists the complete onboarding state; nothing changes on failure. */
  save: (next: DemoOnboardingStateV1) => DemoOnboardingSaveResult;
  navigate: (screen: ScreenId, params?: Record<string, string>) => void;
  /** Replaces the current My medicines view (keeps Back meaningful). */
  showView: (view: MyMedicinesView, medicineId?: string) => void;
  createId?: () => string;
};

/**
 * Post-setup My medicines management. Reuses the setup list, selection and
 * directions components without the five-step progress indicator.
 */
export function MyMedicinesScreen({
  messages,
  locale,
  state,
  view,
  medicineId,
  save,
  navigate,
  showView,
  createId = createRecordId,
}: MyMedicinesScreenProps) {
  const [retry, setRetry] = useState<(() => void) | null>(null);

  function commit(next: DemoOnboardingStateV1, onSaved: () => void) {
    const result = save(next);
    if (result.ok) {
      setRetry(null);
      onSaved();
      return;
    }
    // Values stay in memory for an identical retry; nothing is claimed saved.
    setRetry(() => () => commit(next, onSaved));
  }

  if (retry) {
    return (
      <StorageFailureScreen
        messages={messages}
        onRetry={retry}
        onReturn={() => {
          setRetry(null);
          showView("list");
        }}
        returnLabel={messages.shared.back}
      />
    );
  }

  // Adding after an explicit skip turns the setup into a completed one.
  const activeState: DemoOnboardingStateV1 =
    state.status === "SKIPPED" ? { ...state, status: "COMPLETED", lastCompletedStep: "REVIEW" } : state;

  if (view === "add") {
    return (
      <MedicineSelectionStep
        messages={messages}
        onContinue={(choice) => {
          const medicine = medicineFromChoice(choice, createId());
          commit(addMedicine(activeState, medicine), () => showView("directions", medicine.id));
        }}
      />
    );
  }

  const editing = state.medicines.find((medicine) => medicine.id === medicineId);
  if (view === "directions" && editing) {
    return (
      <DirectionsStep
        key={editing.id}
        messages={messages}
        locale={locale}
        medicine={editing}
        onSave={(facts) => commit(updateMedicineFacts(state, editing.id, facts), () => showView("list"))}
      />
    );
  }

  return (
    <div className="my-medicines">
      <MedicineListStep
        messages={messages}
        medicines={state.status === "SKIPPED" ? [] : state.medicines}
        mode="MANAGE"
        title={messages.medication.screenTitle}
        onAdd={() => showView("add")}
        onEdit={(id) => showView("directions", id)}
        onRemove={(id) => commit(removeMedicine(state, id), () => undefined)}
      />
      {state.medicines.length > 0 && state.status !== "SKIPPED" ? (
        <button type="button" className="more-row" onClick={() => navigate("MEDICATION_INFORMATION")}>
          <BookIcon size={28} className="icon more-row-icon" />
          <span className="more-row-label">{messages.onboarding.medicineInformationLink}</span>
          <ChevronRightIcon size={22} className="icon more-row-chevron" />
        </button>
      ) : null}
    </div>
  );
}
