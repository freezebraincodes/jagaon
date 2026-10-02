"use client";

import { useRef, useState } from "react";
import type { AppMessages } from "@/i18n/types";
import type { DemoOnboardingMedicine } from "@/application/onboarding/demo-onboarding-contracts";
import { AlertDialog } from "../primitives/AlertDialog";
import { Button } from "../primitives/Button";
import {
  ChevronRightIcon,
  ClockIcon,
  DocumentIcon,
  PencilIcon,
  PillIcon,
  PlusIcon,
  ShieldIcon,
  TrashIcon,
} from "../primitives/Icons";
import { medicineSubtitle, sourceLabel } from "./medicine-labels";

type MedicineListStepProps = {
  messages: AppMessages;
  medicines: readonly DemoOnboardingMedicine[];
  /** Setup shows Continue/Skip; management (My medicines) does not. */
  mode: "SETUP" | "MANAGE";
  title: string;
  onAdd: () => void;
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
  onContinue?: () => void;
  onSkip?: () => void;
};

/** Frames 16, 21 and 25; also the post-setup My medicines list. */
export function MedicineListStep({
  messages,
  medicines,
  mode,
  title,
  onAdd,
  onEdit,
  onRemove,
  onContinue,
  onSkip,
}: MedicineListStepProps) {
  const msg = messages.onboarding;
  const [removing, setRemoving] = useState<DemoOnboardingMedicine | null>(null);
  const removeButtons = useRef(new Map<string, HTMLButtonElement>());
  const returnFocus = useRef<HTMLElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  return (
    <>
      <div className="onboarding-page" inert={removing ? true : undefined}>
        <h1 className="onboarding-title" ref={headingRef} tabIndex={-1}>
          {title}
        </h1>
        <p className="onboarding-lead onboarding-lead--muted">{msg.medicinesIntro}</p>

        {medicines.length === 0 ? (
          <>
            <div className="onboarding-empty">
              <span className="onboarding-icon-tile" aria-hidden="true">
                <PillIcon size={32} />
              </span>
              <h2 className="onboarding-empty-title">{msg.emptyTitle}</h2>
              <p>{msg.emptyBody}</p>
            </div>
            <div className="onboarding-actions">
              <Button variant="primary" className="btn-hero" onClick={onAdd}>
                <PlusIcon size={24} />
                {msg.addMedicine}
              </Button>
              {mode === "SETUP" && onSkip ? (
                <>
                  <Button variant="outline" className="btn-wide" onClick={onSkip}>
                    <ClockIcon size={22} />
                    {msg.skipMedicines}
                  </Button>
                  <p className="onboarding-footnote">{msg.skipMedicinesNote}</p>
                </>
              ) : null}
            </div>
          </>
        ) : (
          <>
            <ul className="medicine-cards">
              {medicines.map((medicine) => (
                <li key={medicine.id} className={removing?.id === medicine.id ? "medicine-card is-dimmed" : "medicine-card"}>
                  <div className="medicine-card-head">
                    <span className="onboarding-icon-tile" aria-hidden="true">
                      <PillIcon size={26} />
                    </span>
                    <div className="medicine-card-names">
                      <h2 className="medicine-card-name">{medicine.displayName}</h2>
                      {medicineSubtitle(messages, medicine) ? (
                        <p className="medicine-card-subtitle">{medicineSubtitle(messages, medicine)}</p>
                      ) : null}
                    </div>
                  </div>
                  <p className="medicine-card-directions">
                    <span className="medicine-card-label">{msg.recordedDirectionsLabel}{msg.labelSeparator}</span>
                    {medicine.verbatimDirections ?? msg.unknownValue}
                  </p>
                  <p className="provenance-line medicine-card-source">
                    <DocumentIcon size={18} />
                    {sourceLabel(messages, medicine.source)}
                  </p>
                  <div className="medicine-card-actions">
                    <Button variant="outline" aria-label={msg.editNamed(medicine.displayName)} onClick={() => onEdit(medicine.id)}>
                      <PencilIcon size={20} />
                      {messages.shared.edit}
                    </Button>
                    <Button
                      variant="outline"
                      ref={(element: HTMLButtonElement | null) => {
                        if (element) removeButtons.current.set(medicine.id, element);
                        else removeButtons.current.delete(medicine.id);
                      }}
                      aria-label={msg.removeNamed(medicine.displayName)}
                      onClick={() => {
                        returnFocus.current = removeButtons.current.get(medicine.id) ?? null;
                        setRemoving(medicine);
                      }}
                    >
                      <TrashIcon size={20} />
                      {msg.remove}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
            <Button variant="outline" className="btn-wide" onClick={onAdd}>
              <PlusIcon size={22} />
              {msg.addAnother}
            </Button>
            {mode === "SETUP" && onContinue ? (
              <Button variant="primary" className="btn-hero" onClick={onContinue}>
                <ChevronRightIcon size={24} />
                {messages.shared.continue}
              </Button>
            ) : null}
          </>
        )}
      </div>

      {removing ? (
        <AlertDialog
          title={msg.removeTitle}
          icon={<TrashIcon size={28} />}
          cancelLabel={msg.keepIt}
          cancelIcon={<ShieldIcon size={22} />}
          onCancel={() => setRemoving(null)}
          confirmLabel={msg.removeMedicine}
          confirmIcon={<TrashIcon size={22} />}
          onConfirm={() => {
            const id = removing.id;
            returnFocus.current = headingRef.current;
            setRemoving(null);
            onRemove(id);
          }}
          returnFocusRef={returnFocus}
        >
          <p>{msg.removeBody(removing.displayName)}</p>
        </AlertDialog>
      ) : null}
    </>
  );
}
