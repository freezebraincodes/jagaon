import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireDatasetPresence, createBrowserDatasetCoordinator } from "./browser-dataset-lifecycle";

/** A minimal Web Locks double whose releases settle asynchronously, like real browsers. */
function fakeLockManager() {
  const held = new Map<string, { mode: string; count: number }>();
  return {
    held,
    async request(name: string, options: { mode: "shared" | "exclusive"; ifAvailable?: boolean }, callback: (lock: unknown) => Promise<void> | void) {
      const current = held.get(name);
      const available = !current || (current.mode === "shared" && options.mode === "shared");
      if (!available) {
        if (options.ifAvailable) return callback(null);
        throw new Error("would wait");
      }
      held.set(name, { mode: options.mode, count: (current?.count ?? 0) + 1 });
      try {
        await callback({ name });
      } finally {
        await new Promise((resolve) => setTimeout(resolve, 5));
        const entry = held.get(name)!;
        if (--entry.count === 0) held.delete(name);
      }
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("browser dataset coordination (SDEL-012)", () => {
  it("does not block itself: its own shared lock is fully released before the exclusive probe", async () => {
    const locks = fakeLockManager();
    vi.stubGlobal("navigator", { locks });
    await acquireDatasetPresence("jagaon-test", () => undefined);
    const release = await createBrowserDatasetCoordinator("jagaon-test").acquireExclusive();
    expect(release).toEqual(expect.any(Function));
    release!();
  });

  it("is blocked while another tab holds the dataset, and nothing is requested", async () => {
    const locks = fakeLockManager();
    vi.stubGlobal("navigator", { locks });
    locks.held.set("jagaon-dataset:jagaon-other", { mode: "shared", count: 1 });
    expect(await createBrowserDatasetCoordinator("jagaon-other").acquireExclusive()).toBeNull();
  });

  it("restores this tab's shared presence after a blocked exclusive attempt (item 4)", async () => {
    const locks = fakeLockManager();
    vi.stubGlobal("navigator", { locks });
    await acquireDatasetPresence("jagaon-two-tabs", () => undefined);
    // Another tab also holds the dataset, so this tab's attempt is blocked.
    locks.held.get("jagaon-dataset:jagaon-two-tabs")!.count += 1;
    expect(await createBrowserDatasetCoordinator("jagaon-two-tabs").acquireExclusive()).toBeNull();
    // The other tab leaves: this tab must still be visible to any further exclusive probe.
    locks.held.get("jagaon-dataset:jagaon-two-tabs")!.count -= 1;
    expect(locks.held.get("jagaon-dataset:jagaon-two-tabs")?.count).toBe(1);
    const probe = await new Promise<unknown>((resolve) => void locks.request("jagaon-dataset:jagaon-two-tabs", { mode: "exclusive", ifAvailable: true }, (lock) => resolve(lock)));
    expect(probe).toBeNull();
  });

  it("does not answer its own presence ping when Web Locks are unavailable", async () => {
    vi.stubGlobal("navigator", {});
    await acquireDatasetPresence("jagaon-fallback", () => undefined);
    const release = await createBrowserDatasetCoordinator("jagaon-fallback").acquireExclusive();
    expect(release).toEqual(expect.any(Function));
  });
});
