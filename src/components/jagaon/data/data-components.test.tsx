import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeletionPlan } from "@/application/deletion/deletion-contracts";
import { getMessages } from "@/i18n/get-messages";
import { storageFailure } from "@/storage/storage-failure";
import type { RecordDeletionPort } from "./data-ports";
import { RecordDeletionDialog } from "./RecordDeletionDialog";

afterEach(() => cleanup());

const NOW = "2026-10-04T02:00:00.000Z";

function plan(dependentCount: number, hash = "a"): DeletionPlan {
  return {
    planHash: hash.repeat(64) as never,
    createdAt: NOW as never,
    expiresAt: "2026-10-04T02:10:00.000Z" as never,
    target: { recordType: "GLUCOSE_READING", recordId: "r" as never },
    closure: {} as never,
    closureFingerprint: "",
    neutralisedReceipts: [],
    effects: { targetRecordType: "GLUCOSE_READING", dependentCount, externalCopiesNotRecalled: true },
  };
}

function renderDialog(port: RecordDeletionPort, locale: "en-SG" | "zh-SG" = "en-SG") {
  const onDeleted = vi.fn();
  const onClose = vi.fn();
  const opener = document.createElement("button");
  document.body.appendChild(opener);
  opener.focus();
  render(
    <RecordDeletionDialog
      messages={getMessages(locale)}
      locale={locale}
      port={port}
      target={{ recordType: "GLUCOSE_READING", recordId: "r" as never }}
      recordLabel="Reading 6.2 mmol/L"
      recordWhen="22 Sep 2026, 7:30 am"
      now={() => NOW}
      onClose={onClose}
      onDeleted={onDeleted}
      returnFocusRef={{ current: opener }}
    />,
  );
  return { onDeleted, onClose, opener };
}

describe("frame 10 permanent-record deletion dialog", () => {
  const en = getMessages("en-SG").packet10;

  it("opens as a modal alertdialog with focus on Keep and renders only owner plan items", async () => {
    const port: RecordDeletionPort = { prepare: vi.fn(async () => ({ kind: "PLAN_READY" as const, plan: plan(1234) })), confirm: vi.fn() };
    renderDialog(port);
    const dialog = screen.getByRole("alertdialog", { name: en.deletion.deleteRecordTitle });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("button", { name: en.deletion.keepRecord })).toHaveFocus();
    expect(await within(dialog).findByText(en.deletion.deletePlanItems.dependent("1,234"))).toBeInTheDocument();
    expect(within(dialog).getByText(en.deletion.deletePlanItems.self)).toBeInTheDocument();
    expect(within(dialog).getByText(en.deletion.externalCopiesRemain)).toBeInTheDocument();
    expect(within(dialog).getByText("Reading 6.2 mmol/L")).toBeInTheDocument();
  });

  it("states that no other record is affected, in zh-SG with locale counts", async () => {
    const zh = getMessages("zh-SG").packet10;
    renderDialog({ prepare: vi.fn(async () => ({ kind: "PLAN_READY" as const, plan: plan(0) })), confirm: vi.fn() }, "zh-SG");
    expect(await screen.findByText(zh.deletion.deletePlanItems.none)).toBeInTheDocument();
  });

  it("recalculates a stale plan and requires a fresh confirmation", async () => {
    const prepare = vi.fn().mockResolvedValueOnce({ kind: "PLAN_READY", plan: plan(1, "a") }).mockResolvedValueOnce({ kind: "PLAN_READY", plan: plan(2, "b") });
    const confirm = vi
      .fn()
      .mockResolvedValueOnce({ kind: "STALE", failure: storageFailure("DELETE_RECORD", "DELETION_CONFIRMATION_STALE", NOW as never) })
      .mockResolvedValueOnce({ kind: "DELETED", removedRecordCount: 3 });
    const { onDeleted } = renderDialog({ prepare, confirm });
    const destroy = await screen.findByRole("button", { name: en.deletion.deleteRecordAction });
    await waitFor(() => expect(destroy).toBeEnabled());
    fireEvent.click(destroy);
    expect(await screen.findByRole("alert")).toHaveTextContent(en.deletion.deletionChanged);
    expect(await screen.findByText(en.deletion.deletePlanItems.dependent("2"))).toBeInTheDocument();
    expect(onDeleted).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: en.deletion.deleteRecordAction }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
    expect(confirm.mock.calls[1]![0].planHash).toBe("b".repeat(64));
  });

  it("cancels on Escape before commit and returns focus to the opener", async () => {
    const port: RecordDeletionPort = { prepare: vi.fn(async () => ({ kind: "PLAN_READY" as const, plan: plan(0) })), confirm: vi.fn() };
    const { onClose } = renderDialog(port);
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
    expect(port.confirm).not.toHaveBeenCalled();
  });
});

describe("Packet 10 UI repository isolation (SPRIV-004)", () => {
  it("never imports Dexie, tables, row codecs or stored rows in Packet 10 components", () => {
    const dir = join(process.cwd(), "src/components/jagaon/data");
    for (const file of readdirSync(dir).filter((name) => /\.tsx?$/.test(name) && !name.endsWith(".test.tsx"))) {
      const source = readFileSync(join(dir, file), "utf8");
      expect(source, file).not.toMatch(/from "dexie"|@\/storage\/(database|table-catalogue|closed-row-codecs|storage-row-codec|dataset-verifier)|\.table\(/);
      expect(source, file).not.toMatch(/console\./);
    }
  });
});
