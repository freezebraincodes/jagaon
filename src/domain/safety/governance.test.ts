import { describe, expect, it } from "vitest";

import {
  PATIENT_USE_SAFETY_AVAILABILITY,
  SAFETY_POLICY_PACK_LIFECYCLE_STATES,
  patientUseSafetyAvailabilitySchema,
  safetyAuthoritativeSourceSchema,
  safetyPolicyPackLifecycleStateSchema,
  safetyPolicyPackRefSchema,
  safetyReviewEvidenceSchema,
} from "./governance";

const DIGEST = "a".repeat(64);

describe("Safety governance", () => {
  it("keeps the exact lifecycle catalogue", () => {
    expect([...SAFETY_POLICY_PACK_LIFECYCLE_STATES]).toEqual([
      "DRAFT",
      "IN_REVIEW",
      "APPROVED",
      "ACTIVE",
      "SUPERSEDED",
      "WITHDRAWN",
      "EXPIRED",
    ]);
    expect(new Set(SAFETY_POLICY_PACK_LIFECYCLE_STATES).size).toBe(7);
  });

  it.each(SAFETY_POLICY_PACK_LIFECYCLE_STATES)("accepts %s", (state) => {
    expect(safetyPolicyPackLifecycleStateSchema.parse(state)).toBe(state);
  });

  it("rejects unsupported lifecycle states", () => {
    expect(() => safetyPolicyPackLifecycleStateSchema.parse("DEMO")).toThrow();
  });

  it("parses a strict policy-pack reference", () => {
    const ref = {
      packId: "sg-healthhub-hypoglycaemia",
      version: "2026-10-01",
    };
    expect(safetyPolicyPackRefSchema.parse(ref)).toEqual(ref);
    expect(() => safetyPolicyPackRefSchema.parse({ ...ref, extra: true })).toThrow();
    expect(() => safetyPolicyPackRefSchema.parse({ ...ref, version: " 1 " })).toThrow();
  });

  it("parses strict authoritative-source metadata", () => {
    const source = {
      sourceId: "HEALTHHUB_HYPOGLYCAEMIA_EN_SG",
      publisher: "HEALTHHUB_SG",
      title: "Hypoglycaemia",
      canonicalUrl: "https://www.healthhub.sg/programmes/diabetes-hub/hypoglycaemia",
      retrievedAt: "2026-10-01T00:00:00.000Z",
      contentDigest: DIGEST,
    };
    expect(safetyAuthoritativeSourceSchema.parse(source)).toEqual(source);
    expect(() => safetyAuthoritativeSourceSchema.parse({ ...source, extra: true })).toThrow();
  });

  it("parses strict scoped review evidence without promoting lifecycle", () => {
    const evidence = {
      reviewKind: "SOURCE_TRANSCRIPTION",
      scope: "SYNTHETIC_HACKATHON_DEMO_ONLY",
      reviewerReference: "jagaon-software-team",
      reviewedAt: "2026-10-01T00:00:00.000Z",
      artifactDigest: DIGEST,
      decision: "VERIFIED_AGAINST_SOURCE",
    };
    expect(safetyReviewEvidenceSchema.parse(evidence)).toEqual(evidence);
    expect(() => safetyReviewEvidenceSchema.parse({ ...evidence, lifecycle: "ACTIVE" })).toThrow();
  });

  it("keeps patient-use Safety unavailable", () => {
    expect(PATIENT_USE_SAFETY_AVAILABILITY).toEqual({
      kind: "UNAVAILABLE",
      reason: "CLINICAL_ASSETS_NOT_APPROVED",
    });
    expect(
      patientUseSafetyAvailabilitySchema.parse(PATIENT_USE_SAFETY_AVAILABILITY),
    ).toEqual(PATIENT_USE_SAFETY_AVAILABILITY);
    expect(() =>
      patientUseSafetyAvailabilitySchema.parse({ kind: "AVAILABLE" }),
    ).toThrow();
  });
});
