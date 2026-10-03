import {
  FAMILIAR_OR_FREQUENT_ITEM_CONFIG_V1,
  INTELLIGENCE_ACTIVATION_MANIFEST,
  type EnabledPatternDisposition,
} from "@/application/intelligence/activation-manifest";
import {
  resolveActivityIdentity,
  resolveIntakeIdentities,
} from "@/application/intelligence/familiar-identity";
import {
  collectFamiliarOccurrences,
  distinctOccurrenceDays,
  hasSpanWithin,
} from "@/application/intelligence/familiar-occurrences";
import { addDays, fingerprint, instantMs, localDateOf, sortRevisionRefs } from "@/application/intelligence/metrics";
import type { Instant } from "@/domain/shared/time";
import type { TypedRevisionRef } from "@/domain/shared/typed-revision-ref";
import {
  aggregatePatternGate,
  type FamiliarItemEvidenceMatch,
  type PatternClaim,
  type PatternEvidenceSnapshotPayload,
  type PatternGateDimension,
  type PatternGateOutcome,
  type PatternLifecycle,
} from "@/domain/patterns";
import type {
  PatternEvaluation,
  PatternEvaluationResult,
  PatternSourceRole,
  PreviousPatternChain,
  ResolvedActivityEvent,
  ResolvedIntakeEvent,
  SupersededRevision,
} from "./pattern-evaluator-contracts";
import { downgradePrevious, finaliseProposal, inputFingerprintOf, isTerminalForEvaluator } from "./pattern-evaluator-support";

/**
 * Familiar or frequently recorded item evaluator ("familiar-or-frequent-item.v1").
 *
 * Deterministic-engine Section 9.2 and domain Section 8.12: a 60-day factual
 * recurrence of one exact or deterministically normalised intake-item or
 * activity identity over distinct logical occasions. It never counts an
 * absent log as a non-occurrence and never becomes a preference, benefit or
 * recommendation.
 */

const FAMILY = "FAMILIAR_OR_FREQUENT_ITEM" as const;
const DISPOSITION = INTELLIGENCE_ACTIVATION_MANIFEST.pattern.FAMILIAR_OR_FREQUENT_ITEM as EnabledPatternDisposition;
const CONFIG = FAMILIAR_OR_FREQUENT_ITEM_CONFIG_V1;
const GATE_VERSION = DISPOSITION.ruleVersions.evidenceGateVersion;
const WEEK_MS = 7 * 86_400_000;

export type FamiliarItemEvaluationInput = {
  evaluatedAt: Instant;
  inputSequenceCutoff: number;
  familiarItemKey: string;
  intakeEvents: readonly ResolvedIntakeEvent[];
  activityEvents: readonly ResolvedActivityEvent[];
  superseded: readonly SupersededRevision[];
  previous: PreviousPatternChain | null;
};

export function familiarItemCandidateKey(familiarItemKey: string): string {
  return `${FAMILY}:${familiarItemKey}:ORDINARY:RECURRING_IN_RECORDED_OCCASIONS`;
}

/** Every identity recorded by the supplied events (stable, sorted, unique). */
export function discoverFamiliarCandidates(
  intakeEvents: readonly ResolvedIntakeEvent[],
  activityEvents: readonly ResolvedActivityEvent[],
): string[] {
  const keys = new Set<string>();
  for (const event of intakeEvents) {
    for (const identity of resolveIntakeIdentities(event.payload.items)) keys.add(identity.familiarItemKey);
  }
  for (const event of activityEvents) keys.add(resolveActivityIdentity(event.payload).familiarItemKey);
  return [...keys].sort();
}

export function evaluateFamiliarOrFrequentItem(input: FamiliarItemEvaluationInput): PatternEvaluation {
  const key = input.familiarItemKey;
  const candidateKey = familiarItemCandidateKey(key);
  const T = input.evaluatedAt;
  const windowStart = addDays(T, -CONFIG.sourceWindowDays);
  const allRefs = [...input.intakeEvents.map((e) => e.ref), ...input.activityEvents.map((e) => e.ref)];

  // Bounded family query: events in the window whose latest revision carries the identity.
  const { occasions, exclusions, considered } = collectFamiliarOccurrences({
    familiarItemKey: key,
    windowStart,
    windowEnd: T,
    intakeEvents: input.intakeEvents,
    activityEvents: input.activityEvents,
    superseded: input.superseded,
  });

  const envelope = (result: PatternEvaluationResult): PatternEvaluation => ({
    evaluatorKey: DISPOSITION.evaluatorKey,
    evaluatorVersion: DISPOSITION.evaluatorVersion,
    configurationVersion: DISPOSITION.configurationVersion,
    evaluatedAt: T,
    inputSequenceCutoff: input.inputSequenceCutoff,
    candidateKey,
    consideredRevisions: sortRevisionRefs(considered),
    inputFingerprint: inputFingerprintOf({
      evaluatorKey: DISPOSITION.evaluatorKey,
      evaluatorVersion: DISPOSITION.evaluatorVersion,
      configurationVersion: DISPOSITION.configurationVersion,
      evaluatedAt: T,
      inputSequenceCutoff: input.inputSequenceCutoff,
      candidateKey,
      sources: allRefs,
      superseded: input.superseded.map((entry) => entry.ref),
      previous: input.previous,
    }),
    resultFingerprint: fingerprint(result),
    result,
  });

  if (input.previous && isTerminalForEvaluator(input.previous.observation.payload.lifecycle)) {
    return envelope({ kind: "NO_CHANGE", family: FAMILY, candidateKey });
  }

  const n = occasions.length;
  const latest = occasions.at(-1)?.instant ?? null;
  const recent = latest !== null && instantMs(latest) >= instantMs(addDays(T, -CONFIG.maximumLatestAgeDays));
  const staleNow = latest === null || instantMs(latest) < instantMs(addDays(T, -CONFIG.stalenessDays));
  const withinSevenDays = hasSpanWithin(occasions, WEEK_MS, CONFIG.supportedOccurrences, CONFIG.supportedDistinctDays);
  const counts = { occurrences: n, distinctDays: distinctOccurrenceDays(occasions) };

  if (n < CONFIG.signalOccurrences || !recent) {
    const reasonCodes = n < CONFIG.signalOccurrences ? ["OCCURRENCES_BELOW_SIGNAL_MINIMUM"] : ["LATEST_OCCURRENCE_OLDER_THAN_THIRTY_DAYS"];
    return envelope(
      input.previous
        ? downgradePrevious(FAMILY, candidateKey, input.previous, staleNow)
        : { kind: "INSUFFICIENT_EVIDENCE", family: FAMILY, candidateKey, reasonCodes, counts },
    );
  }

  const dimensions: { dimension: PatternGateDimension; outcome: PatternGateOutcome; reasonCodes: string[] }[] = [
    {
      dimension: "SUPPORT",
      outcome: n >= CONFIG.supportedOccurrences ? "PASS" : "INDETERMINATE",
      reasonCodes: [n >= CONFIG.supportedOccurrences ? "OCCURRENCE_MINIMUM_MET" : "OCCURRENCES_BELOW_SUPPORTED_MINIMUM"],
    },
    {
      dimension: "COVERAGE",
      outcome: withinSevenDays ? "PASS" : "INDETERMINATE",
      reasonCodes: [withinSevenDays ? "DISTINCT_DAYS_WITHIN_SEVEN_DAYS_MET" : "DISTINCT_DAYS_WITHIN_SEVEN_DAYS_NOT_MET"],
    },
    { dimension: "COMPARISON", outcome: "NOT_APPLICABLE", reasonCodes: ["RECURRENCE_CLAIM_HAS_NO_COMPARATOR"] },
    { dimension: "MISSINGNESS", outcome: "PASS", reasonCodes: ["UNLOGGED_OCCASIONS_REMAIN_UNKNOWN"] },
    { dimension: "RECENCY", outcome: "PASS", reasonCodes: ["LATEST_OCCURRENCE_WITHIN_THIRTY_DAYS"] },
    { dimension: "CONSISTENCY", outcome: "PASS", reasonCodes: ["EXACT_OR_NORMALISED_IDENTITY"] },
    { dimension: "CONTRADICTION", outcome: "PASS", reasonCodes: ["NO_PATIENT_CONTRADICTION_RECORDED"] },
    { dimension: "CONTEXT", outcome: "PASS", reasonCodes: ["NO_RECORDED_CONTEXT_BOUNDARY"] },
    { dimension: "STABILITY", outcome: "NOT_APPLICABLE", reasonCodes: ["STABILITY_NOT_APPLICABLE_TO_RECURRENCE"] },
    { dimension: "MAGNITUDE_OR_USEFULNESS", outcome: "NOT_APPLICABLE", reasonCodes: ["MAGNITUDE_NOT_APPLICABLE_TO_RECURRENCE"] },
    { dimension: "PRIOR_PATIENT_DISPOSITION", outcome: "PASS", reasonCodes: ["NO_PRIOR_PATIENT_DISPOSITION"] },
  ];
  const overall = aggregatePatternGate(GATE_VERSION, dimensions);
  const previousState = input.previous?.observation.payload.lifecycle.state;
  if (overall !== "SUPPORTED" && (previousState === "SUPPORTED" || previousState === "WEAKENING") && input.previous) {
    return envelope(downgradePrevious(FAMILY, candidateKey, input.previous, staleNow));
  }
  const lifecycle: PatternLifecycle =
    overall === "SUPPORTED" ? { state: "SUPPORTED" } : n >= CONFIG.emergingOccurrences ? { state: "EMERGING" } : { state: "SIGNAL" };

  // The earliest occurrence's authored wording is the visible identity label.
  const first = occasions[0]!;
  const displayLabel = first.labels[0]!.label;
  const matchBasis = (label: string) =>
    label === displayLabel ? ({ kind: "EXACT_AUTHORED_LABEL" } as const) : ({ kind: "DETERMINISTIC_NORMALISATION" } as const);
  const matches: FamiliarItemEvidenceMatch[] = occasions.map((occasion) =>
    occasion.identity.kind === "INTAKE_ITEM"
      ? {
          kind: "INTAKE_ITEM",
          source: occasion.ref as TypedRevisionRef<"INTAKE_EVENT">,
          matchedItems: occasion.labels.map((entry) => ({ itemIndex: entry.index, matchBasis: matchBasis(entry.label) })),
        }
      : { kind: "ACTIVITY", source: occasion.ref as TypedRevisionRef<"ACTIVITY_EVENT">, matchBasis: matchBasis(occasion.labels[0]!.label) },
  ) as FamiliarItemEvidenceMatch[];

  const label = { text: displayLabel, language: "und" as const };
  const item =
    first.identity.kind === "INTAKE_ITEM"
      ? {
          kind: "INTAKE_ITEM" as const,
          familiarItemKey: key,
          label,
          itemKind: first.identity.itemKind,
          intakeContext: { kind: "ANY_RECORDED_INTAKE" as const },
        }
      : { kind: "ACTIVITY" as const, familiarItemKey: key, label, activityCategory: first.identity.activityCategory };
  const claim = {
    family: FAMILY,
    item,
    scope: { kind: "ORDINARY" },
    claim: { kind: "RECURRING_IN_RECORDED_OCCASIONS" },
  } as unknown as PatternClaim;

  const firstDate = localDateOf(first.instant, first.offset);
  const lastDate = localDateOf(occasions.at(-1)!.instant, occasions.at(-1)!.offset);
  const snapshotPayload = {
    family: FAMILY,
    evaluatedAt: T,
    observationWindow: { start: windowStart, end: T },
    ruleVersions: DISPOSITION.ruleVersions,
    evidenceGroups: [{ role: "SUPPORTING", revisions: occasions.map((o) => o.ref) }],
    consideredButExcluded: exclusions,
    coverage: {
      kind: "OBSERVATION_SPAN",
      distinctOccasionCount: n,
      distinctDayCount: counts.distinctDays,
      spanDays: Math.round((Date.parse(lastDate) - Date.parse(firstDate)) / 86_400_000) + 1,
      outcome: overall === "SUPPORTED" ? "ADEQUATE" : "LIMITED",
    },
    gate: { dimensions, overall },
    facts: { family: FAMILY, claimKind: "RECURRING_IN_RECORDED_OCCASIONS", familiarItemKey: key, occurrenceMatches: matches },
    limitations: overall === "SUPPORTED" ? ["UNKNOWN_NEGATIVE_STATUS"] : ["SPARSE_RECORDING", "UNKNOWN_NEGATIVE_STATUS"],
  } as unknown as PatternEvidenceSnapshotPayload;

  const sourceRoles: PatternSourceRole[] = [
    ...occasions.map((o) => ({ ref: o.ref, role: "SUPPORTING_EVIDENCE" as const })),
    ...exclusions.map((entry) => ({ ref: entry.revision, role: "CONSIDERED_EXCLUDED" as const })),
  ];

  return envelope(
    finaliseProposal(
      {
        kind: "PROPOSAL",
        family: FAMILY,
        candidateKey,
        claim,
        lifecycle,
        snapshot: { kind: "NEW", payload: snapshotPayload },
        reasonCode: "PATTERN_OBSERVATION_CREATED",
        sourceRoles,
        limitationCodes: snapshotPayload.limitations,
      },
      input.previous,
    ),
  );
}
