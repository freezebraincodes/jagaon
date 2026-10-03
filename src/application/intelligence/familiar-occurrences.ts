import type { TypedRevisionRef } from "@/domain/shared/typed-revision-ref";
import type { IntakeTemporal, ActivityTemporal } from "@/domain/health-records/observation-temporal";
import type { ActivityCategory } from "@/domain/health-records/activity-event";
import type { PatternExclusionReason } from "@/domain/patterns";
import type {
  ResolvedActivityEvent,
  ResolvedIntakeEvent,
  SupersededRevision,
} from "@/patterns/pattern-evaluator-contracts";
import { resolveActivityIdentity, resolveIntakeIdentities } from "./familiar-identity";
import { instantMs, localDateOf, sortByInstantThenRevision } from "./metrics";

/**
 * Shared familiar-item occurrence collection used by the Packet 7A Pattern
 * and Learning evaluators: one distinct logical occasion per exact source
 * event carrying the identity, inside a half-open window, with closed
 * exclusion reasons. Missing logs produce nothing.
 */

const ELIGIBLE_PROVENANCE = new Set(["PATIENT_ENTRY", "PATIENT_RESPONSE", "IMPORT"]);

export type FamiliarOccurrence = {
  ref: TypedRevisionRef<"INTAKE_EVENT" | "ACTIVITY_EVENT">;
  instant: string;
  revisionId: string;
  offset: number;
  /** Positions and authored labels of the matched items (one for an activity). */
  labels: { index: number; label: string }[];
  identity:
    | { kind: "INTAKE_ITEM"; itemKind: "FOOD" | "DRINK" | "OTHER" }
    | { kind: "ACTIVITY"; activityCategory: ActivityCategory };
};

export type FamiliarOccurrenceCollection = {
  occasions: FamiliarOccurrence[];
  exclusions: { revision: TypedRevisionRef<never>; reason: PatternExclusionReason }[];
  considered: TypedRevisionRef<never>[];
};

/** Instant and recorded offset of an occurrence, or null when imprecise. */
export function occurrencePoint(temporal: IntakeTemporal | ActivityTemporal): { instant: string; offset: number } | null {
  const point = temporal.kind === "POINT" ? temporal.occurrence : temporal.kind === "INTERVAL" ? temporal.start : null;
  if (!point) return null;
  if (point.kind === "EXACT") return { instant: point.instantUtc, offset: point.utcOffsetMinutes };
  if (point.kind === "APPROXIMATE") return { instant: point.approximateInstantUtc, offset: point.utcOffsetMinutes };
  return null;
}

export function collectFamiliarOccurrences(input: {
  familiarItemKey: string;
  windowStart: string;
  windowEnd: string;
  intakeEvents: readonly ResolvedIntakeEvent[];
  activityEvents: readonly ResolvedActivityEvent[];
  superseded: readonly SupersededRevision[];
}): FamiliarOccurrenceCollection {
  const candidates: FamiliarOccurrence[] = [];
  const exclusions: FamiliarOccurrenceCollection["exclusions"] = [];
  const considered: TypedRevisionRef<never>[] = [];

  const consider = (
    source: ResolvedIntakeEvent | ResolvedActivityEvent,
    labels: FamiliarOccurrence["labels"],
    identity: FamiliarOccurrence["identity"],
  ) => {
    const point = occurrencePoint(source.temporal);
    if (point && (instantMs(point.instant) < instantMs(input.windowStart) || instantMs(point.instant) >= instantMs(input.windowEnd))) {
      return;
    }
    considered.push(source.ref as never);
    if (!ELIGIBLE_PROVENANCE.has(source.provenance.sourceKind)) {
      exclusions.push({ revision: source.ref as never, reason: "INELIGIBLE_PROVENANCE" });
      return;
    }
    if (!point) {
      exclusions.push({ revision: source.ref as never, reason: "INSUFFICIENT_TEMPORAL_PRECISION" });
      return;
    }
    candidates.push({
      ref: source.ref as FamiliarOccurrence["ref"],
      instant: point.instant,
      revisionId: source.ref.revisionId,
      offset: point.offset,
      labels,
      identity,
    });
  };

  for (const event of input.intakeEvents) {
    const identity = resolveIntakeIdentities(event.payload.items).find((entry) => entry.familiarItemKey === input.familiarItemKey);
    if (identity) {
      consider(
        event,
        identity.itemIndexes.map((index, i) => ({ index, label: identity.authoredLabels[i]! })),
        { kind: "INTAKE_ITEM", itemKind: identity.itemKind },
      );
    }
  }
  for (const event of input.activityEvents) {
    const identity = resolveActivityIdentity(event.payload);
    if (identity.familiarItemKey === input.familiarItemKey) {
      consider(event, [{ index: 0, label: identity.authoredLabel }], { kind: "ACTIVITY", activityCategory: identity.activityCategory });
    }
  }

  // Copied entries for the same occurrence count once.
  const seen = new Set<number>();
  const occasions: FamiliarOccurrence[] = [];
  for (const candidate of sortByInstantThenRevision(candidates)) {
    const instantKey = instantMs(candidate.instant);
    if (seen.has(instantKey)) exclusions.push({ revision: candidate.ref as never, reason: "DUPLICATE_LOGICAL_OCCASION" });
    else {
      seen.add(instantKey);
      occasions.push(candidate);
    }
  }
  const consideredIds = new Set(considered.map((ref) => (ref as TypedRevisionRef<"INTAKE_EVENT">).recordId));
  for (const entry of input.superseded) {
    if (consideredIds.has(entry.ref.recordId)) {
      exclusions.push({ revision: entry.ref as never, reason: "CORRECTED_AWAY" });
      considered.push(entry.ref as never);
    }
  }
  return { occasions, exclusions, considered };
}

export function distinctOccurrenceDays(occasions: readonly FamiliarOccurrence[]): number {
  return new Set(occasions.map((o) => localDateOf(o.instant, o.offset))).size;
}

/** True when some half-open 7-day span holds the required occasions and days. */
export function hasSpanWithin(
  occasions: readonly FamiliarOccurrence[],
  spanMs: number,
  minimumOccasions: number,
  minimumDays: number,
): boolean {
  return occasions.some((start) => {
    const span = occasions.filter(
      (o) => instantMs(o.instant) >= instantMs(start.instant) && instantMs(o.instant) < instantMs(start.instant) + spanMs,
    );
    return span.length >= minimumOccasions && distinctOccurrenceDays(span) >= minimumDays;
  });
}
