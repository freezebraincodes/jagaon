import { describe, expect, it } from "vitest";

import {
  HEALTHHUB_HYPOGLYCAEMIA_NO_GUIDANCE_REASONS,
  HEALTHHUB_HYPOGLYCAEMIA_VALIDITY_REASON_CODES,
  healthHubHypoglycaemiaDemoDecisionSchema,
  healthHubHypoglycaemiaDemoInputSchema,
  healthHubHypoglycaemiaValidityReasonCodeSchema,
} from "./healthhub-hypoglycaemia-demo";
import { HEALTHHUB_HYPOGLYCAEMIA_DEMO_POLICY } from "./healthhub-hypoglycaemia-assets";

const GLUCOSE_REVISION = "11111111-1111-4111-8111-111111111111";
const SYMPTOM_REVISION = "22222222-2222-4222-8222-222222222222";
const EVALUATED_AT = "2026-10-01T02:00:00.000Z";

function validInput() {
  return {
    releaseProfile: "HACKATHON_DEMO" as const,
    evaluatedAt: EVALUATED_AT,
    locale: "en-SG" as const,
    glucose: {
      payload: {
        measurement: {
          enteredValue: "3",
          enteredUnit: "MMOL_L" as const,
          normalization: null,
        },
        measurementMethod: "FINGERSTICK_METER" as const,
        context: { kind: "UNSPECIFIED" as const },
      },
      temporal: {
        kind: "POINT" as const,
        occurrence: {
          kind: "EXACT" as const,
          instantUtc: "2026-10-01T01:59:00.000Z",
          timeZoneId: "Asia/Singapore",
          utcOffsetMinutes: 480,
        },
      },
      validity: {
        sourceRevisionId: GLUCOSE_REVISION,
        evaluatedAt: EVALUATED_AT,
        ruleVersion: "healthhub-demo-validity-v1",
        outcome: "ROUTABLE_CURRENT" as const,
        reasonCodes: ["CURRENT_VALIDATED" as const],
      },
    },
  };
}

function validSymptomEvidence() {
  return {
    payload: {
      reportKind: "PRESENT" as const,
      symptoms: [
        {
          code: "SHAKY" as const,
          severity: "MILD" as const,
        },
      ] as const,
      capabilities: {
        canCheckGlucoseNow: "YES" as const,
        canSwallow: "YES" as const,
        canActIndependently: "YES" as const,
      },
    },
    temporal: {
      kind: "POINT" as const,
      occurrence: {
        kind: "EXACT" as const,
        instantUtc: "2026-10-01T01:59:30.000Z",
        timeZoneId: "Asia/Singapore",
        utcOffsetMinutes: 480,
      },
    },
    validity: {
      sourceRevisionId: SYMPTOM_REVISION,
      evaluatedAt: EVALUATED_AT,
      ruleVersion: "healthhub-demo-validity-v1",
      outcome: "ROUTABLE_CURRENT" as const,
      reasonCodes: ["CURRENT_VALIDATED" as const],
    },
  };
}

const commonDecision = {
  mode: "SOURCE_BOUND_HACKATHON_DEMO" as const,
  evaluatedAt: EVALUATED_AT,
  locale: "en-SG" as const,
  policyRef: {
    packId: "sg-healthhub-hypoglycaemia" as const,
    version: "2026-10-01" as const,
  },
  assetDigest: HEALTHHUB_HYPOGLYCAEMIA_DEMO_POLICY.assetDigest,
  triggeringRevisionIds: [GLUCOSE_REVISION],
};

describe("HealthHub hypoglycaemia demo contracts", () => {
  it("keeps exact validity and no-guidance catalogues", () => {
    expect([...HEALTHHUB_HYPOGLYCAEMIA_VALIDITY_REASON_CODES]).toEqual([
      "CURRENT_VALIDATED",
      "HISTORICAL",
      "OCCURRENCE_UNKNOWN",
      "MEASUREMENT_UNCERTAINTY",
      "UNSUPPORTED_UNIT",
      "UNUSABLE_VALUE",
      "SOURCE_NOT_APPLICABLE",
    ]);
    expect([...HEALTHHUB_HYPOGLYCAEMIA_NO_GUIDANCE_REASONS]).toEqual([
      "READING_NOT_ROUTABLE_CURRENT",
      "READING_NOT_COMPARABLE",
      "READING_NOT_LOW",
    ]);
  });

  it.each(HEALTHHUB_HYPOGLYCAEMIA_VALIDITY_REASON_CODES)(
    "accepts reason %s",
    (reason) => {
      expect(healthHubHypoglycaemiaValidityReasonCodeSchema.parse(reason)).toBe(
        reason,
      );
    },
  );

  it("parses a complete strict input", () => {
    const input = { ...validInput(), symptom: validSymptomEvidence() };
    expect(healthHubHypoglycaemiaDemoInputSchema.parse(input)).toEqual(input);
    expect(() =>
      healthHubHypoglycaemiaDemoInputSchema.parse({ ...input, extra: true }),
    ).toThrow();
    expect(() =>
      healthHubHypoglycaemiaDemoInputSchema.parse({
        ...input,
        releaseProfile: "PATIENT_RELEASE",
      }),
    ).toThrow();
  });

  it("rejects unknown keys in nested evidence", () => {
    const input = validInput();
    expect(() =>
      healthHubHypoglycaemiaDemoInputSchema.parse({
        ...input,
        glucose: { ...input.glucose, extra: true },
      }),
    ).toThrow();
  });

  it("parses NO_DEMO_GUIDANCE without rendered text", () => {
    const decision = {
      ...commonDecision,
      kind: "NO_DEMO_GUIDANCE" as const,
      reasonCodes: ["READING_NOT_LOW" as const],
    };
    expect(healthHubHypoglycaemiaDemoDecisionSchema.parse(decision)).toEqual(
      decision,
    );
    expect(() =>
      healthHubHypoglycaemiaDemoDecisionSchema.parse({
        ...decision,
        renderedText: "Looks fine",
      }),
    ).toThrow();
  });

  it("parses CONFIRM_CAPABILITY with only its approved message", () => {
    const decision = {
      ...commonDecision,
      kind: "CONFIRM_CAPABILITY" as const,
      messageId: "HYPOGLYCAEMIA_CONFIRM_CAPABILITY" as const,
      sourceIds: ["HEALTHHUB_HYPOGLYCAEMIA_EN_SG" as const],
    };
    expect(healthHubHypoglycaemiaDemoDecisionSchema.parse(decision)).toEqual(
      decision,
    );
    expect(() =>
      healthHubHypoglycaemiaDemoDecisionSchema.parse({
        ...decision,
        messageId: "HYPOGLYCAEMIA_15_15",
      }),
    ).toThrow();
  });

  it("parses RELAY_15_15_GUIDANCE with exact structured values", () => {
    const decision = {
      ...commonDecision,
      kind: "RELAY_15_15_GUIDANCE" as const,
      messageId: "HYPOGLYCAEMIA_15_15" as const,
      sourceIds: ["HEALTHHUB_HYPOGLYCAEMIA_EN_SG" as const],
      thresholdMmolL: "4",
      fastActingSugarGrams: 15 as const,
      recheckMinutes: 15 as const,
      maxRepeatCount: 1 as const,
    };
    expect(healthHubHypoglycaemiaDemoDecisionSchema.parse(decision)).toEqual(
      decision,
    );
    expect(() =>
      healthHubHypoglycaemiaDemoDecisionSchema.parse({
        ...decision,
        fastActingSugarGrams: 20,
      }),
    ).toThrow();
  });

  it("parses RELAY_EMERGENCY_ASSISTANCE without a contact claim", () => {
    const decision = {
      ...commonDecision,
      triggeringRevisionIds: [GLUCOSE_REVISION, SYMPTOM_REVISION],
      kind: "RELAY_EMERGENCY_ASSISTANCE" as const,
      messageId: "HYPOGLYCAEMIA_EMERGENCY_995" as const,
      sourceIds: [
        "HEALTHHUB_HYPOGLYCAEMIA_EN_SG" as const,
        "SCDF_EMERGENCY_MEDICAL_SERVICES" as const,
      ],
      emergencyNumber: "995" as const,
    };
    expect(healthHubHypoglycaemiaDemoDecisionSchema.parse(decision)).toEqual(
      decision,
    );
    expect(() =>
      healthHubHypoglycaemiaDemoDecisionSchema.parse({
        ...decision,
        contacted: true,
      }),
    ).toThrow();
  });

  it("requires non-empty unique triggering revisions", () => {
    const decision = {
      ...commonDecision,
      kind: "NO_DEMO_GUIDANCE" as const,
      reasonCodes: ["READING_NOT_LOW" as const],
    };
    expect(() =>
      healthHubHypoglycaemiaDemoDecisionSchema.parse({
        ...decision,
        triggeringRevisionIds: [],
      }),
    ).toThrow();
    expect(() =>
      healthHubHypoglycaemiaDemoDecisionSchema.parse({
        ...decision,
        triggeringRevisionIds: [GLUCOSE_REVISION, GLUCOSE_REVISION],
      }),
    ).toThrow();
  });

  it("rejects unsupported locales and malformed revision IDs", () => {
    const decision = {
      ...commonDecision,
      kind: "NO_DEMO_GUIDANCE" as const,
      reasonCodes: ["READING_NOT_LOW" as const],
    };
    expect(() =>
      healthHubHypoglycaemiaDemoDecisionSchema.parse({
        ...decision,
        locale: "en-US",
      }),
    ).toThrow();
    expect(() =>
      healthHubHypoglycaemiaDemoDecisionSchema.parse({
        ...decision,
        triggeringRevisionIds: ["not-a-revision"],
      }),
    ).toThrow();
  });
});
