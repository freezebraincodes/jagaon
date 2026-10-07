import { describe, expect, it } from "vitest";
import { PACKET_11_FIXTURES } from "@/ai/evaluation/packet-11-fixtures";
import { AI_HYBRID_RUNTIME_BUNDLES } from "../ai-hybrid-runtime-bundles";
import { OUTPUT_CODE_POINTS_PER_TOKEN } from "../ai-output-validator";
import { asHybridRequest, shellCandidate } from "@/ai/evaluation/packet-11-hybrid-test-support";
import { AI_ORGANISABLE_SECTIONS, remoteFields, type AiTaskRequest, type ShellFieldPath, type ShellFieldSpec, type SlotPlan } from "@/domain/ai";
import { AI_LANGUAGE_COPY } from "./ai-language-copy";
import { composeAiResult } from "./ai-composition";
import { validationViewJoin, verifyComposition } from "./assembler";
import { defaultShells } from "./default-shells";
import { composeDeterministic } from "./deterministic-composition";
import { approvedSectionHeading } from "./shell-projector";
import { validateShellCandidate } from "./shell-validator";
import { ATOM_SPACING_RESERVE, FIELD_SCHEMA_LIMITS, planSlots } from "./slot-planner";

const cp = (text: string) => [...text].length;
const fixture = (id: string) => PACKET_11_FIXTURES.find((entry) => entry.id === id)!;
const plan = (request: any) => planSlots(asHybridRequest(request), AI_HYBRID_RUNTIME_BUNDLES[request.taskType as "EXPLAIN_PATTERN"]);

/**
 * A maximal compliant shell for a field: the prose outside tokens is exactly maxCodePoints code points of a
 * neutral filler (one sentence, no punctuation), and every token sits between filler letters so the assembler
 * adds the full spacing on both sides of each atom.
 * Rules r4 fix round 2: the filler varies (en: five-letter words cycling z, q, x, j, v; zh: ideographs cycling 文字段落句),
 * so it holds the distinct units the S7b wording gate counts; lengths and token positions are unchanged.
 */
function maximalShell(field: ShellFieldSpec, locale: SlotPlan["locale"]): string {
  const letterAt = (index: number) => (locale === "en-SG" ? "zqxjv"[Math.floor(index / 6) % 5]! : "文字段落句"[index % 5]!);
  const chars = Array.from({ length: field.maxCodePoints }, (_, index) => (locale === "en-SG" && index % 6 === 5 ? " " : letterAt(index)));
  const tokens = field.requiredSlots.length;
  for (let index = 0; index <= Math.min(2 * tokens, chars.length - 1); index += 1) chars[index] = letterAt(index);
  chars[chars.length - 1] = letterAt(chars.length - 1);
  const positions = chars.length >= 2 * tokens + 1 ? field.requiredSlots.map((_, index) => 2 * index + 1) : field.requiredSlots.map(() => chars.length);
  let text = "";
  let slot = 0;
  for (let index = 0; index <= chars.length; index += 1) {
    while (slot < tokens && positions[slot] === index) text += `{{${field.requiredSlots[slot++]}}}`;
    if (index < chars.length) text += chars[index];
  }
  return text;
}
function maximalCandidate(planned: SlotPlan) {
  return shellCandidate(planned, new Map(planned.fields.map((field) => [field.path, maximalShell(field, planned.locale)] as [ShellFieldPath, string])));
}
function expectMaximalCandidateAccepted(request: AiTaskRequest, label: string) {
  const bundle = AI_HYBRID_RUNTIME_BUNDLES[request.taskType as "EXPLAIN_PATTERN" | "DRAFT_CARE_PREPARATION_SUMMARY"];
  const result = planSlots(request, bundle);
  if (result.kind !== "PLANNED") throw new Error(`expected PLANNED ${label}`);
  expect(result.plan.remote, label).toEqual({ eligible: true });
  const validated = validateShellCandidate(result.plan, bundle, maximalCandidate(result.plan));
  expect(validated.kind === "REJECTED" ? `${validated.gate} ${validated.reason}` : validated.kind, label).toBe("VALID");
  if (validated.kind !== "VALID") return;
  // Observation ownership: the model's fields are maximal; the application composes the EXPLAIN observation (S9, S10 in composeAiResult).
  for (const field of remoteFields(result.plan)) expect([...validated.shells.get(field.path)!.replace(/\{\{S\d+\}\}/g, "").trim()].length, `${label} ${field.path}`).toBe(field.maxCodePoints);
  const composed = composeAiResult(request, result.plan, result.atoms, validated.shells, bundle);
  expect(composed.kind === "REJECTED" ? `${composed.gate} ${composed.reason}` : composed.kind, label).toBe("ACCEPTED");
  if (composed.kind !== "ACCEPTED") return;
  const verdict = verifyComposition(request, bundle, composed.composition);
  expect(verdict.kind === "REJECTED" ? verdict.reason : verdict.kind, label).toBe("ACCEPTED");
}
/** A synthetic en-SG care request at the output ceiling: six sections sharing `count` "6.2 mmol/L" facts. */
function nearCeilingCareRequest(count: number): AiTaskRequest {
  const request = asHybridRequest(fixture("p11.draft-care-preparation-summary.en-sg.ordinary").request) as any;
  request.facts = Array.from({ length: count }, (_, index) => ({ ref: `fact-${index + 1}`, field: "MEASUREMENT_VALUE", value: { kind: "DECIMAL", value: "6.2", unit: "MMOL_L" }, sources: [] }));
  const sectionIds = ["CURRENT_CARE_PLAN", "CARE_ORGANISATION", "MEASUREMENTS", "MEDICATION_RECORDS", "INTAKE_AND_ACTIVITY", "QUESTIONS_FOR_CARE_TEAM"];
  request.taskPayload.sections = sectionIds.map((sectionId, section) => ({ ref: `section-${section + 1}`, sectionId, factRefs: request.facts.filter((_: unknown, index: number) => index % sectionIds.length === section).map((fact: any) => fact.ref) }));
  return request as AiTaskRequest;
}

/** The owner-approved fixed budget table (decision 3): task x locale x field kind; never data-dependent. */
const FIXED_BUDGETS = {
  EXPLAIN_PATTERN: { "en-SG": { headline: 60, observation: 120, evidence: 80 }, "zh-SG": { headline: 50, observation: 90, evidence: 60 } },
  DRAFT_CARE_PREPARATION_SUMMARY: { "en-SG": { intro: 60, bullet: 40 }, "zh-SG": { intro: 30, bullet: 24 } },
} as const;
const MAX_SENTENCES = { headline: 1, observation: 2, evidence: 1, intro: 1, bullet: 1 } as const;
const kindOf = (path: string) => (path.endsWith(".intro") ? "intro" : path.includes(".bullets[") ? "bullet" : path) as keyof typeof MAX_SENTENCES;
const budgetOf = (planned: SlotPlan, path: string) => (FIXED_BUDGETS[planned.taskType][planned.locale] as Record<string, number>)[kindOf(path)];
const planned = (request: AiTaskRequest) => {
  const result = planSlots(request, AI_HYBRID_RUNTIME_BUNDLES[request.taskType as "EXPLAIN_PATTERN" | "DRAFT_CARE_PREPARATION_SUMMARY"]);
  if (result.kind !== "PLANNED") throw new Error(`expected PLANNED, got ${result.reason}`);
  return result;
};
const careWithSection = (fixtureId: string, sectionId: string) => {
  const request = asHybridRequest(fixture(fixtureId).request) as any;
  request.taskPayload.sections[0].sectionId = sectionId;
  return request as AiTaskRequest;
};
const careWithQuestion = (text: string) => {
  const request = asHybridRequest(fixture("p11.draft-care-preparation-summary.en-sg.ordinary").request) as any;
  request.facts.find((fact: any) => fact.field === "QUESTION_TEXT").value.text = text;
  return request as AiTaskRequest;
};
const explainWithLabel = (text: string) => {
  const request = asHybridRequest(fixture("p11.explain-pattern.en-sg.ordinary").request) as any;
  request.facts.push({ ref: "fact-9", field: "INTAKE_LABEL", value: { kind: "TEXT", text, language: "en-SG" }, sources: structuredClone(request.facts[0].sources) });
  request.taskPayload.claim.factRefs.push("fact-9");
  return request as AiTaskRequest;
};

describe("slot planner ai-slot-plan.11b.8", () => {
  it("plans every fixture that expects SUCCESS, in both locales, remote-eligible under the fixed budgets", () => {
    for (const entry of PACKET_11_FIXTURES.filter((item) => item.expectedOutcome === "SUCCESS")) {
      const result = plan(entry.request);
      expect(result.kind, entry.id).toBe("PLANNED");
      if (result.kind !== "PLANNED") continue;
      expect(result.plan.planVersion, entry.id).toBe("ai-slot-plan.11b.8");
      // ai-slot-plan.11b.8: every field names its owner; only the EXPLAIN observation is application-owned.
      expect(result.plan.fields.filter((field) => field.owner === "LOCAL").map((field) => field.path), entry.id).toEqual(result.plan.taskType === "EXPLAIN_PATTERN" ? ["observation"] : []);
      expect(result.plan.remote, entry.id).toEqual({ eligible: true });
    }
  });
  it("takes every maxCodePoints from the fixed task x locale table and keeps maxSentences", () => {
    let fields = 0;
    for (const entry of PACKET_11_FIXTURES) {
      const result = plan(entry.request);
      if (result.kind !== "PLANNED") continue;
      for (const field of result.plan.fields) {
        fields += 1;
        expect(field.maxCodePoints, `${entry.id} ${field.path}`).toBe(budgetOf(result.plan, field.path));
        expect(field.maxSentences, `${entry.id} ${field.path}`).toBe(MAX_SENTENCES[kindOf(field.path)]);
      }
    }
    expect(fields).toBeGreaterThan(0);
  });
  it("budgets never depend on atom length: requests differing only in a label's length get identical field budgets", () => {
    const short = planned(explainWithLabel("Rice"));
    const long = planned(explainWithLabel("Brown rice with steamed vegetables and a bowl of soup"));
    expect(short.atoms.S3!.text).not.toBe(long.atoms.S3!.text);
    expect(short.plan.fields).toEqual(long.plan.fields);
    expect(short.plan.fields.map((field) => field.maxCodePoints)).toEqual([60, 120, 80]);
    const shortQuestion = planned(careWithQuestion("Is this fine?"));
    const longQuestion = planned(careWithQuestion(`${"Should I bring my readings to the clinic visit ".repeat(4)}?`));
    expect(shortQuestion.plan.fields).toEqual(longQuestion.plan.fields);
    expect(longQuestion.plan.remote).toEqual({ eligible: true });
  });
  it("the fixed table covers the default shell prose of every field of every plannable fixture (never a runtime shrink)", () => {
    for (const entry of PACKET_11_FIXTURES) {
      const result = plan(entry.request);
      if (result.kind !== "PLANNED") continue;
      const defaults = defaultShells(result.plan);
      for (const field of result.plan.fields) expect(cp(defaults.get(field.path)!.replace(/\{\{S\d+\}\}/g, "").trim()), `${entry.id} ${field.path}`).toBeLessThanOrEqual(field.maxCodePoints);
    }
  });
  it("numbers slots in the documented order and binds every supplied fact exactly once", () => {
    const result = plan(fixture("p11.explain-pattern.en-sg.ordinary").request);
    if (result.kind !== "PLANNED") throw new Error("expected PLANNED");
    expect(result.plan.slots.map((slot) => [slot.slotId, slot.atomKind, slot.homeField, slot.boundRefs])).toEqual([
      ["S1", "MEANING", "headline", ["claim-1"]],
      ["S2", "DECIMAL_LIST", "observation", ["fact-1", "fact-2"]],
      ["S3", "COUNT", "evidence", ["fact-3"]],
    ]);
    expect(result.atoms).toEqual({ S1: expect.objectContaining({ text: "your readings from the same time slot in an earlier and a recent period" }), S2: expect.objectContaining({ text: "6.2 mmol/L and 7.1 mmol/L" }), S3: expect.objectContaining({ text: "10 recorded readings" }) });
    const bound = result.plan.slots.flatMap((slot) => slot.boundRefs).filter((ref) => ref.startsWith("fact-"));
    expect(new Set(bound).size).toBe(bound.length);
  });
  it.each([
    ["an unplanned field", (r: any) => (r.facts[0].field = "UNCERTAINTY")],
    ["an unsupported unit", (r: any) => (r.facts[0].value.unit = "KG")],
    ["mixed display units", (r: any) => (r.facts[1].value.unit = "MG_DL")],
    ["two counts", (r: any) => { r.facts.push({ ...r.facts[2], ref: "fact-9" }); r.taskPayload.claim.factRefs.push("fact-9"); }],
    ["a fact outside the claim", (r: any) => r.facts.push({ ...r.facts[0], ref: "fact-9" })],
  ])("fails closed (PAYLOAD_INVALID) for %s", (_label, mutate) => {
    const request = structuredClone(fixture("p11.explain-pattern.en-sg.ordinary").request);
    mutate(request);
    expect(plan(request)).toEqual({ kind: "UNPLANNABLE", reason: "PAYLOAD_INVALID" });
  });
  it("keeps the projector's privacy fallback", () => {
    const request = structuredClone(fixture("p11.explain-pattern.en-sg.ordinary").request) as any;
    request.facts[0].field = "QUESTION_TEXT"; // not on the EXPLAIN allowlist
    expect(plan(request)).toEqual({ kind: "UNPLANNABLE", reason: "PRIVACY_REJECTED" });
  });
  it("plans care sections, bullets and the appointment pair", () => {
    const entry = PACKET_11_FIXTURES.find((item) => item.taskType === "DRAFT_CARE_PREPARATION_SUMMARY" && (item.request.taskPayload as any).sections.some((s: any) => s.sectionId === "CARE_ORGANISATION"))!;
    const result = plan(entry.request);
    if (result.kind !== "PLANNED") throw new Error("expected PLANNED");
    const organisation = result.plan.sections.find((section) => section.sectionId === "CARE_ORGANISATION")!;
    const pairBullet = result.plan.fields.find((field) => field.path === organisation.bulletPaths[0])!;
    expect(pairBullet.requiredSlots).toHaveLength(2);
    expect(result.plan.slots.filter((slot) => pairBullet.requiredSlots.includes(slot.slotId)).map((slot) => slot.orderGroup)).toEqual(["appointment-0", "appointment-0"]);
  });
  it("fails closed when a care fact is referenced by no section (it would be dropped silently)", () => {
    const request = structuredClone(fixture("p11.draft-care-preparation-summary.en-sg.ordinary").request) as any;
    const source = request.facts.find((fact: any) => fact.field === "MEASUREMENT_VALUE");
    request.facts.push({ ...structuredClone(source), ref: "fact-99" });
    expect(plan(request)).toEqual({ kind: "UNPLANNABLE", reason: "PAYLOAD_INVALID" });
  });
  it("fails closed when a care fact is referenced by two sections (it would be bound twice)", () => {
    const request = structuredClone(fixture("p11.draft-care-preparation-summary.en-sg.ordinary").request) as any;
    const sections = request.taskPayload.sections;
    expect(sections.length).toBeGreaterThan(1);
    sections[1].factRefs.push(sections[0].factRefs[0]);
    expect(plan(request)).toEqual({ kind: "UNPLANNABLE", reason: "PAYLOAD_INVALID" });
  });
  it("Review Focus: every assembled field fits its schema limit and the output budget, for every fixture", () => {
    for (const entry of PACKET_11_FIXTURES.filter((item) => item.expectedOutcome === "SUCCESS")) {
      const result = plan(entry.request);
      if (result.kind !== "PLANNED" || !result.plan.remote.eligible) continue;
      const bundle = AI_HYBRID_RUNTIME_BUNDLES[entry.taskType];
      let total = result.plan.sections.length * cp(validationViewJoin(result.plan.locale));
      for (const field of result.plan.fields) {
        const atomCost = field.requiredSlots.reduce((sum, slot) => sum + cp(result.atoms[slot]!.text) + ATOM_SPACING_RESERVE, 0);
        const limit = field.path === "headline" ? FIELD_SCHEMA_LIMITS.headline : field.path === "observation" ? FIELD_SCHEMA_LIMITS.observation : field.path === "evidence" ? FIELD_SCHEMA_LIMITS.evidence : FIELD_SCHEMA_LIMITS.bullet;
        expect(field.maxCodePoints + atomCost, `${entry.id} ${field.path}`).toBeLessThanOrEqual(limit);
        total += field.maxCodePoints + atomCost;
      }
      expect(total, entry.id).toBeLessThanOrEqual(bundle.executionBudget.outputTokenCeiling * OUTPUT_CODE_POINTS_PER_TOKEN);
    }
  });
  it("Review Focus: a field whose fixed budget and atom exceed its schema limit is PLANNED but remote-ineligible (BUDGET_EXCEEDED), budgets unchanged", () => {
    const ordinary = planned(asHybridRequest(fixture("p11.draft-care-preparation-summary.en-sg.ordinary").request));
    const request = careWithQuestion(`${"Q".repeat(300)}?`);
    const result = planned(request);
    expect(result.plan.remote).toEqual({ eligible: false, reason: "BUDGET_EXCEEDED" });
    expect(result.plan.fields).toEqual(ordinary.plan.fields);
    // The deterministic composition used instead of a provider call passes the composition verifier (S10).
    const bundle = AI_HYBRID_RUNTIME_BUNDLES.DRAFT_CARE_PREPARATION_SUMMARY;
    expect(verifyComposition(request, bundle, composeDeterministic(request, result.plan, result.atoms, bundle))).toMatchObject({ kind: "ACCEPTED" });
  });
  it("Review Focus: a plan over the output ceiling is PLANNED but remote-ineligible (BUDGET_EXCEEDED)", () => {
    expect(planned(nearCeilingCareRequest(16)).plan.remote).toEqual({ eligible: true });
    const over = planned(nearCeilingCareRequest(20));
    expect(over.plan.remote).toEqual({ eligible: false, reason: "BUDGET_EXCEEDED" });
    expect(over.plan.fields.every((field) => field.maxCodePoints === budgetOf(over.plan, field.path))).toBe(true);
    const request = nearCeilingCareRequest(20);
    const bundle = AI_HYBRID_RUNTIME_BUNDLES.DRAFT_CARE_PREPARATION_SUMMARY;
    expect(verifyComposition(request, bundle, composeDeterministic(request, over.plan, over.atoms, bundle))).toMatchObject({ kind: "ACCEPTED" });
  });
  it("Review Focus: fails closed (UNPLANNABLE) when even the deterministic composition cannot fit a question", () => {
    const entry = PACKET_11_FIXTURES.find((item) => item.id === "p11.draft-care-preparation-summary.en-sg.ordinary")!;
    const tooLong = structuredClone(entry.request) as any;
    tooLong.facts.find((fact: any) => fact.field === "QUESTION_TEXT").value.text = "Q".repeat(390) + "?";
    expect(plan(tooLong)).toEqual({ kind: "UNPLANNABLE", reason: "BUDGET_EXCEEDED" });
  });
  it.each(["en-SG", "zh-SG"] as const)("remote eligibility of a care section follows its approved heading (%s): ineligible (PAYLOAD_INVALID) exactly when there is none", (locale) => {
    const fixtureId = locale === "en-SG" ? "p11.draft-care-preparation-summary.en-sg.ordinary" : "p11.draft-care-preparation-summary.zh-sg.ordinary";
    const withHeading = AI_ORGANISABLE_SECTIONS.filter((sectionId) => approvedSectionHeading(locale, sectionId) !== null);
    expect(withHeading.length).toBeGreaterThan(0);
    expect(withHeading).not.toContain("SYMPTOMS_AND_CONTEXT");
    expect(withHeading).not.toContain("PATTERNS");
    for (const sectionId of AI_ORGANISABLE_SECTIONS) {
      const result = planned(careWithSection(fixtureId, sectionId));
      const heading = approvedSectionHeading(locale, sectionId);
      expect(result.plan.remote, `${locale} ${sectionId}`).toEqual(heading === null ? { eligible: false, reason: "PAYLOAD_INVALID" } : { eligible: true });
      expect(result.plan.sections[0]!.heading, `${locale} ${sectionId}`).toBe(heading);
    }
  });
  it("an eligible section with an approved heading stays eligible", () => {
    const result = planned(careWithSection("p11.draft-care-preparation-summary.en-sg.ordinary", "MEASUREMENTS"));
    expect(result.plan.remote).toEqual({ eligible: true });
    expect(result.plan.sections[0]!.heading).toBe(approvedSectionHeading("en-SG", "MEASUREMENTS"));
    expect(result.plan.sections[0]!.heading).toEqual(expect.any(String));
  });
  it.each([
    ["SYMPTOMS_AND_CONTEXT", "p11.draft-care-preparation-summary.en-sg.ordinary"],
    ["PATTERNS", "p11.draft-care-preparation-summary.en-sg.ordinary"],
    ["SYMPTOMS_AND_CONTEXT", "p11.draft-care-preparation-summary.zh-sg.ordinary"],
    ["PATTERNS", "p11.draft-care-preparation-summary.zh-sg.ordinary"],
  ])("a care request with %s (%s) is PLANNED but remote-ineligible (PAYLOAD_INVALID), with no invented heading and the approved default intro", (sectionId, fixtureId) => {
    const request = careWithSection(fixtureId, sectionId);
    const bundle = AI_HYBRID_RUNTIME_BUNDLES.DRAFT_CARE_PREPARATION_SUMMARY;
    const result = planned(request);
    expect(result.plan.remote).toEqual({ eligible: false, reason: "PAYLOAD_INVALID" });
    expect(result.plan.sections[0]).toMatchObject({ sectionId, heading: null });
    expect(defaultShells(result.plan).get(result.plan.sections[0]!.introPath)).toBe(AI_LANGUAGE_COPY.careIntros[sectionId]![request.locale]);
    const composition = composeDeterministic(request, result.plan, result.atoms, bundle);
    expect(composition.sectionIntros[result.plan.sections[0]!.sectionRef]).toBe(AI_LANGUAGE_COPY.careIntros[sectionId]![request.locale]);
    // The deterministic composition used instead of a provider call passes the composition verifier (S10).
    expect(verifyComposition(request, bundle, composition)).toMatchObject({ kind: "ACCEPTED" });
  });
  it("Review Focus: a maximal compliant candidate passes S1–S10 for every plannable fixture", () => {
    let planned = 0;
    for (const entry of PACKET_11_FIXTURES) {
      const request = asHybridRequest(entry.request);
      const result = planSlots(request, AI_HYBRID_RUNTIME_BUNDLES[entry.taskType]);
      if (result.kind !== "PLANNED" || !result.plan.remote.eligible) continue;
      planned += 1;
      expectMaximalCandidateAccepted(request, entry.id);
    }
    expect(planned).toBeGreaterThan(0);
  });
  it.each([10, 11, 12, 13, 14])("Review Focus: a maximal compliant candidate passes S10 for a near-ceiling en-SG care plan (six sections, %i facts)", (count) => {
    const request = nearCeilingCareRequest(count);
    const result = planSlots(request, AI_HYBRID_RUNTIME_BUNDLES.DRAFT_CARE_PREPARATION_SUMMARY);
    if (result.kind !== "PLANNED") throw new Error("expected PLANNED");
    expect(result.plan.sections).toHaveLength(6);
    expectMaximalCandidateAccepted(request, `near-ceiling ${count}`);
  });
  it("refuses a request that does not name the hybrid bundle", () => {
    const request = fixture("p11.explain-pattern.en-sg.ordinary").request; // legacy key @11b.3
    expect(planSlots(request, AI_HYBRID_RUNTIME_BUNDLES.EXPLAIN_PATTERN)).toEqual({ kind: "UNPLANNABLE", reason: "PAYLOAD_INVALID" });
  });
});
