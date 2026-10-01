import { describe, expect, it } from "vitest";

import { hashCanonicalJson } from "@/application/contracts/canonical-json";
import {
  HEALTHHUB_HYPOGLYCAEMIA_DEMO_POLICY,
  HEALTHHUB_HYPOGLYCAEMIA_MESSAGE_IDS,
  HEALTHHUB_HYPOGLYCAEMIA_SOURCE_IDS,
  healthHubHypoglycaemiaDemoPolicySchema,
  healthHubHypoglycaemiaMessageAssetSchema,
  healthHubHypoglycaemiaMessageIdSchema,
  healthHubHypoglycaemiaSourceIdSchema,
} from "./healthhub-hypoglycaemia-assets";

describe("HealthHub hypoglycaemia source-bound assets", () => {
  it("keeps exact duplicate-free source and message catalogues", () => {
    expect([...HEALTHHUB_HYPOGLYCAEMIA_SOURCE_IDS]).toEqual([
      "HEALTHHUB_HYPOGLYCAEMIA_EN_SG",
      "HEALTHHUB_HYPOGLYCAEMIA_ZH_SG",
      "SCDF_EMERGENCY_MEDICAL_SERVICES",
    ]);
    expect([...HEALTHHUB_HYPOGLYCAEMIA_MESSAGE_IDS]).toEqual([
      "HYPOGLYCAEMIA_CONFIRM_CAPABILITY",
      "HYPOGLYCAEMIA_15_15",
      "HYPOGLYCAEMIA_EMERGENCY_995",
    ]);
    expect(new Set(HEALTHHUB_HYPOGLYCAEMIA_SOURCE_IDS).size).toBe(3);
    expect(new Set(HEALTHHUB_HYPOGLYCAEMIA_MESSAGE_IDS).size).toBe(3);
  });

  it.each(HEALTHHUB_HYPOGLYCAEMIA_SOURCE_IDS)("accepts source %s", (id) => {
    expect(healthHubHypoglycaemiaSourceIdSchema.parse(id)).toBe(id);
  });

  it.each(HEALTHHUB_HYPOGLYCAEMIA_MESSAGE_IDS)("accepts message %s", (id) => {
    expect(healthHubHypoglycaemiaMessageIdSchema.parse(id)).toBe(id);
  });

  it("rejects unapproved identifiers", () => {
    expect(() => healthHubHypoglycaemiaSourceIdSchema.parse("WHO_GENERIC")).toThrow();
    expect(() => healthHubHypoglycaemiaMessageIdSchema.parse("TAKE_INSULIN")).toThrow();
  });

  it("contains the exact source-bound constants", () => {
    expect(HEALTHHUB_HYPOGLYCAEMIA_DEMO_POLICY.mode).toBe(
      "SOURCE_BOUND_HACKATHON_DEMO",
    );
    expect(HEALTHHUB_HYPOGLYCAEMIA_DEMO_POLICY.thresholdMmolL).toBe("4");
    expect(HEALTHHUB_HYPOGLYCAEMIA_DEMO_POLICY.fastActingSugarGrams).toBe(15);
    expect(HEALTHHUB_HYPOGLYCAEMIA_DEMO_POLICY.recheckMinutes).toBe(15);
    expect(HEALTHHUB_HYPOGLYCAEMIA_DEMO_POLICY.maxRepeatCount).toBe(1);
    expect(HEALTHHUB_HYPOGLYCAEMIA_DEMO_POLICY.emergencyNumber).toBe("995");
  });

  it("has one exact asset for each message and locale", () => {
    const keys = HEALTHHUB_HYPOGLYCAEMIA_DEMO_POLICY.messages.map(
      ({ messageId, locale }) => `${messageId}:${locale}`,
    );
    expect(keys).toEqual([
      "HYPOGLYCAEMIA_CONFIRM_CAPABILITY:en-SG",
      "HYPOGLYCAEMIA_CONFIRM_CAPABILITY:zh-SG",
      "HYPOGLYCAEMIA_15_15:en-SG",
      "HYPOGLYCAEMIA_15_15:zh-SG",
      "HYPOGLYCAEMIA_EMERGENCY_995:en-SG",
      "HYPOGLYCAEMIA_EMERGENCY_995:zh-SG",
    ]);
    expect(new Set(keys).size).toBe(6);
  });

  it("records honest language provenance for every message asset", () => {
    const assets = HEALTHHUB_HYPOGLYCAEMIA_DEMO_POLICY.messages;
    expect(
      assets.map(({ messageId, locale, textProvenance, sourceIds }) => ({
        messageId,
        locale,
        textProvenance,
        sourceIds: [...sourceIds],
      })),
    ).toEqual([
      {
        messageId: "HYPOGLYCAEMIA_CONFIRM_CAPABILITY",
        locale: "en-SG",
        textProvenance: "SOURCE_LANGUAGE_PARAPHRASE",
        sourceIds: ["HEALTHHUB_HYPOGLYCAEMIA_EN_SG"],
      },
      {
        messageId: "HYPOGLYCAEMIA_CONFIRM_CAPABILITY",
        locale: "zh-SG",
        textProvenance: "UNREVIEWED_DEMO_TRANSLATION",
        sourceIds: ["HEALTHHUB_HYPOGLYCAEMIA_EN_SG"],
      },
      {
        messageId: "HYPOGLYCAEMIA_15_15",
        locale: "en-SG",
        textProvenance: "SOURCE_LANGUAGE_PARAPHRASE",
        sourceIds: ["HEALTHHUB_HYPOGLYCAEMIA_EN_SG"],
      },
      {
        messageId: "HYPOGLYCAEMIA_15_15",
        locale: "zh-SG",
        textProvenance: "SOURCE_LANGUAGE_PARAPHRASE",
        sourceIds: ["HEALTHHUB_HYPOGLYCAEMIA_ZH_SG"],
      },
      {
        messageId: "HYPOGLYCAEMIA_EMERGENCY_995",
        locale: "en-SG",
        textProvenance: "SOURCE_LANGUAGE_PARAPHRASE",
        sourceIds: [
          "HEALTHHUB_HYPOGLYCAEMIA_EN_SG",
          "SCDF_EMERGENCY_MEDICAL_SERVICES",
        ],
      },
      {
        messageId: "HYPOGLYCAEMIA_EMERGENCY_995",
        locale: "zh-SG",
        textProvenance: "UNREVIEWED_DEMO_TRANSLATION",
        sourceIds: [
          "HEALTHHUB_HYPOGLYCAEMIA_EN_SG",
          "SCDF_EMERGENCY_MEDICAL_SERVICES",
        ],
      },
    ]);
  });

  it("contains no insulin or medication adjustment and no contact claim", () => {
    for (const asset of HEALTHHUB_HYPOGLYCAEMIA_DEMO_POLICY.messages) {
      expect(asset.text).not.toMatch(/insulin|medication|dose adjustment/i);
      expect(asset.text).not.toMatch(/has been contacted|已联系|已经联系/i);
    }
  });

  it("is deeply frozen", () => {
    const policy = HEALTHHUB_HYPOGLYCAEMIA_DEMO_POLICY;
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.policyRef)).toBe(true);
    expect(Object.isFrozen(policy.sources)).toBe(true);
    expect(Object.isFrozen(policy.messages)).toBe(true);
    expect(policy.sources.every(Object.isFrozen)).toBe(true);
    expect(policy.messages.every(Object.isFrozen)).toBe(true);
  });

  it("matches its pinned canonical digest", async () => {
    const { assetDigest, ...integrityPayload } =
      HEALTHHUB_HYPOGLYCAEMIA_DEMO_POLICY;
    expect(await hashCanonicalJson(integrityPayload)).toBe(assetDigest);
  });

  it("parses through strict public schemas", () => {
    expect(
      healthHubHypoglycaemiaDemoPolicySchema.parse(
        HEALTHHUB_HYPOGLYCAEMIA_DEMO_POLICY,
      ),
    ).toEqual(HEALTHHUB_HYPOGLYCAEMIA_DEMO_POLICY);
    expect(() =>
      healthHubHypoglycaemiaDemoPolicySchema.parse({
        ...HEALTHHUB_HYPOGLYCAEMIA_DEMO_POLICY,
        extra: true,
      }),
    ).toThrow();

    const first = HEALTHHUB_HYPOGLYCAEMIA_DEMO_POLICY.messages[0];
    expect(healthHubHypoglycaemiaMessageAssetSchema.parse(first)).toEqual(first);
    expect(() =>
      healthHubHypoglycaemiaMessageAssetSchema.parse({ ...first, extra: true }),
    ).toThrow();
  });
});
