import { describe, expect, it } from "vitest";
import * as safetyDomain from "./index";

import type {
  HealthHubHypoglycaemiaDemoDecision,
  HealthHubHypoglycaemiaDemoInput,
  HealthHubHypoglycaemiaDemoPolicy,
  HealthHubHypoglycaemiaMessageAsset,
  HealthHubHypoglycaemiaMessageId,
  HealthHubHypoglycaemiaNoGuidanceReason,
  HealthHubHypoglycaemiaSourceId,
  HealthHubHypoglycaemiaValidityReasonCode,
  PatientUseSafetyAvailability,
  SafetyAuthoritativeSource,
  SafetyPolicyPackLifecycleState,
  SafetyPolicyPackRef,
  SafetyReviewEvidence,
} from "./index";

const APPROVED_RUNTIME_EXPORTS = [
  "HEALTHHUB_HYPOGLYCAEMIA_DEMO_POLICY",
  "HEALTHHUB_HYPOGLYCAEMIA_MESSAGE_IDS",
  "HEALTHHUB_HYPOGLYCAEMIA_NO_GUIDANCE_REASONS",
  "HEALTHHUB_HYPOGLYCAEMIA_SOURCE_IDS",
  "HEALTHHUB_HYPOGLYCAEMIA_VALIDITY_REASON_CODES",
  "PATIENT_USE_SAFETY_AVAILABILITY",
  "SAFETY_POLICY_PACK_LIFECYCLE_STATES",
  "healthHubHypoglycaemiaDemoDecisionSchema",
  "healthHubHypoglycaemiaDemoInputSchema",
  "healthHubHypoglycaemiaDemoPolicySchema",
  "healthHubHypoglycaemiaMessageAssetSchema",
  "healthHubHypoglycaemiaMessageIdSchema",
  "healthHubHypoglycaemiaNoGuidanceReasonSchema",
  "healthHubHypoglycaemiaSourceIdSchema",
  "healthHubHypoglycaemiaValidityReasonCodeSchema",
  "patientUseSafetyAvailabilitySchema",
  "safetyAuthoritativeSourceSchema",
  "safetyPolicyPackLifecycleStateSchema",
  "safetyPolicyPackRefSchema",
  "safetyReviewEvidenceSchema",
].sort();

describe("patient Safety domain barrel", () => {
  it("exports exactly the approved Packet 5A runtime surface", () => {
    expect(Object.keys(safetyDomain).sort()).toEqual(APPROVED_RUNTIME_EXPORTS);
  });

  it("keeps approved public types usable", () => {
    const lifecycle: SafetyPolicyPackLifecycleState = "DRAFT";
    const ref: SafetyPolicyPackRef = {
      packId: "sg-healthhub-hypoglycaemia",
      version: "2026-10-01",
    };
    const availability: PatientUseSafetyAvailability =
      safetyDomain.PATIENT_USE_SAFETY_AVAILABILITY;
    const types: [
      SafetyAuthoritativeSource?,
      SafetyReviewEvidence?,
      HealthHubHypoglycaemiaDemoPolicy?,
      HealthHubHypoglycaemiaMessageAsset?,
      HealthHubHypoglycaemiaMessageId?,
      HealthHubHypoglycaemiaSourceId?,
      HealthHubHypoglycaemiaValidityReasonCode?,
      HealthHubHypoglycaemiaNoGuidanceReason?,
      HealthHubHypoglycaemiaDemoInput?,
      HealthHubHypoglycaemiaDemoDecision?,
    ] = [];
    expect([lifecycle, ref.packId, availability.kind, types.length]).toEqual([
      "DRAFT",
      "sg-healthhub-hypoglycaemia",
      "UNAVAILABLE",
      0,
    ]);
  });
});
