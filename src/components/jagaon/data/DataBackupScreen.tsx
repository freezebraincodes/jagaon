"use client";

import { useRef, useState, type ReactNode } from "react";
import type { AppMessages } from "@/i18n/types";
import { DeviceIcon, FolderIcon, LockIcon, OfflineIcon, TrashIcon } from "../primitives/Icons";
import { Notice } from "../primitives/ScreenHeader";
import type { DeleteAllPort } from "./data-ports";
import { DeleteAllDialog } from "./DeleteAllDialog";

export type DataBackupView = "hub" | "create" | "restore";

/**
 * Frame 01: the distinct Data and backup destination under More. It is not
 * "Export to other apps" (frozen resolution 8). Create and restore panels are
 * supplied by their own packets as sub-views.
 */
export function DataBackupScreen({
  messages,
  view,
  showView,
  deleteAll,
  onDeleted,
  createPanel,
  restorePanel,
}: {
  messages: AppMessages;
  view: DataBackupView;
  showView: (view: DataBackupView) => void;
  deleteAll: DeleteAllPort;
  onDeleted: () => void;
  createPanel?: ReactNode;
  restorePanel?: ReactNode;
}) {
  const hub = messages.packet10.hub;
  const [deleting, setDeleting] = useState(false);
  const deleteButton = useRef<HTMLButtonElement>(null);

  if (view === "create" && createPanel) return <>{createPanel}</>;
  if (view === "restore" && restorePanel) return <>{restorePanel}</>;

  return (
    <div className="screen-page data-screen">
      <header className="screen-header"><h1 className="screen-title">{hub.title}</h1></header>
      <p className="data-lead">{hub.intro}</p>
      <section className="data-card" aria-labelledby="data-live-storage">
        <h2 className="data-card-title" id="data-live-storage">
          <DeviceIcon size={26} />
          {hub.liveStorage}
        </h2>
        <p className="data-card-body">{hub.liveStorageLimit}</p>
        <p className="data-card-meta">{hub.hubLast}</p>
      </section>
      <div className="button-stack">
        {createPanel ? (
          <button type="button" className="btn btn-primary btn-wide" onClick={() => showView("create")}>
            <LockIcon size={22} />
            {hub.createBackup}
          </button>
        ) : null}
        {restorePanel ? (
          <button type="button" className="btn btn-outline btn-wide" onClick={() => showView("restore")}>
            <FolderIcon size={22} />
            {hub.restoreBackup}
          </button>
        ) : null}
      </div>
      <Notice icon={<OfflineIcon size={20} />}>{hub.offline}</Notice>
      <hr className="data-divider" />
      <button ref={deleteButton} type="button" className="btn btn-danger-outline btn-wide" onClick={() => setDeleting(true)}>
        <TrashIcon size={22} />
        {hub.deleteAll}
      </button>
      <p className="field-hint">{hub.deleteAllHelp}</p>
      {deleting ? (
        <DeleteAllDialog messages={messages} port={deleteAll} onClose={() => setDeleting(false)} onDeleted={onDeleted} returnFocusRef={deleteButton} />
      ) : null}
    </div>
  );
}
