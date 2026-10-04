"use client";

import { useId, useRef, useState } from "react";
import type { RestorePlan, RestorePlanCounts } from "@/application/restore/restore-contracts";
import { MAX_BACKUP_ENCODED_BYTES } from "@/backup/backup-container-v1";
import type { AppMessages, SupportedLocale } from "@/i18n/types";
import { AlertDialog } from "../primitives/AlertDialog";
import { Banner } from "../primitives/Card";
import { CheckIcon, CircleIcon, DocumentIcon, EyeIcon, HistoryIcon, LoaderIcon, LockIcon, OfflineIcon, ResetIcon, SearchIcon, ShieldIcon, SunIcon } from "../primitives/Icons";
import { Notice } from "../primitives/ScreenHeader";
import type { AwaitReconciliation, RestorePort } from "./data-ports";
import { failureMessage, formatCount } from "./failure-copy";

type Phase =
  | { kind: "CHOOSE"; error: { message: string; help: string | null } | null }
  | { kind: "CHECKING" }
  | { kind: "PLAN"; plan: RestorePlan; confirming: boolean }
  | { kind: "RESTORING"; plan: RestorePlan }
  | { kind: "RECONCILING"; plan: RestorePlan }
  | { kind: "COMPLETED"; plan: RestorePlan };

function readFile(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

function formatSize(locale: SupportedLocale, bytes: number): string {
  const megabytes = bytes >= 1024 * 1024;
  return new Intl.NumberFormat(locale, { style: "unit", unit: megabytes ? "megabyte" : "kilobyte", maximumFractionDigits: 1 }).format(megabytes ? bytes / (1024 * 1024) : Math.max(1, bytes / 1024));
}

function formatDate(locale: SupportedLocale, instant: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone: "Asia/Singapore", day: "numeric", month: "short", year: "numeric" }).format(new Date(instant));
}

/**
 * Frames 04–08: choose a `.jagaon` file and passphrase, the combined
 * authentication failure, the empty or same-lineage plan, then RESTORING,
 * RECONCILING and COMPLETED as separate sequential states (frozen
 * resolution 1). The file is untrusted until every check passes; nothing is
 * restored before the explicit confirmation of a fresh plan.
 */
export function RestoreBackupPanel({
  messages,
  locale,
  port,
  awaitReconciliation,
  onCreateBackup,
  onCancel,
  onOpenToday,
  now = () => new Date().toISOString(),
}: {
  messages: AppMessages;
  locale: SupportedLocale;
  port: RestorePort;
  awaitReconciliation: AwaitReconciliation;
  onCreateBackup?: () => void;
  onCancel: () => void;
  onOpenToday: () => void;
  now?: () => string;
}) {
  const copy = messages.packet10.restore;
  const shared = messages.packet10.shared;
  const ids = { file: useId(), passphrase: useId() };
  const [file, setFile] = useState<File | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [visible, setVisible] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "CHOOSE", error: null });
  const fileInput = useRef<HTMLInputElement>(null);
  const replaceButton = useRef<HTMLButtonElement>(null);

  async function inspect() {
    if (!file || passphrase.length === 0) return;
    setPhase({ kind: "CHECKING" });
    let bytes: Uint8Array;
    try {
      // The encoded-size bound applies before the whole file is read (spec 8.3).
      if (file.size > MAX_BACKUP_ENCODED_BYTES) throw new Error("TOO_LARGE");
      bytes = await readFile(file);
    } catch {
      setPhase({ kind: "CHOOSE", error: { message: copy.restoreFailed, help: null } });
      return;
    }
    const result = await port.inspect(bytes, passphrase);
    setPassphrase("");
    if (result.kind === "PLAN_READY") {
      setPhase({ kind: "PLAN", plan: result.plan, confirming: false });
      return;
    }
    const key = result.failure.userMessageKey;
    setPhase({ kind: "CHOOSE", error: { message: failureMessage(messages, key), help: key === "packet10.restore.authenticationFailed" ? copy.authHelp : null } });
  }

  async function confirm(plan: RestorePlan) {
    setPhase({ kind: "RESTORING", plan });
    const result = await port.confirm(plan, { planHash: plan.planHash, confirmedAt: now() as never });
    if (result.kind !== "COMMITTED") {
      setPhase({ kind: "CHOOSE", error: { message: failureMessage(messages, result.failure.userMessageKey), help: null } });
      return;
    }
    setPhase({ kind: "RECONCILING", plan });
    // A lock shows the recovery shell (frame 09) instead of this panel.
    if ((await awaitReconciliation()) === "COMPLETED") setPhase({ kind: "COMPLETED", plan });
  }

  const title = <header className="screen-header"><h1 className="screen-title">{copy.restoreTitle}</h1></header>;

  function countsList(counts: RestorePlanCounts, done: boolean) {
    const entries: Array<[keyof RestorePlanCounts, number]> = [
      ["glucoseReadings", counts.glucoseReadings],
      ["medicineEntries", counts.medicineEntries],
      ["mealEntries", counts.mealEntries],
      ["healthChecksAppointments", counts.healthChecksAppointments],
    ];
    return (
      <ul className="data-step-list">
        {entries.map(([key, value]) => (
          <li key={key} className={done ? "data-step-done" : undefined}>
            {done ? <CheckIcon size={20} /> : null}
            {copy.planCounts[key](formatCount(locale, value))}
          </li>
        ))}
      </ul>
    );
  }

  function steps(completed: number, active: number | null) {
    return (
      <ul className="data-step-list">
        {copy.restoreSteps.map((step, index) => (
          <li key={step} className={index < completed ? "data-step-done" : undefined} aria-current={index === active ? "step" : undefined}>
            {index < completed ? <CheckIcon size={20} /> : index === active ? <LoaderIcon size={20} /> : <CircleIcon size={20} />}
            {step}
          </li>
        ))}
      </ul>
    );
  }

  if (phase.kind === "CHECKING" || phase.kind === "RESTORING" || phase.kind === "RECONCILING") {
    const completed = phase.kind === "CHECKING" ? 0 : phase.kind === "RESTORING" ? 3 : 4;
    const active = phase.kind === "CHECKING" ? 0 : phase.kind === "RESTORING" ? 3 : 4;
    return (
      <div className="screen-page data-screen">
        {title}
        <section className="data-card" role="status" aria-live="polite">
          <h2 className="data-card-title">{phase.kind === "CHECKING" ? copy.checking : copy.restoring}</h2>
          {steps(completed, active)}
          <progress className="data-progress" max={5} value={completed} aria-label={phase.kind === "CHECKING" ? copy.checking : copy.restoring} />
        </section>
        {phase.kind === "RECONCILING" ? <Banner variant="warning">{copy.reconciling}</Banner> : null}
        <Notice>{copy.noFaster}</Notice>
      </div>
    );
  }

  if (phase.kind === "COMPLETED") {
    return (
      <div className="screen-page data-screen">
        {title}
        <Banner variant="success">{copy.restoreDone}</Banner>
        <section className="data-card" aria-labelledby="restore-done-summary">
          <h2 className="eyebrow" id="restore-done-summary">
            {copy.doneSummaryK}
          </h2>
          {countsList(phase.plan.effects.counts, true)}
        </section>
        <p className="field-hint">{copy.doneNoShare}</p>
        <button type="button" className="btn btn-primary btn-wide" onClick={onOpenToday}>
          <SunIcon size={22} />
          {shared.openToday}
        </button>
      </div>
    );
  }

  if (phase.kind === "PLAN") {
    const plan = phase.plan;
    const replacing = plan.mode === "REPLACE_SAME_LINEAGE_DATABASE";
    const exported = formatDate(locale, plan.effects.exportedAt);
    return (
      <div className="screen-page data-screen">
        {title}
        <Banner variant={replacing ? "warning" : "info"}>{replacing ? copy.replacementPlan(exported) : copy.emptyPlan}</Banner>
        <section className="data-card" aria-labelledby="restore-plan-backup">
          <h2 className="eyebrow" id="restore-plan-backup">
            {copy.planBackupK}
          </h2>
          {file ? (
            <p className="data-file-name" lang="en">
              {file.name}
            </p>
          ) : null}
          <p className="data-card-meta">{copy.planExported(exported)}</p>
          {countsList(plan.effects.counts, false)}
        </section>
        {replacing ? (
          <section className="data-card data-card--warning" aria-label={copy.willBeLostK}>
            <ul className="data-status-list">
              <li>
                <HistoryIcon size={20} />
                <span>
                  <strong>{copy.willBeLostK}</strong> {copy.willBeLostV(formatCount(locale, plan.effects.newerRecordsDiscarded))}
                </span>
              </li>
              {plan.effects.protectedDeletions > 0 ? (
                <li>
                  <ShieldIcon size={20} />
                  {copy.deletionProtected(formatCount(locale, plan.effects.protectedDeletions))}
                </li>
              ) : null}
            </ul>
          </section>
        ) : null}
        {replacing ? (
          <>
            <Notice icon={<LockIcon size={20} />}>
              <strong>{copy.freshBackupFirst}</strong>
            </Notice>
            {onCreateBackup ? (
              <button type="button" className="btn btn-outline btn-wide" onClick={onCreateBackup}>
                <LockIcon size={22} />
                {messages.packet10.hub.createBackup}
              </button>
            ) : null}
          </>
        ) : null}
        <p className="field-hint">{copy.externalUnchanged}</p>
        <p className="field-hint">{copy.planExpires}</p>
        {replacing ? (
          <button ref={replaceButton} type="button" className="btn btn-danger-outline btn-wide" onClick={() => setPhase({ ...phase, confirming: true })}>
            <ResetIcon size={22} />
            {copy.restoreConfirm}
          </button>
        ) : (
          <button type="button" className="btn btn-primary btn-wide" onClick={() => void confirm(plan)}>
            <ResetIcon size={22} />
            {copy.restoreEmptyAction}
          </button>
        )}
        <button type="button" className="btn btn-outline btn-wide" onClick={onCancel}>
          {shared.cancel}
        </button>
        {phase.confirming ? (
          <AlertDialog
            title={copy.restoreConfirm}
            icon={<ResetIcon size={28} className="icon icon-danger" />}
            cancelLabel={shared.cancel}
            onCancel={() => setPhase({ ...phase, confirming: false })}
            confirmLabel={copy.restoreConfirm}
            confirmIcon={<ResetIcon size={22} />}
            onConfirm={() => void confirm(plan)}
            returnFocusRef={replaceButton}
          >
            <p>{copy.replacementPlan(exported)}</p>
            <p className="alert-dialog-note">{copy.freshBackupFirst}</p>
          </AlertDialog>
        ) : null}
      </div>
    );
  }

  return (
    <div className="screen-page data-screen">
      {title}
      {phase.error ? (
        <Banner variant="error" role="alert" title={phase.error.message}>
          {phase.error.help ?? messages.packet10.shared.recordsUnchanged}
        </Banner>
      ) : null}
      <div className="field">
        <label className="field-label" htmlFor={ids.file}>
          {copy.chooseFile}
        </label>
        {file ? (
          <div className="data-card data-file-card">
            <DocumentIcon size={28} />
            <span className="data-file-text">
              <span className="data-file-name" lang="en">
                {file.name}
              </span>
              <span className="data-card-meta">{copy.fileSize(formatSize(locale, file.size))}</span>
            </span>
            <button type="button" className="text-link" onClick={() => fileInput.current?.click()}>
              {shared.change}
            </button>
          </div>
        ) : null}
        <input
          ref={fileInput}
          id={ids.file}
          className={file ? "sr-only" : "input"}
          type="file"
          accept=".jagaon"
          onChange={(event) => {
            setFile(event.target.files?.[0] ?? null);
            setPhase({ kind: "CHOOSE", error: null });
          }}
        />
        <p className="field-hint">{copy.untrusted}</p>
      </div>
      <div className="field">
        <label className="field-label" htmlFor={ids.passphrase}>
          {copy.restorePassphrase}
        </label>
        <div className="input-with-action">
          <input
            id={ids.passphrase}
            className="input"
            type={visible ? "text" : "password"}
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
            autoComplete="current-password"
            spellCheck={false}
            autoCapitalize="off"
          />
          <button type="button" className="input-action" aria-pressed={visible} aria-controls={ids.passphrase} onClick={() => setVisible((value) => !value)}>
            <EyeIcon size={20} />
            {shared.show}
          </button>
        </div>
      </div>
      <Notice icon={<OfflineIcon size={20} />}>{messages.packet10.hub.offline}</Notice>
      <button type="button" className="btn btn-primary btn-wide" onClick={() => void inspect()} disabled={!file || passphrase.length === 0}>
        <SearchIcon size={22} />
        {copy.inspectAction}
      </button>
    </div>
  );
}
