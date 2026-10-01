import { z } from "zod";

import { sha256DigestSchema } from "@/application/contracts/canonical-json";
import type { Sha256Digest } from "@/application/contracts/canonical-json";
import { createBoundedTextSchema } from "@/domain/shared/text";
import { instantSchema } from "@/domain/shared/time";
import type { Instant } from "@/domain/shared/time";

export const SAFETY_POLICY_PACK_LIFECYCLE_STATES = Object.freeze([
  "DRAFT",
  "IN_REVIEW",
  "APPROVED",
  "ACTIVE",
  "SUPERSEDED",
  "WITHDRAWN",
  "EXPIRED",
] as const);

export type SafetyPolicyPackLifecycleState =
  (typeof SAFETY_POLICY_PACK_LIFECYCLE_STATES)[number];

export const safetyPolicyPackLifecycleStateSchema = z.enum(
  SAFETY_POLICY_PACK_LIFECYCLE_STATES,
);

const safetyPolicyPackIdSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(100);

const safetyPolicyPackVersionSchema = z
  .string()
  .regex(/^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/)
  .max(64);

export const safetyPolicyPackRefSchema = z.strictObject({
  packId: safetyPolicyPackIdSchema,
  version: safetyPolicyPackVersionSchema,
});

export type SafetyPolicyPackRef = z.infer<typeof safetyPolicyPackRefSchema>;

export const safetyAuthoritativeSourceSchema = z.strictObject({
  sourceId: z.string().regex(/^[A-Z0-9]+(?:_[A-Z0-9]+)*$/).max(100),
  publisher: z.enum(["HEALTHHUB_SG", "SCDF_SG"]),
  title: createBoundedTextSchema(1, 200),
  canonicalUrl: z.string().url(),
  retrievedAt: instantSchema,
  contentDigest: sha256DigestSchema,
});

export type SafetyAuthoritativeSource = {
  sourceId: string;
  publisher: "HEALTHHUB_SG" | "SCDF_SG";
  title: string;
  canonicalUrl: string;
  retrievedAt: Instant;
  contentDigest: Sha256Digest;
};

export const safetyReviewEvidenceSchema = z.strictObject({
  reviewKind: z.enum([
    "SOURCE_TRANSCRIPTION",
    "CLINICAL",
    "LINGUISTIC",
    "PRODUCT",
    "LEGAL",
    "REGULATORY",
  ]),
  scope: z.enum(["SYNTHETIC_HACKATHON_DEMO_ONLY", "PATIENT_USE"]),
  reviewerReference: createBoundedTextSchema(1, 100),
  reviewedAt: instantSchema,
  artifactDigest: sha256DigestSchema,
  decision: z.enum(["VERIFIED_AGAINST_SOURCE", "APPROVED", "REJECTED"]),
});

export type SafetyReviewEvidence = z.infer<typeof safetyReviewEvidenceSchema>;

export const patientUseSafetyAvailabilitySchema = z.strictObject({
  kind: z.literal("UNAVAILABLE"),
  reason: z.literal("CLINICAL_ASSETS_NOT_APPROVED"),
});

export type PatientUseSafetyAvailability = z.infer<
  typeof patientUseSafetyAvailabilitySchema
>;

export const PATIENT_USE_SAFETY_AVAILABILITY: PatientUseSafetyAvailability =
  Object.freeze({
    kind: "UNAVAILABLE",
    reason: "CLINICAL_ASSETS_NOT_APPROVED",
  });
