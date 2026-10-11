"use client";

import { useEffect, useRef, useState, type FocusEvent, type FormEvent } from "react";
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
  formatMmolEntry,
  isMmolEntryTyping,
  mmolEntryNeedsConfirmation,
  MMOL_ENTRY_MAX_LENGTH,
} from "@/domain/voice/glucose-entry-format";
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

/**
 * CR-11 (owner decisions 2026-10-11, design v3.1): no hidden maximum. The value uses the shared new-entry format (1–4 integer digits,
 * at most one decimal digit; typing, the keypad and paste all go through the same validator, and anything else is refused with a
 * message, never trimmed or rounded). On completion (Save, or leaving the field) it is formatted to one decimal ("9" → "9.0"), which
 * is also the stored `enteredValue`. A value above 50 mmol/L, or zero, opens the confirmation step (the approved sentences 1–2;
 * Save as shown / Edit reading / Cancel); once opened it is a latch: every later Save of this entry goes through it until the entry
 * is saved. Cancel and Edit write nothing. No clinical warning, threshold or "verified" wording.
 */

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
  /** What the person typed before completion formatting ("9" while the field shows "9.0"), or null. */
  const [typedValue, setTypedValue] = useState<string | null>(null);
  const [latched, setLatched] = useState(false);
  const [confirmValue, setConfirmValue] = useState<string | null>(null);
  const valueInput = useRef<HTMLInputElement>(null);
  const keypadArea = useRef<HTMLDivElement>(null);
  const confirmHeading = useRef<HTMLHeadingElement>(null);
  const inFlight = useRef(false);
  useEffect(() => {
    if (confirmValue !== null) confirmHeading.current?.focus();
  }, [confirmValue]);

  const [date = "", time = ""] = occurredAt.split("T");
  const instant = singaporeWallClockToInstant(date, time);
  const whenText = instant
    ? formatRelativeSingaporeTime(locale, instant, messages.shared)
    : messages.shared.requiredField;

  // Any edit after a commit starts a new, unsaved entry (and a new confirmation latch); any edit closes an open confirmation step.
  function edited() {
    if (saved) setLatched(false);
    setSaved(false);
    setConfirmValue(null);
  }

  /** Typing and paste: the whole new text is accepted or refused (with a message); it is never trimmed. */
  function changeValue(next: string) {
    if (!isMmolEntryTyping(next)) {
      setValueError(msg.formatRefused);
      return;
    }
    setTypedValue(null);
    setValue(next);
    setValueError(null);
    edited();
  }

  /** Completion formatting when leaving the field (not for a keypad tap, which keeps editing). */
  function completeValue(event: FocusEvent<HTMLInputElement>) {
    if (event.relatedTarget instanceof Node && keypadArea.current?.contains(event.relatedTarget)) return;
    const formatted = formatMmolEntry(value);
    if (formatted !== null && formatted !== value) {
      setTypedValue(value);
      setValue(formatted);
    }
  }

  /** Returning to the field restores what was typed, so the added ".0" never gets in the way. */
  function resumeValue() {
    if (typedValue !== null && formatMmolEntry(typedValue) === value) setValue(typedValue);
    setTypedValue(null);
  }

  async function commit(enteredValue: string) {
    if (inFlight.current || !context || !instant) return;
    inFlight.current = true;
    setSaved(false);
    setNotSaved(false);
    setBusy(true);
    try {
      const result = await commandService.recordGlucose({
        payload: {
          measurement: {
            enteredValue: enteredValue as DecimalString,
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
      if (result.kind === "COMMITTED") {
        setConfirmValue(null);
        setSaved(true);
        await onCommitted?.();
        return;
      }
      setNotSaved(true);
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (saved || busy) return;
    const formatted = formatMmolEntry(value);

    setValueError(formatted !== null ? null : msg.invalidDecimal);
    setContextError(context ? null : messages.shared.requiredField);
    setTimeError(instant ? null : messages.shared.requiredField);
    if (formatted === null || !context || !instant) return;

    // Completion: the field shows exactly what will be saved. Fix round 3 (owner ruling 7): an automatically added ".0" is remembered
    // like the one added on leaving the field, so continued entry (keypad, or typing after returning to the field) goes on from what
    // was typed ("60" → "605"); an explicitly typed decimal is never removed.
    setValue(formatted);
    // Fix round 4 (I-1): a real click on Save blurs the field first, which already formatted it and remembered the typed text; keep
    // that remembered text when it completes to the same value.
    setTypedValue(formatted !== value ? value : typedValue !== null && formatMmolEntry(typedValue) === formatted ? typedValue : null);
    if (latched || mmolEntryNeedsConfirmation(formatted)) {
      setLatched(true);
      setConfirmValue(formatted);
      return;
    }
    await commit(formatted);
  }

  function leaveConfirmation() {
    setConfirmValue(null);
    valueInput.current?.focus();
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
          ref={valueInput}
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
          onBlur={completeValue}
          onFocus={resumeValue}
          required
          error={valueError ?? undefined}
        />

        <TimeCard
          label={msg.occurrenceTime}
          summary={whenText}
          hint={msg.timeNowHint}
          editLabel={messages.readingTime.editTime}
          editorMessages={messages.readingTime}
          type="datetime-local"
          value={occurredAt}
          onChange={(next) => {
            setOccurredAt(next);
            setTimeError(null);
            edited();
          }}
          error={timeError ?? undefined}
        />

        <div ref={keypadArea}>
          <NumericKeypad
            label={msg.keypadLabel}
            deleteLabel={msg.deleteDigit}
            decimalLabel={msg.decimalPoint}
            value={value}
            appendBase={typedValue ?? undefined}
            maxLength={MMOL_ENTRY_MAX_LENGTH}
            accept={isMmolEntryTyping}
            onRefused={() => setValueError(msg.formatRefused)}
            onChange={changeValue}
          />
        </div>

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

        {confirmValue !== null ? (
          <section className="glucose-confirm" aria-labelledby="glucose-confirm-heading" data-glucose-confirm="">
            <h2 id="glucose-confirm-heading" ref={confirmHeading} tabIndex={-1} className="glucose-confirm-value">
              {`${confirmValue} ${msg.unit}`}
            </h2>
            <p>{msg.confirmBody}</p>
            <div className="glucose-confirm-actions">
              <Button variant="primary" busy={busy} disabled={saved} onClick={() => void commit(confirmValue)}>
                {busy ? messages.shared.saving : msg.saveAsShown}
              </Button>
              <Button variant="outline" disabled={busy} onClick={leaveConfirmation}>
                {msg.editReading}
              </Button>
              <Button variant="ghost" disabled={busy} onClick={leaveConfirmation}>
                {msg.cancelConfirm}
              </Button>
            </div>
          </section>
        ) : null}

        {confirmValue === null ? (
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
        ) : null}
      </form>
    </div>
  );
}
