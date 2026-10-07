import { describe, expect, it } from "vitest";
import { PACKET_11_FIXTURES } from "@/ai/evaluation/packet-11-fixtures";
import { asHybridRequest, plannedFixture, shellCandidate } from "@/ai/evaluation/packet-11-hybrid-test-support";
import type { ShellFieldPath } from "@/domain/ai";
import { AI_HYBRID_RUNTIME_BUNDLES } from "../ai-hybrid-runtime-bundles";
import { assembleComposition, verifyComposition } from "./assembler";
import { defaultShells } from "./default-shells";
import { atomMultiset, composeDeterministic } from "./deterministic-composition";
import { validateShellCandidate } from "./shell-validator";
import { planSlots } from "./slot-planner";

const plannable = PACKET_11_FIXTURES.flatMap((fixture) => {
  const request = asHybridRequest(fixture.request);
  const planned = planSlots(request, AI_HYBRID_RUNTIME_BUNDLES[fixture.taskType]);
  return planned.kind === "PLANNED" ? [{ fixture, request, ...planned }] : [];
});

describe("deterministic composition ai-shells-default.11b.6", () => {
  it("covers every fixture that expects SUCCESS", () => {
    const planned = new Set(plannable.map((entry) => entry.fixture.id));
    for (const fixture of PACKET_11_FIXTURES.filter((entry) => entry.expectedOutcome === "SUCCESS")) expect(planned.has(fixture.id), fixture.id).toBe(true);
  });
  it("default shells pass every shell gate (S1–S7) for every plannable fixture", () => {
    for (const { fixture, plan } of plannable) expect(validateShellCandidate(plan, AI_HYBRID_RUNTIME_BUNDLES[fixture.taskType], shellCandidate(plan, defaultShells(plan))).kind, fixture.id).toBe("VALID");
  });
  it("deterministic compositions pass the unchanged validator (S10) and contain every atom exactly once", () => {
    for (const { fixture, request, plan, atoms } of plannable) {
      const composition = composeDeterministic(request, plan, atoms, AI_HYBRID_RUNTIME_BUNDLES[fixture.taskType]);
      expect(verifyComposition(request, AI_HYBRID_RUNTIME_BUNDLES[fixture.taskType], composition).kind, fixture.id).toBe("ACCEPTED");
      expect(atomMultiset(composition), fixture.id).toEqual(plan.slots.map((slot) => `${slot.slotId}=${atoms[slot.slotId]!.text}`).sort());
    }
  });
  it("pins the ordinary deterministic wording in both locales", () => {
    const en = plannedFixture("p11.explain-pattern.en-sg.ordinary");
    const enText = composeDeterministic(en.request, en.plan, en.atoms, AI_HYBRID_RUNTIME_BUNDLES.EXPLAIN_PATTERN).output as any;
    expect([enText.payload.headline.text, enText.payload.observation.text, enText.payload.evidence.text]).toEqual([
      "This looks at your readings from the same time slot in an earlier and a recent period.", "Recorded values: 6.2 mmol/L and 7.1 mmol/L.", "This is based on 10 recorded readings.",
    ]);
    const zh = plannedFixture("p11.explain-pattern.zh-sg.ordinary");
    const zhText = composeDeterministic(zh.request, zh.plan, zh.atoms, AI_HYBRID_RUNTIME_BUNDLES.EXPLAIN_PATTERN).output as any;
    expect([zhText.payload.headline.text, zhText.payload.observation.text, zhText.payload.evidence.text]).toEqual([
      "这里看的是同一时段在较早期间和近期的读数。", "记录的数值：6.2 mmol/L 和 7.1 mmol/L。", "以上内容基于 10 条记录读数。",
    ]);
  });
  it("an AI-style composition and the deterministic composition carry the identical atom multiset", () => {
    for (const id of ["p11.explain-pattern.en-sg.ordinary", "p11.explain-pattern.zh-sg.ordinary"]) {
      const { request, plan, atoms } = plannedFixture(id);
      const shells = new Map<ShellFieldPath, string>(id.includes("en-sg") ? [["headline", "Here is a comparison of {{S1}}."], ["observation", "Side by side, the values are {{S2}}."], ["evidence", "Drawn from {{S3}} in your journal."]] : [["headline", "这里比较的是{{S1}}。"], ["observation", "对照来看，数值是{{S2}}。"], ["evidence", "以上内容基于{{S3}}。"]]);
      const ai = assembleComposition(request, plan, atoms, shells, AI_HYBRID_RUNTIME_BUNDLES.EXPLAIN_PATTERN);
      if (ai.kind !== "ASSEMBLED") throw new Error("expected ASSEMBLED");
      expect(atomMultiset(ai.composition)).toEqual(atomMultiset(composeDeterministic(request, plan, atoms, AI_HYBRID_RUNTIME_BUNDLES.EXPLAIN_PATTERN)));
    }
  });
});
