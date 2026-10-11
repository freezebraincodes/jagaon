// @vitest-environment node
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { shellPromptFor } from "@/ai/prompts/packet-11-shell-prompts";
import { historicalShellPrompt11b18, normalise11b20Prompt } from "./packet-11-prompt-change-normalisation";

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const key = "ai.explain-pattern@11b.20";
const request = (instructions: string = shellPromptFor("EXPLAIN_PATTERN", "en-SG")!.text, runtimeBundleKey: string = key) => ({
  instructions,
  input: [{ role: "user", content: [{ text: JSON.stringify({ runtimeBundleKey, planted: key }) }] }],
  planted: key,
});
const PAIRS = [["EXPLAIN_PATTERN", "en-SG"], ["EXPLAIN_PATTERN", "zh-SG"], ["DRAFT_CARE_PREPARATION_SUMMARY", "en-SG"], ["DRAFT_CARE_PREPARATION_SUMMARY", "zh-SG"]] as const;
const DIGESTS_11B18: Record<string, string> = {
  "EXPLAIN_PATTERN|en-SG": "b05c54687f369187a11579165ace220f4cfc8431bcd62a48b723d7e43c264ef7",
  "EXPLAIN_PATTERN|zh-SG": "0fb0a26491fbe5ecab23f5eafe7b4fdc10cb2b3fef3c7401db8a3fdad9b62b8c",
  "DRAFT_CARE_PREPARATION_SUMMARY|en-SG": "e2abd975dbd943cf4edd6e455b74cc2dee1158ce321b4b9cf6c697da1726588d",
  "DRAFT_CARE_PREPARATION_SUMMARY|zh-SG": "1a45da86da96e9aa774a40a50b86e653c081ebcadaba8a9f1c2f35226e696189",
};

describe("11b.20 offline provenance normalisation (back to the exact 11b.18 bodies)", () => {
  it.each(PAIRS)("%s %s: the whole 11b.20 asset is replaced by the exact 11b.18 asset (pinned digest)", (task, locale) => {
    const bundleKey = task === "EXPLAIN_PATTERN" ? "ai.explain-pattern@11b.20" : "ai.draft-care-preparation-summary@11b.20";
    const result = JSON.parse(normalise11b20Prompt(JSON.stringify(request(shellPromptFor(task, locale)!.text, bundleKey))));
    expect(sha256(result.instructions)).toBe(DIGESTS_11B18[`${task}|${locale}`]);
    expect(sha256(historicalShellPrompt11b18(task, locale))).toBe(DIGESTS_11B18[`${task}|${locale}`]);
    expect(JSON.parse(result.input[0].content[0].text).runtimeBundleKey).toBe(bundleKey.replace("@11b.20", "@11b.18"));
  });
  it("restores only instructions and the embedded bundle key, preserving planted copies", () => {
    const result = JSON.parse(normalise11b20Prompt(JSON.stringify(request())));
    expect(result.planted).toBe(key);
    expect(JSON.parse(result.input[0].content[0].text)).toEqual({ runtimeBundleKey: "ai.explain-pattern@11b.18", planted: key });
    expect(result.instructions).toContain("relative time (for example today or last week)");
    expect(result.instructions).toContain("You are a wording component inside JagaOn");
    expect(result.instructions).not.toContain("needs or deserves attention");
    expect(result.instructions).not.toContain("Describe; never evaluate.");
  });
  it("refuses a noncanonical outer body", () => {
    expect(() => normalise11b20Prompt(" " + JSON.stringify(request()))).toThrow("PROMPT_NORMALISATION_NOT_CANONICAL");
  });
  it("refuses a noncanonical embedded shell input", () => {
    const original = request();
    original.input[0]!.content[0]!.text = ` ${original.input[0]!.content[0]!.text}`;
    expect(() => normalise11b20Prompt(JSON.stringify(original))).toThrow("PROMPT_NORMALISATION_INPUT_NOT_CANONICAL");
  });
  it("refuses instructions that are not exactly the current asset (unrelated, partial, edited or duplicated)", () => {
    const current = shellPromptFor("EXPLAIN_PATTERN", "en-SG")!.text;
    for (const instructions of ["an unrelated prompt", current.slice(1), `${current} `, current.replace("Describe; never evaluate.", "Describe."), current + current, historicalShellPrompt11b18("EXPLAIN_PATTERN", "en-SG")]) {
      expect(() => normalise11b20Prompt(JSON.stringify(request(instructions))), instructions.slice(0, 40)).toThrow("PROMPT_NORMALISATION_INSTRUCTIONS_NOT_CURRENT_ASSET");
    }
  });
  it("refuses an asset of the other task under the bundle key (no cross-task restoration)", () => {
    expect(() => normalise11b20Prompt(JSON.stringify(request(shellPromptFor("DRAFT_CARE_PREPARATION_SUMMARY", "en-SG")!.text)))).toThrow("PROMPT_NORMALISATION_INSTRUCTIONS_NOT_CURRENT_ASSET");
  });
  it("refuses an unexpected or historical bundle key", () => {
    for (const runtimeBundleKey of ["unreviewed@version", "ai.explain-pattern@11b.19", "ai.explain-pattern@11b.18"]) {
      expect(() => normalise11b20Prompt(JSON.stringify(request(undefined, runtimeBundleKey))), runtimeBundleKey).toThrow("PROMPT_NORMALISATION_BUNDLE_KEY");
    }
  });
  it("refuses an unexpected input shape", () => {
    expect(() => normalise11b20Prompt(JSON.stringify({ ...request(), input: [] }))).toThrow("PROMPT_NORMALISATION_INPUT_SHAPE");
  });
  it("stays test-only: no non-test source file imports it", () => {
    const importers = sourceFiles("src").filter((path) => !/\.test\.tsx?$/.test(path) && readFileSync(path, "utf8").includes("packet-11-prompt-change-normalisation"));
    expect(importers).toEqual([]);
  });
});

/** Every TypeScript source file under a directory (read-only walk), except the normaliser itself. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = `${dir}/${name}`;
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !path.endsWith("packet-11-prompt-change-normalisation.ts") ? [path] : [];
  });
}
