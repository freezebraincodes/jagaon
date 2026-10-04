"use client";

import { useRef, useState } from "react";
import type { StorageLockState } from "@/application/storage/integrity-gate";
import type { AppMessages } from "@/i18n/types";
import { Banner } from "../primitives/Card";
import { CheckIcon, FolderIcon, LockIcon, ResetIcon, TrashIcon } from "../primitives/Icons";
import { Notice } from "../primitives/ScreenHeader";
import type { DeleteAllPort } from "./data-ports";
import { DeleteAllDialog } from "./DeleteAllDialog";

/**
 * Frame 12 (and frame 09 for a blocked post-restore reconciliation): the
 * neutral recovery shell shown while the dataset is locked (spec 9.4). It
 * presents no stored record as current truth and makes no health claim; it
 * offers only retry, validated restore and delete-all. One variant renders
 * at a time (frozen frame 12 resolution); `intOtherK` is not shipped.
 */
export function IntegrityShell({
  messages,
  lock,
  onRetry,
  onRestore,
  deleteAll,
  onDeleted,
}: {
  messages: AppMessages;
  lock: StorageLockState;
  onRetry: () => void;
  onRestore?: () => void;
  deleteAll: DeleteAllPort;
  onDeleted: () => void;
}) {
  const p = messages.packet10;
  const [deleting, setDeleting] = useState(false);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const recovery = lock.kind === "RECOVERY_REQUIRED";

  const body =
    lock.kind === "MIGRATION_BLOCKED" ? (
      <>
        <strong>{p.integrity.intVariantMigrationK}</strong> {p.integrity.migrationBlocked}
      </>
    ) : lock.kind === "NEWER_DATABASE" ? (
      <>
        <strong>{p.integrity.intVariantNewerK}</strong> {p.integrity.newerDatabase}
      </>
    ) : lock.kind === "RECOVERY_REQUIRED" ? (
      p.restore.recoveryRequired
    ) : lock.kind === "STORAGE_UNAVAILABLE" ? (
      messages.shared.storageUnavailable
    ) : (
      p.integrity.integrityBody
    );

  return (
    <div className="screen-page data-screen integrity-shell">
      {/* Frame 09 (a committed restore that could not finish rebuilding) keeps the restore title. */}
      <header className="screen-header"><h1 className="screen-title">{recovery ? p.restore.restoreTitle : p.integrity.integrityTitle}</h1></header>
      <Banner variant="error" role="alert" title={recovery ? undefined : p.integrity.integrityTitle}>
        <p className="banner-body">{body}</p>
      </Banner>
      <section className="data-card" aria-labelledby="integrity-changed">
        <h2 className="eyebrow" id="integrity-changed">
          {p.restore.whatChangedK}
        </h2>
        <ul className="data-status-list">
          {recovery ? (
            <>
              <li>
                <CheckIcon size={20} />
                {p.restore.blockWritten}
              </li>
              <li>
                <ResetIcon size={20} />
                {p.restore.blockNotRebuilt}
              </li>
              <li>
                <LockIcon size={20} />
                {p.restore.blockLocked}
              </li>
            </>
          ) : (
            <>
              <li>
                <CheckIcon size={20} />
                {p.integrity.intUnchangedLock}
              </li>
              <li>
                <LockIcon size={20} />
                {p.integrity.intDisabled}
              </li>
            </>
          )}
        </ul>
      </section>
      <Notice>{p.shared.noHealthClaim}</Notice>
      <div className="button-stack">
        <button type="button" className="btn btn-primary btn-wide" onClick={onRetry}>
          <ResetIcon size={22} />
          {p.integrity.retryRecovery}
        </button>
        {onRestore ? (
          <button type="button" className="btn btn-outline btn-wide" onClick={onRestore}>
            <FolderIcon size={22} />
            {p.integrity.openBackupRecovery}
          </button>
        ) : null}
        <button ref={deleteButton} type="button" className="btn btn-danger-outline btn-wide" onClick={() => setDeleting(true)}>
          <TrashIcon size={22} />
          {p.hub.deleteAll}
        </button>
      </div>
      {deleting ? (
        <DeleteAllDialog messages={messages} port={deleteAll} onClose={() => setDeleting(false)} onDeleted={onDeleted} returnFocusRef={deleteButton} />
      ) : null}
    </div>
  );
}
