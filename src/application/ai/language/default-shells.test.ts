import { describe, expect, it } from "vitest";
import type { AtomKind, ShellTexts, SlotPlan } from "@/domain/ai";
import { assertShellClosure, defaultShells } from "./default-shells";

const explainPlan = (locale: "en-SG" | "zh-SG", kinds: AtomKind[]): SlotPlan => {
  const home = (kind: AtomKind) => (kind === "MEANING" ? "headline" : kind === "COUNT" ? "evidence" : "observation");
  const slots = kinds.map((atomKind, index) => ({ slotId: `S${index + 1}`, atomKind, homeField: home(atomKind), boundRefs: [], orderGroup: null, glossKey: "MEANING_CLAUSE" }));
  const fields = (["headline", "observation", "evidence"] as const).map((path) => ({ path, requiredSlots: slots.filter((slot) => slot.homeField === path).map((slot) => slot.slotId), maxCodePoints: 90, maxSentences: 2, mayBeAtomOnly: false }));
  return { planVersion: "ai-slot-plan.11b.7", taskType: "EXPLAIN_PATTERN", locale, runtimeBundleKey: "ai.explain-pattern@11b.17", claimFamily: "COMPARABLE_SLOT_TREND", fields, slots, sections: [] } as unknown as SlotPlan;
};

/** Helper: verify that all requiredSlots are present exactly once (multiset equality using sorted arrays) */
const assertClosure = (plan: SlotPlan, texts: ShellTexts): void => {
  for (const field of plan.fields) {
    const required = [...field.requiredSlots].sort();
    const text = texts.get(field.path) ?? "";
    const found: string[] = [];
    const matches = [...text.matchAll(/\{\{(S\d+)\}\}/g)];
    for (const match of matches) {
      found.push(match[1]);
    }
    const foundSorted = found.sort();
    expect(foundSorted).toEqual(required);
  }
};

describe("default shells ai-shells-default.11b.6", () => {
  it("builds the approved EXPLAIN defaults in English and Chinese", () => {
    const enPlan = explainPlan("en-SG", ["MEANING", "DECIMAL_LIST", "COUNT"]);
    const enTexts = defaultShells(enPlan);
    expect([...enTexts.values()]).toEqual(["This looks at {{S1}}.", "Recorded values: {{S2}}.", "This is based on {{S3}}."]);
    assertClosure(enPlan, enTexts);

    const zhPlan = explainPlan("zh-SG", ["MEANING", "DECIMAL_LIST", "COUNT"]);
    const zhTexts = defaultShells(zhPlan);
    expect([...zhTexts.values()]).toEqual(["这里看的是{{S1}}。", "记录的数值：{{S2}}。", "以上内容基于{{S3}}。"]);
    assertClosure(zhPlan, zhTexts);
  });
  it("joins group tokens and orders observation sentences values, dates, ranges, times, items", () => {
    const plan1 = explainPlan("en-SG", ["MEANING", "DATE", "DATE", "COUNT"]);
    const texts1 = defaultShells(plan1);
    expect(texts1.get("observation")).toBe("Recorded dates: {{S2}} and {{S3}}.");
    assertClosure(plan1, texts1);

    const plan2 = explainPlan("en-SG", ["MEANING", "DECIMAL_LIST", "LABEL", "LABEL", "COUNT"]);
    const texts2 = defaultShells(plan2);
    expect(texts2.get("observation")).toBe("Recorded values: {{S2}}. Recorded items, in your own words: “{{S3}}” and “{{S4}}”.");
    assertClosure(plan2, texts2);

    const plan3 = explainPlan("zh-SG", ["MEANING", "DECIMAL_LIST", "LABEL", "LABEL", "COUNT"]);
    const texts3 = defaultShells(plan3);
    expect(texts3.get("observation")).toBe("记录的数值：{{S2}}。记录的项目（您的原文）：“{{S3}}” 和 “{{S4}}”。");
    assertClosure(plan3, texts3);
  });
  it("uses the no-count evidence sentence when no COUNT slot exists", () => {
    const plan = explainPlan("en-SG", ["MEANING", "DATE"]);
    const texts = defaultShells(plan);
    expect(texts.get("evidence")).toBe("This is based on your recorded information.");
    assertClosure(plan, texts);
  });
  it("builds care intros from the approved copy and atom-only bullets, joining an appointment pair", () => {
    const plan = {
      planVersion: "ai-slot-plan.11b.7", taskType: "DRAFT_CARE_PREPARATION_SUMMARY", locale: "zh-SG", runtimeBundleKey: "ai.draft-care-preparation-summary@11b.17", claimFamily: null,
      fields: [
        { path: "sections[0].intro", requiredSlots: [], maxCodePoints: 80, maxSentences: 1, mayBeAtomOnly: false },
        { path: "sections[0].bullets[0]", requiredSlots: ["S1", "S2"], maxCodePoints: 60, maxSentences: 1, mayBeAtomOnly: true },
      ],
      slots: [], sections: [{ sectionSlot: "C1", sectionRef: "section-1", sectionId: "CARE_ORGANISATION", heading: "h", introPath: "sections[0].intro", bulletPaths: ["sections[0].bullets[0]"] }],
    } as unknown as SlotPlan;
    const texts = defaultShells(plan);
    expect([...texts.entries()]).toEqual([["sections[0].intro", "您选择加入的预约信息："], ["sections[0].bullets[0]", "{{S1}}，{{S2}}"]]);
    assertClosure(plan, texts);
  });

  it("fails closed when the observation has an unmapped atom kind (DECIMAL): the observation composer refuses it (11b.18)", () => {
    const plan = explainPlan("en-SG", ["MEANING", "DECIMAL", "COUNT"]);
    expect(() => defaultShells(plan)).toThrow("OBSERVATION_COMPOSITION_INVALID");
  });

  it("throws DEFAULT_SHELL_TOKEN_MISMATCH when evidence field has multiple COUNT slots", () => {
    const kinds = ["MEANING", "COUNT", "COUNT"] as AtomKind[];
    const home = (kind: AtomKind) => (kind === "MEANING" ? "headline" : kind === "COUNT" ? "evidence" : "observation");
    const slots = kinds.map((atomKind, index) => ({ slotId: `S${index + 1}`, atomKind, homeField: home(atomKind), boundRefs: [], orderGroup: null, glossKey: "MEANING_CLAUSE" }));
    const fields = (["headline", "observation", "evidence"] as const).map((path) => ({ path, requiredSlots: slots.filter((slot) => slot.homeField === path).map((slot) => slot.slotId), maxCodePoints: 90, maxSentences: 2, mayBeAtomOnly: false }));
    const plan = { planVersion: "ai-slot-plan.11b.7", taskType: "EXPLAIN_PATTERN", locale: "en-SG", runtimeBundleKey: "ai.explain-pattern@11b.17", claimFamily: "COMPARABLE_SLOT_TREND", fields, slots, sections: [] } as unknown as SlotPlan;
    expect(() => defaultShells(plan)).toThrow("DEFAULT_SHELL_TOKEN_MISMATCH");
  });
});

describe("assertShellClosure unit tests", () => {
  it("throws DEFAULT_SHELL_TOKEN_MISMATCH when a token is duplicated", () => {
    const plan = {
      planVersion: "ai-slot-plan.11b.7", taskType: "EXPLAIN_PATTERN", locale: "en-SG",
      runtimeBundleKey: "ai.explain-pattern@11b.17", claimFamily: "COMPARABLE_SLOT_TREND",
      fields: [{ path: "test", requiredSlots: ["S1"], maxCodePoints: 90, maxSentences: 2, mayBeAtomOnly: false }],
      slots: [], sections: [],
    } as unknown as SlotPlan;
    const texts = new Map([["test", "{{S1}} and {{S1}}"]]) as unknown as ShellTexts;
    expect(() => assertShellClosure(plan, texts)).toThrow("DEFAULT_SHELL_TOKEN_MISMATCH");
  });

  it("throws DEFAULT_SHELL_TOKEN_MISMATCH when a required field is missing", () => {
    const plan = {
      planVersion: "ai-slot-plan.11b.7", taskType: "EXPLAIN_PATTERN", locale: "en-SG",
      runtimeBundleKey: "ai.explain-pattern@11b.17", claimFamily: "COMPARABLE_SLOT_TREND",
      fields: [{ path: "test", requiredSlots: ["S1"], maxCodePoints: 90, maxSentences: 2, mayBeAtomOnly: false }],
      slots: [], sections: [],
    } as unknown as SlotPlan;
    const texts = new Map([]) as unknown as ShellTexts;
    expect(() => assertShellClosure(plan, texts)).toThrow("DEFAULT_SHELL_TOKEN_MISMATCH");
  });

  it("throws DEFAULT_SHELL_TOKEN_MISMATCH when text contains extra tokens not in requiredSlots", () => {
    const plan = {
      planVersion: "ai-slot-plan.11b.7", taskType: "EXPLAIN_PATTERN", locale: "en-SG",
      runtimeBundleKey: "ai.explain-pattern@11b.17", claimFamily: "COMPARABLE_SLOT_TREND",
      fields: [{ path: "test", requiredSlots: ["S1"], maxCodePoints: 90, maxSentences: 2, mayBeAtomOnly: false }],
      slots: [], sections: [],
    } as unknown as SlotPlan;
    const texts = new Map([["test", "{{S1}} and {{S2}}"]]) as unknown as ShellTexts;
    expect(() => assertShellClosure(plan, texts)).toThrow("DEFAULT_SHELL_TOKEN_MISMATCH");
  });
});
