"use client";

import { useEffect, useRef, useState } from "react";
import type { FeelingsChatPort, FeelingsChatTurnResult } from "@/application/feelings-chat/feelings-chat-port";
import { isFeelingsChatCreditLimit } from "@/application/feelings-chat/feelings-chat-route-contract";
import { fallbackQuestion, feelingsChatBankReply, kindSentenceFor } from "@/domain/feelings-chat/feelings-chat-bank";
import { FEELINGS_CHAT_MAX_TURNS, FEELINGS_CHAT_MESSAGE_MAX_CHARS, FEELINGS_CHAT_TASK, isFeelingsChatSafetyStop, type FeelingsChatMessage } from "@/domain/feelings-chat/feelings-chat-contract";
import { FEELINGS_CHAT_PROMPT_VERSION } from "@/domain/feelings-chat/feelings-chat-prompt";
import type { NoteThemeKey } from "@/domain/notes/note-themes";
import type { AppMessages } from "@/i18n/types";
import { ModalDialog } from "../primitives/ModalDialog";
import { TextareaField } from "../primitives/Field";
import { FeelingsChatVoiceAnswer, type FeelingsChatVoice } from "./FeelingsChatVoiceAnswer";

export type FeelingsChatTurnRole = "PATIENT" | "JAGAON_QUESTION" | "JAGAON_KIND_SENTENCE";
export type FeelingsChatTurnSource = "PATIENT" | "AI_VALIDATED" | "REVIEWED_BANK";
export type FeelingsChatNoteTurn = Readonly<{ role: FeelingsChatTurnRole; text: string; source: FeelingsChatTurnSource }>;

/** What the dialog asks the caller to save (the personal-note payload minus storage fields such as language and the care-question link). */
export type FeelingsChatNote = Readonly<{
  /** The summary she approved, or (saved without AI) her own first words. */
  text: string;
  feelingCues: readonly string[];
  /** Her first words, the kind sentence, then each question and her answer, in order (at most 6 lines). */
  turns: readonly FeelingsChatNoteTurn[];
  themes: readonly NoteThemeKey[];
  /** True only when at least one shown line came from the AI (after validation). */
  aiUsed: boolean;
  /** `feelings-chat-prompt.1` when aiUsed, else null. */
  promptVersion: string | null;
}>;

export type FeelingsChatDialogProps = {
  messages: AppMessages;
  /** Her words from Tell JagaOn (already through the distress gate once). */
  initialText: string;
  /** The recognised feeling cues ("tired", "worried"); they pick the reviewed kind sentence and are saved with the note. */
  cueKeys: readonly string[];
  /** The chat port: the browser client of /api/ai/feelings, or the fake port. */
  chat: FeelingsChatPort;
  /** The deterministic distress gate (Track A); runs on EVERY answer and edited text before anything is sent or saved. */
  detectDistress: (text: string) => boolean;
  /** Called instead of continuing when distress is detected (or the AI's safety stop arrives); the dialog then closes and saves nothing. */
  onDistress: () => void;
  /** Saves the note; resolves true when saved. */
  onSave: (note: FeelingsChatNote) => Promise<boolean>;
  /** Adds her doctor question (unticked) to Prepare for my appointment; resolves true when added. */
  onAddDoctorQuestion: (text: string) => Promise<boolean>;
  /** Closes without saving (Escape, "Don't save", "Done"). */
  onClose: () => void;
  /**
   * Owner decision 2026-10-14: "Speak my answer" (the same voice provider, notice and session as Tell JagaOn). Her spoken words go
   * through the distress gate, then into the answer box; she still checks them and taps Send. Absent: typing only.
   */
  voice?: FeelingsChatVoice;
};

type Phase = "NOTICE" | "CHAT" | "WRAP_UP" | "SAVED" | "ENDED";
/** `doctorFromAi`: the doctor-question box holds the AI's validated draft (else it is empty, under the bank's turn-3 question). */
type WrapUp = Readonly<{ fromAi: boolean; themes: readonly NoteThemeKey[]; doctorDraftOffered: boolean; doctorFromAi: boolean }>;
type DoctorState = "OPEN" | "ADDING" | "ADDED" | "DECLINED" | "FAILED";

/**
 * Tell JagaOn understands more (design §3.1, steps 4–7): the feelings chat, a self-contained modal dialog. It reads, stores and sends
 * nothing itself: the chat port, the distress gate and the two save callbacks are injected.
 *
 * Flow:
 * (a) the AI notice (owner-approved wording) with "Continue" and "Save as a note without AI";
 * (b) the reviewed kind sentence (bank, chosen by her feeling cues), then JagaOn's question for turn 1 (AI-validated, else the bank);
 *     she answers in a text box ("Send"), or taps "Skip" or "End chat";
 * (c) every answer (and the summary or doctor question she edits) goes through `detectDistress` FIRST: a match calls `onDistress()`
 *     and the dialog closes without saving; the AI's own safety stop does the same;
 * (d) at most 3 turns (questions at turns 1 and 2, the wrap-up at turn 3, or earlier on "End chat" or when she says she is done);
 *     the wrap-up shows an editable summary and, when the AI drafted one (or with the bank's turn-3 question when the AI was
 *     unavailable, or when the rules dropped the AI's doctor question and kept its summary), an editable doctor question with "Add to
 *     my questions" / "No, thanks"; then "Save note";
 * (e) "Save as a note without AI" saves at once: her words and the kind sentence, `aiUsed: false`.
 * Focus moves to the answer box with each question, to the summary at the wrap-up and to "Done" after saving; questions, the loading
 * state and the results are announced in a polite live region. Escape closes without saving.
 */
export function FeelingsChatDialog({ messages, initialText, cueKeys, chat, detectDistress, onDistress, onSave, onAddDoctorQuestion, onClose, voice }: FeelingsChatDialogProps) {
  const t = messages.feelingsChat;
  const kind = kindSentenceFor(cueKeys);
  const feelingCues = [...new Set(cueKeys.map((cue) => cue.trim().toLowerCase()).filter((cue) => cue.length > 0))];
  const firstWords = initialText.trim();

  const [phase, setPhase] = useState<Phase>("NOTICE");
  const [turns, setTurns] = useState<readonly FeelingsChatNoteTurn[]>([]);
  const [history, setHistory] = useState<readonly FeelingsChatMessage[]>([]);
  const [turn, setTurn] = useState(1);
  const [question, setQuestion] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [answer, setAnswer] = useState("");
  const [fallbackShown, setFallbackShown] = useState(false);
  const [creditLimit, setCreditLimit] = useState(false);
  const [aiUsed, setAiUsed] = useState(false);
  const [wrapUp, setWrapUp] = useState<WrapUp | null>(null);
  const [summary, setSummary] = useState("");
  const [doctorDraft, setDoctorDraft] = useState("");
  const [doctorState, setDoctorState] = useState<DoctorState>("OPEN");
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  // True while "Speak my answer" is open (notice, recording); Send, Skip and End chat wait for it.
  const [voiceBusy, setVoiceBusy] = useState(false);

  const mounted = useRef(true);
  const inFlight = useRef<AbortController | null>(null);
  const answerRef = useRef<HTMLTextAreaElement>(null);
  const summaryRef = useRef<HTMLTextAreaElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      inFlight.current?.abort();
    };
  }, []);

  // Focus stays in the answer box for the whole chat (also while JagaOn is thinking, when the buttons are disabled).
  useEffect(() => {
    if (phase === "CHAT" && !voiceBusy) answerRef.current?.focus();
  }, [phase, question, loading, voiceBusy]);
  useEffect(() => {
    if (phase === "WRAP_UP") summaryRef.current?.focus();
    if (phase === "SAVED") doneRef.current?.focus();
  }, [phase]);

  function stopForDistress() {
    inFlight.current?.abort();
    setPhase("ENDED");
    onDistress();
  }

  async function requestTurn(nextTurn: number, chatHistory: readonly FeelingsChatMessage[], chatTurns: readonly FeelingsChatNoteTurn[]) {
    const request = { task: FEELINGS_CHAT_TASK, turn: Math.min(nextTurn, FEELINGS_CHAT_MAX_TURNS), maxTurns: FEELINGS_CHAT_MAX_TURNS, messages: chatHistory.map((message) => ({ ...message })) };
    const controller = new AbortController();
    inFlight.current = controller;
    setQuestion(null);
    setLoading(true);
    setAnnouncement(t.loading);
    let result: FeelingsChatTurnResult;
    try {
      result = await chat.nextTurn(request, controller.signal);
    } catch {
      result = { source: "REVIEWED_BANK", reply: feelingsChatBankReply(request), reason: "UPSTREAM_ERROR" };
    }
    if (!mounted.current || controller.signal.aborted) return;
    inFlight.current = null;
    setLoading(false);
    const fromAi = result.source === "AI_VALIDATED";
    if (result.source === "AI_VALIDATED" && isFeelingsChatSafetyStop(result.reply)) {
      stopForDistress();
      return;
    }
    if (result.source === "AI_VALIDATED") setAiUsed(true);
    else {
      setFallbackShown(true);
      if (isFeelingsChatCreditLimit(result.reason)) setCreditLimit(true);
    }
    const reply = result.reply;
    if (reply.kind === "QUESTION" && reply.question !== null && request.turn < FEELINGS_CHAT_MAX_TURNS) {
      setTurn(request.turn);
      setQuestion(reply.question);
      setTurns([...chatTurns, { role: "JAGAON_QUESTION", text: reply.question, source: fromAi ? "AI_VALIDATED" : "REVIEWED_BANK" }]);
      setAnnouncement(t.questionAnnouncement(reply.question));
      return;
    }
    // The wrap-up (a QUESTION at the last turn cannot pass the validator; the bank wraps up locally then).
    const final = reply.kind === "WRAP_UP" ? reply : feelingsChatBankReply({ ...request, turn: FEELINGS_CHAT_MAX_TURNS });
    const wrapFromAi = fromAi && reply.kind === "WRAP_UP";
    // Owner decision 2026-10-14: when the rules dropped the AI's doctor question, the summary is kept and she is offered the empty box
    // under the bank's turn-3 question instead (as when the AI is unavailable); the dropped draft is never shown.
    const doctorDropped = result.source === "AI_VALIDATED" && result.doctorQuestionDropped !== undefined;
    const doctorFromAi = wrapFromAi && final.doctorQuestion !== null;
    setTurns(chatTurns);
    setWrapUp({ fromAi: wrapFromAi, themes: wrapFromAi ? final.themes : [], doctorDraftOffered: wrapFromAi ? doctorFromAi || doctorDropped : true, doctorFromAi });
    setSummary(final.summary ?? firstWords);
    setDoctorDraft(doctorFromAi ? (final.doctorQuestion ?? "") : "");
    setDoctorState("OPEN");
    setAnnouncement(t.wrapUpTitle);
    setPhase("WRAP_UP");
  }

  function start() {
    if (detectDistress(initialText)) return stopForDistress();
    const opening: FeelingsChatNoteTurn[] = [
      { role: "PATIENT", text: firstWords, source: "PATIENT" },
      { role: "JAGAON_KIND_SENTENCE", text: kind.text, source: "REVIEWED_BANK" },
    ];
    const chatHistory: FeelingsChatMessage[] = [{ role: "patient", text: firstWords.slice(0, FEELINGS_CHAT_MESSAGE_MAX_CHARS) }];
    setTurns(opening);
    setHistory(chatHistory);
    setPhase("CHAT");
    void requestTurn(1, chatHistory, opening);
  }

  /** Her spoken answer: the distress gate first; then it joins what she already typed, for her to check and send. */
  function spokenAnswer(text: string) {
    if (detectDistress(text)) return stopForDistress();
    setAnswer((current) => (current.trim().length > 0 ? `${current.trimEnd()} ${text}` : text).slice(0, FEELINGS_CHAT_MESSAGE_MAX_CHARS));
    answerRef.current?.focus();
  }

  /** Her answer (if any) joins the chat after the distress gate; then the next turn (or the wrap-up when `finish`). */
  function advance(kindOfStep: "SEND" | "SKIP" | "END") {
    if (loading || question === null || voiceBusy) return;
    const text = kindOfStep === "SKIP" ? "" : answer.trim();
    if (kindOfStep === "SEND" && text.length === 0) return;
    if (text.length > 0 && detectDistress(text)) return stopForDistress();
    let chatHistory = history;
    let chatTurns = turns;
    if (text.length > 0) {
      chatHistory = [...history, { role: "jagaon_question", text: question }, { role: "patient", text }];
      chatTurns = [...turns, { role: "PATIENT", text, source: "PATIENT" }];
    }
    // A skipped question is kept in her note but not sent again: the history she sends keeps alternating.
    setHistory(chatHistory);
    setTurns(chatTurns);
    setAnswer("");
    void requestTurn(kindOfStep === "END" ? FEELINGS_CHAT_MAX_TURNS : turn + 1, chatHistory, chatTurns);
  }

  async function addDoctorQuestion() {
    const text = doctorDraft.trim();
    if (text.length === 0 || doctorState === "ADDING") return;
    if (detectDistress(text)) return stopForDistress();
    setDoctorState("ADDING");
    let added = false;
    try {
      added = await onAddDoctorQuestion(text);
    } catch {
      added = false;
    }
    if (!mounted.current) return;
    setDoctorState(added ? "ADDED" : "FAILED");
    setAnnouncement(added ? t.questionAdded : t.questionNotAdded);
  }

  async function save(note: FeelingsChatNote) {
    if (saving) return;
    setSaving(true);
    setSaveFailed(false);
    let saved = false;
    try {
      saved = await onSave(note);
    } catch {
      saved = false;
    }
    if (!mounted.current) return;
    setSaving(false);
    if (saved) {
      setAnnouncement(t.saved);
      setPhase("SAVED");
    } else {
      setSaveFailed(true);
      setAnnouncement(t.saveFailed);
    }
  }

  function saveWithoutAi() {
    if (detectDistress(initialText)) return stopForDistress();
    void save({
      text: firstWords,
      feelingCues,
      turns: [
        { role: "PATIENT", text: firstWords, source: "PATIENT" },
        { role: "JAGAON_KIND_SENTENCE", text: kind.text, source: "REVIEWED_BANK" },
      ],
      themes: [],
      aiUsed: false,
      promptVersion: null,
    });
  }

  function saveNote() {
    const text = summary.trim();
    if (text.length === 0 || wrapUp === null) return;
    if (detectDistress(text)) return stopForDistress();
    const used = aiUsed || wrapUp.fromAi;
    void save({ text, feelingCues, turns, themes: wrapUp.themes, aiUsed: used, promptVersion: used ? FEELINGS_CHAT_PROMPT_VERSION : null });
  }

  if (phase === "ENDED") return null;

  const live = (
    <p className="sr-only" aria-live="polite" data-feelings-chat-live="">
      {announcement}
    </p>
  );
  const notices = fallbackShown ? (
    <p className="feelings-chat-fallback-notice" data-feelings-chat-fallback="">
      {creditLimit ? t.creditLimitNotice : t.fallbackNotice}
    </p>
  ) : null;

  if (phase === "NOTICE") {
    return (
      <ModalDialog
        className="feelings-chat-dialog"
        title={t.title}
        description={<p>{t.notice}</p>}
        onClose={onClose}
        initialFocusSelector="[data-feelings-chat-continue]"
        actions={
          <>
            <button type="button" className="btn btn-primary btn-wide" data-feelings-chat-continue="" disabled={saving} onClick={start}>
              {t.continue}
            </button>
            <button type="button" className="btn btn-outline btn-wide" disabled={saving} aria-busy={saving || undefined} onClick={saveWithoutAi}>
              {t.saveWithoutAi}
            </button>
          </>
        }
      >
        {saveFailed ? <p role="alert">{t.saveFailed}</p> : null}
        {live}
      </ModalDialog>
    );
  }

  const transcript = (
    <ol className="feelings-chat-transcript" aria-label={t.title}>
      {turns.map((line, index) => (
        <li key={index} className={line.role === "PATIENT" ? "feelings-chat-line feelings-chat-line-patient" : "feelings-chat-line feelings-chat-line-jagaon"}>
          <span className="feelings-chat-speaker">{line.role === "PATIENT" ? t.you : t.jagaon}</span> <span className="feelings-chat-text">{line.text}</span>
        </li>
      ))}
    </ol>
  );

  if (phase === "CHAT") {
    return (
      <ModalDialog
        className="feelings-chat-dialog"
        title={t.title}
        onClose={onClose}
        actions={
          <>
            <button type="button" className="btn btn-primary btn-wide" disabled={loading || question === null || voiceBusy || answer.trim().length === 0} onClick={() => advance("SEND")}>
              {t.send}
            </button>
            <button type="button" className="btn btn-outline btn-wide" disabled={loading || question === null || voiceBusy} onClick={() => advance("SKIP")}>
              {t.skip}
            </button>
            <button type="button" className="btn btn-ghost btn-wide" disabled={loading || question === null || voiceBusy} onClick={() => advance("END")}>
              {t.endChat}
            </button>
          </>
        }
      >
        {transcript}
        {loading ? <p role="status">{t.loading}</p> : null}
        {notices}
        <TextareaField
          ref={answerRef}
          label={t.answerLabel}
          value={answer}
          maxLength={FEELINGS_CHAT_MESSAGE_MAX_CHARS}
          rows={3}
          // Read-only (not disabled) while JagaOn is thinking, so focus can stay in the answer box inside the dialog.
          readOnly={loading || question === null || voiceBusy}
          aria-busy={loading || undefined}
          onChange={(event) => setAnswer(event.target.value)}
        />
        {voice ? <FeelingsChatVoiceAnswer voice={voice} labels={t} disabled={loading || question === null} onTranscript={spokenAnswer} onBusyChange={setVoiceBusy} /> : null}
        {live}
      </ModalDialog>
    );
  }

  if (phase === "SAVED") {
    return (
      <ModalDialog
        className="feelings-chat-dialog"
        title={t.wrapUpTitle}
        onClose={onClose}
        actions={
          <button ref={doneRef} type="button" className="btn btn-primary btn-wide" onClick={onClose}>
            {t.done}
          </button>
        }
      >
        <p role="status">{t.saved}</p>
      </ModalDialog>
    );
  }

  // WRAP_UP
  const doctorOffered = wrapUp?.doctorDraftOffered === true && doctorState !== "DECLINED";
  return (
    <ModalDialog
      className="feelings-chat-dialog"
      title={t.wrapUpTitle}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn btn-primary btn-wide" disabled={saving || summary.trim().length === 0} aria-busy={saving || undefined} onClick={saveNote}>
            {saving ? t.saving : t.saveNote}
          </button>
          <button type="button" className="btn btn-outline btn-wide" disabled={saving} onClick={onClose}>
            {t.dontSave}
          </button>
        </>
      }
    >
      {transcript}
      {notices}
      <TextareaField ref={summaryRef} label={t.summaryLabel} hint={t.summaryHint} value={summary} maxLength={1000} rows={2} onChange={(event) => setSummary(event.target.value)} />
      {doctorOffered ? (
        <div className="feelings-chat-doctor-question">
          <TextareaField
            label={wrapUp?.doctorFromAi ? t.doctorQuestionTitle : fallbackQuestion(FEELINGS_CHAT_MAX_TURNS)}
            hint={t.doctorQuestionHint}
            value={doctorDraft}
            maxLength={1000}
            rows={2}
            disabled={doctorState === "ADDING" || doctorState === "ADDED"}
            onChange={(event) => setDoctorDraft(event.target.value)}
          />
          {doctorState === "ADDED" ? (
            <p role="status">{t.questionAdded}</p>
          ) : (
            <div className="button-row">
              <button type="button" className="btn btn-outline" disabled={doctorState === "ADDING" || doctorDraft.trim().length === 0} aria-busy={doctorState === "ADDING" || undefined} onClick={() => void addDoctorQuestion()}>
                {t.addToQuestions}
              </button>
              <button type="button" className="btn btn-ghost" disabled={doctorState === "ADDING"} onClick={() => setDoctorState("DECLINED")}>
                {t.noThanks}
              </button>
            </div>
          )}
          {doctorState === "FAILED" ? <p role="alert">{t.questionNotAdded}</p> : null}
        </div>
      ) : null}
      {saveFailed ? <p role="alert">{t.saveFailed}</p> : null}
      {live}
    </ModalDialog>
  );
}
