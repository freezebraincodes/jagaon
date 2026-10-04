import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackupExportResult } from "@/backup/backup-export-service";
import { getMessages } from "@/i18n/get-messages";
import { storageFailure } from "@/storage/storage-failure";
import { CreateBackupPanel } from "./CreateBackupPanel";
import { DataBackupScreen } from "./DataBackupScreen";
import type { BackupExportPort } from "./data-ports";

afterEach(() => cleanup());

const NOW = "2026-10-04T06:10:00.000Z";
const PASS = "correct horse battery staple";

function exportPort(result: BackupExportResult) {
  return {
    export: vi.fn(async (_request: { passphrase: string; confirmation: string }, events?: { onStepCompleted?(step: 0 | 1 | 2 | 3): void }) => {
      for (const step of [0, 1, 2] as const) events?.onStepCompleted?.(step);
      if (result.kind === "DOWNLOAD_STARTED" || result.kind === "FILE_WRITE_CONFIRMED") events?.onStepCompleted?.(3);
      return result;
    }),
  } satisfies BackupExportPort;
}

function renderCreate(port: BackupExportPort, locale: "en-SG" | "zh-SG" = "en-SG") {
  const onDone = vi.fn();
  render(<CreateBackupPanel messages={getMessages(locale)} locale={locale} port={port} onDone={onDone} now={() => NOW} />);
  return onDone;
}

function fill(messages: ReturnType<typeof getMessages>, first: string, second: string) {
  fireEvent.change(screen.getByLabelText(messages.packet10.backup.passphrase), { target: { value: first } });
  const confirm = screen.getByLabelText(messages.packet10.backup.confirmPassphrase);
  fireEvent.change(confirm, { target: { value: second } });
  fireEvent.blur(confirm);
}

describe("frame 01 Data and backup hub", () => {
  it("states the live-storage limit, offline boundary and keeps delete-all last and separate", () => {
    const en = getMessages("en-SG");
    render(
      <DataBackupScreen messages={en} view="hub" showView={vi.fn()} deleteAll={{ prepare: vi.fn(), confirm: vi.fn() }} onDeleted={vi.fn()} createPanel={<p>panel</p>} />,
    );
    expect(screen.getByRole("heading", { level: 1, name: en.packet10.hub.title })).toBeInTheDocument();
    for (const text of [en.packet10.hub.intro, en.packet10.hub.liveStorageLimit, en.packet10.hub.hubLast, en.packet10.hub.offline, en.packet10.hub.deleteAllHelp]) {
      expect(screen.getByText(text)).toBeInTheDocument();
    }
    const buttons = screen.getAllByRole("button").map((button) => button.textContent);
    expect(buttons).toEqual([en.packet10.hub.createBackup, en.packet10.hub.deleteAll]);
  });
});

describe("frames 02–03 create an encrypted backup", () => {
  const en = getMessages("en-SG");

  it("keeps passphrases masked by default, toggles Show and blocks a mismatch with nothing created", () => {
    const port = exportPort({ kind: "DOWNLOAD_STARTED", fileName: "JagaOn-backup-2026-10-04.jagaon", preparedAt: NOW as never });
    renderCreate(port);
    const first = screen.getByLabelText(en.packet10.backup.passphrase);
    expect(first).toHaveAttribute("type", "password");
    expect(first).toHaveAttribute("autocomplete", "new-password");
    fireEvent.click(screen.getByRole("button", { name: en.packet10.shared.show }));
    expect(first).toHaveAttribute("type", "text");
    fill(en, PASS, `${PASS}!`);
    expect(screen.getByRole("alert")).toHaveTextContent(en.packet10.backup.passphraseMismatch);
    expect(screen.getByLabelText(en.packet10.backup.confirmPassphrase)).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: en.packet10.backup.createAction })).toBeDisabled();
    expect(screen.getByText(en.packet10.backup.passphraseLoss)).toBeInTheDocument();
    expect(screen.getByText(en.packet10.backup.fileNameNote("JagaOn-backup-2026-10-04.jagaon"))).toBeInTheDocument();
    expect(port.export).not.toHaveBeenCalled();
  });

  it("requires 12 or more characters before preparing", () => {
    renderCreate(exportPort({ kind: "CANCELLED" }));
    fill(en, "short pass", "short pass");
    expect(screen.getByRole("button", { name: en.packet10.backup.createAction })).toBeDisabled();
  });

  it("shows download-started with the not-proof note, never a confirmed save", async () => {
    const port = exportPort({ kind: "DOWNLOAD_STARTED", fileName: "JagaOn-backup-2026-10-04.jagaon", preparedAt: NOW as never });
    const onDone = renderCreate(port);
    fill(en, PASS, PASS);
    fireEvent.click(screen.getByRole("button", { name: en.packet10.backup.createAction }));
    expect(await screen.findByText(en.packet10.backup.downloadStarted)).toBeInTheDocument();
    expect(screen.queryByText(en.packet10.backup.fileWriteConfirmed)).not.toBeInTheDocument();
    expect(screen.getByText(en.packet10.backup.notProof)).toBeInTheDocument();
    expect(screen.getByText("JagaOn-backup-2026-10-04.jagaon")).toBeInTheDocument();
    expect(screen.getByText(en.packet10.backup.preparedAt("2:10 pm"))).toBeInTheDocument();
    for (const step of en.packet10.backup.prepSteps) expect(screen.getByText(step)).toBeInTheDocument();
    expect(screen.getByText(en.packet10.backup.fileContains)).toBeInTheDocument();
    expect(port.export).toHaveBeenCalledWith({ passphrase: PASS, confirmation: PASS }, expect.anything());
    fireEvent.click(screen.getByRole("button", { name: en.packet10.shared.done }));
    expect(onDone).toHaveBeenCalled();
  });

  it("shows the confirmed file-write variant without the not-proof note", async () => {
    renderCreate(exportPort({ kind: "FILE_WRITE_CONFIRMED", fileName: "JagaOn-backup-2026-10-04.jagaon", preparedAt: NOW as never }));
    fill(en, PASS, PASS);
    fireEvent.click(screen.getByRole("button", { name: en.packet10.backup.createAction }));
    expect(await screen.findByText(en.packet10.backup.fileWriteConfirmed)).toBeInTheDocument();
    expect(screen.queryByText(en.packet10.backup.notProof)).not.toBeInTheDocument();
  });

  it.each([
    [{ kind: "CANCELLED" } as BackupExportResult, "saveCancelled"],
    [{ kind: "FAILED", failure: storageFailure("EXPORT_BACKUP", "BACKUP_TOO_LARGE_FOR_FORMAT_V1", NOW as never) } as BackupExportResult, "backupTooLarge"],
    [{ kind: "FAILED", failure: storageFailure("EXPORT_BACKUP", "SECURE_CONTEXT_REQUIRED", NOW as never) } as BackupExportResult, "backupFailed"],
  ] as const)("returns to the form with the closed %s message and clears the passphrase", async (result, key) => {
    renderCreate(exportPort(result));
    fill(en, PASS, PASS);
    fireEvent.click(screen.getByRole("button", { name: en.packet10.backup.createAction }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(en.packet10.backup[key]));
    expect(screen.getByLabelText(en.packet10.backup.passphrase)).toHaveValue("");
  });

  it("renders zh-SG with the same structure and untranslated file name", async () => {
    const zh = getMessages("zh-SG");
    renderCreate(exportPort({ kind: "DOWNLOAD_STARTED", fileName: "JagaOn-backup-2026-10-04.jagaon", preparedAt: NOW as never }), "zh-SG");
    fill(zh, "晚安晚安晚安晚安晚安晚安", "晚安晚安晚安晚安晚安晚安");
    fireEvent.click(screen.getByRole("button", { name: zh.packet10.backup.createAction }));
    expect(await screen.findByText(zh.packet10.backup.downloadStarted)).toBeInTheDocument();
    expect(screen.getByText("JagaOn-backup-2026-10-04.jagaon")).toBeInTheDocument();
    expect(screen.getByText(zh.packet10.backup.notProof)).toBeInTheDocument();
  });
});
