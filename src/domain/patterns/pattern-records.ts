import { z } from "zod";
import { createRecordRevisionSchema, type RecordRevision } from "../shared/revision";
import { provenanceCoreSchema, type ProvenanceCore } from "../shared/provenance";
import { DeletionPolicy } from "../shared/record-catalogue";
import { instantSchema, instantBefore } from "../shared/time";
import {
  anyTypedRevisionRefSchema,
  atemporalSchema,
  revisionRefKey,
  uniqueRefTupleSchema,
  versionIdentifierSchema,
  type AtemporalMeaning,
} from "../learning";
import {
  contextWindowRefSchema,
  inquiryResponseRefSchema,
  patternEvidenceSnapshotRefSchema,
  patternObservationRefSchema,
} from "./pattern-comparable";
import { patternClaimSchema, type PatternClaim } from "./pattern-claims";
import { patternFamilyEvidenceFactsSchema, type PatternFamilyEvidenceFacts } from "./pattern-facts";
import {
  aggregatePatternGate,
  PATTERN_EVIDENCE_GROUP_ROLES,
  PATTERN_EXCLUSION_REASONS,
  PATTERN_FAMILY_GROUP_ROLES,
  PATTERN_FAMILY_OVERLAPPING_ROLES,
  PATTERN_GATE_DIMENSIONS,
  PATTERN_GATE_REGISTRY,
  PATTERN_LIMITATION_CODES,
  patternFamilySchema,
  type PatternFamily,
} from "./pattern-registry";
import { decimalSign, stableStringify } from "./pattern-decimal";

export const PATTERN_RECORD_DELETION_POLICY = DeletionPolicy.PATIENT_DELETABLE;
export const PATTERN_OBSERVATION_REVISION_ACTIONS = Object.freeze(["CREATE", "UPDATE", "CORRECT"] as const);
export const PATTERN_EVIDENCE_SNAPSHOT_REVISION_ACTIONS = Object.freeze(["CREATE", "UPDATE", "CORRECT"] as const);

// --- Observation payload ---------------------------------------------------

export const patternLifecycleSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("SIGNAL") }),
  z.strictObject({ state: z.literal("EMERGING") }),
  z.strictObject({ state: z.literal("WATCHING") }),
  z.strictObject({ state: z.literal("SUPPORTED") }),
  z.strictObject({ state: z.literal("WEAKENING"), previouslySupported: patternObservationRefSchema }),
  z.strictObject({ state: z.literal("STALE") }),
  z.strictObject({ state: z.literal("SUPERSEDED"), replacement: patternObservationRefSchema }),
  z.strictObject({ state: z.literal("REJECTED"), response: inquiryResponseRefSchema }),
  z.strictObject({
    state: z.literal("RETIRED"),
    reason: z.enum(["NO_LONGER_USEFUL", "POLICY_DISABLED", "SOURCE_DELETED"]),
  }),
]);

export type PatternLifecycle = z.infer<typeof patternLifecycleSchema>;

export const patternPatientDispositionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("NONE") }),
  z.strictObject({
    kind: z.literal("CONTEXT_PROVIDED"),
    response: inquiryResponseRefSchema,
    contexts: uniqueRefTupleSchema(contextWindowRefSchema),
  }),
  z.strictObject({ kind: z.literal("DESCRIPTION_CONFIRMED"), response: inquiryResponseRefSchema }),
  z.strictObject({ kind: z.literal("NOT_SURE"), response: inquiryResponseRefSchema }),
  z.strictObject({ kind: z.literal("PREFER_NOT_TO_SAY"), response: inquiryResponseRefSchema }),
  z.strictObject({ kind: z.literal("REJECTED"), response: inquiryResponseRefSchema }),
]);

export const patternObservationPayloadSchema = z
  .strictObject({
    family: patternFamilySchema,
    claim: patternClaimSchema,
    lifecycle: patternLifecycleSchema,
    evidenceSnapshot: patternEvidenceSnapshotRefSchema,
    patientDisposition: patternPatientDispositionSchema,
  })
  .superRefine((payload, ctx) => {
    const issue = (message: string, path: string[] = []) => ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
    if (payload.claim.family !== payload.family) issue("CLAIM_FAMILY_MISMATCH", ["claim"]);
    const rejectedLifecycle = payload.lifecycle.state === "REJECTED";
    const rejectedDisposition = payload.patientDisposition.kind === "REJECTED";
    if (rejectedLifecycle !== rejectedDisposition) issue("REJECTION_REQUIRES_LIFECYCLE_AND_DISPOSITION", ["lifecycle"]);
    if (
      payload.lifecycle.state === "REJECTED" &&
      payload.patientDisposition.kind === "REJECTED" &&
      revisionRefKey(payload.lifecycle.response) !== revisionRefKey(payload.patientDisposition.response)
    ) {
      issue("REJECTION_RESPONSE_MISMATCH", ["patientDisposition"]);
    }
  });

export type PatternObservationPayload = z.infer<typeof patternObservationPayloadSchema>;

// --- Evidence snapshot payload ------------------------------------------------

const evidenceGroupSchema = z.strictObject({
  role: z.enum(PATTERN_EVIDENCE_GROUP_ROLES),
  revisions: uniqueRefTupleSchema(anyTypedRevisionRefSchema),
});

const coverageSchema = z.union([
  z.strictObject({
    kind: z.literal("OBSERVATION_SPAN"),
    distinctOccasionCount: z.number().int().nonnegative().safe(),
    distinctDayCount: z.number().int().nonnegative().safe(),
    spanDays: z.number().int().nonnegative().safe(),
    outcome: z.enum(["ADEQUATE", "LIMITED", "INSUFFICIENT"]),
  }),
  z
    .strictObject({
      kind: z.literal("OPPORTUNITY_BASED"),
      knownOpportunityCount: z.number().int().nonnegative().safe(),
      knownPositiveCount: z.number().int().nonnegative().safe(),
      explicitNegativeCount: z.number().int().nonnegative().safe(),
      unknownOpportunityCount: z.number().int().nonnegative().safe(),
      distinctDayCount: z.number().int().nonnegative().safe(),
      spanDays: z.number().int().nonnegative().safe(),
      outcome: z.enum(["ADEQUATE", "LIMITED", "INSUFFICIENT"]),
    })
    .refine(
      (c) => c.knownPositiveCount + c.explicitNegativeCount <= c.knownOpportunityCount,
      "KNOWN_COUNTS_EXCEED_OPPORTUNITIES",
    ),
]);

const gateDimensionResultSchema = z.strictObject({
  dimension: z.enum(PATTERN_GATE_DIMENSIONS),
  outcome: z.enum(["PASS", "FAIL", "INDETERMINATE", "NOT_APPLICABLE"]),
  reasonCodes: z.array(z.string().min(1).max(96)).min(1),
});

function readingKeys(assignments: readonly { reading: Parameters<typeof revisionRefKey>[0] }[]): string[] {
  return assignments.map((assignment) => revisionRefKey(assignment.reading)).sort();
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = [...a].sort();
  const right = [...b].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export const patternEvidenceSnapshotPayloadSchema = z
  .strictObject({
    family: patternFamilySchema,
    evaluatedAt: instantSchema,
    observationWindow: z.strictObject({ start: instantSchema, end: instantSchema }),
    ruleVersions: z.strictObject({
      familyRuleVersion: versionIdentifierSchema,
      evidenceGateVersion: versionIdentifierSchema,
      missingnessRuleVersion: versionIdentifierSchema,
      metricRuleVersion: versionIdentifierSchema,
    }),
    evidenceGroups: z.array(evidenceGroupSchema).min(1),
    consideredButExcluded: z.array(
      z.strictObject({ revision: anyTypedRevisionRefSchema, reason: z.enum(PATTERN_EXCLUSION_REASONS) }),
    ),
    coverage: coverageSchema,
    gate: z.strictObject({
      dimensions: z.array(gateDimensionResultSchema).min(1),
      overall: z.enum(["INSUFFICIENT", "CONTINUE_OBSERVING", "SUPPORTED"]),
    }),
    facts: patternFamilyEvidenceFactsSchema,
    limitations: z.array(z.enum(PATTERN_LIMITATION_CODES)),
  })
  .superRefine((payload, ctx) => {
    const issue = (message: string, path: (string | number)[] = []) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });

    if (!instantBefore(payload.observationWindow.start, payload.observationWindow.end)) {
      issue("OBSERVATION_WINDOW_INVERTED", ["observationWindow"]);
    }
    if (payload.facts.family !== payload.family) issue("FACTS_FAMILY_MISMATCH", ["facts"]);
    if (new Set(payload.limitations).size !== payload.limitations.length) issue("DUPLICATE_LIMITATION", ["limitations"]);

    // Evidence groups: permitted roles, one group per role, permitted overlaps only.
    const allowedRoles = PATTERN_FAMILY_GROUP_ROLES[payload.family];
    const roles = payload.evidenceGroups.map((group) => group.role);
    if (new Set(roles).size !== roles.length) issue("REPEATED_EVIDENCE_ROLE", ["evidenceGroups"]);
    if (roles.some((role) => !allowedRoles.includes(role))) issue("ROLE_NOT_PERMITTED_FOR_FAMILY", ["evidenceGroups"]);
    const membership = new Map<string, string[]>();
    for (const group of payload.evidenceGroups) {
      for (const ref of group.revisions) {
        const key = revisionRefKey(ref);
        membership.set(key, [...(membership.get(key) ?? []), group.role]);
      }
    }
    const overlaps = PATTERN_FAMILY_OVERLAPPING_ROLES[payload.family];
    for (const memberRoles of membership.values()) {
      if (memberRoles.length > 1 && !overlaps.includes([...memberRoles].sort().join("|"))) {
        issue("REVISION_IN_SEVERAL_GROUPS", ["evidenceGroups"]);
        break;
      }
    }
    const excludedKeys = payload.consideredButExcluded.map((entry) => revisionRefKey(entry.revision));
    if (new Set(excludedKeys).size !== excludedKeys.length) issue("DUPLICATE_EXCLUSION", ["consideredButExcluded"]);
    if (excludedKeys.some((key) => membership.has(key))) issue("EXCLUDED_REVISION_IN_GROUP", ["consideredButExcluded"]);

    // Coverage.
    if (payload.coverage.kind === "OBSERVATION_SPAN" && payload.coverage.distinctOccasionCount > membership.size) {
      issue("COVERAGE_EXCEEDS_EVIDENCE", ["coverage"]);
    }
    if (payload.family === "FAMILIAR_OR_FREQUENT_ITEM" && payload.coverage.kind !== "OBSERVATION_SPAN") {
      issue("FAMILIAR_ITEM_REQUIRES_OBSERVATION_SPAN", ["coverage"]);
    }

    // Evidence Gate.
    const definition = PATTERN_GATE_REGISTRY[payload.ruleVersions.evidenceGateVersion];
    if (!definition || definition.family !== payload.family) {
      issue("UNKNOWN_EVIDENCE_GATE_VERSION", ["ruleVersions", "evidenceGateVersion"]);
    } else {
      const dimensions = payload.gate.dimensions.map((result) => result.dimension);
      if (
        dimensions.length !== PATTERN_GATE_DIMENSIONS.length ||
        new Set(dimensions).size !== PATTERN_GATE_DIMENSIONS.length
      ) {
        issue("GATE_DIMENSIONS_MUST_APPEAR_EXACTLY_ONCE", ["gate", "dimensions"]);
      }
      for (const result of payload.gate.dimensions) {
        const rule = definition.dimensions[result.dimension];
        if ((rule.role === "NOT_APPLICABLE") !== (result.outcome === "NOT_APPLICABLE")) {
          issue("NOT_APPLICABLE_DISAGREES_WITH_FAMILY", ["gate", "dimensions"]);
        }
        if (result.reasonCodes.some((code) => !rule.reasonCodes.includes(code))) {
          issue("UNKNOWN_REASON_CODE", ["gate", "dimensions"]);
        }
        if (new Set(result.reasonCodes).size !== result.reasonCodes.length) {
          issue("DUPLICATE_REASON_CODE", ["gate", "dimensions"]);
        }
      }
      if (aggregatePatternGate(payload.ruleVersions.evidenceGateVersion, payload.gate.dimensions) !== payload.gate.overall) {
        issue("GATE_OVERALL_DISAGREES_WITH_DIMENSIONS", ["gate", "overall"]);
      }
    }

    // Family-specific agreement between facts and evidence groups.
    const groupKeys = (role: string) =>
      payload.evidenceGroups.find((group) => group.role === role)?.revisions.map(revisionRefKey) ?? [];
    const facts = payload.facts;
    if (facts.family === "COMPARABLE_SLOT_TREND") {
      if (!sameSet(groupKeys("BASELINE"), readingKeys(facts.reference.assignments))) {
        issue("BASELINE_GROUP_DISAGREES_WITH_REFERENCE", ["evidenceGroups"]);
      }
      if (!sameSet(groupKeys("RECENT"), readingKeys(facts.recent.assignments))) {
        issue("RECENT_GROUP_DISAGREES_WITH_RECENT", ["evidenceGroups"]);
      }
      const neutral = new Set(groupKeys("NEUTRAL"));
      for (const assignment of [...facts.reference.assignments, ...facts.recent.assignments]) {
        const related = "relatedEvent" in assignment.slotAssignment ? assignment.slotAssignment.relatedEvent : null;
        if (related && !neutral.has(revisionRefKey(related))) issue("RELATED_EVENT_NOT_IN_NEUTRAL_GROUP", ["evidenceGroups"]);
      }
      if (
        instantBefore(facts.reference.window.start, payload.observationWindow.start) ||
        instantBefore(payload.observationWindow.end, facts.recent.window.end)
      ) {
        issue("SEGMENT_OUTSIDE_OBSERVATION_WINDOW", ["facts"]);
      }
    }
    if (facts.family === "FAMILIAR_OR_FREQUENT_ITEM") {
      const sources = facts.occurrenceMatches.map((match) => revisionRefKey(match.source));
      if (!sameSet(groupKeys("SUPPORTING"), sources)) issue("SUPPORTING_GROUP_DISAGREES_WITH_MATCHES", ["evidenceGroups"]);
      if (facts.claimKind === "RECORDED_SHARE_WITHIN_INTAKE_CONTEXT") {
        if (sources.length + groupKeys("COMPARATOR").length !== facts.eligibleLoggedIntakeCount) {
          issue("DENOMINATOR_DISAGREES_WITH_GROUPS", ["evidenceGroups"]);
        }
      } else if (groupKeys("COMPARATOR").length > 0) {
        issue("RECURRENCE_HAS_NO_COMPARATOR", ["evidenceGroups"]);
      }
    }
  });

export type PatternEvidenceSnapshotPayload = z.infer<typeof patternEvidenceSnapshotPayloadSchema>;

// --- Revisions -------------------------------------------------------------------

export type PatternObservationRevision = RecordRevision<
  "PATTERN_OBSERVATION",
  PatternObservationPayload,
  AtemporalMeaning,
  ProvenanceCore
>;

export type PatternEvidenceSnapshotRevision = RecordRevision<
  "PATTERN_EVIDENCE_SNAPSHOT",
  PatternEvidenceSnapshotPayload,
  AtemporalMeaning,
  ProvenanceCore
>;

export const patternObservationRevisionSchema = createRecordRevisionSchema(
  z.literal("PATTERN_OBSERVATION"),
  patternObservationPayloadSchema,
  atemporalSchema,
  provenanceCoreSchema,
).superRefine((revision, ctx) => {
  const issue = (message: string, path: string[]) => ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
  if (!(PATTERN_OBSERVATION_REVISION_ACTIONS as readonly string[]).includes(revision.action)) {
    issue("UNSUPPORTED_REVISION_ACTION", ["action"]);
  }
  const lifecycle = revision.payload.lifecycle;
  if (
    lifecycle.state === "WEAKENING" &&
    (lifecycle.previouslySupported.recordId !== revision.recordId ||
      lifecycle.previouslySupported.revisionId === revision.revisionId)
  ) {
    issue("WEAKENING_MUST_REFERENCE_EARLIER_REVISION_OF_CHAIN", ["payload", "lifecycle"]);
  }
  if (lifecycle.state === "SUPERSEDED" && lifecycle.replacement.recordId === revision.recordId) {
    issue("SUPERSEDED_REPLACEMENT_CANNOT_BE_OWN_CHAIN", ["payload", "lifecycle"]);
  }
}) as unknown as z.ZodType<PatternObservationRevision, z.ZodTypeDef, unknown>;

export const patternEvidenceSnapshotRevisionSchema = createRecordRevisionSchema(
  z.literal("PATTERN_EVIDENCE_SNAPSHOT"),
  patternEvidenceSnapshotPayloadSchema,
  atemporalSchema,
  provenanceCoreSchema,
).superRefine((revision, ctx) => {
  if (!(PATTERN_EVIDENCE_SNAPSHOT_REVISION_ACTIONS as readonly string[]).includes(revision.action)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "UNSUPPORTED_REVISION_ACTION", path: ["action"] });
  }
}) as unknown as z.ZodType<PatternEvidenceSnapshotRevision, z.ZodTypeDef, unknown>;

// --- Exact observation/snapshot pair -----------------------------------------------

export type PatternPairValidation =
  | { ok: true }
  | {
      ok: false;
      code:
        | "SNAPSHOT_REFERENCE_MISMATCH"
        | "FAMILY_MISMATCH"
        | "CLAIM_IDENTITY_DISAGREES_WITH_FACTS"
        | "DIRECTION_DISAGREES_WITH_FACTS";
    };

function signAgrees(direction: string, value: string, positive: string, negative: string): boolean {
  const sign = decimalSign(value);
  if (direction === positive) return sign === 1;
  if (direction === negative) return sign === -1;
  return true;
}

function claimIdentityAgrees(claim: PatternClaim, facts: PatternFamilyEvidenceFacts): boolean {
  if (claim.family === "COMPARABLE_SLOT_TREND" && facts.family === "COMPARABLE_SLOT_TREND") {
    return stableStringify(claim.slot) === stableStringify(facts.slot);
  }
  if (claim.family === "FAMILIAR_OR_FREQUENT_ITEM" && facts.family === "FAMILIAR_OR_FREQUENT_ITEM") {
    return claim.item.familiarItemKey === facts.familiarItemKey && claim.claim.kind === facts.claimKind;
  }
  if (claim.family === "RECURRING_BARRIER" && facts.family === "RECURRING_BARRIER") {
    return (
      claim.barrier.barrierKey === facts.barrierKey &&
      stableStringify(claim.affectedTask) === stableStringify(facts.affectedTask) &&
      stableStringify(claim.scope) === stableStringify(facts.scope)
    );
  }
  if (claim.family === "PRESCRIBED_TIMING_ALIGNMENT" && facts.family === "PRESCRIBED_TIMING_ALIGNMENT") {
    return claim.claim.kind === facts.claimKind && stableStringify(claim.subject) === stableStringify(facts.subject);
  }
  if (
    (claim.family === "ROUTINE_SHIFT" && facts.family === "ROUTINE_SHIFT") ||
    (claim.family === "RETURN_TOWARD_BASELINE" && facts.family === "RETURN_TOWARD_BASELINE")
  ) {
    return stableStringify(claim.subject) === stableStringify(facts.subject);
  }
  if (claim.family === "CONTEXT_BOUNDED_DEVIATION" && facts.family === "CONTEXT_BOUNDED_DEVIATION") {
    return (
      stableStringify(claim.subject) === stableStringify(facts.subject) &&
      revisionRefKey(claim.context) === revisionRefKey(facts.context)
    );
  }
  return claim.family === facts.family;
}

function directionAgrees(claim: PatternClaim, facts: PatternFamilyEvidenceFacts): boolean {
  if (claim.family === "COMPARABLE_SLOT_TREND" && facts.family === "COMPARABLE_SLOT_TREND") {
    return (
      signAgrees(claim.observedChange.typicalValue, facts.difference.medianDifferenceMmolL, "HIGHER", "LOWER") &&
      signAgrees(claim.observedChange.variability, facts.difference.dispersionDifferenceMmolL, "MORE_VARIABLE", "LESS_VARIABLE")
    );
  }
  if (
    (claim.family === "ROUTINE_SHIFT" || claim.family === "CONTEXT_BOUNDED_DEVIATION") &&
    (facts.family === "ROUTINE_SHIFT" || facts.family === "CONTEXT_BOUNDED_DEVIATION") &&
    claim.observedChange.kind === "GLUCOSE_DISTRIBUTION" &&
    facts.difference.kind === "GLUCOSE_DISTRIBUTION"
  ) {
    return signAgrees(claim.observedChange.direction, facts.difference.medianDifferenceMmolL, "HIGHER", "LOWER");
  }
  return true;
}

/**
 * Cross-record rules for one observation revision and the exact snapshot
 * revision it references: same snapshot identity, family, subject and a
 * non-clinical direction that agrees with the signed facts.
 */
export function validatePatternPair(
  observation: PatternObservationPayload,
  snapshot: Pick<PatternEvidenceSnapshotRevision, "recordType" | "recordId" | "revisionId" | "payload">,
): PatternPairValidation {
  if (
    snapshot.recordType !== "PATTERN_EVIDENCE_SNAPSHOT" ||
    observation.evidenceSnapshot.recordId !== snapshot.recordId ||
    observation.evidenceSnapshot.revisionId !== snapshot.revisionId
  ) {
    return { ok: false, code: "SNAPSHOT_REFERENCE_MISMATCH" };
  }
  if (observation.family !== snapshot.payload.family) return { ok: false, code: "FAMILY_MISMATCH" };
  if (!claimIdentityAgrees(observation.claim, snapshot.payload.facts)) {
    return { ok: false, code: "CLAIM_IDENTITY_DISAGREES_WITH_FACTS" };
  }
  if (!directionAgrees(observation.claim, snapshot.payload.facts)) {
    return { ok: false, code: "DIRECTION_DISAGREES_WITH_FACTS" };
  }
  return { ok: true };
}

export type { PatternFamily };
