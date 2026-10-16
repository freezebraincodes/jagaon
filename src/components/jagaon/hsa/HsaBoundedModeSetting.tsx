"use client";

import { useRef, useState } from "react";
import type { AppMessages } from "@/i18n/types";
import { AlertDialog } from "../primitives/AlertDialog";
import { ShieldIcon } from "../primitives/Icons";
import { useHsaBoundedMode } from "./hsa-bounded-mode";

/**
 * Owner decision 2026-10-14: the HSA-bounded mode switch on More → Settings. Turning it OFF asks once, explaining that preview
 * features go beyond the HSA wellness boundary and are for demonstration with synthetic data; turning it back ON needs no question.
 * A public release build (the preview flag off, `hsa-build-flags.ts`) shows no switch at all (owner decision 2026-10-16).
 */
export function HsaBoundedModeSetting({ messages }: { messages: AppMessages }) {
  const copy = messages.hsa;
  const { bounded, switchAvailable, setBounded } = useHsaBoundedMode();
  const [confirming, setConfirming] = useState(false);
  const switchRef = useRef<HTMLButtonElement>(null);
  if (!switchAvailable) return null;
  return (
    <div className="setting-row">
      <ShieldIcon size={26} className="icon setting-icon" />
      <span className="setting-text">
        <span className="setting-title" id="hsa-bounded-title">
          {copy.settingLabel}
        </span>
        <span className="setting-body" id="hsa-bounded-body">
          {copy.settingBody}
        </span>
      </span>
      <button
        ref={switchRef}
        type="button"
        role="switch"
        aria-checked={bounded}
        aria-labelledby="hsa-bounded-title"
        aria-describedby="hsa-bounded-body"
        className="schedule-switch"
        onClick={() => (bounded ? setConfirming(true) : setBounded(true))}
      >
        <span className="schedule-switch-label">{bounded ? copy.on : copy.off}</span>
        <span className="schedule-switch-track" aria-hidden="true" />
      </button>
      {confirming ? (
        <AlertDialog
          title={copy.confirmTitle}
          cancelLabel={messages.shared.cancel}
          onCancel={() => setConfirming(false)}
          confirmLabel={copy.confirmAction}
          onConfirm={() => {
            setBounded(false);
            setConfirming(false);
          }}
          returnFocusRef={switchRef}
        >
          <p>{copy.confirmBody}</p>
        </AlertDialog>
      ) : null}
    </div>
  );
}
