/**
 * Packet 11C Addendum C, Task C2 fix round 1 (I-1): tells the other open tabs of the same dataset that the patient's "Keep wording on
 * this device" setting changed, so they re-read the STORED value and update their in-memory value and UI. Same BroadcastChannel pattern
 * as browser-dataset-lifecycle.ts. The notice carries no value (receivers read the store), no health truth and no identifier beyond the
 * local database name and a random per-runtime sender id; it is never the authority: every AI request also awaits the stored value.
 * Where BroadcastChannel is unavailable nothing is announced and the awaited read alone keeps other tabs correct.
 */

const CHANNEL = "jagaon-keep-wording-setting";
const NOTICE = "KEEP_WORDING_CHANGED";

type Message = { type?: unknown; databaseName?: unknown; senderId?: unknown };

export type KeepWordingChangeNotice = Readonly<{
  /** Announces a stored change to every other runtime of this dataset (never to this one). Never throws. */
  announce(): void;
  /** Calls `listener` when another runtime of this dataset announced a change; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
  close(): void;
}>;

export function createKeepWordingChangeNotice(databaseName: string): KeepWordingChangeNotice {
  const senderId = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Math.random());
  const listeners = new Set<() => void>();
  let bus: BroadcastChannel | null = null;
  let closed = false;

  function open(): BroadcastChannel | null {
    if (bus || closed) return bus;
    if (typeof BroadcastChannel !== "function") return null;
    bus = new BroadcastChannel(CHANNEL);
    // Node's implementation (tests) must not keep the process alive.
    (bus as unknown as { unref?: () => void }).unref?.();
    bus.onmessage = (event: MessageEvent<Message>) => {
      const message = event.data;
      if (!message || message.type !== NOTICE || message.databaseName !== databaseName || message.senderId === senderId) return;
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch {
          // One listener's failure never stops the others.
        }
      }
    };
    return bus;
  }

  return Object.freeze({
    announce() {
      try {
        open()?.postMessage({ type: NOTICE, databaseName, senderId });
      } catch {
        // Best effort only: the stored value stays the authority.
      }
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      try {
        open();
      } catch {
        // Without a channel, the awaited stored value still decides every request.
      }
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      closed = true;
      listeners.clear();
      bus?.close();
      bus = null;
    },
  });
}
