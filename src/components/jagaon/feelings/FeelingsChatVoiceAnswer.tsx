"use client";

import { useEffect, useId, useReducer, useRef, useState } from "react";
import { createVoiceSessionController, type VoiceSessionController, type VoiceSessionSnapshot, type VoiceTimers } from "@/application/voice/voice-session-controller";
import { VOICE_DISCLOSURE_INITIAL_STATE, voiceDisclosureReducer } from "@/application/voice/voice-cloud-disclosure";
import type { VoiceAccessMode, VoiceProviderId, VoiceProviderResolution } from "@/application/voice/voice-provider-selection";
import type { VoiceTranscriberPort } from "@/application/voice/voice-transcriber-port";
import type { VoiceLanguage } from "@/domain/voice/voice-contracts";
import type { FeelingsChatMessages } from "@/i18n/types";
import type { VoiceScreenCopy } from "../voice/voice-screen-copy";

/**
 * Owner decision 2026-10-14: what the feelings chat needs to take an answer by voice. The same pieces as Tell JagaOn: the provider
 * resolved at idle (Web Speech or TRTC, per the deployment and the browser), the voice notice before EVERY recording (one grant per
 * start), the transcriber loaded only after the notice is accepted, and the same session controller and limits.
 */
export type FeelingsChatVoice = Readonly<{
  copy: VoiceScreenCopy;
  language: VoiceLanguage;
  resolveProvider?: () => Promise<VoiceProviderResolution>;
  checkAvailability?: () => Promise<boolean | Readonly<{ available: boolean; passcodeRequired?: boolean }>>;
  loadTranscriber: (accessPasscode: () => string | null, provider: VoiceProviderId, access: VoiceAccessMode) => Promise<VoiceTranscriberPort>;
  /** True while a recording is starting, listening or stopping (the app locks its provider selector meanwhile). */
  onSessionActivity?: (active: boolean) => void;
  timers?: VoiceTimers;
  startTimeoutMs?: number;
  maxSessionSeconds?: number;
}>;

type Props = Readonly<{
  voice: FeelingsChatVoice;
  labels: FeelingsChatMessages;
  /** No recording can start (JagaOn is thinking, or there is no question to answer). */
  disabled: boolean;
  /** Her spoken words (trimmed, not empty). The chat runs the distress gate and puts them in the answer box; nothing is sent. */
  onTranscript: (text: string) => void;
  /** True from "Speak my answer" until the recording has ended (the chat holds Send, Skip and End chat meanwhile). */
  onBusyChange: (busy: boolean) => void;
}>;

type Phase =
  | Readonly<{ kind: "IDLE"; message: string | null }>
  | Readonly<{ kind: "CHECKING" }>
  | Readonly<{ kind: "CONSENT" }>
  | Readonly<{ kind: "SESSION" }>;

const DEFAULT_TIMERS: VoiceTimers = Object.freeze({
  setTimeout: (callback: () => void, ms: number) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
});

function failureMessage(snapshot: VoiceSessionSnapshot, labels: FeelingsChatMessages): string {
  if (snapshot.failureReason === "PERMISSION_DENIED") return labels.voiceNotAllowed;
  if (snapshot.failureReason === "CREDENTIAL_REFUSED" && snapshot.credentialRefusal === "ACCESS_DENIED") return labels.voiceAccessDenied;
  return labels.voiceUnavailable;
}

/** "Speak my answer": one recording at a time, inside the chat dialog (no second dialog, so focus stays in the chat). */
export function FeelingsChatVoiceAnswer({ voice, labels, disabled, onTranscript, onBusyChange }: Props) {
  const { copy, language } = voice;
  const ids = useId();
  const [phase, setPhase] = useState<Phase>({ kind: "IDLE", message: null });
  const [disclosure, dispatchDisclosure] = useReducer(voiceDisclosureReducer, VOICE_DISCLOSURE_INITIAL_STATE);
  const [provider, setProvider] = useState<VoiceProviderId>("TRTC");
  const [passcodeRequired, setPasscodeRequired] = useState(true);
  const [entered, setEntered] = useState("");
  const [snapshot, setSnapshot] = useState<VoiceSessionSnapshot | null>(null);
  const passcode = useRef<string | null>(null);
  const controller = useRef<VoiceSessionController | null>(null);
  const mounted = useRef(true);
  const acceptRef = useRef<HTMLButtonElement>(null);
  const stopRef = useRef<HTMLButtonElement>(null);
  const speakRef = useRef<HTMLButtonElement>(null);

  const latest = useRef({ onTranscript, onBusyChange, onSessionActivity: voice.onSessionActivity });
  useEffect(() => {
    latest.current = { onTranscript, onBusyChange, onSessionActivity: voice.onSessionActivity };
  });

  const busy = phase.kind !== "IDLE";
  useEffect(() => {
    latest.current.onBusyChange(busy);
  }, [busy]);

  const sessionActive = phase.kind === "SESSION" && (snapshot === null || snapshot.state === "STARTING" || snapshot.state === "LISTENING" || snapshot.state === "STOPPING");
  useEffect(() => {
    latest.current.onSessionActivity?.(sessionActive);
  }, [sessionActive]);

  useEffect(() => {
    if (phase.kind === "CONSENT") acceptRef.current?.focus();
  }, [phase.kind]);
  useEffect(() => {
    if (snapshot?.state === "LISTENING") stopRef.current?.focus();
  }, [snapshot?.state]);

  // Closing the chat cancels a recording (releases the microphone), drops its words and forgets the passcode.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const current = controller.current;
      controller.current = null;
      passcode.current = null;
      const report = latest.current.onSessionActivity;
      if (current) void current.cancel().finally(() => {
        current.discardTranscript();
        report?.(false);
      });
    };
  }, []);

  function backToIdle(message: string | null) {
    dispatchDisclosure({ type: "RESET" });
    setSnapshot(null);
    setPhase({ kind: "IDLE", message });
    if (message === null) speakRef.current?.focus();
  }

  async function speak() {
    if (disabled || busy) return;
    setPhase({ kind: "CHECKING" });
    let resolution: VoiceProviderResolution;
    try {
      if (voice.resolveProvider) {
        const result = await voice.resolveProvider();
        resolution = result?.kind === "AVAILABLE" && (result.provider === "TRTC" || result.provider === "WEB_SPEECH") ? result : { kind: "UNAVAILABLE" };
      } else if (voice.checkAvailability) {
        const available = await voice.checkAvailability();
        const ok = available === true || (typeof available === "object" && available !== null && available.available === true);
        resolution = ok ? { kind: "AVAILABLE", provider: "TRTC", passcodeRequired: !(typeof available === "object" && available.passcodeRequired === false) } : { kind: "UNAVAILABLE" };
      } else {
        resolution = { kind: "AVAILABLE", provider: "TRTC" };
      }
    } catch {
      resolution = { kind: "UNAVAILABLE" };
    }
    if (!mounted.current) return;
    if (resolution.kind !== "AVAILABLE") return backToIdle(labels.voiceUnavailable);
    setProvider(resolution.provider);
    setPasscodeRequired(resolution.passcodeRequired !== false);
    setEntered("");
    // The notice is shown before every recording (one grant per start), as in Tell JagaOn.
    dispatchDisclosure({ type: "REQUEST_START", language });
    setPhase({ kind: "CONSENT" });
  }

  async function accept() {
    if (phase.kind !== "CONSENT" || disclosure.kind !== "SHOWN" || (passcodeRequired && entered.trim().length === 0)) return;
    const access: VoiceAccessMode = Object.freeze({ passcodeRequired });
    passcode.current = passcodeRequired ? entered : null;
    setEntered("");
    const accepted = voiceDisclosureReducer(disclosure, { type: "ACCEPT" });
    if (accepted.kind !== "GRANTED") return;
    dispatchDisclosure({ type: "RESET" });
    setSnapshot(null);
    setPhase({ kind: "SESSION" });
    let transcriber: VoiceTranscriberPort;
    try {
      transcriber = await voice.loadTranscriber(() => passcode.current, provider, access);
    } catch {
      if (mounted.current) backToIdle(labels.voiceUnavailable);
      return;
    }
    if (!mounted.current) return;
    const { timers = DEFAULT_TIMERS, startTimeoutMs = 20_000, maxSessionSeconds = 60 } = voice;
    const session: VoiceSessionController = createVoiceSessionController({
      transcriber,
      timers,
      startTimeoutMs,
      maxSessionSeconds,
      onChange: (next) => {
        if (!mounted.current || controller.current !== session) return;
        setSnapshot(next);
        if (next.state === "COMPLETED" || next.state === "CANCELLED" || next.state === "TIMED_OUT" || next.state === "FAILED") finish(session, next);
      },
    });
    controller.current = session;
    const outcome = await session.start({ language, grant: accepted.grant });
    if (outcome.kind === "REFUSED" && mounted.current && controller.current === session) {
      controller.current = null;
      backToIdle(labels.voiceUnavailable);
    }
  }

  function finish(session: VoiceSessionController, next: VoiceSessionSnapshot) {
    controller.current = null;
    passcode.current = null;
    if (next.state === "CANCELLED") {
      session.discardTranscript();
      return backToIdle(null);
    }
    if (next.state !== "COMPLETED") {
      session.discardTranscript();
      return backToIdle(next.state === "TIMED_OUT" ? labels.voiceUnavailable : failureMessage(next, labels));
    }
    const text = (session.takeTranscript() ?? "").trim();
    if (text.length === 0) return backToIdle(labels.voiceNothingHeard);
    backToIdle(labels.voiceAdded);
    latest.current.onTranscript(text);
  }

  function decline() {
    dispatchDisclosure({ type: "DECLINE" });
    backToIdle(null);
  }

  const webSpeech = provider === "WEB_SPEECH";
  const passcodeId = `${ids}-passcode`;

  if (phase.kind === "CONSENT" && disclosure.kind === "SHOWN") {
    return (
      <section className="feelings-chat-voice feelings-chat-voice-consent" aria-labelledby={`${ids}-consent`}>
        <h3 id={`${ids}-consent`} className="feelings-chat-voice-title">
          {webSpeech ? copy.webSpeech.consentTitle : copy.disclosure.title}
        </h3>
        {webSpeech ? copy.webSpeech.consentBody.map((paragraph) => <p key={paragraph}>{paragraph}</p>) : <p>{copy.disclosure.body}</p>}
        {passcodeRequired ? (
          <div className="field">
            <label className="field-label" htmlFor={passcodeId}>
              {copy.passcodeLabel}
            </label>
            <input id={passcodeId} className="input" type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} value={entered} onChange={(event) => setEntered(event.target.value)} />
          </div>
        ) : null}
        <div className="button-row">
          <button ref={acceptRef} type="button" className="btn btn-primary" disabled={passcodeRequired && entered.trim().length === 0} onClick={() => void accept()}>
            {copy.disclosure.accept}
          </button>
          <button type="button" className="btn btn-outline" onClick={decline}>
            {copy.disclosure.decline}
          </button>
        </div>
      </section>
    );
  }

  if (phase.kind === "SESSION") {
    const listening = snapshot?.state === "LISTENING";
    return (
      <section className="feelings-chat-voice feelings-chat-voice-session" aria-label={labels.speakAnswer}>
        <p role="status" className="feelings-chat-voice-status">
          {listening ? copy.state.listening : snapshot?.state === "STOPPING" ? copy.state.stopping : copy.state.starting}
        </p>
        {snapshot?.liveText ? <p className="feelings-chat-voice-live">{snapshot.liveText}</p> : null}
        <div className="button-row">
          <button ref={stopRef} type="button" className="btn btn-primary" disabled={!listening} onClick={() => void controller.current?.stop()}>
            {copy.state.stop}
          </button>
          <button type="button" className="btn btn-outline" onClick={() => void controller.current?.cancel()}>
            {copy.state.cancel}
          </button>
        </div>
      </section>
    );
  }

  return (
    <div className="feelings-chat-voice">
      <button ref={speakRef} type="button" className="btn btn-outline btn-wide feelings-chat-speak" disabled={disabled || phase.kind === "CHECKING"} aria-busy={phase.kind === "CHECKING" || undefined} onClick={() => void speak()}>
        <span aria-hidden="true" className="feelings-chat-mic">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="3" width="6" height="11" rx="3" />
            <path d="M5 11a7 7 0 0 0 14 0" />
            <path d="M12 18v3" />
          </svg>
        </span>
        {phase.kind === "CHECKING" ? copy.state.checking : labels.speakAnswer}
      </button>
      {phase.kind === "IDLE" && phase.message ? (
        <p role="status" className="feelings-chat-voice-message">
          {phase.message}
        </p>
      ) : null}
    </div>
  );
}
