"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { VoiceFactDecision } from "@/application/voice/voice-review-contract";
import { VOICE_ACTIVITY_MAX_MINUTES, voiceActivityTimePhrase } from "@/domain/voice/voice-activity-cues";
import type { VoiceActivityCandidate } from "@/domain/voice/voice-contracts";
import type { VoiceFactOutcome } from "./VoiceFactCard";
import type { VoiceScreenCopy } from "./voice-screen-copy";

/**
 * Owner decision 2026-10-14 (Tell JagaOn understands more, design §4): the Activity card. A short summary ("Walk · 30 minutes · after
 * dinner": the category name, the duration only when said or entered, and a time phrase from her words), her words as the label
 * (editable) and the minutes (editable, optional: whole minutes 1–1440 or empty), then **Save** (the existing activity command through
 * the review contract and the app's save port) or **Skip**. Nothing is inferred: no intensity, no time and no duration she did not say.
 */
export const VOICE_ACTIVITY_LABEL_MAX = 160;

type Props = Readonly<{
  candidate: VoiceActivityCandidate;
  index: number;
  copy: VoiceScreenCopy;
  onDecide: (decision: VoiceFactDecision) => Promise<VoiceFactOutcome>;
  onInteract?: () => void;
}>;

/** The minutes field: "" is no duration (null); whole minutes 1–1440 are a duration; anything else is invalid (undefined). */
function parseMinutes(raw: string): number | null | undefined {
  const value = raw.trim();
  if (value === "") return null;
  if (!/^\d{1,4}$/.test(value)) return undefined;
  const minutes = Number(value);
  return minutes >= 1 && minutes <= VOICE_ACTIVITY_MAX_MINUTES ? minutes : undefined;
}

export function VoiceActivityCard({ candidate, index, copy, onDecide, onInteract }: Props) {
  const ids = useId();
  const [label, setLabel] = useState(candidate.label);
  const [minutesText, setMinutesText] = useState(candidate.durationMinutes === null ? "" : String(candidate.durationMinutes));
  const [outcome, setOutcome] = useState<VoiceFactOutcome | "SKIPPED" | null>(null);
  const [busy, setBusy] = useState(false);
  const statusLine = useRef<HTMLParagraphElement>(null);
  const done = outcome === "SAVED" || outcome === "SKIPPED";
  const trimmed = label.trim();
  const minutes = parseMinutes(minutesText);
  const labelValid = trimmed.length > 0 && [...trimmed].length <= VOICE_ACTIVITY_LABEL_MAX;
  const valid = labelValid && minutes !== undefined;

  useEffect(() => {
    if (outcome === "SAVED") statusLine.current?.focus();
  }, [outcome]);

  const timePhrase = voiceActivityTimePhrase(trimmed);
  const summary = [copy.activity.categories[candidate.category], typeof minutes === "number" ? copy.activity.minutes(minutes) : copy.activity.noDuration, ...(timePhrase ? [timePhrase] : [])].join(" · ");

  async function save() {
    if (busy || done || !valid || minutes === undefined) return;
    const edited = trimmed !== candidate.label || minutes !== candidate.durationMinutes;
    const decision: VoiceFactDecision = { candidateIndex: index, action: "SAVE", ...(edited ? { edit: { kind: "ACTIVITY_NOTE" as const, label: trimmed, durationMinutes: minutes } } : {}) };
    setBusy(true);
    try {
      setOutcome(await onDecide(decision));
    } catch {
      setOutcome("NOT_SAVED");
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="card voice-fact-card voice-activity-card" aria-labelledby={`${ids}-heading`} onClickCapture={onInteract} onChangeCapture={onInteract}>
      <h3 id={`${ids}-heading`} className="voice-fact-heading">
        {copy.activity.heading}
      </h3>
      <p className="voice-fact-value voice-activity-summary">{summary}</p>
      <div className="field">
        <label className="field-label" htmlFor={`${ids}-label`}>
          {copy.activity.labelLabel}
        </label>
        <input id={`${ids}-label`} className="input" maxLength={VOICE_ACTIVITY_LABEL_MAX} value={label} disabled={done || busy} onChange={(event) => setLabel(event.target.value)} aria-invalid={!labelValid || undefined} aria-describedby={!labelValid ? `${ids}-label-error` : undefined} />
        {!labelValid && !done ? (
          <p id={`${ids}-label-error`} className="field-error">
            {copy.activity.labelRequired}
          </p>
        ) : null}
      </div>
      <div className="field">
        <label className="field-label" htmlFor={`${ids}-minutes`}>
          {copy.activity.durationLabel}
        </label>
        <input
          id={`${ids}-minutes`}
          className="input"
          inputMode="numeric"
          autoComplete="off"
          value={minutesText}
          disabled={done || busy}
          onChange={(event) => setMinutesText(event.target.value)}
          aria-invalid={minutes === undefined || undefined}
          aria-describedby={`${ids}-minutes-hint${minutes === undefined ? ` ${ids}-minutes-error` : ""}`}
        />
        <p id={`${ids}-minutes-hint`} className="field-hint">
          {copy.activity.durationHint}
        </p>
        {minutes === undefined && !done ? (
          <p id={`${ids}-minutes-error`} className="field-error">
            {copy.activity.durationInvalid}
          </p>
        ) : null}
      </div>
      {!done ? (
        <div className="voice-fact-actions">
          <button type="button" className="btn btn-primary" disabled={busy || !valid} aria-busy={busy || undefined} onClick={() => void save()}>
            {copy.activity.save}
          </button>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setOutcome("SKIPPED")}>
            {copy.activity.skip}
          </button>
        </div>
      ) : null}
      <p role="status" ref={statusLine} tabIndex={-1} className="voice-fact-status">
        {outcome === "SAVED" ? copy.activity.saved : outcome === "NOT_SAVED" || outcome === "REJECTED" ? copy.activity.notSaved : outcome === "SKIPPED" ? copy.activity.skipped : ""}
      </p>
    </article>
  );
}
