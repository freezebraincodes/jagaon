"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import type { AppMessages } from "@/i18n/types";
import {
  searchDemoMedicineCatalogue,
  type DemoCatalogueKey,
} from "@/application/onboarding/demo-medicine-catalogue";
import { DEMO_TEXT_LIMITS } from "@/application/onboarding/demo-onboarding-contracts";
import type { MedicineChoice } from "@/application/onboarding/demo-onboarding-edits";
import { Button } from "../primitives/Button";
import { InputField } from "../primitives/Field";
import {
  BookIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleIcon,
  InfoIcon,
  PencilIcon,
  PillIcon,
  QuoteIcon,
  SearchIcon,
} from "../primitives/Icons";
import { catalogueFormLabel } from "./medicine-labels";

type MedicineSelectionStepProps = {
  messages: AppMessages;
  onContinue: (choice: MedicineChoice) => void;
};

/**
 * Frames 17, 22 and 23. The list is a local filter over the fictional demo
 * catalogue — never a live lookup — and a typed name is kept exactly.
 */
export function MedicineSelectionStep({ messages, onContinue }: MedicineSelectionStepProps) {
  const msg = messages.onboarding;
  const name = useId();
  const [query, setQuery] = useState("");
  const [choice, setChoice] = useState<DemoCatalogueKey | "NOT_LISTED" | null>(null);
  const [error, setError] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const entries = searchDemoMedicineCatalogue(query);
  const typed = query.trim();

  function submit(event: FormEvent) {
    event.preventDefault();
    if (choice && choice !== "NOT_LISTED") {
      onContinue({ kind: "CATALOGUE", key: choice });
      return;
    }
    if (typed.length > 0) {
      onContinue({ kind: "FREE_TEXT", name: typed });
      return;
    }
    setError(true);
    inputRef.current?.focus();
  }

  return (
    <form className="onboarding-page" onSubmit={submit} noValidate>
      <h1 className="onboarding-title">{msg.selectTitle}</h1>
      <InputField
        ref={inputRef}
        fieldClassName="field--search"
        label={msg.medicineNameLabel}
        icon={<SearchIcon />}
        placeholder={msg.searchPlaceholder}
        value={query}
        maxLength={DEMO_TEXT_LIMITS.name}
        autoComplete="off"
        onChange={(e) => {
          setQuery(e.target.value);
          setChoice(null);
          setError(false);
        }}
        error={error ? msg.nameRequired : undefined}
      />
      {choice === "NOT_LISTED" && typed ? (
        <p className="recorded-exactly">
          <QuoteIcon size={20} />
          <span>{msg.recordedExactly}</span>
          <strong>{typed}</strong>
        </p>
      ) : null}

      <fieldset className="catalogue-group">
        <legend className="eyebrow">{msg.catalogueHeading}</legend>
        <div className="catalogue-options">
          {entries.map((entry) => (
            <label key={entry.key} className="catalogue-card">
              <input
                type="radio"
                className="choice-input"
                name={name}
                checked={choice === entry.key}
                onChange={() => {
                  setChoice(entry.key);
                  setError(false);
                }}
              />
              <span className="catalogue-card-face">
                <span className="onboarding-icon-tile" aria-hidden="true">
                  <PillIcon size={26} />
                </span>
                <span className="catalogue-card-text">
                  <span className="catalogue-card-name">{entry.displayName}</span>
                  <span className="catalogue-card-subtitle">
                    {entry.genericName ? msg.brandWithGeneric(entry.genericName) : msg.genericNoBrand}
                  </span>
                  <span className="catalogue-card-tags">
                    <span className="tag tag--recorded">{catalogueFormLabel(messages, entry.form)}</span>
                    {entry.reviewedContentKey ? (
                      <span className="tag tag--reviewed">
                        <BookIcon size={16} />
                        {msg.reviewedAvailable}
                      </span>
                    ) : (
                      <span className="tag tag--recorded">
                        <CircleIcon size={16} />
                        {msg.reviewedUnavailableTag}
                      </span>
                    )}
                  </span>
                </span>
                <CheckIcon size={26} className="icon catalogue-card-check" />
              </span>
            </label>
          ))}
          <label className="catalogue-card catalogue-card--free">
            <input
              type="radio"
              className="choice-input"
              name={name}
              checked={choice === "NOT_LISTED"}
              onChange={() => {
                setChoice("NOT_LISTED");
                setError(false);
                if (!typed) inputRef.current?.focus();
              }}
            />
            <span className="catalogue-card-face">
              <span className="onboarding-icon-tile" aria-hidden="true">
                <PencilIcon size={26} />
              </span>
              <span className="catalogue-card-text">
                <span className="catalogue-card-name">{msg.notListedTitle}</span>
                <span className="catalogue-card-subtitle">{msg.notListedBody}</span>
              </span>
              <CheckIcon size={26} className="icon catalogue-card-check" />
            </span>
          </label>
        </div>
      </fieldset>

      {choice === "NOT_LISTED" ? (
        <div className="reviewed-unavailable-note">
          <InfoIcon size={22} />
          <p>{msg.noReviewedForEntered}</p>
        </div>
      ) : null}

      <p className="onboarding-footnote">{msg.catalogueDisclaimer}</p>
      <Button type="submit" variant="primary" className="btn-hero">
        <ChevronRightIcon size={24} />
        {messages.shared.continue}
      </Button>
    </form>
  );
}
