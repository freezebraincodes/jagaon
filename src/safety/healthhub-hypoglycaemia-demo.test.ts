import { describe, expect, it } from "vitest";

import {
  healthHubHypoglycaemiaDemoInputSchema,
  type HealthHubHypoglycaemiaDemoInput,
} from "@/domain/safety/healthhub-hypoglycaemia-demo";
import {
  evaluateHealthHubHypoglycaemiaDemo,
  resolveHealthHubHypoglycaemiaDemoMessage,
} from "./healthhub-hypoglycaemia-demo";

const GLUCOSE_REVISION = "11111111-1111-4111-8111-111111111111";
const SYMPTOM_REVISION = "22222222-2222-4222-8222-222222222222";
const EVALUATED_AT = "2026-10-01T02:00:00.000Z";

function input(
  overrides: {
    value?: string;
    enteredUnit?: "MMOL_L" | "MG_DL";
    canonicalValue?: string | null;
    glucoseOutcome?:
      | "ROUTABLE_CURRENT"
      | "ROUTABLE_HISTORICAL"
      | "CONFIRM_REQUIRED"
      | "MEASUREMENT_UNCERTAINTY"
      | "UNUSABLE";
    locale?: "en-SG" | "zh-SG";
    symptom?: unknown;
  } = {},
): HealthHubHypoglycaemiaDemoInput {
  const enteredUnit = overrides.enteredUnit ?? "MMOL_L";
  const canonicalValue = overrides.canonicalValue;

  return healthHubHypoglycaemiaDemoInputSchema.parse({
    releaseProfile: "HACKATHON_DEMO",
    evaluatedAt: EVALUATED_AT,
    locale: overrides.locale ?? "en-SG",
    glucose: {
      payload: {
        measurement: {
          enteredValue: overrides.value ?? "3",
          enteredUnit,
          normalization:
            canonicalValue === undefined || canonicalValue === null
              ? null
              : {
                  canonicalValue,
                  canonicalUnit: "MMOL_L",
                  normalizerVersion: "test-normalizer-v1",
                },
        },
        measurementMethod: "FINGERSTICK_METER",
        context: { kind: "UNSPECIFIED" },
      },
      temporal: {
        kind: "POINT",
        occurrence: {
          kind: "EXACT",
          instantUtc: "2026-10-01T01:59:00.000Z",
          timeZoneId: "Asia/Singapore",
          utcOffsetMinutes: 480,
        },
      },
      validity: {
        sourceRevisionId: GLUCOSE_REVISION,
        evaluatedAt: EVALUATED_AT,
        ruleVersion: "healthhub-demo-validity-v1",
        outcome: overrides.glucoseOutcome ?? "ROUTABLE_CURRENT",
        reasonCodes: ["CURRENT_VALIDATED"],
      },
    },
    symptom: overrides.symptom,
  });
}

function symptom(
  options: {
    code?:
      | "SHAKY"
      | "LOSS_OF_CONSCIOUSNESS"
      | "SEIZURE"
      | "UNABLE_TO_SWALLOW_OR_SELF_TREAT";
    canSwallow?: "YES" | "NO" | "UNSURE" | "NOT_ASSESSED";
    canActIndependently?: "YES" | "NO" | "UNSURE" | "NOT_ASSESSED";
    canCheckGlucoseNow?: "YES" | "NO" | "UNSURE" | "NOT_ASSESSED";
    outcome?:
      | "ROUTABLE_CURRENT"
      | "ROUTABLE_HISTORICAL"
      | "CONFIRM_REQUIRED"
      | "MEASUREMENT_UNCERTAINTY"
      | "UNUSABLE";
  } = {},
) {
  return {
    payload: {
      reportKind: "PRESENT",
      symptoms: [
        {
          code: options.code ?? "SHAKY",
          severity: options.code === "SHAKY" ? "MILD" : "SEVERE",
        },
      ],
      capabilities: {
        canCheckGlucoseNow: options.canCheckGlucoseNow ?? "YES",
        canSwallow: options.canSwallow ?? "YES",
        canActIndependently: options.canActIndependently ?? "YES",
      },
    },
    temporal: {
      kind: "POINT",
      occurrence: {
        kind: "EXACT",
        instantUtc: "2026-10-01T01:59:30.000Z",
        timeZoneId: "Asia/Singapore",
        utcOffsetMinutes: 480,
      },
    },
    validity: {
      sourceRevisionId: SYMPTOM_REVISION,
      evaluatedAt: EVALUATED_AT,
      ruleVersion: "healthhub-demo-validity-v1",
      outcome: options.outcome ?? "ROUTABLE_CURRENT",
      reasonCodes: ["CURRENT_VALIDATED"],
    },
  };
}

describe("evaluateHealthHubHypoglycaemiaDemo", () => {
  it.each([
    "LOSS_OF_CONSCIOUSNESS",
    "SEIZURE",
    "UNABLE_TO_SWALLOW_OR_SELF_TREAT",
  ] as const)("routes current %s to emergency assistance", (code) => {
    const decision = evaluateHealthHubHypoglycaemiaDemo(
      input({
        glucoseOutcome: "UNUSABLE",
        symptom: symptom({ code }),
      }),
    );
    expect(decision.kind).toBe("RELAY_EMERGENCY_ASSISTANCE");
    if (decision.kind === "RELAY_EMERGENCY_ASSISTANCE") {
      expect(decision.emergencyNumber).toBe("995");
      expect(decision.triggeringRevisionIds).toEqual([SYMPTOM_REVISION]);
    }
  });

  it.each([
    { canSwallow: "NO" as const },
    { canActIndependently: "NO" as const },
  ])("routes explicit incapacity to emergency assistance", (capability) => {
    expect(
      evaluateHealthHubHypoglycaemiaDemo(
        input({ symptom: symptom(capability) }),
      ).kind,
    ).toBe("RELAY_EMERGENCY_ASSISTANCE");
  });

  it("ignores non-current severe symptom evidence", () => {
    expect(
      evaluateHealthHubHypoglycaemiaDemo(
        input({
          value: "5",
          symptom: symptom({
            code: "LOSS_OF_CONSCIOUSNESS",
            outcome: "ROUTABLE_HISTORICAL",
          }),
        }),
      ),
    ).toMatchObject({
      kind: "NO_DEMO_GUIDANCE",
      reasonCodes: ["READING_NOT_LOW"],
    });
  });

  it.each([
    "ROUTABLE_HISTORICAL",
    "CONFIRM_REQUIRED",
    "MEASUREMENT_UNCERTAINTY",
    "UNUSABLE",
  ] as const)("does not route a %s reading", (glucoseOutcome) => {
    expect(
      evaluateHealthHubHypoglycaemiaDemo(input({ glucoseOutcome })),
    ).toMatchObject({
      kind: "NO_DEMO_GUIDANCE",
      reasonCodes: ["READING_NOT_ROUTABLE_CURRENT"],
    });
  });

  it("does not guess or convert an unnormalised MG_DL value", () => {
    expect(
      evaluateHealthHubHypoglycaemiaDemo(
        input({ value: "54", enteredUnit: "MG_DL" }),
      ),
    ).toMatchObject({
      kind: "NO_DEMO_GUIDANCE",
      reasonCodes: ["READING_NOT_COMPARABLE"],
    });
  });

  it("uses a preserved canonical MMOL_L value when supplied", () => {
    expect(
      evaluateHealthHubHypoglycaemiaDemo(
        input({
          value: "54",
          enteredUnit: "MG_DL",
          canonicalValue: "3.0",
        }),
      ).kind,
    ).toBe("CONFIRM_CAPABILITY");
  });

  it.each(["4", "4.0", "04.000", "4.000000000000000001"])(
    "does not route boundary value %s",
    (value) => {
      expect(evaluateHealthHubHypoglycaemiaDemo(input({ value }))).toMatchObject(
        {
          kind: "NO_DEMO_GUIDANCE",
          reasonCodes: ["READING_NOT_LOW"],
        },
      );
    },
  );

  it.each(["3", "3.999999999999999999", "03.5000"])(
    "requires capability confirmation for low value %s without evidence",
    (value) => {
      expect(evaluateHealthHubHypoglycaemiaDemo(input({ value }))).toMatchObject(
        {
          kind: "CONFIRM_CAPABILITY",
          messageId: "HYPOGLYCAEMIA_CONFIRM_CAPABILITY",
        },
      );
    },
  );

  it.each(["UNSURE", "NOT_ASSESSED"] as const)(
    "requires confirmation when capability is %s",
    (capability) => {
      expect(
        evaluateHealthHubHypoglycaemiaDemo(
          input({
            symptom: symptom({
              canSwallow: capability,
              canActIndependently: capability,
            }),
          }),
        ).kind,
      ).toBe("CONFIRM_CAPABILITY");
    },
  );

  it.each(["NO", "UNSURE", "NOT_ASSESSED"] as const)(
    "requires confirmation when recheck capability is %s",
    (canCheckGlucoseNow) => {
      expect(
        evaluateHealthHubHypoglycaemiaDemo(
          input({ symptom: symptom({ canCheckGlucoseNow }) }),
        ).kind,
      ).toBe("CONFIRM_CAPABILITY");
    },
  );

  it("relays 15-15 guidance only with affirmative capability", () => {
    const decision = evaluateHealthHubHypoglycaemiaDemo(
      input({ symptom: symptom() }),
    );
    expect(decision).toMatchObject({
      kind: "RELAY_15_15_GUIDANCE",
      messageId: "HYPOGLYCAEMIA_15_15",
      thresholdMmolL: "4",
      fastActingSugarGrams: 15,
      recheckMinutes: 15,
      maxRepeatCount: 1,
      triggeringRevisionIds: [GLUCOSE_REVISION, SYMPTOM_REVISION],
    });
    expect(decision).not.toHaveProperty("renderedText");
  });

  it("selects only the requested locale asset", () => {
    const decision = evaluateHealthHubHypoglycaemiaDemo(
      input({ locale: "zh-SG", symptom: symptom() }),
    );
    expect(decision.locale).toBe("zh-SG");
    if (decision.kind !== "RELAY_15_15_GUIDANCE") {
      throw new Error("Expected 15-15 route");
    }
    const asset = resolveHealthHubHypoglycaemiaDemoMessage({
      messageId: decision.messageId,
      locale: decision.locale,
    });
    expect(asset.locale).toBe("zh-SG");
    expect(asset.text).toContain("15 克");
    expect(Object.isFrozen(asset)).toBe(true);
  });

  it("is deterministic and does not mutate its input", () => {
    const candidate = input({ symptom: symptom() });
    const before = structuredClone(candidate);
    const first = evaluateHealthHubHypoglycaemiaDemo(candidate);
    const second = evaluateHealthHubHypoglycaemiaDemo(candidate);
    expect(second).toEqual(first);
    expect(candidate).toEqual(before);
  });

  it("rejects runtime input outside the strict contract", () => {
    expect(() =>
      evaluateHealthHubHypoglycaemiaDemo({
        ...input(),
        thresholdMmolL: "2",
      } as HealthHubHypoglycaemiaDemoInput),
    ).toThrow();
  });
});

describe("resolveHealthHubHypoglycaemiaDemoMessage", () => {
  it("rejects arbitrary message IDs and locales", () => {
    expect(() =>
      resolveHealthHubHypoglycaemiaDemoMessage({
        messageId: "TAKE_INSULIN",
        locale: "en-SG",
      } as never),
    ).toThrow();
    expect(() =>
      resolveHealthHubHypoglycaemiaDemoMessage({
        messageId: "HYPOGLYCAEMIA_15_15",
        locale: "en-US",
      } as never),
    ).toThrow();
  });
});
