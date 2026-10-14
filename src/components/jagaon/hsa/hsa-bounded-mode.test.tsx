import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { getMessages } from "@/i18n/get-messages";
import { AppShell } from "../AppShell";
import { HSA_BOUNDED_MODE_STORAGE_KEY, HsaBoundedModeProvider, PreviewTag, resetHsaBoundedModeForTests, useHsaBoundedMode } from "./hsa-bounded-mode";
import { HsaBoundedModeSetting } from "./HsaBoundedModeSetting";

const en = getMessages("en-SG");

function Probe() {
  const { bounded, setMoreBadgeCount } = useHsaBoundedMode();
  return (
    <>
      <p data-testid="mode">{bounded ? "bounded" : "preview"}</p>
      <button type="button" onClick={() => setMoreBadgeCount(2)}>
        set badge
      </button>
    </>
  );
}

function renderShell() {
  const onSwitchTab = vi.fn();
  render(
    <HsaBoundedModeProvider>
      <AppShell messages={en} currentScreen="MORE" isTopLevel onBack={vi.fn()} onSwitchTab={onSwitchTab}>
        <HsaBoundedModeSetting messages={en} />
        <Probe />
      </AppShell>
    </HsaBoundedModeProvider>,
  );
  return { onSwitchTab };
}

describe("HSA-bounded mode (owner decision 2026-10-14)", () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    resetHsaBoundedModeForTests();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
    });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("is ON by default: no banner, no badge, the switch reads On", () => {
    renderShell();
    expect(screen.getByTestId("mode")).toHaveTextContent("bounded");
    expect(screen.getByRole("switch", { name: en.hsa.settingLabel })).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByRole("button", { name: en.hsa.banner })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "set badge" }));
    expect(screen.queryByLabelText(en.hsa.moreBadgeLabel(2))).toBeNull();
  });

  it("asks before turning OFF; Cancel keeps it ON", () => {
    renderShell();
    fireEvent.click(screen.getByRole("switch", { name: en.hsa.settingLabel }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent(en.hsa.confirmBody);
    fireEvent.click(within(dialog).getByRole("button", { name: en.shared.cancel }));
    expect(screen.getByTestId("mode")).toHaveTextContent("bounded");
    expect(localStorage.getItem(HSA_BOUNDED_MODE_STORAGE_KEY)).toBeNull();
  });

  it("turned OFF: remembered on the device, banner opens More, the More badge shows; turning ON needs no question", () => {
    const { onSwitchTab } = renderShell();
    fireEvent.click(screen.getByRole("switch", { name: en.hsa.settingLabel }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: en.hsa.confirmAction }));
    expect(screen.getByTestId("mode")).toHaveTextContent("preview");
    expect(localStorage.getItem(HSA_BOUNDED_MODE_STORAGE_KEY)).toBe("off");
    fireEvent.click(screen.getByRole("button", { name: en.hsa.banner }));
    expect(onSwitchTab).toHaveBeenCalledWith("MORE");
    fireEvent.click(screen.getByRole("button", { name: "set badge" }));
    expect(screen.getByLabelText(en.hsa.moreBadgeLabel(2))).toHaveTextContent("2");
    fireEvent.click(screen.getByRole("switch", { name: en.hsa.settingLabel }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByTestId("mode")).toHaveTextContent("bounded");
    expect(localStorage.getItem(HSA_BOUNDED_MODE_STORAGE_KEY)).toBeNull();
  });

  it("reads a stored OFF after mount, and treats anything else as ON", () => {
    localStorage.setItem(HSA_BOUNDED_MODE_STORAGE_KEY, "off");
    renderShell();
    expect(screen.getByTestId("mode")).toHaveTextContent("preview");
    cleanup();
    localStorage.setItem(HSA_BOUNDED_MODE_STORAGE_KEY, "maybe");
    renderShell();
    expect(screen.getByTestId("mode")).toHaveTextContent("bounded");
  });

  it("without a provider the mode is ON and setters do nothing", () => {
    render(<Probe />);
    expect(screen.getByTestId("mode")).toHaveTextContent("bounded");
    act(() => fireEvent.click(screen.getByRole("button", { name: "set badge" })));
    render(<PreviewTag messages={en} />);
    expect(screen.getByText(en.hsa.previewTag)).toBeInTheDocument();
  });
});
