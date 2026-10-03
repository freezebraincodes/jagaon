import {
  INQUIRY_DEFINITION_REGISTRY,
  INQUIRY_SURFACE_DISPOSITIONS,
  type InquiryDefinitionDisposition,
  type InquiryPresentationSurface,
} from "@/domain/inquiry/inquiry-registry";
import type { Instant } from "@/domain/shared/time";
import type { SnoozeChoice } from "@/domain/inquiry/inquiry-registry";
import type { InquiryResponseSafetyDisposition } from "@/domain/inquiry/inquiry-response";

/**
 * Packet 8 compile-time Inquiry capability manifest (deterministic-engine
 * Sections 1.1, 13–15; domain Section 9.11).
 *
 * The ordinary-journal Inquiry capability set structurally omits Safety: the
 * only representable Safety capability is `ABSENT`, so there is no evaluator,
 * policy pack, handler, route, effect or public export to call. Every budget,
 * expiry and reconsideration number used by the engine is governed here.
 */

type SafetyCapability = { kind: "ABSENT"; reason: "INQUIRY_SAFETY_CAPABILITY_ABSENT" };

export type InquiryCapabilityManifest = {
  manifestId: string;
  manifestVersion: string;
  profile: "HACKATHON_DEMO";
  safety: SafetyCapability;
  definitions: Readonly<Record<string, InquiryDefinitionDisposition>>;
  surfaces: Readonly<Record<InquiryPresentationSurface, InquiryDefinitionDisposition>>;
  proactiveOrdinaryPush: { kind: "DISABLED_PRODUCT_SCOPE" };
  budget: {
    version: string;
    concurrentPresentedNonSafety: number;
    contextualPlusOpportunistic: { per24Hours: number; per7Days: number };
    opportunistic: { per24Hours: number; per7Days: number };
    minimumNonInlineIntervalMinutes: number;
    inlinePerActiveTask: number;
    contextualPerView: number;
  };
  reconsideration: {
    version: string;
    notSureDays: number;
    dismissedDays: number;
    expiredDays: number;
    snoozeDays: Readonly<Record<SnoozeChoice, number>>;
  };
  presentationExpiry: { inlineMinutes: number; contextualDays: number; homeCardHours: number };
  medicationOccasionBarrier: {
    answerableDays: number;
    factualCountWindowDays: number;
    recentOccasionDays: number;
    homeTimeZoneId: string;
    homeUtcOffsetMinutes: number;
  };
};

export type { SnoozeChoice };

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

export const INQUIRY_CAPABILITY_MANIFEST: InquiryCapabilityManifest = deepFreeze({
  manifestId: "jagaon-hackathon-inquiry",
  manifestVersion: "8.1",
  profile: "HACKATHON_DEMO",
  safety: { kind: "ABSENT", reason: "INQUIRY_SAFETY_CAPABILITY_ABSENT" },
  definitions: Object.fromEntries(
    INQUIRY_DEFINITION_REGISTRY.map((definition) => [definition.definitionKey, { ...definition.disposition }]),
  ),
  surfaces: { ...INQUIRY_SURFACE_DISPOSITIONS },
  proactiveOrdinaryPush: { kind: "DISABLED_PRODUCT_SCOPE" },
  budget: {
    version: "inquiry-budget.1",
    concurrentPresentedNonSafety: 1,
    contextualPlusOpportunistic: { per24Hours: 2, per7Days: 5 },
    opportunistic: { per24Hours: 1, per7Days: 3 },
    minimumNonInlineIntervalMinutes: 240,
    inlinePerActiveTask: 2,
    contextualPerView: 1,
  },
  reconsideration: {
    version: "inquiry-reconsideration.1",
    notSureDays: 14,
    dismissedDays: 30,
    expiredDays: 14,
    snoozeDays: { TOMORROW: 1, THREE_DAYS: 3, NEXT_WEEK: 7 },
  },
  presentationExpiry: { inlineMinutes: 30, contextualDays: 7, homeCardHours: 48 },
  medicationOccasionBarrier: {
    answerableDays: 14,
    factualCountWindowDays: 14,
    recentOccasionDays: 2,
    homeTimeZoneId: "Asia/Singapore",
    homeUtcOffsetMinutes: 480,
  },
});

/**
 * Resolves the capability-discriminated Safety disposition of an accepted
 * response. The Packet 8 manifest can only describe Safety as absent, so this
 * returns `NOT_APPLICABLE`; it never evaluates, routes or references Safety.
 */
export function resolveInquirySafetyDisposition(
  manifest: InquiryCapabilityManifest,
  determinedAt: Instant,
): Extract<InquiryResponseSafetyDisposition, { applicability: "NOT_APPLICABLE" }> {
  // `safety.kind` has a single representable value; a Safety-enabled set would
  // need a separately governed manifest type and is not compiled here.
  const absent: "ABSENT" = manifest.safety.kind;
  void absent;
  return {
    applicability: "NOT_APPLICABLE",
    determinedAt,
    capabilityManifestVersion: manifest.manifestVersion,
    reason: manifest.safety.reason,
  };
}
