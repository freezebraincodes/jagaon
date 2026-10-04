"use client";

import { useId, useRef, useState } from "react";
import { backupFileName, type BackupExportResult, type BackupExportStep } from "@/backup/backup-export-service";
import { validateConfirmedPassphrase } from "@/backup/passphrase";
import type { AppMessages, SupportedLocale } from "@/i18n/types";
import { Banner } from "../primitives/Card";
import { CheckIcon, CircleIcon, EyeIcon, InfoIcon, LockIcon } from "../primitives/Icons";
import { Notice } from "../primitives/ScreenHeader";
import { formatSingaporeTime } from "../journal/singapore-time";
import type { BackupExportPort } from "./data-ports";
import { failureMessage } from "./failure-copy";

type Phase =
  | { kind: "FORM"; banner: string | null }
  | { kind: "PREPARING"; completed: number }
  | { kind: "RESULT"; result: Extract<BackupExportResult, { kind: "FILE_WRITE_CONFIRMED" | "DOWNLOAD_STARTED" }> };

const STEP_COUNT = 4;

/**
 * Frames 02 and 03: passphrase and exact confirmation, sequential preparation
 * progress, then the truthful result. `fileWriteConfirmed` appears only when a
 * file-write API confirmed completion; otherwise `downloadStarted` with
 * `notProof` (frozen resolution 2). Passphrases are never echoed or stored.
 */
export function CreateBackupPanel({
  messages,
  locale,
  port,
  onDone,
  now = () => new Date().toISOString(),
}: {
  messages: AppMessages;
  locale: SupportedLocale;
  port: BackupExportPort;
  onDone: () => void;
  now?: () => string;
}) {
  const copy = messages.packet10.backup;
  const ids = { passphrase: useId(), confirmation: useId(), help: useId(), mismatch: useId() };
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [confirmTouched, setConfirmTouched] = useState(false);
  const [visible, setVisible] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "FORM", banner: null });
  const heading = useRef<HTMLHeadingElement>(null);

  const validity = validateConfirmedPassphrase(passphrase, confirmation);
  const mismatch = confirmTouched && confirmation.length > 0 && !validity.ok && validity.problem === "MISMATCH";

  async function prepare() {
    if (!validity.ok) return;
    setPhase({ kind: "PREPARING", completed: 0 });
    const result = await port.export(
      { passphrase, confirmation },
      { onStepCompleted: (step: BackupExportStep) => setPhase({ kind: "PREPARING", completed: step + 1 }) },
    );
    // The passphrase leaves component state as soon as the attempt ends.
    setPassphrase("");
    setConfirmation("");
    setConfirmTouched(false);
    if (result.kind === "FAILED") setPhase({ kind: "FORM", banner: failureMessage(messages, result.failure.userMessageKey) });
    else if (result.kind === "CANCELLED") setPhase({ kind: "FORM", banner: copy.saveCancelled });
    else if (result.kind === "PASSPHRASE_REJECTED") setPhase({ kind: "FORM", banner: result.problem === "MISMATCH" ? copy.passphraseMismatch : copy.backupFailed });
    else setPhase({ kind: "RESULT", result });
    heading.current?.focus();
  }

  if (phase.kind === "RESULT") {
    const confirmed = phase.result.kind === "FILE_WRITE_CONFIRMED";
    return (
      <div className="screen-page data-screen">
        <header className="screen-header"><h1 className="screen-title" ref={heading} tabIndex={-1}>
          {copy.backupTitle}
        </h1></header>
        <Banner variant="success">{confirmed ? copy.fileWriteConfirmed : copy.downloadStarted}</Banner>
        <section className="data-card" aria-labelledby="backup-file-label">
          <h2 className="eyebrow" id="backup-file-label">
            {copy.fileK}
          </h2>
          <p className="data-file-name" lang="en">
            {phase.result.fileName}
          </p>
          <p className="data-card-meta">{copy.preparedAt(formatSingaporeTime(locale, phase.result.preparedAt))}</p>
        </section>
        <section className="data-card" aria-labelledby="backup-steps-label">
          <h2 className="eyebrow" id="backup-steps-label">
            {copy.stepsDone}
          </h2>
          <ul className="data-step-list">
            {copy.prepSteps.map((step) => (
              <li key={step} className="data-step-done">
                <CheckIcon size={20} />
                {step}
              </li>
            ))}
          </ul>
        </section>
        {confirmed ? null : <Notice icon={<InfoIcon size={20} />}>{copy.notProof}</Notice>}
        <Notice icon={<LockIcon size={20} />}>{copy.fileContains}</Notice>
        <p className="field-hint">{copy.recordsUnchanged}</p>
        <button type="button" className="btn btn-outline btn-wide" onClick={onDone}>
          <CheckIcon size={22} />
          {messages.packet10.shared.done}
        </button>
      </div>
    );
  }

  const preparing = phase.kind === "PREPARING";
  return (
    <div className="screen-page data-screen">
      <header className="screen-header"><h1 className="screen-title" ref={heading} tabIndex={-1}>
        {copy.backupTitle}
      </h1></header>
      <p className="data-lead">{copy.backupBody}</p>
      {phase.kind === "FORM" && phase.banner ? (
        <Banner variant="error" role="alert">
          {phase.banner}
        </Banner>
      ) : null}
      <div className="field">
        <label className="field-label" htmlFor={ids.passphrase}>
          {copy.passphrase}
        </label>
        <div className="input-with-action">
          <input
            id={ids.passphrase}
            className="input"
            type={visible ? "text" : "password"}
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
            autoComplete="new-password"
            spellCheck={false}
            autoCapitalize="off"
            aria-describedby={ids.help}
            disabled={preparing}
          />
          <button type="button" className="input-action" aria-pressed={visible} aria-controls={`${ids.passphrase} ${ids.confirmation}`} onClick={() => setVisible((value) => !value)}>
            <EyeIcon size={20} />
            {messages.packet10.shared.show}
          </button>
        </div>
        <p className="field-hint" id={ids.help}>
          {copy.passphraseHelp}
        </p>
      </div>
      <div className="field">
        <label className="field-label" htmlFor={ids.confirmation}>
          {copy.confirmPassphrase}
        </label>
        <input
          id={ids.confirmation}
          className="input"
          type={visible ? "text" : "password"}
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          onBlur={() => setConfirmTouched(true)}
          autoComplete="new-password"
          spellCheck={false}
          autoCapitalize="off"
          aria-invalid={mismatch || undefined}
          aria-describedby={mismatch ? ids.mismatch : undefined}
          disabled={preparing}
        />
        {mismatch ? (
          <p className="field-error" id={ids.mismatch} role="alert">
            {copy.passphraseMismatch}
          </p>
        ) : null}
      </div>
      <Notice icon={<LockIcon size={20} />}>
        <strong>{copy.passphraseLoss}</strong>
      </Notice>
      <p className="field-hint">{copy.fileNameNote(backupFileName(now() as never, "Asia/Singapore"))}</p>
      {preparing ? (
        <div className="data-card" role="status" aria-live="polite">
          <p className="data-card-body">{copy.preparing}</p>
          <progress className="data-progress" max={STEP_COUNT} value={phase.completed} aria-label={copy.preparing} />
          <ul className="data-step-list">
            {copy.prepSteps.map((step, index) => (
              <li key={step} className={index < phase.completed ? "data-step-done" : undefined}>
                {index < phase.completed ? <CheckIcon size={20} /> : <CircleIcon size={20} />}
                {step}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <button type="button" className="btn btn-primary btn-wide" onClick={() => void prepare()} disabled={!validity.ok || preparing} aria-busy={preparing || undefined}>
        <LockIcon size={22} />
        {copy.createAction}
      </button>
    </div>
  );
}
