import { describe, expect, it } from "vitest";
import { EXPLAINABLE_PATTERN_FAMILIES, EXPLANATION_LIMITATION_CODES } from "@/domain/ai/ai-task-contracts";
import { enSGMessages } from "@/i18n/messages/en-SG";
import { zhSGMessages } from "@/i18n/messages/zh-SG";
import {
  AI_MEANING_REGISTRY,
  AI_MEANING_REGISTRY_REVISION,
  approvedClaimMeaning,
  approvedLimitationText,
  buildMeaningRegistry,
  renderExplainLimitations,
  type MeaningRegistryEntry,
} from "./ai-meaning-registry";

/**
 * Packet 11B.5 Option B approved-meaning registry (owner approval 2026-10-05
 * of review-matrix §13 for the synthetic hackathon scope only — not clinical
 * validation or independent professional linguistic certification).
 */

const APPROVED: Record<string, { kind: "CLAIM_FAMILY_MEANING" | "LIMITATION_TEXT"; "en-SG": string; "zh-SG": string }> = {
  COMPARABLE_SLOT_TREND: { kind: "CLAIM_FAMILY_MEANING", "en-SG": "This compares readings from the same recorded slot across an earlier period and a recent period.", "zh-SG": "这比较了同一记录时段在较早期间和近期记录的读数。" },
  FAMILIAR_OR_FREQUENT_ITEM: { kind: "CLAIM_FAMILY_MEANING", "en-SG": "This counts how often the same recorded item or context appears in your records over a period.", "zh-SG": "这统计同一个记录项目或情境在一段时间内出现在您记录中的次数。" },
  DOES_NOT_ESTABLISH_CAUSE: { kind: "LIMITATION_TEXT", "en-SG": "This describes your records; it does not explain the cause.", "zh-SG": "这只描述您的记录；并不解释原因。" },
  SPARSE_RECORDING: { kind: "LIMITATION_TEXT", "en-SG": "Only a small number of records were available for this.", "zh-SG": "这里可用的记录数量较少。" },
  UNKNOWN_NEGATIVE_STATUS: { kind: "LIMITATION_TEXT", "en-SG": "If something was not recorded, these records cannot show whether it happened.", "zh-SG": "没有记录的事情，这些记录无法说明它是否发生过。" },
};
const entry = (kind: MeaningRegistryEntry["kind"], code: string, locale: MeaningRegistryEntry["locale"], text: string): MeaningRegistryEntry => ({ task: "EXPLAIN_PATTERN", kind, code, locale, text });
const pair = (kind: MeaningRegistryEntry["kind"], code: string, en: string, zh: string) => [entry(kind, code, "en-SG", en), entry(kind, code, "zh-SG", zh)];
const VALID = [...pair("CLAIM_FAMILY_MEANING", "COMPARABLE_SLOT_TREND", "Compares slots.", "比较时段。"), ...pair("LIMITATION_TEXT", "SPARSE_RECORDING", "Few records.", "记录较少。")];

describe("approved-meaning registry ai-meaning-registry.11b.1", () => {
  it("is the exact, frozen, owner-approved §13 set: 2 claim families and 3 limitations in both locales", () => {
    expect(AI_MEANING_REGISTRY_REVISION).toBe("ai-meaning-registry.11b.1");
    expect(AI_MEANING_REGISTRY.revision).toBe(AI_MEANING_REGISTRY_REVISION);
    expect(Object.isFrozen(AI_MEANING_REGISTRY)).toBe(true);
    expect(Object.isFrozen(AI_MEANING_REGISTRY.entries)).toBe(true);
    expect(Object.isFrozen(AI_MEANING_REGISTRY.entries[0])).toBe(true);
    expect(AI_MEANING_REGISTRY.entries).toHaveLength(10);
    for (const [code, row] of Object.entries(APPROVED)) {
      for (const locale of ["en-SG", "zh-SG"] as const) {
        expect(AI_MEANING_REGISTRY.entries.filter((value) => value.code === code && value.locale === locale), `${code}|${locale}`).toEqual([{ task: "EXPLAIN_PATTERN", kind: row.kind, code, locale, text: row[locale] }]);
      }
    }
  });

  it("reuses the existing approved non-causal history copy verbatim for DOES_NOT_ESTABLISH_CAUSE", () => {
    expect(approvedLimitationText("DOES_NOT_ESTABLISH_CAUSE", "en-SG")).toBe(enSGMessages.history.nonCausalLimitation);
    expect(approvedLimitationText("DOES_NOT_ESTABLISH_CAUSE", "zh-SG")).toBe(zhSGMessages.history.nonCausalLimitation);
  });

  it("keeps UNKNOWN_NEGATIVE_STATUS separate from the non-causal limitation", () => {
    expect(approvedLimitationText("UNKNOWN_NEGATIVE_STATUS", "en-SG")).not.toBe(approvedLimitationText("DOES_NOT_ESTABLISH_CAUSE", "en-SG"));
  });

  it("answers per locale and returns null for unapproved or unknown codes and for the wrong kind", () => {
    expect(approvedClaimMeaning("COMPARABLE_SLOT_TREND", "zh-SG")).toBe(APPROVED.COMPARABLE_SLOT_TREND!["zh-SG"]);
    expect(approvedClaimMeaning("SPARSE_RECORDING", "en-SG")).toBeNull();
    expect(approvedLimitationText("COMPARABLE_SLOT_TREND", "en-SG")).toBeNull();
    for (const code of ["HIGH_VARIABILITY", "LIMITED_COMPARISON", "CONTEXT_OVERLAP", "INSUFFICIENT_TIME_PRECISION", "MEASUREMENT_METHOD_CHANGE", "RECENCY_LIMIT", "CONTRADICTORY_EVIDENCE", "CARE_PLAN_BOUNDARY", "IDENTITY_UNCERTAINTY", "NOT_A_CODE"]) {
      expect(approvedLimitationText(code, "en-SG"), code).toBeNull();
    }
  });

  it("only ever contains codes from the closed contract sets", () => {
    for (const value of AI_MEANING_REGISTRY.entries) {
      expect(value.kind === "CLAIM_FAMILY_MEANING" ? (EXPLAINABLE_PATTERN_FAMILIES as readonly string[]) : (EXPLANATION_LIMITATION_CODES as readonly string[])).toContain(value.code);
    }
  });
});

describe("registry construction fails closed", () => {
  it("accepts a well-formed paired registry", () => {
    expect(buildMeaningRegistry("ai-meaning-registry.11b.1", VALID).entries).toHaveLength(4);
  });

  it.each([
    ["an unknown family code", [...VALID, ...pair("CLAIM_FAMILY_MEANING", "NOT_A_FAMILY", "x.", "某。")], "MEANING_REGISTRY_UNKNOWN_CODE"],
    ["an unknown limitation code", [...VALID, ...pair("LIMITATION_TEXT", "NOT_A_LIMITATION", "x.", "某。")], "MEANING_REGISTRY_UNKNOWN_CODE"],
    ["a limitation code under the family kind", [...VALID, ...pair("CLAIM_FAMILY_MEANING", "SPARSE_RECORDING", "x.", "某。")], "MEANING_REGISTRY_UNKNOWN_CODE"],
    ["a missing zh-SG entry", [...VALID, entry("LIMITATION_TEXT", "UNKNOWN_NEGATIVE_STATUS", "en-SG", "Unknown.")], "MEANING_REGISTRY_MISSING_LOCALE"],
    ["a missing en-SG entry", [...VALID, entry("LIMITATION_TEXT", "UNKNOWN_NEGATIVE_STATUS", "zh-SG", "不明。")], "MEANING_REGISTRY_MISSING_LOCALE"],
    ["a duplicate key", [...VALID, entry("LIMITATION_TEXT", "SPARSE_RECORDING", "en-SG", "Few records again.")], "MEANING_REGISTRY_DUPLICATE_KEY"],
    ["English text under zh-SG", [...pair("CLAIM_FAMILY_MEANING", "COMPARABLE_SLOT_TREND", "Compares slots.", "Compares slots.")], "MEANING_REGISTRY_LOCALE_MISMATCH"],
    ["Chinese text under en-SG", [...pair("CLAIM_FAMILY_MEANING", "COMPARABLE_SLOT_TREND", "比较时段。", "比较时段。")], "MEANING_REGISTRY_LOCALE_MISMATCH"],
    ["empty text", [...pair("CLAIM_FAMILY_MEANING", "COMPARABLE_SLOT_TREND", " ", "比较时段。")], "MEANING_REGISTRY_INVALID_ENTRY"],
    ["an unknown locale", [...VALID, { ...entry("LIMITATION_TEXT", "SPARSE_RECORDING", "en-SG", "x."), locale: "ms-SG" } as unknown as MeaningRegistryEntry], "MEANING_REGISTRY_INVALID_ENTRY"],
    ["another task", [...VALID, { ...entry("LIMITATION_TEXT", "SPARSE_RECORDING", "en-SG", "x."), task: "DRAFT_CARE_PREPARATION_SUMMARY" } as unknown as MeaningRegistryEntry], "MEANING_REGISTRY_INVALID_ENTRY"],
  ] as const)("rejects %s", (_label, entries, code) => {
    expect(() => buildMeaningRegistry("ai-meaning-registry.11b.1", entries as readonly MeaningRegistryEntry[])).toThrow(code);
  });

  it("rejects a malformed revision", () => {
    expect(() => buildMeaningRegistry("latest", VALID)).toThrow("MEANING_REGISTRY_INVALID_REVISION");
  });
});

describe("application rendering of limitation copy", () => {
  const limitations = [
    { ref: "limitation-1", code: "SPARSE_RECORDING" },
    { ref: "limitation-2", code: "DOES_NOT_ESTABLISH_CAUSE" },
    { ref: "limitation-3", code: "UNKNOWN_NEGATIVE_STATUS" },
  ] as const;

  it("renders every supplied limitation from the registry, in order, in the request locale", () => {
    expect(renderExplainLimitations(limitations, "zh-SG")).toEqual({
      complete: true,
      limitations: [
        { limitationRef: "limitation-1", code: "SPARSE_RECORDING", text: APPROVED.SPARSE_RECORDING!["zh-SG"] },
        { limitationRef: "limitation-2", code: "DOES_NOT_ESTABLISH_CAUSE", text: APPROVED.DOES_NOT_ESTABLISH_CAUSE!["zh-SG"] },
        { limitationRef: "limitation-3", code: "UNKNOWN_NEGATIVE_STATUS", text: APPROVED.UNKNOWN_NEGATIVE_STATUS!["zh-SG"] },
      ],
    });
  });

  it("shows the non-causal copy only once, and not at all beside the fixed ai.pattern.limitation row", () => {
    const repeated = [...limitations, { ref: "limitation-4", code: "DOES_NOT_ESTABLISH_CAUSE" }];
    expect(renderExplainLimitations(repeated, "en-SG").limitations.filter((value) => value.code === "DOES_NOT_ESTABLISH_CAUSE")).toHaveLength(1);
    const beside = renderExplainLimitations(repeated, "en-SG", { fixedNonCausalRowShown: true });
    expect(beside.limitations.map((value) => value.code)).toEqual(["SPARSE_RECORDING", "UNKNOWN_NEGATIVE_STATUS"]);
    expect(beside.complete).toBe(true);
  });

  it("reports incomplete copy instead of inventing text when an entry is missing", () => {
    expect(renderExplainLimitations([{ ref: "limitation-1", code: "HIGH_VARIABILITY" }, { ref: "limitation-2", code: "SPARSE_RECORDING" }], "en-SG")).toEqual({
      complete: false,
      limitations: [{ limitationRef: "limitation-2", code: "SPARSE_RECORDING", text: APPROVED.SPARSE_RECORDING!["en-SG"] }],
    });
  });
});
