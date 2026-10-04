import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RestorePlan } from "@/application/restore/restore-contracts";
import { lockStateFor } from "@/application/storage/integrity-gate";
import { getMessages } from "@/i18n/get-messages";
import { storageFailure } from "@/storage/storage-failure";
import { IntegrityShell } from "./IntegrityShell";
import { RestoreBackupPanel } from "./RestoreBackupPanel";
import type { RestorePort } from "./data-ports";

afterEach(() => cleanup());

const NOW = "2026-10-04T06:10:00.000Z";
const counts = { glucoseReadings: 148, medicineEntries: 63, mealEntries: 41, healthChecksAppointments: 6 };

function plan(mode: RestorePlan["mode"], extra: Partial<RestorePlan["effects"]> = {}): RestorePlan {
  return {
    operationId: "op",
    planHash: "a".repeat(64) as never,
    createdAt: NOW as never,
    expiresAt: "2026-10-04T06:20:00.000Z" as never,
    mode,
    containerId: "c",
    datasetIdentity: "d",
    sourceBackupSchemaVersion: 1,
    currentFingerprint: "",
    payloadFingerprint: "",
    targetDigest: "",
    effects: { exportedAt: "2026-10-04T02:00:00.000Z" as never, counts, newerRecordsDiscarded: 0, protectedDeletions: 0, runtimePointersReplaced: 0, externalCopiesUnchanged: true, ...extra },
    target: { tables: {} as never, eventSequenceHighWaterMark: 0 },
  };
}

function setup(port: RestorePort, locale: "en-SG" | "zh-SG" = "en-SG", reconciliation: () => Promise<"COMPLETED" | "LOCKED"> = async () => "COMPLETED") {
  const onOpenToday = vi.fn();
  const onCreateBackup = vi.fn();
  render(<RestoreBackupPanel messages={getMessages(locale)} locale={locale} port={port} awaitReconciliation={reconciliation} onCancel={vi.fn()} onCreateBackup={onCreateBackup} onOpenToday={onOpenToday} now={() => NOW} />);
  return { onOpenToday, onCreateBackup };
}

function chooseAndCheck(messages: ReturnType<typeof getMessages>, passphrase = "correct horse battery staple") {
  const file = new File(['{"format":"jagaon-encrypted-backup"}'], "JagaOn-backup-2026-10-04.jagaon");
  fireEvent.change(screen.getByLabelText(messages.packet10.restore.chooseFile), { target: { files: [file] } });
  fireEvent.change(screen.getByLabelText(messages.packet10.restore.restorePassphrase), { target: { value: passphrase } });
  fireEvent.click(screen.getByRole("button", { name: messages.packet10.restore.inspectAction }));
}

describe("frames 04–05 choose a backup and the combined authentication failure", () => {
  const en = getMessages("en-SG");

  it("treats the file as untrusted and shows one combined message for wrong passphrase or changed file", async () => {
    const port: RestorePort = { inspect: vi.fn(async () => ({ kind: "FAILED" as const, failure: storageFailure("RESTORE_BACKUP", "BACKUP_AUTHENTICATION_FAILED", NOW as never) })), confirm: vi.fn() };
    setup(port);
    expect(screen.getByText(en.packet10.restore.untrusted)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: en.packet10.restore.inspectAction })).toBeDisabled();
    chooseAndCheck(en);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(en.packet10.restore.authenticationFailed);
    expect(alert).toHaveTextContent(en.packet10.restore.authHelp);
    expect(screen.getByText("JagaOn-backup-2026-10-04.jagaon")).toBeInTheDocument();
    expect(screen.getByLabelText(en.packet10.restore.restorePassphrase)).toHaveValue("");
    expect(port.confirm).not.toHaveBeenCalled();
  });

  it.each([
    ["BACKUP_LINEAGE_MISMATCH", "differentDataset"],
    ["BACKUP_VERSION_UNSUPPORTED", "unsupportedVersion"],
    ["BACKUP_PAYLOAD_INVALID", "restoreFailed"],
  ] as const)("maps %s to the closed %s banner", async (code, key) => {
    setup({ inspect: vi.fn(async () => ({ kind: "FAILED" as const, failure: storageFailure("RESTORE_BACKUP", code, NOW as never) })), confirm: vi.fn() });
    chooseAndCheck(en);
    expect(await screen.findByRole("alert")).toHaveTextContent(en.packet10.restore[key]);
  });
});

describe("frames 06–08 plan, confirmation and sequential progress", () => {
  const en = getMessages("en-SG");

  it("restores into an empty JagaOn, then shows RESTORING, RECONCILING and COMPLETED one at a time", async () => {
    let finishReconciliation: (value: "COMPLETED") => void = () => undefined;
    let finishCommit: (value: { kind: "COMMITTED" }) => void = () => undefined;
    const port: RestorePort = {
      inspect: vi.fn(async () => ({ kind: "PLAN_READY" as const, plan: plan("RESTORE_INTO_EMPTY_DATABASE") })),
      confirm: vi.fn(() => new Promise<{ kind: "COMMITTED" }>((resolve) => (finishCommit = resolve))),
    };
    const { onOpenToday } = setup(port, "en-SG", () => new Promise((resolve) => (finishReconciliation = resolve)));
    chooseAndCheck(en);
    expect(await screen.findByText(en.packet10.restore.emptyPlan)).toBeInTheDocument();
    expect(screen.getByText(en.packet10.restore.planCounts.glucoseReadings("148"))).toBeInTheDocument();
    expect(screen.getByText(en.packet10.restore.planExported("4 Oct 2026"))).toBeInTheDocument();
    expect(screen.getByText(en.packet10.restore.planExpires)).toBeInTheDocument();
    expect(screen.queryByText(en.packet10.restore.freshBackupFirst)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en.packet10.restore.restoreEmptyAction }));

    expect(await screen.findByRole("heading", { name: en.packet10.restore.restoring })).toBeInTheDocument();
    expect(screen.queryByText(en.packet10.restore.reconciling)).not.toBeInTheDocument();
    expect(screen.getByText(en.packet10.restore.noFaster)).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("value", "3");
    await act(async () => finishCommit({ kind: "COMMITTED" }));
    expect(await screen.findByText(en.packet10.restore.reconciling)).toBeInTheDocument();
    expect(screen.queryByText(en.packet10.restore.restoreDone)).not.toBeInTheDocument();
    await act(async () => finishReconciliation("COMPLETED"));
    expect(await screen.findByText(en.packet10.restore.restoreDone)).toBeInTheDocument();
    expect(screen.queryByText(en.packet10.restore.reconciling)).not.toBeInTheDocument();
    expect(screen.getByText(en.packet10.restore.doneNoShare)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en.packet10.shared.openToday }));
    expect(onOpenToday).toHaveBeenCalled();
  });

  it("frame 07 warns about replacement and requires an alertdialog confirmation focused on Cancel", async () => {
    const port: RestorePort = {
      inspect: vi.fn(async () => ({ kind: "PLAN_READY" as const, plan: plan("REPLACE_SAME_LINEAGE_DATABASE", { newerRecordsDiscarded: 3, protectedDeletions: 2 }) })),
      confirm: vi.fn(async () => ({ kind: "COMMITTED" as const })),
    };
    const { onCreateBackup } = setup(port);
    chooseAndCheck(en);
    expect(await screen.findByText(en.packet10.restore.replacementPlan("4 Oct 2026"))).toBeInTheDocument();
    expect(screen.getByText(en.packet10.restore.willBeLostV("3"))).toBeInTheDocument();
    expect(screen.getByText(en.packet10.restore.deletionProtected("2"))).toBeInTheDocument();
    expect(screen.getByText(en.packet10.restore.freshBackupFirst)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en.packet10.hub.createBackup }));
    expect(onCreateBackup).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: en.packet10.restore.restoreConfirm }));
    const dialog = screen.getByRole("alertdialog", { name: en.packet10.restore.restoreConfirm });
    expect(within(dialog).getByRole("button", { name: en.packet10.shared.cancel })).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(port.confirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: en.packet10.restore.restoreConfirm }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: en.packet10.restore.restoreConfirm }));
    await waitFor(() => expect(port.confirm).toHaveBeenCalledTimes(1));
  });

  it("returns to the form when the plan became stale, with nothing restored", async () => {
    const port: RestorePort = {
      inspect: vi.fn(async () => ({ kind: "PLAN_READY" as const, plan: plan("RESTORE_INTO_EMPTY_DATABASE") })),
      confirm: vi.fn(async () => ({ kind: "STALE" as const, failure: storageFailure("RESTORE_BACKUP", "RESTORE_CONFIRMATION_STALE", NOW as never) })),
    };
    setup(port);
    chooseAndCheck(en);
    fireEvent.click(await screen.findByRole("button", { name: en.packet10.restore.restoreEmptyAction }));
    expect(await screen.findByRole("alert")).toHaveTextContent(en.packet10.restore.restoreFailed);
  });

  it("renders the zh-SG plan with locale counts and an untranslated file name", async () => {
    const zh = getMessages("zh-SG");
    setup({ inspect: vi.fn(async () => ({ kind: "PLAN_READY" as const, plan: plan("RESTORE_INTO_EMPTY_DATABASE") })), confirm: vi.fn() }, "zh-SG");
    chooseAndCheck(zh);
    expect(await screen.findByText(zh.packet10.restore.emptyPlan)).toBeInTheDocument();
    expect(screen.getByText(zh.packet10.restore.planCounts.medicineEntries("63"))).toBeInTheDocument();
    expect(screen.getByText("JagaOn-backup-2026-10-04.jagaon")).toBeInTheDocument();
  });
});

describe("frame 09 blocked reconciliation recovery", () => {
  it("states what was written, not rebuilt and locked, with no health claim", () => {
    const en = getMessages("en-SG");
    const onRestore = vi.fn();
    render(
      <IntegrityShell
        messages={en}
        lock={lockStateFor(storageFailure("RESTORE_RECONCILE", "RESTORE_RECONCILIATION_FAILED", NOW as never))}
        onRetry={vi.fn()}
        onRestore={onRestore}
        deleteAll={{ prepare: vi.fn(), confirm: vi.fn() }}
        onDeleted={vi.fn()}
      />,
    );
    expect(screen.getByRole("heading", { level: 1, name: en.packet10.restore.restoreTitle })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(en.packet10.restore.recoveryRequired);
    for (const text of [en.packet10.restore.blockWritten, en.packet10.restore.blockNotRebuilt, en.packet10.restore.blockLocked, en.packet10.shared.noHealthClaim]) {
      expect(screen.getByText(text)).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole("button", { name: en.packet10.integrity.openBackupRecovery }));
    expect(onRestore).toHaveBeenCalled();
  });
});
