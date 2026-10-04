import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getMessages } from "./get-messages";
import type { Packet10Messages } from "./packet10-types";

/**
 * Packet 10 catalogue parity with 10-bilingual-copy-matrix.md: every
 * APPROVED_PACKET_10 row and the LOCKED_TOKEN are rendered exactly in both
 * locales, nothing else is shipped, and the prohibited wording never appears.
 */

const MATRIX = readFileSync(join(process.cwd(), "internal-docs/implementation-plans/10-bilingual-copy-matrix.md"), "utf8");

type Row = { key: string; en: string; zh: string; status: string };
const rows: Row[] = MATRIX.split("\n")
  .filter((line) => /^\| `[^`]+` \|/.test(line))
  .map((line) => {
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    return { key: cells[0]!.replace(/`/g, ""), en: cells[1]!, zh: cells[2]!, status: cells[3]! };
  });

const NAMESPACES = ["more", "hub", "backup", "restore", "deletion", "integrity", "shared"] as const;
const PARAMS: Record<string, string> = {
  fileNameNote: "fileName",
  preparedAt: "time",
  fileSize: "size",
  planExported: "date",
  replacementPlan: "date",
  willBeLostV: "n",
  deletionProtected: "count",
  "deletePlanItems.dependent": "n",
};

function resolve(catalogue: Packet10Messages, key: string): string | undefined {
  const path = key.split(".");
  const roots = path[0] === "more" ? [catalogue.more] : NAMESPACES.map((namespace) => catalogue[namespace] as unknown);
  for (const root of roots) {
    let value: unknown = root;
    for (const segment of path[0] === "more" ? path.slice(1) : path) value = (value as Record<string, unknown> | undefined)?.[segment];
    if (typeof value === "string") return value;
    if (typeof value === "function") {
      const param = PARAMS[key] ?? (key.startsWith("planCounts.") ? "n" : "value");
      return (value as (arg: string) => string)(`{${param}}`);
    }
  }
  return undefined;
}

function leaves(value: unknown, prefix = ""): string[] {
  if (typeof value === "string" || typeof value === "function") return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => leaves(child, prefix ? `${prefix}.${key}` : key));
}

describe("Packet 10 bilingual catalogue (matrix parity)", () => {
  const en = getMessages("en-SG").packet10;
  const zh = getMessages("zh-SG").packet10;

  it("covers the closed matrix status counts", () => {
    const count = (status: string) => rows.filter((row) => row.status === status).length;
    expect(count("APPROVED_PACKET_10")).toBe(117);
    expect(count("PARAMETER_ONLY")).toBe(2);
    expect(count("LOCKED_TOKEN")).toBe(1);
    expect(count("DESIGN_ANNOTATION_NOT_SHIPPED")).toBe(2);
    expect(count("NEEDS_BILINGUAL_REVIEW")).toBe(0);
  });

  it("renders every approved row and the locked token exactly in en-SG and zh-SG", () => {
    for (const row of rows.filter((entry) => entry.status === "APPROVED_PACKET_10" || entry.status === "LOCKED_TOKEN")) {
      expect(resolve(en, row.key), `${row.key} en`).toBe(row.en);
      expect(resolve(zh, row.key), `${row.key} zh`).toBe(row.zh);
    }
    expect(en.deletion.deleteConfirmToken).toBe("DELETE");
    expect(zh.deletion.deleteConfirmToken).toBe("DELETE");
  });

  it("ships no string outside the matrix and none of the annotation rows", () => {
    const matrixKeys = new Set(rows.map((row) => row.key));
    const shipped = NAMESPACES.flatMap((namespace) =>
      leaves(en[namespace]).map((leaf) => (namespace === "more" ? `more.${leaf}` : leaf)),
    );
    for (const key of shipped) expect(matrixKeys.has(key) || matrixKeys.has(key.replace(/\.\d+$/, "")) || /^prepSteps\.\d$|^restoreSteps\.\d$/.test(key), key).toBe(true);
    expect(JSON.stringify(en)).not.toContain("Focus opens on Keep");
    expect(JSON.stringify(en)).not.toContain("Other states of this shell");
    expect(leaves(en).sort()).toEqual(leaves(zh).sort());
  });

  it("never claims encrypted live storage, retained downloads, recovery, recall, merge, clinician contact or a health state", () => {
    expect(en.hub.liveStorageLimit).toContain("not encrypted");
    expect(zh.hub.liveStorageLimit).toContain("不会另外加密");
    expect(en.backup.downloadStarted).not.toMatch(/saved|kept|stored|safe/i);
    expect(zh.backup.downloadStarted).not.toMatch(/储存在|保存/);
    expect(en.backup.passphraseLoss).toContain("cannot recover");
    expect(zh.backup.passphraseLoss).toContain("无法恢复");
    for (const catalogue of [en, zh]) {
      const all = leaves(catalogue).map((path) => resolve(catalogue, path.replace(/^more\./, "more.")) ?? "");
      const text = JSON.stringify(catalogue) + all.join("\n");
      expect(text).not.toMatch(/end-to-end|端到端|clinician|doctor|care team|医生|护理团队|healthy|nothing was found|no action is needed|一切正常/i);
    }
    expect(en.deletion.externalCopiesRemain).toContain("not recalled");
    expect(zh.deletion.externalCopiesRemain).toContain("不会被收回");
    expect(en.restore.differentDataset).toContain("cannot replace or merge");
    expect(en.restore.doneNoShare).toBe("Nothing was sent to anyone.");
    expect(en.shared.noHealthClaim).toContain("says nothing about your health");
  });
});
