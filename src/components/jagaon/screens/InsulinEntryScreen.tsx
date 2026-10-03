"use client";

import { useState, type FormEvent } from "react";
import { type AppMessages, type SupportedLocale } from "@/i18n/types";
import {
  isDemoInsulinPrescription,
  type DemoPatientProfile,
} from "@/application/governed/demo-scenario-fixture";
import { labelAndValue, labelWithAside } from "../locale-format";
import { sourceLabel } from "../onboarding/medicine-labels";
import { Banner } from "../primitives/Card";
import { Button } from "../primitives/Button";
import { ChoiceGroup } from "../primitives/ChoiceGroup";
import { InputField, TextareaField } from "../primitives/Field";
import { ChevronRightIcon, DocumentIcon, HistoryIcon, PencilIcon, SaveIcon } from "../primitives/Icons";
import { Notice, ScreenHeader } from "../primitives/ScreenHeader";
import { TimeCard } from "../primitives/TimeCard";
import type { JournalCommandService } from "@/application/journal/journal-contracts";
import type { Instant } from "@/domain/shared/time";
import type { DecimalString } from "@/domain/health-records/measurement";
import {
  exactSingaporeOccurrence,
  formatSingaporeTime,
  singaporeNowParts,
  singaporeWallClockToInstant,
} from "../journal/singapore-time";

type InsulinEntryScreenProps = {
  messages: AppMessages;
  locale: SupportedLocale;
  fixture: DemoPatientProfile;
  commandService: JournalCommandService;
  goBack: () => void;
  onCommitted?: () => void | Promise<void>;
};

/** Units actually taken, as typed: a plain positive decimal. */
const UNITS_INPUT_PATTERN = /^\d{1,3}(\.\d{1,2})?$/;

/**
 * −/+ only move the person's own typed number by one unit; they never
 * start from, suggest or compare with a recorded or calculated dose.
 */
function stepUnits(current: string, delta: 1 | -1): string {
  const value = Number(current);
  const base = current.trim() === "" || Number.isNaN(value) ? 0 : value;
  const next = Math.round((base + delta) * 100) / 100;
  return next <= 0 ? "" : String(Math.min(next, 100));
}

export function InsulinEntryScreen({
  messages,
  locale,
  fixture,
  commandService,
  onCommitted,
}: InsulinEntryScreenProps) {
  const msg = messages.insulin;
  const prescriptions = fixture.recordedPrescriptions.filter(isDemoInsulinPrescription);
  const [medicineId, setMedicineId] = useState(prescriptions[0]?.medicationRecordId ?? "");
  const [amount, setAmount] = useState("");
  const [initialTime] = useState(() => singaporeNowParts().time);
  const [time, setTime] = useState(initialTime);
  const [note, setNote] = useState("");
  const [amountError, setAmountError] = useState<string | null>(null);
  const [timeError, setTimeError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [notSaved, setNotSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const selectedPrescription = prescriptions.find((p) => p.medicationRecordId === medicineId);
  const unknown = messages.onboarding.unknownValue;
  const hasPositiveAmount = Number(amount.trim()) > 0;
  const instant = singaporeWallClockToInstant(singaporeNowParts().date, time);
  const timeText = instant
    ? (time === initialTime ? messages.shared.nowAt : messages.shared.todayAt)(
        formatSingaporeTime(locale, instant),
      )
    : messages.shared.requiredField;

  function changeAmount(next: string) {
    setAmount(next);
    setAmountError(null);
    setSaved(false);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = amount.trim();
    const numeric = Number(trimmed);
    const validAmount = UNITS_INPUT_PATTERN.test(trimmed) && numeric > 0 && numeric <= 100;
    setAmountError(validAmount ? null : messages.shared.invalidValue);
    setTimeError(instant ? null : messages.shared.requiredField);
    if (!validAmount || !instant) return;

    setSaved(false);
    setNotSaved(false);
    if (!selectedPrescription) {
      setNotSaved(true);
      return;
    }
    setBusy(true);
    const result = await commandService.recordInsulin({
      payload: {
        state: "TAKEN",
        medication: {
          recordType: "MEDICATION",
          recordId: selectedPrescription.medicationRecordId,
          revisionId: selectedPrescription.medicationRevisionId,
        },
        amountTaken: {
          kind: "KNOWN",
          amount: { value: trimmed as DecimalString, unit: "UNIT" },
        },
        ...(note.trim() ? { patientNote: { text: note.trim(), language: locale } } : {}),
      },
      temporal: exactSingaporeOccurrence(instant),
      recordedAt: new Date().toISOString() as Instant,
    });
    setBusy(false);
    if (result.kind === "COMMITTED") {
      setSaved(true);
      await onCommitted?.();
      return;
    }
    setNotSaved(true);
  }

  return (
    <div className="screen-page journal-entry-screen insulin-entry-screen">
      <ScreenHeader title={msg.title} subtitle={msg.subtitle} />

      {saved ? <Banner variant="success">{msg.saved}</Banner> : null}
      {notSaved ? <Banner variant="error">{messages.shared.notSaved}</Banner> : null}

      <form onSubmit={handleSubmit} className="entry-form" noValidate>
        <ChoiceGroup
          legend={msg.medicineLabel}
          legendHidden
          variant="card"
          options={prescriptions.map((p) => ({
            value: p.medicationRecordId,
            label: p.displayName,
            detail: p.genericName ?? undefined,
          }))}
          value={medicineId}
          onChange={(next) => {
            setMedicineId(next);
            setSaved(false);
          }}
        />

        {selectedPrescription ? (
          <section className="recorded-direction" aria-labelledby="insulin-scheduled-info">
            <h2 id="insulin-scheduled-info" className="eyebrow">
              <DocumentIcon size={18} />
              {msg.scheduledInfo}
            </h2>
            <p className="recorded-schedule">
              {labelAndValue(
                locale,
                msg.prescriptionSchedule,
                `${selectedPrescription.amountText ?? unknown}, ${selectedPrescription.timingText ?? unknown}`,
              )}
            </p>
            <p className="provenance-line">{sourceLabel(messages, selectedPrescription.source)}</p>
            <div className="recorded-direction-block">
              <p className="eyebrow eyebrow--small">{msg.recordedDirection}</p>
              <p className="recorded-direction-text">{selectedPrescription.recordedDirection ?? unknown}</p>
              <p className="provenance-line">{messages.medication.recordedVerbatim}</p>
            </div>
          </section>
        ) : null}

        <div className="recording-card">
          <p className="eyebrow">
            <PencilIcon size={18} />
            {msg.whatRecording}
          </p>
          <div className="units-stepper">
            <button
              type="button"
              className="stepper-button"
              aria-label={msg.decreaseUnits}
              onClick={() => changeAmount(stepUnits(amount, -1))}
              disabled={!hasPositiveAmount}
            >
              <span aria-hidden="true">−</span>
            </button>
            <InputField
              fieldClassName="field--hero field--stepper"
              label={
                <>
                  {msg.amountLabel}
                  <span className="sr-only"> ({msg.unit})</span>
                </>
              }
              suffix={msg.unit}
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={amount}
              onChange={(e) => changeAmount(e.target.value)}
              hint={amount.trim() === "" ? msg.notEnteredYet : undefined}
              required
              error={amountError ?? undefined}
            />
            <button
              type="button"
              className="stepper-button"
              aria-label={msg.increaseUnits}
              onClick={() => changeAmount(stepUnits(amount, 1))}
            >
              <span aria-hidden="true">+</span>
            </button>
          </div>
          <TimeCard
            label={msg.timeLabel}
            summary={timeText}
            editLabel={messages.readingTime.editTime}
            editorMessages={messages.readingTime}
            type="time"
            value={time}
            onChange={(next) => {
              setTime(next);
              setTimeError(null);
              setSaved(false);
            }}
            error={timeError ?? undefined}
          />
        </div>

        <div
          className="more-row more-row--future"
          role="group"
          aria-labelledby="insulin-history-title"
          aria-disabled="true"
        >
          <HistoryIcon size={28} className="icon more-row-icon" />
          <span className="more-row-text">
            <span className="more-row-label" id="insulin-history-title">
              {msg.correctionHistory}
            </span>
            <span className="more-row-body">{msg.correctionHistoryBody}</span>
            <span className="more-row-body">{messages.today.futureFeature}</span>
          </span>
          <ChevronRightIcon size={22} className="icon more-row-chevron" />
        </div>

        <TextareaField
          label={labelWithAside(locale, msg.noteLabel, messages.shared.optional)}
          value={note}
          onChange={(e) => {
            setNote(e.target.value);
            setSaved(false);
          }}
          rows={2}
        />

        <Notice>{msg.recordOnly}</Notice>

        <div className="save-block">
          <Button
            type="submit"
            variant="primary"
            className="btn-hero"
            busy={busy}
            disabled={saved || !hasPositiveAmount}
          >
            <SaveIcon size={24} />
            {busy ? messages.shared.saving : msg.saveAction}
          </Button>
          {!hasPositiveAmount ? <p className="save-footnote">{msg.enterUnitsToSave}</p> : null}
        </div>
      </form>
    </div>
  );
}
