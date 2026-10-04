import Dexie from "dexie";
import type { DatabaseDeletionPort, DatasetConnectionCoordinator } from "@/storage/delete-dataset";

/**
 * Browser cross-tab coordination for whole-dataset operations (storage-
 * backup-spec 5.4, 6.8, 8.2). Each open runtime holds a shared Web Lock for
 * its dataset; delete-all and restore need the exclusive lock, so another
 * open tab blocks them before anything is requested from IndexedDB. Where Web
 * Locks are unavailable a BroadcastChannel presence ping is used. Neither
 * mechanism is the correctness authority: IndexedDB's own deletion still
 * waits for every connection, and success is verified by checking the
 * database is gone.
 *
 * A blocked exclusive attempt restores this tab's shared presence before it
 * returns, so this tab stays visible to every other tab's probe.
 */

const LOCK_PREFIX = "jagaon-dataset:";
const CHANNEL = "jagaon-dataset-lifecycle";
const PING_WINDOW_MS = 300;
/** Distinguishes this tab's own BroadcastChannel instances from other tabs. */
const TAB_ID = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Math.random());

type LockManagerLike = {
  request(name: string, options: { mode: "shared" | "exclusive"; ifAvailable?: boolean }, callback: (lock: unknown) => Promise<void> | void): Promise<void>;
};

function lockManager(): LockManagerLike | null {
  const locks = (globalThis.navigator as { locks?: LockManagerLike } | undefined)?.locks;
  return locks && typeof locks.request === "function" ? locks : null;
}

function channel(): BroadcastChannel | null {
  if (typeof BroadcastChannel !== "function") return null;
  const bus = new BroadcastChannel(CHANNEL);
  // Node's implementation (tests) must not keep the process alive.
  (bus as unknown as { unref?: () => void }).unref?.();
  return bus;
}

type Message = { type?: string; databaseName?: string; id?: string; tabId?: string };

/** One tab's presence for one dataset; it can be released and re-acquired in place. */
class Presence {
  private releaseLock: (() => void) | null = null;
  private released: Promise<void> = Promise.resolve();
  private bus: BroadcastChannel | null = null;
  private held = false;

  constructor(
    private readonly databaseName: string,
    private readonly onDeletedElsewhere: () => void,
  ) {}

  async acquire(): Promise<void> {
    if (this.held) return;
    this.held = true;
    const locks = lockManager();
    if (locks) {
      await new Promise<void>((granted) => {
        this.released = locks
          .request(`${LOCK_PREFIX}${this.databaseName}`, { mode: "shared" }, () => {
            granted();
            return new Promise<void>((resolve) => (this.releaseLock = resolve));
          })
          .catch(() => granted());
      });
    }
    const bus = channel();
    bus?.addEventListener("message", (message: MessageEvent) => {
      const data = message.data as Message;
      if (data?.databaseName !== this.databaseName || data.tabId === TAB_ID) return;
      if (data.type === "PING") bus.postMessage({ type: "PONG", databaseName: this.databaseName, id: data.id, tabId: TAB_ID });
      if (data.type === "DELETED") this.onDeletedElsewhere();
    });
    this.bus = bus;
  }

  /** Settles only after the lock manager has actually released the shared lock. */
  release(): Promise<void> {
    if (!this.held) return Promise.resolve();
    this.held = false;
    this.releaseLock?.();
    this.releaseLock = null;
    this.bus?.close();
    this.bus = null;
    return this.released;
  }
}

const presences = new Map<string, Presence>();

/**
 * Registers this tab as an open user of `databaseName`, waiting while another
 * tab holds the exclusive lock (a delete-all or restore in progress) so this
 * tab never recreates a database that is being replaced. `onDeletedElsewhere`
 * runs when another tab deletes the dataset; the caller must stop using it.
 */
export async function acquireDatasetPresence(databaseName: string, onDeletedElsewhere: () => void): Promise<() => void> {
  const presence = new Presence(databaseName, onDeletedElsewhere);
  presences.set(databaseName, presence);
  await presence.acquire();
  return () => {
    void presence.release();
    if (presences.get(databaseName) === presence) presences.delete(databaseName);
  };
}

async function othersAnswerPing(databaseName: string): Promise<boolean> {
  const bus = channel();
  if (!bus) return false;
  const id = crypto.randomUUID();
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      bus.close();
      resolve(false);
    }, PING_WINDOW_MS);
    bus.addEventListener("message", (message: MessageEvent) => {
      const data = message.data as Message;
      if (data?.type === "PONG" && data.databaseName === databaseName && data.id === id && data.tabId !== TAB_ID) {
        clearTimeout(timer);
        bus.close();
        resolve(true);
      }
    });
    bus.postMessage({ type: "PING", databaseName, id, tabId: TAB_ID });
  });
}

export function createBrowserDatasetCoordinator(databaseName: string): DatasetConnectionCoordinator {
  return Object.freeze({
    async acquireExclusive() {
      const own = presences.get(databaseName);
      const locks = lockManager();
      if (locks) {
        // This tab's own shared presence must not block itself: wait until the
        // lock manager has really released it before probing for other tabs.
        await own?.release();
        let release: (() => void) | null = null;
        let acquired = false;
        await new Promise<void>((resolveHeld) => {
          void locks
            .request(`${LOCK_PREFIX}${databaseName}`, { mode: "exclusive", ifAvailable: true }, (lock) => {
              if (lock === null) {
                resolveHeld();
                return;
              }
              acquired = true;
              resolveHeld();
              return new Promise<void>((resolveRelease) => (release = resolveRelease));
            })
            .catch(() => resolveHeld());
        });
        if (!acquired) {
          // Blocked: become visible to other tabs again before returning control.
          await own?.acquire();
          return null;
        }
        return () => release?.();
      }
      return (await othersAnswerPing(databaseName)) ? null : () => undefined;
    },
    announceDeleted() {
      const bus = channel();
      bus?.postMessage({ type: "DELETED", databaseName, tabId: TAB_ID });
      bus?.close();
    },
  });
}

export function createBrowserDatabaseDeletion(): DatabaseDeletionPort {
  return Object.freeze({
    deleteDatabase(name: string, onBlocked: () => void) {
      return new Promise<void>((resolve, reject) => {
        const request = Dexie.dependencies.indexedDB.deleteDatabase(name);
        request.onblocked = () => onBlocked();
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    },
    exists: (name: string) => Dexie.exists(name),
  });
}
