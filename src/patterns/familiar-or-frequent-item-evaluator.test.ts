import { describe, expect, it } from "vitest";
import { patternEvidenceSnapshotPayloadSchema, validatePatternPair } from "@/domain/patterns";
import { familiarItemKeyFor } from "@/application/intelligence/familiar-identity";
import {
  discoverFamiliarCandidates,
  evaluateFamiliarOrFrequentItem,
} from "./familiar-or-frequent-item-evaluator";
import type { PreviousPatternChain, ResolvedActivityEvent, ResolvedIntakeEvent } from "./pattern-evaluator-contracts";

const T = "2026-10-03T16:00:00.000Z";
const DAY = 86_400_000;

function uuid(n: number, part: number): string {
  return `${n.toString(16).padStart(8, "0")}-0000-4000-8000-${(part * 10000 + n).toString(16).padStart(12, "0")}`;
}

function point(daysBefore: number, minute = 0) {
  const instant = new Date(Date.parse(T) - daysBefore * DAY + (8 * 60 + minute) * 60_000).toISOString();
  return { kind: "POINT", occurrence: { kind: "EXACT", instantUtc: instant, timeZoneId: "Asia/Singapore", utcOffsetMinutes: 480 } };
}

const PATIENT = { sourceKind: "PATIENT_ENTRY", captureMethod: "FORM", initiator: "PATIENT", assistance: "NONE" };

function intake(n: number, daysBefore: number, labels: Array<string | [string, string]>, options: { minute?: number; revision?: number } = {}): ResolvedIntakeEvent {
  return {
    ref: { recordType: "INTAKE_EVENT", recordId: uuid(n, 1), revisionId: uuid(n, options.revision ?? 2) },
    revisionNumber: options.revision ? 2 : 1,
    action: options.revision ? "CORRECT" : "CREATE",
    provenance: PATIENT,
    temporal: point(daysBefore, options.minute),
    payload: {
      intakeKind: "MEAL",
      intakeSlot: { kind: "STANDARD_MEAL", code: "BREAKFAST" },
      occasion: "ROUTINE",
      foodIncluded: "YES",
      drinkIncluded: "UNKNOWN",
      items: labels.map((label) => (Array.isArray(label) ? { kind: label[0], label: label[1] } : { kind: "FOOD", label })),
    },
  } as unknown as ResolvedIntakeEvent;
}

function activity(n: number, daysBefore: number, patientLabel: string, activityCategory = "WALKING"): ResolvedActivityEvent {
  return {
    ref: { recordType: "ACTIVITY_EVENT", recordId: uuid(n, 1), revisionId: uuid(n, 2) },
    revisionNumber: 1,
    action: "CREATE",
    provenance: PATIENT,
    temporal: point(daysBefore),
    payload: { activityCategory, patientLabel },
  } as unknown as ResolvedActivityEvent;
}

const KAYA = familiarItemKeyFor({ kind: "INTAKE_ITEM", label: "Kaya toast", itemKind: "FOOD" });

function evaluate(key: string, intakes: ResolvedIntakeEvent[], activities: ResolvedActivityEvent[] = [], extra: Record<string, unknown> = {}) {
  return evaluateFamiliarOrFrequentItem({
    evaluatedAt: T,
    inputSequenceCutoff: 9,
    familiarItemKey: key,
    intakeEvents: intakes,
    activityEvents: activities,
    superseded: [],
    previous: null,
    ...extra,
  } as never);
}

function proposal(evaluation: ReturnType<typeof evaluate>) {
  if (evaluation.result.kind !== "PROPOSAL") throw new Error(`expected PROPOSAL, got ${evaluation.result.kind}`);
  return evaluation.result;
}

function asPrevious(evaluation: ReturnType<typeof evaluate>): PreviousPatternChain {
  const result = proposal(evaluation);
  if (result.snapshot.kind !== "NEW") throw new Error("snapshot");
  const snapshot = { recordType: "PATTERN_EVIDENCE_SNAPSHOT", recordId: uuid(700, 1), revisionId: uuid(700, 2), revisionNumber: 1, payload: result.snapshot.payload };
  const observation = {
    recordType: "PATTERN_OBSERVATION",
    recordId: uuid(701, 1),
    revisionId: uuid(701, 2),
    revisionNumber: 1,
    payload: {
      family: result.family,
      claim: result.claim,
      lifecycle: result.lifecycle,
      evidenceSnapshot: { recordType: "PATTERN_EVIDENCE_SNAPSHOT", recordId: snapshot.recordId, revisionId: snapshot.revisionId },
      patientDisposition: { kind: "NONE" },
    },
  };
  return { observation, snapshot } as unknown as PreviousPatternChain;
}

const KAYA_WEEK = [intake(1, 1, ["Kaya toast"]), intake(2, 2, ["Kaya toast", ["DRINK", "Kopi"]]), intake(3, 4, ["kaya toast "]), intake(4, 5, ["Kaya toast"])];

describe("familiar or frequently recorded item evaluator", () => {
  it("supports one stable identity across distinct recent occasions and keeps the authored label", () => {
    const evaluation = evaluate(KAYA, KAYA_WEEK);
    const result = proposal(evaluation);
    expect(result.claim).toEqual({
      family: "FAMILIAR_OR_FREQUENT_ITEM",
      item: {
        kind: "INTAKE_ITEM",
        familiarItemKey: KAYA,
        label: { text: "Kaya toast", language: "und" },
        itemKind: "FOOD",
        intakeContext: { kind: "ANY_RECORDED_INTAKE" },
      },
      scope: { kind: "ORDINARY" },
      claim: { kind: "RECURRING_IN_RECORDED_OCCASIONS" },
    });
    expect(result.lifecycle).toEqual({ state: "SUPPORTED" });
    if (result.snapshot.kind !== "NEW") throw new Error("snapshot");
    const parsed = patternEvidenceSnapshotPayloadSchema.safeParse(result.snapshot.payload);
    expect(parsed.success, JSON.stringify(parsed.error?.issues?.slice(0, 3))).toBe(true);
    const facts = result.snapshot.payload.facts;
    if (facts.family !== "FAMILIAR_OR_FREQUENT_ITEM") throw new Error("facts");
    expect(facts.occurrenceMatches).toHaveLength(4);
    const normalised = facts.occurrenceMatches.find((match) => match.source.recordId === uuid(3, 1));
    expect(normalised).toMatchObject({ matchedItems: [{ itemIndex: 0, matchBasis: { kind: "DETERMINISTIC_NORMALISATION" } }] });
    expect(result.snapshot.payload.coverage).toMatchObject({ distinctOccasionCount: 4, distinctDayCount: 4 });
    expect(result.snapshot.payload.limitations).toEqual(["UNKNOWN_NEGATIVE_STATUS"]);
    const previous = asPrevious(evaluation);
    expect(validatePatternPair(previous.observation.payload, previous.snapshot)).toEqual({ ok: true });
  });

  it("counts repeated items inside one event once while recording every position", () => {
    const result = proposal(evaluate(KAYA, [intake(1, 1, ["Kaya toast", "kaya toast"]), ...KAYA_WEEK.slice(1)]));
    if (result.snapshot.kind !== "NEW" || result.snapshot.payload.facts.family !== "FAMILIAR_OR_FREQUENT_ITEM") throw new Error("facts");
    const repeated = result.snapshot.payload.facts.occurrenceMatches.find((match) => match.source.recordId === uuid(1, 1));
    expect(repeated).toMatchObject({
      matchedItems: [
        { itemIndex: 0, matchBasis: { kind: "EXACT_AUTHORED_LABEL" } },
        { itemIndex: 1, matchBasis: { kind: "DETERMINISTIC_NORMALISATION" } },
      ],
    });
    expect(result.snapshot.payload.coverage).toMatchObject({ distinctOccasionCount: 4 });
  });

  it("counts a copied entry for the same occurrence once", () => {
    const result = proposal(evaluate(KAYA, [...KAYA_WEEK, intake(9, 1, ["Kaya toast"])]));
    if (result.snapshot.kind !== "NEW") throw new Error("snapshot");
    expect(result.snapshot.payload.consideredButExcluded).toEqual([
      { revision: { recordType: "INTAKE_EVENT", recordId: uuid(9, 1), revisionId: uuid(9, 2) }, reason: "DUPLICATE_LOGICAL_OCCASION" },
    ]);
    expect(result.snapshot.payload.coverage).toMatchObject({ distinctOccasionCount: 4 });
  });

  it("keeps similar but different labels as separate identities", () => {
    const result = proposal(evaluate(KAYA, [...KAYA_WEEK.slice(0, 3), intake(8, 5, ["Kaya toast with egg"])]));
    expect(result.lifecycle).toEqual({ state: "EMERGING" });
  });

  it("keeps different activities in one category separate", () => {
    const yoga = familiarItemKeyFor({ kind: "ACTIVITY", label: "Chair yoga", activityCategory: "FLEXIBILITY_OR_MOBILITY" });
    const activities = [
      activity(20, 1, "Chair yoga", "FLEXIBILITY_OR_MOBILITY"),
      activity(21, 2, "Tai chi", "FLEXIBILITY_OR_MOBILITY"),
      activity(22, 3, "Chair yoga", "FLEXIBILITY_OR_MOBILITY"),
    ];
    const result = proposal(evaluate(yoga, [], activities));
    expect(result.lifecycle).toEqual({ state: "SIGNAL" });
    expect(result.claim).toMatchObject({ item: { kind: "ACTIVITY", label: { text: "Chair yoga" } } });
  });

  it("applies SIGNAL, EMERGING and insufficient thresholds and never treats missing logs as non-occurrence", () => {
    expect(proposal(evaluate(KAYA, KAYA_WEEK.slice(0, 2))).lifecycle).toEqual({ state: "SIGNAL" });
    expect(proposal(evaluate(KAYA, KAYA_WEEK.slice(0, 3))).lifecycle).toEqual({ state: "EMERGING" });
    expect(evaluate(KAYA, KAYA_WEEK.slice(0, 1)).result).toMatchObject({ kind: "INSUFFICIENT_EVIDENCE", counts: { occurrences: 1 } });
    const spread = [intake(1, 1, ["Kaya toast"]), intake(2, 10, ["Kaya toast"]), intake(3, 20, ["Kaya toast"]), intake(4, 29, ["Kaya toast"])];
    expect(proposal(evaluate(KAYA, spread)).lifecycle).toEqual({ state: "EMERGING" });
  });

  it("requires the latest occurrence within 30 days", () => {
    const old = [intake(1, 35, ["Kaya toast"]), intake(2, 36, ["Kaya toast"]), intake(3, 37, ["Kaya toast"]), intake(4, 38, ["Kaya toast"])];
    expect(evaluate(KAYA, old).result).toMatchObject({ kind: "INSUFFICIENT_EVIDENCE", reasonCodes: ["LATEST_OCCURRENCE_OLDER_THAN_THIRTY_DAYS"] });
  });

  it("weakens a supported chain when recent support lapses and becomes stale after 60 days without support", () => {
    const previous = asPrevious(evaluate(KAYA, KAYA_WEEK));
    const lapsed = evaluate(KAYA, [intake(1, 40, ["Kaya toast"]), intake(2, 41, ["Kaya toast"])], [], { previous });
    expect(proposal(lapsed)).toMatchObject({ lifecycle: { state: "WEAKENING" }, snapshot: { kind: "REUSE" } });
    const gone = evaluate(KAYA, [], [], { previous });
    expect(proposal(gone).lifecycle).toEqual({ state: "STALE" });
  });

  it("uses the corrected representation and records the earlier revision", () => {
    const corrected = [intake(1, 1, ["Kaya toast"], { revision: 3 }), ...KAYA_WEEK.slice(1)];
    const superseded = [{ ref: { recordType: "INTAKE_EVENT", recordId: uuid(1, 1), revisionId: uuid(1, 2) } }];
    const result = proposal(evaluate(KAYA, corrected, [], { superseded }));
    if (result.snapshot.kind !== "NEW") throw new Error("snapshot");
    expect(result.snapshot.payload.consideredButExcluded).toEqual([{ revision: superseded[0]!.ref, reason: "CORRECTED_AWAY" }]);

    const relabelled = [intake(1, 1, ["Roti prata"], { revision: 3 }), ...KAYA_WEEK.slice(1)];
    expect(proposal(evaluate(KAYA, relabelled, [], { superseded })).lifecycle).toEqual({ state: "EMERGING" });
  });

  it("is independent of input order", () => {
    const a = evaluate(KAYA, KAYA_WEEK);
    const b = evaluate(KAYA, [...KAYA_WEEK].reverse());
    expect(b.inputFingerprint).toBe(a.inputFingerprint);
    expect(b.resultFingerprint).toBe(a.resultFingerprint);
  });

  it("returns NO_CHANGE for the same evidence evaluated later", () => {
    const previous = asPrevious(evaluate(KAYA, KAYA_WEEK));
    expect(evaluate(KAYA, KAYA_WEEK, [], { previous, evaluatedAt: "2026-10-03T18:00:00.000Z" }).result.kind).toBe("NO_CHANGE");
  });

  it("discovers candidate identities deterministically and ignores unknown items", () => {
    const candidates = discoverFamiliarCandidates(
      [intake(1, 1, ["Kaya toast", ["UNKNOWN", "something"]]), intake(2, 2, ["kaya toast"])],
      [activity(3, 1, "Morning walk")],
    );
    expect(candidates).toEqual(
      [KAYA, familiarItemKeyFor({ kind: "ACTIVITY", label: "Morning walk", activityCategory: "WALKING" })].sort(),
    );
  });

  it("states only bounded recorded recurrence in the claim", () => {
    const result = proposal(evaluate(KAYA, KAYA_WEEK));
    expect(Object.keys(result.claim).sort()).toEqual(["claim", "family", "item", "scope"]);
    expect(JSON.stringify(result.claim)).not.toMatch(/prefer|favourite|healthy|recommend|daily|benefit/i);
  });
});
