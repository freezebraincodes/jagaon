import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getMessages } from "./get-messages";

/**
 * Packet 11C Addendum C, Task C4: the two approved catalogue rows that were still missing, `ai.demoTag` and `ai.resultCheck`
 * (11-bilingual-copy-state-matrix.md Section 2, both APPROVED_PACKET_11), are shipped byte-for-byte from the matrix. They are approved
 * rows, not new wording; only their placement and appearance are human acceptance pending.
 */

const MATRIX = readFileSync(join(process.cwd(), "internal-docs/implementation-plans/11-bilingual-copy-state-matrix.md"), "utf8");

type Row = { key: string; state: string; en: string; zh: string; status: string };
const rows: Row[] = MATRIX.split("\n")
  .filter((line) => /^\| `[^`]+` \|/.test(line))
  .map((line) => {
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    return { key: cells[0]!.replace(/`/g, ""), state: cells[1]!, en: cells[2]!, zh: cells[3]!, status: cells[4]! };
  });
const row = (key: string) => {
  const found = rows.filter((entry) => entry.key === key);
  expect(found, key).toHaveLength(1);
  return found[0]!;
};

describe("Packet 11C C4: the approved ai.demoTag and ai.resultCheck rows", () => {
  it("are APPROVED_PACKET_11 rows of the matrix with exactly these bytes", () => {
    expect(row("ai.demoTag")).toEqual({ key: "ai.demoTag", state: "All enabled states", en: "AI-assisted demo", zh: "AI 辅助演示", status: "APPROVED_PACKET_11" });
    expect(row("ai.resultCheck")).toEqual({
      key: "ai.resultCheck",
      state: "Accepted output",
      en: "Check the wording against your recorded information. AI can make mistakes.",
      zh: "请对照您已记录的资料检查内容。AI 可能会出错。",
      status: "APPROVED_PACKET_11",
    });
  });

  it.each([
    ["en-SG", "en"],
    ["zh-SG", "zh"],
  ] as const)("%s: the catalogue ships both rows byte-identical to the matrix", (locale, column) => {
    const ai = getMessages(locale).ai;
    expect(Buffer.from(ai.demoTag, "utf8").equals(Buffer.from(row("ai.demoTag")[column], "utf8"))).toBe(true);
    expect(Buffer.from(ai.resultCheck, "utf8").equals(Buffer.from(row("ai.resultCheck")[column], "utf8"))).toBe(true);
  });

  it("keeps the zh rows in the approved register: full-width sentence punctuation, 您 and never 你, AI untranslated", () => {
    const ai = getMessages("zh-SG").ai;
    for (const text of [ai.demoTag, ai.resultCheck]) {
      expect(text).not.toMatch(/[()[\]:;,!?]|\.(?!\d)|你/);
      expect(text).toContain("AI");
    }
    expect(ai.resultCheck).toContain("您");
  });
});
