"use client";

import { useCallback, useId, useState } from "react";
import type { VoiceLanguage } from "@/domain/voice/voice-contracts";
import { ModalDialog } from "../primitives/ModalDialog";
import { MedicineClarificationDialog, type VoiceMedicineOption } from "./MedicineClarificationDialog";
import type { VoiceRememberedTerm, VoiceTerminologyPort } from "./TellJagaOnScreen";
import type { VoiceScreenCopy } from "./voice-screen-copy";

/**
 * Terminology review Critical #1 (owner: change and forget handling, no extra management screens): the minimal "Words JagaOn
 * remembers" section of the Tell JagaOn screen, collapsed by default (a native disclosure, keyboard operable). Opening it lists the
 * remembered phrases of the screen's language → medicine name. Change reuses the clarification picker (without "remember") and calls
 * `terminology.change` with the listed revision as its head check (a stale change is refused and the list reloads). Forget asks
 * "Forget this word?" (the safe action, Keep it, is focused first; Escape keeps it) and calls `terminology.forget`, the existing
 * permanent deletion. Neither action records anything in the journal.
 */
type Entry = Readonly<{ term: VoiceRememberedTerm; name: string | null }>;

export function RememberedTermsSection({ terminology, copy, language }: { terminology: VoiceTerminologyPort; copy: VoiceScreenCopy; language: VoiceLanguage }) {
  const statusId = useId();
  const [entries, setEntries] = useState<readonly Entry[] | null>(null);
  const [options, setOptions] = useState<readonly VoiceMedicineOption[]>([]);
  const [status, setStatus] = useState("");
  const [forgetting, setForgetting] = useState<VoiceRememberedTerm | null>(null);
  const [changing, setChanging] = useState<VoiceRememberedTerm | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const [terms, medicines] = await Promise.all([terminology.list?.() ?? Promise.resolve([]), terminology.activeMedicines()]);
      const choices = medicines.map((entry) => ({ medication: entry.medication, name: entry.names[0] ?? "" })).filter((entry) => entry.name.length > 0);
      setOptions(choices);
      setEntries(terms.filter((term) => term.language === language).map((term) => ({ term, name: term.medication ? (choices.find((choice) => choice.medication.recordId === term.medication!.recordId)?.name ?? null) : null })));
    } catch {
      setEntries([]);
      setStatus(copy.terms.failed);
    }
  }, [terminology, language, copy]);

  async function forget(term: VoiceRememberedTerm) {
    setBusy(true);
    try {
      if (!terminology.forget) throw new Error("FORGET_UNAVAILABLE");
      const result = await terminology.forget({ recordId: term.recordId });
      setStatus(result.kind === "FORGOTTEN" ? copy.terms.forgotten : copy.terms.failed);
    } catch {
      setStatus(copy.terms.failed);
    } finally {
      setBusy(false);
      setForgetting(null);
      await load();
    }
  }

  async function change(term: VoiceRememberedTerm, choice: VoiceMedicineOption) {
    setBusy(true);
    try {
      if (!terminology.change) throw new Error("CHANGE_UNAVAILABLE");
      const result = await terminology.change({ recordId: term.recordId, expectedRevisionId: term.revisionId, medication: choice.medication });
      setStatus(result.kind === "COMMITTED" || result.kind === "NO_CHANGE" ? copy.terms.changed : result.kind === "REJECTED" && result.code === "HEAD_CONFLICT" ? copy.terms.stale : copy.terms.failed);
    } catch {
      setStatus(copy.terms.failed);
    } finally {
      setBusy(false);
      setChanging(null);
      await load();
    }
  }

  return (
    <details
      className="voice-remembered-terms"
      onToggle={(event) => {
        const isOpen = (event.currentTarget as HTMLDetailsElement).open;
        setOpen(isOpen);
        if (isOpen) {
          setStatus("");
          void load();
        }
      }}
    >
      <summary>{copy.terms.heading}</summary>
      {entries === null ? (
        <p>{copy.terms.loading}</p>
      ) : entries.length === 0 ? (
        <p>{copy.terms.empty}</p>
      ) : (
        <ul className="voice-remembered-list">
          {entries.map(({ term, name }) => (
            <li key={term.recordId}>
              <span>{name ? copy.terms.meaning(term.phrase, name) : copy.terms.dormant(term.phrase)}</span>
              <button type="button" className="btn btn-outline" disabled={busy} aria-describedby={statusId} onClick={() => setChanging(term)}>
                {copy.terms.change}
                <span className="sr-only"> “{term.phrase}”</span>
              </button>
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setForgetting(term)}>
                {copy.terms.forget}
                <span className="sr-only"> “{term.phrase}”</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {/* The section's own live region exists only while it is open (the screen's status line stays the only one otherwise). */}
      {open ? (
        <p id={statusId} role="status" className="voice-remembered-status">
          {status}
        </p>
      ) : null}

      {forgetting ? (
        <ModalDialog
          className="voice-forget-dialog"
          title={copy.terms.forgetTitle}
          description={<p>{copy.terms.forgetBody(forgetting.phrase)}</p>}
          onClose={() => setForgetting(null)}
          initialFocusSelector="[data-voice-forget-safe]"
          actions={
            <>
              <button type="button" className="btn btn-primary btn-wide" disabled={busy} onClick={() => void forget(forgetting)}>
                {copy.terms.forgetConfirm}
              </button>
              <button type="button" className="btn btn-outline btn-wide" data-voice-forget-safe="" onClick={() => setForgetting(null)}>
                {copy.terms.forgetCancel}
              </button>
            </>
          }
        >
          {null}
        </ModalDialog>
      ) : null}

      {changing ? (
        <MedicineClarificationDialog
          phrase={changing.phrase}
          title={copy.terms.changeTitle(changing.phrase)}
          rememberable={false}
          options={options}
          copy={copy}
          onLeaveOut={() => setChanging(null)}
          onChoose={(choice) => void change(changing, choice)}
        />
      ) : null}
    </details>
  );
}
