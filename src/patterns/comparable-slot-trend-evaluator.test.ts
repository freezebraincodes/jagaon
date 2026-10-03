import { describe, expect, it } from "vitest";
import {
  patternClaimSchema,
  patternEvidenceSnapshotPayloadSchema,
  patternObservationPayloadSchema,
  validatePatternPair,
} from "@/domain/patterns";
import { evaluateComparableSlotTrend } from "./comparable-slot-trend-evaluator";
import type { PreviousPatternChain, ResolvedGlucoseReading } from "./pattern-evaluator-contracts";

const T = "2026-10-03T16:00:00.000Z"; // local midnight, 4 Oct 2026, Asia/Singapore
const DAY = 86_400_000;

function uuid(n: number, part: number): string {
  return `${n.toString(16).padStart(8, "0")}-0000-4000-8000-${(part * 10000 + n).toString(16).padStart(12, "0")}`;
}

type ReadingOptions = Partial<{
  slot: string;
  method: string;
  unit: "MMOL_L" | "MG_DL";
  normalised: string | null;
  approximate: boolean;
  provenance: string;
  minute: number;
  revision: number;
}>;

/** A before-breakfast reading `daysBefore` local days before T at 07:30 SGT. */
function reading(n: number, daysBefore: number, value: string, options: ReadingOptions = {}): ResolvedGlucoseReading {
  const instant = new Date(Date.parse(T) - daysBefore * DAY + (7 * 60 + 30 + (options.minute ?? 0)) * 60_000).toISOString();
  const unit = options.unit ?? "MMOL_L";
  const point = options.approximate
    ? { kind: "APPROXIMATE", approximateInstantUtc: instant, uncertaintyMinutes: 60, timeZoneId: "Asia/Singapore", utcOffsetMinutes: 480 }
    : { kind: "EXACT", instantUtc: instant, timeZoneId: "Asia/Singapore", utcOffsetMinutes: 480 };
  return {
    ref: { recordType: "GLUCOSE_READING", recordId: uuid(n, 1), revisionId: uuid(n, options.revision ?? 2) },
    revisionNumber: options.revision ? 2 : 1,
    action: options.revision ? "CORRECT" : "CREATE",
    provenance: {
      sourceKind: (options.provenance ?? "PATIENT_ENTRY") as never,
      captureMethod: options.provenance === "SYSTEM_DERIVATION" ? "RULE_ENGINE" : "FORM",
      initiator: options.provenance === "SYSTEM_DERIVATION" ? "JAGAON_SYSTEM" : "PATIENT",
      assistance: "NONE",
    },
    temporal: { kind: "POINT", occurrence: point },
    payload: {
      measurement: {
        enteredValue: value,
        enteredUnit: unit,
        normalization:
          options.normalised === undefined || options.normalised === null
            ? null
            : { canonicalValue: options.normalised, canonicalUnit: "MMOL_L", normalizerVersion: "glucose-normaliser.v1" },
      },
      measurementMethod: (options.method ?? "FINGERSTICK_METER") as never,
      context: { kind: "PATIENT_SELECTED_SLOT", slot: (options.slot ?? "BEFORE_BREAKFAST") as never },
    },
  } as unknown as ResolvedGlucoseReading;
}

const REFERENCE_DAYS = [16, 18, 20, 23, 25, 27, 30, 33];
const RECENT_DAYS = [2, 4, 6, 9, 11, 13];

function series(referenceValues: string[], recentValues: string[], start = 1): ResolvedGlucoseReading[] {
  return [
    ...referenceValues.map((value, i) => reading(start + i, REFERENCE_DAYS[i]!, value)),
    ...recentValues.map((value, i) => reading(start + 100 + i, RECENT_DAYS[i]!, value)),
  ];
}

const STABLE_REFERENCE = ["5.8", "6.0", "6.1", "5.9", "6.2", "6.0", "5.7", "6.3"];
const HIGHER_RECENT = ["7.2", "7.4", "7.1", "7.6", "7.3", "7.5"];

function evaluate(readings: ResolvedGlucoseReading[], extra: Partial<Parameters<typeof evaluateComparableSlotTrend>[0]> = {}) {
  return evaluateComparableSlotTrend({
    evaluatedAt: T,
    inputSequenceCutoff: 40,
    slot: { kind: "PATIENT_SELECTED_SLOT", slot: "BEFORE_BREAKFAST" },
    readings,
    superseded: [],
    previous: null,
    ...extra,
  } as never);
}

function proposal(evaluation: ReturnType<typeof evaluate>) {
  if (evaluation.result.kind !== "PROPOSAL") throw new Error(`expected PROPOSAL, got ${evaluation.result.kind}`);
  return evaluation.result;
}

/** Persist a proposal as the previous chain for a successive evaluation. */
function asPrevious(evaluation: ReturnType<typeof evaluate>): PreviousPatternChain {
  const result = proposal(evaluation);
  if (result.snapshot.kind !== "NEW") throw new Error("expected new snapshot");
  const snapshot = {
    recordType: "PATTERN_EVIDENCE_SNAPSHOT",
    recordId: uuid(900, 1),
    revisionId: uuid(900, 2),
    revisionNumber: 1,
    payload: result.snapshot.payload,
  };
  const observation = {
    recordType: "PATTERN_OBSERVATION",
    recordId: uuid(901, 1),
    revisionId: uuid(901, 2),
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

function expectValidRecords(evaluation: ReturnType<typeof evaluate>) {
  const result = proposal(evaluation);
  if (result.snapshot.kind !== "NEW") return;
  expect(patternClaimSchema.safeParse(result.claim).success).toBe(true);
  const parsedSnapshot = patternEvidenceSnapshotPayloadSchema.safeParse(result.snapshot.payload);
  expect(parsedSnapshot.success, JSON.stringify(parsedSnapshot.error?.issues?.slice(0, 3))).toBe(true);
  const previous = asPrevious(evaluation);
  expect(patternObservationPayloadSchema.safeParse(previous.observation.payload).success).toBe(true);
  expect(validatePatternPair(previous.observation.payload, previous.snapshot)).toEqual({ ok: true });
}

describe("comparable-slot trend evaluator", () => {
  it("supports sustained numerically higher readings in one slot", () => {
    const evaluation = evaluate(series(STABLE_REFERENCE, HIGHER_RECENT));
    const result = proposal(evaluation);
    expect(result.claim).toEqual({
      family: "COMPARABLE_SLOT_TREND",
      slot: { kind: "PATIENT_SELECTED_SLOT", slot: "BEFORE_BREAKFAST" },
      observedChange: { typicalValue: "HIGHER", variability: "NO_MATERIAL_CHANGE" },
    });
    expect(result.lifecycle).toEqual({ state: "SUPPORTED" });
    expect(result.reasonCode).toBe("PATTERN_OBSERVATION_CREATED");
    if (result.snapshot.kind !== "NEW") throw new Error("snapshot");
    const facts = result.snapshot.payload.facts;
    if (facts.family !== "COMPARABLE_SLOT_TREND") throw new Error("facts");
    expect(facts.reference.summary.median).toBe("6");
    expect(facts.recent.summary.median).toBe("7.35");
    expect(facts.difference.medianDifferenceMmolL).toBe("1.35");
    expect(facts.difference.overlapRatio).toBe("0");
    expect(facts.reference.window).toEqual({ start: "2026-08-22T16:00:00.000Z", end: "2026-09-19T16:00:00.000Z" });
    expect(facts.recent.window).toEqual({ start: "2026-09-19T16:00:00.000Z", end: T });
    expect(result.snapshot.payload.gate.overall).toBe("SUPPORTED");
    expect(result.snapshot.payload.limitations).toContain("UNKNOWN_NEGATIVE_STATUS");
    expectValidRecords(evaluation);
  });

  it("supports sustained numerically lower readings", () => {
    const evaluation = evaluate(series(HIGHER_RECENT.concat(["7.0", "7.2"]), STABLE_REFERENCE.slice(0, 6)));
    expect(proposal(evaluation).claim).toMatchObject({ observedChange: { typicalValue: "LOWER" } });
    expectValidRecords(evaluation);
  });

  it("keeps a variability-only change watching until a successive evaluation with new readings", () => {
    const tight = ["6.4", "6.5", "6.6", "6.5", "6.4", "6.6", "6.5", "6.5"];
    const wide = ["5.0", "8.0", "5.5", "7.5", "6.0", "7.0"];
    const first = evaluate(series(tight, wide));
    expect(proposal(first).claim).toMatchObject({
      observedChange: { typicalValue: "NO_MATERIAL_DIRECTION", variability: "MORE_VARIABLE" },
    });
    expect(proposal(first).lifecycle).toEqual({ state: "WATCHING" });
    expectValidRecords(first);

    const same = evaluate(series(tight, wide), { previous: asPrevious(first) });
    expect(same.result.kind).toBe("NO_CHANGE");

    const withNewReading = [...series(tight, wide), reading(300, 1, "5.2")];
    const second = evaluate(withNewReading, { previous: asPrevious(first) });
    expect(proposal(second).lifecycle).toEqual({ state: "SUPPORTED" });
    expect(proposal(second).reasonCode).toBe("PATTERN_OBSERVATION_REVISED");
  });

  it("reports no material difference without creating a claim", () => {
    const evaluation = evaluate(series(STABLE_REFERENCE, ["6.3", "6.5", "6.2", "6.4", "6.6", "6.1"]));
    expect(evaluation.result).toMatchObject({ kind: "NO_MATERIAL_DIFFERENCE", coverage: "SUPPORTED" });
  });

  it("resists one extreme outlier", () => {
    const evaluation = evaluate(series(STABLE_REFERENCE, ["6.1", "6.0", "14.0", "6.2", "5.9", "6.1"]));
    expect(evaluation.result.kind).toBe("NO_MATERIAL_DIFFERENCE");
  });

  it("returns typed insufficient evidence for sparse logging and never fills missing readings", () => {
    const evaluation = evaluate(series(STABLE_REFERENCE.slice(0, 3), HIGHER_RECENT));
    expect(evaluation.result).toMatchObject({
      kind: "INSUFFICIENT_EVIDENCE",
      counts: { reference: 3, recent: 6, referenceDates: 3, recentDates: 6 },
    });
  });

  it("produces identical fingerprints regardless of input order", () => {
    const readings = series(STABLE_REFERENCE, HIGHER_RECENT);
    const a = evaluate(readings);
    const b = evaluate([...readings].reverse());
    expect(b.inputFingerprint).toBe(a.inputFingerprint);
    expect(b.resultFingerprint).toBe(a.resultFingerprint);
    expect(b.result).toEqual(a.result);
  });

  it("changes the input fingerprint with the cutoff, time or evidence", () => {
    const readings = series(STABLE_REFERENCE, HIGHER_RECENT);
    const base = evaluate(readings);
    expect(evaluate(readings, { inputSequenceCutoff: 41 }).inputFingerprint).not.toBe(base.inputFingerprint);
    expect(evaluate(readings.slice(1)).inputFingerprint).not.toBe(base.inputFingerprint);
  });

  it("ignores other slots and excludes incompatible method, unit, time and provenance", () => {
    const readings = [
      ...series(STABLE_REFERENCE, HIGHER_RECENT),
      reading(400, 3, "12.0", { slot: "BEFORE_DINNER" }),
      reading(401, 5, "12.0", { method: "OTHER" }),
      reading(402, 7, "216", { unit: "MG_DL" }),
      reading(403, 8, "12.0", { approximate: true }),
      reading(404, 10, "12.0", { provenance: "SYSTEM_DERIVATION" }),
    ];
    const result = proposal(evaluate(readings));
    if (result.snapshot.kind !== "NEW") throw new Error("snapshot");
    const reasons = Object.fromEntries(
      result.snapshot.payload.consideredButExcluded.map((entry) => [entry.revision.recordId, entry.reason]),
    );
    expect(reasons).toEqual({
      [uuid(401, 1)]: "FAMILY_POLICY_EXCLUSION",
      [uuid(402, 1)]: "FAMILY_POLICY_EXCLUSION",
      [uuid(403, 1)]: "INSUFFICIENT_TEMPORAL_PRECISION",
      [uuid(404, 1)]: "INELIGIBLE_PROVENANCE",
    });
    expect(result.claim).toMatchObject({ observedChange: { typicalValue: "HIGHER" } });
  });

  it("uses an approved normalisation for mg/dL readings without rewriting the source", () => {
    const readings = [...series(STABLE_REFERENCE, HIGHER_RECENT.slice(0, 5)), reading(500, 1, "135", { unit: "MG_DL", normalised: "7.5" })];
    const result = proposal(evaluate(readings));
    if (result.snapshot.kind !== "NEW" || result.snapshot.payload.facts.family !== "COMPARABLE_SLOT_TREND") throw new Error("facts");
    expect(result.snapshot.payload.facts.recent.assignments).toHaveLength(6);
  });

  it("fails comparison when measurement methods are mixed without harmonisation", () => {
    const readings = series(STABLE_REFERENCE, HIGHER_RECENT);
    readings[0] = reading(1, REFERENCE_DAYS[0]!, "5.8", { method: "CGM" });
    expect(evaluate(readings).result).toMatchObject({ kind: "INSUFFICIENT_EVIDENCE", reasonCodes: ["MIXED_MEASUREMENT_METHODS"] });
  });

  it("uses the corrected representation once and keeps the earlier revision as corrected away", () => {
    const readings = series(STABLE_REFERENCE, HIGHER_RECENT);
    readings[8] = reading(101, RECENT_DAYS[0]!, "7.2", { revision: 3 });
    const superseded = [{ ref: { recordType: "GLUCOSE_READING", recordId: uuid(101, 1), revisionId: uuid(101, 2) } }];
    const result = proposal(evaluate(readings, { superseded } as never));
    if (result.snapshot.kind !== "NEW" || result.snapshot.payload.facts.family !== "COMPARABLE_SLOT_TREND") throw new Error("facts");
    expect(result.snapshot.payload.consideredButExcluded).toEqual([
      { revision: superseded[0]!.ref, reason: "CORRECTED_AWAY" },
    ]);
    const recentRevisions = result.snapshot.payload.facts.recent.assignments.map((a) => a.reading.revisionId);
    expect(recentRevisions).toContain(uuid(101, 3));
    expect(recentRevisions).not.toContain(uuid(101, 2));
  });

  it("counts duplicate readings of one occasion once", () => {
    const readings = [...series(STABLE_REFERENCE, HIGHER_RECENT), { ...reading(600, RECENT_DAYS[0]!, "7.2"), ref: { recordType: "GLUCOSE_READING", recordId: uuid(600, 1), revisionId: uuid(600, 2) } } as ResolvedGlucoseReading];
    const result = proposal(evaluate(readings));
    if (result.snapshot.kind !== "NEW") throw new Error("snapshot");
    expect(result.snapshot.payload.consideredButExcluded.map((e) => e.reason)).toContain("DUPLICATE_LOGICAL_OCCASION");
  });

  it("recomputes after a deletion and weakens a previously supported chain without editing it", () => {
    const supported = evaluate(series(STABLE_REFERENCE, HIGHER_RECENT));
    const previous = asPrevious(supported);
    const afterDeletion = evaluate(series(STABLE_REFERENCE, HIGHER_RECENT).slice(0, 10), { previous });
    expect(proposal(afterDeletion)).toMatchObject({
      lifecycle: { state: "WEAKENING", previouslySupported: { recordId: uuid(901, 1), revisionId: uuid(901, 2) } },
      snapshot: { kind: "REUSE" },
      reasonCode: "PATTERN_OBSERVATION_TRANSITIONED",
    });
    expect(previous.observation.payload.lifecycle).toEqual({ state: "SUPPORTED" });
  });

  it("returns NO_CHANGE for the same evidence evaluated later", () => {
    const readings = series(STABLE_REFERENCE, HIGHER_RECENT);
    const previous = asPrevious(evaluate(readings));
    expect(evaluate(readings, { previous }).result.kind).toBe("NO_CHANGE");
  });

  it("returns a typed unsupported result for event-relative and prescribed slots", () => {
    const evaluation = evaluate(series(STABLE_REFERENCE, HIGHER_RECENT), {
      slot: {
        kind: "EVENT_RELATIVE_INTAKE",
        relation: "AFTER",
        intake: { kind: "MEAL_SLOT", intakeSlot: { kind: "STANDARD_MEAL", code: "BREAKFAST" } },
        offsetWindow: { minimumMinutesInclusive: 90, maximumMinutesExclusive: 150 },
      },
    } as never);
    expect(evaluation.result).toMatchObject({ kind: "INSUFFICIENT_EVIDENCE", reasonCodes: ["UNSUPPORTED_SLOT_VARIANT"] });
  });
});
