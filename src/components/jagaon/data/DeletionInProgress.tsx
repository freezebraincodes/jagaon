"use client";

import { useEffect, useId, useRef } from "react";
import type { AppMessages } from "@/i18n/types";
import { Banner } from "../primitives/Card";

/**
 * App-level, non-dismissable state shown from the moment the irreversible
 * IndexedDB delete request is issued until it succeeds or fails (Corrective
 * Pass A item 3). It offers no cancel, Escape or resubmission, and it does not
 * depend on the screen that opened the confirmation staying mounted.
 */
export function DeletionInProgress({ messages, waitingForTab }: { messages: AppMessages; waitingForTab: boolean }) {
  const id = useId();
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    dialog.current?.focus();
  }, []);
  return (
    <div className="dialog-backdrop">
      <div ref={dialog} className="alert-dialog" role="alertdialog" aria-modal="true" aria-busy="true" aria-labelledby={`${id}-title`} tabIndex={-1} onKeyDown={(event) => event.key === "Escape" && event.preventDefault()}>
        <h2 className="alert-dialog-title" id={`${id}-title`}>
          {messages.packet10.hub.deleteAll}
        </h2>
        <progress className="data-progress" aria-labelledby={`${id}-title`} />
        {waitingForTab ? (
          <Banner variant="warning" role="alert">
            {messages.packet10.deletion.deleteBlocked}
          </Banner>
        ) : null}
      </div>
    </div>
  );
}
