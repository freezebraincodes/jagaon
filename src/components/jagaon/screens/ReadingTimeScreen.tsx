"use client";

import { useEffect, useState, type FormEvent } from "react";
import { type AppMessages, type SupportedLocale } from "@/i18n/types";
import { Banner } from "../primitives/Card";
import { Button } from "../primitives/Button";
import { ChoiceGroup } from "../primitives/ChoiceGroup";
import { InputField } from "../primitives/Field";
import { ClockIcon, DropIcon, HistoryIcon, SaveIcon } from "../primitives/Icons";
import { Notice, ScreenHeader } from "../primitives/ScreenHeader";
import { TimeWheel } from "../primitives/TimeWheel";
import type {
  GlucoseRecordViewModel,
  JournalCommandService,
  JournalQueryPort,
} from "@/application/journal/journal-contracts";
import type { RecordId } from "@/domain/shared/identifiers";
import type { Instant } from "@/domain/shared/time";
import {
  exactSingaporeOccurrence,
  formatSingaporeDateTime,
  isLaterThanNow,
  shiftSingaporeDate,
  singaporeNowParts,
  singaporeWallClockToInstant,
  toSingaporeParts,
} from "../journal/singapore-time";
import {
  GLUCOSE_CONTEXT_CHOICES,
  glucoseContextChoiceLabel,
  storedGlucoseContextLabel,
  toGlucoseContextPayload,
  type GlucoseContextChoice,
} from "../journal/glucose-context";

type ReadingTimeScreenProps = {
  messages: AppMessages;
  locale: SupportedLocale;
  goBack: () => void;
  recordId: RecordId;
  queryPort: JournalQueryPort;
  commandService: JournalCommandService;
  onCommitted?: () => void | Promise<void>;
};

type DayChoice = "TODAY" | "YESTERDAY" | "OTHER";

function storedContextCode(record: GlucoseRecordViewModel): string {
  const context = record.payload.context;
  return context.kind === "PATIENT_SELECTED_SLOT" ? context.slot : context.kind;
}

/** The "When was this test?" chip for a stored context, or null when the record has none of them (it then stays as recorded). */
function storedContextChoice(record: GlucoseRecordViewModel): GlucoseContextChoice | null {
  const code = storedContextCode(record);
  if (code === "OTHER") return "JUST_CHECKING";
  return (GLUCOSE_CONTEXT_CHOICES as readonly string[]).includes(code) ? (code as GlucoseContextChoice) : null;
}

export function ReadingTimeScreen({
  messages,
  locale,
  recordId,
  queryPort,
  commandService,
  onCommitted,
}: ReadingTimeScreenProps) {
  const msg = messages.readingTime;
  const [date, setDate] = useState(() => singaporeNowParts().date);
  const [time, setTime] = useState(() => singaporeNowParts().time);
  const [otherDay, setOtherDay] = useState(false);
  const [timeError, setTimeError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [notSaved, setNotSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [record, setRecord] = useState<GlucoseRecordViewModel | null>(null);
  // Owner decision 2026-10-16: the edit also changes "When was this test?". Null keeps the stored context unchanged.
  const [context, setContext] = useState<GlucoseContextChoice | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let active = true;
    void queryPort.loadGlucose(recordId).then(
      (loaded) => {
        if (!active) return;
        if (!loaded) {
          setUnavailable(true);
          return;
        }
        setRecord(loaded);
        setContext(storedContextChoice(loaded));
        const occurrence = loaded.temporal.occurrence;
        if (occurrence.kind === "EXACT") {
          const local = toSingaporeParts(occurrence.instantUtc);
          setDate(local.date);
          setTime(local.time);
        }
      },
      () => {
        if (active) setUnavailable(true);
      },
    );
    return () => {
      active = false;
    };
  }, [queryPort, recordId]);

  const today = singaporeNowParts().date;
  const yesterday = shiftSingaporeDate(today, -1);
  const day: DayChoice = otherDay
    ? "OTHER"
    : date === today
      ? "TODAY"
      : date === yesterday
        ? "YESTERDAY"
        : "OTHER";
  const instant = singaporeWallClockToInstant(date, time);

  function changed(nextDate: string, nextTime: string) {
    setDate(nextDate);
    setTime(nextTime);
    setTimeError(null);
    setSaved(false);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!record) {
      setNotSaved(true);
      return;
    }
    const later = instant !== null && isLaterThanNow(instant);
    setTimeError(!instant ? messages.shared.requiredField : later ? msg.laterThanNow : null);
    if (!instant || later) return;

    setSaved(false);
    setNotSaved(false);
    setBusy(true);
    const result = await commandService.correctGlucoseTime({
      recordId: record.recordId,
      expectedRevisionId: record.revisionId,
      expectedRevisionNumber: record.revisionNumber,
      payload: context === null ? record.payload : { ...record.payload, context: toGlucoseContextPayload(context) },
      temporal: exactSingaporeOccurrence(instant),
      recordedAt: new Date().toISOString() as Instant,
    });
    setBusy(false);
    if (result.kind === "COMMITTED") {
      setSaved(true);
      const refreshed = await queryPort.loadGlucose(recordId);
      if (refreshed) setRecord(refreshed);
      await onCommitted?.();
      return;
    }
    setNotSaved(true);
  }

  const occurrence = record?.temporal.occurrence;
  const currentInstant = occurrence?.kind === "EXACT" ? occurrence.instantUtc : null;
  const contextLabel = record ? storedGlucoseContextLabel(messages, storedContextCode(record)) : null;
  const readingText = record
    ? `${record.payload.measurement.enteredValue} ${
        record.payload.measurement.enteredUnit === "MMOL_L" ? messages.glucose.unit : "mg/dL"
      }`
    : null;

  return (
    <div className="screen-page journal-entry-screen reading-time-screen">
      <ScreenHeader title={msg.editTitle} />

      {saved ? <Banner variant="success">{msg.saved}</Banner> : null}
      {notSaved ? <Banner variant="error">{messages.shared.notSaved}</Banner> : null}
      {unavailable ? <Banner variant="error">{messages.shared.storageUnavailable}</Banner> : null}

      <div className="reading-summary-card">
        <DropIcon size={28} className="icon reading-summary-icon" />
        <p className="reading-summary-value">
          {record ? (
            <>
              <span className="reading-summary-number">
                {record.payload.measurement.enteredValue}
              </span>{" "}
              <span className="reading-summary-unit">
                {record.payload.measurement.enteredUnit === "MMOL_L" ? messages.glucose.unit : "mg/dL"}
              </span>
            </>
          ) : (
            messages.shared.loading
          )}
        </p>
        {contextLabel ? <p className="reading-summary-context">{contextLabel}</p> : null}
      </div>

      <form onSubmit={handleSubmit} className="entry-form" noValidate>
        <ChoiceGroup
          legend={messages.glucose.whenQuestion}
          options={GLUCOSE_CONTEXT_CHOICES.map((choice) => ({
            value: choice,
            label: glucoseContextChoiceLabel(messages, choice),
          }))}
          value={context}
          onChange={(next) => {
            setContext(next);
            setSaved(false);
          }}
        />

        <ChoiceGroup<DayChoice>
          legend={msg.whichDay}
          variant="segmented"
          options={[
            { value: "TODAY", label: msg.dayToday },
            { value: "YESTERDAY", label: msg.dayYesterday },
            { value: "OTHER", label: msg.dayOther },
          ]}
          value={day}
          onChange={(next) => {
            setOtherDay(next === "OTHER");
            if (next === "TODAY") changed(today, time);
            if (next === "YESTERDAY") changed(yesterday, time);
          }}
        />

        {day === "OTHER" ? (
          <InputField
            fieldClassName="field--time"
            label={msg.newDate}
            type="date"
            value={date}
            onChange={(e) => changed(e.target.value, time)}
            required
          />
        ) : null}

        <TimeWheel
          legend={msg.whatTime}
          value={time}
          onChange={(nextTime) => changed(date, nextTime)}
          messages={msg}
          error={timeError ?? undefined}
        />

        <details className="entry-details">
          <summary>{msg.typeInstead}</summary>
          <div className="entry-details-body field-pair">
            <InputField
              label={msg.newDate}
              type="date"
              value={date}
              onChange={(e) => changed(e.target.value, time)}
              required
            />
            <InputField
              label={msg.newTime}
              type="time"
              value={time}
              onChange={(e) => changed(date, e.target.value)}
              required
            />
          </div>
        </details>

        {readingText && instant ? (
          <div className="current-time-card" aria-live="polite">
            <ClockIcon size={26} className="icon current-time-icon" />
            <div>
              <p className="current-time-value">
                {msg.recordedFor(readingText, formatSingaporeDateTime(locale, instant))}
              </p>
              {currentInstant ? (
                <p className="current-time-note">
                  {/* The wheel edits whole minutes, so compare at that precision. */}
                  {Math.floor(new Date(currentInstant).getTime() / 60_000) ===
                  Math.floor(new Date(instant).getTime() / 60_000)
                    ? msg.sameAsCurrent
                    : msg.currentlyRecorded(formatSingaporeDateTime(locale, currentInstant))}
                </p>
              ) : null}
            </div>
          </div>
        ) : null}

        <Notice icon={<HistoryIcon size={20} />}>{msg.historyNote}</Notice>

        <div className="button-stack">
          <Button
            type="submit"
            variant="primary"
            className="btn-hero"
            busy={busy}
            disabled={!record || saved}
          >
            <SaveIcon size={24} />
            {busy ? messages.shared.saving : msg.saveOccurrence}
          </Button>
          <Button
            variant="outline"
            className="btn-wide"
            onClick={() => {
              const now = singaporeNowParts();
              setOtherDay(false);
              changed(now.date, now.time);
            }}
          >
            {msg.useNow}
          </Button>
        </div>
      </form>
    </div>
  );
}
