import { describe, expect, it } from "vitest";
import {
  PATTERN_FAMILIES,
  PATTERN_LIFECYCLE_STATES,
  PATTERN_GATE_DIMENSIONS,
  PATTERN_LIMITATION_CODES,
  PATTERN_EVIDENCE_GROUP_ROLES,
  PATTERN_EXCLUSION_REASONS,
  PATTERN_GATE_REGISTRY,
  patternClaimSchema,
  patternFamilyEvidenceFactsSchema,
  patternObservationPayloadSchema,
  patternEvidenceSnapshotPayloadSchema,
  patternObservationRevisionSchema,
  patternEvidenceSnapshotRevisionSchema,
  validatePatternPair,
  aggregatePatternGate,
  PATTERN_OBSERVATION_REVISION_ACTIONS,
  PATTERN_EVIDENCE_SNAPSHOT_REVISION_ACTIONS,
  PATTERN_RECORD_DELETION_POLICY,
} from "./index";
import {
  CLAIMS,
  FACTS,
  OBSERVATION_RECORD,
  comparableSnapshotPayload,
  familiarSnapshotPayload,
  observationPayload,
  testRef,
  testUuid,
} from "./pattern-test-fixtures";

const ok = (schema: { safeParse(v: unknown): { success: boolean } }, value: unknown) =>
  schema.safeParse(value).success;

describe("closed Pattern registries", () => {
  it("lists the seven approved families plus the dormant cross-variable family", () => {
    expect([...PATTERN_FAMILIES]).toEqual([
      "ROUTINE_SHIFT",
      "FAMILIAR_OR_FREQUENT_ITEM",
      "RECURRING_BARRIER",
      "COMPARABLE_SLOT_TREND",
      "PRESCRIBED_TIMING_ALIGNMENT",
      "CONTEXT_BOUNDED_DEVIATION",
      "RETURN_TOWARD_BASELINE",
      "CROSS_VARIABLE_ASSOCIATION",
    ]);
    expect(Object.isFrozen(PATTERN_FAMILIES)).toBe(true);
  });

  it("lists every lifecycle, gate dimension, limitation, role and exclusion exactly", () => {
    expect([...PATTERN_LIFECYCLE_STATES]).toEqual([
      "SIGNAL", "EMERGING", "WATCHING", "SUPPORTED", "WEAKENING", "STALE", "SUPERSEDED", "REJECTED", "RETIRED",
    ]);
    expect([...PATTERN_GATE_DIMENSIONS]).toEqual([
      "SUPPORT", "COVERAGE", "COMPARISON", "MISSINGNESS", "RECENCY", "CONSISTENCY", "CONTRADICTION",
      "CONTEXT", "STABILITY", "MAGNITUDE_OR_USEFULNESS", "PRIOR_PATIENT_DISPOSITION",
    ]);
    expect([...PATTERN_LIMITATION_CODES]).toEqual([
      "SPARSE_RECORDING", "UNKNOWN_NEGATIVE_STATUS", "LIMITED_COMPARISON", "HIGH_VARIABILITY",
      "CONTRADICTORY_EVIDENCE", "CONTEXT_OVERLAP", "CARE_PLAN_BOUNDARY", "INSUFFICIENT_TIME_PRECISION",
      "IDENTITY_UNCERTAINTY", "MEASUREMENT_METHOD_CHANGE", "RECENCY_LIMIT",
    ]);
    expect([...PATTERN_EVIDENCE_GROUP_ROLES]).toEqual([
      "SUPPORTING", "CONTRADICTORY", "NEUTRAL", "BASELINE", "RECENT", "EXPOSED", "COMPARATOR", "OUTCOME",
    ]);
    expect([...PATTERN_EXCLUSION_REASONS]).toEqual([
      "DUPLICATE_LOGICAL_OCCASION", "CORRECTED_AWAY", "INELIGIBLE_PROVENANCE", "INSUFFICIENT_TEMPORAL_PRECISION",
      "OUTSIDE_ANALYSIS_WINDOW", "CONTEXT_OR_CARE_BOUNDARY", "INCOMPATIBLE_SLOT_OR_CATEGORY", "AMBIGUOUS_IDENTITY",
      "UNKNOWN_COMPARISON_STATUS", "FAMILY_POLICY_EXCLUSION",
    ]);
  });

  it("registers reviewed gate versions only for the two enabled families", () => {
    expect(Object.keys(PATTERN_GATE_REGISTRY).sort()).toEqual(["comparable-slot-gate.v1", "familiar-item-gate.v1"]);
    expect(PATTERN_GATE_REGISTRY["comparable-slot-gate.v1"].family).toBe("COMPARABLE_SLOT_TREND");
    expect(PATTERN_GATE_REGISTRY["familiar-item-gate.v1"].family).toBe("FAMILIAR_OR_FREQUENT_ITEM");
  });
});

describe("family claims", () => {
  for (const family of PATTERN_FAMILIES.filter((f) => f !== "CROSS_VARIABLE_ASSOCIATION")) {
    it(`accepts a valid ${family} claim and rejects unknown keys`, () => {
      expect(ok(patternClaimSchema, CLAIMS[family])).toBe(true);
      expect(ok(patternClaimSchema, { ...CLAIMS[family], conclusion: "free text" })).toBe(false);
    });
  }

  it("rejects a cross-variable claim because no reviewed definition exists", () => {
    expect(ok(patternClaimSchema, CLAIMS.CROSS_VARIABLE_ASSOCIATION)).toBe(false);
  });

  it("requires a material comparable-slot change", () => {
    expect(
      ok(patternClaimSchema, {
        ...CLAIMS.COMPARABLE_SLOT_TREND,
        observedChange: { typicalValue: "NO_MATERIAL_DIRECTION", variability: "NO_MATERIAL_CHANGE" },
      }),
    ).toBe(false);
    expect(
      ok(patternClaimSchema, {
        ...CLAIMS.COMPARABLE_SLOT_TREND,
        observedChange: { typicalValue: "NO_MATERIAL_DIRECTION", variability: "MORE_VARIABLE" },
      }),
    ).toBe(true);
  });

  it("rejects incompatible glucose slots and post-meal labels without an event", () => {
    const slot = (value: unknown) => ok(patternClaimSchema, { ...CLAIMS.COMPARABLE_SLOT_TREND, slot: value });
    expect(slot({ kind: "PATIENT_SELECTED_SLOT", slot: "AFTER_BREAKFAST" })).toBe(false);
    expect(slot({ kind: "PATIENT_SELECTED_SLOT", slot: "OTHER" })).toBe(false);
    expect(
      slot({
        kind: "EVENT_RELATIVE_INTAKE",
        relation: "AFTER",
        intake: { kind: "MEAL_SLOT", intakeSlot: { kind: "STANDARD_MEAL", code: "BREAKFAST" } },
        offsetWindow: { minimumMinutesInclusive: 90, maximumMinutesExclusive: 150 },
      }),
    ).toBe(true);
    expect(
      slot({
        kind: "EVENT_RELATIVE_INTAKE",
        relation: "AFTER",
        intake: { kind: "MEAL_SLOT", intakeSlot: { kind: "STANDARD_MEAL", code: "BREAKFAST" } },
        offsetWindow: { minimumMinutesInclusive: -30, maximumMinutesExclusive: 0 },
      }),
    ).toBe(false);
  });

  it("keeps routine-shift subjects non-glucose and changes aligned with the dimension", () => {
    expect(
      ok(patternClaimSchema, { ...CLAIMS.ROUTINE_SHIFT, subject: { kind: "GLUCOSE_VALUE", slot: CLAIMS.COMPARABLE_SLOT_TREND.slot } }),
    ).toBe(false);
    expect(
      ok(patternClaimSchema, {
        ...CLAIMS.ROUTINE_SHIFT,
        observedChange: { kind: "DAYS_OF_WEEK", difference: "ADDED_RECORDED_DAYS" },
      }),
    ).toBe(false);
  });

  it("limits the recorded-share claim to intake items", () => {
    expect(
      ok(patternClaimSchema, { ...CLAIMS.FAMILIAR_OR_FREQUENT_ITEM, claim: { kind: "RECORDED_SHARE_WITHIN_INTAKE_CONTEXT" } }),
    ).toBe(true);
    expect(
      ok(patternClaimSchema, {
        ...CLAIMS.FAMILIAR_OR_FREQUENT_ITEM,
        item: {
          kind: "ACTIVITY",
          familiarItemKey: "fik-walk",
          label: { text: "Morning walk", language: "und" },
          activityCategory: "WALKING",
        },
        claim: { kind: "RECORDED_SHARE_WITHIN_INTAKE_CONTEXT" },
      }),
    ).toBe(false);
  });
});

describe("family evidence facts", () => {
  for (const family of PATTERN_FAMILIES.filter((f) => f !== "CROSS_VARIABLE_ASSOCIATION")) {
    it(`accepts valid ${family} facts and rejects an unrestricted metrics map`, () => {
      expect(ok(patternFamilyEvidenceFactsSchema, FACTS[family])).toBe(true);
      expect(ok(patternFamilyEvidenceFactsSchema, { ...FACTS[family], metrics: { confidence: 0.9 } })).toBe(false);
    });
  }

  it("rejects cross-variable facts without a reviewed definition", () => {
    expect(ok(patternFamilyEvidenceFactsSchema, FACTS.CROSS_VARIABLE_ASSOCIATION)).toBe(false);
  });

  it("rejects overlapping or inverted comparable windows and duplicate readings", () => {
    const facts = FACTS.COMPARABLE_SLOT_TREND;
    expect(
      ok(patternFamilyEvidenceFactsSchema, {
        ...facts,
        recent: { ...facts.recent, window: { start: "2026-09-18T16:00:00.000Z", end: "2026-10-03T16:00:00.000Z" } },
      }),
    ).toBe(false);
    expect(
      ok(patternFamilyEvidenceFactsSchema, {
        ...facts,
        recent: { ...facts.recent, assignments: [...facts.recent.assignments, facts.reference.assignments[0]] },
      }),
    ).toBe(false);
  });

  it("requires the summary count to equal unique assigned readings", () => {
    const facts = FACTS.COMPARABLE_SLOT_TREND;
    expect(
      ok(patternFamilyEvidenceFactsSchema, {
        ...facts,
        recent: { ...facts.recent, summary: { ...facts.recent.summary, distinctOccasionCount: 7 } },
      }),
    ).toBe(false);
  });

  it("rejects mixed methods under SAME_METHOD and different dispersion metrics", () => {
    const facts = FACTS.COMPARABLE_SLOT_TREND;
    const assignments = facts.recent.assignments.map((a, i) => (i === 0 ? { ...a, measurementMethod: "CGM" } : a));
    expect(ok(patternFamilyEvidenceFactsSchema, { ...facts, recent: { ...facts.recent, assignments } })).toBe(false);
    expect(
      ok(patternFamilyEvidenceFactsSchema, {
        ...facts,
        recent: { ...facts.recent, summary: { ...facts.recent.summary, dispersion: { metric: "MAD", valueMmolL: "0.7" } } },
      }),
    ).toBe(false);
  });

  it("validates the recorded-share denominator exactly", () => {
    const share = (eligible: number, matched: number, recordedShare: string) => ({
      family: "FAMILIAR_OR_FREQUENT_ITEM",
      claimKind: "RECORDED_SHARE_WITHIN_INTAKE_CONTEXT",
      familiarItemKey: "fik-kaya-toast",
      occurrenceMatches: FACTS.FAMILIAR_OR_FREQUENT_ITEM.occurrenceMatches.slice(0, matched),
      eligibleLoggedIntakeCount: eligible,
      matchedLoggedIntakeCount: matched,
      recordedShare,
    });
    expect(ok(patternFamilyEvidenceFactsSchema, share(6, 4, "0.666667"))).toBe(true);
    expect(ok(patternFamilyEvidenceFactsSchema, share(6, 4, "0.67"))).toBe(false);
    expect(ok(patternFamilyEvidenceFactsSchema, share(3, 4, "1"))).toBe(false);
  });

  it("rejects duplicate and out-of-order intake item indexes", () => {
    const facts = FACTS.FAMILIAR_OR_FREQUENT_ITEM;
    const bad = (matchedItems: unknown) =>
      ok(patternFamilyEvidenceFactsSchema, {
        ...facts,
        occurrenceMatches: [{ ...facts.occurrenceMatches[0], matchedItems }],
      });
    const exact = { kind: "EXACT_AUTHORED_LABEL" };
    expect(bad([{ itemIndex: 1, matchBasis: exact }, { itemIndex: 0, matchBasis: exact }])).toBe(false);
    expect(bad([{ itemIndex: 0, matchBasis: exact }, { itemIndex: 0, matchBasis: exact }])).toBe(false);
  });
});

describe("evidence snapshot payload", () => {
  it("accepts supported comparable-slot and familiar-item snapshots", () => {
    expect(ok(patternEvidenceSnapshotPayloadSchema, comparableSnapshotPayload())).toBe(true);
    expect(ok(patternEvidenceSnapshotPayloadSchema, familiarSnapshotPayload())).toBe(true);
  });

  it("rejects a family mismatch between snapshot and facts", () => {
    expect(ok(patternEvidenceSnapshotPayloadSchema, { ...comparableSnapshotPayload(), facts: FACTS.FAMILIAR_OR_FREQUENT_ITEM })).toBe(false);
  });

  it("rejects disabled families because no reviewed gate version exists", () => {
    const payload = { ...comparableSnapshotPayload(), family: "ROUTINE_SHIFT", facts: FACTS.ROUTINE_SHIFT };
    expect(ok(patternEvidenceSnapshotPayloadSchema, payload)).toBe(false);
  });

  it("requires every gate dimension exactly once with reviewed reason codes", () => {
    const payload = comparableSnapshotPayload();
    const gate = payload.gate as { dimensions: Array<Record<string, unknown>>; overall: string };
    expect(ok(patternEvidenceSnapshotPayloadSchema, { ...payload, gate: { ...gate, dimensions: gate.dimensions.slice(1) } })).toBe(false);
    expect(
      ok(patternEvidenceSnapshotPayloadSchema, {
        ...payload,
        gate: { ...gate, dimensions: [...gate.dimensions, gate.dimensions[0]] },
      }),
    ).toBe(false);
    const unknownCode = gate.dimensions.map((d, i) => (i === 0 ? { ...d, reasonCodes: ["LOOKS_IMPORTANT"] } : d));
    expect(ok(patternEvidenceSnapshotPayloadSchema, { ...payload, gate: { ...gate, dimensions: unknownCode } })).toBe(false);
  });

  it("rejects an overall result inconsistent with the hard-dimension aggregation", () => {
    const payload = comparableSnapshotPayload();
    const gate = payload.gate as { dimensions: Array<Record<string, unknown>>; overall: string };
    const failed = gate.dimensions.map((d) =>
      d.dimension === "SUPPORT" ? { ...d, outcome: "FAIL", reasonCodes: ["SUPPORT_BELOW_SIGNAL_MINIMUM"] } : d,
    );
    expect(ok(patternEvidenceSnapshotPayloadSchema, { ...payload, gate: { dimensions: failed, overall: "SUPPORTED" } })).toBe(false);
    expect(ok(patternEvidenceSnapshotPayloadSchema, { ...payload, gate: { dimensions: failed, overall: "INSUFFICIENT" } })).toBe(true);
  });

  it("rejects NOT_APPLICABLE on an applicable dimension and vice versa", () => {
    const payload = comparableSnapshotPayload();
    const gate = payload.gate as { dimensions: Array<Record<string, unknown>>; overall: string };
    const wrongNa = gate.dimensions.map((d) => (d.dimension === "SUPPORT" ? { ...d, outcome: "NOT_APPLICABLE" } : d));
    expect(ok(patternEvidenceSnapshotPayloadSchema, { ...payload, gate: { ...gate, dimensions: wrongNa } })).toBe(false);
    const wrongPass = gate.dimensions.map((d) => (d.dimension === "CONTRADICTION" ? { ...d, outcome: "PASS" } : d));
    expect(ok(patternEvidenceSnapshotPayloadSchema, { ...payload, gate: { ...gate, dimensions: wrongPass } })).toBe(false);
  });

  it("requires facts and evidence groups to agree", () => {
    const payload = comparableSnapshotPayload();
    const groups = payload.evidenceGroups as Array<{ role: string; revisions: unknown[] }>;
    const trimmed = groups.map((g) => (g.role === "RECENT" ? { ...g, revisions: g.revisions.slice(1) } : g));
    expect(ok(patternEvidenceSnapshotPayloadSchema, { ...payload, evidenceGroups: trimmed })).toBe(false);
    const familiar = familiarSnapshotPayload();
    expect(
      ok(patternEvidenceSnapshotPayloadSchema, {
        ...familiar,
        evidenceGroups: [{ role: "SUPPORTING", revisions: [testRef("INTAKE_EVENT", 20)] }],
      }),
    ).toBe(false);
  });

  it("rejects disallowed roles, repeated roles, duplicate revisions and excluded members", () => {
    const familiar = familiarSnapshotPayload();
    const groups = familiar.evidenceGroups as Array<{ role: string; revisions: unknown[] }>;
    expect(ok(patternEvidenceSnapshotPayloadSchema, { ...familiar, evidenceGroups: [...groups, { role: "OUTCOME", revisions: [testRef("GLUCOSE_READING", 5)] }] })).toBe(false);
    expect(ok(patternEvidenceSnapshotPayloadSchema, { ...familiar, evidenceGroups: [...groups, groups[0]] })).toBe(false);
    expect(
      ok(patternEvidenceSnapshotPayloadSchema, {
        ...familiar,
        consideredButExcluded: [{ revision: testRef("INTAKE_EVENT", 20), reason: "DUPLICATE_LOGICAL_OCCASION" }],
      }),
    ).toBe(false);
  });

  it("rejects inverted windows, unknown limitations and duplicate limitations", () => {
    const payload = comparableSnapshotPayload();
    expect(
      ok(patternEvidenceSnapshotPayloadSchema, {
        ...payload,
        observationWindow: { start: "2026-10-03T16:00:00.000Z", end: "2026-10-03T16:00:00.000Z" },
      }),
    ).toBe(false);
    expect(ok(patternEvidenceSnapshotPayloadSchema, { ...payload, limitations: ["CAUSE_UNKNOWN"] })).toBe(false);
    expect(
      ok(patternEvidenceSnapshotPayloadSchema, { ...payload, limitations: ["SPARSE_RECORDING", "SPARSE_RECORDING"] }),
    ).toBe(false);
  });

  it("requires observation-span coverage for familiar items with consistent counts", () => {
    const familiar = familiarSnapshotPayload();
    expect(
      ok(patternEvidenceSnapshotPayloadSchema, {
        ...familiar,
        coverage: {
          kind: "OPPORTUNITY_BASED",
          knownOpportunityCount: 4,
          knownPositiveCount: 4,
          explicitNegativeCount: 0,
          unknownOpportunityCount: 0,
          distinctDayCount: 4,
          spanDays: 6,
          outcome: "ADEQUATE",
        },
      }),
    ).toBe(false);
    expect(
      ok(patternEvidenceSnapshotPayloadSchema, {
        ...familiar,
        coverage: { ...(familiar.coverage as object), distinctOccasionCount: 9 },
      }),
    ).toBe(false);
  });
});

describe("observation payload", () => {
  it("accepts an observation for each enabled family", () => {
    expect(ok(patternObservationPayloadSchema, observationPayload("COMPARABLE_SLOT_TREND"))).toBe(true);
    expect(ok(patternObservationPayloadSchema, observationPayload("FAMILIAR_OR_FREQUENT_ITEM"))).toBe(true);
  });

  it("rejects a claim discriminator that differs from the family", () => {
    expect(
      ok(patternObservationPayloadSchema, { ...observationPayload("COMPARABLE_SLOT_TREND"), family: "ROUTINE_SHIFT" }),
    ).toBe(false);
  });

  it("requires REJECTED lifecycle and disposition to reference the same response", () => {
    const response = testRef("INQUIRY_RESPONSE", 90);
    const base = observationPayload("COMPARABLE_SLOT_TREND", { state: "REJECTED", response });
    expect(ok(patternObservationPayloadSchema, base)).toBe(false);
    expect(ok(patternObservationPayloadSchema, { ...base, patientDisposition: { kind: "REJECTED", response } })).toBe(true);
    expect(
      ok(patternObservationPayloadSchema, {
        ...base,
        patientDisposition: { kind: "REJECTED", response: testRef("INQUIRY_RESPONSE", 91) },
      }),
    ).toBe(false);
    expect(
      ok(patternObservationPayloadSchema, {
        ...observationPayload("COMPARABLE_SLOT_TREND"),
        patientDisposition: { kind: "REJECTED", response },
      }),
    ).toBe(false);
  });

  it("requires unique contexts for a provided context disposition", () => {
    const ctx = testRef("CONTEXT_WINDOW", 92);
    expect(
      ok(patternObservationPayloadSchema, {
        ...observationPayload("COMPARABLE_SLOT_TREND"),
        patientDisposition: { kind: "CONTEXT_PROVIDED", response: testRef("INQUIRY_RESPONSE", 93), contexts: [ctx, ctx] },
      }),
    ).toBe(false);
  });

  it("accepts each persisted lifecycle shape", () => {
    const lifecycles = [
      { state: "SIGNAL" },
      { state: "EMERGING" },
      { state: "WATCHING" },
      { state: "WEAKENING", previouslySupported: testRef("PATTERN_OBSERVATION", 95) },
      { state: "STALE" },
      { state: "SUPERSEDED", replacement: testRef("PATTERN_OBSERVATION", 96) },
      { state: "RETIRED", reason: "SOURCE_DELETED" },
    ];
    for (const lifecycle of lifecycles) {
      expect(ok(patternObservationPayloadSchema, observationPayload("COMPARABLE_SLOT_TREND", lifecycle))).toBe(true);
    }
    expect(ok(patternObservationPayloadSchema, observationPayload("COMPARABLE_SLOT_TREND", { state: "RETIRED", reason: "BORING" }))).toBe(false);
  });
});

describe("revisions and the observation/snapshot pair", () => {
  const envelope = (recordType: string, recordId: string, payload: unknown, extra: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    recordType,
    recordId,
    revisionId: testUuid(recordType.length, 7),
    revisionNumber: 1,
    previousRevisionId: null,
    action: "CREATE",
    recordedAt: "2026-10-03T16:00:00.000Z",
    revisionCreatedAt: "2026-10-03T16:00:00.000Z",
    temporal: { kind: "ATEMPORAL" },
    provenance: { sourceKind: "SYSTEM_DERIVATION", captureMethod: "RULE_ENGINE", initiator: "JAGAON_SYSTEM", assistance: "NONE" },
    auditEventId: testUuid(3, 8),
    transactionId: testUuid(4, 9),
    payload,
    ...extra,
  });

  it("accepts atemporal derived revisions with closed actions", () => {
    expect([...PATTERN_OBSERVATION_REVISION_ACTIONS]).toEqual(["CREATE", "UPDATE", "CORRECT"]);
    expect([...PATTERN_EVIDENCE_SNAPSHOT_REVISION_ACTIONS]).toEqual(["CREATE", "UPDATE", "CORRECT"]);
    expect(PATTERN_RECORD_DELETION_POLICY).toBe("PATIENT_DELETABLE");
    expect(ok(patternObservationRevisionSchema, envelope("PATTERN_OBSERVATION", OBSERVATION_RECORD, observationPayload("COMPARABLE_SLOT_TREND")))).toBe(true);
    expect(ok(patternEvidenceSnapshotRevisionSchema, envelope("PATTERN_EVIDENCE_SNAPSHOT", testUuid(80, 1), comparableSnapshotPayload()))).toBe(true);
    expect(
      ok(patternObservationRevisionSchema, envelope("PATTERN_OBSERVATION", OBSERVATION_RECORD, observationPayload("COMPARABLE_SLOT_TREND"), { action: "CONFIRM" })),
    ).toBe(false);
  });

  it("requires WEAKENING to reference an earlier revision of the same chain", () => {
    const other = envelope(
      "PATTERN_OBSERVATION",
      OBSERVATION_RECORD,
      observationPayload("COMPARABLE_SLOT_TREND", { state: "WEAKENING", previouslySupported: testRef("PATTERN_OBSERVATION", 95) }),
    );
    expect(ok(patternObservationRevisionSchema, other)).toBe(false);
    const same = envelope(
      "PATTERN_OBSERVATION",
      OBSERVATION_RECORD,
      observationPayload("COMPARABLE_SLOT_TREND", {
        state: "WEAKENING",
        previouslySupported: { recordType: "PATTERN_OBSERVATION", recordId: OBSERVATION_RECORD, revisionId: testUuid(5, 2) },
      }),
    );
    expect(ok(patternObservationRevisionSchema, same)).toBe(true);
  });

  it("rejects a SUPERSEDED replacement that names its own chain", () => {
    const self = envelope(
      "PATTERN_OBSERVATION",
      OBSERVATION_RECORD,
      observationPayload("COMPARABLE_SLOT_TREND", {
        state: "SUPERSEDED",
        replacement: { recordType: "PATTERN_OBSERVATION", recordId: OBSERVATION_RECORD, revisionId: testUuid(6, 2) },
      }),
    );
    expect(ok(patternObservationRevisionSchema, self)).toBe(false);
  });

  it("validates the exact pair: snapshot reference, family, identity and direction", () => {
    const snapshotRevision = envelope("PATTERN_EVIDENCE_SNAPSHOT", testUuid(80, 1), comparableSnapshotPayload());
    const observation = {
      ...observationPayload("COMPARABLE_SLOT_TREND"),
      evidenceSnapshot: {
        recordType: "PATTERN_EVIDENCE_SNAPSHOT",
        recordId: snapshotRevision.recordId,
        revisionId: snapshotRevision.revisionId,
      },
    };
    expect(validatePatternPair(observation as never, snapshotRevision as never)).toEqual({ ok: true });

    const wrongRef = { ...observation, evidenceSnapshot: testRef("PATTERN_EVIDENCE_SNAPSHOT", 81) };
    expect(validatePatternPair(wrongRef as never, snapshotRevision as never)).toEqual({
      ok: false,
      code: "SNAPSHOT_REFERENCE_MISMATCH",
    });

    const lower = {
      ...observation,
      claim: { ...CLAIMS.COMPARABLE_SLOT_TREND, observedChange: { typicalValue: "LOWER", variability: "NO_MATERIAL_CHANGE" } },
    };
    expect(validatePatternPair(lower as never, snapshotRevision as never)).toEqual({
      ok: false,
      code: "DIRECTION_DISAGREES_WITH_FACTS",
    });

    const otherSlot = {
      ...observation,
      claim: { ...CLAIMS.COMPARABLE_SLOT_TREND, slot: { kind: "PATIENT_SELECTED_SLOT", slot: "BEDTIME" } },
    };
    expect(validatePatternPair(otherSlot as never, snapshotRevision as never)).toEqual({
      ok: false,
      code: "CLAIM_IDENTITY_DISAGREES_WITH_FACTS",
    });
  });

  it("aggregates hard dimensions deterministically", () => {
    expect(aggregatePatternGate("comparable-slot-gate.v1", [{ dimension: "SUPPORT", outcome: "INDETERMINATE" }])).toBe(
      "CONTINUE_OBSERVING",
    );
    expect(aggregatePatternGate("comparable-slot-gate.v1", [{ dimension: "MISSINGNESS", outcome: "FAIL" }])).toBe("SUPPORTED");
    expect(
      aggregatePatternGate("comparable-slot-gate.v1", [
        { dimension: "SUPPORT", outcome: "INDETERMINATE" },
        { dimension: "COVERAGE", outcome: "FAIL" },
      ]),
    ).toBe("INSUFFICIENT");
  });
});
