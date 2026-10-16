"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { type AppMessages, type SupportedLocale } from "@/i18n/types";
import type { ActivityCategory } from "@/domain/health-records/activity-event";
import type { JournalCommandService } from "@/application/journal/journal-contracts";
import type { Instant } from "@/domain/shared/time";
import { labelWithAside } from "../locale-format";
import { Banner } from "../primitives/Card";
import { Button } from "../primitives/Button";
import { ChoiceGroup } from "../primitives/ChoiceGroup";
import { InputField } from "../primitives/Field";
import { SaveIcon } from "../primitives/Icons";
import { Notice, ScreenHeader } from "../primitives/ScreenHeader";
import { TimeCard } from "../primitives/TimeCard";
import {
  exactSingaporeOccurrence,
  formatSingaporeTime,
  singaporeNowParts,
  singaporeWallClockToInstant,
} from "../journal/singapore-time";

type ActivityEntryScreenProps = {
  messages: AppMessages;
  locale: SupportedLocale;
  commandService: JournalCommandService;
  goBack: () => void;
  onCommitted?: () => void | Promise<void>;
};

type ActivityKind = "WALK" | "RUN" | "SWIM" | "CYCLE" | "YOGA" | "STRENGTH" | "HOUSEWORK" | "OTHER";

type DurationChoice = "10" | "15" | "20" | "30" | "45" | "60" | "OTHER" | "NOT_SURE";

/** The longest label kept; the domain allows more, but a short line keeps Today and History readable. */
export const ACTIVITY_LABEL_MAX_LENGTH = 160;
/** Whole minutes accepted for "Other": 1 minute to 24 hours. */
export const ACTIVITY_MAX_MINUTES = 1440;

const QUICK_DURATIONS = ["10", "15", "20", "30", "45", "60"] as const;

/** Exact mapping from the tapped chip to the domain's activity category. */
export const ACTIVITY_CATEGORY: Readonly<Record<ActivityKind, ActivityCategory>> = {
  WALK: "WALKING",
  RUN: "AEROBIC",
  SWIM: "AEROBIC",
  CYCLE: "AEROBIC",
  YOGA: "FLEXIBILITY_OR_MOBILITY",
  STRENGTH: "STRENGTH",
  HOUSEWORK: "HOUSEHOLD_ACTIVITY",
  OTHER: "OTHER",
};

/** "1", "90", " 30 " → a whole number; empty → 0; anything else → null. */
function wholeNumber(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return 0;
  return /^\d{1,5}$/.test(trimmed) ? Number(trimmed) : null;
}

/** Hours and minutes as typed → total whole minutes, or null when it is not 1–1440. */
export function typedDurationMinutes(hours: string, minutes: string): number | null {
  const h = wholeNumber(hours);
  const m = wholeNumber(minutes);
  if (h === null || m === null) return null;
  const total = h * 60 + m;
  return total >= 1 && total <= ACTIVITY_MAX_MINUTES ? total : null;
}

export function ActivityEntryScreen({ messages, locale, commandService, goBack, onCommitted }: ActivityEntryScreenProps) {
  const msg = messages.activityEntry;
  const [kind, setKind] = useState<ActivityKind | null>(null);
  const [label, setLabel] = useState("");
  const [labelError, setLabelError] = useState<string | null>(null);
  const [duration, setDuration] = useState<DurationChoice | null>(null);
  const [hours, setHours] = useState("");
  const [minutes, setMinutes] = useState("");
  const [durationError, setDurationError] = useState<string | null>(null);
  const [initialTime] = useState(() => singaporeNowParts().time);
  const [time, setTime] = useState(initialTime);
  const [timeError, setTimeError] = useState<string | null>(null);
  const [notSaved, setNotSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const labelRef = useRef<HTMLInputElement>(null);
  const hoursRef = useRef<HTMLInputElement>(null);
  const durationHelpId = useId();

  const kindLabels: Record<ActivityKind, string> = {
    WALK: msg.kindWalk,
    RUN: msg.kindRun,
    SWIM: msg.kindSwim,
    CYCLE: msg.kindCycle,
    YOGA: msg.kindYoga,
    STRENGTH: msg.kindStrength,
    HOUSEWORK: msg.kindHousework,
    OTHER: msg.kindOther,
  };
  const instant = singaporeWallClockToInstant(singaporeNowParts().date, time);
  const timeText = instant
    ? (time === initialTime ? messages.shared.nowAt : messages.shared.todayAt)(formatSingaporeTime(locale, instant))
    : messages.shared.requiredField;

  function chooseKind(next: ActivityKind) {
    // The words follow the chip until the person writes their own; "Other" starts blank, for their own words.
    const untouched = label.trim() === "" || (kind !== null && label === kindLabels[kind]);
    if (untouched) setLabel(next === "OTHER" ? "" : kindLabels[next]);
    setKind(next);
    setLabelError(null);
    setNotSaved(false);
    if (next === "OTHER" && untouched) requestAnimationFrame(() => labelRef.current?.focus());
  }

  function chooseDuration(next: DurationChoice) {
    setDuration(next);
    setDurationError(null);
    setNotSaved(false);
    if (next === "OTHER") requestAnimationFrame(() => hoursRef.current?.focus());
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (kind === null) return;
    const patientLabel = label.trim() || (kind === "OTHER" ? "" : kindLabels[kind]);
    const durationMinutes =
      duration === "OTHER" ? typedDurationMinutes(hours, minutes) : duration === null || duration === "NOT_SURE" ? undefined : Number(duration);
    const nextLabelError = patientLabel ? null : msg.labelRequired;
    const nextDurationError = durationMinutes === null ? msg.durationInvalid : null;
    setLabelError(nextLabelError);
    setDurationError(nextDurationError);
    setTimeError(instant ? null : messages.shared.requiredField);
    if (nextLabelError) {
      labelRef.current?.focus();
      return;
    }
    if (nextDurationError) {
      hoursRef.current?.focus();
      return;
    }
    if (!instant || durationMinutes === null) return;

    setNotSaved(false);
    setBusy(true);
    const result = await commandService.recordActivity({
      payload: {
        activityCategory: ACTIVITY_CATEGORY[kind],
        patientLabel,
        ...(durationMinutes === undefined ? {} : { reportedDurationMinutes: durationMinutes }),
      },
      temporal: exactSingaporeOccurrence(instant),
      recordedAt: new Date().toISOString() as Instant,
    });
    setBusy(false);
    if (result.kind === "COMMITTED") {
      await onCommitted?.();
      goBack();
      return;
    }
    setNotSaved(true);
  }

  return (
    <div className="screen-page journal-entry-screen activity-entry-screen">
      <ScreenHeader title={msg.screenTitle} subtitle={msg.subtitle} />

      {notSaved ? <Banner variant="error">{messages.shared.notSaved}</Banner> : null}

      <form onSubmit={handleSubmit} className="entry-form" noValidate>
        <ChoiceGroup<ActivityKind>
          legend={msg.whatDidYouDo}
          options={(Object.keys(kindLabels) as ActivityKind[]).map((value) => ({ value, label: kindLabels[value] }))}
          value={kind}
          onChange={chooseKind}
        />

        <InputField
          ref={labelRef}
          label={kind === "OTHER" ? msg.labelField : labelWithAside(locale, msg.labelField, messages.shared.optional)}
          hint={msg.labelHint}
          value={label}
          maxLength={ACTIVITY_LABEL_MAX_LENGTH}
          required={kind === "OTHER"}
          onChange={(e) => {
            setLabel(e.target.value);
            setLabelError(null);
            setNotSaved(false);
          }}
          error={labelError ?? undefined}
          autoComplete="off"
        />

        <ChoiceGroup<DurationChoice>
          legend={labelWithAside(locale, msg.durationLabel, messages.shared.optional)}
          options={[
            ...QUICK_DURATIONS.map((value) => ({ value, label: messages.shared.minutes(Number(value)) })),
            { value: "OTHER", label: msg.durationOther },
            { value: "NOT_SURE", label: msg.durationNotSure },
          ]}
          value={duration}
          onChange={chooseDuration}
        />

        {duration === "OTHER" ? (
          <div className="activity-duration-other">
            <div className="activity-duration-fields">
              <InputField
                ref={hoursRef}
                label={msg.hoursLabel}
                value={hours}
                inputMode="numeric"
                maxLength={2}
                autoComplete="off"
                onChange={(e) => {
                  setHours(e.target.value);
                  setDurationError(null);
                  setNotSaved(false);
                }}
                aria-invalid={durationError ? true : undefined}
                aria-describedby={durationError ? `${durationHelpId}-hint ${durationHelpId}-error` : `${durationHelpId}-hint`}
              />
              <InputField
                label={msg.minutesLabel}
                value={minutes}
                inputMode="numeric"
                maxLength={4}
                autoComplete="off"
                onChange={(e) => {
                  setMinutes(e.target.value);
                  setDurationError(null);
                  setNotSaved(false);
                }}
                aria-invalid={durationError ? true : undefined}
                aria-describedby={durationError ? `${durationHelpId}-hint ${durationHelpId}-error` : `${durationHelpId}-hint`}
              />
            </div>
            <p className="field-hint" id={`${durationHelpId}-hint`}>
              {msg.durationHint}
            </p>
            {durationError ? (
              <p className="field-error" id={`${durationHelpId}-error`} role="alert">
                {durationError}
              </p>
            ) : null}
          </div>
        ) : null}

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
            setNotSaved(false);
          }}
          error={timeError ?? undefined}
        />

        <Notice>{msg.noJudgement}</Notice>

        <div className="save-block">
          <Button type="submit" variant="primary" className="btn-hero" busy={busy} disabled={kind === null}>
            <SaveIcon size={24} />
            {busy ? messages.shared.saving : msg.saveAction}
          </Button>
          {kind === null ? <p className="save-footnote">{msg.chooseToSave}</p> : null}
        </div>
      </form>
    </div>
  );
}
