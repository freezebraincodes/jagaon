"use client";

import { useId, useMemo, useState, type FormEvent } from "react";
import type { AppMessages, SupportedLocale } from "@/i18n/types";
import {
  DEMO_MEDICINE_SOURCES,
  DEMO_TEXT_LIMITS,
  type DemoMedicineSource,
  type DemoOnboardingMedicine,
} from "@/application/onboarding/demo-onboarding-contracts";
import type { RecordedFacts } from "@/application/onboarding/demo-onboarding-edits";
import { createMedicationInformationAdapter } from "@/application/governed/medication-information-adapter";
import { labelAndValue, labelWithAside } from "../locale-format";
import { Button } from "../primitives/Button";
import { ChoiceGroup } from "../primitives/ChoiceGroup";
import { BookIcon, ExternalIcon, InfoIcon, QuestionIcon, SaveIcon, ShieldIcon } from "../primitives/Icons";
import { MedicineGeneralInfoPreview } from "../medicine-info/MedicineGeneralInfoPreview";
import { sourceLabel } from "./medicine-labels";

type FactKey = Exclude<keyof RecordedFacts, "source">;

type FieldState = { value: string; unknown: boolean };

type DirectionsStepProps = {
  messages: AppMessages;
  locale: SupportedLocale;
  medicine: DemoOnboardingMedicine;
  onSave: (facts: RecordedFacts) => void;
};

/**
 * Frames 18 and 24. Section A records exactly what the person types; any
 * field can be left unknown. Section B is reviewed general information from
 * the governed adapter, or the unavailable state — it never fills Section A.
 */
export function DirectionsStep({ messages, locale, medicine, onSave }: DirectionsStepProps) {
  const msg = messages.onboarding;
  const id = useId();
  const fieldLabels: Record<FactKey, string> = {
    form: messages.medication.fieldForm,
    strength: msg.fieldStrength,
    amountAndUnit: msg.fieldAmount,
    scheduleOrTiming: msg.fieldSchedule,
    effectiveDate: messages.medication.fieldEffective,
    verbatimDirections: msg.fieldDirections,
  };
  const factKeys = Object.keys(fieldLabels) as FactKey[];
  const [fields, setFields] = useState<Record<FactKey, FieldState>>(() =>
    Object.fromEntries(
      factKeys.map((key) => [key, { value: medicine[key] ?? "", unknown: false }]),
    ) as Record<FactKey, FieldState>,
  );
  const [source, setSource] = useState<DemoMedicineSource>(medicine.source);
  const anyUnknown = factKeys.some((key) => fields[key].unknown);

  const adapter = useMemo(() => createMedicationInformationAdapter(), []);
  const reviewed = medicine.reviewedContentKey
    ? adapter.getGeneralInfo(medicine.reviewedContentKey, messages, locale)
    : null;
  const hasReviewed = Boolean(reviewed?.available);

  function update(key: FactKey, patch: Partial<FieldState>) {
    setFields((current) => ({ ...current, [key]: { ...current[key], ...patch } }));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const facts = Object.fromEntries(
      factKeys.map((key) => {
        const field = fields[key];
        // Unknown or blank stays null; typed text is kept exactly.
        return [key, field.unknown || field.value.trim() === "" ? null : field.value];
      }),
    ) as Omit<RecordedFacts, "source">;
    onSave({ ...facts, source });
  }

  return (
    <form className="onboarding-page" onSubmit={submit} noValidate>
      <h1 className="onboarding-title">{msg.directionsTitle}</h1>

      <section className="onboarding-card record-section" aria-labelledby={`${id}-recorded`}>
        <p className="tag tag--action">{msg.yourRecordTag}</p>
        <h2 className="record-section-title" id={`${id}-recorded`}>
          {msg.recordedPrescriptionTitle}
        </h2>
        <p className="onboarding-footnote">{msg.allOptional}</p>
        {anyUnknown ? (
          <p className="notice notice--compact">
            <QuestionIcon size={20} />
            <span>{msg.unknownLegend}</span>
          </p>
        ) : null}

        <div className="field">
          <span className="field-label" id={`${id}-medicine-label`}>
            {messages.insulin.medicineLabel}
          </span>
          <ReadOnlyValue id={`${id}-medicine`} labelId={`${id}-medicine-label`} className="input--readonly">
            {medicine.enteredName}
          </ReadOnlyValue>
        </div>

        {factKeys.map((key) => {
          const field = fields[key];
          const inputId = `${id}-${key}`;
          const label = labelWithAside(locale, fieldLabels[key], messages.shared.optional);
          return (
            <div className="field fact-field" key={key}>
              <label className="field-label" htmlFor={inputId} id={`${inputId}-label`}>
                {label}
              </label>
              {field.unknown ? (
                <ReadOnlyValue id={inputId} labelId={`${inputId}-label`} className="input--unknown">
                  {msg.iDontKnow}
                </ReadOnlyValue>
              ) : key === "verbatimDirections" ? (
                <textarea
                  id={inputId}
                  className="input"
                  rows={3}
                  value={field.value}
                  maxLength={DEMO_TEXT_LIMITS.directions}
                  placeholder={msg.directionsPlaceholder}
                  onChange={(e) => update(key, { value: e.target.value })}
                />
              ) : (
                <input
                  id={inputId}
                  className="input"
                  value={field.value}
                  maxLength={DEMO_TEXT_LIMITS.shortFact}
                  autoComplete="off"
                  onChange={(e) => update(key, { value: e.target.value })}
                />
              )}
              <button
                type="button"
                className="text-link text-link--quiet fact-unknown-toggle"
                aria-pressed={field.unknown}
                aria-label={msg.iDontKnowNamed(fieldLabels[key])}
                onClick={() => update(key, { unknown: !field.unknown })}
              >
                <QuestionIcon size={18} />
                {msg.iDontKnow}
              </button>
            </div>
          );
        })}

        <ChoiceGroup<DemoMedicineSource>
          legend={msg.sourceLabel}
          variant="card"
          options={DEMO_MEDICINE_SOURCES.map((value) => ({ value, label: sourceLabel(messages, value) }))}
          value={source}
          onChange={setSource}
        />
      </section>

      <section className="onboarding-card about-section" aria-labelledby={`${id}-about`}>
        <p className="tag tag--reviewed">
          <BookIcon size={16} />
          {messages.medication.generalHeading}
        </p>
        <h2 className="record-section-title" id={`${id}-about`}>
          {messages.medication.aboutThisMedicine}
        </h2>
        <p className="notice notice--compact notice--reviewed">
          <InfoIcon size={18} />
          <span>{messages.medication.notPersonalised}</span>
        </p>
        {hasReviewed && reviewed ? (
          <>
            <p className="about-generic">{medicine.genericName}</p>
            <div className="about-fact">
              <p className="about-fact-label">{msg.purposeLabel}</p>
              <p>{reviewed.purpose}</p>
            </div>
            <div className="about-fact">
              <p className="about-fact-label">{msg.useLabel}</p>
              <p>{reviewed.use}</p>
            </div>
            <p className="source-attr">
              <a href={reviewed.sourceUrl} target="_blank" rel="noreferrer noopener">
                {labelAndValue(locale, messages.shared.source, reviewed.sourceName)}
                <ExternalIcon size={14} />
              </a>
              {" · "}
              {reviewed.reviewedOnLabel}
            </p>
          </>
        ) : (
          <>
            <p className="about-unavailable">{msg.reviewedUnavailableBody}</p>
            {/* HSA preview (owner decision 2026-10-14): only when HSA-bounded mode is off; renders nothing otherwise. */}
            <MedicineGeneralInfoPreview messages={messages} locale={locale} name={medicine.displayName} headingLevel={3} />
          </>
        )}
        <p className="provenance-line about-boundary">
          <ShieldIcon size={16} />
          {msg.neverRewrites}
        </p>
      </section>

      <Button type="submit" variant="primary" className="btn-hero">
        <SaveIcon size={24} />
        {msg.saveRecorded}
      </Button>
    </form>
  );
}

/** A read-only field value that wraps under enlarged text, unlike a single-line input. */
function ReadOnlyValue({ id, labelId, className, children }: { id: string; labelId: string; className: string; children: string }) {
  return (
    <p id={id} className={`input input--wrap ${className}`} role="textbox" aria-readonly="true" aria-labelledby={labelId} tabIndex={0}>
      {children}
    </p>
  );
}
