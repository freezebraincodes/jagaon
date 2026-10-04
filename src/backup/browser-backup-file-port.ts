import type { BackupFilePort, BackupSaveOutcome } from "./backup-export-service";

/**
 * Browser save boundary (spec 7.6; frozen resolution 2). Where the File
 * System Access API is available and the patient picks a location, a
 * completed `close()` is reported as `FILE_WRITE_CONFIRMED`. Otherwise the
 * browser download is started and reported only as `DOWNLOAD_STARTED`, which
 * proves nothing about retention. Cancelling the picker is `CANCELLED`.
 */

type Writable = { write(data: Blob): Promise<void>; close(): Promise<void>; abort?(): Promise<void> };
type SaveFilePicker = (options: { suggestedName: string; types: Array<{ description: string; accept: Record<string, string[]> }> }) => Promise<{
  createWritable(): Promise<Writable>;
}>;

export class BackupFileWriteError extends Error {
  readonly name = "BackupFileWriteError";
  constructor() {
    super("The backup file could not be written");
  }
}

export function createBrowserBackupFilePort(environment: { window?: Window & { showSaveFilePicker?: SaveFilePicker }; document?: Document } = globalThis as never): BackupFilePort {
  return Object.freeze({
    async save(file: Blob, fileName: string): Promise<BackupSaveOutcome> {
      const picker = environment.window?.showSaveFilePicker;
      // Fall back to a download only when the File System Access API is absent.
      if (typeof picker === "function") {
        let handle: Awaited<ReturnType<SaveFilePicker>>;
        try {
          handle = await picker.call(environment.window, {
            suggestedName: fileName,
            types: [{ description: "JagaOn backup", accept: { "application/octet-stream": [".jagaon"] } }],
          });
        } catch (error) {
          if ((error as { name?: unknown } | null)?.name === "AbortError") return "CANCELLED";
          throw new BackupFileWriteError();
        }
        // After a location was chosen, any failure fails closed: no second, silent download.
        let writable: Writable | null = null;
        try {
          writable = await handle.createWritable();
          await writable.write(file);
          await writable.close();
          return "FILE_WRITE_CONFIRMED";
        } catch {
          await writable?.abort?.().catch(() => undefined);
          throw new BackupFileWriteError();
        }
      }
      const document = environment.document;
      if (!document) throw new Error("DOWNLOAD_UNAVAILABLE");
      const url = URL.createObjectURL(file);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      link.rel = "noopener";
      link.style.display = "none";
      document.body.appendChild(link);
      link.click();
      link.remove();
      // Revoke after the browser has taken the Blob URL.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      return "DOWNLOAD_STARTED";
    },
  });
}
