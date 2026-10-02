"use client";

import { useState, type FormEvent } from "react";
import { type AppMessages, type SupportedLocale } from "@/i18n/types";
import { labelWithAside } from "../locale-format";
import { Banner } from "../primitives/Card";
import { Button } from "../primitives/Button";
import { ChoiceGroup } from "../primitives/ChoiceGroup";
import { InputField, SelectField, TextareaField } from "../primitives/Field";
import { SaveIcon } from "../primitives/Icons";
import { NumericKeypad } from "../primitives/NumericKeypad";
import { Notice, ScreenHeader } from "../primitives/ScreenHeader";
import { TimeCard } from "../primitives/TimeCard";
import type { JournalCommandService } from "@/application/journal/journal-contracts";
import type { Instant } from "@/domain/shared/time";
import type { DecimalString } from "@/domain/health-records/measurement";
import {
  exactSingaporeOccurrence,
  formatRelativeSingaporeTime,
  singaporeNowParts,
  singaporeWallClockToInstant,
} from "../journal/singapore-time";
import {
  GLUCOSE_CONTEXT_CHOICES,
  glucoseContextChoiceLabel,
  toGlucoseContextPayload,
  type GlucoseContextChoice,
} from "../journal/glucose-context";

type GlucoseEntryScreenProps = {
  messages: AppMessages;
  locale: SupportedLocale;
  commandService: JournalCommandService;
  goBack: () => void;
  onCommitted?: () => void | Promise<void>;
};

type MeasurementMethod = "FINGERSTICK_METER" | "CGM" | "FLASH_SENSOR" | "OTHER" | "UNKNOWN";

/** Plain positive decimal as typed, within the meter's plausible display range. */
const GLUCOSE_INPUT_PATTERN = /^\d{1,2}(\.\d{1,2})?$/;

export function GlucoseEntryScreen({
  messages,
  locale,
  commandService,
  onCommitted,
}: GlucoseEntryScreenProps) {
  const msg = messages.glucose;
  const [value, setValue] = useState("");
  const [method, setMethod] = useState<MeasurementMethod>("FINGERSTICK_METER");
  const [context, setContext] = useState<GlucoseContextChoice | null>(null);
  const [note, setNote] = useState("");
  const [occurredAt, setOccurredAt] = useState(() => {
    const now = singaporeNowParts();
    return `${now.date}T${now.time}`;
  });
  const [valueError, setValueError] = useState<string | null>(null);
  const [contextError, setContextError] = useState<string | null>(null);
  const [timeError, setTimeError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [notSaved, setNotSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const [date = "", time = ""] = occurredAt.split("T");
  const instant = singaporeWallClockToInstant(date, time);
  const whenText = instant
    ? formatRelativeSingaporeTime(locale, instant, messages.shared)
    : messages.shared.requiredField;

  // Any edit after a commit starts a new, unsaved entry.
  function edited() {
    setSaved(false);
  }

  function changeValue(next: string) {
    setValue(next);
    setValueError(null);
    edited();
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    const numeric = Number(trimmed);
    const validValue = GLUCOSE_INPUT_PATTERN.test(trimmed) && numeric > 0 && numeric <= 50;

    setValueError(validValue ? null : msg.invalidDecimal);
    setContextError(context ? null : messages.shared.requiredField);
    setTimeError(instant ? null : messages.shared.requiredField);
    if (!validValue || !context || !instant) return;

    setSaved(false);
    setNotSaved(false);
    setBusy(true);
    const result = await commandService.recordGlucose({
      payload: {
        measurement: {
          enteredValue: trimmed as DecimalString,
          enteredUnit: "MMOL_L",
          normalization: null,
        },
        measurementMethod: method,
        context: toGlucoseContextPayload(context),
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
    <div className="screen-page journal-entry-screen glucose-entry-screen">
      <ScreenHeader title={messages.today.recordReading} />

      {saved ? <Banner variant="success">{msg.saved}</Banner> : null}
      {notSaved ? <Banner variant="error">{messages.shared.notSaved}</Banner> : null}

      <form onSubmit={handleSubmit} className="entry-form" noValidate>
        <ChoiceGroup
          legend={msg.whenQuestion}
          options={GLUCOSE_CONTEXT_CHOICES.map((choice) => ({
            value: choice,
            label: glucoseContextChoiceLabel(messages, choice),
          }))}
          value={context}
          onChange={(next) => {
            setContext(next);
            setContextError(null);
            edited();
          }}
          error={contextError ?? undefined}
        />

        <InputField
          fieldClassName="field--hero"
          label={
            <>
              {msg.valueLabel}
              <span className="sr-only"> ({msg.unit})</span>
            </>
          }
          suffix={msg.unit}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={value}
          onChange={(e) => changeValue(e.target.value)}
          required
          error={valueError ?? undefined}
        />

        <TimeCard
          label={msg.occurrenceTime}
          summary={whenText}
          hint={msg.timeNowHint}
          editLabel={messages.readingTime.editTime}
          type="datetime-local"
          value={occurredAt}
          onChange={(next) => {
            setOccurredAt(next);
            setTimeError(null);
            edited();
          }}
          error={timeError ?? undefined}
        />

        <NumericKeypad
          label={msg.keypadLabel}
          deleteLabel={msg.deleteDigit}
          decimalLabel={msg.decimalPoint}
          value={value}
          onChange={changeValue}
        />

        <details className="entry-details">
          <summary>{msg.moreDetails}</summary>
          <div className="entry-details-body">
            <SelectField
              label={msg.methodLabel}
              value={method}
              onChange={(e) => {
                setMethod(e.target.value as MeasurementMethod);
                edited();
              }}
            >
              <option value="FINGERSTICK_METER">{msg.methodFingerstick}</option>
              <option value="CGM">{msg.methodCgm}</option>
              <option value="FLASH_SENSOR">{msg.methodFlash}</option>
              <option value="OTHER">{msg.methodOther}</option>
              <option value="UNKNOWN">{msg.methodUnknown}</option>
            </SelectField>
            <TextareaField
              label={labelWithAside(locale, msg.noteLabel, messages.shared.optional)}
              value={note}
              onChange={(e) => {
                setNote(e.target.value);
                edited();
              }}
              rows={2}
            />
          </div>
        </details>

        <Notice>{msg.noInterpretation}</Notice>

        <div className="save-block">
          <Button type="submit" variant="primary" className="btn-hero" busy={busy} disabled={saved}>
            <SaveIcon size={24} />
            {busy ? messages.shared.saving : msg.saveAction}
          </Button>
          {context && instant ? (
            <p className="save-footnote">
              {msg.storedAs(glucoseContextChoiceLabel(messages, context), whenText)}
            </p>
          ) : null}
        </div>
      </form>
    </div>
  );
}
