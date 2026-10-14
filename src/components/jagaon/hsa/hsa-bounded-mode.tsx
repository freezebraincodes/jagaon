"use client";

import { createContext, useCallback, useContext, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import type { AppMessages } from "@/i18n/types";

/**
 * Owner decision 2026-10-14 (HSA-bounded mode): one device setting decides whether JagaOn stays within Singapore's HSA wellness
 * boundary (ON, the default: describe and organise only) or also shows PREVIEW features that would need HSA medical-device approval
 * (OFF: shown for demonstration with synthetic data). Every preview feature reads `useHsaBoundedMode().bounded` and renders nothing
 * beyond today's behaviour while it is true. Whatever the setting, JagaOn never gives dosing or medication-change advice and distress
 * always goes to the helplines.
 *
 * The value is a per-device convenience kept in localStorage (no health data). Unreadable or missing storage means ON.
 */
export const HSA_BOUNDED_MODE_STORAGE_KEY = "jagaon.hsaBoundedMode";

export type HsaBoundedMode = Readonly<{
  /** True (default): within the HSA wellness boundary; preview features are hidden. */
  bounded: boolean;
  setBounded: (next: boolean) => void;
  /** Preview badge on the More tab (e.g. care checks due); 0 hides it. Set by the feature that owns the count. */
  moreBadgeCount: number;
  setMoreBadgeCount: (count: number) => void;
}>;

const DEFAULT_MODE: HsaBoundedMode = Object.freeze({
  bounded: true,
  setBounded: () => undefined,
  moreBadgeCount: 0,
  setMoreBadgeCount: () => undefined,
});

const HsaBoundedModeContext = createContext<HsaBoundedMode>(DEFAULT_MODE);

/** A same-page change notice (not a storage key). */
const CHANGE_EVENT = "jagaon-hsa-bounded-mode-change";
/** A page-local copy, used when storage is unavailable so the choice still lasts for this page. */
let pageValue: boolean | null = null;

function readStored(): boolean {
  if (pageValue !== null) return pageValue;
  try {
    return globalThis.localStorage?.getItem(HSA_BOUNDED_MODE_STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

function writeStored(bounded: boolean): void {
  pageValue = bounded;
  try {
    if (bounded) globalThis.localStorage?.removeItem(HSA_BOUNDED_MODE_STORAGE_KEY);
    else globalThis.localStorage?.setItem(HSA_BOUNDED_MODE_STORAGE_KEY, "off");
    pageValue = null;
  } catch {
    // Storage unavailable: the page-local copy keeps the choice for this page only.
  }
  globalThis.dispatchEvent?.(new Event(CHANGE_EVENT));
}

function subscribe(onChange: () => void): () => void {
  globalThis.addEventListener?.(CHANGE_EVENT, onChange);
  globalThis.addEventListener?.("storage", onChange);
  return () => {
    globalThis.removeEventListener?.(CHANGE_EVENT, onChange);
    globalThis.removeEventListener?.("storage", onChange);
  };
}

/** Test support: forget the page-local copy. */
export function resetHsaBoundedModeForTests(): void {
  pageValue = null;
}

export function HsaBoundedModeProvider({ children }: { children: ReactNode }) {
  // The server render (and hydration) uses ON; the stored choice applies on the client.
  const bounded = useSyncExternalStore(subscribe, readStored, () => true);
  const [moreBadgeCount, setMoreBadgeCount] = useState(0);
  const setBounded = useCallback((next: boolean) => writeStored(next), []);
  const value = useMemo<HsaBoundedMode>(
    () => ({ bounded, setBounded, moreBadgeCount: bounded ? 0 : moreBadgeCount, setMoreBadgeCount }),
    [bounded, setBounded, moreBadgeCount],
  );
  return <HsaBoundedModeContext.Provider value={value}>{children}</HsaBoundedModeContext.Provider>;
}

/** Without a provider (e.g. in isolated tests) the mode is ON and the setters do nothing. */
export function useHsaBoundedMode(): HsaBoundedMode {
  return useContext(HsaBoundedModeContext);
}

/** The small tag every preview element carries, next to its heading. */
export function PreviewTag({ messages }: { messages: AppMessages }) {
  return <span className="tag tag--preview">{messages.hsa.previewTag}</span>;
}

/** Shown at the top of every screen while HSA-bounded mode is off; tapping it opens More, where the setting is. */
export function PreviewModeBanner({ messages, onOpenSetting }: { messages: AppMessages; onOpenSetting: () => void }) {
  const { bounded } = useHsaBoundedMode();
  if (bounded) return null;
  return (
    <button type="button" className="preview-mode-banner" onClick={onOpenSetting}>
      {messages.hsa.banner}
    </button>
  );
}
