import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/get-messages";
import type { DeleteAllPort } from "../data/data-ports";
import { SettingsScreen } from "./SettingsScreen";

afterEach(() => cleanup());

function deletePort(result: Awaited<ReturnType<DeleteAllPort["confirm"]>> = { kind: "DELETED", localStateCleared: true }) {
  return {
    prepare: vi.fn(() => ({ createdAt: "2026-10-04T02:00:00.000Z" as never, expiresAt: "2026-10-04T02:10:00.000Z" as never })),
    confirm: vi.fn(async () => result),
  } satisfies DeleteAllPort;
}

describe("SettingsScreen", () => {
  it("persists an explicit locale selection", async () => {
    const persistLocale = vi.fn().mockResolvedValue(undefined);
    const messages = getMessages("en-SG");
    render(
      <SettingsScreen
        messages={messages}
        locale="en-SG"
        setLocale={vi.fn()}
        persistLocale={persistLocale}
        deleteAll={deletePort()}
        onDatasetDeleted={vi.fn()}
        goBack={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: messages.settings.chinese }));
    await waitFor(() => expect(persistLocale).toHaveBeenCalledWith("zh-SG"));
  });

  it("deletes all local data only after the exact typed DELETE confirmation (frame 11)", async () => {
    const messages = getMessages("en-SG");
    const port = deletePort();
    const onDatasetDeleted = vi.fn();
    render(
      <SettingsScreen messages={messages} locale="en-SG" setLocale={vi.fn()} persistLocale={vi.fn()} deleteAll={port} onDatasetDeleted={onDatasetDeleted} />,
    );
    const opener = screen.getByRole("button", { name: messages.packet10.hub.deleteAll });
    fireEvent.click(opener);
    const dialog = screen.getByRole("alertdialog", { name: messages.packet10.deletion.deleteAllTitle });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    // Focus opens on the safe action; the destructive action is never the default.
    expect(screen.getByRole("button", { name: messages.packet10.deletion.keepData })).toHaveFocus();
    const destroy = screen.getByRole("button", { name: messages.packet10.deletion.deleteAllAction });
    expect(destroy).toBeDisabled();
    fireEvent.change(screen.getByLabelText(messages.packet10.deletion.typeToConfirm), { target: { value: "delete" } });
    expect(destroy).toBeDisabled();
    fireEvent.change(screen.getByLabelText(messages.packet10.deletion.typeToConfirm), { target: { value: "DELETE" } });
    expect(destroy).toBeEnabled();
    fireEvent.click(destroy);
    await waitFor(() => expect(onDatasetDeleted).toHaveBeenCalledTimes(1));
    expect(port.confirm).toHaveBeenCalledWith(expect.anything(), "DELETE", expect.anything());
  });

  it("keeps the data, closes on Escape and returns focus to the opener", () => {
    const messages = getMessages("zh-SG");
    const port = deletePort();
    render(<SettingsScreen messages={messages} locale="zh-SG" setLocale={vi.fn()} persistLocale={vi.fn()} deleteAll={port} onDatasetDeleted={vi.fn()} />);
    const opener = screen.getByRole("button", { name: messages.packet10.hub.deleteAll });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
    expect(port.confirm).not.toHaveBeenCalled();
  });

  it("states that nothing was deleted while another tab blocks it", async () => {
    const messages = getMessages("en-SG");
    const port = deletePort({
      kind: "BLOCKED",
      failure: { userMessageKey: "packet10.deletion.deleteBlocked" } as never,
    });
    render(<SettingsScreen messages={messages} locale="en-SG" setLocale={vi.fn()} persistLocale={vi.fn()} deleteAll={port} onDatasetDeleted={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: messages.packet10.hub.deleteAll }));
    fireEvent.change(screen.getByLabelText(messages.packet10.deletion.typeToConfirm), { target: { value: "DELETE" } });
    fireEvent.click(screen.getByRole("button", { name: messages.packet10.deletion.deleteAllAction }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(messages.packet10.deletion.deleteBlocked);
    expect(alert).toHaveTextContent(messages.packet10.deletion.deleteBlockedUnchanged);
  });

  it("cannot be cancelled once the irreversible delete request was issued (Corrective Pass A item 3)", async () => {
    const messages = getMessages("en-SG");
    const port: DeleteAllPort = {
      prepare: vi.fn(() => ({ createdAt: "2026-10-04T02:00:00.000Z" as never, expiresAt: "2026-10-04T02:10:00.000Z" as never })),
      confirm: vi.fn((_plan, _token, events) => {
        events?.onRequestIssued?.();
        events?.onBlocked?.();
        return new Promise<never>(() => undefined);
      }),
    };
    render(<SettingsScreen messages={messages} locale="en-SG" setLocale={vi.fn()} persistLocale={vi.fn()} deleteAll={port} onDatasetDeleted={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: messages.packet10.hub.deleteAll }));
    fireEvent.change(screen.getByLabelText(messages.packet10.deletion.typeToConfirm), { target: { value: "DELETE" } });
    fireEvent.click(screen.getByRole("button", { name: messages.packet10.deletion.deleteAllAction }));
    const dialog = await screen.findByRole("alertdialog");
    await waitFor(() => expect(screen.getByRole("button", { name: messages.packet10.deletion.keepData })).toBeDisabled());
    expect(screen.getByRole("button", { name: messages.packet10.deletion.deleteAllAction })).toBeDisabled();
    expect(screen.getByLabelText(messages.packet10.deletion.typeToConfirm)).toBeDisabled();
    expect(dialog).toHaveAttribute("aria-busy", "true");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.queryByText(messages.packet10.deletion.deleteBlockedUnchanged)).not.toBeInTheDocument();
    expect(port.confirm).toHaveBeenCalledTimes(1);
  });
});
