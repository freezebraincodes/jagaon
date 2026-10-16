"use client";

import { useRef, useState } from "react";
import { type AppMessages, type SupportedLocale } from "@/i18n/types";
import type { RecordDeletionPort } from "../data/data-ports";
import { RecordDeletionDialog } from "../data/RecordDeletionDialog";
import type { CareNudgeSummary } from "@/application/preview/care-nudges";
import { useHsaBoundedMode } from "../hsa/hsa-bounded-mode";
import { CareNudgeHeader, CareNudgeList } from "../hsa/care-nudges";
import {
  isDemoInsulinPrescription,
  type DemoPatientProfile,
} from "@/application/governed/demo-scenario-fixture";
import type { ScreenId } from "../screen-manifest";
import type {
  TodayJournalEntry,
  TodayJournalViewModel,
} from "@/application/journal/journal-contracts";
import { Banner } from "../primitives/Card";
import {
  BowlIcon,
  CalendarIcon,
  EyeIcon,
  StethoscopeIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleIcon,
  DropIcon,
  PencilIcon,
  PillIcon,
  PlusIcon,
  TrashIcon,
  WalkIcon,
} from "../primitives/Icons";
import {
  formatSingaporeDateTime,
  formatSingaporeLongDate,
  formatSingaporeTime,
  isSameSingaporeDay,
  singaporeHour,
} from "../journal/singapore-time";
import { storedGlucoseContextLabel } from "../journal/glucose-context";
import { labelAndValue } from "../locale-format";
import { sourceLabel } from "../onboarding/medicine-labels";
import { MealIdeasCard } from "../hsa/MealIdeasCard";

type TodayScreenProps = {
  messages: AppMessages;
  locale: SupportedLocale;
  fixture: DemoPatientProfile;
  journal: TodayJournalViewModel;
  actionsDisabled?: boolean;
  navigate: (screen: ScreenId, params?: Record<string, string>) => void;
  /** Injected clock for deterministic tests; defaults to the device time. */
  now?: Date;
  /** Packet 10A: permanent deletion of the latest recorded reading (frame 10). */
  recordDeletion?: RecordDeletionPort;
  onRecordDeleted?: () => void;
  /** Opens the History tab (as the bottom navigation does). Without it, "View history" stays disabled. */
  onOpenHistory?: () => void;
  /** PREVIEW (HSA-bounded mode off only): care checks due by standard intervals; ignored while the mode is on. */
  careNudges?: CareNudgeSummary | null;
};

type BookletSlot = {
  label: string;
  entry: TodayJournalEntry | null;
  at: string | null;
};

/**
 * Finding T-1: the measurement/event time, only when it is known. The recording time (`recordedAt`) is never substituted for it; an
 * unknown time stays unknown and is labelled "Time not recorded · Entered at {time}".
 */
function knownOccurrence(entry: TodayJournalEntry): string | null {
  return entry.occurrenceSortInstant;
}

/** Which Singapore day an entry belongs to on Today: its occurrence day, or, for an unknown time, the day it was entered. Never shown as a time. */
function dayAnchor(entry: TodayJournalEntry): string {
  return entry.occurrenceSortInstant ?? entry.recordedAt;
}

function slotIndexFor(occurrence: string): number {
  const hour = singaporeHour(occurrence);
  return hour < 12 ? 0 : hour < 18 ? 1 : 2;
}

/** Localises the domain unit code for an insulin amount. */
function insulinAmountText(messages: AppMessages, entry: TodayJournalEntry): string | null {
  if (!entry.displayValue) return null;
  const unit = entry.displayUnit === "UNIT" ? messages.insulin.unit : entry.displayUnit;
  return unit ? `${entry.displayValue} ${unit}` : entry.displayValue;
}

/** Label for the stored meal slot, or the intake kind when no slot was chosen. */
function mealSlotText(messages: AppMessages, code: string | undefined): string {
  const meal = messages.meal;
  switch (code) {
    case "BREAKFAST":
      return meal.breakfast;
    case "LUNCH":
      return meal.lunch;
    case "DINNER":
      return meal.dinner;
    case "SUPPER":
      return meal.supper;
    case "MEAL":
      return meal.kindMeal;
    case "SNACK":
      return meal.kindSnack;
    case "TEA":
      return meal.kindTea;
    case "DESSERT":
      return meal.kindDessert;
    case "DRINK":
      return meal.kindDrink;
    default:
      return meal.other;
  }
}

export function TodayScreen({
  messages,
  locale,
  fixture,
  journal,
  actionsDisabled = false,
  navigate,
  now = new Date(),
  recordDeletion,
  onRecordDeleted,
  onOpenHistory,
  careNudges = null,
}: TodayScreenProps) {
  const [deleting, setDeleting] = useState(false);
  // HSA-bounded mode on (default): the care planning card stays as entered dates only.
  const nudges = useHsaBoundedMode().bounded ? null : careNudges;
  const deleteOpener = useRef<HTMLButtonElement>(null);
  const msg = messages.today;
  const greetingName = locale === "zh-SG" ? fixture.displayNameZh : fixture.displayName;
  const prescriptions = fixture.recordedPrescriptions;
  const allPens = prescriptions.length > 0 && prescriptions.every((p) => p.catalogueForm === "PRE_FILLED_PEN");
  const canRecordInsulin = prescriptions.some(isDemoInsulinPrescription);
  const todayEntries = journal.entries.filter((entry) =>
    isSameSingaporeDay(dayAnchor(entry), now),
  );
  /** "Time not recorded · Entered at {time}": the unrecorded time is the measurement/event time; "Entered at" is the recording time. */
  const unknownTimeText = (entry: TodayJournalEntry, withDate: boolean) =>
    `${msg.timeNotRecorded} · ${msg.enteredAt(
      withDate ? formatSingaporeDateTime(locale, entry.recordedAt) : formatSingaporeTime(locale, entry.recordedAt),
    )}`;

  // Entries arrive newest first, so the first reading per slot is the latest. Only a known time places a reading in a slot; a reading
  // with an unknown time is listed under the slots instead and does not count as stamped (finding T-1).
  const slots: BookletSlot[] = [msg.slotMorning, msg.slotAfternoon, msg.slotEvening].map(
    (label) => ({ label, entry: null, at: null }),
  );
  const unknownTimeReadings: TodayJournalEntry[] = [];
  for (const entry of todayEntries) {
    if (entry.recordType !== "GLUCOSE_READING") continue;
    const at = knownOccurrence(entry);
    if (at === null) {
      unknownTimeReadings.push(entry);
      continue;
    }
    const slot = slots[slotIndexFor(at)]!;
    if (slot.entry === null) {
      slot.entry = entry;
      slot.at = at;
    }
  }
  // Owner decision 2026-10-15: the booklet counts today's readings (known or unknown time) and sets no target.
  const readingsToday = todayEntries.filter((entry) => entry.recordType === "GLUCOSE_READING").length;

  const latestGlucose =
    journal.entries.find((entry) => entry.recordType === "GLUCOSE_READING") ?? null;
  const latestInstant = latestGlucose ? knownOccurrence(latestGlucose) : null;
  const latestWhen = latestGlucose
    ? latestInstant
      ? isSameSingaporeDay(latestInstant, now)
        ? formatSingaporeTime(locale, latestInstant)
        : formatSingaporeDateTime(locale, latestInstant)
      : unknownTimeText(latestGlucose, !isSameSingaporeDay(latestGlucose.recordedAt, now))
    : null;
  const latestContext = latestGlucose
    ? storedGlucoseContextLabel(messages, latestGlucose.displayContext)
    : null;
  const latestMeal =
    todayEntries.find((entry) => entry.recordType === "INTAKE_EVENT") ?? null;
  // The newest activity on any day, with when it happened (or when it was entered, if she gave no time).
  const latestActivity =
    journal.entries.find((entry) => entry.recordType === "ACTIVITY_EVENT") ?? null;
  const latestActivityInstant = latestActivity ? knownOccurrence(latestActivity) : null;
  const latestActivityWhen = latestActivity
    ? latestActivityInstant
      ? isSameSingaporeDay(latestActivityInstant, now)
        ? formatSingaporeTime(locale, latestActivityInstant)
        : formatSingaporeDateTime(locale, latestActivityInstant)
      : msg.enteredAt(
          isSameSingaporeDay(latestActivity.recordedAt, now)
            ? formatSingaporeTime(locale, latestActivity.recordedAt)
            : formatSingaporeDateTime(locale, latestActivity.recordedAt),
        )
    : null;

  return (
    <div className="today-screen">
      <header className="today-header">
        <p className="today-date">{formatSingaporeLongDate(locale, now)}</p>
        <h1 className="today-greeting">{greetingName ? msg.greeting(greetingName) : msg.greetingNoName}</h1>
      </header>

      {journal.unavailable ? (
        <Banner variant="error">{messages.shared.storageUnavailable}</Banner>
      ) : null}

      <section className="today-card booklet-card" aria-labelledby="today-booklet-heading">
        <div className="booklet-header">
          <h2 id="today-booklet-heading" className="card-title">
            {msg.todayBooklet}
          </h2>
          <span className="booklet-progress">{msg.bookletProgress(readingsToday)}</span>
        </div>
        <ul className="booklet-slots">
          {slots.map((slot) => (
            <li
              key={slot.label}
              className={`booklet-slot ${slot.entry ? "booklet-slot--recorded" : "booklet-slot--empty"}`}
            >
              <span className="booklet-slot-label">{slot.label}</span>
              {slot.entry && slot.at ? (
                <>
                  <span className="booklet-slot-value">
                    {slot.entry.displayValue}
                    <span className="sr-only"> {slot.entry.displayUnit ?? messages.glucose.unit}</span>
                  </span>
                  <span className="booklet-slot-detail">
                    {[
                      formatSingaporeTime(locale, slot.at),
                      storedGlucoseContextLabel(messages, slot.entry.displayContext),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </>
              ) : (
                <>
                  <span className="booklet-slot-dash" aria-hidden="true" />
                  <span className="booklet-slot-empty">{msg.notRecorded}</span>
                </>
              )}
            </li>
          ))}
        </ul>
        {unknownTimeReadings.length > 0 ? (
          <ul className="booklet-unknown-time">
            {unknownTimeReadings.map((entry) => (
              <li key={entry.recordId} className="booklet-slot-detail">
                {[
                  `${messages.glucose.valueLabel} ${entry.displayValue ?? ""} ${entry.displayUnit ?? messages.glucose.unit}`,
                  unknownTimeText(entry, false),
                  storedGlucoseContextLabel(messages, entry.displayContext),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </li>
            ))}
          </ul>
        ) : null}
        <button
          type="button"
          className="btn btn-primary btn-hero record-reading-action"
          onClick={() => navigate("LOG_GLUCOSE")}
          disabled={actionsDisabled}
        >
          <DropIcon size={26} />
          {msg.recordReading}
        </button>
        {/* Packet 13 slice: Tell JagaOn (always discoverable; the screen explains when voice is unavailable). */}
        <button type="button" className="btn btn-outline btn-wide tell-jagaon-action" onClick={() => navigate("TELL_JAGAON")} disabled={actionsDisabled}>
          {messages.voice.entry}
        </button>
      </section>

      {latestGlucose && latestWhen ? (
        <section className="today-card" aria-labelledby="latest-reading-heading">
          <h2 id="latest-reading-heading" className="eyebrow">
            {msg.latestRecordedReading}
          </h2>
          <p className="reading-display">
            <span className="reading-value">{latestGlucose.displayValue}</span>{" "}
            <span className="reading-unit">{latestGlucose.displayUnit ?? messages.glucose.unit}</span>
          </p>
          <p className="reading-meta">
            {latestWhen}
            {latestContext ? ` · ${latestContext}` : ""}
          </p>
          <div className="card-links">
            <button
              type="button"
              className="text-link"
              onClick={() =>
                navigate("CHANGE_READING_TIME", { recordId: latestGlucose.recordId })
              }
            >
              <PencilIcon size={18} />
              {messages.readingTime.editTime}
            </button>
            {recordDeletion ? (
              <button ref={deleteOpener} type="button" className="text-link text-link--danger" onClick={() => setDeleting(true)}>
                <TrashIcon size={18} />
                {messages.packet10.deletion.deleteRecordAction}
              </button>
            ) : null}
            <button
              type="button"
              className="text-link"
              onClick={onOpenHistory}
              disabled={!onOpenHistory}
              aria-disabled={onOpenHistory ? undefined : "true"}
            >
              {msg.viewHistory}
              <ChevronRightIcon size={18} />
            </button>
          </div>
          {deleting && recordDeletion ? (
            <RecordDeletionDialog
              messages={messages}
              locale={locale}
              port={recordDeletion}
              target={{ recordType: "GLUCOSE_READING", recordId: latestGlucose.recordId }}
              recordLabel={`${messages.glucose.valueLabel} ${latestGlucose.displayValue ?? ""} ${latestGlucose.displayUnit ?? messages.glucose.unit}`.trim()}
              recordWhen={latestInstant ? formatSingaporeDateTime(locale, latestInstant) : unknownTimeText(latestGlucose, true)}
              now={() => new Date().toISOString()}
              onClose={() => setDeleting(false)}
              onDeleted={() => {
                setDeleting(false);
                onRecordDeleted?.();
              }}
              returnFocusRef={deleteOpener}
            />
          ) : null}
        </section>
      ) : null}

      <section className="today-card" aria-labelledby="insulin-today-heading">
        <h2 id="insulin-today-heading" className="eyebrow">
          {allPens ? msg.insulinToday : msg.medicinesToday}
        </h2>
        {prescriptions.length === 0 ? (
          <>
            {/* Frame 31: nothing recorded is stated neutrally, never as missed. */}
            <div className="today-empty-medicines">
              <PillIcon size={28} />
              <p className="today-empty-title">{msg.noMedicinesTitle}</p>
              <p>{msg.noMedicinesNotMissed}</p>
            </div>
            <button type="button" className="btn btn-outline btn-wide" onClick={() => navigate("MY_MEDICINES")}>
              <PlusIcon size={22} />
              {messages.onboarding.addMedicine}
            </button>
            <p className="provenance-line">{msg.noMedicinesNote}</p>
          </>
        ) : (
          <>
            <div className="insulin-list">
              {prescriptions.map((prescription) => {
                const recorded = todayEntries.find(
                  (entry) =>
                    entry.recordType === "MEDICATION_EVENT" &&
                    entry.displayContext === prescription.medicationRecordId,
                );
                const recordedOccurrence = recorded ? knownOccurrence(recorded) : null;
                const recordedText = recorded
                  ? (insulinAmountText(messages, recorded) ??
                    (recordedOccurrence
                      ? messages.shared.recordedAt(formatSingaporeTime(locale, recordedOccurrence))
                      : unknownTimeText(recorded, false)))
                  : null;
                return (
                  <div
                    key={prescription.medicationRecordId}
                    className="insulin-item"
                    role="group"
                    aria-labelledby={`insulin-${prescription.medicationRecordId}`}
                  >
                    <h3 id={`insulin-${prescription.medicationRecordId}`} className="insulin-name">
                      {prescription.displayName}
                    </h3>
                    <dl className="insulin-facts">
                      <div className="insulin-fact">
                        <dt className="eyebrow">{msg.scheduled}</dt>
                        <dd>
                          <CalendarIcon size={18} />
                          {prescription.scheduledTime ?? messages.onboarding.unknownValue}
                        </dd>
                      </div>
                      <div className={`insulin-fact ${recorded ? "insulin-fact--recorded" : ""}`}>
                        <dt className="eyebrow">{msg.intakeRecord}</dt>
                        <dd>
                          {recorded ? <CheckIcon size={18} /> : <CircleIcon size={18} />}
                          {recordedText ?? msg.notRecorded}
                        </dd>
                      </div>
                    </dl>
                    <p className="provenance-line">
                      {labelAndValue(locale, messages.shared.source, sourceLabel(messages, prescription.source))}
                    </p>
                  </div>
                );
              })}
            </div>
            {canRecordInsulin ? (
              <button
                type="button"
                className="text-link text-link--large"
                onClick={() => navigate("RECORD_INSULIN")}
                disabled={actionsDisabled}
              >
                <PlusIcon size={20} />
                {msg.addRecord}
              </button>
            ) : null}
          </>
        )}
      </section>

      <section className="summary-tiles" aria-label={msg.summaryTiles}>
        <button
          type="button"
          className="summary-tile"
          aria-label={msg.mealTitle}
          onClick={() => navigate("LOG_MEAL")}
          disabled={actionsDisabled}
        >
          <BowlIcon size={28} className="icon summary-tile-icon" />
          <span className="summary-tile-title">{msg.mealTitle}</span>
          <span className="summary-tile-body">
            {latestMeal
              ? labelAndValue(
                  locale,
                  mealSlotText(messages, latestMeal.displayContext),
                  latestMeal.displayValue ?? latestMeal.summary,
                )
              : msg.notRecorded}
          </span>
        </button>
        {/* The latest activity she recorded (Tell JagaOn is where activities are recorded, so the tile opens it). */}
        <button
          type="button"
          className="summary-tile"
          aria-label={msg.activityTitle}
          onClick={() => navigate("TELL_JAGAON")}
          disabled={actionsDisabled}
        >
          <WalkIcon size={28} className="icon summary-tile-icon" />
          <span className="summary-tile-title">{msg.activityTitle}</span>
          <span className="summary-tile-body">
            {latestActivity
              ? [
                  latestActivity.displayValue ?? latestActivity.summary,
                  ...(latestActivity.displayMinutes === undefined ? [] : [messages.shared.minutes(latestActivity.displayMinutes)]),
                  latestActivityWhen,
                ].join(" · ")
              : msg.notRecorded}
          </span>
        </button>
      </section>

      {/* Owner decision 2026-10-14: PREVIEW meal ideas, shown only while HSA-bounded mode is off. */}
      <MealIdeasCard messages={messages} now={now} navigate={navigate} />

      <section className="today-card" aria-labelledby="care-planning-heading">
        {nudges ? (
          <CareNudgeHeader messages={messages} summary={nudges} headingId="care-planning-heading" />
        ) : (
          <h2 id="care-planning-heading" className="eyebrow">
            {msg.careDatesHeading}
          </h2>
        )}
        <ul className="care-dates">
          {fixture.careDates.map((date) => (
            <li key={date.id} className="care-date">
              {date.kind === "VISIT" ? <StethoscopeIcon size={24} /> : <EyeIcon size={24} />}
              <span className="care-date-label">{date.label}</span>
              <span className="care-date-value">{date.enteredDateText}</span>
            </li>
          ))}
        </ul>
        {nudges ? <CareNudgeList messages={messages} locale={locale} summary={nudges} onSetDate={() => navigate("PREVENTIVE_CARE")} /> : null}
        <p className="provenance-line">{nudges ? messages.hsaCareNudges.note : msg.careDatesNote}</p>
        <button type="button" className="text-link text-link--large" onClick={() => navigate("CARE_PREPARATION")}>
          {msg.prepareAppointment}
          <ChevronRightIcon size={20} />
        </button>
      </section>
    </div>
  );
}
