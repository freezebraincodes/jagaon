import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/get-messages";
import type { SupportedLocale } from "@/i18n/types";
import { AiCreditLimitDialog } from "./AiCreditLimitDialog";
import type { AiDisclosureFlow } from "./AiDisclosureDialog";

/**
 * Owner decision 2026-10-12 (AI credit dialog): "when the daily AI limit or the DeepSeek balance runs out, show a dialog: title 'AI
 * credit limit reached', text 'This demo has used up its AI credit for today. Your summary uses the standard wording instead.' with an
 * OK button" (history: "The explanation uses ..."). The shared modal primitive: named by its title, described by the text, focus on OK,
 * Escape and OK close it, focus returns. It reads, stores and sends nothing.
 */
afterEach(() => cleanup());

describe("AiCreditLimitDialog (Owner decision 2026-10-12, AI credit dialog)", () => {
  it.each<[AiDisclosureFlow | "FEELINGS_CHAT", string]>([
    ["CARE_SUMMARY", "This demo has used up its AI credit for today. Your summary uses the standard wording instead."],
    ["PATTERN", "This demo has used up its AI credit for today. The explanation uses the standard wording instead."],
    ["FEELINGS_CHAT", "This demo has used up its AI credit for today. JagaOn's standard questions are used instead."],
  ])("en-SG %s: the owner's exact wording, one OK action, a modal dialog named and described", (flow, text) => {
    render(<AiCreditLimitDialog messages={getMessages("en-SG")} flow={flow} onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName("AI credit limit reached");
    expect(dialog).toHaveAccessibleDescription(text);
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(["OK"]);
    expect(dialog.querySelector("input")).toBeNull();
    expect(dialog).toHaveClass("ai-credit-limit-dialog");
  });

  it.each<SupportedLocale>(["en-SG", "zh-SG"])("%s: every row comes from the catalogue", (locale) => {
    const t = getMessages(locale).aiCreditLimit;
    render(<AiCreditLimitDialog messages={getMessages(locale)} flow="CARE_SUMMARY" onClose={vi.fn()} />);
    expect(screen.getByRole("dialog")).toHaveAccessibleName(t.title);
    expect(screen.getByText(t.careSummaryBody)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t.ok })).toBeInTheDocument();
  });

  it("focus starts on OK and stays inside; OK and Escape each close it once; focus returns to the opener", () => {
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Explain
          </button>
          {open ? <AiCreditLimitDialog messages={getMessages("en-SG")} flow="PATTERN" onClose={() => setOpen(false)} /> : null}
        </>
      );
    }
    render(<Host />);
    const opener = screen.getByRole("button", { name: "Explain" });
    for (const close of ["OK", "Escape"] as const) {
      opener.focus();
      fireEvent.click(opener);
      const ok = screen.getByRole("button", { name: "OK" });
      expect(ok).toHaveFocus();
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Tab" });
      expect(ok).toHaveFocus();
      if (close === "OK") fireEvent.click(ok);
      else fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(opener).toHaveFocus();
    }
  });

  it("calls onClose exactly once per action", () => {
    const onClose = vi.fn();
    render(<AiCreditLimitDialog messages={getMessages("en-SG")} flow="PATTERN" onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("is AI-free and network-free: it imports only the catalogue types and the modal primitive", () => {
    const source = readFileSync(join(process.cwd(), "src/components/jagaon/ai/AiCreditLimitDialog.tsx"), "utf8");
    expect(source.match(/^import .*$/gm)).toEqual(['import type { AppMessages } from "@/i18n/types";', 'import { ModalDialog } from "../primitives/ModalDialog";', 'import type { AiDisclosureFlow } from "./AiDisclosureDialog";']);
    expect(source).not.toMatch(/\bfetch\s*\(|localStorage|sessionStorage|indexedDB|console\./);
  });
});
