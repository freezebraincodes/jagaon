import { describe, expect, it } from "vitest";
import { PACKET_11_FIXTURES } from "@/ai/evaluation/packet-11-fixtures";
import { asHybridRequest, plannedFixture } from "@/ai/evaluation/packet-11-hybrid-test-support";
import type { AtomTable, ShellFieldPath } from "@/domain/ai";
import { AI_HYBRID_RUNTIME_BUNDLES } from "../ai-hybrid-runtime-bundles";
import { planSlots } from "./slot-planner";
import { assembleComposition, assembleField, compositionValidationView, verifyComposition } from "./assembler";

const atoms = (entries: Record<string, string>): AtomTable => Object.fromEntries(Object.entries(entries).map(([slot, text]) => [slot, { text, boundRefs: [] }]));
const texts = (entries: Record<string, string>) => new Map(Object.entries(entries)) as Map<ShellFieldPath, string>;

describe("assembler ai-atoms.11b.6", () => {
  it.each([
    ["Your records show {{S2}}.", "Your records show 6.2 mmol/L and 7.1 mmol/L."],
    ["show{{S2}} .", "show 6.2 mmol/L and 7.1 mmol/L."],
    ["  Your   records show {{S2}} .  ", "Your records show 6.2 mmol/L and 7.1 mmol/L."],
  ])("en spacing: %j", (shell, expected) => {
    expect(assembleField(shell, atoms({ S2: "6.2 mmol/L and 7.1 mmol/L" }), "en-SG").text).toBe(expected);
  });
  it.each([
    ["您的记录显示为{{S2}}。", "您的记录显示为 6.2 mmol/L。"],
    ["以上内容基于 {{S3}} 。", "以上内容基于 10 条记录读数。"],
    ["记录的项目：{{S4}}。", "记录的项目：糙米饭。"],
    ["{{S2}} 和 {{S5}}", "6.2 mmol/L 和 7.1 mmol/L"],
  ])("zh spacing: %j", (shell, expected) => {
    expect(assembleField(shell, atoms({ S2: "6.2 mmol/L", S3: "10 条记录读数", S4: "糙米饭", S5: "7.1 mmol/L" }), "zh-SG").text).toBe(expected);
  });
  it("zh spacing treats only CJK ideographs (U+3400–U+9FFF, U+F900–U+FAFF) as ideographs, never Hangul", () => {
    const table = atoms({ S1: "6.2 mmol/L" });
    expect(assembleField("{{S1}}文", table, "zh-SG").text).toBe("6.2 mmol/L 文");
    expect(assembleField("{{S1}}\uF900", table, "zh-SG").text).toBe("6.2 mmol/L \uF900");
    expect(assembleField("{{S1}}\uFAFF", table, "zh-SG").text).toBe("6.2 mmol/L \uFAFF");
    expect(assembleField("{{S1}}가", table, "zh-SG").text).toBe("6.2 mmol/L가");
    expect(assembleField("가{{S1}}", table, "zh-SG").text).toBe("가6.2 mmol/L");
  });
  it("Review Focus: atoms are byte-identical and never re-substituted", () => {
    const field = assembleField("Item: {{S1}}; question: {{S2}}", atoms({ S1: "brown  rice {{S2}} ", S2: "“Is {{S1}} 10 mmol/L?”" }), "en-SG");
    expect(field.spans.map((span) => field.text.slice(span.start, span.end))).toEqual(["brown  rice {{S2}} ", "“Is {{S1}} 10 mmol/L?”"]);
  });
  it("S9: en adjacent duplicate after an atom", () => {
    const { request, plan, atoms: table } = plannedFixture("p11.explain-pattern.en-sg.ordinary");
    const shells = texts({ headline: "A look at {{S1}}.", observation: "Values: {{S2}}.", evidence: "This is based on {{S3}} readings." });
    expect(assembleComposition(request, plan, table, shells, AI_HYBRID_RUNTIME_BUNDLES.EXPLAIN_PATTERN)).toEqual({ kind: "REJECTED", reason: "FACT_FIDELITY_FAILED", gate: "S9" });
  });
  it("S9: zh adjacent duplicate after an atom", () => {
    const { request, plan, atoms: table } = plannedFixture("p11.explain-pattern.zh-sg.ordinary");
    const shells = texts({ headline: "看看{{S1}}。", observation: "数值：{{S2}}。", evidence: "以上内容基于{{S3}}读数。" });
    expect(assembleComposition(request, plan, table, shells, AI_HYBRID_RUNTIME_BUNDLES.EXPLAIN_PATTERN)).toEqual({ kind: "REJECTED", reason: "FACT_FIDELITY_FAILED", gate: "S9" });
  });
  it("S9: doubled punctuation across a boundary", () => {
    const { request, plan, atoms: table } = plannedFixture("p11.explain-pattern.en-sg.ordinary");
    const patched = { ...table, S1: { ...table.S1!, text: `${table.S1!.text}.` } };
    const shells = texts({ headline: "A look at {{S1}}.", observation: "Values: {{S2}}.", evidence: "Based on {{S3}}." });
    expect(assembleComposition(request, plan, patched, shells, AI_HYBRID_RUNTIME_BUNDLES.EXPLAIN_PATTERN)).toEqual({ kind: "REJECTED", reason: "FACT_FIDELITY_FAILED", gate: "S9" });
  });
  it("binds references from the plan and keeps the unchanged output schema version", () => {
    const { request, plan, atoms: table } = plannedFixture("p11.explain-pattern.en-sg.ordinary");
    const result = assembleComposition(request, plan, table, texts({ headline: "A look at {{S1}}.", observation: "Your records show {{S2}}.", evidence: "This is based on {{S3}}." }), AI_HYBRID_RUNTIME_BUNDLES.EXPLAIN_PATTERN);
    if (result.kind !== "ASSEMBLED") throw new Error("expected ASSEMBLED");
    expect(result.composition.output).toMatchObject({
      schemaVersion: "ai-output.explain-pattern@11b.1", outcome: "SUCCESS", locale: "en-SG", inputRefsUsed: ["claim-1", "fact-1", "fact-2", "fact-3"],
      payload: { headline: { claimRefs: ["claim-1"] }, observation: { text: "Your records show 6.2 mmol/L and 7.1 mmol/L.", claimRefs: ["claim-1"] }, evidence: { text: "This is based on 10 recorded readings.", factRefs: ["fact-1", "fact-2", "fact-3"] } },
    });
    expect(verifyComposition(request, AI_HYBRID_RUNTIME_BUNDLES.EXPLAIN_PATTERN, result.composition)).toMatchObject({ kind: "ACCEPTED" });
  });
  it("S10 is live: a tampered composition is rejected by the unchanged validator", () => {
    const { request, plan, atoms: table } = plannedFixture("p11.explain-pattern.en-sg.ordinary");
    const result = assembleComposition(request, plan, table, texts({ headline: "A look at {{S1}}.", observation: "Your records show {{S2}}.", evidence: "This is based on {{S3}}." }), AI_HYBRID_RUNTIME_BUNDLES.EXPLAIN_PATTERN);
    if (result.kind !== "ASSEMBLED") throw new Error("expected ASSEMBLED");
    const tampered = { ...result.composition, output: { ...result.composition.output, payload: { ...(result.composition.output as any).payload, observation: { text: "Your records show 12 values.", claimRefs: ["claim-1"] } } } };
    expect(verifyComposition(request, AI_HYBRID_RUNTIME_BUNDLES.EXPLAIN_PATTERN, tampered as never)).toMatchObject({ kind: "REJECTED", reason: "FACT_FIDELITY_FAILED" });
  });
  it("the care validation view prefixes each intro to its first bullet", () => {
    const { request, plan, atoms: table } = plannedFixture("p11.draft-care-preparation-summary.zh-sg.ordinary");
    const shells = texts(Object.fromEntries(plan.fields.map((field) => [field.path, field.requiredSlots.length === 0 ? "您选择加入的内容：" : field.requiredSlots.map((slot) => `{{${slot}}}`).join("，")])));
    const result = assembleComposition(request, plan, table, shells, AI_HYBRID_RUNTIME_BUNDLES.DRAFT_CARE_PREPARATION_SUMMARY);
    if (result.kind !== "ASSEMBLED") throw new Error("expected ASSEMBLED");
    const view = compositionValidationView(result.composition) as any;
    expect(view.payload.sections[0].bullets[0].text.startsWith("您选择加入的内容：")).toBe(true);
    expect(verifyComposition(request, AI_HYBRID_RUNTIME_BUNDLES.DRAFT_CARE_PREPARATION_SUMMARY, result.composition)).toMatchObject({ kind: "ACCEPTED" });
  });
  it.each([
    ["a question with token-like text and digits", "Is {{S1}} 10 mmol/L okay? (demo)"],
    ["a question with a phone number (redacted atom, ruling 7)", "Can I call 91234567 about the pen? (demo)"],
  ])("Review Focus: %s passes S10 and stays verbatim (after redaction)", (_label, question) => {
    const fixture = PACKET_11_FIXTURES.find((entry) => entry.id === "p11.draft-care-preparation-summary.en-sg.ordinary")!;
    const request = asHybridRequest(structuredClone(fixture.request));
    (request.facts as any[]).find((fact) => fact.field === "QUESTION_TEXT").value.text = question;
    const planned = planSlots(request, AI_HYBRID_RUNTIME_BUNDLES.DRAFT_CARE_PREPARATION_SUMMARY);
    if (planned.kind !== "PLANNED") throw new Error("expected PLANNED");
    const shells = texts(Object.fromEntries(planned.plan.fields.map((field) => [field.path, field.requiredSlots.length === 0 ? "Things you chose to include:" : field.requiredSlots.map((slot) => `{{${slot}}}`).join(", ")])));
    const result = assembleComposition(request, planned.plan, planned.atoms, shells, AI_HYBRID_RUNTIME_BUNDLES.DRAFT_CARE_PREPARATION_SUMMARY);
    if (result.kind !== "ASSEMBLED") throw new Error("expected ASSEMBLED");
    const quoted = Object.values(planned.atoms).find((entry) => entry!.text.startsWith("“"))!.text;
    expect(quoted.includes("91234567")).toBe(false);
    expect([...result.composition.fields.values()].some((field) => field.text.includes(quoted))).toBe(true);
    expect(verifyComposition(request, AI_HYBRID_RUNTIME_BUNDLES.DRAFT_CARE_PREPARATION_SUMMARY, result.composition)).toMatchObject({ kind: "ACCEPTED" });
  });
});
