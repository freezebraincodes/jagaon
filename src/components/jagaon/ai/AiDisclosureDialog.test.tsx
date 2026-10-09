import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/get-messages";
import type { SupportedLocale } from "@/i18n/types";
import { AiDisclosureDialog, type AiDisclosureFlow } from "./AiDisclosureDialog";

/**
 * Packet 11C Addendum B, Task B3 (original Task 4): the shared AI disclosure dialog. It is shown only before a remote call (never while
 * NOT_ACTIVATED; the caller decides that), its copy is the Packet 11 catalogue's (approved rows; corrected remoteBody ai-disclosure.11c.1),
 * and it is a modal dialog: heading and description association, initial focus on the safe action (Cancel), a focus trap, Escape as
 * Cancel and focus return. Opening it sends nothing. Presentation: human acceptance pending.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function open(locale: SupportedLocale = "en-SG", flow: AiDisclosureFlow = "PATTERN") {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(<AiDisclosureDialog messages={getMessages(locale)} flow={flow} onConfirm={onConfirm} onCancel={onCancel} />);
  return { onConfirm, onCancel, dialog: screen.getByRole("dialog") };
}

describe("AiDisclosureDialog (Packet 11C B3)", () => {
  it.each<[SupportedLocale, AiDisclosureFlow, string]>([
    ["en-SG", "PATTERN", "Generate explanation"],
    ["en-SG", "CARE_SUMMARY", "Organise selected information"],
    ["zh-SG", "PATTERN", "生成说明"],
    ["zh-SG", "CARE_SUMMARY", "整理所选资料"],
  ])("%s %s: a modal dialog named by its heading and described by the exact disclosure copy", (locale, flow, confirm) => {
    const ai = getMessages(locale).ai;
    const { dialog } = open(locale, flow);
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName(ai.remoteTitle);
    expect(screen.getByRole("heading", { level: 2, name: ai.remoteTitle })).toBeInTheDocument();
    expect(dialog).toHaveAccessibleDescription(`${ai.remoteBody} ${ai.remoteLimit}`);
    expect(screen.getByText(ai.remoteBody)).toBeInTheDocument();
    expect(screen.getByText(ai.remoteLimit)).toBeInTheDocument();
    // Exactly two actions: the flow's approved primary action and the shared Cancel.
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([confirm, ai.cancel]);
    expect(dialog).toHaveClass("ai-disclosure-dialog");
  });

  it("puts initial focus on the safe action (Cancel)", () => {
    open();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("traps focus: Tab and Shift+Tab cycle between the two actions only", () => {
    const { dialog } = open();
    const confirm = screen.getByRole("button", { name: "Generate explanation" });
    const cancel = screen.getByRole("button", { name: "Cancel" });
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(confirm).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(cancel).toHaveFocus();
  });

  it("Escape is Cancel: onCancel once, never onConfirm", () => {
    const { dialog, onCancel, onConfirm } = open();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("Cancel and the primary action each call only their own handler", () => {
    const first = open();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(first.onCancel).toHaveBeenCalledTimes(1);
    expect(first.onConfirm).not.toHaveBeenCalled();
    cleanup();
    const second = open();
    fireEvent.click(screen.getByRole("button", { name: "Generate explanation" }));
    expect(second.onConfirm).toHaveBeenCalledTimes(1);
    expect(second.onCancel).not.toHaveBeenCalled();
  });

  it("returns focus to the control that opened it when it closes (cancelled, accepted, or dismissed by the caller while pending)", () => {
    function Harness() {
      const [shown, setShown] = useState(false);
      return (
        <main>
          <h1>Screen</h1>
          <button type="button" onClick={() => setShown(true)}>
            Opener
          </button>
          <button type="button" onClick={() => setShown(false)}>
            Elsewhere
          </button>
          {shown ? <AiDisclosureDialog messages={getMessages("en-SG")} flow="PATTERN" onConfirm={() => setShown(false)} onCancel={() => setShown(false)} /> : null}
        </main>
      );
    }
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Opener" });
    for (const close of [() => fireEvent.click(screen.getByRole("button", { name: "Cancel" })), () => fireEvent.click(screen.getByRole("button", { name: "Generate explanation" })), () => fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" })]) {
      opener.focus();
      fireEvent.click(opener);
      expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
      act(() => close());
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(opener).toHaveFocus();
    }
  });

  it("sends nothing when it opens, renders or closes", () => {
    const fetchSpy = vi.fn();
    const beacon = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("navigator", { ...navigator, sendBeacon: beacon });
    const { onCancel } = open("zh-SG");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onCancel).toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(beacon).not.toHaveBeenCalled();
  });

  /**
   * Packet 11C Addendum C, Task C6: the demo passcode field (new wording and presentation; human acceptance pending). It appears only
   * inside this dialog (so only when a remote attempt could happen; never with the shipped manifest) and only while no passcode is held.
   */
  describe("C6: the demo passcode field", () => {
    const PASSCODE = "TEST-ONLY-passcode-value";
    function openWith(entry: { needed(): boolean; provide(passcode: string): boolean }, locale: SupportedLocale = "en-SG") {
      const onConfirm = vi.fn();
      const onCancel = vi.fn();
      render(<AiDisclosureDialog messages={getMessages(locale)} flow="PATTERN" passcode={entry} onConfirm={onConfirm} onCancel={onCancel} />);
      return { onConfirm, onCancel, dialog: screen.getByRole("dialog") };
    }

    it.each<[SupportedLocale]>([["en-SG"], ["zh-SG"]])("%s: needed, a labelled password field inside the focus trap; Cancel keeps initial focus", (locale) => {
      const provide = vi.fn(() => true);
      const { dialog } = openWith({ needed: () => true, provide }, locale);
      const field = screen.getByLabelText(getMessages(locale).aiAccess.passcodeLabel);
      expect(field).toHaveAttribute("type", "password");
      expect(field).toHaveAttribute("autocomplete", "off");
      expect(field).not.toHaveAttribute("name");
      expect(dialog).toContainElement(field);
      expect(screen.getByRole("button", { name: getMessages(locale).ai.cancel })).toHaveFocus();
    });

    /**
     * Owner UI decision U03 (owner-ui-decisions-2026-10-09; replaces the C6 "empty field still answers" behaviour): while the passcode
     * field is required, the primary action is disabled until the field holds non-whitespace input. Cancel stays available; the route's
     * own checks are unchanged.
     */
    it.each<[SupportedLocale]>([["en-SG"], ["zh-SG"]])("U03 %s: the primary action is disabled while the required field is empty or whitespace; Cancel stays available", (locale) => {
      const m = getMessages(locale);
      const provide = vi.fn(() => true);
      const { onConfirm, onCancel } = openWith({ needed: () => true, provide }, locale);
      const confirm = screen.getByRole("button", { name: m.ai.pattern.confirm });
      expect(confirm).toBeDisabled();
      fireEvent.change(screen.getByLabelText(m.aiAccess.passcodeLabel), { target: { value: "   " } });
      expect(confirm).toBeDisabled();
      fireEvent.click(confirm);
      expect(onConfirm).not.toHaveBeenCalled();
      expect(provide).not.toHaveBeenCalled();
      const cancel = screen.getByRole("button", { name: m.ai.cancel });
      expect(cancel).toBeEnabled();
      fireEvent.click(cancel);
      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it.each<[SupportedLocale]>([["en-SG"], ["zh-SG"]])("U03 %s: non-whitespace input enables the primary action, which provides it and accepts", (locale) => {
      const m = getMessages(locale);
      const provide = vi.fn(() => true);
      const { onConfirm } = openWith({ needed: () => true, provide }, locale);
      fireEvent.change(screen.getByLabelText(m.aiAccess.passcodeLabel), { target: { value: PASSCODE } });
      const confirm = screen.getByRole("button", { name: m.ai.pattern.confirm });
      expect(confirm).toBeEnabled();
      fireEvent.click(confirm);
      expect(provide.mock.calls).toEqual([[PASSCODE]]);
      expect(onConfirm).toHaveBeenCalledTimes(1);
      fireEvent.change(screen.getByLabelText(m.aiAccess.passcodeLabel), { target: { value: "" } });
      expect(confirm).toBeDisabled();
    });

    it("confirming provides the entered passcode once, then accepts; the field keeps no copy elsewhere in the dialog", () => {
      const provide = vi.fn(() => true);
      const { onConfirm, dialog } = openWith({ needed: () => true, provide });
      fireEvent.change(screen.getByLabelText("Demo passcode"), { target: { value: PASSCODE } });
      expect(dialog.textContent).not.toContain(PASSCODE);
      fireEvent.click(screen.getByRole("button", { name: "Generate explanation" }));
      expect(provide.mock.calls).toEqual([[PASSCODE]]);
      expect(onConfirm).toHaveBeenCalledTimes(1);
    });

    it("Cancel and Escape never provide the passcode", () => {
      const provide = vi.fn(() => true);
      const { onCancel, dialog } = openWith({ needed: () => true, provide });
      fireEvent.change(screen.getByLabelText("Demo passcode"), { target: { value: PASSCODE } });
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      fireEvent.keyDown(dialog, { key: "Escape" });
      expect(onCancel).toHaveBeenCalledTimes(2);
      expect(provide).not.toHaveBeenCalled();
    });

    it("a passcode already held for the session: no field, the two approved actions only, nothing provided", () => {
      const provide = vi.fn(() => true);
      const { onConfirm } = openWith({ needed: () => false, provide });
      expect(screen.queryByLabelText("Demo passcode")).toBeNull();
      expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(["Generate explanation", "Cancel"]);
      fireEvent.click(screen.getByRole("button", { name: "Generate explanation" }));
      expect(onConfirm).toHaveBeenCalledTimes(1);
      expect(provide).not.toHaveBeenCalled();
    });

    it("an entry that throws when asked shows no field (the route then refuses ACCESS_DENIED; fail closed)", () => {
      openWith({ needed: () => { throw new Error("x"); }, provide: () => true });
      expect(screen.queryByLabelText("Demo passcode")).toBeNull();
    });

    it("the approved disclosure copy is unchanged; the new label lives outside `ai` in both catalogues", () => {
      expect(getMessages("en-SG").aiAccess).toEqual({ passcodeLabel: "Demo passcode" });
      expect(getMessages("zh-SG").aiAccess).toEqual({ passcodeLabel: "演示通行码" });
      expect(Object.keys(getMessages("en-SG").ai)).not.toContain("passcodeLabel");
    });
  });

  it("is an AI-free presentation component: it imports only React, the i18n types and the shared modal primitive", () => {
    const source = readFileSync(join(process.cwd(), "src/components/jagaon/ai/AiDisclosureDialog.tsx"), "utf8");
    const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);
    expect(imports).toContain("../primitives/ModalDialog");
    for (const specifier of imports) expect(["../primitives/ModalDialog", "@/i18n/types", "react"]).toContain(specifier);
    expect(source).not.toMatch(/\bfetch\b|XMLHttpRequest|sendBeacon|localStorage|sessionStorage|@\/application\/|@\/ai\//);
  });

  it("has scoped styles that wrap long words and keep the actions reachable at 390 px and 200% text zoom", () => {
    const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
    const rules = [...css.matchAll(/(^|\n)([^{}\n]*\.ai-disclosure[^{}]*)\{([^}]*)\}/g)].map((match) => ({ selector: match[2]!.trim(), body: match[3]! }));
    expect(rules.length).toBeGreaterThan(0);
    // Every rule is scoped to the disclosure, so no other dialog changes.
    for (const rule of rules) for (const selector of rule.selector.split(",")) expect(selector.trim()).toMatch(/^\.ai-disclosure/);
    const all = rules.map((rule) => rule.body).join("\n");
    expect(all).toMatch(/overflow-wrap:\s*anywhere/);
    expect(all).toMatch(/white-space:\s*normal/);
    // No fixed widths or heights that would force horizontal scrolling; sizes are relative.
    expect(all).not.toMatch(/(^|[^-])(width|height):\s*\d+px/);
  });
});
