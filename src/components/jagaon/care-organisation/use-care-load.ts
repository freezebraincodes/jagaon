"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Loads a read projection after render and on every `reload()`. Only the
 * latest request may update the view; a missing port or a thrown load
 * becomes the caller's unavailable value, never an empty success.
 */
export function useCareLoad<T>(load: (() => Promise<T>) | null, unavailable: T): { value: T | null; reload: () => void } {
  const [value, setValue] = useState<T | null>(null);
  const [attempt, setAttempt] = useState(0);
  const latest = useRef(0);
  const unavailableRef = useRef(unavailable);

  useEffect(() => {
    const request = latest.current + 1;
    latest.current = request;
    void Promise.resolve()
      .then(() => (load ? load() : unavailableRef.current))
      .then((next) => {
        if (latest.current === request) setValue(next);
      })
      .catch(() => {
        if (latest.current === request) setValue(unavailableRef.current);
      });
    return () => {
      // A result arriving after unmount or a newer request is ignored.
      if (latest.current === request) latest.current = request + 1;
    };
  }, [load, attempt]);

  const reload = useCallback(() => setAttempt((count) => count + 1), []);
  return { value, reload };
}
