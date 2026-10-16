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

/**
 * Packet 11C Addendum C, Task C2 (hybrid spec D11): one native checkbox for the patient's "Keep wording on this device" setting. The
 * English label is fixed by the spec; the explanatory line and the zh wording (您) are new candidates, human acceptance pending.
 */
describe("SettingsScreen: Keep wording on this device (Packet 11C C2)", () => {
  function renderWith(locale: "en-SG" | "zh-SG", value: boolean | null, change = vi.fn(async (_next: boolean) => undefined)) {
    const messages = getMessages(locale);
    const view = render(
      <SettingsScreen messages={messages} locale={locale} setLocale={vi.fn()} persistLocale={vi.fn()} deleteAll={deletePort()} onDatasetDeleted={vi.fn()} keepWording={{ value, change }} />,
    );
    return { messages, change, view };
  }

  it.each(["en-SG", "zh-SG"] as const)("%s: a keyboard-reachable native checkbox, named by its label and described by its line; default off", (locale) => {
    const { messages } = renderWith(locale, false);
    const toggle = screen.getByRole("checkbox", { name: messages.aiWording.keepOnDeviceLabel });
    expect(toggle.tagName).toBe("INPUT");
    expect(toggle).toHaveAttribute("type", "checkbox");
    expect(toggle).not.toBeChecked();
    expect(toggle).toBeEnabled();
    expect(toggle).toHaveAccessibleDescription(messages.aiWording.keepOnDeviceBody);
    // Reachable by keyboard: a native, focusable control in the tab order.
    toggle.focus();
    expect(toggle).toHaveFocus();
    expect(toggle).not.toHaveAttribute("tabindex", "-1");
  });

  it.each(["en-SG", "zh-SG"] as const)("%s: turning it on and off applies and persists each choice; the state is the checkbox's own", async (locale) => {
    const { messages, change, view } = renderWith(locale, false);
    fireEvent.click(screen.getByRole("checkbox", { name: messages.aiWording.keepOnDeviceLabel }));
    await waitFor(() => expect(change).toHaveBeenLastCalledWith(true));
    view.rerender(
      <SettingsScreen messages={messages} locale={locale} setLocale={vi.fn()} persistLocale={vi.fn()} deleteAll={deletePort()} onDatasetDeleted={vi.fn()} keepWording={{ value: true, change }} />,
    );
    const toggle = screen.getByRole("checkbox", { name: messages.aiWording.keepOnDeviceLabel });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    await waitFor(() => expect(change).toHaveBeenLastCalledWith(false));
    expect(change).toHaveBeenCalledTimes(2);
  });

  it("is disabled (not guessed) while the dataset is not open, and shows the existing storage message when saving fails", async () => {
    const { messages } = renderWith("en-SG", null);
    expect(screen.getByRole("checkbox", { name: messages.aiWording.keepOnDeviceLabel })).toBeDisabled();
    cleanup();
    const failing = renderWith("en-SG", false, vi.fn(async () => { throw new Error("storage"); }));
    fireEvent.click(screen.getByRole("checkbox", { name: failing.messages.aiWording.keepOnDeviceLabel }));
    expect(await screen.findByText(failing.messages.shared.storageUnavailable)).toBeInTheDocument();
  });

  it("renders no toggle when no setting is wired", () => {
    const messages = getMessages("en-SG");
    render(<SettingsScreen messages={messages} locale="en-SG" setLocale={vi.fn()} persistLocale={vi.fn()} deleteAll={deletePort()} onDatasetDeleted={vi.fn()} />);
    expect(screen.queryByRole("checkbox", { name: messages.aiWording.keepOnDeviceLabel })).toBeNull();
  });
});

describe("SettingsScreen", () => {
  it("offers English only (owner decision 2026-10-16) and persists it when chosen from a stored Chinese locale", async () => {
    const persistLocale = vi.fn().mockResolvedValue(undefined);
    const messages = getMessages("zh-SG");
    render(
      <SettingsScreen
        messages={messages}
        locale="zh-SG"
        setLocale={vi.fn()}
        persistLocale={persistLocale}
        deleteAll={deletePort()}
        onDatasetDeleted={vi.fn()}
        goBack={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: messages.settings.chinese })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: messages.settings.english }));
    await waitFor(() => expect(persistLocale).toHaveBeenCalledWith("en-SG"));
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
