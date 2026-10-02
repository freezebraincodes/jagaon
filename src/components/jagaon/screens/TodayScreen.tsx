"use client";

import { type AppMessages, type SupportedLocale } from "@/i18n/types";
import type { DemoPatientProfile } from "@/application/governed/demo-scenario-fixture";
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
  PlusIcon,
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

type TodayScreenProps = {
  messages: AppMessages;
  locale: SupportedLocale;
  fixture: DemoPatientProfile;
  journal: TodayJournalViewModel;
  actionsDisabled?: boolean;
  navigate: (screen: ScreenId, params?: Record<string, string>) => void;
  /** Injected clock for deterministic tests; defaults to the device time. */
  now?: Date;
};

type BookletSlot = {
  label: string;
  entry: TodayJournalEntry | null;
};

function occurrenceOf(entry: TodayJournalEntry): string {
  return entry.occurrenceSortInstant ?? entry.recordedAt;
}

function slotIndexFor(entry: TodayJournalEntry): number {
  const hour = singaporeHour(occurrenceOf(entry));
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
}: TodayScreenProps) {
  const msg = messages.today;
  const greetingName = locale === "zh-SG" ? fixture.displayNameZh : fixture.displayName;
  const todayEntries = journal.entries.filter((entry) =>
    isSameSingaporeDay(occurrenceOf(entry), now),
  );

  // Entries arrive newest first, so the first reading per slot is the latest.
  const slots: BookletSlot[] = [msg.slotMorning, msg.slotAfternoon, msg.slotEvening].map(
    (label) => ({ label, entry: null }),
  );
  for (const entry of todayEntries) {
    if (entry.recordType !== "GLUCOSE_READING") continue;
    const slot = slots[slotIndexFor(entry)]!;
    slot.entry ??= entry;
  }
  const stamped = slots.filter((slot) => slot.entry).length;

  const latestGlucose =
    journal.entries.find((entry) => entry.recordType === "GLUCOSE_READING") ?? null;
  const latestInstant = latestGlucose ? occurrenceOf(latestGlucose) : null;
  const latestContext = latestGlucose
    ? storedGlucoseContextLabel(messages, latestGlucose.displayContext)
    : null;
  const latestMeal =
    todayEntries.find((entry) => entry.recordType === "INTAKE_EVENT") ?? null;

  return (
    <div className="today-screen">
      <header className="today-header">
        <p className="today-date">{formatSingaporeLongDate(locale, now)}</p>
        <h1 className="today-greeting">{msg.greeting(greetingName)}</h1>
      </header>

      {journal.unavailable ? (
        <Banner variant="error">{messages.shared.storageUnavailable}</Banner>
      ) : null}

      <section className="today-card booklet-card" aria-labelledby="today-booklet-heading">
        <div className="booklet-header">
          <h2 id="today-booklet-heading" className="card-title">
            {msg.todayBooklet}
          </h2>
          <span className="booklet-progress">{msg.bookletProgress(stamped, slots.length)}</span>
        </div>
        <ul className="booklet-slots">
          {slots.map((slot) => (
            <li
              key={slot.label}
              className={`booklet-slot ${slot.entry ? "booklet-slot--recorded" : "booklet-slot--empty"}`}
            >
              <span className="booklet-slot-label">{slot.label}</span>
              {slot.entry ? (
                <>
                  <span className="booklet-slot-value">
                    {slot.entry.displayValue}
                    <span className="sr-only"> {slot.entry.displayUnit ?? messages.glucose.unit}</span>
                  </span>
                  <span className="booklet-slot-detail">
                    {[
                      formatSingaporeTime(locale, occurrenceOf(slot.entry)),
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
        <button
          type="button"
          className="btn btn-primary btn-hero record-reading-action"
          onClick={() => navigate("LOG_GLUCOSE")}
          disabled={actionsDisabled}
        >
          <DropIcon size={26} />
          {msg.recordReading}
        </button>
      </section>

      {latestGlucose && latestInstant ? (
        <section className="today-card" aria-labelledby="latest-reading-heading">
          <h2 id="latest-reading-heading" className="eyebrow">
            {msg.latestRecordedReading}
          </h2>
          <p className="reading-display">
            <span className="reading-value">{latestGlucose.displayValue}</span>{" "}
            <span className="reading-unit">{latestGlucose.displayUnit ?? messages.glucose.unit}</span>
          </p>
          <p className="reading-meta">
            {isSameSingaporeDay(latestInstant, now)
              ? formatSingaporeTime(locale, latestInstant)
              : formatSingaporeDateTime(locale, latestInstant)}
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
            <button type="button" className="text-link" disabled aria-disabled="true">
              {msg.viewHistory}
              <ChevronRightIcon size={18} />
            </button>
          </div>
        </section>
      ) : null}

      <section className="today-card" aria-labelledby="insulin-today-heading">
        <h2 id="insulin-today-heading" className="eyebrow">
          {msg.insulinToday}
        </h2>
        <div className="insulin-list">
          {fixture.recordedPrescriptions.map((prescription) => {
            const recorded = todayEntries.find(
              (entry) =>
                entry.recordType === "MEDICATION_EVENT" &&
                entry.displayContext === prescription.medicationRecordId,
            );
            const recordedText = recorded
              ? (insulinAmountText(messages, recorded) ??
                messages.shared.recordedAt(formatSingaporeTime(locale, occurrenceOf(recorded))))
              : null;
            return (
              <div
                key={prescription.medicationId}
                className="insulin-item"
                role="group"
                aria-labelledby={`insulin-${prescription.medicationId}`}
              >
                <h3 id={`insulin-${prescription.medicationId}`} className="insulin-name">
                  {prescription.displayName}
                </h3>
                <dl className="insulin-facts">
                  <div className="insulin-fact">
                    <dt className="eyebrow">{msg.scheduled}</dt>
                    <dd>
                      <CalendarIcon size={18} />
                      {prescription.scheduledTime}
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
                  {labelAndValue(locale, messages.shared.source, prescription.provenance.detail)}
                </p>
              </div>
            );
          })}
        </div>
        <button
          type="button"
          className="text-link text-link--large"
          onClick={() => navigate("RECORD_INSULIN")}
          disabled={actionsDisabled}
        >
          <PlusIcon size={20} />
          {msg.addRecord}
        </button>
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
        {/* Synthetic, user-entered activity from the fixture; there is no
            activity logging in Packet 6, so the tile is not interactive. */}
        <div className="summary-tile" role="group" aria-labelledby="activity-heading">
          <WalkIcon size={28} className="icon summary-tile-icon" />
          <h2 id="activity-heading" className="summary-tile-title">
            {fixture.activity.title}
          </h2>
          <p className="summary-tile-body">
            {[fixture.activity.place, messages.shared.minutes(fixture.activity.minutes), msg.enteredByYou].join(
              " · ",
            )}
          </p>
        </div>
      </section>

      <section className="today-card" aria-labelledby="care-planning-heading">
        <h2 id="care-planning-heading" className="eyebrow">
          {msg.careDatesHeading}
        </h2>
        <ul className="care-dates">
          {fixture.careDates.map((date) => (
            <li key={date.id} className="care-date">
              {date.kind === "VISIT" ? <StethoscopeIcon size={24} /> : <EyeIcon size={24} />}
              <span className="care-date-label">{date.label}</span>
              <span className="care-date-value">{date.enteredDateText}</span>
            </li>
          ))}
        </ul>
        <p className="provenance-line">{msg.careDatesNote}</p>
        <button
          type="button"
          className="text-link text-link--large"
          disabled
          aria-disabled="true"
          aria-describedby="care-planning-later"
        >
          {msg.prepareAppointment}
          <ChevronRightIcon size={20} />
        </button>
        <p className="sr-only" id="care-planning-later">
          {msg.futureFeature}
        </p>
      </section>
    </div>
  );
}
