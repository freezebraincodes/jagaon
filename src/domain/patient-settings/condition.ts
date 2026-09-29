import { z } from "zod";
import { localDateSchema } from "../shared/time";

// --- Section 3.4: Condition knowledge class ---

export const CONDITION_KNOWLEDGE_CLASS = "PATIENT_STATED" as const;

export const conditionKnowledgeClassSchema = z.literal(CONDITION_KNOWLEDGE_CLASS);

// --- Section 3.4: ConditionPayload ---

export type ConditionPayload = {
  conditionCode: "TYPE_1_DIABETES";
  status: "ACTIVE" | "HISTORICAL" | "UNSURE";
  patientReportedDiagnosisDate?: {
    kind: "DATE_ONLY";
    localDate: string;
  };
};

const diagnosisDateSchema = z.strictObject({
  kind: z.literal("DATE_ONLY"),
  localDate: localDateSchema,
});

export const conditionPayloadSchema = z.strictObject({
  conditionCode: z.enum(["TYPE_1_DIABETES"]),
  status: z.enum(["ACTIVE", "HISTORICAL", "UNSURE"]),
  patientReportedDiagnosisDate: diagnosisDateSchema.optional(),
});