import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserBackupFilePort } from "./browser-backup-file-port";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const file = () => new Blob(["{}"], { type: "application/octet-stream" });

describe("browser backup file port (BAK-015, frozen resolution 2)", () => {
  it("reports FILE_WRITE_CONFIRMED only after a file-write API completes", async () => {
    const steps: string[] = [];
    const showSaveFilePicker = vi.fn(async () => ({
      async createWritable() {
        return { write: async () => void steps.push("write"), close: async () => void steps.push("close") };
      },
    }));
    const port = createBrowserBackupFilePort({ window: { showSaveFilePicker } as never, document });
    expect(await port.save(file(), "JagaOn-backup-2026-10-04.jagaon")).toBe("FILE_WRITE_CONFIRMED");
    expect(steps).toEqual(["write", "close"]);
    expect(showSaveFilePicker).toHaveBeenCalledWith(expect.objectContaining({ suggestedName: "JagaOn-backup-2026-10-04.jagaon" }));
  });

  it("reports a cancelled picker as CANCELLED and never as a download", async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click");
    const showSaveFilePicker = vi.fn(async () => {
      throw Object.assign(new Error("user"), { name: "AbortError" });
    });
    const port = createBrowserBackupFilePort({ window: { showSaveFilePicker } as never, document });
    expect(await port.save(file(), "JagaOn-backup-2026-10-04.jagaon")).toBe("CANCELLED");
    expect(click).not.toHaveBeenCalled();
  });

  it("falls back to a started download that claims nothing about retention", async () => {
    // jsdom has no object URLs; supply them for this test only.
    const created = vi.fn(() => "blob:jagaon-test");
    vi.stubGlobal("URL", Object.assign(Object.create(URL), { createObjectURL: created, revokeObjectURL: vi.fn() }));
    let clicked: HTMLAnchorElement | null = null;
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked = this;
    });
    const port = createBrowserBackupFilePort({ window: {} as never, document });
    expect(await port.save(file(), "JagaOn-backup-2026-10-04.jagaon")).toBe("DOWNLOAD_STARTED");
    expect(created).toHaveBeenCalledTimes(1);
    expect(clicked!.download).toBe("JagaOn-backup-2026-10-04.jagaon");
    expect(clicked!.isConnected).toBe(false);
  });

  const stubObjectUrls = () => vi.stubGlobal("URL", Object.assign(Object.create(URL), { createObjectURL: vi.fn(() => "blob:jagaon-test"), revokeObjectURL: vi.fn() }));

  it.each(["createWritable", "write", "close"] as const)("fails closed when %s fails after a location was chosen, with no second download", async (stage) => {
    stubObjectUrls();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const abort = vi.fn(async () => undefined);
    const fail = async () => {
      throw Object.assign(new Error("disk full"), { name: "QuotaExceededError" });
    };
    const showSaveFilePicker = vi.fn(async () => ({
      createWritable: stage === "createWritable" ? fail : async () => ({ write: stage === "write" ? fail : async () => undefined, close: stage === "close" ? fail : async () => undefined, abort }),
    }));
    const port = createBrowserBackupFilePort({ window: { showSaveFilePicker } as never, document });
    await expect(port.save(file(), "JagaOn-backup-2026-10-04.jagaon")).rejects.toBeTruthy();
    expect(click).not.toHaveBeenCalled();
    if (stage !== "createWritable") expect(abort).toHaveBeenCalledTimes(1);
  });

  it("does not fall back to a download when the save picker itself fails for another reason", async () => {
    stubObjectUrls();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const showSaveFilePicker = vi.fn(async () => {
      throw Object.assign(new Error("blocked"), { name: "SecurityError" });
    });
    const port = createBrowserBackupFilePort({ window: { showSaveFilePicker } as never, document });
    await expect(port.save(file(), "JagaOn-backup-2026-10-04.jagaon")).rejects.toBeTruthy();
    expect(click).not.toHaveBeenCalled();
  });
});
