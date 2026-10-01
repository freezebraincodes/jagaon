import { z } from "zod";

import {
  HEALTHHUB_HYPOGLYCAEMIA_DEMO_POLICY,
  healthHubHypoglycaemiaMessageIdSchema,
} from "@/domain/safety/healthhub-hypoglycaemia-assets";
import type { HealthHubHypoglycaemiaMessageId } from "@/domain/safety/healthhub-hypoglycaemia-assets";
import {
  healthHubHypoglycaemiaDemoDecisionSchema,
  healthHubHypoglycaemiaDemoInputSchema,
} from "@/domain/safety/healthhub-hypoglycaemia-demo";
import type {
  HealthHubHypoglycaemiaDemoDecision,
  HealthHubHypoglycaemiaDemoInput,
} from "@/domain/safety/healthhub-hypoglycaemia-demo";
import type { DecimalString } from "@/domain/health-records/measurement";
import { supportedLocaleSchema } from "@/domain/patient-settings/locale";
import type { SupportedLocale } from "@/domain/patient-settings/locale";
import type { RevisionId } from "@/domain/shared/identifiers";
import { compareDecimalStrings } from "./decimal-comparison";

const messageLookupSchema = z.strictObject({
  messageId: healthHubHypoglycaemiaMessageIdSchema,
  locale: supportedLocaleSchema,
});

type MessageLookup = {
  messageId: HealthHubHypoglycaemiaMessageId;
  locale: SupportedLocale;
};

export function resolveHealthHubHypoglycaemiaDemoMessage(
  input: MessageLookup,
): (typeof HEALTHHUB_HYPOGLYCAEMIA_DEMO_POLICY.messages)[number] {
  const lookup = messageLookupSchema.parse(input);
  const asset = HEALTHHUB_HYPOGLYCAEMIA_DEMO_POLICY.messages.find(
    (candidate) =>
      candidate.messageId === lookup.messageId &&
      candidate.locale === lookup.locale,
  );
  if (asset === undefined) {
    throw new Error("Source-bound Safety message asset is unavailable");
  }
  return asset;
}

const EMERGENCY_SYMPTOMS = new Set([
  "LOSS_OF_CONSCIOUSNESS",
  "SEIZURE",
  "UNABLE_TO_SWALLOW_OR_SELF_TREAT",
]);

function sourcesForMessage(
  messageId: HealthHubHypoglycaemiaMessageId,
  locale: SupportedLocale,
) {
  const sourceIds = resolveHealthHubHypoglycaemiaDemoMessage({
    messageId,
    locale,
  }).sourceIds;
  return [sourceIds[0], ...sourceIds.slice(1)];
}

function commonDecision(
  input: HealthHubHypoglycaemiaDemoInput,
  triggeringRevisionIds: [RevisionId, ...RevisionId[]],
) {
  return {
    mode: HEALTHHUB_HYPOGLYCAEMIA_DEMO_POLICY.mode,
    evaluatedAt: input.evaluatedAt,
    locale: input.locale,
    policyRef: HEALTHHUB_HYPOGLYCAEMIA_DEMO_POLICY.policyRef,
    assetDigest: HEALTHHUB_HYPOGLYCAEMIA_DEMO_POLICY.assetDigest,
    triggeringRevisionIds,
  } as const;
}

function comparableMmolLValue(
  input: HealthHubHypoglycaemiaDemoInput,
): DecimalString | null {
  const measurement = input.glucose.payload.measurement;
  if (measurement.normalization !== null) {
    return measurement.normalization.canonicalValue;
  }
  return measurement.enteredUnit === "MMOL_L"
    ? measurement.enteredValue
    : null;
}

function isCurrentEmergencySymptom(
  input: HealthHubHypoglycaemiaDemoInput,
): boolean {
  const symptom = input.symptom;
  if (
    symptom === undefined ||
    symptom.validity.outcome !== "ROUTABLE_CURRENT" ||
    symptom.payload.reportKind !== "PRESENT"
  ) {
    return false;
  }

  if (
    symptom.payload.symptoms.some((entry) =>
      EMERGENCY_SYMPTOMS.has(entry.code),
    )
  ) {
    return true;
  }

  const capabilities = symptom.payload.capabilities;
  return (
    capabilities?.canSwallow === "NO" ||
    capabilities?.canActIndependently === "NO"
  );
}

function hasConfirmedSelfTreatmentCapability(
  input: HealthHubHypoglycaemiaDemoInput,
): boolean {
  const symptom = input.symptom;
  if (
    symptom === undefined ||
    symptom.validity.outcome !== "ROUTABLE_CURRENT" ||
    symptom.payload.reportKind !== "PRESENT"
  ) {
    return false;
  }
  return (
    symptom.payload.capabilities?.canCheckGlucoseNow === "YES" &&
    symptom.payload.capabilities.canSwallow === "YES" &&
    symptom.payload.capabilities.canActIndependently === "YES"
  );
}

export function evaluateHealthHubHypoglycaemiaDemo(
  rawInput: HealthHubHypoglycaemiaDemoInput,
): HealthHubHypoglycaemiaDemoDecision {
  const input = healthHubHypoglycaemiaDemoInputSchema.parse(rawInput);

  if (isCurrentEmergencySymptom(input)) {
    const symptomRevisionId = input.symptom!.validity.sourceRevisionId;
    return healthHubHypoglycaemiaDemoDecisionSchema.parse({
      ...commonDecision(input, [symptomRevisionId]),
      kind: "RELAY_EMERGENCY_ASSISTANCE",
      messageId: "HYPOGLYCAEMIA_EMERGENCY_995",
      sourceIds: sourcesForMessage(
        "HYPOGLYCAEMIA_EMERGENCY_995",
        input.locale,
      ),
      emergencyNumber: HEALTHHUB_HYPOGLYCAEMIA_DEMO_POLICY.emergencyNumber,
    });
  }

  const glucoseRevisionId = input.glucose.validity.sourceRevisionId;
  if (input.glucose.validity.outcome !== "ROUTABLE_CURRENT") {
    return healthHubHypoglycaemiaDemoDecisionSchema.parse({
      ...commonDecision(input, [glucoseRevisionId]),
      kind: "NO_DEMO_GUIDANCE",
      reasonCodes: ["READING_NOT_ROUTABLE_CURRENT"],
    });
  }

  const glucoseMmolL = comparableMmolLValue(input);
  if (glucoseMmolL === null) {
    return healthHubHypoglycaemiaDemoDecisionSchema.parse({
      ...commonDecision(input, [glucoseRevisionId]),
      kind: "NO_DEMO_GUIDANCE",
      reasonCodes: ["READING_NOT_COMPARABLE"],
    });
  }

  if (
    compareDecimalStrings(
      glucoseMmolL,
      HEALTHHUB_HYPOGLYCAEMIA_DEMO_POLICY.thresholdMmolL,
    ) >= 0
  ) {
    return healthHubHypoglycaemiaDemoDecisionSchema.parse({
      ...commonDecision(input, [glucoseRevisionId]),
      kind: "NO_DEMO_GUIDANCE",
      reasonCodes: ["READING_NOT_LOW"],
    });
  }

  const currentSymptomRevisionId =
    input.symptom?.validity.outcome === "ROUTABLE_CURRENT"
      ? input.symptom.validity.sourceRevisionId
      : undefined;
  const triggeringRevisionIds: [RevisionId, ...RevisionId[]] =
    currentSymptomRevisionId === undefined
      ? [glucoseRevisionId]
      : [glucoseRevisionId, currentSymptomRevisionId];

  if (!hasConfirmedSelfTreatmentCapability(input)) {
    return healthHubHypoglycaemiaDemoDecisionSchema.parse({
      ...commonDecision(input, triggeringRevisionIds),
      kind: "CONFIRM_CAPABILITY",
      messageId: "HYPOGLYCAEMIA_CONFIRM_CAPABILITY",
      sourceIds: sourcesForMessage(
        "HYPOGLYCAEMIA_CONFIRM_CAPABILITY",
        input.locale,
      ),
    });
  }

  return healthHubHypoglycaemiaDemoDecisionSchema.parse({
    ...commonDecision(input, triggeringRevisionIds),
    kind: "RELAY_15_15_GUIDANCE",
    messageId: "HYPOGLYCAEMIA_15_15",
    sourceIds: sourcesForMessage("HYPOGLYCAEMIA_15_15", input.locale),
    thresholdMmolL: HEALTHHUB_HYPOGLYCAEMIA_DEMO_POLICY.thresholdMmolL,
    fastActingSugarGrams:
      HEALTHHUB_HYPOGLYCAEMIA_DEMO_POLICY.fastActingSugarGrams,
    recheckMinutes: HEALTHHUB_HYPOGLYCAEMIA_DEMO_POLICY.recheckMinutes,
    maxRepeatCount: HEALTHHUB_HYPOGLYCAEMIA_DEMO_POLICY.maxRepeatCount,
  });
}
