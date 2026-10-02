"use client";

import { useEffect, useState, type FormEvent } from "react";
import { type AppMessages, type SupportedLocale } from "@/i18n/types";
import { Banner } from "../primitives/Card";
import { Button } from "../primitives/Button";
import { ChoiceGroup } from "../primitives/ChoiceGroup";
import { InputField } from "../primitives/Field";
import { ClockIcon, DropIcon, HistoryIcon, SaveIcon } from "../primitives/Icons";
import { Notice, ScreenHeader } from "../primitives/ScreenHeader";
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
  shiftSingaporeDate,
  singaporeNowParts,
  singaporeWallClockToInstant,
  toSingaporeParts,
} from "../journal/singapore-time";
import { storedGlucoseContextLabel } from "../journal/glucose-context";

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

const HOURS = Array.from({ length: 12 }, (_, i) => String(i + 1));
const MINUTES = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0"));

function storedContextCode(record: GlucoseRecordViewModel): string {
  const context = record.payload.context;
  return context.kind === "PATIENT_SELECTED_SLOT" ? context.slot : context.kind;
}

/** 24-hour "HH:mm" ↔ 12-hour wheel parts. */
function toWheel(time: string) {
  const [h = 0, m = 0] = time.split(":").map(Number);
  return { hour: String(h % 12 === 0 ? 12 : h % 12), minute: String(m).padStart(2, "0"), pm: h >= 12 };
}

function fromWheel(hour: string, minute: string, pm: boolean): string {
  const h = (Number(hour) % 12) + (pm ? 12 : 0);
  return `${String(h).padStart(2, "0")}:${minute}`;
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
  const wheel = toWheel(time);
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
    setTimeError(instant ? null : messages.shared.requiredField);
    if (!instant) return;

    setSaved(false);
    setNotSaved(false);
    setBusy(true);
    const result = await commandService.correctGlucoseTime({
      recordId: record.recordId,
      expectedRevisionId: record.revisionId,
      expectedRevisionNumber: record.revisionNumber,
      payload: record.payload,
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
      <ScreenHeader title={messages.glucose.whenQuestion} />

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

        <fieldset className="time-wheel">
          <legend className="eyebrow">{msg.whatTime}</legend>
          <div className="time-wheel-band">
            <label className="time-wheel-column">
              <span className="sr-only">{msg.hourLabel}</span>
              <select
                className="time-wheel-select"
                value={wheel.hour}
                onChange={(e) => changed(date, fromWheel(e.target.value, wheel.minute, wheel.pm))}
              >
                {HOURS.map((hour) => (
                  <option key={hour} value={hour}>
                    {hour}
                  </option>
                ))}
              </select>
            </label>
            <span className="time-wheel-colon" aria-hidden="true">
              :
            </span>
            <label className="time-wheel-column">
              <span className="sr-only">{msg.minuteLabel}</span>
              <select
                className="time-wheel-select"
                value={wheel.minute}
                onChange={(e) => changed(date, fromWheel(wheel.hour, e.target.value, wheel.pm))}
              >
                {MINUTES.map((minute) => (
                  <option key={minute} value={minute}>
                    {minute}
                  </option>
                ))}
              </select>
            </label>
            <label className="time-wheel-column">
              <span className="sr-only">{msg.periodLabel}</span>
              <select
                className="time-wheel-select time-wheel-select--period"
                value={wheel.pm ? "pm" : "am"}
                onChange={(e) => changed(date, fromWheel(wheel.hour, wheel.minute, e.target.value === "pm"))}
              >
                <option value="am">{msg.am}</option>
                <option value="pm">{msg.pm}</option>
              </select>
            </label>
          </div>
          <p className="time-wheel-hint">{msg.wheelHint}</p>
          {timeError ? (
            <p className="field-error" role="alert">
              {timeError}
            </p>
          ) : null}
        </fieldset>

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
