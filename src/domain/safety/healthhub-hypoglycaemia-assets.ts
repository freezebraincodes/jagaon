import { z } from "zod";

import { sha256DigestSchema } from "@/application/contracts/canonical-json";
import type { Sha256Digest } from "@/application/contracts/canonical-json";
import { supportedLocaleSchema } from "@/domain/patient-settings/locale";
import type { SupportedLocale } from "@/domain/patient-settings/locale";
import { decimalStringSchema } from "@/domain/health-records/measurement";
import type { DecimalString } from "@/domain/health-records/measurement";
import { createBoundedTextSchema } from "@/domain/shared/text";
import { safetyAuthoritativeSourceSchema } from "./governance";
import type { SafetyAuthoritativeSource, SafetyPolicyPackRef } from "./governance";

export const HEALTHHUB_HYPOGLYCAEMIA_SOURCE_IDS = Object.freeze([
  "HEALTHHUB_HYPOGLYCAEMIA_EN_SG",
  "HEALTHHUB_HYPOGLYCAEMIA_ZH_SG",
  "SCDF_EMERGENCY_MEDICAL_SERVICES",
] as const);

export type HealthHubHypoglycaemiaSourceId =
  (typeof HEALTHHUB_HYPOGLYCAEMIA_SOURCE_IDS)[number];

export const healthHubHypoglycaemiaSourceIdSchema = z.enum(
  HEALTHHUB_HYPOGLYCAEMIA_SOURCE_IDS,
);

export const HEALTHHUB_HYPOGLYCAEMIA_MESSAGE_IDS = Object.freeze([
  "HYPOGLYCAEMIA_CONFIRM_CAPABILITY",
  "HYPOGLYCAEMIA_15_15",
  "HYPOGLYCAEMIA_EMERGENCY_995",
] as const);

export type HealthHubHypoglycaemiaMessageId =
  (typeof HEALTHHUB_HYPOGLYCAEMIA_MESSAGE_IDS)[number];

export const healthHubHypoglycaemiaMessageIdSchema = z.enum(
  HEALTHHUB_HYPOGLYCAEMIA_MESSAGE_IDS,
);

export const healthHubHypoglycaemiaMessageAssetSchema = z.strictObject({
  messageId: healthHubHypoglycaemiaMessageIdSchema,
  locale: supportedLocaleSchema,
  textProvenance: z.enum([
    "SOURCE_LANGUAGE_PARAPHRASE",
    "UNREVIEWED_DEMO_TRANSLATION",
  ]),
  text: createBoundedTextSchema(1, 1000),
  sourceIds: z
    .tuple([healthHubHypoglycaemiaSourceIdSchema])
    .rest(healthHubHypoglycaemiaSourceIdSchema),
});

export type HealthHubHypoglycaemiaMessageAsset = {
  messageId: HealthHubHypoglycaemiaMessageId;
  locale: SupportedLocale;
  textProvenance:
    | "SOURCE_LANGUAGE_PARAPHRASE"
    | "UNREVIEWED_DEMO_TRANSLATION";
  text: string;
  sourceIds: readonly [
    HealthHubHypoglycaemiaSourceId,
    ...HealthHubHypoglycaemiaSourceId[],
  ];
};

const policyRefSchema = z.strictObject({
  packId: z.literal("sg-healthhub-hypoglycaemia"),
  version: z.literal("2026-10-01"),
});

const expectedSourceIds = new Set<string>(HEALTHHUB_HYPOGLYCAEMIA_SOURCE_IDS);
const expectedMessageKeys = new Set<string>(
  HEALTHHUB_HYPOGLYCAEMIA_MESSAGE_IDS.flatMap((messageId) => [
    `${messageId}:en-SG`,
    `${messageId}:zh-SG`,
  ]),
);

export const healthHubHypoglycaemiaDemoPolicySchema = z
  .strictObject({
    mode: z.literal("SOURCE_BOUND_HACKATHON_DEMO"),
    policyRef: policyRefSchema,
    thresholdMmolL: decimalStringSchema.refine((value) => value === "4"),
    fastActingSugarGrams: z.literal(15),
    recheckMinutes: z.literal(15),
    maxRepeatCount: z.literal(1),
    emergencyNumber: z.literal("995"),
    sources: z.array(safetyAuthoritativeSourceSchema).length(3),
    messages: z.array(healthHubHypoglycaemiaMessageAssetSchema).length(6),
    assetDigest: sha256DigestSchema,
  })
  .superRefine((policy, ctx) => {
    const sourceIds = policy.sources.map((source) => source.sourceId);
    if (
      new Set(sourceIds).size !== expectedSourceIds.size ||
      sourceIds.some((id) => !expectedSourceIds.has(id))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sources"],
        message: "Sources must contain the exact source-bound catalogue",
      });
    }

    const messageKeys = policy.messages.map(
      (message) => `${message.messageId}:${message.locale}`,
    );
    if (
      new Set(messageKeys).size !== expectedMessageKeys.size ||
      messageKeys.some((key) => !expectedMessageKeys.has(key))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["messages"],
        message: "Messages must contain one exact asset per message and locale",
      });
    }
  });

export type HealthHubHypoglycaemiaDemoPolicy = {
  mode: "SOURCE_BOUND_HACKATHON_DEMO";
  policyRef: SafetyPolicyPackRef;
  thresholdMmolL: DecimalString;
  fastActingSugarGrams: 15;
  recheckMinutes: 15;
  maxRepeatCount: 1;
  emergencyNumber: "995";
  sources: readonly SafetyAuthoritativeSource[];
  messages: readonly HealthHubHypoglycaemiaMessageAsset[];
  assetDigest: Sha256Digest;
};

const sources = Object.freeze(
  [
    {
      sourceId: "HEALTHHUB_HYPOGLYCAEMIA_EN_SG",
      publisher: "HEALTHHUB_SG",
      title: "Hypoglycaemia",
      canonicalUrl:
        "https://www.healthhub.sg/programmes/diabetes-hub/hypoglycaemia",
      retrievedAt: "2026-10-01T00:00:00.000Z",
      // SHA-256 of the captured source-evidence facts used by this demo,
      // not a claim to hash the mutable HealthHub web page in full.
      contentDigest:
        "5235f2d57acb5e738648a584fac1dc98dafcab072f4ff3787d5254e311b11b36",
    },
    {
      sourceId: "HEALTHHUB_HYPOGLYCAEMIA_ZH_SG",
      publisher: "HEALTHHUB_SG",
      title: "HealthHub Chinese hypoglycaemia guidance",
      canonicalUrl:
        "https://ch-api.healthhub.sg/api/public/content/5ad98f11b4274094ba5329b4d43559e5?v=dfea2cee",
      retrievedAt: "2026-10-01T00:00:00.000Z",
      contentDigest:
        "4eb43dac843501bffc3731e72d683b7ab52b2aa2cc21c3dbed98d1ee6178ce5f",
    },
    {
      sourceId: "SCDF_EMERGENCY_MEDICAL_SERVICES",
      publisher: "SCDF_SG",
      title: "Emergency Medical Services",
      canonicalUrl:
        "https://www.scdf.gov.sg/home/about-scdf/emergency-medical-services",
      retrievedAt: "2026-10-01T00:00:00.000Z",
      contentDigest:
        "cc3aa0c7637ddfac2d96bc281199256d267873eefc4f1d29d09ef20729d0896c",
    },
  ].map((source) => Object.freeze(safetyAuthoritativeSourceSchema.parse(source))),
);

const messages = Object.freeze(
  [
    {
      messageId: "HYPOGLYCAEMIA_CONFIRM_CAPABILITY",
      locale: "en-SG",
      textProvenance: "SOURCE_LANGUAGE_PARAPHRASE",
      text: "Before taking sugar, confirm that the person is conscious, can swallow, can act independently, and can check their blood sugar again after 15 minutes.",
      sourceIds: ["HEALTHHUB_HYPOGLYCAEMIA_EN_SG"],
    },
    {
      messageId: "HYPOGLYCAEMIA_CONFIRM_CAPABILITY",
      locale: "zh-SG",
      textProvenance: "UNREVIEWED_DEMO_TRANSLATION",
      text: "服用糖分前，请确认患者神志清醒、能够吞咽、能够自行采取行动，并且能够在 15 分钟后再次检测血糖。",
      sourceIds: ["HEALTHHUB_HYPOGLYCAEMIA_EN_SG"],
    },
    {
      messageId: "HYPOGLYCAEMIA_15_15",
      locale: "en-SG",
      textProvenance: "SOURCE_LANGUAGE_PARAPHRASE",
      text: "This demo reading is below 4 mmol/L. If the person is conscious and can swallow, take 15 g of fast-acting sugar. Recheck after 15 minutes. If the reading is still below 4 mmol/L or symptoms continue, repeat once. If it still does not improve, seek medical advice.",
      sourceIds: ["HEALTHHUB_HYPOGLYCAEMIA_EN_SG"],
    },
    {
      messageId: "HYPOGLYCAEMIA_15_15",
      locale: "zh-SG",
      textProvenance: "SOURCE_LANGUAGE_PARAPHRASE",
      text: "此演示读数低于 4 毫摩尔/升。如果患者神志清醒且能够吞咽，请摄取 15 克速效糖。监测情况 15 分钟；如果身边有家用血糖检测仪，15 分钟后再次检测。若读数仍低于 4 毫摩尔/升或症状持续，请再重复一次。若仍未改善，请立即求医。",
      sourceIds: ["HEALTHHUB_HYPOGLYCAEMIA_ZH_SG"],
    },
    {
      messageId: "HYPOGLYCAEMIA_EMERGENCY_995",
      locale: "en-SG",
      textProvenance: "SOURCE_LANGUAGE_PARAPHRASE",
      text: "Call 995 for an emergency ambulance now. Do not give food or drink to someone who is unconscious or cannot swallow.",
      sourceIds: [
        "HEALTHHUB_HYPOGLYCAEMIA_EN_SG",
        "SCDF_EMERGENCY_MEDICAL_SERVICES",
      ],
    },
    {
      messageId: "HYPOGLYCAEMIA_EMERGENCY_995",
      locale: "zh-SG",
      textProvenance: "UNREVIEWED_DEMO_TRANSLATION",
      text: "请立即拨打 995 召救护车。若患者失去意识或无法吞咽，请勿喂食或给予饮料。",
      sourceIds: [
        "HEALTHHUB_HYPOGLYCAEMIA_EN_SG",
        "SCDF_EMERGENCY_MEDICAL_SERVICES",
      ],
    },
  ].map((message) => {
    const parsed = healthHubHypoglycaemiaMessageAssetSchema.parse(message);
    return Object.freeze({
      ...parsed,
      sourceIds: Object.freeze(parsed.sourceIds),
    });
  }),
);

export const HEALTHHUB_HYPOGLYCAEMIA_DEMO_POLICY = Object.freeze({
  mode: "SOURCE_BOUND_HACKATHON_DEMO",
  policyRef: Object.freeze({
    packId: "sg-healthhub-hypoglycaemia",
    version: "2026-10-01",
  }),
  thresholdMmolL: decimalStringSchema.parse("4"),
  fastActingSugarGrams: 15,
  recheckMinutes: 15,
  maxRepeatCount: 1,
  emergencyNumber: "995",
  sources,
  messages,
  assetDigest: sha256DigestSchema.parse(
    "742ac4b841afefbf866854b1350a513167db924c1632123ec3af407c48f876a8",
  ),
}) satisfies HealthHubHypoglycaemiaDemoPolicy;
