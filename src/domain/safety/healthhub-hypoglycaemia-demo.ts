import { z } from "zod";

import { sha256DigestSchema } from "@/application/contracts/canonical-json";
import { glucoseReadingPayloadSchema } from "@/domain/health-records/glucose-reading";
import { readingTemporalSchema } from "@/domain/health-records/reading-temporal";
import { symptomReportPayloadSchema } from "@/domain/health-records/symptom-report";
import { symptomTemporalSchema } from "@/domain/health-records/observation-temporal";
import { createDataValidityAssessmentSchema } from "@/domain/health-records/data-validity-assessment";
import { supportedLocaleSchema } from "@/domain/patient-settings/locale";
import { revisionIdSchema } from "@/domain/shared/identifiers";
import { instantSchema } from "@/domain/shared/time";
import {
  HEALTHHUB_HYPOGLYCAEMIA_DEMO_POLICY,
  healthHubHypoglycaemiaSourceIdSchema,
} from "./healthhub-hypoglycaemia-assets";

export const HEALTHHUB_HYPOGLYCAEMIA_VALIDITY_REASON_CODES = Object.freeze([
  "CURRENT_VALIDATED",
  "HISTORICAL",
  "OCCURRENCE_UNKNOWN",
  "MEASUREMENT_UNCERTAINTY",
  "UNSUPPORTED_UNIT",
  "UNUSABLE_VALUE",
  "SOURCE_NOT_APPLICABLE",
] as const);

export type HealthHubHypoglycaemiaValidityReasonCode =
  (typeof HEALTHHUB_HYPOGLYCAEMIA_VALIDITY_REASON_CODES)[number];

export const healthHubHypoglycaemiaValidityReasonCodeSchema = z.enum(
  HEALTHHUB_HYPOGLYCAEMIA_VALIDITY_REASON_CODES,
);

export const HEALTHHUB_HYPOGLYCAEMIA_NO_GUIDANCE_REASONS = Object.freeze([
  "READING_NOT_ROUTABLE_CURRENT",
  "READING_NOT_COMPARABLE",
  "READING_NOT_LOW",
] as const);

export type HealthHubHypoglycaemiaNoGuidanceReason =
  (typeof HEALTHHUB_HYPOGLYCAEMIA_NO_GUIDANCE_REASONS)[number];

export const healthHubHypoglycaemiaNoGuidanceReasonSchema = z.enum(
  HEALTHHUB_HYPOGLYCAEMIA_NO_GUIDANCE_REASONS,
);

const validitySchema = createDataValidityAssessmentSchema(
  healthHubHypoglycaemiaValidityReasonCodeSchema,
);

const glucoseEvidenceSchema = z.strictObject({
  payload: glucoseReadingPayloadSchema,
  temporal: readingTemporalSchema,
  validity: validitySchema,
});

const symptomEvidenceSchema = z.strictObject({
  payload: symptomReportPayloadSchema,
  temporal: symptomTemporalSchema,
  validity: validitySchema,
});

export const healthHubHypoglycaemiaDemoInputSchema = z
  .strictObject({
    releaseProfile: z.literal("HACKATHON_DEMO"),
    evaluatedAt: instantSchema,
    locale: supportedLocaleSchema,
    glucose: glucoseEvidenceSchema,
    symptom: symptomEvidenceSchema.optional(),
  })
  .superRefine((input, ctx) => {
    if (input.glucose.validity.evaluatedAt !== input.evaluatedAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["glucose", "validity", "evaluatedAt"],
        message: "Glucose validity must belong to this evaluation",
      });
    }
    if (
      input.symptom !== undefined &&
      input.symptom.validity.evaluatedAt !== input.evaluatedAt
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["symptom", "validity", "evaluatedAt"],
        message: "Symptom validity must belong to this evaluation",
      });
    }
  });

export type HealthHubHypoglycaemiaDemoInput = z.infer<
  typeof healthHubHypoglycaemiaDemoInputSchema
>;

const triggeringRevisionIdsSchema = z
  .tuple([revisionIdSchema])
  .rest(revisionIdSchema)
  .superRefine((revisionIds, ctx) => {
    if (new Set(revisionIds).size !== revisionIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Triggering revision IDs must be unique",
      });
    }
  });

const noGuidanceReasonsSchema = z
  .tuple([healthHubHypoglycaemiaNoGuidanceReasonSchema])
  .rest(healthHubHypoglycaemiaNoGuidanceReasonSchema)
  .superRefine((reasons, ctx) => {
    if (new Set(reasons).size !== reasons.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "No-guidance reasons must be unique",
      });
    }
  });

const commonDecisionShape = {
  mode: z.literal("SOURCE_BOUND_HACKATHON_DEMO"),
  evaluatedAt: instantSchema,
  locale: supportedLocaleSchema,
  policyRef: z.strictObject({
    packId: z.literal("sg-healthhub-hypoglycaemia"),
    version: z.literal("2026-10-01"),
  }),
  assetDigest: sha256DigestSchema.refine(
    (digest) => digest === HEALTHHUB_HYPOGLYCAEMIA_DEMO_POLICY.assetDigest,
  ),
  triggeringRevisionIds: triggeringRevisionIdsSchema,
};

export const healthHubHypoglycaemiaDemoDecisionSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      ...commonDecisionShape,
      kind: z.literal("NO_DEMO_GUIDANCE"),
      reasonCodes: noGuidanceReasonsSchema,
    }),
    z.strictObject({
      ...commonDecisionShape,
      kind: z.literal("CONFIRM_CAPABILITY"),
      messageId: z.literal("HYPOGLYCAEMIA_CONFIRM_CAPABILITY"),
      sourceIds: z
        .tuple([healthHubHypoglycaemiaSourceIdSchema])
        .rest(healthHubHypoglycaemiaSourceIdSchema),
    }),
    z.strictObject({
      ...commonDecisionShape,
      kind: z.literal("RELAY_15_15_GUIDANCE"),
      messageId: z.literal("HYPOGLYCAEMIA_15_15"),
      sourceIds: z
        .tuple([healthHubHypoglycaemiaSourceIdSchema])
        .rest(healthHubHypoglycaemiaSourceIdSchema),
      thresholdMmolL: z.literal("4"),
      fastActingSugarGrams: z.literal(15),
      recheckMinutes: z.literal(15),
      maxRepeatCount: z.literal(1),
    }),
    z.strictObject({
      ...commonDecisionShape,
      kind: z.literal("RELAY_EMERGENCY_ASSISTANCE"),
      messageId: z.literal("HYPOGLYCAEMIA_EMERGENCY_995"),
      sourceIds: z
        .tuple([healthHubHypoglycaemiaSourceIdSchema])
        .rest(healthHubHypoglycaemiaSourceIdSchema),
      emergencyNumber: z.literal("995"),
    }),
  ])
  .superRefine((decision, ctx) => {
    if (decision.kind === "NO_DEMO_GUIDANCE") return;

    const message = HEALTHHUB_HYPOGLYCAEMIA_DEMO_POLICY.messages.find(
      (candidate) =>
        candidate.messageId === decision.messageId &&
        candidate.locale === decision.locale,
    );
    if (message === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["messageId"],
        message: "Message must exist in the source-bound policy catalogue",
      });
      return;
    }
    const expectedSources = message.sourceIds;

    if (
      decision.sourceIds.length !== expectedSources.length ||
      decision.sourceIds.some((sourceId, index) => sourceId !== expectedSources[index])
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sourceIds"],
        message: "Source IDs must match the selected source-bound message",
      });
    }
  });

export type HealthHubHypoglycaemiaDemoDecision = z.infer<
  typeof healthHubHypoglycaemiaDemoDecisionSchema
>;
