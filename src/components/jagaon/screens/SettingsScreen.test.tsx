import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/get-messages";
import { SettingsScreen } from "./SettingsScreen";

afterEach(() => cleanup());

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
        resetDemo={vi.fn()}
        goBack={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: messages.settings.chinese }));
    await waitFor(() => expect(persistLocale).toHaveBeenCalledWith("zh-SG"));
  });

  it("runs reset only after the exact confirmation action", async () => {
    const resetDemo = vi.fn().mockResolvedValue(undefined);
    const messages = getMessages("en-SG");
    render(
      <SettingsScreen
        messages={messages}
        locale="en-SG"
        setLocale={vi.fn()}
        persistLocale={vi.fn()}
        resetDemo={resetDemo}
        goBack={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: messages.settings.resetAction }));
    expect(resetDemo).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: messages.settings.resetConfirm }));
    await waitFor(() => expect(resetDemo).toHaveBeenCalledTimes(1));
  });
});
