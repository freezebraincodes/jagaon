"use client";

import { useCallback, useEffect, useId, useMemo, useReducer, useRef, useState } from "react";
import { reviewVoiceCandidates, type VoiceFactDecision, type VoiceSaveIntent } from "@/application/voice/voice-review-contract";
import { VOICE_DISCLOSURE_INITIAL_STATE, voiceDisclosureReducer } from "@/application/voice/voice-cloud-disclosure";
import { createVoiceSessionController, type VoiceSessionController, type VoiceSessionSnapshot, type VoiceTimers } from "@/application/voice/voice-session-controller";
import type { VoiceTranscriberPort } from "@/application/voice/voice-transcriber-port";
import { analyseTranscript, type VoiceMedicineDirectory } from "@/domain/voice/voice-candidate-extractor";
import type { VoiceAnalysis, VoiceCandidate, VoiceFactCandidate, VoiceLanguage, VoiceMedicationRef, VoiceRedirectCategory } from "@/domain/voice/voice-contracts";
import { gateRemoteTranscriptExtraction } from "@/domain/voice/voice-remote-extraction-gate";
import { mergeRemoteCandidates } from "./voice-remote-merge";
import type { AppMessages, SupportedLocale } from "@/i18n/types";
import { ModalDialog } from "../primitives/ModalDialog";
import { ScreenHeader } from "../primitives/ScreenHeader";
import type { VoiceMedicineOption } from "./MedicineClarificationDialog";
import { VoiceFactCard, type VoiceFactOutcome } from "./VoiceFactCard";
import { RememberedTermsSection } from "./RememberedTermsSection";
import { voiceScreenCopy } from "./voice-screen-copy";

/**
 * Packet 13 (P13S step 4): the Tell JagaOn screen. Everything app-specific arrives through props, so the app, the component tests and
 * the isolated e2e harness render the same screen.
 *
 * Flow: the voice-cloud disclosure (before EVERY microphone start, with the in-memory demo passcode) → the transcriber is loaded by
 * `loadTranscriber` ONLY after acceptance → listening (interim text display-only) → stop → deterministic analysis with the patient's
 * remembered terms → review: separate fact cards, each saved only by its own explicit Save through `onSaveFacts`; unsupported parts
 * shown as not understood; a dose, treatment or health question shown as the fixed neutral redirect. Every state but review offers
 * manual entry.
 * - Voice off: `voiceAvailable={false}` (app-level) shows "unavailable" plus manual entry with no microphone, credential request or
 *   session. Review I-5: `checkAvailability` (the credential-free probe) runs when the screen opens and on each restart, BEFORE the
 *   disclosure; false or any failure shows "unavailable" plus manual entry at once (no disclosure, passcode, microphone, UserSig or
 *   session). Server-side off also answers a credential request with VOICE_DISABLED, shown the same way.
 * - Review I-1: a remote merge is applied only when no card was saved or touched since the request started; otherwise the local result
 *   is kept as it is (no remount, no reset choices, no second save).
 * - Review I-2: Discard after a save says the saved items stay in the records (never "nothing was saved").
 * - The temporary transcript lives in this component's memory only; it is cleared on discard, close and unmount. Late results are
 *   discarded by the session controller; the microphone is released on stop, cancel, timeout and unmount.
 * - Nothing is simulated: the screen never shows a transcript or a fact it did not receive.
 */
export type VoiceRememberedTerm = Readonly<{ recordId: string; revisionId: string; language: VoiceLanguage; phrase: string; medication: VoiceMedicationRef | null }>;
export type VoiceTerminologyPort = Readonly<{
  directory(language: VoiceLanguage): Promise<VoiceMedicineDirectory>;
  activeMedicines(): Promise<ReadonlyArray<Readonly<{ medication: VoiceMedicationRef; names: readonly string[] }>>>;
  remember(input: Readonly<{ language: VoiceLanguage; phrase: string; medication: VoiceMedicationRef }>): Promise<Readonly<{ kind: string }>>;
  /**
   * Terminology review Critical #1: list, change (with its head check) and forget (the existing permanent deletion). The "Words JagaOn
   * remembers" section is shown only when all three are present.
   */
  list?(): Promise<readonly VoiceRememberedTerm[]>;
  change?(input: Readonly<{ recordId: string; expectedRevisionId: string; medication: VoiceMedicationRef }>): Promise<Readonly<{ kind: string; code?: string }>>;
  forget?(input: Readonly<{ recordId: string }>): Promise<Readonly<{ kind: string }>>;
}>;

export type VoiceSaveOutcome = Readonly<{ kind: "SAVED" }> | Readonly<{ kind: "NOT_SAVED" }>;
export type VoiceRemoteExtraction = (transcript: string, language: VoiceLanguage, signal: AbortSignal) => Promise<Readonly<{ kind: "CANDIDATES"; candidates: readonly VoiceCandidate[] }> | Readonly<{ kind: "UNAVAILABLE" | "WITHHELD" | "DECLINED" }>>;
export type VoiceManualEntryKind = "GLUCOSE" | "MEAL" | "MEDICATION";

export type TellJagaOnScreenProps = Readonly<{
  messages: AppMessages;
  locale: SupportedLocale;
  /** App-level availability; false shows "unavailable" at once (no microphone, credential request or session). */
  voiceAvailable?: boolean;
  /**
   * Review I-5: the credential-free availability probe (production: `checkTrtcVoiceAvailability`). Called when the screen opens and on
   * restart; false or a rejection shows "unavailable" plus manual entry before any disclosure. Absent: only `voiceAvailable` applies.
   */
  checkAvailability?: () => Promise<boolean>;
  /** Called only after the disclosure is accepted (the production loader uses dynamic imports). */
  loadTranscriber: (accessPasscode: () => string | null) => Promise<VoiceTranscriberPort>;
  terminology: VoiceTerminologyPort;
  /** The app's effective glucose ENTRY unit (fixed mmol/L in this slice; owner decision #2). */
  glucoseEntryUnit: "MMOL_PER_L" | null;
  /** One explicitly confirmed fact → the existing journal command (wired by the app; never called without a Save). */
  onSaveFacts: (intent: VoiceSaveIntent) => Promise<VoiceSaveOutcome>;
  onManualEntry: (kind: VoiceManualEntryKind) => void;
  onClose: () => void;
  /**
   * Owner decision #4: whether `onSaveFacts` stores a reported amount (a TAKEN event's known amount). Default false: the card then says
   * plainly that the amount will not be saved and offers manual entry; it never drops the amount silently.
   */
  reportedAmountSaved?: boolean;
  /**
   * Optional remote transcript extraction (stream 1's client). Offered only after the local analysis, only when the remote-extraction
   * gate PERMITs the transcript (never treatment-question content), only before any fact was saved, and only after its own per-request
   * disclosure (the transcript text goes to DeepSeek). Remote candidates are merged under the local floor (voice-remote-merge.ts); any
   * failure keeps the local result. Absent: never offered.
   */
  remoteExtraction?: VoiceRemoteExtraction;
  timers?: VoiceTimers;
  startTimeoutMs?: number;
  maxSessionSeconds?: number;
}>;

type Ended = "DECLINED" | "CANCELLED" | "DONE_SAVED" | "TIMED_OUT" | "PERMISSION_DENIED" | "UNSUPPORTED" | "UNAVAILABLE" | "ACCESS_DENIED" | "NOT_UNDERSTOOD";
type Phase =
  | { kind: "CHECKING" }
  | { kind: "DISCLOSURE" }
  | { kind: "SESSION" }
  | { kind: "REVIEW"; transcript: string; analysis: Extract<VoiceAnalysis, { kind: "ANALYSED" }>; sessionToken: number; medicines: readonly VoiceMedicineOption[]; directory: VoiceMedicineDirectory; generation: number }
  | { kind: "REDIRECT"; transcript: string; category: VoiceRedirectCategory }
  | { kind: "ENDED"; reason: Ended };

const DEFAULT_TIMERS: VoiceTimers = Object.freeze({
  setTimeout: (callback: () => void, ms: number) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
});

function endedFor(snapshot: VoiceSessionSnapshot): Ended {
  if (snapshot.state === "CANCELLED") return "CANCELLED";
  if (snapshot.state === "TIMED_OUT") return "TIMED_OUT";
  if (snapshot.failureReason === "PERMISSION_DENIED") return "PERMISSION_DENIED";
  if (snapshot.failureReason === "UNSUPPORTED_BROWSER") return "UNSUPPORTED";
  if (snapshot.failureReason === "CREDENTIAL_REFUSED" && snapshot.credentialRefusal === "ACCESS_DENIED") return "ACCESS_DENIED";
  return "UNAVAILABLE";
}

export function TellJagaOnScreen(props: TellJagaOnScreenProps) {
  const { messages, locale, voiceAvailable = true, loadTranscriber, terminology, glucoseEntryUnit, onSaveFacts, onManualEntry, onClose } = props;
  const copy = useMemo(() => voiceScreenCopy(messages, locale), [messages, locale]);
  const language: VoiceLanguage = locale === "zh-SG" ? "zh" : "en";
  const passcodeId = useId();
  const [disclosure, dispatchDisclosure] = useReducer(voiceDisclosureReducer, VOICE_DISCLOSURE_INITIAL_STATE);
  const [phase, setPhase] = useState<Phase>(() => (!voiceAvailable ? { kind: "ENDED", reason: "UNAVAILABLE" } : props.checkAvailability ? { kind: "CHECKING" } : { kind: "DISCLOSURE" }));
  const [snapshot, setSnapshot] = useState<VoiceSessionSnapshot | null>(null);
  const [entered, setEntered] = useState("");
  const passcode = useRef<string | null>(null);
  const controller = useRef<VoiceSessionController | null>(null);
  const mounted = useRef(true);
  const remoteAbort = useRef<AbortController | null>(null);
  const [remote, setRemote] = useState<"IDLE" | "ASKING" | "CHECKING" | "DONE" | "KEPT_LOCAL">("IDLE");
  const [anySaved, setAnySaved] = useState(false);
  // Review I-1: counts saves and interactions inside the cards; a remote result is merged only if this did not change meanwhile.
  const touches = useRef(0);
  const touch = useCallback(() => {
    touches.current += 1;
  }, []);

  // Review I-5: the availability probe (fail closed) before any disclosure, on open and on every restart.
  const { checkAvailability } = props;
  useEffect(() => {
    if (phase.kind !== "CHECKING" || !checkAvailability) return;
    let current = true;
    void checkAvailability()
      .then((available) => available === true, () => false)
      .then((available) => {
        if (current && mounted.current) setPhase(available ? { kind: "DISCLOSURE" } : { kind: "ENDED", reason: "UNAVAILABLE" });
      });
    return () => {
      current = false;
    };
  }, [phase.kind, checkAvailability]);

  // The disclosure is shown before every start (one grant per start).
  useEffect(() => {
    if (voiceAvailable && phase.kind === "DISCLOSURE" && disclosure.kind === "IDLE") dispatchDisclosure({ type: "REQUEST_START", language });
  }, [voiceAvailable, phase.kind, disclosure.kind, language]);

  // A locale change makes an open disclosure moot.
  const firstLocale = useRef(locale);
  useEffect(() => {
    if (locale !== firstLocale.current) dispatchDisclosure({ type: "LOCALE_CHANGED" });
  }, [locale]);

  // Unmount: cancel (releases the microphone), drop every transcript, forget the passcode.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      remoteAbort.current?.abort();
      const current = controller.current;
      controller.current = null;
      passcode.current = null;
      if (current) {
        void current.cancel().finally(() => current.discardTranscript());
      }
    };
  }, []);

  const finishSession = useCallback(
    async (session: VoiceSessionController, next: VoiceSessionSnapshot) => {
      if (next.state !== "COMPLETED") {
        if (mounted.current) setPhase({ kind: "ENDED", reason: endedFor(next) });
        return;
      }
      const transcript = session.takeTranscript() ?? "";
      try {
        const [directory, medicines] = await Promise.all([terminology.directory(language), terminology.activeMedicines()]);
        const analysis = analyseTranscript(transcript, language, { medicines: directory, glucoseEntryUnit });
        if (!mounted.current) return;
        if (analysis.kind === "REDIRECT") return setPhase({ kind: "REDIRECT", transcript, category: analysis.category });
        if (analysis.kind !== "ANALYSED" || analysis.candidates.length === 0) return setPhase({ kind: "ENDED", reason: "NOT_UNDERSTOOD" });
        setRemote("IDLE");
        setAnySaved(false);
        setPhase({ kind: "REVIEW", transcript, analysis, sessionToken: next.sessionToken, medicines: medicines.map((entry) => ({ medication: entry.medication, name: entry.names[0] ?? "" })).filter((entry) => entry.name.length > 0), directory, generation: 0 });
      } catch {
        if (mounted.current) setPhase({ kind: "ENDED", reason: "NOT_UNDERSTOOD" });
      }
    },
    [terminology, language, glucoseEntryUnit],
  );

  async function accept() {
    if (disclosure.kind !== "SHOWN" || entered.trim().length === 0) return;
    passcode.current = entered;
    setEntered("");
    // The accepted disclosure's one-shot grant is used for exactly this start; the model then returns to IDLE (shown again next time).
    const accepted = voiceDisclosureReducer(disclosure, { type: "ACCEPT" });
    if (accepted.kind !== "GRANTED") return;
    dispatchDisclosure({ type: "RESET" });
    setPhase({ kind: "SESSION" });
    let transcriber: VoiceTranscriberPort;
    try {
      transcriber = await loadTranscriber(() => passcode.current);
    } catch {
      dispatchDisclosure({ type: "RESET" });
      if (mounted.current) setPhase({ kind: "ENDED", reason: "UNAVAILABLE" });
      return;
    }
    if (!mounted.current) return;
    const { timers = DEFAULT_TIMERS, startTimeoutMs = 20_000, maxSessionSeconds = 120 } = props;
    let session: VoiceSessionController;
    session = createVoiceSessionController({
      transcriber,
      timers,
      startTimeoutMs,
      maxSessionSeconds,
      onChange: (next) => {
        if (!mounted.current || controller.current !== session) return;
        setSnapshot(next);
        if (next.state === "COMPLETED" || next.state === "CANCELLED" || next.state === "TIMED_OUT" || next.state === "FAILED") void finishSession(session, next);
      },
    });
    controller.current = session;
    const outcome = await session.start({ language, grant: accepted.grant });
    if (outcome.kind === "REFUSED" && mounted.current) setPhase({ kind: "ENDED", reason: "UNAVAILABLE" });
  }

  function decline() {
    dispatchDisclosure({ type: "DECLINE" });
    setPhase({ kind: "ENDED", reason: "DECLINED" });
  }

  function discard() {
    remoteAbort.current?.abort();
    controller.current?.discardTranscript();
    // Review I-2: after a save, the saved items stay; only the unsaved rest is discarded.
    setPhase({ kind: "ENDED", reason: anySaved ? "DONE_SAVED" : "CANCELLED" });
  }

  function restart() {
    controller.current?.discardTranscript();
    dispatchDisclosure({ type: "RESET" });
    setSnapshot(null);
    setPhase(checkAvailability ? { kind: "CHECKING" } : { kind: "DISCLOSURE" });
  }

  async function decideFact(decision: VoiceFactDecision): Promise<VoiceFactOutcome> {
    if (phase.kind !== "REVIEW") return "REJECTED";
    const current = controller.current?.snapshot();
    const known = phase.medicines.map((entry) => entry.medication);
    const review = reviewVoiceCandidates({ analysis: phase.analysis, reviewedSessionToken: phase.sessionToken, currentSession: { sessionToken: current?.sessionToken ?? -1, state: current?.state ?? "IDLE" }, knownMedications: known, decisions: [decision] });
    if (review.kind !== "INTENTS" || review.intents.length !== 1) return (review.rejected ?? []).some((entry) => entry.reason === "OUT_OF_RANGE") ? "OUT_OF_RANGE" : "REJECTED";
    touch();
    const result = await onSaveFacts(review.intents[0]!.intent);
    touch();
    if (result.kind === "SAVED") setAnySaved(true);
    return result.kind === "SAVED" ? "SAVED" : "NOT_SAVED";
  }

  const remoteOffered = phase.kind === "REVIEW" && props.remoteExtraction !== undefined && !anySaved && phase.analysis.redirect === null && gateRemoteTranscriptExtraction(phase.transcript, language).kind === "PERMIT";

  async function askRemote() {
    const extract = props.remoteExtraction;
    if (phase.kind !== "REVIEW" || !extract || !remoteOffered) return;
    const review = phase;
    const touchedAtStart = touches.current;
    const abort = new AbortController();
    remoteAbort.current = abort;
    setRemote("CHECKING");
    try {
      const result = await extract(review.transcript, language, abort.signal);
      if (!mounted.current || abort.signal.aborted) return;
      // Review I-1: never re-render the cards under a person who already saved or chose something.
      if (touches.current !== touchedAtStart) return setRemote("KEPT_LOCAL");
      const merged = result.kind === "CANDIDATES" ? mergeRemoteCandidates({ local: review.analysis, remote: result.candidates, transcript: review.transcript, language, directory: review.directory }) : { kind: "LOCAL_KEPT" as const };
      if (merged.kind === "MERGED") {
        setPhase({ ...review, analysis: merged.analysis, generation: review.generation + 1 });
        setRemote("DONE");
      } else {
        setRemote("KEPT_LOCAL");
      }
    } catch {
      if (mounted.current && !abort.signal.aborted) setRemote("KEPT_LOCAL");
    } finally {
      if (remoteAbort.current === abort) remoteAbort.current = null;
    }
  }

  async function rememberTerm(phrase: string, choice: VoiceMedicineOption): Promise<boolean> {
    const result = await terminology.remember({ language, phrase, medication: choice.medication });
    return result.kind === "COMMITTED" || result.kind === "NO_CHANGE";
  }

  /** 13s.3: the fixed redirect wording is chosen by the redirect's category (never by its message key string). */
  const redirectBody = (category: VoiceRedirectCategory) => (category === "HEALTH_QUESTION" ? copy.redirect.healthBody : copy.redirect.body);

  const statusText =
    phase.kind === "CHECKING"
      ? copy.state.checking
      : phase.kind === "SESSION"
      ? snapshot?.state === "LISTENING"
        ? copy.state.listening
        : snapshot?.state === "STOPPING"
          ? copy.state.stopping
          : copy.state.starting
      : phase.kind === "REVIEW"
        ? copy.review.heading
        : phase.kind === "REDIRECT"
          ? redirectBody(phase.category)
          : phase.kind === "ENDED"
            ? {
                DECLINED: copy.state.declined,
                CANCELLED: copy.state.cancelled,
                DONE_SAVED: copy.state.doneSaved,
                TIMED_OUT: copy.state.timedOut,
                PERMISSION_DENIED: copy.state.permissionDenied,
                UNSUPPORTED: copy.state.unsupported,
                UNAVAILABLE: copy.state.unavailable,
                ACCESS_DENIED: copy.state.accessDenied,
                NOT_UNDERSTOOD: copy.review.nothingFound,
              }[phase.reason]
            : "";

  // Finding N-1: the screen-level manual-entry chooser. Each button opens its existing entry flow blank (nothing from the transcript is
  // carried over and nothing is saved); it never restarts voice or contacts a provider. The type is the person's choice, never guessed.
  const chooserId = `${passcodeId}-manual`;
  const chooser = (
    <section className="voice-manual" aria-labelledby={chooserId}>
      <h2 id={chooserId} className="voice-section-label">
        {copy.review.manualHeading}
      </h2>
      <div className="voice-actions">
        <button type="button" className="btn btn-secondary btn-wide" onClick={() => onManualEntry("GLUCOSE")}>
          {copy.review.manualReading}
        </button>
        <button type="button" className="btn btn-secondary btn-wide" onClick={() => onManualEntry("MEAL")}>
          {copy.review.manualMeal}
        </button>
        <button type="button" className="btn btn-secondary btn-wide" onClick={() => onManualEntry("MEDICATION")}>
          {copy.review.manualMedicine}
        </button>
      </div>
    </section>
  );
  // A separate exit, not a manual-entry action.
  const backToToday = (
    <button type="button" className="btn btn-ghost btn-wide" onClick={onClose}>
      {copy.review.backToToday}
    </button>
  );

  return (
    <div className="screen-page voice-screen">
      <ScreenHeader title={copy.title} />
      <p role="status" aria-live="polite" className="voice-status">
        {statusText}
      </p>

      {phase.kind === "SESSION" ? (
        <section className="voice-listening" aria-label={copy.review.transcriptLabel}>
          {snapshot?.liveText ? (
            <>
              <h2 className="voice-section-label">{copy.review.transcriptLabel}</h2>
              <p className="voice-live-text">{snapshot.liveText}</p>
            </>
          ) : null}
          <div className="voice-actions">
            <button type="button" className="btn btn-primary btn-wide" disabled={snapshot?.state !== "LISTENING"} onClick={() => void controller.current?.stop()}>
              {copy.state.stop}
            </button>
            <button type="button" className="btn btn-outline btn-wide" onClick={() => void controller.current?.cancel()}>
              {copy.state.cancel}
            </button>
          </div>
        </section>
      ) : null}

      {phase.kind === "REVIEW" ? (
        <section className="voice-review">
          <h2 className="voice-section-label">{copy.review.transcriptLabel}</h2>
          <p className="voice-transcript">{phase.transcript}</p>
          {remoteOffered && remote === "IDLE" ? (
            <button type="button" className="btn btn-outline btn-wide voice-remote-offer" onClick={() => setRemote("ASKING")}>
              {copy.remote.offer}
            </button>
          ) : null}
          {remote === "CHECKING" ? <p role="status">{copy.remote.checking}</p> : null}
          {remote === "KEPT_LOCAL" ? <p role="status">{copy.remote.keptLocal}</p> : null}
          {remote === "ASKING" && remoteOffered ? (
            <ModalDialog
              className="voice-remote-disclosure-dialog"
              title={copy.remote.title}
              description={<p>{copy.remote.disclosure}</p>}
              onClose={() => setRemote("KEPT_LOCAL")}
              initialFocusSelector="[data-voice-remote-safe]"
              actions={
                <>
                  <button type="button" className="btn btn-primary btn-wide" onClick={() => void askRemote()}>
                    {copy.remote.accept}
                  </button>
                  <button type="button" className="btn btn-outline btn-wide" data-voice-remote-safe="" onClick={() => setRemote("KEPT_LOCAL")}>
                    {copy.remote.decline}
                  </button>
                </>
              }
            >
              {null}
            </ModalDialog>
          ) : null}
          {phase.analysis.redirect ? (
            <div className="notice voice-redirect" role="note">
              {/* Review M-3: the "nothing was saved" note belongs to the redirect-only screen, not beside saveable cards. */}
              <p>{redirectBody(phase.analysis.redirect.category)}</p>
            </div>
          ) : null}
          {phase.analysis.candidates.map((candidate, index) =>
            candidate.kind === "UNSUPPORTED_SPAN" ? null : (
              <VoiceFactCard
                key={`${phase.sessionToken}-${phase.generation}-${index}`}
                candidate={candidate as VoiceFactCandidate}
                index={index}
                copy={copy}
                language={language}
                medicines={phase.medicines}
                onDecide={decideFact}
                onRemember={rememberTerm}
                onManualEntry={() => onManualEntry(candidate.kind === "GLUCOSE_READING" ? "GLUCOSE" : candidate.kind === "MEAL_NOTE" ? "MEAL" : "MEDICATION")}
                onInteract={touch}
                amountSaveSupported={props.reportedAmountSaved === true}
              />
            ),
          )}
          {phase.analysis.candidates.some((candidate) => candidate.kind === "UNSUPPORTED_SPAN") ? (
            <section className="voice-not-understood" aria-labelledby={`${passcodeId}-not-understood`}>
              <h3 id={`${passcodeId}-not-understood`}>{copy.review.notUnderstoodHeading}</h3>
              <ul>
                {phase.analysis.candidates.filter((candidate) => candidate.kind === "UNSUPPORTED_SPAN").map((candidate, index) => (
                  <li key={index}>“{candidate.sourcePhrase}”</li>
                ))}
              </ul>
              <p>{copy.review.notUnderstoodBody}</p>
            </section>
          ) : null}
          {chooser}
          <div className="voice-actions">
            <button type="button" className="btn btn-outline btn-wide" onClick={discard}>
              {copy.review.discard}
            </button>
            {backToToday}
          </div>
        </section>
      ) : null}

      {phase.kind === "REDIRECT" ? (
        <section className="voice-redirect-only">
          <h2 className="voice-section-label">{copy.review.transcriptLabel}</h2>
          <p className="voice-transcript">{phase.transcript}</p>
          <div className="notice voice-redirect" role="note">
            <p>{redirectBody(phase.category)}</p>
            <p>{copy.redirect.transcribedNote}</p>
          </div>
          {chooser}
          <div className="voice-actions">
            <button type="button" className="btn btn-outline btn-wide" onClick={discard}>
              {copy.review.discard}
            </button>
            {backToToday}
          </div>
        </section>
      ) : null}

      {phase.kind === "ENDED" ? (
        <section className="voice-ended">
          {chooser}
          <div className="voice-actions">
            {voiceAvailable && phase.reason !== "UNAVAILABLE" && phase.reason !== "UNSUPPORTED" ? (
              <button type="button" className="btn btn-outline btn-wide" onClick={restart}>
                {copy.title}
              </button>
            ) : null}
            {backToToday}
          </div>
        </section>
      ) : null}

      {(phase.kind === "REVIEW" || phase.kind === "REDIRECT" || phase.kind === "ENDED") && terminology.list && terminology.change && terminology.forget ? <RememberedTermsSection terminology={terminology} copy={copy} language={language} /> : null}

      {phase.kind === "DISCLOSURE" && disclosure.kind === "SHOWN" ? (
        <ModalDialog
          className="voice-disclosure-dialog"
          title={copy.disclosure.title}
          description={<p>{copy.disclosure.body}</p>}
          onClose={decline}
          initialFocusSelector="[data-voice-disclosure-safe]"
          actions={
            <>
              <button type="button" className="btn btn-primary btn-wide" disabled={entered.trim().length === 0} onClick={() => void accept()}>
                {copy.disclosure.accept}
              </button>
              <button type="button" className="btn btn-outline btn-wide" data-voice-disclosure-safe="" onClick={decline}>
                {copy.disclosure.decline}
              </button>
            </>
          }
        >
          <div className="field">
            <label className="field-label" htmlFor={passcodeId}>
              {copy.passcodeLabel}
            </label>
            <input id={passcodeId} className="input" type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} value={entered} onChange={(event) => setEntered(event.target.value)} />
          </div>
        </ModalDialog>
      ) : null}
    </div>
  );
}
