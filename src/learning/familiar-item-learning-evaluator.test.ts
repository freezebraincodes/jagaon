import { describe, expect, it } from "vitest";
import { learnedKnowledgePayloadSchema } from "@/domain/learning";
import { familiarItemKeyFor } from "@/application/intelligence/familiar-identity";
import type { ResolvedIntakeEvent } from "@/patterns/pattern-evaluator-contracts";
import { evaluateFamiliarItemLearning } from "./familiar-item-learning-evaluator";

const T = "2026-10-03T16:00:00.000Z";
const DAY = 86_400_000;
const uuid = (n: number, part: number) =>
  `${n.toString(16).padStart(8, "0")}-0000-4000-8000-${(part * 10000 + n).toString(16).padStart(12, "0")}`;

function intake(n: number, daysBefore: number, label = "Kaya toast"): ResolvedIntakeEvent {
  const instant = new Date(Date.parse(T) - daysBefore * DAY + 8 * 3_600_000).toISOString();
  return {
    ref: { recordType: "INTAKE_EVENT", recordId: uuid(n, 1), revisionId: uuid(n, 2) },
    revisionNumber: 1,
    action: "CREATE",
    provenance: { sourceKind: "PATIENT_ENTRY", captureMethod: "FORM", initiator: "PATIENT", assistance: "NONE" },
    temporal: { kind: "POINT", occurrence: { kind: "EXACT", instantUtc: instant, timeZoneId: "Asia/Singapore", utcOffsetMinutes: 480 } },
    payload: { intakeKind: "MEAL", occasion: "ROUTINE", foodIncluded: "YES", drinkIncluded: "UNKNOWN", items: [{ kind: "FOOD", label }] },
  } as unknown as ResolvedIntakeEvent;
}

const KEY = familiarItemKeyFor({ kind: "INTAKE_ITEM", label: "Kaya toast", itemKind: "FOOD" });

function evaluate(intakes: ResolvedIntakeEvent[], previous: unknown = null) {
  return evaluateFamiliarItemLearning({
    evaluatedAt: T,
    inputSequenceCutoff: 5,
    familiarItemKey: KEY,
    intakeEvents: intakes,
    activityEvents: [],
    superseded: [],
    previous,
  } as never);
}

function proposal(result: ReturnType<typeof evaluate>) {
  if (result.result.kind !== "PROPOSAL") throw new Error(`expected PROPOSAL, got ${result.result.kind}`);
  return result.result;
}

function asPrevious(result: ReturnType<typeof evaluate>) {
  const p = proposal(result);
  return {
    recordType: "LEARNED_KNOWLEDGE",
    recordId: uuid(800, 1),
    revisionId: uuid(800, 2),
    revisionNumber: 1,
    payload: { content: p.content, relationship: { kind: "PRIMARY" }, lifecycle: p.lifecycle, evidence: p.evidence },
  };
}

describe("familiar-item Learning evaluator (minimum Packet 7A behaviour)", () => {
  it("keeps one occasion or two on one day as unpersisted insufficient state", () => {
    expect(evaluate([intake(1, 1)]).result.kind).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("applies the governed EMERGING, CANDIDATE and ACTIVE thresholds", () => {
    expect(proposal(evaluate([intake(1, 1), intake(2, 20)])).lifecycle).toEqual({ state: "EMERGING" });
    expect(proposal(evaluate([intake(1, 1), intake(2, 3), intake(3, 5)])).lifecycle).toEqual({ state: "CANDIDATE" });
    const active = proposal(evaluate([intake(1, 1), intake(2, 2), intake(3, 4), intake(4, 5)]));
    expect(active.lifecycle).toEqual({
      state: "ACTIVE",
      activation: { kind: "LOW_CONSEQUENCE_POLICY", policyVersion: "familiar-item-activation.v1" },
    });
    expect(active.evidence).toMatchObject({
      kind: "OBSERVATION_SET",
      distinctOccasionCount: 4,
      assessmentPolicyVersion: "familiar-item-learning-policy.v1",
      evaluationRuleVersion: "familiar-item-learning-rule.v1",
    });
    const payload = { content: active.content, relationship: { kind: "PRIMARY" }, lifecycle: active.lifecycle, evidence: active.evidence };
    expect(learnedKnowledgePayloadSchema.safeParse(payload).success).toBe(true);
    expect(active.content).toEqual({
      kind: "FAMILIAR_ITEM",
      item: {
        kind: "INTAKE_ITEM",
        familiarItemKey: KEY,
        label: { text: "Kaya toast", language: "und" },
        itemKind: "FOOD",
        intakeContext: { kind: "ANY_RECORDED_INTAKE" },
      },
      scope: { kind: "ORDINARY" },
    });
  });

  it("returns NO_CHANGE for unchanged evidence and weakens active knowledge when support thins", () => {
    const active = evaluate([intake(1, 1), intake(2, 2), intake(3, 4), intake(4, 5)]);
    const previous = asPrevious(active);
    expect(evaluate([intake(1, 1), intake(2, 2), intake(3, 4), intake(4, 5)], previous).result.kind).toBe("NO_CHANGE");
    const thinner = proposal(evaluate([intake(1, 1), intake(2, 40)], previous));
    expect(thinner.lifecycle).toEqual({
      state: "WEAKENING",
      previousActivation: { kind: "LOW_CONSEQUENCE_POLICY", policyVersion: "familiar-item-activation.v1" },
    });
    expect(thinner.reasonCode).toBe("LEARNED_KNOWLEDGE_TRANSITIONED");
  });

  it("becomes stale after 60 days without eligible support while retaining its evidence", () => {
    const previous = asPrevious(evaluate([intake(1, 1), intake(2, 2), intake(3, 4), intake(4, 5)]));
    const stale = proposal(evaluate([], previous));
    expect(stale.lifecycle).toEqual({ state: "STALE" });
    expect(stale.evidence).toEqual(previous.payload.evidence);
  });

  it("is independent of input order", () => {
    const events = [intake(1, 1), intake(2, 2), intake(3, 4), intake(4, 5)];
    expect(evaluate([...events].reverse()).resultFingerprint).toBe(evaluate(events).resultFingerprint);
  });
});
