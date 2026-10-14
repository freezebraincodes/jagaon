"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { VoiceFactDecision } from "@/application/voice/voice-review-contract";
import { noteKindSentenceFor } from "@/domain/notes/note-kind-sentences";
import { VOICE_FEELING_TEXT_MAX_CODE_POINTS, type VoiceFeelingCandidate } from "@/domain/voice/voice-contracts";
import type { VoiceFactOutcome } from "./VoiceFactCard";
import type { VoiceScreenCopy } from "./voice-screen-copy";

/** What the feelings chat receives when she chooses "Talk it through": her (edited) words and the recognised cue keys. */
export type VoiceTalkItThroughInput = Readonly<{ text: string; cueKeys: readonly string[] }>;

/**
 * Owner decision 2026-10-14 (Tell JagaOn understands more, design §3.1 step 3): the Feeling card. Her words, editable; **Save as a
 * note** (a personal note through the review contract and the app's save port: her words plus the reviewed kind sentence) and
 * **Skip**. **Talk it through** is rendered ONLY when `onTalkItThrough` is given (the feelings chat, wired by the app); this card never
 * starts a chat or calls an AI itself. After saving, the reviewed kind sentence for her cues is shown, calmly, with where it was kept.
 */
type Props = Readonly<{
  candidate: VoiceFeelingCandidate;
  index: number;
  copy: VoiceScreenCopy;
  onDecide: (decision: VoiceFactDecision) => Promise<VoiceFactOutcome>;
  /** Review I-1: called on any interaction inside the card, so a pending remote merge is not applied over it. */
  onInteract?: () => void;
  /** The feelings chat (a separate track). Absent: no "Talk it through" button. */
  onTalkItThrough?: (feeling: VoiceTalkItThroughInput) => void;
}>;

export function VoiceFeelingCard({ candidate, index, copy, onDecide, onInteract, onTalkItThrough }: Props) {
  const ids = useId();
  const [text, setText] = useState(candidate.text);
  const [outcome, setOutcome] = useState<VoiceFactOutcome | "SKIPPED" | null>(null);
  const [busy, setBusy] = useState(false);
  const statusLine = useRef<HTMLDivElement>(null);
  const done = outcome === "SAVED" || outcome === "SKIPPED";
  const trimmed = text.trim();
  const valid = trimmed.length > 0 && [...trimmed].length <= VOICE_FEELING_TEXT_MAX_CODE_POINTS;

  useEffect(() => {
    if (outcome === "SAVED") statusLine.current?.focus();
  }, [outcome]);

  async function save() {
    if (busy || done || !valid) return;
    const decision: VoiceFactDecision = { candidateIndex: index, action: "SAVE", ...(trimmed !== candidate.text ? { edit: { kind: "FEELING_NOTE" as const, text: trimmed } } : {}) };
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
    <article className="card voice-fact-card voice-feeling-card" aria-labelledby={`${ids}-heading`} onClickCapture={onInteract} onChangeCapture={onInteract}>
      <h3 id={`${ids}-heading`} className="voice-fact-heading">
        {copy.feeling.heading}
      </h3>
      <div className="field">
        <label className="field-label" htmlFor={`${ids}-text`}>
          {copy.feeling.textLabel}
        </label>
        <textarea id={`${ids}-text`} className="input" rows={3} maxLength={VOICE_FEELING_TEXT_MAX_CODE_POINTS} value={text} disabled={done || busy} onChange={(event) => setText(event.target.value)} aria-invalid={!valid || undefined} aria-describedby={!valid ? `${ids}-text-error` : undefined} />
        {!valid && !done ? (
          <p id={`${ids}-text-error`} className="field-error">
            {copy.feeling.textRequired}
          </p>
        ) : null}
      </div>
      {!done ? (
        <div className="voice-fact-actions">
          {onTalkItThrough ? (
            <button type="button" className="btn btn-secondary" disabled={busy || !valid} onClick={() => onTalkItThrough({ text: trimmed, cueKeys: candidate.cueKeys })}>
              {copy.feeling.talkItThrough}
            </button>
          ) : null}
          <button type="button" className="btn btn-primary" disabled={busy || !valid} aria-busy={busy || undefined} onClick={() => void save()}>
            {copy.feeling.saveAsNote}
          </button>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setOutcome("SKIPPED")}>
            {copy.feeling.skip}
          </button>
        </div>
      ) : null}
      <div role="status" ref={statusLine} tabIndex={-1} className="voice-fact-status">
        {outcome === "SAVED" ? (
          <>
            <p className="voice-kind-sentence">{noteKindSentenceFor(candidate.cueKeys)}</p>
            <p>{copy.feeling.savedToNotes}</p>
          </>
        ) : outcome === "NOT_SAVED" || outcome === "REJECTED" ? (
          <p>{copy.feeling.notSaved}</p>
        ) : outcome === "SKIPPED" ? (
          <p>{copy.feeling.skipped}</p>
        ) : null}
      </div>
    </article>
  );
}
